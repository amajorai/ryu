//! Broker environment settings, session, and request-log routes.
//! test-exempt: moved out of vault_broker_api.rs; tests.rs drives these routes through the router.

use super::*;

// ── Environment settings ──────────────────────────────────────────────────

/// GET /api/vault/broker/environments/{env}.
#[utoipa::path(get, path = "/api/vault/broker/environments/{env}", tag = "Vault",
    operation_id = "broker_get_environment",
    summary = "Broker settings of one environment",
    params(("env" = String, Path, description = "Environment slug")),
    responses((status = 200, description = "Settings", body = serde_json::Value)))]
pub async fn get_environment(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(environment): Path<String>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::List));
    let conn = ctx.store.conn.lock().await;
    match settings::get(&conn, &environment) {
        Ok(settings) => respond(json!({ "settings": settings })),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentBody {
    #[serde(default)]
    unmatched_host_policy: settings::UnmatchedHostPolicy,
    /// Absent means off: a client that predates the setting turns it off
    /// rather than leaving runs brokered behind its back.
    #[serde(default)]
    broker_runs_under_deny: bool,
    #[serde(default)]
    skills: String,
}

/// PUT /api/vault/broker/environments/{env}.
#[utoipa::path(put, path = "/api/vault/broker/environments/{env}", tag = "Vault",
    operation_id = "broker_put_environment",
    summary = "Set an environment's unmatched-host policy, agent-run opt-in and agent skills (admin on sys/broker)",
    params(("env" = String, Path, description = "Environment slug")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value)))]
pub async fn put_environment(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(environment): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::Admin));
    let body: EnvironmentBody = tri!(parse_body(body));
    let saved = {
        let conn = ctx.store.conn.lock().await;
        settings::save(
            &conn,
            &environment,
            body.unmatched_host_policy,
            body.broker_runs_under_deny,
            &body.skills,
        )
    };
    match saved {
        Ok(settings) => {
            audit(
                ctx.store,
                &ctx.actor(),
                "broker.environment.update",
                json!({
                    "environment": environment,
                    "unmatchedHostPolicy": settings.unmatched_host_policy,
                    "brokerRunsUnderDeny": settings.broker_runs_under_deny,
                }),
            )
            .await;
            respond(json!({ "settings": settings }))
        }
        Err(error) => vault_error(error),
    }
}

// ── Sessions ──────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBody {
    #[serde(default)]
    pub(super) environment: Option<String>,
    #[serde(default)]
    pub(super) services: Vec<String>,
    #[serde(default)]
    pub(super) label: String,
    #[serde(default)]
    pub(super) ttl_secs: Option<i64>,
}

/// Check that every requested service exists in the environment and that the
/// caller holds `use` on it.
pub(super) async fn check_session_services(
    store: &PluginSecretStore,
    environment: &str,
    names: &[String],
    may_use: impl Fn(&str) -> bool,
) -> Result<(), Response> {
    let known = {
        let conn = store.conn.lock().await;
        services::list(&conn, Some(environment)).map_err(vault_error)?
    };
    for name in names {
        if !known.iter().any(|service| service.name() == name) {
            return Err(invalid_request(&format!(
                "no broker service `{name}` in environment `{environment}`"
            )));
        }
        if !may_use(name) {
            return Err(super::super::vault_api::denied(
                Capability::Use,
                &service_key(name),
            ));
        }
    }
    Ok(())
}

/// Mint a session and render the response (token shown once, plus the
/// child-process environment when the listener is up).
pub(super) async fn mint_session(
    store: &PluginSecretStore,
    actor: &AuditActor,
    request: sessions::MintRequest,
) -> Response {
    let minted = {
        let conn = store.conn.lock().await;
        sessions::mint(&conn, request)
    };
    let (token, session) = match minted {
        Ok(minted) => minted,
        Err(error) => return vault_error(error),
    };
    audit(
        store,
        actor,
        "broker.session.create",
        json!({ "session": session.id, "environment": session.environment, "services": session.services }),
    )
    .await;
    let proxy = match broker::listening_port() {
        Some(port) => match ca::certificate_pem(store)
            .await
            .and_then(|pem| ca::write_bundle(&pem))
        {
            Ok(files) => json!({
                "url": format!("http://127.0.0.1:{port}"),
                "port": port,
                "caPath": files.ca_only,
                "caBundlePath": files.combined,
                "caUrl": CA_PATH,
                "env": broker::proxy_env(&token, port, &files),
            }),
            Err(error) => return vault_error(error),
        },
        None => Value::Null,
    };
    respond(json!({ "token": token, "session": session, "proxy": proxy }))
}

