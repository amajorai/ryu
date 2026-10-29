//! RNP v0 working-tree handoff.
//!
//! A separate, capability-probed set of endpoints beside the v0 transcript
//! bundle (old nodes answer 404 on `/api/rnp/v0/capabilities`, so the desktop
//! hides the option instead of sending a field an old node would drop). The
//! desktop still mediates every transfer with each node's own credential:
//!
//! 1. the source **inspects** the thread's folder, then **exports** a reviewed
//!    manifest and stages its content-addressed blobs for the exporting caller;
//! 2. the desktop relays each blob (`GET` on the source, `PUT` on the
//!    destination, `HEAD` to skip what the destination already has);
//! 3. the destination **resumes**: it clones (or reuses a matching checkout),
//!    rebuilds the tree as a persistent `handoff/<thread>` worktree, and stamps
//!    the conversation's folder;
//! 4. the desktop then marks the source thread **continued**.
//!
//! Unlike the transcript bundle, a resume may make Core contact a git remote
//! named by the request. That URL must be credential-free HTTPS or SSH, pass
//! `parse_git_clone_url` and the `resolve_guarded_host` SSRF guard, and the
//! desktop shows it to the user before the resume is sent. Git work runs in
//! `spawn_blocking` through `ryu_workspace::handoff`, which never runs
//! repository hooks, filters, textconv or external diff drivers.

