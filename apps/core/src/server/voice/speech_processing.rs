//! Speech processing (S1-mini transcript cleanup): engine listing, model
//! install, and `POST /api/voice/speech-processing`.

use super::*;

/// The exact system prompt S1-mini was trained with. Keep this literal stable:
/// the model card warns that changing it can produce empty or garbled output.
pub const S1_MINI_SYSTEM_PROMPT: &str = "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.";

pub(super) const S1_DEFAULT_STYLING: &str = "semi-formal";
pub(super) const S1_DEFAULT_STRUCTURE: &str = "prose";
pub(super) const S1_DEFAULT_CONTEXT: &str = "general";
pub(super) const S1_STYLINGS: &[&str] = &["casual", "semi-casual", "semi-formal", "formal"];
pub(super) const S1_STRUCTURES: &[&str] = &["prose", "lists"];
pub(super) const S1_CONTEXTS: &[&str] = &["general", "email"];
pub(super) const S1_MAX_NEW_TOKENS: u32 = 1024;

/// Request body for the Speech Processing cleanup stage.
#[derive(Debug, Deserialize)]
pub struct SpeechProcessingRequest {
    /// Raw text returned by Voice Recognition.
    pub text: String,
    /// Speech Processing engine id. Omitted = the node's default S1-mini engine.
    #[serde(default)]
    pub engine: Option<String>,
    /// S1-mini styling control-line value.
    #[serde(default)]
    pub styling: Option<String>,
    /// S1-mini structure control-line value.
    #[serde(default)]
    pub structure: Option<String>,
    /// S1-mini destination-context control-line value.
    #[serde(default)]
    pub context: Option<String>,
}

/// Request body for installing the default Speech Processing model.
#[derive(Debug, Deserialize)]
pub struct InstallSpeechProcessingModelRequest {
    /// Engine id to install. Omitted = S1-mini.
    #[serde(default)]
    pub engine: Option<String>,
}

pub(super) fn s1_axis(
    value: Option<&str>,
    default: &str,
    allowed: &[&str],
    name: &str,
) -> Result<String, String> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default);
    if allowed.contains(&value) {
        Ok(value.to_owned())
    } else {
        Err(format!("unsupported S1-mini {name} value: {value}"))
    }
}

pub(super) fn s1_control_line(request: &SpeechProcessingRequest) -> Result<String, String> {
    let styling = s1_axis(
        request.styling.as_deref(),
        S1_DEFAULT_STYLING,
        S1_STYLINGS,
        "styling",
    )?;
    let structure = s1_axis(
        request.structure.as_deref(),
        S1_DEFAULT_STRUCTURE,
        S1_STRUCTURES,
        "structure",
    )?;
    let context = s1_axis(
        request.context.as_deref(),
        S1_DEFAULT_CONTEXT,
        S1_CONTEXTS,
        "context",
    )?;
    Ok(format!(
        "[Styling: {styling}] [Structure: {structure}] [Context: {context}]"
    ))
}

pub(super) fn s1_payload(model: &str, request: &SpeechProcessingRequest) -> Result<Value, String> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err("missing `text` (the raw transcript to clean)".to_owned());
    }
    let engine = request
        .engine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID);
    if engine != crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID {
        return Err(format!("unknown Speech Processing engine: {engine}"));
    }
    let control = s1_control_line(request)?;
    Ok(json!({
        "model": model,
        "messages": [
            { "role": "system", "content": S1_MINI_SYSTEM_PROMPT },
            { "role": "user", "content": format!("{control}\n{text}") },
        ],
        "temperature": 0,
        "max_tokens": S1_MAX_NEW_TOKENS,
        "stream": false,
        "chat_template_kwargs": { "enable_thinking": false },
    }))
}

