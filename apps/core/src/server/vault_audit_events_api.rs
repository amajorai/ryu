//! Vault audit-device, audit-hash, declarative-init, and event-stream routes.
//!
//! * `GET /api/vault/audit/devices`, `PUT`/`DELETE /api/vault/audit/devices/{id}`
//!   manage external audit devices (admin on `sys/audit`);
//! * `POST /api/vault/sys/audit-hash` computes the salted digest a device
//!   writes for an identifier, so an admin can search that device's log;
//! * `POST /api/vault/sys/init/apply` re-applies `RYU_VAULT_INIT_FILE` (admin on
//!   `sys/init`);
//! * `GET /api/vault/events` (operator/user) and `GET /api/vault/agent/events`
//!   (machine token) stream value-free vault events as SSE. Each event is
//!   delivered only when the caller holds `list` on its policy key. The
//!   caller's credentials are re-validated every [`REVALIDATE_EVERY`] and on
//!   every policy, machine, or credential change, and the stream ends once
//!   they no longer authenticate or a machine token expires.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{invalid_request, respond, vault_error, Ctx};
use super::vault_engines_api::{human, local_node_id, machine, Who};
use super::ServerState;
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::{SecretCoords, SecretScope};
use crate::vault::audit::AuditEntry;
use crate::vault::audit_devices::{self, AuditDevice, DeviceKind};
use crate::vault::events::{EventFilter, VaultEvent};
use crate::vault::policy::Capability;
use crate::vault::{declarative, VaultError};

const AUDIT_KEY: &str = "sys/audit";
const INIT_KEY: &str = "sys/init";
/// How often an open event stream re-authenticates its caller.
const REVALIDATE_EVERY: Duration = Duration::from_secs(30);
/// Event types after which a stream re-authenticates before delivering
/// anything else, since they can change what the caller may see.
const REVALIDATE_ON: &[&str] = &["credential-revoke", "policy-change", "machine-change"];

// ── Audit devices ─────────────────────────────────────────────────────────

/// GET /api/vault/audit/devices lists devices with delivery health.
#[utoipa::path(get, path = "/api/vault/audit/devices", tag = "Vault",
    summary = "List external vault audit devices (admin)",
    responses((status = 200, description = "Devices", body = serde_json::Value)))]
pub async fn list_devices(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(AUDIT_KEY, Capability::Admin) {
        return response;
    }
    let conn = ctx.store.conn.lock().await;
    match audit_devices::list(&conn) {
        Ok(devices) => {
            let devices: Vec<Value> = devices
                .into_iter()
                .map(|device| {
                    let health = audit_devices::health(&device.id);
                    let mut value = serde_json::to_value(&device).unwrap_or(Value::Null);
                    value["health"] = serde_json::to_value(health).unwrap_or(Value::Null);
                    value
                })
                .collect();
            respond(json!({
                "devices": devices,
                "failClosed": audit_devices::fail_closed(),
            }))
        }
        Err(error) => vault_error(error),
    }
}

/// Body of `PUT /api/vault/audit/devices/{id}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceBody {
    kind: DeviceKind,
    #[serde(default = "enabled_default")]
    enabled: bool,
    #[serde(default)]
    description: String,
    #[serde(default = "enabled_default")]
    hmac_fields: bool,
    #[serde(default)]
    options: Value,
}

fn enabled_default() -> bool {
    true
}