use std::collections::BTreeSet;
use std::path::{Path as FsPath, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use ryu_workspace::handoff::{self, HandoffError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use super::{now_millis, valid_text, ValidationError, MAX_ID_BYTES, MAX_LABEL_BYTES, VERSION};
use crate::identity_verify::VerifiedCaller;
use crate::server::{
    enforce_permission, require_resource_read, require_resource_write, ServerState,
};

const FEATURE_WORKSPACE: &str = "workspace";
const MEDIA_BUNDLE: &str = "application/x-git-bundle";
const MEDIA_DIFF: &str = "text/x-diff";
/// JSON routes carry at most one manifest (256 KiB) plus a little framing.
const MAX_JSON_BYTES: usize = 512 * 1024;
const MAX_MANIFEST_JSON_BYTES: usize = 256 * 1024;
const MAX_PREREQUISITES: usize = 64;
/// Staged source blobs live only long enough for one review and transfer.
const STAGING_TTL: Duration = Duration::from_secs(60 * 60);
/// Received destination blobs survive a day so an interrupted resume can retry.
const RECEIVED_TTL: Duration = Duration::from_secs(24 * 60 * 60);

static WORKSPACE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn workspace_lock() -> &'static tokio::sync::Mutex<()> {
    WORKSPACE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// All RNP on-disk state: `<data dir>/state/rnp`. It holds durable resume
/// records beside the TTL-swept staging and received blobs, so it is a structured
/// state dir rather than a regenerable cache.
fn rnp_dir() -> PathBuf {
    crate::paths::state_path("rnp")
}

// ── Wire types (mirrors `@ryuhq/protocol/continuity`) ────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpBlobRefV0 {
    pub sha256: String,
    pub bytes: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceFileV0 {
    pub path: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub binary: bool,
    pub sensitive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceOmissionV0 {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceRepoV0 {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    pub base_commit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceCommitsV0 {
    pub blob: RnpBlobRefV0,
    pub tip: String,
    pub prerequisites: Vec<String>,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceDiffV0 {
    pub blob: RnpBlobRefV0,
    pub files: Vec<RnpWorkspaceFileV0>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceManifestV0 {
    pub version: u8,
    pub workspace_id: String,
    pub conversation_id: String,
    pub created_at: i64,
    pub repo: RnpWorkspaceRepoV0,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commits: Option<RnpWorkspaceCommitsV0>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<RnpWorkspaceDiffV0>,
    pub untracked: Vec<RnpWorkspaceFileV0>,
    pub omitted: Vec<RnpWorkspaceOmissionV0>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceCandidateV0 {
    pub path: String,
    pub bytes: u64,
    pub sensitive: bool,
    pub selectable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RnpWorkspaceDiffStatV0 {
    pub files: usize,
    pub insertions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceInspectionV0 {
    pub version: u8,
    pub conversation_id: String,
    pub repo: RnpWorkspaceRepoV0,
    pub unpushed_commits: u32,
    pub changed: Vec<RnpWorkspaceFileV0>,
    pub untracked_candidates: Vec<RnpWorkspaceCandidateV0>,
    pub diff_stat: RnpWorkspaceDiffStatV0,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceInspectRequestV0 {
    pub version: u8,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceExportRequestV0 {
    pub version: u8,
    #[serde(default)]
    pub if_updated_at: Option<i64>,
    pub if_head: String,
    #[serde(default)]
    pub include_untracked: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum RnpWorkspaceDestinationV0 {
    NewClone {
        #[serde(default, rename = "folderName")]
        folder_name: Option<String>,
    },
    ExistingCheckout {
        #[serde(rename = "checkoutPath")]
        checkout_path: String,
    },
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceResumeRequestV0 {
    pub version: u8,
    pub manifest: RnpWorkspaceManifestV0,
    pub destination: RnpWorkspaceDestinationV0,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpWorkspaceResumeResultV0 {
    pub version: u8,
    pub workspace_id: String,
    pub conversation_id: String,
    pub status: String,
    pub folder_path: String,
    pub worktree_path: String,
    pub branch: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpContinuedOnV0 {
    pub node_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub at: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RnpCapabilitiesV0 {
    pub version: u8,
    pub features: Vec<String>,
}

// ── Errors ────────────────────────────────────────────────────────────────────

/// `{ error, code }`: the code is the stable, machine-readable part.
fn coded_error(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "error": message.into(), "code": code })),
    )
        .into_response()
}

fn validation_response(error: ValidationError) -> Response {
    let code = if error.status == StatusCode::PAYLOAD_TOO_LARGE {
        "too-large"
    } else {
        "invalid-manifest"
    };
    coded_error(error.status, code, error.message)
}

fn handoff_response(error: HandoffError) -> Response {
    let (status, code) = match &error {
        HandoffError::NotAGitRepository => {
            (StatusCode::UNPROCESSABLE_ENTITY, "not-a-git-repository")
        }
        HandoffError::HeadMoved { .. } => (StatusCode::CONFLICT, "head-moved"),
        HandoffError::TooLarge(_) => (StatusCode::PAYLOAD_TOO_LARGE, "too-large"),
        HandoffError::Refused(_) => (StatusCode::UNPROCESSABLE_ENTITY, "refused"),
        HandoffError::MissingCommit(_) => (StatusCode::CONFLICT, "missing-commit"),
        HandoffError::Git(_) => (StatusCode::BAD_GATEWAY, "git-failed"),
    };
    coded_error(status, code, error.to_string())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, HandoffError> + Send + 'static,
) -> Result<T, Response> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result.map_err(handoff_response),
        Err(error) => {
            tracing::error!("rnp workspace task failed: {error}");
            Err(coded_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            ))
        }
    }
}

// ── Validation ────────────────────────────────────────────────────────────────

fn is_hex(value: &str, lengths: &[usize]) -> bool {
    lengths.contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_commit(value: &str) -> bool {
    is_hex(value, &[40, 64])
}

fn is_sha256(value: &str) -> bool {
    is_hex(value, &[64])
}

fn validate_blob(blob: &RnpBlobRefV0, media_type: &str, max: u64) -> Result<(), ValidationError> {
    if !is_sha256(&blob.sha256) {
        return Err(ValidationError::invalid("blob digest is invalid"));
    }
    if blob.media_type != media_type {
        return Err(ValidationError::invalid("blob media type is invalid"));
    }
    if blob.bytes > max {
        return Err(ValidationError::too_large("workspace blob is too large"));
    }
    Ok(())
}

fn validate_file(file: &RnpWorkspaceFileV0) -> Result<(), ValidationError> {
    if !handoff::is_safe_repo_relative_path(&file.path) {
        return Err(ValidationError::invalid(format!(
            "workspace path is unsafe: {}",
            file.path
        )));
    }
    if !matches!(
        file.status.as_str(),
        "added" | "modified" | "deleted" | "renamed"
    ) {
        return Err(ValidationError::invalid("unsupported file status"));
    }
    Ok(())
}

/// Every rule `parseRnpWorkspaceManifest` applies, enforced again here because
/// the destination is the boundary: the manifest came from another machine.
fn validate_manifest(manifest: &RnpWorkspaceManifestV0) -> Result<(), ValidationError> {
    if manifest.version != VERSION {
        return Err(ValidationError::invalid("unsupported continuity version"));
    }
    if !valid_text(&manifest.workspace_id, MAX_ID_BYTES, false)
        || !valid_text(&manifest.conversation_id, MAX_ID_BYTES, false)
    {
        return Err(ValidationError::invalid(
            "workspace and conversation ids are required",
        ));
    }
    if manifest.created_at < 0 {
        return Err(ValidationError::invalid("workspace timestamp is invalid"));
    }
    let repo = &manifest.repo;
    if !valid_text(&repo.name, MAX_LABEL_BYTES, false) {
        return Err(ValidationError::invalid("repository name is invalid"));
    }
    if !is_commit(&repo.base_commit) {
        return Err(ValidationError::invalid("base commit is invalid"));
    }
    for value in [repo.branch.as_deref(), repo.upstream_ref.as_deref()]
        .into_iter()
        .flatten()
    {
        if !valid_text(value, MAX_LABEL_BYTES, false) {
            return Err(ValidationError::invalid("branch name is invalid"));
        }
    }
    if let Some(url) = repo.remote_url.as_deref() {
        crate::server::git::parse_git_clone_url(url).map_err(|error| {
            ValidationError::invalid(format!("remote URL is not allowed: {error}"))
        })?;
    }
    if let Some(commits) = &manifest.commits {
        validate_blob(&commits.blob, MEDIA_BUNDLE, handoff::MAX_BUNDLE_BYTES)?;
        if commits.tip != repo.base_commit {
            return Err(ValidationError::invalid(
                "bundle tip must be the base commit",
            ));
        }
        if commits.prerequisites.len() > MAX_PREREQUISITES
            || !commits.prerequisites.iter().all(|commit| is_commit(commit))
        {
            return Err(ValidationError::invalid("bundle prerequisites are invalid"));
        }
    }
    let diff_files = manifest
        .diff
        .as_ref()
        .map(|diff| diff.files.as_slice())
        .unwrap_or_default();
    if let Some(diff) = &manifest.diff {
        validate_blob(&diff.blob, MEDIA_DIFF, handoff::MAX_DIFF_BYTES)?;
    }
    if diff_files.len() + manifest.omitted.len() > handoff::MAX_MANIFEST_PATHS {
        return Err(ValidationError::too_large("too many workspace paths"));
    }
    for file in diff_files {
        validate_file(file)?;
    }
    if let Some(path) = handoff::first_path_collision(diff_files.iter().map(|f| f.path.as_str())) {
        return Err(ValidationError::invalid(format!(
            "changed paths collide by case or normalization: {path}"
        )));
    }
    if manifest.untracked.len() > handoff::MAX_UNTRACKED_COUNT {
        return Err(ValidationError::too_large("too many untracked files"));
    }
    let diff_paths: BTreeSet<&str> = diff_files.iter().map(|f| f.path.as_str()).collect();
    let mut untracked_paths = BTreeSet::new();
    let mut untracked_bytes = 0u64;
    for file in &manifest.untracked {
        validate_file(file)?;
        if !untracked_paths.insert(file.path.as_str()) {
            return Err(ValidationError::invalid("untracked paths must be unique"));
        }
        if !diff_paths.contains(file.path.as_str()) {
            return Err(ValidationError::invalid(
                "untracked file is missing from the diff",
            ));
        }
        let bytes = file.bytes.unwrap_or(0);
        if bytes > handoff::MAX_UNTRACKED_FILE_BYTES {
            return Err(ValidationError::too_large("untracked file is too large"));
        }
        untracked_bytes = untracked_bytes.saturating_add(bytes);
    }
    if untracked_bytes > handoff::MAX_UNTRACKED_TOTAL_BYTES {
        return Err(ValidationError::too_large("untracked files are too large"));
    }
    let mut omitted = BTreeSet::new();
    for omission in &manifest.omitted {
        if !valid_text(&omission.path, handoff::MAX_PATH_BYTES, false)
            || !omitted.insert(omission.path.as_str())
        {
            return Err(ValidationError::invalid("omitted paths are invalid"));
        }
    }
    if serde_json::to_vec(manifest)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
        > MAX_MANIFEST_JSON_BYTES
    {
        return Err(ValidationError::too_large(
            "workspace manifest is too large",
        ));
    }
    Ok(())
}

/// The SSRF screen for a remote URL that came from another machine: it must
/// parse as a credential-free HTTPS/SSH clone URL and resolve only to public
/// addresses.
pub(crate) async fn guard_remote_url(url: &str) -> Result<(), String> {
    let source = crate::server::git::parse_git_clone_url(url)?;
    crate::server::resolve_guarded_host(&source.host, source.port)
        .await
        .map(|_| ())
}

// ── On-disk state ─────────────────────────────────────────────────────────────

/// Where handoff state and new clones live. Handlers use [`Roots::resolve`];
/// tests pass temporary folders.
#[derive(Debug, Clone)]
pub(crate) struct Roots {
    /// `rnp/` state: `staging/`, `blobs/`, `resumed/`.
    pub rnp: PathBuf,
    /// Parent of new clones (`~/Documents/Ryu/handoffs`).
    pub handoffs: PathBuf,
    /// The node's home folder; clones and existing checkouts must be inside it.
    pub home: PathBuf,
}

impl Roots {
    fn resolve() -> Result<Self, Response> {
        let unavailable = |what: &str| {
            coded_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                format!("could not resolve the {what} directory"),
            )
        };
        let documents = dirs::document_dir().ok_or_else(|| unavailable("Documents"))?;
        let home = dirs::home_dir().ok_or_else(|| unavailable("home"))?;
        Ok(Self {
            rnp: rnp_dir(),
            handoffs: documents.join("Ryu").join("handoffs"),
            home,
        })
    }

    fn staging(&self) -> PathBuf {
        self.rnp.join("staging")
    }

    fn blobs(&self) -> PathBuf {
        self.rnp.join("blobs")
    }

    fn resumed(&self) -> PathBuf {
        self.rnp.join("resumed")
    }

    /// Private scratch for the few seconds a resume needs a received blob as a
    /// plaintext file (git reads bundles and patches by path).
    fn scratch(&self) -> PathBuf {
        self.rnp.join("opened")
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StagingOwner {
    owner: Option<String>,
    created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeRecord {
    conversation_id: String,
    folder_path: String,
    worktree_path: String,
    branch: String,
}

fn caller_key(caller: &Option<VerifiedCaller>) -> Option<String> {
    caller.as_ref().map(|caller| caller.user_id.clone())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Write `bytes` beside `target` and rename it into place, so a reader never
/// sees a partial file.
fn write_atomically(target: &FsPath, bytes: &[u8]) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::other("target has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.partial", uuid::Uuid::new_v4()));
    let result =
        std::fs::write(&temporary, bytes).and_then(|()| std::fs::rename(&temporary, target));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Magic for a handoff blob sealed at rest: `RYU-HB01 | nonce(12) | ciphertext`,
/// ChaCha20-Poly1305 under the node's master key. Staged and received patches
/// and bundles carry working-tree content (possibly credentials the reviewer
/// chose to include), so neither queue keeps them in the clear. The plaintext
/// digest names the file and is re-checked on every open.
const SEALED_BLOB_MAGIC: &[u8; 8] = b"RYU-HB01";

fn seal_blob(bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
    let (nonce, ciphertext) = ryu_crypto::global_cipher()?.encrypt(bytes)?;
    let mut sealed = Vec::with_capacity(SEALED_BLOB_MAGIC.len() + nonce.len() + ciphertext.len());
    sealed.extend_from_slice(SEALED_BLOB_MAGIC);
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

/// Read a staged or received blob and return its plaintext, verifying it still
/// hashes to `sha`. Blobs written by older builds (plaintext, at most a day old
/// given the TTLs) are accepted; a sealed blob that cannot be opened is an error.
fn read_blob(path: &FsPath, sha: &str) -> anyhow::Result<Vec<u8>> {
    let stored = std::fs::read(path)?;
    let plain = match stored.strip_prefix(SEALED_BLOB_MAGIC.as_slice()) {
        Some(body) => {
            anyhow::ensure!(body.len() >= 12, "sealed handoff blob is truncated");
            let (nonce, ciphertext) = body.split_at(12);
            ryu_crypto::global_cipher()?.decrypt(nonce, ciphertext)?
        }
        None => stored,
    };
    anyhow::ensure!(
        sha256_hex(&plain) == sha,
        "handoff blob does not match its digest"
    );
    Ok(plain)
}

/// Seal `bytes` and write them atomically to `target`. Fails closed when the
/// master key is unavailable.
fn write_sealed_blob(target: &FsPath, bytes: &[u8]) -> std::io::Result<()> {
    let sealed = seal_blob(bytes).map_err(|error| std::io::Error::other(error.to_string()))?;
    write_atomically(target, &sealed)
}

fn older_than(path: &FsPath, ttl: Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > ttl)
}

/// Drop expired staging folders and received blobs. Runs on each export and
/// resume instead of from a startup hook.
fn sweep(roots: &Roots) {
    if let Ok(entries) = std::fs::read_dir(roots.staging()) {
        for entry in entries.flatten() {
            if older_than(&entry.path(), STAGING_TTL) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(roots.blobs()) {
        for entry in entries.flatten() {
            if older_than(&entry.path(), RECEIVED_TTL) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    // Plaintext opened for a resume lives only for that request.
    if let Ok(entries) = std::fs::read_dir(roots.scratch()) {
        for entry in entries.flatten() {
            if older_than(&entry.path(), Duration::from_secs(10 * 60)) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// The staged blob `sha` exported by `owner`, if any.
fn staged_blob(roots: &Roots, owner: &Option<String>, sha: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(roots.staging()).ok()?;
    entries.flatten().find_map(|entry| {
        let record: StagingOwner =
            serde_json::from_slice(&std::fs::read(entry.path().join("owner.json")).ok()?).ok()?;
        let blob = entry.path().join(sha);
        (record.owner == *owner && blob.is_file() && !older_than(&entry.path(), STAGING_TTL))
            .then_some(blob)
    })
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StoredBlob {
    Created,
    Unchanged,
}

/// Store a received blob under its digest. Re-uploading the same bytes is a
/// no-op; a digest mismatch leaves nothing behind.
pub(crate) fn store_blob(roots: &Roots, sha: &str, bytes: &[u8]) -> Result<StoredBlob, Response> {
    if !is_sha256(sha) {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-digest",
            "blob digest is invalid",
        ));
    }
    if bytes.len() as u64 > handoff::MAX_BUNDLE_BYTES {
        return Err(coded_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too-large",
            "workspace blob is too large",
        ));
    }
    if sha256_hex(bytes) != sha {
        return Err(coded_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "digest-mismatch",
            "blob content does not match its digest",
        ));
    }
    let target = roots.blobs().join(sha);
    if target.is_file() {
        return Ok(StoredBlob::Unchanged);
    }
    write_sealed_blob(&target, bytes).map_err(|error| {
        coded_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            format!("could not store the blob: {error}"),
        )
    })?;
    Ok(StoredBlob::Created)
}

/// Whether `sha` is in the received store that resume reads from.
fn received_blob_present(roots: &Roots, sha: &str) -> bool {
    roots.blobs().join(sha).is_file()
}

/// Open a received blob for `materialize_handoff`, which reads files by path.
/// The plaintext goes to an owner-only temporary file in the private
/// `rnp/opened` scratch dir that is deleted when the returned handle drops
/// (right after the resume); `sweep` clears anything a crash left there.
fn received_blob(roots: &Roots, blob: &RnpBlobRefV0) -> Result<tempfile::TempPath, Response> {
    let missing = || {
        coded_error(
            StatusCode::CONFLICT,
            "blob-missing",
            format!("blob {} has not been uploaded", blob.sha256),
        )
    };
    let path = roots.blobs().join(&blob.sha256);
    if !path.is_file() {
        return Err(missing());
    }
    let plain = read_blob(&path, &blob.sha256).map_err(|_| missing())?;
    if plain.len() as u64 != blob.bytes {
        return Err(missing());
    }
    let scratch = roots.scratch();
    let written = ryu_backup::archive::private_directory(&scratch)
        .map_err(std::io::Error::other)
        .and_then(|()| {
            let mut file = tempfile::Builder::new()
                .prefix(".handoff-")
                .tempfile_in(&scratch)?;
            std::io::Write::write_all(file.as_file_mut(), &plain)?;
            file.as_file().sync_all()?;
            Ok(file.into_temp_path())
        });
    written.map_err(|error| {
        coded_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            format!("could not open the blob: {error}"),
        )
    })
}

// ── Router ────────────────────────────────────────────────────────────────────

pub(super) fn router() -> Router<ServerState> {
    Router::new()
        .route("/api/rnp/v0/capabilities", get(capabilities))
        .route(
            "/api/rnp/v0/conversations/:id/workspace/inspect",
            post(inspect_workspace),
        )
        .route(
            "/api/rnp/v0/conversations/:id/workspace/export",
            post(export_workspace),
        )
        .route(
            "/api/rnp/v0/conversations/:id/workspace/resume",
            post(resume_workspace),
        )
        .route(
            "/api/rnp/v0/conversations/:id/continued",
            post(mark_continued).delete(clear_continued),
        )
        .layer(DefaultBodyLimit::max(MAX_JSON_BYTES))
        .route(
            "/api/rnp/v0/workspace-blobs/:sha256",
            get(get_blob)
                .head(head_blob)
                .put(put_blob)
                .layer(DefaultBodyLimit::max(handoff::MAX_BUNDLE_BYTES as usize)),
        )
}

#[utoipa::path(
    get,
    path = "/api/rnp/v0/capabilities",
    tag = "Conversations",
    summary = "List the optional RNP v0 features this node supports",
    responses((status = 200, body = RnpCapabilitiesV0))
)]
pub(crate) async fn capabilities() -> Json<RnpCapabilitiesV0> {
    Json(RnpCapabilitiesV0 {
        version: VERSION,
        features: vec![FEATURE_WORKSPACE.to_owned()],
    })
}

/// The source conversation after the read ACL, refusing while a turn runs.
async fn source_summary(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
) -> Result<super::super::conversations::ConversationSummary, Response> {
    require_resource_read(
        state.conversations.get_access_meta(id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    )?;
    let summary = state
        .conversations
        .get_summary(id)
        .await
        .map_err(|error| {
            coded_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                error.to_string(),
            )
        })?
        .ok_or_else(|| {
            coded_error(
                StatusCode::NOT_FOUND,
                "not-found",
                format!("conversation '{id}' not found"),
            )
        })?;
    if summary.run_status.as_deref() == Some("running") {
        return Err(coded_error(
            StatusCode::CONFLICT,
            "turn-running",
            "wait for the active response to finish before continuing elsewhere",
        ));
    }
    Ok(summary)
}

/// The folder the thread works in: its worktree when it has one, else its folder.
fn thread_folder(
    summary: &super::super::conversations::ConversationSummary,
) -> Result<PathBuf, Response> {
    [
        summary.worktree_path.as_deref(),
        summary.folder_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(PathBuf::from)
    .find(|path| path.is_dir())
    .ok_or_else(|| {
        coded_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "not-a-git-repository",
            "this thread has no folder to hand off",
        )
    })
}

fn file_wire(file: &handoff::ChangedFile) -> RnpWorkspaceFileV0 {
    RnpWorkspaceFileV0 {
        path: file.path.clone(),
        status: serde_json::to_value(file.status)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "modified".to_owned()),
        bytes: file.bytes,
        binary: file.binary,
        sensitive: file.sensitive,
    }
}

fn reason_wire(reason: handoff::OmissionReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "not-selected".to_owned())
}

fn repo_wire(inspection: &handoff::WorkspaceInspection) -> RnpWorkspaceRepoV0 {
    RnpWorkspaceRepoV0 {
        name: inspection.name.clone(),
        remote_url: inspection.remote_url.clone(),
        base_commit: inspection.head.clone(),
        branch: inspection.branch.clone(),
        upstream_ref: inspection.upstream_ref.clone(),
    }
}

pub(crate) async fn inspect_inner(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
) -> Result<RnpWorkspaceInspectionV0, Response> {
    let summary = source_summary(state, caller, id).await?;
    let folder = thread_folder(&summary)?;
    let inspection = blocking(move || handoff::inspect_workspace(&folder)).await?;
    Ok(RnpWorkspaceInspectionV0 {
        version: VERSION,
        conversation_id: id.to_owned(),
        repo: repo_wire(&inspection),
        unpushed_commits: inspection.unpushed_commits,
        diff_stat: RnpWorkspaceDiffStatV0 {
            files: inspection.changed.len(),
            insertions: inspection.insertions,
            deletions: inspection.deletions,
        },
        changed: inspection.changed.iter().map(file_wire).collect(),
        untracked_candidates: inspection
            .untracked
            .iter()
            .map(|candidate| RnpWorkspaceCandidateV0 {
                path: candidate.path.clone(),
                bytes: candidate.bytes,
                sensitive: candidate.sensitive,
                selectable: candidate.selectable,
                reason: candidate.reason.map(reason_wire),
            })
            .collect(),
    })
}

#[utoipa::path(
    post,
    path = "/api/rnp/v0/conversations/{id}/workspace/inspect",
    tag = "Conversations",
    summary = "Describe the working tree a handoff of this thread would carry",
    params(("id" = String, Path)),
    request_body = RnpWorkspaceInspectRequestV0,
    responses((status = 200, body = RnpWorkspaceInspectionV0), (status = 409), (status = 422))
)]
pub(crate) async fn inspect_workspace(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(request): Json<RnpWorkspaceInspectRequestV0>,
) -> Response {
    if request.version != VERSION {
        return coded_error(
            StatusCode::BAD_REQUEST,
            "unsupported-version",
            "unsupported continuity version",
        );
    }
    match inspect_inner(&state, &caller, &id).await {
        Ok(inspection) => Json(inspection).into_response(),
        Err(response) => response,
    }
}

pub(crate) async fn export_inner(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
    request: RnpWorkspaceExportRequestV0,
    roots: &Roots,
) -> Result<RnpWorkspaceManifestV0, Response> {
    if request.version != VERSION {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "unsupported-version",
            "unsupported continuity version",
        ));
    }
    if !is_commit(&request.if_head) {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-request",
            "ifHead must be a commit id",
        ));
    }
    if request.include_untracked.len() > handoff::MAX_UNTRACKED_COUNT {
        return Err(coded_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too-large",
            "too many untracked files",
        ));
    }
    if !request
        .include_untracked
        .iter()
        .all(|path| handoff::is_safe_repo_relative_path(path))
    {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-request",
            "an untracked path is unsafe",
        ));
    }
    let summary = source_summary(state, caller, id).await?;
    if request
        .if_updated_at
        .is_some_and(|value| value != summary.updated_at)
    {
        return Err(coded_error(
            StatusCode::CONFLICT,
            "conversation-changed",
            "conversation changed after the handoff review; review it again",
        ));
    }
    let folder = thread_folder(&summary)?;
    sweep(roots);
    let workspace_id = uuid::Uuid::new_v4().to_string();
    let staging = roots.staging().join(&workspace_id);
    let owner = StagingOwner {
        owner: caller_key(caller),
        created_at: now_millis(),
    };
    let owner_json = serde_json::to_vec(&owner).unwrap_or_default();
    if let Err(error) = write_atomically(&staging.join("owner.json"), &owner_json) {
        return Err(coded_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            format!("could not create the staging folder: {error}"),
        ));
    }
    let work = staging.join("work");
    let if_head = request.if_head.clone();
    let include = request.include_untracked.clone();
    let staging_for_task = staging.clone();
    let result = blocking(move || {
        let exported = handoff::export_workspace(&folder, &if_head, &include, &work)?;
        // Content-address each blob inside the caller's staging folder.
        // The exported file is sealed into the staging folder and the
        // plaintext work copy removed at once.
        let stage = |path: &FsPath| -> Result<(String, u64), HandoffError> {
            let plain = std::fs::read(path)
                .map_err(|error| HandoffError::Git(format!("could not read a blob: {error}")))?;
            let sha = sha256_hex(&plain);
            let bytes = plain.len() as u64;
            let sealed = write_sealed_blob(&staging_for_task.join(&sha), &plain);
            let _ = std::fs::remove_file(path);
            sealed
                .map_err(|error| HandoffError::Git(format!("could not stage a blob: {error}")))?;
            Ok((sha, bytes))
        };
        let commits = exported
            .commits
            .as_ref()
            .map(|commits| stage(&commits.path).map(|blob| (blob, commits.clone())))
            .transpose()?;
        let diff = exported
            .diff
            .as_ref()
            .map(|diff| stage(&diff.path).map(|blob| (blob, diff.clone())))
            .transpose()?;
        let _ = std::fs::remove_dir_all(&work);
        Ok((exported, commits, diff))
    })
    .await;
    let (exported, commits, diff) = match result {
        Ok(value) => value,
        Err(response) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(response);
        }
    };
    let manifest = RnpWorkspaceManifestV0 {
        version: VERSION,
        workspace_id,
        conversation_id: id.to_owned(),
        created_at: now_millis(),
        repo: repo_wire(&exported.inspection),
        commits: commits.map(|((sha256, bytes), commits)| RnpWorkspaceCommitsV0 {
            blob: RnpBlobRefV0 {
                sha256,
                bytes,
                media_type: MEDIA_BUNDLE.to_owned(),
            },
            tip: commits.tip,
            prerequisites: commits.prerequisites,
            count: commits.count,
        }),
        diff: diff.map(|((sha256, bytes), diff)| RnpWorkspaceDiffV0 {
            blob: RnpBlobRefV0 {
                sha256,
                bytes,
                media_type: MEDIA_DIFF.to_owned(),
            },
            files: diff.files.iter().map(file_wire).collect(),
        }),
        untracked: exported.untracked.iter().map(file_wire).collect(),
        omitted: exported
            .omitted
            .iter()
            .map(|omission| RnpWorkspaceOmissionV0 {
                path: omission.path.clone(),
                reason: reason_wire(omission.reason),
            })
            .collect(),
    };
    if let Err(error) = validate_manifest(&manifest) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(validation_response(error));
    }
    Ok(manifest)
}

