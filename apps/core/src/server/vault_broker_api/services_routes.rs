//! Broker status, CA, catalog, and service routes.
//! test-exempt: moved out of vault_broker_api.rs; tests.rs drives these routes through the router.

use super::*;

// ── Status, CA, catalog ───────────────────────────────────────────────────

pub(super) fn proxy_info() -> Value {
    json!({
        "listening": broker::listening_port().is_some(),
        "port": broker::listening_port(),
        "caUrl": CA_PATH,
        "portEnv": broker::ENV_PORT,
    })
}

/// GET /api/vault/broker/status.
#[utoipa::path(get, path = "/api/vault/broker/status", tag = "Vault",
    summary = "Credential broker listener status",
    responses((status = 200, description = "Status", body = serde_json::Value)))]
pub async fn broker_status(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::List));
    respond(json!({ "broker": proxy_info() }))
}

/// GET /api/vault/broker/ca.pem (public certificate, no auth). Read-only:
/// the CA is created by session minting, never by an anonymous request.
#[utoipa::path(get, path = "/api/vault/broker/ca.pem", tag = "Vault",
    summary = "Download the credential broker CA certificate (PEM)",
    responses(
        (status = 200, description = "PEM certificate", body = String),
        (status = 404, description = "No broker CA exists yet"),
    ))]
pub async fn broker_ca() -> Response {
    let store = tri!(store());
    match ca::existing_certificate_pem(store).await {
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: the broker CA is created when the first broker session is minted"
                .to_owned(),
        ),
        Ok(Some(pem)) => (
            [
                (header::CONTENT_TYPE, "application/x-pem-file"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            pem,
        )
            .into_response(),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/broker/catalog.
#[utoipa::path(get, path = "/api/vault/broker/catalog", tag = "Vault",
    summary = "Built-in broker service templates",
    responses((status = 200, description = "Templates", body = serde_json::Value)))]
pub async fn broker_catalog(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    tri!(human(&state, caller, &headers).await);
    respond(json!({ "templates": catalog::templates() }))
}

// ── Services ──────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentQuery {
    #[serde(default)]
    pub(super) environment: Option<String>,
}

/// GET /api/vault/broker/services.
#[utoipa::path(get, path = "/api/vault/broker/services", tag = "Vault",
    summary = "List broker services visible to the caller",
    params(("environment" = Option<String>, Query, description = "Filter by environment")),
    responses((status = 200, description = "Services", body = serde_json::Value)))]
pub async fn list_services(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<EnvironmentQuery>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    let listed = {
        let conn = ctx.store.conn.lock().await;
        services::list(&conn, query.environment.as_deref())
    };
    match listed {
        Ok(items) => {
            let visible: Vec<_> = items
                .into_iter()
                .filter(|service| !ctx.sys_caps(&service_key(service.name())).is_empty())
                .collect();
            // The caller's own OAuth connections back OAuth services for the
            // sessions they mint; status only, never a token.
            let owner = crate::mcp_oauth::owner_for_caller(ctx.caller.as_ref()).ok();
            let oauth = broker::oauth::statuses(
                &broker::oauth::CoreOAuthTokens,
                owner.as_deref(),
                &visible,
            )
            .await;
            respond(json!({ "services": visible, "oauthStatus": oauth }))
        }
        Err(error) => vault_error(error),
    }
}

/// Create body: a full service, or `{ template, name?, environment?,
/// credentialRef? }` to instantiate a catalog template.
pub(super) fn service_from_body(body: Value) -> Result<services::ServiceInput, Response> {
    let Some(template) = body.get("template").and_then(Value::as_str) else {
        let input: services::ServiceInput = parse_body(body)?;
        return input.normalize().map_err(vault_error);
    };
    let text = |key: &str| body.get(key).and_then(Value::as_str);
    catalog::instantiate(
        template,
        text("name"),
        text("environment").unwrap_or(crate::vault::DEFAULT_ENVIRONMENT),
        text("credentialRef"),
    )
    .map_err(vault_error)
}

pub(super) async fn audit(
    store: &PluginSecretStore,
    actor: &AuditActor,
    action: &str,
    details: Value,
) {
    store
        .audit(&AuditEntry::new(actor, action, "ok").details(details))
        .await;
}

/// Node-scoped coordinates for a `secret:` reference, resolved against
/// `environment` when the reference names none.
pub(super) fn node_coords(
    ctx: &Ctx,
    reference: &str,
    environment: &str,
) -> Result<SecretCoords, Response> {
    let parsed = reference
        .strip_prefix("secret:")
        .and_then(SecretRef::parse)
        .ok_or_else(|| invalid_request(&format!("invalid reference `{reference}`")))?;
    SecretCoords {
        scope: SecretScope::Node,
        scope_id: ctx.node_id.clone(),
        environment: parsed.environment_or(environment),
        path: parsed.path,
        binding: None,
        name: parsed.name,
    }
    .normalize()
    .map_err(|error| invalid_request(&error.to_string()))
}

