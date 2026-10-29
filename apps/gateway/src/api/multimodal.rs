use axum::{
    extract::{Multipart, Path, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use tracing::debug;

use crate::{
    config::{Modality, ProviderId},
    error::GatewayError,
    pipeline::{self, authenticate, AuthInputs},
    state::SharedState,
};

/// Allows a bounded, base64-encoded image input plus the JSON request body.
pub const MAX_IMAGE_GENERATION_BODY_BYTES: usize = 24 * 1024 * 1024;

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn forwarded_request_id(headers: &HeaderMap, trusted_forwarder: bool) -> Option<String> {
    if !trusted_forwarder {
        return None;
    }
    let request_id = header_string(headers, "x-ryu-request-id")?;
    if request_id.len() <= 200
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        Some(request_id)
    } else {
        None
    }
}

fn forwarded_project_id(headers: &HeaderMap, trusted_forwarder: bool) -> Option<String> {
    if !trusted_forwarder {
        return None;
    }
    let project_id = header_string(headers, "x-ryu-project-id")?;
    if project_id.len() <= 160
        && project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        Some(project_id)
    } else {
        None
    }
}

fn apply_forwarded_identity(headers: &HeaderMap, ctx: &mut pipeline::RequestContext) {
    let trusted_forwarder = ctx
        .key_config
        .as_ref()
        .is_some_and(|config| config.trusted_forwarder);
    if let Some(request_id) = forwarded_request_id(headers, trusted_forwarder) {
        ctx.request_id = request_id;
    }
    if let Some(project_id) = forwarded_project_id(headers, trusted_forwarder) {
        ctx.project_id = Some(project_id);
    }
}

/// Parse the node's routing preferences off `x-ryu-node-routing` (see
/// `api::chat` for the discipline: unparseable is ignored, never rejected).
///
/// Carried on the four identity-bearing modality handlers so the FALLBACK clamp
/// applies to them: `run_multimodal` expands the chain through the same
/// `clamped_fallback_chain` helper as `run` / `run_stream`.
///
/// The firewall half is chat-only in v1, and that was checked rather than
/// assumed. `run_multimodal`'s inbound scan goes through `state.with_firewall`
/// (the process-global node-base scanner), not `state.resolved_scanner` — its one
/// `resolved_scanner` call is an Image-modality *logging* branch that enforces
/// nothing. So the request overlay has no seam to land on here. That is a
/// pre-existing gap, not one this channel introduced: the org and per-agent
/// scopes of the node → org → agent cascade do not reach these paths either.
/// Routing it through `resolved_scanner` is the fix, and it belongs with whoever
/// closes the cascade gap, not bolted on behind one new knob.
///
/// Also deliberately NOT in v1: the modality MAP itself. Per-modality pins
/// already travel as `x-ryu-slot-<modality>-provider` / `-model`, which these
/// handlers read alongside it — a second, differently-clamped way to say the
/// same thing would be two precedence rules to keep in agreement.
fn node_routing_prefs(
    state: &SharedState,
    headers: &HeaderMap,
) -> Option<pipeline::node_routing::NodeRoutingPrefs> {
    header_string(headers, "x-ryu-node-routing")
        .and_then(|v| pipeline::node_routing::parse(&v, &state.config.node_routing))
}

/// Authenticate a modality request: the bearer key, Core's forwarded identity
/// and correlation, the node's routing preferences, and the agent's slot
/// override for this modality (its `x-ryu-slot-<modality>-provider` / `-model`
/// headers).
async fn authenticate_modality(
    state: &SharedState,
    headers: &HeaderMap,
    slot_provider_header: &str,
    slot_model_header: &str,
) -> Result<pipeline::RequestContext, GatewayError> {
    let mut ctx = authenticate(
        state,
        AuthInputs {
            raw_api_key: headers.get("authorization").and_then(|v| v.to_str().ok()),
            user_id: header_string(headers, "x-ryu-user-id"),
            user_jwt: header_string(headers, "x-ryu-user-jwt"),
            agent_id: header_string(headers, "x-ryu-agent-id"),
            slot_provider: header_string(headers, slot_provider_header).map(ProviderId::from),
            slot_model: header_string(headers, slot_model_header),
            node_routing: node_routing_prefs(state, headers),
            agent_provider_access: header_string(headers, "x-ryu-agent-provider-access"),
            ..Default::default()
        },
    )
    .await?;
    apply_forwarded_identity(headers, &mut ctx);
    Ok(ctx)
}

/// Stamp the pipeline's correlation, provider, and degraded-mode headers.
fn insert_output_headers(response: &mut Response, output: &pipeline::PipelineOutput) {
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
}

