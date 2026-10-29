//! Generative-media data path — text-to-image, video generation and audio
//! (music, sound-effect) generation.
//!
//! `POST /api/images/generate` accepts an OpenAI-style JSON body (`{ "prompt":
//! "...", ... }`) and proxies it to the running stable-diffusion.cpp media
//! sidecar's OpenAI-compatible `/v1/images/generations` endpoint, returning the
//! upstream JSON (image bytes as base64 in `data[].b64_json`). `POST
//! /api/video/generate` proxies to the same engine's native `/sdcpp/v1/vid_gen`
//! endpoint. Both make the media engine callable: install + start `sdcpp` from
//! the Store, then POST here.
//!
//! For the local engine the image request body is forwarded as-is (with only a
//! sensible default merged in when absent), so the full sd-server parameter
//! surface stays reachable without Core hardcoding a schema. The one field Core
//! takes out of the body is `provider_input`: a JSON object of model-specific
//! fields for a cloud provider. It is refused (400) for the local engine, may not
//! set routing, prompt or canonical input keys (`model`, `provider`, `prompt`,
//! `request_id`, `n`, `input_images`, `input_mask`, ...), and is merged into the
//! provider body only when it does not collide with a field already present — a
//! collision is refused, never silently overridden.
//!
//! Per the Core-vs-Gateway rule this is **Core** (it decides *what runs* — which
//! local media engine renders the pixels). Routing image/video through
//! per-attribute Gateway slots is a separate, future enhancement.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

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

use crate::image_host::CoreImageHost;

/// Map a [`ryu_image`] response code back to an `axum` `StatusCode`, preserving
/// the pre-extraction wire status (unknown codes fall back to 502).
fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY)
}

/// Enforce the app-level generation permission on host-direct Canvas/Slides
/// calls. The coarse `media:generate` grant protects the sandbox bridge, while
/// this verified-caller check makes the manifest's human-facing permission level
/// reach the Core data path as well. Direct Core callers without the host marker
/// retain the existing node route policy; a malformed marker is denied rather
/// than treated as a new app identity.
pub(crate) async fn enforce_host_media_permission(
    state: &super::ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    headers: &HeaderMap,
) -> Result<(), Response> {
    let Some(app_id) = headers
        .get("x-ryu-app-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let expected = match app_id {
        "@ryu/canvas" => "canvas.generate",
        "@ryu/slides" => "slides.generate",
        "@ryu/voice" => "voice.studio.generate",
        _ => {
            return Err((StatusCode::FORBIDDEN, "unsupported app media permission").into_response());
        }
    };
    enforce_host_app_permission(state, caller, headers, app_id, expected).await
}

/// Enforce Voice Studio's model-install permission on a host-direct route.
/// Ordinary Settings calls omit the host app marker and use the node route
/// policy; a marked Companion call must identify the built-in Voice app.
pub(crate) async fn enforce_host_voice_models_permission(
    state: &super::ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    headers: &HeaderMap,
) -> Result<(), Response> {
    let Some(app_id) = headers
        .get("x-ryu-app-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    if app_id != "@ryu/voice" {
        return Err((StatusCode::FORBIDDEN, "unsupported voice model permission").into_response());
    }
    enforce_host_app_permission(state, caller, headers, app_id, "voice.models.manage").await
}

async fn enforce_host_app_permission(
    state: &super::ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    headers: &HeaderMap,
    app_id: &str,
    expected_permission: &str,
) -> Result<(), Response> {
    let Some(permission) = headers
        .get("x-ryu-app-permission")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err((StatusCode::FORBIDDEN, "missing app permission").into_response());
    };
    if permission != expected_permission
        || state
            .app_store
            .get(app_id)
            .await
            .ok()
            .flatten()
            .is_none_or(|app| !app.enabled)
    {
        return Err((StatusCode::FORBIDDEN, "app permission denied").into_response());
    }
    if super::enforce_permission(state, caller, expected_permission)
        .await
        .is_err()
    {
        return Err((StatusCode::FORBIDDEN, "app permission denied").into_response());
    }
    Ok(())
}

// ── Local media storage (Notion editor image/file uploads) ──────────────────────
//
// Stores user-uploaded bytes (pasted/dropped editor images) on local disk under
// `~/.ryu/media/` (overridable via `RYU_MEDIA_DIR`) and serves them back over
// Core's HTTP. Content-addressed by a random uuid, so served objects are
// immutable and safe to cache forever. This is the local, no-cloud replacement
// for an uploadthing-style service; per the Core-vs-Gateway rule it is **Core**
// (it decides *what runs* / where bytes live, not policy).

