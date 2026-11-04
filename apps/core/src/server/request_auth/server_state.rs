//! Server state, the remote-auth gate, route policy and the `require_auth` middleware: `WorktreeRun` through `host_is_non_loopback`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// A completed run's worktree state, kept alive until the user applies or
/// discards it. Holds both the diff (for display) and the live guard (for
/// apply). The guard is `None` after apply/cleanup; the diff is always present.
pub struct WorktreeRun {
    /// The last computed diff. A **cache**, not the truth: while the guard is
    /// live, `GET /api/worktree/:run_id/diff` recomputes from the worktree and
    /// refreshes this. It is the answer only once the worktree is gone (applied
    /// or cleaned up), when there is nothing left to read.
    pub diff: worktree::WorktreeDiff,
    /// Live worktree guard — `Some` until apply is called, then `None`.
    pub guard: Option<worktree::WorktreeGuard>,
    /// When `diff` was computed. Bounds how often a client can make the node
    /// shell out for a fresh one (see `WORKTREE_DIFF_MAX_AGE`).
    pub computed_at: std::time::Instant,
}

/// Maps `conversation_id` → [`WorktreeRun`]. Populated by `route_chat_stream`
/// after each ACP run that used worktree isolation; consumed by
/// `GET /api/worktree/:run_id/diff` (read diff) and
/// `POST /api/worktree/:run_id/apply` (apply + cleanup).
pub type WorktreeDiffStore = Arc<Mutex<HashMap<String, WorktreeRun>>>;

