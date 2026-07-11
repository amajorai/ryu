//! Core → Shadow proxy for Ryu Clips (agent-native Loom/Jam).
//!
//! Shadow owns the sensor half of clips (screen + audio capture, ffmpeg mux, the
//! agent-context.json bundle). Core owns *what runs* — the clip session the
//! desktop drives — so it exposes a stable `/api/clips/*` surface on the
//! protected router and proxies each call to the Shadow sidecar over loopback.
//!
//! Placement (CLAUDE.md §1): capture + bundle is "what runs" (Core/Shadow).
//! Redacting diagnostics on egress is "what is shared" (a Gateway concern); v1
//! redacts client-side in the extension, so nothing here enforces policy.
//!
//! Fail-soft: when Shadow is down these handlers return `{ available: false,
//! reason }` (the same shape as the Shadow MCP provider) rather than a 5xx, so a
//! stopped sidecar degrades gracefully in the UI instead of erroring.

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;

/// Resolve the Shadow base URL: `RYU_SHADOW_URL` if set, else loopback Shadow.
/// Mirrors `sidecar/mcp/shadow.rs` so the address stays in one convention.
fn shadow_base() -> String {
    std::env::var("RYU_SHADOW_URL").unwrap_or_else(|_| "http://127.0.0.1:3030".into())
}

/// How long to wait for Shadow before declaring it unavailable. Clips involve
/// ffmpeg on the Shadow side, so this is more generous than a plain query.
const SHADOW_TIMEOUT_SECS: u64 = 15;

/// The default, undeletable system Space that finished clips are auto-filed into.
/// Seeded eagerly in `main.rs` (same pattern as "Artifacts") and re-resolved
/// idempotently at file-time via `ensure_system_space`.
pub const CLIPS_SPACE_NAME: &str = "Clips";
pub const CLIPS_SPACE_DESC: &str = "Screen recordings and clips captured by Ryu";

/// Build the fail-soft body returned when Shadow can't be reached.
fn unavailable(reason: impl Into<String>) -> Value {
    json!({ "available": false, "reason": reason.into() })
}

/// Rewrite a manifest's `framesEndpoint` from the Shadow-relative `/clips/{id}/frame`
/// to the Core-served `/api/clips/{id}/frame` so the desktop hits Core, not Shadow.
fn rewrite_frames_endpoint(body: &mut Value, id: &str) {
    if let Some(obj) = body.as_object_mut() {
        obj.insert(
            "framesEndpoint".to_string(),
            json!(format!("/api/clips/{id}/frame")),
        );
    }
}

/// How long to wait for a clip ingest (yt-dlp download + Shadow ffmpeg passes).
/// Far more generous than the plain-proxy timeout — a full video download plus
/// scene-detect extraction can run for minutes.
const INGEST_TIMEOUT_SECS: u64 = 600;

/// Body for `POST /api/clips/ingest` from the desktop `ingestClip`.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct IngestBody {
    /// A URL (`http`/`https`) to download, or a local video file path.
    pub source: String,
    /// Detail mode: `transcript` | `efficient` | `balanced` | `tokenBurner`.
    pub detail: Option<String>,
    /// Optional trim (ms).
    pub start: Option<u64>,
    pub end: Option<u64>,
}

impl Default for IngestBody {
    fn default() -> Self {
        Self {
            source: String::new(),
            detail: None,
            start: None,
            end: None,
        }
    }
}

/// The local video extensions accepted for a local-file ingest.
const LOCAL_VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "webm"];

