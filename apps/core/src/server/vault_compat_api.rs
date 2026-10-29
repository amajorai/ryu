//! HashiCorp Vault-compatible `/v1/*` surface over the Ryu secret vault.
//!
//! Existing Vault tooling (the `vault` CLI, `hvac`, the Go client, CI
//! integrations) can talk to Core with machine credentials:
//!
//! - `POST /v1/auth/approle/login` and `POST /v1/auth/jwt/login` exchange an
//!   AppRole secret id or an OIDC JWT for a machine vault token.
//! - `GET|POST /v1/auth/token/lookup-self` and `POST /v1/auth/token/revoke-self`.
//! - `GET /v1/sys/internal/ui/mounts/secret/...` reports a KV v2 mount so the
//!   `vault kv` commands pick the v2 wire format.
//! - KV v2 on the fixed `secret/` mount: `data/<path>` (read, write, soft
//!   delete) and `metadata/<path>` (read, `LIST` or `?list=true`, destroy).
//!
//! Mapping: a Vault secret path `a/b` is the Ryu folder `/a/b` in the node's
//! active environment (or the `X-Ryu-Environment` header), and each key of
//! the Vault `data` object is one node-scoped value in that folder. Keys must
//! therefore be environment-variable names. A write replaces the whole key
//! set atomically, like KV v2, and advances a monotonic per-folder version
//! that check-and-set compares under the store lock.
//!
//! Every route authenticates with `X-Vault-Token` (or `Authorization: Bearer`)
//! only. Data routes first require that the caller's policies could grant the
//! capability somewhere in the folder, before anything is looked up, so a
//! denied caller gets 403 whether or not the secret exists. They then check
//! every key's `ENV/folder/NAME` policy key all-or-nothing, like Vault's path
//! ACLs; machines have no baseline. Token
//! lookup is by digest, so the presented token is never compared byte-wise.
//! Store operations write their own audit rows. Errors use Vault's
//! `{"errors": [...]}` envelope and never echo tokens, secret ids, JWTs, or
//! values.

use std::collections::{BTreeMap, BTreeSet};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::no_store_response;
use super::vault_engines_api::{local_node_id, machine_who, Who};
use crate::plugin_secrets::kv::ListFilter;
use crate::plugin_secrets::{
    KvFolder, KvFolderReplace, KvFolderState, PluginSecretStore, SecretCoords, SecretScope,
    VaultSecretInfo, MAX_VAULT_SECRET_VALUE_LEN,
};
use crate::vault::machine::IssuedToken;
use crate::vault::policy::{glob_matches, may_match_child, Capability};
use crate::vault::{VaultError, ROOT_PATH};

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
    fn store(&self) -> Result<&'static PluginSecretStore, Response> {
        self.store
            .or_else(crate::plugin_secrets::global)
            .ok_or_else(|| errors(StatusCode::SERVICE_UNAVAILABLE, "Vault is sealed"))
    }

    fn node_id(&self) -> String {
        self.node_id.clone().unwrap_or_else(local_node_id)
    }
}

// ── Envelope ──────────────────────────────────────────────────────────────

fn errors(status: StatusCode, message: &str) -> Response {
    let list: Vec<&str> = if message.is_empty() {
        Vec::new()
    } else {
        vec![message]
    };
    no_store_response((status, Json(json!({ "errors": list }))).into_response())
}

fn permission_denied() -> Response {
    errors(StatusCode::FORBIDDEN, "permission denied")
}

fn not_found() -> Response {
    errors(StatusCode::NOT_FOUND, "")
}

fn no_content() -> Response {
    no_store_response(StatusCode::NO_CONTENT.into_response())
}

/// Map a store error. Denials are generic so login failures do not reveal
/// which credential part was wrong; storage errors are not echoed.
fn store_error(error: &anyhow::Error) -> Response {
    if let Some(vault) = error.downcast_ref::<VaultError>() {
        return match vault {
            VaultError::Sealed => errors(StatusCode::SERVICE_UNAVAILABLE, "Vault is sealed"),
            VaultError::AuditUnavailable => {
                errors(StatusCode::SERVICE_UNAVAILABLE, "audit unavailable")
            }
            VaultError::Invalid(message) | VaultError::Conflict(message) => {
                errors(StatusCode::BAD_REQUEST, message)
            }
            VaultError::NotFound(_) => not_found(),
            VaultError::Denied(_) => permission_denied(),
        };
    }
    if error.downcast_ref::<rusqlite::Error>().is_some() {
        tracing::warn!("vault compat storage error: {error:#}");
        return errors(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }
    // Validation failures from the store (names, paths, sizes); top-level
    // message only, which never carries a value.
    errors(StatusCode::BAD_REQUEST, &error.to_string())
}

fn rfc3339(millis: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|at| at.to_rfc3339())
        .unwrap_or_default()
}

/// A Vault success envelope around `data` and/or `auth`.
fn envelope(data: Option<Value>, auth: Option<Value>) -> Response {
    no_store_response(
        Json(json!({
            "request_id": uuid::Uuid::new_v4().to_string(),
            "lease_id": "",
            "renewable": false,
            "lease_duration": 0,
            "data": data,
            "wrap_info": null,
            "warnings": null,
            "auth": auth,
        }))
        .into_response(),
    )
}

fn parse_json<T: serde::de::DeserializeOwned>(body: &Bytes) -> Result<T, Response> {
    let raw: &[u8] = if body.is_empty() { b"{}" } else { body };
    serde_json::from_slice(raw)
        .map_err(|_| errors(StatusCode::BAD_REQUEST, "failed to parse JSON input"))
}

macro_rules! tri {
    ($expr:expr) => {
        match $expr {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
}

// ── Caller ────────────────────────────────────────────────────────────────

fn presented_token(headers: &HeaderMap) -> Option<String> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    header(VAULT_COMPAT_TOKEN_HEADER).or_else(|| {
        header("authorization").and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .map(|token| token.trim().to_owned())
        })
    })
}

