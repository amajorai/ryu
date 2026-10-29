//! An agent's own Composio accounts, under `/api/agents/:id/composio/…`.
//!
//! An agent with its own identity (`individual`) or both identities (`mixed`)
//! runs Composio actions as its own entity, `agent:<owner>:<agent_id>` (see
//! [`AgentAccountPolicy::composio_agent_entity`]), never as the user. These
//! routes let the user connect apps to that entity, list them and disconnect
//! them:
//!
//! * `GET /api/agents/:id/composio/connections?toolkit=` lists the entity's
//!   accounts, each with its access level and its allowlist key
//!   `agent-composio:<connected_account_id>`.
//! * `POST /api/agents/:id/composio/connections/initiate` starts a connection
//!   and stores its access level for the entity. An agent with an allowlist
//!   gets the new account added to it, so it can be used at once.
//! * `GET` and `DELETE /api/agents/:id/composio/connections/:cid` read or
//!   remove one account, only after the entity's own listing shows it owns it.
//!   Removing it also removes the Composio triggers subscribed on it.
//!
//! Triggers on these accounts are subscribed through
//! `POST /api/composio/triggers/subscribe` with `own_account`; that route
//! checks the policy and this entity's ownership the same way.
//!
//! They are operator-only: the route policy admits only the node owner, the
//! handlers apply the exact-agent ACL (`agent.edit`), and the self-API never
//! exposes them, so an agent can never connect, inspect or disconnect its own
//! accounts. A `managed` agent ("Acts as you") has no own entity and is refused.
//!
//! With the Connect service, the agent's account lives inside the owner's
//! tenant: Core uses the owner's tenant credential and names the agent
//! (`agentId`), and Connect derives the agent's Composio user. That needs a
//! tenant binding with agent accounts enabled; otherwise these routes answer
//! 501 `agent_entity_unsupported`. Connect verifies the sign-in callback, so a
//! started link is finished with `POST /api/composio/connections/complete`,
//! which tries the owner's pending links, newest first (see
//! [`pending_service_links`]).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;
use crate::agent_access::{AccountKey, AgentAccountPolicy};
use crate::agents::AgentIdentityMode;
use crate::identity_verify::VerifiedCaller;

/// The routes, merged into the agents router.
pub fn routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/agents/:id/composio/connections",
            get(agent_composio_connections),
        )
        .route(
            "/api/agents/:id/composio/connections/initiate",
            axum::routing::post(agent_composio_connection_initiate),
        )
        .route(
            "/api/agents/:id/composio/connections/:cid",
            get(agent_composio_connection_status).delete(agent_composio_connection_disconnect),
        )
}

/// The allowlist key of one account connected to an agent's own entity.
pub(crate) fn agent_composio_key(connected_account_id: &str) -> String {
    AccountKey::AgentComposio(connected_account_id.to_owned()).to_key_string()
}

/// `?toolkit=`.
#[derive(Debug, Default, Deserialize)]
pub struct AgentComposioQuery {
    #[serde(default)]
    pub toolkit: Option<String>,
}

/// Body for `POST /api/agents/:id/composio/connections/initiate`.
#[derive(Debug, Deserialize)]
pub struct AgentComposioConnectBody {
    pub toolkit: String,
    #[serde(default)]
    pub access_level: crate::identity::ConnectionAccessLevel,
}

/// What every handler resolves before touching Composio.
struct AgentComposioTarget {
    owner: String,
    agent_id: String,
    /// The agent's own entity. Embedded Composio runs as it; Core's identity
    /// store keys the agent's access levels by it in both modes.
    entity: String,
    /// Whether the agent has an allowlist, so a new account must be added to it.
    limited: bool,
}

impl AgentComposioTarget {
    fn subject(&self) -> ryu_composio::connect::Subject<'_> {
        ryu_composio::connect::Subject::Agent {
            owner: &self.owner,
            agent_id: &self.agent_id,
        }
    }
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn service_unsupported(message: &str) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "error": message, "code": "agent_entity_unsupported" })),
    )
        .into_response()
}