/// POST /api/clips/ingest — turn a watched URL or a local video file into a clip
/// bundle indistinguishable from a recorded one. Core resolves the source (yt-dlp
/// for URLs → local mp4 + best-effort captions; validation for local files), then
/// hands the local path to Shadow's `/clips/ingest`, which owns the sensor half
/// (normalize + budgeted keyframe extraction + transcript + bundle). Core rewrites
/// `framesEndpoint` so the desktop hits Core, not Shadow.
///
/// Placement (CLAUDE.md §1): binary management + ingest orchestration + bundle
/// build are "what runs" → Core/Shadow. Routing the Whisper model call is "what
/// is measured/paid" → the Gateway (Shadow selects `sttEngine`; Core only emits
/// slot headers in `voice::transcribe_wav`).
pub async fn ingest(
    State(state): State<ServerState>,
    Json(body): Json<IngestBody>,
) -> (StatusCode, Json<Value>) {
    let source = body.source.trim().to_string();
    if source.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing `source` (a video URL or local file path)" })),
        );
    }

    let is_url = source.starts_with("http://") || source.starts_with("https://");

    // Resolve the source to a local path (+ optional captions). To keep a SINGLE
    // trim: a URL with a fully-bounded `[start, end)` is trimmed at download by
    // yt-dlp (bandwidth saver) and its start/end are then NOT forwarded to Shadow;
    // every other case (local file, or a one-sided URL trim) downloads/passes the
    // whole video and lets Shadow own the trim via start/end.
    let (video_path, captions, caption_segments, fwd_start, fwd_end) = if is_url {
        if let Err(e) = crate::sidecar::tools::ytdlp::YtDlpDownloader::new()
            .ensure_installed(&state.downloads)
            .await
        {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": format!("could not install the yt-dlp downloader: {e:#}")
                })),
            );
        }

        let work_dir = crate::paths::ryu_dir()
            .join("tmp")
            .join(format!("clip-ingest-{}", uuid::Uuid::new_v4().simple()));

        let trim_at_download = body.start.is_some() && body.end.is_some();
        let (dl_start, dl_end) = if trim_at_download {
            (body.start, body.end)
        } else {
            (None, None)
        };

        match crate::sidecar::tools::ytdlp::download_video(&source, &work_dir, dl_start, dl_end)
            .await
        {
            Ok(dl) => {
                let (fwd_start, fwd_end) = if trim_at_download {
                    (None, None)
                } else {
                    (body.start, body.end)
                };
                let caption_segments: Vec<Value> = dl
                    .caption_segments
                    .iter()
                    .map(|c| {
                        json!({ "startMs": c.start_ms, "endMs": c.end_ms, "text": c.text })
                    })
                    .collect();
                (
                    dl.video.to_string_lossy().to_string(),
                    dl.captions,
                    caption_segments,
                    fwd_start,
                    fwd_end,
                )
            }
            Err(e) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": format!("downloading the video failed: {e:#}") })),
                );
            }
        }
    } else {
        let path = std::path::PathBuf::from(&source);
        let canonical = match path.canonicalize() {
            Ok(p) => p,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("local file not found: {source}") })),
                );
            }
        };
        if !canonical.is_file() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("not a file: {source}") })),
            );
        }
        let ext_ok = canonical
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| LOCAL_VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if !ext_ok {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "unsupported video type (expected .mp4, .mov, .mkv, or .webm)"
                })),
            );
        }
        (
            canonical.to_string_lossy().to_string(),
            None,
            Vec::new(),
            body.start,
            body.end,
        )
    };

    // STT engine for the (captions-absent) transcript path: a swappable default,
    // "gateway" (Gateway-routed Whisper, default Groq) unless re-pointed.
    let stt_engine = std::env::var("RYU_CLIP_STT_ENGINE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gateway".to_string());

    let detail = body
        .detail
        .clone()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| "balanced".to_string());

    let payload = json!({
        "videoPath": video_path,
        "captions": captions,
        "captionSegments": caption_segments,
        "detail": detail,
        "start": fwd_start,
        "end": fwd_end,
        "sttEngine": stt_engine,
    });

    let url = format!("{}/clips/ingest", shadow_base());
    let resp = state
        .client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(INGEST_TIMEOUT_SECS))
        .send()
        .await;

    match resp {
        Ok(r) => {
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::OK);
            match r.json::<Value>().await {
                Ok(mut b) => {
                    if let Some(id) = b.get("id").and_then(Value::as_str).map(String::from) {
                        rewrite_frames_endpoint(&mut b, &id);
                    }
                    // A finished ingest (2xx) is auto-filed into the "Clips" space,
                    // fire-and-forget so it never delays or alters this response.
                    if status.is_success() {
                        tokio::spawn(file_clip_into_space(state.clone(), b.clone()));
                    }
                    (status, Json(b))
                }
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(unavailable(format!("Shadow returned an invalid response: {e}"))),
                ),
            }
        }
        // Fail-soft when Shadow is down, like the other proxy handlers.
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(unavailable(format!("Shadow is not reachable: {e}"))),
        ),
    }
}

