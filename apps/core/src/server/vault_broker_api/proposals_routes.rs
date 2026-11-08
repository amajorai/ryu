//! Broker proposal routes (human side).
//! test-exempt: moved out of vault_broker_api.rs; tests.rs and tests_agent.rs drive these routes through the router.

use super::*;

// ── Proposals (human side) ────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
pub struct ProposalListQuery {
    #[serde(default)]
    status: Option<proposals::ProposalStatus>,
}

/// GET /api/vault/broker/proposals.
#[utoipa::path(get, path = "/api/vault/broker/proposals", tag = "Vault",
    summary = "List agent proposals (list on sys/broker; credential-use requests only for accounts the caller can see)",
    params(("status" = Option<String>, Query, description = "pending, approved, rejected, expired")),
    responses((status = 200, description = "Proposals", body = serde_json::Value)))]
pub async fn list_proposals(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<ProposalListQuery>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::List));
    let conn = ctx.store.conn.lock().await;
    match proposals::list(&conn, query.status) {
        Ok(items) => respond(json!({ "proposals": visible_proposals(&ctx, items) })),
        Err(error) => vault_error(error),
    }
}

/// A password-manager credential-use request is listed only to callers who
/// can see its account, as on the password-manager approvals route.
pub(super) fn visible_proposals(
    ctx: &Ctx,
    items: Vec<proposals::Proposal>,
) -> Vec<proposals::Proposal> {
    items
        .into_iter()
        .filter(|proposal| {
            proposal
                .credential_use
                .as_ref()
                .map_or(true, |credential_use| {
                    super::super::vault_pm_api::visible(ctx, &credential_use.account)
                })
        })
        .collect()
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionBody {
    /// Values for requested credentials, keyed by their `secret:` reference.
    #[serde(default)]
    values: BTreeMap<String, String>,
    #[serde(default)]
    note: String,
    /// For a password-manager credential-use request: `once`, `1h`, `24h`,
    /// or `30d` (the default).
    #[serde(default)]
    grant: Option<GrantMode>,
}

/// Validate supplied values and the approver's grants before anything is
/// written.
pub(super) async fn plan_values(
    ctx: &Ctx,
    proposal: &proposals::Proposal,
    values: &BTreeMap<String, String>,
) -> Result<Vec<(SecretCoords, String)>, Response> {
    let mut planned = Vec::with_capacity(values.len());
    for (reference, value) in values {
        if !proposal
            .credentials
            .iter()
            .any(|credential| &credential.reference == reference)
        {
            return Err(invalid_request(&format!(
                "`{reference}` is not a credential this proposal requested"
            )));
        }
        if value.trim().is_empty() {
            return Err(invalid_request(&format!(
                "value for `{reference}` is empty"
            )));
        }
        let coords = node_coords(ctx, reference, &proposal.environment)?;
        ctx.require(&coords, Capability::Write)?;
        // The approver's write grant may constrain the value
        // (`allowedParameters`/`deniedParameters`/`requiredParameters`);
        // enforce it here exactly as a direct write does.
        ctx.require_write_parameters(&coords, Some(value))?;
        let protected = ctx
            .store
            .environment(&coords.environment)
            .await
            .map_err(vault_error)?
            .is_some_and(|environment| environment.protected);
        if protected {
            return Err(json_error(
                StatusCode::CONFLICT,
                format!(
                    "vault_conflict: `{}` is protected; submit the value as a change request and approve without values",
                    coords.environment
                ),
            ));
        }
        planned.push((coords, value.clone()));
    }
    Ok(planned)
}

/// POST /api/vault/broker/proposals/{id}/approve.
#[utoipa::path(post, path = "/api/vault/broker/proposals/{id}/approve", tag = "Vault",
    summary = "Approve an agent proposal, optionally supplying credential values (admin on sys/broker and each service, use on each service credential); a password-manager credential-use request takes `grant` (once, 1h, 24h, 30d) and admin on its account",
    params(("id" = String, Path, description = "Proposal id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Approved", body = serde_json::Value)))]
