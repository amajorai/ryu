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

mod agent;
pub mod hosted_mcp;
mod proposals_routes;
mod services_routes;
mod sessions_routes;

pub use agent::*;
pub use proposals_routes::*;
pub use services_routes::*;
pub use sessions_routes::*;

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

/// The public routes for any state: no handler here reads server state, so
/// the hosted MCP broker tools dispatch through this same router (behind the
/// vault request layer) without a [`ServerState`]. Mounted on the server as
/// `fn public_routes()` below; `server/vault_public_routes_auth_test.rs` counts
/// the routes from that name in this comment to the end of this function.
fn stateless_public_routes<S: Clone + Send + Sync + 'static>() -> Router<S> {
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

/// Public routes: the CA certificate and the agent surface (in-handler auth).
pub fn public_routes() -> Router<ServerState> {
    stateless_public_routes()
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "vault_broker_routes_test.rs"]
mod routes_test;