/// POST /v1/images/generations — image generation routed through the pipeline.
pub async fn image_generations(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    // Per-agent image slot override (M3 / #164): Core forwards the agent's
    // image_model slot so the gateway can route this call to the slot's provider
    // instead of the static modality_map entry.
    let ctx = authenticate_modality(
        &state,
        &headers,
        "x-ryu-slot-image-provider",
        "x-ryu-slot-image-model",
    )
    .await?;
    debug!(request_id = %ctx.request_id, "image_generations: authenticated");

    let output = pipeline::run_multimodal(state, ctx, body, Modality::Image).await?;

    let mut response = Json(&output.response).into_response();
    insert_output_headers(&mut response, &output);
    Ok(response)
}

/// POST /v1/audio/speech — TTS routed through the pipeline.
pub async fn audio_speech(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    // Per-agent TTS slot override (M3 / #164).
    let ctx = authenticate_modality(
        &state,
        &headers,
        "x-ryu-slot-tts-provider",
        "x-ryu-slot-tts-model",
    )
    .await?;
    debug!(request_id = %ctx.request_id, "audio_speech: authenticated");

    super::audio_wire::validate_speech_request(&body)?;
    let (mut output, origin) = pipeline::run_speech(state, ctx, body).await?;
    let audio = if let Some(origin) = origin {
        origin.complete(&output.response).await.map_err(|_| {
            tracing::warn!(request_id = %output.context.request_id, provider = output.provider_used, phase = "speech_delivery", code = "accepted_audio_delivery_failed", "Accepted speech audio delivery failed");
            GatewayError::ProviderDeliveryUncertain("Accepted speech audio delivery failed".into())
        })?
    } else {
        output.response.take()
    };
    let (bytes, content_type) = super::audio_wire::inline_speech(&audio)?;
    let mut response = ([(axum::http::header::CONTENT_TYPE, content_type)], bytes).into_response();
    insert_output_headers(&mut response, &output);
    Ok(response)
}

/// POST /v1/audio/transcriptions — STT routed through the pipeline.
pub async fn audio_transcriptions(
    State(state): State<SharedState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Response, GatewayError> {
    // Per-agent STT slot override (M3 / #164).
    let ctx = authenticate_modality(
        &state,
        &headers,
        "x-ryu-slot-stt-provider",
        "x-ryu-slot-stt-model",
    )
    .await?;
    debug!(request_id = %ctx.request_id, "audio_transcriptions: authenticated");

    let (body, response_format) = super::audio_wire::transcription_body(multipart).await?;
    let output = pipeline::run_multimodal(state, ctx, body, Modality::Stt).await?;

    let mut response = if response_format == "text" {
        let text = output.response["text"].as_str().ok_or_else(|| {
            GatewayError::ProviderDeliveryUncertain(
                "Transcription returned no normalized text".into(),
            )
        })?;
        (
            [(
                axum::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )],
            text.to_owned(),
        )
            .into_response()
    } else if matches!(response_format.as_str(), "srt" | "vtt") {
        let subtitles = super::audio_wire::render_subtitles(&output.response, &response_format)?;
        let content_type = if response_format == "vtt" {
            "text/vtt; charset=utf-8"
        } else {
            "application/x-subrip; charset=utf-8"
        };
        (
            [(axum::http::header::CONTENT_TYPE, content_type)],
            subtitles,
        )
            .into_response()
    } else {
        Json(&output.response).into_response()
    };
    insert_output_headers(&mut response, &output);
    Ok(response)
}

/// Upper bound for a job-based media submission (video or audio). Reference
/// media (a source clip, first/last frames, a voice track) travels inline as
/// base64 `data:` URIs, so the axum 2 MiB default would reject ordinary
/// image-to-video, video-to-video and lip-sync requests. 64 MiB covers a short
/// 720p reference clip plus frames and audio with base64 overhead.
pub const MAX_MEDIA_JOB_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Authenticate a job-based media request, honoring the per-agent slot override
/// for that modality (`x-ryu-slot-{video|audio}-provider` / `-model`).
async fn authenticate_media_job(
    state: &SharedState,
    headers: &HeaderMap,
    modality: &Modality,
) -> Result<pipeline::RequestContext, GatewayError> {
    let label = modality.as_str();
    authenticate_modality(
        state,
        headers,
        &format!("x-ryu-slot-{label}-provider"),
        &format!("x-ryu-slot-{label}-model"),
    )
    .await
}

/// Authenticate a poll. Polls carry only the bearer: ownership is checked
/// against the job's recorded bindings, not against request headers.
async fn authenticate_media_poll(
    state: &SharedState,
    headers: &HeaderMap,
) -> Result<pipeline::RequestContext, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    authenticate(state, AuthInputs::with_key(raw_key)).await
}

/// POST /v1/videos/generations — submit a video-generation job (job-based; cloud
/// video runs for minutes). Returns 202 with `{ id, status }`; poll the id via
/// `GET /v1/videos/generations/{id}`.
pub async fn video_generations(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    let ctx = authenticate_media_job(&state, &headers, &Modality::Video).await?;
    debug!(request_id = %ctx.request_id, "video_generations: authenticated");
    let output = pipeline::submit_video_job(state, ctx, body).await?;
    Ok((StatusCode::ACCEPTED, Json(output)).into_response())
}