pub async fn approve_proposal(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<DecisionBody>>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::Admin));
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let proposal = {
        let conn = ctx.store.conn.lock().await;
        tri!(proposals::pending(&conn, &id).map_err(vault_error))
    };
    if proposal.credential_use.is_some() {
        return super::super::vault_pm_api::approve_credential_use(
            &ctx,
            &id,
            body.grant.unwrap_or_default(),
            &body.note,
        )
        .await;
    }
    let mut proposal = proposal;
    for service in &mut proposal.services {
        tri!(authorize_service_write(&ctx, service).await);
    }
    let planned = tri!(plan_values(&ctx, &proposal, &body.values).await);
    let actor = ctx.actor();
    for (coords, value) in planned {
        let written = ctx
            .store
            .write_secret(WriteRequest {
                coords,
                value: Some(&value),
                patch: Default::default(),
                actor: &actor,
                source: VersionSource::Write,
                expected_version: None,
            })
            .await;
        if let Err(error) = written {
            return vault_error(error);
        }
    }
    let applied = {
        let conn = ctx.store.conn.lock().await;
        apply_proposal(&conn, &proposal, &minted_by(&ctx), &body.note)
    };
    match applied {
        Ok(()) => {
            audit(
                ctx.store,
                &actor,
                "broker.proposal.approve",
                json!({
                    "proposal": id,
                    "services": proposal.services.iter().map(|s| &s.name).collect::<Vec<_>>(),
                    "credentials": body.values.keys().collect::<Vec<_>>(),
                }),
            )
            .await;
            respond(json!({ "approved": true, "proposal": id }))
        }
        Err(error) => vault_error(error),
    }
}

/// Create the proposal's services and mark it approved in one transaction.
pub(super) fn apply_proposal(
    conn: &rusqlite::Connection,
    proposal: &proposals::Proposal,
    decided_by: &str,
    note: &str,
) -> anyhow::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for service in &proposal.services {
        services::insert(&tx, service.clone())?;
    }
    if !proposals::decide(
        &tx,
        &proposal.id,
        proposals::ProposalStatus::Approved,
        decided_by,
        note,
    )? {
        return Err(
            crate::vault::VaultError::Conflict("proposal is no longer pending".into()).into(),
        );
    }
    tx.commit()?;
    Ok(())
}

/// POST /api/vault/broker/proposals/{id}/reject.
#[utoipa::path(post, path = "/api/vault/broker/proposals/{id}/reject", tag = "Vault",
    summary = "Reject an agent proposal (admin on sys/broker; a password-manager credential-use request also needs admin on its account)",
    params(("id" = String, Path, description = "Proposal id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Rejected", body = serde_json::Value)))]
pub async fn reject_proposal(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<DecisionBody>>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    let note = body.map(|Json(body)| body.note).unwrap_or_default();
    reject_inner(&ctx, &id, &note).await
}

pub(super) async fn reject_inner(ctx: &Ctx, id: &str, note: &str) -> Response {
    tri!(ctx.require_sys(SYS_BROKER, Capability::Admin));
    let credential_use = {
        let conn = ctx.store.conn.lock().await;
        tri!(proposals::get(&conn, id).map_err(vault_error))
            .is_some_and(|proposal| proposal.credential_use.is_some())
    };
    if credential_use {
        // Needs admin on the account and writes its own audit row.
        return super::super::vault_pm_api::reject_credential_use(ctx, id, note).await;
    }
    let conn = ctx.store.conn.lock().await;
    match proposals::decide(
        &conn,
        id,
        proposals::ProposalStatus::Rejected,
        &minted_by(ctx),
        note,
    ) {
        Ok(true) => {
            ctx.store.audit_locked(
                &conn,
                &AuditEntry::new(&ctx.actor(), "broker.proposal.reject", "ok")
                    .details(json!({ "proposal": id })),
            );
            respond(json!({ "rejected": true }))
        }
        Ok(false) => json_error(
            StatusCode::CONFLICT,
            format!("vault_conflict: proposal `{id}` is not pending"),
        ),
        Err(error) => vault_error(error),
    }
}