/// A Composio or Connect failure: 501 when the Connect service's tenant
/// binding does not enable agent accounts, 502 otherwise.
fn upstream_error(e: &anyhow::Error) -> Response {
    if ryu_composio::service::is_subject_unsupported(e) {
        return service_unsupported(
            "the Connect service on this node does not enable apps for agents",
        );
    }
    error(StatusCode::BAD_GATEWAY, e.to_string())
}

/// Why this agent may not have own Composio accounts, if it may not: an agent
/// that acts as the user has no own entity.
fn own_entity_refusal(record: &crate::agents::AgentRecord) -> Option<Response> {
    let policy = AgentAccountPolicy::from_record(record);
    if record.identity_mode == AgentIdentityMode::Managed || !policy.allows_own_accounts() {
        return Some(error(
            StatusCode::CONFLICT,
            "this agent acts as you; choose Its own identity or Both to connect apps for it",
        ));
    }
    None
}

/// How long a link started through the Connect service waits for its callback.
const SERVICE_LINK_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Most pending Connect service links remembered per owner. A link nobody
/// finishes ages out after [`SERVICE_LINK_TTL`]; this bounds a burst of starts.
const MAX_PENDING_LINKS_PER_OWNER: usize = 8;

/// One pending Connect service link: the agent it was started for, or `None`
/// for the owner's own account, and when it started.
type PendingLink = (Option<String>, std::time::Instant);

/// The Connect service links each owner started and has not finished.
/// Connect's sign-in callback carries only an opaque session, so the completion
/// route cannot tell whose link it is: it tries the owner's pending subjects,
/// newest first ([`pending_service_links`]), and Connect and Composio check the
/// session against each subject's own Composio user and pending account, so a
/// wrong guess fails closed and the next one is tried.
static PENDING_SERVICE_LINKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<PendingLink>>>,
> = std::sync::LazyLock::new(Default::default);

fn pending_links(
) -> std::sync::MutexGuard<'static, std::collections::HashMap<String, Vec<PendingLink>>> {
    PENDING_SERVICE_LINKS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Remember that `owner` started a Connect service link for `agent_id`, or
/// (`None`) for their own account. Starting another link for the same subject
/// refreshes it; links for other subjects stay pending.
pub(crate) fn note_service_link(owner: &str, agent_id: Option<&str>) {
    let mut links = pending_links();
    let pending = links.entry(owner.to_owned()).or_default();
    pending.retain(|(subject, started)| {
        subject.as_deref() != agent_id && started.elapsed() < SERVICE_LINK_TTL
    });
    pending.push((agent_id.map(str::to_owned), std::time::Instant::now()));
    if pending.len() > MAX_PENDING_LINKS_PER_OWNER {
        let excess = pending.len() - MAX_PENDING_LINKS_PER_OWNER;
        pending.drain(..excess);
    }
}

/// The subjects `owner` has an unexpired pending Connect service link for,
/// newest first: an agent id, or `None` for the owner's own account.
pub(crate) fn pending_service_links(owner: &str) -> Vec<Option<String>> {
    let mut links = pending_links();
    let Some(pending) = links.get_mut(owner) else {
        return Vec::new();
    };
    pending.retain(|(_, started)| started.elapsed() < SERVICE_LINK_TTL);
    let subjects = pending
        .iter()
        .rev()
        .map(|(subject, _)| subject.clone())
        .collect();
    if pending.is_empty() {
        links.remove(owner);
    }
    subjects
}

/// Forget `owner`'s completed link for `agent_id` (`None`: their own account).
pub(crate) fn finish_service_link(owner: &str, agent_id: Option<&str>) {
    let mut links = pending_links();
    if let Some(pending) = links.get_mut(owner) {
        pending.retain(|(subject, _)| subject.as_deref() != agent_id);
        if pending.is_empty() {
            links.remove(owner);
        }
    }
}

/// Re-check, when its link completes, that `agent_id` may still have own
/// accounts and that the caller may still edit it.
pub(crate) async fn completion_refusal(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    agent_id: &str,
) -> Option<Response> {
    resolve_target(state, caller, agent_id).await.err()
}