/// Maximum encoded image-generation request. A 16 MiB image encoded as base64
/// needs about 22 MiB before the JSON envelope.
pub const MAX_IMAGE_GENERATION_BODY_BYTES: usize = 24 * 1024 * 1024;

/// Maximum accepted upload size (32 MB).
pub const MAX_MEDIA_BYTES: usize = 32 * 1024 * 1024;
const MAX_MEDIA_STORE_BYTES: u64 = 512 * 1024 * 1024;

fn media_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

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

/// Disk-backed local media store. Cheap to clone.
///
/// Every object is a write-once `RYU-SF01` sealed file (content store
/// [`MEDIA_STORE`], AAD = the object's id, the file stem) written to an
/// owner-only temporary name and renamed into place. Reads decrypt on the fly
/// (Range requests decrypt only the chunks they touch). Files written by older
/// builds are plaintext: they are sealed in place on first read and by a
/// background pass at startup ([`MediaStore::seal_legacy_files`]), each only
/// after its sealed copy verifies and enough disk space is free.
#[derive(Debug, Clone)]
pub struct MediaStore {
    base: PathBuf,
    /// A fixed cipher (tests); `None` resolves the media content key per call.
    cipher: Option<ryu_crypto::ContentCipher>,
}

/// Registered content-store name for media files (KDF input: never rename).
pub const MEDIA_STORE: &str = "media";
/// Suffix of a sealed object being written (renamed into place when complete).
const MEDIA_PART_SUFFIX: &str = ".part";

/// The AAD context of one media object: its id (the file stem), never a path.
fn media_context(file_name: &str) -> ryu_crypto::ContentContext {
    let id = std::path::Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name);
    ryu_crypto::ContentContext::new("file").with("id", id)
}

/// Plaintext length of a stored object from its size and header (no key
/// needed): sealed files carry one 16-byte tag per chunk plus a 32-byte header.
fn stored_plaintext_len(path: &std::path::Path, size: u64) -> u64 {
    use std::io::Read;
    let mut header = [0u8; 9];
    let Ok(mut file) = std::fs::File::open(path) else {
        return size;
    };
    if file.read_exact(&mut header).is_err() || &header[..8] != b"RYU-SF01" {
        return size;
    }
    let chunk = 1u64 << u32::from(header[8].clamp(10, 20));
    let body = size.saturating_sub(32);
    let full = body / (chunk + 16);
    let rem = body % (chunk + 16);
    full * chunk + rem.saturating_sub(16)
}

