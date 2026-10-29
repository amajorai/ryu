//! OpenAI Responses API ingress. Requests are normalized to the Gateway's
//! shared Chat Completions pipeline; only the outer wire format differs.

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

use crate::{
    compat::responses::{chat_response_to_responses, ResponseCreateRequest},
    error::GatewayError,
    pipeline,
    responses_store::ResponseOwner,
    state::SharedState,
};

pub async fn create_response(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    let context = super::compat::authenticate_compat(&state, &headers, None).await?;
    // This route never forwards `anthropic-beta`, so a beta the fleet does not
    // offer is refused rather than silently dropped, as on `/v1/messages`.
    let beta = pipeline::upstream_features::beta_header(&headers);
    if let Err(error) =
        pipeline::upstream_features::enforce_beta_header(state.custody, beta.as_deref())
    {
        let requested_model = body["model"].as_str().unwrap_or("unknown");
        pipeline::audit_refused(&state, &context, requested_model, &error);
        return Err(error);
    }
    let request = ResponseCreateRequest::parse(body).map_err(GatewayError::BadRequest)?;
    let mut history = if let Some(previous_id) = request.previous_response_id.as_deref() {
        state
            .response_states
            .get(previous_id, &ResponseOwner::from(&context))
            .ok_or_else(|| {
                GatewayError::BadRequest(
                    "previous_response_id is unknown, expired, or belongs to another caller"
                        .to_owned(),
                )
            })?
    } else {
        Vec::new()
    };
    history.extend(
        request
            .to_chat_messages()
            .map_err(GatewayError::BadRequest)?,
    );

    let response_id = format!("resp_{}", Uuid::new_v4().simple());
    let mut envelope = request.envelope(response_id.clone(), unix_time());
    let openai_body = request.to_chat_body(history.clone(), request.stream);
    let hosted = if let Some(declaration) = request.tool_registry.hosted_web.as_ref() {
        let (output, hosted_history, records) = super::responses_hosted::run(
            Arc::clone(&state),
            context.clone(),
            &headers,
            openai_body.clone(),
            declaration,
            history.clone(),
            request.max_tool_calls(),
        )
        .await?;
        history = hosted_history;
        envelope.hosted_output = records;
        Some(output)
    } else {
        None
    };

    if request.stream {
        if let Some(output) = hosted {
            let owner = ResponseOwner::from(&output.context);
            let stream = super::responses_stream::translate_chat_stream(
                super::responses_hosted::chat_stream(&output.response),
                envelope,
                output.model_used.clone(),
                history,
                owner,
                state.response_states.clone(),
            );
            let mut response = Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .header("cache-control", "no-cache")
                .header("x-request-id", &output.context.request_id)
                .body(axum::body::Body::from_stream(stream))
                .map_err(|error| {
                    GatewayError::Internal(anyhow::anyhow!("response build error: {error}"))
                })?;
            add_response_headers(
                response.headers_mut(),
                output.provider_used,
                &output.model_used,
            );
            if let Some(alert) = output.policy_alert {
                response.extensions_mut().insert(alert);
            }
            return Ok(response);
        }
        let output = pipeline::run_stream(Arc::clone(&state), context, openai_body).await?;
        let owner = ResponseOwner::from(&output.context);
        let request_id = output.context.request_id.clone();
        let model_used = output.model_used.clone();
        let provider_used = output.provider_used;
        let stream = super::responses_stream::translate_chat_stream(
            output.body,
            envelope,
            model_used.clone(),
            history,
            owner,
            state.response_states.clone(),
        );
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .header("x-request-id", request_id)
            .body(axum::body::Body::from_stream(stream))
            .map_err(|error| {
                GatewayError::Internal(anyhow::anyhow!("response build error: {error}"))
            })?;
        add_response_headers(response.headers_mut(), provider_used, &model_used);
        if let Some(alert) = output.policy_alert {
            response.extensions_mut().insert(alert);
        }
        Ok(response)
    } else {
        let output = match hosted {
            Some(output) => output,
            None => pipeline::run(Arc::clone(&state), context, openai_body).await?,
        };
        let completed_at = unix_time();
        let result = chat_response_to_responses(
            &output.response,
            &envelope,
            &output.model_used,
            completed_at,
        )
        .map_err(|error| {
            GatewayError::Internal(anyhow::anyhow!("invalid provider completion: {error}"))
        })?;

        history.push(result.assistant_message);
        let mut response_body = result.response;
        if envelope.store
            && !state.response_states.insert(
                response_id,
                ResponseOwner::from(&output.context),
                history,
            )
        {
            // The response remains usable statelessly, but its ID cannot be used
            // for continuation when the bounded in-memory store is full.
            response_body["store"] = Value::Bool(false);
        }

        let mut response = Json(response_body).into_response();
        add_response_headers(
            response.headers_mut(),
            output.provider_used,
            &output.model_used,
        );
        if let Ok(value) = HeaderValue::from_str(&output.context.request_id) {
            response.headers_mut().insert("x-request-id", value);
        }
        if output.cache_hit {
            response
                .headers_mut()
                .insert("x-cache", HeaderValue::from_static("hit"));
        }
        if let Some(alert) = output.policy_alert {
            response.extensions_mut().insert(alert);
        }
        Ok(response)
    }
}