/// `GET /api/voice/speech-processing-engines` — the node's Speech Processing
/// engines and model state. The list is deliberately separate from Voice
/// Recognition: ASR and cleanup are two independent layers.
#[utoipa::path(
    get,
    path = "/api/voice/speech-processing-engines",
    tag = "Voice",
    summary = "list Speech Processing engines",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn speech_processing_engines(State(state): State<ServerState>) -> impl IntoResponse {
    let registry = crate::registry::ModelRegistry::from_env();
    let loaded = state
        .manager
        .statuses()
        .into_iter()
        .find(|status| {
            status.name
                == crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_SIDECAR_NAME
        })
        .is_some_and(|status| status.running);
    let installed = registry.local_speech_model.weight_path().exists();
    let row = json!({
        "id": crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID,
        "display_name": "S1-mini by Superwhisper",
        "description": "Local transcript cleanup · punctuation, filler removal, corrections, and formatting",
        "model": registry.local_speech_model.id,
        "size_mb": 484,
        "languages": ["en"],
        "sidecar": crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_SIDECAR_NAME,
        "installed": installed,
        "loaded": loaded,
    });
    (
        StatusCode::OK,
        Json(json!({ "object": "list", "data": [row] })),
    )
        .into_response()
}

/// `POST /api/voice/speech-processing-model/install` — download the curated
/// default S1-mini GGUF through Core's checksum-verified download center.
#[utoipa::path(
    post,
    path = "/api/voice/speech-processing-model/install",
    tag = "Voice",
    summary = "install the Speech Processing model",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn speech_processing_model_install(
    State(state): State<ServerState>,
    Json(request): Json<InstallSpeechProcessingModelRequest>,
) -> impl IntoResponse {
    let engine = request
        .engine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID);
    if engine != crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("unknown Speech Processing engine: {engine}") })),
        )
            .into_response();
    }

    let registry = crate::registry::ModelRegistry::from_env();
    let id = registry.local_speech_model.id.clone();
    let result = state
        .downloads
        .resume_and_download_blocking(crate::model_catalog::gguf_download_spec(
            &id,
            &registry.local_speech_model.weight_url,
            &registry.local_speech_model.sha256,
            &format!("{id} (Speech Processing model)"),
            crate::downloads::DownloadRole::SpeechModel,
        ))
        .await;
    match result {
        Ok(path) => {
            state
                .manager
                .mark_installed(
                    crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_SIDECAR_NAME,
                )
                .await;
            if let Err(error) = crate::model_catalog::record_default_download(
                &id,
                &registry.local_speech_model.weight_url,
                None,
                None,
            ) {
                tracing::warn!("recording Speech Processing model provenance failed: {error:#}");
            }
            (
                StatusCode::OK,
                Json(json!({ "success": true, "engine": engine, "model": id, "path": path })),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(
                json!({ "error": format!("installing Speech Processing model failed: {error:#}") }),
            ),
        )
            .into_response(),
    }
}

/// `POST /api/voice/speech-processing` — clean one raw ASR transcript with the
/// selected Speech Processing engine. The dedicated sidecar is warmed lazily;
/// disabling cleanup in Dictation simply skips this endpoint.
#[utoipa::path(
    post,
    path = "/api/voice/speech-processing",
    tag = "Voice",
    summary = "clean a speech transcript",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn speech_processing(
    State(state): State<ServerState>,
    Json(request): Json<SpeechProcessingRequest>,
) -> impl IntoResponse {
    let registry = crate::registry::ModelRegistry::from_env();
    let model = registry.local_speech_model.id.clone();
    let payload = match s1_payload(&model, &request) {
        Ok(payload) => payload,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
        }
    };

    let sidecar_name = crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_SIDECAR_NAME;
    let _activity = state.manager.enter_request(sidecar_name);
    if let Err(error) = state
        .manager
        .wake_and_await_healthy(sidecar_name, std::time::Duration::from_secs(120))
        .await
    {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": format!("Speech Processing engine is unavailable: {error:#}") })),
        )
            .into_response();
    }

    let url = format!(
        "{}/v1/chat/completions",
        crate::sidecar::providers::llamacpp::speech::speech_processing_base_url()
    );
    let response = match state.client.post(&url).json(&payload).send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("Speech Processing request failed: {error}") })),
            )
                .into_response();
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return (
            StatusCode::BAD_GATEWAY,
            Json(
                json!({ "error": format!("Speech Processing engine returned {status}: {detail}") }),
            ),
        )
            .into_response();
    }

    let value: Value = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("could not parse Speech Processing response: {error}") })),
            )
                .into_response();
        }
    };
    let Some(text) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
    else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "Speech Processing response contained no text" })),
        )
            .into_response();
    };
    (
        StatusCode::OK,
        Json(json!({
            "text": text.trim(),
            "engine": crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID,
            "model": model,
        })),
    )
        .into_response()
}