/// GET /api/clips — list clips (proxied from Shadow).
pub async fn list_clips(State(state): State<ServerState>) -> Json<Value> {
    let url = format!("{}/clips", shadow_base());
    let resp = state
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(body) => Json(body),
            Err(e) => Json(unavailable(format!("Shadow returned an invalid response: {e}"))),
        },
        Ok(r) => Json(unavailable(format!("Shadow returned HTTP {}", r.status()))),
        Err(e) => Json(unavailable(format!("Shadow is not reachable: {e}"))),
    }
}

/// POST /api/clips/start — start a clip (proxied from Shadow).
pub async fn start_clip(
    State(state): State<ServerState>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let url = format!("{}/clips/start", shadow_base());
    let resp = state
        .client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
        .send()
        .await;
    match resp {
        Ok(r) => {
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::OK);
            match r.json::<Value>().await {
                Ok(body) => (status, Json(body)),
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(unavailable(format!("Shadow returned an invalid response: {e}"))),
                ),
            }
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(unavailable(format!("Shadow is not reachable: {e}"))),
        ),
    }
}

/// POST /api/clips/:id/stop — finalize a clip; rewrites `framesEndpoint`.
pub async fn stop_clip(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    let url = format!("{}/clips/{id}/stop", shadow_base());
    let resp = state
        .client
        .post(&url)
        .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
        .send()
        .await;
    match resp {
        Ok(r) => {
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::OK);
            match r.json::<Value>().await {
                Ok(mut body) => {
                    rewrite_frames_endpoint(&mut body, &id);
                    // A finalized clip (2xx) is auto-filed into the "Clips" space,
                    // fire-and-forget so it never delays or alters this response.
                    if status.is_success() {
                        tokio::spawn(file_clip_into_space(state.clone(), body.clone()));
                    }
                    (status, Json(body))
                }
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(unavailable(format!("Shadow returned an invalid response: {e}"))),
                ),
            }
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(unavailable(format!("Shadow is not reachable: {e}"))),
        ),
    }
}

/// POST /api/clips/:id/pause — pause the in-progress clip (proxied from Shadow).
pub async fn pause_clip(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    proxy_clip_post(&state, &format!("clips/{id}/pause")).await
}

/// POST /api/clips/:id/resume — resume a paused clip (proxied from Shadow).
pub async fn resume_clip(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    proxy_clip_post(&state, &format!("clips/{id}/resume")).await
}

/// Shared bodyless POST proxy to a Shadow `clips/*` path (pause/resume).
async fn proxy_clip_post(state: &ServerState, path: &str) -> (StatusCode, Json<Value>) {
    let url = format!("{}/{path}", shadow_base());
    let resp = state
        .client
        .post(&url)
        .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
        .send()
        .await;
    match resp {
        Ok(r) => {
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::OK);
            match r.json::<Value>().await {
                Ok(body) => (status, Json(body)),
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(unavailable(format!("Shadow returned an invalid response: {e}"))),
                ),
            }
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(unavailable(format!("Shadow is not reachable: {e}"))),
        ),
    }
}

