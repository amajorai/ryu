//! Agent broker routes: sessions, discovery, proposals, and card approvals.
//! test-exempt: moved out of vault_broker_api.rs; tests_agent.rs drives these routes through the router.

use super::*;
use crate::vault::broker::oauth::OAuthStatus;

// ── Agent routes ──────────────────────────────────────────────────────────

/// POST /api/vault/agent/broker/sessions.
#[utoipa::path(post, path = "/api/vault/agent/broker/sessions", tag = "Vault",
    summary = "Mint a broker session with a machine token (use on each sys/broker/<service>)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Token (shown once), session, and proxy environment", body = serde_json::Value)))]
pub async fn agent_create_session(headers: HeaderMap, Json(body): Json<SessionBody>) -> Response {
    let store = tri!(store());
    let (principal, policies) = tri!(machine_only(&headers).await);
    {
        let conn = store.conn.lock().await;
        if let Err(error) = sessions::check_minting_token(&conn, &principal.accessor) {
            return vault_error(error);
        }
    }
    let environment = tri!(session_environment(&body));
    let template_context =
        crate::vault::policy_ext::TemplateContext::from_subjects(&[principal.subject()]);
    tri!(
        check_session_services(store, &environment, &body.services, |name| {
            crate::vault::policy::evaluate_with(
                &CapabilitySet::new(),
                &policies,
                &service_key(name),
                &template_context,
            )
            .contains(&Capability::Use)
        })
        .await
    );
    let request = sessions::MintRequest {
        environment,
        services: body.services,
        label: body.label,
        ttl_secs: body.ttl_secs,
        minted_by: principal.subject(),
        not_after: Some(principal.expires_at),
        // The session lives only while this token does, and its credential
        // resolution applies this machine's policies.
        minted_token: Some(principal.accessor.clone()),
        minter_scope: None,
    };
    mint_session(store, &principal.actor(), request).await
}

/// Discovery for one agent: the services it may broker through, their
/// placeholders, and the environment's skills. Never values.
pub(crate) fn discovery(
    services: &[services::BrokerService],
    settings: &settings::EnvironmentSettings,
    oauth: &BTreeMap<String, OAuthStatus>,
    may_use: impl Fn(&services::BrokerService) -> bool,
) -> Value {
    let listed: Vec<Value> = services
        .iter()
        .filter(|service| service.input.enabled && may_use(service))
        .map(|service| {
            let input = &service.input;
            let mut entry = json!({
                "name": input.name,
                "host": input.host,
                "port": input.port,
                "pathPrefix": input.path_prefix,
                "auth": input.auth.kind(),
                "injectedHeaders": input.auth.header_names(),
                "placeholders": input.substitutions.iter().map(|s| json!({
                    "placeholder": s.placeholder, "in": s.surfaces,
                })).collect::<Vec<_>>(),
                "description": input.description,
                "notes": input.notes,
            });
            if let Some(status) = oauth.get(&input.name) {
                entry["oauth"] = json!(status);
            }
            entry
        })
        .collect();
    json!({
        "environment": settings.environment,
        "unmatchedHostPolicy": settings.unmatched_host_policy,
        "skills": settings.skills,
        "services": listed,
        "proxy": proxy_info(),
        "proposalsEndpoint": broker::proxy::PROPOSALS_ENDPOINT,
    })
}

/// GET /api/vault/agent/broker/discover.
#[utoipa::path(get, path = "/api/vault/agent/broker/discover", tag = "Vault",
    summary = "List brokered services and placeholders for an agent (machine token or broker session)",
    params(("environment" = Option<String>, Query, description = "Environment (machine tokens only)")),
    responses((status = 200, description = "Discovery document", body = serde_json::Value)))]
pub async fn agent_discover(headers: HeaderMap, Query(query): Query<EnvironmentQuery>) -> Response {
    let store = tri!(store());
    let agent = tri!(agent(&headers).await);
    let environment = match &agent {
        Agent::Session(session) => session.environment.clone(),
        Agent::Machine { .. } => query
            .environment
            .unwrap_or_else(crate::vault::active_environment),
    };
    let view = {
        let conn = store.conn.lock().await;
        services::list(&conn, Some(&environment))
            .and_then(|services| Ok((services, settings::get(&conn, &environment)?)))
    };
    let (services, settings) = match view {
        Ok(view) => view,
        Err(error) => return vault_error(error),
    };
    let visible: Vec<_> = services
        .into_iter()
        .filter(|service| service.input.enabled && agent.may_use(service))
        .collect();
    // A session uses its minter's OAuth connections; a machine token the
    // node's local owner (none on a shared node).
    let user = match &agent {
        Agent::Session(session) => session.user_id(),
        Agent::Machine { .. } => None,
    };
    let owner = broker::oauth::owner_for_session(user).ok();
    let oauth =
        broker::oauth::statuses(&broker::oauth::CoreOAuthTokens, owner.as_deref(), &visible).await;
    respond(discovery(&visible, &settings, &oauth, |_| true))
}