fn default_media_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("RYU_MEDIA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    crate::paths::files_path("media")
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
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
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
        // User-uploaded SVG is served as an attachment-compatible binary so
        // active same-origin markup cannot execute in the Core origin.
        "svg" => "application/octet-stream",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        // Passive media only: served with its real type so `<video>` can stream
        // and seek it through Range requests.
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

impl MediaStore {
    /// Open (creating the dir if needed) the default-located store, and start
    /// the background pass that seals media files written by older builds.
    pub fn open_default() -> Result<Self> {
        let store = Self::open(default_media_dir())?;
        let background = store.clone();
        let spawned = std::thread::Builder::new()
            .name("media-seal".to_owned())
            .spawn(move || {
                let report = background.seal_legacy_files();
                if report.total > 0 {
                    tracing::info!(
                        sealed = report.sealed,
                        total = report.total,
                        pending = report.pending,
                        "media: sealed files written by an older build"
                    );
                }
            });
        if let Err(error) = spawned {
            tracing::warn!("media: could not start the sealing pass: {error}");
        }
        Ok(store)
    }

    /// Open the store at a specific base dir.
    pub fn open(base: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&base)
            .with_context(|| format!("creating media dir {}", base.display()))?;
        restrict_dir(&base);
        Ok(Self { base, cipher: None })
    }

    /// Open the store with a fixed content cipher (tests).
    #[cfg(test)]
    pub fn open_with_cipher(base: PathBuf, cipher: ryu_crypto::ContentCipher) -> Result<Self> {
        let mut store = Self::open(base)?;
        store.cipher = Some(cipher);
        Ok(store)
    }

    fn cipher(&self) -> Result<ryu_crypto::ContentCipher> {
        match &self.cipher {
            Some(cipher) => Ok(cipher.clone()),
            None => ryu_crypto::content_cipher(MEDIA_STORE)
                .context("no content key for media; refusing to store it unsealed"),
        }
    }

    /// Plaintext bytes held by the store (the quota counts what users stored,
    /// not the sealing overhead).
    fn stored_bytes(&self) -> Result<u64> {
        Ok(std::fs::read_dir(&self.base)
            .with_context(|| format!("reading media dir {}", self.base.display()))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                metadata
                    .is_file()
                    .then(|| stored_plaintext_len(&entry.path(), metadata.len()))
            })
            .sum::<u64>())
    }

    /// Seal one legacy plaintext object in place (verified copy, free-space
    /// checked). `Ok(false)` when it already was sealed.
    pub fn seal_in_place(&self, file_name: &str) -> Result<bool> {
        if !is_safe_filename(file_name) {
            bail!("invalid media file name");
        }
        let cipher = self.cipher()?;
        let _guard = media_write_lock()
            .lock()
            .map_err(|_| anyhow::anyhow!("media store lock is poisoned"))?;
        let path = self.base.join(file_name);
        Ok(matches!(
            ryu_crypto::sealed_file::seal_file_in_place(&path, &cipher, &media_context(file_name))?,
            ryu_crypto::sealed_file::SealInPlace::Sealed { .. }
        ))
    }

    /// Seal every plaintext object left by an older build, one file at a time.
    /// Stops (leaving the rest pending for the next start) when disk space runs
    /// short. Also removes `.part` files a crashed upload left behind.
    pub fn seal_legacy_files(&self) -> MediaSealReport {
        let mut report = MediaSealReport::default();
        let Ok(entries) = std::fs::read_dir(&self.base) else {
            return report;
        };
        let mut names = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
            if !is_file {
                continue;
            }
            if name.ends_with(MEDIA_PART_SUFFIX) || name.ends_with(".sealing") {
                let stale = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age > std::time::Duration::from_secs(3600));
                if stale {
                    let _ = std::fs::remove_file(entry.path());
                }
                continue;
            }
            if is_safe_filename(&name)
                && !ryu_crypto::sealed_file::is_sealed_file(&entry.path()).unwrap_or(true)
            {
                names.push(name);
            }
        }
        report.total = names.len();
        for (index, name) in names.iter().enumerate() {
            match self.seal_in_place(name) {
                Ok(_) => report.sealed += 1,
                Err(error) => {
                    let short_of_space = error
                        .downcast_ref::<ryu_crypto::sealed_file::InsufficientSpace>()
                        .is_some();
                    tracing::warn!("media: could not seal {name}: {error:#}");
                    if short_of_space {
                        report.pending = names.len() - index;
                        break;
                    }
                    report.pending += 1;
                }
            }
        }
        report
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
        let _guard = media_write_lock()
            .lock()
            .map_err(|_| anyhow::anyhow!("media store lock is poisoned"))?;
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
        let cipher = self.cipher()?;
        let current_bytes = self.stored_bytes()?;
        if current_bytes.saturating_add(bytes.len() as u64) > MAX_MEDIA_STORE_BYTES {
            bail!(
                "media store quota exceeded (maximum {} MiB)",
                MAX_MEDIA_STORE_BYTES / (1024 * 1024)
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
        // Write-once: seal into an owner-only temporary name, then rename. A
        // crash leaves only a `.part` file, swept at the next start.
        let part = self.base.join(format!(".{file_name}{MEDIA_PART_SUFFIX}"));
        let written = (|| -> Result<()> {
            let mut writer =
                ryu_crypto::SealedFileWriter::create(&part, &cipher, &media_context(&file_name))?;
            writer.write_plain(bytes)?;
            writer.finish()?;
            std::fs::rename(&part, &path)
                .with_context(|| format!("writing media file {}", path.display()))?;
            Ok(())
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&part);
            return Err(error);
        }

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

    /// Resolve a stored object's on-disk path + content-type without reading it,
    /// so the serve route can stream (and range-slice) large files. Same
    /// path-traversal guard as [`MediaStore::load`].
    pub fn resolve(&self, file_name: &str) -> Result<(PathBuf, String)> {
        if !is_safe_filename(file_name) {
            bail!("invalid media file name");
        }
        let ext = std::path::Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        Ok((
            self.base.join(file_name),
            content_type_from_ext(ext).to_owned(),
        ))
    }

    /// Open a stored object for reading: the sealed reader, or (legacy file
    /// that could not be sealed yet) the plaintext file.
    pub fn open_object(&self, file_name: &str) -> Result<MediaReader> {
        let (path, _) = self.resolve(file_name)?;
        let sealed = ryu_crypto::sealed_file::is_sealed_file(&path)
            .with_context(|| format!("reading media file {}", path.display()))?;
        if !sealed {
            // Lazy migration: seal on first read; serve the plaintext if that is
            // not possible right now (for example, short of disk space).
            if let Err(error) = self.seal_in_place(file_name) {
                tracing::warn!("media: serving {file_name} unsealed for now: {error:#}");
                let file = std::fs::File::open(&path)
                    .with_context(|| format!("reading media file {}", path.display()))?;
                let len = file.metadata()?.len();
                return Ok(MediaReader::Plain { file, len });
            }
        }
        let reader = ryu_crypto::SealedFileReader::open_path(
            &path,
            &self.cipher()?,
            &media_context(file_name),
        )?;
        Ok(MediaReader::Sealed(Box::new(reader)))
    }

    /// Read a stored object's bytes + content-type. Rejects any `file_name` that
    /// is not a bare safe filename (path-traversal guard).
    pub fn load(&self, file_name: &str) -> Result<(Vec<u8>, String)> {
        use std::io::Read;
        if !is_safe_filename(file_name) {
            bail!("invalid media file name");
        }
        let mut reader = self.open_object(file_name)?;
        let mut bytes = Vec::with_capacity(usize::try_from(reader.len()).unwrap_or(0));
        reader
            .read_to_end(&mut bytes)
            .with_context(|| format!("reading media file {file_name}"))?;
        let ext = std::path::Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        Ok((bytes, content_type_from_ext(ext).to_owned()))
    }
}

/// What [`MediaStore::seal_legacy_files`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct MediaSealReport {
    /// Plaintext objects found.
    pub total: usize,
    /// Objects sealed in this pass.
    pub sealed: usize,
    /// Objects left plaintext (retried on first read and at the next start).
    pub pending: usize,
}