/// GET /v1/videos/generations/{id} — poll a submitted video job. Returns the
/// job envelope with current `status` and, once succeeded, the media `data`.
pub async fn video_job_status(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, GatewayError> {
    let ctx = authenticate_media_poll(&state, &headers).await?;
    let output = pipeline::poll_video_job(state, ctx, id).await?;
    Ok(Json(output).into_response())
}

/// POST /v1/audio/generations — submit an audio-generation job (music or sound
/// effects from a prompt, optionally with reference media). Job-based like
/// video: returns 202 with `{ id, status }`; poll `GET
/// /v1/audio/generations/{id}`. Speech from text stays on `/v1/audio/speech`.
pub async fn audio_generations(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    let ctx = authenticate_media_job(&state, &headers, &Modality::Audio).await?;
    debug!(request_id = %ctx.request_id, "audio_generations: authenticated");
    let output = pipeline::submit_audio_job(state, ctx, body).await?;
    Ok((StatusCode::ACCEPTED, Json(output)).into_response())
}

/// GET /v1/audio/generations/{id} — poll a submitted audio-generation job.
pub async fn audio_job_status(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, GatewayError> {
    let ctx = authenticate_media_poll(&state, &headers).await?;
    let output = pipeline::poll_audio_job(state, ctx, id).await?;
    Ok(Json(output).into_response())
}

/// GET /v1/modalities — list available modalities and their configured providers.
///
/// Authenticated like inference when `require_auth` is on (it reveals the
/// operator's provider and model routing); anonymous in no-auth mode.
pub async fn list_modalities(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, GatewayError> {
    use serde_json::json;

    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    authenticate(&state, AuthInputs::with_key(raw_key)).await?;

    let modality_map = &state.config.routing.modality_map;

    let entries: Vec<_> = [
        Modality::Chat,
        Modality::Image,
        Modality::Tts,
        Modality::Stt,
        Modality::Video,
        Modality::Audio,
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

    Ok((StatusCode::OK, Json(json!({ "modalities": entries }))))
}

#[cfg(test)]
mod tests {
    use super::{apply_forwarded_identity, forwarded_project_id, forwarded_request_id};
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn forwarded_request_id_requires_a_trusted_forwarder() {
        let mut headers = HeaderMap::new();
        headers.insert("x-ryu-request-id", HeaderValue::from_static("generation-1"));

        assert_eq!(forwarded_request_id(&headers, false), None);
        assert_eq!(
            forwarded_request_id(&headers, true).as_deref(),
            Some("generation-1")
        );
    }

    #[test]
    fn forwarded_correlation_is_preserved_for_media_receipts() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-ryu-request-id",
            HeaderValue::from_static("generation-repeat"),
        );
        headers.insert("x-ryu-project-id", HeaderValue::from_static("project-42"));
        let mut first = crate::pipeline::test_support::plain_request_context();
        first.request_id = uuid::Uuid::new_v4().to_string();
        first.key_config = Some(
            toml::from_str("key = 'fixture'\nname = 'Core'\ntrusted_forwarder = true\n")
                .expect("trusted Core key"),
        );
        let mut second = first.clone();
        second.request_id = uuid::Uuid::new_v4().to_string();
        apply_forwarded_identity(&headers, &mut first);
        apply_forwarded_identity(&headers, &mut second);
        assert_eq!(first.request_id, "generation-repeat");
        assert_eq!(second.request_id, "generation-repeat");
        assert_eq!(first.project_id.as_deref(), Some("project-42"));
    }

    #[test]
    fn forwarded_request_id_rejects_unsafe_or_oversized_values() {
        let mut headers = HeaderMap::new();
        headers.insert("x-ryu-request-id", HeaderValue::from_static("generation/1"));
        assert_eq!(forwarded_request_id(&headers, true), None);

        let mut oversized = HeaderMap::new();
        let value = "x".repeat(201);
        oversized.insert(
            "x-ryu-request-id",
            HeaderValue::from_str(&value).expect("valid header value"),
        );
        assert_eq!(forwarded_request_id(&oversized, true), None);
    }

    #[test]
    fn forwarded_project_id_is_trusted_only_from_core_and_bounded() {
        let mut headers = HeaderMap::new();
        headers.insert("x-ryu-project-id", HeaderValue::from_static("project-42"));
        assert_eq!(forwarded_project_id(&headers, false), None);
        assert_eq!(
            forwarded_project_id(&headers, true).as_deref(),
            Some("project-42")
        );

        let mut unsafe_headers = HeaderMap::new();
        unsafe_headers.insert("x-ryu-project-id", HeaderValue::from_static("project/42"));
        assert_eq!(forwarded_project_id(&unsafe_headers, true), None);
    }
}