/// GET /api/clips/sources — the displays + windows a clip can capture from
/// (proxied from Shadow). Fail-soft like `list_clips`.
pub async fn get_sources(State(state): State<ServerState>) -> Json<Value> {
    let url = format!("{}/clips/sources", shadow_base());
    let resp = state
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(body) => Json(body),
            Err(e) => Json(unavailable(format!("Shadow returned an invalid response: {e}"))),
        },
        Ok(r) => Json(unavailable(format!("Shadow returned HTTP {}", r.status()))),
        Err(e) => Json(unavailable(format!("Shadow is not reachable: {e}"))),
    }
}

/// GET /api/clips/:id/context — the clip manifest; rewrites `framesEndpoint`.
pub async fn get_context(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    let url = format!("{}/clips/{id}/context", shadow_base());
    let resp = state
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
        .send()
        .await;
    match resp {
        Ok(r) => {
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::OK);
            match r.json::<Value>().await {
                Ok(mut body) => {
                    rewrite_frames_endpoint(&mut body, &id);
                    (status, Json(body))
                }
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(unavailable(format!("Shadow returned an invalid response: {e}"))),
                ),
            }
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(unavailable(format!("Shadow is not reachable: {e}"))),
        ),
    }
}

/// Query for GET /api/clips/:id/frame.
#[derive(Debug, Deserialize)]
pub struct FrameQuery {
    #[serde(rename = "atMs", default)]
    pub at_ms: u64,
}

/// GET /api/clips/:id/frame?atMs= — stream a JPEG frame from Shadow.
pub async fn get_frame(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(q): Query<FrameQuery>,
) -> Response {
    let url = format!("{}/clips/{id}/frame", shadow_base());
    proxy_bytes(
        &state,
        state
            .client
            .get(&url)
            .query(&[("atMs", q.at_ms)])
            .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS)),
        "image/jpeg",
    )
    .await
}

/// GET /api/clips/:id/file — stream the clip.mp4 bytes from Shadow.
pub async fn get_file(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    let url = format!("{}/clips/{id}/file", shadow_base());
    proxy_bytes(
        &state,
        state
            .client
            .get(&url)
            .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS)),
        "video/mp4",
    )
    .await
}

/// POST /api/clips/:id/diagnostics — append diagnostics (proxied from Shadow).
pub async fn post_diagnostics(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let url = format!("{}/clips/{id}/diagnostics", shadow_base());
    let resp = state
        .client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
        .send()
        .await;
    match resp {
        Ok(r) => {
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::OK);
            match r.json::<Value>().await {
                Ok(body) => (status, Json(body)),
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(unavailable(format!("Shadow returned an invalid response: {e}"))),
                ),
            }
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(unavailable(format!("Shadow is not reachable: {e}"))),
        ),
    }
}

/// Query for GET /api/clips/recent-activity.
#[derive(Debug, Deserialize)]
pub struct RecentActivityQuery {
    #[serde(default)]
    pub minutes: Option<u32>,
}

/// GET /api/clips/recent-activity?minutes=<n> — proxy Shadow's ephemeral
/// "last N minutes" keyframe bundle straight through (nothing persisted). Core
/// only clamps `minutes` to 1..=15 (default 3) and passes the JSON unchanged.
/// Fail-soft like the other clips proxies.
pub async fn recent_activity(
    State(state): State<ServerState>,
    Query(q): Query<RecentActivityQuery>,
) -> (StatusCode, Json<Value>) {
    let minutes = q.minutes.unwrap_or(3).clamp(1, 15);
    let url = format!("{}/activity/recent?minutes={minutes}", shadow_base());
    let resp = state
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(body) => (StatusCode::OK, Json(body)),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(unavailable(format!("Shadow returned an invalid response: {e}"))),
            ),
        },
        Ok(r) => (
            StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(unavailable(format!("Shadow returned HTTP {}", r.status()))),
        ),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(unavailable(format!("Shadow is not reachable: {e}"))),
        ),
    }
}

