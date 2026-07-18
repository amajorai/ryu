//! HTTP API for Ryu Clips (`/api/clips/*`).
//!
//! Surfaces the record/ingest/list/frame/stream flow, proxying each call to the
//! Shadow sidecar over loopback. See the crate root for the transport split and
//! the host-inversion rationale.
//!
//! The router is built with its own state ([`ClipsCtx`]) inside this crate so it
//! returns a state-less, mergeable `Router<()>`. Routes are declared relative to
//! `/api/clips` (Core nests this service at that prefix behind the Clips-App
//! gate), while the OpenAPI annotations keep the full external paths. The static
//! collection route is registered before the `:id` routes (convention).

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{shadow_base, SharedClipsHost};

/// Router state for the clips HTTP surface: the shared HTTP client (for the Shadow
/// proxy) and the injected [`crate::ClipsHost`] (yt-dlp ingest + Space filing).
/// Kept as a named type so the router bakes a concrete state and returns
/// `Router<()>`.
#[derive(Clone)]
pub struct ClipsCtx {
    pub client: reqwest::Client,
    pub host: SharedClipsHost,
}

impl ClipsCtx {
    pub fn new(client: reqwest::Client, host: SharedClipsHost) -> Self {
        Self { client, host }
    }
}

/// Build the `/api/clips/*` router with its own state baked in, returning a
/// state-less `Router<()>` the host nests at `/api/clips` behind the App gate.
pub fn routes(ctx: ClipsCtx) -> Router<()> {
    Router::new()
        .route("/", get(list_clips))
        .route("/ingest", post(ingest))
        .route("/sources", get(get_sources))
        .route("/recent-activity", get(recent_activity))
        .route("/start", post(start_clip))
        .route("/:id/stop", post(stop_clip))
        .route("/:id/pause", post(pause_clip))
        .route("/:id/resume", post(resume_clip))
        .route("/:id/context", get(get_context))
        .route("/:id/frame", get(get_frame))
        .route("/:id/file", get(get_file))
        .route("/:id/diagnostics", post(post_diagnostics))
        .with_state(ctx)
}

/// The OpenAPI sub-document for the clips surface, merged into Core's spec when
/// the `clips` feature is enabled.
pub fn openapi() -> utoipa::openapi::OpenApi {
    <ClipsApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(
    get_context,
    get_file,
    get_frame,
    get_sources,
    ingest,
    list_clips,
    pause_clip,
    post_diagnostics,
    recent_activity,
    resume_clip,
    start_clip,
    stop_clip,
))]
struct ClipsApiDoc;

/// How long to wait for Shadow before declaring it unavailable. Clips involve
/// ffmpeg on the Shadow side, so this is more generous than a plain query.
const SHADOW_TIMEOUT_SECS: u64 = 15;

/// How long to wait for a clip ingest (yt-dlp download + Shadow ffmpeg passes).
/// Far more generous than the plain-proxy timeout — a full video download plus
/// scene-detect extraction can run for minutes.
const INGEST_TIMEOUT_SECS: u64 = 600;

/// Build the fail-soft body returned when Shadow can't be reached.
fn unavailable(reason: impl Into<String>) -> Value {
    json!({ "available": false, "reason": reason.into() })
}

