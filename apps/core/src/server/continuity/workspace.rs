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

mod blob_routes;
mod errors;
mod export;
mod prepare;
mod resume;
mod routes;
mod storage;
mod validation;

#[cfg(test)]
mod tests;

use self::{errors::*, prepare::*, routes::*, storage::*, validation::*};

pub(crate) use blob_routes::{
    __path_get_blob, __path_head_blob, __path_put_blob, get_blob, head_blob, put_blob,
};
pub(crate) use export::{
    __path_export_workspace, __path_inspect_workspace, export_workspace, inspect_workspace,
};
pub(crate) use resume::{
    __path_clear_continued, __path_mark_continued, __path_resume_workspace, clear_continued,
    mark_continued, resume_workspace,
};
pub(crate) use routes::__path_capabilities;
pub(super) use routes::router;
