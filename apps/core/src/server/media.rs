//! Generative-media data path — text-to-image and text/image-to-video.
//!
//! `POST /api/images/generate` accepts an OpenAI-style JSON body (`{ "prompt":
//! "...", ... }`) and proxies it to the running stable-diffusion.cpp media
//! sidecar's OpenAI-compatible `/v1/images/generations` endpoint, returning the
//! upstream JSON (image bytes as base64 in `data[].b64_json`). `POST
//! /api/video/generate` proxies to the same engine's native `/sdcpp/v1/vid_gen`
//! endpoint. Both make the media engine callable: install + start `sdcpp` from
//! the Store, then POST here.
//!
//! The request body is forwarded as-is (with only a sensible default merged in
//! when absent), so the full sd-server parameter surface stays reachable without
//! Core hardcoding a schema — every field is the caller's to set.
//!
//! Per the Core-vs-Gateway rule this is **Core** (it decides *what runs* — which
//! local media engine renders the pixels). Routing image/video through
//! per-attribute Gateway slots is a separate, future enhancement.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use serde_json::{json, Value};

use crate::sidecar::providers::sdcpp::sd_base_url;

// ── Local media storage (Notion editor image/file uploads) ──────────────────────
//
// Stores user-uploaded bytes (pasted/dropped editor images) on local disk under
// `~/.ryu/media/` (overridable via `RYU_MEDIA_DIR`) and serves them back over
// Core's HTTP. Content-addressed by a random uuid, so served objects are
// immutable and safe to cache forever. This is the local, no-cloud replacement
// for an uploadthing-style service; per the Core-vs-Gateway rule it is **Core**
// (it decides *what runs* / where bytes live, not policy).

/// Maximum accepted upload size (32 MB).
pub const MAX_MEDIA_BYTES: usize = 32 * 1024 * 1024;

/// A stored media object. `url` is relative (`/api/media/<file>`); the desktop
/// prepends the active Core base URL when rendering.
#[derive(Debug, Clone, Serialize)]
pub struct MediaObject {
    pub id: String,
    pub file_name: String,
    pub url: String,
    pub size: usize,
    pub content_type: String,
}

/// Disk-backed local media store. Cheap to clone (holds only the base dir).
#[derive(Debug, Clone)]
pub struct MediaStore {
    base: PathBuf,
}

fn default_media_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("RYU_MEDIA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    crate::paths::ryu_dir().join("media")
}

/// Map a content-type to a file extension (fallback when the name has none).
fn ext_from_content_type(ct: &str) -> &'static str {
    match ct.split(';').next().unwrap_or("").trim() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

/// Infer a content-type from a file extension for serving.
fn content_type_from_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

impl MediaStore {
    /// Open (creating the dir if needed) the default-located store.
    pub fn open_default() -> Result<Self> {
        Self::open(default_media_dir())
    }

    /// Open the store at a specific base dir.
    pub fn open(base: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&base)
            .with_context(|| format!("creating media dir {}", base.display()))?;
        Ok(Self { base })
    }

    /// Persist `bytes` and return the stored object. Derives the extension from
    /// `original_name`, falling back to `content_type`. The stored filename is
    /// always a clean `<uuid>.<ext>` with no caller-controlled path segments.
    pub fn save(
        &self,
        bytes: &[u8],
        original_name: &str,
        content_type: Option<&str>,
    ) -> Result<MediaObject> {
        if bytes.is_empty() {
            bail!("empty upload");
        }
        if bytes.len() > MAX_MEDIA_BYTES {
            bail!(
                "upload too large: {} bytes (max {} MB)",
                bytes.len(),
                MAX_MEDIA_BYTES / (1024 * 1024)
            );
        }
        // Derive extension from the original name's extension, else content-type.
        let ext = std::path::Path::new(original_name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .filter(|e| !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()))
            .unwrap_or_else(|| ext_from_content_type(content_type.unwrap_or("")).to_owned());

        let id = uuid::Uuid::new_v4().to_string();
        let file_name = format!("{id}.{ext}");
        let path = self.base.join(&file_name);
        std::fs::write(&path, bytes)
            .with_context(|| format!("writing media file {}", path.display()))?;

        let resolved_ct = content_type
            .map(|c| c.split(';').next().unwrap_or(c).trim().to_owned())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| content_type_from_ext(&ext).to_owned());

        Ok(MediaObject {
            id,
            url: format!("/api/media/{file_name}"),
            file_name,
            size: bytes.len(),
            content_type: resolved_ct,
        })
    }

    /// Read a stored object's bytes + content-type. Rejects any `file_name` that
    /// is not a bare safe filename (path-traversal guard).
    pub fn load(&self, file_name: &str) -> Result<(Vec<u8>, String)> {
        if !is_safe_filename(file_name) {
            bail!("invalid media file name");
        }
        let path = self.base.join(file_name);
        let bytes = std::fs::read(&path)
            .with_context(|| format!("reading media file {}", path.display()))?;
        let ext = std::path::Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        Ok((bytes, content_type_from_ext(ext).to_owned()))
    }
}

