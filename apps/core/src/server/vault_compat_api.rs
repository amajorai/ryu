//! HashiCorp Vault-compatible `/v1/*` surface over the Ryu secret vault.
//!
//! Existing Vault tooling (the `vault` CLI, `hvac`, the Go client, CI
//! integrations) can talk to Core with machine credentials:
//!
//! - `GET|HEAD /v1/sys/health`, `GET /v1/sys/seal-status`, and
//!   `GET /v1/sys/leader` are unauthenticated, as in Vault (see [`sys`]).
//! - `POST /v1/auth/{approle,jwt,cert,aws,kubernetes}/login` exchange a
//!   machine credential for a machine vault token (see [`auth`]).
//! - `/v1/auth/token/{lookup-self,renew-self,revoke-self,create}` manage the
//!   presented token and its children (see [`token`]).
//! - `GET /v1/sys/internal/ui/mounts/secret/...` reports a KV v2 mount so the
//!   `vault kv` commands pick the v2 wire format.
//! - KV v2 on the fixed `secret/` mount: `data/<path>` (read, write, soft
//!   delete) and `metadata/<path>` (read, `LIST` or `?list=true`, destroy).
//! - Transit operations on `/v1/transit/*` (see [`transit`]).
//! - `POST /v1/sys/tools/random` and `/v1/sys/tools/hash` for any valid token
//!   (see [`tools`]).
//!
//! Mapping: a Vault secret path `a/b` is the Ryu folder `/a/b` in the node's
//! active environment (or the `X-Ryu-Environment` header), and each key of
//! the Vault `data` object is one node-scoped value in that folder. Keys must
//! therefore be environment-variable names. A write replaces the whole key
//! set atomically, like KV v2, and advances a monotonic per-folder version
//! that check-and-set compares under the store lock.
//!
//! Every other route authenticates with `X-Vault-Token` (or
//! `Authorization: Bearer`) only, and answers Vault's `503 Vault is sealed`
//! while the vault is sealed. Data routes first require that the caller's policies could grant the
//! capability somewhere in the folder, before anything is looked up, so a
//! denied caller gets 403 whether or not the secret exists. They then check
//! every key's `ENV/folder/NAME` policy key all-or-nothing, like Vault's path
//! ACLs; machines have no baseline. Token
//! lookup is by digest, so the presented token is never compared byte-wise.
//! Store operations write their own audit rows. Errors use Vault's
//! `{"errors": [...]}` envelope and never echo tokens, secret ids, JWTs, or
//! values.

use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;

use super::vault_engines_api::local_node_id;
use crate::plugin_secrets::PluginSecretStore;

/// The single KV v2 mount this surface exposes.
pub const KV_MOUNT: &str = "secret";
/// Header Vault clients use to present a token.
pub const VAULT_COMPAT_TOKEN_HEADER: &str = "x-vault-token";
/// Optional header selecting the Ryu environment (default: node's active).
pub const ENVIRONMENT_HEADER: &str = "x-ryu-environment";

/// Where handlers find the store and node. Production resolves the global
/// store lazily (it may be installed after the router is built); tests pin an
/// in-memory store.
#[derive(Clone, Default)]
pub struct CompatState {
    store: Option<&'static PluginSecretStore>,
    node_id: Option<String>,
}

impl CompatState {
    /// The installed store, sealed or not (health and seal status only).
    fn installed(&self) -> Option<&'static PluginSecretStore> {
        self.store.or_else(crate::plugin_secrets::global)
    }

    /// The store for every other route. A sealed vault (or none) is refused
    /// with Vault's sealed 503 before any credential is looked at, as Vault
    /// refuses everything but its status routes while sealed.
    fn store(&self) -> Result<&'static PluginSecretStore, Response> {
        match self.installed() {
            Some(store) if !store.keyring.is_sealed() => Ok(store),
            _ => Err(errors(StatusCode::SERVICE_UNAVAILABLE, "Vault is sealed")),
        }
    }

    fn node_id(&self) -> String {
        self.node_id.clone().unwrap_or_else(local_node_id)
    }
}