async fn caller(state: &CompatState, headers: &HeaderMap) -> Result<Who, Response> {
    let store = state.store()?;
    let Some(token) = presented_token(headers) else {
        return Err(permission_denied());
    };
    let principal = match store.token_lookup(&token).await {
        Ok(Some(principal)) => principal,
        Ok(None) => return Err(permission_denied()),
        Err(error) => return Err(store_error(&error)),
    };
    machine_who(store, principal)
        .await
        .map_err(|_| errors(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))
}

fn require(who: &Who, key: &str, capability: Capability) -> Result<(), Response> {
    who.require(key, capability)
        .map_err(|_| permission_denied())
}

/// Whether the caller holds any of `capabilities` on `key`.
fn holds_any(who: &Who, key: &str, capabilities: &[Capability]) -> bool {
    let caps = who.sys_caps(key);
    capabilities
        .iter()
        .any(|capability| caps.contains(capability))
}

// ── Auth ──────────────────────────────────────────────────────────────────

fn auth_body(token: IssuedToken) -> Value {
    let ttl = ((token.expires_at - Utc::now().timestamp_millis()) / 1000).max(0);
    json!({
        "client_token": token.token,
        "accessor": token.accessor,
        "policies": token.policies,
        "token_policies": token.policies,
        "identity_policies": [],
        "metadata": { "identity_id": token.identity_id },
        "lease_duration": ttl,
        "renewable": false,
        "entity_id": token.identity_id,
        "token_type": "service",
        "orphan": true,
    })
}

#[derive(Debug, Deserialize)]
struct AppRoleLoginBody {
    role_id: String,
    secret_id: String,
}

/// POST /v1/auth/approle/login.
async fn approle_login(State(state): State<CompatState>, body: Bytes) -> Response {
    let store = tri!(state.store());
    let body: AppRoleLoginBody = tri!(parse_json(&body));
    match store.approle_login(&body.role_id, &body.secret_id).await {
        Ok(token) => envelope(None, Some(auth_body(token))),
        Err(error) => store_error(&error),
    }
}

#[derive(Debug, Deserialize)]
struct JwtLoginBody {
    /// The Ryu machine identity name.
    role: String,
    jwt: String,
}

/// POST /v1/auth/jwt/login.
async fn jwt_login(State(state): State<CompatState>, body: Bytes) -> Response {
    let store = tri!(state.store());
    let body: JwtLoginBody = tri!(parse_json(&body));
    match store.jwt_login(&body.role, &body.jwt).await {
        Ok(token) => envelope(None, Some(auth_body(token))),
        // Unknown identities, identities using another auth method, disabled
        // identities, and rejected JWTs all look the same to the caller, so
        // this public route cannot enumerate identity names. A fail-closed
        // audit refusal stays a 503 so the caller can retry.
        Err(error)
            if error.downcast_ref::<VaultError>().is_some_and(|e| {
                !matches!(e, VaultError::Sealed | VaultError::AuditUnavailable)
            }) =>
        {
            permission_denied()
        }
        Err(error) => store_error(&error),
    }
}

/// GET|POST /v1/auth/token/lookup-self.
async fn lookup_self(State(state): State<CompatState>, headers: HeaderMap) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let Who::Machine { principal, .. } = &who else {
        return permission_denied();
    };
    let ttl = ((principal.expires_at - Utc::now().timestamp_millis()) / 1000).max(0);
    envelope(
        Some(json!({
            "accessor": principal.accessor,
            "display_name": principal.identity_name,
            "entity_id": principal.identity_id,
            "expire_time": rfc3339(principal.expires_at),
            "ttl": ttl,
            "policies": principal.policies,
            "renewable": false,
            "orphan": true,
            "type": "service",
        })),
        None,
    )
}

/// POST /v1/auth/token/revoke-self.
async fn revoke_self(State(state): State<CompatState>, headers: HeaderMap) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let Who::Machine {
        store, principal, ..
    } = &who
    else {
        return permission_denied();
    };
    match store
        .token_revoke(&principal.accessor, &principal.actor())
        .await
    {
        Ok(()) => no_content(),
        Err(error) => store_error(&error),
    }
}

// ── sys ───────────────────────────────────────────────────────────────────

/// GET /v1/sys/internal/ui/mounts/{path}: mount discovery used by `vault kv`.
async fn ui_mount(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
) -> Response {
    tri!(caller(&state, &headers).await);
    let mount = path.trim_start_matches('/').split('/').next().unwrap_or("");
    if mount != KV_MOUNT {
        return permission_denied();
    }
    envelope(
        Some(json!({
            "path": format!("{KV_MOUNT}/"),
            "type": "kv",
            "description": "Ryu secret vault (KV v2 compatible)",
            "options": { "version": "2" },
        })),
        None,
    )
}

// ── KV v2 ─────────────────────────────────────────────────────────────────

/// The folder and environment one Vault secret path addresses.
struct Target {
    environment: String,
    folder: String,
    node_id: String,
}