#[utoipa::path(
    post,
    path = "/api/rnp/v0/conversations/{id}/workspace/export",
    tag = "Conversations",
    summary = "Stage the reviewed working tree of this thread for a handoff",
    params(("id" = String, Path)),
    request_body = RnpWorkspaceExportRequestV0,
    responses((status = 200, body = RnpWorkspaceManifestV0), (status = 409), (status = 413), (status = 422))
)]
pub(crate) async fn export_workspace(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(request): Json<RnpWorkspaceExportRequestV0>,
) -> Response {
    let roots = match Roots::resolve() {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    match export_inner(&state, &caller, &id, request, &roots).await {
        Ok(manifest) => Json(manifest).into_response(),
        Err(response) => response,
    }
}

fn blob_digest(sha: &str) -> Result<(), Response> {
    if is_sha256(sha) {
        Ok(())
    } else {
        Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-digest",
            "blob digest is invalid",
        ))
    }
}

#[utoipa::path(
    get,
    path = "/api/rnp/v0/workspace-blobs/{sha256}",
    tag = "Conversations",
    summary = "Download a staged handoff blob (exporting caller only)",
    params(("sha256" = String, Path)),
    responses((status = 200, description = "Blob bytes (application/octet-stream)"), (status = 404))
)]
pub(crate) async fn get_blob(
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(sha): Path<String>,
) -> Response {
    if let Err(response) = blob_digest(&sha) {
        return response;
    }
    let roots = match Roots::resolve() {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    read_staged_blob(&roots, &caller, sha).await
}

/// The staged blob `sha` exported by `caller`, as `get_blob` serves it.
async fn read_staged_blob(roots: &Roots, caller: &Option<VerifiedCaller>, sha: String) -> Response {
    if let Err(response) = blob_digest(&sha) {
        return response;
    }
    let Some(path) = staged_blob(roots, &caller_key(caller), &sha) else {
        return coded_error(
            StatusCode::NOT_FOUND,
            "blob-missing",
            "blob is not staged for this caller",
        );
    };
    match tokio::task::spawn_blocking(move || read_blob(&path, &sha)).await {
        Ok(Ok(bytes)) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()
        }
        _ => coded_error(
            StatusCode::NOT_FOUND,
            "blob-missing",
            "blob is no longer staged",
        ),
    }
}

