//! Responses hosted search uses the existing governed Gateway web pipeline.
use crate::{
    config::ApiKeyOperation,
    error::GatewayError,
    pipeline::{self, PipelineOutput, RequestContext},
    state::SharedState,
};
use axum::{body::Body, http::HeaderMap};
use ryu_gw_providers::web::WebSearchRequest;
use serde_json::{json, Value};
use std::sync::Arc;

pub async fn run(
    state: SharedState,
    context: RequestContext,
    headers: &HeaderMap,
    mut body: Value,
    declaration: &Value,
    mut history: Vec<Value>,
    max_tool_calls: Option<u64>,
) -> Result<(PipelineOutput, Vec<Value>, Vec<Value>), GatewayError> {
    body["stream"] = json!(false);
    // Hosted calls the Gateway may still execute for this response. Once the
    // budget is spent the hosted tool is withdrawn so the model must answer.
    let mut remaining_calls = max_tool_calls.unwrap_or(u64::MAX);
    let initial_messages = body["messages"]
        .as_array()
        .cloned()
        .ok_or_else(|| GatewayError::BadRequest("hosted tool history must be messages".into()))?;
    let prefix = initial_messages[..initial_messages.len().saturating_sub(history.len())].to_vec();
    let mut records = Vec::new();
    let mut usage = json!({});
    let mut hosted_alert = None;
    for iteration in 0..4 {
        // A round-based tool loop checks standing before each round (spec
        // 05.5), so a push that lands during a model round stops the next.
        crate::standing::recheck(&state, &context).await?;
        body["messages"] = json!(prefix
            .iter()
            .chain(history.iter())
            .cloned()
            .collect::<Vec<_>>());
        if remaining_calls == 0 {
            withdraw_hosted_tool(&mut body);
        }
        let mut step_context = context.clone();
        if iteration > 0 {
            step_context.request_id = format!("{}_hosted_{iteration}", context.request_id);
        }
        let mut output = pipeline::run(Arc::clone(&state), step_context, body.clone()).await?;
        add_usage(&mut usage, &output.response["usage"]);
        let message = output
            .response
            .pointer("/choices/0/message")
            .cloned()
            .ok_or_else(|| {
                GatewayError::Internal(anyhow::anyhow!(
                    "hosted search received no assistant message"
                ))
            })?;
        let calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let searches = calls
            .iter()
            .filter(|call| {
                call.pointer("/function/name").and_then(Value::as_str)
                    == Some("ryu_responses_web_search")
            })
            .collect::<Vec<_>>();
        if searches.is_empty() {
            output.response["usage"] = usage;
            output.policy_alert = output.policy_alert.or(hosted_alert.take());
            return Ok((output, history, records));
        }
        if searches.len() > 4 || iteration == 3 {
            return Err(GatewayError::BadRequest(
                "hosted web search exceeded the bounded tool-call limit".into(),
            ));
        }
        let mut hosted_message = message.clone();
        hosted_message["tool_calls"] = json!(searches
            .iter()
            .map(|call| (*call).clone())
            .collect::<Vec<_>>());
        history.push(hosted_message);
        for call in searches {
            let call_id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    GatewayError::BadRequest("hosted web search requires a call id".into())
                })?;
            if remaining_calls == 0 {
                // The model asked for more hosted calls than max_tool_calls
                // allows in one batch: answer explicitly instead of searching.
                let result = json!({"error":{"code":"max_tool_calls_exceeded","message":"This response reached its max_tool_calls limit; no further hosted tool calls run."},"results":[]});
                let query = serde_json::from_str::<Value>(
                    call.pointer("/function/arguments")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
                .ok()
                .and_then(|arguments| {
                    arguments
                        .get("query")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
                records.push(json!({"id":call_id,"type":"web_search_call","status":"failed","action":{"type":"search","query":query,"sources":[]},"results":[],"error":result["error"]}));
                history.push(
                    json!({"role":"tool","tool_call_id":call_id,"content":result.to_string()}),
                );
                continue;
            }
            remaining_calls -= 1;
            // Declaration and inference permission never authorize search.
            let web_context = pipeline::authenticate_for_operation(
                &state,
                super::web::inputs(headers),
                ApiKeyOperation::WebSearch,
            )
            .await?;
            let arguments: Value = serde_json::from_str(
                call.pointer("/function/arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
            .map_err(|_| {
                GatewayError::BadRequest("hosted web search requires JSON arguments".into())
            })?;
            if arguments
                .as_object()
                .is_none_or(|object| object.keys().any(|key| key != "query"))
            {
                return Err(GatewayError::BadRequest(
                    "hosted search arguments contain unsupported fields".into(),
                ));
            }
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    GatewayError::BadRequest("hosted web search requires query".into())
                })?;
            let request = WebSearchRequest::new(query.to_owned(), 10).map_err(|_| {
                GatewayError::BadRequest("hosted web search query is invalid".into())
            })?;
            let cached_only = declaration.get("external_web_access") == Some(&Value::Bool(false));
            let result = if cached_only {
                // No Gateway search cache exists. Never silently turn a cached
                // request into live provider/network access.
                json!({"error":{"code":"cached_web_search_unavailable","message":"No cached Gateway web search results are available; external web access is disabled."},"results":[]})
            } else {
                let web_output = pipeline::web::run(
                    Arc::clone(&state),
                    web_context,
                    pipeline::web::WebRequest::Search(request),
                    None,
                )
                .await?;
                hosted_alert = hosted_alert.or(web_output.policy_alert);
                web_output.response
            };
            let sources = result
                .get("results")
                .and_then(Value::as_array)
                .map(|results| {
                    results
                        .iter()
                        .filter_map(|result| result.get("url").and_then(Value::as_str))
                        .map(|url| json!({"type":"url","url":url}))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let mut record = json!({"id":call_id,"type":"web_search_call","status":if cached_only{"failed"}else{"completed"},"action":{"type":"search","query":query,"sources":sources},"results":result.get("results").cloned().unwrap_or_else(||json!([]))});
            if let Some(error) = result.get("error") {
                record["error"] = error.clone();
            }
            records.push(record);
            let encoded = serde_json::to_string(&result).map_err(|_| {
                GatewayError::Internal(anyhow::anyhow!("search result encoding failed"))
            })?;
            // Search results are attacker-reachable web content: wrap them in
            // untrusted-content markers (chat-template tokens stripped) before
            // they re-enter the model, as the tool loops do. The next
            // iteration's pipeline run still applies the inbound firewall.
            let content = if crate::untrusted::is_enabled() {
                crate::untrusted::neutralize(&encoded)
            } else {
                encoded
            };
            history.push(json!({"role":"tool","tool_call_id":call_id,"content":content}));
        }
        if calls.iter().any(|call| {
            call.pointer("/function/name").and_then(Value::as_str)
                != Some("ryu_responses_web_search")
        }) {
            // Client tool calls must return to the client; do not execute or
            // replay them while handling a simultaneous hosted call.
            output.response["choices"][0]["message"]["tool_calls"] = json!(calls
                .into_iter()
                .filter(
                    |call| call.pointer("/function/name").and_then(Value::as_str)
                        != Some("ryu_responses_web_search")
                )
                .collect::<Vec<_>>());
            output.response["usage"] = usage;
            output.policy_alert = output.policy_alert.or(hosted_alert.take());
            return Ok((output, history, records));
        }
    }
    Err(GatewayError::BadRequest(
        "hosted web search tool loop exhausted".into(),
    ))
}

/// Remove the Gateway-hosted search function from a Chat body so the model can
/// no longer call it (client tools stay declared).
fn withdraw_hosted_tool(body: &mut Value) {
    let is_hosted = |tool: &Value| {
        tool.pointer("/function/name").and_then(Value::as_str) == Some("ryu_responses_web_search")
    };
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        tools.retain(|tool| !is_hosted(tool));
        if tools.is_empty() {
            if let Some(object) = body.as_object_mut() {
                object.remove("tools");
                object.remove("tool_choice");
                object.remove("parallel_tool_calls");
            }
            return;
        }
    }
    if body.get("tool_choice").is_some_and(|choice| {
        choice.pointer("/function/name").and_then(Value::as_str) == Some("ryu_responses_web_search")
    }) {
        body["tool_choice"] = json!("auto");
    }
}

fn add_usage(total: &mut Value, usage: &Value) {
    for field in ["prompt_tokens", "completion_tokens", "total_tokens"] {
        if let Some(value) = usage.get(field).and_then(Value::as_u64) {
            total[field] = json!(total[field].as_u64().unwrap_or(0).saturating_add(value));
        }
    }
    let normalized = crate::compat::responses::chat_usage_to_responses(Some(usage));
    for field in ["cached_tokens", "cache_write_tokens"] {
        // The Responses wire defaults cached_tokens to zero, but aggregation
        // must retain the distinction between reported usage and unknown usage.
        if field == "cached_tokens"
            && usage["prompt_tokens_details"][field].as_u64().is_none()
            && usage["input_tokens_details"][field].as_u64().is_none()
            && usage["cache_read_input_tokens"].as_u64().is_none()
        {
            continue;
        }
        if let Some(value) = normalized["input_tokens_details"][field].as_u64() {
            total["prompt_tokens_details"][field] = json!(total["prompt_tokens_details"][field]
                .as_u64()
                .unwrap_or(0)
                .saturating_add(value));
        }
    }
    if let Some(value) = usage
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(Value::as_u64)
    {
        total["completion_tokens_details"]["reasoning_tokens"] = json!(total
            ["completion_tokens_details"]["reasoning_tokens"]
            .as_u64()
            .unwrap_or(0)
            .saturating_add(value));
    }
}

pub fn chat_stream(response: &Value) -> Body {
    let choice = &response["choices"][0];
    let mut delta = choice["message"].clone();
    if let Some(calls) = delta.get_mut("tool_calls").and_then(Value::as_array_mut) {
        for (index, call) in calls.iter_mut().enumerate() {
            call["index"] = json!(index);
        }
    }
    let mut first = json!({"choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    if !choice["logprobs"].is_null() {
        first["choices"][0]["logprobs"] = choice["logprobs"].clone();
    }
    let final_chunk = json!({"choices":[{"index":0,"delta":{},"finish_reason":choice["finish_reason"]}],"usage":response["usage"]});
    Body::from(format!(
        "data: {first}\n\ndata: {final_chunk}\n\ndata: [DONE]\n\n"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_gw_credentials::web::WebProviderKind;
    use ryu_gw_providers::web::{WebSearchOutput, WebSearchResult, WebServiceUsage};
    use ryu_gw_providers::{Provider, ProviderError};
    use std::{
        future::Future,
        pin::Pin,
        sync::atomic::{AtomicUsize, Ordering},
    };
    #[test]
    fn hosted_steps_preserve_cache_metrics_and_unknown_values() {
        let mut total = json!({});
        add_usage(
            &mut total,
            &json!({"prompt_tokens":3,"completion_tokens":1,"cache_read_input_tokens":2}),
        );
        add_usage(
            &mut total,
            &json!({"prompt_tokens":4,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1,"cache_write_tokens":2}}),
        );
        assert_eq!(total["prompt_tokens_details"]["cached_tokens"], 3);
        assert_eq!(total["prompt_tokens_details"]["cache_write_tokens"], 2);
        assert_eq!(total["prompt_tokens"], 7);
        let mut unknown = json!({});
        add_usage(&mut unknown, &json!({"prompt_tokens":1}));
        assert!(unknown.get("prompt_tokens_details").is_none());
        add_usage(
            &mut unknown,
            &json!({"prompt_tokens_details":{"cached_tokens":0}}),
        );
        assert_eq!(unknown["prompt_tokens_details"]["cached_tokens"], 0);
        assert!(unknown["prompt_tokens_details"]
            .get("cache_write_tokens")
            .is_none());
    }
    struct Fixture {
        web: bool,
        calls: Arc<AtomicUsize>,
    }
    impl Provider for Fixture {
        fn name(&self) -> &'static str {
            if self.web {
                "tavily"
            } else {
                "hosted-chat-fixture"
            }
        }
        fn web_descriptor(
            &self,
        ) -> Option<&'static ryu_gw_credentials::web::WebProviderDescriptor> {
            self.web.then(|| WebProviderKind::Tavily.descriptor())
        }
        fn complete<'a>(
            &'a self,
            _: &'a str,
            body: &'a Value,
        ) -> Pin<Box<dyn Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
            Box::pin(async move {
                let finished = body["messages"].as_array().is_some_and(|messages| {
                    messages.iter().any(|message| message["role"] == "tool")
                });
                let message = if finished {
                    json!({"role":"assistant","content":"searched"})
                } else {
                    json!({"role":"assistant","content":null,"tool_calls":[{"id":"web_call","type":"function","function":{"name":"ryu_responses_web_search","arguments":"{\"query\":\"fixture query\"}"}}]})
                };
                Ok(
                    json!({"choices":[{"message":message,"finish_reason":if finished{"stop"}else{"tool_calls"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}),
                )
            })
        }
        fn complete_stream<'a>(
            &'a self,
            _: &'a str,
            _: &'a Value,
        ) -> Pin<Box<dyn Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
            Box::pin(async { Err(ProviderError::Provider("fixture is buffered".into())) })
        }
        fn web_search_for_session<'a>(
            &'a self,
            request: &'a WebSearchRequest,
            _: Option<&'a str>,
        ) -> Pin<Box<dyn Future<Output = Result<WebSearchOutput, ProviderError>> + Send + 'a>>
        {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(WebSearchOutput {
                    results: vec![WebSearchResult {
                        title: Some("Fixture".into()),
                        url: "https://example.com/fixture".into(),
                        snippet: request.query().into(),
                        score: None,
                    }],
                    usage: WebServiceUsage {
                        requests: 1,
                        ..Default::default()
                    },
                })
            })
        }
    }
    fn fixture() -> (SharedState, Arc<AtomicUsize>) {
        let mut config = crate::config::GatewayConfig::default();
        config.auth=serde_json::from_value(json!({"require_auth":false,"api_keys":[{"key":"hosted-allowed","name":"allowed","allowed_operations":["inference","web_search"]},{"key":"hosted-inference","name":"inference-only"}]})).unwrap();
        config.cache.enabled = false;
        config.firewall.enabled = false;
        config.routing.default_provider = crate::config::ProviderId::from("hosted-chat-fixture");
        config.routing.fallback_chain =
            vec![crate::config::ProviderId::from("hosted-chat-fixture")];
        config.providers.web = serde_json::from_value(
            json!({"tavily":{"mode":"accounts","accounts":[{"api_key":"fixture-provider-key"}]}}),
        )
        .unwrap();
        config.routing.web.search = Some(crate::web_config::WebBinding::Provider {
            provider: WebProviderKind::Tavily,
        });
        let mut state = crate::state::AppState::new_for_test(
            config,
            crate::audit::AuditLogger::new(&crate::config::AuditConfig {
                enabled: false,
                db_path: String::new(),
            })
            .unwrap(),
            crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        state.provider_runtime.register_for_test(Arc::new(Fixture {
            web: false,
            calls: Arc::clone(&calls),
        }));
        state.provider_runtime.register_for_test(Arc::new(Fixture {
            web: true,
            calls: Arc::clone(&calls),
        }));
        (Arc::new(state), calls)
    }
    async fn invoke(
        state: SharedState,
        key: &str,
        live: bool,
    ) -> Result<(PipelineOutput, Vec<Value>, Vec<Value>), GatewayError> {
        invoke_with_limit(state, key, live, None).await
    }
    async fn invoke_with_limit(
        state: SharedState,
        key: &str,
        live: bool,
        max_tool_calls: Option<u64>,
    ) -> Result<(PipelineOutput, Vec<Value>, Vec<Value>), GatewayError> {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
        let context = pipeline::authenticate_for_operation(
            &state,
            super::super::web::inputs(&headers),
            ApiKeyOperation::Inference,
        )
        .await?;
        let request=crate::compat::responses::ResponseCreateRequest::parse(json!({"model":"fixture-model","input":"query","tools":[{"type":"web_search","external_web_access":live}]})).unwrap();
        let history = request.to_chat_messages().unwrap();
        run(
            state,
            context,
            &headers,
            request.to_chat_body(history.clone(), false),
            request.tool_registry.hosted_web.as_ref().unwrap(),
            history,
            max_tool_calls,
        )
        .await
    }
    #[tokio::test]
    async fn zero_max_tool_calls_withdraws_hosted_search_before_inference() {
        let (state, calls) = fixture();
        // The fixture model always calls search while the tool is offered and
        // the conversation has no tool result; with the tool withdrawn it is
        // still asked, so the loop must not execute a search.
        let result = invoke_with_limit(state, "hosted-allowed", true, Some(0)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let (_, _, records) = result.unwrap();
        assert!(records.iter().all(|record| record["status"] == "failed"));
    }
    #[test]
    fn withdrawing_hosted_tool_keeps_client_tools() {
        let mut body = json!({"tools":[{"type":"function","function":{"name":"ryu_responses_web_search"}},{"type":"function","function":{"name":"lookup"}}],"tool_choice":{"type":"function","function":{"name":"ryu_responses_web_search"}}});
        withdraw_hosted_tool(&mut body);
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
        assert_eq!(body["tool_choice"], "auto");
        let mut only_hosted = json!({"tools":[{"type":"function","function":{"name":"ryu_responses_web_search"}}],"tool_choice":"required"});
        withdraw_hosted_tool(&mut only_hosted);
        assert!(only_hosted.get("tools").is_none());
        assert!(only_hosted.get("tool_choice").is_none());
    }
    #[tokio::test]
    async fn live_hosted_search_uses_existing_provider_pipeline_and_sums_inference_usage() {
        // Search results re-enter the model boundary-wrapped; pin the
        // process-global wrapping flag on for this test.
        let _guard = crate::untrusted::FLAG_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::untrusted::set_enabled(true);
        let (state, calls) = fixture();
        let (output, history, records) = invoke(state, "hosted-allowed", true).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(records[0]["status"], "completed");
        assert_eq!(
            records[0]["action"]["sources"][0]["url"],
            "https://example.com/fixture"
        );
        assert_eq!(output.response["usage"]["total_tokens"], 4);
        let tool_results = history
            .iter()
            .filter(|message| message["role"] == "tool")
            .collect::<Vec<_>>();
        assert_eq!(tool_results.len(), 1);
        let content = tool_results[0]["content"].as_str().expect("tool content");
        assert!(
            content.starts_with(crate::untrusted::UNTRUSTED_OPEN)
                && content.ends_with(crate::untrusted::UNTRUSTED_CLOSE),
            "web search results must be boundary-wrapped: {content}"
        );
        assert!(content.contains("https://example.com/fixture"));
    }
    #[tokio::test]
    async fn cached_only_search_reports_unavailable_without_provider_egress() {
        let (state, calls) = fixture();
        let (_, _, records) = invoke(state, "hosted-allowed", false).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(records[0]["error"]["code"], "cached_web_search_unavailable");
        assert_eq!(records[0]["status"], "failed");
    }
    #[tokio::test]
    async fn inference_grant_cannot_execute_live_or_cached_hosted_search() {
        for live in [false, true] {
            let (state, calls) = fixture();
            assert!(invoke(state, "hosted-inference", live).await.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    }
}