impl Target {
    fn resolve(
        state: &CompatState,
        headers: &HeaderMap,
        path: &str,
        allow_root: bool,
    ) -> Result<Self, Response> {
        let environment = headers
            .get(ENVIRONMENT_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(crate::vault::active_environment);
        if !crate::vault::is_valid_environment(&environment) {
            return Err(errors(StatusCode::BAD_REQUEST, "invalid environment"));
        }
        let folder = crate::vault::normalize_path(path)
            .ok_or_else(|| errors(StatusCode::BAD_REQUEST, "invalid secret path"))?;
        if folder == ROOT_PATH && !allow_root {
            return Err(errors(StatusCode::BAD_REQUEST, "a secret path is required"));
        }
        Ok(Self {
            environment,
            folder,
            node_id: state.node_id(),
        })
    }

    fn coords(&self, name: &str) -> Result<SecretCoords, Response> {
        SecretCoords {
            scope: SecretScope::Node,
            scope_id: self.node_id.clone(),
            environment: self.environment.clone(),
            path: self.folder.clone(),
            binding: None,
            name: name.to_owned(),
        }
        .normalize()
        .map_err(|_| {
            errors(
                StatusCode::BAD_REQUEST,
                "data keys must be environment-variable names ([A-Za-z_][A-Za-z0-9_]*)",
            )
        })
    }

    fn owns(&self, info: &VaultSecretInfo) -> bool {
        info.scope == SecretScope::Node && info.scope_id == self.node_id && info.binding.is_none()
    }

    fn kv_folder(&self) -> KvFolder {
        KvFolder {
            scope_id: self.node_id.clone(),
            environment: self.environment.clone(),
            path: self.folder.clone(),
        }
    }

    /// The node's keys directly in this folder (including soft-deleted ones)
    /// and the folder's KV v2 version.
    async fn state(&self, store: &PluginSecretStore) -> Result<KvFolderState, Response> {
        store
            .kv_folder_state(&self.kv_folder())
            .await
            .map_err(|error| store_error(&error))
    }

    /// `ENV/folder`, the prefix of every key's policy key.
    fn folder_key(&self) -> String {
        if self.folder == ROOT_PATH {
            self.environment.clone()
        } else {
            format!("{}{}", self.environment, self.folder)
        }
    }

    /// Folder-level authorization, checked before the folder is looked up:
    /// some allow rule for one of `capabilities` must be able to match a key
    /// in the folder, and no deny rule may cover every key in it. Per-key
    /// checks still follow; this only keeps a caller with no possible grant
    /// from learning whether the secret exists or what version it is at.
    fn require_folder(&self, who: &Who, capabilities: &[Capability]) -> Result<(), Response> {
        let Who::Machine { policies, .. } = who else {
            return Err(permission_denied());
        };
        let key = self.folder_key();
        // A deny pattern that matches both probes matches every key name.
        let probes = [format!("{key}/*"), format!("{key}/**")];
        let granted = capabilities.iter().any(|capability| {
            let rules = || {
                policies
                    .iter()
                    .flat_map(|policy| &policy.rules)
                    .filter(|rule| rule.capabilities.contains(capability))
            };
            rules().any(|rule| !rule.deny && may_match_child(&rule.path, &key))
                && !rules().any(|rule| {
                    rule.deny && probes.iter().all(|probe| glob_matches(&rule.path, probe))
                })
        });
        if granted {
            Ok(())
        } else {
            Err(permission_denied())
        }
    }

    /// Writes into a protected environment need change approval, which this
    /// surface cannot carry; only callers holding `admin` on every key may
    /// write directly, matching the native API's bypass.
    async fn require_unprotected(&self, who: &Who, keys: &[SecretCoords]) -> Result<(), Response> {
        match who.store().environment(&self.environment).await {
            Ok(Some(env)) if env.protected => {
                if keys.iter().all(|coords| {
                    who.sys_caps(&coords.policy_key())
                        .contains(&Capability::Admin)
                }) {
                    Ok(())
                } else {
                    Err(errors(
                        StatusCode::FORBIDDEN,
                        "permission denied: the environment is protected and requires change approval",
                    ))
                }
            }
            Ok(_) => Ok(()),
            Err(error) => Err(store_error(&error)),
        }
    }
}

fn version_metadata(version: i64, created: i64, deleted: Option<i64>) -> Value {
    json!({
        "created_time": rfc3339(created),
        "custom_metadata": null,
        "deletion_time": deleted.map(rfc3339).unwrap_or_default(),
        "destroyed": false,
        "version": version,
    })
}

#[derive(Debug, Default, Deserialize)]
struct DataQuery {
    #[serde(default)]
    version: Option<i64>,
}

/// GET /v1/secret/data/{path}.
async fn read_data(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
    Query(query): Query<DataQuery>,
) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let target = tri!(Target::resolve(&state, &headers, &path, false));
    tri!(target.require_folder(&who, &[Capability::Read]));
    let folder = tri!(target.state(who.store()).await);
    let live: Vec<&VaultSecretInfo> = folder
        .keys
        .iter()
        .filter(|i| i.deleted_at.is_none())
        .collect();
    if live.is_empty() {
        return not_found();
    }
    // All-or-nothing, like a Vault path ACL: returning only the readable keys
    // would let a later full-replace write silently remove the hidden ones.
    for info in &live {
        let key = info.coords().policy_key();
        tri!(require(&who, &key, Capability::Read));
        // Compat tokens cannot open control-group requests; a gated value is
        // refused, as on the native machine read path.
        if who.read_gated(&key) {
            return permission_denied();
        }
    }
    let version = folder.version;
    if query
        .version
        .is_some_and(|wanted| wanted != 0 && wanted != version)
    {
        return errors(
            StatusCode::BAD_REQUEST,
            "only the current version can be read through this API",
        );
    }
    let mut data = Map::new();
    for info in &live {
        match who.store().reveal(&info.coords(), None, &who.actor()).await {
            Ok(value) => {
                data.insert(info.name.clone(), Value::String(value));
            }
            Err(error) => return store_error(&error),
        }
    }
    let created = live.iter().map(|i| i.updated_at).max().unwrap_or(0);
    envelope(
        Some(json!({
            "data": data,
            "metadata": version_metadata(version, created, None),
        })),
        None,
    )
}

#[derive(Debug, Default, Deserialize)]
struct WriteOptions {
    #[serde(default)]
    cas: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct WriteBody {
    data: Map<String, Value>,
    #[serde(default)]
    options: WriteOptions,
}

fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// PUT|POST /v1/secret/data/{path}: replace the secret's key set.
async fn write_data(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
    body: Bytes,
) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let target = tri!(Target::resolve(&state, &headers, &path, false));
    let body: WriteBody = tri!(parse_json(&body));