/// A clip id is a single path segment that we interpolate directly into a
/// loopback Shadow URL (`{shadow_base}/clips/{id}/...`). Axum percent-decodes
/// `Path<String>` before we see it, so an encoded `/` or `..` would let a caller
/// escape the intended `/clips/<id>/...` shape and reach arbitrary Shadow routes
/// (path traversal into the loopback service). Reject any id that could do so.
fn clip_id_is_safe(id: &str) -> bool {
    !id.is_empty() && !id.contains('/') && !id.contains("..")
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

/// Local-file ingest is restricted to an allowlist of user media folders so an
/// authenticated caller cannot use the endpoint to read arbitrary files on disk:
/// `$HOME/{Movies,Downloads,Desktop}` plus any colon-separated extra roots in
/// `RYU_CLIPS_ALLOWED_DIRS`. Bases are canonicalized before the prefix check so
/// symlinked paths (e.g. macOS `/var` → `/private/var`) compare correctly.
fn local_ingest_allowed(canonical: &std::path::Path) -> bool {
    let mut bases: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        for sub in ["Movies", "Downloads", "Desktop"] {
            bases.push(home.join(sub));
        }
    }
    if let Some(extra) = std::env::var_os("RYU_CLIPS_ALLOWED_DIRS") {
        bases.extend(std::env::split_paths(&extra));
    }
    bases
        .into_iter()
        .filter_map(|b| b.canonicalize().ok())
        .any(|b| canonical.starts_with(&b))
}

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
#[utoipa::path(
    post,
    path = "/api/clips/ingest",
    tag = "Clips",
    summary = "turn a watched URL or a local video file into a clip",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn ingest(
    State(ctx): State<ClipsCtx>,
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
        if let Err(e) = ctx.host.ensure_ytdlp().await {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": format!("could not install the yt-dlp downloader: {e}")
                })),
            );
        }

        let work_dir = ctx
            .host
            .tmp_dir()
            .join(format!("clip-ingest-{}", uuid::Uuid::new_v4().simple()));

        let trim_at_download = body.start.is_some() && body.end.is_some();
        let (dl_start, dl_end) = if trim_at_download {
            (body.start, body.end)
        } else {
            (None, None)
        };

        match ctx
            .host
            .download_video(&source, &work_dir, dl_start, dl_end)
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
                    Json(json!({ "error": format!("downloading the video failed: {e}") })),
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
        if !local_ingest_allowed(&canonical) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "local file is outside the allowed ingest folders (Movies, Downloads, Desktop, or RYU_CLIPS_ALLOWED_DIRS)"
                })),
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
    let resp = ctx
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
                        tokio::spawn(file_clip_into_space(ctx.clone(), b.clone()));
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
#[utoipa::path(
    get,
    path = "/api/clips",
    tag = "Clips",
    summary = "list clips (proxied from Shadow).",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_clips(State(ctx): State<ClipsCtx>) -> Json<Value> {
    let url = format!("{}/clips", shadow_base());
    let resp = ctx
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
#[utoipa::path(
    post,
    path = "/api/clips/start",
    tag = "Clips",
    summary = "start a clip (proxied from Shadow).",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn start_clip(
    State(ctx): State<ClipsCtx>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let url = format!("{}/clips/start", shadow_base());
    let resp = ctx
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
#[utoipa::path(
    post,
    path = "/api/clips/{id}/stop",
    tag = "Clips",
    summary = "finalize a clip; rewrites `framesEndpoint`.",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn stop_clip(
    State(ctx): State<ClipsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    if !clip_id_is_safe(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid clip id" })),
        );
    }
    let url = format!("{}/clips/{id}/stop", shadow_base());
    let resp = ctx
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
                        tokio::spawn(file_clip_into_space(ctx.clone(), body.clone()));
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
#[utoipa::path(
    post,
    path = "/api/clips/{id}/pause",
    tag = "Clips",
    summary = "pause the in-progress clip (proxied from Shadow).",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn pause_clip(
    State(ctx): State<ClipsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    if !clip_id_is_safe(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid clip id" })),
        );
    }
    proxy_clip_post(&ctx, &format!("clips/{id}/pause")).await
}

/// POST /api/clips/:id/resume — resume a paused clip (proxied from Shadow).
#[utoipa::path(
    post,
    path = "/api/clips/{id}/resume",
    tag = "Clips",
    summary = "resume a paused clip (proxied from Shadow).",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn resume_clip(
    State(ctx): State<ClipsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    if !clip_id_is_safe(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid clip id" })),
        );
    }
    proxy_clip_post(&ctx, &format!("clips/{id}/resume")).await
}

