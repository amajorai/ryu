use axum::{
    extract::{Path, State},
    http::{HeaderValue, Method, Request, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{delete, get, post, put},
    Json, Router,
};
use serde_json::json;
use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;

pub mod activity_api;
pub mod approvals_api;
pub mod auto_title;
pub mod chat_suggestions;
pub mod conversations;
pub mod dashboard_api;
pub mod data_admin;
pub mod finetune;
pub mod git;
pub mod hardware_api;
pub mod learning;
pub mod hardware_ws;
pub mod identity_api;
pub mod media;
pub mod meetings_api;
pub mod memory;
pub mod message_index;
pub mod message_fts;
pub mod monitors_api;
pub mod openapi;
pub mod predict_api;
pub mod preferences;
pub mod quests_api;
pub mod realtime_ws;
pub mod recipes_api;
pub mod retrieval;
pub mod spaces;
pub mod sync;
pub mod trace;
pub mod usage_api;
pub mod voice;
pub mod voice_ws;
pub mod worktree;

use crate::agents::{AgentStore, AgentTemplate, CreateAgent, UpdateAgent};
use crate::auth::AuthState;
use crate::plugins::PluginStore;
use crate::sidecar::adapters::{
    route_chat_stream, run_reply_text, run_team_reply_text, AcpAgentRegistry, ChatStreamRequest,
};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::onboarding::SetupManager;
use crate::sidecar::{install_state::InstallStatusStore, SidecarManager};
use crate::skills::{SkillRegistry, SkillSummary};
use crate::teams::{CreateTeam, UpdateTeam};
use conversations::{ConversationStore, Session, SessionStatus};
use memory::MemoryStore;
use preferences::PreferencesStore;
use retrieval::{ChunkSource, RetrievalStore};
use spaces::SpaceStore;
use trace::TraceStore;

/// A completed run's worktree state, kept alive until the user applies or
/// discards it. Holds both the diff (for display) and the live guard (for
/// apply). The guard is `None` after apply/cleanup; the diff is always present.
pub struct WorktreeRun {
    pub diff: worktree::WorktreeDiff,
    /// Live worktree guard — `Some` until apply is called, then `None`.
    pub guard: Option<worktree::WorktreeGuard>,
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
    /// Persisted agent **teams** (a named, ordered collection of agents + a
    /// coordination strategy). Backed by `~/.ryu/teams.db`. Addressed as one unit
    /// via `@team` in chat; orchestration lives in
    /// [`crate::sidecar::adapters::route_team_chat_stream`].
    pub teams: crate::teams::TeamStore,
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
    /// headroom plugin (`io.ryu.headroom`) is enabled/disabled so the gateway's
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
    /// Per-run observability trace store (M4 / issue #178). Persists ordered
    /// spans (tool-call, model-call) keyed by `conversation_id`.
    pub traces: TraceStore,
    /// Cross-surface key-value preferences (e.g. the shared theme blob). Backed
    /// by `~/.ryu/preferences.db` with a broadcast channel for live SSE updates,
    /// so the island companion stays in sync with the desktop's theme choice.
    pub preferences: PreferencesStore,
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
    /// Website-monitoring engine (price/content/stock/keyword/uptime). Owns the
    /// monitors store and runs checks; the scheduler fires each monitor on its
    /// interval via a `JobTarget::Monitor` job.
    pub monitors: crate::monitors::MonitorEngine,
    /// Meeting-notes engine (Granola/Notion-AI style): records a call, transcribes
    /// it live (reusing the voice STT path), and generates AI notes via the
    /// gateway. Owns the meetings store + the live SSE event stream. Audio capture
    /// is a device-bound sensor and lives in Shadow; Core only ingests chunks.
    pub meetings: crate::meetings::MeetingEngine,
    /// Quests engine (auto-detecting todo list): holds the quests store and runs
    /// each open quest's detection pass — gathering Shadow context and asking a
    /// judge model whether the task looks done. The scheduler fires each open
    /// quest on its interval via a `JobTarget::Quest` job. The judge call routes
    /// through the Gateway; nothing about the model is hardcoded.
    pub quests: crate::quests::QuestEngine,
    /// Home dashboards engine: holds the dashboards/widgets store and the live SSE
    /// stream. The background refresh loop resolves each widget's source on its
    /// interval and broadcasts fresh values. Decides *what data is pulled and how
    /// often* ⇒ Core; the model/tool calls a source makes route through the Gateway.
    pub dashboards: crate::dashboard::DashboardEngine,
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
    pub activity: crate::activity::ActivityStore,
    /// Optional mesh plane (#478): a thin handle over the Tailscale/Headscale
    /// status read path. The daemon itself is an opt-in Sidecar (never in
    /// `startup_order`); this handle backs `GET /api/mesh/status`.
    pub mesh: crate::mesh::MeshHandle,
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
    pub hardware: crate::hardware::store::DeviceStore,
    /// Room-keyed realtime fan-out registry (Phase 1 of the multi-user epic).
    /// Backs `GET /api/realtime/ws`: chat fan-out, presence/awareness, and
    /// (Phase 3) CRDT doc-sync all flow through per-room broadcast actors keyed
    /// by `conversation_id` / `document_id`. Already `Arc`-backed and `Clone`, so
    /// it is stored directly (not wrapped in another `Arc`). See
    /// [`crate::realtime`].
    pub realtime: crate::realtime::RoomRegistry,
    /// Authoritative CRDT document engine (Phase 3 of the multi-user epic). Holds a
    /// server-side `yrs` replica per LIVE collaborative document for persistence,
    /// late-joiner state-vector sync, and (dormant) per-quiescence materialization
    /// for the embed/search readers. Driven by the `kind:"document"` path of
    /// `GET /api/realtime/ws`: rehydrate + `SyncStep1` on join, write-ACL-gated
    /// apply + rebroadcast on update, flush-and-drop on last-leave. Cheap to clone
    /// (an `Arc` bag). See [`crate::collab`].
    pub collab: crate::collab::DocRegistry,
    /// Fine-tuning job store (`~/.ryu/finetune.db`) — Core's durable record of
    /// Unsloth fine-tune jobs. The training runs in the opt-in `unsloth` sidecar;
    /// this is the system-of-record for the job list (survives restarts). Read by
    /// the `/api/finetune/*` surface ([`crate::server::finetune`]).
    pub finetune: crate::finetune::FinetuneStore,
    /// Experience buffer (`~/.ryu/experience.db`) for the MetaClaw-style
    /// continual-learning loop: captured `(user, assistant)` turns + PRM scores,
    /// the dataset source for a reward-filtered LoRA retrain. Populated by
    /// sweeping conversations at cycle time (never on the chat hot path). Read by
    /// the `/api/learn/*` + `/api/experience/*` surface ([`crate::server::learning`]).
    pub experience: crate::experience::ExperienceStore,
    /// The configured node-admittance token (`RYU_TOKEN`), captured so the public
    /// `GET /api/realtime/ws` handler can enforce it in-handler (the public router
    /// has no `auth_token` request Extension, unlike the protected router's
    /// `require_auth`). `None`/empty = loopback dev (no token configured), where
    /// the upgrade is allowed without a token — mirrors [`require_auth`] semantics.
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

/// Fail-closed auth policy under mesh / remote bind (#478, security HIGH).
///
/// When the node is reachable beyond loopback — the mesh is on **or** the bind is
/// non-loopback — running without an auth token leaves every protected route open
/// to the tailnet/LAN. A log warning is not a control, so this **refuses** (Err)
/// rather than silently allowing. Returns the (possibly unchanged) token to use.
///
/// Pure + unit-testable: callers pass the resolved token, the mesh flag, and the
/// non-loopback-bind flag.
pub(crate) fn enforce_remote_auth(
    auth_token: Option<String>,
    mesh_enabled: bool,
    bind_non_loopback: bool,
) -> Result<Option<String>, String> {
    let exposed = mesh_enabled || bind_non_loopback;
    if exposed {
        let token = auth_token.as_deref().map(str::trim).unwrap_or("");
        if token.is_empty() {
            return Err(
                "refusing to start: RYU_MESH_ENABLED (or a non-loopback RYU_BIND) exposes this Core \
                 beyond loopback, but no RYU_TOKEN is set. Set RYU_TOKEN to a strong secret so \
                 protected routes are authenticated."
                    .to_owned(),
            );
        }
        if is_insecure_auth_token_placeholder(token) {
            return Err(
                "refusing to start: RYU_TOKEN is still a known placeholder. Generate a strong \
                 random token before exposing Core beyond loopback."
                    .to_owned(),
            );
        }
    }
    Ok(auth_token)
}

fn is_insecure_auth_token_placeholder(token: &str) -> bool {
    const PLACEHOLDERS: &[&str] = &[
        "CHANGE_ME",
        "CHANGEME",
        "REPLACE_ME",
        "REPLACEME",
        "YOUR_TOKEN_HERE",
        "TOKEN",
        "SECRET",
        "PASSWORD",
    ];

    let trimmed = token.trim();
    PLACEHOLDERS
        .iter()
        .any(|placeholder| trimmed.eq_ignore_ascii_case(placeholder))
}

async fn require_auth(
    req: Request<axum::body::Body>,
    next: middleware::Next,
) -> Result<axum::response::Response, StatusCode> {
    let expected = match req.extensions().get::<Option<String>>().cloned().flatten() {
        Some(t) => t,
        None => return Ok(next.run(req).await),
    };

    let provided = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);

    match provided {
        Some(t) if t == expected => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

/// Read a single trimmed, non-empty header value.
fn header_str(headers: &axum::http::HeaderMap, key: &str) -> Option<String> {
    headers
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Same, but percent-decoded — for fields that may carry non-ASCII (display
/// names, emails). Clients URL-encode these so the value is always a valid HTTP
/// header value regardless of the user's locale.
fn header_decoded(headers: &axum::http::HeaderMap, key: &str) -> Option<String> {
    header_str(headers, key).map(|raw| {
        urlencoding::decode(&raw)
            .map(std::borrow::Cow::into_owned)
            .unwrap_or(raw)
    })
}

/// Parse the self-declared caller identity from request headers (see
/// [`crate::connections`]). All fields are optional except `client_id`, which is
/// what makes a request trackable at all.
fn identity_from_headers(headers: &axum::http::HeaderMap) -> crate::connections::CallerIdentity {
    crate::connections::CallerIdentity {
        user_id: header_decoded(headers, "x-ryu-user-id"),
        user_name: header_decoded(headers, "x-ryu-user-name"),
        client_id: header_str(headers, "x-ryu-client-id").unwrap_or_default(),
        client_label: header_decoded(headers, "x-ryu-client-label"),
        surface: header_str(headers, "x-ryu-surface"),
    }
}

/// Middleware that records connected-client presence. Layered INSIDE
/// `require_auth` so only authenticated requests touch the registry (public
/// routes — health, version, auth — never pollute the "who's connected" view).
/// A request with no `x-ryu-client-id` is a no-op, so older clients that don't
/// send identity headers simply don't appear (they still work).
async fn track_connection(
    State(registry): State<crate::connections::ConnectionRegistry>,
    req: Request<axum::body::Body>,
    next: middleware::Next,
) -> axum::response::Response {
    let identity = identity_from_headers(req.headers());
    if identity.is_trackable() {
        registry.touch(&identity);
    }
    next.run(req).await
}

/// Header carrying the Better Auth **user** JWT (Phase 0 of the multi-user
/// epic). This is distinct from `authorization` (the shared `RYU_TOKEN`
/// node-admittance bearer enforced by [`require_auth`]): a remote client presents
/// BOTH — the bearer admits the node, this JWT carries the verified human
/// identity. Lower-case per the HTTP header-name convention.
const USER_JWT_HEADER: &str = "x-ryu-user-jwt";

/// Resolve the verified caller from the optional user JWT on the request.
///
/// Returns `None` (anonymous) when the header is absent OR the token fails
/// verification — failure is NEVER an error to the request, because `RYU_TOKEN`
/// is the gate and a missing/invalid user identity must simply be absent, never
/// spoofable-as-privileged. The JWT is verified entirely offline
/// (`crate::identity_verify`) and narrowed to THIS node's bound org.
async fn verified_caller_from_headers(
    headers: &axum::http::HeaderMap,
) -> Option<crate::identity_verify::VerifiedCaller> {
    let token = header_str(headers, USER_JWT_HEADER)?;
    verified_caller_from_token(&token).await
}

/// Verify a raw user-JWT string and narrow it to THIS node's org, returning the
/// anonymous case (`None`) on any failure — never an error. Factored out of
/// [`verified_caller_from_headers`] so non-REST transports (the realtime WS
/// gateway, which receives the JWT via a `?jwt=` query param because browsers
/// cannot set custom headers on a WS upgrade) reuse the exact same Phase 0 verify
/// + org-narrowing path.
pub(crate) async fn verified_caller_from_token(
    token: &str,
) -> Option<crate::identity_verify::VerifiedCaller> {
    match crate::identity_verify::verify_jwt(token).await {
        Ok(claims) => {
            // This node's org binding (managed-node registration result). When the
            // node is unbound (local/dev), fall back to the user's sole membership
            // if they have exactly one — a single-org user has no ambiguity. With
            // zero or many memberships and no node binding, the caller has no org
            // context (org_id = None), which fails closed for org-scoped checks.
            // TODO: resolve node org binding for unmanaged nodes more precisely
            // once a node↔org config exists for self-hosted multi-user.
            let node_org = crate::sidecar::control_plane::registered_org()
                .map(|o| o.id)
                .or_else(|| match claims.orgs.as_slice() {
                    [single] => Some(single.id.clone()),
                    _ => None,
                });
            Some(crate::identity_verify::to_caller_for_org(
                &claims,
                node_org.as_deref(),
            ))
        }
        Err(e) => {
            tracing::debug!("user JWT verification failed (treated as anonymous): {e}");
            None
        }
    }
}

/// Middleware that attaches the OPTIONAL verified user identity to the request.
///
/// Layered INSIDE [`require_auth`] (so only node-admitted requests do JWT work)
/// and ALWAYS inserts an `Option<VerifiedCaller>` extension — `Some` when a valid
/// user JWT is present, `None` otherwise. It never rejects: a missing/invalid JWT
/// yields the anonymous (single-tenant/loopback) flow unchanged. Requests without
/// the `x-ryu-user-jwt` header short-circuit before any verification, so this is
/// zero-overhead on the common single-tenant path.
async fn attach_verified_caller(
    mut req: Request<axum::body::Body>,
    next: middleware::Next,
) -> axum::response::Response {
    let caller = verified_caller_from_headers(req.headers()).await;
    req.extensions_mut().insert(caller);
    next.run(req).await
}

/// `GET /api/connections` — the clients currently connected to THIS node.
///
/// Presence/attribution only: identities are self-declared behind the shared
/// token and the data model is single-tenant, so this answers "who is here", not
/// "who is allowed to see what" (see [`crate::connections`]). `user_count` counts
/// distinct declared users (anonymous clients each count once by `client_id`).
async fn list_connections(State(state): State<ServerState>) -> impl IntoResponse {
    let ttl = crate::connections::DEFAULT_TTL_SECS;
    let clients = state.connections.list_active(ttl);
    let user_count = clients
        .iter()
        .map(|c| {
            c.user_id
                .clone()
                .unwrap_or_else(|| format!("client:{}", c.client_id))
        })
        .collect::<std::collections::HashSet<_>>()
        .len();
    Json(json!({
        "object": "list",
        "data": clients,
        "client_count": clients.len(),
        "user_count": user_count,
        "ttl_secs": ttl,
    }))
}

// ── Data folder ("Storage" setting) ──────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct DataPathTarget {
    path: String,
}

#[derive(serde::Deserialize)]
struct DataPathExportReq {
    out: String,
}

/// `GET /api/data-path` — current data-folder location, default, size, free space.
/// All path logic lives in Core (`crate::data_path`); the desktop only renders it.
async fn get_data_path() -> impl IntoResponse {
    match tokio::task::spawn_blocking(crate::data_path::info).await {
        Ok(info) => Json(info).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/data-path/validate` — check a candidate target folder (writable,
/// empty, not nested in the current folder, enough free space for a copy).
async fn validate_data_path(Json(req): Json<DataPathTarget>) -> impl IntoResponse {
    let target = std::path::PathBuf::from(&req.path);
    let res = tokio::task::spawn_blocking(move || {
        crate::data_path::validate_target(&crate::paths::ryu_dir(), &target, true)
    })
    .await;
    match res {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/data-path/switch` — point-only relocation (NO copy). Writes the
/// pointer; takes effect on the next Core restart. The old data stays intact, so
/// this is the "start fresh in a new folder" path. (Copy-and-migrate runs as the
/// offline `data-path migrate` subcommand the desktop invokes while Core is down.)
async fn switch_data_path(Json(req): Json<DataPathTarget>) -> impl IntoResponse {
    let target = std::path::PathBuf::from(&req.path);
    let v = crate::data_path::validate_target(&crate::paths::ryu_dir(), &target, false);
    if !v.ok {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": v.error })),
        )
            .into_response();
    }
    match crate::paths::set_data_dir(Some(&target)) {
        Ok(()) => Json(json!({ "ok": true, "restart_required": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/data-path/reset` — revert to the default `~/.ryu` (point-only).
async fn reset_data_path() -> impl IntoResponse {
    match crate::paths::set_data_dir(None) {
        Ok(()) => Json(json!({ "ok": true, "restart_required": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/data-path/export` — zip the current data folder to `out`. Read-only
/// on the data folder, so it runs online (no restart). Import/restore is offline
/// (the `data-path import` subcommand) because it overwrites the live DB files.
async fn export_data_path(Json(req): Json<DataPathExportReq>) -> impl IntoResponse {
    let out = std::path::PathBuf::from(&req.out);
    let res = tokio::task::spawn_blocking(move || {
        crate::data_path::export_zip(&crate::paths::ryu_dir(), &out)
    })
    .await;
    match res {
        Ok(Ok(bytes)) => Json(json!({ "ok": true, "bytes": bytes })).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub fn create_router(state: ServerState, auth_token: Option<String>, bind_addr: &str) -> Router {
    // Fail-closed under mesh / remote bind (#478): a node reachable beyond
    // loopback MUST have an auth token, or every protected route is open to the
    // tailnet/LAN. Refuse to build the router (which stops startup) otherwise.
    // The non-loopback decision uses the SAME `bind_addr` `main()` actually
    // listens on (resolved from `--bind=` → `RYU_BIND` → default), so the
    // `--bind=0.0.0.0` flag can no longer bypass the gate (#478 V1).
    let auth_token = match enforce_remote_auth(
        auth_token,
        crate::mesh::is_enabled(),
        host_is_non_loopback(bind_addr),
    ) {
        Ok(t) => t,
        Err(msg) => panic!("{msg}"),
    };

    // The presence registry is shared between the tracking middleware (as its
    // state) and `GET /api/connections` (via `ServerState`); clone the handle out
    // before `state` is moved into `.with_state(state)` below.
    let connections = state.connections.clone();

    // CORS: allow the Desktop webview (dev + prod), localhost dev servers, and
    // the hosted web app. `apps/webapp` is local-first: even when served from
    // https://app.ryuhq.com the browser talks DIRECTLY to the user's LOCAL Core
    // on 127.0.0.1:7980. That is both cross-origin (origin = app.ryuhq.com) and a
    // private-network request (public page → loopback), so we must (a) list
    // app.ryuhq.com as an allowed origin AND (b) enable `allow_private_network`
    // so Chrome's Private Network Access preflight succeeds. Extra origins (e.g.
    // a staging web host) can be added without a rebuild via RYU_CORS_ORIGINS
    // (comma-separated).
    let mut cors_origins: Vec<HeaderValue> = [
        "http://localhost:5173",   // desktop vite dev
        "http://localhost:5174",   // webapp vite dev
        "http://127.0.0.1:5173",   // desktop vite dev (127 variant)
        "http://127.0.0.1:5174",   // webapp vite dev (127 variant)
        "http://localhost:1420",   // tauri dev
        "tauri://localhost",       // tauri prod (macOS/Linux)
        "https://tauri.localhost", // tauri prod (Windows)
        "https://app.ryuhq.com",   // hosted web app → local Core
    ]
    .into_iter()
    .filter_map(|origin| origin.parse::<HeaderValue>().ok())
    .collect();
    if let Ok(extra) = std::env::var("RYU_CORS_ORIGINS") {
        cors_origins.extend(
            extra
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .filter_map(|origin| origin.parse::<HeaderValue>().ok()),
        );
    }
    let cors = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(tower_http::cors::Any)
        .allow_private_network(true)
        .allow_origin(cors_origins);

    let public = Router::new()
        .route("/api/health", get(health))
        // Generated OpenAPI spec for this Core (public so docs tooling can fetch it).
        .route("/api/openapi.json", get(openapi::serve_openapi))
        // ── Version + update verdict (read-only, public so every surface —
        // including the unauthenticated extension/cli — can show the toast) ──
        .route("/api/version", get(get_version))
        .route("/api/update/check", get(update_check))
        .route("/api/node/init", post(node_init))
        // Auth routes — no RYU_TOKEN required (Desktop must be able to call these).
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/logout", post(auth_logout))
        // ── Ryu Hardware Protocol (RHP v1) public surface ────────────────────
        // The realtime device link: a device presents a PER-DEVICE Bearer token,
        // which `require_auth` (which only knows the global RYU_TOKEN) would
        // reject — so the WS handler authenticates the device token against the
        // registry itself. Pairing is nonce-gated (the proof-of-possession is the
        // device's QR/BLE nonce), so it is public too. Device management
        // (list/patch/delete) is protected — see the protected router below.
        .route("/api/hardware/ws", get(hardware_ws::hardware_ws))
        // ── Realtime room gateway (Phase 1 multi-user epic) ──────────────────
        // Room-keyed fan-out for live chat / presence / (Phase 3) doc-sync. On
        // the PUBLIC router because the upgrade carries credentials the protected
        // `require_auth` layer can't gate the way this handler needs: the node
        // token + an OPTIONAL user JWT both ride query params (`?token=`/`?jwt=`)
        // because browsers cannot set custom headers on a WS upgrade. The handler
        // enforces `RYU_TOKEN` (if configured) at upgrade and resolves the
        // verified caller in-handler before joining a room — mirroring the
        // auth-in-handler pattern of `/api/hardware/ws`.
        .route("/api/realtime/ws", get(realtime_ws::realtime_ws))
        // Realtime voice mode (desktop/island). Public router, auth-in-handler
        // (browser WS can't set the bearer header) — mirrors the two routes above.
        .route("/api/voice/ws", get(voice_ws::voice_ws))
        .route("/api/hardware/pair", post(hardware_api::pair_device))
        // TRMNL display surface: the device polls these with its OWN per-device
        // Bearer token (which `require_auth`/global-RYU_TOKEN can't gate), so the
        // handlers authenticate the device token against the registry themselves —
        // the same model as the WS upgrade. Hence: public router.
        .route(
            "/api/hardware/display/:device_id",
            get(hardware_api::display_manifest),
        )
        .route(
            "/api/hardware/display/:device_id/image",
            get(hardware_api::display_image),
        )
        // Inbound Composio webhook: public (external delivery can't send the bearer
        // token) but HMAC-authenticated fail-closed inside the handler.
        .route("/api/composio/webhook", post(composio_webhook));

    let protected = Router::new()
        .route("/api/catalog", get(get_catalog))
        // ── Model catalog (HF browse + device-fit + install; logic in Core) ──
        .route("/api/models/catalog", get(models_catalog_list))
        .route("/api/models/catalog/detail", get(models_catalog_detail))
        .route("/api/models/catalog/install", post(models_catalog_install))
        .route(
            "/api/models/catalog/uninstall",
            post(models_catalog_uninstall),
        )
        .route("/api/models/device", get(models_device))
        .route("/api/models/llmfit-estimate", get(models_llmfit_estimate))
        .route("/api/models/engines", get(models_engines))
        .route("/api/models/installed", get(models_installed))
        // Live hardware snapshot for this node (CPU/RAM/disk/GPU) — backs the
        // desktop node selector's per-node "what's this machine" view.
        .route("/api/system/info", get(system_info_handler))
        // Per-model advanced launch config (#mtp-advanced-inference). The `{id}` is
        // a catalog model id and may contain a slash, so clients must
        // percent-encode it (`encodeURIComponent`); axum decodes `%2F` into the
        // single `:id` segment.
        .route(
            "/api/models/:id/launch-config",
            get(get_model_launch_config).put(set_model_launch_config),
        )
        // ── CatalogSource seam (#459): per-kind source listing + custom add +
        // active selection. The catalogs themselves route through these sources.
        .route(
            "/api/catalog/sources",
            get(catalog_sources_list).post(catalog_sources_add),
        )
        .route("/api/catalog/sources/select", post(catalog_sources_select))
        // ── Skills catalog (browse + install from skills.sh; logic in Core) ──
        .route("/api/skills/catalog", get(skills_catalog_list))
        .route("/api/skills/catalog/detail", get(skills_catalog_detail))
        .route("/api/skills/catalog/install", post(skills_catalog_install))
        .route(
            "/api/skills/install-from-source",
            post(skills_install_from_source),
        )
        .route("/api/skills/activate", post(skills_activate))
        // ── Composio catalog (browse the user's toolkits/actions/triggers using
        // their configured key; gateway still executes — see composio_catalog) ──
        .route("/api/composio/status", get(composio_status))
        .route("/api/composio/toolkits", get(composio_toolkits))
        .route("/api/composio/actions", get(composio_actions))
        .route("/api/composio/triggers", get(composio_triggers))
        // Composio connections — proactively connect the user's accounts to a
        // toolkit (Marketplace → Connections), ahead of any agent run.
        .route("/api/composio/connections", get(composio_connections))
        .route(
            "/api/composio/connections/initiate",
            post(composio_connection_initiate),
        )
        .route(
            "/api/composio/connections/:id",
            get(composio_connection_status),
        )
        // Composio event-trigger subscriptions (fire an agent on a Composio event).
        .route(
            "/api/composio/triggers/subscribe",
            post(composio_trigger_subscribe),
        )
        .route(
            "/api/composio/trigger-subscriptions",
            get(composio_trigger_list),
        )
        .route(
            "/api/composio/trigger-subscriptions/:id",
            delete(composio_trigger_delete),
        )
        .route("/api/engines", get(list_engines))
        .route("/api/engines/models", get(engine_models))
        // ── Plugin catalog browse + install-from-URL + hot-reload (#427, #428) ──
        // Static 3-segment routes registered before the parameterized
        // `/api/plugins/:id/*` routes so matchit never confuses them.
        .route("/api/plugins", get(list_apps))
        .route("/api/plugins/contributions", get(plugin_contributions))
        .route("/api/plugins/catalog", get(list_apps_catalog))
        .route("/api/plugins/install", post(install_app_from_url))
        .route("/api/plugins/reload", post(reload_app_manifests))
        .route("/api/plugins/:id/install", post(install_app_handler))
        .route("/api/plugins/:id/enable", post(enable_app_handler))
        .route("/api/plugins/:id/disable", post(disable_app_handler))
        .route("/api/plugins/:id/update", post(update_app_handler))
        // ── DEPRECATED `/api/apps*` aliases (one-release back-compat for #457) ──
        // These point at the same handlers as `/api/plugins*` and exist only so
        // clients that have not yet migrated keep working. Remove after one
        // release once all clients use `/api/plugins*`.
        .route("/api/apps", get(list_apps))
        .route("/api/apps/catalog", get(list_apps_catalog))
        .route("/api/apps/install", post(install_app_from_url))
        .route("/api/apps/reload", post(reload_app_manifests))
        .route("/api/apps/:id/install", post(install_app_handler))
        .route("/api/apps/:id/enable", post(enable_app_handler))
        .route("/api/apps/:id/disable", post(disable_app_handler))
        .route("/api/apps/:id/update", post(update_app_handler))
        .route("/api/skills", get(list_skills))
        .route("/api/agents", get(list_agents).post(create_agent))
        .route("/api/agents/catalog", get(list_agent_catalog))
        .route("/api/agents/catalog/install", post(install_agent_handler))
        .route(
            "/api/agents/catalog/uninstall",
            post(uninstall_agent_handler),
        )
        .route("/api/agents/import", post(import_agent))
        .route(
            "/api/agents/:id",
            get(get_agent).put(update_agent).delete(delete_agent),
        )
        .route("/api/agents/:id/export", get(export_agent))
        .route("/api/agents/:id/tools", get(list_tools))
        .route("/api/agents/:id/migrate-to-ryu", post(migrate_to_ryu))
        // ── Import a past thread from an agent's own on-disk history store
        //    (Claude Code / Codex), Zed/VS Code parity. List, then import one
        //    into a Ryu conversation. ──
        .route("/api/agents/:id/threads", get(list_agent_threads_handler))
        .route(
            "/api/agents/:id/threads/import",
            post(import_agent_thread_handler),
        )
        // ── ACP session config (agent-reported permission modes / models /
        //    config options like reasoning effort), Zed-style ──
        .route("/api/agents/:id/acp-config", get(acp_config))
        .route("/api/agents/:id/authenticate", post(acp_authenticate))
        .route("/api/agents/:id/logout", post(acp_logout))
        .route("/api/agents/:id/sessions", get(list_acp_sessions_handler))
        .route(
            "/api/agents/:id/sessions/:sid",
            delete(delete_acp_session_handler),
        )
        .route(
            "/api/agents/:id/sessions/:sid/load",
            post(load_acp_session_handler),
        )
        .route("/api/agents/:id/update-check", get(agent_update_check))
        .route("/api/agents/:id/update", post(agent_update))
        // ── Per-agent subscription usage (5h + weekly rate-limit windows read
        //    from the CLI's own local OAuth token, à la CodexBar/openusage).
        //    Backs the chat "usage bar"; Claude + Codex in v1. ──
        .route("/api/agents/:id/usage", get(usage_api::agent_usage))
        // ── Per-agent capabilities (tools / reasoning / vision), Jan-style.
        //    GET resolves auto-detection + overrides; PUT persists overrides. ──
        .route(
            "/api/agents/:id/capabilities",
            get(agent_capabilities).put(set_agent_capabilities),
        )
        // ── Ryu-managed Pi config (isolated model/provider config) ──
        .route("/api/pi-config", get(get_pi_config).put(put_pi_config))
        .route("/api/pi-config/catalog", get(get_pi_config_catalog))
        .route("/api/pi-config/providers", post(configure_pi_provider))
        .route("/api/pi-config/providers/:id", delete(delete_pi_provider))
        .route("/api/pi-config/discover-models", post(discover_pi_models))
        // ── Agent teams (collections of agents + a coordination strategy) ──
        .route("/api/teams", get(list_teams).post(create_team))
        .route(
            "/api/teams/:id",
            get(get_team).patch(update_team).delete(delete_team),
        )
        .route("/api/teams/:id/members", post(add_team_member))
        .route(
            "/api/teams/:id/members/:agent_id",
            delete(remove_team_member),
        )
        .route(
            "/api/mcp/servers",
            get(list_mcp_servers).post(create_mcp_server),
        )
        .route("/api/mcp/tools", get(list_mcp_tools))
        .route("/api/mcp/tools/call", post(call_mcp_tool))
        // ── Unified tool catalog: search + describe (#474) ───────────────────
        .route("/api/tools/search", get(tools_search))
        .route("/api/tools/describe", get(tools_describe))
        // ── Programmatic tool calling sandbox (#476, P4) ──────────────────────
        .route("/api/tools/exec", post(tools_exec))
        .route("/api/tools/exec/resume", post(tools_exec_resume))
        // ── Identity Vault: connection lifecycle (#520) ──────────────────────
        // Status-only responses; sealed credential state is never returned.
        .route("/api/identities", get(identity_api::list_identities))
        .route(
            "/api/identities/connections",
            post(identity_api::create_connection),
        )
        .route(
            "/api/identities/connections/:id/login",
            post(identity_api::begin_login),
        )
        .route(
            "/api/identities/connections/:id/import",
            post(identity_api::import_connection),
        )
        .route(
            "/api/identities/connections/:id",
            get(identity_api::poll_connection).delete(identity_api::delete_connection),
        )
        // ── Mesh status (#478): opt-in Tailscale/Headscale reachability ───────
        .route("/api/mesh/status", get(mesh_status))
        // ── Webhook ingress seam (#479, P6a): public URL status + backend ─────
        .route("/api/webhook-ingress/status", get(webhook_ingress_status))
        .route(
            "/api/webhook-ingress/backend",
            get(webhook_ingress_get_backend).post(webhook_ingress_set_backend),
        )
        // ── MCP catalog (browse + install from the official MCP registry; #464) ──
        .route("/api/mcp/catalog", get(mcp_catalog_list))
        .route("/api/mcp/catalog/detail", get(mcp_catalog_detail))
        .route("/api/mcp/catalog/install", post(mcp_catalog_install))
        // ── Knowledge catalog (browse + install OKF bundles via the okf module) ──
        .route("/api/knowledge/catalog", get(knowledge_catalog_list))
        .route(
            "/api/knowledge/catalog/detail",
            get(knowledge_catalog_detail),
        )
        .route(
            "/api/knowledge/catalog/install",
            post(knowledge_catalog_install),
        )
        // ── OKF export (emit Ryu's own indexed knowledge as an OKF bundle) ──
        .route("/api/okf/export", post(okf_export))
        // ── Sandbox enable/disable toggle (M6 / issue #190) ──────────────────
        .route("/api/mcp/sandbox/enable", post(sandbox_enable))
        .route("/api/mcp/sandbox/disable", post(sandbox_disable))
        .route("/api/mcp/sandbox/status", get(sandbox_status))
        .route("/api/chat/stream", post(chat_stream))
        // Resolve an interactive tool-permission prompt raised mid-turn by an
        // ACP agent (the desktop echoes the chosen option id here to unblock it).
        .route("/api/chat/permission", post(chat_permission))
        .route("/api/chat/cancel", post(chat_cancel))
        // Resume a running chat stream (reconnect to an in-flight ACP turn).
        .route("/api/chat/stream/resume/:conversation_id", get(chat_stream_resume))
        // Next-prompt suggestions (ChatGPT-style follow-up chips) for a turn.
        .route(
            "/api/chat/suggestions",
            post(chat_suggestions::chat_suggestions),
        )
        // ── Channel bot run endpoint (M11 / #226) ───────────────────────────
        // Channel bots (Telegram, Slack, etc.) call this to turn a single inbound
        // text message into an assembled reply, using the Core session/memory path
        // so bot turns share conversation history with the Core conversation store.
        .route("/api/channels/run", post(channel_run))
        .route("/api/retrieval/index", post(index_retrieval_chunk))
        .route("/api/retrieval/search", post(search_retrieval))
        // ── Danger zone: irreversible bulk "delete all X" (settings) ─────────
        .route("/api/data/counts", get(data_admin::data_counts))
        .route("/api/data/clear", post(data_admin::data_clear))
        .route("/api/conversations", get(list_conversations))
        // Semantic search over past chat messages (the `search_conversations`
        // capability). Static segment registered before `:id` so it never
        // resolves as a conversation id.
        .route(
            "/api/conversations/search",
            get(search_conversations_handler),
        )
        .route(
            "/api/conversations/:id",
            get(get_conversation).delete(delete_conversation),
        )
        .route(
            "/api/conversations/:id/participants",
            get(get_participants_handler).post(add_participant_handler),
        )
        // Branch (fork) a conversation into a new chat, ChatGPT-style.
        .route("/api/conversations/:id/fork", post(fork_conversation))
        // Pin / archive a conversation. Server-backed so coordinator-thread
        // pins/archives and desktop pins share one source of truth and sync
        // across clients (the same columns the `threads` tool writes).
        .route(
            "/api/conversations/:id/pinned",
            post(set_conversation_pinned_handler),
        )
        .route(
            "/api/conversations/:id/archived",
            post(set_conversation_archived_handler),
        )
        // Manual rename (ChatGPT/Claude-style). Marks the title user-chosen so the
        // background auto-namer leaves it alone.
        .route(
            "/api/conversations/:id/title",
            post(set_conversation_title_handler),
        )
        // Goal + double-check are now plugins (io.ryu.goal / io.ryu.double-check)
        // driven by the plugin turn-hook runtime; their old Core endpoints are
        // removed. See docs/plugin-runtime.md.
        // ── Side questions (`/btw`): answer over the conversation, persisted as
        //    a listable "side chat" keyed to its parent conversation ──────────
        .route("/api/btw", post(btw_handler))
        .route("/api/btw/:id", axum::routing::delete(delete_btw_handler))
        .route("/api/conversations/:id/btw", get(list_btw_handler))
        // ── Predictive typing: system-wide inline autocomplete brain ──────────
        .route(
            "/api/predict/config",
            get(predict_api::get_config).put(predict_api::put_config),
        )
        .route("/api/predict/complete", post(predict_api::complete))
        .route(
            "/api/conversations/:id/participants/:agent_id",
            axum::routing::delete(remove_participant_handler),
        )
        // ── Background-runs list + per-run trace (issues #128, #178) ────────
        .route("/api/runs", get(list_runs_handler))
        .route("/api/runs/stream", get(runs_stream))
        .route("/api/runs/:id/trace", get(get_run_trace_handler))
        .route("/api/sessions", post(create_session_handler))
        .route("/api/sessions/:id", get(get_session_handler))
        .route(
            "/api/sessions/:id/status",
            post(update_session_status_handler),
        )
        .route(
            "/api/conversations/:id/sessions",
            get(list_sessions_for_conversation_handler),
        )
        .route("/api/spaces", get(list_spaces).post(create_space))
        .route("/api/spaces/:id", axum::routing::delete(delete_space))
        .route(
            "/api/spaces/:id/documents",
            get(list_documents).post(ingest_document),
        )
        .route("/api/spaces/:id/pages", post(create_page))
        .route("/api/spaces/:id/databases", post(create_database))
        .route(
            "/api/spaces/:id/documents/:doc_id",
            get(get_document)
                .put(update_document)
                .delete(delete_document),
        )
        .route("/api/spaces/:id/search", post(search_space))
        // Embedding-model config + re-index (global, not per-space → own prefix so
        // the literal segments never collide with `/api/spaces/:id`).
        .route(
            "/api/embeddings/model",
            get(get_embedding_model).post(set_embedding_model),
        )
        .route("/api/embeddings/reindex", post(trigger_reindex))
        .route("/api/embeddings/reindex/status", get(reindex_status))
        .route("/v1/chat/completions", post(oai_chat_completions))
        .route("/api/setup/list", get(list_installed))
        .route("/api/setup/status", get(get_install_status))
        .route("/api/setup/status/:name", get(get_install_status_by_name))
        .route("/api/setup/:name/install", post(install_sidecar))
        .route("/api/setup/:name/uninstall", post(uninstall_sidecar))
        // ── Global download center (#456): unified progress + control across
        // every artifact. SSE `stream` registered before the `:id/*` routes so
        // the static segment is matched first. ─────────────────────────────────
        .route("/api/downloads", get(list_downloads))
        .route("/api/downloads/stream", get(downloads_stream))
        .route("/api/downloads/:id/pause", post(download_pause))
        .route("/api/downloads/:id/resume", post(download_resume))
        .route("/api/downloads/:id/retry", post(download_retry))
        .route("/api/downloads/:id/cancel", post(download_cancel))
        .route("/api/downloads/:id", axum::routing::delete(download_clear))
        .route(
            "/api/setup/:name/uninstall-with-data",
            post(uninstall_sidecar_with_data),
        )
        .route("/api/setup/check/:name", get(check_installed))
        .route("/api/dependencies/check", get(check_dependencies))
        .route("/api/dependencies/install", post(install_dependencies))
        .route("/api/sidecar/status", get(sidecar_status))
        .route("/api/system/status", get(system_status))
        // Local support-access diagnostic channel (#546, P5). The diagnostics
        // endpoint is gated on the user grant + hard expiry IN the handler (so a
        // refusal is itself audited); the audit log is always readable.
        .route(
            "/api/support-access/diagnostics",
            get(support_access_diagnostics),
        )
        .route("/api/support-access/audit", get(support_access_audit))
        .route("/api/sidecar/start-all", post(sidecar_start_all))
        .route("/api/sidecar/stop-all", post(sidecar_stop_all))
        .route("/api/sidecar/:name/start", post(sidecar_start))
        .route("/api/sidecar/:name/stop", post(sidecar_stop))
        .route("/api/sidecar/:name/restart", post(sidecar_restart))
        .route(
            "/api/engine/active",
            get(get_active_engine).post(set_active_engine),
        )
        // Sandbox (code-execution) backend default. Unlike the engine swap, this
        // is a *default* the agent's `sandbox_exec` tool uses when no per-call
        // backend is given — backends coexist, they are not mutually exclusive.
        .route(
            "/api/sandbox/backend",
            get(get_sandbox_backend).post(set_sandbox_backend),
        )
        // Active *served model* (which installed GGUF the local engine loads),
        // distinct from the active engine runtime above. Backs the deep-link
        // "switch" / "Use this model" flow.
        .route(
            "/api/models/active",
            get(get_active_model).post(set_active_model),
        )
        // ── Voice engine data path (STT) — proxies audio to whisper.cpp ──────
        .route("/api/voice/transcribe", post(voice::transcribe))
        // ── Voice engine data path (TTS) — OuteTTS (built-in) or ?engine= via
        //    the universal Ryu TTS sidecar ────────────────────────────────────
        .route("/api/voice/speak", post(voice::speak))
        .route("/api/voice/tts-engines", get(voice::tts_engines))
        // Curated, installable TTS model catalog (voicebox-style) + install via
        // the Core-managed HF cache. Distinct from the raw HF text-to-speech
        // browse in the Models tab.
        .route("/api/voice/tts-models", get(voice::tts_models))
        .route(
            "/api/voice/tts-models/install",
            post(voice::tts_models_install),
        )
        // ── Fine-tuning data path (Unsloth) — proxies job control to the
        //    `unsloth` Python sidecar; gates local training on the node's GPU ──
        .route("/api/finetune/capability", get(finetune::capability))
        .route("/api/finetune/start", post(finetune::start))
        .route("/api/finetune/list", get(finetune::list))
        .route("/api/finetune/adapters", get(finetune::list_adapters))
        .route("/api/finetune/merge", post(finetune::merge))
        .route(
            "/api/finetune/:id",
            get(finetune::get).delete(finetune::cancel),
        )
        .route("/api/finetune/:id/stream", get(finetune::stream))
        // ── Continual-learning loop (experience buffer + PRM + skill synthesis) ──
        .route("/api/learn/config", get(learning::config))
        .route("/api/learn/sweep", post(learning::sweep))
        .route("/api/learn/score", post(learning::score))
        .route("/api/learn/synthesize", post(learning::synthesize))
        .route("/api/learn/cycle", post(learning::cycle))
        .route("/api/learn/exclude", post(learning::exclude))
        .route("/api/experience/list", get(learning::list))
        // ── Generative-media data path (image/video) — proxies to sd-server ──
        .route("/api/images/generate", post(media::generate_image))
        .route("/api/video/generate", post(media::generate_video))
        // Poll a cloud video-generation job (job-based; see media::generate_video)
        .route("/api/video/jobs/:id", get(media::poll_video_job))
        .route(
            "/api/media/upload",
            post(media::upload_media)
                .layer(axum::extract::DefaultBodyLimit::max(media::MAX_MEDIA_BYTES)),
        )
        .route("/api/media/:file", get(media::serve_media))
        // ── Git workspace status (read-only, Unit U009) ─────────────────────
        .route("/api/git/status", get(git::git_status))
        // ── Git branch list + switch (composer branch selector) ─────────────
        .route("/api/git/branches", get(git::git_branches))
        .route("/api/git/checkout", post(git::git_checkout))
        .route("/api/git/create-branch", post(git::git_create_branch))
        // ── Git commit + push (pinned-summary "commit & push" button) ───────
        .route("/api/git/commit-push", post(git::git_commit_push))
        // ── Create a new project folder ("Start from scratch") ──────────────
        .route("/api/workspace/new-folder", post(git::create_project_folder))
        // ── Worktree diff (read-only, Unit U011) ────────────────────────────
        .route("/api/worktree/:run_id/diff", get(worktree_diff_handler))
        // ── Worktree status (persistent-session: is a worktree live?) ───────
        .route("/api/worktree/:run_id/status", get(worktree_status_handler))
        // ── Worktree apply (commit+merge or PR, Unit U012) ──────────────────
        .route("/api/worktree/:run_id/apply", post(worktree_apply_handler))
        // ── Gateway config read/write + status proxy (M2 / U017 / U018) ──────
        .route(
            "/api/gateway/config",
            get(gateway_get_config).put(gateway_put_config),
        )
        .route("/api/gateway/status", get(gateway_status))
        // ── Local-engine admission-queue depth (batching/queue observability) ──
        .route("/api/engine/concurrency", get(engine_concurrency))
        // ── BYOK provider-key vault (Unit U026) ──────────────────────────────
        .route("/api/gateway/providers", put(gateway_set_provider))
        // ── Gateway eval dataset runner proxy (M4 / #180) ───────────────────
        .route("/api/gateway/evals/run", post(gateway_run_evals))
        // ── Gateway audit proxy (M4 / #177) ─────────────────────────────────
        .route("/api/gateway/audit", get(gateway_audit))
        // ── Workflows (DAG engine) ──────────────────────────────────────────
        .route("/workflows", get(list_workflows).post(create_workflow))
        .route("/workflows/:id", get(get_workflow).delete(delete_workflow))
        .route("/workflows/:id/run", post(run_workflow))
        .route("/workflows/runs/:run_id", get(get_workflow_run))
        .route("/workflows/runs/:run_id/resume", post(resume_workflow_run))
        // ── Activity feed (unified cross-module timeline) ───────────────────
        // The SSE `stream` route is registered before the collection route (no
        // `:id` routes exist here, but the convention is preserved).
        .route(
            "/api/activity/stream",
            get(activity_api::activity_stream),
        )
        .route(
            "/api/activity",
            get(activity_api::list_activity).post(activity_api::create_activity),
        )
        // ── Website monitors (price/content/stock/keyword/uptime) ───────────
        // Static segments (`alerts`, `push-tokens`) are registered before the
        // `:id` routes so they match first.
        .route(
            "/api/monitors/alerts/stream",
            get(monitors_api::alerts_stream),
        )
        .route(
            "/api/events/notifications/stream",
            get(notifications_stream),
        )
        // Unified multiplex of every feature event bus over ONE connection so the
        // desktop stays within the browser's 6-per-host HTTP/1.1 budget.
        .route("/api/events/all", get(all_events_stream))
        .route("/api/monitors/alerts", get(monitors_api::list_all_alerts))
        .route(
            "/api/monitors/alerts/:id/ack",
            post(monitors_api::ack_alert),
        )
        .route(
            "/api/monitors/push-tokens",
            post(monitors_api::register_push_token),
        )
        .route(
            "/api/monitors/push-tokens/:token",
            delete(monitors_api::remove_push_token),
        )
        .route(
            "/api/monitors",
            get(monitors_api::list_monitors).post(monitors_api::create_monitor),
        )
        .route(
            "/api/monitors/:id",
            get(monitors_api::get_monitor)
                .put(monitors_api::update_monitor)
                .delete(monitors_api::delete_monitor),
        )
        .route("/api/monitors/:id/run", post(monitors_api::run_monitor))
        .route(
            "/api/monitors/:id/snapshots",
            get(monitors_api::list_snapshots),
        )
        .route(
            "/api/monitors/:id/alerts",
            get(monitors_api::list_monitor_alerts),
        )
        // ── Approval inbox (human-in-the-loop) ──────────────────────────────
        // Static `events` / `mode` registered before `:id` so they match first.
        .route("/api/approvals/events", get(approvals_api::approval_events))
        .route(
            "/api/approvals/mode",
            get(approvals_api::get_mode).put(approvals_api::set_mode),
        )
        .route("/api/approvals", get(approvals_api::list_approvals))
        .route("/api/approvals/:id", get(approvals_api::get_approval))
        .route(
            "/api/approvals/:id/approve",
            post(approvals_api::approve_approval),
        )
        .route(
            "/api/approvals/:id/reject",
            post(approvals_api::reject_approval),
        )
        // ── Quests (auto-detecting todo list) ───────────────────────────────
        // Static segments (`events`, `detection-config`) registered before the
        // `:id` routes so they match first.
        .route("/api/quests/events", get(quests_api::quest_events))
        .route(
            "/api/quests/detection-config",
            get(quests_api::get_detection_config).put(quests_api::set_detection_config),
        )
        .route(
            "/api/quests",
            get(quests_api::list_quests).post(quests_api::create_quest),
        )
        .route(
            "/api/quests/:id",
            get(quests_api::get_quest)
                .put(quests_api::update_quest)
                .delete(quests_api::delete_quest),
        )
        .route("/api/quests/:id/judge", post(quests_api::judge_quest))
        .route("/api/quests/:id/complete", post(quests_api::complete_quest))
        .route("/api/quests/:id/dismiss", post(quests_api::dismiss_quest))
        .route(
            "/api/quests/:id/suggestion/accept",
            post(quests_api::accept_suggestion),
        )
        .route(
            "/api/quests/:id/suggestion/dismiss",
            post(quests_api::dismiss_suggestion),
        )
        // ── Home dashboards (customizable live widget grid) ─────────────────
        // Static segments (`events`, `catalog`) before `:id` so they match first.
        .route(
            "/api/dashboards/events",
            get(dashboard_api::dashboard_events),
        )
        .route("/api/dashboards/catalog", get(dashboard_api::catalog))
        .route(
            "/api/dashboards",
            get(dashboard_api::list_dashboards).post(dashboard_api::create_dashboard),
        )
        .route(
            "/api/dashboards/:id",
            get(dashboard_api::get_dashboard)
                .put(dashboard_api::update_dashboard)
                .delete(dashboard_api::delete_dashboard),
        )
        .route(
            "/api/dashboards/:id/widgets",
            get(dashboard_api::list_widgets).post(dashboard_api::create_widget),
        )
        .route(
            "/api/dashboards/:id/widgets/:wid",
            axum::routing::put(dashboard_api::update_widget).delete(dashboard_api::delete_widget),
        )
        .route(
            "/api/dashboards/:id/widgets/:wid/layout",
            axum::routing::put(dashboard_api::update_widget_layout),
        )
        .route(
            "/api/dashboards/:id/widgets/:wid/refresh",
            post(dashboard_api::refresh_widget),
        )
        // ── Meeting notes (record → live transcript → AI notes) ─────────────
        // Static segments are registered before `:id` so `stream` / `detect` /
        // `detection-config` match first.
        .route("/api/meetings/stream", get(meetings_api::meetings_stream))
        .route("/api/meetings/detect", post(meetings_api::detect))
        .route(
            "/api/meetings/detection-config",
            get(meetings_api::get_detection_config).put(meetings_api::put_detection_config),
        )
        .route(
            "/api/meetings",
            get(meetings_api::list_meetings).post(meetings_api::create_meeting),
        )
        .route(
            "/api/meetings/:id",
            get(meetings_api::get_meeting).delete(meetings_api::delete_meeting),
        )
        .route(
            "/api/meetings/:id/title",
            post(meetings_api::rename_meeting),
        )
        .route("/api/meetings/:id/chunk", post(meetings_api::ingest_chunk))
        .route(
            "/api/meetings/:id/finalize",
            post(meetings_api::finalize_meeting),
        )
        .route(
            "/api/meetings/:id/transcript",
            get(meetings_api::get_transcript),
        )
        // ── Hardware device registry (management; protected) ────────────────
        // The realtime `/api/hardware/ws` + nonce-gated `/api/hardware/pair` are
        // public (registered on the public router above). These management routes
        // require the node token.
        .route("/api/hardware/devices", get(hardware_api::list_devices))
        .route(
            "/api/hardware/devices/:id",
            axum::routing::patch(hardware_api::update_device).delete(hardware_api::delete_device),
        )
        // Per-device dashboard config (layout/widgets/refresh_rate). Management
        // routes (the desktop + the `dashboard_builder` chat target these), so they
        // sit behind `require_auth` with the rest of the protected surface.
        .route(
            "/api/hardware/devices/:id/dashboard",
            get(hardware_api::get_device_dashboard).put(hardware_api::set_device_dashboard),
        )
        // ── Sub-agent delegation (clean context, presets, caps) ─────────────
        .route("/api/delegate/stream", post(delegate_stream))
        // ── Self-update apply (headless binaries; protected) ────────────────
        .route("/api/update/apply", post(update_apply))
        // ── Cross-surface preferences (theme sync: desktop ↔ island) ────────
        // SSE stream is registered before the `:key` route so the static
        // `stream` segment is matched first.
        .route("/api/preferences/stream", get(preferences_stream))
        .route(
            "/api/preferences/:key",
            get(get_preference).put(set_preference),
        )
        // ── Ghost recipes (record / list / show / run / delete) ─────────────
        // Static `record/*` segments registered before `:name` so they match
        // first (Axum would otherwise capture `record` as a recipe name).
        .route("/api/recipes/record/start", post(recipes_api::record_start))
        .route(
            "/api/recipes/record/status",
            get(recipes_api::record_status),
        )
        .route("/api/recipes/record/stop", post(recipes_api::record_stop))
        .route(
            "/api/recipes",
            get(recipes_api::list_recipes).post(recipes_api::save_recipe),
        )
        .route("/api/recipes/:name/run", post(recipes_api::run_recipe))
        .route(
            "/api/recipes/:name",
            get(recipes_api::get_recipe).delete(recipes_api::delete_recipe),
        )
        // ── Scheduled jobs / heartbeat ──────────────────────────────────────
        .route("/heartbeat/jobs", get(list_jobs).post(create_job))
        .route("/heartbeat/jobs/:id", get(get_job).delete(delete_job))
        // Connected-client presence (the "who's on this node" surface). Read by
        // the desktop NodeSelector; populated by `track_connection` below.
        .route("/api/connections", get(list_connections))
        // Data folder ("Storage" setting): read location, validate/switch (point-only),
        // reset to default, export a backup zip. Copy-migrate + import run offline as
        // the `ryu-core data-path` subcommand.
        .route("/api/data-path", get(get_data_path))
        .route("/api/data-path/validate", post(validate_data_path))
        .route("/api/data-path/switch", post(switch_data_path))
        .route("/api/data-path/reset", post(reset_data_path))
        .route("/api/data-path/export", post(export_data_path))
        // Verified user identity (Phase 0): the innermost layer, so it runs AFTER
        // require_auth admits the node and just before the handler. It attaches an
        // `Option<VerifiedCaller>` extension (anonymous when no/invalid user JWT),
        // never rejecting — RYU_TOKEN remains the gate.
        .layer(middleware::from_fn(attach_verified_caller))
        // Presence tracking runs INSIDE require_auth (added before it here, so it
        // is the inner layer): only authenticated requests are recorded.
        .layer(middleware::from_fn_with_state(
            connections,
            track_connection,
        ))
        .layer(middleware::from_fn(require_auth))
        .layer(axum::Extension(auth_token));

    public.merge(protected).layer(cors).with_state(state)
}

// ── Version + update handlers (unified update service) ─────────────────────────

/// `GET /api/version` — the installed Ryu version + per-component builds.
#[utoipa::path(
    get,
    path = "/api/version",
    tag = "Health",
    summary = "Installed version and per-component builds",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_version() -> Json<crate::update::VersionInfo> {
    Json(crate::update::version_info())
}

/// `GET /api/update/check` — compares the installed version against the latest
/// GitHub release. Fails open: a network/API error returns 200 with
/// `update_available: false` so a client never blocks launch on a flaky check.
#[utoipa::path(
    get,
    path = "/api/update/check",
    tag = "Health",
    summary = "Compare installed version against the latest release",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn update_check(State(state): State<ServerState>) -> axum::response::Response {
    match crate::update::check_for_update(&state.client).await {
        Ok(verdict) => (StatusCode::OK, Json(json!(verdict))).into_response(),
        Err(e) => {
            tracing::warn!("update check failed (treating as up-to-date): {e}");
            (
                StatusCode::OK,
                Json(json!({
                    "current": crate::update::current_version(),
                    "latest": crate::update::current_version(),
                    "update_available": false,
                    "notes": serde_json::Value::Null,
                    "html_url": serde_json::Value::Null,
                    "asset": serde_json::Value::Null,
                    "error": e.to_string(),
                })),
            )
                .into_response()
        }
    }
}

/// `POST /api/update/apply` — download + install an update for the headless
/// binaries. Body is the [`crate::update::ReleaseAsset`] returned by the check.
#[utoipa::path(
    post,
    path = "/api/update/apply",
    tag = "Health",
    summary = "Download and apply an update (headless binaries)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn update_apply(
    State(state): State<ServerState>,
    Json(asset): Json<crate::update::ReleaseAsset>,
) -> axum::response::Response {
    match crate::update::apply::apply_update(&state.client, &asset).await {
        Ok(result) => (StatusCode::OK, Json(json!(result))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

// ── Preferences handlers (cross-surface theme sync) ────────────────────────────

#[utoipa::path(
    get,
    path = "/api/preferences/{key}",
    tag = "Preferences",
    summary = "Get a preference value",
    params(("key" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_preference(
    State(state): State<ServerState>,
    Path(key): Path<String>,
) -> axum::response::Response {
    match state.preferences.get(&key).await {
        Ok(Some(value)) => {
            (StatusCode::OK, Json(json!({ "key": key, "value": value }))).into_response()
        }
        // An unset key is not an error for a KV store: return 200 with a null
        // value so clients reading optional prefs don't generate console 404 noise.
        Ok(None) => (StatusCode::OK, Json(json!({ "key": key, "value": null }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
struct SetPreferenceBody {
    value: String,
}

#[utoipa::path(
    put,
    path = "/api/preferences/{key}",
    tag = "Preferences",
    summary = "Set a preference value",
    params(("key" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn set_preference(
    State(state): State<ServerState>,
    Path(key): Path<String>,
    Json(body): Json<SetPreferenceBody>,
) -> axum::response::Response {
    match state.preferences.set(&key, &body.value).await {
        Ok(()) => {
            // Keep the in-process Hugging Face token resolver in sync so gated
            // model search + downloads pick up the change without a restart.
            if key == crate::hf_auth::HF_TOKEN_PREF_KEY {
                crate::hf_auth::set_token(&body.value);
            }
            // Same for the Artificial Analysis API key (model-catalog stats).
            if key == crate::model_catalog::aa::AA_API_KEY_PREF_KEY {
                crate::model_catalog::aa::set_key(&body.value).await;
            }
            // And the AA fetch mode (cached daily cache vs. realtime live fetch).
            if key == crate::model_catalog::aa::AA_MODE_PREF_KEY {
                crate::model_catalog::aa::set_mode(&body.value);
            }
            // Composio API key: keep the resolver in sync AND respawn the gateway
            // so its Composio tool loop picks up the new key (the gateway reads
            // `COMPOSIO_API_KEY` from its spawn env; a refresh re-injects it).
            // Best-effort — a refresh failure must not fail the preference write.
            if key == crate::composio_auth::COMPOSIO_API_KEY_PREF_KEY {
                crate::composio_auth::set_key(&body.value);
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!("gateway: refresh after Composio key change failed: {e}");
                }
            }
            // OpenRouter API key (A4 / #501): same pattern — keep the resolver in
            // sync and respawn the gateway so its `openrouter` provider picks up
            // the new key (the gateway reads `OPENROUTER_API_KEY` from spawn env).
            if key == crate::openrouter_auth::OPENROUTER_API_KEY_PREF_KEY {
                crate::openrouter_auth::set_key(&body.value);
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!("gateway: refresh after OpenRouter key change failed: {e}");
                }
            }
            // Cloud media provider keys (Replicate / Fal): same pattern — sync the
            // resolver and respawn the gateway so its `replicate` / `fal` media
            // providers pick up the new key (read from spawn env).
            if key == crate::replicate_auth::REPLICATE_API_KEY_PREF_KEY {
                crate::replicate_auth::set_key(&body.value);
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!("gateway: refresh after Replicate key change failed: {e}");
                }
            }
            if key == crate::fal_auth::FAL_API_KEY_PREF_KEY {
                crate::fal_auth::set_key(&body.value);
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!("gateway: refresh after Fal key change failed: {e}");
                }
            }
            // Claude Code gateway-routing toggle: keep the in-process flag in sync
            // so the next Claude Code spawn injects (or omits) `ANTHROPIC_BASE_URL`.
            // No gateway respawn needed — the flag is read on Core's spawn path.
            if key == crate::claude_config::CLAUDE_GATEWAY_ROUTING_PREF_KEY {
                crate::claude_config::set_enabled(&body.value);
            }
            // Untrusted-content wrapping toggle: keep the in-process flag in sync
            // so the next tool result wraps (or, on opt-out, does not) before it
            // re-enters the model. Read on Core's tool-result path.
            if key == crate::sidecar::untrusted::UNTRUSTED_WRAPPING_PREF_KEY {
                crate::sidecar::untrusted::set_enabled(&body.value);
            }
            // Generic per-agent gateway routing: keep the in-process map in sync so
            // the next spawn of any toggled agent injects (or omits) OPENAI_BASE_URL.
            // No gateway respawn needed — the map is read on Core's spawn path.
            if key == crate::agent_routing::AGENT_GATEWAY_ROUTING_PREF_KEY {
                crate::agent_routing::set_from_json(&body.value);
            }
            (StatusCode::OK, Json(json!({ "ok": true, "key": key }))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

// ── Per-model launch config (advanced inference) ───────────────────────────────

/// `GET /api/models/{id}/launch-config` — the stored engine-launch config for a
/// model (context size, GPU layers, MoE offload, chat template, speculative draft
/// model, ...). Returns the empty/default config when none is set. The `{id}` must
/// be percent-encoded by the client when it contains a slash.
#[utoipa::path(
    get,
    path = "/api/models/{id}/launch-config",
    tag = "Models",
    summary = "Get a model's advanced launch config",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_model_launch_config(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let cfg = state.preferences.get_launch_config(&id).await;
    let value = serde_json::to_value(&cfg).unwrap_or_else(|_| json!({}));
    (StatusCode::OK, Json(value)).into_response()
}

/// `PUT /api/models/{id}/launch-config` — persist the engine-launch config for a
/// model. Body is a `LaunchConfig` JSON object. Changes apply the next time the
/// engine loads this model (a respawn is required).
#[utoipa::path(
    put,
    path = "/api/models/{id}/launch-config",
    tag = "Models",
    summary = "Set a model's advanced launch config",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn set_model_launch_config(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(cfg): Json<crate::inference::LaunchConfig>,
) -> axum::response::Response {
    match state.preferences.set_launch_config(&id, &cfg).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true, "id": id }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// SSE stream of preference changes. The island companion subscribes to this so
/// theme edits in the desktop propagate live without polling.
#[utoipa::path(
    get,
    path = "/api/preferences/stream",
    tag = "Preferences",
    summary = "Preferences SSE stream",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
async fn preferences_stream(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = state.preferences.subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let data = serde_json::to_string(&ev).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), rx));
                }
                Err(RecvError::Lagged(_)) => {
                    // Dropped some events under backpressure; keep streaming.
                    continue;
                }
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// `GET /api/events/notifications/stream` — SSE: desktop notifications pushed by
/// built-in agent actions (e.g. `notify__desktop`). The desktop subscribes and
/// renders each as a native OS notification (#456).
#[utoipa::path(
    get,
    path = "/api/events/notifications/stream",
    tag = "Events",
    summary = "Desktop notifications SSE stream",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
async fn notifications_stream() -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = crate::events::subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let data = serde_json::to_string(&ev).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), rx));
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// `GET /api/events/all` — unified SSE that multiplexes EVERY feature event bus
/// (notifications, quests, monitors, approvals, meetings, dashboards, downloads)
/// into ONE connection, each event tagged with its channel via the SSE `event:`
/// field. The desktop subscribes here ONCE instead of opening 6+ always-on
/// streams; otherwise those feeds hold every slot of the browser's
/// 6-connection-per-host HTTP/1.1 budget and starve all other fetches (the
/// "every page loads forever" bug). The per-feature endpoints stay for
/// non-desktop clients (mobile, CLI).
async fn all_events_stream(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use futures_util::stream::{self, Stream, StreamExt};
    use std::convert::Infallible;
    use std::pin::Pin;
    use tokio::sync::broadcast::error::RecvError;

    type TaggedStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

    // Wrap one broadcast receiver as a channel-tagged SSE event stream.
    fn tagged<T>(channel: &'static str, rx: tokio::sync::broadcast::Receiver<T>) -> TaggedStream
    where
        T: serde::Serialize + Clone + Send + 'static,
    {
        Box::pin(stream::unfold(rx, move |mut rx| async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let data = serde_json::to_string(&ev).unwrap_or_default();
                        return Some((Ok(Event::default().event(channel).data(data)), rx));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        }))
    }

    // Downloads is snapshot-first (a late client self-heals from the snapshot).
    // Subscribe BEFORE taking the snapshot so no delta is missed in between, then
    // prepend the snapshot ahead of the delta stream.
    let downloads_rx = state.downloads.subscribe();
    let downloads_snapshot = crate::downloads::DownloadEvent::Snapshot {
        tasks: state.downloads.snapshot().await,
    };
    let downloads_snap_data = serde_json::to_string(&downloads_snapshot).unwrap_or_default();
    let downloads: TaggedStream = Box::pin(
        stream::once(async move {
            Ok(Event::default()
                .event("downloads")
                .data(downloads_snap_data))
        })
        .chain(tagged("downloads", downloads_rx)),
    );

    // The dashboards channel additionally registers a live UI VIEWER for the life of
    // this stream (the refresh loop's cost guard keys off viewer_count, not the raw
    // broadcast receiver count — so internal listeners like the hardware nudge loop
    // don't fake a viewer). The guard rides in the unfold state and drops on close.
    let dashboards_rx = state.dashboards.store.subscribe();
    let dashboards_guard = state.dashboards.store.viewer_guard();
    let dashboards: TaggedStream = Box::pin(stream::unfold(
        (dashboards_rx, dashboards_guard),
        |(mut rx, guard)| async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let data = serde_json::to_string(&ev).unwrap_or_default();
                        return Some((
                            Ok(Event::default().event("dashboards").data(data)),
                            (rx, guard),
                        ));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    ));

    let streams: Vec<TaggedStream> = vec![
        tagged("notifications", crate::events::subscribe()),
        tagged("quests", state.quests.store.subscribe()),
        tagged("monitors", state.monitors.store.subscribe()),
        tagged("approvals", state.approvals.store.subscribe()),
        tagged("meetings", state.meetings.store.subscribe()),
        dashboards,
        downloads,
    ];

    Sse::new(stream::select_all(streams)).keep_alive(KeepAlive::default())
}

// ── Download center handlers (#456) ─────────────────────────────────────────

/// `GET /api/downloads` — current snapshot of all tracked downloads.
#[utoipa::path(
    get,
    path = "/api/downloads",
    tag = "Downloads",
    summary = "List downloads (download center)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_downloads(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let tasks = state.downloads.snapshot().await;
    Json(json!({ "downloads": tasks }))
}

/// `GET /api/downloads/stream` — SSE: a full snapshot on connect, then deltas.
/// The snapshot-first contract lets a late/lagged client self-heal (a missed
/// broadcast delta is corrected by the next event), so terminal states are never
/// silently lost.
#[utoipa::path(
    get,
    path = "/api/downloads/stream",
    tag = "Downloads",
    summary = "Download center SSE stream",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
async fn downloads_stream(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = state.downloads.subscribe();
    let snapshot = crate::downloads::DownloadEvent::Snapshot {
        tasks: state.downloads.snapshot().await,
    };

    // State carries the (one-shot) snapshot until it's been emitted, then `None`.
    // First poll yields the snapshot; subsequent polls forward live deltas.
    let stream = futures_util::stream::unfold(
        (rx, Some(snapshot)),
        |(mut rx, pending_snapshot)| async move {
            if let Some(snap) = pending_snapshot {
                let data = serde_json::to_string(&snap).unwrap_or_default();
                return Some((Ok(Event::default().data(data)), (rx, None)));
            }
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let data = serde_json::to_string(&ev).unwrap_or_default();
                        return Some((Ok(Event::default().data(data)), (rx, None)));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Shared body for the control endpoints — `{ ok }` or 404 when the id is unknown.
fn download_control_result(ok: bool) -> (StatusCode, Json<serde_json::Value>) {
    if ok {
        (StatusCode::OK, Json(json!({ "ok": true })))
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "unknown download id" })),
        )
    }
}

#[utoipa::path(
    post,
    path = "/api/downloads/{id}/pause",
    tag = "Downloads",
    summary = "Pause a download",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn download_pause(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    download_control_result(state.downloads.pause(&id).await)
}

#[utoipa::path(
    post,
    path = "/api/downloads/{id}/resume",
    tag = "Downloads",
    summary = "Resume a download",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn download_resume(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    download_control_result(state.downloads.resume(&id).await)
}

#[utoipa::path(
    post,
    path = "/api/downloads/{id}/retry",
    tag = "Downloads",
    summary = "Retry a download",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn download_retry(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    download_control_result(state.downloads.retry(&id).await)
}

#[utoipa::path(
    post,
    path = "/api/downloads/{id}/cancel",
    tag = "Downloads",
    summary = "Cancel a download",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn download_cancel(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    download_control_result(state.downloads.cancel(&id).await)
}

#[utoipa::path(
    delete,
    path = "/api/downloads/{id}",
    tag = "Downloads",
    summary = "Clear a download entry",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn download_clear(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    download_control_result(state.downloads.clear(&id).await)
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
struct AuthLoginBody {
    #[serde(rename = "backendUrl")]
    backend_url: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/auth/login",
    tag = "Auth",
    summary = "Start the device authorization flow",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn auth_login(
    State(state): State<ServerState>,
    body: Option<Json<AuthLoginBody>>,
) -> Json<serde_json::Value> {
    tracing::info!("auth_login: starting device authorization flow");
    let body = body.map(|b| b.0).unwrap_or_default();
    let backend_url = body
        .backend_url
        .or_else(|| std::env::var("RYU_BACKEND_URL").ok())
        .unwrap_or_else(|| "http://localhost:3000".to_string());
    tracing::info!("auth_login: backend={backend_url}");

    match crate::auth::start_device_login(Arc::clone(&state.auth), &backend_url).await {
        Ok(info) => Json(json!({
            "userCode": info.user_code,
            "verificationUri": info.verification_uri,
            "verificationUriComplete": info.verification_uri_complete,
        })),
        Err(e) => Json(json!({ "error": e.to_string() })),
    }
}

#[utoipa::path(
    get,
    path = "/api/auth/status",
    tag = "Auth",
    summary = "Device authorization status",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn auth_status(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let s = state.auth.lock().await;
    let authenticated = matches!(s.status, crate::auth::AuthStatus::Authenticated);
    let pending = matches!(s.status, crate::auth::AuthStatus::Pending);
    tracing::debug!("auth_status: authenticated={authenticated} pending={pending}");
    Json(json!({
        "authenticated": authenticated,
        "pending": pending,
        // The desktop poll (apps/desktop/lib/oauth.ts) completes login only when
        // BOTH `authenticated` and `token` are present, then stores the bearer
        // token client-side. Dropping this field (regressed in 9b3ac61c) left the
        // app polling forever on the auth-code page despite Core being authed.
        "token": s.token,
        "userCode": s.user_code,
        "verificationUri": s.verification_uri,
    }))
}

#[utoipa::path(
    post,
    path = "/api/auth/logout",
    tag = "Auth",
    summary = "Clear the stored token",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn auth_logout(State(state): State<ServerState>) -> Json<serde_json::Value> {
    if let Err(e) = crate::auth::clear_token() {
        tracing::warn!("Failed to clear token from disk: {e}");
    }
    let mut s = state.auth.lock().await;
    s.status = crate::auth::AuthStatus::Idle;
    s.token = None;
    s.user_code = None;
    s.verification_uri = None;
    Json(json!({ "success": true }))
}

#[utoipa::path(
    post,
    path = "/api/chat/stream",
    tag = "Chat",
    summary = "Stream a chat turn (SSE, Vercel AI format)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Server-Sent Events stream"))
)]
async fn chat_stream(
    State(state): State<ServerState>,
    // Verified human author (Phase 0), attached by `attach_verified_caller`.
    // `None` in the anonymous single-tenant / loopback flow. Always present as an
    // extension (the middleware inserts it on every protected route), so the
    // direct `Extension` extractor is safe here.
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(mut req): Json<ChatStreamRequest>,
) -> axum::response::Response {
    // Stamp the verified author onto this turn unconditionally (None when
    // anonymous). `author_user_id` is `#[serde(skip)]`, so this server-side write
    // is the ONLY source — a client request body can neither set nor spoof it.
    req.author_user_id = caller.as_ref().map(|c| c.user_id.clone());
    // Team turn: fan out to the team's members per its coordination strategy.
    if let Some(team_id) = req.team_id.clone() {
        let team = match state.teams.get(&team_id).await {
            Ok(Some(t)) => t,
            Ok(None) => {
                return crate::sidecar::adapters::error_stream(format!("Unknown team: {team_id}"));
            }
            Err(e) => {
                return crate::sidecar::adapters::error_stream(format!(
                    "failed to load team {team_id}: {e}"
                ));
            }
        };
        return crate::sidecar::adapters::route_team_chat_stream(
            req,
            team,
            Arc::clone(&state.agents),
            state.conversations.clone(),
            state.agent_store.clone(),
            Arc::clone(&state.manager),
            state.memory.clone(),
            Arc::clone(&state.worktree_diffs),
            Arc::clone(&state.mcp),
            state.skills.clone(),
            state.traces.clone(),
        )
        .await;
    }
    // Wrap the turn with the plugin turn-hook runtime (M5): after the assistant
    // turn streams + persists, enabled `post_assistant_turn` hooks run and may
    // surface a note or drive a server-side continue loop. Zero-overhead when no
    // hook plugins are enabled (the wrapper returns the inner stream unwrapped).
    run_chat_with_hooks(state, req).await
}

/// Run one chat turn: resolve the per-turn skills-disclosure + auto-recall config,
/// then hand off to the single-agent route. Extracted so the plugin turn-hook
/// wrapper can re-run a turn during a `continue` loop.
async fn route_single_turn(
    state: &ServerState,
    req: crate::sidecar::adapters::ChatStreamRequest,
) -> axum::response::Response {
    // Apply the global skills disclosure mode (progressive vs full) from the pref
    // so the ACP chat path injects the L1 index + loads on demand (default) or the
    // full skill bodies. Cheap pref read; mirrors the per-request recall resolution.
    apply_skills_disclosure(state).await;
    // Resolve auto-recall (U17) config from prefs/env. Default ON; encoded as
    // `Some`/`None` so a disabled feature does zero work inside route_chat_stream.
    let recall = if resolve_auto_recall_enabled(state).await {
        Some(crate::sidecar::adapters::AutoRecallConfig {
            retrieval: state.retrieval.clone(),
            top_k: resolve_auto_recall_top_k(state).await,
            // FTS (lexical) session search is a sub-source of auto-recall: default
            // OFF, only contributes when explicitly enabled. Resolved here so a
            // disabled feature does zero FTS work inside route_chat_stream.
            fts_enabled: resolve_fts_recall_enabled(state).await,
        })
    } else {
        None
    };
    // App-level context-window config (off by default). Resolved here, on the
    // interactive chat path, mirroring the recall resolution above.
    let ctx_window = resolve_context_window(state, &req).await;
    route_chat_stream(
        req,
        Arc::clone(&state.agents),
        state.conversations.clone(),
        state.agent_store.clone(),
        Arc::clone(&state.manager),
        state.memory.clone(),
        Arc::clone(&state.worktree_diffs),
        Arc::clone(&state.mcp),
        state.skills.clone(),
        state.traces.clone(),
        recall,
        ctx_window,
    )
    .await
}

/// Build the post-assistant-turn hook context from the persisted transcript
/// (most-recent 20 messages) + the request's plugin flags.
async fn build_hook_context(
    state: &ServerState,
    conversation_id: &str,
    agent_id: Option<&str>,
    flags: &std::collections::HashMap<String, bool>,
) -> crate::plugin_host::HookContext {
    const MAX_TRANSCRIPT: usize = 20;
    let transcript = match state.conversations.get_messages(conversation_id).await {
        Ok(msgs) => {
            let skip = msgs.len().saturating_sub(MAX_TRANSCRIPT);
            msgs.into_iter()
                .skip(skip)
                .map(|m| crate::plugin_host::HookMessage {
                    role: m.role,
                    content: m.content,
                })
                .collect()
        }
        Err(e) => {
            tracing::warn!("plugin_host: could not load transcript for hooks: {e}");
            Vec::new()
        }
    };
    crate::plugin_host::HookContext {
        conversation_id: Some(conversation_id.to_string()),
        agent_id: agent_id.map(str::to_string),
        transcript,
        flags: flags.clone(),
    }
}

/// Build the next-turn request for a `continue` directive: reload the full
/// transcript and append the injected user turn (`text`). `route_chat_stream`
/// persists that final user turn + the next assistant reply, so the server-side
/// loop is recorded exactly like a normal turn.
async fn continue_turn_request(
    state: &ServerState,
    prev: &crate::sidecar::adapters::ChatStreamRequest,
    conversation_id: &str,
    text: String,
) -> crate::sidecar::adapters::ChatStreamRequest {
    use crate::sidecar::adapters::{UiContent, UiMessage};
    let mut messages: Vec<UiMessage> = match state.conversations.get_messages(conversation_id).await
    {
        Ok(msgs) => msgs
            .into_iter()
            .map(|m| UiMessage {
                role: m.role,
                content: UiContent::Text(m.content),
                parts: Vec::new(),
            })
            .collect(),
        Err(_) => prev.messages.clone(),
    };
    messages.push(UiMessage {
        role: "user".to_string(),
        content: UiContent::Text(text),
        parts: Vec::new(),
    });
    let mut next = prev.clone();
    next.messages = messages;
    next.persist = true;
    next
}

/// One `data-plugin_note` AI-SDK custom data part frame carrying a hook's note
/// (e.g. double-check's review). The client renders it out-of-band; it never
/// enters chat history.
fn plugin_note_frame(text: &str) -> Vec<u8> {
    let value = serde_json::json!({ "type": "data-plugin_note", "data": { "text": text } });
    format!("data: {value}\n\n").into_bytes()
}

/// Wrap a chat turn with the plugin turn-hook runtime (M5). After the assistant
/// turn streams + persists, enabled `post_assistant_turn` hooks run: a `note`
/// directive is surfaced as a `data-plugin_note` UI part (e.g. double-check's
/// review), and a `continue` directive injects a follow-up user turn and streams
/// another turn into the SAME response (the server-side goal loop), capped at
/// [`crate::plugin_host::MAX_CONTINUE_TURNS`]. When no hook plugins are enabled
/// (or the sandbox backend is absent, or this is a background / non-persisted /
/// no-conversation turn) the inner stream is returned unwrapped — zero overhead
/// on the hot path.
async fn run_chat_with_hooks(
    state: ServerState,
    req: crate::sidecar::adapters::ChatStreamRequest,
) -> axum::response::Response {
    use axum::body::Body;
    use futures_util::StreamExt;

    let eligible = req.conversation_id.is_some() && req.persist && !req.background;
    // Cheap gate: collect enabled hooks once. Empty (the common case) → no wrap.
    let hooks = if eligible && crate::tool_exec::is_available() {
        crate::plugin_host::collect_enabled_hooks(&state).await
    } else {
        Vec::new()
    };
    if hooks.is_empty() {
        return route_single_turn(&state, req).await;
    }

    let conversation_id = req.conversation_id.clone().unwrap_or_default();
    let agent_id = req.agent_id.clone();
    let flags = req.plugin_flags.clone();

    let stream = async_stream::stream! {
        let mut current = req;
        let mut turn: u32 = 0;
        loop {
            // Stream one turn, forwarding every UI part except its terminal [DONE].
            let inner = route_single_turn(&state, current.clone()).await;
            let mut body = inner.into_body().into_data_stream();
            while let Some(item) = body.next().await {
                match item {
                    Ok(bytes) => {
                        if crate::sidecar::adapters::is_done_frame(&bytes) {
                            continue;
                        }
                        yield Ok::<_, std::convert::Infallible>(bytes.to_vec());
                    }
                    Err(_) => break,
                }
            }

            // Post-turn hooks: build context from the persisted transcript.
            let ctx = build_hook_context(&state, &conversation_id, agent_id.as_deref(), &flags).await;
            let directives = crate::plugin_host::run_hooks(&state, &ctx, &hooks).await;
            let mut next_text: Option<String> = None;
            for directive in directives {
                match directive {
                    crate::plugin_host::HookDirective::Note { text } => {
                        yield Ok(plugin_note_frame(&text));
                    }
                    crate::plugin_host::HookDirective::Continue { text } => {
                        if next_text.is_none() {
                            next_text = Some(text);
                        }
                    }
                    crate::plugin_host::HookDirective::None => {}
                }
            }

            turn += 1;
            match next_text {
                Some(text) if turn < crate::plugin_host::MAX_CONTINUE_TURNS => {
                    current = continue_turn_request(&state, &current, &conversation_id, text).await;
                }
                _ => break,
            }
        }
        // One terminal DONE for the whole (possibly multi-turn) response.
        yield Ok(crate::sidecar::adapters::done_sse_frame());
    };

    crate::sidecar::adapters::sse_response(Body::from_stream(stream))
}

/// `GET /api/agents/:id/acp-config` — the agent's advertised ACP session config.
///
/// Opens a throwaway ACP session (no prompt) and returns `{ modes, models,
/// configOptions }` exactly as the agent reports them at `session/new` (each
/// `null` when unsupported). This is the data the desktop's per-agent permission
/// mode / reasoning effort / model pickers are built from — fully agent-driven,
/// nothing hardcoded. Non-ACP agents return all-null. Cached per spawn command.
async fn acp_config(
    State(state): State<ServerState>,
    Path(agent_id): Path<String>,
) -> axum::response::Response {
    let Some(spawn_cmd) = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        &agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    else {
        // Not an ACP agent → no session/new advertisement to read.
        return Json(serde_json::json!({
            "modes": null,
            "models": null,
            "configOptions": null,
        }))
        .into_response();
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    match crate::sidecar::adapters::acp::probe_acp_config(spawn_cmd, cwd).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Body for `POST /api/agents/:id/authenticate`.
#[derive(serde::Deserialize)]
struct AcpAuthRequest {
    /// One of the `authMethods[].id` values from the agent's `acp-config`.
    method_id: String,
}

/// `POST /api/agents/:id/authenticate` — run the ACP Authentication flow for an
/// agent using one of the methods it advertised (e.g. a subscription/OAuth
/// login). The agent subprocess owns the login UX; this issues the ACP
/// `authenticate` request and waits for completion, then invalidates the cached
/// `acp-config` so the now-unlocked session config is re-read.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/authenticate",
    tag = "Agents",
    summary = "Authenticate to an ACP agent (login)",
    params(("id" = String, Path, description = "Agent id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn acp_authenticate(
    State(state): State<ServerState>,
    Path(agent_id): Path<String>,
    Json(body): Json<AcpAuthRequest>,
) -> axum::response::Response {
    let Some(spawn_cmd) = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        &agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "not an ACP agent" })),
        )
            .into_response();
    };
    match crate::sidecar::adapters::acp::authenticate_acp(spawn_cmd, body.method_id).await {
        Ok(()) => Json(serde_json::json!({ "authenticated": true })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "authenticated": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/agents/:id/logout` — end an ACP agent's authenticated session (ACP
/// `logout`). Inverse of `authenticate`: the agent drops its credentials so the
/// next `session/new` requires re-login. Best-effort; agents that don't support
/// the `logout` capability return an error.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/logout",
    tag = "Agents",
    summary = "Log out of an ACP agent",
    params(("id" = String, Path, description = "Agent id")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn acp_logout(
    State(state): State<ServerState>,
    Path(agent_id): Path<String>,
) -> axum::response::Response {
    let Some(spawn_cmd) = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        &agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "not an ACP agent" })),
        )
            .into_response();
    };
    match crate::sidecar::adapters::acp::logout_acp(spawn_cmd).await {
        Ok(()) => Json(serde_json::json!({ "loggedOut": true })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "loggedOut": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `GET /api/agents/:id/sessions` — the sessions an ACP agent is tracking (ACP
/// `session/list`). Best-effort: agents that don't implement it (the flagship pi)
/// return `{ sessions: [] }`.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/sessions",
    tag = "Agents",
    summary = "List an ACP agent's sessions",
    params(("id" = String, Path, description = "Agent id")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_acp_sessions_handler(
    State(state): State<ServerState>,
    Path(agent_id): Path<String>,
) -> axum::response::Response {
    let Some(spawn_cmd) = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        &agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    else {
        return Json(serde_json::json!({ "sessions": [] })).into_response();
    };
    match crate::sidecar::adapters::acp::list_acp_sessions(spawn_cmd).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "sessions": [], "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `DELETE /api/agents/:id/sessions/:sid` — delete an ACP agent session (ACP
/// `session/close`).
#[utoipa::path(
    delete,
    path = "/api/agents/{id}/sessions/{sid}",
    tag = "Agents",
    summary = "Delete an ACP agent session",
    params(
        ("id" = String, Path, description = "Agent id"),
        ("sid" = String, Path, description = "Session id")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn delete_acp_session_handler(
    State(state): State<ServerState>,
    Path((agent_id, sid)): Path<(String, String)>,
) -> axum::response::Response {
    let Some(spawn_cmd) = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        &agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "not an ACP agent" })),
        )
            .into_response();
    };
    match crate::sidecar::adapters::acp::close_acp_session(spawn_cmd, sid).await {
        Ok(()) => Json(serde_json::json!({ "deleted": true })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "deleted": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Optional body for `POST /api/agents/:id/sessions/:sid/load`.
#[derive(serde::Deserialize, Default)]
struct LoadSessionBody {
    /// Workspace the session ran in. Falls back to the server's cwd when absent.
    #[serde(default)]
    cwd: Option<String>,
}

/// `POST /api/agents/:id/sessions/:sid/load` — warm-resume an ACP agent's own
/// prior session (ACP `session/load`), restoring its context. Returns
/// `{ supported, modes, models, configOptions }`; `supported: false` for agents
/// that don't advertise the `loadSession` capability.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/sessions/{sid}/load",
    tag = "Agents",
    summary = "Resume an ACP agent session (session/load)",
    params(
        ("id" = String, Path, description = "Agent id"),
        ("sid" = String, Path, description = "Session id")
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn load_acp_session_handler(
    State(state): State<ServerState>,
    Path((agent_id, sid)): Path<(String, String)>,
    body: Option<Json<LoadSessionBody>>,
) -> axum::response::Response {
    let Some(spawn_cmd) = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        &agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "not an ACP agent" })),
        )
            .into_response();
    };
    let cwd = body
        .and_then(|b| b.0.cwd)
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    match crate::sidecar::adapters::acp::load_acp_session(spawn_cmd, sid, cwd).await {
        Ok(value) => Json(value).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "supported": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Resolve the npm package that backs an agent (for version/update checks). The
/// flagship `ryu` agent's runtime is the managed Pi engine; every other ACP agent
/// self-fetches via `npx -y <pkg>`, so the package is parsed from its spawn cmd.
async fn agent_npm_package(state: &ServerState, agent_id: &str) -> Option<String> {
    if agent_id == "ryu" {
        return Some(crate::sidecar::adapters::acp::PI_ENGINE_NPM.to_owned());
    }
    let spawn_cmd = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await?;
    npx_package_of(&spawn_cmd)
}

/// `GET /api/agents/:id/update-check` — the agent runtime's installed vs latest
/// version, mirroring the engine catalog's update check but per agent. Installed
/// version is tracked for the managed Pi (`ryu`); npx-fetched agents report a
/// latest only (npx caches globally, so there is no persisted installed version).
#[utoipa::path(
    get,
    path = "/api/agents/{id}/update-check",
    tag = "Agents",
    summary = "Check an agent runtime for updates",
    params(("id" = String, Path, description = "Agent id")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn agent_update_check(
    State(state): State<ServerState>,
    Path(agent_id): Path<String>,
) -> Json<serde_json::Value> {
    let npm_package = agent_npm_package(&state, &agent_id).await;
    let installed = if agent_id == "ryu" {
        crate::sidecar::adapters::acp::read_managed_pi_version()
    } else {
        None
    };
    let latest = match &npm_package {
        Some(pkg) => crate::catalog::npm::fetch_latest_version(&reqwest::Client::new(), pkg)
            .await
            .ok(),
        None => None,
    };
    let update_available = matches!((&installed, &latest), (Some(i), Some(l)) if i != l);
    Json(json!({
        "id": agent_id,
        "npmPackage": npm_package,
        "installedVersion": installed,
        "latestVersion": latest,
        "updateAvailable": update_available,
    }))
}

/// `POST /api/agents/:id/update` — update the agent runtime to the latest version.
/// For the managed Pi (`ryu`) this re-installs `@earendil-works/pi-coding-agent@latest`;
/// for npx agents it re-warms the npx cache (which pulls the latest on fetch).
#[utoipa::path(
    post,
    path = "/api/agents/{id}/update",
    tag = "Agents",
    summary = "Update an agent runtime to the latest version",
    params(("id" = String, Path, description = "Agent id")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn agent_update(
    State(state): State<ServerState>,
    Path(agent_id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    if agent_id == "ryu" {
        return match crate::sidecar::adapters::acp::update_managed_pi().await {
            Ok(()) => {
                let version = crate::sidecar::adapters::acp::read_managed_pi_version();
                (
                    StatusCode::OK,
                    Json(json!({ "updated": true, "installedVersion": version })),
                )
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "updated": false, "error": e.to_string() })),
            ),
        };
    }
    match agent_npm_package(&state, &agent_id).await {
        Some(pkg) => {
            warm_npx_package(&pkg).await;
            (StatusCode::OK, Json(json!({ "updated": true })))
        }
        None => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "updated": false, "error": "no updatable runtime for this agent" })),
        ),
    }
}

/// `GET /api/agents/:id/capabilities` — the agent's effective tool / reasoning /
/// vision capabilities, Jan-style.
///
/// Detection branches by plane: an ACP agent's reasoning support is read from its
/// `session/new` config options (tools always supported via the MCP bridge); a
/// local / openai-compat agent's flags are read from the bound model's GGUF chat
/// template ([`crate::model_catalog::capabilities`]). The auto-detected result is
/// the default; a persisted per-agent override (set via PUT) wins. The desktop
/// gates its composer and edit-page controls on the effective flags. Nothing is
/// hardcoded — detection is data-driven from the agent's own model/probe.
async fn agent_capabilities(
    State(state): State<ServerState>,
    Path(agent_id): Path<String>,
) -> axum::response::Response {
    use crate::model_catalog::capabilities::{self as caps, CapabilityReport, DetectedCaps};

    let overrides = caps::load_override(&agent_id);

    // ACP plane: tools flow through the MCP bridge (always supported); reasoning
    // is whatever the agent advertises at session/new.
    if let Some(spawn_cmd) = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        &agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    {
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let (detected, source) =
            match crate::sidecar::adapters::acp::probe_acp_config(spawn_cmd, cwd).await {
                Ok(v) => (
                    DetectedCaps {
                        tools: true,
                        reasoning: caps::acp_probe_reasoning(&v),
                        vision: false,
                        diffusion: false,
                    },
                    "acp_probe",
                ),
                // Probe failed (agent binary missing, etc.) — assume a tool loop
                // is available so we don't hide controls on a transient error.
                Err(_) => (
                    DetectedCaps {
                        tools: true,
                        reasoning: false,
                        vision: false,
                        diffusion: false,
                    },
                    "default",
                ),
            };
        return Json(CapabilityReport::build(detected, overrides, source)).into_response();
    }

    // Local / openai-compat plane: read the bound model's GGUF chat template. The
    // bound model is the agent's chat slot (or legacy flat `model`); fall back to
    // the node's active local chat model when the agent pins none.
    let bound = match state.agent_store.get(&agent_id).await {
        Ok(Some(r)) => r.chat_model.and_then(|s| s.model_id).or(r.model),
        _ => None,
    };
    let model_ref = match bound {
        Some(m) => Some(m),
        None => state
            .preferences
            .get(crate::model_catalog::installed::ACTIVE_MODEL_PREF)
            .await
            .ok()
            .flatten()
            .and_then(|raw| {
                crate::model_catalog::installed::parse_active_pref(&raw).map(|a| a.r#ref)
            }),
    };

    let (detected, source) = match model_ref.as_deref().and_then(caps::detect_local) {
        Some(d) => (d, "gguf"),
        // No installed GGUF resolves (remote provider / non-GGUF / not
        // downloaded). Default to tool support (most remote providers do);
        // reasoning/vision unknown. The user can override on the edit page.
        None => (
            DetectedCaps {
                tools: true,
                reasoning: false,
                vision: false,
                diffusion: false,
            },
            "default",
        ),
    };
    Json(CapabilityReport::build(detected, overrides, source)).into_response()
}

/// Body for `PUT /api/agents/:id/capabilities` — a tri-state capability override.
/// Each field omitted or `null` means "auto-detect"; `true`/`false` forces the
/// flag. Mirrors Jan's per-model `_userConfiguredCapabilities`.
#[derive(serde::Deserialize)]
struct CapabilityOverridePatch {
    #[serde(default)]
    tools: Option<bool>,
    #[serde(default)]
    reasoning: Option<bool>,
    #[serde(default)]
    vision: Option<bool>,
}

/// `PUT /api/agents/:id/capabilities` — persist the agent's capability overrides
/// and return the recomputed report.
async fn set_agent_capabilities(
    State(state): State<ServerState>,
    Path(agent_id): Path<String>,
    Json(patch): Json<CapabilityOverridePatch>,
) -> axum::response::Response {
    use crate::model_catalog::capabilities::CapabilityOverrides;

    let overrides = CapabilityOverrides {
        tools: patch.tools,
        reasoning: patch.reasoning,
        vision: patch.vision,
    };
    if let Err(e) = crate::model_catalog::capabilities::save_override(&agent_id, &overrides) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response();
    }
    // Re-resolve so the response reflects the new effective flags.
    agent_capabilities(State(state), Path(agent_id)).await
}

/// Body for `POST /api/chat/permission`.
#[derive(serde::Deserialize)]
struct PermissionDecision {
    /// The `requestId` from the `data-ryu-permission` stream part.
    request_id: String,
    /// The chosen `optionId`; omit (or null) to cancel/reject the request.
    #[serde(default)]
    option_id: Option<String>,
}

/// `POST /api/chat/permission` — deliver the user's decision for an interactive
/// ACP tool-permission prompt, unblocking the awaiting agent turn. `resolved` is
/// `false` when no matching pending request was found (e.g. it already timed out).
async fn chat_permission(Json(body): Json<PermissionDecision>) -> Json<serde_json::Value> {
    let resolved =
        crate::sidecar::adapters::acp::resolve_permission(&body.request_id, body.option_id);
    Json(serde_json::json!({ "resolved": resolved }))
}

/// Body for `POST /api/chat/cancel`.
#[derive(serde::Deserialize)]
struct CancelRequest {
    /// The conversation id whose in-flight ACP turn should be cancelled.
    conversation_id: String,
}

/// `POST /api/chat/cancel` — explicitly stop a conversation's in-flight ACP turn.
/// Unlike a mere SSE disconnect (which Core lets finish so the assistant message
/// persists), this propagates an ACP `session/cancel` to the agent so it actually
/// stops. `cancelled` is `false` when no live turn was found for the conversation.
#[utoipa::path(
    post,
    path = "/api/chat/cancel",
    tag = "Chat",
    summary = "Cancel a conversation's in-flight ACP turn",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn chat_cancel(Json(body): Json<CancelRequest>) -> Json<serde_json::Value> {
    let cancelled = crate::sidecar::adapters::acp::request_cancel(&body.conversation_id);
    Json(serde_json::json!({ "cancelled": cancelled }))
}

/// `GET /api/chat/stream/resume/:conversation_id` — reconnect to an in-flight
/// ACP turn's live UI frame stream. Returns the accumulated reply text as a
/// synthetic replay, then forwards live frames until the turn completes.
/// Returns 404 when no turn is running for the conversation.
async fn chat_stream_resume(
    axum::extract::Path(conversation_id): axum::extract::Path<String>,
) -> axum::response::Response {
    match crate::sidecar::adapters::subscribe_live_stream(&conversation_id) {
        Some(stream) => {
            crate::sidecar::adapters::sse_response(axum::body::Body::from_stream(stream))
        }
        None => {
            // No live turn — return 404 so the client knows not to wait.
            axum::response::Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header("Content-Type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({ "error": "no running turn" }).to_string(),
                ))
                .unwrap_or_default()
        }
    }
}

// ── Channel bot run endpoint (M11 / #226) ────────────────────────────────────

/// Request body for `POST /api/channels/run`.
///
/// Channel bots send one inbound turn and receive the assembled reply text back.
/// `conversation_id` should be a stable per-chat identifier (e.g. Telegram chat_id)
/// so multi-turn exchanges share conversation history in the Core session store.
#[derive(serde::Deserialize)]
struct ChannelRunRequest {
    /// Stable per-chat identifier used as the Core conversation id.
    conversation_id: String,
    /// The agent to route the message to. Falls back to the default agent when absent.
    #[serde(default)]
    agent_id: Option<String>,
    /// The team to route the message to. When set (and non-empty) it takes
    /// precedence over `agent_id`: the message fans out to the team's members
    /// per its coordination strategy (a lead agent orchestrating the others)
    /// and the combined, attributed reply is returned.
    #[serde(default)]
    team_id: Option<String>,
    /// The user's message text.
    text: String,
    /// Optional sender display name for group/channel chats (Telegram first
    /// name, Discord username, …). Connector-supplied and UNVERIFIED — recorded
    /// on the user message so a multi-participant thread knows who spoke; never
    /// used for auth. Absent for 1:1 chats.
    #[serde(default)]
    author_name: Option<String>,
}

/// `POST /api/channels/run` — non-streaming channel bot entry point (M11 / #226).
///
/// Channel bots (Telegram, Slack, WhatsApp, Discord) call this endpoint with a
/// `(conversation_id, agent_id, text)` turn and receive the assembled reply as a
/// plain JSON `{ "reply": "..." }`. Model calls still flow Core → Gateway so the
/// moat (firewall, DLP, budgets, audit) governs every bot-initiated call.
#[utoipa::path(
    post,
    path = "/api/channels/run",
    tag = "Chat",
    summary = "Run a channel-bot inbound message turn",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn channel_run(
    State(state): State<ServerState>,
    Json(req): Json<ChannelRunRequest>,
) -> axum::response::Response {
    // A non-empty team_id targets a whole team (lead orchestrates members) and
    // takes precedence over agent_id; otherwise route to a single agent.
    let team_id = req.team_id.as_deref().filter(|s| !s.trim().is_empty());
    let result = if let Some(team_id) = team_id {
        match state.teams.get(team_id).await {
            Ok(Some(team)) => {
                run_team_reply_text(
                    req.conversation_id,
                    team,
                    req.text,
                    req.author_name,
                    Arc::clone(&state.agents),
                    state.conversations.clone(),
                    state.agent_store.clone(),
                    Arc::clone(&state.manager),
                    state.memory.clone(),
                    Arc::clone(&state.worktree_diffs),
                    Arc::clone(&state.mcp),
                    state.skills.clone(),
                    state.traces.clone(),
                )
                .await
            }
            Ok(None) => Err(anyhow::anyhow!("team '{team_id}' not found")),
            Err(e) => Err(e),
        }
    } else {
        run_reply_text(
            req.conversation_id,
            req.agent_id,
            req.text,
            req.author_name,
            Arc::clone(&state.agents),
            state.conversations.clone(),
            state.agent_store.clone(),
            Arc::clone(&state.manager),
            state.memory.clone(),
            Arc::clone(&state.worktree_diffs),
            Arc::clone(&state.mcp),
            state.skills.clone(),
            state.traces.clone(),
        )
        .await
    };

    match result {
        Ok(reply) => Json(json!({ "reply": reply })).into_response(),
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/api/worktree/{run_id}/diff",
    tag = "Worktree",
    summary = "Diff a run's worktree",
    params(("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn worktree_diff_handler(
    State(state): State<ServerState>,
    Path(run_id): Path<String>,
) -> impl IntoResponse {
    let store = state.worktree_diffs.lock().await;
    match store.get(&run_id) {
        Some(run) => {
            Json(serde_json::to_value(&run.diff).unwrap_or(serde_json::json!({}))).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no diff found for run", "run_id": run_id })),
        )
            .into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/api/worktree/{run_id}/status",
    tag = "Worktree",
    summary = "Status of a conversation's persistent worktree",
    params(("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn worktree_status_handler(
    State(state): State<ServerState>,
    Path(run_id): Path<String>,
) -> impl IntoResponse {
    let store = state.worktree_diffs.lock().await;
    match store.get(&run_id) {
        Some(run) => {
            let (branch, path) = run
                .guard
                .as_ref()
                .map(|g| {
                    (
                        Some(g.branch.clone()),
                        Some(g.path.to_string_lossy().into_owned()),
                    )
                })
                .unwrap_or((None, None));
            Json(json!({
                // `active` ⇒ a live worktree is held for this conversation (the
                // session can iterate in it); false once it has been applied.
                "active": run.guard.is_some(),
                "branch": branch,
                "path": path,
                "has_changes": run.diff.has_changes,
                "changed_files": run.diff.files.len(),
            }))
            .into_response()
        }
        None => Json(json!({ "active": false })).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct WorktreeApplyBody {
    mode: worktree::ApplyMode,
    message: String,
    #[serde(default)]
    base: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/worktree/{run_id}/apply",
    tag = "Worktree",
    summary = "Apply/merge a run's worktree",
    params(("run_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn worktree_apply_handler(
    State(state): State<ServerState>,
    Path(run_id): Path<String>,
    Json(body): Json<WorktreeApplyBody>,
) -> impl IntoResponse {
    if body.message.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "message is required".to_owned());
    }

    // Take the guard out of the store so it is live during apply and then
    // dropped (which calls remove_worktree_sync) after the function returns.
    let guard = {
        let mut store = state.worktree_diffs.lock().await;
        match store.get_mut(&run_id) {
            Some(run) => run.guard.take(),
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "no worktree found for run", "run_id": run_id })),
                )
                    .into_response();
            }
        }
    };

    let Some(guard) = guard else {
        return json_error(
            StatusCode::GONE,
            "worktree has already been applied or cleaned up".to_owned(),
        );
    };

    let mode = body.mode;
    let message = body.message.trim().to_string();
    let base = body.base.as_deref().map(str::to_string);

    // Apply is synchronous git I/O; run it on the blocking thread pool.
    let result = tokio::task::spawn_blocking(move || {
        worktree::apply_worktree(&guard, mode, &message, base.as_deref())
    })
    .await;

    match result {
        Ok(Ok(success)) => Json(json!({
            "success": true,
            "commit": success.commit,
            "pr_url": success.pr_url,
        }))
        .into_response(),

        Ok(Err(conflict)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "merge_conflict",
                "conflicted_files": conflict.conflicted_files,
            })),
        )
            .into_response(),

        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("apply task panicked: {e}"),
        ),
    }
}

// ── Retrieval handlers (spec unit U17) ────────────────────────────────────────
//
// Auto-injection IS now wired: the `chat_stream` handler resolves the
// `auto-recall-enabled` pref (default ON) and threads an `AutoRecallConfig` into
// `route_chat_stream`, which retrieves relevant long-term memory + past chat
// messages (current conversation excluded) and folds them into `long_term_system`
// so both planes inherit it (fail-open). These explicit endpoints remain for
// indexing chunks and for direct/manual retrieval queries.

#[derive(serde::Deserialize)]
struct IndexChunkBody {
    id: String,
    /// "memory" or "space" (defaults to "memory").
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    space_id: Option<String>,
    content: String,
}

#[utoipa::path(
    post,
    path = "/api/retrieval/index",
    tag = "Retrieval",
    summary = "Index a retrieval chunk",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn index_retrieval_chunk(
    State(state): State<ServerState>,
    Json(body): Json<IndexChunkBody>,
) -> axum::response::Response {
    let source = match body.source.as_deref() {
        Some("space") => ChunkSource::Space,
        _ => ChunkSource::Memory,
    };
    match state
        .retrieval
        .index_chunk(&body.id, source, body.space_id.as_deref(), &body.content)
        .await
    {
        Ok(()) => Json(json!({ "success": true, "id": body.id })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct RetrievalSearchBody {
    query: String,
    #[serde(default)]
    top_k: Option<usize>,
    #[serde(default)]
    space_ids: Option<Vec<String>>,
    #[serde(default)]
    include_memory: Option<bool>,
    #[serde(default)]
    min_score: Option<f32>,
}

#[utoipa::path(
    post,
    path = "/api/retrieval/search",
    tag = "Retrieval",
    summary = "Search indexed chunks + memory",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn search_retrieval(
    State(state): State<ServerState>,
    Json(body): Json<RetrievalSearchBody>,
) -> axum::response::Response {
    let opts = retrieval::RetrievalOptions {
        top_k: body.top_k.unwrap_or(retrieval::DEFAULT_TOP_K),
        space_ids: body.space_ids,
        include_memory: body.include_memory.unwrap_or(true),
        min_score: body.min_score.unwrap_or(0.0),
        ..Default::default()
    };
    match state.retrieval.retrieve(&body.query, &opts).await {
        Ok(chunks) => Json(json!({ "chunks": chunks })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /api/apps` — list all loaded App manifests (built-ins + user-installed),
/// merged with their persisted lifecycle state (installed version, enabled flag).
///
/// Each entry includes:
/// - `id` — manifest id
/// - `kinds` — deduplicated list of [`RunnableKind`] strings bundled by this app
/// - `enabled` — current enabled flag from the lifecycle store
/// - `permission_grants` — verbatim declared grants from `ryu.json` (declarations
///   only; enforcement is Gateway scope — Core never gates calls on grants)
///
/// Returns the manifests loaded at startup via [`PluginManifestLoader`]. The list is
/// stable for the lifetime of this Core process; a restart is required for newly
/// installed apps to appear.
#[utoipa::path(
    get,
    path = "/api/plugins",
    tag = "Plugins",
    summary = "List installed plugins with state",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_apps(State(state): State<ServerState>) -> Json<serde_json::Value> {
    // Attach lifecycle state to each manifest so the client knows install/enable
    // status without a separate round-trip.
    let lifecycle: Vec<crate::plugins::PluginRecord> =
        state.app_store.list().await.unwrap_or_default();

    let manifests = state.app_manifests.read().await;
    let manifests_with_state: Vec<serde_json::Value> = manifests
        .iter()
        .map(|m| {
            let lc = lifecycle.iter().find(|r| r.id == m.id);
            let mut v = serde_json::to_value(m).unwrap_or_default();
            if let Some(obj) = v.as_object_mut() {
                obj.insert(
                    "installed".to_owned(),
                    serde_json::Value::Bool(lc.is_some()),
                );
                obj.insert(
                    "enabled".to_owned(),
                    serde_json::Value::Bool(lc.map_or(false, |r| r.enabled)),
                );
                obj.insert(
                    "installed_version".to_owned(),
                    lc.map_or(serde_json::Value::Null, |r| {
                        serde_json::Value::String(r.version.clone())
                    }),
                );
                // Deduplicated list of Runnable kinds bundled by this app.
                // Lets the Desktop Extensions page know at a glance what kinds of
                // Runnables the app contributes without parsing the full runnables list.
                let kinds: Vec<&str> = {
                    let mut seen = std::collections::HashSet::new();
                    m.runnables
                        .iter()
                        .filter_map(|r| {
                            let s = r.kind.as_str();
                            if seen.insert(s) {
                                Some(s)
                            } else {
                                None
                            }
                        })
                        .collect()
                };
                obj.insert(
                    "kinds".to_owned(),
                    serde_json::to_value(kinds).unwrap_or(serde_json::Value::Array(vec![])),
                );
                // Built-in system apps (Ghost, Shadow) are sidecar-managed; the
                // frontend renders a SystemAppCard and calls the sidecar endpoints
                // instead of the app-lifecycle endpoints.
                let system = crate::plugins::builtins::find_system_plugin(&m.id);
                obj.insert(
                    "built_in".to_owned(),
                    serde_json::Value::Bool(system.is_some()),
                );
                // Two-tier registry (#444): Core (first-party, default-on) vs
                // Community (opt-in). Derived from membership, so a plugin cannot
                // self-assert Core. Lets the desktop render the Core/Community split.
                obj.insert(
                    "tier".to_owned(),
                    serde_json::Value::String(
                        crate::plugins::builtins::tier_for(&m.id)
                            .as_str()
                            .to_owned(),
                    ),
                );
                if let Some(s) = system {
                    obj.insert(
                        "sidecar_name".to_owned(),
                        serde_json::Value::String(s.sidecar_name.to_owned()),
                    );
                    obj.insert(
                        "windows_first".to_owned(),
                        serde_json::Value::Bool(s.windows_first),
                    );
                    obj.insert(
                        "local_only".to_owned(),
                        serde_json::Value::Bool(s.local_only),
                    );
                } else {
                    obj.insert("sidecar_name".to_owned(), serde_json::Value::Null);
                    obj.insert("windows_first".to_owned(), serde_json::Value::Bool(false));
                    obj.insert("local_only".to_owned(), serde_json::Value::Bool(false));
                }
            }
            v
        })
        .collect();

    Json(json!({ "apps": manifests_with_state }))
}

// ── App catalog browse + install-from-URL + hot-reload (#427, #428) ───────────

/// `GET /api/apps/catalog` — browse installable apps from the remote registry.
///
/// TTL-cached in `ServerState::catalog_client`; falls back to a stale cache or
/// an empty list when the registry is unreachable. Built-in apps are always
/// discoverable via `GET /api/apps`, so an offline machine is never blank.
#[utoipa::path(
    get,
    path = "/api/plugins/catalog",
    tag = "Plugins",
    summary = "List the plugin catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_apps_catalog(State(state): State<ServerState>) -> Json<serde_json::Value> {
    // The Plugins catalog merges three sources into one `entries` list, deduped by
    // id (first writer wins, in precedence order below). Previously this returned
    // ONLY the remote GitHub registry, which is empty/unreachable in the common
    // case — so the desktop Store's Plugins tab was blank while Skills/MCP/Models
    // (which consult their federated CatalogSource) were not. This brings the
    // Plugin kind to parity: built-in manifests are always shown (offline-safe),
    // the active marketplace source is merged in, and the legacy registry still
    // contributes anything new.
    // 1. Loaded built-in / installed plugin manifests (spider, exa, ghost, shadow,
    //    sample, …). Always present and offline-safe, so the catalog is never blank
    //    — the parity counterpart of the other kinds' built-in registries. The read
    //    guard is scoped to this block so it is dropped before the awaits below.
    let manifest_entries: Vec<serde_json::Value> = {
        let manifests = state.app_manifests.read().await;
        manifests.iter().map(plugin_manifest_to_entry).collect()
    };

    // 2. The active Plugin marketplace source (default = the Ryu marketplace).
    //    Best-effort: a slow/empty/unreachable marketplace degrades silently so it
    //    never blanks the built-ins. The source returns a `{ items: [...] }`
    //    envelope (see `RyuMarketplaceSource::card_to_value`).
    let mut marketplace_entries: Vec<serde_json::Value> = Vec::new();
    if let Some(source) = state
        .catalog_sources
        .get_active(
            crate::catalog_source::CatalogKind::Plugin,
            &state.preferences,
        )
        .await
    {
        let q = crate::catalog_source::CatalogQuery {
            limit: 40,
            ..Default::default()
        };
        if let Ok(val) = source.search(&state.client, &q).await {
            if let Some(items) = val.get("items").and_then(|v| v.as_array()) {
                marketplace_entries = items
                    .iter()
                    .filter_map(|it| plugin_marketplace_item_to_entry(it, source.id()))
                    .collect();
            }
        }
    }

    // 3. The legacy remote registry.
    let catalog = state.catalog_client.fetch_catalog().await;
    let registry_entries: Vec<serde_json::Value> = serde_json::to_value(&catalog)
        .ok()
        .and_then(|v| v.get("entries").and_then(|e| e.as_array()).cloned())
        .unwrap_or_default();

    // Merge, deduped by id (first writer wins): built-ins → marketplace → registry.
    let entries = merge_plugin_catalog_entries(vec![
        manifest_entries,
        marketplace_entries,
        registry_entries,
    ]);
    Json(json!({ "entries": entries }))
}

/// Map a loaded [`crate::plugin_manifest::PluginManifest`] to a Plugins-catalog
/// `CatalogEntry`. Built-in system apps (Ghost/Shadow) are flagged so the desktop
/// renders them as system cards.
fn plugin_manifest_to_entry(m: &crate::plugin_manifest::PluginManifest) -> serde_json::Value {
    let kinds: Vec<&str> = {
        let mut s = std::collections::HashSet::new();
        m.runnables
            .iter()
            .filter_map(|r| {
                let k = r.kind.as_str();
                if s.insert(k) {
                    Some(k)
                } else {
                    None
                }
            })
            .collect()
    };
    json!({
        "id": m.id,
        "name": m.name,
        "description": "",
        "version": m.version,
        "source": "built-in",
        "kinds": kinds,
        "tags": [],
        "permission_grants": m.permission_grants,
        "built_in": crate::plugins::builtins::find_system_plugin(&m.id).is_some(),
    })
}

/// Map one Ryu-marketplace plugin item (`{ id, name, description, version, … }`,
/// the `RyuMarketplaceSource` plugin card shape) to a Plugins-catalog
/// `CatalogEntry`. Returns `None` when the item carries no id.
fn plugin_marketplace_item_to_entry(
    it: &serde_json::Value,
    source_id: &str,
) -> Option<serde_json::Value> {
    let id = it.get("id").and_then(|v| v.as_str())?;
    Some(json!({
        "id": id,
        "name": it.get("name").and_then(|v| v.as_str()).unwrap_or(id),
        "description": it.get("description").and_then(|v| v.as_str()).unwrap_or(""),
        "version": it.get("version").and_then(|v| v.as_str()).unwrap_or(""),
        "source": source_id,
        "kinds": [],
        "tags": [],
        "permission_grants": [],
        "built_in": false,
    }))
}

/// Merge plugin-catalog entry groups into one list, deduped by `id` (first writer
/// wins, in group order). Pure, so it is unit-testable without a live
/// `ServerState`. An entry with no string `id` is dropped.
fn merge_plugin_catalog_entries(groups: Vec<Vec<serde_json::Value>>) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for group in groups {
        for e in group {
            if let Some(id) = e.get("id").and_then(|v| v.as_str()) {
                if seen.insert(id.to_owned()) {
                    out.push(e);
                }
            }
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct InstallFromUrlRequest {
    url: String,
}

/// SSRF guard for a single resolved IPv4 address: loopback (127/8), RFC1918
/// private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, includes the
/// cloud metadata endpoint), unspecified (0.0.0.0), the 0.0.0.0/8 block,
/// broadcast, and CGNAT shared space (100.64/10).
fn is_blocked_ipv4(v4: std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 0x40)
}

/// SSRF guard for a single resolved IP. Rejects loopback / private / link-local
/// ranges for both families, IPv6 unique-local (fc00::/7) and link-local
/// (fe80::/10), and any IPv4-mapped form of a blocked v4 address.
pub(crate) fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_blocked_ipv4(v4),
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return true;
            }
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_blocked_ipv4(mapped);
            }
            let seg0 = v6.segments()[0];
            // fc00::/7 (unique local) or fe80::/10 (link local).
            (seg0 & 0xfe00) == 0xfc00 || (seg0 & 0xffc0) == 0xfe80
        }
    }
}

/// Cloud-metadata hostnames that must never be fetched, in addition to the
/// 169.254.169.254 IP already screened by [`is_blocked_ip`]. Matched
/// case-insensitively as an exact host or a domain suffix.
const BLOCKED_METADATA_HOSTS: &[&str] = &["metadata.google.internal", "metadata.goog"];

/// SSRF host-name guard applied inside every resolve path so all callers
/// benefit. Returns `Err(reason)` when the host must be rejected. Rejects:
/// - cloud-metadata hostnames (`metadata.google.internal`, `metadata.goog`,
///   and bare `metadata`), case-insensitive, exact or domain-suffix match;
/// - hostile / homograph hosts: any non-ASCII character (covers unicode
///   homographs, zero-width joiners, and bidi-control code points), any
///   embedded control character or whitespace, or a domain that fails to
///   round-trip through IDNA/punycode (decode mismatch).
///
/// IP literals are passed through (they are screened by [`is_blocked_ip`]
/// after resolution); only domain names get the IDNA round-trip.
fn screen_guarded_hostname(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("host is empty".to_owned());
    }
    // Control characters or whitespace anywhere in the host are illegal. This
    // also rejects leading/trailing whitespace and embedded newlines (checked
    // on the raw input, before any trimming, so a trailing `\n` cannot slip
    // through).
    if host.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("host contains control or whitespace characters".to_owned());
    }
    // Non-ASCII covers unicode homographs, zero-width joiners, and bidi marks.
    if !host.is_ascii() {
        return Err("non-ASCII host is not allowed".to_owned());
    }
    // Strip a single trailing dot (absolute FQDN form) for the remaining
    // checks so `example.com.` is treated like `example.com`.
    let bare = host.strip_suffix('.').unwrap_or(host);
    let lower = bare.to_ascii_lowercase();
    // Cloud-metadata hostname denylist (the IP form is screened separately).
    let is_metadata = lower == "metadata"
        || BLOCKED_METADATA_HOSTS
            .iter()
            .any(|deny| lower == *deny || lower.ends_with(&format!(".{deny}")));
    if is_metadata {
        return Err("cloud metadata host is not allowed".to_owned());
    }
    // IP literals (bracketed IPv6 from `host_str`, bare IPv4/IPv6 from clone
    // parsing) are handled by `is_blocked_ip` after resolution; don't run the
    // IDNA round-trip on them.
    let unbracketed = lower.trim_start_matches('[').trim_end_matches(']');
    if unbracketed.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    // IDNA round-trip: an ASCII domain must parse + re-serialize unchanged. A
    // host that decodes to a different value (malformed/ambiguous punycode) is
    // rejected.
    match url::Host::parse(bare) {
        Ok(parsed) if parsed.to_string().eq_ignore_ascii_case(bare) => Ok(()),
        Ok(_) => Err("host failed IDNA round-trip".to_owned()),
        Err(e) => Err(format!("invalid host: {e}")),
    }
}

/// `POST /api/apps/install` — install an app by fetching its `ryu.json` from an
/// `https://` URL, validating it, writing it under the apps dir, and hot-reloading.
///
/// ## Security (SSRF guard)
///
/// Only `https://` URLs are accepted. The host is resolved with `getaddrinfo`
/// and rejected if *any* resolved IP is loopback / private / link-local / ULA /
/// CGNAT (so a DNS name pointing at an internal address is caught, not just
/// literal IPs). The fetch client is then pinned to those validated IPs (no
/// re-resolution, defeating DNS rebinding) and redirects are disabled so a
/// remote cannot bounce the request to an internal host after the check.
#[utoipa::path(
    post,
    path = "/api/plugins/install",
    tag = "Plugins",
    summary = "Install a plugin from a URL",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn install_app_from_url(
    State(state): State<ServerState>,
    Json(body): Json<InstallFromUrlRequest>,
) -> axum::response::Response {
    let url = body.url.trim().to_string();
    if !url.starts_with("https://") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Only https:// URLs are allowed".to_owned(),
        );
    }

    // Parse the URL and pull out the host + port for resolution.
    let parsed = match url::Url::parse(&url) {
        Ok(p) => p,
        Err(e) => {
            return json_error(StatusCode::BAD_REQUEST, format!("Invalid URL: {e}"));
        }
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_owned(),
        None => {
            return json_error(StatusCode::BAD_REQUEST, "URL has no host".to_owned());
        }
    };
    if host.eq_ignore_ascii_case("localhost") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Private/loopback URLs are not allowed".to_owned(),
        );
    }
    if let Err(e) = screen_guarded_hostname(&host) {
        return json_error(StatusCode::BAD_REQUEST, e);
    }
    let port = parsed.port_or_known_default().unwrap_or(443);

    // Resolve the host (getaddrinfo) off the async runtime and reject if ANY
    // resolved IP is private/loopback/link-local/etc. This catches DNS names
    // that point at internal addresses, not just literal IPs.
    let resolve_host = host.clone();
    let resolved: Vec<std::net::SocketAddr> = match tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (resolve_host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect::<Vec<_>>())
    })
    .await
    {
        Ok(Ok(addrs)) => addrs,
        Ok(Err(e)) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!("Failed to resolve host: {e}"),
            );
        }
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DNS resolution task failed: {e}"),
            );
        }
    };
    if resolved.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Host did not resolve".to_owned());
    }
    if resolved.iter().any(|addr| is_blocked_ip(addr.ip())) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Private/loopback URLs are not allowed".to_owned(),
        );
    }

    // Fetch the manifest with a client pinned to the validated IPs (no
    // re-resolution → no DNS rebinding) and redirects disabled (a remote can't
    // bounce us to an internal host after the check).
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &resolved)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build HTTP client: {e}"),
            );
        }
    };

    // Cap the manifest body so an allowlisted host can't OOM us with a huge
    // response. A ryu.json manifest is small; 2 MiB is a generous ceiling.
    const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
    let manifest_json = match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Some(len) = resp.content_length() {
                if len > MAX_MANIFEST_BYTES {
                    return json_error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Manifest is too large".to_owned(),
                    );
                }
            }
            match resp.bytes().await {
                Ok(bytes) if (bytes.len() as u64) > MAX_MANIFEST_BYTES => {
                    return json_error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Manifest is too large".to_owned(),
                    );
                }
                Ok(bytes) => match String::from_utf8(bytes.to_vec()) {
                    Ok(text) => text,
                    Err(e) => {
                        return json_error(
                            StatusCode::UNPROCESSABLE_ENTITY,
                            format!("Manifest is not valid UTF-8: {e}"),
                        );
                    }
                },
                Err(e) => {
                    return json_error(
                        StatusCode::BAD_GATEWAY,
                        format!("Failed to read response: {e}"),
                    );
                }
            }
        }
        Ok(resp) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("Remote returned status {}", resp.status()),
            );
        }
        Err(e) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to fetch manifest: {e}"),
            );
        }
    };

    // Parse and validate the manifest.
    let manifest: crate::plugin_manifest::PluginManifest =
        match serde_json::from_str(&manifest_json) {
            Ok(m) => m,
            Err(e) => {
                return json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    format!("Invalid manifest JSON: {e}"),
                );
            }
        };

    // Validate the app id BEFORE it is ever used as a filesystem path component
    // (see `apps_dir().join(&manifest.id)` below). A crafted id like
    // "../../etc/x" or an absolute/drive-qualified path would otherwise escape
    // the apps directory and write an arbitrary file. `validate_plugin_id` uses a
    // strict allowlist, so traversal and absolute-path ids are both rejected.
    if let Err(e) = crate::plugin_manifest::validate_plugin_id(&manifest.id) {
        return json_error(StatusCode::UNPROCESSABLE_ENTITY, e);
    }

    // Validate semver up front so a bad version is a 422, not a silent install.
    if semver::Version::parse(&manifest.version).is_err() {
        return json_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "manifest version '{}' is not valid semver",
                manifest.version
            ),
        );
    }

    // Validate each Runnable's per-kind config contract.
    for entry in &manifest.runnables {
        if let Err(e) = crate::plugin_manifest::schema::validate_runnable(entry) {
            return json_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("Invalid runnable '{}': {e}", entry.id),
            );
        }
    }

    // Reject a duplicate id (don't clobber an existing app).
    {
        let manifests = state.app_manifests.read().await;
        if manifests.iter().any(|m| m.id == manifest.id) {
            return json_error(
                StatusCode::CONFLICT,
                format!("App '{}' is already installed", manifest.id),
            );
        }
    }

    // Write to disk under the plugins dir (same resolver the loader reads from).
    let app_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir().join(&manifest.id);
    if let Err(e) = tokio::fs::create_dir_all(&app_dir).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to create plugin directory: {e}"),
        );
    }
    let manifest_path = app_dir.join("plugin.json");
    if let Err(e) = tokio::fs::write(&manifest_path, &manifest_json).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write manifest: {e}"),
        );
    }

    // Hot-reload so the new app appears in `GET /api/apps` without a restart.
    reload_manifests_inner(&state).await;

    Json(json!({
        "success": true,
        "app": { "id": manifest.id, "name": manifest.name, "version": manifest.version }
    }))
    .into_response()
}

/// `POST /api/apps/reload` — re-scan built-ins + `~/.ryu/apps/*/ryu.json` and
/// replace the in-memory manifest set. Idempotent.
#[utoipa::path(
    post,
    path = "/api/plugins/reload",
    tag = "Plugins",
    summary = "Reload plugin manifests from disk",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn reload_app_manifests(State(state): State<ServerState>) -> Json<serde_json::Value> {
    reload_manifests_inner(&state).await;
    Json(json!({ "success": true }))
}

/// Re-load all manifests from disk and swap the in-memory set. `load()` returns
/// a `Vec` directly (not a `Result`), so this never fails; a parse error in one
/// manifest only drops that manifest with a logged warning.
async fn reload_manifests_inner(state: &ServerState) {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load();
    let mut lock = state.app_manifests.write().await;
    let count = manifests.len();
    *lock = manifests;
    tracing::info!("app manifests hot-reloaded: {count} loaded");
}

/// Compute the set of MCP tool name slugs claimed by disabled apps.
///
/// A grant entry has the form `"mcp:<tool_slug>"`. This function scans every
/// loaded manifest, looks up its enabled/disabled state, and builds two sets:
///
/// - `disabled_claimed` — slugs claimed by at least one *disabled* app.
/// - `enabled_claimed`  — slugs claimed by at least one *enabled* app.
///
/// The caller uses these to decide visibility: a tool is filtered out only when
/// it is claimed by a disabled app and NOT claimed by any enabled app.
///
/// ## Why "claimed by any enabled app wins"
///
/// Two apps may legitimately declare the same grant (e.g. both a Research app and
/// a Summariser app declare `mcp:web_search`). If either is enabled, the tool
/// should be discoverable — removing it only when the last claimant is disabled.
fn app_tool_claim_sets(
    manifests: &[crate::plugin_manifest::PluginManifest],
    lifecycle: &[crate::plugins::PluginRecord],
) -> (
    std::collections::HashSet<String>,
    std::collections::HashSet<String>,
) {
    let mut disabled_claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut enabled_claimed: std::collections::HashSet<String> = std::collections::HashSet::new();

    for m in manifests {
        let enabled = lifecycle
            .iter()
            .find(|r| r.id == m.id)
            .map_or(false, |r| r.enabled);

        for grant in &m.permission_grants {
            // Permission grants for MCP tools follow the "mcp:<tool_slug>" convention.
            if let Some(slug) = grant.strip_prefix("mcp:") {
                if enabled {
                    enabled_claimed.insert(slug.to_owned());
                } else {
                    disabled_claimed.insert(slug.to_owned());
                }
            }
        }
    }

    (disabled_claimed, enabled_claimed)
}

// ── Skill handlers (M3 / issue #145) ─────────────────────────────────────────

/// `GET /api/skills` — list all installed skills with their enabled state.
///
/// Skills live in the universal `~/.claude/skills/<id>/SKILL.md`. This endpoint lets agents and
/// UIs discover available skills (AC1). Each entry carries a `kind = "skill"`
/// field so the listing is heterogeneous-runnable compatible.
#[utoipa::path(
    get,
    path = "/api/skills",
    tag = "Skills",
    summary = "List installed skills",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_skills(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let summaries: Vec<SkillSummary> = state
        .skills
        .list_all()
        .iter()
        .map(SkillSummary::from)
        .collect();
    Json(json!({ "skills": summaries }))
}

// ── App lifecycle handlers (M3 / U033) ───────────────────────────────────────

/// Find a manifest by `id` from the loaded set. This is a synchronous helper
/// used by handlers that hold a read guard.
async fn find_manifest(
    state: &ServerState,
    id: &str,
) -> Option<crate::plugin_manifest::PluginManifest> {
    let manifests = state.app_manifests.read().await;
    manifests.iter().find(|m| m.id == id).cloned()
}

/// `POST /api/apps/:id/install` — record the app as installed (disabled).
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/install",
    tag = "Plugins",
    summary = "Install a built-in plugin by id",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn install_app_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let Some(manifest) = find_manifest(&state, &id).await else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("no manifest found for app '{id}'; ensure the ryu.json is loaded"),
        );
    };

    match crate::plugins::lifecycle::install_app(&state.app_store, &manifest).await {
        Ok(record) => Json(json!({ "success": true, "app": record })).into_response(),
        Err(e) => {
            let msg = e.to_string();
            // Conflict: already installed.
            let status = if msg.contains("UNIQUE constraint") || msg.contains("already") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}

/// `POST /api/apps/:id/enable` — validate grants via Gateway, then enable.
///
/// Fails closed: if the Gateway is unreachable the app stays disabled and a
/// clear 503 error is returned. If the Gateway denies a grant a 403 is returned.
///
/// After a successful enable the manifest's Runnables are activated via
/// [`crate::runnable::RunnableRegistry`]. Per-Runnable results are included in
/// the response so the caller can see which Runnables were registered and which
/// (if any) encountered a partial failure. A partial failure does NOT roll back
/// the enable — Core-owned kinds (Agent, Workflow, Tool) are activated; kinds
/// without a built-in handler (Policy, Engine — Gateway's domain) produce an
/// observable "no handler" error.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/enable",
    tag = "Plugins",
    summary = "Enable a plugin (activate its runnables)",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn enable_app_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    use crate::plugins::lifecycle::{enable_app, EnableError};
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    let Some(manifest) = find_manifest(&state, &id).await else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("no manifest found for app '{id}'; ensure the ryu.json is loaded"),
        );
    };

    let gw_url = gateway_url();
    let gw_token = gateway_token();

    let record = match enable_app(
        &state.app_store,
        &manifest,
        &gw_url,
        gw_token.as_deref(),
        &state.client,
    )
    .await
    {
        Ok(record) => record,
        Err(EnableError::GrantsDenied { denied }) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "success": false,
                    "error": "Gateway denied one or more grants",
                    "denied_grants": denied,
                })),
            )
                .into_response();
        }
        Err(EnableError::GatewayUnreachable { reason }) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "success": false,
                    "error": "Gateway unreachable; enable fails closed",
                    "reason": reason,
                })),
            )
                .into_response();
        }
        Err(EnableError::Other(e)) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };

    // Build and run the RunnableRegistry to activate the manifest's Runnables.
    // Handlers capture cloned subsystem handles; the registry is built per-call
    // so ServerState stays Clone (no non-Clone field added).
    //
    // Use `register_active` against the live fired-event snapshot (#443): an
    // eager plugin (empty `activation_events`, the common case) activates
    // immediately on enable exactly as before, but a plugin gated on a not-yet
    // fired event (e.g. `onCommand:x`) is correctly held back until that event
    // lands via `fire_activation_event`. This keeps the enable path and the
    // event-driven path on one activation contract.
    let fired = crate::runnable::fired_activation_events();
    let runnable_results = build_runnable_registry(&state).register_active(&manifest, &fired);

    // Apply async runtime side effects the sync handlers can't (gateway I/O).
    // Dispatches per Policy runnable: headroom compression / firewall / routing /
    // sandbox — turning each ON for this enable.
    apply_policy(&state, &manifest, true).await;

    // Provision the plugin's declared external runtime (#449), if any. Gated on
    // Core tier + best-effort + spawned so a slow pip install never blocks the
    // enable response. The TTS sidecar precedent (a Python venv) is the shape.
    provision_external_runtime(&manifest);

    // Collect per-Runnable outcomes for the response (success + failures both
    // surfaced so the caller can observe partial failures without silent drops).
    let runnable_statuses: Vec<serde_json::Value> = runnable_results
        .into_iter()
        .map(|(rid, res)| match res {
            Ok(()) => json!({ "id": rid, "ok": true }),
            Err(e) => json!({ "id": rid, "ok": false, "error": e }),
        })
        .collect();

    Json(json!({
        "success": true,
        "app": record,
        "runnables": runnable_statuses,
    }))
    .into_response()
}

/// Build a [`crate::runnable::RunnableRegistry`] with default Core handlers
/// wired to the live subsystem handles in `state`.
///
/// Only Core-owned kinds receive built-in handlers:
/// - **Agent** - upserts into [`AgentStore`] using the app-namespaced id.
/// - **Workflow** - persists a skeleton workflow via the file-backed store.
/// - **Tool** - registers an in-memory tool in [`McpRegistry`].
///
/// Kinds owned by the Gateway (Policy, Engine) and UI-only kinds (Companion,
/// Channel, Skill) have no built-in handler, producing an observable
/// "no handler" error in `register_all`. This is intentional — it keeps Core
/// strictly on the "what runs" side of the Core-vs-Gateway rule.
fn build_runnable_registry(state: &ServerState) -> crate::runnable::RunnableRegistry {
    use crate::agents::CreateAgent;
    use crate::plugin_manifest::schema::{AgentConfig, PolicyConfig, ToolConfig, WorkflowConfig};
    use crate::runnable::{RunnableHandler, RunnableRegistry};

    let mut registry = RunnableRegistry::new();

    // ── Agent handler ────────────────────────────────────────────────────────
    {
        let agent_store = state.agent_store.clone();
        registry.register_handler(
            crate::runnable::RunnableKind::Agent,
            Box::new(
                move |entry: &crate::plugin_manifest::schema::RunnableEntry| {
                    let id = format!("app__{}", entry.id);
                    let cfg: AgentConfig = entry
                        .config
                        .as_ref()
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();

                    let create = CreateAgent {
                        name: entry.name.clone(),
                        system_prompt: cfg.system_prompt,
                        tools: cfg.tools,
                        model: cfg.model,
                        ..Default::default()
                    };

                    // Use block_in_place so the synchronous handler can await the
                    // async AgentStore::create_with_id call. Idempotent: if the id
                    // already exists the DB returns a unique-constraint error, which
                    // we treat as success (re-enable is a no-op on the agent record).
                    let result = tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current()
                            .block_on(agent_store.create_with_id(id.clone(), create))
                    });
                    match result {
                        Ok(_) => Ok(()),
                        Err(e) => {
                            let msg = e.to_string();
                            if msg.contains("UNIQUE constraint") || msg.contains("already") {
                                Ok(()) // idempotent re-enable
                            } else {
                                Err(format!("agent '{}': {msg}", entry.id))
                            }
                        }
                    }
                },
            ) as RunnableHandler,
        );
    }

    // ── Workflow handler ─────────────────────────────────────────────────────
    registry.register_handler(
        crate::runnable::RunnableKind::Workflow,
        Box::new(|entry: &crate::plugin_manifest::schema::RunnableEntry| {
            use crate::workflow::{store::save_workflow, Workflow};

            let cfg: WorkflowConfig = entry
                .config
                .as_ref()
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .ok_or_else(|| format!("workflow '{}': missing or invalid config", entry.id))?;

            let id = format!("app__{}", entry.id);
            let now = chrono::Utc::now().to_rfc3339();
            let wf = Workflow {
                id: id.clone(),
                name: entry.name.clone(),
                description: None,
                nodes: vec![],
                edges: vec![],
                triggers: Vec::new(),
                created_at: Some(now.clone()),
                updated_at: Some(now),
            };
            // Entry field is recorded in the description so it's not lost.
            let mut wf = wf;
            wf.description = Some(format!("entry: {}", cfg.entry));

            save_workflow(&wf).map_err(|e| format!("workflow '{}': {e}", entry.id))
        }) as RunnableHandler,
    );

    // ── Tool handler ─────────────────────────────────────────────────────────
    {
        let mcp = Arc::clone(&state.mcp);
        registry.register_handler(
            crate::runnable::RunnableKind::Tool,
            Box::new(
                move |entry: &crate::plugin_manifest::schema::RunnableEntry| {
                    let cfg: ToolConfig = entry
                        .config
                        .as_ref()
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .ok_or_else(|| format!("tool '{}': missing or invalid config", entry.id))?;

                    let id = format!("app__{}", cfg.slug);
                    mcp.register_app_tool(
                        id,
                        cfg.slug.clone(),
                        Some(format!(
                            "App-registered tool '{}' (slug: {})",
                            entry.name, cfg.slug
                        )),
                    );
                    Ok(())
                },
            ) as RunnableHandler,
        );
    }

    // ── Policy handler ───────────────────────────────────────────────────────
    // Policy enforcement is a Gateway concern (Core-vs-Gateway rule), so this
    // handler does NO inline enforcement and NO I/O: it only validates the
    // declared policy so `register_all` does not fail on a Policy runnable. The
    // actual activation (e.g. toggling the gateway's egress compression for a
    // `compression` policy) is performed by the async enable/disable handlers,
    // which can do the gateway refresh without the sync-handler→async hazard.
    registry.register_handler(
        crate::runnable::RunnableKind::Policy,
        Box::new(|entry: &crate::plugin_manifest::schema::RunnableEntry| {
            let _cfg: PolicyConfig = entry
                .config
                .as_ref()
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .ok_or_else(|| format!("policy '{}': missing or invalid config", entry.id))?;
            Ok(())
        }) as RunnableHandler,
    );

    registry
}

/// Fire an activation event (`#443`): wake every **enabled** plugin whose
/// `activation_events` match the just-fired event, activating its Runnables via
/// the same [`build_runnable_registry`] dispatch the enable path uses.
///
/// This is the live runtime driver behind the activation contract. The event is
/// recorded in the process-global fired set (so a plugin enabled *after* the
/// event still sees it via the snapshot), then every enabled plugin is run
/// through [`crate::runnable::RunnableRegistry::register_active`] against the
/// snapshot — eager plugins (empty `activation_events`) always activate, gated
/// plugins activate only once one of their declared events has fired.
///
/// Idempotent and safe to call repeatedly: the Core handlers swallow re-register
/// (the Agent handler treats UNIQUE-constraint as success; Workflow `save` and
/// Tool `register_app_tool` overwrite in place). Best-effort — a per-Runnable
/// failure is logged, never fatal.
///
/// `onStartup` is fired from `main.rs` once `ServerState` exists; `onChat` /
/// `onCommand:<id>` / `onRunnable:<id>` are data-wiring follow-ons that call this
/// same driver from the chat and command-palette paths.
pub async fn fire_activation_event(state: &ServerState, event: &str) {
    let snapshot = crate::runnable::mark_activation_event_fired(event);

    // The set of installed+enabled plugins; only these may activate.
    let enabled_ids: std::collections::HashSet<String> = match state.app_store.list().await {
        Ok(records) => records
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| r.id)
            .collect(),
        Err(e) => {
            tracing::warn!("fire_activation_event('{event}'): listing plugins failed: {e}");
            return;
        }
    };
    if enabled_ids.is_empty() {
        return;
    }

    let registry = build_runnable_registry(state);
    let manifests = state.app_manifests.read().await.clone();
    for manifest in &manifests {
        if !enabled_ids.contains(&manifest.id) {
            continue;
        }
        let results = registry.register_active(manifest, &snapshot);
        for (rid, res) in results {
            if let Err(e) = res {
                tracing::debug!(
                    "fire_activation_event('{event}'): plugin '{}' runnable '{rid}': {e}",
                    manifest.id
                );
            }
        }
    }
}

/// Collect the `policy_type` of every `Policy` runnable in a manifest.
fn manifest_policy_types(manifest: &crate::plugin_manifest::PluginManifest) -> Vec<String> {
    manifest_policies(manifest)
        .into_iter()
        .map(|c| c.policy_type)
        .collect()
}

/// `GET /api/plugins/contributions` — the declarative UI contributions (composer
/// controls, settings tabs, slash commands) of every **enabled** plugin, each
/// tagged with its owning `plugin` id. The desktop renders the known widget types
/// from this; new widget types need no Core change (Core passes them verbatim).
/// This is what lets a plugin like double-check/goal contribute its composer
/// toggle / slash command without editing the closed desktop source.
async fn plugin_contributions(State(state): State<ServerState>) -> axum::response::Response {
    let enabled_ids: std::collections::HashSet<String> = match state.app_store.list().await {
        Ok(records) => records
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| r.id)
            .collect(),
        Err(e) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };
    let mut composer_controls = Vec::new();
    let mut settings_tabs = Vec::new();
    let mut slash_commands = Vec::new();
    let mut turn_hooks = Vec::new();

    let manifests = state.app_manifests.read().await;
    for manifest in manifests.iter() {
        if !enabled_ids.contains(&manifest.id) {
            continue;
        }
        let Some(c) = &manifest.contributes else {
            continue;
        };
        // Tag each contribution with its owning plugin id so the desktop knows
        // which `plugin_flags` entry a toggle sets / which plugin a tab belongs to.
        let tag = |mut v: serde_json::Value| {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("plugin".to_string(), serde_json::json!(manifest.id));
            }
            v
        };
        composer_controls.extend(c.composer_controls.iter().cloned().map(tag));
        settings_tabs.extend(c.settings_tabs.iter().cloned().map(tag));
        slash_commands.extend(c.slash_commands.iter().cloned().map(tag));
        turn_hooks.extend(
            c.turn_hooks
                .iter()
                .map(|h| serde_json::json!({ "plugin": manifest.id, "id": h.id, "on": h.on })),
        );
    }
    Json(json!({
        "composer_controls": composer_controls,
        "settings_tabs": settings_tabs,
        "slash_commands": slash_commands,
        "turn_hooks": turn_hooks,
    }))
    .into_response()
}

/// Collect the full [`PolicyConfig`] (type + definition) of every `Policy`
/// runnable in a manifest, so [`apply_policy`] can data-drive a policy from its
/// declared `definition` (e.g. the compression service URL) rather than a
/// hardcoded value.
fn manifest_policies(
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Vec<crate::plugin_manifest::schema::PolicyConfig> {
    manifest
        .runnables
        .iter()
        .filter(|r| r.kind == crate::runnable::RunnableKind::Policy)
        .filter_map(|r| {
            r.config.as_ref().and_then(|v| {
                serde_json::from_value::<crate::plugin_manifest::schema::PolicyConfig>(v.clone())
                    .ok()
            })
        })
        .collect()
}

/// Apply a manifest's **policy** runtime side effects (the async work the sync
/// [`RunnableRegistry`] Policy handler cannot do — it stays validate-only per the
/// Core-vs-Gateway rule). Dispatches on each `Policy` runnable's `policy_type`.
///
/// `enabled` selects direction (true on plugin-enable, false on plugin-disable).
/// Each arm only flips the policy's **active state** (a process-global flag) and,
/// where needed, runs the local side effect (start/stop the headroom proxy); the
/// rich policy *definition* (firewall pattern set, routing model_map) stays in
/// the gateway's `/v1/config`. A `gateway.refresh()` respawns the gateway once at
/// the end (batched) so `gateway_spawn_env` re-reads every flipped flag. An
/// unknown `policy_type` is a logged no-op, never a panic. All steps are
/// best-effort and logged.
///
/// Arms:
/// - `compression` — headroom egress compression (flag + proxy start/stop).
/// - `firewall` — force the gateway firewall on (flag only; gateway enforces).
/// - `routing` — force smart (classifier) routing on (flag only).
/// - `sandbox` — Core wasmtime sandbox availability (in-process flag, no gateway).
async fn apply_policy(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    enabled: bool,
) {
    let policies = manifest_policies(manifest);
    if policies.is_empty() {
        return;
    }

    let mut gateway_dirty = false;

    for policy in &policies {
        match policy.policy_type.as_str() {
            "compression" => {
                // Data-drive the compression service from the policy `definition`
                // (url/token/timeout_ms/min_messages/service) rather than a
                // hardcoded URL, so any compression plugin — not just the bundled
                // `io.ryu.headroom` — works by pointing at its own `/v1/compress`
                // service. The gateway transform (`compression.rs`) is the generic
                // protocol host; the *service* is the plugin (MCP-style split).
                if enabled {
                    crate::sidecar::headroom::set_compression_policy(
                        crate::sidecar::headroom::CompressionPolicy::from_definition(
                            &policy.definition,
                        ),
                    );
                } else {
                    crate::sidecar::headroom::set_compression_policy(Default::default());
                }
                crate::sidecar::headroom::set_enabled(enabled);
                // Manage the bundled local proxy only when the active service IS
                // the bundled headroom one; a third-party service URL is the
                // plugin's own process and Core only configures the gateway.
                if crate::sidecar::headroom::manages_bundled_service() {
                    if enabled {
                        if let Err(e) = state.headroom.start().await {
                            tracing::warn!(
                                "headroom: start on plugin-enable failed (compression may pass through): {e}"
                            );
                        }
                    } else if let Err(e) = state.headroom.stop().await {
                        tracing::warn!("headroom: stop on plugin-disable failed: {e}");
                    }
                }
                gateway_dirty = true;
            }
            "firewall" => {
                crate::sidecar::gateway_policy::set_firewall_enabled(enabled);
                gateway_dirty = true;
            }
            "routing" => {
                crate::sidecar::gateway_policy::set_routing_enabled(enabled);
                gateway_dirty = true;
            }
            "sandbox" => {
                // The wasmtime sandbox is a Core-local tool, not a gateway feature
                // — toggling it needs no gateway respawn.
                crate::sidecar::mcp::sandbox::set_enabled(enabled);
            }
            other => {
                tracing::debug!(
                    "apply_policy: no runtime handler for policy_type '{other}'; \
                     validate-only (gateway owns enforcement)"
                );
            }
        }
    }

    // Respawn the gateway ONCE if any flipped flag affects gateway spawn-env
    // (the routing/config "takes effect on next gateway restart" pattern). Batched
    // so enabling several gateway policies at once is one refresh, not N.
    if gateway_dirty {
        if let Err(e) = state.gateway.refresh().await {
            tracing::warn!("gateway: refresh after policy change failed: {e}");
        }
    }
}

/// Resolve the per-plugin external-runtime directory: `<plugins_dir>/<id>/runtime`.
///
/// The venv + pip-installed deps land here, namespaced under the plugin id so two
/// plugins never collide. `<id>` is already path-validated by the manifest loader
/// (`validate_plugin_id`), so this join is traversal-safe.
fn plugin_runtime_dir(plugin_id: &str) -> std::path::PathBuf {
    crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(plugin_id)
        .join("runtime")
}

/// Provision a plugin's declared external runtime (#449) — the live call path for
/// [`crate::sidecar::external_runtime::provision`].
///
/// Gated on the plugin's **Core tier** (per the module's security note: running
/// `pip install` from a manifest is a network + code surface a Community plugin
/// must not reach without a Gateway grant — that grant path is the documented
/// follow-on, so for now only first-party Core-tier plugins provision). The work
/// is **spawned** and **best-effort**: a missing Python interpreter or a failed
/// pip install is logged, never fatal, and never blocks the enable response —
/// exactly the graceful-degrade contract the `RyuTtsManager` venv path follows.
fn provision_external_runtime(manifest: &crate::plugin_manifest::PluginManifest) {
    let Some(runtime) = manifest.runtime.clone() else {
        return;
    };
    // Tier gate: only Core-tier (first-party) plugins may auto-provision today.
    if crate::plugins::builtins::tier_for(&manifest.id) != crate::plugin_manifest::PluginTier::Core
    {
        tracing::info!(
            "plugin '{}' declares an external runtime but is Community-tier; \
             auto-provision is gated to Core-tier (needs a Gateway grant)",
            manifest.id
        );
        return;
    }
    let dir = plugin_runtime_dir(&manifest.id);
    let plugin_id = manifest.id.clone();
    tokio::spawn(async move {
        match crate::sidecar::external_runtime::provision(&runtime, &dir).await {
            Ok(python) => tracing::info!(
                "plugin '{plugin_id}': external runtime provisioned at {}",
                python.display()
            ),
            Err(e) => tracing::warn!(
                "plugin '{plugin_id}': external-runtime provisioning failed (best-effort): {e}"
            ),
        }
    });
}

/// `POST /api/apps/:id/disable` — disable the app and clear its approved grants.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/disable",
    tag = "Plugins",
    summary = "Disable a plugin",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn disable_app_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    match crate::plugins::lifecycle::disable_app(&state.app_store, &id).await {
        Ok(record) => {
            // Deactivate the app's runtime contributions — the symmetric
            // counterpart of `build_runnable_registry` (#444). Each kind enable
            // registers is now torn down on disable, so a disabled plugin's
            // Runnables stop being listable/callable instead of lingering:
            //   - Tool     → unregister the app__<slug> MCP tool.
            //   - Agent    → delete the app__<id> agent record.
            //   - Workflow → delete the app__<id> workflow.
            //   - Policy   → flip the gateway/sandbox policy flag OFF (apply_policy).
            // Deletes are strictly namespaced on the `app__` prefix (the same
            // prefix enable mints) so a user agent/workflow can never be removed.
            if let Some(manifest) = find_manifest(&state, &id).await {
                for entry in &manifest.runnables {
                    match entry.kind {
                        crate::runnable::RunnableKind::Tool => {
                            if let Some(cfg) = entry.config.as_ref().and_then(|v| {
                                serde_json::from_value::<
                                    crate::plugin_manifest::schema::ToolConfig,
                                >(v.clone())
                                .ok()
                            }) {
                                state.mcp.unregister_app_tool(&format!("app__{}", cfg.slug));
                            }
                        }
                        crate::runnable::RunnableKind::Agent => {
                            let agent_id = format!("app__{}", entry.id);
                            if let Err(e) = state.agent_store.delete(&agent_id).await {
                                tracing::warn!(
                                    "plugin disable: removing agent '{agent_id}' failed: {e}"
                                );
                            }
                        }
                        crate::runnable::RunnableKind::Workflow => {
                            let wf_id = format!("app__{}", entry.id);
                            if let Err(e) = crate::workflow::store::delete_workflow(&wf_id) {
                                tracing::warn!(
                                    "plugin disable: removing workflow '{wf_id}' failed: {e}"
                                );
                            }
                        }
                        // Skill / Companion / Channel / Engine: no Core-side
                        // registration on enable today, so nothing to tear down.
                        // Policy is handled by apply_policy below (one batched pass).
                        _ => {}
                    }
                }
                // Symmetric to enable: each Policy runnable (compression / firewall
                // / routing / sandbox) is turned back OFF.
                apply_policy(&state, &manifest, false).await;
            }
            Json(json!({ "success": true, "app": record })).into_response()
        }
        Err(e) => {
            let msg = e.to_string();
            let status = if msg.contains("not installed") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}

/// Request body for `POST /api/apps/:id/update`.
#[derive(serde::Deserialize, Default)]
struct UpdateAppBody {
    /// When `true`, allow downgrading to an older version.
    #[serde(default)]
    force: bool,
}

/// `POST /api/apps/:id/update` — update the installed version from the manifest.
///
/// Refuses a downgrade unless `force = true`.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/update",
    tag = "Plugins",
    summary = "Update a plugin",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn update_app_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    body: Option<Json<UpdateAppBody>>,
) -> axum::response::Response {
    use crate::plugins::lifecycle::{update_app, UpdateError};

    let body = body.map(|b| b.0).unwrap_or_default();

    let Some(manifest) = find_manifest(&state, &id).await else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("no manifest found for app '{id}'; ensure the ryu.json is loaded"),
        );
    };

    match update_app(&state.app_store, &manifest, body.force).await {
        Ok(record) => Json(json!({ "success": true, "app": record })).into_response(),
        Err(UpdateError::Downgrade {
            installed,
            requested,
        }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "error": "downgrade refused",
                "installed_version": installed,
                "requested_version": requested,
                "hint": "pass force=true to override",
            })),
        )
            .into_response(),
        Err(UpdateError::Other(e)) => {
            let msg = e.to_string();
            let status = if msg.contains("not installed") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}

/// Built-in engines (Claude Code, ZeroClaw, …) available to bind an agent to.
/// Each entry reports whether its runtime is installed so the Desktop engine
/// picker can offer only what is usable (U8).
#[utoipa::path(
    get,
    path = "/api/engines",
    tag = "Engines",
    summary = "List engine runtimes",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_engines(State(state): State<ServerState>) -> Json<serde_json::Value> {
    Json(json!({ "engines": state.agents.list_infos() }))
}

/// Per-engine chat-model options, keyed by engine id (e.g. `claude` →
/// Opus/Sonnet/Haiku). Core owns this catalog so every client — desktop, CLI,
/// mobile — shows the same swappable defaults instead of each hardcoding its own
/// list. Clients fall back to a local copy only when offline.
#[utoipa::path(
    get,
    path = "/api/engines/models",
    tag = "Engines",
    summary = "Per-engine chat-model options",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn engine_models() -> Json<serde_json::Value> {
    Json(json!({ "models": crate::sidecar::adapters::engine_model_catalog() }))
}

/// List agents the user can actually pick: the flagship `ryu` plus any built-in
/// agents they have added via the catalog, unioned with custom agents persisted
/// in the SQLite store. Catalog-only built-ins (Claude Code, Codex, Gemini CLI,
/// Pi, OpenClaw, …) are hidden until added — browse + add them via
/// `GET /api/agents/catalog`. Built-in rows are represented by the richer
/// registry info, so we skip their DB rows.
#[utoipa::path(
    get,
    path = "/api/agents",
    tag = "Agents",
    summary = "List installed agents",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_agents(State(state): State<ServerState>) -> Json<serde_json::Value> {
    // Load the registry once per request so the default_agent_id is consistent
    // across both the ACP registry entries and the DB-backed custom records.
    // Config is authoritative for `enabled` (AC4 of U041 — not a DB column).
    let registry = crate::registry::ProviderRegistry::load();
    let default_agent_id = &registry.default_agent_id;

    // Which built-in agents are in the installed set. `ryu` is always present.
    let installed_set = state.agent_store.installed_ids().await.unwrap_or_default();

    let mut agents: Vec<_> = state
        .agents
        .list_infos_with_default(default_agent_id)
        .into_iter()
        .filter(|a| a.id == "ryu" || installed_set.contains(&a.id))
        .collect();

    match state.agent_store.list().await {
        Ok(records) => {
            for record in records {
                // Surface the persona's custom avatar (a data URL) on the summary
                // so the chat picker / transcript can render it without a second
                // fetch of the full record.
                let avatar_url = record
                    .persona
                    .as_ref()
                    .and_then(|p| p.avatar_url.clone());
                // Built-in agents are sourced from the in-code registry above (which
                // has no persona data), so their DB row is otherwise skipped. But a
                // user can still set a custom avatar on a built-in (e.g. Claude Code),
                // and it's persisted on that row — merge it onto the registry entry so
                // the sidebar/chat render the custom image instead of the engine logo.
                if record.built_in {
                    if let Some(url) = avatar_url {
                        if let Some(existing) = agents.iter_mut().find(|a| a.id == record.id) {
                            existing.avatar_url = Some(url);
                        }
                    }
                    continue;
                }
                let locked_flag = record.locked.then_some(true);
                let enabled = (record.id == *default_agent_id).then_some(true);
                agents.push(crate::sidecar::adapters::AgentInfo {
                    id: record.id,
                    name: record.name,
                    description: record.description,
                    install_hint: None,
                    installed: None,
                    model: record.model,
                    system_prompt: record.system_prompt,
                    created_at: record.created_at,
                    engine: None,
                    transport: None,
                    recommended: None,
                    version: Some(record.version),
                    locked: locked_flag,
                    enabled,
                    // Custom agents from the DB don't carry bypass metadata — they
                    // go through the normal OpenAI-compat path.
                    gateway_bypass: None,
                    avatar_url,
                });
            }
        }
        Err(e) => tracing::error!("list_agents: failed to read agent store: {e:#}"),
    }

    Json(json!({ "agents": agents }))
}

/// The full installable agent catalog: every built-in registry agent, with two
/// independent flags so the onboarding/store UI can both *detect* what the user
/// already has and show what they have *added*:
///   - `detected`: the agent's CLI binary is on PATH (`null` for agents with no
///     detectable binary — managed sidecars like OpenClaw, and `ryu` itself).
///   - `added`: the agent is in the installed set (shows in the picker). `ryu`
///     is always `true`.
/// Mirrors the model/skills catalog shape (`GET /api/{models,skills}/catalog`).
#[utoipa::path(
    get,
    path = "/api/agents/catalog",
    tag = "Agents",
    summary = "List the agent catalog (detected CLIs)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_agent_catalog(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let registry = crate::registry::ProviderRegistry::load();
    let installed_set = state.agent_store.installed_ids().await.unwrap_or_default();
    let agents: Vec<_> = state
        .agents
        .list_infos_with_default(&registry.default_agent_id)
        .into_iter()
        .map(|i| {
            let added = i.id == "ryu" || installed_set.contains(&i.id);
            json!({
                "id": i.id,
                "name": i.name,
                "description": i.description,
                "install_hint": i.install_hint,
                "recommended": i.recommended,
                // `installed` from list_infos = binary detected on PATH.
                "detected": i.installed,
                "added": added,
                "gateway_bypass": i.gateway_bypass,
                "engine": i.engine,
                "transport": i.transport,
            })
        })
        .collect();
    Json(json!({ "agents": agents }))
}

#[derive(serde::Deserialize)]
struct AgentCatalogAction {
    id: String,
}

/// Extract the npm package from an `npx -y [--] <pkg> [args]` spawn command,
/// skipping env-var prefixes (`FOO=bar`), `npx` flags, and the `--` separator.
/// Returns `None` for non-npx commands (uvx self-fetch, managed binaries).
fn npx_package_of(spawn_cmd: &str) -> Option<String> {
    let tokens: Vec<&str> = spawn_cmd.split_whitespace().collect();
    let npx_idx = tokens.iter().position(|t| *t == "npx")?;
    tokens.iter().skip(npx_idx + 1).find_map(|t| {
        if *t == "-y" || *t == "--yes" || *t == "--" || t.starts_with('-') {
            None
        } else {
            Some((*t).to_string())
        }
    })
}

/// Warm npx's cache for `pkg` so the package is downloaded and ready before the
/// first chat, mirroring Zed's `npm exec --yes`. We run a cheap `--version` so
/// npx fetches + caches the package without launching the long-lived ACP server;
/// a timeout bounds agents that ignore `--version` (the package is already
/// fetched by the time npx executes it, so the cache stays warm regardless).
async fn warm_npx_package(pkg: &str) {
    #[cfg(target_os = "windows")]
    let (prog, args): (&str, Vec<&str>) = ("cmd", vec!["/c", "npx", "-y", pkg, "--version"]);
    #[cfg(not(target_os = "windows"))]
    let (prog, args): (&str, Vec<&str>) = ("npx", vec!["-y", pkg, "--version"]);

    let mut cmd = tokio::process::Command::new(prog);
    cmd.args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let _ = tokio::time::timeout(std::time::Duration::from_secs(180), cmd.status()).await;
}

/// Actually fetch an agent's runtime (Zed-style), dispatched by how the agent is
/// distributed. Best-effort and non-fatal: every npx/uvx agent also self-fetches
/// on first spawn, so a failure here only costs a one-time first-run delay.
async fn install_agent_runtime(
    entry: crate::sidecar::adapters::acp::AcpAgentEntry,
    downloads: crate::downloads::DownloadCenter,
) {
    use crate::sidecar::adapters::acp::{binary_in_path, AgentTransport};
    use crate::sidecar::agents;

    // Already resolvable on PATH — nothing to fetch.
    if let Some(bin) = entry.detect_binary {
        if binary_in_path(bin) {
            return;
        }
    }

    let id = entry.id.clone();
    let result: anyhow::Result<()> = async {
        // Per-platform GitHub-release binary agents (e.g. goose).
        if let Some(spec) = entry.archive_spec.as_ref() {
            agents::archive_agent::ensure_installed(spec, &downloads).await?;
            return Ok(());
        }
        // Native managed agents with dedicated installers/downloaders. ZeroClaw
        // fetches a GitHub-release binary through the download center so its
        // install shows real progress in the Agents tab (kind `agent`/name),
        // instead of only being added to the picker.
        match id.as_str() {
            "openclaw" => {
                agents::openclaw::installer::ensure_installed().await?;
                return Ok(());
            }
            "zeroclaw" => {
                agents::zeroclaw::ZeroClawDownloader::new()
                    .ensure_installed(&downloads)
                    .await?;
                return Ok(());
            }
            _ => {}
        }
        // npx self-fetching agents (claude/codex/gemini/pi, …): warm the cache.
        // uvx agents and OpenAI-compat servers self-fetch on first use.
        if let AgentTransport::Acp { spawn_cmd } = &entry.transport {
            if let Some(pkg) = npx_package_of(spawn_cmd) {
                warm_npx_package(&pkg).await;
            }
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => tracing::info!(agent = %id, "agent runtime install complete"),
        Err(e) => tracing::warn!(
            agent = %id,
            error = %e,
            "agent runtime install failed; agent will self-fetch on first use"
        ),
    }
}

/// Add a built-in agent to the installed set so it appears in the picker, and
/// kick off a background fetch of its runtime so it's ready before first chat.
/// The fetch is best-effort and non-blocking: registration succeeds immediately
/// and the npx/binary download continues after the response (npx agents also
/// self-fetch on first spawn, so a failure only costs a one-time first-run delay).
#[utoipa::path(
    post,
    path = "/api/agents/catalog/install",
    tag = "Agents",
    summary = "Install an agent from the catalog",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn install_agent_handler(
    State(state): State<ServerState>,
    Json(body): Json<AgentCatalogAction>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(entry) = state
        .agents
        .entries
        .iter()
        .find(|e| e.id == body.id)
        .cloned()
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown agent id: {}", body.id) })),
        );
    };
    match state.agent_store.set_installed(&body.id, true).await {
        Ok(_) => {
            let downloads = state.downloads.clone();
            tokio::spawn(install_agent_runtime(entry, downloads));
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "id": body.id, "installed": true })),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Remove a built-in agent from the installed set (hides it from the picker).
/// The flagship `ryu` cannot be removed.
#[utoipa::path(
    post,
    path = "/api/agents/catalog/uninstall",
    tag = "Agents",
    summary = "Uninstall a catalog agent",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn uninstall_agent_handler(
    State(state): State<ServerState>,
    Json(body): Json<AgentCatalogAction>,
) -> (StatusCode, Json<serde_json::Value>) {
    if !state.agents.entries.iter().any(|e| e.id == body.id) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown agent id: {}", body.id) })),
        );
    }
    match state.agent_store.set_installed(&body.id, false).await {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "id": body.id, "installed": false })),
        ),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    post,
    path = "/api/agents",
    tag = "Agents",
    summary = "Create an agent",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn create_agent(
    State(state): State<ServerState>,
    Json(input): Json<CreateAgent>,
) -> (StatusCode, Json<serde_json::Value>) {
    if input.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "name is required" })),
        );
    }
    match state.agent_store.create(input).await {
        Ok(record) => (StatusCode::CREATED, Json(json!({ "agent": record }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    get,
    path = "/api/agents/{id}",
    tag = "Agents",
    summary = "Get an agent by id",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_agent(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.agent_store.get(&id).await {
        Ok(Some(record)) => (StatusCode::OK, Json(json!({ "agent": record }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("agent '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    put,
    path = "/api/agents/{id}",
    tag = "Agents",
    summary = "Update an agent",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn update_agent(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(patch): Json<UpdateAgent>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.agent_store.update(&id, patch).await {
        Ok(Some(record)) => (StatusCode::OK, Json(json!({ "agent": record }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("agent '{id}' not found") })),
        ),
        Err(e) => {
            let msg = e.to_string();
            // The store returns an error whose message contains "locked" when the
            // agent is immutable. Surface this as 409 Conflict so the client can
            // distinguish a policy rejection from an internal error.
            let status = if msg.contains("locked") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "error": msg })))
        }
    }
}

#[utoipa::path(
    delete,
    path = "/api/agents/{id}",
    tag = "Agents",
    summary = "Delete an agent",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn delete_agent(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.agent_store.delete(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "success": true }))),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("agent '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

// ── Ryu Pi config (the managed Pi's isolated model/provider config) ───────────

/// The current configuration of the Ryu-managed Pi agent (provider, model,
/// thinking level, routing mode). Reads from the isolated `PI_CODING_AGENT_DIR`.
/// Never returns secrets.
#[utoipa::path(
    get,
    path = "/api/pi-config",
    tag = "Agents",
    summary = "Get the Ryu-managed Pi configuration",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_pi_config() -> Json<serde_json::Value> {
    Json(json!({ "config": crate::pi_config::current() }))
}

/// The catalog of providers + models + thinking levels the managed Pi supports,
/// with per-provider `configured` flags. Mirrors pi.dev's supported set.
#[utoipa::path(
    get,
    path = "/api/pi-config/catalog",
    tag = "Agents",
    summary = "List supported Pi providers and models",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_pi_config_catalog() -> Json<serde_json::Value> {
    Json(crate::pi_config::catalog())
}

/// Update the Ryu-managed Pi configuration. Writes `settings.json` (and, in
/// direct-provider mode, `models.json`/`auth.json`) into the isolated config dir.
#[utoipa::path(
    put,
    path = "/api/pi-config",
    tag = "Agents",
    summary = "Update the Ryu-managed Pi configuration",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn put_pi_config(
    Json(input): Json<crate::pi_config::PiConfigInput>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::pi_config::apply(input) {
        Ok(view) => (StatusCode::OK, Json(json!({ "config": view }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Configure a provider's credential / base URL / routing **without** activating
/// it (the Zed-style "set up many, activate one" flow). Returns the refreshed
/// catalog.
#[utoipa::path(
    post,
    path = "/api/pi-config/providers",
    tag = "Agents",
    summary = "Configure a Pi provider without activating it",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn configure_pi_provider(
    Json(input): Json<crate::pi_config::ProviderConfigInput>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::pi_config::configure_provider(input) {
        Ok(catalog) => (StatusCode::OK, Json(catalog)),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Remove a provider's stored credential (and, for custom providers, its entry).
#[utoipa::path(
    delete,
    path = "/api/pi-config/providers/{id}",
    tag = "Agents",
    summary = "Remove a Pi provider's stored credential",
    params(("id" = String, Path, description = "Provider id")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn delete_pi_provider(Path(id): Path<String>) -> (StatusCode, Json<serde_json::Value>) {
    match crate::pi_config::remove_provider(&id) {
        Ok(catalog) => (StatusCode::OK, Json(catalog)),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Discover a provider's live model list via its OpenAI-compatible `GET /models`,
/// falling back to the provider's static suggestions when discovery is
/// unavailable. Runs server-side so keys never reach the browser.
#[utoipa::path(
    post,
    path = "/api/pi-config/discover-models",
    tag = "Agents",
    summary = "Discover a provider's models (with static fallback)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn discover_pi_models(
    Json(input): Json<crate::pi_config::DiscoverInput>,
) -> Json<serde_json::Value> {
    Json(crate::pi_config::discover_models(input).await)
}

// ── Agent teams CRUD ──────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/teams",
    tag = "Teams",
    summary = "List agent teams",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_teams(State(state): State<ServerState>) -> (StatusCode, Json<serde_json::Value>) {
    match state.teams.list().await {
        Ok(teams) => (StatusCode::OK, Json(json!({ "teams": teams }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    post,
    path = "/api/teams",
    tag = "Teams",
    summary = "Create a team",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn create_team(
    State(state): State<ServerState>,
    Json(input): Json<CreateTeam>,
) -> (StatusCode, Json<serde_json::Value>) {
    if input.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "team name is required" })),
        );
    }
    match state.teams.create(input).await {
        Ok(team) => (StatusCode::CREATED, Json(json!({ "team": team }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    get,
    path = "/api/teams/{id}",
    tag = "Teams",
    summary = "Get a team by id",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_team(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.teams.get(&id).await {
        Ok(Some(team)) => (StatusCode::OK, Json(json!({ "team": team }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("team '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    patch,
    path = "/api/teams/{id}",
    tag = "Teams",
    summary = "Update a team",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn update_team(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(patch): Json<UpdateTeam>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.teams.update(&id, patch).await {
        Ok(Some(team)) => (StatusCode::OK, Json(json!({ "team": team }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("team '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    delete,
    path = "/api/teams/{id}",
    tag = "Teams",
    summary = "Delete a team",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn delete_team(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.teams.delete(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "success": true }))),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("team '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Body for `POST /api/teams/:id/members` — add one agent to the team. Used by
/// the desktop's drag-an-agent-into-a-team gesture.
#[derive(serde::Deserialize)]
struct AddTeamMemberRequest {
    agent_id: String,
}

#[utoipa::path(
    post,
    path = "/api/teams/{id}/members",
    tag = "Teams",
    summary = "Add a member agent to a team",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn add_team_member(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<AddTeamMemberRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.teams.add_member(&id, &body.agent_id).await {
        Ok(Some(team)) => (StatusCode::OK, Json(json!({ "team": team }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("team '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    delete,
    path = "/api/teams/{id}/members/{agent_id}",
    tag = "Teams",
    summary = "Remove a member from a team",
    params(("id" = String, Path), ("agent_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn remove_team_member(
    State(state): State<ServerState>,
    axum::extract::Path((id, agent_id)): axum::extract::Path<(String, String)>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.teams.remove_member(&id, &agent_id).await {
        Ok(Some(team)) => (StatusCode::OK, Json(json!({ "team": team }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("team '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// The stable well-known id for the lean Ryu agent (Pi + Gateway). Using a
/// constant rather than a hard-coded string literal ensures the id is consistent
/// across create, find, and update paths in this module.
const RYU_AGENT_ID: &str = "ryu";

/// `POST /api/agents/:id/migrate-to-ryu`
///
/// Reads the source agent (persona/tools/model), then creates-or-updates the
/// Ryu agent (id = "ryu", engine = "acp:pi") with those slots. The source
/// agent is never modified; migration is a copy. Returns the updated Ryu agent
/// and a summary of the fields that were carried over.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/migrate-to-ryu",
    tag = "Agents",
    summary = "Migrate an agent onto the Ryu engine",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn migrate_to_ryu(
    State(state): State<ServerState>,
    axum::extract::Path(source_id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Fetch the full source record (includes tools, which the list endpoint omits).
    let source = match state.agent_store.get(&source_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("agent '{source_id}' not found") })),
            );
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            );
        }
    };

    // Deny migrating the Ryu agent onto itself.
    if source_id == RYU_AGENT_ID {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "cannot migrate the Ryu agent to itself" })),
        );
    }

    // Collect the fields that will be carried over for the summary.
    let carried = {
        let mut c = vec![];
        if source.system_prompt.is_some() {
            c.push("system_prompt");
        }
        if !source.tools.is_empty() {
            c.push("tools");
        }
        if source.model.is_some() {
            c.push("model");
        }
        c
    };

    // Create-or-update the Ryu agent. Ryu is always bound to acp:pi.
    let ryu_agent = match state.agent_store.get(RYU_AGENT_ID).await {
        Ok(Some(_existing)) => {
            // Update the existing Ryu card with the source agent's slots.
            let patch = crate::agents::UpdateAgent {
                name: Some(format!("Ryu (migrated from {})", source.name)),
                description: Some(format!(
                    "Ryu agent — Pi + Gateway. Migrated from '{}'.",
                    source.name
                )),
                system_prompt: Some(source.system_prompt.clone().unwrap_or_default()),
                tools: Some(source.tools.clone()),
                model: source.model.clone(),
                engine: Some("acp:pi".to_owned()),
                ..Default::default()
            };
            match state.agent_store.update(RYU_AGENT_ID, patch).await {
                Ok(Some(r)) => r,
                Ok(None) => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "Ryu agent disappeared during update" })),
                    );
                }
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": e.to_string() })),
                    );
                }
            }
        }
        Ok(None) => {
            // No Ryu agent yet — create it under the stable well-known id so the
            // UI can always refer to it by "ryu" rather than a random uuid.
            let input = crate::agents::CreateAgent {
                name: format!("Ryu (migrated from {})", source.name),
                description: Some(format!(
                    "Ryu agent — Pi + Gateway. Migrated from '{}'.",
                    source.name
                )),
                system_prompt: source.system_prompt.clone(),
                tools: source.tools.clone(),
                model: source.model.clone(),
                engine: Some("acp:pi".to_owned()),
                ..Default::default()
            };
            match state
                .agent_store
                .create_with_id(RYU_AGENT_ID.to_owned(), input)
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": e.to_string() })),
                    );
                }
            }
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            );
        }
    };

    (
        StatusCode::OK,
        Json(json!({
            "ryu_agent": ryu_agent,
            "source_id": source_id,
            "carried": carried,
        })),
    )
}

/// `GET /api/agents/:id/export`
///
/// Returns a portable agent template JSON that captures name, version, system
/// prompt, tools, engine, and per-attribute slots. The template can be imported
/// via `POST /api/agents/import` to create a new, unlocked copy with a fresh id.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/export",
    tag = "Agents",
    summary = "Export an agent as a template",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn export_agent(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.agent_store.get(&id).await {
        Ok(Some(record)) => {
            let template = record.to_template();
            (StatusCode::OK, Json(json!({ "template": template })))
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("agent '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `POST /api/agents/import`
///
/// Creates a new agent from a portable agent template (as produced by
/// `GET /api/agents/:id/export`). The imported agent always gets a fresh
/// server-assigned id and starts unlocked — the caller owns their copy and
/// can edit it freely. Name, version, system prompt, tools, engine, and
/// per-attribute slots are all round-tripped from the template.
#[utoipa::path(
    post,
    path = "/api/agents/import",
    tag = "Agents",
    summary = "Import an agent from a template",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn import_agent(
    State(state): State<ServerState>,
    Json(body): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Accept both `{ "template": { ... } }` (export envelope) and a bare template.
    let raw_template = body.get("template").cloned().unwrap_or(body);
    let template: AgentTemplate = match serde_json::from_value(raw_template) {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid agent template: {e}") })),
            );
        }
    };
    if template.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "template name is required" })),
        );
    }
    let input = template.into_create_agent();
    match state.agent_store.create(input).await {
        Ok(record) => (StatusCode::CREATED, Json(json!({ "agent": record }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// True if `name`'s installed binary is present on disk (or the sidecar ships no
/// file-based binary, in which case we trust the version store). Centralizes the
/// `llamacpp`→`llama-server` and `.exe` handling used by every install-status
/// endpoint so they all report the same per-engine reality.
fn binary_installed_on_disk(name: &str) -> bool {
    // Sidecars without a file-based binary: trust the store.
    if matches!(name, "openclaw" | "vllm") {
        return true;
    }
    // Parakeet installs an ONNX model directory (not a binary in ~/.ryu/bin).
    if name == "parakeet" {
        return crate::sidecar::providers::parakeet::model_present();
    }
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    // Some sidecars install a binary whose filename differs from the sidecar
    // name: llamacpp (and the embeddings sidecar that shares it) ship as
    // "llama-server"; the stable-diffusion.cpp media engine ships as "sd-server".
    let bin_name = match name {
        "llamacpp" | "llamacpp-embed" => format!("llama-server{ext}"),
        "sdcpp" => format!("sd-server{ext}"),
        _ => format!("{name}{ext}"),
    };
    crate::paths::ryu_dir().join("bin").join(&bin_name).exists()
}

// ── Conversation history handlers (spec unit U10) ─────────────────────────────

#[utoipa::path(
    get,
    path = "/api/conversations",
    tag = "Conversations",
    summary = "List conversations",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_conversations(State(state): State<ServerState>) -> axum::response::Response {
    match state.conversations.list_conversations().await {
        Ok(items) => Json(json!({ "conversations": items })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct SearchConversationsQuery {
    /// The natural-language query to match against past messages.
    q: String,
    /// Max number of hits (defaults to 20, clamped to 100).
    limit: Option<usize>,
}

/// `GET /api/conversations/search?q=…&limit=…` — semantic search over past chat
/// messages, the human-facing surface of the `search_conversations` capability.
/// Returns `{ hits, indexed }`. `indexed: false` means the message index isn't
/// wired (e.g. the embedder sidecar never ran), so the UI can explain why there
/// are no results rather than implying the chats are empty.
#[utoipa::path(
    get,
    path = "/api/conversations/search",
    tag = "Conversations",
    summary = "Semantic search over past chat messages",
    params(
        ("q" = String, Query, description = "Natural-language search query"),
        ("limit" = Option<usize>, Query, description = "Max hits (default 20, max 100)")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn search_conversations_handler(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<SearchConversationsQuery>,
) -> axum::response::Response {
    let query = params.q.trim();
    if query.is_empty() {
        return Json(json!({ "hits": [], "indexed": true })).into_response();
    }
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    match state
        .conversations
        .search_messages(query, limit, None)
        .await
    {
        Ok(Some(hits)) => Json(json!({ "hits": hits, "indexed": true })).into_response(),
        Ok(None) => Json(json!({ "hits": [], "indexed": false })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/conversations/{id}",
    tag = "Conversations",
    summary = "Get a conversation with messages",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_conversation(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    // TODO (Phase 1 realtime join): enforce read ACL here. Extract
    // `Extension<Option<VerifiedCaller>>`, load the conversation's
    // owner_user_id/org_id/visibility/team_id, and gate on
    // `crate::identity_verify::can_access(...) != Access::None`. Not enforced in
    // Phase 0 so the single-tenant flow is unchanged.
    match state.conversations.get_conversation_detail(&id).await {
        Ok(Some(detail)) => Json(detail).into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation '{id}' not found"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    delete,
    path = "/api/conversations/{id}",
    tag = "Conversations",
    summary = "Delete a conversation",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn delete_conversation(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    match state.conversations.delete_conversation(&id).await {
        Ok(removed) => Json(json!({ "success": true, "removed": removed })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize, Default)]
struct ForkConversationBody {
    /// Copy messages up to and including this message id. When omitted, the whole
    /// conversation is copied.
    #[serde(default)]
    message_id: Option<String>,
}

/// `POST /api/conversations/:id/fork`
///
/// ChatGPT-style "Branch in new chat": copy this conversation's history up to a
/// chosen message into a fresh, independent conversation and return its summary.
/// The caller opens the returned conversation to continue the branch.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/fork",
    tag = "Conversations",
    summary = "Fork a conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn fork_conversation(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: Option<Json<ForkConversationBody>>,
) -> axum::response::Response {
    let message_id = body.and_then(|Json(b)| b.message_id);
    match state
        .conversations
        .fork_conversation(&id, message_id.as_deref())
        .await
    {
        Ok(Some(summary)) => (
            StatusCode::CREATED,
            Json(json!({ "conversation": summary })),
        )
            .into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation '{id}' or fork message not found"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct SetFlagBody {
    value: bool,
}

/// `POST /api/conversations/:id/pinned` — pin or unpin a conversation. Body:
/// `{ "value": true|false }`. Server-backed (the same column the coordinator
/// `threads` tool writes), so a pin set here surfaces to every client.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/pinned",
    tag = "Conversations",
    summary = "Pin or unpin a conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn set_conversation_pinned_handler(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetFlagBody>,
) -> axum::response::Response {
    match state.conversations.set_pinned(&id, body.value).await {
        Ok(()) => Json(json!({ "ok": true, "pinned": body.value })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/conversations/:id/archived` — archive or unarchive a conversation.
/// Body: `{ "value": true|false }`. Server-backed, shared with the coordinator
/// `threads` tool's `set_thread_archived`.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/archived",
    tag = "Conversations",
    summary = "Archive or unarchive a conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn set_conversation_archived_handler(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetFlagBody>,
) -> axum::response::Response {
    match state.conversations.set_archived(&id, body.value).await {
        Ok(()) => Json(json!({ "ok": true, "archived": body.value })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/conversations/:id/title` request body.
#[derive(serde::Deserialize)]
struct SetTitleBody {
    title: String,
}

/// `POST /api/conversations/:id/title` — manually rename a conversation. Body:
/// `{ "title": "..." }`. This marks the title user-chosen (`title_custom = 1`)
/// so the background auto-namer never overwrites it. Server-backed, so the new
/// title surfaces to every client (and to the coordinator `threads` view).
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/title",
    tag = "Conversations",
    summary = "Rename a conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn set_conversation_title_handler(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetTitleBody>,
) -> axum::response::Response {
    let title = body.title.trim();
    if title.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "title must not be empty".to_string(),
        );
    }
    match state.conversations.set_title(&id, title).await {
        Ok(()) => Json(json!({ "ok": true, "title": title })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ── Goal handlers (`/goal`) ───────────────────────────────────────────────────
//
// A goal is a persistent completion condition attached to a conversation. The
// goal state lives in Core ("what runs"); the judge model call routes through the
// Gateway ("what is measured"), so the firewall/budget/audit pipeline applies. The
// continuation loop (re-running turns until the condition is met) is driven by the
// client for now; Core owns the reusable headless primitives: persist the goal and
// evaluate progress on demand.

// Goal + double-check preference keys moved to their plugins (io.ryu.goal /
// io.ryu.double-check); the model/effort prefs (`goal-judge-model`,
// `double-check-model`, …) are still read by the plugin host's side-model
// capability, just not by hardcoded Core handlers.

/// Preference keys for the `/btw` side-question feature's model + effort. Like
/// double-check, the desktop may store a `btw-provider` pref purely for UI state;
/// Core ignores it (the gateway routes by model id alone).
const BTW_MODEL_PREF: &str = "btw-model";
const BTW_EFFORT_PREF: &str = "btw-effort";

/// Preference key for auto-recall (U17): before each chat turn, automatically
/// retrieve relevant prior knowledge (long-term memory + past chat messages) and
/// inject it into the prompt. DEFAULT ON — an unset pref means enabled; only an
/// explicit `false`/`0`/`off`/`no` disables it. Env fallback
/// `RYU_AUTO_RECALL_ENABLED`.
const AUTO_RECALL_ENABLED_PREF: &str = "auto-recall-enabled";

/// Preference key for the number of recalled snippets injected per turn (across
/// memory + past chats combined). DEFAULT 5. Env fallback `RYU_AUTO_RECALL_TOP_K`.
const AUTO_RECALL_TOP_K_PREF: &str = "auto-recall-top-k";

/// Fallback top-k when neither the pref nor the env var is set.
const AUTO_RECALL_DEFAULT_TOP_K: usize = 5;

/// Parse the auto-recall enabled flag from a raw pref/env string. PURE so it is
/// unit-testable without a store. Default ON: `None` or any unrecognised value is
/// enabled; only an explicit disable token (`false`/`0`/`off`/`no`, any case)
/// turns it off.
fn parse_auto_recall_enabled(raw: Option<&str>) -> bool {
    match raw {
        None => true,
        Some(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "false" | "0" | "off" | "no"
        ),
    }
}

/// Resolve whether auto-recall is enabled: pref → env (`RYU_AUTO_RECALL_ENABLED`)
/// → default ON.
async fn resolve_auto_recall_enabled(state: &ServerState) -> bool {
    if let Ok(Some(pref)) = state.preferences.get(AUTO_RECALL_ENABLED_PREF).await {
        return parse_auto_recall_enabled(Some(&pref));
    }
    match std::env::var("RYU_AUTO_RECALL_ENABLED") {
        Ok(v) => parse_auto_recall_enabled(Some(&v)),
        Err(_) => true,
    }
}

/// Preference key for the FTS (full-text, lexical) session-search recall layer:
/// the keyword complement to the semantic auto-recall half. DEFAULT OFF — an unset
/// pref means disabled; only an explicit enable token (`true`/`1`/`on`/`yes`, any
/// case) turns it on. This is a *sub-source* of auto-recall: it contributes only
/// when auto-recall is enabled (default on) AND this pref is enabled (default off),
/// so no session text is full-text-recalled unless the user opts in. Env fallback
/// `RYU_FTS_RECALL_ENABLED`.
const FTS_RECALL_ENABLED_PREF: &str = "fts-recall-enabled";

/// Parse the FTS-recall enabled flag from a raw pref/env string. PURE so it is
/// unit-testable without a store. Default OFF: `None` or any unrecognised value is
/// disabled; only an explicit enable token (`true`/`1`/`on`/`yes`, any case) turns
/// it on. Mirrors [`parse_auto_recall_enabled`] but with the opposite default.
fn parse_fts_recall_enabled(raw: Option<&str>) -> bool {
    match raw {
        None => false,
        Some(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "on" | "yes"
        ),
    }
}

/// Resolve whether the FTS recall layer is enabled: pref → env
/// (`RYU_FTS_RECALL_ENABLED`) → default OFF.
async fn resolve_fts_recall_enabled(state: &ServerState) -> bool {
    if let Ok(Some(pref)) = state.preferences.get(FTS_RECALL_ENABLED_PREF).await {
        return parse_fts_recall_enabled(Some(&pref));
    }
    match std::env::var("RYU_FTS_RECALL_ENABLED") {
        Ok(v) => parse_fts_recall_enabled(Some(&v)),
        Err(_) => false,
    }
}

/// Resolve the global skills disclosure mode from the `skills-disclosure` pref and
/// apply it to the process-global flag the ACP chat path reads. Progressive
/// disclosure injects only an L1 skill index up front and loads full bodies on
/// demand; `full` injects every enabled skill body (today's behavior). When the
/// pref is unset the current flag (env-seeded, default progressive) is left as-is.
async fn apply_skills_disclosure(state: &ServerState) {
    if let Ok(Some(v)) = state
        .preferences
        .get(crate::skills::SKILLS_DISCLOSURE_PREF)
        .await
    {
        crate::skills::set_progressive_disclosure(crate::skills::disclosure_value_is_progressive(
            &v,
        ));
    }
}

/// Resolve the auto-recall top-k: pref → env (`RYU_AUTO_RECALL_TOP_K`) → default.
/// A non-parseable or zero value falls back to the default.
async fn resolve_auto_recall_top_k(state: &ServerState) -> usize {
    let from_str = |s: &str| s.trim().parse::<usize>().ok().filter(|n| *n > 0);
    if let Ok(Some(pref)) = state.preferences.get(AUTO_RECALL_TOP_K_PREF).await {
        if let Some(n) = from_str(&pref) {
            return n;
        }
    }
    if let Ok(v) = std::env::var("RYU_AUTO_RECALL_TOP_K") {
        if let Some(n) = from_str(&v) {
            return n;
        }
    }
    AUTO_RECALL_DEFAULT_TOP_K
}

// ── Context-window management (opt-in / off by default) ───────────────────────
//
// Local models run with small context windows. When a budget is set, Core trims
// the outbound history to fit (always keeping the system block) and optionally
// summarizes the dropped turns, instead of relying solely on the engine's blunt
// context-shift (which can evict the system prompt since Ryu never sets n_keep).
// All keys are off/unset by default so behavior is unchanged until configured.

/// `context.max-tokens`: `""`/`0`/`off` = disabled (default); `auto` = size to
/// the loaded model's launch `ctx_size`; a positive integer = explicit total
/// token budget (input + output). Env fallback `RYU_CONTEXT_MAX_TOKENS`.
const CONTEXT_MAX_TOKENS_PREF: &str = "context.max-tokens";
/// `context.auto-compact`: summarize dropped turns via a side model instead of
/// dropping them. DEFAULT off. Adds one summarization round-trip per over-budget
/// turn (cached by the dropped-message set).
const CONTEXT_AUTO_COMPACT_PREF: &str = "context.auto-compact";
/// `context.max-output-tokens`: tokens reserved for the reply. DEFAULT 1024.
const CONTEXT_MAX_OUTPUT_PREF: &str = "context.max-output-tokens";
/// `context.compact-model`: model id used to summarize dropped turns. DEFAULT =
/// the turn's own chat model.
const CONTEXT_COMPACT_MODEL_PREF: &str = "context.compact-model";
/// `context.compact-effort`: reasoning effort for the summarizer. DEFAULT empty.
const CONTEXT_COMPACT_EFFORT_PREF: &str = "context.compact-effort";
/// Reply reserve used when `context.max-output-tokens` is unset.
const CONTEXT_DEFAULT_OUTPUT_RESERVE: usize = 1024;

/// Parse the `context.max-tokens` value into a concrete token budget. PURE so
/// the off/auto/numeric contract is unit-testable without a store. Returns
/// `None` (feature off) for `""`/`0`/`off` and for unparseable values, for
/// `auto` when `ctx_size` is unknown/0, else the resolved positive budget.
fn parse_context_budget(raw: &str, ctx_size: Option<u32>) -> Option<usize> {
    let raw = raw.trim();
    if raw.is_empty() || raw == "0" || raw.eq_ignore_ascii_case("off") {
        return None;
    }
    if raw.eq_ignore_ascii_case("auto") {
        return match ctx_size {
            Some(n) if n > 0 => Some(n as usize),
            _ => None,
        };
    }
    match raw.parse::<usize>() {
        Ok(n) if n > 0 => Some(n),
        _ => None,
    }
}

/// Resolve app-level context-window config from prefs/env. Returns `None` (the
/// feature is off, full history is sent) unless `context.max-tokens` is `auto`
/// or a positive integer. `auto` sizes the budget to the loaded model's launch
/// `ctx_size` and is the recommended no-guess value; it yields `None` when the
/// model's `ctx_size` is unknown/0. Mirrors the `resolve_auto_recall_*` shape so
/// the per-turn cost is a few cheap pref reads.
async fn resolve_context_window(
    state: &ServerState,
    req: &crate::sidecar::adapters::ChatStreamRequest,
) -> Option<crate::sidecar::adapters::context_window::ContextWindowConfig> {
    let raw = match state.preferences.get(CONTEXT_MAX_TOKENS_PREF).await {
        Ok(Some(v)) => v.trim().to_string(),
        _ => std::env::var("RYU_CONTEXT_MAX_TOKENS")
            .unwrap_or_default()
            .trim()
            .to_string(),
    };
    if raw.is_empty() || raw == "0" || raw.eq_ignore_ascii_case("off") {
        return None;
    }

    // The chat model for this turn (mirrors route_chat_stream's effective-agent
    // resolution): used to size an `auto` budget and as the default summarizer.
    let effective_agent = req.target_agent_id.clone().or_else(|| req.agent_id.clone());
    let model = match effective_agent {
        Some(id) => crate::sidecar::adapters::resolve_agent_model(&id, &state.agent_store).await,
        None => None,
    };

    // For `auto`, the budget is the loaded model's launch `ctx_size`; for a
    // numeric value, `ctx_size` is ignored. Fetched only on the `auto` path.
    let ctx_size = if raw.eq_ignore_ascii_case("auto") {
        match model.as_deref() {
            Some(m) => state.preferences.get_launch_config(m).await.ctx_size,
            None => None,
        }
    } else {
        None
    };
    let max_tokens = parse_context_budget(&raw, ctx_size)?;

    let reserve_output = match state.preferences.get(CONTEXT_MAX_OUTPUT_PREF).await {
        Ok(Some(v)) => v.trim().parse::<usize>().ok(),
        _ => None,
    }
    .unwrap_or(CONTEXT_DEFAULT_OUTPUT_RESERVE);

    let auto_compact = matches!(
        state
            .preferences
            .get(CONTEXT_AUTO_COMPACT_PREF)
            .await
            .ok()
            .flatten()
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase()),
        Some(ref v) if matches!(v.as_str(), "true" | "1" | "on" | "yes")
    );

    let compact_model = match state.preferences.get(CONTEXT_COMPACT_MODEL_PREF).await {
        Ok(Some(v)) if !v.trim().is_empty() => v.trim().to_string(),
        _ => model.unwrap_or_else(|| crate::registry::DEFAULT_LLM_MODEL.to_string()),
    };
    let compact_effort = match state.preferences.get(CONTEXT_COMPACT_EFFORT_PREF).await {
        Ok(Some(v)) => v.trim().to_string(),
        _ => String::new(),
    };

    Some(
        crate::sidecar::adapters::context_window::ContextWindowConfig {
            max_tokens,
            reserve_output,
            auto_compact,
            compact_model,
            compact_effort,
        },
    )
}

/// Recent-message window a `/btw` side question sees when it loads the transcript
/// from a stored conversation (clients that pass their own `messages` aren't
/// bounded here). Matches the goal judge's window.
const BTW_TRANSCRIPT_LIMIT: usize = 30;

/// Resolve a "side model" effort/thinking level from a preference key, falling
/// back to an env var then empty (= provider default). Shared by the goal judge
/// and the double-check reviewer.
async fn resolve_side_effort(state: &ServerState, pref_key: &str, env_var: &str) -> String {
    if let Ok(Some(pref)) = state.preferences.get(pref_key).await {
        let trimmed = pref.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    std::env::var(env_var).ok().unwrap_or_default()
}

/// Run a one-shot, non-streaming completion of `model` over `(system, user)`
/// through the local gateway and return the assistant text. This is the single
/// place the goal judge and the double-check reviewer make a "side model" call,
/// so the request shape (and the effort param) lives in exactly one spot.
///
/// `effort` (when non-empty) is forwarded as `reasoning_effort`. The gateway's
/// OpenAI/local/OpenRouter providers clone the request body verbatim, so it
/// reaches them as-is; the Anthropic-direct transform (`to_anthropic_body`)
/// rebuilds the request and currently drops it (caveat, not a hard failure).
pub(crate) async fn call_side_model(
    state: &ServerState,
    model: &str,
    effort: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let mut payload = json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let effort = effort.trim();
    if !effort.is_empty() {
        payload["reasoning_effort"] = json!(effort);
    }
    let mut req = state
        .client
        .post(format!("{base}/v1/chat/completions"))
        .timeout(std::time::Duration::from_secs(60))
        .json(&payload);
    if let Some(t) = gateway_token() {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("gateway unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("gateway returned HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("response was not valid JSON: {e}"))?;
    let text = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    Ok(text.to_string())
}

// ── Side questions (`/btw`) ───────────────────────────────────────────────────
//
// A `/btw` side question (modeled on Claude Code's interactive `/btw`) lets a
// user ask a quick question *about the current conversation* without polluting
// the chat history. It sees the conversation context but has NO tool access and
// produces a single, ephemeral answer the client shows in an overlay and then
// discards. This is the inverse of a sub-agent: full context, no tools.
//
// Like double-check it reuses [`call_side_model`] (one non-streaming gateway
// call, persists nothing). The endpoint is top-level (`POST /api/btw`, not under
// `/conversations/:id`) because some clients hold the transcript themselves and
// have no Core conversation id: the body carries either a `messages` array (CLI,
// mobile — the client's own transcript) or a `conversation_id` (desktop — Core
// has the authoritative, possibly-fuller transcript).

/// Resolve the model that answers `/btw` side questions: pref `btw-model` →
/// env `RYU_BTW_MODEL`/`RYU_DEFAULT_LLM_MODEL` → the built-in default. Nothing
/// hardcoded — the stored value is any gateway-routable model id.
async fn resolve_btw_model(state: &ServerState) -> String {
    if let Ok(Some(pref)) = state.preferences.get(BTW_MODEL_PREF).await {
        let trimmed = pref.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    for var in ["RYU_BTW_MODEL", "RYU_DEFAULT_LLM_MODEL"] {
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() {
                return val;
            }
        }
    }
    crate::registry::DEFAULT_LLM_MODEL.to_string()
}

/// One message in a client-supplied `/btw` transcript.
#[derive(serde::Deserialize)]
struct BtwMessage {
    role: String,
    content: String,
}

/// `POST /api/btw` request body. The transcript comes from `messages` when the
/// client holds it (CLI/mobile), else it's loaded from `conversation_id`
/// (desktop). `question` is the side question to answer.
#[derive(serde::Deserialize)]
struct BtwBody {
    question: String,
    #[serde(default)]
    messages: Option<Vec<BtwMessage>>,
    #[serde(default)]
    conversation_id: Option<String>,
}

/// `POST /api/btw` — answer an ephemeral side question against the conversation
/// context. Stateless: Core persists nothing. Returns `{ answer, model }`.
async fn btw_handler(
    State(state): State<ServerState>,
    Json(body): Json<BtwBody>,
) -> axum::response::Response {
    let question = body.question.trim();
    if question.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "a side question is required".to_string(),
        );
    }

    // Prefer a client-supplied transcript; otherwise load it from the stored
    // conversation. Either is fine — a `/btw` with no prior context still works
    // (it just has less to draw on).
    let transcript = match body.messages {
        Some(msgs) if !msgs.is_empty() => msgs
            .iter()
            .map(|m| format!("[{}] {}", m.role, m.content))
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => match body.conversation_id.as_deref().filter(|s| !s.is_empty()) {
            Some(cid) => state
                .conversations
                .get_recent_messages(cid, BTW_TRANSCRIPT_LIMIT)
                .await
                .unwrap_or_default()
                .iter()
                .map(|m| format!("[{}] {}", m.role, m.content))
                .collect::<Vec<_>>()
                .join("\n\n"),
            None => String::new(),
        },
    };

    let model = resolve_btw_model(&state).await;
    let effort = resolve_side_effort(&state, BTW_EFFORT_PREF, "RYU_BTW_EFFORT").await;

    let system = "You are answering a quick SIDE QUESTION about an ongoing conversation. \
        Answer ONLY from the conversation context provided — you have no tools and cannot run \
        commands, read files, or browse. If the context does not contain the answer, say so \
        briefly rather than guessing. Be concise and direct; this is a quick aside, not a new task.";
    let user = if transcript.is_empty() {
        format!("SIDE QUESTION:\n{question}\n\nAnswer concisely.")
    } else {
        format!(
            "CONVERSATION SO FAR:\n{transcript}\n\n\
             SIDE QUESTION:\n{question}\n\n\
             Answer the side question concisely, using only the conversation above."
        )
    };

    match call_side_model(&state, &model, &effort, system, user.as_str()).await {
        Ok(text) => {
            // Persist the aside as a "side chat" keyed to its parent conversation
            // so it can be listed later (in the Context rail and the sidebar). This
            // is best-effort: a persistence failure never fails the answer, and a
            // request that carried only a client-held transcript (no Core
            // conversation id) is simply not persisted.
            let mut entry_id: Option<String> = None;
            if let Some(cid) = body.conversation_id.as_deref().filter(|s| !s.is_empty()) {
                match state
                    .conversations
                    .append_btw(cid, question, &text, Some(&model))
                    .await
                {
                    Ok(entry) => entry_id = Some(entry.id),
                    Err(e) => tracing::warn!("failed to persist btw entry: {e:#}"),
                }
            }
            Json(json!({ "answer": text, "model": model, "id": entry_id })).into_response()
        }
        Err(e) => json_error(
            StatusCode::BAD_GATEWAY,
            format!("side-question model unavailable: {e}"),
        ),
    }
}

/// `GET /api/conversations/:id/btw` — list persisted `/btw` side chats for a
/// conversation, newest first.
async fn list_btw_handler(
    State(state): State<ServerState>,
    Path(conversation_id): Path<String>,
) -> axum::response::Response {
    match state.conversations.list_btw(&conversation_id).await {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not list side chats: {e}"),
        ),
    }
}

/// `DELETE /api/btw/:id` — delete a single persisted side chat.
async fn delete_btw_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    match state.conversations.delete_btw(&id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "side chat not found".to_string()),
        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not delete side chat: {e}"),
        ),
    }
}

// ── Multi-agent participant handlers (#414) ───────────────────────────────────

#[derive(serde::Deserialize)]
struct AddParticipantBody {
    agent_id: String,
}

/// `POST /api/conversations/:id/participants` — add an agent to a conversation.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/participants",
    tag = "Conversations",
    summary = "List conversation participants",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_participants_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    match state.conversations.get_participants(&id).await {
        Ok(participants) => {
            let list: Vec<serde_json::Value> = participants
                .iter()
                .map(|a| json!({ "agent_id": a }))
                .collect();
            Json(json!({ "participants": list })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/conversations/{id}/participants",
    tag = "Conversations",
    summary = "Add a participant agent",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn add_participant_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<AddParticipantBody>,
) -> axum::response::Response {
    if body.agent_id.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "agent_id is required".to_owned());
    }
    match state
        .conversations
        .add_participant(&id, body.agent_id.trim())
        .await
    {
        Ok(participants) => Json(json!({ "participants": participants })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `DELETE /api/conversations/:id/participants/:agent_id` — remove an agent from a conversation.
#[utoipa::path(
    delete,
    path = "/api/conversations/{id}/participants/{agent_id}",
    tag = "Conversations",
    summary = "Remove a participant agent",
    params(("id" = String, Path), ("agent_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn remove_participant_handler(
    State(state): State<ServerState>,
    Path((id, agent_id)): Path<(String, String)>,
) -> axum::response::Response {
    match state.conversations.remove_participant(&id, &agent_id).await {
        Ok(participants) => Json(json!({ "participants": participants })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /api/runs` — list conversations that have a `run_status` set, ordered
/// most-recently-updated first.  Used by the desktop's background-runs view
/// (issue #128): the sidebar polls this to show active/recent run status, and
/// the notification logic watches for `running → completed/failed` transitions.
#[utoipa::path(
    get,
    path = "/api/runs",
    tag = "Conversations",
    summary = "List runs",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_runs_handler(State(state): State<ServerState>) -> axum::response::Response {
    match state.conversations.list_runs().await {
        Ok(items) => Json(json!({ "runs": items })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// One frame of the `/api/runs/stream` feed. `snapshot` carries the full run list
/// on connect; each subsequent `run` carries a single run whose status just
/// changed. The `type` tag lets the client branch without a second endpoint.
#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RunStreamFrame {
    Snapshot {
        runs: Vec<conversations::ConversationSummary>,
    },
    Run {
        run: conversations::ConversationSummary,
    },
}

/// `GET /api/runs/stream` — SSE: a full run snapshot on connect, then a frame per
/// run whose `run_status` transitions. Replaces the desktop's 3s poll of
/// `/api/runs` (issue #128); the snapshot-first contract lets a late/lagged client
/// self-heal, so a `running → completed/failed` transition is never silently
/// missed. Mirrors [`downloads_stream`].
#[utoipa::path(
    get,
    path = "/api/runs/stream",
    tag = "Conversations",
    summary = "Background-runs SSE stream",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
async fn runs_stream(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    // Subscribe BEFORE snapshotting so a transition in the gap between the two is
    // still delivered as a delta (the snapshot may or may not include it; either
    // way the client converges on the right terminal status).
    let rx = conversations::subscribe_run_events();
    let snapshot = RunStreamFrame::Snapshot {
        runs: state.conversations.list_runs().await.unwrap_or_default(),
    };

    // State carries the (one-shot) snapshot until it's been emitted, then `None`.
    // First poll yields the snapshot; subsequent polls forward live deltas.
    let stream = futures_util::stream::unfold(
        (rx, Some(snapshot)),
        |(mut rx, pending_snapshot)| async move {
            if let Some(snap) = pending_snapshot {
                let data = serde_json::to_string(&snap).unwrap_or_default();
                return Some((Ok(Event::default().data(data)), (rx, None)));
            }
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let frame = RunStreamFrame::Run { run: ev.run };
                        let data = serde_json::to_string(&frame).unwrap_or_default();
                        return Some((Ok(Event::default().data(data)), (rx, None)));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// `GET /api/runs/:id/trace` — return the ordered span list for a run (M4 / issue #178).
///
/// `:id` is the `conversation_id` used as the run key.  Returns `{ "spans": [...] }`.
/// Returns an empty list (not 404) when the run exists but has no recorded spans yet
/// so the desktop can poll during an active run without error handling.
#[utoipa::path(
    get,
    path = "/api/runs/{id}/trace",
    tag = "Conversations",
    summary = "Get a run's trace spans",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_run_trace_handler(
    State(state): State<ServerState>,
    Path(run_id): Path<String>,
) -> axum::response::Response {
    match state.traces.get_spans(&run_id).await {
        Ok(spans) => Json(json!({ "spans": spans })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ── Session handlers (spec unit U004/#118) ────────────────────────────────────

#[derive(serde::Deserialize)]
struct CreateSessionBody {
    runnable_id: String,
    runnable_kind: crate::runnable::RunnableKind,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/sessions",
    tag = "Conversations",
    summary = "Create a session",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn create_session_handler(
    State(state): State<ServerState>,
    Json(body): Json<CreateSessionBody>,
) -> axum::response::Response {
    if body.runnable_id.trim().is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "runnable_id is required".to_owned(),
        );
    }
    match state
        .conversations
        .create_session(
            body.runnable_id.trim(),
            body.runnable_kind,
            body.agent_id.as_deref(),
            body.title.as_deref(),
        )
        .await
    {
        Ok(session) => Json(json!({ "session": session })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/sessions/{id}",
    tag = "Conversations",
    summary = "Get a session",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_session_handler(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    match state.conversations.get_session(&id).await {
        Ok(Some(session)) => Json(json!({ "session": session })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, format!("session '{id}' not found")),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct UpdateSessionStatusBody {
    status: SessionStatus,
}

#[utoipa::path(
    post,
    path = "/api/sessions/{id}/status",
    tag = "Conversations",
    summary = "Update a session's status",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn update_session_status_handler(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<UpdateSessionStatusBody>,
) -> axum::response::Response {
    match state
        .conversations
        .update_session_status(&id, body.status)
        .await
    {
        Ok(true) => Json(json!({ "success": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, format!("session '{id}' not found")),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/conversations/{id}/sessions",
    tag = "Conversations",
    summary = "List a conversation's sessions",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_sessions_for_conversation_handler(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    match state
        .conversations
        .list_sessions_for_conversation(&id)
        .await
    {
        Ok(sessions) => {
            Json(json!({ "conversation_id": id, "sessions": sessions })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Resolve an agent id to its engine (the `AgentInfo.engine` value, e.g.
/// `claude`/`codex`), so the native-history reader knows which on-disk store to
/// read. Falls back to the id with any `acp:` prefix stripped when the agent is
/// not in the registry (BYO agents), which is a no-op for unknown engines.
fn resolve_agent_engine(state: &ServerState, agent_id: &str) -> Option<String> {
    state
        .agents
        .list_infos()
        .into_iter()
        .find(|i| i.id == agent_id)
        .and_then(|i| i.engine)
        .or_else(|| Some(agent_id.strip_prefix("acp:").unwrap_or(agent_id).to_string()))
}

/// List the threads in an agent's own on-disk history store (Claude Code / Codex)
/// that Ryu can import. Optional `?cwd=` filters to threads from one directory.
/// Unsupported engines return an empty list (not an error) so the UI can always
/// offer the affordance and show an empty state.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/threads",
    tag = "Agents",
    summary = "List an agent's importable native threads",
    params(
        ("id" = String, Path),
        ("cwd" = Option<String>, Query, description = "Filter to threads from this working directory")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_agent_threads_handler(
    State(state): State<ServerState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let engine = match resolve_agent_engine(&state, &agent_id) {
        Some(e) => e,
        None => {
            return Json(json!({ "agent_id": agent_id, "threads": [] })).into_response();
        }
    };
    let cwd = params.get("cwd").map(String::as_str).filter(|s| !s.is_empty());
    // Blocking filesystem scan — hop off the async runtime.
    let result = tokio::task::spawn_blocking({
        let engine = engine.clone();
        let cwd = cwd.map(str::to_string);
        move || crate::native_history::list_threads(&engine, cwd.as_deref())
    })
    .await;
    match result {
        Ok(Ok(threads)) => Json(json!({
            "agent_id": agent_id,
            "engine": engine,
            "supported": crate::native_history::engine_supports_history(&engine),
            "threads": threads,
        }))
        .into_response(),
        Ok(Err(e)) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct ImportThreadBody {
    thread_id: String,
}

/// Import one native thread into a fresh Ryu conversation: read the agent's
/// on-disk transcript and persist it as conversation messages, stamping the
/// origin + the agent-native session id (for a future `session/load` resume).
/// Returns the new `conversation_id` so the client can open it.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/threads/import",
    tag = "Agents",
    summary = "Import a native thread into a Ryu conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn import_agent_thread_handler(
    State(state): State<ServerState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    Json(body): Json<ImportThreadBody>,
) -> axum::response::Response {
    let engine = match resolve_agent_engine(&state, &agent_id) {
        Some(e) => e,
        None => return json_error(StatusCode::BAD_REQUEST, "unknown agent".to_string()),
    };
    let thread_id = body.thread_id.clone();
    let read = tokio::task::spawn_blocking({
        let engine = engine.clone();
        move || crate::native_history::read_thread(&engine, &thread_id)
    })
    .await;
    let imported = match read {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return json_error(StatusCode::NOT_FOUND, e.to_string()),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if imported.messages.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "thread has no messages".to_string());
    }

    // Dedup: a repeat import of the same agent-native thread focuses the existing
    // Ryu conversation instead of creating a duplicate.
    let origin = format!("import:{engine}");
    if let Some(native_id) = imported.thread.native_session_id.as_deref() {
        match state
            .conversations
            .find_imported_conversation(&origin, native_id)
            .await
        {
            Ok(Some(existing)) => {
                return Json(json!({
                    "conversation_id": existing,
                    "agent_id": agent_id,
                    "engine": engine,
                    "message_count": imported.messages.len(),
                    "truncated": imported.truncated,
                    "title": imported.thread.title,
                    "cwd": imported.thread.cwd,
                    "already_imported": true,
                }))
                .into_response();
            }
            Ok(None) => {}
            Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    }

    let conversation_id = format!("conv_{}", uuid::Uuid::new_v4());
    if let Err(e) = state
        .conversations
        .ensure_conversation(&conversation_id, Some(&agent_id), Some(&imported.thread.title))
        .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    for msg in &imported.messages {
        if let Err(e) = state
            .conversations
            .append_message(&conversation_id, &msg.role, &msg.content, Some(&agent_id), None, None)
            .await
        {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    // Group the imported conversation under the workspace folder the thread ran
    // in (Claude Code / Codex both record a `cwd`), plus its git branch. Without
    // this the chat lands loose in "Chats" instead of nested under its project —
    // the sidebar buckets conversations by `folder_path`, so stamping it here is
    // what makes an imported (or auto-imported) thread appear in the right folder.
    if imported.thread.cwd.is_some() || imported.thread.git_branch.is_some() {
        if let Err(e) = state
            .conversations
            .set_run_metadata(
                &conversation_id,
                imported.thread.cwd.as_deref(),
                imported.thread.git_branch.as_deref(),
                None,
            )
            .await
        {
            tracing::warn!("import: failed to set folder for {conversation_id}: {e:#}");
        }
    }
    if let Err(e) = state
        .conversations
        .set_import_source(
            &conversation_id,
            &origin,
            imported.thread.native_session_id.as_deref(),
        )
        .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    // Preserve the title even though append_message derives one from the first
    // user turn — a native summary is a better title when present. set_title
    // marks it custom so the background auto-namer never clobbers it.
    if let Err(e) = state
        .conversations
        .set_title(&conversation_id, &imported.thread.title)
        .await
    {
        tracing::warn!("import: failed to set title for {conversation_id}: {e:#}");
    }

    Json(json!({
        "conversation_id": conversation_id,
        "agent_id": agent_id,
        "engine": engine,
        "message_count": imported.messages.len(),
        "truncated": imported.truncated,
        "title": imported.thread.title,
        "cwd": imported.thread.cwd,
        "already_imported": false,
    }))
    .into_response()
}

/// Real tools available for an agent. For ACP agents this is the set of tools
/// the agent has actually invoked this run (they expose no static catalog);
/// for OpenAI-compatible agents it is currently empty.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/tools",
    tag = "Agents",
    summary = "List an agent's tools + MCP tools",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_tools(
    State(state): State<ServerState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    // Tools the ACP agent has actually invoked this run...
    let observed = state.agents.tools_for(&agent_id);
    // ...plus the registered MCP tools this agent is allowed to use. Registered
    // once in config, every agent can reach them (U13). The per-agent allowlist
    // is resolved from the registry config when present.
    let allowlist = state.agents.allowlist_for(&agent_id);
    let mcp = state.mcp.tools_for_agent(allowlist.as_deref()).await;
    Json(json!({ "tools": observed, "mcpTools": mcp }))
}

/// `GET /api/mcp/servers` — list the MCP servers registered in Core config.
#[utoipa::path(
    get,
    path = "/api/mcp/servers",
    tag = "MCP",
    summary = "List configured MCP servers",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_mcp_servers(State(state): State<ServerState>) -> Json<serde_json::Value> {
    Json(json!({ "servers": state.mcp.server_summaries() }))
}

/// Body accepted by `POST /api/mcp/servers`.
#[derive(serde::Deserialize)]
struct CreateMcpServerBody {
    /// The key used to register the server (unique, no `__` separator).
    name: String,
    /// Executable to spawn (e.g. `npx`, `/usr/local/bin/my-mcp`).
    command: String,
    /// Arguments forwarded to the command.
    #[serde(default)]
    args: Vec<String>,
    /// Extra environment variables for the server process.
    #[serde(default)]
    env: std::collections::BTreeMap<String, String>,
    /// Optional human description shown in the Tools page.
    #[serde(default)]
    description: Option<String>,
}

/// `POST /api/mcp/servers` — append a new user-defined MCP server to
/// `~/.ryu/mcp.json` and reload the registry so tools are immediately
/// discoverable without restarting Core.
///
/// Validation:
/// - `name` must be non-empty and must not contain `__` (the tool-id separator
///   that `split_tool_id` uses to route calls).
/// - `command` must be non-empty.
/// - `name` must not already be registered (built-ins included).
///
/// Write strategy: read the current `mcp.json` user map (parse-fail → 400 to
/// avoid clobbering a hand-edited file), insert the new entry, write back
/// atomically via `write_secret_file` + rename, then call `McpRegistry::reload`
/// so the change takes effect without a restart.
#[utoipa::path(
    post,
    path = "/api/mcp/servers",
    tag = "MCP",
    summary = "Register an MCP server",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn create_mcp_server(
    State(state): State<ServerState>,
    Json(body): Json<CreateMcpServerBody>,
) -> axum::response::Response {
    use crate::sidecar::mcp::McpServerConfig;

    let name = body.name.trim().to_string();
    if name.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "name is required".to_owned());
    }
    // The `__` separator is used by `split_tool_id`; a server name containing it
    // would make tool routing ambiguous.
    if name.contains("__") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "name must not contain '__' (reserved tool-id separator)".to_owned(),
        );
    }

    let command = body.command.trim().to_string();
    if command.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "command is required".to_owned());
    }

    // Reject duplicates — check both the in-memory registry (built-ins) and the
    // user file that will be written.
    if state.mcp.contains_server(&name) {
        return json_error(
            StatusCode::CONFLICT,
            format!("MCP server '{name}' is already registered"),
        );
    }

    let cfg_path = crate::sidecar::mcp::McpRegistry::config_path();

    // Read-modify-write the user's mcp.json. A malformed existing file is a
    // 400 (not a 500) so the user can fix and retry; we must not clobber it.
    let write_result = tokio::task::spawn_blocking({
        let name = name.clone();
        let cfg_path = cfg_path.clone();
        let new_cfg = McpServerConfig {
            command: command.clone(),
            args: body.args.clone(),
            env: body.env.clone(),
            description: body.description.clone(),
            enabled: true,
        };
        move || -> Result<(), (StatusCode, String)> {
            // Ensure the parent directory exists.
            if let Some(parent) = cfg_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("cannot create config dir: {e}"),
                    )
                })?;
            }

            // Parse existing user file, or start from an empty map.
            let mut file_map: std::collections::BTreeMap<String, McpServerConfig> =
                if cfg_path.exists() {
                    let raw = std::fs::read_to_string(&cfg_path).map_err(|e| {
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("cannot read mcp.json: {e}"),
                        )
                    })?;
                    // Parse as a raw JSON Value first so we can detect parse errors
                    // and return a 400 without corrupting the file.
                    let val: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
                        (
                            StatusCode::BAD_REQUEST,
                            format!("mcp.json is malformed (fix it before adding): {e}"),
                        )
                    })?;
                    // Extract only `mcpServers` — the key we own. Other unknown
                    // top-level keys are preserved by round-tripping via raw Value.
                    val.get("mcpServers")
                        .and_then(|v| {
                            serde_json::from_value::<
                                std::collections::BTreeMap<String, McpServerConfig>,
                            >(v.clone())
                            .ok()
                        })
                        .unwrap_or_default()
                } else {
                    std::collections::BTreeMap::new()
                };

            // Duplicate check in the file map (handles the rare race between the
            // in-memory `contains_server` check above and the write).
            if file_map.contains_key(&name) {
                return Err((
                    StatusCode::CONFLICT,
                    format!("MCP server '{name}' is already in mcp.json"),
                ));
            }

            file_map.insert(name, new_cfg);

            // Reconstruct the file. We only write `mcpServers`; any other keys
            // the user had in the file are not preserved (they are rare), but
            // we parse only `mcpServers` on load anyway so this is safe.
            let out = serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": file_map
            }))
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to serialize mcp.json: {e}"),
                )
            })?;

            // Atomic write via tmp + rename. write_secret_file sets 0o600 on Unix.
            let tmp = cfg_path.with_extension("json.tmp");
            write_secret_file(&tmp, out.as_bytes()).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to write mcp.json: {e}"),
                )
            })?;
            std::fs::rename(&tmp, &cfg_path).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to rename mcp.json.tmp: {e}"),
                )
            })?;

            Ok(())
        }
    })
    .await;

    match write_result {
        Ok(Ok(())) => {}
        Ok(Err((status, msg))) => return json_error(status, msg),
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("write task panicked: {e}"),
            )
        }
    }

    // Reload the in-memory registry so the new server appears in subsequent
    // GET /api/mcp/servers and GET /api/mcp/tools calls without a restart.
    state.mcp.reload();

    (
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "server": {
                "name": name,
                "command": command,
                "args": body.args,
                "description": body.description,
                "enabled": true,
            }
        })),
    )
        .into_response()
}

/// The active Mcp catalog source (the official MCP registry by default, or a
/// custom registry mirror). See [`crate::catalog_source`].
async fn active_mcp_source(state: &ServerState) -> Option<crate::catalog_source::Source> {
    let source = state
        .catalog_sources
        .get_active(crate::catalog_source::CatalogKind::Mcp, &state.preferences)
        .await?;
    // BYOK: when the active source is Smithery, inject the user's API key from
    // preferences (preferences-first; the source already env-falls-back). The key
    // is host-scoped inside the source so it can only ever reach the Smithery host.
    if let crate::catalog_source::Source::Smithery(mut s) = source.clone() {
        if let Ok(Some(key)) = state
            .preferences
            .get(crate::catalog_source::SMITHERY_API_KEY_PREF)
            .await
        {
            let trimmed = key.trim();
            if !trimmed.is_empty() {
                s.api_key = Some(trimmed.to_string());
            }
        }
        return Some(crate::catalog_source::Source::Smithery(s));
    }
    Some(source)
}

/// `GET /api/mcp/catalog?query=&limit=&cursor=` — browse the active MCP source
/// (the official registry by default). Source-aware (#464): mirrors the model and
/// skill catalog list handlers.
#[utoipa::path(
    get,
    path = "/api/mcp/catalog",
    tag = "MCP",
    summary = "Browse the MCP server catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn mcp_catalog_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let query = params.get("query").map(String::as_str).unwrap_or("");
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(40);
    let cursor = params
        .get("cursor")
        .map(String::as_str)
        .filter(|s| !s.is_empty());

    let mut q = crate::catalog_source::CatalogQuery {
        query: query.to_string(),
        limit,
        cursor: cursor.map(str::to_string),
        ..Default::default()
    };
    q.extra.clear();

    match active_mcp_source(&state).await {
        Some(source) => match source.search(&state.client, &q).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e.to_string(), "servers": [] })),
            ),
        },
        None => (
            StatusCode::OK,
            Json(json!({ "servers": [], "next_cursor": serde_json::Value::Null })),
        ),
    }
}

/// `GET /api/mcp/catalog/detail?id=<server-name>` — the chosen server's packages
/// and remotes, so a client can review the launch command before installing.
#[utoipa::path(
    get,
    path = "/api/mcp/catalog/detail",
    tag = "MCP",
    summary = "MCP server detail",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn mcp_catalog_detail(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `id` query parameter" })),
        );
    };
    match active_mcp_source(&state).await {
        Some(source) => match source.detail(&state.client, id).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e.to_string() })),
            ),
        },
        None => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "no active MCP source" })),
        ),
    }
}

#[derive(serde::Deserialize)]
struct McpCatalogInstallBody {
    /// The registry server name / id to install.
    id: String,
}

/// `POST /api/mcp/catalog/install { id }` — resolve the chosen registry server to
/// a validated `~/.ryu/mcp.json` entry and hot-reload the MCP registry so its
/// tools are listable. Source-aware (#464).
///
/// Security: the entry is written **disabled** so install never auto-launches a
/// registry-supplied command. The resolved command/url is returned in the
/// response so the user can review it before enabling/starting the server through
/// the existing explicit path. The package identifier + version were validated by
/// [`crate::mcp_catalog::plan_install`] (no shell metacharacters / path traversal).
#[utoipa::path(
    post,
    path = "/api/mcp/catalog/install",
    tag = "MCP",
    summary = "Install an MCP server from the catalog",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn mcp_catalog_install(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<McpCatalogInstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let id = body.id.trim().to_string();
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "`id` must not be empty" })),
        );
    }

    // Forward the caller's bearer to the marketplace install handoff (#491) so a
    // PAID Ryu-Marketplace MCP server is denied unless the buyer org holds a
    // license.
    let buyer_token = buyer_bearer_from_headers(&headers);

    // Resolve the install plan through the active MCP source (never launches).
    let plan = match active_mcp_source(&state).await {
        Some(source) => match crate::catalog_source::with_buyer_token(
            buyer_token,
            source.install_mcp(&state.client, &id),
        )
        .await
        {
            Ok(Some(plan)) => plan,
            Ok(None) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(
                        json!({ "success": false, "error": "active MCP source does not support install" }),
                    ),
                )
            }
            Err(e) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "success": false, "error": e.to_string() })),
                )
            }
        },
        None => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "success": false, "error": "no active MCP source" })),
            )
        }
    };

    // Reject a name collision with an already-registered server (built-ins
    // included) before writing.
    if state.mcp.contains_server(&plan.server_name) {
        return (
            StatusCode::CONFLICT,
            Json(
                json!({ "success": false, "error": format!("MCP server '{}' is already registered", plan.server_name) }),
            ),
        );
    }

    // Build the disabled mcp.json entry from the plan. A stdio plan writes its
    // command + args verbatim. A remote plan is bridged to stdio via the standard
    // `mcp-remote` npm shim run through npx (`npx -y mcp-remote <url>`) — the MCP
    // registry's config shape only spawns a stdio command, and a bare `mcp-remote`
    // is not a PATH binary, so the URL must be wrapped in a launchable command for
    // hosted servers (e.g. most Smithery servers) to actually run once enabled.
    let (command, args, url) = match &plan.entry {
        crate::mcp_catalog::McpEntryPlan::Stdio { command, args } => {
            (command.clone(), args.clone(), None)
        }
        crate::mcp_catalog::McpEntryPlan::Remote { url } => (
            "npx".to_string(),
            vec!["-y".to_string(), "mcp-remote".to_string(), url.clone()],
            Some(url.clone()),
        ),
    };

    match write_mcp_entry(
        &plan.server_name,
        &command,
        &args,
        plan.description.as_deref(),
    )
    .await
    {
        Ok(()) => {
            // Hot-reload so the new server's tools are listable without a restart.
            state.mcp.reload();
            (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "server": {
                        "name": plan.server_name,
                        "command": command,
                        "args": args,
                        "url": url,
                        "description": plan.description,
                        // Installed disabled: the user must explicitly enable/start it.
                        "enabled": false,
                    },
                })),
            )
        }
        Err((status, msg)) => (status, Json(json!({ "success": false, "error": msg }))),
    }
}

/// Write a single **disabled** MCP server entry into `~/.ryu/mcp.json`,
/// read-modify-write with an atomic tmp + rename. Shared shape with
/// [`create_mcp_server`] but forces `enabled: false` so a catalog install never
/// auto-launches a registry-supplied command.
async fn write_mcp_entry(
    name: &str,
    command: &str,
    args: &[String],
    description: Option<&str>,
) -> Result<(), (StatusCode, String)> {
    use crate::sidecar::mcp::McpServerConfig;

    let cfg_path = crate::sidecar::mcp::McpRegistry::config_path();
    let name = name.to_string();
    let new_cfg = McpServerConfig {
        command: command.to_string(),
        args: args.to_vec(),
        env: std::collections::BTreeMap::new(),
        description: description.map(str::to_string),
        // Installed disabled — never auto-launch on install.
        enabled: false,
    };

    let result = tokio::task::spawn_blocking(move || -> Result<(), (StatusCode, String)> {
        if let Some(parent) = cfg_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("cannot create config dir: {e}"),
                )
            })?;
        }

        let mut file_map: std::collections::BTreeMap<String, McpServerConfig> = if cfg_path.exists()
        {
            let raw = std::fs::read_to_string(&cfg_path).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("cannot read mcp.json: {e}"),
                )
            })?;
            let val: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    format!("mcp.json is malformed (fix it before installing): {e}"),
                )
            })?;
            val.get("mcpServers")
                .and_then(|v| {
                    serde_json::from_value::<std::collections::BTreeMap<String, McpServerConfig>>(
                        v.clone(),
                    )
                    .ok()
                })
                .unwrap_or_default()
        } else {
            std::collections::BTreeMap::new()
        };

        if file_map.contains_key(&name) {
            return Err((
                StatusCode::CONFLICT,
                format!("MCP server '{name}' is already in mcp.json"),
            ));
        }
        file_map.insert(name, new_cfg);

        let out = serde_json::to_string_pretty(&serde_json::json!({ "mcpServers": file_map }))
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to serialize mcp.json: {e}"),
                )
            })?;
        let tmp = cfg_path.with_extension("json.tmp");
        write_secret_file(&tmp, out.as_bytes()).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to write mcp.json: {e}"),
            )
        })?;
        std::fs::rename(&tmp, &cfg_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to rename mcp.json.tmp: {e}"),
            )
        })?;
        Ok(())
    })
    .await;

    match result {
        Ok(inner) => inner,
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write task panicked: {e}"),
        )),
    }
}

/// `GET /api/mcp/tools` — list every tool across registered MCP servers. An
/// optional `?agent=<id>` narrows the list to that agent's allowlist.
///
/// ## App-enable filtering (AC3)
///
/// Tools whose slug is *declared* by at least one loaded App manifest (via
/// `permission_grants: ["mcp:<slug>"]`) are only included when at least one
/// app that claims them is currently **enabled**. Tools not claimed by any
/// app are always included — they are standalone/built-in MCP tools.
///
/// ## Core-vs-Gateway boundary
///
/// This is a list-time *visibility* filter, not a policy gate. Grant
/// *enforcement* — whether the agent is actually allowed to call the tool —
/// belongs to the Gateway. Core decides what *runs*; Gateway decides what
/// is *allowed*.
#[utoipa::path(
    get,
    path = "/api/mcp/tools",
    tag = "MCP",
    summary = "List available MCP tools",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_mcp_tools(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let raw_tools = match params.get("agent") {
        Some(agent_id) => {
            let allowlist = state.agents.allowlist_for(agent_id);
            state.mcp.tools_for_agent(allowlist.as_deref()).await
        }
        None => state.mcp.list_all_tools().await,
    };

    // Filter: exclude tools whose slug is claimed only by disabled apps.
    let lifecycle = state.app_store.list().await.unwrap_or_default();
    let app_manifests_guard = state.app_manifests.read().await;
    let (disabled_claimed, enabled_claimed) = app_tool_claim_sets(&app_manifests_guard, &lifecycle);
    drop(app_manifests_guard);

    let tools: Vec<_> = raw_tools
        .into_iter()
        .filter(|t| {
            // A tool is gated only if at least one app claims its slug.
            // If claimed by a disabled app AND NOT by any enabled app → exclude.
            // Standalone (unclaimed) tools are always visible.
            if disabled_claimed.contains(&t.name) && !enabled_claimed.contains(&t.name) {
                return false;
            }
            true
        })
        .collect();

    Json(json!({ "tools": tools }))
}

#[derive(serde::Deserialize)]
struct CallToolBody {
    /// Fully-qualified tool id: `<server>__<tool>`.
    tool: String,
    #[serde(default)]
    arguments: serde_json::Value,
    /// Optional agent id whose allowlist gates this call.
    #[serde(default)]
    agent_id: Option<String>,
    /// Optional caller user id — selects the Composio entity (connected-account
    /// owner) and scopes per-user audit. Absent → env/`"default"` fallback.
    #[serde(default)]
    user_id: Option<String>,
}

/// `POST /api/mcp/tools/call` — invoke a registered MCP tool. This is the path
/// the chat tool loop (U12) uses to execute a tool the agent requested.
#[utoipa::path(
    post,
    path = "/api/mcp/tools/call",
    tag = "MCP",
    summary = "Call an MCP tool",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn call_mcp_tool(
    State(state): State<ServerState>,
    Json(body): Json<CallToolBody>,
) -> axum::response::Response {
    // The allowlist must be tied to a *known* agent. A `None` allowlist means
    // "allow every tool" (see `McpRegistry::call_tool`), so we must not let a
    // client reach that path by omitting or faking `agent_id` — that would be a
    // fail-open bypass of the per-agent allowlist. Require a non-empty agent id
    // that resolves to a registered agent; otherwise deny.
    let Some(agent_id) = body.agent_id.as_deref().filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "agent_id is required to call a tool" })),
        )
            .into_response();
    };
    if state.agents.find_by_prefix(agent_id).is_none() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": format!("unknown agent '{agent_id}'") })),
        )
            .into_response();
    }
    // Per-agent restriction comes from the agent's configured allowlist. (A
    // deny-by-default global policy for unconfigured agents is Gateway /
    // control-plane scope, U28/U30, out of scope here.)
    let allowlist = state.agents.allowlist_for(agent_id);
    // Per-agent Identity Vault binding (epic #517): a tool call targeting a
    // NEEDS_AUTH bound domain elicits; an AUTHENTICATED one reads the credential
    // under the gateway grant. Resolved from the AgentStore record (empty when the
    // agent has no row / no binding, which is the common case).
    let identity_profile_ids = state
        .agent_store
        .get(agent_id)
        .await
        .ok()
        .flatten()
        .map(|rec| rec.identity_profile_ids)
        .unwrap_or_default();
    match state
        .mcp
        .call_tool_with_identity(
            &body.tool,
            body.arguments,
            allowlist.as_deref(),
            body.user_id.as_deref(),
            &identity_profile_ids,
            None,
        )
        .await
    {
        Ok(output) => Json(json!({ "ok": true, "output": output })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

// ── Unified tool catalog: search + describe (#474) ───────────────────────────

/// `GET /api/tools/search?q=&kind=&limit=&agent=` — search the unified tool
/// catalog (MCP + built-ins + Composio + plugin tools). `kind` ∈
/// `mcp|builtin|composio|app|any` (default `any`). `agent` narrows results to
/// the agent's allowlist. Returns `{ "object":"list", "data":[ToolDescriptor] }`.
#[utoipa::path(
    get,
    path = "/api/tools/search",
    tag = "Tools",
    summary = "Search the unified tool catalog",
    params(
        ("q" = Option<String>, Query, description = "Natural-language capability query"),
        ("kind" = Option<String>, Query, description = "mcp|builtin|composio|app|any"),
        ("limit" = Option<usize>, Query, description = "Max results (default 8)"),
        ("agent" = Option<String>, Query, description = "Narrow to this agent's allowlist"),
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn tools_search(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let query = params.get("q").map(String::as_str).unwrap_or_default();
    let kind = params
        .get("kind")
        .and_then(|k| crate::sidecar::mcp::catalog::ToolKind::parse_filter(k));
    let limit = params
        .get("limit")
        .and_then(|l| l.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(8)
        .min(25);

    // When `?agent=` is present we narrow by the agent's allowlist (search ≠
    // grant, but a UI can ask for only the tools this agent may actually call).
    // Over-fetch first so allowed tools ranked below the top-`limit` are not
    // hidden by truncation, then narrow, then truncate to `limit`.
    let agent = params.get("agent").filter(|s| !s.is_empty());
    let fetch = if agent.is_some() {
        limit.saturating_mul(4).max(50)
    } else {
        limit
    };
    let mut results = state.mcp.search(query, kind, fetch).await;
    if let Some(agent) = agent {
        if let Some(allow) = state.agents.allowlist_for(agent) {
            // Match the execution gate (id || name || server for MCP/built-ins,
            // id-only for Composio) so search doesn't hide tools the agent may
            // actually call (e.g. a server-level grant like `["spider"]`).
            results.retain(|d| d.matches_allowlist(&allow));
        }
        results.truncate(limit);
    }

    Json(json!({ "object": "list", "data": results }))
}

/// `GET /api/tools/describe?id=` — describe one tool by its fully-qualified id.
/// Returns a `DescribedTool` object as the body root, or 404 when unknown.
#[utoipa::path(
    get,
    path = "/api/tools/describe",
    tag = "Tools",
    summary = "Describe a tool's argument schema",
    params(("id" = String, Query, description = "Fully-qualified tool id (<server>__<tool>)")),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "Missing `id` query parameter"),
        (status = 404, description = "Unknown tool id"),
    )
)]
async fn tools_describe(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing `id`" })),
        )
            .into_response();
    };
    match state.mcp.describe(id).await {
        Some(described) => {
            Json(serde_json::to_value(described).unwrap_or_default()).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown tool id '{id}'") })),
        )
            .into_response(),
    }
}

// ── Programmatic tool calling sandbox (#476, P4) ─────────────────────────────

/// Body for `POST /api/tools/exec`.
#[derive(serde::Deserialize)]
struct ToolExecBody {
    /// Agent whose resolved allowlist gates the program's tool calls. Required;
    /// absent/unknown → rejected (fail-closed, mirrors `call_mcp_tool`).
    agent_id: Option<String>,
    /// The JavaScript program to run.
    code: String,
    /// Optional conversation id. Used **only** to select the Composio entity for
    /// per-user connected accounts (the `user_id` the invoker forwards to
    /// `call_tool_with_user`); it does not flow into the gateway audit
    /// `session_id`. Composio documents that this selector is not authenticated,
    /// so the caller must bind it to a real session upstream.
    #[serde(default)]
    conversation_id: Option<String>,
}

/// Body for `POST /api/tools/exec/resume`.
#[derive(serde::Deserialize)]
struct ToolExecResumeBody {
    agent_id: Option<String>,
    execution_id: String,
    /// `accept | decline | cancel`.
    action: String,
    #[serde(default)]
    content: serde_json::Value,
}

/// `POST /api/tools/exec` — run a JS program in the sandbox, fanning out across
/// tools via the `tools` proxy. Returns the flattened [`ExecOutcome`]
/// (`completed` with the final value + logs, or `paused` awaiting a connect
/// step). The invoker carries the agent's resolved allowlist — no escalation.
#[utoipa::path(
    post,
    path = "/api/tools/exec",
    tag = "Tools",
    summary = "Run a programmatic tool-calling program",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Terminal or paused outcome", body = serde_json::Value),
        (status = 400, description = "Missing/unknown agent or no backend"),
    )
)]
async fn tools_exec(
    State(state): State<ServerState>,
    Json(body): Json<ToolExecBody>,
) -> axum::response::Response {
    let allowlist =
        match crate::tool_exec::resolve_agent_allowlist(&state.agents, body.agent_id.as_deref()) {
            Ok(list) => list,
            Err(e) => {
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response();
            }
        };
    // agent_id is guaranteed present + known by resolve_agent_allowlist.
    let agent_id = body.agent_id.unwrap_or_default();
    // Per-agent Identity Vault binding (epic #517): threaded into the invoker so a
    // program's tool call targeting a NEEDS_AUTH bound domain suspends and an
    // AUTHENTICATED one reads the credential under the gateway grant.
    let identity_profile_ids = state
        .agent_store
        .get(&agent_id)
        .await
        .ok()
        .flatten()
        .map(|rec| rec.identity_profile_ids)
        .unwrap_or_default();
    let invoker = std::sync::Arc::new(
        crate::tool_exec::SandboxToolInvoker::registry_with_identity(
            state.mcp.clone(),
            agent_id.clone(),
            allowlist,
            body.conversation_id,
            identity_profile_ids,
        ),
    );
    let outcome = crate::tool_exec::execute_code(body.code, invoker, &agent_id).await;
    Json(serde_json::to_value(&outcome).unwrap_or_default()).into_response()
}

/// `POST /api/tools/exec/resume` — continue a paused execution after the user
/// completed the auth/consent step. Unknown id → `404 execution_not_found`.
#[utoipa::path(
    post,
    path = "/api/tools/exec/resume",
    tag = "Tools",
    summary = "Resume a paused programmatic execution",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Terminal or paused outcome", body = serde_json::Value),
        (status = 400, description = "Missing/unknown agent or bad action"),
        (status = 404, description = "execution_not_found"),
    )
)]
async fn tools_exec_resume(
    State(state): State<ServerState>,
    Json(body): Json<ToolExecResumeBody>,
) -> axum::response::Response {
    // Validate the agent (fail-closed) — an unknown agent must not be able to
    // poke someone else's parked execution. The resolved agent id is then
    // ownership-checked against the parked execution inside `resume_parked`
    // (security M2): a different known agent gets a 404, not someone else's run.
    if let Err(e) =
        crate::tool_exec::resolve_agent_allowlist(&state.agents, body.agent_id.as_deref())
    {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response();
    }
    let agent_id = body.agent_id.unwrap_or_default();
    let Some(decision) = crate::tool_exec::ResumeDecision::parse(&body.action) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "action must be accept|decline|cancel" })),
        )
            .into_response();
    };
    match crate::tool_exec::resume_execution_opt(
        body.execution_id,
        &agent_id,
        decision,
        body.content,
    )
    .await
    {
        Some(outcome) => Json(serde_json::to_value(&outcome).unwrap_or_default()).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "execution_not_found" })),
        )
            .into_response(),
    }
}

// ── Mesh status (#478) ───────────────────────────────────────────────────────

/// `GET /api/mesh/status` — opt-in Tailscale/Headscale mesh reachability.
///
/// Returns the canonical Contract 6 superset. When the mesh is disabled
/// (`RYU_MESH_ENABLED` unset) this is the all-default object with HTTP 200
/// (never 500), so a vanilla install reports `enabled:false` without amber.
#[utoipa::path(
    get,
    path = "/api/mesh/status",
    tag = "Nodes",
    summary = "Mesh (Tailscale/Headscale) reachability + peers",
    responses((status = 200, description = "Mesh status", body = serde_json::Value))
)]
async fn mesh_status(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let status = state.mesh.status().await;
    Json(serde_json::to_value(status).unwrap_or_default())
}

// ── Webhook ingress seam (#479, P6a) ──────────────────────────────────────────

/// `GET /api/webhook-ingress/status` — the active ingress backend, its public URL
/// (if resolved), and whether ingress is up. Consumed by P7's desktop status
/// surface (the `webhook_ingress_mode` line). `up` is true once a public URL has
/// been resolved (the tunnel/relay can receive Composio webhooks).
#[utoipa::path(
    get,
    path = "/api/webhook-ingress/status",
    tag = "Nodes",
    summary = "Webhook ingress backend + public URL",
    responses((status = 200, description = "Ingress status", body = serde_json::Value))
)]
async fn webhook_ingress_status(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let kind = crate::webhook_ingress::configured_kind(&state.preferences).await;
    let public_url = crate::webhook_ingress::public_url();
    let up = public_url.is_some();
    Json(json!({
        "kind": kind.as_str(),
        "public_url": public_url,
        "up": up,
    }))
}

/// `GET /api/webhook-ingress/backend` — the configured backend selector + the
/// full list of available backends (for a picker). The configured kind resolves
/// from the env override → the `webhook.ingress.backend` pref → the default.
#[utoipa::path(
    get,
    path = "/api/webhook-ingress/backend",
    tag = "Nodes",
    summary = "Get the configured webhook ingress backend",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn webhook_ingress_get_backend(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let kind = crate::webhook_ingress::configured_kind(&state.preferences).await;
    let available: Vec<&str> = crate::webhook_ingress::IngressKind::ALL
        .iter()
        .map(|k| k.as_str())
        .collect();
    Json(json!({
        "backend": kind.as_str(),
        "default": crate::webhook_ingress::IngressKind::DEFAULT.as_str(),
        "available": available,
    }))
}

#[derive(serde::Deserialize)]
struct SetIngressBackendBody {
    backend: String,
}

/// `POST /api/webhook-ingress/backend` — select the active ingress backend,
/// persisted to the `webhook.ingress.backend` pref. The change takes effect on
/// the next Core start (the ingress is built once at startup). Rejects an unknown
/// backend with 400.
#[utoipa::path(
    post,
    path = "/api/webhook-ingress/backend",
    tag = "Nodes",
    summary = "Set the active webhook ingress backend",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn webhook_ingress_set_backend(
    State(state): State<ServerState>,
    Json(body): Json<SetIngressBackendBody>,
) -> axum::response::Response {
    let kind: crate::webhook_ingress::IngressKind = match body.backend.parse() {
        Ok(k) => k,
        Err(e) => {
            return json_error(StatusCode::BAD_REQUEST, e.to_string());
        }
    };
    match state
        .preferences
        .set(crate::webhook_ingress::INGRESS_BACKEND_PREF, kind.as_str())
        .await
    {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "backend": kind.as_str() })),
        )
            .into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ── Sandbox enable/disable (M6 / issue #190) ─────────────────────────────────

#[utoipa::path(
    post,
    path = "/api/mcp/sandbox/enable",
    tag = "MCP",
    summary = "Enable MCP tool sandboxing",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn sandbox_enable() -> Json<serde_json::Value> {
    crate::sidecar::mcp::sandbox::set_enabled(true);
    Json(json!({ "ok": true, "enabled": true }))
}

#[utoipa::path(
    post,
    path = "/api/mcp/sandbox/disable",
    tag = "MCP",
    summary = "Disable MCP tool sandboxing",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn sandbox_disable() -> Json<serde_json::Value> {
    crate::sidecar::mcp::sandbox::set_enabled(false);
    Json(json!({ "ok": true, "enabled": false }))
}

#[utoipa::path(
    get,
    path = "/api/mcp/sandbox/status",
    tag = "MCP",
    summary = "MCP sandbox availability + state",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn sandbox_status() -> Json<serde_json::Value> {
    use crate::sidecar::sandbox::docker::{detect, DetectResult};

    let enabled = crate::sidecar::mcp::sandbox::is_enabled();
    let available = cfg!(feature = "sandbox-wasmtime");

    // Probe Docker daemon availability (detect-only; never installs Docker).
    let docker_detect = detect().await;
    let docker_available = matches!(docker_detect, DetectResult::Available);
    let docker_reason = match &docker_detect {
        DetectResult::Available => None,
        DetectResult::Unavailable(r) => Some(r.as_str()),
    };

    Json(json!({
        "enabled": enabled,
        "available": available,
        "docker": {
            "available": docker_available,
            "reason": docker_reason,
        }
    }))
}

// ── Spaces / RAG handlers (spec unit U16) ─────────────────────────────────────

#[derive(serde::Deserialize)]
struct CreateSpaceBody {
    name: String,
    description: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/spaces",
    tag = "Spaces",
    summary = "Create a space",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn create_space(
    State(state): State<ServerState>,
    Json(body): Json<CreateSpaceBody>,
) -> axum::response::Response {
    if body.name.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "name is required".to_owned());
    }
    match state
        .spaces
        .create_space(body.name.trim(), body.description.as_deref())
        .await
    {
        Ok(id) => Json(json!({ "id": id })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/spaces",
    tag = "Spaces",
    summary = "List spaces",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_spaces(State(state): State<ServerState>) -> axum::response::Response {
    match state.spaces.list_spaces().await {
        Ok(items) => Json(json!({ "spaces": items })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    delete,
    path = "/api/spaces/{id}",
    tag = "Spaces",
    summary = "Delete a space",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn delete_space(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    match state.spaces.delete_space(&id).await {
        Ok(removed) => Json(json!({ "success": true, "removed": removed })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/spaces/{id}/documents",
    tag = "Spaces",
    summary = "List documents in a space",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_documents(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    match state.spaces.list_documents(&id).await {
        Ok(documents) => Json(json!({ "space_id": id, "documents": documents })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct IngestBody {
    title: String,
    content: String,
}

#[utoipa::path(
    post,
    path = "/api/spaces/{id}/documents",
    tag = "Spaces",
    summary = "Ingest a document into a space",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn ingest_document(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<IngestBody>,
) -> axum::response::Response {
    match state
        .spaces
        .ingest_document(&id, body.title.trim(), &body.content)
        .await
    {
        Ok(document_id) => Json(json!({ "document_id": document_id })).into_response(),
        Err(e) => {
            let msg = e.to_string();
            let status = if msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}

#[derive(serde::Deserialize)]
struct SearchBody {
    query: String,
    #[serde(default = "default_search_limit")]
    limit: usize,
}

fn default_search_limit() -> usize {
    5
}

#[utoipa::path(
    post,
    path = "/api/spaces/{id}/search",
    tag = "Spaces",
    summary = "Search a space (RAG)",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn search_space(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SearchBody>,
) -> axum::response::Response {
    let limit = body.limit.clamp(1, 50);
    // Lazily start the (off-by-default) reranker server so Spaces RAG can neural-
    // rerank. Fire-and-forget: the current search fails open to the vector order
    // if the server isn't warm yet; subsequent searches rerank once it is up.
    {
        let manager = state.manager.clone();
        tokio::spawn(async move {
            if let Err(e) = manager.start_sidecar("llamacpp-rerank").await {
                tracing::debug!("llamacpp-rerank lazy start skipped: {e:#}");
            }
        });
    }
    match state.spaces.search(&id, &body.query, limit).await {
        Ok(matches) => Json(json!({ "space_id": id, "matches": matches })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct CreatePageBody {
    title: String,
    /// When set, create a child "row page" parented to this document (a database).
    #[serde(default)]
    parent_id: Option<String>,
}

/// `POST /api/spaces/:id/pages` — create an empty Notion-style markdown page.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/pages",
    tag = "Spaces",
    summary = "Create a page document",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn create_page(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<CreatePageBody>,
) -> axum::response::Response {
    let title = if body.title.trim().is_empty() {
        "Untitled"
    } else {
        body.title.trim()
    };
    let result = match body.parent_id.as_deref() {
        Some(parent) => state.spaces.create_child_page(&id, title, parent).await,
        None => state.spaces.create_page(&id, title).await,
    };
    match result {
        Ok(document_id) => Json(json!({ "id": document_id })).into_response(),
        Err(e) => {
            let msg = e.to_string();
            let status = if msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}

/// `POST /api/spaces/:id/databases` — create an empty database (data-grid) doc.
/// Same lifecycle as a page; the editor saves its grid JSON via `update_document`.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/databases",
    tag = "Spaces",
    summary = "Create a database document",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn create_database(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<CreatePageBody>,
) -> axum::response::Response {
    let title = if body.title.trim().is_empty() {
        "Untitled"
    } else {
        body.title.trim()
    };
    match state.spaces.create_database(&id, title).await {
        Ok(document_id) => Json(json!({ "id": document_id })).into_response(),
        Err(e) => {
            let msg = e.to_string();
            let status = if msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}

/// `GET /api/spaces/:id/documents/:doc_id` — fetch a document's markdown source.
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/documents/{doc_id}",
    tag = "Spaces",
    summary = "Get a document",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_document(
    State(state): State<ServerState>,
    axum::extract::Path((_id, doc_id)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    // TODO (Phase 1 realtime join): enforce read ACL here. Extract
    // `Extension<Option<VerifiedCaller>>`, load the document's
    // owner_user_id/org_id/visibility/team_id, and gate on
    // `crate::identity_verify::can_access(...) != Access::None`. Not enforced in
    // Phase 0 so the single-tenant flow is unchanged.
    match state.spaces.get_document(&doc_id).await {
        Ok(Some(doc)) => Json(doc).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "document not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct UpdateDocumentBody {
    title: String,
    source: String,
}

/// `PUT /api/spaces/:id/documents/:doc_id` — save edits (re-embeds on save).
#[utoipa::path(
    put,
    path = "/api/spaces/{id}/documents/{doc_id}",
    tag = "Spaces",
    summary = "Update a document",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn update_document(
    State(state): State<ServerState>,
    axum::extract::Path((_id, doc_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<UpdateDocumentBody>,
) -> axum::response::Response {
    match state
        .spaces
        .update_document(&doc_id, body.title.trim(), &body.source)
        .await
    {
        Ok(()) => Json(json!({ "success": true })).into_response(),
        Err(e) => {
            let msg = e.to_string();
            let status = if msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}

/// `DELETE /api/spaces/:id/documents/:doc_id` — delete a single document.
#[utoipa::path(
    delete,
    path = "/api/spaces/{id}/documents/{doc_id}",
    tag = "Spaces",
    summary = "Delete a document",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn delete_document(
    State(state): State<ServerState>,
    axum::extract::Path((_id, doc_id)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    match state.spaces.delete_document(&doc_id).await {
        Ok(removed) => Json(json!({ "success": true, "removed": removed })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /api/embeddings/model` — the active default embedding model + dims.
#[utoipa::path(
    get,
    path = "/api/embeddings/model",
    tag = "Spaces",
    summary = "Get the active embedding model",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_embedding_model(State(state): State<ServerState>) -> axum::response::Response {
    Json(state.spaces.embedding_model().await).into_response()
}

#[derive(serde::Deserialize)]
struct SetEmbeddingModelBody {
    model_id: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    dims: Option<usize>,
}

/// `POST /api/embeddings/model` — change the default embedding model. Persists the
/// choice, swaps the live embedder, and kicks a background re-index (every existing
/// vector lives in the old model's space and must be re-embedded).
#[utoipa::path(
    post,
    path = "/api/embeddings/model",
    tag = "Spaces",
    summary = "Set the embedding model",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn set_embedding_model(
    State(state): State<ServerState>,
    Json(body): Json<SetEmbeddingModelBody>,
) -> axum::response::Response {
    if body.model_id.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "model_id is required".to_owned());
    }
    let pref = spaces::EmbeddingModelPref {
        model_id: body.model_id.trim().to_owned(),
        base_url: body.base_url.clone(),
        dims: body.dims,
    };
    let raw = match serde_json::to_string(&pref) {
        Ok(s) => s,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if let Err(e) = state
        .preferences
        .set(spaces::EMBEDDING_MODEL_PREF_KEY, &raw)
        .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state.spaces.set_embedder(pref.into_embedder()).await;
    let store = state.spaces.clone();
    tokio::spawn(async move {
        let _ = store.reindex_all().await;
    });
    Json(json!({ "success": true, "reindexing": true })).into_response()
}

/// `POST /api/embeddings/reindex` — manually kick a background re-index.
#[utoipa::path(
    post,
    path = "/api/embeddings/reindex",
    tag = "Spaces",
    summary = "Trigger a re-index",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn trigger_reindex(State(state): State<ServerState>) -> axum::response::Response {
    let store = state.spaces.clone();
    tokio::spawn(async move {
        let _ = store.reindex_all().await;
    });
    Json(json!({ "started": true })).into_response()
}

/// `GET /api/embeddings/reindex/status` — re-index progress (pending chunk count).
#[utoipa::path(
    get,
    path = "/api/embeddings/reindex/status",
    tag = "Spaces",
    summary = "Re-index progress",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn reindex_status(State(state): State<ServerState>) -> axum::response::Response {
    match state.spaces.reindex_status().await {
        Ok(status) => Json(status).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

fn json_error(status: StatusCode, msg: String) -> axum::response::Response {
    // Serialize via serde so quotes/backslashes/control chars in `msg`
    // (e.g. serde parse errors, resolver errors) can't produce malformed JSON.
    let body = json!({ "error": msg }).to_string();
    axum::response::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response())
}

#[utoipa::path(
    post,
    path = "/v1/chat/completions",
    tag = "Chat",
    summary = "OpenAI-compatible chat completions (proxied)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn oai_chat_completions(
    State(state): State<ServerState>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::{body::Body, http::StatusCode};

    let json_body: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, format!("invalid json: {e}")),
    };

    let model = json_body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let is_stream = json_body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let upstream_base = if model.starts_with("zeroclaw") {
        "http://127.0.0.1:42617"
    } else if model.starts_with("openclaw") {
        "http://127.0.0.1:3118"
    } else {
        "http://127.0.0.1:11434"
    };

    let url = format!("{upstream_base}/v1/chat/completions");
    tracing::debug!(model, upstream = %url, stream = is_stream, "oai_chat_completions: routing");

    let upstream_resp = match state
        .client
        .post(&url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("upstream unreachable: {e}"),
            )
        }
    };

    let status = upstream_resp.status();
    let content_type = upstream_resp
        .headers()
        .get("content-type")
        .cloned()
        .unwrap_or_else(|| axum::http::HeaderValue::from_static("application/json"));

    let mut builder = axum::response::Response::builder()
        .status(status)
        .header("content-type", content_type);

    if is_stream {
        builder = builder
            .header("cache-control", "no-cache")
            .header("x-accel-buffering", "no");
    }

    builder
        .body(Body::from_stream(upstream_resp.bytes_stream()))
        .unwrap()
}

#[utoipa::path(
    get,
    path = "/api/health",
    tag = "Health",
    summary = "Service health check",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": crate::capabilities::version(),
        "capabilities": crate::capabilities::CAPABILITIES,
    }))
}

#[utoipa::path(
    get,
    path = "/api/catalog",
    tag = "Sidecars",
    summary = "List the sidecar (engine/tool/agent) catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_catalog(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let items = state.catalog.get_catalog(&state.install_status).await;
    Json(json!({ "sidecars": items }))
}

// ── Model catalog (Hugging Face browse + install, all logic in Core) ─────────
//
// The desktop/mobile/extension are pure GUI layers over these endpoints. Search,
// sorting, device-fit, stats, and install all happen here so every surface
// behaves identically. See `crate::model_catalog`.

/// True when an active Model source resolves search/detail/install through the
/// CatalogSource seam (a flat descriptor) rather than the HF Hub resolve path:
/// a model-index source (#461) or a Ryu Marketplace model source (#467). HF /
/// ModelScope sources go through the dedicated `model_catalog` HF helpers.
fn is_seam_model_source(source: &crate::catalog_source::Source) -> bool {
    matches!(
        source,
        crate::catalog_source::Source::ModelIndex(_)
            | crate::catalog_source::Source::RyuMarketplace(_)
    )
}

/// Resolve the active Model [`HfEndpoint`] from the catalog-source registry.
/// The active source (HF by default, or a selected ModelScope/custom source)
/// owns the host every model fetch points at — this is the seam in action
/// (#460). Falls back to the Hugging Face default when no model source resolves.
async fn active_model_endpoint(state: &ServerState) -> crate::model_catalog::HfEndpoint {
    use crate::catalog_source::{CatalogKind, Source};
    match state
        .catalog_sources
        .get_active(CatalogKind::Model, &state.preferences)
        .await
    {
        Some(Source::Hf(hf)) => hf.endpoint(),
        _ => crate::model_catalog::HfEndpoint::huggingface(),
    }
}

/// `GET /api/composio/status` — is a Composio key configured + the active base.
#[utoipa::path(
    get,
    path = "/api/composio/status",
    tag = "Composio",
    summary = "Composio integration status",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn composio_status() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::OK,
        Json(json!({
            "configured": crate::composio_auth::is_configured(),
            "base_url": crate::composio_catalog::base_url(),
        })),
    )
}

/// `GET /api/composio/toolkits` — browse the user's Composio toolkits.
#[utoipa::path(
    get,
    path = "/api/composio/toolkits",
    tag = "Composio",
    summary = "Browse Composio toolkits",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn composio_toolkits(
    State(state): State<ServerState>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::composio_catalog::list_toolkits(&state.client).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "data": [] })),
        ),
    }
}

/// `GET /api/composio/actions?toolkit=&q=&limit=` — list a toolkit's actions.
#[utoipa::path(
    get,
    path = "/api/composio/actions",
    tag = "Composio",
    summary = "List Composio actions for a toolkit",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn composio_actions(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let toolkit = params.get("toolkit").map(String::as_str).unwrap_or("");
    let query = params.get("q").map(String::as_str).unwrap_or("");
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(50);
    match crate::composio_catalog::list_actions(&state.client, toolkit, query, limit).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "data": [] })),
        ),
    }
}

/// `GET /api/composio/triggers?toolkit=` — list a toolkit's trigger types.
#[utoipa::path(
    get,
    path = "/api/composio/triggers",
    tag = "Composio",
    summary = "List Composio trigger types for a toolkit",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn composio_triggers(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let toolkit = params.get("toolkit").map(String::as_str).unwrap_or("");
    match crate::composio_catalog::list_triggers(&state.client, toolkit).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "data": [] })),
        ),
    }
}

/// `GET /api/composio/connections?toolkit=` — list the user's connected accounts,
/// optionally filtered to one toolkit (for the Connections tab's connected state).
#[utoipa::path(
    get,
    path = "/api/composio/connections",
    tag = "Composio",
    summary = "List the user's Composio connected accounts",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn composio_connections(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    // No Composio key is the default state, not a failure: report it as an empty,
    // unconfigured list (200) so callers show a "connect an integration" empty
    // state rather than a load error. 502 stays reserved for real upstream faults.
    if !crate::composio_auth::is_configured() {
        return (
            StatusCode::OK,
            Json(json!({ "data": [], "configured": false })),
        );
    }
    let toolkit = params.get("toolkit").map(String::as_str).unwrap_or("");
    match crate::composio_connect::list_connections(&state.client, toolkit).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "data": [] })),
        ),
    }
}

/// Body for `POST /api/composio/connections/initiate`.
#[derive(serde::Deserialize)]
struct ComposioConnectBody {
    toolkit: String,
}

/// `POST /api/composio/connections/initiate` — start an OAuth connection for a
/// toolkit. Returns `{ connection_id, redirect_url, status }`; the client opens
/// `redirect_url` then polls `GET /api/composio/connections/:id`.
#[utoipa::path(
    post,
    path = "/api/composio/connections/initiate",
    tag = "Composio",
    summary = "Initiate a Composio account connection for a toolkit",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn composio_connection_initiate(
    State(state): State<ServerState>,
    Json(body): Json<ComposioConnectBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::composio_connect::initiate(&state.client, &body.toolkit).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `GET /api/composio/connections/:id` — poll one connection's status (the client
/// calls this after the user returns from the Composio OAuth redirect).
#[utoipa::path(
    get,
    path = "/api/composio/connections/{id}",
    tag = "Composio",
    summary = "Poll a Composio connection's status",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn composio_connection_status(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::composio_connect::connection_status(&state.client, &id).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Body for `POST /api/composio/triggers/subscribe`.
#[derive(serde::Deserialize)]
struct ComposioSubscribeBody {
    agent_id: String,
    toolkit: String,
    trigger_slug: String,
    connected_account_id: String,
    #[serde(default)]
    config: serde_json::Value,
}

/// `POST /api/composio/triggers/subscribe` — register a Composio trigger instance
/// and bind it to an agent.
#[utoipa::path(
    post,
    path = "/api/composio/triggers/subscribe",
    tag = "Composio",
    summary = "Subscribe an agent to a Composio event trigger",
    request_body = serde_json::Value,
    responses((status = 201, description = "Created", body = serde_json::Value))
)]
async fn composio_trigger_subscribe(
    Json(body): Json<ComposioSubscribeBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::composio_triggers::global() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "composio triggers store unavailable" })),
        );
    };
    let config = if body.config.is_null() {
        json!({})
    } else {
        body.config
    };
    match store
        .subscribe(
            &body.agent_id,
            &body.toolkit,
            &body.trigger_slug,
            &body.connected_account_id,
            config,
        )
        .await
    {
        Ok(sub) => (StatusCode::CREATED, Json(json!({ "subscription": sub }))),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `GET /api/composio/trigger-subscriptions` — list agent↔trigger subscriptions.
#[utoipa::path(
    get,
    path = "/api/composio/trigger-subscriptions",
    tag = "Composio",
    summary = "List Composio trigger subscriptions",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn composio_trigger_list() -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::composio_triggers::global() else {
        return (StatusCode::OK, Json(json!({ "subscriptions": [] })));
    };
    match store.list().await {
        Ok(subs) => (StatusCode::OK, Json(json!({ "subscriptions": subs }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `DELETE /api/composio/trigger-subscriptions/:id` — remove a subscription.
#[utoipa::path(
    delete,
    path = "/api/composio/trigger-subscriptions/{id}",
    tag = "Composio",
    summary = "Delete a Composio trigger subscription",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn composio_trigger_delete(Path(id): Path<String>) -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::composio_triggers::global() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "composio triggers store unavailable" })),
        );
    };
    match store.delete(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "subscription not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `POST /api/composio/webhook` — inbound Composio trigger event. Maps the event
/// to subscribed agents/workflows and fires each. Requires Core to be reachable
/// at a public URL (or via a relay) for the webhook to arrive (#456).
///
/// This route is **public** (it sits outside `require_auth`) because an external
/// Composio delivery cannot send Core's bearer token. It is instead authenticated
/// **fail-closed** with an HMAC-SHA256 signature over the raw body keyed by
/// `COMPOSIO_WEBHOOK_SECRET` (see [`crate::composio_triggers::verify_webhook_signature`]):
/// when the secret is unset, or the `webhook-signature` header is absent/invalid,
/// the request is rejected with 401 and nothing fires.
#[utoipa::path(
    post,
    path = "/api/composio/webhook",
    tag = "Composio",
    summary = "Composio trigger webhook receiver (HMAC-authenticated)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 401, description = "Missing/invalid signature or secret unset")
    )
)]
async fn composio_webhook(
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
    // Authenticate the raw bytes BEFORE parsing — verify over exactly what was
    // received, never a re-serialized value. Read the signature from any of the
    // common header spellings (Composio/Svix vary by version).
    let signature = ["webhook-signature", "x-composio-signature", "x-signature"]
        .iter()
        .find_map(|h| headers.get(*h).and_then(|v| v.to_str().ok()));
    if !crate::composio_triggers::verify_webhook_signature(&body, signature) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid or missing webhook signature" })),
        );
    }

    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid JSON body: {e}") })),
            );
        }
    };

    let Some(store) = crate::composio_triggers::global() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "composio triggers store unavailable" })),
        );
    };
    let fired = store.handle_webhook(&payload).await;
    (StatusCode::OK, Json(json!({ "ok": true, "fired": fired })))
}

/// `GET /api/models/catalog?query=&sort=&limit=&installed_only=`
#[utoipa::path(
    get,
    path = "/api/models/catalog",
    tag = "Models",
    summary = "Browse the model catalog (HF GGUF)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn models_catalog_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let query = params.get("query").map(String::as_str).unwrap_or("");
    let sort = crate::model_catalog::CatalogSort::parse(
        params.get("sort").map(String::as_str).unwrap_or("trending"),
    );
    // Weight-format facet (one clean cursor per format; the desktop fans out).
    // Defaults to GGUF for back-compat with older clients that omit it.
    let format = crate::model_format::ModelFormat::from_wire(
        params.get("format").map(String::as_str).unwrap_or("gguf"),
    );
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(40);
    let installed_only = params
        .get("installed_only")
        .map(|s| s == "true" || s == "1")
        .unwrap_or(false);
    // Optional Hugging Face pipeline tag (e.g. `sentence-similarity` for
    // embeddings). The friendly category → tag mapping lives in the client.
    let task = params.get("task").map(String::as_str).unwrap_or("");
    // Optional org/user "browse this org" filter (a Hub namespace).
    let author = params.get("author").map(String::as_str).unwrap_or("");
    // Opaque pagination cursor for infinite scroll (from a prior page's
    // `next_cursor`). Forwarded verbatim to the Hub.
    let cursor = params
        .get("cursor")
        .map(String::as_str)
        .filter(|s| !s.is_empty());

    // A model-index active source has no HF query surface — route the search
    // through the active CatalogSource so its flat JSON index is listed. The
    // installed-only view is local + source-agnostic, so it always uses the HF
    // helper (which reads the on-disk models dir).
    if !installed_only {
        // Bind the active source ONCE and match on the binding (selection could
        // otherwise change between two awaits, panicking the `.expect`).
        let active = state
            .catalog_sources
            .get_active(
                crate::catalog_source::CatalogKind::Model,
                &state.preferences,
            )
            .await;
        if let Some(source) = active.as_ref().filter(|s| is_seam_model_source(s)) {
            let mut q = crate::catalog_source::CatalogQuery {
                query: query.to_string(),
                limit,
                cursor: cursor.map(str::to_string),
                ..Default::default()
            };
            q.extra.insert(
                "sort".to_string(),
                serde_json::Value::String(params.get("sort").cloned().unwrap_or_default()),
            );
            q.extra.insert(
                "format".to_string(),
                serde_json::Value::String(format.as_str().to_string()),
            );
            return match source.search(&state.client, &q).await {
                Ok(value) => (StatusCode::OK, Json(value)),
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": e.to_string(), "models": [] })),
                ),
            };
        }
    }

    let endpoint = active_model_endpoint(&state).await;
    match crate::model_catalog::search_models_json(
        &state.client,
        &endpoint,
        query,
        sort,
        format,
        limit,
        installed_only,
        task,
        author,
        cursor,
    )
    .await
    {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "models": [] })),
        ),
    }
}

/// `GET /api/models/catalog/detail?id=author%2Fname`
#[utoipa::path(
    get,
    path = "/api/models/catalog/detail",
    tag = "Models",
    summary = "Model detail: README + per-quant files",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn models_catalog_detail(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `id` query parameter" })),
        );
    };
    // A model-index active source resolves detail from its flat JSON index, not
    // the HF info/tree/README round-trips. Bind the active source ONCE and match
    // on the binding (avoids a panic if selection changes between two awaits).
    let active = state
        .catalog_sources
        .get_active(
            crate::catalog_source::CatalogKind::Model,
            &state.preferences,
        )
        .await;
    if let Some(source) = active.as_ref().filter(|s| is_seam_model_source(s)) {
        return match source.detail(&state.client, id).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e.to_string() })),
            ),
        };
    }

    let format = crate::model_format::ModelFormat::from_wire(
        params.get("format").map(String::as_str).unwrap_or("gguf"),
    );
    let endpoint = active_model_endpoint(&state).await;
    match crate::model_catalog::model_detail_json(&state.client, &endpoint, id, format).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
struct ModelInstallBody {
    id: String,
    /// GGUF filename to install. Required for single-file (GGUF) installs;
    /// ignored for a snapshot install (the whole repo is fetched).
    #[serde(default)]
    file: String,
    /// Weight format. Defaults to GGUF for back-compat with older clients.
    /// Drives the single-file-vs-snapshot dispatch on the direct HF path.
    #[serde(default)]
    format: Option<String>,
}

/// Header carrying the buyer's CONTROL-PLANE session bearer for a marketplace
/// install (#491). Distinct from `Authorization` on purpose: `Authorization`
/// holds the Core **node** token (a machine secret the control plane does not
/// recognize as a user), so the desktop sends its signed-in Better-Auth session
/// token here instead, and Core forwards it to the install handoff. The control
/// plane resolves the buyer org + license from it. Absent ⇒ anonymous install
/// (free items only).
const BUYER_TOKEN_HEADER: &str = "x-ryu-buyer-token";

/// Extract the caller's marketplace buyer bearer to forward to the install
/// handoff. Prefers the dedicated [`BUYER_TOKEN_HEADER`] (the user's
/// control-plane session token); when absent, falls back to the
/// `Authorization: Bearer …` value so a direct/headless caller hitting Core with
/// a real user token still works. Returns the trimmed token, or `None` for an
/// anonymous (free-item) install.
fn buyer_bearer_from_headers(headers: &axum::http::HeaderMap) -> Option<String> {
    let from_dedicated = headers
        .get(BUYER_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    if from_dedicated.is_some() {
        return from_dedicated;
    }
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// `POST /api/models/catalog/install { id, file }`
///
/// Source-aware install. For an HF-compatible active model source (the default),
/// `id` is the Hub `author/name` repo and `file` the GGUF filename, downloaded
/// via the HF resolve URL. For a Ryu **model-index** active source (#461), the
/// source resolves a descriptor (download URL + sha) for `id`; Core validates
/// the descriptor URL against the SSRF guard and downloads it through the same
/// privileged [`crate::model_catalog::install_from_descriptor`] path. Either
/// way Core stays the only code that touches the disk.
#[utoipa::path(
    post,
    path = "/api/models/catalog/install",
    tag = "Models",
    summary = "Install a GGUF model file",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn models_catalog_install(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ModelInstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::catalog_source::CatalogKind;

    // Forward the caller's bearer to the marketplace install handoff (#491): a
    // PAID Ryu-Marketplace item is denied unless the buyer org holds a license.
    let buyer_token = buyer_bearer_from_headers(&headers);

    let active = state
        .catalog_sources
        .get_active(CatalogKind::Model, &state.preferences)
        .await;

    // Seam model sources (model-index or the Ryu Marketplace) install from a
    // source-supplied descriptor (arbitrary download URL), not the HF resolve
    // path.
    if active.as_ref().is_some_and(is_seam_model_source) {
        let source = active.expect("active model source present in this branch");
        let descriptor = match crate::catalog_source::with_buyer_token(
            buyer_token,
            source.install_descriptor(&state.client, &body.id),
        )
        .await
        {
            Ok(d) => d,
            Err(e) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "success": false, "error": e.to_string() })),
                );
            }
        };
        let Some(file) = descriptor.files.into_iter().next() else {
            return (
                StatusCode::BAD_GATEWAY,
                Json(
                    json!({ "success": false, "error": "model index entry has no downloadable file" }),
                ),
            );
        };
        // The descriptor URL is source-supplied and becomes an outbound fetch
        // target — validate it against the SSRF guard before downloading.
        if let Err(e) = validate_remote_base_url(&file.url).await {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": format!("download URL rejected: {e}") })),
            );
        }
        return match crate::model_catalog::install_from_descriptor(
            &descriptor.repo_id,
            &file.url,
            file.sha256.as_deref(),
            &file.dest_filename,
            &state.downloads,
        )
        .await
        {
            Ok(result) => (
                StatusCode::OK,
                Json(
                    json!({ "success": true, "result": serde_json::to_value(result).unwrap_or_default() }),
                ),
            ),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            ),
        };
    }

    let endpoint = active_model_endpoint(&state).await;
    let format =
        crate::model_format::ModelFormat::from_wire(body.format.as_deref().unwrap_or("gguf"));

    // Dispatch on format: GGUF is a single verified file; safetensors/MLX are a
    // multi-file repo snapshot. (Ollama is its own CLI pull, never routed here.)
    let result = if format.is_single_file() {
        crate::model_catalog::install_file(
            &state.client,
            &endpoint,
            &body.id,
            &body.file,
            &state.downloads,
        )
        .await
    } else {
        crate::model_catalog::install_snapshot(
            &state.client,
            &endpoint,
            &body.id,
            format,
            &state.downloads,
        )
        .await
    };

    match result {
        Ok(result) => (
            StatusCode::OK,
            Json(
                json!({ "success": true, "result": serde_json::to_value(result).unwrap_or_default() }),
            ),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
struct ModelUninstallBody {
    /// The model's repo id (used to scope cache invalidation).
    id: String,
    /// The GGUF filename to remove (its stem is the on-disk key).
    file: String,
}

/// `POST /api/models/catalog/uninstall { id, file }`
///
/// Delete a downloaded GGUF and clear its catalog provenance. Source-agnostic:
/// installed models live in one on-disk dir regardless of which source fetched
/// them, so this routes straight to [`crate::model_catalog::uninstall_file`]
/// (no per-source branch like install needs).
#[utoipa::path(
    post,
    path = "/api/models/catalog/uninstall",
    tag = "Models",
    summary = "Uninstall a model file",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn models_catalog_uninstall(
    Json(body): Json<ModelUninstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::model_catalog::uninstall_file(&body.id, &body.file) {
        Ok(()) => (StatusCode::OK, Json(json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// `GET /api/models/device` — detected hardware for the fit estimate.
#[utoipa::path(
    get,
    path = "/api/models/device",
    tag = "Models",
    summary = "Detect local device RAM/VRAM for fit verdicts",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn models_device() -> Json<serde_json::Value> {
    let device = crate::model_catalog::device::DeviceInfo::detect();
    Json(serde_json::to_value(device).unwrap_or_default())
}

/// `GET /api/models/llmfit-estimate?repo=&context=&quant=` — on-demand hardware
/// fit + tok/s estimate for one model via the optional `llmfit` sidecar. It is
/// slow (~15s, networked) and only matches llmfit's curated catalog, so the
/// desktop calls it ONLY on an explicit "Estimate speed" click, never while
/// listing models. Always 200: the body's `installed`/`matched` flags tell the
/// UI whether to render the estimate, prompt to install llmfit, or fall back to
/// the instant native verdict.
#[utoipa::path(
    get,
    path = "/api/models/llmfit-estimate",
    tag = "Models",
    summary = "On-demand llmfit fit + tok/s estimate for one model",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn models_llmfit_estimate(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(repo) = params.get("repo").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `repo` query parameter" })),
        );
    };
    let context = params.get("context").and_then(|s| s.parse::<u32>().ok());
    let quant = params
        .get("quant")
        .map(String::as_str)
        .filter(|s| !s.is_empty());
    let estimate = crate::model_catalog::llmfit::estimate(repo, context, quant).await;
    (
        StatusCode::OK,
        Json(serde_json::to_value(estimate).unwrap_or_default()),
    )
}

/// `GET /api/models/installed` — the flat list of models present on disk, each
/// with its local `stem` (the servable ref), origin `repo_id`, format, size, and
/// `finetune_base` when it is a merged fine-tune. Unlike `/api/models/catalog`
/// (HF browse, keyed by repo id), this exposes every installed model by its own
/// stem — including fine-tuned GGUFs, which collapse under their base repo in the
/// catalog view. Backs the "your fine-tuned models" list and the agent model
/// picker.
#[utoipa::path(
    get,
    path = "/api/models/installed",
    tag = "Models",
    summary = "List installed models by stem (with fine-tune provenance)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn models_installed() -> Json<serde_json::Value> {
    let models = crate::model_catalog::installed::load_present();
    Json(json!({ "models": models }))
}

/// `GET /api/models/engines` — the format → engine capability map for THIS node,
/// with per-engine `supported` flags and the currently resident engine. The
/// desktop renders compatibility annotations + the format facet from this
/// without guessing; the verdict is authoritative because it is computed on the
/// (possibly remote) Core node.
#[utoipa::path(
    get,
    path = "/api/models/engines",
    tag = "Models",
    summary = "Format → engine capability map + node support",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn models_engines(State(state): State<ServerState>) -> Json<serde_json::Value> {
    use crate::model_format::{engines_for_format, format_supported_on_node, ModelFormat};

    let supported = crate::catalog::registry::supported_on_node;
    let formats: Vec<serde_json::Value> = ModelFormat::ALL
        .iter()
        .map(|fmt| {
            let engines: Vec<serde_json::Value> = engines_for_format(*fmt)
                .into_iter()
                .map(|e| json!({ "name": e, "supported": supported(e) }))
                .collect();
            json!({
                "format": fmt.as_str(),
                "supported": format_supported_on_node(*fmt, supported),
                "engines": engines,
            })
        })
        .collect();

    Json(json!({
        "formats": formats,
        "resident": state.manager.active_local_engine().await,
    }))
}

/// `GET /api/system/info` — live CPU/RAM/disk/GPU snapshot for this node.
#[utoipa::path(
    get,
    path = "/api/system/info",
    tag = "Health",
    summary = "Live CPU/RAM/disk/GPU snapshot for this node",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn system_info_handler() -> Json<serde_json::Value> {
    // Detection spawns subprocesses (nvidia-smi) and enumerates disks, so keep it
    // off the async worker thread.
    match tokio::task::spawn_blocking(crate::system_info::SystemInfo::detect).await {
        Ok(info) => Json(serde_json::to_value(info).unwrap_or_default()),
        Err(_) => Json(serde_json::json!({})),
    }
}

// ── CatalogSource seam (#459) ────────────────────────────────────────────────
//
// One adapter every catalog (model/skill/mcp/plugin) routes through. These
// endpoints list the sources per kind, add a user custom source, and persist
// the active selection. See `crate::catalog_source`.

/// Parse `?kind=` into a [`CatalogKind`], 400 on missing/unknown.
fn parse_catalog_kind(s: Option<&str>) -> Result<crate::catalog_source::CatalogKind, StatusCode> {
    s.and_then(|v| v.parse().ok())
        .ok_or(StatusCode::BAD_REQUEST)
}

/// `GET /api/catalog/sources?kind=<model|skill|mcp|plugin>`
/// → `{ kind, active, sources: [{ id, display_name, builtin, base_url? }] }`
#[utoipa::path(
    get,
    path = "/api/catalog/sources",
    tag = "Catalog",
    summary = "List catalog sources for a kind + the active one",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn catalog_sources_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let kind = match parse_catalog_kind(params.get("kind").map(String::as_str)) {
        Ok(k) => k,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({ "error": "missing or unknown `kind` (model|skill|mcp|plugin|knowledge)" }),
                ),
            );
        }
    };
    let sources = state.catalog_sources.sources_for(kind);
    let active = state
        .catalog_sources
        .active_id(kind, &state.preferences)
        .await;
    (
        StatusCode::OK,
        Json(json!({
            "kind": kind.as_str(),
            "active": active,
            "sources": sources,
        })),
    )
}

#[derive(serde::Deserialize)]
struct AddCatalogSourceBody {
    kind: crate::catalog_source::CatalogKind,
    id: String,
    display_name: String,
    #[serde(default)]
    base_url: Option<String>,
}

/// SSRF guard for a user-supplied custom catalog-source `base_url`. A custom
/// model source's base URL is interpolated into outbound fetch URLs and driven
/// by the shared client, so an unvalidated value is an SSRF / cloud-metadata
/// read primitive. Mirrors the [`install_app_from_url`] guard: require
/// `https://`, reject `localhost`, resolve the host (catching DNS names that
/// point inward), and reject if any resolved IP is loopback / private /
/// link-local / ULA / CGNAT. Residual: this validates at add-time; a full
/// defense against DNS-rebinding would also pin the model fetch client to the
/// validated IPs (tracked as a follow-up; the model fetch path re-resolves).
async fn validate_remote_base_url(raw: &str) -> Result<(), String> {
    let url = raw.trim();
    if !url.starts_with("https://") {
        return Err("base_url must start with https://".to_owned());
    }
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid base_url: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "base_url has no host".to_owned())?
        .to_owned();
    if host.eq_ignore_ascii_case("localhost") {
        return Err("private/loopback base_url is not allowed".to_owned());
    }
    screen_guarded_hostname(&host)?;
    let port = parsed.port_or_known_default().unwrap_or(443);
    let resolve_host = host.clone();
    let resolved: Vec<std::net::SocketAddr> = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (resolve_host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect::<Vec<_>>())
    })
    .await
    .map_err(|e| format!("DNS resolution task failed: {e}"))?
    .map_err(|e| format!("failed to resolve base_url host: {e}"))?;
    if resolved.is_empty() {
        return Err("base_url host did not resolve".to_owned());
    }
    if resolved.iter().any(|addr| is_blocked_ip(addr.ip())) {
        return Err("private/loopback base_url is not allowed".to_owned());
    }
    Ok(())
}

/// Resolve + SSRF-validate a host, returning the validated socket addresses.
///
/// Shared by the catalog fetch paths (model-index + marketplace) and the
/// `git@`/`ssh://` clone guard. Requires `https`/`http` per the caller's own
/// scheme check (this only resolves + screens IPs): rejects `localhost`, hosts
/// that fail to resolve, and any host whose resolved IPs include a
/// loopback / private / link-local / ULA / CGNAT address. Catches DNS names
/// that point at internal addresses, not just literal IPs.
pub(crate) async fn resolve_guarded_host(
    host: &str,
    port: u16,
) -> Result<Vec<std::net::SocketAddr>, String> {
    if host.eq_ignore_ascii_case("localhost") {
        return Err("private/loopback host is not allowed".to_owned());
    }
    screen_guarded_hostname(host)?;
    let resolve_host = host.to_string();
    let resolved: Vec<std::net::SocketAddr> = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (resolve_host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect::<Vec<_>>())
    })
    .await
    .map_err(|e| format!("DNS resolution task failed: {e}"))?
    .map_err(|e| format!("failed to resolve host: {e}"))?;
    if resolved.is_empty() {
        return Err("host did not resolve".to_owned());
    }
    if resolved.iter().any(|addr| is_blocked_ip(addr.ip())) {
        return Err("private/loopback host is not allowed".to_owned());
    }
    Ok(resolved)
}

// ── Agent tool-egress SSRF screen ────────────────────────────────────────────
//
// The first-party guarded_get chain protects Core's own catalog/model/skill
// fetches. Agent browsing tools (the built-in Spider crawl tool) shell out to an
// external binary and would otherwise crawl arbitrary URLs with no Core-side IP
// screening, so http://169.254.169.254/ (cloud metadata) or http://10.0.0.1/
// (RFC1918) would be reachable. `screen_agent_egress_url` is the shared
// pre-dispatch screen for that egress path: it accepts http and https (Spider
// crawls both), reuses the same resolve + is_blocked_ip guard as the first-party
// path, and is default-on with a host-allowlist escape hatch.

/// Env var toggling the agent tool-egress SSRF screen. Default-on: absent or any
/// non-disable value keeps the screen active. Set to `0`/`false`/`off`/`no`
/// (case-insensitive) to disable.
const ENV_AGENT_EGRESS_SSRF_GUARD: &str = "RYU_AGENT_EGRESS_SSRF_GUARD";
/// Env var holding a comma-separated host allowlist that bypasses the egress
/// screen (case-insensitive, whitespace-trimmed, empty entries ignored).
const ENV_AGENT_EGRESS_ALLOW_HOSTS: &str = "RYU_AGENT_EGRESS_ALLOW_HOSTS";

/// Pure: is the egress guard enabled for this env value? Default-on — only an
/// explicit disable token (`0`/`false`/`off`/`no`, case-insensitive, trimmed)
/// turns it off. Mirrors [`parse_auto_recall_enabled`] so the behavior is
/// unit-testable without mutating process env.
fn agent_egress_guard_enabled_from(val: Option<&str>) -> bool {
    match val {
        Some(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        ),
        None => true,
    }
}

/// Pure: is `host` present in the comma-separated allowlist `list`? Case- and
/// whitespace-insensitive; empty entries are ignored. Unit-testable without env.
fn host_is_allowlisted_in(host: &str, list: Option<&str>) -> bool {
    let Some(list) = list else {
        return false;
    };
    list.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .any(|entry| entry.eq_ignore_ascii_case(host))
}

/// Runtime wrapper: read [`ENV_AGENT_EGRESS_SSRF_GUARD`] and classify.
fn agent_egress_guard_enabled() -> bool {
    agent_egress_guard_enabled_from(std::env::var(ENV_AGENT_EGRESS_SSRF_GUARD).ok().as_deref())
}

/// Runtime wrapper: is `host` in [`ENV_AGENT_EGRESS_ALLOW_HOSTS`]?
fn host_is_allowlisted(host: &str) -> bool {
    host_is_allowlisted_in(
        host,
        std::env::var(ENV_AGENT_EGRESS_ALLOW_HOSTS).ok().as_deref(),
    )
}

/// SSRF egress screen for agent browsing tools that fetch arbitrary URLs.
///
/// Parses `url`, requires an `http`/`https` scheme (rejecting `file://`,
/// `ldap://`, etc.), and — unless the guard is disabled or the host is
/// allowlisted — resolves the host and rejects it if any resolved IP is
/// loopback / RFC1918 private / link-local (incl. 169.254.169.254 metadata) /
/// ULA / CGNAT, reusing [`resolve_guarded_host`]. Returns the parsed URL so the
/// caller can dispatch it.
///
/// Residual (DNS-rebinding TOCTOU): a shell-out crawler re-resolves the host
/// itself, so Core cannot IP-pin the connection (unlike [`guarded_get`]). This
/// pre-dispatch screen narrows but cannot fully close the window between Core's
/// resolve and the crawler's resolve. Best achievable for a shell-out crawler;
/// closing it fully requires fetching in-process.
pub(crate) async fn screen_agent_egress_url(url: &str) -> anyhow::Result<url::Url> {
    let trimmed = url.trim();
    let parsed =
        url::Url::parse(trimmed).map_err(|e| anyhow::anyhow!("invalid URL '{trimmed}': {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        anyhow::bail!(
            "URL scheme '{}' is not allowed — only http and https are accepted",
            parsed.scheme()
        );
    }
    if !agent_egress_guard_enabled() {
        return Ok(parsed);
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL has no host: {trimmed}"))?
        .to_owned();
    if host_is_allowlisted(&host) {
        return Ok(parsed);
    }
    let default_port = if parsed.scheme() == "https" { 443 } else { 80 };
    let port = parsed.port_or_known_default().unwrap_or(default_port);
    resolve_guarded_host(&host, port)
        .await
        .map_err(|e| anyhow::anyhow!("blocked egress to {host}: {e}"))?;
    Ok(parsed)
}

/// SSRF-guarded HTTPS GET, shared by the catalog fetch paths so they all get the
/// same protection as [`install_app_from_url`]: https-only, resolve + screen IPs,
/// pin the client to the validated IPs (no re-resolution, defeating DNS
/// rebinding), and disable redirects (a remote cannot bounce us inward after the
/// check). Returns the response on success.
pub(crate) async fn guarded_get(url: &str) -> anyhow::Result<reqwest::Response> {
    guarded_get_with_bearer(url, None).await
}

/// SSRF-guarded HTTPS GET that optionally attaches an `Authorization: Bearer
/// <token>` header. Shares the exact resolve/screen/pin/redirect-none/https-only
/// guard with [`guarded_get`] so a BYOK credential (e.g. a Smithery registry API
/// key, #465) can never bypass the SSRF protections by being sent through a
/// plain client. The bearer is host-scoped by the *caller* (the credential must
/// only ever be attached to its own fixed host), so this helper simply attaches
/// whatever non-empty token it is given.
pub(crate) async fn guarded_get_with_bearer(
    url: &str,
    bearer: Option<&str>,
) -> anyhow::Result<reqwest::Response> {
    let trimmed = url.trim();
    let parsed =
        url::Url::parse(trimmed).map_err(|e| anyhow::anyhow!("invalid URL {trimmed}: {e}"))?;
    if parsed.scheme() != "https" {
        anyhow::bail!("remote catalog URL must use https: {trimmed}");
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL has no host: {trimmed}"))?
        .to_owned();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let resolved = resolve_guarded_host(&host, port)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &resolved)
        .build()
        .map_err(|e| anyhow::anyhow!("failed to build HTTP client: {e}"))?;
    let mut req = client
        .get(trimmed)
        .header("User-Agent", crate::skills_catalog::USER_AGENT);
    if let Some(token) = bearer.map(str::trim).filter(|t| !t.is_empty()) {
        req = req.bearer_auth(token);
    }
    req.send()
        .await
        .map_err(|e| anyhow::anyhow!("requesting {trimmed}: {e}"))
}

/// Max bytes read from an untrusted catalog/registry JSON response. These hosts
/// (official MCP registry, Smithery, model-index, marketplace, Ryu index) are
/// treated as untrusted, so a compromised/hostile one must not be able to OOM
/// Core with a multi-GB body. JSON catalog payloads are kilobytes; 32 MB is ample.
pub(crate) const MAX_CATALOG_BODY_BYTES: u64 = 32 * 1024 * 1024;

/// SSRF-guarded GET that also asserts a success status and bounds the response
/// body to [`MAX_CATALOG_BODY_BYTES`] (streamed, so a lying `Content-Length`
/// can't bypass it). Returns the body bytes. Use for every untrusted catalog
/// fetch instead of `guarded_get(..).bytes()`.
pub(crate) async fn guarded_get_bytes(url: &str) -> anyhow::Result<Vec<u8>> {
    read_capped_body(guarded_get(url).await?, url).await
}

/// Bearer-bearing variant of [`guarded_get_bytes`] (e.g. Smithery BYOK key).
pub(crate) async fn guarded_get_bytes_with_bearer(
    url: &str,
    bearer: Option<&str>,
) -> anyhow::Result<Vec<u8>> {
    read_capped_body(guarded_get_with_bearer(url, bearer).await?, url).await
}

/// Max bytes read from a `web_fetch` page body. A logged-in dashboard page is
/// typically tens to hundreds of KB; 5 MB bounds memory against a hostile/large
/// response. Read streamed, so a lying `Content-Length` can't bypass it; the body
/// is truncated at the cap rather than erroring (a partial page is still useful).
pub(crate) const MAX_WEB_FETCH_BODY_BYTES: u64 = 5 * 1024 * 1024;

/// SSRF-guarded HTTPS GET that attaches caller-supplied request headers and
/// returns the response status plus body text (UTF-8 lossy, capped).
///
/// This is the [`web_fetch`](crate::sidecar::mcp::web_fetch) tool's egress path:
/// the headers carry a user's Identity Vault session (e.g. a `Cookie`), spliced in
/// here so the request is made AS the user. It shares the exact
/// resolve/screen/pin/redirect-none/https-only guard as
/// [`guarded_get_with_bearer`], so an injected credential can never bypass the
/// SSRF protections. Invalid header names/values are skipped (never sent), and a
/// non-2xx status is returned (not an error) so an expired-cookie 302/401 is
/// observable rather than fatal. **Header values are never logged.**
pub(crate) async fn guarded_fetch_text_with_headers(
    url: &str,
    headers: &[(String, String)],
) -> anyhow::Result<(u16, String)> {
    let trimmed = url.trim();
    let parsed =
        url::Url::parse(trimmed).map_err(|e| anyhow::anyhow!("invalid URL {trimmed}: {e}"))?;
    if parsed.scheme() != "https" {
        anyhow::bail!("web_fetch URL must use https: {trimmed}");
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL has no host: {trimmed}"))?
        .to_owned();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let resolved = resolve_guarded_host(&host, port)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &resolved)
        .build()
        .map_err(|e| anyhow::anyhow!("failed to build HTTP client: {e}"))?;
    let mut req = client
        .get(trimmed)
        .header("User-Agent", crate::skills_catalog::USER_AGENT);
    for (name, value) in headers {
        match (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            (Ok(n), Ok(v)) => req = req.header(n, v),
            // Skip a malformed header name (value omitted from the log on purpose).
            _ => tracing::warn!("web_fetch: skipping invalid injected header name '{name}'"),
        }
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("requesting {trimmed}: {e}"))?;
    let status = resp.status().as_u16();
    // Stream the body with a hard cap; truncate at the cap rather than erroring.
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| anyhow::anyhow!("reading {trimmed}: {e}"))?
    {
        if buf.len() as u64 + chunk.len() as u64 > MAX_WEB_FETCH_BODY_BYTES {
            let remaining = (MAX_WEB_FETCH_BODY_BYTES as usize).saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    Ok((status, String::from_utf8_lossy(&buf).into_owned()))
}

async fn read_capped_body(mut resp: reqwest::Response, url: &str) -> anyhow::Result<Vec<u8>> {
    if !resp.status().is_success() {
        anyhow::bail!("{url} returned HTTP {}", resp.status());
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_CATALOG_BODY_BYTES {
            anyhow::bail!("{url} response too large ({len} bytes; cap {MAX_CATALOG_BODY_BYTES})");
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| anyhow::anyhow!("reading {url}: {e}"))?
    {
        if buf.len() as u64 + chunk.len() as u64 > MAX_CATALOG_BODY_BYTES {
            anyhow::bail!("{url} exceeded the {MAX_CATALOG_BODY_BYTES}-byte body cap");
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// `POST /api/catalog/sources { kind, id, display_name, base_url? }`
/// Adds a custom source, persists it to the JSON file, returns ok.
#[utoipa::path(
    post,
    path = "/api/catalog/sources",
    tag = "Catalog",
    summary = "Add a custom catalog source",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn catalog_sources_add(
    State(state): State<ServerState>,
    Json(body): Json<AddCatalogSourceBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if body.id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "`id` must not be empty" })),
        );
    }
    // A custom source's base_url becomes an outbound fetch target — validate it
    // against the SSRF guard before persisting (authenticated, but still a
    // metadata/internal-host read primitive otherwise).
    if let Some(ref base) = body.base_url {
        if !base.trim().is_empty() {
            if let Err(e) = validate_remote_base_url(base).await {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "ok": false, "error": e })),
                );
            }
        }
    }
    let spec = crate::catalog_source::CustomSourceSpec {
        kind: body.kind,
        id: body.id,
        display_name: body.display_name,
        base_url: body.base_url,
    };
    match state.catalog_sources.add_custom(spec) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
struct SelectCatalogSourceBody {
    kind: crate::catalog_source::CatalogKind,
    id: String,
}

/// `POST /api/catalog/sources/select { kind, id }`
/// Sets + persists the active source for a kind. Rejects an unknown id.
#[utoipa::path(
    post,
    path = "/api/catalog/sources/select",
    tag = "Catalog",
    summary = "Select the active source for a kind",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn catalog_sources_select(
    State(state): State<ServerState>,
    Json(body): Json<SelectCatalogSourceBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state
        .catalog_sources
        .set_active(body.kind, &body.id, &state.preferences)
        .await
    {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        ),
    }
}

// ── Knowledge catalog (browse + install OKF bundles) ─────────────────────────
//
// Source-aware like the model/skill/mcp catalogs: the active Knowledge source
// (the Ryu Marketplace federated source by default, or a custom OKF git bundle)
// owns search/detail. Install is the privileged path: clone/parse the bundle via
// the `okf` module, then index it through the retrieval layer
// (`ingest_okf_bundle`). The seam returns descriptors only; the download/ingest
// happens here in Core.

/// The active Knowledge catalog [`Source`] (defaults to the built-in primary).
async fn active_knowledge_source(state: &ServerState) -> Option<crate::catalog_source::Source> {
    state
        .catalog_sources
        .get_active(
            crate::catalog_source::CatalogKind::Knowledge,
            &state.preferences,
        )
        .await
}

/// Load an OKF bundle from a descriptor's `source_url`: a local directory via
/// [`crate::okf::Bundle::from_dir`] (off-thread, sync), else a git clone via
/// [`crate::okf::Bundle::from_git`]. Mirrors `OkfBundleSource::load_bundle` for
/// the install path, which works off the resolved descriptor rather than the
/// source struct (a marketplace source carries the same `{ source_url, ref? }`).
async fn load_okf_bundle(
    source_url: &str,
    git_ref: Option<&str>,
) -> anyhow::Result<crate::okf::Bundle> {
    let url = source_url.trim().to_string();
    let path = std::path::Path::new(&url);
    if path.is_dir() {
        let p = path.to_path_buf();
        tokio::task::spawn_blocking(move || crate::okf::Bundle::from_dir(p))
            .await
            .map_err(|e| anyhow::anyhow!("loading OKF bundle task panicked: {e}"))?
    } else {
        crate::okf::Bundle::from_git(&url, git_ref).await
    }
}

/// `GET /api/knowledge/catalog?query=&limit=&cursor=` — browse the active
/// Knowledge source's concepts. Mirrors the model/skill/mcp list handlers.
#[utoipa::path(
    get,
    path = "/api/knowledge/catalog",
    tag = "Knowledge",
    summary = "Browse the knowledge (OKF) catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn knowledge_catalog_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let query = params.get("query").map(String::as_str).unwrap_or("");
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(40);
    let cursor = params
        .get("cursor")
        .map(String::as_str)
        .filter(|s| !s.is_empty());
    let q = crate::catalog_source::CatalogQuery {
        query: query.to_string(),
        limit,
        cursor: cursor.map(str::to_string),
        ..Default::default()
    };
    match active_knowledge_source(&state).await {
        Some(source) => match source.search(&state.client, &q).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e.to_string(), "concepts": [] })),
            ),
        },
        None => (
            StatusCode::OK,
            Json(json!({ "concepts": [], "next_cursor": serde_json::Value::Null })),
        ),
    }
}

/// `GET /api/knowledge/catalog/detail?id=<concept-path>` — one concept's parsed
/// frontmatter + body, so a client can preview it before installing the bundle.
#[utoipa::path(
    get,
    path = "/api/knowledge/catalog/detail",
    tag = "Knowledge",
    summary = "Knowledge concept detail",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn knowledge_catalog_detail(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `id` query parameter" })),
        );
    };
    match active_knowledge_source(&state).await {
        Some(source) => match source.detail(&state.client, id).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e.to_string() })),
            ),
        },
        None => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "no active knowledge source" })),
        ),
    }
}

#[derive(serde::Deserialize)]
struct KnowledgeCatalogInstallBody {
    /// The bundle/source id to install. Optional for a single-bundle OKF source
    /// (it installs its configured bundle); a marketplace source uses it to pick
    /// the catalog item.
    #[serde(default)]
    id: String,
}

/// `POST /api/knowledge/catalog/install { id }` — the privileged install path:
/// resolve the active source's descriptor (`{ source_url, ref?, bundle_id }`),
/// clone/parse the OKF bundle via the `okf` module, and index it into the
/// retrieval layer via [`RetrievalStore::ingest_okf_bundle`]. Returns the ingest
/// summary (concepts + chunks). Source returns a descriptor only; Core downloads.
#[utoipa::path(
    post,
    path = "/api/knowledge/catalog/install",
    tag = "Knowledge",
    summary = "Install (clone + ingest) a knowledge bundle from the catalog",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn knowledge_catalog_install(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<KnowledgeCatalogInstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let id = body.id.trim().to_string();
    // Forward the caller's bearer to the marketplace install handoff (#491) so a
    // PAID Ryu-Marketplace bundle is denied unless the buyer org holds a license.
    let buyer_token = buyer_bearer_from_headers(&headers);

    let Some(source) = active_knowledge_source(&state).await else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "success": false, "error": "no active knowledge source" })),
        );
    };

    // Resolve the descriptor (never downloads). The raw payload carries the OKF
    // bundle git source the install path needs.
    let descriptor = match crate::catalog_source::with_buyer_token(
        buyer_token,
        source.install_descriptor(&state.client, &id),
    )
    .await
    {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
    };

    // Extract the bundle source from the descriptor's opaque `raw` payload.
    let raw = &descriptor.raw;
    let source_url = raw
        .get("source_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        // Fall back to the descriptor repo_id (OkfBundleSource sets it to the URL).
        .unwrap_or(descriptor.repo_id.as_str())
        .to_string();
    if source_url.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "error": "knowledge descriptor has no `source_url` to ingest",
            })),
        );
    }
    let git_ref = raw
        .get("ref")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    // The bundle id the concepts are indexed under (idempotent re-ingest key):
    // the descriptor's `bundle_id` when present, else the source id, else the URL.
    let bundle_id = raw
        .get("bundle_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if descriptor.source_id.trim().is_empty() {
                source_url.clone()
            } else {
                descriptor.source_id.clone()
            }
        });

    // Clone + parse the bundle (the download), then index it.
    let bundle = match load_okf_bundle(&source_url, git_ref.as_deref()).await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
    };
    let warnings = bundle.warnings.clone();
    match state.retrieval.ingest_okf_bundle(&bundle_id, &bundle).await {
        Ok(summary) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "bundle_id": summary.bundle_id,
                "concepts": summary.concepts,
                "chunks": summary.chunks,
                "warnings": warnings,
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
struct OkfExportBody {
    /// Filesystem directory the bundle is written to (created if absent).
    target_dir: String,
    /// What to export. Only `"bundle"` (the default) is implemented today;
    /// `"memory"` is reserved for a future broader memory export.
    #[serde(default)]
    scope: Option<String>,
    /// For scope `"bundle"`: the ingested bundle id to re-emit.
    #[serde(default)]
    bundle_id: Option<String>,
}

/// Assemble an exportable [`crate::okf::Bundle`] from reconstructed concepts,
/// generating a progressive-disclosure `index.md` and a dated `log.md`.
fn build_okf_export_bundle(
    bundle_id: &str,
    concepts: Vec<crate::okf::Concept>,
) -> crate::okf::Bundle {
    use crate::okf::{Bundle, IndexDoc, LogDoc, LogEntry, OKF_VERSION};

    // index.md: one bullet per concept, bundle-absolute link + type + description.
    let mut index_body = String::from("# Concepts\n\n");
    for c in &concepts {
        let title = c.title.clone().unwrap_or_else(|| c.file_path.clone());
        let desc = c
            .description
            .as_deref()
            .map(|d| format!(" — {d}"))
            .unwrap_or_default();
        index_body.push_str(&format!(
            "- [{title}](/{path}) `{kind}`{desc}\n",
            path = c.file_path,
            kind = c.type_,
        ));
    }
    let index = IndexDoc {
        okf_version: Some(OKF_VERSION.to_owned()),
        title: Some(format!("{bundle_id} (exported)")),
        description: Some(format!(
            "OKF bundle exported from Ryu Core, reconstructed from the retrieval index for bundle `{bundle_id}`."
        )),
        extra: std::collections::BTreeMap::new(),
        body: index_body,
    };

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let entry = format!(
        "Exported {n} concept(s) from Ryu Core (bundle `{bundle_id}`).",
        n = concepts.len(),
    );
    let log = LogDoc {
        entries: vec![LogEntry {
            date: today.clone(),
            content: entry.clone(),
        }],
        body: format!("# Changelog\n\n## {today}\n\n{entry}\n"),
    };

    Bundle {
        root: std::path::PathBuf::new(),
        concepts,
        index: Some(index),
        log: Some(log),
        okf_version: Some(OKF_VERSION.to_owned()),
        warnings: Vec::new(),
    }
}

/// `POST /api/okf/export { target_dir, scope?, bundle_id? }` — emit Ryu's own
/// indexed knowledge as an OKF bundle on disk.
///
/// The concrete path is scope `"bundle"`: reconstruct the concepts previously
/// ingested under `bundle_id` from the retrieval index (via
/// [`RetrievalStore::reconstruct_okf_concepts`]), map each to an [`crate::okf::Concept`],
/// generate `index.md` + `log.md`, and write the bundle to `target_dir`. Broader
/// memory export is a follow-up.
#[utoipa::path(
    post,
    path = "/api/okf/export",
    tag = "Knowledge",
    summary = "Export indexed knowledge as an OKF bundle directory",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn okf_export(
    State(state): State<ServerState>,
    Json(body): Json<OkfExportBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let target_dir = body.target_dir.trim().to_string();
    if target_dir.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "`target_dir` is required" })),
        );
    }

    let scope = body.scope.as_deref().map(str::trim).unwrap_or("bundle");
    if scope != "bundle" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "error": format!("unsupported scope '{scope}'; only 'bundle' is implemented (broader memory export is a follow-up)"),
            })),
        );
    }

    let Some(bundle_id) = body
        .bundle_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "success": false, "error": "`bundle_id` is required for scope 'bundle'" }),
            ),
        );
    };

    let concepts = match state.retrieval.reconstruct_okf_concepts(bundle_id).await {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
    };
    if concepts.is_empty() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "success": false,
                "error": format!("no indexed knowledge found for bundle '{bundle_id}'"),
            })),
        );
    }

    let bundle = build_okf_export_bundle(bundle_id, concepts);
    let files: Vec<String> = bundle
        .concepts
        .iter()
        .map(|c| c.file_path.clone())
        .collect();
    let concept_count = bundle.concepts.len();

    let dir = std::path::PathBuf::from(&target_dir);
    let write = {
        let bundle = bundle.clone();
        tokio::task::spawn_blocking(move || bundle.write(&dir)).await
    };
    match write {
        Ok(Ok(())) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "target_dir": target_dir,
                "bundle_id": bundle_id,
                "concepts": concept_count,
                "files": files,
                "index": crate::okf::RESERVED_INDEX,
                "log": crate::okf::RESERVED_LOG,
            })),
        ),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": format!("export task panicked: {e}") })),
        ),
    }
}

// ── Skills catalog (browse + install from skills.sh, all logic in Core) ──────
//
// The desktop/mobile/extension are pure GUI layers over these endpoints. Uses
// the public, no-key skills.sh endpoints. See `crate::skills_catalog`.

/// Resolve the active Skill catalog [`Source`]. Defaults to the built-in
/// skills.sh source when nothing resolves.
async fn active_skill_source(state: &ServerState) -> Option<crate::catalog_source::Source> {
    state
        .catalog_sources
        .get_active(
            crate::catalog_source::CatalogKind::Skill,
            &state.preferences,
        )
        .await
}

/// `GET /api/skills/catalog?query=&limit=&installed_only=`
///
/// Source-aware (#463): the active Skill source (skills.sh by default, or a
/// custom Claude plugin marketplace) owns search. The installed-only view is
/// always source-agnostic (it scans the on-disk skills dir), so it uses the
/// skills.sh helper which reads local state.
#[utoipa::path(
    get,
    path = "/api/skills/catalog",
    tag = "Skills",
    summary = "Browse the skills catalog (skills.sh)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn skills_catalog_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let query = params.get("query").map(String::as_str).unwrap_or("");
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(40);
    let installed_only = params
        .get("installed_only")
        .map(|s| s == "true" || s == "1")
        .unwrap_or(false);

    // Marketplace sources have no concept of a local installed-only view, so the
    // installed query always uses the skills.sh helper (it reads the on-disk dir).
    if !installed_only {
        if let Some(source) = active_skill_source(&state).await {
            if !matches!(source, crate::catalog_source::Source::SkillsSh(_)) {
                let mut q = crate::catalog_source::CatalogQuery {
                    query: query.to_string(),
                    limit,
                    ..Default::default()
                };
                q.extra.insert(
                    "installed_only".to_string(),
                    serde_json::Value::String(installed_only.to_string()),
                );
                return match source.search(&state.client, &q).await {
                    Ok(value) => (StatusCode::OK, Json(value)),
                    Err(e) => (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({ "error": e.to_string(), "skills": [] })),
                    ),
                };
            }
        }
    }

    match crate::skills_catalog::search_skills(&state.client, query, limit, installed_only).await {
        Ok(skills) => (StatusCode::OK, Json(json!({ "skills": skills }))),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "skills": [] })),
        ),
    }
}

/// `GET /api/skills/catalog/detail?id=owner%2Frepo%2Fslug`
#[utoipa::path(
    get,
    path = "/api/skills/catalog/detail",
    tag = "Skills",
    summary = "Skill detail: SKILL.md + file list",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn skills_catalog_detail(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `id` query parameter" })),
        );
    };
    // Source-aware (#463): a marketplace source resolves detail from its manifest.
    if let Some(source) = active_skill_source(&state).await {
        if !matches!(source, crate::catalog_source::Source::SkillsSh(_)) {
            return match source.detail(&state.client, id).await {
                Ok(value) => (StatusCode::OK, Json(value)),
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": e.to_string() })),
                ),
            };
        }
    }
    match crate::skills_catalog::skill_detail(&state.client, id).await {
        Ok(detail) => (
            StatusCode::OK,
            Json(serde_json::to_value(detail).unwrap_or_default()),
        ),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
struct SkillInstallBody {
    id: String,
}

/// `POST /api/skills/catalog/install { id }` — installs into the universal
/// `~/.claude/skills/<slug>/SKILL.md` and reloads the live skill registry so the
/// Skill is usable immediately (and visible to Claude Code / the skills CLI).
///
/// Source-aware (#463): skills.sh installs via the `owner/repo/slug` download
/// path; a custom Claude marketplace source resolves the chosen item to its
/// repo+subdir and installs through Unit #462's from-source fetcher. Either way
/// the registry hot-reloads.
#[utoipa::path(
    post,
    path = "/api/skills/catalog/install",
    tag = "Skills",
    summary = "Install a skill from the catalog",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn skills_catalog_install(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SkillInstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Forward the caller's bearer to the marketplace install handoff (#491) so a
    // PAID Ryu-Marketplace skill is denied unless the buyer org holds a license.
    let buyer_token = buyer_bearer_from_headers(&headers);
    // Skills install fetches a JSON envelope of inline files (no single
    // streaming URL→dest), so it tracks as an INDETERMINATE task in the global
    // download center (#456): it shows in the overlay as active→done/failed and
    // is cancelable, without byte progress.
    let id = body.id.clone();
    let label = format!("Skill: {id}");
    let installed = state
        .downloads
        .register_indeterminate(
            format!("skill:{id}"),
            crate::downloads::DownloadKind::Skill,
            label,
            crate::catalog_source::with_buyer_token(buyer_token, async {
                // Dispatch through the active source's skill-install path. A
                // non-skill source returns Ok(None), so fall back to the
                // skills.sh helper for the built-in source.
                let installed = match active_skill_source(&state).await {
                    Some(source) => source.install_skill(&state.client, &id).await,
                    None => crate::skills_catalog::install_skill(&state.client, &id)
                        .await
                        .map(Some),
                };
                match installed {
                    Ok(Some(result)) => Ok(result),
                    Ok(None) => crate::skills_catalog::install_skill(&state.client, &id).await,
                    Err(e) => Err(e),
                }
            }),
        )
        .await;
    match installed {
        Ok(result) => {
            // Hot-reload the registry so the new Skill is selectable without a restart.
            state.skills.reload();
            (
                StatusCode::OK,
                Json(
                    json!({ "success": true, "result": serde_json::to_value(result).unwrap_or_default() }),
                ),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
struct SkillInstallFromSourceBody {
    /// One of the six supported source forms: `owner/repo`, a github/gitlab URL,
    /// a github `/tree/<ref>/<subdir>` URL, a `git@` SSH url, or a local path.
    source: String,
}

/// `POST /api/skills/install-from-source { source }` — resolve a source reference
/// (issue #462), fetch it (tarball first, `git clone --depth 1` fallback), copy the
/// **entire** skill directory into `~/.claude/skills/<name>/`, mark it active, and
/// hot-reload the registry so it's usable immediately.
#[utoipa::path(
    post,
    path = "/api/skills/install-from-source",
    tag = "Skills",
    summary = "Install a skill directly from a source spec",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn skills_install_from_source(
    State(state): State<ServerState>,
    Json(body): Json<SkillInstallFromSourceBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if body.source.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "`source` must not be empty" })),
        );
    }
    match crate::skills_catalog::from_source::install_from_source(&state.client, &body.source).await
    {
        Ok(result) => {
            state.skills.reload();
            (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "id": result.slug,
                    "result": serde_json::to_value(result).unwrap_or_default(),
                })),
            )
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
struct SkillActivateBody {
    /// Skill id (the directory name / slug).
    id: String,
    /// `true` to inject this skill on the default chat route, `false` to stop.
    active: bool,
}

/// `POST /api/skills/activate { id, active }` — toggle whether a skill's
/// instructions inject on the openai_compat default route. Installed-but-inactive
/// is the default for skills discovered in the shared dir (so dozens of them don't
/// flood a local model's context); this lets the user opt one in or out. Reloads
/// the registry so the change takes effect immediately.
#[utoipa::path(
    post,
    path = "/api/skills/activate",
    tag = "Skills",
    summary = "Toggle a skill active (injection gate)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn skills_activate(
    State(state): State<ServerState>,
    Json(body): Json<SkillActivateBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    crate::skills::set_active(&body.id, body.active);
    state.skills.reload();
    (
        StatusCode::OK,
        Json(json!({ "success": true, "id": body.id, "active": body.active })),
    )
}

#[utoipa::path(
    post,
    path = "/api/node/init",
    tag = "Nodes",
    summary = "Initialize or fetch this node's token",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn node_init() -> (StatusCode, Json<serde_json::Value>) {
    use std::io::Write;

    let token_path = crate::paths::ryu_dir().join("core.token");

    if let Some(parent) = token_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
        // Restrict ~/.ryu to owner-only so tokens/keys stored inside are not
        // world-readable on multi-user systems.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }

    let token = format!("ryu_{}", uuid::Uuid::new_v4().simple());

    // Use create_new(true) for an atomic "create-or-fail" open — no TOCTOU race.
    // Set 0o600 so the token file is owner-read/write only.
    let mut open_opts = std::fs::OpenOptions::new();
    open_opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_opts.mode(0o600);
    }
    let result = open_opts
        .open(&token_path)
        .and_then(|mut f| f.write_all(token.as_bytes()));

    match result {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "success": true, "token": token })),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (
            StatusCode::CONFLICT,
            Json(json!({ "success": false, "error": "already_initialized" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    get,
    path = "/api/setup/list",
    tag = "Sidecars",
    summary = "List installed sidecars",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_installed(State(state): State<ServerState>) -> Json<serde_json::Value> {
    use crate::sidecar::download_manager::VersionStore;

    // Merge persistent VersionStore with the in-session SetupManager cache.
    let store = VersionStore::load();
    let mut known: std::collections::HashSet<String> = store.versions.keys().cloned().collect();
    for name in state.setup.list_installed().await {
        known.insert(name);
    }

    // For sidecars that ship a binary into ~/.ryu/bin/, verify it exists on
    // disk so the UI always reflects reality even after manual deletions.
    let installed: Vec<String> = known
        .into_iter()
        .filter(|name| binary_installed_on_disk(name))
        .collect();

    Json(json!({ "installed": installed }))
}

#[utoipa::path(
    post,
    path = "/api/setup/{name}/install",
    tag = "Sidecars",
    summary = "Install a sidecar (SSE progress)",
    params(("name" = String, Path)),
    responses((status = 200, description = "Server-Sent Events stream"))
)]
async fn install_sidecar(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use crate::sidecar::agents::zeroclaw::ZeroClawDownloader;
    use crate::sidecar::providers::llamacpp::LlamaCppDownloader;
    use crate::sidecar::providers::ollama::OllamaDownloader;
    use crate::sidecar::tools::screenpipe::ScreenpipeDownloader;
    use crate::sidecar::tools::spider::SpiderDownloader;

    let setup = Arc::clone(&state.setup);
    let install_status = Arc::clone(&state.install_status);
    // Downloads route through the global center (#456) so installs show in the
    // overlay; same instance the auto-spawn `start()` path uses.
    let downloads = state.downloads.clone();
    let sidecar_name = name.clone();

    // Node-gate platform-locked engines (e.g. MLX = Apple Silicon only). The check
    // is on THIS Core node's OS/arch — authoritative, since the client may be a
    // remote desktop on a different platform. Refuse before marking installing so
    // an unsupported node never shows a phantom install.
    if !crate::catalog::registry::supported_on_node(&sidecar_name) {
        return Json(json!({
            "success": false,
            "error": format!(
                "'{sidecar_name}' is not supported on this node ({}/{})",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        }));
    }

    // Mark as installing
    install_status.set_installing(&sidecar_name).await;

    tokio::spawn(async move {
        let result: anyhow::Result<String> = match sidecar_name.as_str() {
            "llamacpp" => LlamaCppDownloader::new()
                .ensure_installed(&downloads)
                .await
                .map(|_| "installed".to_string()),
            "llamacpp-embed" => {
                // The embeddings engine shares the llama.cpp binary. Installing it
                // only ensures that binary — the embedding *model* (a GGUF) is a
                // model download owned by onboarding (`install_local_stack`), not
                // by the engine catalog, mirroring how the chat model is handled.
                LlamaCppDownloader::new()
                    .ensure_installed(&downloads)
                    .await
                    .map(|_| "installed".to_string())
            }
            // ── Archive-extract downloaders: route the archive through the
            // download center (#456) so the install shows in the overlay. ──
            "ollama" => OllamaDownloader::new()
                .ensure_installed(&downloads)
                .await
                .map(|_| "installed".to_string()),
            "zeroclaw" => ZeroClawDownloader::new()
                .ensure_installed(&downloads)
                .await
                .map(|_| "installed".to_string()),
            "whispercpp" => {
                crate::sidecar::providers::whispercpp::WhisperCppDownloader::new()
                    .ensure_installed(&downloads)
                    .await
            }
            "parakeet" => crate::sidecar::providers::parakeet::ParakeetDownloader::new()
                .ensure_model(&downloads)
                .await
                .map(|_| "installed".to_string()),
            "sdcpp" => {
                crate::sidecar::providers::sdcpp::StableDiffusionDownloader::new()
                    .ensure_installed(&downloads)
                    .await
            }
            "outetts" => {
                crate::sidecar::providers::outetts::OuteTtsDownloader::new()
                    .ensure_installed(&downloads)
                    .await
            }
            // ── Subprocess installers (npm/pip/cargo/shell): no byte progress, so
            // they track as INDETERMINATE tasks in the overlay (#456). ──
            "screenpipe" => downloads
                .register_indeterminate(
                    "tool:screenpipe".to_string(),
                    crate::downloads::DownloadKind::Tool,
                    "Screenpipe".to_string(),
                    async { ScreenpipeDownloader::new().ensure_installed().await },
                )
                .await
                .map(|_| "installed".to_string()),
            "spider" => downloads
                .register_indeterminate(
                    "tool:spider".to_string(),
                    crate::downloads::DownloadKind::Tool,
                    "Spider".to_string(),
                    async { SpiderDownloader::new().ensure_installed().await },
                )
                .await
                .map(|_| "installed".to_string()),
            "openclaw" => downloads
                .register_indeterminate(
                    "agent:openclaw".to_string(),
                    crate::downloads::DownloadKind::Agent,
                    "OpenClaw".to_string(),
                    async { crate::sidecar::agents::openclaw::installer::ensure_installed().await },
                )
                .await
                .map(|_| "installed".to_string()),
            "vllm" => downloads
                .register_indeterminate(
                    "engine:vllm".to_string(),
                    crate::downloads::DownloadKind::Engine,
                    "vLLM".to_string(),
                    async { crate::sidecar::providers::vllm::installer::ensure_installed().await },
                )
                .await
                .map(|_| "installed".to_string()),
            "mlx" => downloads
                .register_indeterminate(
                    "engine:mlx".to_string(),
                    crate::downloads::DownloadKind::Engine,
                    "MLX".to_string(),
                    async { crate::sidecar::providers::mlx::installer::ensure_installed().await },
                )
                .await
                .map(|_| "installed".to_string()),
            "mlx-vlm" => downloads
                .register_indeterminate(
                    "engine:mlx-vlm".to_string(),
                    crate::downloads::DownloadKind::Engine,
                    "MLX-VLM".to_string(),
                    async {
                        crate::sidecar::providers::mlx_vlm::installer::ensure_installed().await
                    },
                )
                .await
                .map(|_| "installed".to_string()),
            "omlx" => downloads
                .register_indeterminate(
                    "engine:omlx".to_string(),
                    crate::downloads::DownloadKind::Engine,
                    "oMLX".to_string(),
                    async { crate::sidecar::providers::omlx::installer::ensure_installed().await },
                )
                .await
                .map(|_| "installed".to_string()),
            // Docker Model Runner is adopt-only: there is nothing to download.
            // "Installing" means verifying DMR is enabled + reachable on :12434,
            // then recording a version-store marker so the engine survives a Core
            // restart (`seed_installed_from_disk` re-detects it). We verify and
            // guide rather than mutate the user's Docker config (the
            // `docker desktop enable model-runner` surface differs across Docker
            // Desktop vs Engine, so auto-running it is the fragile path).
            "docker-model-runner" => {
                use crate::sidecar::providers::docker_model_runner::DockerModelRunnerManager;
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(3))
                    .build()
                    .unwrap_or_default();
                if DockerModelRunnerManager::server_reachable(&client).await {
                    let version = "adopted".to_string();
                    if let Err(e) =
                        crate::sidecar::download_manager::VersionStore::set_version_persisted(
                            "docker-model-runner",
                            &version,
                        )
                    {
                        tracing::warn!("could not persist docker-model-runner marker: {e}");
                    }
                    Ok(version)
                } else {
                    Err(anyhow::anyhow!(
                        "Docker Model Runner is not reachable on 127.0.0.1:12434. Enable it in \
                         Docker Desktop (Settings → AI → Model Runner) with host-side TCP access \
                         on port 12434, or run `docker desktop enable model-runner --tcp 12434`, \
                         then pull a model with `docker model pull ai/<model>` and try again."
                    ))
                }
            }
            other => {
                tracing::warn!("no downloader for sidecar '{}' — skipping", other);
                Ok("skipped".to_string())
            }
        };

        match result {
            Ok(version) => {
                setup.mark_installed(&sidecar_name).await;
                tracing::info!("sidecar '{}' installed successfully", sidecar_name);
                install_status.set_installed(&sidecar_name, version).await;
            }
            Err(e) => {
                tracing::error!("failed to install sidecar '{}': {e:#}", sidecar_name);
                install_status
                    .set_failed(&sidecar_name, format!("{e:#}"))
                    .await;
            }
        }
    });

    Json(json!({
        "success": true,
        "message": format!("Sidecar '{}' installation started in background", name)
    }))
}

#[utoipa::path(
    post,
    path = "/api/setup/{name}/uninstall",
    tag = "Sidecars",
    summary = "Uninstall a sidecar",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn uninstall_sidecar(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    // Clear install status
    state.install_status.clear(&name).await;

    // Use manager to stop and uninstall
    match state.manager.uninstall_sidecar(&name, false).await {
        Ok(()) => {
            // Also clear from setup manager
            state.setup.uninstall(&name).await;
            Json(json!({
                "success": true,
                "message": format!("Sidecar '{}' uninstalled", name)
            }))
        }
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[utoipa::path(
    post,
    path = "/api/setup/{name}/uninstall-with-data",
    tag = "Sidecars",
    summary = "Uninstall a sidecar and its data",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn uninstall_sidecar_with_data(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    // Clear install status
    state.install_status.clear(&name).await;

    // Use manager to stop and uninstall with data
    match state.manager.uninstall_sidecar(&name, true).await {
        Ok(()) => {
            // Also clear from setup manager
            let _ = state.setup.uninstall_with_data(&name).await;
            Json(json!({
                "success": true,
                "message": format!("Sidecar '{}' uninstalled with data", name)
            }))
        }
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[utoipa::path(
    get,
    path = "/api/sidecar/status",
    tag = "Sidecars",
    summary = "Status of all sidecars",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn sidecar_status(State(state): State<ServerState>) -> Json<serde_json::Value> {
    // Serialize `SidecarStatus` directly so the per-engine resource fields
    // (pid/memory_bytes/cpu_percent) ride along; absent fields are skipped by
    // serde, so adopt-mode/serverless engines stay `{name, running}`.
    Json(json!({ "sidecars": state.manager.statuses() }))
}

/// Max redacted trace spans included in a support diagnostic bundle. Bounds the
/// bundle size; spans are content-free (`args_hash` only) by construction.
const SUPPORT_RECENT_SPANS_LIMIT: usize = 50;

/// The canonical observability/privacy pref keys a support bundle reports as
/// "set or not" (KEY presence only, NEVER the value). An allowlist so a value
/// can never leak; mirrors the §6 keys owned by `crate::privacy`.
const SUPPORT_REPORTED_PREF_KEYS: &[&str] = &[
    crate::privacy::PRODUCT_ANALYTICS_ENABLED_PREF_KEY,
    crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY,
    crate::privacy::DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY,
    crate::privacy::DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY,
    crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
    crate::privacy::SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY,
];

/// `GET /api/support-access/diagnostics` — the gated, read-only local diagnostic
/// surface (#546, P5).
///
/// Refuses (403) unless the user has granted the local support channel
/// (`support-access-local-enabled`) AND the hard expiry has not passed — checked
/// live so a grant that expired since startup is also refused (and lazily swept).
/// On grant it returns ONLY the allowlist [`crate::support_access::DiagnosticBundle`]
/// (version, active engine, sidecar liveness, set-pref KEYS, redacted spans) —
/// never prompt/agent content, never credentials/`auth.json`. Every call (grant
/// or refusal) is recorded in the local append-only audit log with the actor
/// (`x-ryu-support-actor` header) stamped.
async fn support_access_diagnostics(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
) -> (StatusCode, Json<serde_json::Value>) {
    let actor = header_str(&headers, "x-ryu-support-actor")
        .unwrap_or_else(|| crate::support_access::UNKNOWN_ACTOR.to_string());

    // Re-check the grant + expiry live, then lazily sweep a stale grant for
    // defense in depth (the startup sweep is the durable guarantee).
    let _ = crate::support_access::sweep_expired(&state.preferences).await;
    let grant = crate::privacy::support_access_local(&state.preferences).await;
    let now = chrono::Utc::now().timestamp_millis();
    if !crate::support_access::is_open(grant, now) {
        let _ = state
            .support_audit
            .append(&actor, "access_refused", Some("grant off or expired"))
            .await;
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "support access is not granted",
                "code": "support_access_off",
            })),
        );
    }

    // Transport gate (#547): the diagnostic bundle may egress ONLY over the
    // opt-in mesh (Tailscale/Headscale). The bundle is *pulled* by a support
    // operator who dials this Core node over the tailnet; we never push it. With
    // the mesh disabled there is no governed private transport, so we refuse
    // (audited) rather than serve it over an arbitrary interface. Reachability
    // over the tailnet plus this enabled-gate is the enforceable proxy for
    // "mesh-only" (peer-IP verification is out of scope under the single-tenant
    // / connections posture; noted as a follow-up).
    if !crate::mesh::is_enabled() {
        let _ = state
            .support_audit
            .append(&actor, "access_refused", Some("mesh disabled"))
            .await;
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "support access requires the mesh (Tailscale) to be enabled so the diagnostic bundle egresses only over the tailnet",
                "code": "support_access_mesh_off",
            })),
        );
    }

    // Gather ONLY the known-safe primitives, then project through the pure
    // allowlist builder (no full-config serialization, no raw args).
    let active_engine = state.manager.active_local_engine().await;
    let sidecars = state
        .manager
        .statuses()
        .into_iter()
        .map(|s| crate::support_access::SidecarLiveness {
            name: s.name,
            running: s.running,
        })
        .collect::<Vec<_>>();

    // Report only WHICH observability prefs are set (key presence), never values.
    let mut preference_keys_set = Vec::new();
    for key in SUPPORT_REPORTED_PREF_KEYS {
        if matches!(state.preferences.get(key).await, Ok(Some(_))) {
            preference_keys_set.push((*key).to_string());
        }
    }

    // Recent redacted spans across the most recent conversations. The trace store
    // is keyed by conversation; reuse the conversation list to gather a bounded,
    // already-content-free window. Spans carry `args_hash` only — never raw args.
    let recent_spans = collect_recent_redacted_spans(&state).await;

    let bundle = crate::support_access::build_bundle(
        env!("CARGO_PKG_VERSION"),
        active_engine,
        sidecars,
        preference_keys_set,
        recent_spans,
        now,
    );

    // Gateway DLP pass (#547): even an allowlist bundle has one free-text field
    // (a capped span `error`) that could echo a secret or PII. Per the
    // Core-vs-Gateway rule, "what is allowed to leave" is the Gateway's job, so
    // we route the egressing bundle text through the gateway firewall
    // (`POST /v1/firewall/check`, pii + secret checks) before it leaves the box —
    // the same governance the workflow Guardrails node uses. On a block we
    // WITHHOLD (the firewall has no sanitize surface for Core to call; block-and-
    // refuse is the design, not rewrite). Fail-CLOSED when the gateway is
    // unreachable, matching `run_guardrails` (override with
    // `RYU_ALLOW_GATEWAY_FALLBACK=1`).
    if let Err(reason) = support_bundle_dlp_check(&bundle).await {
        let _ = state
            .support_audit
            .append(&actor, "access_blocked_dlp", Some(&reason))
            .await;
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "support diagnostic bundle withheld by the gateway firewall",
                "code": "support_access_dlp_block",
                "reason": reason,
            })),
        );
    }

    let _ = state
        .support_audit
        .append(&actor, "diagnostic_bundle_read", None)
        .await;

    (StatusCode::OK, Json(json!({ "diagnostics": bundle })))
}

/// Run the egressing support bundle through the Gateway firewall before it
/// leaves the box (#547). Returns `Ok(())` when the gateway allows it (or no
/// enforceable content is present), and `Err(reason)` when a guardrail trips OR
/// the gateway is unreachable (fail-closed). Mirrors the workflow `run_guardrails`
/// posture, including the `RYU_ALLOW_GATEWAY_FALLBACK=1` escape hatch, so the two
/// egress gates agree. Only the `pii`/`secret` checks are requested — the
/// `jailbreak`/`injection` patterns target inbound prompts, not outbound diagnostics.
async fn support_bundle_dlp_check(
    bundle: &crate::support_access::DiagnosticBundle,
) -> Result<(), String> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    // Scan ONLY the free-text span `error` strings, not the whole serialized
    // bundle. Every other field is content-free BY CONSTRUCTION (version,
    // sidecar names, pref KEYS, the SHA-256 `args_hash`, the `conversation_id`);
    // feeding those high-entropy identifiers to a secret/PII scanner would risk
    // false-positives that, under fail-closed, would withhold every bundle. The
    // span `error` is the one place a secret/PII could leak (which is exactly why
    // #546 bounds it via `cap_error`), so it is the only thing worth scanning.
    let text = bundle
        .recent_spans
        .iter()
        .filter_map(|s| s.error.as_deref())
        .collect::<Vec<_>>()
        .join("\n");
    // Nothing free-text to scan → nothing can leak; allow without a gateway hop.
    if text.trim().is_empty() {
        return Ok(());
    }

    let payload = serde_json::json!({
        "text": text,
        "checks": ["pii", "secret"],
    });

    let allow_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK")
        .ok()
        .is_some_and(|v| v == "1");

    let client = reqwest::Client::new();
    let endpoint = format!("{}/v1/firewall/check", gateway_url().trim_end_matches('/'));
    let mut builder = client.post(&endpoint).json(&payload);
    if let Some(token) = gateway_token() {
        builder = builder.bearer_auth(token);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            if allow_fallback {
                return Ok(());
            }
            return Err(format!("gateway firewall unreachable (fail-closed): {e}"));
        }
    };
    if !resp.status().is_success() {
        if allow_fallback {
            return Ok(());
        }
        return Err(format!("gateway firewall returned HTTP {}", resp.status()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("invalid gateway firewall response: {e}"))?;
    let allowed = body
        .get("allowed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        let reason = body
            .get("reason")
            .and_then(|r| r.as_str())
            .unwrap_or("firewall guardrail tripped")
            .to_string();
        Err(reason)
    }
}

/// Gather a bounded window of recent redacted trace spans for the support bundle.
/// Spans are content-free by construction (`args_hash`, never raw args); this
/// merely caps the count. Best-effort — a read failure yields an empty list.
async fn collect_recent_redacted_spans(
    state: &ServerState,
) -> Vec<crate::support_access::RedactedSpan> {
    let mut out = Vec::new();
    // Pull recent conversation ids, then their spans, newest-conversation first.
    let conv_ids = match state.conversations.list_conversations().await {
        Ok(convs) => convs.into_iter().map(|c| c.id).collect::<Vec<_>>(),
        Err(_) => return out,
    };
    for cid in conv_ids {
        if out.len() >= SUPPORT_RECENT_SPANS_LIMIT {
            break;
        }
        let Ok(spans) = state.traces.get_spans(&cid).await else {
            continue;
        };
        for s in spans {
            if out.len() >= SUPPORT_RECENT_SPANS_LIMIT {
                break;
            }
            out.push(crate::support_access::RedactedSpan {
                conversation_id: s.conversation_id,
                kind: s.kind,
                name: s.name,
                args_hash: s.args_hash,
                started_at: s.started_at,
                ended_at: s.ended_at,
                error: s.error,
            });
        }
    }
    out
}

/// `GET /api/support-access/audit` — the local, user-readable, append-only audit
/// log of every support-access event (#546, P5). Not gated on the grant: the
/// user can always read their own record of what support saw, even after the
/// grant lapses (that's the point — they hold the record).
async fn support_access_audit(
    State(state): State<ServerState>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.support_audit.list().await {
        Ok(entries) => (StatusCode::OK, Json(json!({ "entries": entries }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `GET /api/system/status` — the merged system-status spine in ONE call.
///
/// Composes the active-engine, sidecar, gateway, and mesh probes Core already
/// exposes individually, applying the degrade rules in one place so every client
/// (desktop, CLI, extension, island, mobile) renders the same reachable/down view
/// instead of each firing 4+ requests and re-deriving the merge. If this endpoint
/// answers at all, Core is reachable; the client adds only the device-local
/// Shadow probe (Shadow is a sensor and is never routed through Core).
#[utoipa::path(
    get,
    path = "/api/system/status",
    tag = "Nodes",
    summary = "Merged system status (engine + sidecars + gateway + mesh)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn system_status(State(state): State<ServerState>) -> Json<serde_json::Value> {
    // Reuse each existing handler verbatim, concurrently — no probe logic is
    // duplicated here; only the merge shape lives in Core.
    let (engine, sidecars, gateway, mesh) = tokio::join!(
        get_active_engine(State(state.clone())),
        sidecar_status(State(state.clone())),
        gateway_status(State(state.clone())),
        mesh_status(State(state.clone())),
    );
    let gateway_reachable = gateway
        .0
        .get("reachable")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    Json(json!({
        "core": { "reachable": true },
        "engine": engine.0,
        "sidecars": sidecars
            .0
            .get("sidecars")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "gateway": { "reachable": gateway_reachable },
        "mesh": mesh.0,
    }))
}

#[utoipa::path(
    post,
    path = "/api/sidecar/start-all",
    tag = "Sidecars",
    summary = "Start all sidecars",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn sidecar_start_all(State(state): State<ServerState>) -> Json<serde_json::Value> {
    match state.manager.start_all().await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[utoipa::path(
    post,
    path = "/api/sidecar/stop-all",
    tag = "Sidecars",
    summary = "Stop all sidecars",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn sidecar_stop_all(State(state): State<ServerState>) -> Json<serde_json::Value> {
    state.manager.stop_all().await;
    Json(json!({ "success": true }))
}

#[utoipa::path(
    post,
    path = "/api/sidecar/{name}/start",
    tag = "Sidecars",
    summary = "Start a sidecar",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn sidecar_start(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    match state.manager.start_sidecar(&name).await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[utoipa::path(
    post,
    path = "/api/sidecar/{name}/stop",
    tag = "Sidecars",
    summary = "Stop a sidecar",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn sidecar_stop(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    match state.manager.stop_sidecar(&name).await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[utoipa::path(
    post,
    path = "/api/sidecar/{name}/restart",
    tag = "Sidecars",
    summary = "Restart a sidecar",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn sidecar_restart(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    match state.manager.restart_sidecar(&name).await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

/// Report the currently selected local engine, whether it is running, and which
/// local engines are installed and available to swap to. Only one local engine
/// is ever resident at a time.
#[utoipa::path(
    get,
    path = "/api/engine/active",
    tag = "Engines",
    summary = "Get the active resident engine",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_active_engine(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let active = state.manager.active_local_engine().await;
    let available = state.manager.available_local_engines().await;
    let running = active
        .as_ref()
        .map(|name| {
            state
                .manager
                .statuses()
                .into_iter()
                .any(|s| &s.name == name && s.running)
        })
        .unwrap_or(false);
    Json(json!({
        "active": active,
        "running": running,
        "available": available,
    }))
}

#[derive(serde::Deserialize)]
struct SetActiveEngineBody {
    name: String,
}

/// Swap the resident local engine to `name`: stop whatever local engine is
/// currently resident and start the requested one (mutually exclusive). The
/// selection persists across Core restarts.
#[utoipa::path(
    post,
    path = "/api/engine/active",
    tag = "Engines",
    summary = "Swap the active resident engine",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn set_active_engine(
    State(state): State<ServerState>,
    Json(body): Json<SetActiveEngineBody>,
) -> Json<serde_json::Value> {
    match state.manager.set_active_local_engine(&body.name).await {
        Ok(swap) => {
            // Re-point the gateway's `local` provider at the now-active engine
            // so an agent bound to a local model keeps routing through the
            // gateway to the right engine (U19). A no-op when the swap was
            // idempotent. Best-effort: a gateway refresh failure must not fail
            // the swap itself, so surface it as a warning field.
            let mut gateway_refreshed = true;
            if !swap.unchanged {
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!("gateway: refresh after engine swap failed: {e}");
                    gateway_refreshed = false;
                }
            }
            Json(json!({
                "success": true,
                "active": swap.active,
                "stopped": swap.stopped,
                "running": swap.running,
                "unchanged": swap.unchanged,
                "gateway_refreshed": gateway_refreshed,
            }))
        }
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

/// Report the default sandbox backend, plus every known backend with its live
/// availability (detected on this node) and platform support. Mirrors
/// `GET /api/engine/active`, but a sandbox backend is a *default* (per-call
/// overridable), not an exclusive resident slot, so there is no "running" field.
#[utoipa::path(
    get,
    path = "/api/sandbox/backend",
    tag = "Sandboxes",
    summary = "Get the default sandbox backend and available backends",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_sandbox_backend(State(_state): State<ServerState>) -> Json<serde_json::Value> {
    use crate::sidecar::sandbox;

    let active = sandbox::configured_backend().as_str().to_owned();
    let mut available = Vec::new();
    for name in sandbox::KNOWN_BACKENDS {
        available.push(json!({
            "name": name,
            "display_name": sandbox::backend_display_name(name),
            "detected": sandbox::detect_backend(name).await,
            "supported": crate::catalog::registry::supported_on_node(name),
        }));
    }
    Json(json!({
        "active": active,
        "available": available,
    }))
}

#[derive(serde::Deserialize)]
struct SetSandboxBackendBody {
    name: String,
}

/// Set the default sandbox backend. Persists to `~/.ryu/sandbox-backend.json`
/// (read by `configured_backend()`); the change takes effect on the next
/// `sandbox_exec` call that omits an explicit `backend`. An unknown/empty name
/// is rejected.
#[utoipa::path(
    post,
    path = "/api/sandbox/backend",
    tag = "Sandboxes",
    summary = "Set the default sandbox backend",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn set_sandbox_backend(
    State(_state): State<ServerState>,
    Json(body): Json<SetSandboxBackendBody>,
) -> Json<serde_json::Value> {
    use crate::sidecar::sandbox::{self, SandboxBackend, SandboxBackendStore};

    let name = body.name.trim();
    // Validate it parses to a backend we can actually build/run.
    match SandboxBackend::from_name(name) {
        Ok(_) if sandbox::KNOWN_BACKENDS.contains(&name) => {}
        _ => {
            return Json(json!({
                "success": false,
                "error": format!("unknown sandbox backend '{name}'"),
            }));
        }
    }
    match SandboxBackendStore::save(Some(name)) {
        Ok(()) => Json(json!({ "success": true, "active": name })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

/// `GET /api/models/active` — the GGUF the local chat engine is serving.
///
/// Reports the user-selected active model override (the local stem persisted in
/// preferences and its originating Hugging Face repo when known) plus the
/// registry default it falls back to. `active` is the default when no override
/// is set, so a client always learns the effective served model.
#[utoipa::path(
    get,
    path = "/api/models/active",
    tag = "Models",
    summary = "Get the active served local chat model",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_active_model(State(state): State<ServerState>) -> Json<serde_json::Value> {
    use crate::model_catalog::installed;

    // The pref is a structured {engine, format, ref}; legacy bare stems parse as
    // GGUF. Surface the parsed shape so clients learn the engine + format, not a
    // raw JSON blob.
    let raw = state
        .preferences
        .get(installed::ACTIVE_MODEL_PREF)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let active = installed::parse_active_pref(&raw);

    let registry = crate::registry::ModelRegistry::from_env();
    let default_id = registry.local_chat_model.id.clone();

    let (active_ref, engine, format) = match &active {
        Some(a) => (a.r#ref.clone(), Some(a.engine.clone()), a.format.as_str()),
        None => (default_id.clone(), None, "gguf"),
    };
    // For a GGUF selection the ref is a stem whose origin repo we can resolve;
    // for a snapshot the ref *is* the repo id.
    let repo_id = active.as_ref().and_then(|a| match a.format {
        crate::model_format::ModelFormat::Gguf => installed::repo_for_stem(&a.r#ref),
        _ => Some(a.r#ref.clone()),
    });

    Json(json!({
        "active": active_ref,
        "engine": engine,
        "format": format,
        "ref": active.as_ref().map(|a| a.r#ref.clone()),
        "repo_id": repo_id,
        "default": default_id,
    }))
}

#[derive(serde::Deserialize)]
struct SetActiveModelBody {
    /// Either a local stem or the Hugging Face `repo_id` of an installed model
    /// (the form carried by a `ryu://models/...` deep link).
    id: String,
    /// Optional explicit engine override (e.g. `"ollama"` instead of the picker's
    /// default `"llamacpp"` for a GGUF model). When omitted, the engine is
    /// derived from the model's format via `pick_engine`.
    #[serde(default)]
    engine: Option<String>,
}

/// `POST /api/models/active { id }` — switch the GGUF the local chat engine
/// serves to an already-installed model.
///
/// `id` is resolved to the local stem of a file present on disk; switching to a
/// model the user never downloaded is refused (400). The choice is persisted in
/// preferences, then the resident local engine (if any) is restarted so it
/// reloads with the new `--model`, and the gateway's `local` provider is
/// refreshed. When no local engine is currently resident the choice still
/// persists and takes effect on next start.
#[utoipa::path(
    post,
    path = "/api/models/active",
    tag = "Models",
    summary = "Switch the active served local chat model",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn set_active_model(
    State(state): State<ServerState>,
    Json(body): Json<SetActiveModelBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::model_catalog::installed;

    // 1. Resolve to a structured selection for an install present on disk.
    let Some(mut selection) = installed::resolve_active(body.id.trim()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "error": format!("'{}' is not installed — install it before switching", body.id),
            })),
        );
    };

    // 1b. Diffusion GGUFs are not chat models — route them to sd-server instead
    //     of the LOCAL_ENGINES chat-engine swap.
    if selection.format == crate::model_format::ModelFormat::Gguf
        && crate::model_catalog::capabilities::detect_local_is_diffusion(&selection.r#ref)
    {
        if let Err(e) = state
            .preferences
            .set(installed::ACTIVE_DIFFUSION_MODEL_PREF, &selection.r#ref)
            .await
        {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({ "success": false, "error": format!("could not persist diffusion model: {e}") }),
                ),
            );
        }
        // Best-effort restart so sd-server reloads with the new model weights.
        if let Err(e) = state.manager.restart_sidecar("sdcpp").await {
            tracing::warn!("could not restart sdcpp after diffusion model switch: {e}");
        }
        return (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "engine": "sdcpp",
                "ref": selection.r#ref,
                "diffusion": true,
            })),
        );
    }

    // 2. Derive the engine: an explicit override wins; otherwise pick the best
    //    node-supported engine for the model's format (preferring the resident
    //    one). No supported engine ⇒ 400 (annotate-only on this node).
    let resident = state.manager.active_local_engine().await;
    let picked = match body.engine.as_deref().filter(|e| !e.is_empty()) {
        Some(explicit) => explicit.to_string(),
        None => match crate::model_format::pick_engine(
            selection.format,
            resident.as_deref(),
            crate::catalog::registry::supported_on_node,
        ) {
            Some(e) => e.to_string(),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "success": false,
                        "error": format!(
                            "no installed engine serves {} on this node",
                            selection.format.as_str()
                        ),
                    })),
                );
            }
        },
    };
    selection.engine = picked.clone();

    // 3. Persist the structured selection FIRST, so the engine we start in the
    //    next step boots already pointed at the right model (the provider's
    //    `start()` reads this pref and matches on `engine`, so it MUST be written
    //    before the swap — decision 9). `engine` is the value we hand to
    //    `set_active_local_engine` below and which it makes resident, so the two
    //    records agree on success. To avoid drift when the swap FAILS (decision
    //    11), snapshot the prior pref and restore it if activation errors.
    let prior_pref = state
        .preferences
        .get(installed::ACTIVE_MODEL_PREF)
        .await
        .ok()
        .flatten();
    if let Err(e) = state
        .preferences
        .set(
            installed::ACTIVE_MODEL_PREF,
            &installed::encode_active_pref(&selection),
        )
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": format!("could not persist selection: {e}") })),
        );
    }

    // 4. Make the picked engine resident. A swap starts it fresh (already reading
    //    the pref we just wrote); an idempotent no-op means it was already
    //    resident and must be restarted to reload the new weights.
    let mut restarted = false;
    let swap = match state.manager.set_active_local_engine(&picked).await {
        Ok(swap) => swap,
        Err(e) => {
            // Activation failed — restore the prior pref so the persisted
            // selection never claims an engine that isn't actually resident
            // (no drift from the authoritative active-engine store). An empty
            // string clears it (`parse_active_pref` treats empty as unset).
            let restore = prior_pref.unwrap_or_default();
            let _ = state
                .preferences
                .set(installed::ACTIVE_MODEL_PREF, &restore)
                .await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({ "success": false, "error": format!("could not activate engine '{picked}': {e}") }),
                ),
            );
        }
    };
    if swap.unchanged {
        // 5. No swap happened (engine already resident) — restart it so it picks
        //    up the new model. Restart the PICKED engine, not the prior resident.
        match state.manager.restart_sidecar(&picked).await {
            Ok(()) => restarted = true,
            Err(e) => {
                tracing::warn!("could not restart engine '{picked}' after model switch: {e}")
            }
        }
    }

    // 6. Re-point the gateway's `local` provider at the now-active engine.
    let mut gateway_refreshed = true;
    if let Err(e) = state.gateway.refresh().await {
        tracing::warn!("gateway: refresh after model switch failed: {e}");
        gateway_refreshed = false;
    }

    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "active": selection.r#ref,
            "engine": picked,
            "format": selection.format.as_str(),
            "swapped": !swap.unchanged,
            "restarted": restarted,
            "gateway_refreshed": gateway_refreshed,
        })),
    )
}

// ── Gateway config write + status proxy (M2 / U018) ─────────────────────────

/// Writable subset of `GatewayConfig` accepted by `PUT /api/gateway/config`.
///
/// Only `firewall`, `routing`, and `budgets` are writable from Core. Provider
/// credentials require an environment-variable change (to avoid ever round-
/// tripping sensitive API keys through Core). All fields are optional — the
/// patch is merged over the existing persisted config.
///
/// The structs mirror the relevant sections of `apps/gateway/src/config.rs`.
/// Because the gateway is a binary crate (no lib target), we cannot import its
/// types; we define a compatible subset here and rely on TOML serialization
/// compatibility. The gateway's `toml::from_str` deserializes the same keys, so
/// the schema must stay in sync. Unknown keys in `gateway.toml` are ignored by
/// the gateway's serde config, making additive changes safe.
#[derive(serde::Deserialize, serde::Serialize, Default)]
struct GatewayConfigPatch {
    #[serde(default)]
    firewall: Option<GatewayFirewallPatch>,
    #[serde(default)]
    routing: Option<GatewayRoutingPatch>,
    #[serde(default)]
    budgets: Option<GatewayBudgetPatch>,
    /// When present, replaces the `[auth]` section's `api_keys` in gateway.toml.
    #[serde(default)]
    auth: Option<GatewayAuthPatch>,
}

/// Subset of the gateway's `FirewallConfig` exposed for Core writes.
#[derive(serde::Deserialize, serde::Serialize)]
struct GatewayFirewallPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scan_inbound: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scan_outbound: Option<bool>,
    /// "block" | "warn_and_continue" | "sanitize"
    #[serde(skip_serializing_if = "Option::is_none")]
    policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_detections: Option<bool>,
}

/// Subset of the gateway's `RoutingConfig` exposed for Core writes.
#[derive(serde::Deserialize, serde::Serialize)]
struct GatewayRoutingPatch {
    /// Provider to use when no model-map entry matches.
    /// One of: "openai", "anthropic", "local", "openrouter", "core".
    #[serde(skip_serializing_if = "Option::is_none")]
    default_provider: Option<String>,
    /// Ordered fallback chain, same provider names.
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_chain: Option<Vec<String>>,
}

/// Subset of the gateway's `BudgetConfig` exposed for Core writes.
/// Each entry maps an id (user or agent) to a token limit + action.
#[derive(serde::Deserialize, serde::Serialize, Default)]
struct GatewayBudgetPatch {
    /// Per-user budgets keyed by user id.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    users: std::collections::HashMap<String, GatewayBudgetRule>,
    /// Per-agent budgets keyed by agent id.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    agents: std::collections::HashMap<String, GatewayBudgetRule>,
    /// A single global per-session budget rule (#510). Mirrors the gateway's
    /// `SessionBudgetConfig`, which shares `BudgetRule`'s shape. Omitted when
    /// unset so it never clobbers an existing `[budgets.session]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<GatewayBudgetRule>,
}

/// A single budget rule: lifetime token cap and the enforcement action.
/// Mirrors `apps/gateway/src/config.rs::BudgetRule`.
#[derive(serde::Deserialize, serde::Serialize)]
struct GatewayBudgetRule {
    /// Lifetime token cap (input + output). 0 = unlimited.
    limit: u64,
    /// "notify" | "downgrade" | "restrict" | "stop"
    #[serde(default = "default_budget_action")]
    action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    downgrade_to: Option<String>,
    /// Cap applied to `max_tokens` when `action = restrict`. Preserved through
    /// the write path so a save never drops a hand-set value (the gateway
    /// defaults it to 256 when omitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restrict_max_tokens: Option<u64>,
}

fn default_budget_action() -> String {
    "notify".to_string()
}

/// Auth section of gateway.toml: the list of per-client API keys.
/// Only `api_keys` is writable from Core; `master_key` and `require_auth`
/// are startup-only (env vars) to prevent lockout.
#[derive(serde::Deserialize, serde::Serialize, Default)]
struct GatewayAuthPatch {
    /// Full replacement list of API keys.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    api_keys: Vec<GatewayApiKeyEntry>,
    /// Whether to enable auth (require a key on every request).
    #[serde(skip_serializing_if = "Option::is_none")]
    require_auth: Option<bool>,
}

/// A single API key entry. Mirrors `apps/gateway/src/config.rs::ApiKeyConfig`.
#[derive(serde::Deserialize, serde::Serialize)]
struct GatewayApiKeyEntry {
    pub key: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub trusted_forwarder: bool,
}

/// Resolve the path of `gateway.toml` using the same logic as the gateway's
/// `GatewayConfig::config_path()` so writes land where the gateway reads.
fn gateway_config_path() -> Option<std::path::PathBuf> {
    std::env::var("GATEWAY_CONFIG")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::config_dir().map(|d| d.join("ryu").join("gateway.toml")))
}

/// Merge a `GatewayConfigPatch` into the existing `gateway.toml`, returning
/// the merged `toml::Value` for inclusion in the response. The merge strategy
/// is: load the existing file (or start from an empty table), overlay each
/// present section from the patch, write back atomically.
///
/// The write uses a `.tmp`-rename so a crash mid-write never leaves a corrupt
/// file. Unknown keys in the existing file are preserved; only the patched
/// sections are updated.
fn write_gateway_toml(patch: &GatewayConfigPatch) -> anyhow::Result<toml::Value> {
    let path = gateway_config_path()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine gateway config path"))?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Load the existing config as a raw TOML value so we can merge without
    // knowing the full schema — extra keys from the gateway binary are preserved.
    let mut root: toml::Value = if path.exists() {
        let raw = std::fs::read_to_string(&path)?;
        toml::from_str(&raw)?
    } else {
        toml::Value::Table(toml::map::Map::new())
    };

    let table = root
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("gateway.toml root is not a table"))?;

    if let Some(fw) = &patch.firewall {
        let fw_toml = toml::Value::try_from(fw)
            .map_err(|e| anyhow::anyhow!("Failed to serialize firewall patch: {e}"))?;
        if let toml::Value::Table(fw_table) = fw_toml {
            let existing = table
                .entry("firewall")
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
            if let toml::Value::Table(existing_table) = existing {
                for (k, v) in fw_table {
                    existing_table.insert(k, v);
                }
            }
        }
    }

    if let Some(rt) = &patch.routing {
        let rt_toml = toml::Value::try_from(rt)
            .map_err(|e| anyhow::anyhow!("Failed to serialize routing patch: {e}"))?;
        if let toml::Value::Table(rt_table) = rt_toml {
            let existing = table
                .entry("routing")
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
            if let toml::Value::Table(existing_table) = existing {
                for (k, v) in rt_table {
                    existing_table.insert(k, v);
                }
            }
        }
    }

    if let Some(budgets) = &patch.budgets {
        let budgets_toml = toml::Value::try_from(budgets)
            .unwrap_or_else(|_| toml::Value::Table(toml::map::Map::new()));
        table.insert("budgets".to_string(), budgets_toml);
    }

    if let Some(auth) = &patch.auth {
        let auth_toml = toml::Value::try_from(auth)
            .map_err(|e| anyhow::anyhow!("Failed to serialize auth patch: {e}"))?;
        if let toml::Value::Table(auth_table) = auth_toml {
            let existing = table
                .entry("auth")
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
            if let toml::Value::Table(existing_table) = existing {
                for (k, v) in auth_table {
                    existing_table.insert(k, v);
                }
            }
        }
    }

    let merged_str = toml::to_string_pretty(&root)
        .map_err(|e| anyhow::anyhow!("Failed to serialize merged config: {e}"))?;

    // Write with 0o600 permissions so provider keys / budget rules stored in
    // gateway.toml are not world-readable on multi-user systems. The parent
    // directory is restricted to 0o700 for the same reason.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(parent) = path.parent() {
            if parent.exists() {
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }
    }

    let tmp_path = path.with_extension("toml.tmp");
    write_secret_file(&tmp_path, merged_str.as_bytes())?;
    std::fs::rename(&tmp_path, &path)?;

    Ok(root)
}

/// Write `data` to `path` with owner-only permissions (0o600 on Unix).
/// Uses a plain `OpenOptions` call on Windows — the BYOK vault unit (#140)
/// will add Windows ACL restriction when it lands.
fn write_secret_file(path: &std::path::Path, data: &[u8]) -> anyhow::Result<()> {
    use std::io::Write as _;

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(data)?;
    f.sync_all()?;
    Ok(())
}

/// `PUT /api/gateway/config` — write a validated TOML subset (firewall,
/// routing, budgets) to `gateway.toml` and trigger a gateway refresh.
///
/// **IMPORTANT:** `GatewayManager::refresh()` stops and respawns the gateway
/// process. This drops any in-flight requests and resets all in-memory metrics
/// counters (rate-limit windows, circuit-breaker state, eval scores, cache).
/// Callers should treat writes as low-frequency operations and avoid calling
/// during peak load.
///
/// When `RYU_GATEWAY_MANAGED=0`, the write is still persisted to disk (the next
/// manual gateway restart will pick it up), but `refresh()` is a no-op and the
/// response includes `"externally_managed": true` with a notice that a restart
/// is required for the change to take effect.
async fn gateway_config_write(
    State(state): State<ServerState>,
    Json(patch): Json<GatewayConfigPatch>,
) -> axum::response::Response {
    if patch.firewall.is_none()
        && patch.routing.is_none()
        && patch.budgets.is_none()
        && patch.auth.is_none()
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Request body must include at least one of: firewall, routing, budgets, auth"
                .to_owned(),
        );
    }

    // Persist the patch to disk first. If this fails the gateway is unchanged.
    let merged = match tokio::task::spawn_blocking(move || write_gateway_toml(&patch)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("config write task panicked: {e}"),
            )
        }
    };

    // Attempt to refresh the gateway so the new config takes effect immediately.
    // refresh() returns Ok(false) when RYU_GATEWAY_MANAGED=0 (externally managed).
    match state.gateway.refresh().await {
        Ok(false) => {
            // Externally managed: file write succeeded, but Core does not own
            // the gateway process. The operator must restart it manually.
            let config_path = gateway_config_path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            Json(json!({
                "ok": true,
                "externally_managed": true,
                "notice": "gateway.toml updated; restart the gateway process for changes to take effect (RYU_GATEWAY_MANAGED=0)",
                "config_path": config_path,
                "effective_config": merged,
            }))
            .into_response()
        }
        Ok(true) => Json(json!({
            "ok": true,
            "externally_managed": false,
            "notice": "gateway restarted; in-flight requests were dropped and in-memory metrics counters reset",
            "effective_config": merged,
        }))
        .into_response(),
        Err(e) => {
            // The file write succeeded but the refresh failed. The config on disk
            // is updated; the running gateway still has the old config until it
            // is restarted manually.
            let config_path = gateway_config_path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            (
                StatusCode::ACCEPTED,
                Json(json!({
                    "ok": false,
                    "notice": "gateway.toml updated but gateway refresh failed; restart the gateway manually",
                    "config_path": config_path,
                    "effective_config": merged,
                    "error": e.to_string(),
                })),
            )
                .into_response()
        }
    }
}

/// `GET /api/gateway/status` — a read-only observability proxy that fetches the
/// local gateway's `/health` and `/metrics` and returns a combined snapshot.
/// Also includes the persisted effective config from `gateway.toml` so the
/// desktop surfaces can reflect the current firewall/routing/budget settings
/// even when the gateway is unreachable.
///
/// Always responds `200`. When the gateway is unreachable it returns
/// `{ "reachable": false, ... }` rather than an error status, so the desktop
/// status spine can distinguish "gateway down (Core up)" from "Core down" — the
/// typed client treats any non-2xx as Core being unreachable.
///
/// Forwards the gateway bearer token (`RYU_GATEWAY_TOKEN`) when configured, in
/// case the gateway runs with auth enabled.
#[utoipa::path(
    get,
    path = "/api/gateway/status",
    tag = "Gateway",
    summary = "Gateway status (proxied)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn gateway_status(State(state): State<ServerState>) -> Json<serde_json::Value> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_token();

    // Read the effective config from disk so the status endpoint always reflects
    // the persisted config even when the gateway is temporarily down.
    let effective_config: Option<serde_json::Value> = gateway_config_path().and_then(|p| {
        let raw = std::fs::read_to_string(&p).ok()?;
        let v: toml::Value = toml::from_str(&raw).ok()?;
        serde_json::to_value(v).ok()
    });

    // Short timeout: the indicator polls frequently and a down gateway must fail
    // fast rather than stall the UI.
    let fetch_json = |path: &str| {
        let url = format!("{base}{path}");
        let req = state
            .client
            .get(&url)
            .timeout(std::time::Duration::from_millis(1500));
        let req = match token.as_deref() {
            Some(t) => req.bearer_auth(t),
            None => req,
        };
        async move {
            let resp = req.send().await.ok()?;
            if !resp.status().is_success() {
                return None;
            }
            resp.json::<serde_json::Value>().await.ok()
        }
    };

    let (health, metrics) = tokio::join!(fetch_json("/health"), fetch_json("/metrics"));

    // Reachability is gated on /health: if the gateway didn't answer a healthy
    // /health, treat it as down even if a stale /metrics happened to respond.
    let Some(health) = health else {
        return Json(json!({
            "reachable": false,
            "url": base,
            "health": null,
            "metrics": null,
            "effective_config": effective_config,
        }));
    };

    Json(json!({
        "reachable": true,
        "url": base,
        "health": health,
        "metrics": metrics,
        "effective_config": effective_config,
    }))
}

// ── Gateway config proxy (control plane, Unit U017) ─────────────────────────
//
// These two handlers forward to the gateway's `/v1/config` endpoint, carrying
// the bearer token server-side so the desktop never handles the master key. The
// proxy relays the gateway's exact status code; when the gateway is unreachable
// a structured 502 is returned, consistent with AC #3.

/// `GET /api/engine/concurrency` — local-engine admission-queue depth for the
/// desktop "N/M slots busy · K queued" surface (Layer 2 of the batching work).
///
/// Merges two sources, both best-effort (a missing one is simply omitted):
///   - the **gateway** admission snapshot (`/v1/concurrency`) — in-flight vs
///     queued, with the interactive/background split — the priority queue Core's
///     fan-out traffic flows through; and
///   - the resident **llama.cpp** engine's own `/slots` — how many slots the
///     engine reports busy (covers the direct, ungated LocalEngine path too).
///
/// Always returns 200 with whatever is reachable, so the panel degrades to
/// "unknown" instead of erroring when the gateway or engine is down.
#[utoipa::path(
    get,
    path = "/api/engine/concurrency",
    tag = "Gateway",
    summary = "Local-engine admission-queue + slot depth",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn engine_concurrency(State(state): State<ServerState>) -> Json<serde_json::Value> {
    use crate::sidecar::active_engine::{local_engine_base_url, ActiveEngineStore};
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    // 1. Gateway admission snapshot.
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let mut req = state
        .client
        .get(format!("{base}/v1/concurrency"))
        .timeout(std::time::Duration::from_millis(2000));
    if let Some(t) = gateway_token().as_deref() {
        req = req.bearer_auth(t);
    }
    let admission = match req.send().await {
        Ok(resp) => resp.json::<serde_json::Value>().await.ok(),
        Err(_) => None,
    };

    // 2. Resident engine's own slot view (best-effort; only meaningful for the
    //    llama.cpp server, which exposes `/slots`).
    let active = ActiveEngineStore::load().active;
    let mut engine_busy: Option<u64> = None;
    let mut engine_total: Option<u64> = None;
    if active.as_deref() == Some("llamacpp") {
        if let Some(engine_base) = active.as_deref().and_then(local_engine_base_url) {
            if let Ok(resp) = state
                .client
                .get(format!("{engine_base}/slots"))
                .timeout(std::time::Duration::from_millis(1500))
                .send()
                .await
            {
                if let Ok(slots) = resp.json::<serde_json::Value>().await {
                    if let Some(arr) = slots.as_array() {
                        engine_total = Some(arr.len() as u64);
                        // llama-server slots report `is_processing` (newer) or a
                        // non-`-1` `state` (older). Count either signal as busy.
                        let busy = arr
                            .iter()
                            .filter(|s| {
                                s.get("is_processing").and_then(serde_json::Value::as_bool)
                                    == Some(true)
                                    || s.get("state")
                                        .and_then(serde_json::Value::as_i64)
                                        .is_some_and(|st| st > 0)
                            })
                            .count() as u64;
                        engine_busy = Some(busy);
                    }
                }
            }
        }
    }

    Json(json!({
        "active_engine": active,
        "admission": admission,
        "engine_busy_slots": engine_busy,
        "engine_total_slots": engine_total,
    }))
}

#[utoipa::path(
    get,
    path = "/api/gateway/config",
    tag = "Gateway",
    summary = "Get the gateway config (proxied)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn gateway_get_config(
    State(state): State<ServerState>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_token();

    let mut req = state
        .client
        .get(format!("{base}/v1/config"))
        .timeout(std::time::Duration::from_millis(3000));
    if let Some(t) = token.as_deref() {
        req = req.bearer_auth(t);
    }

    match req.send().await {
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "reachable": false, "error": e.to_string() })),
        ),
        Ok(resp) => {
            let status =
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));
            (status, Json(body))
        }
    }
}

#[utoipa::path(
    put,
    path = "/api/gateway/config",
    tag = "Gateway",
    summary = "Update the gateway config (proxied)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn gateway_put_config(
    State(state): State<ServerState>,
    Json(patch): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_token();

    let mut req = state
        .client
        .put(format!("{base}/v1/config"))
        .timeout(std::time::Duration::from_millis(5000))
        .json(&patch);
    if let Some(t) = token.as_deref() {
        req = req.bearer_auth(t);
    }

    match req.send().await {
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "reachable": false, "error": e.to_string() })),
        ),
        Ok(resp) => {
            let status =
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));
            (status, Json(body))
        }
    }
}

// ── BYOK provider-key vault (Unit U026) ────────────────────────────────────
//
// `PUT /api/gateway/providers` writes a provider API key (or clears it when
// `api_key` is null) directly to gateway.toml, then restarts the gateway so
// the change takes effect. The key value is never logged.
//
// Supported providers: openai, anthropic, openrouter (local/core are keyless),
// and gemini — which is stored in the nested [providers.genai].keys table the
// genai-backed provider reads, rather than as a top-level api_key.

#[derive(serde::Deserialize)]
struct SetProviderBody {
    provider: String,
    api_key: Option<String>,
}

#[utoipa::path(
    put,
    path = "/api/gateway/providers",
    tag = "Gateway",
    summary = "Set a BYOK provider key (proxied)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn gateway_set_provider(
    State(state): State<ServerState>,
    Json(body): Json<SetProviderBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let provider = body.provider.trim().to_ascii_lowercase();
    if !matches!(
        provider.as_str(),
        "openai" | "anthropic" | "openrouter" | "gemini"
    ) {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "success": false, "error": "provider must be openai, anthropic, openrouter, or gemini" }),
            ),
        );
    }
    if let Some(ref key) = body.api_key {
        if key.trim().is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({ "success": false, "error": "api_key must not be empty (use null to clear)" }),
                ),
            );
        }
    }

    // Load, patch the providers table, write back atomically.
    let path = match gateway_config_path() {
        Some(p) => p,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": "cannot determine gateway config path" })),
            );
        }
    };

    let load_result: Result<toml::Value, String> = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if path.exists() {
            let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            toml::from_str::<toml::Value>(&raw).map_err(|e| e.to_string())
        } else {
            Ok(toml::Value::Table(toml::map::Map::new()))
        }
    })();

    let mut root = match load_result {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({ "success": false, "error": format!("failed to read gateway config: {e}") }),
                ),
            );
        }
    };

    let providers_table = root
        .as_table_mut()
        .expect("root is a table")
        .entry("providers")
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
        .as_table_mut()
        .expect("providers is a table");

    if provider == "gemini" {
        // The genai backend keeps per-adapter keys in a nested
        // [providers.genai].keys table (keyed by adapter kind, e.g. "gemini"),
        // so patch just that entry rather than a top-level api_key field.
        {
            let keys_table = providers_table
                .entry("genai".to_string())
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
                .as_table_mut()
                .expect("genai is a table")
                .entry("keys".to_string())
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
                .as_table_mut()
                .expect("genai.keys is a table");
            match body.api_key {
                None => {
                    keys_table.remove("gemini");
                }
                Some(key) => {
                    keys_table.insert("gemini".to_string(), toml::Value::String(key));
                }
            }
        }
        // Don't leave an empty genai provider behind once its last key is cleared.
        let genai_empty = providers_table
            .get("genai")
            .and_then(|v| v.as_table())
            .and_then(|t| t.get("keys"))
            .and_then(|v| v.as_table())
            .is_some_and(toml::map::Map::is_empty);
        if genai_empty {
            providers_table.remove("genai");
        }
    } else {
        match body.api_key {
            None => {
                providers_table.remove(&provider);
            }
            Some(key) => {
                let entry = providers_table
                    .entry(provider.clone())
                    .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
                if let Some(t) = entry.as_table_mut() {
                    t.insert("api_key".to_string(), toml::Value::String(key));
                }
            }
        }
    }

    let write_result: Result<(), String> = (|| {
        let toml_str = toml::to_string_pretty(&root).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, &toml_str).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    })();

    if let Err(e) = write_result {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(
                json!({ "success": false, "error": format!("failed to write gateway config: {e}") }),
            ),
        );
    }

    let mut gateway_restarted = true;
    if let Err(e) = state.gateway.refresh().await {
        tracing::warn!("gateway: restart after provider key change failed: {e}");
        gateway_restarted = false;
    }

    (
        StatusCode::OK,
        Json(
            json!({ "success": true, "provider": provider, "gateway_restarted": gateway_restarted }),
        ),
    )
}

// ── Gateway eval dataset runner proxy (M4 / #180) ──────────────────────────
//
// `POST /api/gateway/evals/run` forwards the eval run request to the gateway's
// `POST /v1/evals/run` endpoint, carrying the bearer token server-side so the
// desktop never holds the master key. Returns the gateway's response verbatim;
// on gateway-unreachable, returns a structured 502 (fail-closed, AC hard-constraint #1).

#[utoipa::path(
    post,
    path = "/api/gateway/evals/run",
    tag = "Gateway",
    summary = "Run a gateway eval dataset (proxied)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn gateway_run_evals(
    State(state): State<ServerState>,
    req_headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_token();

    let mut req = state
        .client
        .post(format!("{base}/v1/evals/run"))
        .timeout(std::time::Duration::from_secs(120))
        .json(&body);

    // Prefer the gateway token if configured; otherwise forward the caller's
    // Authorization header so per-key budgets are tracked for the eval run.
    if let Some(t) = token.as_deref() {
        req = req.bearer_auth(t);
    } else if let Some(auth) = req_headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
    {
        req = req.header("authorization", auth);
    }

    match req.send().await {
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "reachable": false, "error": e.to_string() })),
        ),
        Ok(resp) => {
            let status =
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let response_body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));
            (status, Json(response_body))
        }
    }
}

// ── Gateway audit proxy (M4 / #177) ────────────────────────────────────────
//
// `GET /api/gateway/audit` forwards supported query-string filters to the
// gateway's `GET /v1/audit` endpoint, carrying the bearer token server-side so
// the desktop never handles the master key. Returns `{ "reachable": false }`
// (200) when the gateway is unreachable, consistent with the status proxy
// contract (fail-soft for read-only observability, not fail-closed like the
// exec-budget gate). The gateway owns the audit data; Core only proxies.

#[derive(serde::Deserialize, Debug)]
struct AuditQueryParams {
    session_id: Option<String>,
    #[serde(default)]
    errors_only: bool,
    limit: Option<u32>,
}

#[utoipa::path(
    get,
    path = "/api/gateway/audit",
    tag = "Gateway",
    summary = "Query the gateway audit log (proxied)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn gateway_audit(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<AuditQueryParams>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_token();

    // Build the query string from supported filter params.
    let mut query_parts: Vec<String> = Vec::new();
    if let Some(sid) = &params.session_id {
        query_parts.push(format!("session_id={}", urlencoding_simple(sid)));
    }
    if params.errors_only {
        query_parts.push("errors_only=true".to_string());
    }
    if let Some(limit) = params.limit {
        query_parts.push(format!("limit={limit}"));
    }

    let qs = if query_parts.is_empty() {
        String::new()
    } else {
        format!("?{}", query_parts.join("&"))
    };

    let url = format!("{base}/v1/audit{qs}");

    let mut req = state
        .client
        .get(&url)
        .timeout(std::time::Duration::from_millis(3000));
    if let Some(t) = token.as_deref() {
        req = req.bearer_auth(t);
    }

    match req.send().await {
        Err(e) => (
            StatusCode::OK,
            Json(json!({ "reachable": false, "error": e.to_string(), "entries": [] })),
        ),
        Ok(resp) => {
            if !resp.status().is_success() {
                let status_u16 = resp.status().as_u16();
                let body = resp
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or_else(|_| json!({}));
                // Gateway audit disabled or returned an error — surface as
                // reachable:false with empty entries so the desktop shows the
                // "audit disabled" empty state rather than a raw error.
                return (
                    StatusCode::OK,
                    Json(
                        json!({ "reachable": false, "status": status_u16, "error": body, "entries": [] }),
                    ),
                );
            }
            let body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));
            (
                StatusCode::OK,
                Json(
                    json!({ "reachable": true, "entries": body.get("entries").cloned().unwrap_or(json!([])), "count": body.get("count").cloned().unwrap_or(json!(0)) }),
                ),
            )
        }
    }
}

/// Minimal percent-encoding for query string values (encodes non-alphanumeric
/// except `-`, `_`, `.`, `~`). Avoids a full URL-encoding library dependency.
fn urlencoding_simple(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            for byte in c.to_string().as_bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

// ── Workflow handlers (DAG engine) ──────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/workflows",
    tag = "Workflows",
    summary = "List workflows",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_workflows() -> Json<serde_json::Value> {
    let workflows = crate::workflow::store::list_workflows();
    Json(json!({ "workflows": workflows }))
}

#[utoipa::path(
    post,
    path = "/workflows",
    tag = "Workflows",
    summary = "Create a workflow",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn create_workflow(
    Json(workflow): Json<crate::workflow::Workflow>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Validate → stamp → save → reconcile triggers via the single shared write
    // path so the REST handler and the chat-driven workflow_builder behave
    // identically. A DAG-validation failure surfaces as a 400; any other error
    // (e.g. a disk write failure) as a 500.
    match crate::workflow::persist_workflow(workflow).await {
        Ok(workflow) => (
            StatusCode::OK,
            Json(json!({ "success": true, "workflow": workflow })),
        ),
        Err(e) => {
            let status = if e.contains("cycle")
                || e.contains("unknown node")
                || e.contains("duplicate node")
            {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "success": false, "error": e })))
        }
    }
}

#[utoipa::path(
    get,
    path = "/workflows/{id}",
    tag = "Workflows",
    summary = "Get a workflow",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_workflow(
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::workflow::store::load_workflow(&id) {
        Ok(wf) => (StatusCode::OK, Json(json!({ "workflow": wf }))),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "workflow not found" })),
        ),
    }
}

#[utoipa::path(
    delete,
    path = "/workflows/{id}",
    tag = "Workflows",
    summary = "Delete a workflow",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn delete_workflow(
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::workflow::store::delete_workflow(&id) {
        Ok(true) => {
            // Tear down the trigger resources the workflow created so a deleted
            // workflow stops firing (otherwise its `wf-sched-*` job keeps ticking
            // and `load_workflow` fails forever). Best-effort.
            crate::workflow::triggers::delete_schedule_jobs(&id);
            if let Some(store) = crate::composio_triggers::global() {
                if let Err(e) = store.delete_for_workflow(&id).await {
                    tracing::warn!(workflow = %id, error = %e, "clearing composio subs on workflow delete");
                }
            }
            (StatusCode::OK, Json(json!({ "success": true })))
        }
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "workflow not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize, Default)]
struct RunWorkflowBody {
    /// Initial input map (key → value) for `Input` nodes.
    #[serde(default)]
    input: std::collections::HashMap<String, String>,
    /// Optional run id to create or resume. Generated when absent.
    #[serde(default)]
    run_id: Option<String>,
}

/// `POST /workflows/:id/run` — execute a persisted workflow end-to-end.
///
/// Routes through the durable engine selected by `durable::select_engine()` —
/// the in-process petgraph topological executor with file-backed resumable
/// state, crash-recoverable at the node checkpoint level. Re-POST with the same
/// `run_id` to resume a run after a Core restart (already-Completed nodes are
/// skipped and their output reused).
///
/// Returns 503 when the gateway is unreachable and fail-closed is in effect.
#[utoipa::path(
    post,
    path = "/workflows/{id}/run",
    tag = "Workflows",
    summary = "Run a workflow",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn run_workflow(
    axum::extract::Path(id): axum::extract::Path<String>,
    body: Option<Json<RunWorkflowBody>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let body = body.map(|b| b.0).unwrap_or_default();

    let workflow = match crate::workflow::store::load_workflow(&id) {
        Ok(wf) => wf,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "success": false, "error": "workflow not found" })),
            );
        }
    };

    let run_id = body
        .run_id
        .unwrap_or_else(|| format!("run_{}", uuid::Uuid::new_v4().simple()));

    let engine = crate::workflow::durable::select_engine();

    tracing::debug!(
        workflow_id = %id,
        run_id = %run_id,
        "workflow: starting durable run"
    );

    match engine.execute(&workflow, body.input, run_id).await {
        Ok(run) => (StatusCode::OK, Json(json!({ "success": true, "run": run }))),
        Err(e) => {
            // Fail-closed: a gateway-unreachable error (from run_prompt) maps to 503.
            let status = if e.contains("gateway unreachable") || e.contains("gateway returned HTTP")
            {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "success": false, "error": e })))
        }
    }
}

#[utoipa::path(
    get,
    path = "/workflows/runs/{run_id}",
    tag = "Workflows",
    summary = "Get a workflow run",
    params(("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_workflow_run(
    axum::extract::Path(run_id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::workflow::store::load_run(&run_id) {
        Ok(run) => (StatusCode::OK, Json(json!({ "run": run }))),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "run not found" })),
        ),
    }
}

/// Body for `POST /workflows/runs/:run_id/resume`.
#[derive(serde::Deserialize, Default)]
struct ResumeWorkflowBody {
    /// Value to inject as the suspended Awakeable gate's output. Becomes the
    /// input to downstream nodes. Defaults to empty string when absent.
    #[serde(default)]
    payload: String,
}

/// `POST /workflows/runs/:run_id/resume` — resume a run suspended at an
/// Awakeable gate.
///
/// Acceptance criteria:
/// - 404 when the run does not exist.
/// - 409 when the run is not in `awaiting_input` status.
/// - Completes the Awakeable gate with the caller-supplied `payload`, persists,
///   re-invokes the executor (which skips all already-Completed nodes and
///   continues from the gate's successor), and returns the final run state.
#[utoipa::path(
    post,
    path = "/workflows/runs/{run_id}/resume",
    tag = "Workflows",
    summary = "Resume a workflow run (HITL)",
    params(("run_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn resume_workflow_run(
    axum::extract::Path(run_id): axum::extract::Path<String>,
    body: Option<Json<ResumeWorkflowBody>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let body = body.map(|b| b.0).unwrap_or_default();

    // Delegate to the reusable resume core (shared with the approval engine, so a
    // manual resume and an approved workflow-gate resume are identical). Map its
    // error string onto the right status code.
    match crate::workflow::resume_run(&run_id, body.payload).await {
        Ok(completed_run) => (
            StatusCode::OK,
            Json(json!({ "success": true, "run": completed_run })),
        ),
        Err(e) => {
            let status = if e.contains("not found") {
                StatusCode::NOT_FOUND
            } else if e.contains("not awaiting input") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "success": false, "error": e })))
        }
    }
}

// ── Sub-agent delegation ──────────────────────────────────────────────────────

/// Body for `POST /api/delegate/stream`: a parent hands one or more tasks to
/// sub-agents that run with a clean context under a permission preset and caps.
#[derive(serde::Deserialize, Default)]
struct DelegateBody {
    /// The sibling delegates to fan out (run concurrently, bounded by caps).
    #[serde(default)]
    delegates: Vec<crate::workflow::delegation::DelegateSpec>,
    /// Optional caps override; concurrency is clamped to the hard maximum.
    #[serde(default)]
    caps: Option<crate::workflow::delegation::DelegationCaps>,
    /// Depth of these delegates (a top-level parent delegating is depth 1).
    #[serde(default = "default_delegate_depth")]
    depth: usize,
}

fn default_delegate_depth() -> usize {
    1
}

/// `POST /api/delegate/stream` — run a delegation fan-out and stream progress.
///
/// Each delegate's `started`/`finished` event is emitted as an SSE line as it
/// happens, so the client sees same-depth delegates progress concurrently. A
/// terminal `done` event carries the ordered result array.
#[utoipa::path(
    post,
    path = "/api/delegate/stream",
    tag = "Chat",
    summary = "Stream a sub-agent delegation (SSE)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Server-Sent Events stream"))
)]
async fn delegate_stream(body: Option<Json<DelegateBody>>) -> axum::response::Response {
    use crate::sidecar::adapters::sse_response;
    use crate::workflow::delegation;

    let body = body.map(|b| b.0).unwrap_or_default();
    let caps = body.caps.unwrap_or_default();
    let depth = body.depth;
    let delegates = body.delegates;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<delegation::DelegateProgress>();

    // Spawn the fan-out; progress events arrive on `rx` while it runs.
    let fanout =
        tokio::spawn(async move { delegation::run_fanout(delegates, caps, depth, Some(tx)).await });

    let stream = async_stream::stream! {
        while let Some(ev) = rx.recv().await {
            let line = match serde_json::to_string(&ev) {
                Ok(json) => format!("data: {json}\n\n"),
                Err(_) => continue,
            };
            yield Ok::<_, std::convert::Infallible>(line.into_bytes());
        }

        let terminal = match fanout.await {
            Ok(Ok(results)) => json!({ "event": "done", "results": results }),
            Ok(Err(e)) => json!({ "event": "error", "error": e.to_string() }),
            Err(e) => json!({ "event": "error", "error": format!("delegation task failed: {e}") }),
        };
        yield Ok::<_, std::convert::Infallible>(
            format!("data: {terminal}\n\n").into_bytes(),
        );
    };

    sse_response(axum::body::Body::from_stream(stream))
}

// ── Scheduled-job handlers (heartbeat) ──────────────────────────────────────

async fn list_jobs() -> Json<serde_json::Value> {
    let jobs = crate::scheduler::store::list_jobs();
    Json(json!({ "jobs": jobs }))
}

#[derive(serde::Deserialize)]
struct CreateJobBody {
    name: String,
    schedule: crate::scheduler::store::Schedule,
    target: crate::scheduler::store::JobTarget,
    #[serde(default = "default_enabled")]
    enabled: bool,
    /// When true, each due firing waits for a human-in-the-loop approval before
    /// running (raises an inbox request). Off by default.
    #[serde(default)]
    require_approval: bool,
}

fn default_enabled() -> bool {
    true
}

async fn create_job(Json(body): Json<CreateJobBody>) -> (StatusCode, Json<serde_json::Value>) {
    // Validate the schedule up front so a broken cron is never persisted.
    if let crate::scheduler::store::Schedule::Cron { expr } = &body.schedule {
        if let Err(e) = crate::scheduler::cron::CronSchedule::parse(expr) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": e })),
            );
        }
    }
    if let crate::scheduler::store::Schedule::Every { interval } = &body.schedule {
        if humantime::parse_duration(interval).is_err() {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({ "success": false, "error": format!("invalid interval '{interval}'") }),
                ),
            );
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    let job = crate::scheduler::store::ScheduledJob {
        id: format!("job_{}", uuid::Uuid::new_v4().simple()),
        name: body.name,
        schedule: body.schedule,
        target: body.target,
        enabled: body.enabled,
        require_approval: body.require_approval,
        created_at: now.clone(),
        updated_at: now,
        last_run_at: None,
        last_outcome: None,
        history: Vec::new(),
    };

    match crate::scheduler::store::save_job(&job) {
        Ok(()) => (StatusCode::OK, Json(json!({ "success": true, "job": job }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

async fn get_job(
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::scheduler::store::load_job(&id) {
        Ok(job) => (StatusCode::OK, Json(json!({ "job": job }))),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "job not found" })),
        ),
    }
}

async fn delete_job(
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::scheduler::store::delete_job(&id) {
        Ok(true) => (StatusCode::OK, Json(json!({ "success": true }))),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "job not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    get,
    path = "/api/setup/check/{name}",
    tag = "Sidecars",
    summary = "Check whether a sidecar is installed",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn check_installed(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use crate::sidecar::download_manager::VersionStore;

    let in_session = state.setup.is_installed(&name).await;
    let in_store = VersionStore::load().versions.contains_key(&name);

    let installed = (in_session || in_store) && binary_installed_on_disk(&name);

    Json(json!({ "name": name, "installed": installed }))
}

#[utoipa::path(
    get,
    path = "/api/setup/status",
    tag = "Sidecars",
    summary = "Install status for all sidecars",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_install_status(State(state): State<ServerState>) -> Json<serde_json::Value> {
    use crate::sidecar::download_manager::VersionStore;
    use crate::sidecar::install_state::InstallState;

    // The in-memory InstallStatusStore only knows about installs/uninstalls that
    // happened in *this* core session. To report per-engine state for *every*
    // installed engine (including ones installed in a previous session, e.g.
    // both llama.cpp and ollama side by side), hydrate from the durable
    // versions.json and verify each binary still exists on disk.
    let mut states = state.install_status.get_all().await;

    let store = VersionStore::load();
    for (name, version) in &store.versions {
        // Don't override a live session state (Installing / Failed / freshly
        // Installed) — that is always the most accurate.
        if states.contains_key(name) {
            continue;
        }
        if binary_installed_on_disk(name) {
            states.insert(
                name.clone(),
                InstallState::Installed {
                    version: version.clone(),
                    installed_at: chrono::Utc::now(),
                },
            );
        }
    }

    Json(json!({ "states": states }))
}

#[utoipa::path(
    get,
    path = "/api/setup/status/{name}",
    tag = "Sidecars",
    summary = "Install status for one sidecar",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_install_status_by_name(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use crate::sidecar::download_manager::VersionStore;
    use crate::sidecar::install_state::InstallState;

    // Prefer the live session state; otherwise fall back to the durable store so
    // an engine installed in a previous session still reports as installed.
    let status = match state.install_status.get(&name).await {
        InstallState::NotInstalled => match VersionStore::load().versions.get(&name) {
            Some(version) if binary_installed_on_disk(&name) => InstallState::Installed {
                version: version.clone(),
                installed_at: chrono::Utc::now(),
            },
            _ => InstallState::NotInstalled,
        },
        live => live,
    };
    Json(json!({ "name": name, "status": status }))
}

fn command_exists(program: &str) -> bool {
    Command::new(program)
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn dependency_status() -> (serde_json::Map<String, serde_json::Value>, bool) {
    let git_installed = command_exists("git");
    let rust_installed = command_exists("rustc");
    let npm_installed = command_exists("npm") || command_exists("bun");
    let python_installed = command_exists("python3") || command_exists("python");
    let all_installed = git_installed && rust_installed && npm_installed && python_installed;

    let mut dependencies = serde_json::Map::new();
    dependencies.insert("git".to_string(), json!(git_installed));
    dependencies.insert("rust".to_string(), json!(rust_installed));
    dependencies.insert("npm".to_string(), json!(npm_installed));
    dependencies.insert("python".to_string(), json!(python_installed));

    (dependencies, all_installed)
}

fn run_install_command(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("{program} failed to start: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let status = output.status.code().map_or_else(
        || "terminated by signal".to_string(),
        |code| code.to_string(),
    );

    if stderr.is_empty() {
        Err(format!("{program} exited with status {status}"))
    } else {
        Err(format!("{program} exited with status {status}: {stderr}"))
    }
}

fn run_first_success(commands: &[(&str, &[&str])]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (program, args) in commands {
        match run_install_command(program, args) {
            Ok(()) => return Ok(()),
            Err(error) => errors.push(error),
        }
    }
    Err(errors.join("; "))
}

fn install_git() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        run_install_command(
            "winget",
            &[
                "install",
                "--id",
                "Git.Git",
                "-e",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
        )
    }

    #[cfg(target_os = "macos")]
    {
        run_install_command("brew", &["install", "git"])
    }

    #[cfg(target_os = "linux")]
    {
        run_first_success(&[
            ("sudo", &["apt-get", "install", "-y", "git"][..]),
            ("sudo", &["dnf", "install", "-y", "git"][..]),
            ("sudo", &["yum", "install", "-y", "git"][..]),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("automatic git install is unsupported on this platform".to_string())
    }
}

fn install_rust() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        run_install_command(
            "winget",
            &[
                "install",
                "--id",
                "Rustlang.Rustup",
                "-e",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
        )
    }

    #[cfg(target_os = "macos")]
    {
        run_install_command("brew", &["install", "rust"])
    }

    #[cfg(target_os = "linux")]
    {
        run_first_success(&[
            ("sudo", &["apt-get", "install", "-y", "rustc", "cargo"][..]),
            ("sudo", &["dnf", "install", "-y", "rust", "cargo"][..]),
            ("sudo", &["yum", "install", "-y", "rust", "cargo"][..]),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("automatic Rust install is unsupported on this platform".to_string())
    }
}

fn install_node_runtime() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        run_install_command(
            "winget",
            &[
                "install",
                "--id",
                "OpenJS.NodeJS.LTS",
                "-e",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
        )
    }

    #[cfg(target_os = "macos")]
    {
        run_install_command("brew", &["install", "node"])
    }

    #[cfg(target_os = "linux")]
    {
        run_first_success(&[
            ("sudo", &["apt-get", "install", "-y", "nodejs", "npm"][..]),
            ("sudo", &["dnf", "install", "-y", "nodejs", "npm"][..]),
            ("sudo", &["yum", "install", "-y", "nodejs", "npm"][..]),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("automatic Node.js install is unsupported on this platform".to_string())
    }
}

fn install_python() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        run_install_command(
            "winget",
            &[
                "install",
                "--id",
                "Python.Python.3",
                "-e",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
        )
    }

    #[cfg(target_os = "macos")]
    {
        run_install_command("brew", &["install", "python3"])
    }

    #[cfg(target_os = "linux")]
    {
        run_first_success(&[
            (
                "sudo",
                &["apt-get", "install", "-y", "python3", "python3-pip"][..],
            ),
            (
                "sudo",
                &["dnf", "install", "-y", "python3", "python3-pip"][..],
            ),
            (
                "sudo",
                &["yum", "install", "-y", "python3", "python3-pip"][..],
            ),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("automatic Python install is unsupported on this platform".to_string())
    }
}

fn install_dependency(
    is_installed: impl Fn() -> bool,
    install: impl FnOnce() -> Result<(), String>,
) -> serde_json::Value {
    if is_installed() {
        return json!({ "status": "already_installed", "success": true });
    }

    match install() {
        Ok(()) if is_installed() => json!({ "status": "installed", "success": true }),
        Ok(()) => json!({
            "status": "failed",
            "success": false,
            "error": "installer completed, but the dependency is still unavailable"
        }),
        Err(error) => json!({
            "status": "failed",
            "success": false,
            "error": error
        }),
    }
}

#[utoipa::path(
    get,
    path = "/api/dependencies/check",
    tag = "Sidecars",
    summary = "Check for git/rust/bun/python on PATH",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn check_dependencies() -> Json<serde_json::Value> {
    use std::time::Duration;

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(|| {
            let (dependencies, all_installed) = dependency_status();

            json!({
                "dependencies": dependencies,
                "all_installed": all_installed
            })
        }),
    )
    .await;

    match result {
        Ok(Ok(json)) => Json(json),
        Ok(Err(e)) => Json(json!({ "success": false, "error": e.to_string() })),
        Err(_) => Json(json!({ "success": false, "error": "timeout" })),
    }
}

#[utoipa::path(
    post,
    path = "/api/dependencies/install",
    tag = "Sidecars",
    summary = "Best-effort install of missing deps",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn install_dependencies() -> Json<serde_json::Value> {
    use std::time::Duration;

    let result = tokio::time::timeout(
        Duration::from_secs(300), // 5 minute timeout
        tokio::task::spawn_blocking(|| {
            let mut results = serde_json::Map::new();

            results.insert(
                "git".to_string(),
                install_dependency(|| command_exists("git"), install_git),
            );
            results.insert(
                "rust".to_string(),
                install_dependency(|| command_exists("rustc"), install_rust),
            );
            results.insert(
                "npm".to_string(),
                install_dependency(
                    || command_exists("npm") || command_exists("bun"),
                    install_node_runtime,
                ),
            );
            results.insert(
                "python".to_string(),
                install_dependency(
                    || command_exists("python3") || command_exists("python"),
                    install_python,
                ),
            );

            let (dependencies, all_installed) = dependency_status();
            let install_steps_succeeded = results.values().all(|result| {
                result
                    .get("success")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            });

            json!({
                "success": install_steps_succeeded && all_installed,
                "results": results,
                "dependencies": dependencies,
                "all_installed": all_installed
            })
        }),
    )
    .await;

    match result {
        Ok(Ok(json)) => Json(json),
        Ok(Err(e)) => Json(json!({ "success": false, "error": e.to_string() })),
        Err(_) => Json(json!({ "success": false, "error": "timeout" })),
    }
}

// NOTE: the former `double_check_tests` module was removed — it tested
// `parse_double_check_verdict`, which was deleted when the goal/double-check path
// moved to the plugin runtime (commit 10ca382c). The stale test broke the core
// test binary; it is gone with the function it covered.

// ── Connection-identity header parsing tests ─────────────────────────────────

#[cfg(test)]
mod remote_auth_tests {
    use super::{enforce_remote_auth, host_is_non_loopback};

    #[test]
    fn loopback_allows_tokenless_local_core() {
        let token = enforce_remote_auth(None, false, host_is_non_loopback("127.0.0.1:7980"))
            .expect("loopback-only Core may be tokenless");

        assert_eq!(token, None);
    }

    #[test]
    fn exposed_core_requires_a_real_token() {
        assert!(enforce_remote_auth(None, false, true).is_err());
        assert!(enforce_remote_auth(Some("   ".to_string()), false, true).is_err());
        assert!(enforce_remote_auth(Some("CHANGE_ME".to_string()), false, true).is_err());
        assert!(enforce_remote_auth(Some("replace_me".to_string()), true, false).is_err());

        let token = enforce_remote_auth(Some("strong-random-token".to_string()), false, true)
            .expect("non-placeholder tokens are accepted");

        assert_eq!(token.as_deref(), Some("strong-random-token"));
    }
}

#[cfg(test)]
mod context_budget_tests {
    use super::parse_context_budget;

    #[test]
    fn off_values_disable() {
        assert_eq!(parse_context_budget("", Some(8192)), None);
        assert_eq!(parse_context_budget("0", Some(8192)), None);
        assert_eq!(parse_context_budget("off", Some(8192)), None);
        assert_eq!(parse_context_budget("  OFF ", Some(8192)), None);
    }

    #[test]
    fn auto_sizes_to_ctx_size_else_off() {
        assert_eq!(parse_context_budget("auto", Some(8192)), Some(8192));
        assert_eq!(parse_context_budget("AUTO", Some(4096)), Some(4096));
        // Unknown / zero ctx_size → feature stays off (no guessable budget).
        assert_eq!(parse_context_budget("auto", None), None);
        assert_eq!(parse_context_budget("auto", Some(0)), None);
    }

    #[test]
    fn numeric_is_explicit_budget_and_ignores_ctx_size() {
        assert_eq!(parse_context_budget("3500", None), Some(3500));
        assert_eq!(parse_context_budget(" 12000 ", Some(8192)), Some(12000));
        // Garbage / non-positive → off.
        assert_eq!(parse_context_budget("abc", Some(8192)), None);
        assert_eq!(parse_context_budget("-5", Some(8192)), None);
    }
}

#[cfg(test)]
mod connection_identity_tests {
    use super::identity_from_headers;
    use axum::http::{HeaderMap, HeaderName, HeaderValue};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                k.parse::<HeaderName>().unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn parses_all_fields_and_url_decodes_user() {
        let id = identity_from_headers(&headers(&[
            ("x-ryu-client-id", "c1"),
            ("x-ryu-client-label", "Desktop"),
            ("x-ryu-surface", "desktop"),
            ("x-ryu-user-id", "a%40x.com"),
            ("x-ryu-user-name", "Jia%20Wei"),
        ]));
        assert_eq!(id.client_id, "c1");
        assert_eq!(id.client_label.as_deref(), Some("Desktop"));
        assert_eq!(id.surface.as_deref(), Some("desktop"));
        // user_id/user_name are percent-decoded (clients URL-encode them).
        assert_eq!(id.user_id.as_deref(), Some("a@x.com"));
        assert_eq!(id.user_name.as_deref(), Some("Jia Wei"));
        assert!(id.is_trackable());
    }

    #[test]
    fn decodes_non_ascii_display_name() {
        // "山田太郎" — a non-Latin1 name would be an invalid raw header value, so
        // clients send it URL-encoded and Core decodes it back here.
        let id = identity_from_headers(&headers(&[
            ("x-ryu-client-id", "c1"),
            ("x-ryu-user-name", "%E5%B1%B1%E7%94%B0%E5%A4%AA%E9%83%8E"),
        ]));
        assert_eq!(id.user_name.as_deref(), Some("山田太郎"));
    }

    #[test]
    fn missing_client_id_is_untrackable() {
        let id = identity_from_headers(&headers(&[("x-ryu-user-id", "a%40x.com")]));
        assert!(!id.is_trackable());
        assert_eq!(id.client_id, "");
        // The user is still parsed even when the request can't be tracked.
        assert_eq!(id.user_id.as_deref(), Some("a@x.com"));
    }

    #[test]
    fn empty_headers_yield_empty_identity() {
        let id = identity_from_headers(&HeaderMap::new());
        assert!(!id.is_trackable());
        assert!(id.user_id.is_none());
        assert!(id.user_name.is_none());
    }

    #[test]
    fn blank_header_values_are_ignored() {
        let id = identity_from_headers(&headers(&[
            ("x-ryu-client-id", "   "),
            ("x-ryu-user-name", ""),
        ]));
        assert!(!id.is_trackable());
        assert!(id.user_name.is_none());
    }
}

// ── Plugins catalog merge tests ──────────────────────────────────────────────

#[cfg(test)]
mod plugin_catalog_tests {
    use super::{
        manifest_policy_types, merge_plugin_catalog_entries, plugin_manifest_to_entry,
        plugin_marketplace_item_to_entry, plugin_runtime_dir,
    };
    use crate::plugin_manifest::{schema::RunnableEntry, PluginManifest};
    use crate::runnable::RunnableKind;
    use serde_json::json;

    /// #449: the per-plugin external-runtime dir is namespaced under the plugin
    /// id and ends in `runtime`, and the OS-correct venv interpreter derives
    /// beneath it. This pins the arg/venv-path construction the live
    /// `provision_external_runtime` call site relies on (the install itself is
    /// best-effort and never run in a test).
    #[test]
    fn plugin_runtime_dir_is_namespaced_and_venv_derives() {
        let dir = plugin_runtime_dir("io.ryu.durable");
        // Namespaced under the plugin id, ending in the `runtime` segment.
        assert!(dir.ends_with("runtime"), "dir: {}", dir.display());
        assert!(
            dir.to_string_lossy().contains("io.ryu.durable"),
            "dir must be namespaced by plugin id: {}",
            dir.display()
        );
        // The venv interpreter derives OS-correctly under that dir (the exact
        // path the provisioner creates + pip-installs into).
        let python = crate::sidecar::external_runtime::venv_python(&dir);
        let s = python.to_string_lossy();
        assert!(s.contains(".venv"), "venv under runtime dir: {s}");
        if cfg!(target_os = "windows") {
            assert!(s.ends_with("python.exe"));
        } else {
            assert!(s.ends_with("python"));
        }
    }

    /// `manifest_policy_types` collects the `policy_type` of every Policy runnable
    /// (the dispatch keys `apply_policy` switches on), and is empty for a manifest
    /// with no Policy runnables.
    #[test]
    fn manifest_policy_types_collects_policy_kinds() {
        let with_policies = PluginManifest {
            id: "io.ryu.firewall".to_owned(),
            name: "FW".to_owned(),
            version: "1.0.0".to_owned(),
            runnables: vec![
                RunnableEntry {
                    id: "p1".to_owned(),
                    name: "p1".to_owned(),
                    kind: RunnableKind::Policy,
                    config: Some(json!({ "policy_type": "firewall", "definition": {} })),
                },
                RunnableEntry {
                    id: "t1".to_owned(),
                    name: "t1".to_owned(),
                    kind: RunnableKind::Tool,
                    config: Some(json!({ "slug": "x" })),
                },
            ],
            ..Default::default()
        };
        assert_eq!(manifest_policy_types(&with_policies), vec!["firewall"]);

        let no_policies = PluginManifest {
            id: "io.ryu.spider".to_owned(),
            name: "Spider".to_owned(),
            version: "1.0.0".to_owned(),
            runnables: vec![RunnableEntry {
                id: "t1".to_owned(),
                name: "t1".to_owned(),
                kind: RunnableKind::Tool,
                config: Some(json!({ "slug": "x" })),
            }],
            ..Default::default()
        };
        assert!(manifest_policy_types(&no_policies).is_empty());
    }

    #[test]
    fn manifest_maps_to_entry_with_kinds() {
        let m = PluginManifest {
            id: "io.ryu.spider".to_owned(),
            name: "Spider".to_owned(),
            version: "1.2.3".to_owned(),
            runnables: vec![
                RunnableEntry {
                    id: "crawl".to_owned(),
                    name: "Crawl".to_owned(),
                    kind: RunnableKind::Tool,
                    config: None,
                },
                RunnableEntry {
                    id: "scrape".to_owned(),
                    name: "Scrape".to_owned(),
                    kind: RunnableKind::Tool,
                    config: None,
                },
            ],
            permission_grants: vec!["network.fetch".to_owned()],
            companion: None,
            ..Default::default()
        };
        let e = plugin_manifest_to_entry(&m);
        assert_eq!(e["id"], "io.ryu.spider");
        assert_eq!(e["name"], "Spider");
        assert_eq!(e["version"], "1.2.3");
        assert_eq!(e["source"], "built-in");
        // Duplicate kinds are deduped (two Tool runnables → one "tool").
        assert_eq!(e["kinds"], json!(["tool"]));
        assert_eq!(e["permission_grants"], json!(["network.fetch"]));
    }

    #[test]
    fn marketplace_item_maps_with_name_fallback() {
        // Full item.
        let full = json!({ "id": "acme/widget", "name": "Widget", "description": "d", "version": "2.0.0" });
        let e = plugin_marketplace_item_to_entry(&full, "ryu-marketplace").unwrap();
        assert_eq!(e["id"], "acme/widget");
        assert_eq!(e["name"], "Widget");
        assert_eq!(e["source"], "ryu-marketplace");
        assert_eq!(e["built_in"], false);

        // Missing name → falls back to id; missing version → empty string.
        let sparse = json!({ "id": "acme/bare" });
        let e2 = plugin_marketplace_item_to_entry(&sparse, "ryu-marketplace").unwrap();
        assert_eq!(e2["name"], "acme/bare");
        assert_eq!(e2["version"], "");

        // No id → dropped.
        assert!(plugin_marketplace_item_to_entry(&json!({ "name": "x" }), "s").is_none());
    }

    #[test]
    fn merge_dedups_by_id_first_writer_wins() {
        let builtins = vec![json!({ "id": "a", "source": "built-in" })];
        let marketplace = vec![
            json!({ "id": "a", "source": "ryu-marketplace" }), // dup of builtin → dropped
            json!({ "id": "b", "source": "ryu-marketplace" }),
        ];
        let registry = vec![
            json!({ "id": "b", "source": "registry" }), // dup → dropped
            json!({ "id": "c", "source": "registry" }),
            json!({ "no_id": true }), // no id → dropped
        ];
        let merged = merge_plugin_catalog_entries(vec![builtins, marketplace, registry]);
        assert_eq!(merged.len(), 3, "a, b, c — deduped");
        assert_eq!(merged[0]["id"], "a");
        assert_eq!(
            merged[0]["source"], "built-in",
            "first writer (builtin) wins for 'a'"
        );
        assert_eq!(merged[1]["id"], "b");
        assert_eq!(
            merged[1]["source"], "ryu-marketplace",
            "first writer wins for 'b'"
        );
        assert_eq!(merged[2]["id"], "c");
    }
}

// ── App-enable MCP filter tests (AC3 / issue #169) ───────────────────────────

#[cfg(test)]
mod app_tool_filter_tests {
    use super::app_tool_claim_sets;
    use crate::plugin_manifest::{schema::RunnableEntry, PluginManifest};
    use crate::plugins::PluginRecord;
    use crate::runnable::RunnableKind;

    fn make_manifest(id: &str, grants: &[&str]) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: "Test App".to_owned(),
            version: "1.0.0".to_owned(),
            runnables: vec![RunnableEntry {
                id: "r1".to_owned(),
                name: "R1".to_owned(),
                kind: RunnableKind::Tool,
                config: None,
            }],
            permission_grants: grants.iter().map(|s| s.to_string()).collect(),
            companion: None,
            ..Default::default()
        }
    }

    fn make_record(id: &str, enabled: bool) -> PluginRecord {
        PluginRecord {
            id: id.to_owned(),
            version: "1.0.0".to_owned(),
            enabled,
            approved_grants: vec![],
            created_at: None,
            updated_at: None,
        }
    }

    /// A tool claimed by a disabled app (not claimed by any enabled app) is
    /// in `disabled_claimed` but not `enabled_claimed` — filter it out.
    #[test]
    fn disabled_app_tool_is_in_disabled_set() {
        let manifests = vec![make_manifest("com.test.app", &["mcp:web_search"])];
        let lifecycle = vec![make_record("com.test.app", false)];

        let (disabled, enabled) = app_tool_claim_sets(&manifests, &lifecycle);
        assert!(
            disabled.contains("web_search"),
            "disabled app's tool must be in disabled_claimed"
        );
        assert!(
            !enabled.contains("web_search"),
            "disabled app's tool must not be in enabled_claimed"
        );
    }

    /// A tool claimed by an enabled app is in `enabled_claimed` — always show it.
    #[test]
    fn enabled_app_tool_is_in_enabled_set() {
        let manifests = vec![make_manifest("com.test.app", &["mcp:web_search"])];
        let lifecycle = vec![make_record("com.test.app", true)];

        let (disabled, enabled) = app_tool_claim_sets(&manifests, &lifecycle);
        assert!(!disabled.contains("web_search"));
        assert!(
            enabled.contains("web_search"),
            "enabled app's tool must be in enabled_claimed"
        );
    }

    /// When two apps claim the same tool and one is enabled, the tool is visible
    /// (enabled_claimed wins over disabled_claimed).
    #[test]
    fn one_enabled_claimant_keeps_tool_visible() {
        let manifests = vec![
            make_manifest("com.test.app-a", &["mcp:web_search"]),
            make_manifest("com.test.app-b", &["mcp:web_search"]),
        ];
        let lifecycle = vec![
            make_record("com.test.app-a", false), // disabled
            make_record("com.test.app-b", true),  // enabled
        ];

        let (disabled, enabled) = app_tool_claim_sets(&manifests, &lifecycle);
        // Both sets include web_search — caller checks enabled wins.
        assert!(disabled.contains("web_search"));
        assert!(
            enabled.contains("web_search"),
            "at least one enabled claimant — tool must stay visible"
        );
    }

    /// Grants that don't start with "mcp:" are not MCP tool slugs and must not
    /// appear in either set.
    #[test]
    fn non_mcp_grants_are_ignored() {
        let manifests = vec![make_manifest(
            "com.test.app",
            &["file:read", "storage:write"],
        )];
        let lifecycle = vec![make_record("com.test.app", false)];

        let (disabled, enabled) = app_tool_claim_sets(&manifests, &lifecycle);
        assert!(
            disabled.is_empty(),
            "non-mcp grants should not populate disabled_claimed"
        );
        assert!(
            enabled.is_empty(),
            "non-mcp grants should not populate enabled_claimed"
        );
    }

    /// A manifest with no lifecycle record is treated as disabled (not installed).
    #[test]
    fn manifest_without_lifecycle_record_treated_as_disabled() {
        let manifests = vec![make_manifest("com.test.app", &["mcp:file_search"])];
        let lifecycle: Vec<PluginRecord> = vec![];

        let (disabled, enabled) = app_tool_claim_sets(&manifests, &lifecycle);
        assert!(disabled.contains("file_search"));
        assert!(!enabled.contains("file_search"));
    }
}

#[cfg(test)]
mod auto_recall_pref_tests {
    use super::parse_auto_recall_enabled;

    #[test]
    fn default_on_when_unset() {
        assert!(parse_auto_recall_enabled(None));
    }

    #[test]
    fn explicit_disable_tokens_turn_it_off() {
        for v in ["false", "0", "off", "no", "FALSE", "Off", " no "] {
            assert!(
                !parse_auto_recall_enabled(Some(v)),
                "{v:?} should disable auto-recall"
            );
        }
    }

    #[test]
    fn enabled_tokens_and_garbage_stay_on() {
        for v in ["true", "1", "on", "yes", "", "anything"] {
            assert!(
                parse_auto_recall_enabled(Some(v)),
                "{v:?} should keep auto-recall on"
            );
        }
    }
}

#[cfg(test)]
mod fts_recall_pref_tests {
    use super::parse_fts_recall_enabled;

    #[test]
    fn default_off_when_unset() {
        assert!(!parse_fts_recall_enabled(None));
    }

    #[test]
    fn explicit_enable_tokens_turn_it_on() {
        for v in ["true", "1", "on", "yes", "TRUE", "On", " yes "] {
            assert!(
                parse_fts_recall_enabled(Some(v)),
                "{v:?} should enable fts recall"
            );
        }
    }

    #[test]
    fn disable_tokens_and_garbage_stay_off() {
        for v in ["false", "0", "off", "no", "", "anything"] {
            assert!(
                !parse_fts_recall_enabled(Some(v)),
                "{v:?} should keep fts recall off"
            );
        }
    }
}

#[cfg(test)]
mod ssrf_host_guard_tests {
    use super::screen_guarded_hostname;

    #[test]
    fn allows_normal_https_hosts() {
        assert!(screen_guarded_hostname("example.com").is_ok());
        assert!(screen_guarded_hostname("huggingface.co").is_ok());
        assert!(screen_guarded_hostname("sub.domain.example.org").is_ok());
        // Trailing-dot FQDN still allowed.
        assert!(screen_guarded_hostname("example.com.").is_ok());
        // Uppercase host is normalized, not rejected.
        assert!(screen_guarded_hostname("EXAMPLE.COM").is_ok());
    }

    #[test]
    fn blocks_cloud_metadata_hosts() {
        assert!(screen_guarded_hostname("metadata").is_err());
        assert!(screen_guarded_hostname("metadata.google.internal").is_err());
        assert!(screen_guarded_hostname("METADATA.GOOGLE.INTERNAL").is_err());
        assert!(screen_guarded_hostname("metadata.goog").is_err());
        assert!(screen_guarded_hostname("foo.metadata.google.internal").is_err());
        assert!(screen_guarded_hostname("metadata.google.internal.").is_err());
        // A host that merely contains the word but isn't a suffix match is fine.
        assert!(screen_guarded_hostname("metadata-service.example.com").is_ok());
    }

    #[test]
    fn blocks_non_ascii_and_homograph_hosts() {
        // Cyrillic 'а' homograph of ascii 'a'.
        assert!(screen_guarded_hostname("ex\u{0430}mple.com").is_err());
        // Zero-width joiner / bidi control embedded.
        assert!(screen_guarded_hostname("examp\u{200d}le.com").is_err());
        assert!(screen_guarded_hostname("ex\u{202e}ample.com").is_err());
        // Raw unicode label.
        assert!(screen_guarded_hostname("\u{043f}\u{0440}\u{0438}\u{043c}\u{0435}\u{0440}.\u{0440}\u{0444}").is_err());
    }

    #[test]
    fn blocks_control_and_whitespace_hosts() {
        assert!(screen_guarded_hostname("exa mple.com").is_err());
        assert!(screen_guarded_hostname("example.com\n").is_err());
        assert!(screen_guarded_hostname("example\t.com").is_err());
        assert!(screen_guarded_hostname("example.com\0").is_err());
        assert!(screen_guarded_hostname("").is_err());
    }

    #[test]
    fn ip_literals_pass_through_for_later_ip_screen() {
        // IP literals are screened by is_blocked_ip after resolution, not here.
        assert!(screen_guarded_hostname("93.184.216.34").is_ok());
        assert!(screen_guarded_hostname("[2606:2800:220:1:248:1893:25c8:1946]").is_ok());
    }
}

#[cfg(test)]
mod agent_egress_screen_tests {
    use super::{
        agent_egress_guard_enabled_from, host_is_allowlisted_in, is_blocked_ip,
        screen_agent_egress_url,
    };

    #[test]
    fn guard_default_on_and_disable_tokens() {
        // Absent env => on (secure default).
        assert!(agent_egress_guard_enabled_from(None));
        // Explicit disable tokens (case-insensitive, trimmed) => off.
        for v in ["0", "false", "off", "no", "FALSE", "Off", " no "] {
            assert!(
                !agent_egress_guard_enabled_from(Some(v)),
                "{v:?} should disable the egress guard"
            );
        }
        // Anything else keeps it on.
        for v in ["1", "true", "on", "yes", "", "anything"] {
            assert!(
                agent_egress_guard_enabled_from(Some(v)),
                "{v:?} should keep the egress guard on"
            );
        }
    }

    #[test]
    fn allowlist_parsing_is_case_and_whitespace_insensitive() {
        assert!(host_is_allowlisted_in(
            "169.254.169.254",
            Some("169.254.169.254")
        ));
        // Whitespace around entries is trimmed; case is ignored.
        assert!(host_is_allowlisted_in(
            "internal.example.com",
            Some(" a.com , Internal.Example.COM ,b.com")
        ));
        // Empty entries are ignored and non-members are rejected.
        assert!(!host_is_allowlisted_in("evil.com", Some("a.com,,b.com")));
        assert!(!host_is_allowlisted_in("evil.com", Some("")));
        assert!(!host_is_allowlisted_in("evil.com", None));
    }

    #[test]
    fn ip_screen_ranges_match_first_party_guard() {
        // Sanity-check the reused classifier covers the intended ranges.
        for ip in [
            "169.254.169.254",
            "10.0.0.1",
            "127.0.0.1",
            "192.168.1.1",
            "172.16.0.1",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(
                is_blocked_ip(ip.parse().unwrap()),
                "{ip} must be classified as blocked"
            );
        }
        assert!(!is_blocked_ip("93.184.216.34".parse().unwrap()));
    }

    #[tokio::test]
    async fn non_http_scheme_is_rejected() {
        assert!(screen_agent_egress_url("file:///etc/passwd").await.is_err());
        assert!(screen_agent_egress_url("ftp://example.com").await.is_err());
        assert!(screen_agent_egress_url("not a url").await.is_err());
    }

    #[tokio::test]
    async fn metadata_and_private_ip_literals_are_blocked_by_default() {
        // Default-on (no env mutation): IP-literal hosts are screened directly,
        // no DNS needed.
        for url in [
            "http://169.254.169.254/",
            "http://10.0.0.1/",
            "http://127.0.0.1/",
            "https://192.168.1.1/",
            "http://[fc00::1]/",
        ] {
            assert!(
                screen_agent_egress_url(url).await.is_err(),
                "{url} must be blocked by the egress screen"
            );
        }
    }
}