    let mut writes: Vec<(SecretCoords, String)> = Vec::with_capacity(body.data.len());
    for (name, value) in &body.data {
        let coords = tri!(target.coords(name));
        let Some(text) = scalar_text(value) else {
            return errors(
                StatusCode::BAD_REQUEST,
                "data values must be strings, numbers, or booleans",
            );
        };
        if text.trim().is_empty() {
            return errors(StatusCode::BAD_REQUEST, "data values must not be empty");
        }
        if text.len() > MAX_VAULT_SECRET_VALUE_LEN {
            return errors(
                StatusCode::BAD_REQUEST,
                "a data value exceeds the maximum size",
            );
        }
        tri!(require(&who, &coords.policy_key(), Capability::Write));
        if who
            .write_parameters_violation(&coords.policy_key(), &text)
            .is_some()
        {
            return permission_denied();
        }
        writes.push((coords, text));
    }
    // Before any lookup (an empty `data` object checks nothing above).
    tri!(target.require_folder(&who, &[Capability::Write]));

    // Authorize implicit removals against a snapshot; the store refuses the
    // replace if a key outside this set is live when it runs.
    let snapshot = tri!(target.state(who.store()).await);
    let mut removals = Vec::new();
    for info in snapshot.keys.iter().filter(|i| i.deleted_at.is_none()) {
        if !body.data.contains_key(&info.name) {
            let coords = info.coords();
            tri!(require(&who, &coords.policy_key(), Capability::Delete));
            removals.push(coords);
        }
    }
    let touched: Vec<SecretCoords> = writes
        .iter()
        .map(|(coords, _)| coords.clone())
        .chain(removals.iter().cloned())
        .collect();
    tri!(target.require_unprotected(&who, &touched).await);

    let actor = who.actor();
    let after = match who
        .store()
        .kv_folder_replace(KvFolderReplace {
            folder: target.kv_folder(),
            writes,
            removable: removals.into_iter().map(|coords| coords.name).collect(),
            cas: body.options.cas,
            actor: &actor,
        })
        .await
    {
        Ok(after) => after,
        Err(error) => return store_error(&error),
    };
    let created = after
        .keys
        .iter()
        .filter(|i| i.deleted_at.is_none())
        .map(|i| i.updated_at)
        .max()
        .unwrap_or_else(|| Utc::now().timestamp_millis());
    envelope(Some(version_metadata(after.version, created, None)), None)
}

/// DELETE /v1/secret/data/{path}: soft-delete every key (restorable).
async fn delete_data(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let target = tri!(Target::resolve(&state, &headers, &path, false));
    tri!(target.require_folder(&who, &[Capability::Delete]));
    let folder = tri!(target.state(who.store()).await);
    let coords: Vec<SecretCoords> = folder
        .keys
        .iter()
        .filter(|i| i.deleted_at.is_none())
        .map(VaultSecretInfo::coords)
        .collect();
    for key in &coords {
        tri!(require(&who, &key.policy_key(), Capability::Delete));
    }
    tri!(target.require_unprotected(&who, &coords).await);
    let actor = who.actor();
    for key in coords {
        if let Err(error) = who.store().soft_delete(key, &actor).await {
            return store_error(&error);
        }
    }
    no_content()
}

#[derive(Debug, Default, Deserialize)]
struct MetadataQuery {
    #[serde(default)]
    list: Option<String>,
}

impl MetadataQuery {
    fn is_list(&self) -> bool {
        self.list
            .as_deref()
            .is_some_and(|value| matches!(value, "true" | "1"))
    }
}

/// Immediate children of `folder` visible to the caller: `name` for a
/// secret (a folder holding keys) and `name/` for a deeper prefix.
async fn list_children(state: &CompatState, headers: &HeaderMap, path: &str) -> Response {
    let who = tri!(caller(state, headers).await);
    let target = tri!(Target::resolve(state, headers, path, true));
    let items = match who
        .store()
        .list_vault_secrets_filtered(&ListFilter {
            environment: Some(target.environment.clone()),
            path: Some(target.folder.clone()),
            recursive: true,
            include_deleted: false,
        })
        .await
    {
        Ok(items) => items,
        Err(error) => return store_error(&error),
    };
    let prefix = if target.folder == ROOT_PATH {
        "/".to_owned()
    } else {
        format!("{}/", target.folder)
    };
    let mut keys = BTreeSet::new();
    for info in items.iter().filter(|info| target.owns(info)) {
        if !who
            .sys_caps(&info.coords().policy_key())
            .contains(&Capability::List)
        {
            continue;
        }
        let Some(rest) = info.path.strip_prefix(&prefix) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        match rest.split_once('/') {
            Some((head, _)) => keys.insert(format!("{head}/")),
            None => keys.insert(rest.to_owned()),
        };
    }
    if keys.is_empty() {
        return not_found();
    }
    envelope(Some(json!({ "keys": keys })), None)
}

async fn read_metadata(who: &Who, target: &Target) -> Response {
    const METADATA: [Capability; 2] = [Capability::List, Capability::Read];
    tri!(target.require_folder(who, &METADATA));
    let folder = tri!(target.state(who.store()).await);
    let all = &folder.keys;
    if all.is_empty() {
        return not_found();
    }
    if !all
        .iter()
        .all(|info| holds_any(who, &info.coords().policy_key(), &METADATA))
    {
        return permission_denied();
    }
    let version = folder.version;
    let created = all.iter().map(|i| i.created_at).min().unwrap_or(0);
    let updated = all.iter().map(|i| i.updated_at).max().unwrap_or(0);
    let deleted = if all.iter().all(|i| i.deleted_at.is_some()) {
        all.iter().filter_map(|i| i.deleted_at).max()
    } else {
        None
    };
    let mut versions = BTreeMap::new();
    versions.insert(
        version.to_string(),
        json!({
            "created_time": rfc3339(updated),
            "deletion_time": deleted.map(rfc3339).unwrap_or_default(),
            "destroyed": false,
        }),
    );
    envelope(
        Some(json!({
            "cas_required": false,
            "created_time": rfc3339(created),
            "current_version": version,
            "custom_metadata": null,
            "delete_version_after": "0s",
            "max_versions": 0,
            "oldest_version": 0,
            "updated_time": rfc3339(updated),
            "versions": versions,
        })),
        None,
    )
}