/// A safe served filename: no slashes, no `..`, only `[A-Za-z0-9_.-]`.
fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// `POST /api/media/upload` — store raw request-body bytes as a local media
/// object. The original filename comes from the `x-filename` header (or `?name=`)
/// and the content-type from the `content-type` header. Returns the MediaObject.
pub async fn upload_media(
    State(state): State<super::ServerState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let name = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| params.get("name").cloned())
        .unwrap_or_else(|| "upload".to_string());
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());

    match state.media.save(&body, &name, content_type) {
        Ok(obj) => (StatusCode::OK, Json(json!(obj))).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `GET /api/media/:file` — serve a stored media object with a long immutable
/// cache (content-addressed by uuid).
pub async fn serve_media(
    State(state): State<super::ServerState>,
    Path(file): Path<String>,
) -> Response {
    match state.media.load(&file) {
        Ok((bytes, content_type)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
                (
                    header::CACHE_CONTROL,
                    "public, max-age=31536000, immutable".to_owned(),
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "media not found").into_response(),
    }
}

/// Diffusion on CPU can take minutes; use a generous client timeout independent
/// of the short-lived shared `ServerState` client.
fn media_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("ryu-core/0.1")
        .timeout(Duration::from_secs(600))
        .build()
        .expect("reqwest client")
}

/// Cloud media providers routed through the Gateway (governed, metered) rather
/// than the local stable-diffusion.cpp engine. A request selects one via a
/// `"provider"` field in the body; anything else (or absent) uses the local
/// engine, so the default local path is unchanged.
const CLOUD_PROVIDERS: [&str; 3] = ["openrouter", "replicate", "fal"];

/// Returns the normalized cloud provider id when the body selects one, else
/// `None` (⇒ the local sd-server path).
fn cloud_provider(body: &Value) -> Option<String> {
    body.get("provider")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_lowercase())
        .filter(|s| CLOUD_PROVIDERS.contains(&s.as_str()))
}

/// Forward a media request to the Gateway, routing to `provider` via the
/// per-request slot header for `modality` (image/video). The Gateway runs the
/// full firewall/budget/metering pipeline and returns a normalized body.
async fn forward_to_gateway(
    modality: &str,
    endpoint: &str,
    provider: &str,
    body: Value,
) -> (StatusCode, Json<Value>) {
    use crate::sidecar::gateway::{gateway_token, gateway_url};
    let base = gateway_url();
    let url = format!("{}{endpoint}", base.trim_end_matches('/'));
    let slot_header = format!("x-ryu-slot-{modality}-provider");

    let mut req = media_client()
        .post(&url)
        .header(slot_header, provider)
        .json(&body);
    if let Some(t) = gateway_token() {
        req = req.bearer_auth(t);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": format!("cloud media gateway not reachable at {url}: {e}")
                })),
            );
        }
    };
    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
    if !status.is_success() {
        // Preserve 202 Accepted (video job submitted) as success; treat other
        // non-2xx as an error with the upstream detail.
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("cloud media provider returned {status}"), "detail": value })),
        );
    }
    (StatusCode::OK, Json(value))
}

/// Forward a JSON body to a media-engine endpoint and pass the response through.
async fn proxy(endpoint: &str, body: Value) -> (StatusCode, Json<Value>) {
    let url = format!("{}{endpoint}", sd_base_url());
    let resp = match media_client().post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": format!(
                        "stable-diffusion.cpp media engine not reachable at {url}: {e}. \
                         Install + start `sdcpp` from the Store first."
                    )
                })),
            );
        }
    };

    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    // Pass the upstream body through verbatim when it is JSON; otherwise wrap it.
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));

    if !status.is_success() {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("media engine returned {status}"), "detail": value })),
        );
    }
    (StatusCode::OK, Json(value))
}