/// Best-effort: file a just-finished clip into the "Clips" system Space. Fetches
/// the muxed mp4 from Shadow and stores it via `create_file`, plus a short
/// markdown summary via `ingest_document`. Every step is fail-soft (log +
/// continue); this NEVER affects the clip HTTP response. Spawn it, don't await it.
async fn file_clip_into_space(state: ServerState, bundle: Value) {
    let Some(id) = bundle.get("id").and_then(Value::as_str) else {
        return;
    };
    let id = id.to_string();
    let title = bundle
        .get("title")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Clip")
        .to_string();
    let duration_ms = bundle.get("durationMs").and_then(Value::as_u64).unwrap_or(0);

    // Resolve the Clips space at call time (idempotent get-or-create).
    let space_id = match state
        .spaces
        .ensure_system_space(CLIPS_SPACE_NAME, Some(CLIPS_SPACE_DESC))
        .await
    {
        Ok(sid) => sid,
        Err(e) => {
            tracing::warn!("clips auto-file: ensure Clips space failed: {e:#}");
            return;
        }
    };

    // 1) the mp4 blob — bytes come from Shadow over HTTP (the manifest `video` is
    //    a Shadow-internal relative path, so Core cannot read it off disk).
    let file_url = format!("{}/clips/{id}/file", shadow_base());
    match state
        .client
        .get(&file_url)
        .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.bytes().await {
            Ok(bytes) => {
                let fname = format!("{title}.mp4");
                if let Err(e) = state
                    .spaces
                    .create_file(&space_id, &fname, &bytes, "video/mp4")
                    .await
                {
                    tracing::warn!("clips auto-file: create_file failed: {e:#}");
                }
            }
            Err(e) => tracing::warn!("clips auto-file: reading mp4 bytes failed: {e}"),
        },
        Ok(r) => tracing::warn!("clips auto-file: Shadow /file returned HTTP {}", r.status()),
        Err(e) => tracing::warn!("clips auto-file: Shadow /file unreachable: {e}"),
    }

    // 2) the markdown summary doc (diagnostics + duration; raw transcript text is
    //    not proxied by Shadow, so we summarize the manifest we already have).
    let summary = build_clip_summary_md(&title, duration_ms, &bundle);
    if let Err(e) = state
        .spaces
        .ingest_document(&space_id, &title, &summary)
        .await
    {
        tracing::warn!("clips auto-file: ingest_document failed: {e:#}");
    }
}

/// Render a compact markdown summary from a finalized clip manifest.
fn build_clip_summary_md(title: &str, duration_ms: u64, bundle: &Value) -> String {
    let secs = duration_ms / 1000;
    let mm = secs / 60;
    let ss = secs % 60;
    let mut md = format!("# {title}\n\n- Duration: {mm:02}:{ss:02}\n");
    if let Some(w) = bundle.get("scanWarning").and_then(Value::as_str) {
        md.push_str(&format!("- Coverage: {w}\n"));
    }
    if let Some(moments) = bundle.get("recommendedMoments").and_then(Value::as_array) {
        if !moments.is_empty() {
            md.push_str("\n## Highlights\n");
            for m in moments {
                let at = m.get("atMs").and_then(Value::as_u64).unwrap_or(0) / 1000;
                let reason = m.get("reason").and_then(Value::as_str).unwrap_or("");
                md.push_str(&format!("- {at:02}s: {reason}\n"));
            }
        }
    }
    md
}

/// Stream a binary body from Shadow, forwarding its Content-Type (falling back to
/// `default_ct`). A transport failure or non-2xx becomes `502 Bad Gateway`.
async fn proxy_bytes(
    _state: &ServerState,
    request: reqwest::RequestBuilder,
    default_ct: &str,
) -> Response {
    let resp = match request.send().await {
        Ok(r) => r,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    if !resp.status().is_success() {
        return StatusCode::from_u16(resp.status().as_u16())
            .unwrap_or(StatusCode::BAD_GATEWAY)
            .into_response();
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or(default_ct)
        .to_string();
    match resp.bytes().await {
        Ok(bytes) => ([(header::CONTENT_TYPE, content_type)], bytes.to_vec()).into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}
