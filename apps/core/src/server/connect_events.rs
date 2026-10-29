//! Core authorization and orchestration for the standalone Connect inbox.
use anyhow::{bail, Context, Result};
use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ConsumeBody {}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(
    tag = "kind",
    content = "id",
    rename_all = "lowercase",
    deny_unknown_fields
)]
pub enum ConnectTargetSelector {
    Agent(String),
    Workflow(String),
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindConnectTargetBody {
    connect_trigger_id: String,
    target: ConnectTargetSelector,
}

/// Refuse an agent trigger binding on a connected account the agent's account
/// policy does not allow (its identity mode and allowlist). The trigger runs on
/// one of the user's accounts, so this guards every route that attaches one to
/// an agent. A store error refuses with 503; an agent without a record keeps
/// today's behaviour.
pub(super) async fn agent_trigger_account_refusal(
    state: &ServerState,
    agent_id: &str,
    connected_account_id: &str,
) -> Option<(StatusCode, Json<Value>)> {
    match state.agent_store.get(agent_id).await {
        Ok(Some(record))
            if !crate::agent_access::AgentAccountPolicy::from_record(&record)
                .allows_composio_account(connected_account_id) =>
        {
            Some((
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": "this agent is not allowed to use that connected account; allow it in the agent's account access"
                })),
            ))
        }
        Ok(_) => None,
        Err(_) => Some((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "agent lookup unavailable" })),
        )),
    }
}

/// Refuse a trigger on one of the user's accounts that the calling user's own
/// Composio entity does not hold (for example an account connected to an
/// agent's own identity, passed as a user account). Embedded mode only: with
/// the Connect service, Connect scopes every trigger to the caller's tenant.
pub(super) async fn user_trigger_account_ownership_refusal(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    connected_account_id: &str,
) -> Option<(StatusCode, Json<Value>)> {
    let user = caller.as_ref().map(|caller| caller.user_id.as_str());
    match crate::composio_connect::owned_connection(&state.client, connected_account_id, user).await
    {
        Ok(Some(_)) => None,
        Ok(None) => Some((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such account is connected to your account" })),
        )),
        Err(error) => Some((
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error.to_string() })),
        )),
    }
}

/// Check a trigger on an account connected to the agent's own identity and
/// return that identity's Composio entity (`agent:<owner>:<agent_id>`), or the
/// response to return. In order: the Connect service has no agent entities
/// (501), the caller must be a verified user (403) who may run the agent
/// (403), the agent must exist (404; a store error is 503), its policy must
/// allow events from that own account (403), Composio must be configured (503),
/// and the agent's own entity must hold the account (404) and have it active
/// (409). Another agent's account, or one of the user's, is never found on
/// this agent's entity.
pub(super) async fn own_account_trigger_refusal(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    agent_id: &str,
    connected_account_id: &str,
) -> Result<String, (StatusCode, Json<Value>)> {
    let refuse = |status: StatusCode, message: &str| (status, Json(json!({ "error": message })));
    if ryu_composio::service::is_configured() {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({
                "error": "triggers on an agent's own apps are not available with Connect service mode",
                "code": "agent_entity_unsupported",
            })),
        ));
    }
    let Ok(owner) = crate::mcp_oauth::owner_for_caller(caller.as_ref()) else {
        return Err(refuse(StatusCode::FORBIDDEN, "verified user required"));
    };
    if super::enforce_permission_on(
        state,
        caller,
        crate::identity_verify::permissions::AGENT_RUN,
        crate::acl::KIND_AGENT,
        agent_id,
    )
    .await
    .is_err()
    {
        return Err(refuse(
            StatusCode::FORBIDDEN,
            "agent execution is not permitted",
        ));
    }
    let record = match state.agent_store.get(agent_id).await {
        Ok(Some(record)) => record,
        Ok(None) => return Err(refuse(StatusCode::NOT_FOUND, "agent not found")),
        Err(_) => {
            return Err(refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent lookup unavailable",
            ))
        }
    };
    if !crate::agent_access::AgentAccountPolicy::from_record(&record)
        .allows_own_composio_trigger(connected_account_id)
    {
        return Err(refuse(
            StatusCode::FORBIDDEN,
            "this agent is not allowed to use that connected account; allow it in the agent's account access",
        ));
    }
    if !crate::composio_auth::is_configured() {
        return Err(refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "Composio is not configured; add a Composio API key first",
        ));
    }
    let entity = crate::agent_access::AgentAccountPolicy::composio_agent_entity(&owner, agent_id);
    match crate::composio_connect::owned_connection(
        &state.client,
        connected_account_id,
        Some(&entity),
    )
    .await
    {
        Ok(Some(row)) if row.get("active").and_then(Value::as_bool) == Some(false) => Err(refuse(
            StatusCode::CONFLICT,
            "that account is not active; reconnect it for this agent first",
        )),
        Ok(Some(_)) => Ok(entity),
        Ok(None) => Err(refuse(
            StatusCode::NOT_FOUND,
            "no such account is connected to this agent",
        )),
        Err(error) => Err((
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error.to_string() })),
        )),
    }
}