/// `POST /api/images/generate` — text-to-image via sd-server's OpenAI-compatible
/// `/v1/images/generations`. Requires at least `{ "prompt": "..." }`.
pub async fn generate_image(Json(mut body): Json<Value>) -> impl IntoResponse {
    if body
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing `prompt` (the text to render)" })),
        );
    }
    // Default to a single image when the caller doesn't specify a count.
    if let Some(obj) = body.as_object_mut() {
        obj.entry("n").or_insert(json!(1));
    }
    // Cloud provider selected → route through the Gateway; else the local engine.
    if let Some(provider) = cloud_provider(&body) {
        return forward_to_gateway("image", "/v1/images/generations", &provider, body).await;
    }
    proxy("/v1/images/generations", body).await
}

/// `POST /api/video/generate` — text/image-to-video via sd-server's native
/// `/sdcpp/v1/vid_gen`. Requires at least `{ "prompt": "..." }`. Video models
/// (Wan / LTX) are large and GPU-preferred; point `RYU_SD_MODEL` at a video model
/// and use the CUDA sd-server build for usable speed.
pub async fn generate_video(Json(body): Json<Value>) -> impl IntoResponse {
    if body
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing `prompt` (the text to render)" })),
        );
    }
    // Cloud provider selected → submit a Gateway video job (job-based; poll via
    // `GET /api/video/jobs/:id`). Else the local engine (synchronous).
    if let Some(provider) = cloud_provider(&body) {
        return forward_to_gateway("video", "/v1/videos/generations", &provider, body).await;
    }
    proxy("/sdcpp/v1/vid_gen", body).await
}

/// `GET /api/video/jobs/:id` — poll a cloud video-generation job submitted via
/// `POST /api/video/generate` with a cloud provider. Passes through to the
/// Gateway's `GET /v1/videos/generations/:id`; returns the job envelope with
/// current `status` and, once succeeded, the media `data`.
pub async fn poll_video_job(Path(id): Path<String>) -> impl IntoResponse {
    use crate::sidecar::gateway::{gateway_token, gateway_url};
    let base = gateway_url();
    let url = format!("{}/v1/videos/generations/{id}", base.trim_end_matches('/'));
    let mut req = media_client().get(&url);
    if let Some(t) = gateway_token() {
        req = req.bearer_auth(t);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("cloud media gateway not reachable: {e}") })),
            );
        }
    };
    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
    if !status.is_success() {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("video job poll returned {status}"), "detail": value })),
        );
    }
    (StatusCode::OK, Json(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (MediaStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ryu-media-test-{}", uuid::Uuid::new_v4()));
        let store = MediaStore::open(dir.clone()).unwrap();
        (store, dir)
    }

    #[test]
    fn save_then_load_round_trips_with_content_type() {
        let (store, _dir) = temp_store();
        let png = [0x89, b'P', b'N', b'G', 0, 1, 2, 3];
        let obj = store.save(&png, "shot.png", Some("image/png")).unwrap();
        assert!(obj.file_name.ends_with(".png"));
        assert_eq!(obj.url, format!("/api/media/{}", obj.file_name));
        assert_eq!(obj.size, png.len());
        assert_eq!(obj.content_type, "image/png");

        let (bytes, ct) = store.load(&obj.file_name).unwrap();
        assert_eq!(bytes, png);
        assert_eq!(ct, "image/png");
    }

    #[test]
    fn extension_falls_back_to_content_type() {
        let (store, _dir) = temp_store();
        let obj = store.save(&[1, 2, 3], "noext", Some("image/webp")).unwrap();
        assert!(obj.file_name.ends_with(".webp"));
    }

    #[test]
    fn load_rejects_path_traversal() {
        let (store, _dir) = temp_store();
        assert!(store.load("../foo").is_err());
        assert!(store.load("a/b").is_err());
        assert!(store.load("..").is_err());
        assert!(store.load("").is_err());
    }

    #[test]
    fn rejects_oversize_and_empty() {
        let (store, _dir) = temp_store();
        assert!(store.save(&[], "x.png", None).is_err());
        let big = vec![0u8; MAX_MEDIA_BYTES + 1];
        assert!(store.save(&big, "x.png", Some("image/png")).is_err());
    }
}
