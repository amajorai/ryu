//! Ryu-canonical import/export state for external agent roots.
//!
//! This module deliberately keeps the sync ledger separate from the conversation
//! database.  A sync retry can therefore reconcile setup files and ACP metadata
//! without changing conversation rows, and a crash between a projection write and
//! the ledger update is recoverable by comparing the content hash again.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};

use anyhow::{bail, Context, Result};
use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::{import::ImportSelection, server::ServerState};

const BUNDLE_FILE_NAME: &str = ".ryu-agent-sync.json";
const BUNDLE_FORMAT: &str = "ryu-agent-sync";
const BUNDLE_VERSION: u32 = 1;
const MAX_HASH_BYTES: u64 = 32 * 1024 * 1024;
const MAX_HASH_ENTRIES: usize = 2_000;
const MAX_HASH_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_IMPORT_SELECTIONS: usize = 256;

/// A configured external root. Import and export are independent opt-in bits.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfile {
    pub id: String,
    pub provider: String,
    pub root: String,
    pub import_enabled: bool,
    pub export_enabled: bool,
    /// Whether the automatic export writes conversation transcripts into the
    /// bundle. Off by default: the bundle is plaintext outside the data folder.
    #[serde(default)]
    pub include_conversations: bool,
    pub status: String,
    pub conflict_count: u64,
    pub last_operation_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub profiles: Vec<SyncProfile>,
    pub bindings: Vec<AcpBinding>,
    pub items: Vec<SyncItemStatus>,
    pub active_operations: usize,
    pub node_id: String,
}

/// The durable record used to suppress generated-output re-imports and to make
/// retries converge after a process crash.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItemStatus {
    pub profile_id: String,
    pub kind: String,
    pub source_id: String,
    pub source_hash: Option<String>,
    pub generated_hash: Option<String>,
    pub revision: i64,
    pub operation_id: Option<String>,
    pub state: String,
    pub conflict: Option<Value>,
    pub updated_at: i64,
}

/// ACP state belongs to a conversation *and* a node. A session id is not safe to
/// reuse on another device, even when an agent happens to use globally unique ids.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpBinding {
    pub node_id: String,
    pub conversation_id: String,
    pub agent_id: String,
    pub engine: String,
    pub native_session_id: String,
    pub working_directory: Option<String>,
    pub capabilities: Value,
    pub updated_at: i64,
    pub conversation_generation: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCapabilities {
    pub setup_import: bool,
    pub native_threads: bool,
    pub acp_load_resume: Option<bool>,
    pub portable_bundle: bool,
    pub native_conversation_export: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScan {
    pub agent_id: Option<String>,
    pub root: String,
    pub provider: String,
    pub items: Vec<crate::import::ScanItem>,
    pub threads: Vec<crate::native_history::NativeThread>,
    pub warnings: Vec<String>,
    pub capabilities: SyncCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncImportResult {
    pub profile_id: String,
    pub operation_id: String,
    pub dry_run: bool,
    pub results: Vec<crate::import::ImportOutcome>,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub conflicts: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncExportResult {
    pub profile_id: Option<String>,
    pub operation_id: String,
    pub dry_run: bool,
    pub destination: String,
    pub bundle_path: String,
    pub bundle_hash: String,
    pub agents: usize,
    pub skills: usize,
    pub conversations: usize,
    pub messages: usize,
    pub projected_files: usize,
    pub conflicts: usize,
    pub warnings: Vec<String>,
    pub acp_resume: Vec<AcpResumeStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpResumeStatus {
    pub conversation_id: String,
    pub agent_id: Option<String>,
    pub mode: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpResumeResponse {
    conversation_id: String,
    agent_id: Option<String>,
    native_session_id: Option<String>,
    mode: String,
    reason: String,
    response: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileInput {
    id: Option<String>,
    provider: String,
    root: String,
    #[serde(default)]
    import_enabled: bool,
    #[serde(default)]
    export_enabled: bool,
    /// `None` keeps the stored choice (off for a new profile).
    #[serde(default)]
    include_conversations: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanInput {
    path: String,
    provider: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportInput {
    profile_id: String,
    path: Option<String>,
    items: Vec<ImportSelection>,
    #[serde(default)]
    dry_run: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportThreadInput {
    agent_id: String,
    thread_id: String,
    #[serde(default)]
    dry_run: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpResumeInput {
    conversation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportInput {
    profile_id: Option<String>,
    destination: String,
    #[serde(default)]
    dry_run: bool,
    #[serde(default = "default_true")]
    include_agents: bool,
    #[serde(default = "default_true")]
    include_skills: bool,
    /// Conversation transcripts are an explicit opt-in: the bundle is
    /// plaintext outside the data folder.
    #[serde(default)]
    include_conversations: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveConflictInput {
    profile_id: String,
    kind: String,
    item_id: String,
    resolution: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    format: &'static str,
    version: u32,
    operation_id: String,
    generated_by: &'static str,
    node_id: String,
    created_at: i64,
    agents: Vec<crate::agents::AgentTemplate>,
    skills: Vec<ryu_skills::SkillRecord>,
    conversations: Vec<BundleConversation>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleConversation {
    id: String,
    title: Option<String>,
    agent_id: Option<String>,
    created_at: i64,
    updated_at: i64,
    folder_path: Option<String>,
    branch: Option<String>,
    messages: Vec<crate::server::conversations::StoredMessage>,
}

#[derive(Clone)]
pub struct AgentSyncStore {
    conn: Arc<Mutex<Connection>>,
    active: Arc<Mutex<HashSet<String>>>,
    node_id: String,
}

static GLOBAL: OnceLock<AgentSyncStore> = OnceLock::new();

pub fn install_global(store: AgentSyncStore) {
    let _ = GLOBAL.set(store);
}

pub fn global_store() -> Option<AgentSyncStore> {
    GLOBAL.get().cloned()
}

/// Preserve a native-history session id as soon as a thread is imported. The
/// capability payload is intentionally conservative: native transcripts prove
/// identity, not ACP load support. A later ACP initialize/load probe can replace
/// it with the agent's actual capability record.
pub(crate) fn remember_native_session(
    conversation_id: &str,
    generation: &str,
    agent_id: &str,
    engine: &str,
    native_session_id: &str,
    working_directory: Option<&str>,
) {
    let Some(store) = global_store() else {
        return;
    };
    let working_directory = working_directory.map(Path::new);
    if let Err(error) = store.record_acp_binding(
        conversation_id,
        agent_id,
        engine,
        native_session_id,
        working_directory,
        &json!({ "source": "native-history" }),
        generation,
    ) {
        tracing::debug!("agent sync: native session binding skipped: {error:#}");
    }
}

pub fn local_node_id() -> String {
    std::env::var("RYU_NODE_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("local:{}", crate::paths::ryu_dir().display()))
}

impl AgentSyncStore {
    pub fn open_default() -> Result<Self> {
        Self::open(crate::paths::db_path("agent-sync.db"))
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating sync state directory {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening agent sync database {}", path.display()))?;
        // This connection ATTACHes conversations.db, which the conversation
        // store writes through its own connection; wait out a transient lock
        // instead of failing the sync read with SQLITE_BUSY.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        init_schema(&conn)?;
        attach_conversations(
            &conn,
            path.parent()
                .map(|parent| parent.join("conversations.db"))
                .as_deref(),
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            active: Arc::new(Mutex::new(HashSet::new())),
            node_id: local_node_id(),
        })
    }

    #[cfg(test)]
    fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory sync database")?;
        init_schema(&conn)?;
        attach_conversations(&conn, None)?;
        conn.execute("INSERT INTO conversation_state.conversation_generations VALUES ('conversation-1', 'test-generation')", [])?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            active: Arc::new(Mutex::new(HashSet::new())),
            node_id: "test-node".to_owned(),
        })
    }

    pub fn current_generation(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self
            .conn
            .try_lock()
            .map_err(|_| anyhow::anyhow!("sync database busy"))?;
        conn.query_row("SELECT generation FROM conversation_state.conversation_generations WHERE conversation_id = ?1", [conversation_id], |row| row.get(0)).optional().context("reading conversation generation")
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    async fn profiles(&self) -> Result<Vec<SyncProfile>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, provider, root, import_enabled, export_enabled, status,
                    conflict_count, last_operation_id, updated_at, include_conversations
             FROM sync_profiles ORDER BY provider, root",
        )?;
        let rows = stmt.query_map([], profile_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing sync profiles")
    }

    async fn profile(&self, id: &str) -> Result<Option<SyncProfile>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id, provider, root, import_enabled, export_enabled, status,
                    conflict_count, last_operation_id, updated_at, include_conversations
             FROM sync_profiles WHERE id = ?1",
            [id],
            profile_from_row,
        )
        .optional()
        .context("reading sync profile")
    }

    async fn profile_for_root(&self, root: &Path) -> Result<Option<SyncProfile>> {
        let root = root.to_string_lossy().to_string();
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id, provider, root, import_enabled, export_enabled, status,
                    conflict_count, last_operation_id, updated_at, include_conversations
             FROM sync_profiles WHERE root = ?1",
            [root],
            profile_from_row,
        )
        .optional()
        .context("reading sync profile for root")
    }

    async fn upsert_profile(&self, input: ProfileInput) -> Result<SyncProfile> {
        let provider = normalize_provider(&input.provider)?;
        let root = crate::import::canonicalize_root(&input.root)?;
        let root = root.to_string_lossy().to_string();
        let supplied_id = input.id.clone();
        let id = supplied_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("profile_{}", uuid::Uuid::new_v4()));
        let now = now_ms();
        let conn = self.conn.lock().await;
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT id, provider FROM sync_profiles WHERE root = ?1",
                [&root],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing_id, existing_provider)) = existing {
            if existing_id != id && input.id.is_some() {
                bail!("root is already configured by profile {existing_id}");
            }
            if existing_provider != provider && input.id.is_some() {
                bail!("root is already configured for provider {existing_provider}");
            }
            conn.execute(
                "UPDATE sync_profiles
                 SET provider = ?1, import_enabled = ?2, export_enabled = ?3,
                     updated_at = ?4,
                     include_conversations = COALESCE(?6, include_conversations)
                 WHERE id = ?5",
                params![
                    provider,
                    input.import_enabled as i64,
                    input.export_enabled as i64,
                    now,
                    existing_id,
                    input.include_conversations.map(i64::from)
                ],
            )?;
            drop(conn);
            return self
                .profile(&existing_id)
                .await?
                .context("updated sync profile disappeared");
        }
        conn.execute(
            "INSERT INTO sync_profiles
                (id, provider, root, import_enabled, export_enabled, status,
                 conflict_count, updated_at, include_conversations)
             VALUES (?1, ?2, ?3, ?4, ?5, 'idle', 0, ?6, ?7)",
            params![
                id,
                provider,
                root,
                input.import_enabled as i64,
                input.export_enabled as i64,
                now,
                i64::from(input.include_conversations.unwrap_or(false))
            ],
        )?;
        drop(conn);
        self.profile(&id)
            .await?
            .context("created sync profile disappeared")
    }

    async fn delete_profile(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let deleted = conn.execute("DELETE FROM sync_profiles WHERE id = ?1", [id])?;
        Ok(deleted != 0)
    }

    async fn try_start(&self, profile_id: &str) -> bool {
        self.active.lock().await.insert(profile_id.to_owned())
    }

    async fn finish(&self, profile_id: &str) {
        self.active.lock().await.remove(profile_id);
    }

    async fn active_count(&self) -> usize {
        self.active.lock().await.len()
    }

    async fn upsert_item(
        &self,
        profile_id: &str,
        kind: &str,
        source_id: &str,
        source_hash: Option<&str>,
        generated_hash: Option<&str>,
        operation_id: &str,
        state: &str,
        conflict: Option<&Value>,
    ) -> Result<()> {
        let conflict_json = conflict.map(serde_json::to_string).transpose()?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO sync_items
                (profile_id, kind, source_id, source_hash, generated_hash,
                 revision, operation_id, state, conflict_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9)
             ON CONFLICT(profile_id, kind, source_id) DO UPDATE SET
                source_hash = COALESCE(excluded.source_hash, sync_items.source_hash),
                generated_hash = COALESCE(excluded.generated_hash, sync_items.generated_hash),
                revision = sync_items.revision + 1,
                operation_id = excluded.operation_id,
                state = excluded.state,
                conflict_json = excluded.conflict_json,
                updated_at = excluded.updated_at",
            params![
                profile_id,
                kind,
                source_id,
                source_hash,
                generated_hash,
                operation_id,
                state,
                conflict_json,
                now_ms()
            ],
        )?;
        Ok(())
    }

    async fn item(
        &self,
        profile_id: &str,
        kind: &str,
        source_id: &str,
    ) -> Result<Option<SyncItemStatus>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT profile_id, kind, source_id, source_hash, generated_hash,
                    revision, operation_id, state, conflict_json, updated_at
             FROM sync_items WHERE profile_id = ?1 AND kind = ?2 AND source_id = ?3",
            params![profile_id, kind, source_id],
            item_from_row,
        )
        .optional()
        .context("reading sync item")
    }

    async fn bindings(&self) -> Result<Vec<AcpBinding>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT node_id, conversation_id, agent_id, engine, native_session_id,
                    working_directory, capabilities_json, updated_at, conversation_generation
             FROM acp_bindings WHERE EXISTS (SELECT 1 FROM conversation_state.conversation_generations g WHERE g.conversation_id = acp_bindings.conversation_id AND g.generation = acp_bindings.conversation_generation) ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], binding_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing ACP bindings")
    }

    /// The native session this node last recorded for one agent in one
    /// conversation, which a respawned ACP instance can resume.
    pub async fn binding_for_agent(
        &self,
        conversation_id: &str,
        agent_id: &str,
    ) -> Result<Option<AcpBinding>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT node_id, conversation_id, agent_id, engine, native_session_id,
                    working_directory, capabilities_json, updated_at, conversation_generation
             FROM acp_bindings
             WHERE node_id = ?1 AND conversation_id = ?2 AND agent_id = ?3 AND EXISTS (SELECT 1 FROM conversation_state.conversation_generations g WHERE g.conversation_id = acp_bindings.conversation_id AND g.generation = acp_bindings.conversation_generation)
             LIMIT 1",
            params![self.node_id, conversation_id, agent_id],
            binding_from_row,
        )
        .optional()
        .context("reading ACP binding for agent")
    }

    /// Every native session id this node recorded for one conversation (any
    /// agent or generation), for deleting the agents' own transcripts with it.
    pub async fn native_sessions_for(&self, conversation_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT native_session_id FROM acp_bindings
             WHERE node_id = ?1 AND conversation_id = ?2 AND native_session_id <> ''",
        )?;
        let rows = stmt.query_map(params![self.node_id, conversation_id], |row| {
            row.get::<_, String>(0)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing native sessions")
    }

    /// Forget this node's native ACP sessions for one conversation, so the next
    /// turn starts a fresh agent session from Ryu's transcript instead of
    /// resuming one that remembers turns the user rewound.
    pub async fn forget_acp_bindings(&self, conversation_id: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM acp_bindings WHERE node_id = ?1 AND conversation_id = ?2",
            params![self.node_id, conversation_id],
        )
        .context("forgetting ACP bindings")
    }

    async fn binding_for(&self, conversation_id: &str) -> Result<Option<AcpBinding>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT node_id, conversation_id, agent_id, engine, native_session_id,
                    working_directory, capabilities_json, updated_at, conversation_generation
             FROM acp_bindings
             WHERE node_id = ?1 AND conversation_id = ?2 AND EXISTS (SELECT 1 FROM conversation_state.conversation_generations g WHERE g.conversation_id = acp_bindings.conversation_id AND g.generation = acp_bindings.conversation_generation)
             ORDER BY updated_at DESC LIMIT 1",
            params![self.node_id, conversation_id],
            binding_from_row,
        )
        .optional()
        .context("reading ACP binding")
    }

    async fn items(&self) -> Result<Vec<SyncItemStatus>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT profile_id, kind, source_id, source_hash, generated_hash,
                    revision, operation_id, state, conflict_json, updated_at
             FROM sync_items ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], item_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing sync items")
    }

    async fn update_profile_summary(
        &self,
        profile_id: &str,
        operation_id: &str,
        status: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE sync_profiles
             SET status = ?1,
                 conflict_count = (SELECT COUNT(*) FROM sync_items
                                   WHERE profile_id = ?2 AND state = 'conflict'),
                 last_operation_id = ?3,
                 updated_at = ?4
             WHERE id = ?2",
            params![status, profile_id, operation_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn record_acp_binding(
        &self,
        conversation_id: &str,
        agent_id: &str,
        engine: &str,
        native_session_id: &str,
        working_directory: Option<&Path>,
        capabilities: &Value,
        generation: &str,
    ) -> Result<()> {
        let conn = self
            .conn
            .try_lock()
            .map_err(|_| anyhow::anyhow!("sync database busy"))?;
        record_acp_binding_conn(
            &conn,
            &self.node_id,
            conversation_id,
            agent_id,
            engine,
            native_session_id,
            working_directory,
            capabilities,
            generation,
        )
    }

    pub async fn record_acp_binding_async(
        &self,
        conversation_id: &str,
        agent_id: &str,
        engine: &str,
        native_session_id: &str,
        working_directory: Option<&Path>,
        capabilities: &Value,
        generation: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        record_acp_binding_conn(
            &conn,
            &self.node_id,
            conversation_id,
            agent_id,
            engine,
            native_session_id,
            working_directory,
            capabilities,
            generation,
        )
    }
}

fn record_acp_binding_conn(
    conn: &Connection,
    node_id: &str,
    conversation_id: &str,
    agent_id: &str,
    engine: &str,
    native_session_id: &str,
    working_directory: Option<&Path>,
    capabilities: &Value,
    generation: &str,
) -> Result<()> {
    let changed = conn.execute(
        "INSERT INTO acp_bindings
                (node_id, conversation_id, agent_id, engine, native_session_id,
                 working_directory, capabilities_json, updated_at, conversation_generation)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
             WHERE EXISTS (SELECT 1 FROM conversation_state.conversation_generations WHERE conversation_id = ?2 AND generation = ?9)
             ON CONFLICT(node_id, conversation_id, agent_id) DO UPDATE SET
                engine = excluded.engine,
                native_session_id = excluded.native_session_id,
                working_directory = excluded.working_directory,
                capabilities_json = excluded.capabilities_json,
                updated_at = excluded.updated_at,
                conversation_generation = excluded.conversation_generation",
        params![
            node_id,
            conversation_id,
            agent_id,
            engine,
            native_session_id,
            working_directory.map(|path| path.to_string_lossy().to_string()),
            serde_json::to_string(capabilities)?,
            now_ms(),
            generation,
        ],
    )?;
    anyhow::ensure!(changed == 1, "conversation generation is no longer current");
    Ok(())
}

/// Routes are merged into Core's protected router. They intentionally use the
/// existing `ServerState` for canonical Ryu reads/writes and the separate ledger
/// for sync metadata.
pub fn routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/agent-sync/profiles",
            get(list_profiles).post(save_profile),
        )
        .route(
            "/api/agent-sync/profiles/:id",
            put(save_profile_by_id).delete(remove_profile),
        )
        .route("/api/agent-sync/scan", post(scan))
        .route("/api/agent-sync/import", post(import_items))
        .route("/api/agent-sync/threads/import", post(import_thread))
        .route("/api/agent-sync/acp/resume", post(resume_acp))
        .route("/api/agent-sync/export", post(export_bundle))
        .route("/api/agent-sync/status", get(status))
        .route("/api/agent-sync/conflicts/resolve", put(resolve_conflict))
}