#[utoipa::path(
    head,
    path = "/api/rnp/v0/workspace-blobs/{sha256}",
    tag = "Conversations",
    summary = "Check whether a handoff blob is already present",
    params(("sha256" = String, Path)),
    responses((status = 200), (status = 404))
)]
pub(crate) async fn head_blob(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(sha): Path<String>,
) -> Response {
    if let Err(response) = blob_digest(&sha) {
        return response;
    }
    let roots = match Roots::resolve() {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    // HEAD answers for the received store only: the relay asks the destination
    // whether it can skip the PUT, and resume reads only received blobs. A blob
    // this node merely staged for its own export must not count as present.
    // Received blobs are visible to callers who may upload them.
    let present = received_blob_present(&roots, &sha)
        && enforce_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_EDIT,
        )
        .await
        .is_ok();
    if present {
        StatusCode::OK.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

#[utoipa::path(
    put,
    path = "/api/rnp/v0/workspace-blobs/{sha256}",
    tag = "Conversations",
    summary = "Upload a content-addressed handoff blob to this node",
    params(("sha256" = String, Path)),
    request_body(
        content = Vec<u8>,
        content_type = "application/octet-stream",
        description = "The raw blob; its sha256 must equal the path digest."
    ),
    responses((status = 200), (status = 201), (status = 413), (status = 422))
)]
pub(crate) async fn put_blob(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(sha): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return coded_error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "insufficient permissions: agent.edit",
        );
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream");
    if !content_type.starts_with("application/octet-stream") {
        return coded_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported-media-type",
            "blobs are uploaded as application/octet-stream",
        );
    }
    let roots = match Roots::resolve() {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    let bytes = body.len();
    match tokio::task::spawn_blocking(move || {
        store_blob(&roots, &sha, &body).map(|stored| (sha, stored))
    })
    .await
    {
        Ok(Ok((sha, stored))) => {
            let (status, label) = match stored {
                StoredBlob::Created => (StatusCode::CREATED, "created"),
                StoredBlob::Unchanged => (StatusCode::OK, "unchanged"),
            };
            (
                status,
                Json(json!({ "sha256": sha, "bytes": bytes, "status": label })),
            )
                .into_response()
        }
        Ok(Err(response)) => response,
        Err(_) => coded_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        ),
    }
}