/// Resolve the caller, the agent and its own Composio entity, refusing every
/// case in which the agent may not have own Composio accounts. `None` means
/// Composio is not configured at all.
async fn resolve_target(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    agent_id: &str,
) -> Result<Option<AgentComposioTarget>, Response> {
    let owner = crate::mcp_oauth::owner_for_caller(caller.as_ref())
        .map_err(|e| error(StatusCode::UNAUTHORIZED, e.to_string()))?;
    super::enforce_agent_resource_permission(
        state,
        caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        agent_id,
    )
    .await?;
    let record = match state.agent_store.get(agent_id).await {
        Ok(Some(record)) => record,
        Ok(None) => return Err(error(StatusCode::NOT_FOUND, "agent not found")),
        Err(e) => {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("the agent could not be read: {e}"),
            ))
        }
    };
    if let Some(refusal) = own_entity_refusal(&record) {
        return Err(refusal);
    }
    let service_mode = ryu_composio::service::is_configured();
    if !service_mode && !crate::composio_auth::is_configured() {
        return Ok(None);
    }
    if service_mode && !ryu_composio::service::valid_agent_subject(agent_id) {
        return Err(service_unsupported(
            "this agent's id can't name an account with the Connect service",
        ));
    }
    Ok(Some(AgentComposioTarget {
        entity: AgentAccountPolicy::composio_agent_entity(&owner, agent_id),
        owner,
        agent_id: agent_id.to_owned(),
        limited: record.account_access.is_some(),
    }))
}

fn not_configured() -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Composio is not configured; add a Composio API key first",
    )
}

/// Add the entity's access level and the allowlist key to each listed row.
async fn decorate_rows(entity: &str, value: &mut Value) -> anyhow::Result<()> {
    let store = crate::identity::global();
    let Some(data) = value.get_mut("data").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for connection in data {
        let Some(object) = connection.as_object_mut() else {
            continue;
        };
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        object.insert("key".to_owned(), Value::String(agent_composio_key(&id)));
        let Some(store) = store else {
            continue;
        };
        let toolkit = object.get("toolkit").and_then(Value::as_str).unwrap_or("");
        let access_level = store
            .get_connection_access_level(
                entity,
                crate::connection_policy::COMPOSIO_PROVIDER,
                &crate::connection_policy::composio_connection_key(toolkit),
            )
            .await?;
        object.insert(
            "access_level".to_owned(),
            Value::String(access_level.as_str().to_owned()),
        );
    }
    Ok(())
}