/// Shared bodyless POST proxy to a Shadow `clips/*` path (pause/resume).
async fn proxy_clip_post(ctx: &ClipsCtx, path: &str) -> (StatusCode, Json<Value>) {
    let url = format!("{}/{path}", shadow_base());
    let resp = ctx
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
#[utoipa::path(
    get,
    path = "/api/clips/sources",
    tag = "Clips",
    summary = "the displays + windows a clip can capture from",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_sources(State(ctx): State<ClipsCtx>) -> Json<Value> {
    let url = format!("{}/clips/sources", shadow_base());
    let resp = ctx
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
#[utoipa::path(
    get,
    path = "/api/clips/{id}/context",
    tag = "Clips",
    summary = "the clip manifest; rewrites `framesEndpoint`.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_context(
    State(ctx): State<ClipsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    if !clip_id_is_safe(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid clip id" })),
        );
    }
    let url = format!("{}/clips/{id}/context", shadow_base());
    let resp = ctx
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
#[utoipa::path(
    get,
    path = "/api/clips/{id}/frame",
    tag = "Clips",
    summary = "stream a JPEG frame from Shadow.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_frame(
    State(ctx): State<ClipsCtx>,
    Path(id): Path<String>,
    Query(q): Query<FrameQuery>,
) -> Response {
    if !clip_id_is_safe(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let url = format!("{}/clips/{id}/frame", shadow_base());
    proxy_bytes(
        ctx.client
            .get(&url)
            .query(&[("atMs", q.at_ms)])
            .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS)),
        "image/jpeg",
    )
    .await
}

/// GET /api/clips/:id/file — stream the clip.mp4 bytes from Shadow.
#[utoipa::path(
    get,
    path = "/api/clips/{id}/file",
    tag = "Clips",
    summary = "stream the clip.mp4 bytes from Shadow.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_file(State(ctx): State<ClipsCtx>, Path(id): Path<String>) -> Response {
    if !clip_id_is_safe(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let url = format!("{}/clips/{id}/file", shadow_base());
    proxy_bytes(
        ctx.client
            .get(&url)
            .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS)),
        "video/mp4",
    )
    .await
}