pub(super) fn session_environment(body: &SessionBody) -> Result<String, Response> {
    let environment = body
        .environment
        .clone()
        .unwrap_or_else(crate::vault::active_environment);
    if crate::vault::is_valid_environment(&environment) {
        Ok(environment)
    } else {
        Err(invalid_request("invalid environment"))
    }
}

/// POST /api/vault/broker/sessions.
#[utoipa::path(post, path = "/api/vault/broker/sessions", tag = "Vault",
    summary = "Mint a broker session (use on each sys/broker/<service>)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Token (shown once), session, and proxy environment", body = serde_json::Value)))]
pub async fn create_session(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<SessionBody>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    let environment = tri!(session_environment(&body));
    tri!(
        check_session_services(ctx.store, &environment, &body.services, |name| {
            ctx.sys_caps(&service_key(name)).contains(&Capability::Use)
        })
        .await
    );
    let request = sessions::MintRequest {
        environment,
        services: body.services,
        label: body.label,
        ttl_secs: body.ttl_secs,
        minted_by: minted_by(&ctx),
        not_after: None,
        minted_token: None,
        // Card substitution later evaluates the minter's own `use` on each
        // card under these subjects.
        minter_scope: Some(sessions::MinterScope {
            subjects: ctx.subjects(),
            manager: ctx.manager,
        }),
    };
    mint_session(ctx.store, &ctx.actor(), request).await
}

/// GET /api/vault/broker/sessions.
#[utoipa::path(get, path = "/api/vault/broker/sessions", tag = "Vault",
    summary = "List live broker sessions (admin on sys/broker)",
    responses((status = 200, description = "Sessions (no tokens)", body = serde_json::Value)))]
pub async fn list_sessions(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::Admin));
    let conn = ctx.store.conn.lock().await;
    match sessions::list(&conn) {
        Ok(items) => respond(json!({ "sessions": items })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/broker/sessions/{id}.
#[utoipa::path(delete, path = "/api/vault/broker/sessions/{id}", tag = "Vault",
    summary = "Revoke a broker session (its minter, or admin on sys/broker)",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, description = "Revoked", body = serde_json::Value)))]
pub async fn revoke_session(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    let conn = ctx.store.conn.lock().await;
    let session = match sessions::get(&conn, &id) {
        Ok(Some(session)) => session,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("vault_not_found: broker session `{id}`"),
            )
        }
        Err(error) => return vault_error(error),
    };
    tri!(authorize_revoke(&ctx, &session));
    match sessions::revoke(&conn, &id) {
        Ok(revoked) => {
            ctx.store.audit_locked(
                &conn,
                &AuditEntry::new(&ctx.actor(), "broker.session.revoke", "ok")
                    .details(json!({ "session": id })),
            );
            respond(json!({ "revoked": revoked }))
        }
        Err(error) => vault_error(error),
    }
}

// ── Logs ──────────────────────────────────────────────────────────────────

/// GET /api/vault/broker/logs.
#[utoipa::path(get, path = "/api/vault/broker/logs", tag = "Vault",
    summary = "Brokered request log, newest first (list on sys/broker)",
    params(
        ("environment" = Option<String>, Query, description = "Environment"),
        ("service" = Option<String>, Query, description = "Service name"),
        ("sessionId" = Option<String>, Query, description = "Session id"),
        ("statusBucket" = Option<String>, Query, description = "2xx, 3xx, 4xx, or 5xx"),
        ("before" = Option<i64>, Query, description = "Rows with an id below this"),
        ("limit" = Option<i64>, Query, description = "Page size (max 200)"),
    ),
    responses((status = 200, description = "Rows", body = serde_json::Value)))]
pub async fn list_logs(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(filter): Query<log::LogFilter>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::List));
    let conn = ctx.store.conn.lock().await;
    match log::list(&conn, &filter) {
        Ok(rows) => respond(json!({ "logs": rows })),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/broker/discovered-hosts.
#[utoipa::path(get, path = "/api/vault/broker/discovered-hosts", tag = "Vault",
    summary = "Hosts agents requested without a matching service (list on sys/broker)",
    params(("environment" = Option<String>, Query, description = "Environment")),
    responses((status = 200, description = "Hosts", body = serde_json::Value)))]
pub async fn discovered_hosts(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<EnvironmentQuery>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::List));
    let conn = ctx.store.conn.lock().await;
    match log::discovered_hosts(&conn, query.environment.as_deref()) {
        Ok(hosts) => respond(json!({ "hosts": hosts })),
        Err(error) => vault_error(error),
    }
}