/// A readable stored object: plaintext length, `Read` and `Seek` in plaintext
/// coordinates.
pub enum MediaReader {
    /// An `RYU-SF01` file.
    Sealed(Box<ryu_crypto::SealedFileReader<std::fs::File>>),
    /// A legacy plaintext file not sealed yet.
    Plain { file: std::fs::File, len: u64 },
}

impl MediaReader {
    /// Plaintext length in bytes.
    pub fn len(&self) -> u64 {
        match self {
            Self::Sealed(reader) => reader.plaintext_len(),
            Self::Plain { len, .. } => *len,
        }
    }

    /// Whether the object is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl std::io::Read for MediaReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Sealed(reader) => reader.read(buf),
            Self::Plain { file, .. } => file.read(buf),
        }
    }
}

impl std::io::Seek for MediaReader {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        match self {
            Self::Sealed(reader) => reader.seek(position),
            Self::Plain { file, .. } => file.seek(position),
        }
    }
}

/// Owner-only media directory.
fn restrict_dir(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
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
#[utoipa::path(
    post,
    path = "/api/media/upload",
    tag = "Media",
    summary = "store raw request-body bytes as a local media",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn upload_media(
    State(state): State<super::ServerState>,
    axum::Extension(_caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if crate::sidecar::control_plane::registered_org().is_some()
        || crate::sidecar::control_plane::is_managed_node()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "media objects require a personal node until per-object tenancy is enabled"
            })),
        )
            .into_response();
    }
    let name = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| params.get("name").cloned())
        .unwrap_or_else(|| "upload".to_string());
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());

    // Run the fs write in spawn_blocking so we don't block the async runtime.
    let media = state.media.clone();
    let content_type_owned = content_type.map(str::to_owned);
    let result = tokio::task::spawn_blocking(move || {
        media.save(&body, &name, content_type_owned.as_deref())
    })
    .await;

    match result {
        Ok(Ok(obj)) => (StatusCode::OK, Json(json!(obj))).into_response(),
        Ok(Err(e)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("upload_media: join error: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error storing media" })),
            )
                .into_response()
        }
    }
}

