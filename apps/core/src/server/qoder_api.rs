//! Protected local relay for official Qoder CLI profiles and sealed PAT accounts.
use axum::{
    extract::rejection::JsonRejection,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use ryu_gw_providers::{Provider, ProviderError, QoderProvider, QoderRegion};
use serde_json::{json, Value};

/// Native Qoder CLI accepts text history; its shared validator rejects image and tool content.
#[derive(serde::Deserialize, serde::Serialize, utoipa::ToSchema)]
pub struct QoderCompletionRequest {
    /// Exact model ID returned by the selected profile's native CLI discovery.
    pub model: String,
    /// User/assistant text history and optional system/developer text instructions.
    /// Content is a string or an array of text blocks; image and tool blocks are rejected.
    pub messages: Vec<Value>,
    /// Emit normalized OpenAI SSE after the native turn completes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    /// Additional OpenAI fields remain subject to the shared native CLI validator.
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, Value>,
}

pub(super) fn register_security(doc: &mut utoipa::openapi::OpenApi) {
    use utoipa::openapi::security::{ApiKey, ApiKeyValue, SecurityScheme};
    doc.components
        .get_or_insert_with(Default::default)
        .add_security_scheme(
            "QoderNodeToken",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new("x-ryu-node-token"))),
        );
}

fn request_body(
    body: Result<Json<QoderCompletionRequest>, JsonRejection>,
) -> Result<Value, Response> {
    let Json(request) = body.map_err(|rejection| {
        let status = if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            StatusCode::PAYLOAD_TOO_LARGE
        } else {
            StatusCode::BAD_REQUEST
        };
        error(
            status,
            "invalid_request",
            "Supply a bounded Qoder model and text messages request",
        )
    })?;
    serde_json::to_value(request).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid_request",
            "The Qoder request could not be encoded",
        )
    })
}

fn error(status: StatusCode, kind: &str, message: &str) -> Response {
    (
        status,
        Json(json!({"error":{"type":kind,"code":kind,"message":message}})),
    )
        .into_response()
}

fn region(provider_id: &str) -> Result<QoderRegion, Response> {
    match provider_id {
        "qoder" => Ok(QoderRegion::Global),
        "qoder-cn" => Ok(QoderRegion::Cn),
        _ => Err(error(
            StatusCode::NOT_FOUND,
            "invalid_provider",
            "Unknown Qoder profile",
        )),
    }
}

fn capture_with(
    provider_id: &str,
    capture: impl FnOnce(&str) -> anyhow::Result<String>,
) -> Result<QoderProvider, Response> {
    let region = region(provider_id)?;
    // Capture the selected sealed credential once, before transport or discovery awaits.
    let token = capture(provider_id).map_err(|_| {
        error(
            StatusCode::UNAUTHORIZED,
            "authentication_required",
            "Save and select a Personal Access Token for this Qoder profile",
        )
    })?;
    if token.trim().is_empty() {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "authentication_required",
            "The selected Qoder Personal Access Token is empty",
        ));
    }
    Ok(QoderProvider::new(region, token))
}

fn captured(provider_id: &str) -> Result<QoderProvider, Response> {
    capture_with(provider_id, crate::pi_config::qoder_cli::capture_token)
}

fn model(body: &Value) -> Result<&str, Response> {
    body["model"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control))
        .ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Choose an exact Qoder model ID",
            )
        })
}

fn provider_error(failure: ProviderError) -> Response {
    match failure {
        ProviderError::RateLimited { retry_after, .. } => {
            let mut response = error(
                StatusCode::TOO_MANY_REQUESTS,
                "insufficient_quota",
                "Qoder reported insufficient quota for the selected account",
            );
            if let Some(seconds) = retry_after {
                if let Ok(value) = seconds.to_string().parse() {
                    response.headers_mut().insert("retry-after", value);
                }
            }
            response
        }
        ProviderError::DeliveryUncertain(_) | ProviderError::Transport(_) => {
            let mut response = error(
                StatusCode::BAD_GATEWAY,
                "delivery_uncertain",
                "Qoder delivery is uncertain; the request was not replayed",
            );
            response.headers_mut().insert(
                "x-ryu-delivery-uncertain",
                axum::http::HeaderValue::from_static("true"),
            );
            response
        }
        _ => error(
            StatusCode::BAD_GATEWAY,
            "qoder_error",
            "Qoder rejected the request or returned an invalid response",
        ),
    }
}

async fn complete(provider_id: &str, body: Value) -> Response {
    complete_with(
        provider_id,
        body,
        crate::pi_config::qoder_cli::capture_token,
    )
    .await
}