async fn require_agent_permission(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &'static str,
) -> Option<Response> {
    if crate::server::enforce_permission(state, caller, permission)
        .await
        .is_err()
    {
        let message = match permission {
            crate::identity_verify::permissions::AGENT_VIEW => {
                "insufficient permissions: agent.view"
            }
            crate::identity_verify::permissions::AGENT_RUN => "insufficient permissions: agent.run",
            crate::identity_verify::permissions::AGENT_EDIT => {
                "insufficient permissions: agent.edit"
            }
            _ => "insufficient permissions",
        };
        Some(error_response_with(StatusCode::FORBIDDEN, message))
    } else {
        None
    }
}

/// Apply the canonical per-agent ACL to an HTTP caller while preserving the
/// existing internal sync-worker context. The worker deliberately passes
/// `None` because it is a node-owned operation rather than a user request; the
/// route-level coarse permission check has already rejected that context on a
/// managed or org-bound HTTP request.
async fn agent_resource_is_visible(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &'static str,
    agent_id: &str,
) -> bool {
    caller.is_none()
        || crate::server::enforce_permission_on(
            state,
            caller,
            permission,
            crate::acl::KIND_AGENT,
            agent_id,
        )
        .await
        .is_ok()
}

fn filter_status_bindings(
    bindings: Vec<AcpBinding>,
    allowed_agent_ids: &HashSet<String>,
    readable_conversation_ids: &HashSet<String>,
) -> Vec<AcpBinding> {
    bindings
        .into_iter()
        .filter(|binding| {
            allowed_agent_ids.contains(&binding.agent_id)
                && readable_conversation_ids.contains(&binding.conversation_id)
        })
        .collect()
}

fn filter_status_items(
    items: Vec<SyncItemStatus>,
    profile_agent_ids: &HashMap<String, String>,
    allowed_agent_ids: &HashSet<String>,
) -> Vec<SyncItemStatus> {
    // A profile's provider is the only durable link from setup-ledger rows to
    // a Ryu agent. Keep rows for providers with no canonical agent (currently
    // `other`) under the existing coarse sync permission rather than inventing
    // a second resource identity for them.
    items
        .into_iter()
        .filter(|item| {
            profile_agent_ids
                .get(&item.profile_id)
                .is_none_or(|agent_id| allowed_agent_ids.contains(agent_id))
        })
        .collect()
}

fn filter_export_templates(
    templates: Vec<(String, crate::agents::AgentTemplate)>,
    allowed_agent_ids: &HashSet<String>,
) -> Vec<crate::agents::AgentTemplate> {
    templates
        .into_iter()
        .filter_map(|(agent_id, template)| {
            allowed_agent_ids.contains(&agent_id).then_some(template)
        })
        .collect()
}