/// `GET /api/media/:file` — stream a stored media object from disk. Honours a
/// single `Range: bytes=` request (206 / 416) so video starts and seeks without
/// downloading the whole file; responses stay `private, no-store`.
#[utoipa::path(
    get,
    path = "/api/media/{file}",
    tag = "Media",
    summary = "stream a stored media object, with byte-range support",
    params(("file" = String, Path)),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 206, description = "Partial content for a byte range"),
        (status = 416, description = "Requested range not satisfiable")
    )
)]
pub async fn serve_media(
    State(state): State<super::ServerState>,
    axum::Extension(_caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(file): Path<String>,
    headers: HeaderMap,
) -> Response {
    if crate::sidecar::control_plane::registered_org().is_some()
        || crate::sidecar::control_plane::is_managed_node()
    {
        return (
            StatusCode::FORBIDDEN,
            "media objects require a personal node until per-object tenancy is enabled",
        )
            .into_response();
    }
    let Ok((path, content_type)) = state.media.resolve(&file) else {
        return (StatusCode::NOT_FOUND, "media not found").into_response();
    };
    if !path.is_file() {
        return (StatusCode::NOT_FOUND, "media not found").into_response();
    }
    // Opening verifies the sealed file's final chunk, so the plaintext length
    // (and every Content-Length below) is trustworthy.
    let media = state.media.clone();
    let opened = tokio::task::spawn_blocking(move || media.open_object(&file)).await;
    let mut reader = match opened {
        Ok(Ok(reader)) => reader,
        Ok(Err(error)) => {
            tracing::error!("serve_media: could not open a media object: {error:#}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "media could not be read").into_response();
        }
        Err(error) => {
            tracing::error!("serve_media: join error: {error}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    };
    let total = reader.len();

    // Stream instead of buffering the whole object, and honour a single
    // `Range` so video can start playing (and seek) before the file is sent.
    // Only the chunks a range touches are decrypted.
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let (status, start, len) = match parse_byte_range(range, total) {
        Ok(Some((start, end))) => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
        Ok(None) => (StatusCode::OK, 0, total),
        Err(()) => {
            return (
                StatusCode::RANGE_NOT_SATISFIABLE,
                [
                    (header::CONTENT_RANGE, format!("bytes */{total}")),
                    (header::ACCEPT_RANGES, "bytes".to_owned()),
                ],
            )
                .into_response();
        }
    };
    let (sender, receiver) = tokio::sync::mpsc::channel::<std::io::Result<Bytes>>(4);
    tokio::task::spawn_blocking(move || {
        use std::io::{Read, Seek};
        if let Err(error) = reader.seek(std::io::SeekFrom::Start(start)) {
            let _ = sender.blocking_send(Err(error));
            return;
        }
        let mut remaining = len;
        let mut buffer = vec![0u8; 64 * 1024];
        while remaining > 0 {
            let want = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
            match reader.read(&mut buffer[..want]) {
                Ok(0) => {
                    let _ = sender.blocking_send(Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "media object ended early",
                    )));
                    return;
                }
                Ok(read) => {
                    remaining -= read as u64;
                    if sender
                        .blocking_send(Ok(Bytes::copy_from_slice(&buffer[..read])))
                        .is_err()
                    {
                        return; // client went away
                    }
                }
                Err(error) => {
                    tracing::error!("serve_media: read failed: {error}");
                    let _ = sender.blocking_send(Err(error));
                    return;
                }
            }
        }
    });
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });
    let mut response = Response::new(axum::body::Body::from_stream(stream));
    *response.status_mut() = status;
    let response_headers = response.headers_mut();
    if let Ok(value) = header::HeaderValue::from_str(&content_type) {
        response_headers.insert(header::CONTENT_TYPE, value);
    }
    response_headers.insert(header::CONTENT_LENGTH, header::HeaderValue::from(len));
    response_headers.insert(
        header::ACCEPT_RANGES,
        header::HeaderValue::from_static("bytes"),
    );
    response_headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-store"),
    );
    if status == StatusCode::PARTIAL_CONTENT {
        if let Ok(value) =
            header::HeaderValue::from_str(&format!("bytes {start}-{}/{total}", start + len - 1))
        {
            response_headers.insert(header::CONTENT_RANGE, value);
        }
    }
    response
}

/// Parse a single `Range: bytes=...` header against a file of `total` bytes.
///
/// `Ok(None)` means "send the whole file" (no header, a non-bytes unit, or a
/// multi-range request, which we answer in full rather than as multipart).
/// `Ok(Some((start, end)))` is an inclusive, in-bounds slice. `Err(())` is an
/// unsatisfiable range (416).
fn parse_byte_range(header: Option<&str>, total: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Ok(None);
    };
    if spec.contains(',') {
        return Ok(None);
    }
    let (start, end) = spec.split_once('-').ok_or(())?;
    let (start, end) = (start.trim(), end.trim());
    if total == 0 {
        return Err(());
    }
    let last = total - 1;
    let (start, end) = if start.is_empty() {
        // Suffix range: the final N bytes.
        let suffix: u64 = end.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        (total.saturating_sub(suffix), last)
    } else {
        let start: u64 = start.parse().map_err(|_| ())?;
        let end = if end.is_empty() {
            last
        } else {
            end.parse::<u64>().map_err(|_| ())?.min(last)
        };
        (start, end)
    };
    if start > end || start > last {
        return Err(());
    }
    Ok(Some((start, end)))
}

