//! Audio engine and model catalog routes: list and install TTS engines and models.

use super::*;

/// `GET /api/voice/tts-engines` — list available Audio engines for the desktop
/// picker. Always includes the built-in `outetts`, the native `audiocpp` runtime,
/// and the cloud slot, then mirrors the Ryu TTS sidecar's `/engines` catalog when
/// it is reachable.
#[utoipa::path(
    get,
    path = "/api/voice/tts-engines",
    tag = "Voice",
    summary = "list available Audio engines for the desktop",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn tts_engines(State(state): State<ServerState>) -> impl IntoResponse {
    let builtin = json!({
        "id": "outetts",
        "display_name": "OuteTTS (built-in)",
        "description": "Local OuteTTS + WavTokenizer on llama.cpp · CPU-friendly",
        "voices": [],
        "default_voice": "",
        "sample_rate": 24000,
        "supports_cloning": false,
        "languages": ["en"],
        "size_mb": 0,
        "installed": true,
        "loaded": false,
    });

    // Both alternate slots are listed independently of the Ryu TTS sidecar call
    // so every picker can select them before the Python sidecar is installed.
    let audio_cpp_loaded =
        crate::sidecar::providers::audiocpp::server_reachable(&state.client).await;
    let audio_cpp = crate::sidecar::providers::audiocpp::tts_engine_row(
        crate::sidecar::providers::audiocpp::tts_runtime_installed(),
        audio_cpp_loaded && crate::sidecar::providers::audiocpp::tts_model_present(),
    );
    let mut engines = vec![builtin, gateway_tts_engine_row(), audio_cpp];
    if let Ok(Value::Array(sidecar_engines)) =
        crate::sidecar::providers::ryutts::list_engines(&state.client).await
    {
        engines.extend(sidecar_engines);
    }
    (
        StatusCode::OK,
        Json(json!({ "object": "list", "data": engines })),
    )
        .into_response()
}

/// Request body for installing one optional Ryu TTS engine runtime.
#[derive(Debug, Deserialize)]
pub struct InstallTtsEngineRequest {
    /// Engine id from `/api/voice/tts-engines`.
    pub engine: String,
}

pub(crate) fn valid_tts_engine_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
}

/// `POST /api/voice/tts-engines/install` — install the selected engine's Python
/// dependencies into the managed Ryu TTS runtime. The engine id is resolved by
/// the sidecar's fixed registry; callers cannot supply package names or commands.
#[utoipa::path(
    post,
    path = "/api/voice/tts-engines/install",
    tag = "Voice",
    summary = "install a registered text-to-speech engine",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn tts_engines_install(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    headers: HeaderMap,
    Json(req): Json<InstallTtsEngineRequest>,
) -> impl IntoResponse {
    if let Err(response) =
        crate::server::media::enforce_host_voice_models_permission(&state, &caller, &headers).await
    {
        return response;
    }
    let engine = req.engine.trim();
    if !valid_tts_engine_id(engine) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid text-to-speech engine id" })),
        )
            .into_response();
    }
    let url = format!(
        "{}/engines/install",
        crate::sidecar::providers::ryutts::tts_base_url()
    );
    match install_tts_engine_at(
        &state.client,
        &url,
        &crate::sidecar::providers::ryutts::bearer(),
        engine,
    )
    .await
    {
        Ok(value) if value["installed"] == true => (StatusCode::OK, Json(value)).into_response(),
        Ok(value) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "Audio installer did not confirm the engine is installed", "detail": value })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error })),
        )
            .into_response(),
    }
}

pub(super) async fn install_tts_engine_at(
    client: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    engine: &str,
) -> Result<Value, String> {
    // Relay the Voice sidecar's own `{ "error": "…" }` sentence alone, so the
    // Companion's localizer can match it; transport detail goes to the log.
    const UNREACHABLE_MESSAGE: &str = "The Audio engine installer could not be reached.";
    const INSTALL_FAILED_MESSAGE: &str = "The text-to-speech engine could not be installed.";
    let logged = |message: &str, detail: String| {
        tracing::warn!(engine, %detail, "text-to-speech engine install failed");
        message.to_owned()
    };
    let response = build_tts_engine_install_request(client, base_url, bearer, engine)
        .send()
        .await
        .map_err(|error| logged(UNREACHABLE_MESSAGE, error.to_string()))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| logged(INSTALL_FAILED_MESSAGE, error.to_string()))?;
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&bytes[..bytes.len().min(4000)]).into_owned();
        let fallback = logged(INSTALL_FAILED_MESSAGE, format!("{status}: {detail}"));
        let refusal = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|body| {
                let error = body.get("error")?.as_str()?.trim();
                (!error.is_empty()).then(|| error.chars().take(500).collect::<String>())
            });
        return Err(refusal.unwrap_or(fallback));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| logged(INSTALL_FAILED_MESSAGE, error.to_string()))
}