macro_rules! tri {
    ($expr:expr) => {
        match $expr {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
}

mod auth;
mod envelope;
mod kv_data;
mod kv_metadata;
mod kv_target;
mod sys;
mod token;
mod tools;
mod transit;

pub(crate) use auth::*;
use envelope::*;
pub(crate) use kv_data::*;
pub(crate) use kv_metadata::*;
use kv_target::*;
pub(crate) use sys::*;
pub(crate) use token::*;
pub(crate) use tools::*;
pub(crate) use transit::*;

fn router_with<S: Clone + Send + Sync + 'static>(state: CompatState) -> Router<S> {
    let limit = axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    let data = format!("/v1/{KV_MOUNT}/data/*path");
    let metadata = format!("/v1/{KV_MOUNT}/metadata/*path");
    let metadata_root = format!("/v1/{KV_MOUNT}/metadata");
    let metadata_root_slash = format!("/v1/{KV_MOUNT}/metadata/");
    Router::new()
        .route("/v1/sys/health", get(sys_health))
        .route("/v1/sys/seal-status", get(seal_status))
        .route("/v1/sys/leader", get(leader))
        .route("/v1/auth/approle/login", post(approle_login))
        .route("/v1/auth/jwt/login", post(jwt_login))
        .route("/v1/auth/cert/login", post(cert_login))
        .route("/v1/auth/aws/login", post(aws_login))
        .route("/v1/auth/kubernetes/login", post(kubernetes_login))
        .route(
            "/v1/auth/token/lookup-self",
            get(lookup_self).post(lookup_self_post),
        )
        .route("/v1/auth/token/revoke-self", post(revoke_self))
        .route("/v1/auth/token/renew-self", post(renew_self))
        .route("/v1/auth/token/create", post(token_create))
        .route("/v1/auth/token/create/:role_name", post(token_create_role))
        .route("/v1/sys/internal/ui/mounts/*path", get(ui_mount))
        .route("/v1/sys/tools/random", post(tools_random))
        .route("/v1/sys/tools/random/*params", post(tools_random_params))
        .route("/v1/sys/tools/hash", post(tools_hash))
        .route("/v1/sys/tools/hash/*algorithm", post(tools_hash_algorithm))
        .route("/v1/transit/encrypt/:name", post(transit_encrypt))
        .route("/v1/transit/decrypt/:name", post(transit_decrypt))
        .route("/v1/transit/rewrap/:name", post(transit_rewrap))
        .route("/v1/transit/datakey/:kind/:name", post(transit_datakey))
        .route("/v1/transit/sign/*rest", post(transit_sign))
        .route("/v1/transit/verify/*rest", post(transit_verify))
        .route("/v1/transit/hmac/*rest", post(transit_hmac))
        .route("/v1/transit/keys/:name/rotate", post(transit_rotate))
        .route(
            &data,
            get(read_data)
                .put(write_data)
                .post(write_data_post)
                .delete(delete_data)
                .fallback(method_not_allowed),
        )
        .route(
            &metadata,
            get(get_metadata)
                .delete(delete_metadata)
                .fallback(metadata_other),
        )
        .route(
            &metadata_root,
            get(get_metadata_root).fallback(metadata_other),
        )
        .route(
            &metadata_root_slash,
            get(get_metadata_root).fallback(metadata_other),
        )
        .layer(limit)
        .with_state(state)
}

/// Public routes: authentication is in-handler (`X-Vault-Token`), because
/// Vault clients hold machine tokens, not the node bearer.
pub fn public_routes() -> Router<super::ServerState> {
    router_with(CompatState::default())
}

#[cfg(test)]
mod fixture_test;

#[cfg(test)]
mod auth_tests;
#[cfg(test)]
mod envelope_tests;
#[cfg(test)]
mod kv_data_tests;
#[cfg(test)]
mod kv_metadata_tests;
#[cfg(test)]
mod kv_target_tests;
#[cfg(test)]
mod sys_tests;
#[cfg(test)]
mod token_tests;
#[cfg(test)]
mod tools_tests;
#[cfg(test)]
mod transit_tests;
