//! Broker CA management and per-session log routes.
//!
//! CA status needs `list` on `sys/broker`; rotating or importing the CA needs
//! `admin` on it. A session's sealed log is readable by its minter or with
//! `list` on `sys/broker`, like the request log.

use super::*;

/// GET /api/vault/broker/ca.
#[utoipa::path(get, path = "/api/vault/broker/ca", tag = "Vault",
    operation_id = "broker_ca_info",
    summary = "Broker CA status: fingerprint, subject, expiry, source, and a still-trusted previous CA (list on sys/broker)",
    responses((status = 200, description = "CA status (null before first use)", body = serde_json::Value)))]
pub async fn ca_info(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::List));
    match ca::info(ctx.store).await {
        Ok(info) => respond(json!({ "ca": info })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/broker/ca/rotate.
#[utoipa::path(post, path = "/api/vault/broker/ca/rotate", tag = "Vault",
    operation_id = "broker_ca_rotate",
    summary = "Replace the broker CA with a new generated one; the old one stays trusted for 24 hours (admin on sys/broker)",
    responses((status = 200, description = "The new CA", body = serde_json::Value)))]
pub async fn ca_rotate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::Admin));
    match ca::rotate(ctx.store, &ctx.actor()).await {
        Ok(info) => respond(json!({ "ca": info })),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaImportBody {
    certificate: String,
    private_key: String,
}

/// PUT /api/vault/broker/ca.
#[utoipa::path(put, path = "/api/vault/broker/ca", tag = "Vault",
    operation_id = "broker_ca_import",
    summary = "Use an operator CA (PEM certificate and PKCS#8 key) for broker interception; the key is sealed and never returned (admin on sys/broker)",
    request_body = serde_json::Value,
    responses((status = 200, description = "The imported CA", body = serde_json::Value)))]
pub async fn ca_import(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::Admin));
    let body: CaImportBody = tri!(parse_body(body));
    match ca::import(
        ctx.store,
        &body.certificate,
        &body.private_key,
        &ctx.actor(),
    )
    .await
    {
        Ok(info) => respond(json!({ "ca": info })),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct SessionLogQuery {
    #[serde(default)]
    limit: Option<usize>,
}

/// Whether `ctx` may read `session`'s log: its minter, or `list` on
/// `sys/broker`.
pub(super) fn may_read_session_log(ctx: &Ctx, session: &sessions::BrokerSession) -> bool {
    session.minted_by == minted_by(ctx) || ctx.sys_caps(SYS_BROKER).contains(&Capability::List)
}

/// GET /api/vault/broker/sessions/{id}/log.
#[utoipa::path(get, path = "/api/vault/broker/sessions/{id}/log", tag = "Vault",
    operation_id = "broker_session_log",
    summary = "A session's sealed request log, newest first: request metadata and MCP tool calls, never values (its minter, or list on sys/broker)",
    params(
        ("id" = String, Path, description = "Session id"),
        ("limit" = Option<usize>, Query, description = "Entries (default 200, max 2048)"),
    ),
    responses((status = 200, description = "Entries", body = serde_json::Value)))]
pub async fn session_log(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<SessionLogQuery>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    let session = {
        let conn = ctx.store.conn.lock().await;
        sessions::get(&conn, &id)
    };
    // A pruned session's log can outlive its row: only broker listers read it.
    let allowed = match session {
        Ok(Some(session)) => may_read_session_log(&ctx, &session),
        Ok(None) => ctx.sys_caps(SYS_BROKER).contains(&Capability::List),
        Err(error) => return vault_error(error),
    };
    if !allowed {
        return super::super::vault_api::denied(Capability::List, SYS_BROKER);
    }
    match broker::session_log::read(ctx.store, &id, query.limit.unwrap_or(200)).await {
        Ok(entries) => respond(json!({ "session": id, "entries": entries })),
        Err(error) => vault_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_minter_or_a_broker_lister_reads_a_session_log() {
        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        let session = |minted_by: &str| sessions::BrokerSession {
            id: "bvs_1".into(),
            environment: "default".into(),
            services: vec!["gh".into()],
            label: String::new(),
            minted_by: minted_by.into(),
            created_at: 0,
            expires_at: i64::MAX,
            revoked_at: None,
            minted_token: None,
            minter_scope: None,
        };
        let alice = Ctx::test_member(store, "alice", Vec::new());
        assert!(may_read_session_log(&alice, &session("user:alice")));
        assert!(!may_read_session_log(&alice, &session("user:bob")));
        assert!(!may_read_session_log(&alice, &session("machine:m1")));
        let lister = Ctx::test_member(
            store,
            "carol",
            vec![Policy {
                name: "p".into(),
                description: String::new(),
                rules: vec![crate::vault::policy::PolicyRule {
                    path: SYS_BROKER.into(),
                    capabilities: vec![Capability::List],
                    ..Default::default()
                }],
            }],
        );
        assert!(may_read_session_log(&lister, &session("machine:m1")));
    }
}
