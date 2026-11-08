//! Audit, seal, keys, and shared-value migration.
//!
//! test-exempt: audit, seal, and migration routes moved unchanged out of the former single-file `vault_api`; covered by the vault audit and seal route tests.

use super::*;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    #[serde(default)]
    pub(crate) before: Option<i64>,
    #[serde(default)]
    pub(crate) limit: Option<usize>,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) action: Option<String>,
    #[serde(default)]
    pub(crate) actor_id: Option<String>,
    #[serde(default)]
    pub(crate) environment: Option<String>,
}

/// GET /api/vault/audit pages the vault audit log (newest first).
#[utoipa::path(get, path = "/api/vault/audit", tag = "Vault",
    summary = "Page the vault audit log (admin)",
    params(
        ("before" = Option<i64>, Query, description = "Return rows with seq below this"),
        ("limit" = Option<usize>, Query, description = "Page size (max 500)"),
        ("name" = Option<String>, Query, description = "Secret name filter"),
        ("action" = Option<String>, Query, description = "Action filter"),
        ("actorId" = Option<String>, Query, description = "Actor filter"),
        ("environment" = Option<String>, Query, description = "Environment filter"),
    ),
    responses((status = 200, description = "Audit rows (never values)", body = serde_json::Value)))]
pub async fn list_audit(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<AuditQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/audit", Capability::Admin) {
        return response;
    }
    let filter = AuditFilter {
        before_seq: query.before,
        limit: query.limit.unwrap_or(100),
        name: query.name,
        action: query.action,
        actor_id: query.actor_id,
        environment: query.environment,
    };
    let conn = ctx.store.conn.lock().await;
    match crate::vault::audit::list(&conn, &filter) {
        Ok(rows) => {
            let next = rows.last().map(|row| row.seq);
            respond(json!({ "events": rows, "nextBefore": next }))
        }
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/audit/verify checks the HMAC chain.
#[utoipa::path(get, path = "/api/vault/audit/verify", tag = "Vault",
    summary = "Verify the vault audit log's tamper-evident chain (admin)",
    responses((status = 200, description = "Verification report", body = serde_json::Value)))]
pub async fn verify_audit(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/audit", Capability::Admin) {
        return response;
    }
    let conn = ctx.store.conn.lock().await;
    match crate::vault::audit::verify(&conn, &ctx.store.audit_key) {
        Ok(report) => respond(json!({ "report": report })),
        Err(error) => vault_error(error),
    }
}

// ── Seal, keys, migration ─────────────────────────────────────────────────

/// GET /api/vault/sys/status reports seal state and key versions.
#[utoipa::path(get, path = "/api/vault/sys/status", tag = "Vault",
    summary = "Seal status and data-key versions",
    responses((status = 200, description = "Status", body = serde_json::Value)))]
pub async fn sys_status() -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    respond(json!({
        "seal": store.keyring.status(),
        "activeEnvironment": crate::vault::active_environment(),
        "sharedRemote": crate::vault::shared::is_enabled(),
    }))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SysBody {
    #[serde(default)]
    pub(crate) share: Option<String>,
    #[serde(default)]
    pub(crate) shares: Option<u8>,
    #[serde(default)]
    pub(crate) threshold: Option<u8>,
}