async fn list_profiles(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    {
        return response;
    }
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    match store.profiles().await {
        Ok(profiles) => Json(json!({ "profiles": profiles })).into_response(),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn save_profile(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ProfileInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    save_profile_inner(input).await
}

async fn save_profile_by_id(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    AxumPath(id): AxumPath<String>,
    Json(mut input): Json<ProfileInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    input.id = Some(id);
    save_profile_inner(input).await
}

async fn save_profile_inner(input: ProfileInput) -> Response {
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    match store.upsert_profile(input).await {
        Ok(profile) => Json(profile).into_response(),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn remove_profile(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    match store.delete_profile(&id).await {
        Ok(true) => Json(json!({ "deleted": true, "id": id })).into_response(),
        Ok(false) => error_response_with(StatusCode::NOT_FOUND, "profile not found"),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn scan(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ScanInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    {
        return response;
    }
    let root = match crate::import::canonicalize_root(&input.path) {
        Ok(root) => root,
        Err(error) => return error_response_with(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let provider = match input.provider.as_deref() {
        Some(raw) => match normalize_provider(raw) {
            Ok(provider) => provider,
            Err(error) => return error_response_with(StatusCode::BAD_REQUEST, &error.to_string()),
        },
        None => detect_provider(&root),
    };
    let scan_root = root.clone();
    let scan_provider = provider.clone();
    let result = tokio::task::spawn_blocking(move || {
        let setup = crate::import::scan_source(&scan_root)?;
        let mut warnings = setup.warnings;
        let threads = if crate::native_history::engine_supports_history(&scan_provider) {
            crate::native_history::list_threads(&scan_provider, None)?
        } else {
            if scan_provider == "cursor" {
                warnings.push(
                    "Cursor native conversation history is not a documented import format; use the portable bundle.".to_owned(),
                );
            }
            Vec::new()
        };
        Ok::<_, anyhow::Error>((setup.items, threads, warnings))
    })
    .await;
    match result {
        Ok(Ok((items, threads, warnings))) => Json(SyncScan {
            agent_id: state
                .agents
                .list_infos()
                .into_iter()
                .find(|info| info.engine.as_deref() == Some(provider.as_str()))
                .map(|info| info.id),
            root: root.to_string_lossy().to_string(),
            provider: provider.clone(),
            items,
            threads,
            warnings,
            capabilities: capabilities_for(&provider),
        })
        .into_response(),
        Ok(Err(error)) => error_response(&error.to_string()),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn import_thread(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ImportThreadInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    if input.agent_id.trim().is_empty() || input.thread_id.trim().is_empty() {
        return error_response_with(
            StatusCode::BAD_REQUEST,
            "agent_id and thread_id are required",
        );
    }
    crate::server::import_agent_thread_handler(
        State(state),
        axum::Extension(caller),
        AxumPath(input.agent_id),
        Json(crate::server::ImportThreadBody {
            thread_id: input.thread_id,
            dry_run: input.dry_run,
        }),
    )
    .await
}

async fn resume_acp(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<AcpResumeInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
    )
    .await
    {
        return response;
    }
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    let conversation_id = input.conversation_id.trim().to_owned();
    if conversation_id.is_empty() {
        return error_response_with(StatusCode::BAD_REQUEST, "conversation_id is required");
    }
    if let Err(response) =
        crate::server::require_conversation_read_by_id(&state, &caller, &conversation_id).await
    {
        return response;
    }
    let binding = match store.binding_for(&conversation_id).await {
        Ok(binding) => binding,
        Err(error) => return error_response(&error.to_string()),
    };
    let Some(binding) = binding else {
        return Json(AcpResumeResponse {
            conversation_id,
            agent_id: None,
            native_session_id: None,
            mode: "replay".to_owned(),
            reason: "No node-scoped ACP binding is recorded; replay the canonical Ryu transcript."
                .to_owned(),
            response: None,
        })
        .into_response();
    };
    if crate::server::enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
        crate::acl::KIND_AGENT,
        &binding.agent_id,
    )
    .await
    .is_err()
    {
        return error_response_with(StatusCode::FORBIDDEN, "insufficient permissions: agent.run");
    }
    let Some(spawn_cmd) = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        &binding.agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    else {
        return Json(AcpResumeResponse {
            conversation_id,
            agent_id: Some(binding.agent_id),
            native_session_id: Some(binding.native_session_id),
            mode: "replay".to_owned(),
            reason:
                "The bound agent is unavailable on this node; replay the canonical Ryu transcript."
                    .to_owned(),
            response: None,
        })
        .into_response();
    };
    let cwd = binding
        .working_directory
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    if store
        .current_generation(&conversation_id)
        .ok()
        .flatten()
        .as_deref()
        != Some(binding.conversation_generation.as_str())
    {
        return error_response_with(
            StatusCode::CONFLICT,
            "Conversation changed; retry from its current transcript",
        );
    }
    let native_session_id = binding.native_session_id.clone();
    let loaded =
        crate::sidecar::adapters::acp::load_acp_session(spawn_cmd, native_session_id.clone(), cwd)
            .await;
    if store
        .current_generation(&conversation_id)
        .ok()
        .flatten()
        .as_deref()
        != Some(binding.conversation_generation.as_str())
    {
        return error_response_with(
            StatusCode::CONFLICT,
            "Conversation changed; retry from its current transcript",
        );
    }
    match loaded {
        Ok(response) if response.get("supported").and_then(Value::as_bool) == Some(true) => {
            let mode = response
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("load");
            Json(AcpResumeResponse {
                conversation_id,
                agent_id: Some(binding.agent_id),
                native_session_id: Some(native_session_id),
                mode: mode.to_owned(),
                reason: if mode == "resume" {
                    "ACP session/resume succeeded; the native session is available without transcript replay.".to_owned()
                } else {
                    "ACP session/load succeeded; the native session is available with native history replay.".to_owned()
                },
                response: Some(response),
            })
            .into_response()
        }
        Ok(response) => Json(AcpResumeResponse {
            conversation_id,
            agent_id: Some(binding.agent_id),
            native_session_id: Some(native_session_id),
            mode: "replay".to_owned(),
            reason: "The agent does not advertise ACP session/resume or session/load; replay the canonical Ryu transcript.".to_owned(),
            response: Some(response),
        })
        .into_response(),
        Err(error) => Json(AcpResumeResponse {
            conversation_id,
            agent_id: Some(binding.agent_id),
            native_session_id: Some(native_session_id),
            mode: "replay".to_owned(),
            reason: format!("ACP session resume/load was unavailable ({error}); replay the canonical Ryu transcript."),
            response: None,
        })
        .into_response(),
    }
}

async fn import_items(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ImportInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    if input.items.is_empty() {
        return error_response_with(StatusCode::BAD_REQUEST, "no items selected");
    }
    if input.items.len() > MAX_IMPORT_SELECTIONS {
        let message = format!("too many items selected; maximum is {MAX_IMPORT_SELECTIONS}");
        return error_response_with(StatusCode::BAD_REQUEST, &message);
    }
    if let Some(key) = duplicate_selection_key(&input.items) {
        return error_response_with(
            StatusCode::BAD_REQUEST,
            &format!("duplicate item selected: {key}"),
        );
    }
    let profile = match store.profile(&input.profile_id).await {
        Ok(Some(profile)) => profile,
        Ok(None) => return error_response_with(StatusCode::NOT_FOUND, "profile not found"),
        Err(error) => return error_response(&error.to_string()),
    };
    let configured_root = match crate::import::canonicalize_root(&profile.root) {
        Ok(root) => root,
        Err(error) => return error_response_with(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let root = match input.path.as_deref() {
        None => configured_root,
        Some(requested_root) => {
            let requested_root = match crate::import::canonicalize_root(requested_root) {
                Ok(root) => root,
                Err(error) => {
                    return error_response_with(StatusCode::BAD_REQUEST, &error.to_string());
                }
            };
            if requested_root != configured_root {
                return error_response_with(
                    StatusCode::BAD_REQUEST,
                    "path must match the selected profile root",
                );
            }
            configured_root
        }
    };
    let operation_id = format!("import_{}", uuid::Uuid::new_v4());
    if input.dry_run {
        let skipped = input.items.len();
        return Json(SyncImportResult {
            profile_id: profile.id,
            operation_id,
            dry_run: true,
            results: input
                .items
                .into_iter()
                .map(|selection| {
                    crate::import::ImportOutcome::skipped(
                        &selection.kind,
                        &selection.id,
                        &selection.id,
                        "dry run",
                    )
                })
                .collect(),
            imported: 0,
            skipped,
            failed: 0,
            conflicts: 0,
        })
        .into_response();
    }
    if !store.try_start(&profile.id).await {
        return error_response_with(
            StatusCode::CONFLICT,
            "sync operation already running for root",
        );
    }
    let selections = input.items.clone();
    let hash_root = root.clone();
    let hash_selections = selections.clone();
    let hash_results = match tokio::task::spawn_blocking(move || {
        let mut budget = HashBudget::default();
        hash_selections
            .iter()
            .map(|selection| {
                (
                    selection_key(selection),
                    hash_selected_item_with_budget(&hash_root, selection, &mut budget),
                )
            })
            .collect::<Vec<_>>()
    })
    .await
    {
        Ok(results) => results,
        Err(error) => {
            store.finish(&profile.id).await;
            return error_response(&format!("hashing selected items failed: {error}"));
        }
    };
    let mut hash_results: HashMap<_, _> = hash_results.into_iter().collect();
    let mut filtered = Vec::with_capacity(selections.len());
    let mut skipped_hashes = HashMap::new();
    let mut source_hashes = HashMap::new();
    for selection in selections {
        let selection_key = selection_key(&selection);
        if let Some(reason) = own_skill_skip_reason(&store, &profile.id, &root, &selection).await {
            skipped_hashes.insert(selection_key.clone(), reason.to_owned());
            continue;
        }
        let source_hash = match hash_results.remove(&selection_key) {
            Some(result) => result,
            None => Err(anyhow::anyhow!("selected item was not hashed")),
        };
        let source_hash = match source_hash {
            Ok(hash) => hash,
            Err(error) => {
                skipped_hashes.insert(selection_key.clone(), error.to_string());
                continue;
            }
        };
        if let Some(hash) = source_hash.as_deref() {
            source_hashes.insert(selection_key.clone(), hash.to_owned());
            match store
                .item(&profile.id, &selection.kind, &selection.id)
                .await
            {
                Ok(Some(previous))
                    if previous.source_hash.as_deref() == Some(hash)
                        && previous.state == "imported" =>
                {
                    skipped_hashes.insert(selection_key.clone(), "unchanged source".to_owned());
                    continue;
                }
                Ok(Some(previous)) if previous.generated_hash.as_deref() == Some(hash) => {
                    skipped_hashes.insert(selection_key.clone(), "generated output".to_owned());
                    continue;
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!("agent sync: reading ledger item failed: {error:#}");
                }
            }
        }
        filtered.push(selection);
    }
    let results = crate::server::apply_import_selections(&state, &caller, &root, filtered).await;
    store.finish(&profile.id).await;
    let mut final_results = Vec::with_capacity(input.items.len());
    let mut result_by_id: HashMap<String, crate::import::ImportOutcome> = results
        .into_iter()
        .map(|result| (format!("{}:{}", result.kind, result.id), result))
        .collect();
    for selection in input.items {
        let selection_key = selection_key(&selection);
        if let Some(reason) = skipped_hashes.remove(&selection_key) {
            final_results.push(crate::import::ImportOutcome::skipped(
                &selection.kind,
                &selection.id,
                &selection.id,
                &reason,
            ));
        } else if let Some(result) = result_by_id.remove(&selection_key) {
            if let Some(source_hash) = source_hashes.get(&selection_key) {
                let _ = store
                    .upsert_item(
                        &profile.id,
                        &selection.kind,
                        &selection.id,
                        Some(source_hash.as_str()),
                        None,
                        &operation_id,
                        if result.status == "failed" {
                            "failed"
                        } else {
                            "imported"
                        },
                        None,
                    )
                    .await;
            }
            final_results.push(result);
        }
    }
    let imported = final_results
        .iter()
        .filter(|result| result.status == "imported")
        .count();
    let skipped = final_results
        .iter()
        .filter(|result| result.status == "skipped")
        .count();
    let failed = final_results
        .iter()
        .filter(|result| result.status == "failed")
        .count();
    let _ = store
        .update_profile_summary(
            &profile.id,
            &operation_id,
            if failed > 0 { "error" } else { "idle" },
        )
        .await;
    Json(SyncImportResult {
        profile_id: profile.id,
        operation_id,
        dry_run: false,
        results: final_results,
        imported,
        skipped,
        failed,
        conflicts: 0,
    })
    .into_response()
}

async fn export_bundle(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ExportInput>,
) -> Response {
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return error_response_with(
            StatusCode::FORBIDDEN,
            "insufficient permissions: agent.edit",
        );
    }
    let destination = match crate::import::canonicalize_root(&input.destination) {
        Ok(path) => path,
        Err(error) => return error_response_with(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let profile = match input.profile_id.as_deref() {
        Some(id) => match store.profile(id).await {
            Ok(Some(profile)) => Some(profile),
            Ok(None) => return error_response_with(StatusCode::NOT_FOUND, "profile not found"),
            Err(error) => return error_response(&error.to_string()),
        },
        None => match store.profile_for_root(&destination).await {
            Ok(profile) => profile,
            Err(error) => return error_response(&error.to_string()),
        },
    };
    if let Some(profile) = profile.as_ref() {
        let profile_root = match crate::import::canonicalize_root(&profile.root) {
            Ok(root) => root,
            Err(error) => return error_response_with(StatusCode::BAD_REQUEST, &error.to_string()),
        };
        if profile_root != destination {
            return error_response_with(
                StatusCode::BAD_REQUEST,
                "destination must match the selected profile root",
            );
        }
    }
    let lock_id = profile
        .as_ref()
        .map(|profile| profile.id.as_str())
        .unwrap_or("manual-export");
    if !store.try_start(lock_id).await {
        return error_response_with(
            StatusCode::CONFLICT,
            "sync operation already running for root",
        );
    }
    let operation_id = format!("export_{}", uuid::Uuid::new_v4());
    let result = build_export(
        &state,
        &store,
        profile.as_ref(),
        &destination,
        &operation_id,
        input.dry_run,
        input.include_agents,
        input.include_skills,
        input.include_conversations,
        &caller,
        None,
    )
    .await;
    store.finish(lock_id).await;
    match result {
        Ok(result) => Json(result).into_response(),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn status(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    {
        return response;
    }
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    match (
        store.profiles().await,
        store.bindings().await,
        store.items().await,
    ) {
        (Ok(profiles), Ok(bindings), Ok(items)) => {
            if caller.is_none() {
                return Json(SyncStatus {
                    profiles,
                    bindings,
                    items,
                    active_operations: store.active_count().await,
                    node_id: store.node_id().to_owned(),
                })
                .into_response();
            }

            let agent_infos = state.agents.list_infos();
            let profile_agent_ids: HashMap<String, String> = profiles
                .iter()
                .filter_map(|profile| {
                    agent_infos
                        .iter()
                        .find(|info| {
                            info.engine.as_deref().is_some_and(|engine| {
                                engine.eq_ignore_ascii_case(&profile.provider)
                            })
                        })
                        .map(|info| (profile.id.clone(), info.id.clone()))
                })
                .collect();
            let mut candidate_agent_ids: HashSet<String> = bindings
                .iter()
                .map(|binding| binding.agent_id.clone())
                .collect();
            candidate_agent_ids.extend(profile_agent_ids.values().cloned());
            let mut allowed_agent_ids = HashSet::new();
            for agent_id in candidate_agent_ids {
                if agent_resource_is_visible(
                    &state,
                    &caller,
                    crate::identity_verify::permissions::AGENT_VIEW,
                    &agent_id,
                )
                .await
                {
                    allowed_agent_ids.insert(agent_id);
                }
            }
            let mut readable_conversation_ids = HashSet::new();
            for binding in &bindings {
                if allowed_agent_ids.contains(&binding.agent_id)
                    && crate::server::require_conversation_read_by_id(
                        &state,
                        &caller,
                        &binding.conversation_id,
                    )
                    .await
                    .is_ok()
                {
                    readable_conversation_ids.insert(binding.conversation_id.clone());
                }
            }
            let bindings =
                filter_status_bindings(bindings, &allowed_agent_ids, &readable_conversation_ids);
            let items = filter_status_items(items, &profile_agent_ids, &allowed_agent_ids);
            Json(SyncStatus {
                profiles,
                bindings,
                items,
                active_operations: store.active_count().await,
                node_id: store.node_id().to_owned(),
            })
            .into_response()
        }
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
            error_response(&error.to_string())
        }
    }
}

async fn resolve_conflict(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ResolveConflictInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    if !matches!(input.resolution.as_str(), "keep_ryu" | "keep_external") {
        return error_response_with(
            StatusCode::BAD_REQUEST,
            "resolution must be keep_ryu or keep_external",
        );
    }
    let profile = match store.profile(&input.profile_id).await {
        Ok(Some(profile)) => profile,
        Ok(None) => return error_response_with(StatusCode::NOT_FOUND, "profile not found"),
        Err(error) => return error_response(&error.to_string()),
    };
    let item = match store
        .item(&input.profile_id, &input.kind, &input.item_id)
        .await
    {
        Ok(Some(item)) => item,
        Ok(None) => return error_response_with(StatusCode::NOT_FOUND, "sync conflict not found"),
        Err(error) => return error_response(&error.to_string()),
    };
    if item.state != "conflict" {
        return error_response_with(
            StatusCode::CONFLICT,
            "sync item is not currently in conflict",
        );
    }
    if !store.try_start(&profile.id).await {
        return error_response_with(
            StatusCode::CONFLICT,
            "sync operation already running for root",
        );
    }
    let operation_id = format!("resolve_{}", uuid::Uuid::new_v4());
    let result: Result<()> = async {
        let root = crate::import::canonicalize_root(&profile.root)?;
        match input.resolution.as_str() {
            "keep_ryu" => {
                build_export(
                    &state,
                    &store,
                    Some(&profile),
                    &root,
                    &operation_id,
                    false,
                    true,
                    true,
                    profile.include_conversations,
                    &caller,
                    Some((input.kind.as_str(), input.item_id.as_str())),
                )
                .await?;
                let resolved = store
                    .item(&profile.id, &input.kind, &input.item_id)
                    .await?
                    .is_some_and(|item| item.state != "conflict");
                if !resolved {
                    bail!("the selected conflict could not be projected");
                }
            }
            "keep_external" => {
                let path = item
                    .conflict
                    .as_ref()
                    .and_then(|value| value.get("path"))
                    .and_then(Value::as_str)
                    .context("conflict has no external projection path")?;
                let path = fs::canonicalize(path)
                    .with_context(|| format!("reading external projection {}", path))?;
                if path.strip_prefix(&root).is_err() {
                    bail!("external projection is outside the selected profile root");
                }
                let bytes = fs::read(&path)
                    .with_context(|| format!("reading external projection {}", path.display()))?;
                let adopted_hash = if input.kind == "bundle" {
                    bundle_projection_hash_from_bytes(&bytes)
                        .context("external bundle is not a valid Ryu projection")?
                } else {
                    sha256_bytes(&bytes)
                };
                let previous_generated_hash = item
                    .conflict
                    .as_ref()
                    .and_then(|value| value.get("generated_hash_before_conflict"))
                    .and_then(Value::as_str)
                    .or(item.generated_hash.as_deref())
                    .unwrap_or_default();
                store
                    .upsert_item(
                        &profile.id,
                        &input.kind,
                        &input.item_id,
                        None,
                        Some(adopted_hash.as_str()),
                        &operation_id,
                        "external",
                        Some(&json!({
                            "resolution": "keep_external",
                            "adopted_hash": adopted_hash,
                            "previous_generated_hash": previous_generated_hash,
                            "path": path.to_string_lossy(),
                        })),
                    )
                    .await?;
            }
            _ => bail!("resolution must be keep_ryu or keep_external"),
        }
        let remaining_conflicts = store
            .items()
            .await?
            .into_iter()
            .filter(|item| item.profile_id == profile.id && item.state == "conflict")
            .count();
        store
            .update_profile_summary(
                &profile.id,
                &operation_id,
                if remaining_conflicts > 0 {
                    "conflict"
                } else {
                    "idle"
                },
            )
            .await?;
        Ok(())
    }
    .await;
    store.finish(&profile.id).await;
    match result {
        Ok(()) => Json(json!({ "resolved": true })).into_response(),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn build_export(
    state: &ServerState,
    store: &AgentSyncStore,
    profile: Option<&SyncProfile>,
    destination: &Path,
    operation_id: &str,
    dry_run: bool,
    include_agents: bool,
    include_skills: bool,
    include_conversations: bool,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    force_item: Option<(&str, &str)>,
) -> Result<SyncExportResult> {
    let mut warnings = Vec::new();
    let agents = if include_agents {
        let records = state
            .agent_store
            .list()
            .await
            .context("listing agents for export")?;
        let mut allowed_agent_ids = HashSet::new();
        let mut templates = Vec::with_capacity(records.len());
        for record in records {
            if agent_resource_is_visible(
                state,
                caller,
                crate::identity_verify::permissions::AGENT_VIEW,
                &record.id,
            )
            .await
            {
                allowed_agent_ids.insert(record.id.clone());
                templates.push((record.id.clone(), record.to_template()));
            }
        }
        filter_export_templates(templates, &allowed_agent_ids)
    } else {
        Vec::new()
    };
    let skills = if include_skills {
        state.skills.list_all()
    } else {
        Vec::new()
    };
    let conversation_summaries = state
        .conversations
        .list_conversations()
        .await
        .context("listing conversations for export")?;
    let mut visible_conversations = Vec::with_capacity(conversation_summaries.len());
    for summary in conversation_summaries {
        if crate::server::require_conversation_read_by_id(state, caller, &summary.id)
            .await
            .is_ok()
        {
            visible_conversations.push(summary);
        }
    }
    let mut conversations = Vec::new();
    let mut messages = 0;
    if include_conversations {
        for summary in &visible_conversations {
            let rows = state
                .conversations
                .get_messages(&summary.id)
                .await
                .with_context(|| format!("reading conversation {} for export", summary.id))?;
            messages += rows.len();
            conversations.push(BundleConversation {
                id: summary.id.clone(),
                title: summary.title.clone(),
                agent_id: summary.agent_id.clone(),
                created_at: summary.created_at,
                updated_at: summary.updated_at,
                folder_path: summary.folder_path.clone(),
                branch: summary.branch.clone(),
                messages: rows,
            });
        }
        warnings.push(
            "Conversation transcripts are portable-bundle data only; no native history file is written.".to_owned(),
        );
    }
    let bundle = Bundle {
        format: BUNDLE_FORMAT,
        version: BUNDLE_VERSION,
        operation_id: operation_id.to_owned(),
        generated_by: "ryu",
        node_id: store.node_id.clone(),
        created_at: now_ms(),
        agents,
        skills,
        conversations,
        warnings: warnings.clone(),
    };
    let raw = serde_json::to_vec_pretty(&bundle).context("serializing Ryu sync bundle")?;
    // Operation ids and timestamps are useful metadata but must not make an
    // unchanged projection look changed. The ledger compares this stable
    // content hash, not the volatile envelope bytes.
    let bundle_hash = bundle_projection_hash(&bundle)?;
    let bundle_path = destination.join(BUNDLE_FILE_NAME);
    let mut projected_files = 0;
    let mut conflicts = 0;
    let existing_projection = fs::read(&bundle_path)
        .ok()
        .and_then(|bytes| bundle_projection_hash_from_bytes(&bytes));
    let previous = match profile {
        Some(profile) => store.item(&profile.id, "bundle", BUNDLE_FILE_NAME).await?,
        None => None,
    };
    let force_bundle = force_item == Some(("bundle", BUNDLE_FILE_NAME));
    let external_preserved = previous.as_ref().is_some_and(|item| {
        item.state == "external"
            && item
                .conflict
                .as_ref()
                .and_then(|value| value.get("resolution"))
                .and_then(Value::as_str)
                == Some("keep_external")
            && item
                .conflict
                .as_ref()
                .and_then(|value| value.get("adopted_hash"))
                .and_then(Value::as_str)
                == existing_projection.as_deref()
            && item
                .conflict
                .as_ref()
                .and_then(|value| value.get("previous_generated_hash"))
                .and_then(Value::as_str)
                == Some(bundle_hash.as_str())
    });
    if let Some(ref existing_projection) = existing_projection {
        let external_changed = previous
            .as_ref()
            .and_then(|item| item.generated_hash.as_deref())
            .is_none_or(|previous_hash| previous_hash != existing_projection);
        let paused = previous
            .as_ref()
            .is_some_and(|item| item.state == "conflict");
        if !force_bundle
            && !external_preserved
            && (external_changed || paused)
            && existing_projection.as_str() != bundle_hash
        {
            conflicts = 1;
            warnings.push(
                "The destination bundle changed outside Ryu; it was preserved and export paused for review.".to_owned(),
            );
        }
    }
    let force_skill = force_item.is_some_and(|(kind, _)| kind == "skill");
    if (conflicts == 0 || force_skill) && !force_bundle {
        if let Some(profile) = profile {
            let (skill_files, skill_conflicts, skill_warnings) = project_skills(
                store,
                profile,
                destination,
                &bundle.skills,
                operation_id,
                dry_run,
                force_item,
            )
            .await?;
            projected_files += skill_files;
            conflicts += skill_conflicts;
            warnings.extend(skill_warnings);
        }
    }
    if conflicts == 0 && !external_preserved && existing_projection != Some(bundle_hash.clone()) {
        projected_files += 1;
        if !dry_run {
            write_atomic(&bundle_path, &raw)?;
        }
    }
    if let Some(profile) = profile {
        if !dry_run {
            if external_preserved {
                store
                    .upsert_item(
                        &profile.id,
                        "bundle",
                        BUNDLE_FILE_NAME,
                        None,
                        existing_projection.as_deref(),
                        operation_id,
                        "external",
                        Some(&json!({
                            "resolution": "keep_external",
                            "adopted_hash": existing_projection,
                            "previous_generated_hash": bundle_hash,
                            "path": bundle_path.to_string_lossy(),
                        })),
                    )
                    .await?;
            } else if conflicts == 0 {
                store
                    .upsert_item(
                        &profile.id,
                        "bundle",
                        BUNDLE_FILE_NAME,
                        None,
                        Some(&bundle_hash),
                        operation_id,
                        "projected",
                        None,
                    )
                    .await?;
            } else {
                store
                    .upsert_item(
                        &profile.id,
                        "bundle",
                        BUNDLE_FILE_NAME,
                        None,
                        existing_projection.as_deref(),
                        operation_id,
                        "conflict",
                        Some(&json!({
                            "reason": "external bundle changed",
                            "path": bundle_path.to_string_lossy(),
                            "generated_hash_before_conflict": bundle_hash,
                        })),
                    )
                    .await?;
            }
            store
                .update_profile_summary(
                    &profile.id,
                    operation_id,
                    if conflicts > 0 { "conflict" } else { "idle" },
                )
                .await?;
        }
    }
    let readable_conversation_ids: HashSet<String> = visible_conversations
        .iter()
        .map(|conversation| conversation.id.clone())
        .collect();
    let mut bindings = Vec::new();
    for binding in store.bindings().await? {
        if !readable_conversation_ids.contains(&binding.conversation_id)
            || !agent_resource_is_visible(
                state,
                caller,
                crate::identity_verify::permissions::AGENT_VIEW,
                &binding.agent_id,
            )
            .await
        {
            continue;
        }
        bindings.push(binding);
    }
    let acp_resume = visible_conversations
        .into_iter()
        .map(|conversation| {
            let binding = bindings.iter().find(|binding| {
                binding.conversation_id == conversation.id
                    && conversation
                        .agent_id
                        .as_deref()
                        .is_none_or(|agent_id| binding.agent_id == agent_id)
            });
            let can_resume = binding.is_some_and(|binding| {
                binding
                    .capabilities
                    .get("loadSession")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || binding
                        .capabilities
                        .get("sessionCapabilities")
                        .and_then(|value| value.get("resume"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            });
            AcpResumeStatus {
                conversation_id: conversation.id,
                agent_id: conversation.agent_id,
                mode: if can_resume { "resume" } else { "replay" }.to_owned(),
                reason: if can_resume {
                    "The ACP binding advertises session load/resume; the native session id is retained.".to_owned()
                } else {
                    "No load/resume capability was recorded; Ryu replays the canonical transcript.".to_owned()
                },
            }
        })
        .collect();
    Ok(SyncExportResult {
        profile_id: profile.map(|profile| profile.id.clone()),
        operation_id: operation_id.to_owned(),
        dry_run,
        destination: destination.to_string_lossy().to_string(),
        bundle_path: bundle_path.to_string_lossy().to_string(),
        bundle_hash,
        agents: bundle.agents.len(),
        skills: bundle.skills.len(),
        conversations: bundle.conversations.len(),
        messages,
        projected_files,
        conflicts,
        warnings,
        acp_resume,
    })
}

async fn project_skills(
    store: &AgentSyncStore,
    profile: &SyncProfile,
    destination: &Path,
    skills: &[ryu_skills::SkillRecord],
    operation_id: &str,
    dry_run: bool,
    force_item: Option<(&str, &str)>,
) -> Result<(usize, usize, Vec<String>)> {
    let mut projected = 0;
    let mut conflicts = 0;
    let mut warnings = Vec::new();
    for skill in skills {
        let Some(id) = safe_projection_segment(&skill.id) else {
            warnings.push(format!(
                "Skipped skill {:?}: unsafe projection id",
                skill.id
            ));
            continue;
        };
        let path = destination.join("skills").join(id).join("SKILL.md");
        let content = render_skill(skill)?;
        let hash = sha256_bytes(content.as_bytes());
        let source_id = format!("skills/{id}/SKILL.md");
        let existing = fs::read(&path).ok();
        let previous = store.item(&profile.id, "skill", &source_id).await?;
        let existing_hash = existing.as_deref().map(sha256_bytes);
        let forced = force_item == Some(("skill", source_id.as_str()));
        let external_preserved =
            external_baseline_preserved(previous.as_ref(), existing_hash.as_deref(), &hash);
        if let Some(existing) = existing.as_deref() {
            let existing_hash = existing_hash
                .as_deref()
                .context("skill projection hash disappeared")?;
            let external_changed = previous
                .as_ref()
                .and_then(|item| item.generated_hash.as_deref())
                .is_none_or(|previous_hash| previous_hash != existing_hash);
            let paused = previous
                .as_ref()
                .is_some_and(|item| item.state == "conflict");
            if existing != content.as_bytes()
                && (external_changed || paused)
                && !forced
                && !external_preserved
            {
                conflicts += 1;
                warnings.push(format!(
                    "Skill projection {} changed outside Ryu; preserved and paused.",
                    path.display()
                ));
                if !dry_run {
                    store
                        .upsert_item(
                            &profile.id,
                            "skill",
                            &source_id,
                            None,
                            Some(&existing_hash),
                            operation_id,
                            "conflict",
                            Some(&json!({
                                "path": path.to_string_lossy(),
                                "generated_hash_before_conflict": hash,
                            })),
                        )
                        .await?;
                }
                continue;
            }
            if existing != content.as_bytes() && !external_preserved {
                projected += 1;
                if !dry_run {
                    write_atomic(&path, content.as_bytes())?;
                }
            }
        } else {
            projected += 1;
            if !dry_run {
                write_atomic(&path, content.as_bytes())?;
            }
        }
        if !dry_run && external_preserved {
            store
                .upsert_item(
                    &profile.id,
                    "skill",
                    &source_id,
                    None,
                    existing_hash.as_deref(),
                    operation_id,
                    "external",
                    Some(&json!({
                        "resolution": "keep_external",
                        "adopted_hash": existing_hash,
                        "previous_generated_hash": hash,
                        "path": path.to_string_lossy(),
                    })),
                )
                .await?;
        } else if !dry_run {
            store
                .upsert_item(
                    &profile.id,
                    "skill",
                    &source_id,
                    None,
                    Some(&hash),
                    operation_id,
                    "projected",
                    None,
                )
                .await?;
        }
    }
    Ok((projected, conflicts, warnings))
}

fn external_baseline_preserved(
    previous: Option<&SyncItemStatus>,
    existing_hash: Option<&str>,
    current_generated_hash: &str,
) -> bool {
    let Some(item) = previous else {
        return false;
    };
    item.state == "external"
        && item
            .conflict
            .as_ref()
            .and_then(|value| value.get("resolution"))
            .and_then(Value::as_str)
            == Some("keep_external")
        && item
            .conflict
            .as_ref()
            .and_then(|value| value.get("adopted_hash"))
            .and_then(Value::as_str)
            == existing_hash
        && item
            .conflict
            .as_ref()
            .and_then(|value| value.get("previous_generated_hash"))
            .and_then(Value::as_str)
            == Some(current_generated_hash)
}

fn render_skill(skill: &ryu_skills::SkillRecord) -> Result<String> {
    let name = serde_json::to_string(&skill.name)?;
    let description = serde_json::to_string(&skill.description.clone().unwrap_or_default())?;
    let allowed_tools = if skill.allowed_tools.is_empty() {
        String::new()
    } else {
        skill
            .allowed_tools
            .iter()
            .map(|tool| serde_json::to_string(tool).map(|value| format!("  - {value}")))
            .collect::<Result<Vec<_>, _>>()?
            .join("\n")
    };
    let tools_block = if allowed_tools.is_empty() {
        String::new()
    } else {
        format!("allowed-tools:\n{allowed_tools}\n")
    };
    Ok(format!(
        "---\nname: {name}\ndescription: {description}\n{tools_block}enabled: {}\nalways-on: {}\n---\n{}\n",
        skill.enabled, skill.always_on, skill.instructions
    ))
}

fn safe_projection_segment(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value != "."
        && value != ".."
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        }))
    .then_some(value)
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS sync_profiles (
             id TEXT PRIMARY KEY,
             provider TEXT NOT NULL,
             root TEXT NOT NULL UNIQUE,
             import_enabled INTEGER NOT NULL DEFAULT 0,
             export_enabled INTEGER NOT NULL DEFAULT 0,
             status TEXT NOT NULL DEFAULT 'idle',
             conflict_count INTEGER NOT NULL DEFAULT 0,
             last_operation_id TEXT,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sync_items (
             profile_id TEXT NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
             kind TEXT NOT NULL,
             source_id TEXT NOT NULL,
             source_hash TEXT,
             generated_hash TEXT,
             revision INTEGER NOT NULL DEFAULT 0,
             operation_id TEXT,
             state TEXT NOT NULL,
             conflict_json TEXT,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY (profile_id, kind, source_id)
         );
         CREATE TABLE IF NOT EXISTS acp_bindings (
             node_id TEXT NOT NULL,
             conversation_id TEXT NOT NULL,
             agent_id TEXT NOT NULL,
             engine TEXT NOT NULL,
             native_session_id TEXT NOT NULL,
             working_directory TEXT,
             capabilities_json TEXT NOT NULL,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY (node_id, conversation_id, agent_id)
         );
         CREATE INDEX IF NOT EXISTS idx_sync_items_operation
             ON sync_items(operation_id);
         CREATE INDEX IF NOT EXISTS idx_acp_bindings_conversation
             ON acp_bindings(node_id, conversation_id);",
    )
    .context("initializing agent sync schema")?;
    let has_generation = {
        let mut stmt = conn.prepare("PRAGMA table_info(acp_bindings)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        columns.iter().any(|name| name == "conversation_generation")
    };
    if !has_generation {
        conn.execute(
            "ALTER TABLE acp_bindings ADD COLUMN conversation_generation TEXT",
            [],
        )?;
    }
    let has_revision = {
        let mut stmt = conn.prepare("PRAGMA table_info(sync_items)")?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        names.iter().any(|name| name == "revision")
    };
    if !has_revision {
        conn.execute(
            "ALTER TABLE sync_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    let has_include_conversations = {
        let mut stmt = conn.prepare("PRAGMA table_info(sync_profiles)")?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        names.iter().any(|name| name == "include_conversations")
    };
    if !has_include_conversations {
        // Existing profiles stop exporting conversations until the user opts in.
        conn.execute(
            "ALTER TABLE sync_profiles ADD COLUMN include_conversations INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}

fn profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncProfile> {
    Ok(SyncProfile {
        id: row.get(0)?,
        provider: row.get(1)?,
        root: row.get(2)?,
        import_enabled: row.get::<_, i64>(3)? != 0,
        export_enabled: row.get::<_, i64>(4)? != 0,
        status: row.get(5)?,
        conflict_count: row.get::<_, i64>(6)?.max(0) as u64,
        last_operation_id: row.get(7)?,
        updated_at: row.get(8)?,
        include_conversations: row.get::<_, i64>(9)? != 0,
    })
}

fn item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncItemStatus> {
    let conflict_json: Option<String> = row.get(8)?;
    Ok(SyncItemStatus {
        profile_id: row.get(0)?,
        kind: row.get(1)?,
        source_id: row.get(2)?,
        source_hash: row.get(3)?,
        generated_hash: row.get(4)?,
        revision: row.get(5)?,
        operation_id: row.get(6)?,
        state: row.get(7)?,
        conflict: conflict_json.and_then(|raw| serde_json::from_str(&raw).ok()),
        updated_at: row.get(9)?,
    })
}

fn attach_conversations(conn: &Connection, path: Option<&Path>) -> Result<()> {
    if let Some(path) = path.filter(|path| path.is_file()) {
        conn.execute(
            "ATTACH DATABASE ?1 AS conversation_state",
            [path.to_string_lossy().as_ref()],
        )?;
    } else {
        conn.execute("ATTACH DATABASE ':memory:' AS conversation_state", [])?;
        conn.execute("CREATE TABLE conversation_state.conversation_generations (conversation_id TEXT PRIMARY KEY, generation TEXT NOT NULL)", [])?;
    }
    Ok(())
}

fn binding_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AcpBinding> {
    let capabilities = row
        .get::<_, String>(6)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}));
    Ok(AcpBinding {
        node_id: row.get(0)?,
        conversation_id: row.get(1)?,
        agent_id: row.get(2)?,
        engine: row.get(3)?,
        native_session_id: row.get(4)?,
        working_directory: row.get(5)?,
        capabilities,
        updated_at: row.get(7)?,
        conversation_generation: row.get(8)?,
    })
}

fn default_true() -> bool {
    true
}

fn normalize_provider(input: &str) -> Result<String> {
    let provider = input.trim().to_ascii_lowercase();
    if provider.is_empty() {
        bail!("provider is empty");
    }
    if !matches!(
        provider.as_str(),
        "claude"
            | "codex"
            | "cursor"
            | "openclaw"
            | "hermes"
            | "muse"
            | "mastra"
            | "langchain"
            | "persona"
            | "chatgpt"
            | "claude-ai"
            | "other"
    ) {
        bail!("unsupported provider {provider:?}");
    }
    Ok(provider)
}

fn detect_provider(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .map(|name| match name.to_ascii_lowercase().as_str() {
            ".claude" => "claude",
            ".codex" => "codex",
            ".cursor" => "cursor",
            _ => "other",
        })
        .filter(|provider| *provider != "other")
        .or_else(|| crate::import::chat_exports::detect(root).map(|s| s.id()))
        .or_else(|| crate::import::frameworks::detect(root).map(|f| f.id()))
        .unwrap_or("other")
        .to_owned()
}

fn capabilities_for(provider: &str) -> SyncCapabilities {
    let native_threads = crate::native_history::engine_supports_history(provider);
    SyncCapabilities {
        setup_import: true,
        native_threads,
        acp_load_resume: None,
        portable_bundle: true,
        native_conversation_export: false,
        note: if provider == "cursor" {
            Some("Cursor setup can be scanned, but native thread/session files are not projected or fabricated.".to_owned())
        } else {
            Some("ACP load/resume is capability-based; replaying the Ryu transcript is always available.".to_owned())
        },
    }
}

fn hash_selected_item_with_budget(
    root: &Path,
    selection: &ImportSelection,
    budget: &mut HashBudget,
) -> Result<Option<String>> {
    // Chat-export items dedupe per conversation / per memory entry inside the
    // importer, and their source files can be far larger than the hash budget,
    // so they are tracked by a fingerprint of the export's file metadata.
    if is_chat_export_selection(selection) {
        return chat_export_fingerprint(root).map(Some);
    }
    let path = crate::import::resolve_item_path(root, &selection.id)?;
    Ok(Some(hash_path_with_budget(&path, budget)?))
}

/// A ChatGPT / Claude export item: a conversation group or saved context.
fn is_chat_export_selection(selection: &ImportSelection) -> bool {
    selection.kind == crate::import::kind::CONVERSATIONS
        || selection
            .id
            .ends_with(&format!("#{}", crate::import::chat_exports::SAVED_CONTEXT))
}

/// Names, sizes, and modification times of the files of a ChatGPT / Claude
/// export that the importer reads: its conversation, project and memory files
/// at the top level plus the records in `projects/` and `memories/`. A newer
/// export unzipped over the folder changes it, without reading any file.
fn chat_export_fingerprint(root: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    for folder in ["", "projects", "memories"] {
        let dir = root.join(folder);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if !folder.is_empty() && error.kind() == std::io::ErrorKind::NotFound => {
                continue;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("reading directory {}", dir.display()))
            }
        };
        // Only the files the importer reads count. An export of a heavy account
        // also holds a file for every image it handled, thousands of them;
        // counting those would put it past the entry limit, and an export that
        // cannot be fingerprinted is never imported and is parsed again on every
        // tick.
        let mut entries = entries
            .filter(|entry| {
                entry
                    .as_ref()
                    .map_or(true, |entry| reads_export_file(folder, &entry.file_name()))
            })
            .take(MAX_HASH_ENTRIES.saturating_add(1))
            .collect::<std::io::Result<Vec<_>>>()?;
        if entries.len() > MAX_HASH_ENTRIES {
            bail!("hash entry limit exceeded");
        }
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() {
                continue;
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_nanos());
            hasher.update(folder.as_bytes());
            hasher.update([0]);
            hasher.update(entry.file_name().as_encoded_bytes());
            hasher.update([0]);
            hasher.update(metadata.len().to_le_bytes());
            hasher.update(modified.to_le_bytes());
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Whether the importer reads this file of an export folder: the conversation,
/// project, memory and marker files at the top level, and the `.json` records in
/// `projects/` and `memories/`.
fn reads_export_file(folder: &str, name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    if folder.is_empty() {
        return crate::import::chat_exports::is_import_file(name);
    }
    Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        == Some("json")
}

/// Why a scanned skill must not be imported because it is Ryu's own skill:
/// a directory inside Ryu's skills install dir (installing it would delete
/// the very directory it copies from), or a `SKILL.md` that `project_skills`
/// wrote for this profile and that nothing has changed since. Re-importing a
/// projection would replace the real skill (and its bundled resources) with
/// the one-file projection and re-activate a skill the user disabled.
async fn own_skill_skip_reason(
    store: &AgentSyncStore,
    profile_id: &str,
    root: &Path,
    selection: &ImportSelection,
) -> Option<&'static str> {
    if selection.kind != crate::import::kind::SKILL {
        return None;
    }
    let dir = crate::import::resolve_item_path(root, &selection.id).ok()?;
    if is_inside_skills_install_dir(&dir) {
        return Some("already a Ryu skill install");
    }
    let rel = selection
        .id
        .strip_prefix(crate::import::kind::SKILL)?
        .strip_prefix('/')?;
    let source_id = format!("{rel}/SKILL.md");
    let previous = store
        .item(profile_id, "skill", &source_id)
        .await
        .ok()
        .flatten()?;
    // Only a "projected" row's hash is Ryu's own output. An "external" row's
    // adopted hash is the agent's or user's edit that "keep external" chose
    // over Ryu's projection, so importing it must still go through.
    if previous.state != "projected" {
        return None;
    }
    let projected_hash = previous.generated_hash?;
    let current_hash = sha256_bytes(&fs::read(dir.join("SKILL.md")).ok()?);
    (current_hash == projected_hash).then_some("generated output")
}

/// True when `dir` is (inside) Ryu's skills install directory.
fn is_inside_skills_install_dir(dir: &Path) -> bool {
    let Ok(skills_dir) = fs::canonicalize(ryu_skills::SkillRegistry::skills_dir()) else {
        return false;
    };
    fs::canonicalize(dir).is_ok_and(|dir| dir.starts_with(&skills_dir))
}

fn selection_key(selection: &ImportSelection) -> String {
    format!("{}:{}", selection.kind, selection.id)
}

fn duplicate_selection_key(selections: &[ImportSelection]) -> Option<String> {
    let mut seen = HashSet::with_capacity(selections.len());
    selections
        .iter()
        .map(selection_key)
        .find(|key| !seen.insert(key.clone()))
}

fn hash_path(path: &Path) -> Result<String> {
    let mut budget = HashBudget::default();
    hash_path_with_budget(path, &mut budget)
}

#[derive(Default)]
struct HashBudget {
    entries: usize,
    bytes: u64,
}

impl HashBudget {
    fn visit(&mut self, metadata: &fs::Metadata) -> Result<()> {
        if self.entries >= MAX_HASH_ENTRIES {
            bail!("hash entry limit exceeded");
        }
        if metadata.is_file() {
            if metadata.len() > MAX_HASH_BYTES {
                bail!("file is too large to hash safely");
            }
            self.bytes = self
                .bytes
                .checked_add(metadata.len())
                .filter(|bytes| *bytes <= MAX_HASH_TOTAL_BYTES)
                .ok_or_else(|| anyhow::anyhow!("total hash byte limit exceeded"))?;
        }
        self.entries += 1;
        Ok(())
    }
}

fn hash_path_with_budget(path: &Path, budget: &mut HashBudget) -> Result<String> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("reading metadata for {}", path.display()))?;
    let mut hasher = Sha256::new();
    hash_path_inner(path, &metadata, &mut hasher, budget)?;
    Ok(hex::encode(hasher.finalize()))
}

fn hash_path_inner(
    path: &Path,
    metadata: &fs::Metadata,
    hasher: &mut Sha256,
    budget: &mut HashBudget,
) -> Result<()> {
    if metadata.file_type().is_symlink() {
        bail!("refusing to hash symlink {}", path.display());
    }
    budget.visit(metadata)?;
    hasher.update(
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(""),
    );
    hasher.update([0]);
    if metadata.is_file() {
        if metadata.len() > MAX_HASH_BYTES {
            bail!("file is too large to hash safely");
        }
        hasher.update(fs::read(path).with_context(|| format!("reading {}", path.display()))?);
        return Ok(());
    }
    if !metadata.is_dir() {
        bail!("unsupported item type {}", path.display());
    }
    let mut children = fs::read_dir(path)
        .with_context(|| format!("reading directory {}", path.display()))?
        .take(MAX_HASH_ENTRIES.saturating_add(1))
        .collect::<std::io::Result<Vec<_>>>()?;
    if children.len() > MAX_HASH_ENTRIES {
        bail!("hash entry limit exceeded");
    }
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let child_path = child.path();
        let child_metadata = fs::symlink_metadata(&child_path)?;
        hash_path_inner(&child_path, &child_metadata, hasher, budget)?;
    }
    Ok(())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn bundle_projection_hash(bundle: &Bundle) -> Result<String> {
    let projection = json!({
        "format": bundle.format,
        "version": bundle.version,
        "generatedBy": bundle.generated_by,
        "agents": &bundle.agents,
        "skills": &bundle.skills,
        "conversations": &bundle.conversations,
    });
    Ok(sha256_bytes(&serde_json::to_vec(&projection)?))
}

fn bundle_projection_hash_from_bytes(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let projection = json!({
        "format": value.get("format")?,
        "version": value.get("version")?,
        "generatedBy": value.get("generatedBy")?,
        "agents": value.get("agents")?,
        "skills": value.get("skills")?,
        "conversations": value.get("conversations")?,
    });
    Some(sha256_bytes(&serde_json::to_vec(&projection).ok()?))
}

/// Remove bundle temporaries a crashed export left in `dir` (older than an
/// hour, so a write in progress is never touched). Returns how many went.
fn sweep_orphaned_bundle_temporaries(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let prefix = format!(".{BUNDLE_FILE_NAME}.");
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(&prefix) && name.ends_with(".tmp")) {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .filter(fs::Metadata::is_file)
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(3600));
        if stale && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("bundle has no parent directory")?;
    fs::create_dir_all(parent)?;
    sweep_orphaned_bundle_temporaries(parent);
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        BUNDLE_FILE_NAME,
        uuid::Uuid::new_v4()
    ));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .with_context(|| format!("writing {}", temporary.display()))?;
        std::io::Write::write_all(&mut file, bytes)
            .and_then(|()| file.sync_all())
            .with_context(|| format!("writing {}", temporary.display()))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error).with_context(|| format!("atomically replacing {}", path.display()));
    }
    Ok(())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn error_response(message: &str) -> Response {
    error_response_with(StatusCode::INTERNAL_SERVER_ERROR, message)
}

fn error_response_with(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// Start the opt-in worker after `ServerState` exists. The worker is intentionally
/// conservative: it imports setup items and projects the portable bundle only;
/// native transcript files remain read-only and are never invented by a timer.
pub fn spawn_worker(state: ServerState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some(store) = global_store() else {
                continue;
            };
            let profiles = match store.profiles().await {
                Ok(profiles) => profiles,
                Err(error) => {
                    tracing::warn!("agent sync: cannot list profiles: {error:#}");
                    continue;
                }
            };
            for profile in profiles {
                if profile.import_enabled {
                    reconcile_import(&state, &store, &profile).await;
                    if crate::native_history::engine_supports_history(&profile.provider) {
                        reconcile_native_threads(&state, &store, &profile).await;
                    }
                }
                if profile.export_enabled {
                    reconcile_export(&state, &store, &profile).await;
                }
            }
        }
    });
}

/// Chat-export fingerprints automatic import has fully reconciled, by profile
/// id. Scanning an export parses all of it, so an unchanged export is not
/// scanned again on every tick.
fn reconciled_chat_exports() -> &'static std::sync::Mutex<HashMap<String, String>> {
    static RECONCILED: OnceLock<std::sync::Mutex<HashMap<String, String>>> = OnceLock::new();
    RECONCILED.get_or_init(Default::default)
}

fn remember_reconciled_chat_export(profile_id: &str, fingerprint: Option<String>) {
    if let (Some(fingerprint), Ok(mut reconciled)) = (fingerprint, reconciled_chat_exports().lock())
    {
        reconciled.insert(profile_id.to_owned(), fingerprint);
    }
}

async fn reconcile_import(state: &ServerState, store: &AgentSyncStore, profile: &SyncProfile) {
    let root = PathBuf::from(&profile.root);
    let export_fingerprint = tokio::task::spawn_blocking({
        let root = root.clone();
        move || {
            crate::import::chat_exports::detect(&root)?;
            chat_export_fingerprint(&root).ok()
        }
    })
    .await
    .ok()
    .flatten();
    if let Some(fingerprint) = &export_fingerprint {
        let reconciled = reconciled_chat_exports()
            .lock()
            .is_ok_and(|reconciled| reconciled.get(&profile.id) == Some(fingerprint));
        if reconciled {
            return;
        }
    }
    let scan = match tokio::task::spawn_blocking({
        let root = root.clone();
        move || crate::import::scan_source(&root)
    })
    .await
    {
        Ok(Ok(scan)) => scan,
        Ok(Err(error)) => {
            tracing::warn!("agent sync: scan failed for {}: {error}", profile.root);
            return;
        }
        Err(error) => {
            tracing::warn!("agent sync: scan task failed for {}: {error}", profile.root);
            return;
        }
    };
    // Each pending item keeps the hash it was compared under. That is the hash
    // recorded once it is imported: hashing the folder again after the import
    // would also cover files that arrived while the import ran, and mark them
    // imported although the import never read them.
    let mut pending: Vec<(ImportSelection, String)> = Vec::new();
    let mut budget = HashBudget::default();
    for item in scan.items {
        let selection = ImportSelection {
            kind: item.kind.to_owned(),
            id: item.id,
        };
        if own_skill_skip_reason(store, &profile.id, &root, &selection)
            .await
            .is_some()
        {
            continue;
        }
        let Ok(Some(hash)) = hash_selected_item_with_budget(&root, &selection, &mut budget) else {
            continue;
        };
        // A chat export can be very large, so a failed chat-export item is
        // retried when the export changes (or from a manual import), not on
        // every tick.
        let chat_export = is_chat_export_selection(&selection);
        let unchanged = store
            .item(&profile.id, &selection.kind, &selection.id)
            .await
            .ok()
            .flatten()
            .is_some_and(|previous| {
                previous.source_hash.as_deref() == Some(hash.as_str())
                    && (previous.state == "imported" || chat_export)
            });
        if !unchanged {
            pending.push((selection, hash));
        }
    }
    let truncated = pending.len() > MAX_IMPORT_SELECTIONS;
    if truncated {
        pending.truncate(MAX_IMPORT_SELECTIONS);
    }
    if pending.is_empty() {
        remember_reconciled_chat_export(&profile.id, export_fingerprint);
        return;
    }
    if !store.try_start(&profile.id).await {
        return;
    }
    let operation_id = format!("auto-import_{}", uuid::Uuid::new_v4());
    let selections = pending
        .iter()
        .map(|(selection, _)| selection.clone())
        .collect();
    let results = crate::server::apply_import_selections(state, &None, &root, selections).await;
    store.finish(&profile.id).await;
    for ((selection, hash), result) in pending.into_iter().zip(results) {
        let _ = store
            .upsert_item(
                &profile.id,
                &selection.kind,
                &selection.id,
                Some(hash.as_str()),
                None,
                &operation_id,
                if result.status == "failed" {
                    "failed"
                } else {
                    "imported"
                },
                None,
            )
            .await;
    }
    if !truncated {
        remember_reconciled_chat_export(&profile.id, export_fingerprint);
    }
}

async fn reconcile_export(state: &ServerState, store: &AgentSyncStore, profile: &SyncProfile) {
    if !store.try_start(&profile.id).await {
        return;
    }
    let operation_id = format!("auto-export_{}", uuid::Uuid::new_v4());
    let result = build_export(
        state,
        store,
        Some(profile),
        Path::new(&profile.root),
        &operation_id,
        false,
        true,
        true,
        profile.include_conversations,
        &None,
        None,
    )
    .await;
    store.finish(&profile.id).await;
    if let Err(error) = result {
        tracing::warn!("agent sync: export failed for {}: {error:#}", profile.root);
    }
}

async fn reconcile_native_threads(
    state: &ServerState,
    store: &AgentSyncStore,
    profile: &SyncProfile,
) {
    let Some(agent_id) = state
        .agents
        .list_infos()
        .into_iter()
        .find(|info| info.engine.as_deref() == Some(profile.provider.as_str()))
        .map(|info| info.id)
    else {
        return;
    };
    let provider = profile.provider.clone();
    let threads = match tokio::task::spawn_blocking(move || {
        crate::native_history::list_threads(&provider, None)
    })
    .await
    {
        Ok(Ok(threads)) => threads,
        Ok(Err(error)) => {
            tracing::debug!("agent sync: native thread scan failed: {error:#}");
            return;
        }
        Err(error) => {
            tracing::debug!("agent sync: native thread scan task failed: {error}");
            return;
        }
    };
    let mut pending = Vec::new();
    for thread in threads.into_iter().take(20) {
        let source_hash = format!("{}:{}", thread.updated_at, thread.message_count);
        let unchanged = store
            .item(&profile.id, "native_thread", &thread.id)
            .await
            .ok()
            .flatten()
            .is_some_and(|previous| {
                previous.source_hash.as_deref() == Some(source_hash.as_str())
                    && previous.state == "imported"
            });
        if !unchanged {
            pending.push((thread.id, source_hash));
        }
    }
    if pending.is_empty() || !store.try_start(&profile.id).await {
        return;
    }
    let operation_id = format!("auto-thread-import_{}", uuid::Uuid::new_v4());
    for (thread_id, source_hash) in pending {
        let response =
            crate::server::import_agent_thread_for_sync(state, agent_id.clone(), thread_id.clone())
                .await;
        if response.status().is_success() {
            let _ = store
                .upsert_item(
                    &profile.id,
                    "native_thread",
                    &thread_id,
                    Some(source_hash.as_str()),
                    None,
                    &operation_id,
                    "imported",
                    None,
                )
                .await;
        }
    }
    store.finish(&profile.id).await;
}

#[cfg(test)]
#[path = "agent_sync_reconcile_test.rs"]
mod reconcile_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const DENIED_AGENT_ID: &str = "agent-sync-denied-agent";
    const VISIBLE_AGENT_ID: &str = "agent-sync-visible-agent";
    static ACL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct RestoredAgentAcl {
        key: crate::acl::store::ResourceKey,
        previous: Vec<crate::acl::store::StoredOverwrite>,
    }

    impl Drop for RestoredAgentAcl {
        fn drop(&mut self) {
            let _ = crate::acl::store::set_overwrites(&self.key, self.previous.clone());
        }
    }

    fn install_denied_agent_acl() -> RestoredAgentAcl {
        let key = crate::acl::store::ResourceKey::new(crate::acl::KIND_AGENT, DENIED_AGENT_ID);
        let previous = crate::acl::store::stored_for(&key);
        crate::acl::store::set_overwrites(
            &key,
            vec![crate::acl::store::StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: "sync-bob".to_owned(),
                allow: Vec::new(),
                deny: vec![
                    crate::identity_verify::permissions::AGENT_RUN.to_owned(),
                    crate::identity_verify::permissions::AGENT_VIEW.to_owned(),
                ],
            }],
        )
        .expect("persist the agent sync ACL fixture");
        let restored = RestoredAgentAcl { key, previous };
        assert_eq!(crate::acl::store::stored_for(&restored.key).len(), 1);
        restored
    }

    fn sync_member(user_id: &str) -> crate::identity_verify::VerifiedCaller {
        crate::identity_verify::VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("sync-org".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        }
    }

    fn persisted_allowed_agent_ids(
        caller: &crate::identity_verify::VerifiedCaller,
    ) -> HashSet<String> {
        [DENIED_AGENT_ID, VISIBLE_AGENT_ID]
            .into_iter()
            .filter(|agent_id| {
                crate::acl::decide_with_context(
                    caller,
                    crate::acl::KIND_AGENT,
                    agent_id,
                    crate::identity_verify::permissions::AGENT_VIEW,
                    &HashSet::new(),
                    &HashSet::new(),
                ) == crate::acl::Decision::Allowed
            })
            .map(str::to_owned)
            .collect()
    }

    fn binding(conversation_id: &str, agent_id: &str) -> AcpBinding {
        AcpBinding {
            node_id: "sync-node".to_owned(),
            conversation_id: conversation_id.to_owned(),
            agent_id: agent_id.to_owned(),
            engine: "claude".to_owned(),
            native_session_id: format!("session-{conversation_id}"),
            conversation_generation: "test-generation".to_owned(),
            working_directory: None,
            capabilities: serde_json::json!({}),
            updated_at: 1,
        }
    }

    fn item(profile_id: &str, source_id: &str) -> SyncItemStatus {
        SyncItemStatus {
            profile_id: profile_id.to_owned(),
            kind: "instructions".to_owned(),
            source_id: source_id.to_owned(),
            source_hash: None,
            generated_hash: None,
            revision: 1,
            operation_id: None,
            state: "imported".to_owned(),
            conflict: None,
            updated_at: 1,
        }
    }

    fn template(name: &str) -> crate::agents::AgentTemplate {
        serde_json::from_value(serde_json::json!({
            "kind": "agent",
            "name": name,
            "version": "1.0.0",
            "agent_config": {}
        }))
        .expect("valid agent template")
    }

    #[test]
    fn persisted_agent_acl_filters_status_and_export_rows() {
        let _lock = ACL_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _restore = install_denied_agent_acl();
        let caller = sync_member("sync-bob");
        let allowed_agent_ids = persisted_allowed_agent_ids(&caller);
        assert_eq!(
            allowed_agent_ids,
            [VISIBLE_AGENT_ID.to_owned()].into_iter().collect()
        );
        assert_eq!(
            crate::acl::decide_with_context(
                &caller,
                crate::acl::KIND_AGENT,
                DENIED_AGENT_ID,
                crate::identity_verify::permissions::AGENT_RUN,
                &HashSet::new(),
                &HashSet::new(),
            ),
            crate::acl::Decision::Denied
        );

        let readable_conversations = ["conversation-visible".to_owned()]
            .into_iter()
            .collect::<HashSet<_>>();
        let bindings = filter_status_bindings(
            vec![
                binding("conversation-denied-agent", DENIED_AGENT_ID),
                binding("conversation-visible", VISIBLE_AGENT_ID),
                binding("conversation-unreadable", VISIBLE_AGENT_ID),
            ],
            &allowed_agent_ids,
            &readable_conversations,
        );
        assert_eq!(
            bindings
                .iter()
                .map(|binding| binding.conversation_id.as_str())
                .collect::<Vec<_>>(),
            vec!["conversation-visible"]
        );

        let profile_agent_ids = HashMap::from([
            ("profile-denied".to_owned(), DENIED_AGENT_ID.to_owned()),
            ("profile-visible".to_owned(), VISIBLE_AGENT_ID.to_owned()),
        ]);
        let items = filter_status_items(
            vec![
                item("profile-denied", "private.md"),
                item("profile-visible", "shared.md"),
                item("profile-unmapped", "setup.md"),
            ],
            &profile_agent_ids,
            &allowed_agent_ids,
        );
        assert_eq!(
            items
                .iter()
                .map(|item| item.source_id.as_str())
                .collect::<Vec<_>>(),
            vec!["shared.md", "setup.md"]
        );

        let templates = filter_export_templates(
            vec![
                (DENIED_AGENT_ID.to_owned(), template("private agent")),
                (VISIBLE_AGENT_ID.to_owned(), template("visible agent")),
            ],
            &allowed_agent_ids,
        );
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].name, "visible agent");
    }

    #[tokio::test]
    async fn duplicate_roots_are_idempotent_without_duplicate_profiles() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        let dir = tempdir().unwrap();
        let first = store
            .upsert_profile(ProfileInput {
                id: None,
                provider: "claude".to_owned(),
                root: dir.path().to_string_lossy().to_string(),
                import_enabled: true,
                export_enabled: false,
                include_conversations: None,
            })
            .await
            .unwrap();
        let second = store
            .upsert_profile(ProfileInput {
                id: None,
                provider: "claude".to_owned(),
                root: dir.path().to_string_lossy().to_string(),
                import_enabled: false,
                export_enabled: true,
                include_conversations: None,
            })
            .await
            .unwrap();
        assert_eq!(first.id, second.id);
        assert!(!second.import_enabled);
        assert!(second.export_enabled);
        assert_eq!(store.profiles().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn conversation_export_is_opt_in_and_kept_until_changed() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        let dir = tempdir().unwrap();
        let input = |include_conversations| ProfileInput {
            id: None,
            provider: "claude".to_owned(),
            root: dir.path().to_string_lossy().to_string(),
            import_enabled: false,
            export_enabled: true,
            include_conversations,
        };
        let created = store.upsert_profile(input(None)).await.unwrap();
        assert!(!created.include_conversations, "off by default");
        let opted_in = store.upsert_profile(input(Some(true))).await.unwrap();
        assert!(opted_in.include_conversations);
        // A toggle that does not mention it keeps the stored choice.
        let kept = store.upsert_profile(input(None)).await.unwrap();
        assert!(kept.include_conversations);
        let opted_out = store.upsert_profile(input(Some(false))).await.unwrap();
        assert!(!opted_out.include_conversations);
        let manual: ExportInput =
            serde_json::from_value(json!({ "destination": "/tmp/x" })).unwrap();
        assert!(!manual.include_conversations);
    }

    #[test]
    fn crashed_bundle_temporaries_are_swept_but_fresh_ones_kept() {
        let dir = tempdir().unwrap();
        let stale = dir.path().join(format!(".{BUNDLE_FILE_NAME}.old.tmp"));
        let fresh = dir.path().join(format!(".{BUNDLE_FILE_NAME}.new.tmp"));
        let other = dir.path().join("notes.tmp");
        for path in [&stale, &fresh, &other] {
            fs::write(path, "{}").unwrap();
        }
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert_eq!(sweep_orphaned_bundle_temporaries(dir.path()), 1);
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(other.exists());
        write_atomic(&dir.path().join(BUNDLE_FILE_NAME), b"{}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(BUNDLE_FILE_NAME))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[tokio::test]
    async fn duplicate_roots_reject_a_different_explicit_profile() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        let dir = tempdir().unwrap();
        store
            .upsert_profile(ProfileInput {
                id: Some("profile-a".to_owned()),
                provider: "claude".to_owned(),
                root: dir.path().to_string_lossy().to_string(),
                import_enabled: false,
                export_enabled: false,
                include_conversations: None,
            })
            .await
            .unwrap();
        let result = store
            .upsert_profile(ProfileInput {
                id: Some("profile-b".to_owned()),
                provider: "claude".to_owned(),
                root: dir.path().to_string_lossy().to_string(),
                import_enabled: false,
                export_enabled: false,
                include_conversations: None,
            })
            .await;
        assert!(result.is_err());
        assert_eq!(store.profiles().await.unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn hash_rejects_symlink_traversal() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("target.txt");
        fs::write(&target, "secret").unwrap();
        let link = dir.path().join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &link).unwrap();
        assert!(hash_path(&link).is_err());
    }

    #[test]
    fn hash_budget_rejects_cumulative_bytes() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("item.txt");
        fs::write(&file, "secret").unwrap();
        let metadata = fs::symlink_metadata(&file).unwrap();
        let mut budget = HashBudget {
            entries: 0,
            bytes: MAX_HASH_TOTAL_BYTES,
        };
        assert!(budget.visit(&metadata).is_err());
    }

    #[test]
    fn bundle_projection_hash_ignores_operation_metadata() {
        let first = Bundle {
            format: BUNDLE_FORMAT,
            version: BUNDLE_VERSION,
            operation_id: "one".to_owned(),
            generated_by: "ryu",
            node_id: "node-a".to_owned(),
            created_at: 1,
            agents: Vec::new(),
            skills: Vec::new(),
            conversations: Vec::new(),
            warnings: Vec::new(),
        };
        let mut second = first.clone();
        second.operation_id = "two".to_owned();
        second.created_at = 2;
        assert_eq!(
            bundle_projection_hash(&first).unwrap(),
            bundle_projection_hash(&second).unwrap()
        );
    }

    #[test]
    fn selection_hash_keys_keep_kinds_distinct() {
        let skill = ImportSelection {
            kind: "skill".to_owned(),
            id: "shared-id".to_owned(),
        };
        let agent = ImportSelection {
            kind: "agent".to_owned(),
            id: "shared-id".to_owned(),
        };
        assert_ne!(selection_key(&skill), selection_key(&agent));
    }

    #[test]
    fn duplicate_import_selections_are_rejected_before_hashing() {
        let selection = ImportSelection {
            kind: "skill".to_owned(),
            id: "same".to_owned(),
        };
        assert_eq!(
            duplicate_selection_key(&[selection.clone(), selection]),
            Some("skill:same".to_owned())
        );
    }

    #[test]
    fn chat_export_items_are_fingerprinted_so_automatic_import_queues_them() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("conversations.json"), "[]").unwrap();
        fs::create_dir_all(root.join("projects")).unwrap();
        fs::write(root.join("projects/p.json"), "{}").unwrap();
        let chats = ImportSelection {
            kind: crate::import::kind::CONVERSATIONS.to_owned(),
            id: "conversations/conversations.json#chats".to_owned(),
        };
        // Split exports have no `conversations.json`; nothing is resolved.
        let saved = ImportSelection {
            kind: crate::import::kind::MEMORY.to_owned(),
            id: "memory/conversations-000.json#saved-context".to_owned(),
        };
        let mut budget = HashBudget::default();
        let first = hash_selected_item_with_budget(root, &chats, &mut budget)
            .unwrap()
            .expect("a chat export item has a fingerprint");
        assert_eq!(
            hash_selected_item_with_budget(root, &saved, &mut budget).unwrap(),
            Some(first.clone())
        );
        assert_eq!(budget.bytes, 0, "fingerprinting reads no file contents");
        fs::write(root.join("projects/p.json"), "{\"uuid\":\"x\"}").unwrap();
        assert_ne!(chat_export_fingerprint(root).unwrap(), first);
    }

    #[test]
    fn automatic_hash_budget_is_shared_across_items() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.txt");
        let second = dir.path().join("second.txt");
        fs::write(&first, "a").unwrap();
        fs::write(&second, "b").unwrap();
        let mut budget = HashBudget {
            entries: 0,
            bytes: MAX_HASH_TOTAL_BYTES - 1,
        };
        assert!(hash_path_with_budget(&first, &mut budget).is_ok());
        assert!(hash_path_with_budget(&second, &mut budget).is_err());
    }

    #[test]
    fn skill_projection_is_safe_and_does_not_emit_credentials() {
        let skill = ryu_skills::SkillRecord {
            id: "safe-skill".to_owned(),
            name: "Safe skill".to_owned(),
            description: Some("A test skill".to_owned()),
            instructions: "Use the tool carefully.".to_owned(),
            allowed_tools: vec!["web.search".to_owned()],
            enabled: true,
            always_on: false,
        };
        let rendered = render_skill(&skill).unwrap();
        assert!(rendered.contains("safe-skill") || rendered.contains("Safe skill"));
        assert!(rendered.contains("web.search"));
        assert!(!rendered.contains("api_key"));
        assert!(safe_projection_segment("../escape").is_none());
        assert!(safe_projection_segment("safe-skill").is_some());
    }

    #[tokio::test]
    async fn automatic_import_skips_ryus_own_skill_projections_and_installs() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let profile = store
            .upsert_profile(ProfileInput {
                id: None,
                provider: "codex".to_owned(),
                root: root.to_string_lossy().to_string(),
                import_enabled: true,
                export_enabled: true,
                include_conversations: None,
            })
            .await
            .unwrap();
        let skill = ryu_skills::SkillRecord {
            id: "pdf".to_owned(),
            name: "pdf".to_owned(),
            description: Some("Read PDFs".to_owned()),
            instructions: "Use the scripts.".to_owned(),
            allowed_tools: Vec::new(),
            enabled: false,
            always_on: false,
        };
        project_skills(&store, &profile, &root, &[skill], "op-export", false, None)
            .await
            .unwrap();
        let selection = ImportSelection {
            kind: crate::import::kind::SKILL.to_owned(),
            id: "skill/skills/pdf".to_owned(),
        };
        let skill_dir = root.join("skills").join("pdf");
        fs::write(skill_dir.join("notes.md"), "extra").unwrap();
        assert_eq!(
            own_skill_skip_reason(&store, &profile.id, &root, &selection).await,
            Some("generated output")
        );

        let edited = "---\nname: pdf\n---\nEdited.";
        fs::write(skill_dir.join("SKILL.md"), edited).unwrap();
        assert_eq!(
            own_skill_skip_reason(&store, &profile.id, &root, &selection).await,
            None
        );

        // "Keep external" adopts the edit; it is the user's content, not Ryu's
        // projection, so it must stay importable.
        let adopted_hash = sha256_bytes(edited.as_bytes());
        store
            .upsert_item(
                &profile.id,
                "skill",
                "skills/pdf/SKILL.md",
                None,
                Some(&adopted_hash),
                "op-resolve",
                "external",
                Some(&json!({
                    "resolution": "keep_external",
                    "adopted_hash": adopted_hash,
                })),
            )
            .await
            .unwrap();
        assert_eq!(
            own_skill_skip_reason(&store, &profile.id, &root, &selection).await,
            None
        );

        let inside_install_dir = {
            let _env = ryu_skills::SKILLS_ENV_LOCK
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            std::env::set_var("RYU_SKILLS_DIR", root.join("skills"));
            let inside = is_inside_skills_install_dir(&skill_dir);
            std::env::remove_var("RYU_SKILLS_DIR");
            inside
        };
        assert!(inside_install_dir);
    }

    #[tokio::test]
    async fn acp_binding_is_device_scoped_and_updated_in_place() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        store
            .record_acp_binding(
                "conversation-1",
                "agent-1",
                "claude",
                "session-a",
                None,
                &json!({ "loadSession": true }),
                "test-generation",
            )
            .unwrap();
        store
            .record_acp_binding(
                "conversation-1",
                "agent-1",
                "claude",
                "session-b",
                None,
                &json!({ "loadSession": false }),
                "test-generation",
            )
            .unwrap();
        let bindings = store.bindings().await.unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].native_session_id, "session-b");
        assert_eq!(bindings[0].node_id, "test-node");
    }

    #[tokio::test]
    async fn deleted_incarnations_cannot_resume_or_overwrite_recreated_bindings() {
        let root = tempdir().unwrap();
        let canonical = Connection::open(root.path().join("conversations.db")).unwrap();
        canonical.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE conversations (id TEXT PRIMARY KEY, owner TEXT); INSERT INTO conversations VALUES ('chat', 'alice');").unwrap();
        crate::server::conversation_lifecycle::initialize(&canonical).unwrap();
        let path = root.path().join("agent-sync.db");
        let store = AgentSyncStore::open(path.clone()).unwrap();
        let old = store.current_generation("chat").unwrap().unwrap();
        // Pre-migration rows must not inherit the generation of an existing ID.
        store.conn.lock().await.execute("INSERT INTO acp_bindings (node_id, conversation_id, agent_id, engine, native_session_id, capabilities_json, updated_at) VALUES (?1, 'chat', 'agent', 'claude', 'legacy', '{}', 1)", [store.node_id()]).unwrap();
        assert!(store
            .binding_for_agent("chat", "agent")
            .await
            .unwrap()
            .is_none());
        store
            .record_acp_binding_async(
                "chat",
                "agent",
                "claude",
                "alice-session",
                None,
                &json!({}),
                &old,
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .binding_for("chat")
                .await
                .unwrap()
                .unwrap()
                .native_session_id,
            "alice-session"
        );
        drop(store);
        let store = AgentSyncStore::open(path.clone()).unwrap();
        assert_eq!(
            store.current_generation("chat").unwrap().as_deref(),
            Some(old.as_str())
        );
        assert_eq!(store.bindings().await.unwrap().len(), 1);
        canonical
            .execute("DELETE FROM conversations WHERE owner = 'alice'", [])
            .unwrap();
        assert!(store
            .binding_for_agent("chat", "agent")
            .await
            .unwrap()
            .is_none());
        assert!(store.binding_for("chat").await.unwrap().is_none());
        assert!(store.bindings().await.unwrap().is_empty());
        assert!(store
            .record_acp_binding_async(
                "chat",
                "agent",
                "claude",
                "late-old",
                None,
                &json!({}),
                &old
            )
            .await
            .is_err());
        canonical
            .execute("INSERT INTO conversations VALUES ('chat', 'bob')", [])
            .unwrap();
        let new = store.current_generation("chat").unwrap().unwrap();
        assert_ne!(old, new);
        assert!(store.binding_for("chat").await.unwrap().is_none());
        store
            .record_acp_binding_async(
                "chat",
                "agent",
                "claude",
                "bob-session",
                None,
                &json!({}),
                &new,
            )
            .await
            .unwrap();
        assert!(store
            .record_acp_binding_async(
                "chat",
                "agent",
                "claude",
                "late-old",
                None,
                &json!({}),
                &old
            )
            .await
            .is_err());
        assert_eq!(
            store
                .binding_for("chat")
                .await
                .unwrap()
                .unwrap()
                .native_session_id,
            "bob-session"
        );
        drop(store);
        let store = AgentSyncStore::open(path).unwrap();
        assert_eq!(
            store
                .binding_for("chat")
                .await
                .unwrap()
                .unwrap()
                .native_session_id,
            "bob-session"
        );
        canonical.execute("DELETE FROM conversations", []).unwrap();
        assert!(store.bindings().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn sync_item_revisions_increment_on_retry() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        let dir = tempdir().unwrap();
        let profile = store
            .upsert_profile(ProfileInput {
                id: None,
                provider: "claude".to_owned(),
                root: dir.path().to_string_lossy().to_string(),
                import_enabled: false,
                export_enabled: false,
                include_conversations: None,
            })
            .await
            .unwrap();
        store
            .upsert_item(
                &profile.id,
                "instructions",
                "AGENTS.md",
                Some("source-a"),
                None,
                "op-a",
                "imported",
                None,
            )
            .await
            .unwrap();
        store
            .upsert_item(
                &profile.id,
                "instructions",
                "AGENTS.md",
                Some("source-b"),
                None,
                "op-b",
                "imported",
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .item(&profile.id, "instructions", "AGENTS.md")
                .await
                .unwrap()
                .unwrap()
                .revision,
            2
        );
    }
}