async fn complete_with(
    provider_id: &str,
    body: Value,
    capture: impl FnOnce(&str) -> anyhow::Result<String>,
) -> Response {
    let model = match model(&body) {
        Ok(model) => model,
        Err(response) => return response,
    };
    if ryu_gw_providers::qoder::validate_request(&body).is_err() {
        return error(
            StatusCode::BAD_REQUEST,
            "unsupported_content",
            "Qoder accepts text conversations without images or tools",
        );
    }
    let provider = match capture_with(provider_id, capture) {
        Ok(provider) => provider,
        Err(response) => return response,
    };
    if body["stream"].as_bool() == Some(true) {
        match provider.complete_stream(model, &body).await {
            Ok(body) => (
                [
                    ("content-type", "text/event-stream"),
                    ("cache-control", "no-cache"),
                ],
                body,
            )
                .into_response(),
            Err(failure) => provider_error(failure),
        }
    } else {
        match provider.complete(model, &body).await {
            Ok(value) => Json(value).into_response(),
            Err(failure) => provider_error(failure),
        }
    }
}

#[utoipa::path(
    post, path = "/api/pi-config/qoder/v1/chat/completions", tag = "Agents",
    summary = "Complete text using the official Qoder Global CLI",
    description = "Protected local CLI relay using the selected sealed Global PAT. No vendor HTTP inference endpoint or automatic replay. Image/tool input is rejected before credential capture. Streaming emits normalized SSE after terminal completion.",
    request_body = QoderCompletionRequest,
    security(("QoderNodeToken" = [])),
    responses(
        (status = 200, description = "OpenAI completion JSON or normalized SSE", content((Value = "application/json"), (String = "text/event-stream"))),
        (status = 400, description = "Invalid request or unsupported_content", body = Value),
        (status = 401, description = "Node authentication or selected sealed PAT required", body = Value),
        (status = 413, description = "Request exceeds the 1 MiB body limit", body = Value),
        (status = 429, description = "Native CLI insufficient_quota; error.code is insufficient_quota", body = Value),
        (status = 502, description = "CLI failure or delivery uncertain; request is not replayed", body = Value)
    )
)]
pub async fn global_completions(
    body: Result<Json<QoderCompletionRequest>, JsonRejection>,
) -> Response {
    match request_body(body) {
        Ok(body) => complete("qoder", body).await,
        Err(response) => response,
    }
}
#[utoipa::path(
    post, path = "/api/pi-config/qoder-cn/v1/chat/completions", tag = "Agents",
    summary = "Complete text using the official Qoder CN CLI",
    description = "Protected local CLI relay using the selected sealed CN PAT. Global and CN credentials are isolated. Image/tool input is rejected before credential capture. Streaming emits normalized SSE after terminal completion; failed delivery is not replayed.",
    request_body = QoderCompletionRequest,
    security(("QoderNodeToken" = [])),
    responses(
        (status = 200, description = "OpenAI completion JSON or normalized SSE", content((Value = "application/json"), (String = "text/event-stream"))),
        (status = 400, description = "Invalid request or unsupported_content", body = Value),
        (status = 401, description = "Node authentication or selected sealed PAT required", body = Value),
        (status = 413, description = "Request exceeds the 1 MiB body limit", body = Value),
        (status = 429, description = "Native CLI insufficient_quota; error.code is insufficient_quota", body = Value),
        (status = 502, description = "CLI failure or delivery uncertain; request is not replayed", body = Value)
    )
)]
pub async fn cn_completions(body: Result<Json<QoderCompletionRequest>, JsonRejection>) -> Response {
    match request_body(body) {
        Ok(body) => complete("qoder-cn", body).await,
        Err(response) => response,
    }
}

pub async fn discover_models(provider_id: &str) -> Result<Vec<Value>, Response> {
    captured(provider_id)?
        .discover_models()
        .await
        .ok_or_else(|| {
            error(
                StatusCode::BAD_GATEWAY,
                "discovery_unavailable",
                "Qoder model discovery is unavailable",
            )
        })
}

