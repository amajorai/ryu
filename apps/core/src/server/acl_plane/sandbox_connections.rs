//! The per-resource ACL plane (HTTP side), connections and sandbox handlers: `tenancy_filter_args` through `destroy_sandbox`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// The caller's tenancy tuple for a SQL-level read filter: `(user_id, org_id,
/// team_ids_json, node_bound)`. The single place handlers translate a [`VerifiedCaller`] into the
/// arguments of `ConversationStore::{list_conversations_visible, list_runs_visible,
/// visible_conversation_ids}`, whose `WHERE` mirrors [`resource_access`].
pub(crate) fn tenancy_filter_args(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> (Option<String>, Option<String>, Option<String>, bool) {
    let node_bound = node_org_id().is_some();
    let user_id = caller.as_ref().map(|c| c.user_id.clone());
    let org_id = caller.as_ref().and_then(|c| c.org_id.clone());
    let team_ids_json = caller.as_ref().map(|c| {
        let team_ids: Vec<&str> = c.teams.iter().map(|team| team.id.as_str()).collect();
        serde_json::to_string(&team_ids).unwrap_or_else(|_| "[]".to_owned())
    });
    (user_id, org_id, team_ids_json, node_bound)
}

/// The ids of every conversation `caller` may READ: [`tenancy_filter_args`] fed to
/// `ConversationStore::visible_conversation_ids_for_teams`, so verified team
/// memberships (narrowed to this node's org) reach the same SQL predicate as the
/// sidebar list. The one visibility function REST conversation search and the
/// `search_conversations` agent tool share for a verified caller.
pub(crate) async fn visible_conversation_ids_for_caller(
    store: &conversations::ConversationStore,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> anyhow::Result<Vec<String>> {
    let (user_id, org_id, team_ids_json, node_bound) = tenancy_filter_args(caller);
    store
        .visible_conversation_ids_for_teams(
            user_id.as_deref(),
            org_id.as_deref(),
            node_bound,
            team_ids_json.as_deref(),
        )
        .await
}

/// `GET /api/connections` — the clients currently connected to THIS node.
///
/// Presence/attribution only: identities are self-declared behind the shared
/// token and the data model is single-tenant, so this answers "who is here", not
/// "who is allowed to see what" (see [`crate::connections`]). `user_count` counts
/// distinct declared users (anonymous clients each count once by `client_id`).
#[utoipa::path(
    get,
    path = "/api/connections",
    tag = "Core",
    summary = "List the clients currently connected to this node",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_connections(
    State(state): State<ServerState>,
) -> impl IntoResponse {
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

/// `GET /api/sandboxes` — the remote (billable) sandbox runs live on THIS node.
///
/// Sibling of [`list_connections`]: a read-only visibility surface for the node
/// selector so a client can see which metered sandboxes a node is running (and
/// their elapsed/accrued figures) before routing work to it. Populated by the
/// sandbox metering registry (`crate::sidecar::sandbox::heartbeat`).
#[utoipa::path(
    get,
    path = "/api/sandboxes",
    tag = "Sandboxes",
    summary = "List the active run sandboxes",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_sandboxes() -> impl IntoResponse {
    let sandboxes = crate::sidecar::sandbox::heartbeat::list_active_runs();
    Json(json!({ "sandboxes": sandboxes }))
}

/// `POST /api/sandboxes` — launch a persistent (Daytona) sandbox.
///
/// Creates a long-lived Daytona workspace, registers it with the metering
/// heartbeat (per-second billing + budget-kill), and returns its `run_id` +
/// real `workspace_id`. Persistent is Daytona-only; the one-shot `sandbox_exec`
/// tool covers other backends. RYU_TOKEN-only (desktop launch), no JWT
/// carve-out — the read-only `GET` above stays web-viewable.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub(in crate::server) struct CreateSandboxRequest {
    pub(in crate::server) spec: Option<crate::sidecar::sandbox::spec::SandboxSpec>,
    pub(in crate::server) budget_micro_usd: Option<u64>,
}

pub(in crate::server) async fn create_sandbox(
    Json(req): Json<CreateSandboxRequest>,
) -> impl IntoResponse {
    match crate::sidecar::sandbox::session::create_sandbox(req.spec, req.budget_micro_usd).await {
        Ok(c) => Json(c).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/sandboxes/{run_id}/exec` — run one command in a live sandbox.
#[derive(serde::Deserialize)]
pub(in crate::server) struct ExecSandboxRequest {
    pub(in crate::server) command: String,
    #[serde(default)]
    pub(in crate::server) args: Vec<String>,
    #[serde(default)]
    pub(in crate::server) timeout_secs: Option<u64>,
}

#[utoipa::path(
    post,
    path = "/api/sandboxes/{run_id}/exec",
    tag = "Sandboxes",
    summary = "Execute a command inside a run's sandbox",
    params(("run_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn exec_sandbox(
    Path(run_id): Path<String>,
    Json(req): Json<ExecSandboxRequest>,
) -> impl IntoResponse {
    match crate::sidecar::sandbox::session::exec_in_sandbox(
        &run_id,
        req.command,
        req.args,
        req.timeout_secs,
    )
    .await
    {
        Ok(r) => Json(r).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `DELETE /api/sandboxes/{run_id}` — destroy a live sandbox (final tail debit +
/// workspace teardown). Idempotent: an already-destroyed run returns `ok`.
#[utoipa::path(
    delete,
    path = "/api/sandboxes/{run_id}",
    tag = "Sandboxes",
    summary = "Destroy a run's sandbox",
    params(("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn destroy_sandbox(Path(run_id): Path<String>) -> impl IntoResponse {
    match crate::sidecar::sandbox::session::destroy_sandbox(&run_id).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}