/// POST /api/clips/:id/diagnostics — append diagnostics (proxied from Shadow).
#[utoipa::path(
    post,
    path = "/api/clips/{id}/diagnostics",
    tag = "Clips",
    summary = "append diagnostics (proxied from Shadow).",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn post_diagnostics(
    State(ctx): State<ClipsCtx>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !clip_id_is_safe(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid clip id" })),
        );
    }
    let url = format!("{}/clips/{id}/diagnostics", shadow_base());
    let resp = ctx
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
#[utoipa::path(
    get,
    path = "/api/clips/recent-activity",
    tag = "Clips",
    summary = "proxy Shadow's ephemeral",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn recent_activity(
    State(ctx): State<ClipsCtx>,
    Query(q): Query<RecentActivityQuery>,
) -> (StatusCode, Json<Value>) {
    let minutes = q.minutes.unwrap_or(3).clamp(1, 15);
    let url = format!("{}/activity/recent?minutes={minutes}", shadow_base());
    let resp = ctx
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
/// the muxed mp4 from Shadow (the manifest `video` is a Shadow-internal relative
/// path, so Core cannot read it off disk), builds a short markdown summary, and
/// hands both to the host's [`crate::ClipsHost::store_clip`] (the Space filing is
/// kernel machinery). Fail-soft: this NEVER affects the clip HTTP response. Spawn
/// it, don't await it.
async fn file_clip_into_space(ctx: ClipsCtx, bundle: Value) {
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

    // The mp4 blob — bytes come from Shadow over HTTP (the manifest `video` is a
    // Shadow-internal relative path, so Core cannot read it off disk).
    let file_url = format!("{}/clips/{id}/file", shadow_base());
    let mp4: Option<Vec<u8>> = match ctx
        .client
        .get(&file_url)
        .timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.bytes().await {
            Ok(bytes) => Some(bytes.to_vec()),
            Err(e) => {
                tracing::warn!("clips auto-file: reading mp4 bytes failed: {e}");
                None
            }
        },
        Ok(r) => {
            tracing::warn!("clips auto-file: Shadow /file returned HTTP {}", r.status());
            None
        }
        Err(e) => {
            tracing::warn!("clips auto-file: Shadow /file unreachable: {e}");
            None
        }
    };

    let summary = build_clip_summary_md(&title, duration_ms, &bundle);
    ctx.host.store_clip(&title, mp4, &summary).await;
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
async fn proxy_bytes(request: reqwest::RequestBuilder, default_ct: &str) -> Response {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_id_is_safe_rejects_traversal_and_separators() {
        // Ordinary ids pass.
        assert!(clip_id_is_safe("abc123"));
        assert!(clip_id_is_safe("clip-2026-07-16_09-30"));
        // Empty is rejected (would collapse the URL path).
        assert!(!clip_id_is_safe(""));
        // A raw or (percent-)decoded slash would escape the `/clips/<id>/...` shape.
        assert!(!clip_id_is_safe("a/b"));
        assert!(!clip_id_is_safe("../secret"));
        assert!(!clip_id_is_safe("id/../../admin"));
        assert!(!clip_id_is_safe(".."));
        // Dot-dot anywhere is rejected, even without a separator.
        assert!(!clip_id_is_safe("a..b"));
    }

    #[test]
    fn rewrite_frames_endpoint_points_at_core() {
        let mut body = json!({ "id": "abc", "framesEndpoint": "/clips/abc/frame" });
        rewrite_frames_endpoint(&mut body, "abc");
        assert_eq!(body["framesEndpoint"], json!("/api/clips/abc/frame"));
    }

    #[test]
    fn rewrite_frames_endpoint_inserts_when_absent() {
        let mut body = json!({ "id": "xy" });
        rewrite_frames_endpoint(&mut body, "xy");
        assert_eq!(body["framesEndpoint"], json!("/api/clips/xy/frame"));
    }

    #[test]
    fn rewrite_frames_endpoint_noop_on_non_object() {
        let mut body = json!("not an object");
        rewrite_frames_endpoint(&mut body, "z");
        assert_eq!(body, json!("not an object"));
    }

    #[test]
    fn summary_renders_duration_mmss() {
        let md = build_clip_summary_md("My Clip", 125_000, &json!({}));
        assert!(md.contains("# My Clip"), "title missing: {md}");
        assert!(md.contains("- Duration: 02:05"), "duration wrong: {md}");
    }

    #[test]
    fn summary_includes_coverage_warning() {
        let md = build_clip_summary_md("C", 0, &json!({ "scanWarning": "partial" }));
        assert!(md.contains("- Coverage: partial"), "coverage missing: {md}");
    }

    #[test]
    fn summary_includes_highlights() {
        let bundle = json!({
            "recommendedMoments": [
                { "atMs": 3000, "reason": "intro" },
                { "atMs": 42000, "reason": "key point" },
            ]
        });
        let md = build_clip_summary_md("C", 60_000, &bundle);
        assert!(md.contains("## Highlights"), "highlights header missing: {md}");
        assert!(md.contains("- 03s: intro"), "first moment missing: {md}");
        assert!(md.contains("- 42s: key point"), "second moment missing: {md}");
    }

    #[test]
    fn summary_omits_empty_highlights() {
        let md = build_clip_summary_md("C", 0, &json!({ "recommendedMoments": [] }));
        assert!(!md.contains("## Highlights"), "should omit empty highlights: {md}");
    }

    #[test]
    fn local_ingest_rejects_paths_outside_allowlist_and_honors_env_extra_roots() {
        let dir = std::env::temp_dir().join(format!("ryu-clips-ingest-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("video.mp4");
        std::fs::write(&file, b"x").unwrap();
        let canonical = file.canonicalize().unwrap();

        std::env::remove_var("RYU_CLIPS_ALLOWED_DIRS");
        assert!(
            !local_ingest_allowed(&canonical),
            "a temp-dir file must be rejected by the default allowlist"
        );

        std::env::set_var("RYU_CLIPS_ALLOWED_DIRS", &dir);
        assert!(
            local_ingest_allowed(&canonical),
            "RYU_CLIPS_ALLOWED_DIRS must extend the allowlist"
        );
        std::env::remove_var("RYU_CLIPS_ALLOWED_DIRS");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