/// PUT /api/vault/audit/devices/{id} creates or replaces a device.
#[utoipa::path(put, path = "/api/vault/audit/devices/{id}", tag = "Vault",
    summary = "Create or replace a vault audit device (admin)",
    params(("id" = String, Path, description = "Device id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value)))]
pub async fn put_device(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<DeviceBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(AUDIT_KEY, Capability::Admin) {
        return response;
    }
    let device = AuditDevice {
        id,
        kind: body.kind,
        enabled: body.enabled,
        description: body.description,
        hmac_fields: body.hmac_fields,
        options: body.options,
        source: "api".to_owned(),
    };
    if let Err(error) = audit_devices::validate(&device) {
        return invalid_request(&format!("{error:#}"));
    }
    let conn = ctx.store.conn.lock().await;
    if let Err(error) = audit_devices::put(&conn, &device) {
        return invalid_request(&format!("{error:#}"));
    }
    ctx.store.audit_locked(
        &conn,
        &AuditEntry::new(&ctx.actor(), "audit.device.put", "ok").details(json!({
            "id": device.id, "kind": device.kind, "enabled": device.enabled,
        })),
    );
    respond(json!({ "ok": true, "device": device }))
}

/// DELETE /api/vault/audit/devices/{id}.
#[utoipa::path(delete, path = "/api/vault/audit/devices/{id}", tag = "Vault",
    summary = "Delete a vault audit device (admin)",
    params(("id" = String, Path, description = "Device id")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn delete_device(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(AUDIT_KEY, Capability::Admin) {
        return response;
    }
    let conn = ctx.store.conn.lock().await;
    match audit_devices::delete(&conn, &id) {
        Ok(false) => vault_error(VaultError::NotFound(format!("audit device `{id}`")).into()),
        Ok(true) => {
            // Recorded after removal, so the removed device does not see it.
            ctx.store.audit_locked(
                &conn,
                &AuditEntry::new(&ctx.actor(), "audit.device.delete", "ok")
                    .details(json!({ "id": id })),
            );
            respond(json!({ "ok": true }))
        }
        Err(error) => vault_error(error),
    }
}

/// Body of `POST /api/vault/sys/audit-hash`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditHashBody {
    device: String,
    input: String,
}

/// POST /api/vault/sys/audit-hash returns the digest a device writes for an
/// identifier (an accessor, a secret name, an actor id).
#[utoipa::path(post, path = "/api/vault/sys/audit-hash", tag = "Vault",
    summary = "Hash an identifier the way an audit device does (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Digest", body = serde_json::Value)))]
pub async fn audit_hash(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<AuditHashBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(AUDIT_KEY, Capability::Admin) {
        return response;
    }
    if body.input.is_empty() || body.input.len() > 1024 {
        return invalid_request("input must be 1-1024 bytes");
    }
    let conn = ctx.store.conn.lock().await;
    match audit_devices::get(&conn, &body.device) {
        Ok(Some(device)) => {
            let hash = audit_devices::audit_hash(&ctx.store.audit_key, &device.id, &body.input);
            respond(json!({ "device": device.id, "hash": hash }))
        }
        Ok(None) => {
            vault_error(VaultError::NotFound(format!("audit device `{}`", body.device)).into())
        }
        Err(error) => vault_error(error),
    }
}

// ── Declarative init ──────────────────────────────────────────────────────

/// POST /api/vault/sys/init/apply re-applies `RYU_VAULT_INIT_FILE`.
#[utoipa::path(post, path = "/api/vault/sys/init/apply", tag = "Vault",
    summary = "Re-apply the declarative vault init file (admin)",
    responses((status = 200, description = "Apply report", body = serde_json::Value)))]
pub async fn init_apply(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(INIT_KEY, Capability::Admin) {
        return response;
    }
    match declarative::apply_configured(ctx.store).await {
        Ok(Some(report)) => respond(json!({ "configured": true, "report": report })),
        Ok(None) => respond(json!({ "configured": false })),
        Err(error) => invalid_request(&format!("{error:#}")),
    }
}

// ── Event streams ─────────────────────────────────────────────────────────

/// Whether a human caller may see `event`.
fn human_may_see(ctx: &Ctx, event: &VaultEvent) -> bool {
    let scope = event.scope.as_deref().and_then(SecretScope::from_str);
    if let (Some(scope), Some(scope_id), Some(environment), Some(name)) =
        (scope, &event.scope_id, &event.environment, &event.name)
    {
        let coords = SecretCoords {
            scope,
            scope_id: scope_id.clone(),
            environment: environment.clone(),
            path: event
                .path
                .clone()
                .unwrap_or_else(|| crate::vault::ROOT_PATH.to_owned()),
            binding: None,
            name: name.clone(),
        };
        return ctx.caps(&coords).contains(&Capability::List);
    }
    ctx.sys_caps(&event.policy_key())
        .contains(&Capability::List)
}