/// `POST /api/images/generate` — text-to-image via sd-server's OpenAI-compatible
/// `/v1/images/generations`, or via a configured cloud image provider.
///
/// Requires at least `{ "prompt": "..." }`. An optional `provider_input` object
/// (cloud providers only) is merged into the provider body; it cannot set
/// routing, prompt or canonical input fields, and cannot override a field the
/// request already carries. Any of those, or `provider_input` without a cloud
/// provider, is refused with 400.
// Implementation note (kept out of the public spec): a thin wrapper over
// `ryu_image::generate`, the extracted image-gen abstraction and routing, with
// Core's `CoreImageHost` injected.
#[utoipa::path(
    post,
    path = "/api/images/generate",
    tag = "Media",
    summary = "Generate or edit images (local engine or cloud provider)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "Missing prompt, unsupported provider, or a `provider_input` that is not an object, targets the local engine, sets a reserved key, or conflicts with a request field"),
        (status = 413, description = "Request body exceeds 24 MiB")
    )
)]
pub async fn generate_image(
    State(state): State<super::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(response) = enforce_host_media_permission(&state, &caller, &headers).await {
        return response;
    }
    // A node whose RAM/disk fits no local image model (image tier "none") has
    // nothing to lazily start; say so and name the cloud alternative instead of
    // the generic "engine not reachable". Cloud requests are unaffected, and
    // there is no automatic cloud fallback: the caller picks the provider.
    if ryu_image::validate_media_provider(&body).is_ok()
        && ryu_image::cloud_provider(&body).is_none()
    {
        if let Some(reason) =
            crate::sidecar::providers::sdcpp::local_image_unavailable_reason().await
        {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": reason, "code": "local_image_unavailable" })),
            )
                .into_response();
        }
    }
    let host = CoreImageHost::new(state.manager.clone());
    let (code, value) = ryu_image::generate(&host, body).await;
    (status(code), Json(value)).into_response()
}

/// Upper bound for a video or audio generation request. Reference media (first
/// and last frames, a source clip, an audio track) travels inline as base64
/// `data:` URIs, so axum's 2 MiB default would reject ordinary image-to-video,
/// video-to-video and lip-sync requests. Matches the Gateway's media-job limit.
pub const MAX_MEDIA_JOB_BODY_BYTES: usize = 64 * 1024 * 1024;

/// `POST /api/video/generate` — text, image, video or audio to video.
///
/// A cloud `provider` (`fal`, `replicate`, `runway`; `openrouter` is refused) submits a Gateway job
/// (poll `GET /api/video/jobs/:id`); otherwise the local sd-server engine runs
/// synchronously. Canonical reference inputs (`input_images: [first, last?]`,
/// `input_video`, `input_audio`) are mapped per target or refused, and
/// `provider_input` (cloud only) is merged into the provider body but can never
/// override `model`, `provider`, `prompt`, `request_id` or `n`.
#[utoipa::path(
    post,
    path = "/api/video/generate",
    tag = "Media",
    summary = "Generate video from text, frames, a source clip or audio",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "Missing prompt, unsupported provider, or an input the target cannot use"),
        (status = 413, description = "Request body exceeds 64 MiB")
    )
)]
pub async fn generate_video(
    State(state): State<super::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(response) = enforce_host_media_permission(&state, &caller, &headers).await {
        return response;
    }
    let host = CoreImageHost::new(state.manager.clone());
    let (code, value) = ryu_image::video::generate_video(&host, body).await;
    (status(code), Json(value)).into_response()
}

/// `GET /api/video/jobs/:id` — poll a cloud video-generation job submitted via
/// `POST /api/video/generate` with a cloud provider. Passes through to the
/// Gateway's `GET /v1/videos/generations/:id`; returns the job envelope with
/// current `status` and, once succeeded, the media `data`.
#[utoipa::path(
    get,
    path = "/api/video/jobs/{id}",
    tag = "Media",
    summary = "poll a cloud video-generation job submitted via",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn poll_video_job(Path(id): Path<String>) -> impl IntoResponse {
    poll_gateway_media_job("videos", "video", &id).await
}