fn record_path(roots: &Roots, workspace_id: &str) -> PathBuf {
    roots
        .resumed()
        .join(format!("{}.json", sha256_hex(workspace_id.as_bytes())))
}

fn inside(root: &FsPath, path: &FsPath) -> bool {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    path.starts_with(root)
}

fn slug(value: &str, max: usize) -> String {
    let slug: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .take(max)
        .collect();
    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() {
        "thread".to_owned()
    } else {
        slug
    }
}

/// Remotes compare without credentials, a trailing slash or `.git`.
fn same_remote(left: &str, right: &str) -> bool {
    let normalize = |url: &str| {
        let url = url.trim().trim_end_matches('/');
        url.strip_suffix(".git").unwrap_or(url).to_ascii_lowercase()
    };
    normalize(left) == normalize(right)
}

fn stamp_error(error: impl std::fmt::Display) -> Response {
    coded_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        error.to_string(),
    )
}

/// Pick the repository the worktree is added to. New clones are created (and
/// removed again on failure by the caller); existing checkouts are only read.
async fn prepare_repository(
    manifest: &RnpWorkspaceManifestV0,
    destination: &RnpWorkspaceDestinationV0,
    roots: &Roots,
) -> Result<(PathBuf, bool), Response> {
    let refused =
        |code: &str, message: String| coded_error(StatusCode::UNPROCESSABLE_ENTITY, code, message);
    let needed: Vec<String> = match &manifest.commits {
        Some(commits) => commits.prerequisites.clone(),
        None => vec![manifest.repo.base_commit.clone()],
    };
    match destination {
        RnpWorkspaceDestinationV0::ExistingCheckout { checkout_path } => {
            let Some(remote) = manifest.repo.remote_url.clone() else {
                return Err(refused(
                    "remote-mismatch",
                    "an existing checkout needs the source's remote URL".to_owned(),
                ));
            };
            let path = std::fs::canonicalize(checkout_path).map_err(|_| {
                refused(
                    "folder-invalid",
                    "the checkout folder does not exist".to_owned(),
                )
            })?;
            if !inside(&roots.home, &path) {
                return Err(coded_error(
                    StatusCode::FORBIDDEN,
                    "folder-invalid",
                    "the checkout must stay inside the node home directory",
                ));
            }
            let root = blocking({
                let path = path.clone();
                move || handoff::inspect_workspace(&path).map(|inspection| inspection.repo_root)
            })
            .await?;
            let origin = handoff::origin_url(&root);
            if !origin
                .as_deref()
                .is_some_and(|origin| same_remote(origin, &remote))
            {
                return Err(refused(
                    "remote-mismatch",
                    "the checkout's origin does not match the handed-off repository".to_owned(),
                ));
            }
            guard_remote_url(&remote)
                .await
                .map_err(|error| coded_error(StatusCode::BAD_GATEWAY, "remote-blocked", error))?;
            let ensure_root = root.clone();
            blocking(move || handoff::ensure_base(&ensure_root, &needed)).await?;
            Ok((root, false))
        }
        RnpWorkspaceDestinationV0::NewClone { folder_name } => {
            let base_name = folder_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "{}-{}",
                        slug(&manifest.repo.name, 80),
                        slug(&manifest.conversation_id, 8)
                    )
                });
            crate::server::git::validate_folder_name(&base_name)
                .map_err(|error| refused("folder-invalid", error))?;
            std::fs::create_dir_all(&roots.handoffs).map_err(stamp_error)?;
            let parent = std::fs::canonicalize(&roots.handoffs).map_err(stamp_error)?;
            if !inside(&roots.home, &parent) {
                return Err(coded_error(
                    StatusCode::FORBIDDEN,
                    "folder-invalid",
                    "the handoff folder must stay inside the node home directory",
                ));
            }
            let folder = (1..=20)
                .map(|attempt| {
                    if attempt == 1 {
                        parent.join(&base_name)
                    } else {
                        parent.join(format!("{base_name}-{attempt}"))
                    }
                })
                .find(|candidate| std::fs::symlink_metadata(candidate).is_err())
                .ok_or_else(|| {
                    coded_error(
                        StatusCode::CONFLICT,
                        "folder-exists",
                        "no free handoff folder name is left",
                    )
                })?;
            match manifest.repo.remote_url.clone() {
                Some(remote) => {
                    guard_remote_url(&remote).await.map_err(|error| {
                        coded_error(StatusCode::BAD_GATEWAY, "remote-blocked", error)
                    })?;
                    let clone_folder = folder.clone();
                    let cloned = blocking(move || {
                        ryu_workspace::git::clone_repository(&remote, &clone_folder)
                            .map_err(HandoffError::Git)?;
                        handoff::ensure_base(&clone_folder, &needed)
                    })
                    .await;
                    if let Err(response) = cloned {
                        let _ = std::fs::remove_dir_all(&folder);
                        return Err(response);
                    }
                }
                None => {
                    // A local-only repository ships its full history.
                    let full_history = manifest
                        .commits
                        .as_ref()
                        .is_some_and(|commits| commits.prerequisites.is_empty());
                    if !full_history {
                        return Err(refused(
                            "remote-required",
                            "the source has no reachable remote and sent no full history"
                                .to_owned(),
                        ));
                    }
                    let init_folder = folder.clone();
                    blocking(move || handoff::init_repository(&init_folder)).await?;
                }
            }
            Ok((folder, true))
        }
    }
}

pub(crate) async fn resume_inner(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
    request: RnpWorkspaceResumeRequestV0,
    roots: &Roots,
) -> Result<RnpWorkspaceResumeResultV0, Response> {
    if request.version != VERSION {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "unsupported-version",
            "unsupported continuity version",
        ));
    }
    let manifest = request.manifest;
    validate_manifest(&manifest).map_err(validation_response)?;
    if manifest.conversation_id != id {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-manifest",
            "path conversation id does not match the workspace manifest",
        ));
    }
    // The transcript resume runs first, so the conversation must exist here.
    require_resource_write(
        state.conversations.get_access_meta(id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    )?;
    if enforce_permission(
        state,
        caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return Err(coded_error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "insufficient permissions: agent.edit",
        ));
    }
    // A worktree added to an existing checkout would inherit that checkout's
    // workspace trust (#662 `worktree_origin`) until handed-off worktrees are
    // excluded by their `ryu-handoff` marker, so v1 resumes into new clones only.
    if matches!(
        request.destination,
        RnpWorkspaceDestinationV0::ExistingCheckout { .. }
    ) {
        return Err(coded_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "existing-checkout-unavailable",
            "this node resumes handed-off working trees into a new clone only",
        ));
    }
    let _guard = workspace_lock().lock().await;
    sweep(roots);

    let record_file = record_path(roots, &manifest.workspace_id);
    let result = |status: &str, record: &ResumeRecord| RnpWorkspaceResumeResultV0 {
        version: VERSION,
        workspace_id: manifest.workspace_id.clone(),
        conversation_id: id.to_owned(),
        status: status.to_owned(),
        folder_path: record.folder_path.clone(),
        worktree_path: record.worktree_path.clone(),
        branch: record.branch.clone(),
        // Handed-off folders are never trusted automatically.
        warnings: vec!["workspace-untrusted".to_owned()],
    };
    if let Some(record) = std::fs::read(&record_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ResumeRecord>(&bytes).ok())
        .filter(|record| {
            record.conversation_id == id && FsPath::new(&record.worktree_path).is_dir()
        })
    {
        state
            .conversations
            .set_run_metadata(
                id,
                Some(&record.worktree_path),
                Some(&record.branch),
                Some(&record.worktree_path),
            )
            .await
            .map_err(stamp_error)?;
        return Ok(result("unchanged", &record));
    }

    let bundle = manifest
        .commits
        .as_ref()
        .map(|commits| received_blob(roots, &commits.blob))
        .transpose()?;
    let diff = manifest
        .diff
        .as_ref()
        .map(|diff| received_blob(roots, &diff.blob))
        .transpose()?;

    let (repo_root, created) = prepare_repository(&manifest, &request.destination, roots).await?;
    let worktree_dir = repo_root
        .join(".ryu-worktrees")
        .join(format!("handoff-{}", slug(&manifest.workspace_id, 12)));
    let marker = json!({
        "workspaceId": manifest.workspace_id,
        "conversationId": id,
        "baseCommit": manifest.repo.base_commit,
        "at": now_millis(),
    })
    .to_string();
    let materialize = handoff::MaterializeRequest {
        repo_root: repo_root.clone(),
        bundle: bundle.as_ref().map(|path| path.to_path_buf()),
        head: manifest.repo.base_commit.clone(),
        branch: format!("handoff/{}", slug(id, 8)),
        worktree_dir,
        diff: diff.as_ref().map(|path| path.to_path_buf()),
        expected_paths: manifest
            .diff
            .as_ref()
            .map(|diff| diff.files.iter().map(|file| file.path.clone()).collect())
            .unwrap_or_default(),
        marker,
    };
    let materialized = blocking(move || handoff::materialize_handoff(&materialize)).await;
    // Remove the opened plaintext copies as soon as git has read them.
    drop(bundle);
    drop(diff);
    let materialized = match materialized {
        Ok(materialized) => materialized,
        Err(response) => {
            if created {
                let _ = std::fs::remove_dir_all(&repo_root);
            }
            return Err(response);
        }
    };
    let record = ResumeRecord {
        conversation_id: id.to_owned(),
        folder_path: repo_root.to_string_lossy().into_owned(),
        worktree_path: materialized.worktree_path.to_string_lossy().into_owned(),
        branch: materialized.branch,
    };
    // The thread now works in the worktree; isolation must stay off for it (a
    // managed fork from HEAD would leave the uncommitted changes behind, and
    // `create_managed_worktree` refuses a handoff worktree for that reason).
    state
        .conversations
        .set_run_metadata(
            id,
            Some(&record.worktree_path),
            Some(&record.branch),
            Some(&record.worktree_path),
        )
        .await
        .map_err(stamp_error)?;
    if let Ok(bytes) = serde_json::to_vec(&record) {
        if let Err(error) = write_atomically(&record_file, &bytes) {
            tracing::warn!("could not record workspace resume: {error}");
        }
    }
    for blob in [
        manifest.commits.as_ref().map(|commits| &commits.blob),
        manifest.diff.as_ref().map(|diff| &diff.blob),
    ]
    .into_iter()
    .flatten()
    {
        let _ = std::fs::remove_file(roots.blobs().join(&blob.sha256));
    }
    Ok(result("created", &record))
}