/// Whether a machine token may see `event`: node-scoped or non-secret events
/// it holds `list` on.
fn machine_may_see(who: &Who, node_id: &str, event: &VaultEvent) -> bool {
    let foreign_secret = event.name.is_some()
        && !(event.scope.as_deref() == Some("node") && event.scope_id.as_deref() == Some(node_id));
    !foreign_secret
        && who
            .sys_caps(&event.policy_key())
            .contains(&Capability::List)
}

/// What a stream's caller may currently see.
struct Grant {
    authorize: Box<dyn Fn(&VaultEvent) -> bool + Send + Sync>,
    /// Unix millis after which the credential is no longer valid.
    expires_at: Option<i64>,
}

/// Re-authenticates a stream's caller from the credentials it connected with.
/// `None` ends the stream.
type Reauth = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Option<Grant>> + Send>> + Send + Sync>;

fn expired(grant: &Grant) -> bool {
    grant
        .expires_at
        .is_some_and(|at| crate::vault::now_millis() >= at)
}

/// Time left until `grant` expires, capped so the select stays cheap.
fn until_expiry(grant: &Grant) -> Duration {
    grant.expires_at.map_or(Duration::from_secs(3600), |at| {
        let left = at.saturating_sub(crate::vault::now_millis()).max(0);
        Duration::from_millis(u64::try_from(left).unwrap_or(0).min(3_600_000))
    })
}

struct StreamState {
    rx: tokio::sync::broadcast::Receiver<VaultEvent>,
    filter: EventFilter,
    grant: Grant,
    reauth: Reauth,
    revalidate: tokio::time::Interval,
}

fn sse(filter: EventFilter, grant: Grant, reauth: Reauth) -> Response {
    use tokio::sync::broadcast::error::RecvError;
    let state = StreamState {
        rx: crate::vault::events::subscribe(),
        filter,
        grant,
        reauth,
        revalidate: tokio::time::interval_at(
            tokio::time::Instant::now() + REVALIDATE_EVERY,
            REVALIDATE_EVERY,
        ),
    };
    let stream = futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if expired(&state.grant) {
                return None;
            }
            let expiry = until_expiry(&state.grant);
            tokio::select! {
                received = state.rx.recv() => match received {
                    Ok(event) => {
                        if REVALIDATE_ON.contains(&event.kind.as_str()) {
                            state.grant = (state.reauth)().await?;
                        }
                        if !state.filter.matches(&event) || !(state.grant.authorize)(&event) {
                            continue;
                        }
                        let data = serde_json::to_string(&event).unwrap_or_default();
                        let frame = Event::default()
                            .event("vault")
                            .id(event.seq.to_string())
                            .data(data);
                        return Some((Ok::<_, Infallible>(frame), state));
                    }
                    Err(RecvError::Lagged(skipped)) => {
                        // Tell the client to refetch instead of silently
                        // dropping changes.
                        let frame = Event::default()
                            .event("lagged")
                            .data(json!({ "skipped": skipped }).to_string());
                        return Some((Ok(frame), state));
                    }
                    Err(RecvError::Closed) => return None,
                },
                _ = state.revalidate.tick() => {
                    state.grant = (state.reauth)().await?;
                }
                () = tokio::time::sleep(expiry) => {}
            }
        }
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn human_grant(ctx: Ctx) -> Grant {
    Grant {
        authorize: Box::new(move |event| human_may_see(&ctx, event)),
        expires_at: None,
    }
}

fn machine_grant(who: Who, node_id: String) -> Grant {
    let expires_at = match &who {
        Who::Machine { principal, .. } => Some(principal.expires_at),
        Who::Human(_) => None,
    };
    Grant {
        authorize: Box::new(move |event| machine_may_see(&who, &node_id, event)),
        expires_at,
    }
}