#[utoipa::path(
    post,
    path = "/api/composio/targets",
    operation_id = "bind_connect_target",
    tag = "Composio",
    summary = "Bind an owned Connect trigger to an authorized Core agent or workflow",
    request_body = BindConnectTargetBody,
    responses((status = 201, description = "Core target binding saved", body = serde_json::Value))
)]
pub async fn bind_target(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<BindConnectTargetBody>,
) -> (StatusCode, Json<Value>) {
    if !ryu_composio::service::is_configured() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"code":"connect_unavailable"})),
        );
    }
    let owner = match crate::mcp_oauth::owner_for_caller(caller.as_ref()) {
        Ok(owner) => owner,
        Err(_) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"code":"verified_user_required"})),
            );
        }
    };
    use crate::identity_verify::permissions;
    let (permission, kind, target_id) = match &body.target {
        ConnectTargetSelector::Agent(id) => {
            (permissions::AGENT_RUN, crate::acl::KIND_AGENT, id.as_str())
        }
        ConnectTargetSelector::Workflow(id) => (
            permissions::WORKFLOW_RUN,
            crate::acl::KIND_WORKFLOW,
            id.as_str(),
        ),
    };
    if uuid::Uuid::parse_str(&body.connect_trigger_id).is_err()
        || target_id.is_empty()
        || target_id.len() > 256
        || target_id
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"code":"invalid_target_binding"})),
        );
    }
    if super::enforce_permission_on(&state, &caller, permission, kind, target_id)
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"code":"target_run_denied"})),
        );
    }
    // `Ok(Err(response))` is a policy refusal decided after the trigger (and so
    // its connected account) has been resolved.
    let result: Result<std::result::Result<Value, (StatusCode, Json<Value>)>> = async {
        match &body.target {
            ConnectTargetSelector::Agent(id) => {
                if state.agent_store.get(id).await?.is_none()
                    && state.agents.find_exact(id).is_none()
                {
                    bail!("Unknown Core target agent");
                }
            }
            ConnectTargetSelector::Workflow(id) => {
                crate::workflow::store::load_workflow(id)?;
            }
        }
        let store = crate::composio_triggers::global().context("Core target store unavailable")?;
        let user = caller.as_ref().map(|caller| caller.user_id.as_str());
        let trigger = ryu_composio::service::list_triggers(user)
            .await
            .context("Connect is not configured")??
            .into_iter()
            .find(|trigger| trigger.id == body.connect_trigger_id)
            .context("Connect trigger is not owned by the caller")?;
        if trigger.status != "active" {
            bail!("Connect trigger is not active");
        }
        if let ConnectTargetSelector::Agent(id) = &body.target {
            if let Some(refusal) =
                agent_trigger_account_refusal(&state, id, &trigger.connected_account_id).await
            {
                return Ok(Err(refusal));
            }
        }
        let account = ryu_composio::service::connection_status(&trigger.connected_account_id, user)
            .await
            .context("Connect is not configured")??;
        if account.get("active").and_then(Value::as_bool) != Some(true) {
            bail!("Connect account is not active");
        }
        let identity = ryu_composio::triggers::ConnectEventIdentity {
            trigger_id: trigger
                .trigger_id
                .as_deref()
                .context("Missing provider trigger ID")?,
            trigger_slug: &trigger.trigger_slug,
            connected_account_id: &trigger.connected_account_id,
            provider_user_id: &trigger.user_id,
            auth_config_id: &trigger.auth_config_id,
        };
        let toolkit = trigger
            .trigger_slug
            .split('_')
            .next()
            .unwrap_or("integration")
            .to_ascii_lowercase();
        let target = match &body.target {
            ConnectTargetSelector::Agent(id) => ryu_composio::triggers::ConnectTarget::Agent(id),
            ConnectTargetSelector::Workflow(id) => {
                ryu_composio::triggers::ConnectTarget::Workflow(id)
            }
        };
        let subscription = store
            .bind_connect_target(&owner, &identity, &toolkit, target)
            .await?;
        Ok(Ok(
            json!({"subscription":subscription,"connectTriggerId":trigger.id}),
        ))
    }
    .await;
    match result {
        Ok(Ok(value)) => (StatusCode::CREATED, Json(value)),
        Ok(Err(refusal)) => refusal,
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":error.to_string()})),
        ),
    }
}