#[derive(Clone)]
pub struct ServerState {
    pub setup: Arc<SetupManager>,
    pub manager: Arc<SidecarManager>,
    pub install_status: Arc<InstallStatusStore>,
    pub catalog: Arc<crate::catalog::CatalogManager>,
    pub client: reqwest::Client,
    pub auth: Arc<Mutex<AuthState>>,
    pub agents: Arc<AcpAgentRegistry>,
    pub agent_store: AgentStore,
    /// Core-owned Safe Actions verifier, policy store, review queue, and receipt
    /// ledger. The companion app is only a UI over this authority.
    pub safe_actions: crate::safe_actions::SafeActionsService,
    pub conversations: ConversationStore,
    pub memory: MemoryStore,
    pub mcp: Arc<McpRegistry>,
    pub spaces: SpaceStore,
    /// Local on-disk media store (`~/.ryu/media/`) for editor image/file uploads.
    /// Served back over `GET /api/media/:file`. The no-cloud replacement for an
    /// uploadthing-style service.
    pub media: media::MediaStore,
    /// Local ryu-gateway lifecycle. Used to re-point the gateway's `local`
    /// provider at the active engine after a swap (U19).
    pub gateway: Arc<crate::sidecar::gateway::GatewayManager>,
    /// Local headroom compression-proxy lifecycle. Started/refreshed when the
    /// headroom plugin (`headroom`) is enabled/disabled so the gateway's
    /// egress compression toggles at runtime (persist+respawn, not env-at-spawn).
    pub headroom: Arc<crate::sidecar::headroom::HeadroomManager>,
    pub retrieval: RetrievalStore,
    /// Stores the per-run worktree diff after each ACP run completes.
    /// Keyed by `conversation_id` (the run_id exposed in the REST API).
    pub worktree_diffs: WorktreeDiffStore,
    /// App manifests: built-ins + user-installed + hot-scaffolded apps.
    /// Uses `RwLock` so `scaffold_runnable` / `write_ryu_json` can hot-install
    /// a new manifest and `GET /api/apps` sees it immediately without restart.
    /// Loaded at startup from built-ins + `~/.ryu/apps/*/ryu.json`.
    pub app_manifests: Arc<tokio::sync::RwLock<Vec<crate::plugin_manifest::PluginManifest>>>,
    /// Manifests held back because this node does not meet their `engines` floors.
    ///
    /// Deliberately a SEPARATE field from `app_manifests` rather than a flag on it:
    /// every consumer that iterates `app_manifests` runs plugins, and an
    /// incompatible one must never be picked up by hook dispatch, sidecar spawn,
    /// contributions, or route mounting. Only the catalog projection reads this, to
    /// render a greyed card explaining what the plugin needs. See
    /// [`crate::plugin_manifest::IncompatibleManifest`].
    pub incompatible_manifests:
        Arc<tokio::sync::RwLock<Vec<crate::plugin_manifest::IncompatibleManifest>>>,
    /// Persisted app lifecycle state (install/enable/version). Backed by SQLite
    /// at `~/.ryu/apps.db`. Populated on demand by the install/enable endpoints.
    pub app_store: PluginStore,
    /// Remote app catalog client (#427): TTL-cached browse of the registry JSON.
    pub catalog_client: Arc<crate::plugins::catalog::PluginCatalogClient>,
    /// Agent Skill registry (M3 / issue #145). Loaded from the universal Agent
    /// Skills directory `~/.claude/skills/<id>/SKILL.md` at startup.
    /// Discoverable via `GET /api/skills`. Instructions are injected
    /// into outgoing chat requests by [`route_chat_stream`].
    pub skills: SkillRegistry,
    /// In-memory registry of runtime contributions from enabled plugins that Core
    /// otherwise has no home for: engine bindings (`RunnableKind::Engine`), channel
    /// adapters (`RunnableKind::Channel`), and companion surfaces
    /// (`RunnableKind::Companion`). Populated by [`build_runnable_registry`]'s
    /// per-kind handlers on plugin enable, drained on disable. Mirrors
    /// `McpRegistry`'s in-memory `app_tools` bag; survives restart via the
    /// `onStartup` re-run. Surfaced through `GET /api/engines` (engines) and
    /// `GET /api/plugins/contributions` (channels + companions).
    pub app_contrib: crate::plugins::app_contrib::AppContribRegistry,
    /// Coordinates plugin runtime generations. Activation publishes only after
    /// registration completes; deactivation drains in-flight hook work before
    /// removing the plugin's contributions.
    pub plugin_runtime: crate::plugins::runtime::PluginRuntime,
    /// Per-run observability trace store (M4 / issue #178). Persists ordered
    /// spans (tool-call, model-call) keyed by `conversation_id`.
    pub traces: TraceStore,
    /// Cross-surface key-value preferences (e.g. the shared theme blob). Backed
    /// by `~/.ryu/preferences.db` with a broadcast channel for live SSE updates,
    /// so the island companion stays in sync with the desktop's theme choice.
    pub preferences: PreferencesStore,
    /// Opt-in, month-to-date API-equivalent usage for managed Pi OAuth accounts.
    /// Contains only provider/account/model IDs and token counters, never prompts
    /// or credentials; separate from the preference event stream.
    pub subscription_costs: Option<subscription_costs::SubscriptionCostStore>,
    /// Local support-access audit log (#546, P5). The append-only, user-held
    /// record of every access to the local diagnostic channel — actor stamped on
    /// each row. Backed by `~/.ryu/support-access-audit.db`. Read by
    /// `GET /api/support-access/audit`; written on every diagnostic read/refusal.
    pub support_audit: crate::support_access::SupportAccessStore,
    /// The CatalogSource seam (#459): per-kind built-in + custom catalog
    /// sources (model/skill/mcp/plugin). Active selection persists in
    /// `preferences`; custom sources persist to `~/.ryu/catalog-sources.json`.
    pub catalog_sources: Arc<crate::catalog_source::CatalogSourceRegistry>,
    /// Global download state manager (#456). The single source of truth for every
    /// network artifact (models/engines/agents/tools/skills): lifecycle, live
    /// progress over SSE, and pause/resume/cancel. `/api/setup/status` is derived
    /// from it. Cheap to clone (wraps an `Arc`).
    pub downloads: crate::downloads::DownloadCenter,
    // Monitors, meetings and quests are OUT-OF-PROCESS apps: Core keeps no engine
    // or client field for them. Their `/api/<app>/*` surfaces are served via the
    // manifest `public_mount`; Core reaches them only through the capabilities they
    // provide (the `jobs.*` fan-out in `crate::scheduler::app_jobs`, the frozen
    // `quests.*` residue in `crate::scheduler::legacy_quest_jobs`,
    // `crate::meeting_capabilities`, and the `data.*` fan-out in
    // `server::data_admin`).
    /// Human-in-the-loop approval inbox: holds the approvals store + decision
    /// engine. Agents/workflows/automations explicitly configured for approval
    /// raise pending requests here (scheduler `require_approval` jobs, workflow
    /// `Awakeable` gates); the user approves/rejects from one inbox and the
    /// approved action runs. Decides *what runs* ⇒ Core; the *requires-approval*
    /// policy is a user flag today (a Gateway consult once tool risk-tags land).
    pub approvals: crate::approvals::ApprovalEngine,
    /// Unified activity feed: one cross-module timeline of what the node did
    /// (monitor alerts, quest completions, approvals, meetings, manual notes).
    /// Backed by `~/.ryu/activity.db` with a broadcast channel for live SSE. Fed
    /// by background ingest loops (`crate::activity::ingest`) that subscribe to
    /// each producing engine. Records *what happened* ⇒ Core.
    pub activity: ryu_activity::ActivityStore,
    /// Optional private-network plane (#478): a thin handle over the
    /// Tailscale/Headscale or Tailcat status read path. The provider itself is
    /// an opt-in Sidecar; this handle backs `GET /api/mesh/status`.
    pub mesh: ryu_mesh::MeshHandle,
    /// In-memory connected-client presence registry (the "who's on this node"
    /// surface). Populated by the `track_connection` middleware on every
    /// authenticated request and read by `GET /api/connections`. This is
    /// self-declared attribution behind the shared token, NOT verified identity
    /// (see `crate::connections`).
    pub connections: crate::connections::ConnectionRegistry,
    /// Ryu hardware device registry (RHP v1, PROTOCOL.md §6): paired watch /
    /// necklace / desk devices, their revocable per-device Bearer tokens, and
    /// presence (last-seen + battery). Backed by `~/.ryu/hardware.db`. Read by the
    /// `/api/hardware/*` REST surface and the `/api/hardware/ws` realtime handler;
    /// the WS handler authenticates the device token against it on each connect.
    pub hardware: ryu_hardware::DeviceStore,
    /// Room-keyed realtime fan-out registry (Phase 1 of the multi-user epic).
    /// Backs `GET /api/realtime/ws`: chat fan-out, presence/awareness, and
    /// (Phase 3) CRDT doc-sync all flow through per-room broadcast actors keyed
    /// by `conversation_id` / `document_id`. Already `Arc`-backed and `Clone`, so
    /// it is stored directly (not wrapped in another `Arc`). See
    /// [`ryu_realtime`].
    pub realtime: ryu_realtime::RoomRegistry,
    /// Authoritative CRDT document engine (Phase 3 of the multi-user epic). Holds a
    /// server-side `yrs` replica per LIVE collaborative document for persistence,
    /// late-joiner state-vector sync, and (dormant) per-quiescence materialization
    /// for the embed/search readers. Driven by the `kind:"document"` path of
    /// `GET /api/realtime/ws`: rehydrate + `SyncStep1` on join, write-ACL-gated
    /// apply + rebroadcast on update, flush-and-drop on last-leave. Cheap to clone
    /// (an `Arc` bag). See [`ryu_collab`].
    pub collab: ryu_collab::DocRegistry,
    /// Experience buffer (`~/.ryu/experience.db`) for the MetaClaw-style
    /// continual-learning loop: captured `(user, assistant)` turns + PRM scores,
    /// the dataset source for a reward-filtered LoRA retrain. Populated by
    /// sweeping conversations at cycle time (never on the chat hot path). Read by
    /// the `/api/learn/*` + `/api/experience/*` surface ([`crate::server::learning`]).
    pub experience: ryu_learning::ExperienceStore,
    /// Core-owned durable recursive-improvement records. Learning and Research
    /// carry correlation ids into this store; Core owns lifecycle persistence.
    pub improvements: ryu_improvement::ImprovementStore,
    /// Per-node Agent-UI template library. Templates are validated JSON over
    /// the closed catalog and resource-scoped by the HTTP handlers.
    pub agent_ui_templates: agent_ui_templates::AgentUiTemplateStore,
    /// Startup snapshot of the configured node-admittance token (`RYU_TOKEN`). Live
    /// auth surfaces resolve [`crate::node_token::active_token`] so rotation takes
    /// effect immediately; this field remains for state compatibility only.
    pub node_token: Option<String>,
}