/// GET /api/vault/events streams vault events (SSE).
#[utoipa::path(get, path = "/api/vault/events", tag = "Vault",
    summary = "Stream value-free vault change events (SSE, list per event)",
    params(
        ("types" = Option<String>, Query, description = "Comma-separated event types"),
        ("environment" = Option<String>, Query, description = "Environment"),
        ("path" = Option<String>, Query, description = "Policy-key glob, e.g. prod/payments/*"),
    ),
    responses((status = 200, description = "text/event-stream", body = serde_json::Value)))]
pub async fn events(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(filter): Query<EventFilter>,
) -> Response {
    let ctx = match human(&state, caller.clone(), &headers).await {
        Ok(Who::Human(ctx)) => ctx,
        Ok(Who::Machine { .. }) => return invalid_request("unexpected machine principal"),
        Err(response) => return response,
    };
    // Reload the caller's policies and bindings from the same credentials, so
    // an unbound or expired binding stops the stream.
    let reauth: Reauth = Arc::new(move || {
        let state = state.clone();
        let caller = caller.clone();
        let headers = headers.clone();
        Box::pin(async move {
            match human(&state, caller, &headers).await {
                Ok(Who::Human(ctx)) => Some(human_grant(ctx)),
                _ => None,
            }
        })
    });
    sse(filter, human_grant(ctx), reauth)
}

/// GET /api/vault/agent/events streams events a machine token may list (SSE).
#[utoipa::path(get, path = "/api/vault/agent/events", tag = "Vault",
    summary = "Stream value-free vault change events with a machine token (SSE)",
    params(
        ("types" = Option<String>, Query, description = "Comma-separated event types"),
        ("environment" = Option<String>, Query, description = "Environment"),
        ("path" = Option<String>, Query, description = "Policy-key glob"),
    ),
    responses((status = 200, description = "text/event-stream", body = serde_json::Value)))]
