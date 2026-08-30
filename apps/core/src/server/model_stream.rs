//! Generic sidecar-to-Core streaming model callback.
//!
//! Apps that own a long-lived product flow can ask Core for a bounded text-only
//! model stream without receiving a node token, provider credential, or upstream
//! URL. Core authenticates the sidecar, checks its approved `hook:side-model`
//! grant, and routes the request through the existing Gateway local-provider
//! path.

use std::convert::Infallible;

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::StreamExt;
use ryu_app_events::{ModelStreamEvent, ModelStreamMessage, ModelStreamRequest};
use serde_json::{json, Value};

use super::ServerState;

const MAX_SSE_FRAME_BYTES: usize = 256 * 1024;

/// `POST /api/host/model/stream` — the generic streaming model callback for
/// Core-hosted sidecars.
pub async fn host_model_stream(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(request): Json<ModelStreamRequest>,
) -> Response {
    if let Err(error) = request.validate() {
        return error_response(
            StatusCode::BAD_REQUEST,
            error.to_string(),
            &request.request_id,
        );
    }
    if let Err((status, message)) =
        crate::sidecar::ext_proxy::authorize_host_call(&state, &headers, "hook:side-model").await
    {
        return error_response(status, message.to_owned(), &request.request_id);
    }

    let response = match open_gateway_stream(&state, &request).await {
        Ok(response) => response,
        Err(error) => return error_response(error.status(), error.message(), &request.request_id),
    };
    let stream = filter_gateway_stream(response, request.request_id.clone());
    crate::sidecar::adapters::sse_response(Body::from_stream(stream))
}

fn error_response(status: StatusCode, message: String, request_id: &str) -> Response {
    (
        status,
        Json(json!({
            "code": if status == StatusCode::BAD_REQUEST { "invalidArgs" } else { "modelStreamUnavailable" },
            "message": message,
            "requestId": request_id,
        })),
    )
        .into_response()
}

struct GatewayError {
    status: StatusCode,
    code: String,
    message: String,
}

impl GatewayError {
    fn status(&self) -> StatusCode {
        self.status
    }

    fn message(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

async fn open_gateway_stream(
    state: &ServerState,
    request: &ModelStreamRequest,
) -> Result<reqwest::Response, GatewayError> {
    let payload = json!({
        "model": request.model,
        "stream": true,
        "messages": request.messages.iter().map(message_value).collect::<Vec<_>>(),
        "max_tokens": request.max_tokens.unwrap_or(1024),
        "temperature": request.temperature,
    });
    let base = crate::sidecar::gateway::gateway_url();
    let mut outbound = state
        .client
        .post(format!(
            "{}/v1/chat/completions",
            base.trim_end_matches('/')
        ))
        .json(&payload);
    if let Some(provider) = request.provider.as_deref() {
        outbound = outbound.header("x-ryu-slot-chat-provider", provider);
    }
    if let Some(token) = crate::sidecar::gateway::gateway_token() {
        outbound = outbound.bearer_auth(token);
    }
    let response = outbound.send().await.map_err(|_| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "gatewayTransport".to_owned(),
        message: "the local model gateway could not be reached".to_owned(),
    })?;
    if !response.status().is_success() {
        return Err(GatewayError {
            status: if response.status() == StatusCode::UNAUTHORIZED
                || response.status() == StatusCode::FORBIDDEN
            {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::BAD_GATEWAY
            },
            code: "providerRejected".to_owned(),
            message: "the selected model provider rejected the request".to_owned(),
        });
    }
    Ok(response)
}

fn message_value(message: &ModelStreamMessage) -> Value {
    json!({ "role": message.role, "content": message.content })
}

fn filter_gateway_stream(
    response: reqwest::Response,
    request_id: String,
) -> impl futures_util::Stream<Item = Result<Bytes, Infallible>> + Send {
    async_stream::stream! {
        let mut upstream = response.bytes_stream();
        let mut buffer = Vec::new();
        let mut terminal = false;
        while let Some(chunk) = upstream.next().await {
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(_) => {
                    yield Ok(event_bytes(ModelStreamEvent::Failed {
                        request_id: request_id.clone(),
                        code: "providerTransport".to_owned(),
                        message: "the model stream ended unexpectedly".to_owned(),
                    }));
                    terminal = true;
                    break;
                }
            };
            buffer.extend_from_slice(&bytes);
            if buffer.len() > MAX_SSE_FRAME_BYTES {
                yield Ok(event_bytes(ModelStreamEvent::Failed {
                    request_id: request_id.clone(),
                    code: "frameTooLarge".to_owned(),
                    message: "the model stream frame was too large".to_owned(),
                }));
                terminal = true;
                break;
            }
            while let Some((position, delimiter_len)) = frame_boundary(&buffer) {
                let frame = buffer.drain(..position).collect::<Vec<_>>();
                buffer.drain(..delimiter_len);
                match gateway_frame(&frame, &request_id) {
                    Ok(Some((event, is_terminal))) => {
                        yield Ok(event_bytes(event));
                        if is_terminal {
                            terminal = true;
                            break;
                        }
                    }
                    Ok(None) => {}
                    Err((code, message)) => {
                        yield Ok(event_bytes(ModelStreamEvent::Failed {
                            request_id: request_id.clone(),
                            code,
                            message,
                        }));
                        terminal = true;
                        break;
                    }
                }
            }
            if terminal { break; }
        }
        if !terminal {
            yield Ok(event_bytes(ModelStreamEvent::Failed {
                request_id,
                code: "streamEnded".to_owned(),
                message: "the model stream ended without a terminal event".to_owned(),
            }));
        }
    }
}