pub(super) async fn subscribe(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    body: super::ComposioSubscribeBody,
) -> (StatusCode, Json<Value>) {
    let owner = match crate::mcp_oauth::owner_for_caller(caller.as_ref()) {
        Ok(owner) => owner,
        Err(_) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"verified user required"})),
            );
        }
    };
    if super::enforce_permission_on(
        state,
        caller,
        crate::identity_verify::permissions::AGENT_RUN,
        crate::acl::KIND_AGENT,
        &body.agent_id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"agent execution is not permitted"})),
        );
    }
    let result: Result<Value> = async {
        let record = state.agent_store.get(&body.agent_id).await?;
        if record.is_none() && state.agents.find_exact(&body.agent_id).is_none() {
            bail!("Unknown Core target agent");
        }
        let store = crate::composio_triggers::global().context("Core target store unavailable")?;
        let config = if body.config.is_null() {
            json!({})
        } else {
            body.config
        };
        let trigger = ryu_composio::service::create_trigger(
            &body.trigger_slug,
            &body.connected_account_id,
            &config,
            caller.as_ref().map(|caller| caller.user_id.as_str()),
        )
        .await
        .context("Connect is not configured")??;
        if trigger.status != "active" {
            bail!("Connect trigger is not active; reconcile its operation first");
        }
        let identity = ryu_composio::triggers::ConnectEventIdentity {
            trigger_id: trigger
                .trigger_id
                .as_deref()
                .context("Missing provider trigger identity")?,
            trigger_slug: &trigger.trigger_slug,
            connected_account_id: &trigger.connected_account_id,
            provider_user_id: &trigger.user_id,
            auth_config_id: &trigger.auth_config_id,
        };
        let subscription = store
            .bind_connect_target(
                &owner,
                &identity,
                &body.toolkit,
                ryu_composio::triggers::ConnectTarget::Agent(&body.agent_id),
            )
            .await?;
        Ok(json!({"subscription":subscription,"connectTriggerId":trigger.id}))
    }
    .await;
    match result {
        Ok(value) => (StatusCode::CREATED, Json(value)),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":error.to_string()})),
        ),
    }
}

struct CoreEventHandler {
    state: ServerState,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    authorization: Option<super::ResolvedAuthorization>,
}

