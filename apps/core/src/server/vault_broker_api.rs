//! Credential broker routes (`/api/vault/broker/*`, `/api/vault/agent/broker/*`).
//!
//! Human routes sit behind the node bearer and authorize against
//! `sys/broker/<service>` (`admin` manages a service, `use` mints sessions for
//! it) and `sys/broker` (`admin` for environment settings, sessions, and
//! proposals; `list` for the request log). Creating, replacing, or approving a
//! service also needs `use` on every `secret:` reference it names, so a
//! service cannot aim a credential its author may not broker at a host of
//! their choosing. Configuration managers and the unbound local operator hold
//! every capability.
//!
//! Public routes serve the broker CA certificate (unauthenticated and
//! read-only: it is a public certificate, and the route never creates the CA)
//! and the agent surface: machine tokens
//! (`x-ryu-vault-token`) mint sessions with `use` on each service, and machine
//! tokens or broker sessions (`Authorization: Bearer rvb_…`) read discovery
//! and file proposals. No route here returns a credential value.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{invalid_request, parse_body, respond, store, vault_error, Ctx};
use super::vault_engines_api::VAULT_TOKEN_HEADER;
use super::{json_error, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::{
    PluginSecretStore, SecretCoords, SecretScope, VersionSource, WriteRequest,
};
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::broker::{
    self, ca, catalog, log, proposals, service_key, services, sessions, settings, substitute,
    SYS_BROKER,
};
use crate::vault::machine::TokenPrincipal;
use crate::vault::password_managers::{GrantMode, PmRef};
use crate::vault::policy::{Capability, CapabilitySet, Policy};
use crate::vault::SecretRef;

/// Public CA download path.
pub const CA_PATH: &str = "/api/vault/broker/ca.pem";

macro_rules! tri {
    ($expr:expr) => {
        match $expr {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
}

async fn human(
    state: &ServerState,
    caller: Option<VerifiedCaller>,
    headers: &HeaderMap,
) -> Result<Ctx, Response> {
    Ctx::load(state, caller, headers).await
}

fn minted_by(ctx: &Ctx) -> String {
    match &ctx.caller {
        Some(caller) => format!("user:{}", caller.user_id),
        None => "operator".to_owned(),
    }
}

fn unauthorized(message: &str) -> Response {
    json_error(
        StatusCode::UNAUTHORIZED,
        format!("vault_token_invalid: {message}"),
    )
}

// ── Agent principals ──────────────────────────────────────────────────────

/// A machine token holder or a broker session on an agent route.
enum Agent {
    Machine {
        principal: TokenPrincipal,
        policies: Vec<Policy>,
    },
    Session(sessions::BrokerSession),
}

impl Agent {
    fn subject(&self) -> String {
        match self {
            Self::Machine { principal, .. } => principal.subject(),
            Self::Session(session) => format!("broker_session:{}", session.id),
        }
    }

    fn actor(&self) -> AuditActor {
        match self {
            Self::Machine { principal, .. } => principal.actor(),
            Self::Session(session) => session.actor(),
        }
    }

    /// The principal whose proposal quota this agent draws on: the machine,
    /// or whoever minted the session (so many sessions share one quota).
    fn accountable(&self) -> String {
        match self {
            Self::Machine { principal, .. } => principal.subject(),
            Self::Session(session) => session.minted_by.clone(),
        }
    }

    /// Whether the agent may broker through `service` (in `environment`).
    fn may_use(&self, service: &services::BrokerService) -> bool {
        match self {
            Self::Machine {
                policies,
                principal,
            } => crate::vault::policy::evaluate_with(
                &CapabilitySet::new(),
                policies,
                &service_key(service.name()),
                &crate::vault::policy_ext::TemplateContext::from_subjects(&[principal.subject()]),
            )
            .contains(&Capability::Use),
            Self::Session(session) => {
                session.environment == service.input.environment && session.allows(service.name())
            }
        }
    }
}

async fn machine_principal(
    store: &PluginSecretStore,
    token: &str,
) -> Result<Option<(TokenPrincipal, Vec<Policy>)>, Response> {
    let principal = match store.token_lookup(token).await {
        Ok(Some(principal)) => principal,
        Ok(None) => return Ok(None),
        Err(error) => return Err(vault_error(error)),
    };
    let conn = store.conn.lock().await;
    let policies =
        crate::vault::machine::principal_policies_locked(&conn, &principal).map_err(vault_error)?;
    Ok(Some((principal, policies)))
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Authenticate a machine token only (session minting).
async fn machine_only(headers: &HeaderMap) -> Result<(TokenPrincipal, Vec<Policy>), Response> {
    let store = store()?;
    let token = header_value(headers, VAULT_TOKEN_HEADER)
        .ok_or_else(|| unauthorized("a valid x-ryu-vault-token is required"))?;
    machine_principal(store, token)
        .await?
        .ok_or_else(|| unauthorized("a valid x-ryu-vault-token is required"))
}

/// Authenticate a machine token or an `rvb_` session.
async fn agent(headers: &HeaderMap) -> Result<Agent, Response> {
    let store = store()?;
    if let Some(token) = header_value(headers, VAULT_TOKEN_HEADER) {
        return match machine_principal(store, token).await? {
            Some((principal, policies)) => Ok(Agent::Machine {
                principal,
                policies,
            }),
            None => Err(unauthorized("a valid x-ryu-vault-token is required")),
        };
    }
    let session_token = [header::AUTHORIZATION, header::PROXY_AUTHORIZATION]
        .iter()
        .filter_map(|name| header_value(headers, name.as_str()))
        .find_map(sessions::parse_authorization);
    let Some(session_token) = session_token else {
        return Err(unauthorized(
            "an x-ryu-vault-token or an rvb_ broker session is required",
        ));
    };
    let conn = store.conn.lock().await;
    match sessions::lookup(
        &conn,
        &session_token,
        crate::vault::tokens::request_client_ip(),
    ) {
        Ok(Some(session)) => Ok(Agent::Session(session)),
        Ok(None) => Err(unauthorized("the broker session is invalid or expired")),
        Err(error) => Err(vault_error(error)),
    }
}

// ── Status, CA, catalog ───────────────────────────────────────────────────

fn proxy_info() -> Value {
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
    environment: Option<String>,
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
            respond(json!({ "services": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// Create body: a full service, or `{ template, name?, environment?,
/// credentialRef? }` to instantiate a catalog template.
fn service_from_body(body: Value) -> Result<services::ServiceInput, Response> {
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

async fn audit(store: &PluginSecretStore, actor: &AuditActor, action: &str, details: Value) {
    store
        .audit(&AuditEntry::new(actor, action, "ok").details(details))
        .await;
}

/// Node-scoped coordinates for a `secret:` reference, resolved against
/// `environment` when the reference names none.
fn node_coords(ctx: &Ctx, reference: &str, environment: &str) -> Result<SecretCoords, Response> {
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
async fn authorize_service_write(
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
fn authorize_revoke(ctx: &Ctx, session: &sessions::BrokerSession) -> Result<(), Response> {
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
    #[serde(default)]
    skills: String,
}

/// PUT /api/vault/broker/environments/{env}.
#[utoipa::path(put, path = "/api/vault/broker/environments/{env}", tag = "Vault",
    operation_id = "broker_put_environment",
    summary = "Set an environment's unmatched-host policy and agent skills (admin on sys/broker)",
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
        settings::put(
            &conn,
            &environment,
            body.unmatched_host_policy,
            &body.skills,
        )
    };
    match saved {
        Ok(settings) => {
            audit(
                ctx.store,
                &ctx.actor(),
                "broker.environment.update",
                json!({ "environment": environment, "unmatchedHostPolicy": settings.unmatched_host_policy }),
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
    environment: Option<String>,
    #[serde(default)]
    services: Vec<String>,
    #[serde(default)]
    label: String,
    #[serde(default)]
    ttl_secs: Option<i64>,
}

/// Check that every requested service exists in the environment and that the
/// caller holds `use` on it.
async fn check_session_services(
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
            return Err(super::vault_api::denied(
                Capability::Use,
                &service_key(name),
            ));
        }
    }
    Ok(())
}

/// Mint a session and render the response (token shown once, plus the
/// child-process environment when the listener is up).
async fn mint_session(
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

fn session_environment(body: &SessionBody) -> Result<String, Response> {
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
fn visible_proposals(ctx: &Ctx, items: Vec<proposals::Proposal>) -> Vec<proposals::Proposal> {
    items
        .into_iter()
        .filter(|proposal| {
            proposal
                .credential_use
                .as_ref()
                .map_or(true, |credential_use| {
                    super::vault_pm_api::visible(ctx, &credential_use.account)
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
async fn plan_values(
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
        return super::vault_pm_api::approve_credential_use(
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
fn apply_proposal(
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

async fn reject_inner(ctx: &Ctx, id: &str, note: &str) -> Response {
    tri!(ctx.require_sys(SYS_BROKER, Capability::Admin));
    let credential_use = {
        let conn = ctx.store.conn.lock().await;
        tri!(proposals::get(&conn, id).map_err(vault_error))
            .is_some_and(|proposal| proposal.credential_use.is_some())
    };
    if credential_use {
        // Needs admin on the account and writes its own audit row.
        return super::vault_pm_api::reject_credential_use(ctx, id, note).await;
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
    may_use: impl Fn(&services::BrokerService) -> bool,
) -> Value {
    let listed: Vec<Value> = services
        .iter()
        .filter(|service| service.input.enabled && may_use(service))
        .map(|service| {
            let input = &service.input;
            json!({
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
            })
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
    let conn = store.conn.lock().await;
    let view = services::list(&conn, Some(&environment))
        .and_then(|services| Ok((services, settings::get(&conn, &environment)?)));
    match view {
        Ok((services, settings)) => respond(discovery(&services, &settings, |s| agent.may_use(s))),
        Err(error) => vault_error(error),
    }
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
fn may_poll(agent: &Agent, proposal: &proposals::Proposal) -> bool {
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

/// Protected routes (node bearer).
pub fn routes() -> Router<ServerState> {
    use axum::routing::{get, post};
    let body = || axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    Router::new()
        .route("/api/vault/broker/status", get(broker_status))
        .route("/api/vault/broker/catalog", get(broker_catalog))
        .route(
            "/api/vault/broker/services",
            get(list_services).post(create_service).layer(body()),
        )
        .route(
            "/api/vault/broker/services/:name",
            get(get_service)
                .put(put_service)
                .delete(delete_service)
                .layer(body()),
        )
        .route("/api/vault/broker/usage", get(service_usage))
        .route(
            "/api/vault/broker/environments/:env",
            get(get_environment).put(put_environment).layer(body()),
        )
        .route(
            "/api/vault/broker/sessions",
            get(list_sessions).post(create_session).layer(body()),
        )
        .route(
            "/api/vault/broker/sessions/:id",
            axum::routing::delete(revoke_session),
        )
        .route("/api/vault/broker/logs", get(list_logs))
        .route("/api/vault/broker/discovered-hosts", get(discovered_hosts))
        .route("/api/vault/broker/proposals", get(list_proposals))
        .route(
            "/api/vault/broker/proposals/:id/approve",
            post(approve_proposal).layer(body()),
        )
        .route(
            "/api/vault/broker/proposals/:id/reject",
            post(reject_proposal).layer(body()),
        )
}

/// Public routes: the CA certificate and the agent surface (in-handler auth).
pub fn public_routes() -> Router<ServerState> {
    use axum::routing::{get, post};
    let limit = axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    Router::new()
        .route(CA_PATH, get(broker_ca))
        .route(
            "/api/vault/agent/broker/sessions",
            post(agent_create_session),
        )
        .route("/api/vault/agent/broker/discover", get(agent_discover))
        .route(
            "/api/vault/agent/broker/proposals",
            post(agent_create_proposal),
        )
        .route(
            "/api/vault/agent/broker/proposals/:id",
            get(agent_get_proposal),
        )
        .route(
            "/api/vault/agent/cards/approvals/:id",
            get(agent_get_card_approval),
        )
        .layer(limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::broker::services::{test_service, Substitution};
    use crate::vault::broker::substitute::Surface;

    fn stored(input: services::ServiceInput) -> services::BrokerService {
        services::BrokerService {
            input: input.normalize().unwrap(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn rule(path: &str, capability: Capability, deny: bool) -> crate::vault::policy::PolicyRule {
        crate::vault::policy::PolicyRule {
            path: path.into(),
            capabilities: vec![capability],
            deny,
            ..Default::default()
        }
    }

    /// A non-manager human principal holding `rules` (the local node, so
    /// node-scoped values start from the full baseline and only policies
    /// narrow them).
    fn human_ctx(rules: Vec<crate::vault::policy::PolicyRule>) -> Ctx {
        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        Ctx {
            store,
            node: None,
            node_id: crate::vault::broker::local_node_id(),
            caller: None,
            manager: false,
            policies: vec![Policy {
                name: "p".into(),
                description: String::new(),
                rules,
            }],
            jwt: None,
        }
    }

    fn status(result: Result<(), Response>) -> StatusCode {
        match result {
            Ok(()) => StatusCode::OK,
            Err(response) => response.status(),
        }
    }

    #[tokio::test]
    async fn service_writes_need_admin_and_use_on_every_credential() {
        let mut service = test_service("gh", "api.github.com", None, "/");
        service.substitutions = vec![Substitution {
            placeholder: "__ORG__".into(),
            reference: "secret:prod:/team/ORG_ID".into(),
            surfaces: vec![Surface::Header],
        }];
        // No admin on the service key.
        let ctx = human_ctx(vec![rule("sys/broker/other", Capability::Admin, false)]);
        assert_eq!(
            status(authorize_service_write(&ctx, &mut service.clone()).await),
            StatusCode::FORBIDDEN
        );
        // Admin, and `use` on both references (auth in the service's
        // environment, the substitution in the one it names).
        let ctx = human_ctx(vec![rule("sys/broker/gh", Capability::Admin, false)]);
        assert_eq!(
            status(authorize_service_write(&ctx, &mut service.clone()).await),
            StatusCode::OK
        );
        // Admin on the key alone cannot aim a credential the caller may not
        // use: a deny on either reference refuses the write.
        for denied in ["default/API_TOKEN", "prod/team/ORG_ID"] {
            let ctx = human_ctx(vec![
                rule("sys/broker/gh", Capability::Admin, false),
                rule(denied, Capability::Use, true),
            ]);
            assert_eq!(
                status(authorize_service_write(&ctx, &mut service.clone()).await),
                StatusCode::FORBIDDEN,
                "{denied}"
            );
        }
        let mut bad = service.clone();
        bad.auth = services::ServiceAuth::Bearer {
            token: "secret:bad name".into(),
        };
        let ctx = human_ctx(vec![rule("sys/broker/gh", Capability::Admin, false)]);
        assert_eq!(
            status(authorize_service_write(&ctx, &mut bad.clone()).await),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn human_session_minting_needs_use_on_each_service() {
        let ctx = human_ctx(vec![rule("sys/broker/gh", Capability::Use, false)]);
        {
            let conn = ctx.store.conn.lock().await;
            for name in ["gh", "linear"] {
                services::insert(
                    &conn,
                    test_service(name, &format!("{name}.example.com"), None, "/"),
                )
                .unwrap();
            }
        }
        let check = |names: &[&str]| {
            let names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
            let ctx = &ctx;
            async move {
                status(
                    check_session_services(ctx.store, "default", &names, |name| {
                        ctx.sys_caps(&service_key(name)).contains(&Capability::Use)
                    })
                    .await,
                )
            }
        };
        assert_eq!(check(&["gh"]).await, StatusCode::OK);
        assert_eq!(check(&["gh", "linear"]).await, StatusCode::FORBIDDEN);
        assert_eq!(check(&["missing"]).await, StatusCode::BAD_REQUEST);
        let admin_only = human_ctx(vec![rule("sys/broker/*", Capability::Admin, false)]);
        assert!(!admin_only
            .sys_caps(&service_key("gh"))
            .contains(&Capability::Use));
    }

    #[test]
    fn only_the_minter_or_a_broker_admin_revokes_a_session() {
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
        let nobody = human_ctx(Vec::new());
        assert_eq!(
            status(authorize_revoke(&nobody, &session("operator"))),
            StatusCode::OK
        );
        assert_eq!(
            status(authorize_revoke(&nobody, &session("user:someone-else"))),
            StatusCode::FORBIDDEN
        );
        let lister = human_ctx(vec![rule(SYS_BROKER, Capability::List, false)]);
        assert_eq!(
            status(authorize_revoke(&lister, &session("machine:m1"))),
            StatusCode::FORBIDDEN
        );
        let admin = human_ctx(vec![rule(SYS_BROKER, Capability::Admin, false)]);
        assert_eq!(
            status(authorize_revoke(&admin, &session("machine:m1"))),
            StatusCode::OK
        );
    }

    #[test]
    fn broker_wide_routes_gate_on_sys_broker() {
        // Logs, discovered hosts, proposals listing, and status need `list`;
        // settings, the session list, and decisions need `admin`.
        let nobody = human_ctx(Vec::new());
        assert_eq!(
            status(nobody.require_sys(SYS_BROKER, Capability::List)),
            StatusCode::FORBIDDEN
        );
        let lister = human_ctx(vec![rule(SYS_BROKER, Capability::List, false)]);
        assert_eq!(
            status(lister.require_sys(SYS_BROKER, Capability::List)),
            StatusCode::OK
        );
        assert_eq!(
            status(lister.require_sys(SYS_BROKER, Capability::Admin)),
            StatusCode::FORBIDDEN
        );
        // A per-service grant does not reach the broker-wide key.
        let service_admin = human_ctx(vec![rule("sys/broker/*", Capability::Admin, false)]);
        assert_eq!(
            status(service_admin.require_sys(SYS_BROKER, Capability::Admin)),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn the_public_ca_route_never_creates_the_ca() {
        // `broker_ca` reads through the global store; exercise the read it
        // performs on a fresh store instead.
        let store = PluginSecretStore::in_memory().unwrap();
        assert!(ca::existing_certificate_pem(&store)
            .await
            .unwrap()
            .is_none());
        let audits: i64 = {
            let conn = store.conn.lock().await;
            conn.query_row(
                "SELECT COUNT(*) FROM vault_audit WHERE action = 'broker.ca.create'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(audits, 0);
    }

    fn machine(rules: &[(&str, Capability)]) -> Agent {
        Agent::Machine {
            principal: TokenPrincipal {
                accessor: "rva_x".into(),
                identity_id: "mid_x".into(),
                identity_name: "ci".into(),
                policies: vec!["ci".into()],
                expires_at: i64::MAX,
            },
            policies: vec![Policy {
                name: "ci".into(),
                description: String::new(),
                rules: rules
                    .iter()
                    .map(|(path, capability)| crate::vault::policy::PolicyRule {
                        path: (*path).into(),
                        capabilities: vec![*capability],
                        deny: false,
                        ..Default::default()
                    })
                    .collect(),
            }],
        }
    }

    #[test]
    fn machines_broker_only_with_use_on_the_service_key() {
        let openai = stored(test_service("openai", "api.openai.com", None, "/"));
        let github = stored(test_service("github", "api.github.com", None, "/"));
        let agent = machine(&[("sys/broker/openai", Capability::Use)]);
        assert!(agent.may_use(&openai));
        assert!(!agent.may_use(&github));
        let wildcard = machine(&[("sys/broker/*", Capability::Use)]);
        assert!(wildcard.may_use(&github));
        let reader = machine(&[("sys/broker/*", Capability::Read)]);
        assert!(!reader.may_use(&github));
        assert_eq!(agent.subject(), "machine:mid_x");
    }

    #[test]
    fn sessions_see_only_their_services_and_environment() {
        let session = sessions::BrokerSession {
            id: "bvs_1".into(),
            environment: "default".into(),
            services: vec!["openai".into()],
            label: String::new(),
            minted_by: "operator".into(),
            created_at: 0,
            expires_at: i64::MAX,
            revoked_at: None,
            minted_token: None,
            minter_scope: None,
        };
        let agent = Agent::Session(session);
        let openai = stored(test_service("openai", "api.openai.com", None, "/"));
        let mut elsewhere = test_service("openai", "api.openai.com", None, "/");
        elsewhere.environment = "prod".into();
        assert!(agent.may_use(&openai));
        assert!(!agent.may_use(&stored(elsewhere)));
        assert_eq!(agent.subject(), "broker_session:bvs_1");
        // Its proposals count against whoever minted it.
        assert_eq!(agent.accountable(), "operator");
    }

    fn credential_use(store: &PluginSecretStore, subject: &str) -> proposals::Proposal {
        let conn = store.conn.blocking_lock();
        proposals::create_credential_use(
            &conn,
            proposals::CredentialUse {
                reference: "op://work@dev/GitHub/token".into(),
                account_id: "pma_1".into(),
                account: "work".into(),
                provider: "1password-connect".into(),
                subject: subject.into(),
            },
            "default",
            "broker_session:bvs_1",
        )
        .unwrap()
    }

    #[test]
    fn sessions_of_one_principal_poll_its_credential_use_requests() {
        let store = PluginSecretStore::in_memory().unwrap();
        let request = credential_use(&store, "broker:user:u1");
        let session = |id: &str, minted_by: &str| {
            Agent::Session(sessions::BrokerSession {
                id: id.into(),
                environment: "default".into(),
                services: vec!["gh".into()],
                label: String::new(),
                minted_by: minted_by.into(),
                created_at: 0,
                expires_at: i64::MAX,
                revoked_at: None,
                minted_token: None,
                minter_scope: None,
            })
        };
        // The filing session and a second session of the same minter both
        // poll it; another minter's session and a machine do not.
        assert!(may_poll(&session("bvs_1", "user:u1"), &request));
        assert!(may_poll(&session("bvs_2", "user:u1"), &request));
        assert!(!may_poll(&session("bvs_3", "user:u2"), &request));
        assert!(!may_poll(&machine(&[]), &request));
        // A second session's retry returns the same request.
        let again = credential_use(&store, "broker:user:u1");
        assert_eq!(again.id, request.id);
        let for_machine = credential_use(&store, "broker:machine:mid_x");
        assert!(may_poll(&machine(&[]), &for_machine));
        // A request for the user's explicit read is not a broker request.
        let read = credential_use(&store, "read:user:u1");
        assert!(!may_poll(&session("bvs_2", "user:u1"), &read));
    }

    #[tokio::test]
    async fn credential_use_requests_need_the_account_on_broker_routes() {
        let lister = human_ctx(vec![
            rule(SYS_BROKER, Capability::Admin, false),
            rule(SYS_BROKER, Capability::List, false),
        ]);
        let request = {
            let conn = lister.store.conn.lock().await;
            proposals::create_credential_use(
                &conn,
                proposals::CredentialUse {
                    reference: "op://work@dev/GitHub/token".into(),
                    account_id: "pma_1".into(),
                    account: "work".into(),
                    provider: "1password-connect".into(),
                    subject: "broker:operator".into(),
                },
                "default",
                "broker_session:bvs_1",
            )
            .unwrap()
        };
        let mut plain = proposals::ProposalInput::default();
        plain.message = "need linear".into();
        plain.credentials = vec![proposals::CredentialRequest {
            reference: "secret:LINEAR".into(),
            description: String::new(),
            obtain_instructions: String::new(),
        }];
        let all = {
            let conn = lister.store.conn.lock().await;
            proposals::create(&conn, plain, "default", "machine:m1", "machine:m1").unwrap();
            proposals::list(&conn, None).unwrap()
        };
        assert_eq!(all.len(), 2);
        // Without any capability on `sys/password-managers/work` the
        // credential-use request is neither listed nor rejectable.
        let listed = visible_proposals(&lister, all.clone());
        assert_eq!(listed.len(), 1);
        assert!(listed[0].credential_use.is_none());
        assert_eq!(
            reject_inner(&lister, &request.id, "").await.status(),
            StatusCode::FORBIDDEN
        );
        let account_admin = Ctx {
            store: lister.store,
            ..human_ctx(vec![
                rule(SYS_BROKER, Capability::Admin, false),
                rule("sys/password-managers/work", Capability::Admin, false),
            ])
        };
        assert_eq!(visible_proposals(&account_admin, all).len(), 2);
    }

    #[tokio::test]
    async fn approval_values_honor_the_approvers_write_parameter_constraints() {
        let ctx = human_ctx(vec![crate::vault::policy::PolicyRule {
            path: "prod/**".into(),
            capabilities: vec![Capability::Write],
            deny: false,
            denied_parameters: Some(BTreeMap::from([(
                "value".to_owned(),
                vec!["bad*".to_owned()],
            )])),
            ..Default::default()
        }]);
        let mut input = proposals::ProposalInput::default();
        input.message = "need a token".into();
        input.credentials = vec![proposals::CredentialRequest {
            reference: "secret:API_TOKEN".into(),
            description: String::new(),
            obtain_instructions: String::new(),
        }];
        let proposal = {
            let conn = ctx.store.conn.lock().await;
            proposals::create(&conn, input, "prod", "machine:m1", "machine:m1").unwrap()
        };
        let values =
            |value: &str| BTreeMap::from([("secret:API_TOKEN".to_owned(), value.to_owned())]);
        // A value the approver's write grant denies is refused before
        // anything is written, and the proposal stays pending.
        let refused = plan_values(&ctx, &proposal, &values("bad-token")).await;
        assert_eq!(
            refused.err().map(|response| response.status()),
            Some(StatusCode::FORBIDDEN)
        );
        {
            let conn = ctx.store.conn.lock().await;
            assert!(proposals::pending(&conn, &proposal.id).is_ok());
        }
        // A compliant value is planned for the write.
        let planned = plan_values(&ctx, &proposal, &values("good-token"))
            .await
            .unwrap_or_else(|_| panic!("compliant value planned"));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].0.environment, "prod");
        assert_eq!(planned[0].1, "good-token");
    }

    #[tokio::test]
    async fn password_manager_refs_are_pinned_to_their_account_on_write() {
        use crate::vault::password_managers::tests::{add_cli_account, BWS_TOKEN, SECRET_ID};
        let dir = tempfile::tempdir().unwrap();
        let ctx = human_ctx(vec![
            rule("sys/broker/bw", Capability::Admin, false),
            rule("sys/password-managers/team", Capability::Use, false),
        ]);
        add_cli_account(ctx.store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
        let mut service = test_service("bw", "api.example.com", None, "/");
        service.auth = services::ServiceAuth::Custom {
            headers: [(
                "x-key".to_owned(),
                format!("k {{{{ bws://{SECRET_ID} }}}} / {{{{secret:API_TOKEN}}}}"),
            )]
            .into_iter()
            .collect(),
        };
        service.substitutions = vec![Substitution {
            placeholder: "__BW__".into(),
            reference: format!("secret:bws://{SECRET_ID}"),
            surfaces: vec![Surface::Header],
        }];
        assert_eq!(
            status(authorize_service_write(&ctx, &mut service).await),
            StatusCode::OK
        );
        let services::ServiceAuth::Custom { headers } = &service.auth else {
            panic!("custom auth");
        };
        assert_eq!(
            headers["x-key"],
            format!("k {{{{bws://team@{SECRET_ID}}}}} / {{{{secret:API_TOKEN}}}}")
        );
        assert_eq!(
            service.substitutions[0].reference,
            format!("secret:bws://team@{SECRET_ID}")
        );
        assert!(service.clone().normalize().is_ok());
        // Without `use` on the account the write is refused.
        let mut fresh = test_service("bw", "api.example.com", None, "/");
        fresh.auth = services::ServiceAuth::Bearer {
            token: format!("bws://{SECRET_ID}"),
        };
        let no_use = Ctx {
            store: ctx.store,
            ..human_ctx(vec![rule("sys/broker/bw", Capability::Admin, false)])
        };
        assert_eq!(
            status(authorize_service_write(&no_use, &mut fresh).await),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn discovery_lists_placeholders_and_skills_but_no_values() {
        let mut openai = test_service("openai", "api.openai.com", None, "/");
        openai.substitutions = vec![Substitution {
            placeholder: "__OPENAI_ORG__".into(),
            reference: "secret:OPENAI_ORG".into(),
            surfaces: vec![Surface::Header],
        }];
        openai.notes = "Use model gpt-x".into();
        let mut disabled = test_service("off", "api.off.com", None, "/");
        disabled.enabled = false;
        let services = vec![
            stored(openai),
            stored(disabled),
            stored(test_service("github", "api.github.com", None, "/")),
        ];
        let settings = settings::EnvironmentSettings {
            environment: "default".into(),
            unmatched_host_policy: settings::UnmatchedHostPolicy::Deny,
            skills: "# House rules".into(),
            updated_at: 0,
        };
        let doc = discovery(&services, &settings, |s| s.name() != "github");
        let listed = doc["services"].as_array().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["name"], "openai");
        assert_eq!(listed[0]["auth"], "bearer");
        assert_eq!(
            listed[0]["placeholders"][0]["placeholder"],
            "__OPENAI_ORG__"
        );
        assert_eq!(doc["skills"], "# House rules");
        assert_eq!(doc["proposalsEndpoint"], broker::proxy::PROPOSALS_ENDPOINT);
        let text = doc.to_string();
        assert!(!text.contains("secret:API_TOKEN"));
        assert!(!text.contains("secret:OPENAI_ORG"));
    }

    #[tokio::test]
    async fn approving_with_values_honors_write_parameter_constraints() {
        let mut constrained = rule("default/STRIPE_KEY", Capability::Write, false);
        constrained.allowed_parameters = Some(BTreeMap::from([(
            "value".to_owned(),
            vec!["sk_test_*".to_owned()],
        )]));
        let ctx = human_ctx(vec![constrained]);
        let input = proposals::ProposalInput {
            credentials: vec![proposals::CredentialRequest {
                reference: "secret:STRIPE_KEY".into(),
                description: String::new(),
                obtain_instructions: String::new(),
            }],
            ..Default::default()
        };
        let proposal = {
            let conn = ctx.store.conn.lock().await;
            proposals::create(&conn, input, "default", "machine:m", "machine:m").unwrap()
        };
        let values =
            |value: &str| BTreeMap::from([("secret:STRIPE_KEY".to_owned(), value.to_owned())]);
        assert_eq!(
            plan_values(&ctx, &proposal, &values("sk_live_123"))
                .await
                .err()
                .map(|response| response.status()),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            plan_values(&ctx, &proposal, &values("sk_test_123"))
                .await
                .ok()
                .map(|planned| planned.len()),
            Some(1)
        );
    }

    #[tokio::test]
    async fn approving_a_proposal_creates_its_services_atomically() {
        let store = PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let input = proposals::ProposalInput {
            services: vec![
                test_service("one", "api.one.com", None, "/"),
                test_service("two", "api.two.com", None, "/"),
            ],
            ..Default::default()
        };
        let proposal =
            proposals::create(&conn, input.clone(), "default", "machine:m", "machine:m").unwrap();
        services::insert(
            &conn,
            test_service("two", "api.other.com", None, "/")
                .normalize()
                .unwrap(),
        )
        .unwrap();
        assert!(apply_proposal(&conn, &proposal, "operator", "").is_err());
        assert!(services::get(&conn, "one").unwrap().is_none());
        assert_eq!(
            proposals::get(&conn, &proposal.id).unwrap().unwrap().status,
            proposals::ProposalStatus::Pending
        );
        services::delete(&conn, "two").unwrap();
        apply_proposal(&conn, &proposal, "operator", "ok").unwrap();
        assert!(services::get(&conn, "one").unwrap().is_some());
        assert!(apply_proposal(&conn, &proposal, "operator", "").is_err());
    }
}

#[cfg(test)]
#[path = "vault_broker_routes_test.rs"]
mod routes_test;
