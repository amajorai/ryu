use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use tracing::debug;

use crate::{
    config::{Modality, ProviderKind},
    error::GatewayError,
    pipeline::{self, authenticate, AuthInputs},
    state::SharedState,
};

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// POST /v1/images/generations — image generation routed through the pipeline.
pub async fn image_generations(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let user_id = header_string(&headers, "x-ryu-user-id");
    let agent_id = header_string(&headers, "x-ryu-agent-id");
    // Per-agent image slot override (M3 / #164): Core forwards the agent's
    // image_model slot so the gateway can route this call to the slot's provider
    // instead of the static modality_map entry.
    let slot_provider = header_string(&headers, "x-ryu-slot-image-provider")
        .and_then(|s| s.parse::<ProviderKind>().ok());
    let slot_model = header_string(&headers, "x-ryu-slot-image-model");

    let ctx = authenticate(
        &state,
        AuthInputs {
            raw_api_key: raw_key,
            user_id,
            agent_id,
            slot_provider,
            slot_model,
            ..Default::default()
        },
    )?;
    debug!(request_id = %ctx.request_id, "image_generations: authenticated");

    let output = pipeline::run_multimodal(state, ctx, body, Modality::Image).await?;

    let mut response = Json(output.response).into_response();
    let hdrs = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&output.context.request_id) {
        hdrs.insert("x-request-id", v);
    }
    hdrs.insert("x-provider", HeaderValue::from_static(output.provider_used));
    if let Some(ref d) = output.degraded {
        if let Ok(v) = HeaderValue::from_str(&d.header_value()) {
            hdrs.insert("x-degraded", v);
        }
    }
    Ok(response)
}

/// POST /v1/audio/speech — TTS routed through the pipeline.
pub async fn audio_speech(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let user_id = header_string(&headers, "x-ryu-user-id");
    let agent_id = header_string(&headers, "x-ryu-agent-id");
    // Per-agent TTS slot override (M3 / #164).
    let slot_provider = header_string(&headers, "x-ryu-slot-tts-provider")
        .and_then(|s| s.parse::<ProviderKind>().ok());
    let slot_model = header_string(&headers, "x-ryu-slot-tts-model");

    let ctx = authenticate(
        &state,
        AuthInputs {
            raw_api_key: raw_key,
            user_id,
            agent_id,
            slot_provider,
            slot_model,
            ..Default::default()
        },
    )?;
    debug!(request_id = %ctx.request_id, "audio_speech: authenticated");

    let output = pipeline::run_multimodal(state, ctx, body, Modality::Tts).await?;

    let mut response = Json(output.response).into_response();
    let hdrs = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&output.context.request_id) {
        hdrs.insert("x-request-id", v);
    }
    hdrs.insert("x-provider", HeaderValue::from_static(output.provider_used));
    if let Some(ref d) = output.degraded {
        if let Ok(v) = HeaderValue::from_str(&d.header_value()) {
            hdrs.insert("x-degraded", v);
        }
    }
    Ok(response)
}

/// POST /v1/audio/transcriptions — STT routed through the pipeline.
pub async fn audio_transcriptions(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let user_id = header_string(&headers, "x-ryu-user-id");
    let agent_id = header_string(&headers, "x-ryu-agent-id");
    // Per-agent STT slot override (M3 / #164).
    let slot_provider = header_string(&headers, "x-ryu-slot-stt-provider")
        .and_then(|s| s.parse::<ProviderKind>().ok());
    let slot_model = header_string(&headers, "x-ryu-slot-stt-model");

    let ctx = authenticate(
        &state,
        AuthInputs {
            raw_api_key: raw_key,
            user_id,
            agent_id,
            slot_provider,
            slot_model,
            ..Default::default()
        },
    )?;
    debug!(request_id = %ctx.request_id, "audio_transcriptions: authenticated");

    let output = pipeline::run_multimodal(state, ctx, body, Modality::Stt).await?;

    let mut response = Json(output.response).into_response();
    let hdrs = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&output.context.request_id) {
        hdrs.insert("x-request-id", v);
    }
    hdrs.insert("x-provider", HeaderValue::from_static(output.provider_used));
    if let Some(ref d) = output.degraded {
        if let Ok(v) = HeaderValue::from_str(&d.header_value()) {
            hdrs.insert("x-degraded", v);
        }
    }
    Ok(response)
}

/// GET /v1/modalities — list available modalities and their configured providers.
pub async fn list_modalities(State(state): State<SharedState>) -> impl IntoResponse {
    use serde_json::json;

    let modality_map = &state.config.routing.modality_map;

    let entries: Vec<_> = [
        Modality::Chat,
        Modality::Image,
        Modality::Tts,
        Modality::Stt,
    ]
    .iter()
    .map(|m| {
        let mapping = modality_map.get(m);
        json!({
            "modality": m.as_str(),
            "provider": mapping.map(|mm| mm.provider.as_str()).unwrap_or("default"),
            "model": mapping.and_then(|mm| mm.model.as_deref()).unwrap_or(""),
            "configured": mapping.is_some(),
        })
    })
    .collect();

    (StatusCode::OK, Json(json!({ "modalities": entries })))
}
