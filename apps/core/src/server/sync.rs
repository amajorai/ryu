//! Cross-device conversation sync client (spec unit U108 / #222).
//!
//! Connects a local [`ConversationStore`] to the `:3000` server-side store
//! (`POST /api/conversations-sync/push`, `GET /api/conversations-sync/pull`).
//!
//! **Conflict rule:** last-writer-wins on conversation metadata by
//! `updated_at`; messages are union-merged by their stable UUID `id`
//! (append-only — merge-by-id is always an additive insert).
//!
//! **Auth:** reuses the token stored at `~/.ryu/auth.json` by the existing
//! device-auth flow (`crate::auth::load_token`). No new secret file; if no
//! token is present the client returns [`SyncError::Unauthenticated`].
//!
//! **Nothing hardcoded:** the server base URL is read from the
//! `RYU_SERVER_URL` environment variable, falling back to `http://localhost:3000`.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): conversation state is
//! *what runs* (orchestration), so the sync client belongs in Core.

use std::fmt;
use std::time::Duration;

use anyhow::Result;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::conversations::ConversationStore;

/// Errors specific to the sync client.
#[derive(Debug)]
pub enum SyncError {
    Unauthenticated,
    ServerError(u16, String),
    Http(reqwest::Error),
    Store(anyhow::Error),
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
}

/// HTTP client that pushes and pulls conversation payloads.
#[derive(Clone)]
pub struct SyncClient {
    server_url: String,
    token: String,
    http: Client,
}

impl SyncClient {
    /// Build a sync client from the environment.
    ///
    /// `server_url` - resolved from `RYU_SERVER_URL`, defaults to
    ///   `http://localhost:3000`.
    /// `token` - loaded via [`crate::auth::load_token`].
    ///
    /// Returns [`SyncError::Unauthenticated`] when no token is stored.
    pub fn from_env() -> Result<Self, SyncError> {
        let server_url =
            std::env::var("RYU_SERVER_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
        let token = crate::auth::load_token().ok_or(SyncError::Unauthenticated)?;
        Ok(Self::new(server_url, token))
    }

    /// Build a sync client with explicit values (used in tests / integration).
    pub fn new(server_url: impl Into<String>, token: impl Into<String>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("building reqwest client");
        Self {
            server_url: server_url.into().trim_end_matches('/').to_string(),
            token: token.into(),
            http,
        }
    }

    /// Push one conversation (all messages) to the server store.
    pub async fn push(
        &self,
        store: &ConversationStore,
        conversation_id: &str,
    ) -> Result<(), SyncError> {
        let payload = build_sync_payload(store, conversation_id)
            .await
            .map_err(SyncError::Store)?;

        let url = format!("{}/api/conversations-sync/push", self.server_url);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.token)
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::ServerError(status, body));
        }
        Ok(())
    }

    /// Pull all conversations updated at or after `since_ms` and apply them
    /// to the local store.  Pass `0` for a full sync.
    ///
    /// Returns the number of conversations applied.
    pub async fn pull_since(
        &self,
        store: &ConversationStore,
        since_ms: i64,
    ) -> Result<usize, SyncError> {
        let url = format!(
            "{}/api/conversations-sync/pull?since={}",
            self.server_url, since_ms
        );
        let resp = self.http.get(&url).bearer_auth(&self.token).send().await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::ServerError(status, body));
        }

        #[derive(Deserialize)]
        struct PullResponse {
            conversations: Vec<SyncPayload>,
        }
        let data: PullResponse = resp.json().await?;
        let count = data.conversations.len();
        for payload in data.conversations {
            apply_sync_payload(store, &payload)
                .await
                .map_err(SyncError::Store)?;
        }
        Ok(count)
    }
}

// ── Background sync loop (opt-in, off by default) ─────────────────────────────

/// Preferences-KV key for the opt-in sync toggle. Mirrors the
/// `claude_config::CLAUDE_GATEWAY_ROUTING_PREF_KEY` pattern: a value of
/// `"true"` enables the background sync loop. Absent / any other value keeps it
/// off (local-first rule: Core never phones home by default).
pub const SYNC_ENABLED_PREF_KEY: &str = "cloud-sync-enabled";

