//! Secret Vault engine routes: transit, PKI, SSH certificates, dynamic
//! secrets and leases, machine identities, and machine-authenticated agent
//! routes.
//!
//! Human routes sit under `/api/vault/*` behind the node bearer (plus an
//! optional user JWT) and authorize against `sys/<engine>/<name>` policy keys:
//! configuration managers and the unbound local operator hold every
//! capability; anyone else needs a policy. Managing an engine object needs
//! `admin`; using it (encrypt, sign, issue) needs `use`.
//!
//! Machine routes are public mounts (`/api/vault/auth/*`, `/api/vault/agent/*`)
//! because CI runners and services have no node bearer. Login exchanges an
//! AppRole secret id or an OIDC JWT for a short-lived vault token; agent routes
//! accept only `x-ryu-vault-token` and authorize purely by the token's
//! policies (no baseline). Machines read node-scoped values.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{
    denied, invalid_request, login_token_response, parse_body, respond, store, vault_error, Ctx,
};
use super::{json_error, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::{
    PluginSecretStore, SecretCoords, SecretResolutionContext, SecretScope,
};
use crate::vault::audit::AuditActor;
use crate::vault::dynamic::ProviderConfig;
use crate::vault::machine::{AuthMethod, TokenPrincipal};
use crate::vault::policy::{Capability, CapabilitySet, Policy};
use crate::vault::transit::{
    TransitConfigUpdate, TransitKeyOptions, TransitKeyType, TransitOpOptions,
};
use crate::vault::{dotenv, ROOT_PATH};

/// Header carrying a machine vault token.
pub const VAULT_TOKEN_HEADER: &str = "x-ryu-vault-token";

/// Who is calling an engine route. Shared with the Vault-compatible
/// `/v1/*` surface in [`super::vault_compat_api`].
pub(super) enum Who {
    Human(Ctx),
    Machine {
        store: &'static PluginSecretStore,
        principal: TokenPrincipal,
        policies: Vec<Policy>,
    },
}

impl Who {
    pub(super) fn store(&self) -> &'static PluginSecretStore {
        match self {
            Self::Human(ctx) => ctx.store,
            Self::Machine { store, .. } => store,
        }
    }

    pub(super) fn actor(&self) -> AuditActor {
        match self {
            Self::Human(ctx) => ctx.actor(),
            Self::Machine { principal, .. } => principal.actor(),
        }
    }

    pub(super) fn issued_to(&self) -> String {
        let actor = self.actor();
        format!("{}:{}", actor.kind, actor.id.unwrap_or_default())
    }

    pub(super) fn sys_caps(&self, key: &str) -> CapabilitySet {
        match self {
            Self::Human(ctx) => ctx.sys_caps(key),
            Self::Machine {
                policies,
                principal,
                ..
            } => crate::vault::policy::evaluate_with(
                &CapabilitySet::new(),
                policies,
                key,
                &crate::vault::policy_ext::TemplateContext::from_subjects(&[principal.subject()]),
            ),
        }
    }

    /// Whether a control group gates `read` on `key` for this caller. Machine
    /// tokens cannot open control-group requests, so a gated value is denied.
    pub(super) fn read_gated(&self, key: &str) -> bool {
        match self {
            Self::Human(ctx) => {
                ctx.caller.is_some()
                    && crate::vault::policy_ext::control_group_for(
                        &ctx.policies,
                        key,
                        Capability::Read,
                        &ctx.template_context(),
                    )
                    .is_some()
            }
            Self::Machine {
                policies,
                principal,
                ..
            } => crate::vault::policy_ext::control_group_for(
                policies,
                key,
                Capability::Read,
                &crate::vault::policy_ext::TemplateContext::from_subjects(&[principal.subject()]),
            )
            .is_some(),
        }
    }

    /// The first parameter-constraint violation a write of `value` to the
    /// policy key `key` would commit, if any. Same parameter extraction as
    /// `Ctx::write_parameters_violation`: a JSON-object value contributes its
    /// top-level keys; any other value is the single parameter `value`.
    pub(super) fn write_parameters_violation(&self, key: &str, value: &str) -> Option<String> {
        let (policies, context) = match self {
            Self::Human(ctx) => (&ctx.policies, ctx.template_context()),
            Self::Machine {
                policies,
                principal,
                ..
            } => (
                policies,
                crate::vault::policy_ext::TemplateContext::from_subjects(&[principal.subject()]),
            ),
        };
        let parameters: std::collections::BTreeMap<String, serde_json::Value> =
            match serde_json::from_str::<serde_json::Value>(value) {
                Ok(serde_json::Value::Object(map)) => map.into_iter().collect(),
                _ => std::collections::BTreeMap::from([(
                    "value".to_owned(),
                    serde_json::Value::String(value.to_owned()),
                )]),
            };
        crate::vault::policy_ext::check_parameters(
            policies.iter(),
            key,
            Capability::Write,
            &context,
            &parameters,
        )
        .err()
    }

    pub(super) fn require(&self, key: &str, capability: Capability) -> Result<(), Response> {
        if self.sys_caps(key).contains(&capability) {
            Ok(())
        } else {
            Err(denied(capability, key))
        }
    }
}