fn add_response_headers(headers: &mut HeaderMap, provider: &str, model: &str) {
    if let Ok(value) = HeaderValue::from_str(provider) {
        headers.insert("x-provider", value);
    }
    if let Ok(value) = HeaderValue::from_str(model) {
        headers.insert("x-routed-model", value);
    }
}

fn unix_time() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        pin::Pin,
        sync::{Arc, Mutex},
    };

    use axum::{
        body::{to_bytes, Body},
        http::{Method, Request, StatusCode},
        Router,
    };
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use crate::{
        api,
        audit::AuditLogger,
        config::{AuditConfig, GatewayConfig, ProviderId},
        evals::EvalsRunner,
        providers::Provider,
        state::AppState,
    };

    use super::unix_time;

    struct FixtureProvider {
        response: Value,
        stream: String,
        calls: Arc<Mutex<Vec<Value>>>,
    }

    impl Provider for FixtureProvider {
        fn name(&self) -> &'static str {
            "responses-test"
        }

        fn complete<'a>(
            &'a self,
            _model: &'a str,
            body: &'a Value,
        ) -> Pin<Box<dyn Future<Output = Result<Value, ryu_gw_providers::ProviderError>> + Send + 'a>>
        {
            self.calls.lock().expect("calls lock").push(body.clone());
            let response = self.response.clone();
            Box::pin(async move { Ok(response) })
        }

        fn complete_stream<'a>(
            &'a self,
            _model: &'a str,
            body: &'a Value,
        ) -> Pin<Box<dyn Future<Output = Result<Body, ryu_gw_providers::ProviderError>> + Send + 'a>>
        {
            self.calls.lock().expect("calls lock").push(body.clone());
            let stream = self.stream.clone();
            Box::pin(async move { Ok(Body::from(stream)) })
        }
    }

    fn test_app(response: Value, stream: impl Into<String>) -> (Router, Arc<Mutex<Vec<Value>>>) {
        test_app_with(response, stream, |config| config.firewall.enabled = false)
    }

    fn test_app_with(
        response: Value,
        stream: impl Into<String>,
        configure: impl FnOnce(&mut GatewayConfig),
    ) -> (Router, Arc<Mutex<Vec<Value>>>) {
        let mut config = GatewayConfig::default();
        config.auth.require_auth = false;
        config.cache.enabled = false;
        configure(&mut config);
        config.routing.default_provider = ProviderId::from("responses-test");
        config.routing.fallback_chain = vec![ProviderId::from("responses-test")];

        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = EvalsRunner::new(crate::config::EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        let calls = Arc::new(Mutex::new(Vec::new()));
        state
            .provider_runtime
            .register_for_test(Arc::new(FixtureProvider {
                response,
                stream: stream.into(),
                calls: Arc::clone(&calls),
            }));
        (api::router(Arc::new(state)), calls)
    }

    async fn post(app: Router, body: Value) -> axum::response::Response {
        app.oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v1/responses")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .expect("request builds"),
        )
        .await
        .expect("router responds")
    }

    async fn json_body(response: axum::response::Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body reads");
        serde_json::from_slice(&bytes).expect("response body is JSON")
    }

    fn completion(message: Value, finish_reason: &str) -> Value {
        json!({
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "model": "responses-test-model",
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": finish_reason
            }],
            "usage": {
                "prompt_tokens": 3,
                "completion_tokens": 2,
                "total_tokens": 5
            }
        })
    }

    #[tokio::test]
    async fn http_request_runs_through_pipeline_and_continues_by_response_id() {
        let (app, calls) = test_app(
            completion(json!({ "role": "assistant", "content": "pong" }), "stop"),
            "",
        );
        let first = post(
            app.clone(),
            json!({
                "model": "requested-model",
                "instructions": "be brief",
                "input": "ping"
            }),
        )
        .await;
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(
            first
                .headers()
                .get("x-provider")
                .and_then(|value| value.to_str().ok()),
            Some("responses-test")
        );
        let first = json_body(first).await;
        assert_eq!(first["object"], "response");
        assert_eq!(first["status"], "completed");
        assert_eq!(first["output"][0]["content"][0]["text"], "pong");
        let first_id = first["id"].as_str().expect("response id").to_owned();

        let second = post(
            app,
            json!({
                "model": "requested-model",
                "previous_response_id": first_id,
                "input": "again"
            }),
        )
        .await;
        assert_eq!(second.status(), StatusCode::OK);
        let recorded = calls.lock().expect("calls lock");
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[0]["messages"][0]["role"], "system");
        assert_eq!(recorded[1]["messages"][0]["content"], "ping");
        assert_eq!(recorded[1]["messages"][1]["role"], "assistant");
        assert_eq!(recorded[1]["messages"][2]["content"], "again");
    }

    #[tokio::test]
    async fn function_call_round_trip_continues_as_a_responses_tool_result() {
        let tool_response = completion(
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_lookup",
                    "type": "function",
                    "function": {
                        "name": "lookup",
                        "arguments": r#"{"key":"alpha"}"#
                    }
                }]
            }),
            "tool_calls",
        );
        let (app, calls) = test_app(tool_response, "");
        let first = post(
            app.clone(),
            json!({
                "model": "requested-model",
                "input": "look up alpha",
                "tools": [{
                    "type": "function",
                    "name": "lookup",
                    "parameters": { "type": "object", "properties": { "key": { "type": "string" } } }
                }]
            }),
        )
        .await;
        assert_eq!(first.status(), StatusCode::OK);
        let first = json_body(first).await;
        assert_eq!(first["output"][0]["type"], "function_call");
        assert_eq!(first["output"][0]["call_id"], "call_lookup");
        let previous_response_id = first["id"].as_str().expect("response id");

        let second = post(
            app,
            json!({
                "model": "requested-model",
                "previous_response_id": previous_response_id,
                "input": [{
                    "type": "function_call_output",
                    "call_id": "call_lookup",
                    "output": { "found": true }
                }]
            }),
        )
        .await;
        assert_eq!(second.status(), StatusCode::OK);
        let recorded = calls.lock().expect("calls lock");
        let follow_up = &recorded[1]["messages"];
        assert_eq!(follow_up[1]["tool_calls"][0]["id"], "call_lookup");
        assert_eq!(follow_up[2]["role"], "tool");
        assert_eq!(follow_up[2]["tool_call_id"], "call_lookup");
        assert_eq!(follow_up[2]["content"], r#"{"found":true}"#);
    }

    fn sanitize_firewall(config: &mut GatewayConfig) {
        config.firewall.enabled = true;
        config.firewall.scan_inbound = true;
        config.firewall.scan_outbound = false;
        config.firewall.policy = crate::config::FirewallPolicy::Sanitize;
    }

    /// `/v1/responses` turns every `input_text` into an array content part. Under
    /// the Sanitize policy the secret in that part, and in a replayed
    /// `function_call_output`, must be redacted before the provider sees it.
    #[tokio::test]
    async fn sanitize_policy_redacts_input_text_parts_before_the_provider() {
        let (app, calls) = test_app_with(
            completion(json!({ "role": "assistant", "content": "ok" }), "stop"),
            "",
            sanitize_firewall,
        );
        let response = post(
            app,
            json!({
                "model": "requested-model",
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "deploy with AKIAIOSFODNN7EXAMPLE" }]
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_env",
                        "name": "read_env",
                        "arguments": "{}"
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_env",
                        "output": "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"
                    }
                ]
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let recorded = calls.lock().expect("calls lock");
        assert_eq!(recorded.len(), 1);
        let sent = recorded[0]["messages"].to_string();
        assert!(
            !sent.contains("AKIAIOSFODNN7EXAMPLE"),
            "the provider must not receive the secret: {sent}"
        );
        assert!(
            sent.contains("[REDACTED:"),
            "expected a redaction marker: {sent}"
        );
    }

    /// A zero-width split defeats the raw-text redaction regexes but not
    /// detection; Sanitize fails closed instead of forwarding the secret.
    #[tokio::test]
    async fn sanitize_policy_blocks_an_obfuscated_secret_it_cannot_redact() {
        let (app, calls) = test_app_with(
            completion(json!({ "role": "assistant", "content": "ok" }), "stop"),
            "",
            sanitize_firewall,
        );
        let response = post(
            app,
            json!({
                "model": "requested-model",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "key AKIA\u{200B}IOSFODNN7EXAMPLE" }]
                }]
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(
            calls.lock().expect("calls lock").is_empty(),
            "a blocked request must never reach the provider"
        );
    }

    #[tokio::test]
    async fn http_stream_emits_responses_semantic_events() {
        let fixture = concat!(
            "data: {\"id\":\"chatcmpl-test\",\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-test\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
        );
        let (app, _) = test_app(
            completion(json!({ "role": "assistant", "content": "Hi" }), "stop"),
            fixture,
        );
        let response = post(
            app,
            json!({ "model": "requested-model", "input": "hello", "stream": true }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("stream body reads");
        let events = String::from_utf8(bytes.to_vec()).expect("SSE is UTF-8");
        assert!(events.contains("event: response.created\n"));
        assert!(events.contains("event: response.output_text.delta\n"));
        assert!(events.contains("\"delta\":\"Hi\""));
        assert!(events.contains("event: response.completed\n"));
        assert!(!events.contains("data: [DONE]"));
        let completed = events
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .find(|event| event["type"] == "response.completed")
            .expect("completed response event");
        assert_eq!(completed["response"]["usage"]["input_tokens"], 1);
        assert_eq!(completed["response"]["usage"]["output_tokens"], 1);
        assert_eq!(completed["response"]["usage"]["total_tokens"], 2);
    }

    #[tokio::test]
    async fn http_stream_projects_function_call_arguments() {
        let text_chunk = json!({
            "choices": [{
                "delta": { "content": "Looking this up. " },
                "finish_reason": null
            }]
        });
        let first_chunk = json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_lookup",
                        "type": "function",
                        "function": { "name": "lookup", "arguments": r#"{"key":"# }
                    }]
                },
                "finish_reason": null
            }]
        });
        let second_chunk = json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "function": { "arguments": r#""alpha"}"# }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 }
        });
        let fixture = format!(
            "data: {text_chunk}\n\ndata: {first_chunk}\n\ndata: {second_chunk}\n\ndata: [DONE]\n\n"
        );
        let (app, calls) = test_app(
            completion(
                json!({ "role": "assistant", "content": null }),
                "tool_calls",
            ),
            fixture,
        );
        let response = post(
            app.clone(),
            json!({
                "model": "requested-model",
                "input": "look up alpha",
                "stream": true,
                "tools": [{
                    "type": "function",
                    "name": "lookup",
                    "parameters": { "type": "object" }
                }]
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("stream body reads");
        let events = String::from_utf8(bytes.to_vec()).expect("SSE is UTF-8");
        assert!(events.contains("event: response.output_item.added\n"));
        assert!(events.contains("event: response.function_call_arguments.delta\n"));
        assert!(events.contains("event: response.function_call_arguments.done\n"));
        assert!(events.contains("\"call_id\":\"call_lookup\""));
        assert!(events.contains("event: response.completed\n"));

        let response_id = events
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .find(|event| event["type"] == "response.completed")
            .and_then(|event| event.pointer("/response/id")?.as_str().map(str::to_owned))
            .expect("completed response id");

        let follow_up = post(
            app,
            json!({
                "model": "requested-model",
                "previous_response_id": response_id,
                "input": [{
                    "type": "function_call_output",
                    "call_id": "call_lookup",
                    "output": "found"
                }]
            }),
        )
        .await;
        assert_eq!(follow_up.status(), StatusCode::OK);
        let follow_up = calls.lock().expect("calls lock");
        assert_eq!(follow_up.len(), 2);
        assert_eq!(follow_up[1]["messages"][1]["content"], "Looking this up. ");
        assert_eq!(
            follow_up[1]["messages"][1]["tool_calls"][0]["id"],
            "call_lookup"
        );
    }

    #[tokio::test]
    async fn upstream_stream_error_emits_a_failed_response_event() {
        let fixture = "data: {\"error\":{\"message\":\"provider unavailable\"}}\n\n";
        let (app, _) = test_app(
            completion(json!({ "role": "assistant", "content": "unused" }), "stop"),
            fixture,
        );
        let response = post(
            app,
            json!({ "model": "requested-model", "input": "hello", "stream": true }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("stream body reads");
        let events = String::from_utf8(bytes.to_vec()).expect("SSE is UTF-8");
        assert!(events.contains("event: response.failed\n"));
        assert!(events.contains("\"status\":\"failed\""));
        assert!(!events.contains("event: response.completed\n"));
    }

    #[tokio::test]
    async fn malformed_streamed_function_call_fails_instead_of_disappearing() {
        let chunk = json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_invalid",
                        "function": { "arguments": "{}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        });
        let fixture = format!("data: {chunk}\n\ndata: [DONE]\n\n");
        let (app, _) = test_app(
            completion(
                json!({ "role": "assistant", "content": null }),
                "tool_calls",
            ),
            fixture,
        );
        let response = post(
            app,
            json!({
                "model": "requested-model",
                "input": "call the tool",
                "stream": true,
                "tools": [{
                    "type": "function",
                    "name": "lookup",
                    "parameters": { "type": "object" }
                }]
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("stream body reads");
        let events = String::from_utf8(bytes.to_vec()).expect("SSE is UTF-8");
        assert!(events.contains("event: response.failed\n"));
        assert!(events.contains("function call without a name"));
        assert!(!events.contains("event: response.completed\n"));
    }

    #[tokio::test]
    async fn unsupported_hosted_tool_returns_a_request_error_before_provider_call() {
        let (app, calls) = test_app(
            completion(json!({ "role": "assistant", "content": "unused" }), "stop"),
            "",
        );
        let response = post(
            app,
            json!({
                "model": "requested-model",
                "input": "search",
                "tools": [{ "type": "file_search" }]
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn namespace_and_custom_sse_calls_preserve_client_protocol() {
        for custom in [false, true] {
            let tool = if custom {
                json!({"type":"custom","name":"patch","format":{"type":"text"}})
            } else {
                json!({"type":"namespace","name":"multi_agent_v1","tools":[{"type":"function","name":"spawn_agent","parameters":{}}]})
            };
            let parsed = crate::compat::responses::ResponseCreateRequest::parse(
                json!({"model":"requested-model","input":"call","tools":[tool.clone()]}),
            )
            .unwrap();
            let wire = parsed
                .tool_registry
                .wire_name(
                    if custom { "patch" } else { "spawn_agent" },
                    if custom { None } else { Some("multi_agent_v1") },
                )
                .unwrap();
            let arguments = if custom {
                "{\"input\":\"line one\\nline two\"}"
            } else {
                "{}"
            };
            let delta = json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_client","type":"function","function":{"name":wire,"arguments":arguments}}]},"finish_reason":null}]});
            let end = json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
            let (app, _) = test_app(
                json!({}),
                format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
            );
            let response = post(
                app,
                json!({"model":"requested-model","input":"call","tools":[tool],"stream":true}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let text = String::from_utf8(
                to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .to_vec(),
            )
            .unwrap();
            if custom {
                assert!(text.contains("response.custom_tool_call_input.delta"));
                assert!(text.contains("custom_tool_call"));
                assert!(!text.contains("response.function_call_arguments.delta"));
            } else {
                assert!(text.contains("\"namespace\":\"multi_agent_v1\""));
                assert!(text.contains("\"name\":\"spawn_agent\""));
            }
        }
    }

    #[tokio::test]
    async fn cached_web_declaration_is_accepted_without_implicitly_searching() {
        let (app, calls) = test_app(
            completion(json!({"role":"assistant","content":"local answer"}), "stop"),
            "",
        );
        let response=post(app,json!({"model":"requested-model","input":"hello","tools":[{"type":"web_search","external_web_access":false}]})).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(calls.lock().unwrap().len(), 1);
        let body = json_body(response).await;
        assert_eq!(body["output"][0]["content"][0]["text"], "local answer");
        assert_eq!(body["tools"][0]["external_web_access"], false);
    }

    #[tokio::test]
    async fn unknown_previous_response_id_returns_a_request_error() {
        let (app, calls) = test_app(
            completion(json!({ "role": "assistant", "content": "unused" }), "stop"),
            "",
        );
        let response = post(
            app,
            json!({
                "model": "requested-model",
                "previous_response_id": "resp_missing",
                "input": "continue"
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn non_string_model_returns_a_client_error_without_provider_call() {
        let (app, calls) = test_app(
            completion(json!({ "role": "assistant", "content": "unused" }), "stop"),
            "",
        );
        let response = post(app, json!({ "model": 123, "input": "hello" })).await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[test]
    fn unix_time_is_non_negative() {
        assert!(unix_time() >= 0);
    }
}