fn event_bytes(event: ModelStreamEvent) -> Bytes {
    let mut output = b"data: ".to_vec();
    output.extend(serde_json::to_vec(&event).unwrap_or_else(|_| b"{}".to_vec()));
    output.extend_from_slice(b"\n\n");
    Bytes::from(output)
}

fn frame_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
        return Some((position, 4));
    }
    buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| (position, 2))
}

fn gateway_frame(
    frame: &[u8],
    request_id: &str,
) -> Result<Option<(ModelStreamEvent, bool)>, (String, String)> {
    let text = std::str::from_utf8(frame).map_err(|_| {
        (
            "invalidUtf8".to_owned(),
            "the model stream was not valid UTF-8".to_owned(),
        )
    })?;
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() {
        return Ok(None);
    }
    if data == "[DONE]" {
        return Ok(Some((
            ModelStreamEvent::Completed {
                request_id: request_id.to_owned(),
            },
            true,
        )));
    }
    let value = serde_json::from_str::<Value>(&data).map_err(|_| {
        (
            "invalidJson".to_owned(),
            "the model stream returned invalid JSON".to_owned(),
        )
    })?;
    if value.get("type").and_then(Value::as_str) == Some("completed") {
        return Ok(Some((
            ModelStreamEvent::Completed {
                request_id: request_id.to_owned(),
            },
            true,
        )));
    }
    if value.get("type").and_then(Value::as_str) == Some("error") || value.get("error").is_some() {
        return Ok(Some((
            ModelStreamEvent::Failed {
                request_id: request_id.to_owned(),
                code: "providerError".to_owned(),
                message: "the model provider returned an error".to_owned(),
            },
            true,
        )));
    }
    if let Some(delta) = value.get("delta").and_then(Value::as_str).or_else(|| {
        value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("delta"))
            .and_then(|delta| delta.get("content"))
            .and_then(Value::as_str)
    }) {
        return Ok(Some((
            ModelStreamEvent::TextDelta {
                request_id: request_id.to_owned(),
                delta: delta.to_owned(),
            },
            false,
        )));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::{frame_boundary, gateway_frame};
    use ryu_app_events::ModelStreamEvent;

    #[test]
    fn frame_boundary_accepts_lf_and_crlf() {
        assert_eq!(frame_boundary(b"data: x\n\nrest"), Some((7, 2)));
        assert_eq!(frame_boundary(b"data: x\r\n\r\nrest"), Some((7, 4)));
    }

    #[test]
    fn gateway_frame_projects_openai_delta_without_exposing_internal_shape() {
        let event = gateway_frame(
            br#"data: {"choices":[{"delta":{"content":"hello"}}]}"#,
            "req_1",
        )
        .expect("frame")
        .expect("event");
        assert_eq!(event.1, false);
        assert_eq!(
            event.0,
            ModelStreamEvent::TextDelta {
                request_id: "req_1".to_owned(),
                delta: "hello".to_owned(),
            }
        );
    }

    #[test]
    fn gateway_done_frame_is_terminal() {
        let event = gateway_frame(b"data: [DONE]", "req_1")
            .expect("frame")
            .expect("event");
        assert!(event.1);
        assert!(matches!(event.0, ModelStreamEvent::Completed { .. }));
    }
}
