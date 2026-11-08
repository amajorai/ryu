//! Secret Vault token lifecycle, response wrapping, cubbyhole, lease
//! administration, and quota routes.
//!
//! Human routes (node bearer, optional user JWT) manage tokens by accessor,
//! token roles, identity token settings, quotas, and leases; they authorize on
//! `sys/machines`, `sys/token-roles/<name>`, `sys/quotas`, `sys/leases`, and
//! `sys/wrapping`. Machine routes under `/api/vault/agent/*` take
//! `x-ryu-vault-token`; the `sys/wrapping/{unwrap,lookup,rewrap}` routes are
//! authenticated by the wrapping token itself.
//!
//! [`request_layer`] wraps every vault route: it resolves the client address
//! for CIDR-bound tokens, enforces rate-limit and lease-count quotas (`429`),
//! and turns a successful response into a wrapping token when the request
//! carries `X-Ryu-Wrap-TTL` (or the `X-Vault-Wrap-TTL` alias). It also runs the
//! handler inside a policy wrapping scope, so a rule's `minWrappingTtlSecs` /
//! `maxWrappingTtlSecs` refuses a request whose wrap TTL does not meet it.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{invalid_request, respond, store, vault_error};
use super::vault_engines_api::{human, machine, Who, VAULT_TOKEN_HEADER};
use super::{json_error, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::policy::Capability;
use crate::vault::quotas::{self, LeaseFilter, QuotaRule};
use crate::vault::tokens::{self, RequestContext, TokenConfig, TokenRequest, TokenRole};
use crate::vault::wrapping;

/// Request header asking for a wrapped response.
pub const WRAP_TTL_HEADER: &str = "x-ryu-wrap-ttl";
/// HashiCorp-compatible alias of [`WRAP_TTL_HEADER`].
pub const VAULT_WRAP_TTL_HEADER: &str = "x-vault-wrap-ttl";
/// Header carrying a wrapping token (in addition to `x-ryu-vault-token`).
pub const WRAP_TOKEN_HEADER: &str = "x-ryu-wrap-token";

macro_rules! who {
    ($expr:expr) => {
        match $expr {
            Ok(who) => who,
            Err(response) => return response,
        }
    };
}

macro_rules! check {
    ($expr:expr) => {
        if let Err(response) = $expr {
            return response;
        }
    };
}

fn ok_or<T: serde::Serialize>(result: anyhow::Result<T>, key: &str) -> Response {
    match result {
        Ok(value) => respond(json!({ key: value })),
        Err(error) => vault_error(error),
    }
}

fn machine_parts(
    who: &Who,
) -> (
    &'static PluginSecretStore,
    &crate::vault::machine::TokenPrincipal,
) {
    match who {
        Who::Machine {
            store, principal, ..
        } => (*store, principal),
        Who::Human(_) => unreachable!("machine() only returns machines"),
    }
}

mod lease_routes;
mod request_layer;
mod token_routes;
mod wrap_policy;
mod wrap_routes;

pub use lease_routes::*;
pub use request_layer::*;
pub use token_routes::*;
pub use wrap_routes::*;

// ── Routers ───────────────────────────────────────────────────────────────

/// Protected routes (node bearer), merged into the vault router.
pub fn routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post, put};
    let limit = || axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route(
            "/api/vault/tokens",
            get(token_list).post(token_create).layer(limit()),
        )
        .route("/api/vault/tokens/:accessor", get(token_lookup_accessor))
        .route(
            "/api/vault/tokens/:accessor/renew",
            post(token_renew_accessor).layer(limit()),
        )
        .route(
            "/api/vault/tokens/:accessor/revoke-orphan",
            post(token_revoke_orphan),
        )
        .route(
            "/api/vault/machines/:id/token-config",
            put(machine_token_config).layer(limit()),
        )
        .route("/api/vault/token-roles", get(token_roles))
        .route(
            "/api/vault/token-roles/:name",
            get(token_role_get)
                .put(token_role_put)
                .delete(token_role_delete)
                .layer(limit()),
        )
        .route("/api/vault/sys/leases", get(sys_leases))
        .route("/api/vault/sys/leases/count", get(sys_lease_count))
        .route("/api/vault/sys/leases/lookup/:id", get(sys_lease_lookup))
        .route(
            "/api/vault/sys/leases/revoke-prefix",
            post(sys_lease_revoke_prefix).layer(limit()),
        )
        .route(
            "/api/vault/sys/leases/tidy",
            post(sys_lease_tidy).layer(limit()),
        )
        .route("/api/vault/sys/quotas", get(sys_quotas))
        .route(
            "/api/vault/sys/quotas/:name",
            put(sys_quota_put).delete(sys_quota_delete).layer(limit()),
        )
        .route(
            "/api/vault/sys/wrapping/wrap",
            post(sys_wrap).layer(limit()),
        )
}

/// Public routes: machine-token agent routes and wrapping-token routes.
pub fn public_routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post};
    let limit = axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route("/api/vault/agent/self/lookup", get(agent_lookup_self))
        .route("/api/vault/agent/self/renew", post(agent_renew_self))
        .route("/api/vault/agent/self/child", post(agent_create_child))
        .route("/api/vault/agent/wrapping/wrap", post(agent_wrap))
        .route("/api/vault/agent/cubbyhole", get(cubbyhole_list))
        .route(
            "/api/vault/agent/cubbyhole/:key",
            get(cubbyhole_get)
                .put(cubbyhole_put)
                .delete(cubbyhole_delete),
        )
        .route("/api/vault/sys/wrapping/unwrap", post(sys_unwrap))
        .route("/api/vault/sys/wrapping/lookup", post(sys_wrap_lookup))
        .route("/api/vault/sys/wrapping/rewrap", post(sys_rewrap))
        .layer(limit)
        .layer(axum::middleware::from_fn(request_layer))
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "vault_tokens_routes_test.rs"]
mod routes_test;