/// Whether a bind address string (`host:port`, `host`, `[v6]:port`) resolves to a
/// non-loopback host (so this Core is reachable off-box even without the mesh).
/// Wildcard binds (`0.0.0.0` / `::`) count as non-loopback. An empty/unparseable
/// host is treated fail-closed (a hostname we can't resolve = assume reachable).
///
/// Pure + unit-testable: the caller resolves the bind from the same chain `main()`
/// uses (`--bind=` arg → `RYU_BIND` → default) and passes it here, so the gate can
/// never disagree with the actual listen address (the `--bind=` bypass, #478 V1).
pub(crate) fn host_is_non_loopback(bind: &str) -> bool {
    let bind = bind.trim();
    if bind.is_empty() {
        // No explicit bind = the loopback default `127.0.0.1:7980`.
        return false;
    }
    let host = bind.rsplit_once(':').map(|(h, _)| h).unwrap_or(bind);
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    match host {
        // An empty host (e.g. `:7980`) binds the wildcard → reachable off-box.
        "" => true,
        "127.0.0.1" | "::1" => false,
        // A wildcard bind is reachable off-box.
        "0.0.0.0" | "::" => true,
        other => other
            .parse::<std::net::IpAddr>()
            .map(|ip| !ip.is_loopback())
            // A hostname we can't parse — assume reachable (fail-closed).
            .unwrap_or(true),
    }
}