/// `GET /api/agents/:id/composio/connections?toolkit=`.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/composio/connections",
    tag = "Agents",
    summary = "List the Composio accounts connected to an agent's own identity",
    params(("id" = String, Path), ("toolkit" = Option<String>, Query)),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 404, description = "Unknown agent", body = serde_json::Value),
        (status = 409, description = "The agent acts as the user", body = serde_json::Value),
        (status = 501, description = "The Connect service's tenant binding does not enable agent accounts", body = serde_json::Value)
    )
)]
pub async fn agent_composio_connections(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(agent_id): Path<String>,
    Query(query): Query<AgentComposioQuery>,
) -> Response {
    let target = match resolve_target(&state, &caller, &agent_id).await {
        Ok(Some(target)) => target,
        Ok(None) => return Json(json!({ "data": [], "configured": false })).into_response(),
        Err(response) => return response,
    };
    let toolkit = query.toolkit.as_deref().unwrap_or("").trim();
    match crate::composio_connect::list_connections_for(&state.client, toolkit, target.subject())
        .await
    {
        Ok(mut value) => {
            if let Err(e) = decorate_rows(&target.entity, &mut value).await {
                return error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            if let Some(object) = value.as_object_mut() {
                object.insert("configured".to_owned(), Value::Bool(true));
            }
            Json(value).into_response()
        }
        Err(e) => upstream_error(&e),
    }
}

/// `POST /api/agents/:id/composio/connections/initiate`.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/composio/connections/initiate",
    tag = "Agents",
    summary = "Connect a Composio app to an agent's own identity",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK: open redirect_url to finish", body = serde_json::Value),
        (status = 404, description = "Unknown agent", body = serde_json::Value),
        (status = 409, description = "The agent acts as the user", body = serde_json::Value),
        (status = 501, description = "The Connect service's tenant binding does not enable agent accounts", body = serde_json::Value)
    )
)]
pub async fn agent_composio_connection_initiate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(agent_id): Path<String>,
    Json(body): Json<AgentComposioConnectBody>,
) -> Response {
    let target = match resolve_target(&state, &caller, &agent_id).await {
        Ok(Some(target)) => target,
        Ok(None) => return not_configured(),
        Err(response) => return response,
    };
    let toolkit = body.toolkit.trim();
    if toolkit.is_empty() {
        return error(StatusCode::BAD_REQUEST, "toolkit is required to connect");
    }
    let Some(store) = crate::identity::global() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "identity store not initialized",
        );
    };
    // Store the ceiling first, so the account is never usable under a looser
    // default than the one the user picked.
    if let Err(e) = store
        .set_connection_access_level(
            &target.entity,
            crate::connection_policy::COMPOSIO_PROVIDER,
            &crate::connection_policy::composio_connection_key(toolkit),
            body.access_level,
        )
        .await
    {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Composio connection policy could not be saved: {e}"),
        );
    }
    match crate::composio_connect::initiate_for(&state.client, toolkit, target.subject()).await {
        Ok(mut value) => {
            if ryu_composio::service::is_configured() {
                note_service_link(&target.owner, Some(&agent_id));
            }
            let connection_id = value
                .get("connection_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned);
            if let Some(id) = connection_id.as_deref() {
                if target.limited {
                    super::vault_agent_accounts_api::allow_agent_owned_key(
                        &state,
                        &agent_id,
                        agent_composio_key(id),
                    )
                    .await;
                }
            }
            if let Some(object) = value.as_object_mut() {
                object.insert("access_level".to_owned(), json!(body.access_level.as_str()));
                if let Some(id) = connection_id.as_deref() {
                    object.insert("key".to_owned(), json!(agent_composio_key(id)));
                }
            }
            Json(value).into_response()
        }
        Err(e) => upstream_error(&e),
    }
}

/// Resolve one account the agent's entity owns, or the response to return.
async fn owned(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    agent_id: &str,
    connection_id: &str,
) -> Result<(AgentComposioTarget, Value), Response> {
    let target = match resolve_target(state, caller, agent_id).await? {
        Some(target) => target,
        None => return Err(not_configured()),
    };
    match crate::composio_connect::owned_connection_for(
        &state.client,
        connection_id,
        target.subject(),
    )
    .await
    {
        Ok(Some(row)) => Ok((target, row)),
        Ok(None) => Err(error(
            StatusCode::NOT_FOUND,
            "no such account is connected to this agent",
        )),
        Err(e) => Err(upstream_error(&e)),
    }
}

/// `GET /api/agents/:id/composio/connections/:cid`.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/composio/connections/{cid}",
    tag = "Agents",
    summary = "Read one Composio account connected to an agent's own identity",
    params(("id" = String, Path), ("cid" = String, Path)),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 404, description = "Not connected to this agent", body = serde_json::Value)
    )
)]
pub async fn agent_composio_connection_status(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path((agent_id, connection_id)): Path<(String, String)>,
) -> Response {
    match owned(&state, &caller, &agent_id, &connection_id).await {
        Ok((_, mut row)) => {
            if let Some(object) = row.as_object_mut() {
                object.insert("key".to_owned(), json!(agent_composio_key(&connection_id)));
            }
            Json(row).into_response()
        }
        Err(response) => response,
    }
}