pub(super) async fn human(
    state: &ServerState,
    caller: Option<VerifiedCaller>,
    headers: &HeaderMap,
) -> Result<Who, Response> {
    Ctx::load(state, caller, headers).await.map(Who::Human)
}

pub(super) async fn machine(headers: &HeaderMap) -> Result<Who, Response> {
    let store = store()?;
    let token = headers
        .get(VAULT_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or_default();
    let unauthorized = || {
        json_error(
            StatusCode::UNAUTHORIZED,
            "vault_token_invalid: a valid x-ryu-vault-token is required".to_owned(),
        )
    };
    if token.is_empty() {
        return Err(unauthorized());
    }
    let principal = match store.token_lookup(token).await {
        Ok(Some(principal)) => principal,
        Ok(None) => return Err(unauthorized()),
        Err(error) => return Err(vault_error(error)),
    };
    machine_who(store, principal).await
}

/// Build a machine caller from a live token principal. `principal.policies`
/// already holds the identity's policies and its live `machine:<id>`
/// bindings, narrowed for child tokens, so exactly those names resolve.
/// Machines have no baseline capabilities.
pub(super) async fn machine_who(
    store: &'static PluginSecretStore,
    principal: TokenPrincipal,
) -> Result<Who, Response> {
    let policies = {
        let conn = store.conn.lock().await;
        crate::vault::policy::list_policies(&conn)
            .map_err(vault_error)?
            .into_iter()
            .filter(|policy| principal.policies.contains(&policy.name))
            .collect()
    };
    Ok(Who::Machine {
        store,
        principal,
        policies,
    })
}

macro_rules! who {
    ($expr:expr) => {
        match $expr {
            Ok(who) => who,
            Err(response) => return response,
        }
    };
}

/// A listing reduced to the entries the caller holds any capability on, so
/// engine configuration (targets, ARNs, principals) is not enumerable by
/// callers without a grant on it.
fn visible_listing<T: serde::Serialize>(
    who: &Who,
    result: anyhow::Result<Vec<T>>,
    key: &str,
    resource: impl Fn(&T) -> String,
) -> Response {
    match result {
        Ok(items) => {
            let visible: Vec<T> = items
                .into_iter()
                .filter(|item| !who.sys_caps(&resource(item)).is_empty())
                .collect();
            respond(json!({ key: visible }))
        }
        Err(error) => vault_error(error),
    }
}

fn ok_or<T: serde::Serialize>(result: anyhow::Result<T>, key: &str) -> Response {
    match result {
        Ok(value) => respond(json!({ key: value })),
        Err(error) => vault_error(error),
    }
}

#[path = "vault_engine_roles.rs"]
mod roles;
use roles::ssh_sign_op;

#[path = "vault_engines_agent.rs"]
mod agent;
#[path = "vault_engines_dynamic.rs"]
mod dynamic;
#[path = "vault_engines_machines.rs"]
mod machines;
#[path = "vault_engines_pki_ssh.rs"]
mod pki_ssh;
#[path = "vault_engines_transit.rs"]
mod transit;

pub use agent::*;
pub use dynamic::*;
pub use machines::*;
pub use pki_ssh::*;
pub use transit::*;

fn node_coords(
    node_id: &str,
    environment: &str,
    path: &str,
    name: &str,
) -> Result<SecretCoords, Response> {
    SecretCoords {
        scope: SecretScope::Node,
        scope_id: node_id.to_owned(),
        environment: environment.to_owned(),
        path: path.to_owned(),
        binding: None,
        name: name.to_owned(),
    }
    .normalize()
    .map_err(|error| invalid_request(&error.to_string()))
}

pub(super) fn local_node_id() -> String {
    crate::sidecar::control_plane::registered_node()
        .map(|node| node.node_id)
        .unwrap_or_else(crate::server::agent_sync::local_node_id)
}

/// Public machine routes (in-handler token auth).
pub fn public_routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post};
    let limit = axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route("/api/vault/auth/approle/login", post(approle_login))
        .route("/api/vault/auth/jwt/login", post(jwt_login))
        .route("/api/vault/agent/self", get(agent_self))
        .route(
            "/api/vault/agent/events",
            get(super::vault_audit_events_api::agent_events),
        )
        .route("/api/vault/agent/self/revoke", post(agent_revoke_self))
        .route("/api/vault/agent/export", post(agent_export))
        .route("/api/vault/agent/secrets/:name", get(agent_secret))
        .route("/api/vault/agent/dynamic/:role", post(agent_dynamic_issue))
        .route(
            "/api/vault/agent/leases/:id/:op",
            post(agent_lease_operation),
        )
        .route("/api/vault/agent/transit/:op/:name", post(agent_transit))
        .route("/api/vault/agent/pki/:op/:role", post(agent_pki))
        .route("/api/vault/agent/ssh/sign/:role", post(agent_ssh_sign))
        .layer(limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn login_failures_do_not_reveal_identity_names_or_methods() {
        use crate::vault::VaultError;
        let body = |response: Response| async move {
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
                .await
                .unwrap();
            (status, String::from_utf8_lossy(&bytes).into_owned())
        };
        let mut seen = Vec::new();
        for error in [
            VaultError::NotFound("machine identity `ci`".into()),
            VaultError::Invalid("identity does not use JWT login".into()),
            VaultError::Denied("identity is disabled".into()),
            VaultError::Denied("JWT rejected: bad audience".into()),
            VaultError::Conflict("busy".into()),
        ] {
            let (status, text) = body(login_token_response::<String>(Err(error.into()))).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
            seen.push(text);
        }
        assert!(seen.windows(2).all(|pair| pair[0] == pair[1]), "{seen:?}");
        assert!(!seen[0].contains("ci") && !seen[0].contains("JWT"));
        let (status, _) = body(login_token_response::<String>(Err(
            VaultError::Sealed.into()
        )))
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        let (status, text) = body(login_token_response(Ok("t".to_owned()))).await;
        assert_eq!(status, StatusCode::OK, "{text}");
    }

    #[tokio::test]
    async fn machine_principals_have_no_baseline() {
        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        let principal = TokenPrincipal {
            accessor: "rva_x".into(),
            identity_id: "mid_x".into(),
            identity_name: "ci".into(),
            policies: vec!["ci".into()],
            expires_at: i64::MAX,
        };
        let policy = Policy {
            name: "ci".into(),
            description: String::new(),
            rules: vec![crate::vault::policy::PolicyRule {
                path: "sys/transit/payments".into(),
                capabilities: vec![Capability::Use],
                deny: false,
                ..Default::default()
            }],
        };
        let who = Who::Machine {
            store,
            principal,
            policies: vec![policy],
        };
        assert!(who.require("sys/transit/payments", Capability::Use).is_ok());
        assert!(who
            .require("sys/transit/payments", Capability::Admin)
            .is_err());
        assert!(who.require("sys/transit/other", Capability::Use).is_err());
        assert!(who.require("default/API_KEY", Capability::Read).is_err());
        assert_eq!(who.issued_to(), "machine:mid_x");
    }
}