/// POST /api/vault/sys/{action}: `seal`, `unseal`, `init-shamir`,
/// `migrate-auto`, `rotate`.
#[utoipa::path(post, path = "/api/vault/sys/{action}", tag = "Vault",
    summary = "Seal, unseal (key share), switch seal mode, or rotate the data key (admin)",
    params(("action" = String, Path, description = "`seal`, `unseal`, `init-shamir`, `migrate-auto`, or `rotate`")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Seal status", body = serde_json::Value)))]
pub async fn sys_action(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(action): Path<String>,
    body: Option<Json<SysBody>>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/seal", Capability::Admin) {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let actor = ctx.actor();
    let keyring = &ctx.store.keyring;
    let audit = |outcome: &str| AuditEntry::new(&actor, &format!("sys.{action}"), outcome);
    let result: anyhow::Result<Value> = match action.as_str() {
        "seal" => {
            keyring.seal();
            Ok(json!({ "seal": keyring.status() }))
        }
        "unseal" => {
            let conn = ctx.store.conn.lock().await;
            let status = match body.share.as_deref() {
                Some(share) => keyring.submit_share(&conn, share),
                None => keyring.unseal_auto(&conn),
            };
            status.map(|status| json!({ "seal": status }))
        }
        "init-shamir" => {
            // Shamir mode cannot decrypt legacy version-0 rows, so move every
            // row onto a data key first (creating one if the vault has none).
            let prepared: anyhow::Result<usize> = async {
                if keyring.active_version() == crate::vault::keyring::LEGACY_KEY_VERSION {
                    let conn = ctx.store.conn.lock().await;
                    keyring.rotate(&conn)?;
                }
                ctx.store.rewrap_all(&actor).await
            }
            .await;
            match prepared {
                Ok(_) => {
                    let conn = ctx.store.conn.lock().await;
                    keyring
                        .init_shamir(&conn, body.shares.unwrap_or(5), body.threshold.unwrap_or(3))
                        .map(|shares| json!({ "shares": shares, "seal": keyring.status() }))
                }
                Err(error) => Err(error),
            }
        }
        "migrate-auto" => {
            let conn = ctx.store.conn.lock().await;
            keyring
                .migrate_to_auto(&conn)
                .map(|()| json!({ "seal": keyring.status() }))
        }
        "rotate" => {
            let rotated = {
                let conn = ctx.store.conn.lock().await;
                keyring.rotate(&conn)
            };
            match rotated {
                Ok(version) => ctx
                    .store
                    .rewrap_all(&actor)
                    .await
                    .map(|rows| json!({ "keyVersion": version, "rewrapped": rows, "seal": keyring.status() })),
                Err(error) => Err(error),
            }
        }
        _ => {
            return json_error(
                StatusCode::NOT_FOUND,
                "vault_not_found: unknown action".to_owned(),
            )
        }
    };
    match result {
        Ok(value) => {
            // Shares are never written to the audit log.
            ctx.store.audit(&audit("ok")).await;
            respond(value)
        }
        Err(error) => {
            ctx.store.audit(&audit("error")).await;
            vault_error(error)
        }
    }
}

/// POST /api/vault/migrate-shared moves legacy node-local team and
/// organization values into the control plane.
#[utoipa::path(post, path = "/api/vault/migrate-shared", tag = "Vault",
    summary = "Move node-local team/org values to the control plane (admin)",
    responses((status = 200, description = "Migration counts", body = serde_json::Value)))]
pub async fn migrate_shared(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/migrate", Capability::Admin) {
        return response;
    }
    if !crate::vault::shared::is_enabled() {
        return json_error(
            StatusCode::CONFLICT,
            "vault_shared_unavailable: this node is not connected to the control plane".to_owned(),
        );
    }
    let Some(jwt) = ctx.jwt.clone() else {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "vault_user_required: migration needs a signed-in administrator".to_owned(),
        );
    };
    let values = match ctx.store.current_values(&ListFilter::default()).await {
        Ok(values) => values,
        Err(error) => return vault_error(error),
    };
    let actor = ctx.actor();
    let (mut moved, mut failed) = (0usize, Vec::new());
    for (info, value) in values {
        if !matches!(info.scope, SecretScope::Team | SecretScope::Org) {
            continue;
        }
        let coords = info.coords();
        // Create-only: a coordinate that already exists in the control plane
        // (or that another legacy node migrated first) is reported as a
        // conflict to reconcile, never overwritten with this node's copy.
        let body = json!({
            "scope": info.scope, "scopeId": info.scope_id, "binding": info.binding,
            "environment": info.environment, "path": info.path, "value": value,
            "metadata": info.metadata, "expectedVersion": 0,
        });
        let result = crate::vault::shared::proxy(
            reqwest::Method::PUT,
            &format!("/secrets/{}", urlencoding::encode(&info.name)),
            &[],
            &jwt,
            Some(body),
            false,
        )
        .await;
        match result {
            Ok(_) => {
                if ctx.store.soft_delete(coords, &actor).await.is_ok() {
                    moved += 1;
                }
            }
            Err(crate::vault::shared::ProxyError::Status(409, _)) => failed.push(json!({
                "key": coords.policy_key(),
                "error": "already exists in the control plane; reconcile it and delete the local copy",
                "conflict": true,
            })),
            Err(error) => {
                failed.push(json!({ "key": coords.policy_key(), "error": format!("{error:?}") }))
            }
        }
    }
    respond(json!({ "ok": failed.is_empty(), "moved": moved, "failed": failed }))
}