/// `DELETE /api/agents/:id/composio/connections/:cid`.
#[utoipa::path(
    delete,
    path = "/api/agents/{id}/composio/connections/{cid}",
    tag = "Agents",
    summary = "Disconnect a Composio account from an agent's own identity",
    params(("id" = String, Path), ("cid" = String, Path)),
    responses(
        (status = 200, description = "Disconnected", body = serde_json::Value),
        (status = 404, description = "Not connected to this agent", body = serde_json::Value)
    )
)]
pub async fn agent_composio_connection_disconnect(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path((agent_id, connection_id)): Path<(String, String)>,
) -> Response {
    let target = match owned(&state, &caller, &agent_id, &connection_id).await {
        Ok((target, _)) => target,
        Err(response) => return response,
    };
    if let Err(e) = crate::composio_connect::delete_connection_for(
        &state.client,
        &connection_id,
        target.subject(),
    )
    .await
    {
        return upstream_error(&e);
    }
    // Its triggers go with it, so no binding or remote instance outlives the
    // account.
    if let Some(store) = crate::composio_triggers::global() {
        if let Err(e) = store
            .delete_for_connected_account(&target.entity, &connection_id)
            .await
        {
            tracing::warn!(agent = %agent_id, error = %e, "removing a disconnected account's triggers failed");
        }
    }
    super::vault_agent_accounts_api::revoke_agent_owned_key(
        &state,
        &agent_id,
        &agent_composio_key(&connection_id),
    )
    .await;
    Json(json!({ "ok": true, "id": connection_id })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::CreateAgent;

    async fn agent(
        state: &ServerState,
        mode: AgentIdentityMode,
        access: Option<Vec<&str>>,
    ) -> String {
        state
            .agent_store
            .create(CreateAgent {
                name: format!("{mode:?} agent"),
                identity_mode: mode,
                account_access: access.map(|keys| keys.into_iter().map(str::to_owned).collect()),
                ..Default::default()
            })
            .await
            .unwrap()
            .id
    }

    async fn list(state: &ServerState, agent_id: &str) -> (StatusCode, Value) {
        let response = agent_composio_connections(
            State(state.clone()),
            Extension(None),
            Path(agent_id.to_owned()),
            Query(AgentComposioQuery::default()),
        )
        .await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn agent_composio_keys_round_trip() {
        assert_eq!(agent_composio_key("ca_1"), "agent-composio:ca_1");
        assert_eq!(
            AccountKey::parse(&agent_composio_key("ca_1")),
            Some(AccountKey::AgentComposio("ca_1".into()))
        );
    }

    #[tokio::test]
    async fn refuses_agents_that_act_as_the_user_and_unknown_agents() {
        let directory = tempfile::tempdir().unwrap();
        let state = super::super::isolated_plugin_hook_test_state(directory.path());

        let legacy = agent(&state, AgentIdentityMode::Managed, None).await;
        let limited = agent(&state, AgentIdentityMode::Managed, Some(vec![])).await;
        for agent_id in [&legacy, &limited] {
            let (status, body) = list(&state, agent_id).await;
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert!(body["error"].as_str().unwrap().contains("acts as you"));
        }
        let (status, _) = list(&state, "no-such-agent").await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Disconnect and status refuse the same way, before any Composio call.
        let response = agent_composio_connection_disconnect(
            State(state.clone()),
            Extension(None),
            Path((legacy.clone(), "ca_1".to_owned())),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let response = agent_composio_connection_status(
            State(state.clone()),
            Extension(None),
            Path(("no-such-agent".to_owned(), "ca_1".to_owned())),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn agents_with_their_own_identity_may_have_accounts_in_either_mode() {
        let directory = tempfile::tempdir().unwrap();
        let state = super::super::isolated_plugin_hook_test_state(directory.path());
        for mode in [AgentIdentityMode::Individual, AgentIdentityMode::Mixed] {
            let agent_id = agent(&state, mode, Some(vec![])).await;
            let record = state.agent_store.get(&agent_id).await.unwrap().unwrap();
            assert!(own_entity_refusal(&record).is_none(), "{mode:?}");
        }
    }

    #[tokio::test]
    async fn connect_tenants_without_agent_accounts_answer_501() {
        let unsupported = anyhow::Error::new(ryu_composio::service::ConnectRejected {
            status: 400,
            code: Some("subject_unsupported".into()),
        });
        let response = upstream_error(&unsupported);
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "agent_entity_unsupported");
        let other = anyhow::Error::new(ryu_composio::service::ConnectRejected {
            status: 409,
            code: Some("connection_conflict".into()),
        });
        assert_eq!(upstream_error(&other).status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn service_links_keep_every_pending_subject_newest_first() {
        note_service_link("owner-a", Some("agent_1"));
        note_service_link("owner-b", Some("agent_2"));
        assert_eq!(
            pending_service_links("owner-a"),
            vec![Some("agent_1".to_owned())]
        );
        // A later link for another subject does not displace the first.
        note_service_link("owner-a", Some("agent_3"));
        note_service_link("owner-a", None);
        assert_eq!(
            pending_service_links("owner-a"),
            vec![None, Some("agent_3".to_owned()), Some("agent_1".to_owned())]
        );
        // Starting a subject's link again moves it to the front, once.
        note_service_link("owner-a", Some("agent_1"));
        assert_eq!(
            pending_service_links("owner-a"),
            vec![Some("agent_1".to_owned()), None, Some("agent_3".to_owned())]
        );
        // Finishing one subject's link leaves the others pending.
        finish_service_link("owner-a", None);
        assert_eq!(
            pending_service_links("owner-a"),
            vec![Some("agent_1".to_owned()), Some("agent_3".to_owned())]
        );
        finish_service_link("owner-b", Some("agent_9"));
        assert_eq!(
            pending_service_links("owner-b"),
            vec![Some("agent_2".to_owned())]
        );
        finish_service_link("owner-b", Some("agent_2"));
        assert!(pending_service_links("owner-b").is_empty());
        // The per-owner list is bounded, dropping the oldest.
        for index in 0..MAX_PENDING_LINKS_PER_OWNER + 3 {
            note_service_link("owner-d", Some(&format!("agent_d{index}")));
        }
        let kept = pending_service_links("owner-d");
        assert_eq!(kept.len(), MAX_PENDING_LINKS_PER_OWNER);
        assert_eq!(
            kept.first().and_then(Option::as_deref),
            Some(format!("agent_d{}", MAX_PENDING_LINKS_PER_OWNER + 2).as_str())
        );
        // Expired links are dropped.
        if let Some(expired) = std::time::Instant::now()
            .checked_sub(SERVICE_LINK_TTL + std::time::Duration::from_secs(1))
        {
            pending_links().insert("owner-c".into(), vec![(Some("agent_4".into()), expired)]);
            assert!(pending_service_links("owner-c").is_empty());
        }
    }

    #[tokio::test]
    async fn own_accounts_are_added_to_and_removed_from_an_allowlist() {
        let directory = tempfile::tempdir().unwrap();
        let state = super::super::isolated_plugin_hook_test_state(directory.path());

        let limited = agent(
            &state,
            AgentIdentityMode::Mixed,
            Some(vec!["composio:ca_user"]),
        )
        .await;
        let key = agent_composio_key("ca_own");
        super::super::vault_agent_accounts_api::allow_agent_owned_key(
            &state,
            &limited,
            key.clone(),
        )
        .await;
        super::super::vault_agent_accounts_api::allow_agent_owned_key(
            &state,
            &limited,
            key.clone(),
        )
        .await;
        let record = state.agent_store.get(&limited).await.unwrap().unwrap();
        assert_eq!(
            record.account_access,
            Some(vec!["composio:ca_user".to_owned(), key.clone()])
        );
        super::super::vault_agent_accounts_api::revoke_agent_owned_key(&state, &limited, &key)
            .await;
        let record = state.agent_store.get(&limited).await.unwrap().unwrap();
        assert_eq!(
            record.account_access,
            Some(vec!["composio:ca_user".to_owned()])
        );

        // An unlimited agent may already use every own account.
        let open = agent(&state, AgentIdentityMode::Individual, None).await;
        super::super::vault_agent_accounts_api::allow_agent_owned_key(&state, &open, key).await;
        let record = state.agent_store.get(&open).await.unwrap().unwrap();
        assert!(record.account_access.is_none());
    }

    #[test]
    fn the_routes_are_documented_but_never_core_api_tools() {
        let spec = serde_json::to_value(super::super::openapi::api_doc()).unwrap();
        for path in [
            "/api/agents/{id}/composio/connections",
            "/api/agents/{id}/composio/connections/initiate",
            "/api/agents/{id}/composio/connections/{cid}",
        ] {
            assert!(
                spec["paths"].get(path).is_some(),
                "{path} is not in the spec"
            );
            assert!(
                !crate::self_api::routes()
                    .iter()
                    .any(|route| route.path_template == path),
                "{path} reached the CoreApi catalog"
            );
        }
    }
}