#[utoipa::path(
    post,
    path = "/api/rnp/v0/conversations/{id}/workspace/resume",
    tag = "Conversations",
    summary = "Rebuild a handed-off working tree as a worktree on this node",
    params(("id" = String, Path)),
    request_body = RnpWorkspaceResumeRequestV0,
    responses((status = 200, body = RnpWorkspaceResumeResultV0), (status = 403), (status = 409), (status = 422))
)]
pub(crate) async fn resume_workspace(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(request): Json<RnpWorkspaceResumeRequestV0>,
) -> Response {
    let roots = match Roots::resolve() {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    match resume_inner(&state, &caller, &id, request, &roots).await {
        Ok(result) => Json(result).into_response(),
        Err(response) => response,
    }
}

pub(crate) async fn set_continued_inner(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
    record: Option<RnpContinuedOnV0>,
) -> Result<serde_json::Value, Response> {
    require_resource_write(
        state.conversations.get_access_meta(id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    )?;
    let Some(record) = record else {
        state
            .conversations
            .clear_continued_on(id)
            .await
            .map_err(stamp_error)?;
        return Ok(json!({ "continuedOn": null }));
    };
    let ids_valid = [record.bundle_id.as_deref(), record.workspace_id.as_deref()]
        .into_iter()
        .flatten()
        .all(|value| valid_text(value, MAX_ID_BYTES, false));
    if !valid_text(&record.node_label, MAX_LABEL_BYTES, false) || !ids_valid || record.at < 0 {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-request",
            "continued-on record is invalid",
        ));
    }
    let value = serde_json::to_value(&record).map_err(stamp_error)?;
    state
        .conversations
        .set_continued_on(id, &value.to_string())
        .await
        .map_err(stamp_error)?;
    Ok(json!({ "continuedOn": value }))
}