pub(super) fn build_tts_engine_install_request(
    client: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    engine: &str,
) -> reqwest::RequestBuilder {
    let url = format!("{}/engines/install", base_url.trim_end_matches('/'));
    client
        .post(url)
        .timeout(std::time::Duration::from_secs(15 * 60))
        .bearer_auth(bearer)
        .json(&tts_engine_install_body(engine))
}

pub(super) fn tts_engine_install_body(engine: &str) -> Value {
    json!({ "engine": engine })
}

/// `GET /api/voice/tts-models` — the curated, installable Audio model catalog (the
/// voicebox-style known-good set, each model bound to its engine + cache state).
/// Distinct from the raw HF `pipeline_tag=text-to-speech` browse in the Models
/// tab: these are the models Core can actually install + run. The native
/// audio.cpp row is available even when its server is not running.
#[utoipa::path(
    get,
    path = "/api/voice/tts-models",
    tag = "Voice",
    summary = "the curated, installable Audio model catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn tts_models(State(state): State<ServerState>) -> impl IntoResponse {
    let mut models = vec![crate::sidecar::providers::audiocpp::tts_model_row()];
    if let Ok(Value::Array(rows)) =
        crate::sidecar::providers::ryutts::list_models(&state.client).await
    {
        models.extend(rows);
    }
    (
        StatusCode::OK,
        Json(json!({ "object": "list", "data": models })),
    )
        .into_response()
}

/// Request body for installing a curated Audio model.
#[derive(Debug, Deserialize)]
pub struct InstallTtsModelRequest {
    /// Engine id the model belongs to (from `/api/voice/tts-models`).
    pub engine: String,
    /// Curated `model_name` to install.
    pub model_name: String,
}

/// `POST /api/voice/tts-models/install` — download a curated model into the
/// Core-managed HF cache (`HF_HOME` under `~/.ryu`) via the sidecar's
/// `snapshot_download`. The download is registered with the DownloadCenter (a
/// spinner entry, since HF reports no byte total here) so it shows in the global
/// download overlay. Idempotent — a cache hit returns immediately.
#[utoipa::path(
    post,
    path = "/api/voice/tts-models/install",
    tag = "Voice",
    summary = "download a curated model into the",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn tts_models_install(
    State(state): State<ServerState>,
    Json(req): Json<InstallTtsModelRequest>,
) -> impl IntoResponse {
    let engine = req.engine.clone();
    let model_name = req.model_name.clone();
    let client = state.client.clone();
    if engine == "audiocpp" && model_name != "pocket_tts_english_q8_0" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "unsupported audio.cpp model; use pocket_tts_english_q8_0"
            })),
        )
            .into_response();
    }
    let label = format!("Audio model: {model_name}");

    let result = if engine == "audiocpp" {
        let downloads = state.downloads.clone();
        state
            .downloads
            .register_indeterminate_as(
                format!("tts-model:{engine}:{model_name}"),
                crate::downloads::DownloadKind::Model,
                crate::downloads::DownloadRole::VoiceModel,
                label,
                async move {
                    let version = crate::sidecar::providers::audiocpp::AudioCppDownloader::new()
                        .ensure_installed(&downloads)
                        .await?;
                    Ok(json!({
                        "engine": "audiocpp",
                        "model_name": "pocket_tts_english_q8_0",
                        "version": version,
                        "installed": true,
                    }))
                },
            )
            .await
    } else {
        state
            .downloads
            .register_indeterminate_as(
                format!("tts-model:{engine}:{model_name}"),
                crate::downloads::DownloadKind::Model,
                crate::downloads::DownloadRole::VoiceModel,
                label,
                async move {
                    crate::sidecar::providers::ryutts::install_model(&client, &engine, &model_name)
                        .await
                },
            )
            .await
    };

    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("installing Audio model failed: {e:#}") })),
        )
            .into_response(),
    }
}
