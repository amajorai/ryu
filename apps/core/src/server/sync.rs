//! Cross-device conversation sync client (spec unit U108 / #222).
//!
//! Connects a local [`ConversationStore`] to the account backend's store
//! (`POST /api/conversations-sync/push`, `GET /api/conversations-sync/pull`).
//!
//! **Read path:** the background loop prefers the live SSE change feed
//! (`GET /api/conversations-sync/stream`), applying each delta as it arrives,
//! and falls back to the `GET .../pull` long-poll when streaming is
//! unavailable (old server, a proxy that strips streaming, transient error).
//!
//! **Conflict rule:** last-writer-wins on conversation metadata by
//! `updated_at`; messages are union-merged by their stable UUID `id`
//! (append-only — merge-by-id is always an additive insert).
//!
//! **Auth:** reuses the token stored at `~/.ryu/auth.json` by the existing
//! device-auth flow (`crate::auth::load_token`). No new secret file; if no
//! token is present the client returns [`SyncError::Unauthenticated`].
//!
//! **Nothing hardcoded:** the server base URL is `RYU_SERVER_URL`, else the
//! backend the last device sign-in used (https only). With neither the loop
//! sends nothing; see [`backend`].
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): conversation state is
//! *what runs* (orchestration), so the sync client belongs in Core.

use std::collections::HashSet;
use std::fmt;
use std::time::Duration;

use anyhow::Result;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::conversations::{ConversationStore, SyncLink, SyncParent, Tenancy};

/// Errors specific to the sync client.
#[derive(Debug)]
pub enum SyncError {
    Unauthenticated,
    ServerError(u16, String),
    Http(reqwest::Error),
    Store(anyhow::Error),
    /// No usable account backend; no client is built and nothing is sent.
    Backend(backend::BackendError),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::Unauthenticated => {
                write!(f, "no auth token found — complete device login first")
            }
            SyncError::ServerError(status, body) => {
                write!(f, "server returned {status}: {body}")
            }
            SyncError::Http(e) => write!(f, "http error: {e}"),
            SyncError::Store(e) => write!(f, "store error: {e}"),
            SyncError::Backend(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<reqwest::Error> for SyncError {
    fn from(e: reqwest::Error) -> Self {
        SyncError::Http(e)
    }
}

/// Wire format shared between Core (Rust) and the `:3000` sync router.
/// Mirrors `ConversationSummary + Vec<StoredMessage>` from `conversations.rs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPayload {
    pub conversation_id: String,
    pub title: Option<String>,
    pub agent_id: Option<String>,
    pub folder_path: Option<String>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub run_status: Option<String>,
    /// The ORIGINAL author of this conversation, carried from the source node so a
    /// replay lands owned by the person who wrote it — never the device that pulled
    /// it. `None` for a row created on an unbound personal node (NULL-tenanted at
    /// source); on a bound node a replay with no author here is REFUSED rather than
    /// mis-attributed (see [`effective_replay_tenancy`]). `#[serde(default,
    /// skip_serializing_if)]` keeps the wire bytes byte-identical for the unbound
    /// (author-less) push, and lets an older server that drops the field degrade to
    /// the safe fail-closed path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds — LWW key.
    pub updated_at: i64,
    pub messages: Vec<SyncMessage>,
}

/// A single message inside a [`SyncPayload`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// The message this one replies to in the source's version tree. Sent only
    /// by a source whose conversation is branched (non-NULL leaf); a flat source
    /// and an older peer omit it, and the receiver then appends the row to its
    /// own thread. `skip_serializing_if` keeps a flat push byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
    /// Set by a branched source on a row with no parent: a genuine root of its
    /// version tree (a first turn, or an edited first turn). The relay merges
    /// rows from every device, so a parentless row without this mark (a flat
    /// source's or an older peer's) is never read as a root. Omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub version_root: bool,
}

/// Stable-id LWW snapshot for a Spaces document. The Space metadata rides with
/// every document so a receiving node can recreate the collection first.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSyncPayload {
    pub document_id: String,
    pub title: String,
    pub source: String,
    pub kind: String,
    pub parent_id: Option<String>,
    pub icon: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<String>,
    pub space: ryu_spaces::SpaceSyncRecord,
}

/// HTTP client that pushes and pulls conversation payloads.
#[derive(Clone)]
pub struct SyncClient {
    server_url: String,
    token: String,
    http: Client,
}

const MAX_SYNC_PAGES: usize = 10_000;

#[derive(Debug, Deserialize)]
struct DocumentPullPage {
    documents: Vec<DocumentSyncPayload>,
    #[serde(rename = "nextCursor", alias = "next_cursor", default)]
    next_cursor: Option<String>,
    #[serde(rename = "snapshotAt", alias = "snapshot_at", default)]
    snapshot_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ConversationPullPage {
    conversations: Vec<SyncPayload>,
    #[serde(rename = "nextCursor", alias = "next_cursor", default)]
    next_cursor: Option<String>,
    #[serde(rename = "snapshotAt", alias = "snapshot_at", default)]
    snapshot_at: Option<i64>,
}

#[derive(Debug, Default, Clone, Copy)]
struct SyncPullOutcome {
    applied: usize,
    snapshot_at: Option<i64>,
}

#[derive(Debug, Default, Clone, Copy)]
struct SyncStreamOutcome {
    snapshot_at: Option<i64>,
}

fn record_pull_snapshot(
    outcome: &mut SyncPullOutcome,
    snapshot_at: Option<i64>,
    requires_snapshot: bool,
) -> Result<(), SyncError> {
    match snapshot_at {
        Some(snapshot_at) if snapshot_at >= 0 => {
            if let Some(previous) = outcome.snapshot_at {
                if previous != snapshot_at {
                    return Err(SyncError::ServerError(
                        502,
                        "sync server changed snapshot while paging".to_owned(),
                    ));
                }
            } else {
                outcome.snapshot_at = Some(snapshot_at);
            }
            Ok(())
        }
        Some(_) => Err(SyncError::ServerError(
            502,
            "sync server returned an invalid snapshotAt".to_owned(),
        )),
        None if requires_snapshot => Err(SyncError::ServerError(
            502,
            "sync server omitted snapshotAt for paginated response".to_owned(),
        )),
        None => Ok(()),
    }
}

pub(crate) mod backend;
mod client;
mod payloads;
mod sync_loop;

use client::*;
pub use payloads::*;
pub use sync_loop::*;

#[cfg(test)]
mod tests;
