// test-exempt: part of server/agent_sync.rs (spliced in with include!), moved verbatim; tests in agent_sync/tests/ and agent_sync_reconcile_test.rs.

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