/// POST /api/vault/agent/broker/proposals.
#[utoipa::path(post, path = "/api/vault/agent/broker/proposals", tag = "Vault",
    summary = "Propose a broker service or credential (machine token or broker session)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Pending proposal", body = serde_json::Value)))]
pub async fn agent_create_proposal(headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let store = tri!(store());
    let agent = tri!(agent(&headers).await);
    let input: proposals::ProposalInput = tri!(parse_body(body));
    let environment = match &agent {
        Agent::Session(session) => session.environment.clone(),
        Agent::Machine { .. } => input
            .environment
            .clone()
            .unwrap_or_else(crate::vault::active_environment),
    };
    if !crate::vault::is_valid_environment(&environment) {
        return invalid_request("invalid environment");
    }
    let conn = store.conn.lock().await;
    match proposals::create(
        &conn,
        input,
        &environment,
        &agent.subject(),
        &agent.accountable(),
    ) {
        Ok(proposal) => {
            store.audit_locked(
                &conn,
                &AuditEntry::new(&agent.actor(), "broker.proposal.create", "ok")
                    .details(json!({ "proposal": proposal.id, "environment": environment })),
            );
            respond(json!({ "proposal": proposal }))
        }
        Err(error) => vault_error(error),
    }
}

/// Whether `agent` may poll `proposal`: it filed it, or it is a
/// credential-use request for the agent's broker consumer (one request is
/// shared by every session the same principal minted).
pub(super) fn may_poll(agent: &Agent, proposal: &proposals::Proposal) -> bool {
    proposal.requested_by == agent.subject()
        || proposal
            .credential_use
            .as_ref()
            .is_some_and(|credential_use| {
                credential_use.subject
                    == crate::vault::password_managers::broker_subject(&agent.accountable())
            })
}

/// GET /api/vault/agent/broker/proposals/{id}.
#[utoipa::path(get, path = "/api/vault/agent/broker/proposals/{id}", tag = "Vault",
    summary = "Poll a proposal the caller filed, or a credential-use request for its broker consumer",
    params(("id" = String, Path, description = "Proposal id")),
    responses((status = 200, description = "Proposal", body = serde_json::Value)))]
pub async fn agent_get_proposal(headers: HeaderMap, Path(id): Path<String>) -> Response {
    let store = tri!(store());
    let agent = tri!(agent(&headers).await);
    let conn = store.conn.lock().await;
    match proposals::get(&conn, &id) {
        Ok(Some(proposal)) if may_poll(&agent, &proposal) => {
            respond(json!({ "proposal": proposal }))
        }
        Ok(_) => json_error(
            StatusCode::NOT_FOUND,
            format!("vault_not_found: proposal `{id}`"),
        ),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/agent/cards/approvals/{id}.
#[utoipa::path(get, path = "/api/vault/agent/cards/approvals/{id}", tag = "Vault",
    summary = "Poll a card spend approval the caller's broker session or agent requested",
    params(("id" = String, Path, description = "Approval id")),
    responses((status = 200, description = "Approval status (no card values)", body = serde_json::Value)))]
pub async fn agent_get_card_approval(headers: HeaderMap, Path(id): Path<String>) -> Response {
    let store = tri!(store());
    let agent = tri!(agent(&headers).await);
    let subject = agent.subject();
    let accountable = agent.accountable();
    let conn = store.conn.lock().await;
    match crate::vault::items::cards::get(&conn, &id) {
        Ok(Some(approval))
            if approval.requester == subject
                || approval.agent == subject
                || approval.agent == accountable =>
        {
            respond(json!({
                "approval": {
                    "id": approval.id,
                    "status": approval.status,
                    "key": approval.key,
                    "brand": approval.brand,
                    "last4": approval.last4,
                    "merchantHost": approval.merchant_host,
                    "mode": approval.mode,
                    "grantSubject": approval.grant_subject,
                    "maxUses": approval.max_uses,
                    "uses": approval.uses,
                    "requestExpiresAt": approval.request_expires_at,
                    "grantExpiresAt": approval.grant_expires_at,
                }
            }))
        }
        Ok(_) => json_error(
            StatusCode::NOT_FOUND,
            format!("vault_not_found: card approval `{id}`"),
        ),
        Err(error) => vault_error(error),
    }
}
