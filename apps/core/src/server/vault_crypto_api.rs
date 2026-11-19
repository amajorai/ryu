//! Secret Vault cryptography extensions: transit key lifecycle (BYOK import,
//! export, backup/restore, trim, soft-delete recovery), PKI intermediates,
//! issuer import, and tidy, and workload identity tokens with a public OIDC
//! discovery document and JWKS.
//!
//! Human routes sit under `/api/vault/*` behind the node bearer (plus an
//! optional user JWT) and authorize against `sys/transit/<key>`,
//! `sys/pki/issuers/<name>`, `sys/pki/_tidy`, `sys/identity/<role>`, and
//! `sys/identity/_config`: managing needs `admin`; requesting an identity
//! token or reading a public key needs `use`. Machine routes under
//! `/api/vault/agent/*` accept only `x-ryu-vault-token` and authorize purely by
//! the token's policies. The discovery document and JWKS are public and
//! unauthenticated so relying parties can verify tokens.
//!
//! Key material leaves Core only through `export` and `backup`, which need
//! `admin` and keys created (or configured, one-way) as exportable.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{denied, invalid_request, parse_body, respond, store, vault_error, Ctx};
use super::vault_engines_api::VAULT_TOKEN_HEADER;
use super::{json_error, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::identity_tokens::{IdentityConfig, IdentityRole, IdentitySubject};
use crate::vault::machine::TokenPrincipal;
use crate::vault::policy::{Capability, CapabilitySet, Policy};
use crate::vault::transit::{TransitExportKind, TransitKeyOptions, TransitKeyType};

#[path = "vault_crypto_api/identity.rs"]
mod identity;
#[path = "vault_crypto_api/pki.rs"]
mod pki;
#[path = "vault_crypto_api/transit.rs"]
mod transit;
pub use identity::*;
pub use pki::*;
pub use transit::*;

const IDENTITY_CONFIG_KEY: &str = "sys/identity/_config";
const PKI_TIDY_KEY: &str = "sys/pki/_tidy";
const WRAPPING_KEY_KEY: &str = "sys/transit/_wrapping-key";

fn transit_key(name: &str) -> String {
    format!("sys/transit/{name}")
}

fn issuer_key(name: &str) -> String {
    format!("sys/pki/issuers/{name}")
}

fn identity_key(role: &str) -> String {
    format!("sys/identity/{role}")
}

/// Who is calling: a human on the node bearer or a machine vault token.
/// Shared with the TOTP and password-policy routes in
/// [`super::vault_totp_pwpolicy_api`].
pub(super) enum Caller {
    Human(Ctx),
    Machine {
        store: &'static PluginSecretStore,
        principal: TokenPrincipal,
        policies: Vec<Policy>,
    },
}

impl Caller {
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

    pub(super) fn caps(&self, key: &str) -> CapabilitySet {
        match self {
            Self::Human(ctx) => ctx.sys_caps(key),
            // Machine tokens start from no capabilities; identity templates
            // (`{{identity.machine.id}}`) expand against the token's machine.
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

    pub(super) fn require(&self, key: &str, capability: Capability) -> Result<(), Response> {
        if self.caps(key).contains(&capability) {
            Ok(())
        } else {
            Err(denied(capability, key))
        }
    }

    /// The subject an identity token is issued for. `None` for a human caller
    /// without a verified user id (node bearer only): every such caller would
    /// share the same empty-id `sub`, which relying parties cannot tell apart.
    fn subject(&self) -> Option<IdentitySubject> {
        match self {
            Self::Human(ctx) => {
                let actor = ctx.actor();
                let id = actor.id.clone().filter(|id| !id.is_empty())?;
                Some(IdentitySubject {
                    kind: actor.kind.to_string(),
                    name: id.clone(),
                    id,
                    policies: Vec::new(),
                })
            }
            Self::Machine {
                principal,
                policies,
                ..
            } => {
                let mut names = principal.policies.clone();
                for policy in policies {
                    if !names.contains(&policy.name) {
                        names.push(policy.name.clone());
                    }
                }
                Some(IdentitySubject {
                    kind: "machine".into(),
                    id: principal.identity_id.clone(),
                    name: principal.identity_name.clone(),
                    policies: names,
                })
            }
        }
    }
}

#[cfg(test)]
impl Caller {
    /// A machine caller (identity `mid_x`) holding one `ci` policy with
    /// `rules`, backed by an in-memory store.
    pub(super) fn machine_for_test(rules: Vec<crate::vault::policy::PolicyRule>) -> Self {
        Self::Machine {
            store: Box::leak(Box::new(PluginSecretStore::in_memory().unwrap())),
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
                rules,
            }],
        }
    }
}

pub(super) async fn human(
    state: &ServerState,
    caller: Option<VerifiedCaller>,
    headers: &HeaderMap,
) -> Result<Caller, Response> {
    Ctx::load(state, caller, headers).await.map(Caller::Human)
}

/// Authenticate a machine vault token and load its policies (bound to the
/// machine subject plus the named policies on the token).
pub(super) async fn machine(headers: &HeaderMap) -> Result<Caller, Response> {
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
    let policies = {
        let conn = store.conn.lock().await;
        // Exactly the token's (possibly narrowed) policies: re-adding the
        // identity's bindings would widen a scoped child token.
        crate::vault::machine::principal_policies_locked(&conn, &principal).map_err(vault_error)?
    };
    Ok(Caller::Machine {
        store,
        principal,
        policies,
    })
}

macro_rules! caller {
    ($expr:expr) => {
        match $expr {
            Ok(caller) => caller,
            Err(response) => return response,
        }
    };
}
pub(super) use caller;

macro_rules! require {
    ($caller:expr, $key:expr, $capability:expr) => {
        if let Err(response) = $caller.require(&$key, $capability) {
            return response;
        }
    };
}
pub(super) use require;

pub(super) fn ok_or<T: serde::Serialize>(result: anyhow::Result<T>, key: &str) -> Response {
    match result {
        Ok(value) => respond(json!({ key: value })),
        Err(error) => vault_error(error),
    }
}

/// Node-bearer routes, merged into the vault router.
pub fn routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post, put};
    let limit = || axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route("/api/vault/transit/wrapping-key", get(transit_wrapping_key))
        .route("/api/vault/transit/deleted", get(transit_deleted))
        .route(
            "/api/vault/transit/keys/:name/import",
            post(transit_import).layer(limit()),
        )
        .route(
            "/api/vault/transit/keys/:name/import-version",
            post(transit_import_version).layer(limit()),
        )
        .route("/api/vault/transit/keys/:name/trim", post(transit_trim))
        .route(
            "/api/vault/transit/keys/:name/recover",
            post(transit_recover),
        )
        .route(
            "/api/vault/transit/export/:kind/:name",
            get(transit_export_all),
        )
        .route(
            "/api/vault/transit/export/:kind/:name/:version",
            get(transit_export_version),
        )
        .route("/api/vault/transit/backup/:name", get(transit_backup))
        .route(
            "/api/vault/transit/restore",
            post(transit_restore).layer(limit()),
        )
        .route(
            "/api/vault/pki/issuers/:name/intermediate/generate",
            post(pki_generate_intermediate),
        )
        .route(
            "/api/vault/pki/issuers/:name/intermediate/set-signed",
            post(pki_set_signed).layer(limit()),
        )
        .route(
            "/api/vault/pki/issuers/:name/import",
            post(pki_import_issuer).layer(limit()),
        )
        .route(
            "/api/vault/pki/issuers/:name/sign-intermediate",
            post(pki_sign_intermediate).layer(limit()),
        )
        .route("/api/vault/pki/tidy", post(pki_tidy))
        .route(
            "/api/vault/identity/config",
            get(identity_config).put(identity_set_config),
        )
        .route("/api/vault/identity/keys/rotate", post(identity_rotate))
        .route("/api/vault/identity/roles", get(identity_roles))
        .route(
            "/api/vault/identity/roles/:name",
            put(identity_put_role).delete(identity_delete_role),
        )
        .route("/api/vault/identity/token/:role", post(identity_token))
}

/// Public routes: the OIDC discovery document, the JWKS, and the
/// machine-token identity route (authorized by the vault token).
pub fn public_routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route(
            "/api/vault/identity/.well-known/openid-configuration",
            get(identity_discovery),
        )
        .route("/api/vault/identity/.well-known/keys", get(identity_jwks))
        .route(
            "/api/vault/agent/identity/token/:role",
            post(agent_identity_token),
        )
}

#[cfg(test)]
#[path = "vault_crypto_api/tests.rs"]
mod tests;