/// `POST /api/audio/generate` — generate music or sound effects through a cloud
/// provider (`fal` or `replicate`).
///
/// Submits a Gateway audio job; poll
/// `GET /api/audio/jobs/:id`. Body: `{ prompt, provider, model, kind?:
/// "music"|"sfx", duration_s?, input_audio?, input_images?, input_video?,
/// provider_input? }`. Canonical inputs reach the model only through
/// `provider_input` references such as `{"seconds_total": "$duration_s"}`.
/// There is no local audio-generation engine, so a request without a supported
/// cloud provider is refused.
#[utoipa::path(
    post,
    path = "/api/audio/generate",
    tag = "Media",
    summary = "Generate music or sound effects through a cloud provider",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Job accepted; poll its id", body = serde_json::Value),
        (status = 400, description = "Missing prompt or model, unsupported provider, or an unmapped input"),
        (status = 413, description = "Request body exceeds 64 MiB")
    )
)]
pub async fn generate_audio(
    State(state): State<super::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(response) = enforce_host_media_permission(&state, &caller, &headers).await {
        return response;
    }
    let host = CoreImageHost::new(state.manager.clone());
    let (code, value) = ryu_image::video::generate_audio(&host, body).await;
    (status(code), Json(value)).into_response()
}

/// `GET /api/audio/jobs/:id` — poll an audio-generation job submitted via
/// `POST /api/audio/generate`.
///
/// Passes through to the Gateway's
/// `GET /v1/audio/generations/:id`.
#[utoipa::path(
    get,
    path = "/api/audio/jobs/{id}",
    tag = "Media",
    summary = "Poll a cloud audio-generation job",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn poll_audio_job(Path(id): Path<String>) -> impl IntoResponse {
    poll_gateway_media_job("audio", "audio", &id).await
}