/// GET /v1/secret/metadata/{path} (`?list=true` lists).
async fn get_metadata(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
    Query(query): Query<MetadataQuery>,
) -> Response {
    if query.is_list() {
        return list_children(&state, &headers, &path).await;
    }
    let who = tri!(caller(&state, &headers).await);
    let target = tri!(Target::resolve(&state, &headers, &path, false));
    read_metadata(&who, &target).await
}

/// GET /v1/secret/metadata?list=true (root listing).
async fn get_metadata_root(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Query(query): Query<MetadataQuery>,
) -> Response {
    if query.is_list() {
        return list_children(&state, &headers, "").await;
    }
    errors(StatusCode::METHOD_NOT_ALLOWED, "unsupported operation")
}

/// DELETE /v1/secret/metadata/{path}: permanently destroy every key and its
/// history.
async fn delete_metadata(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let target = tri!(Target::resolve(&state, &headers, &path, false));
    tri!(target.require_folder(&who, &[Capability::Delete]));
    let folder = tri!(target.state(who.store()).await);
    let coords: Vec<SecretCoords> = folder.keys.iter().map(VaultSecretInfo::coords).collect();
    for key in &coords {
        tri!(require(&who, &key.policy_key(), Capability::Delete));
    }
    tri!(target.require_unprotected(&who, &coords).await);
    let actor = who.actor();
    for key in coords {
        if let Err(error) = who.store().destroy(key, None, &actor).await {
            return store_error(&error);
        }
    }
    if let Err(error) = who.store().kv_folder_forget(&target.kv_folder()).await {
        return store_error(&error);
    }
    no_content()
}

/// The `LIST` verb (and anything else unrouted) on a metadata path.
async fn metadata_other(
    State(state): State<CompatState>,
    method: Method,
    headers: HeaderMap,
    path: Option<Path<String>>,
) -> Response {
    if method.as_str() == "LIST" {
        let path = path.map(|Path(path)| path).unwrap_or_default();
        return list_children(&state, &headers, &path).await;
    }
    errors(StatusCode::METHOD_NOT_ALLOWED, "unsupported operation")
}

async fn method_not_allowed() -> Response {
    errors(StatusCode::METHOD_NOT_ALLOWED, "unsupported operation")
}