#[utoipa::path(
    post,
    path = "/api/rnp/v0/conversations/{id}/continued",
    tag = "Conversations",
    summary = "Mark this thread as continued on another node",
    params(("id" = String, Path)),
    request_body = RnpContinuedOnV0,
    responses((status = 200), (status = 403), (status = 404))
)]
pub(crate) async fn mark_continued(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(record): Json<RnpContinuedOnV0>,
) -> Response {
    match set_continued_inner(&state, &caller, &id, Some(record)).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

#[utoipa::path(
    delete,
    path = "/api/rnp/v0/conversations/{id}/continued",
    tag = "Conversations",
    summary = "Take a continued thread back on this node",
    params(("id" = String, Path)),
    responses((status = 200), (status = 403), (status = 404))
)]
pub(crate) async fn clear_continued(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    match set_continued_inner(&state, &caller, &id, None).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::conversations::Tenancy;
    use std::process::Command;

    const FIXTURE: &str =
        include_str!("../../../../../packages/protocol/fixtures/continuity-workspace-v0.json");

    fn fixture() -> RnpWorkspaceManifestV0 {
        serde_json::from_str(FIXTURE).expect("fixture must deserialize")
    }

    fn git(dir: &FsPath, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn roots(base: &FsPath) -> Roots {
        Roots {
            rnp: base.join("rnp"),
            handoffs: base.join("home/Documents/Ryu/handoffs"),
            home: base.join("home"),
        }
    }

    fn file(path: &str) -> RnpWorkspaceFileV0 {
        RnpWorkspaceFileV0 {
            path: path.to_owned(),
            status: "added".to_owned(),
            bytes: Some(1),
            binary: false,
            sensitive: false,
        }
    }

    fn status(response: Response) -> StatusCode {
        response.status()
    }

    #[test]
    fn shared_fixture_parses_and_validates() {
        let manifest = fixture();
        validate_manifest(&manifest).expect("fixture must satisfy Rust limits");
        assert_eq!(manifest.diff.as_ref().unwrap().files.len(), 4);
        assert_eq!(manifest.untracked[0].path, "notes/todo.txt");
    }

    #[test]
    fn validation_rejects_unsafe_paths_collisions_and_oversize_values() {
        for path in [
            "/etc/passwd",
            "C:/Windows",
            "\\\\server\\share",
            "a\\b",
            "a/../b",
            "./a",
            "a//b",
            ".git/config",
            "x/.GIT/hooks",
            "GIT~1/x",
            "trailing./x",
            "space /x",
            "nul\u{0}",
        ] {
            let mut manifest = fixture();
            manifest.untracked.clear();
            manifest.diff.as_mut().unwrap().files = vec![file(path)];
            assert!(validate_manifest(&manifest).is_err(), "{path:?}");
        }
        let mut duplicate = fixture();
        duplicate.untracked.clear();
        duplicate.diff.as_mut().unwrap().files = vec![file("a.txt"), file("A.TXT")];
        assert!(validate_manifest(&duplicate).is_err());
        let mut nfc = fixture();
        nfc.untracked.clear();
        nfc.diff.as_mut().unwrap().files = vec![file("caf\u{e9}"), file("cafe\u{301}")];
        assert!(validate_manifest(&nfc).is_err());

        let mut big_bundle = fixture();
        big_bundle.commits.as_mut().unwrap().blob.bytes = handoff::MAX_BUNDLE_BYTES + 1;
        assert_eq!(
            validate_manifest(&big_bundle).unwrap_err().status,
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let mut big_diff = fixture();
        big_diff.diff.as_mut().unwrap().blob.bytes = handoff::MAX_DIFF_BYTES + 1;
        assert!(validate_manifest(&big_diff).is_err());

        let mut many = fixture();
        let files: Vec<_> = (0..=handoff::MAX_UNTRACKED_COUNT)
            .map(|index| file(&format!("n/{index}.txt")))
            .collect();
        many.diff.as_mut().unwrap().files = files.clone();
        many.untracked = files;
        assert_eq!(
            validate_manifest(&many).unwrap_err().status,
            StatusCode::PAYLOAD_TOO_LARGE
        );

        let mut big_untracked = fixture();
        big_untracked.untracked[0].bytes = Some(handoff::MAX_UNTRACKED_FILE_BYTES + 1);
        assert!(validate_manifest(&big_untracked).is_err());

        for url in [
            "https://token@github.com/org/repo.git",
            "https://user:pw@github.com/org/repo.git",
            "ssh://alice@example.com/org/repo.git",
            "http://github.com/org/repo.git",
            "file:///srv/repo.git",
        ] {
            let mut manifest = fixture();
            manifest.repo.remote_url = Some(url.to_owned());
            assert!(validate_manifest(&manifest).is_err(), "{url}");
        }
        let mut tip = fixture();
        tip.commits.as_mut().unwrap().tip = "3".repeat(40);
        assert!(validate_manifest(&tip).is_err());
    }

    #[tokio::test]
    async fn remote_guard_rejects_private_hosts_and_other_schemes() {
        for url in [
            "https://127.0.0.1/org/repo.git",
            "https://localhost/org/repo.git",
            "https://169.254.169.254/org/repo.git",
            "https://10.0.0.8/org/repo.git",
            "https://[::1]/org/repo.git",
            "git@127.0.0.1:org/repo.git",
            "http://github.com/org/repo.git",
            "file:///srv/repo.git",
            "ftp://example.com/org/repo.git",
        ] {
            assert!(guard_remote_url(url).await.is_err(), "{url}");
        }
    }

    #[test]
    fn blob_store_checks_digest_is_idempotent_and_leaves_no_partial_file() {
        crate::crypto_host::install();
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(temp.path());
        let bytes = b"bundle bytes";
        let sha = sha256_hex(bytes);
        assert_eq!(
            status(store_blob(&roots, &"0".repeat(64), bytes).unwrap_err()),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            status(store_blob(&roots, "not-a-digest", bytes).unwrap_err()),
            StatusCode::BAD_REQUEST
        );
        assert!(
            !roots.blobs().exists() || std::fs::read_dir(roots.blobs()).unwrap().next().is_none()
        );
        assert_eq!(
            store_blob(&roots, &sha, bytes).unwrap(),
            StoredBlob::Created
        );
        assert_eq!(
            store_blob(&roots, &sha, bytes).unwrap(),
            StoredBlob::Unchanged
        );
        let names: Vec<_> = std::fs::read_dir(roots.blobs())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![sha.clone()]);
        // Sealed on disk; the plaintext comes back only through `read_blob`.
        let stored = std::fs::read(roots.blobs().join(&sha)).unwrap();
        assert!(stored.starts_with(SEALED_BLOB_MAGIC));
        assert!(!stored.windows(bytes.len()).any(|window| window == bytes));
        assert_eq!(read_blob(&roots.blobs().join(&sha), &sha).unwrap(), bytes);
    }

    #[test]
    fn handoff_blobs_read_legacy_plaintext_and_reject_tampering() {
        crate::crypto_host::install();
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(temp.path());
        let bytes = b"diff --git a/.env b/.env\n+TOKEN=sk-live-handoff-secret\n";
        let sha = sha256_hex(bytes);
        // A blob an older build wrote in the clear still opens.
        std::fs::create_dir_all(roots.blobs()).unwrap();
        std::fs::write(roots.blobs().join(&sha), bytes).unwrap();
        assert_eq!(read_blob(&roots.blobs().join(&sha), &sha).unwrap(), bytes);
        // A sealed blob with a flipped byte, or under the wrong name, fails.
        let sealed_path = temp.path().join("sealed");
        write_sealed_blob(&sealed_path, bytes).unwrap();
        assert!(read_blob(&sealed_path, &"0".repeat(64)).is_err());
        let mut damaged = std::fs::read(&sealed_path).unwrap();
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        std::fs::write(&sealed_path, damaged).unwrap();
        assert!(read_blob(&sealed_path, &sha).is_err());
        // Resume opens a received blob into a private scratch file that is
        // gone once the handle drops.
        std::fs::remove_file(roots.blobs().join(&sha)).unwrap();
        store_blob(&roots, &sha, bytes).unwrap();
        let reference = RnpBlobRefV0 {
            sha256: sha.clone(),
            bytes: bytes.len() as u64,
            media_type: "text/x-diff".to_owned(),
        };
        let opened = received_blob(&roots, &reference).unwrap();
        assert_eq!(std::fs::read(&opened).unwrap(), bytes);
        let opened_path = opened.to_path_buf();
        drop(opened);
        assert!(!opened_path.exists());
    }

    /// A source repository with no network remote, one local commit, a tracked
    /// change and an untracked file.
    fn source_repo(base: &FsPath) -> PathBuf {
        let source = base.join("home/src/app");
        std::fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "--quiet", "-b", "main"]);
        git(&source, &["config", "user.email", "test@ryu"]);
        git(&source, &["config", "user.name", "Test"]);
        git(&source, &["config", "commit.gpgsign", "false"]);
        std::fs::write(source.join("README.md"), "one\n").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "--quiet", "-m", "init"]);
        std::fs::write(source.join("README.md"), "one\ntwo\n").unwrap();
        std::fs::write(source.join("notes.txt"), "carry me\n").unwrap();
        std::fs::write(source.join(".env"), "SECRET=1\n").unwrap();
        source
    }

    fn owned(user: &str) -> Tenancy {
        Tenancy::Owned {
            user_id: user.to_owned(),
            org_id: Some("org-1".to_owned()),
        }
    }

    fn member(user: &str) -> Option<VerifiedCaller> {
        Some(VerifiedCaller {
            user_id: user.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        })
    }

    async fn relay(
        source_roots: &Roots,
        destination_roots: &Roots,
        caller: &Option<VerifiedCaller>,
        manifest: &RnpWorkspaceManifestV0,
    ) {
        for blob in [
            manifest.commits.as_ref().map(|c| &c.blob),
            manifest.diff.as_ref().map(|d| &d.blob),
        ]
        .into_iter()
        .flatten()
        {
            let staged =
                staged_blob(source_roots, &caller_key(caller), &blob.sha256).expect("staged");
            assert!(
                staged_blob(source_roots, &caller_key(&member("mallory")), &blob.sha256).is_none()
            );
            let on_disk = std::fs::read(&staged).unwrap();
            assert!(
                on_disk.starts_with(SEALED_BLOB_MAGIC),
                "staged in the clear"
            );
            let bytes = read_blob(&staged, &blob.sha256).unwrap();
            store_blob(destination_roots, &blob.sha256, &bytes).unwrap();
        }
    }

    #[tokio::test]
    async fn handoff_round_trip_is_idempotent_and_stamps_the_destination() {
        crate::crypto_host::install();
        let temp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(temp.path()).unwrap();
        let source_state = crate::server::isolated_plugin_hook_test_state(&base.join("s"));
        let destination_state = crate::server::isolated_plugin_hook_test_state(&base.join("d"));
        let source_roots = roots(&base.join("source"));
        let destination_roots = roots(&base.join("destination"));
        std::fs::create_dir_all(&destination_roots.home).unwrap();
        let source = source_repo(&base);
        let id = "conversation-handoff-1";
        source_state
            .conversations
            .ensure_sync_conversation(id, None, Some("Thread"), 1, 2, Tenancy::Unattributed)
            .await
            .unwrap();
        source_state
            .conversations
            .set_run_metadata(id, Some(source.to_str().unwrap()), Some("main"), None)
            .await
            .unwrap();

        let inspection = inspect_inner(&source_state, &None, id).await.unwrap();
        assert_eq!(inspection.repo.remote_url, None);
        assert!(inspection
            .untracked_candidates
            .iter()
            .any(|candidate| candidate.path == ".env" && candidate.sensitive));

        let summary = source_state
            .conversations
            .get_summary(id)
            .await
            .unwrap()
            .unwrap();
        let manifest = export_inner(
            &source_state,
            &None,
            id,
            RnpWorkspaceExportRequestV0 {
                version: 0,
                if_updated_at: Some(summary.updated_at),
                if_head: inspection.repo.base_commit.clone(),
                include_untracked: vec!["notes.txt".to_owned()],
            },
            &source_roots,
        )
        .await
        .unwrap();
        assert!(manifest.commits.as_ref().unwrap().prerequisites.is_empty());
        assert!(manifest.omitted.iter().any(|o| o.path == ".env"));

        // The destination refuses a resume before the blobs arrive.
        destination_state
            .conversations
            .ensure_sync_conversation(id, None, Some("Thread"), 1, 2, Tenancy::Unattributed)
            .await
            .unwrap();
        let request = |manifest: &RnpWorkspaceManifestV0| RnpWorkspaceResumeRequestV0 {
            version: 0,
            manifest: manifest.clone(),
            destination: RnpWorkspaceDestinationV0::NewClone { folder_name: None },
        };
        let missing = resume_inner(
            &destination_state,
            &None,
            id,
            request(&manifest),
            &destination_roots,
        )
        .await
        .unwrap_err();
        assert_eq!(missing.status(), StatusCode::CONFLICT);

        // A node that only staged a blob for its own export (a hand-back of
        // the same unchanged work) must not report it as present, or the
        // relay would skip the upload and resume would fail with 409.
        for blob in [
            &manifest.commits.as_ref().unwrap().blob,
            &manifest.diff.as_ref().unwrap().blob,
        ] {
            assert!(staged_blob(&source_roots, &None, &blob.sha256).is_some());
            assert!(!received_blob_present(&source_roots, &blob.sha256));
            assert!(received_blob(&source_roots, blob).is_err());
        }

        // v1 resumes into a new clone only; an existing checkout would let the
        // worktree inherit that checkout's workspace trust.
        let existing = resume_inner(
            &destination_state,
            &None,
            id,
            RnpWorkspaceResumeRequestV0 {
                version: 0,
                manifest: manifest.clone(),
                destination: RnpWorkspaceDestinationV0::ExistingCheckout {
                    checkout_path: source.to_string_lossy().into_owned(),
                },
            },
            &destination_roots,
        )
        .await
        .unwrap_err();
        assert_eq!(existing.status(), StatusCode::UNPROCESSABLE_ENTITY);

        relay(&source_roots, &destination_roots, &None, &manifest).await;
        for blob in [
            &manifest.commits.as_ref().unwrap().blob,
            &manifest.diff.as_ref().unwrap().blob,
        ] {
            assert!(received_blob_present(&destination_roots, &blob.sha256));
        }
        let first = resume_inner(
            &destination_state,
            &None,
            id,
            request(&manifest),
            &destination_roots,
        )
        .await
        .unwrap();
        assert_eq!(first.status, "created");
        assert_eq!(first.warnings, vec!["workspace-untrusted".to_owned()]);
        assert!(first.branch.starts_with("handoff/"));
        let worktree = PathBuf::from(&first.worktree_path);
        assert_eq!(
            std::fs::read_to_string(worktree.join("README.md")).unwrap(),
            "one\ntwo\n"
        );
        assert_eq!(
            std::fs::read_to_string(worktree.join("notes.txt")).unwrap(),
            "carry me\n"
        );
        assert!(!worktree.join(".env").exists());
        assert!(handoff::is_handoff_worktree(&worktree));

        let stamped = destination_state
            .conversations
            .get_summary(id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            stamped.folder_path.as_deref(),
            Some(first.worktree_path.as_str())
        );
        assert_eq!(
            stamped.worktree_path.as_deref(),
            Some(first.worktree_path.as_str())
        );
        assert_eq!(stamped.branch.as_deref(), Some(first.branch.as_str()));

        let replay = resume_inner(
            &destination_state,
            &None,
            id,
            request(&manifest),
            &destination_roots,
        )
        .await
        .unwrap();
        assert_eq!(replay.status, "unchanged");
        assert_eq!(replay.worktree_path, first.worktree_path);
        assert_eq!(replay.folder_path, first.folder_path);

        // The source is untouched.
        assert_eq!(
            std::fs::read_to_string(source.join(".env")).unwrap(),
            "SECRET=1\n"
        );
        assert_eq!(
            git(&source, &["status", "--porcelain=v1"]).lines().count(),
            3
        );
    }

    #[tokio::test]
    async fn access_is_enforced_and_running_turns_are_refused() {
        crate::crypto_host::install();
        let temp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(temp.path()).unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(&base.join("s"));
        let roots = roots(&base);
        let source = source_repo(&base);
        let id = "conversation-private";
        state
            .conversations
            .ensure_sync_conversation(id, None, Some("Private"), 1, 2, owned("alice"))
            .await
            .unwrap();
        state
            .conversations
            .set_run_metadata(id, Some(source.to_str().unwrap()), None, None)
            .await
            .unwrap();
        let bob = member("bob");
        let alice = member("alice");

        assert_eq!(
            inspect_inner(&state, &bob, id).await.unwrap_err().status(),
            StatusCode::FORBIDDEN
        );
        let head = inspect_inner(&state, &alice, id)
            .await
            .unwrap()
            .repo
            .base_commit;
        let export = |caller: Option<VerifiedCaller>| {
            let state = state.clone();
            let roots = roots.clone();
            let head = head.clone();
            async move {
                export_inner(
                    &state,
                    &caller,
                    id,
                    RnpWorkspaceExportRequestV0 {
                        version: 0,
                        if_updated_at: None,
                        if_head: head,
                        include_untracked: Vec::new(),
                    },
                    &roots,
                )
                .await
            }
        };
        assert_eq!(
            export(bob.clone()).await.unwrap_err().status(),
            StatusCode::FORBIDDEN
        );
        let manifest = export(alice.clone()).await.unwrap();
        let resume = resume_inner(
            &state,
            &bob,
            id,
            RnpWorkspaceResumeRequestV0 {
                version: 0,
                manifest,
                destination: RnpWorkspaceDestinationV0::NewClone { folder_name: None },
            },
            &roots,
        )
        .await
        .unwrap_err();
        assert_eq!(resume.status(), StatusCode::FORBIDDEN);

        let record = RnpContinuedOnV0 {
            node_label: "Mac".to_owned(),
            bundle_id: Some("bundle-1".to_owned()),
            workspace_id: None,
            at: 5,
        };
        assert_eq!(
            set_continued_inner(&state, &bob, id, Some(record.clone()))
                .await
                .unwrap_err()
                .status(),
            StatusCode::FORBIDDEN
        );
        set_continued_inner(&state, &alice, id, Some(record))
            .await
            .unwrap();
        let marked = state.conversations.get_summary(id).await.unwrap().unwrap();
        assert_eq!(marked.continued_on.unwrap()["nodeLabel"], "Mac");
        set_continued_inner(&state, &alice, id, None).await.unwrap();
        assert!(state
            .conversations
            .get_summary(id)
            .await
            .unwrap()
            .unwrap()
            .continued_on
            .is_none());

        state
            .conversations
            .set_run_status(id, "running")
            .await
            .unwrap();
        let running = inspect_inner(&state, &alice, id).await.unwrap_err();
        assert_eq!(running.status(), StatusCode::CONFLICT);
        assert_eq!(
            export(alice).await.unwrap_err().status(),
            StatusCode::CONFLICT
        );
    }

    async fn body_bytes(response: Response) -> Vec<u8> {
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }

    #[tokio::test]
    async fn staged_blobs_are_served_by_digest_only_to_their_exporter() {
        crate::crypto_host::install();
        let temp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(temp.path()).unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(&base.join("s"));
        let roots = roots(&base);
        let source = source_repo(&base);
        let id = "conversation-blobs";
        state
            .conversations
            .ensure_sync_conversation(id, None, Some("Blobs"), 1, 2, owned("alice"))
            .await
            .unwrap();
        state
            .conversations
            .set_run_metadata(id, Some(source.to_str().unwrap()), None, None)
            .await
            .unwrap();
        let alice = member("alice");
        let head = inspect_inner(&state, &alice, id)
            .await
            .unwrap()
            .repo
            .base_commit;
        let manifest = export_inner(
            &state,
            &alice,
            id,
            RnpWorkspaceExportRequestV0 {
                version: 0,
                if_updated_at: None,
                if_head: head,
                include_untracked: vec!["notes.txt".to_owned()],
            },
            &roots,
        )
        .await
        .unwrap();
        let diff = manifest.diff.as_ref().expect("the export stages a diff");

        // The exporter downloads the plaintext blob, which hashes to its digest.
        let served = read_staged_blob(&roots, &alice, diff.blob.sha256.clone()).await;
        assert_eq!(served.status(), StatusCode::OK);
        assert_eq!(
            served.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        let bytes = body_bytes(served).await;
        assert_eq!(sha256_hex(&bytes), diff.blob.sha256);
        assert!(String::from_utf8_lossy(&bytes).contains("README.md"));

        // Another caller, and an unknown digest, get a 404 and no bytes.
        let other = read_staged_blob(&roots, &member("bob"), diff.blob.sha256.clone()).await;
        assert_eq!(other.status(), StatusCode::NOT_FOUND);
        let other: serde_json::Value = serde_json::from_slice(&body_bytes(other).await).unwrap();
        assert_eq!(other["code"], "blob-missing");
        let unknown = read_staged_blob(&roots, &alice, sha256_hex(b"never staged")).await;
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

        // A malformed digest is a 400, before any lookup.
        for bad in [
            "not-a-digest",
            &diff.blob.sha256[..40],
            &diff.blob.sha256.to_uppercase(),
        ] {
            let response = read_staged_blob(&roots, &alice, bad.to_owned()).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{bad}");
        }
        let response = get_blob(Extension(alice.clone()), Path("../../etc".to_owned())).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