/// Environment variable that also enables the sync loop (truthy = `1`/`true`).
/// Either the env var OR the persisted pref turns sync on; default is OFF.
pub const SYNC_ENABLED_ENV: &str = "RYU_SYNC_ENABLED";

/// How often the loop pushes local conversations + pulls remote changes.
const SYNC_INTERVAL: Duration = Duration::from_secs(60);

/// True when the `RYU_SYNC_ENABLED` env var is set to a truthy value.
fn env_sync_enabled() -> bool {
    matches!(
        std::env::var(SYNC_ENABLED_ENV).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes")
    )
}

/// Resolve whether sync is currently enabled. The env var is a static gate; the
/// pref is re-read each tick so a desktop toggle takes effect without a restart.
async fn sync_enabled(preferences: &super::preferences::PreferencesStore) -> bool {
    if env_sync_enabled() {
        return true;
    }
    matches!(
        preferences
            .get(SYNC_ENABLED_PREF_KEY)
            .await
            .ok()
            .flatten()
            .as_deref(),
        Some("true")
    )
}

/// Spawn the opt-in cross-device sync loop. Returns immediately. The loop is a
/// no-op every tick until the user opts in (env `RYU_SYNC_ENABLED` or the
/// `cloud-sync-enabled` pref), so this is safe to call unconditionally at
/// startup and never alters default (local-first) behaviour.
///
/// Each enabled tick: push every local conversation to the server store, then
/// pull everything updated since the last successful pull (last-writer-wins +
/// union-merge, applied by [`apply_sync_payload`]). All errors are best-effort:
/// logged and swallowed so a flaky network or a signed-out user never panics or
/// stalls Core.
pub fn spawn_sync_loop(
    conversations: ConversationStore,
    preferences: super::preferences::PreferencesStore,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SYNC_INTERVAL);
        // Loop-local watermark: 0 = full sync on the first enabled pull, then
        // advanced to "now" after each success. Kept in memory only: no new
        // persistence path, so a restart simply does one extra full pull.
        let mut pull_since_ms: i64 = 0;
        // Throttle the "no token" warning so a signed-out user with sync on does
        // not spam the log every tick.
        let mut warned_unauthenticated = false;

        loop {
            interval.tick().await;

            if !sync_enabled(&preferences).await {
                continue;
            }

            let client = match SyncClient::from_env() {
                Ok(client) => {
                    warned_unauthenticated = false;
                    client
                }
                Err(SyncError::Unauthenticated) => {
                    if !warned_unauthenticated {
                        tracing::info!(
                            "cloud sync enabled but no auth token found; complete device login to sync"
                        );
                        warned_unauthenticated = true;
                    }
                    continue;
                }
                Err(e) => {
                    tracing::warn!("cloud sync: failed to build client: {e}");
                    continue;
                }
            };

            // Push every local conversation (best-effort, per-conversation).
            match conversations.list_conversations().await {
                Ok(summaries) => {
                    for summary in &summaries {
                        if let Err(e) = client.push(&conversations, &summary.id).await {
                            tracing::warn!(
                                "cloud sync: push of conversation {} failed: {e}",
                                summary.id
                            );
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("cloud sync: listing local conversations failed: {e}");
                }
            }

            // Pull remote changes since the last successful pull.
            let now_ms = chrono::Utc::now().timestamp_millis();
            match client.pull_since(&conversations, pull_since_ms).await {
                Ok(count) => {
                    if count > 0 {
                        tracing::info!("cloud sync: pulled {count} conversation(s)");
                    }
                    pull_since_ms = now_ms;
                }
                Err(e) => {
                    tracing::warn!("cloud sync: pull failed: {e}");
                }
            }
        }
    });
}

// ── Pure helpers (no HTTP — tested independently) ────────────────────────────