fn router_with<S: Clone + Send + Sync + 'static>(state: CompatState) -> Router<S> {
    let limit = axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    let data = format!("/v1/{KV_MOUNT}/data/*path");
    let metadata = format!("/v1/{KV_MOUNT}/metadata/*path");
    let metadata_root = format!("/v1/{KV_MOUNT}/metadata");
    let metadata_root_slash = format!("/v1/{KV_MOUNT}/metadata/");
    Router::new()
        .route("/v1/auth/approle/login", post(approle_login))
        .route("/v1/auth/jwt/login", post(jwt_login))
        .route(
            "/v1/auth/token/lookup-self",
            get(lookup_self).post(lookup_self),
        )
        .route("/v1/auth/token/revoke-self", post(revoke_self))
        .route("/v1/sys/internal/ui/mounts/*path", get(ui_mount))
        .route(
            &data,
            get(read_data)
                .put(write_data)
                .post(write_data)
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
mod tests {
    use super::*;
    use crate::plugin_secrets::kv::Environment;
    use crate::plugin_secrets::{VersionSource, WriteRequest};
    use crate::vault::audit::AuditActor;
    use crate::vault::machine::AuthMethod;
    use crate::vault::policy::{Policy, PolicyRule};
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    const NODE: &str = "node-compat-test";

    struct Fixture {
        app: Router,
        store: &'static PluginSecretStore,
        role_id: String,
        secret_id: String,
    }

    async fn fixture(rules: Vec<PolicyRule>) -> Fixture {
        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        let admin = AuditActor::new("user", Some("admin"));
        {
            let conn = store.conn.lock().await;
            crate::vault::policy::put_policy(
                &conn,
                &Policy {
                    name: "ci".into(),
                    description: String::new(),
                    rules,
                },
            )
            .unwrap();
        }
        let identity = store
            .machine_create(
                "ci",
                AuthMethod::AppRole {
                    role_id: String::new(),
                },
                vec!["ci".into()],
                Some(600),
                &admin,
            )
            .await
            .unwrap();
        let AuthMethod::AppRole { role_id } = identity.auth else {
            panic!("approle identity")
        };
        let (secret_id, _) = store
            .machine_issue_secret_id("ci", None, None, &admin)
            .await
            .unwrap();
        let app = router_with(CompatState {
            store: Some(store),
            node_id: Some(NODE.to_owned()),
        });
        Fixture {
            app,
            store,
            role_id,
            secret_id,
        }
    }

    fn all_caps(path: &str) -> PolicyRule {
        PolicyRule {
            path: path.into(),
            capabilities: vec![
                Capability::List,
                Capability::Read,
                Capability::Write,
                Capability::Delete,
            ],
            deny: false,
            ..Default::default()
        }
    }

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        call_in(app, None, method, uri, token, body).await
    }

    /// [`call`] with an optional `X-Ryu-Environment` header.
    async fn call_in(
        app: &Router,
        environment: Option<&str>,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            request = request.header("X-Vault-Token", token);
        }
        if let Some(environment) = environment {
            request = request.header("X-Ryu-Environment", environment);
        }
        let body = body.map_or_else(Body::empty, |body| Body::from(body.to_string()));
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    async fn login(fixture: &Fixture) -> String {
        let (status, body) = call(
            &fixture.app,
            "POST",
            "/v1/auth/approle/login",
            None,
            Some(json!({ "role_id": fixture.role_id, "secret_id": fixture.secret_id })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["auth"]["policies"], json!(["ci"]));
        assert!(body["auth"]["lease_duration"].as_i64().unwrap() > 0);
        body["auth"]["client_token"].as_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn approle_login_and_token_self_routes() {
        let fixture = fixture(vec![all_caps("default/app/**")]).await;
        let (status, body) = call(
            &fixture.app,
            "POST",
            "/v1/auth/approle/login",
            None,
            Some(json!({ "role_id": fixture.role_id, "secret_id": "sid_wrong" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, json!({ "errors": ["permission denied"] }));
        assert!(!body.to_string().contains("sid_wrong"));

        let token = login(&fixture).await;
        let (status, body) = call(
            &fixture.app,
            "GET",
            "/v1/auth/token/lookup-self",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["data"]["display_name"], "ci");
        assert!(!body.to_string().contains(&token));

        let (status, body) = call(
            &fixture.app,
            "GET",
            "/v1/sys/internal/ui/mounts/secret/app/db",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["data"]["options"]["version"], "2");

        let (status, _) = call(
            &fixture.app,
            "POST",
            "/v1/auth/token/revoke-self",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, body) = call(
            &fixture.app,
            "GET",
            "/v1/auth/token/lookup-self",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, json!({ "errors": ["permission denied"] }));
    }

    #[tokio::test]
    async fn kv_v2_write_read_metadata_list_and_delete() {
        let fixture = fixture(vec![all_caps("default/app/**")]).await;
        let token = login(&fixture).await;
        let app = &fixture.app;

        let (status, body) = call(
            app,
            "POST",
            "/v1/secret/data/app/db",
            Some(&token),
            Some(json!({ "data": { "USER": "svc", "PASSWORD": "hunter2" } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["version"], 1);
        assert!(!body.to_string().contains("hunter2"));

        let (status, body) = call(app, "GET", "/v1/secret/data/app/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["data"]["data"],
            json!({ "USER": "svc", "PASSWORD": "hunter2" })
        );
        assert_eq!(body["data"]["metadata"]["version"], 1);

        // Full replace with check-and-set: PASSWORD changes, USER is removed.
        let (status, body) = call(
            app,
            "PUT",
            "/v1/secret/data/app/db",
            Some(&token),
            Some(json!({ "options": { "cas": 1 }, "data": { "PASSWORD": "rotated" } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["version"], 2);
        let (status, body) = call(
            app,
            "PUT",
            "/v1/secret/data/app/db",
            Some(&token),
            Some(json!({ "options": { "cas": 1 }, "data": { "PASSWORD": "stale" } })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["errors"][0]
            .as_str()
            .unwrap()
            .contains("check-and-set"));
        let (_, body) = call(app, "GET", "/v1/secret/data/app/db", Some(&token), None).await;
        assert_eq!(body["data"]["data"], json!({ "PASSWORD": "rotated" }));

        let (status, body) =
            call(app, "GET", "/v1/secret/metadata/app/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["current_version"], 2);

        call(
            app,
            "POST",
            "/v1/secret/data/app/nested/cache",
            Some(&token),
            Some(json!({ "data": { "URL": "redis://x" } })),
        )
        .await;
        let (status, body) = call(app, "LIST", "/v1/secret/metadata/app", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["keys"], json!(["db", "nested/"]));
        let (status, body) = call(
            app,
            "GET",
            "/v1/secret/metadata/app/?list=true",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["keys"], json!(["db", "nested/"]));

        // Soft delete: the read is gone, metadata survives.
        let (status, _) = call(app, "DELETE", "/v1/secret/data/app/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, body) = call(app, "GET", "/v1/secret/data/app/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, json!({ "errors": [] }));
        let (status, body) =
            call(app, "GET", "/v1/secret/metadata/app/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_ne!(body["data"]["versions"]["2"]["deletion_time"], "");

        // Metadata delete destroys everything.
        let (status, _) = call(
            app,
            "DELETE",
            "/v1/secret/metadata/app/db",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = call(app, "GET", "/v1/secret/metadata/app/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(fixture
            .store
            .list_vault_secrets_filtered(&ListFilter {
                path: Some("/app/db".into()),
                include_deleted: true,
                ..ListFilter::default()
            })
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn errors_use_vault_envelope_and_policies_are_enforced() {
        let fixture = fixture(vec![PolicyRule {
            path: "default/app/**".into(),
            capabilities: vec![Capability::Read],
            deny: false,
            ..Default::default()
        }])
        .await;
        let app = &fixture.app;

        let (status, body) = call(app, "GET", "/v1/secret/data/app/db", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, json!({ "errors": ["permission denied"] }));
        let (status, body) = call(
            app,
            "GET",
            "/v1/secret/data/app/db",
            Some("rvt_not_a_real_token"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!body.to_string().contains("rvt_not_a_real_token"));

        let token = login(&fixture).await;
        // Read-only policy: writes are denied without leaking the value.
        let (status, body) = call(
            app,
            "PUT",
            "/v1/secret/data/app/db",
            Some(&token),
            Some(json!({ "data": { "PASSWORD": "topsecret" } })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, json!({ "errors": ["permission denied"] }));

        // Outside the policy path: 403 whether or not the secret exists, and
        // a version probe reveals nothing either.
        let (status, _) = call(app, "GET", "/v1/secret/data/other/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        fixture
            .store
            .write_secret(WriteRequest {
                coords: SecretCoords {
                    scope: SecretScope::Node,
                    scope_id: NODE.into(),
                    environment: "default".into(),
                    path: "/other/db".into(),
                    binding: None,
                    name: "KEY".into(),
                },
                value: Some("v"),
                patch: Default::default(),
                actor: &AuditActor::system(),
                source: VersionSource::Write,
                expected_version: None,
            })
            .await
            .unwrap();
        let (status, body) = call(app, "GET", "/v1/secret/data/other/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        for uri in [
            "/v1/secret/data/other/db?version=1",
            "/v1/secret/data/other/db?version=7",
            "/v1/secret/metadata/other/db",
            "/v1/secret/metadata/other/missing",
        ] {
            let (status, body) = call(app, "GET", uri, Some(&token), None).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
        }

        // Invalid key names and malformed JSON.
        let (status, body) = call(
            app,
            "PUT",
            "/v1/secret/data/app/db",
            Some(&token),
            Some(json!({ "data": { "not-env-shaped": "x" } })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["errors"].is_array());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/v1/secret/data/app/db")
                    .header("X-Vault-Token", &token)
                    .body(Body::from("{not json"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let (status, body) = call(app, "PATCH", "/v1/secret/data/app/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert!(body["errors"].is_array());
    }

    fn rule(path: &str, capabilities: &[Capability], deny: bool) -> PolicyRule {
        PolicyRule {
            path: path.into(),
            capabilities: capabilities.to_vec(),
            deny,
            ..Default::default()
        }
    }

    async fn native_write(store: &PluginSecretStore, environment: &str, path: &str, name: &str) {
        store
            .write_secret(WriteRequest {
                coords: SecretCoords {
                    scope: SecretScope::Node,
                    scope_id: NODE.into(),
                    environment: environment.into(),
                    path: path.into(),
                    binding: None,
                    name: name.into(),
                },
                value: Some("native"),
                patch: Default::default(),
                actor: &AuditActor::system(),
                source: VersionSource::Write,
                expected_version: None,
            })
            .await
            .unwrap();
    }

    async fn put(app: &Router, token: &str, uri: &str, body: Value) -> (StatusCode, Value) {
        call(app, "PUT", uri, Some(token), Some(body)).await
    }

    fn is_cas_error(body: &Value) -> bool {
        body["errors"][0]
            .as_str()
            .is_some_and(|message| message.contains("check-and-set"))
    }

    #[tokio::test]
    async fn check_and_set_versions_are_monotonic() {
        let fixture = fixture(vec![all_caps("default/app/**")]).await;
        let token = login(&fixture).await;
        let app = &fixture.app;
        let uri = "/v1/secret/data/app/cfg";

        for (cas, value) in [(0, "1"), (1, "2"), (2, "3")] {
            let (status, body) = put(
                app,
                &token,
                uri,
                json!({ "options": { "cas": cas }, "data": { "A": value } }),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["data"]["version"], cas + 1);
        }

        // Removing the key that holds the highest per-key version still
        // creates a new version, so the same cas cannot win twice.
        let (status, body) = put(
            app,
            &token,
            uri,
            json!({ "options": { "cas": 3 }, "data": { "B": "x" } }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["version"], 4);
        let (status, body) = put(
            app,
            &token,
            uri,
            json!({ "options": { "cas": 3 }, "data": { "B": "y" } }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(is_cas_error(&body));
        let (_, body) = call(app, "GET", uri, Some(&token), None).await;
        assert_eq!(body["data"]["data"], json!({ "B": "x" }));
        assert_eq!(body["data"]["metadata"]["version"], 4);

        // cas 0 is create-only, including after a soft delete.
        let (status, body) = put(
            app,
            &token,
            uri,
            json!({ "options": { "cas": 0 }, "data": { "B": "z" } }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(is_cas_error(&body));
        let (status, _) = call(app, "DELETE", uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = put(
            app,
            &token,
            uri,
            json!({ "options": { "cas": 0 }, "data": { "B": "z" } }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // The current version of a fully soft-deleted secret is accepted.
        let (status, body) = put(
            app,
            &token,
            uri,
            json!({ "options": { "cas": 4 }, "data": { "B": "z" } }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["version"], 5);

        // A direct write outside this surface also advances the version.
        native_write(fixture.store, "default", "/app/cfg", "B").await;
        let (_, body) = call(
            app,
            "GET",
            "/v1/secret/metadata/app/cfg",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(body["data"]["current_version"], 6);
        let (status, _) = put(
            app,
            &token,
            uri,
            json!({ "options": { "cas": 5 }, "data": { "B": "w" } }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // An empty write is a new (empty) version.
        let (status, body) = put(
            app,
            &token,
            uri,
            json!({ "options": { "cas": 6 }, "data": {} }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["version"], 7);
        let (status, _) = call(app, "GET", uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Metadata delete starts the secret over at version 1.
        let (status, _) = call(
            app,
            "DELETE",
            "/v1/secret/metadata/app/cfg",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, body) = put(
            app,
            &token,
            uri,
            json!({ "options": { "cas": 0 }, "data": { "C": "c" } }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["version"], 1);
    }

    #[tokio::test]
    async fn listing_and_metadata_require_list_and_reads_are_all_or_nothing() {
        let fixture = fixture(vec![
            all_caps("default/app/**"),
            rule("default/app/db/HIDDEN", &[Capability::Read], true),
            rule(
                "default/wo/**",
                &[Capability::Write, Capability::Use],
                false,
            ),
        ])
        .await;
        let token = login(&fixture).await;
        let app = &fixture.app;
        for (uri, data) in [
            ("/v1/secret/data/app/db", json!({ "USER": "svc" })),
            (
                "/v1/secret/data/app/nested/cache",
                json!({ "URL": "redis://x" }),
            ),
            ("/v1/secret/data/wo/sink", json!({ "TOKEN": "t" })),
        ] {
            let (status, body) = put(app, &token, uri, json!({ "data": data })).await;
            assert_eq!(status, StatusCode::OK, "{uri}: {body}");
        }

        let (status, body) = call(app, "LIST", "/v1/secret/metadata/app", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["keys"], json!(["db", "nested/"]));
        for (method, uri) in [
            ("GET", "/v1/secret/metadata?list=true"),
            ("GET", "/v1/secret/metadata/?list=true"),
            ("LIST", "/v1/secret/metadata"),
        ] {
            let (status, body) = call(app, method, uri, Some(&token), None).await;
            assert_eq!(status, StatusCode::OK, "{method} {uri}: {body}");
            // `wo/` holds keys the caller may write but not list.
            assert_eq!(body["data"]["keys"], json!(["app/"]), "{method} {uri}");
        }

        // Write/use without list or read: no listing, metadata, or data.
        let (status, _) = call(app, "LIST", "/v1/secret/metadata/wo", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        for uri in ["/v1/secret/metadata/wo/sink", "/v1/secret/data/wo/sink"] {
            let (status, body) = call(app, "GET", uri, Some(&token), None).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
        }

        // One unreadable key denies the whole secret instead of returning
        // a partial key set a later full replace would drop.
        native_write(fixture.store, "default", "/app/db", "HIDDEN").await;
        let (status, body) = call(app, "GET", "/v1/secret/data/app/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(!body.to_string().contains("svc"));
    }

    #[tokio::test]
    async fn environment_header_and_protected_environments() {
        let fixture = fixture(vec![
            all_caps("staging/**"),
            all_caps("prod/**"),
            rule("prod/admin/**", &[Capability::Admin], false),
        ])
        .await;
        let admin = AuditActor::new("user", Some("admin"));
        for (slug, protected) in [("staging", false), ("prod", true)] {
            fixture
                .store
                .put_environment(
                    &Environment {
                        slug: slug.into(),
                        name: slug.into(),
                        protected,
                        required_approvals: 1,
                        position: 1,
                        cas_required: false,
                    },
                    &admin,
                )
                .await
                .unwrap();
        }
        let token = login(&fixture).await;
        let app = &fixture.app;

        let (status, body) = call_in(
            app,
            Some("staging"),
            "PUT",
            "/v1/secret/data/svc",
            Some(&token),
            Some(json!({ "data": { "KEY": "staged" } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = call_in(
            app,
            Some("staging"),
            "GET",
            "/v1/secret/data/svc",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["data"], json!({ "KEY": "staged" }));
        // Without the header the node's active (default) environment is used,
        // where this caller holds nothing.
        let (status, _) = call(app, "GET", "/v1/secret/data/svc", Some(&token), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call_in(
            app,
            Some("Not A Slug"),
            "GET",
            "/v1/secret/data/svc",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // Protected environment: direct writes need admin on every key.
        let (status, body) = call_in(
            app,
            Some("prod"),
            "PUT",
            "/v1/secret/data/svc",
            Some(&token),
            Some(json!({ "data": { "KEY": "live" } })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body["errors"][0]
            .as_str()
            .unwrap()
            .contains("change approval"));
        let (status, body) = call_in(
            app,
            Some("prod"),
            "PUT",
            "/v1/secret/data/admin/svc",
            Some(&token),
            Some(json!({ "data": { "KEY": "live" } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    #[tokio::test]
    async fn jwt_login_does_not_reveal_identity_names() {
        let fixture = fixture(vec![all_caps("default/app/**")]).await;
        let mut seen = Vec::new();
        // An unknown identity and an existing AppRole identity look the same.
        for role in ["no-such-identity", "ci"] {
            let (status, body) = call(
                &fixture.app,
                "POST",
                "/v1/auth/jwt/login",
                None,
                Some(json!({ "role": role, "jwt": "e30.e30.sig" })),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{role}: {body}");
            assert!(!body.to_string().contains("e30.e30.sig"));
            seen.push(body);
        }
        assert_eq!(seen[0], seen[1]);
    }

    #[tokio::test]
    async fn control_groups_and_parameter_constraints_apply_to_compat() {
        use crate::vault::policy_ext::{ControlGroupFactor, ControlGroupSpec};
        let mut gated = all_caps("default/gated/**");
        gated.control_group = Some(ControlGroupSpec {
            ttl_secs: None,
            factors: vec![ControlGroupFactor {
                name: "security".into(),
                approvers: vec!["user:bob".into()],
                approvals: 1,
            }],
        });
        let mut constrained = all_caps("default/limited/**");
        constrained.allowed_parameters = Some(BTreeMap::from([(
            "value".to_owned(),
            vec!["ok-*".to_owned()],
        )]));
        let fixture = fixture(vec![gated, constrained]).await;
        let token = login(&fixture).await;
        let app = &fixture.app;

        // A machine token cannot open a control group, so a gated read is refused.
        let (status, body) = put(
            app,
            &token,
            "/v1/secret/data/gated/db",
            json!({ "data": { "PASSWORD": "p" } }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = call(app, "GET", "/v1/secret/data/gated/db", Some(&token), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.to_string().find("\"p\"").is_none());

        // Parameter constraints gate compat writes like native ones.
        let (status, body) = put(
            app,
            &token,
            "/v1/secret/data/limited/cfg",
            json!({ "data": { "A": "bad" } }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        let (status, body) = put(
            app,
            &token,
            "/v1/secret/data/limited/cfg",
            json!({ "data": { "A": "ok-1" } }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = call(
            app,
            "GET",
            "/v1/secret/data/limited/cfg",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["data"], json!({ "A": "ok-1" }));
    }

    #[tokio::test]
    async fn cas_required_environments_accept_compat_writes_that_carry_cas() {
        let fixture = fixture(vec![all_caps("strict/app/**")]).await;
        fixture
            .store
            .put_environment(
                &Environment {
                    slug: "strict".into(),
                    name: "strict".into(),
                    protected: false,
                    required_approvals: 1,
                    position: 1,
                    cas_required: true,
                },
                &AuditActor::new("user", Some("admin")),
            )
            .await
            .unwrap();
        let token = login(&fixture).await;
        let app = &fixture.app;
        let uri = "/v1/secret/data/app/cfg";
        let write = |body: Value| {
            call_in(
                app,
                Some("strict"),
                "PUT",
                uri,
                Some(token.as_str()),
                Some(body),
            )
        };

        let (status, body) = write(json!({ "data": { "A": "1" } })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(is_cas_error(&body), "{body}");
        let (status, body) = write(json!({ "options": { "cas": 0 }, "data": { "A": "1" } })).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = write(json!({
            "options": { "cas": 1 },
            "data": { "A": "2", "B": "new" }
        }))
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["version"], 2);
        let (status, body) = write(json!({ "data": { "A": "3", "B": "new" } })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let (status, body) = write(json!({ "options": { "cas": 1 }, "data": { "A": "3" } })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(is_cas_error(&body), "{body}");
    }
}