/// Gateway job ids are server-minted UUIDs; anything else never reaches the
/// upstream URL, so a crafted id cannot change the polled path.
fn valid_media_job_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Poll `GET /v1/{collection}/generations/{id}` on the Gateway.
async fn poll_gateway_media_job(
    collection: &str,
    label: &str,
    id: &str,
) -> (StatusCode, Json<Value>) {
    use crate::sidecar::gateway::{gateway_inference_token, gateway_url};
    if !valid_media_job_id(id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("invalid {label} job id") })),
        );
    }
    let base = gateway_url();
    let url = format!(
        "{}/v1/{collection}/generations/{id}",
        base.trim_end_matches('/')
    );
    let mut req = ryu_image::media_client().get(&url);
    if let Some(t) = gateway_inference_token() {
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
            Json(
                json!({ "error": format!("{label} job poll returned {status}"), "detail": value }),
            ),
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
    fn media_job_ids_are_bounded_to_gateway_minted_shapes() {
        assert!(valid_media_job_id("3f2b9c1e-5d4a-4f7e-9b1a-0c2d3e4f5a6b"));
        assert!(!valid_media_job_id(""));
        assert!(!valid_media_job_id("../admin"));
        assert!(!valid_media_job_id("a/b"));
        assert!(!valid_media_job_id(&"x".repeat(161)));
        assert_eq!(MAX_MEDIA_JOB_BODY_BYTES, 64 * 1024 * 1024);
    }

    #[test]
    fn byte_range_parsing_covers_open_closed_suffix_and_invalid() {
        assert_eq!(parse_byte_range(None, 100), Ok(None));
        assert_eq!(parse_byte_range(Some("items=0-1"), 100), Ok(None));
        assert_eq!(parse_byte_range(Some("bytes=0-9,20-29"), 100), Ok(None));
        assert_eq!(parse_byte_range(Some("bytes=0-9"), 100), Ok(Some((0, 9))));
        assert_eq!(parse_byte_range(Some("bytes=90-"), 100), Ok(Some((90, 99))));
        assert_eq!(
            parse_byte_range(Some("bytes=90-500"), 100),
            Ok(Some((90, 99)))
        );
        assert_eq!(parse_byte_range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(parse_byte_range(Some("bytes=-500"), 100), Ok(Some((0, 99))));
        assert_eq!(parse_byte_range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(parse_byte_range(Some("bytes=9-3"), 100), Err(()));
        assert_eq!(parse_byte_range(Some("bytes=-0"), 100), Err(()));
        assert_eq!(parse_byte_range(Some("bytes=x-1"), 100), Err(()));
        assert_eq!(parse_byte_range(Some("bytes=0-0"), 0), Err(()));
    }

    #[test]
    fn resolve_guards_paths_and_maps_content_type() {
        let (store, dir) = temp_store();
        let (path, content_type) = store.resolve("clip.mp4").unwrap();
        assert_eq!(path, dir.join("clip.mp4"));
        assert_eq!(content_type, content_type_from_ext("mp4"));
        assert!(store.resolve("../clip.mp4").is_err());
        let _ = std::fs::remove_dir_all(dir);
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

    fn sealed_store() -> (MediaStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ryu-media-test-{}", uuid::Uuid::new_v4()));
        let cipher = ryu_crypto::ContentCipher::from_root(&[3; 32], MEDIA_STORE);
        (
            MediaStore::open_with_cipher(dir.clone(), cipher).unwrap(),
            dir,
        )
    }

    fn sample(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 131 + 17) as u8).collect()
    }

    #[test]
    fn saved_media_is_sealed_on_disk_and_reads_back() {
        let (store, dir) = sealed_store();
        let marker = b"plaintext-media-marker-5521";
        let mut bytes = sample(200 * 1024);
        bytes[1000..1000 + marker.len()].copy_from_slice(marker);
        let obj = store.save(&bytes, "clip.mp4", Some("video/mp4")).unwrap();
        let on_disk = std::fs::read(dir.join(&obj.file_name)).unwrap();
        assert!(on_disk.starts_with(b"RYU-SF01"));
        assert!(!on_disk.windows(marker.len()).any(|window| window == marker));
        assert_eq!(store.load(&obj.file_name).unwrap().0, bytes);
        // No temporary file remains.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        // The quota counts plaintext bytes.
        assert_eq!(store.stored_bytes().unwrap(), bytes.len() as u64);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn range_reads_return_plaintext_slices() {
        use std::io::{Read, Seek};
        let (store, dir) = sealed_store();
        let bytes = sample(300 * 1024 + 7);
        let obj = store.save(&bytes, "clip.webm", None).unwrap();
        let mut reader = store.open_object(&obj.file_name).unwrap();
        assert_eq!(reader.len(), bytes.len() as u64);
        for (start, len) in [
            (0usize, 10usize),
            (65_530, 20),
            (200_000, 100_007),
            (bytes.len() - 5, 5),
        ] {
            reader.seek(std::io::SeekFrom::Start(start as u64)).unwrap();
            let mut out = vec![0u8; len];
            reader.read_exact(&mut out).unwrap();
            assert_eq!(out, bytes[start..start + len]);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn truncated_or_moved_media_does_not_open() {
        let (store, dir) = sealed_store();
        let a = store.save(&sample(70_000), "a.png", None).unwrap();
        let b = store.save(&sample(10), "b.png", None).unwrap();
        // Truncation is detected.
        let path = dir.join(&a.file_name);
        let sealed = std::fs::read(&path).unwrap();
        std::fs::write(&path, &sealed[..sealed.len() - 100]).unwrap();
        assert!(store.load(&a.file_name).is_err());
        // A file copied under another id does not open (AAD = id).
        std::fs::write(dir.join(&b.file_name), &sealed).unwrap();
        assert!(store.load(&b.file_name).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_plaintext_media_reads_and_is_sealed_lazily_and_in_background() {
        let (store, dir) = sealed_store();
        let first = b"legacy-media-one".to_vec();
        let second = b"legacy-media-two".to_vec();
        std::fs::write(dir.join("old-one.png"), &first).unwrap();
        std::fs::write(dir.join("old-two.png"), &second).unwrap();
        // First read serves the plaintext and seals the file.
        assert_eq!(store.load("old-one.png").unwrap().0, first);
        assert!(std::fs::read(dir.join("old-one.png"))
            .unwrap()
            .starts_with(b"RYU-SF01"));
        // The background pass seals the rest and is idempotent.
        let report = store.seal_legacy_files();
        assert_eq!((report.total, report.sealed, report.pending), (1, 1, 0));
        assert_eq!(store.seal_legacy_files().total, 0);
        let on_disk = std::fs::read(dir.join("old-two.png")).unwrap();
        assert!(!String::from_utf8_lossy(&on_disk).contains("legacy-media-two"));
        assert_eq!(store.load("old-two.png").unwrap().0, second);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_oversize_and_empty() {
        let (store, _dir) = temp_store();
        assert!(store.save(&[], "x.png", None).is_err());
        let big = vec![0u8; MAX_MEDIA_BYTES + 1];
        assert!(store.save(&big, "x.png", Some("image/png")).is_err());
    }
}