/// Serialize a conversation from `store` into a [`SyncPayload`].
///
/// This is the "export" half of the round-trip that [`apply_sync_payload`]
/// ingests.  Both halves are tested together in [`tests::round_trip`].
pub async fn build_sync_payload(
    store: &ConversationStore,
    conversation_id: &str,
) -> Result<SyncPayload> {
    let summaries = store.list_conversations().await?;
    let summary = summaries
        .iter()
        .find(|s| s.id == conversation_id)
        .ok_or_else(|| anyhow::anyhow!("conversation {} not found in store", conversation_id))?
        .clone();

    let stored_messages = store.get_messages(conversation_id).await?;

    let messages = stored_messages
        .into_iter()
        .map(|m| SyncMessage {
            id: m.id,
            role: m.role,
            content: m.content,
            created_at: m.created_at,
        })
        .collect();

    Ok(SyncPayload {
        conversation_id: summary.id,
        title: summary.title,
        agent_id: summary.agent_id,
        folder_path: summary.folder_path,
        branch: summary.branch,
        worktree_path: summary.worktree_path,
        run_status: summary.run_status,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
        messages,
    })
}

/// Apply a [`SyncPayload`] to a local store.
///
/// Conflict rule:
/// - Conversation row: upserted on first apply; on subsequent applies,
///   metadata is only overwritten when the incoming `updated_at` is strictly
///   newer than the stored value (last-writer-wins).
/// - Messages: union-merged by `id` — messages absent from the local store
///   are inserted; messages already present are left unchanged (append-only).
pub async fn apply_sync_payload(store: &ConversationStore, payload: &SyncPayload) -> Result<()> {
    // Ensure the conversation row exists (creates it with initial metadata if
    // this is the first time we see this conversation on this device).
    store
        .ensure_conversation(
            &payload.conversation_id,
            payload.agent_id.as_deref(),
            payload.title.as_deref(),
        )
        .await?;

    // LWW: update metadata only when the incoming timestamp beats stored one.
    store
        .update_metadata_if_newer(
            &payload.conversation_id,
            payload.title.as_deref(),
            payload.agent_id.as_deref(),
            payload.folder_path.as_deref(),
            payload.branch.as_deref(),
            payload.worktree_path.as_deref(),
            payload.run_status.as_deref(),
            payload.updated_at,
        )
        .await?;

    // Union-merge messages: fetch existing ids, then insert only new ones.
    let existing = store.get_messages(&payload.conversation_id).await?;
    let existing_ids: std::collections::HashSet<&str> =
        existing.iter().map(|m| m.id.as_str()).collect();

    for msg in &payload.messages {
        if !existing_ids.contains(msg.id.as_str()) {
            store
                .append_message_with_id(
                    &payload.conversation_id,
                    &msg.id,
                    &msg.role,
                    &msg.content,
                    payload.agent_id.as_deref(),
                    msg.created_at,
                )
                .await?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::conversations::ConversationStore;

    /// Proves "two DBs, one synced conversation" (AC2):
    /// - store_a gets messages appended,
    /// - a payload is built from store_a,
    /// - the payload is applied to store_b,
    /// - store_b now has identical messages.
    #[tokio::test]
    async fn round_trip_two_stores() {
        let store_a = ConversationStore::open_in_memory().unwrap();
        let store_b = ConversationStore::open_in_memory().unwrap();

        store_a
            .append_message("conv-sync-1", "user", "hello from A", Some("agent-1"))
            .await
            .unwrap();
        store_a
            .append_message("conv-sync-1", "assistant", "hi back", Some("agent-1"))
            .await
            .unwrap();

        // Export from A.
        let payload = build_sync_payload(&store_a, "conv-sync-1").await.unwrap();

        assert_eq!(payload.conversation_id, "conv-sync-1");
        assert_eq!(payload.messages.len(), 2);

        // Apply to B — this is "device B receiving the sync payload".
        apply_sync_payload(&store_b, &payload).await.unwrap();

        let msgs_a = store_a.get_messages("conv-sync-1").await.unwrap();
        let msgs_b = store_b.get_messages("conv-sync-1").await.unwrap();

        assert_eq!(msgs_a.len(), msgs_b.len(), "message counts must match");
        for (a, b) in msgs_a.iter().zip(msgs_b.iter()) {
            assert_eq!(a.role, b.role);
            assert_eq!(a.content, b.content);
        }

        let list_b = store_b.list_conversations().await.unwrap();
        assert_eq!(list_b.len(), 1);
        assert_eq!(list_b[0].id, "conv-sync-1");
    }

    /// Union-merge: applying the same payload twice must not duplicate messages.
    #[tokio::test]
    async fn idempotent_apply() {
        let store_a = ConversationStore::open_in_memory().unwrap();
        let store_b = ConversationStore::open_in_memory().unwrap();

        store_a
            .append_message("conv-idem", "user", "msg1", None)
            .await
            .unwrap();

        let payload = build_sync_payload(&store_a, "conv-idem").await.unwrap();

        apply_sync_payload(&store_b, &payload).await.unwrap();
        apply_sync_payload(&store_b, &payload).await.unwrap();

        let msgs = store_b.get_messages("conv-idem").await.unwrap();
        assert_eq!(
            msgs.len(),
            1,
            "idempotent apply must not duplicate messages"
        );
    }

    /// LWW: a subsequent apply with an older `updated_at` must not clobber
    /// newer metadata already in the store.
    #[tokio::test]
    async fn lww_metadata_newer_wins() {
        let store_b = ConversationStore::open_in_memory().unwrap();

        // Construct payloads manually with controlled timestamps so the test
        // is deterministic regardless of wall-clock ordering.
        let base_ts: i64 = 1_700_000_000_000;

        // "Fresh" payload has a higher updated_at.
        let fresh = SyncPayload {
            conversation_id: "conv-lww".to_string(),
            title: Some("fresh title".to_string()),
            agent_id: Some("agent-1".to_string()),
            folder_path: None,
            branch: None,
            worktree_path: None,
            run_status: None,
            created_at: base_ts,
            updated_at: base_ts + 2000,
            messages: vec![SyncMessage {
                id: "msg-1".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                created_at: base_ts,
            }],
        };

        // "Stale" payload has a lower updated_at.
        let stale = SyncPayload {
            conversation_id: "conv-lww".to_string(),
            title: Some("stale title".to_string()),
            agent_id: Some("agent-1".to_string()),
            folder_path: None,
            branch: None,
            worktree_path: None,
            run_status: None,
            created_at: base_ts,
            updated_at: base_ts + 1000,
            messages: vec![SyncMessage {
                id: "msg-1".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                created_at: base_ts,
            }],
        };

        // Apply fresh first, then stale — stale must not overwrite.
        apply_sync_payload(&store_b, &fresh).await.unwrap();
        apply_sync_payload(&store_b, &stale).await.unwrap();

        let summaries = store_b.list_conversations().await.unwrap();
        let title = summaries[0].title.as_deref().unwrap_or("");
        assert_eq!(
            title, "fresh title",
            "LWW: stale payload must not overwrite newer title"
        );
    }

    /// Incremental push: new messages from a second device are merged in.
    #[tokio::test]
    async fn incremental_merge_new_messages() {
        let store_a = ConversationStore::open_in_memory().unwrap();
        let store_b = ConversationStore::open_in_memory().unwrap();

        store_a
            .append_message("conv-incr", "user", "first", None)
            .await
            .unwrap();

        let p1 = build_sync_payload(&store_a, "conv-incr").await.unwrap();
        apply_sync_payload(&store_b, &p1).await.unwrap();

        // A second message added after the first sync.
        store_a
            .append_message("conv-incr", "assistant", "second", None)
            .await
            .unwrap();

        let p2 = build_sync_payload(&store_a, "conv-incr").await.unwrap();
        apply_sync_payload(&store_b, &p2).await.unwrap();

        let msgs = store_b.get_messages("conv-incr").await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content, "first");
        assert_eq!(msgs[1].content, "second");
    }
}