/// Who may create, replace, or approve `service`: `admin` on its
/// `sys/broker/<name>` key and `use` on every credential reference it names
/// (in the service's environment). Without the second check, admin on one
/// service key would let a caller point any node credential at any host.
/// A password-manager reference (`op://…`, `bws://…`) needs `use` on its
/// account's `sys/password-managers/<account>` key instead, and is rewritten
/// to name that account (`op://<account>@…`), so the service keeps resolving
/// through the account it was authorized against; every use still needs a
/// human approval for the session's principal.
pub(super) async fn authorize_service_write(
    ctx: &Ctx,
    service: &mut services::ServiceInput,
) -> Result<(), Response> {
    ctx.require_sys(&service_key(&service.name), Capability::Admin)?;
    let mut qualified = BTreeMap::new();
    for reference in service.refs() {
        if let Some(text) = substitute::pm_ref_text(&reference) {
            let parsed = PmRef::parse(text)
                .ok_or_else(|| invalid_request(&format!("invalid reference `{reference}`")))?;
            let account = ctx
                .store
                .pm_account_for_ref(&parsed)
                .await
                .map_err(vault_error)?;
            ctx.require_sys(
                &crate::vault::password_managers::account_key(&account.name),
                Capability::Use,
            )?;
            if parsed.account.is_none() {
                let prefix = &reference[..reference.len() - text.len()];
                qualified.insert(
                    reference.clone(),
                    format!("{prefix}{}", parsed.qualified(&account.name)),
                );
            }
            continue;
        }
        let coords = node_coords(ctx, &reference, &service.environment)?;
        ctx.require(&coords, Capability::Use)?;
    }
    if !qualified.is_empty() {
        service.replace_refs(&qualified);
    }
    Ok(())
}

/// A session's minter may revoke it; anyone else needs `admin` on
/// `sys/broker`.
pub(super) fn authorize_revoke(
    ctx: &Ctx,
    session: &sessions::BrokerSession,
) -> Result<(), Response> {
    if session.minted_by == minted_by(ctx) {
        return Ok(());
    }
    ctx.require_sys(SYS_BROKER, Capability::Admin)
}

/// POST /api/vault/broker/services.
#[utoipa::path(post, path = "/api/vault/broker/services", tag = "Vault",
    summary = "Create a broker service (admin on sys/broker/<name>, use on each credential)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created", body = serde_json::Value)))]
pub async fn create_service(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    let mut input = tri!(service_from_body(body));
    tri!(authorize_service_write(&ctx, &mut input).await);
    let created = {
        let conn = ctx.store.conn.lock().await;
        services::insert(&conn, input)
    };
    match created {
        Ok(service) => {
            audit(
                ctx.store,
                &ctx.actor(),
                "broker.service.create",
                json!({ "service": service.name(), "host": service.input.host, "refs": service.refs() }),
            )
            .await;
            respond(json!({ "service": service }))
        }
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/broker/services/{name}.
#[utoipa::path(get, path = "/api/vault/broker/services/{name}", tag = "Vault",
    summary = "Read one broker service",
    params(("name" = String, Path, description = "Service name")),
    responses((status = 200, description = "Service", body = serde_json::Value)))]
pub async fn get_service(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(&service_key(&name), Capability::List));
    let found = {
        let conn = ctx.store.conn.lock().await;
        services::get(&conn, &name)
    };
    match found {
        Ok(Some(service)) => respond(json!({ "service": service })),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("vault_not_found: broker service `{name}`"),
        ),
        Err(error) => vault_error(error),
    }
}

/// PUT /api/vault/broker/services/{name}.
#[utoipa::path(put, path = "/api/vault/broker/services/{name}", tag = "Vault",
    summary = "Replace a broker service (admin on sys/broker/<name>, use on each credential)",
    params(("name" = String, Path, description = "Service name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Updated", body = serde_json::Value)))]
pub async fn put_service(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(&service_key(&name), Capability::Admin));
    if let Some(object) = body.as_object_mut() {
        object.insert("name".into(), json!(name));
        object.remove("template");
    }
    let mut input = tri!(service_from_body(body));
    tri!(authorize_service_write(&ctx, &mut input).await);
    let updated = {
        let conn = ctx.store.conn.lock().await;
        services::update(&conn, input)
    };
    match updated {
        Ok(service) => {
            audit(
                ctx.store,
                &ctx.actor(),
                "broker.service.update",
                json!({ "service": service.name(), "host": service.input.host, "refs": service.refs() }),
            )
            .await;
            respond(json!({ "service": service }))
        }
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/broker/services/{name}.
#[utoipa::path(delete, path = "/api/vault/broker/services/{name}", tag = "Vault",
    summary = "Delete a broker service (admin on sys/broker/<name>)",
    params(("name" = String, Path, description = "Service name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn delete_service(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(&service_key(&name), Capability::Admin));
    let deleted = {
        let conn = ctx.store.conn.lock().await;
        services::delete(&conn, &name)
    };
    match deleted {
        Ok(deleted) => {
            if deleted {
                audit(
                    ctx.store,
                    &ctx.actor(),
                    "broker.service.delete",
                    json!({ "service": name }),
                )
                .await;
            }
            respond(json!({ "deleted": deleted }))
        }
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
pub struct UsageQuery {
    #[serde(rename = "ref")]
    reference: String,
}

/// GET /api/vault/broker/usage?ref=secret:NAME.
#[utoipa::path(get, path = "/api/vault/broker/usage", tag = "Vault",
    summary = "Broker services that use a credential reference",
    params(("ref" = String, Query, description = "A `secret:` reference")),
    responses((status = 200, description = "Services", body = serde_json::Value)))]
pub async fn service_usage(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<UsageQuery>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    let found = {
        let conn = ctx.store.conn.lock().await;
        services::usage(&conn, query.reference.trim())
    };
    match found {
        Ok(items) => {
            let names: Vec<String> = items
                .iter()
                .filter(|service| !ctx.sys_caps(&service_key(service.name())).is_empty())
                .map(|service| service.name().to_owned())
                .collect();
            respond(json!({ "ref": query.reference, "services": names }))
        }
        Err(error) => vault_error(error),
    }
}