fn authorize_connect_target(
    resolved: &super::ResolvedAuthorization,
    kind: &str,
    id: &str,
    now: u64,
) -> bool {
    use crate::authorization::{Capability, RoutePolicy};
    let mut bindings = resolved.bindings.clone();
    bindings.agent_id = (kind == "agent").then(|| id.to_owned());
    bindings.resource_id = Some(id.to_owned());
    bindings.plugin_id = None;
    bindings.tool_name = None;
    let capability = match kind {
        "agent" => Capability::ToolsExec,
        "workflow" => Capability::WorkflowsRun,
        _ => return false,
    };
    resolved
        .context
        .authorize(&RoutePolicy::requires([capability]), &bindings, now)
        .is_allowed()
}

#[cfg(test)]
mod credential_target_tests {
    use super::*;
    #[test]
    fn fanout_preserves_delegated_agent_and_resource_bounds() {
        use crate::authorization::*;
        let mut resolved = super::super::ResolvedAuthorization {
            context: AuthorizationContext {
                credential: CredentialKind::ManagedDelegation,
                principal: Principal::Agent {
                    agent_id: "a".into(),
                },
                capabilities: CapabilitySet::new([Capability::ToolsExec, Capability::WorkflowsRun]),
                constraints: GrantConstraints {
                    agent_id: Some("a".into()),
                    ..Default::default()
                },
                issued_at: 0,
                expires_at: Some(100),
            },
            bindings: RequestBindings {
                agent_id: Some("a".into()),
                ..Default::default()
            },
            caller: None,
            verified_user_jwt: None,
        };
        assert!(authorize_connect_target(&resolved, "agent", "a", 1));
        assert!(!authorize_connect_target(&resolved, "agent", "b", 1));
        assert!(!authorize_connect_target(&resolved, "workflow", "a", 1));
        assert!(!authorize_connect_target(&resolved, "agent", "a", 100));
        resolved.context.constraints.agent_id = None;
        resolved.context.constraints.resource_id = Some("workflow-a".into());
        assert!(authorize_connect_target(
            &resolved,
            "workflow",
            "workflow-a",
            1
        ));
        assert!(!authorize_connect_target(
            &resolved,
            "workflow",
            "workflow-b",
            1
        ));
        resolved.context = AuthorizationContext::owner(0);
        assert!(authorize_connect_target(&resolved, "agent", "b", 1));
        assert!(authorize_connect_target(
            &resolved,
            "workflow",
            "workflow-b",
            1
        ));
    }
}