pub async fn agent_events(headers: HeaderMap, Query(filter): Query<EventFilter>) -> Response {
    let who = match machine(&headers).await {
        Ok(who) => who,
        Err(response) => return response,
    };
    let node_id = local_node_id();
    // Re-run the token lookup, which refuses revoked, expired, and disabled
    // tokens and re-reads the identity's current policy bindings.
    let reauth: Reauth = Arc::new(move || {
        let headers = headers.clone();
        Box::pin(async move {
            let who = machine(&headers).await.ok()?;
            Some(machine_grant(who, local_node_id()))
        })
    });
    sse(filter, machine_grant(who, node_id), reauth)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_secrets::PluginSecretStore;
    use crate::vault::machine::TokenPrincipal;
    use crate::vault::policy::{Policy, PolicyRule};

    fn event(scope: Option<&str>, scope_id: Option<&str>, name: Option<&str>) -> VaultEvent {
        VaultEvent {
            seq: 1,
            at: String::new(),
            kind: "kv-write".into(),
            action: "secret.update".into(),
            environment: Some("prod".into()),
            path: Some("/".into()),
            name: name.map(str::to_owned),
            version: Some(1),
            lease_id: None,
            scope: scope.map(str::to_owned),
            scope_id: scope_id.map(str::to_owned),
            sys_key: None,
        }
    }

    fn machine_with(rules: Vec<PolicyRule>) -> Who {
        Who::Machine {
            store: Box::leak(Box::new(PluginSecretStore::in_memory().unwrap())),
            principal: TokenPrincipal {
                accessor: "rva_x".into(),
                identity_id: "mi_1".into(),
                identity_name: "ci".into(),
                policies: vec!["p".into()],
                expires_at: i64::MAX,
            },
            policies: vec![Policy {
                name: "p".into(),
                description: String::new(),
                rules,
            }],
        }
    }

    fn member_ctx(user_id: &str, policies: Vec<Policy>) -> Ctx {
        Ctx::test_member(
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap())),
            user_id,
            policies,
        )
    }

    fn sys_event(action: &str, kind: &str, sys_key: &str) -> VaultEvent {
        VaultEvent {
            kind: kind.into(),
            action: action.into(),
            environment: None,
            name: None,
            scope: None,
            scope_id: None,
            sys_key: Some(sys_key.into()),
            ..event(None, None, None)
        }
    }

    #[test]
    fn humans_see_own_secrets_and_listed_sys_events() {
        let member = member_ctx("u1", Vec::new());
        // A user-scoped secret is visible to its owner only.
        assert!(human_may_see(
            &member,
            &event(Some("user"), Some("u1"), Some("A"))
        ));
        assert!(!human_may_see(
            &member,
            &event(Some("user"), Some("u2"), Some("A"))
        ));
        let policy = sys_event("policy.put", "policy-change", "sys/policies");
        assert!(!human_may_see(&member, &policy));
        let lister = member_ctx(
            "u1",
            vec![Policy {
                name: "p".into(),
                description: String::new(),
                rules: vec![PolicyRule {
                    path: "sys/policies".into(),
                    capabilities: vec![Capability::List],
                    deny: false,
                    ..Default::default()
                }],
            }],
        );
        assert!(human_may_see(&lister, &policy));
        assert!(!human_may_see(
            &lister,
            &sys_event("transit.rotate", "key-rotate", "sys/transit/payments")
        ));
    }

    #[test]
    fn machine_grants_end_at_token_expiry() {
        let mut who = machine_with(Vec::new());
        if let Who::Machine { principal, .. } = &mut who {
            principal.expires_at = crate::vault::now_millis() - 1;
        }
        let grant = machine_grant(who, "n1".into());
        assert!(expired(&grant));
        assert_eq!(until_expiry(&grant), Duration::ZERO);
        assert!(!expired(&machine_grant(
            machine_with(Vec::new()),
            "n1".into()
        )));
    }

    #[tokio::test]
    async fn streams_end_when_reauthentication_fails() {
        use futures_util::StreamExt;
        let grant = machine_grant(
            machine_with(vec![PolicyRule {
                path: "sys/*".into(),
                capabilities: vec![Capability::List],
                deny: false,
                ..Default::default()
            }]),
            "n1".into(),
        );
        let reauth: Reauth = Arc::new(|| Box::pin(async { None }));
        let response = sse(EventFilter::default(), grant, reauth);
        let mut body = response.into_body().into_data_stream();
        let mut revoked = sys_event("token.revoke", "credential-revoke", "sys/machines");
        revoked.seq = 424_242;
        // Keep publishing until the stream has subscribed and seen the event.
        let ended = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                crate::vault::events::publish_for_test(revoked.clone());
                match tokio::time::timeout(Duration::from_millis(50), body.next()).await {
                    Ok(None) => return true,
                    Ok(Some(chunk)) => {
                        let chunk = chunk.unwrap();
                        assert!(
                            !String::from_utf8_lossy(&chunk).contains("424242"),
                            "a revoked credential must not receive the event"
                        );
                    }
                    Err(_) => {}
                }
            }
        })
        .await
        .unwrap();
        assert!(ended);
    }

    #[test]
    fn machines_see_only_listed_node_events() {
        let who = machine_with(vec![PolicyRule {
            path: "prod/*".into(),
            capabilities: vec![Capability::List],
            deny: false,
            ..Default::default()
        }]);
        assert!(machine_may_see(
            &who,
            "n1",
            &event(Some("node"), Some("n1"), Some("A"))
        ));
        assert!(!machine_may_see(
            &who,
            "n1",
            &event(Some("node"), Some("n2"), Some("A"))
        ));
        assert!(!machine_may_see(
            &who,
            "n1",
            &event(Some("user"), Some("u1"), Some("A"))
        ));
        let none = machine_with(Vec::new());
        assert!(!machine_may_see(
            &none,
            "n1",
            &event(Some("node"), Some("n1"), Some("A"))
        ));
    }
}