async fn models(provider_id: &str) -> Response {
    match discover_models(provider_id).await {
        Ok(models) => Json(json!({"object":"list","data":models})).into_response(),
        Err(response) => response,
    }
}
#[utoipa::path(
    get, path = "/api/pi-config/qoder/v1/models", tag = "Agents",
    summary = "Discover models from the official Qoder Global CLI",
    description = "Uses the selected sealed Global PAT for native --list-models discovery. Returns an OpenAI object:list/data envelope; this is not a quota API.",
    security(("QoderNodeToken" = [])),
    responses(
        (status = 200, description = "Native model discovery list", body = Value),
        (status = 401, description = "Node authentication or selected sealed PAT required", body = Value),
        (status = 502, description = "Native CLI model discovery unavailable", body = Value)
    )
)]
pub async fn global_models() -> Response {
    models("qoder").await
}
#[utoipa::path(
    get, path = "/api/pi-config/qoder-cn/v1/models", tag = "Agents",
    summary = "Discover models from the official Qoder CN CLI",
    description = "Uses the selected sealed CN PAT for native --list-models discovery, isolated from Global credentials. Returns an OpenAI object:list/data envelope; this is not a quota API.",
    security(("QoderNodeToken" = [])),
    responses(
        (status = 200, description = "Native model discovery list", body = Value),
        (status = 401, description = "Node authentication or selected sealed PAT required", body = Value),
        (status = 502, description = "Native CLI model discovery unavailable", body = Value)
    )
)]
pub async fn cn_models() -> Response {
    models("qoder-cn").await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
        middleware,
        routing::{get, post},
        Router,
    };
    use tower::ServiceExt;

    #[test]
    fn region_and_capture_are_exact_and_single_use() {
        assert_eq!(region("qoder").unwrap(), QoderRegion::Global);
        assert_eq!(region("qoder-cn").unwrap(), QoderRegion::Cn);
        for id in ["qoder", "qoder-cn"] {
            let mut calls = 0;
            let provider = capture_with(id, |requested| {
                calls += 1;
                assert_eq!(requested, id);
                Ok("synthetic-sealed-pat".into())
            })
            .unwrap();
            assert_eq!(provider.name(), id);
            assert_eq!(calls, 1);
        }
        assert!(capture_with("qoder.com", |_| panic!(
            "unknown profile must not access credentials"
        ))
        .is_err());
        assert!(capture_with("qoder", |_| Ok(" ".into())).is_err());
        assert!(capture_with("qoder-cn", |_| anyhow::bail!("private vault detail")).is_err());
    }

    #[test]
    fn model_validation_preserves_exact_ids_and_bounds_input() {
        let body = json!({"model":"qoder-exact/version-1"});
        assert_eq!(model(&body).unwrap(), "qoder-exact/version-1");
        for value in [
            json!(null),
            json!(""),
            json!("model\nflag"),
            json!("x".repeat(1025)),
        ] {
            assert!(model(&json!({"model":value})).is_err());
        }
    }

    #[tokio::test]
    async fn errors_hide_diagnostics_and_preserve_quota_and_no_replay_signals() {
        for failure in [
            ProviderError::Provider("synthetic-secret-stderr".into()),
            ProviderError::DeliveryUncertain("synthetic-secret-stderr".into()),
        ] {
            let response = provider_error(failure);
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            assert!(!String::from_utf8_lossy(&body).contains("synthetic-secret-stderr"));
        }
        let response = provider_error(ProviderError::RateLimited {
            provider: "qoder-cn".into(),
            retry_after: Some(30),
            reset_at: None,
        });
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()["retry-after"], "30");
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["error"]["type"], "insufficient_quota");
        assert_eq!(body["error"]["code"], "insufficient_quota");
        let response = provider_error(ProviderError::DeliveryUncertain("private".into()));
        assert_eq!(response.headers()["x-ryu-delivery-uncertain"], "true");
    }

    #[tokio::test]
    async fn both_profiles_require_node_auth_on_completion_and_discovery_routes() {
        for path in [
            "/api/pi-config/qoder/v1/chat/completions",
            "/api/pi-config/qoder/v1/models",
            "/api/pi-config/qoder-cn/v1/chat/completions",
            "/api/pi-config/qoder-cn/v1/models",
        ] {
            let (method, handler) = if path.ends_with("/models") {
                ("GET", get(|| async { StatusCode::NO_CONTENT }))
            } else {
                ("POST", post(|| async { StatusCode::NO_CONTENT }))
            };
            let app = Router::new()
                .route(path, handler)
                .layer(middleware::from_fn(|req, next| {
                    super::super::require_auth_with_token(
                        req,
                        next,
                        Some("synthetic-node-token".into()),
                    )
                }));
            for (token, expected) in [
                (None, StatusCode::UNAUTHORIZED),
                (Some("wrong-synthetic-token"), StatusCode::UNAUTHORIZED),
                (Some("synthetic-node-token"), StatusCode::NO_CONTENT),
            ] {
                let mut request = Request::builder().method(method).uri(path);
                if let Some(token) = token {
                    request = request.header("x-ryu-node-token", token);
                }
                assert_eq!(
                    app.clone()
                        .oneshot(request.body(Body::empty()).unwrap())
                        .await
                        .unwrap()
                        .status(),
                    expected
                );
            }
        }
    }

    #[tokio::test]
    async fn invalid_and_oversized_bodies_fail_before_credential_capture() {
        let app = Router::new().route(
            "/completion",
            post(global_completions).layer(axum::extract::DefaultBodyLimit::max(1024 * 1024)),
        );
        for (body, expected) in [
            ("{}".to_owned(), StatusCode::BAD_REQUEST),
            (
                json!({"model":"x".repeat(1025)}).to_string(),
                StatusCode::BAD_REQUEST,
            ),
            (
                json!({"model":"fixture","messages":"x".repeat(1024 * 1024)}).to_string(),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            let request = Request::builder()
                .method("POST")
                .uri("/completion")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn unsupported_content_returns_bad_request_without_capturing_pat() {
        for payload in [
            json!({"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.com/image.png"}}]}]}),
            json!({"messages":[{"role":"user","content":"hello"}],"tools":[{"type":"function","function":{"name":"test"}}]}),
            json!({"messages":[{"role":"assistant","content":"hello","tool_calls":[]}]}),
        ] {
            for provider_id in ["qoder", "qoder-cn"] {
                let mut body = payload.clone();
                body["model"] = json!("fixture-model");
                let response = complete_with(provider_id, body, |_| {
                    panic!("unsupported input must not access PAT custody")
                })
                .await;
                assert_eq!(response.status(), StatusCode::BAD_REQUEST);
                let body: Value =
                    serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap())
                        .unwrap();
                assert_eq!(body["error"]["code"], "unsupported_content");
            }
        }
    }

    #[test]
    fn qoder_openapi_includes_real_routes_typed_request_security_and_responses() {
        let spec = serde_json::to_value(super::super::openapi::api_doc()).unwrap();
        assert_eq!(
            spec["components"]["securitySchemes"]["QoderNodeToken"]["type"],
            "apiKey"
        );
        assert_eq!(
            spec["components"]["securitySchemes"]["QoderNodeToken"]["in"],
            "header"
        );
        assert_eq!(
            spec["components"]["securitySchemes"]["QoderNodeToken"]["name"],
            "x-ryu-node-token"
        );
        for profile in ["qoder", "qoder-cn"] {
            for (suffix, method) in [("chat/completions", "post"), ("models", "get")] {
                let path = format!("/api/pi-config/{profile}/v1/{suffix}");
                let operation = &spec["paths"][&path][method];
                assert!(operation.is_object(), "missing {method} {path}");
                assert!(operation["security"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|security| security.get("QoderNodeToken").is_some()));
                for status in ["200", "401", "502"] {
                    assert!(
                        operation["responses"].get(status).is_some(),
                        "missing status {status}: {path}"
                    );
                }
                assert!(operation["responses"]["200"]["content"]["application/json"]
                    .get("schema")
                    .is_some());
                if method == "post" {
                    assert_eq!(
                        operation["requestBody"]["content"]["application/json"]["schema"]["$ref"],
                        "#/components/schemas/QoderCompletionRequest"
                    );
                    assert_eq!(
                        operation["responses"]["200"]["content"]["text/event-stream"]["schema"]
                            ["type"],
                        "string"
                    );
                    for status in ["400", "413", "429"] {
                        assert!(operation["responses"].get(status).is_some());
                    }
                    assert!(operation["responses"]["400"]["description"]
                        .as_str()
                        .unwrap()
                        .contains("unsupported_content"));
                    assert!(operation["responses"]["429"]["description"]
                        .as_str()
                        .unwrap()
                        .contains("insufficient_quota"));
                }
            }
        }
        let schema = &spec["components"]["schemas"]["QoderCompletionRequest"];
        for name in ["model", "messages"] {
            assert!(schema["required"]
                .as_array()
                .unwrap()
                .contains(&json!(name)));
        }
        assert_eq!(schema["properties"]["model"]["type"], "string");
        assert_eq!(schema["properties"]["messages"]["type"], "array");
        let request: QoderCompletionRequest = serde_json::from_value(json!({"model":"exact-native-model","messages":[{"role":"user","content":"hello"}],"stream":true,"tools":[]})).unwrap();
        let actual_body = request_body(Ok(Json(request))).unwrap();
        assert_eq!(actual_body["model"], "exact-native-model");
        assert_eq!(actual_body["tools"], json!([]));
        assert_eq!(actual_body["stream"], true);
        assert!(ryu_gw_providers::qoder::validate_request(&actual_body).is_ok());
    }
}