/// Start only explicitly configured owners. JWT files are reread and verified
/// for every delivery; no persisted or model-supplied identity can authorize a run.
pub fn spawn_workers(state: ServerState) {
    let Ok(raw) = std::env::var("RYU_CONNECT_EVENT_WORKERS") else {
        return;
    };
    let identities = match ryu_composio::worker::parse_identities(&raw) {
        Ok(identities) => identities,
        Err(_) => {
            tracing::error!("Invalid Connect event worker configuration; no workers started");
            return;
        }
    };
    for identity in identities {
        let state = state.clone();
        tokio::spawn(async move {
            let mut failing = false;
            loop {
                let result = worker_attempt(&state, &identity).await;
                let delay = match result {
                    Ok(ryu_composio::consumer::Consumption::Acknowledged { .. }) => {
                        if failing {
                            tracing::info!(owner = %identity.owner_user_id, "Connect event worker recovered");
                        }
                        failing = false;
                        500
                    }
                    Ok(ryu_composio::consumer::Consumption::Empty) => {
                        failing = false;
                        5_000
                    }
                    Err(_) => {
                        if !failing {
                            tracing::warn!(owner = %identity.owner_user_id, "Connect event worker paused: check identity, service and target permissions");
                        }
                        failing = true;
                        30_000
                    }
                };
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
        });
    }
}

async fn worker_attempt(
    state: &ServerState,
    identity: &ryu_composio::worker::WorkerIdentity,
) -> Result<ryu_composio::consumer::Consumption> {
    use tokio::io::AsyncReadExt;
    let caller = match &identity.jwt_file {
        Some(path) => {
            let mut file = tokio::fs::File::open(path).await?;
            if !file.metadata().await?.is_file() {
                bail!("Worker identity must be a regular file");
            }
            let mut bytes = Vec::new();
            (&mut file).take(16_385).read_to_end(&mut bytes).await?;
            if bytes.len() > 16_384 {
                bail!("Worker identity exceeds its limit");
            }
            let token = std::str::from_utf8(&bytes)?.trim();
            Some(
                super::verified_caller_from_token(token)
                    .await
                    .context("Worker identity is unavailable")?,
            )
        }
        None => None,
    };
    let bound = crate::sidecar::control_plane::is_managed_node()
        || crate::sidecar::control_plane::registered_org().is_some();
    if !ryu_composio::worker::identity_matches(
        identity,
        caller.as_ref().map(|c| c.user_id.as_str()),
        bound,
    ) {
        bail!("Worker identity mismatch");
    }
    super::enforce_permission(
        state,
        &caller,
        crate::identity_verify::permissions::TOOL_EXEC,
    )
    .await
    .map_err(|_| anyhow::anyhow!("Worker execution is not permitted"))?;
    let user = caller.as_ref().map(|c| c.user_id.clone());
    let handler = CoreEventHandler {
        state: state.clone(),
        caller,
        authorization: None,
    };
    ryu_composio::consumer::consume_one(user.as_deref(), &handler).await
}

#[async_trait::async_trait]
impl ryu_composio::consumer::EventHandler for CoreEventHandler {
    async fn handle(&self, owner: &str, delivery_id: &str, payload: &Value) -> Result<()> {
        if crate::mcp_oauth::owner_for_caller(self.caller.as_ref())? != owner {
            bail!("Connect event owner mismatch");
        }
        let store =
            crate::composio_triggers::global().context("Core trigger target store unavailable")?;
        let targets = store.connect_targets(owner, payload).await?;
        if targets.is_empty() {
            if store.connect_event_was_unbound(owner, payload).await? {
                crate::sidecar::gateway::record_composio_trigger_delivery(
                    &self.state.client,
                    delivery_id,
                )
                .await?;
                return Ok(());
            }
            bail!("Connect event has no owned Core target; retaining delivery");
        }
        // An agent whose account access no longer allows the event's account
        // (switched to its own identity, or the account was dropped from its
        // allowlist) stops receiving it, whenever the binding was made. A store
        // error retains the delivery.
        let mut allowed_targets = Vec::with_capacity(targets.len());
        for target in targets {
            if target.target_kind == "agent" {
                if let Some(record) = self.state.agent_store.get(&target.agent_id).await? {
                    if !crate::agent_access::AgentAccountPolicy::from_record(&record)
                        .allows_composio_account(&target.connected_account_id)
                    {
                        tracing::info!(
                            agent = %target.agent_id,
                            subscription = %target.id,
                            "Connect event skipped: the agent may no longer use this account"
                        );
                        continue;
                    }
                }
            }
            allowed_targets.push(target);
        }
        let targets = allowed_targets;
        if targets.is_empty() {
            crate::sidecar::gateway::record_composio_trigger_delivery(
                &self.state.client,
                delivery_id,
            )
            .await?;
            return Ok(());
        }
        // Authorize the entire fan-out before issuing any effects. A delivery
        // cannot choose arbitrary targets: these rows were bound by the owner.
        for target in &targets {
            if target.target_kind == "agent"
                && !self
                    .state
                    .agent_store
                    .get(&target.agent_id)
                    .await?
                    .is_some()
                && self.state.agents.find_exact(&target.agent_id).is_none()
            {
                bail!("Connect target agent does not exist");
            }
            if target.target_kind == "workflow"
                && !self
                    .state
                    .app_store
                    .get("@ryu/workflows")
                    .await?
                    .is_some_and(|app| app.enabled)
            {
                bail!("Workflows app is disabled");
            }
            use crate::identity_verify::permissions;
            let (permission, kind, id) = match target.target_kind.as_str() {
                "agent" => (
                    permissions::AGENT_RUN,
                    crate::acl::KIND_AGENT,
                    target.agent_id.as_str(),
                ),
                "workflow" => (
                    permissions::WORKFLOW_RUN,
                    crate::acl::KIND_WORKFLOW,
                    target
                        .workflow_id
                        .as_deref()
                        .context("Missing workflow target")?,
                ),
                _ => bail!("Invalid Connect target kind"),
            };
            if self.authorization.as_ref().is_some_and(|resolved| {
                !authorize_connect_target(
                    resolved,
                    &target.target_kind,
                    id,
                    chrono::Utc::now().timestamp().max(0) as u64,
                )
            }) {
                bail!("Connect target exceeds credential authority");
            }
            if super::enforce_permission_on(&self.state, &self.caller, permission, kind, id)
                .await
                .is_err()
            {
                bail!("Connect target execution is not permitted");
            }
        }
        crate::sidecar::gateway::record_composio_trigger_delivery(&self.state.client, delivery_id)
            .await?;
        for target in &targets {
            crate::composio_host::run_connect_target(owner, delivery_id, target, payload).await?;
        }
        Ok(())
    }
}

#[utoipa::path(
    post,
    path = "/api/composio/events/consume",
    tag = "Composio",
    operation_id = "consume_connect_event",
    summary = "Consume one Connect event using the caller's owned Core targets",
    request_body = ConsumeBody,
    responses((status = 200, description = "Inbox empty or delivery durably handled", body = serde_json::Value))
)]
pub async fn consume(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Extension(authorization): Extension<super::ResolvedAuthorization>,
    Json(_body): Json<ConsumeBody>,
) -> (StatusCode, Json<Value>) {
    if !ryu_composio::service::is_configured() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"code":"connect_unavailable"})),
        );
    }
    if crate::mcp_oauth::owner_for_caller(caller.as_ref()).is_err() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"code":"verified_user_required"})),
        );
    }
    let user_id = caller.as_ref().map(|caller| caller.user_id.clone());
    let handler = CoreEventHandler {
        state,
        caller,
        authorization: Some(authorization),
    };
    match ryu_composio::consumer::consume_one(user_id.as_deref(), &handler).await {
        Ok(ryu_composio::consumer::Consumption::Empty) => {
            (StatusCode::OK, Json(json!({"status":"empty"})))
        }
        Ok(ryu_composio::consumer::Consumption::Acknowledged { delivery_id }) => (
            StatusCode::OK,
            Json(json!({"status":"acknowledged","deliveryId":delivery_id})),
        ),
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(
                json!({"code":"event_not_acknowledged","error":"Check the target binding, run permissions, and Core workflow history before retrying."}),
            ),
        ),
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    #[test]
    fn binding_request_cannot_supply_identity_or_provider_overrides() {
        let valid = json!({"connectTriggerId":"00000000-0000-4000-8000-000000000001","target":{"kind":"workflow","id":"workflow-a"}});
        assert!(serde_json::from_value::<BindConnectTargetBody>(valid.clone()).is_ok());
        for field in [
            "userId",
            "tenantId",
            "authConfigId",
            "connectedAccountId",
            "leaseToken",
        ] {
            let mut value = valid.clone();
            value[field] = json!("override");
            assert!(serde_json::from_value::<BindConnectTargetBody>(value).is_err());
        }
        let mut target_override = valid.clone();
        target_override["target"]["owner"] = json!("other-user");
        assert!(serde_json::from_value::<BindConnectTargetBody>(target_override).is_err());
        let mut invalid_kind = valid;
        invalid_kind["target"]["kind"] = json!("command");
        assert!(serde_json::from_value::<BindConnectTargetBody>(invalid_kind).is_err());
        assert!(serde_json::from_value::<ConsumeBody>(json!({})).is_ok());
        assert!(serde_json::from_value::<ConsumeBody>(json!({"userId":"other"})).is_err());
    }
}
