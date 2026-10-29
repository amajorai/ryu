//! Secret Vault routes: values, versions, environments, folders, policies,
//! change requests, audit, import/export, scanning, and seal management.
//!
//! This module is the management projection for [`crate::plugin_secrets`] and
//! [`crate::vault`]. Values are write-only except through the explicit
//! `reveal`/`export` routes, which require the `read` capability and are
//! audited. Engines (transit, PKI, SSH, dynamic secrets, machine identities)
//! live in [`super::vault_engines_api`].
//!
//! Authorization is `(baseline ∪ policy allows) − policy denies` per
//! `ENV/folder/NAME` key (see `docs/vault-parity-spec.md`). Baselines preserve
//! the pre-policy boundaries: the unbound local operator has every capability;
//! a user owns user-scoped values; node/team/org members may `list` and `use`
//! values in their boundary; configuration managers (`gateway.configure`)
//! additionally `read`, `write`, `delete`, `approve`, and `admin`.
//!
//! On a registered managed node, team and organization values live in the
//! control plane; those requests are forwarded with the caller's user JWT so
//! the control plane applies its own RBAC.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{json_error, no_store_response, ServerState};
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::plugin_secrets::kv::{Environment, FolderImport, ListFilter};
use crate::plugin_secrets::{
    is_valid_scope_id, is_valid_vault_secret_name, PluginSecretStore, SecretBinding,
    SecretBindingKind, SecretCoords, SecretMetadataPatch, SecretResolutionContext, SecretScope,
    VaultSecretInfo, VersionSource, WriteRequest, MAX_VAULT_SECRET_VALUE_LEN,
};
use crate::sidecar::control_plane::{NodeScope, RegisteredNode};
use crate::vault::audit::{AuditActor, AuditEntry, AuditFilter};
use crate::vault::changes::{ChangeBase, ChangeOperation, ChangeStatus, RequesterAuthority};
use crate::vault::policy::{Capability, CapabilitySet, Policy, PolicyRule};
use crate::vault::policy_ext::{ControlGroupSpec, TemplateContext};
use crate::vault::{dotenv, scan, snapshot, VaultError, DEFAULT_ENVIRONMENT, ROOT_PATH};

/// Maximum JSON body accepted by the vault mutation routes.
pub const MAX_REQUEST_BODY_BYTES: usize = 128 * 1024;
/// Maximum body for import and scan routes.
pub const MAX_BULK_BODY_BYTES: usize = 4 * 1024 * 1024;

const LOCAL_SCOPE_ID: &str = "local";

// ── Wire helpers ──────────────────────────────────────────────────────────

/// Convert integer `…At` fields (epoch millis) to RFC 3339 strings, recursively.
enum TimestampUnit {
    Millis,
    Secs,
}

/// Which wire keys carry an epoch timestamp, and in which unit.
fn timestamp_unit(key: &str) -> Option<TimestampUnit> {
    match key {
        // SSH certificate validity is stored as the certificate's own seconds.
        "validAfter" | "validBefore" => Some(TimestampUnit::Secs),
        "at" | "notAfter" | "notBefore" => Some(TimestampUnit::Millis),
        _ if key.ends_with("At") => Some(TimestampUnit::Millis),
        _ => None,
    }
}

pub(super) fn rfc3339_fields(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let converted = match (&value, timestamp_unit(&key)) {
                        (Value::Number(number), Some(unit)) => number
                            .as_i64()
                            .and_then(|raw| match unit {
                                TimestampUnit::Millis => {
                                    DateTime::<Utc>::from_timestamp_millis(raw)
                                }
                                TimestampUnit::Secs => DateTime::<Utc>::from_timestamp(raw, 0),
                            })
                            .map_or(value.clone(), |at| Value::String(at.to_rfc3339())),
                        _ => rfc3339_fields(value),
                    };
                    (key, converted)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(rfc3339_fields).collect()),
        other => other,
    }
}

/// Convert RFC 3339 string `…At` fields to epoch millis, recursively (input side).
pub(super) fn millis_fields(value: Value) -> Result<Value, String> {
    Ok(match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, value) in map {
                let converted = match (&value, key.ends_with("At")) {
                    (Value::String(text), true) => DateTime::parse_from_rfc3339(text)
                        .map(|at| Value::from(at.timestamp_millis()))
                        .map_err(|_| format!("`{key}` must be an RFC 3339 timestamp"))?,
                    _ => millis_fields(value)?,
                };
                out.insert(key, converted);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(millis_fields)
                .collect::<Result<_, _>>()?,
        ),
        other => other,
    })
}

/// A `no-store` JSON response with timestamps rendered as RFC 3339.
pub(super) fn respond(value: Value) -> Response {
    no_store_response(Json(rfc3339_fields(value)).into_response())
}

/// Parse a JSON body after converting RFC 3339 timestamps.
pub(super) fn parse_body<T: serde::de::DeserializeOwned>(body: Value) -> Result<T, Response> {
    let body = millis_fields(body).map_err(|message| invalid_request(&message))?;
    serde_json::from_value(body).map_err(|error| invalid_request(&error.to_string()))
}

pub(super) fn invalid_request(message: &str) -> Response {
    json_error(
        StatusCode::BAD_REQUEST,
        format!("vault_invalid_request: {message}"),
    )
}

pub(super) fn denied(capability: Capability, key: &str) -> Response {
    json_error(
        StatusCode::FORBIDDEN,
        format!(
            "vault_denied: the `{}` capability is required on `{key}`",
            capability.as_str()
        ),
    )
}

/// Map a store error onto a stable status and code.
pub(super) fn vault_error(error: anyhow::Error) -> Response {
    if let Some(vault) = error.downcast_ref::<VaultError>() {
        let status = match vault {
            VaultError::Sealed | VaultError::AuditUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            VaultError::Invalid(_) => StatusCode::BAD_REQUEST,
            VaultError::NotFound(_) => StatusCode::NOT_FOUND,
            VaultError::Conflict(_) => StatusCode::CONFLICT,
            VaultError::Denied(_) => StatusCode::FORBIDDEN,
        };
        return json_error(status, vault.to_string());
    }
    if error.downcast_ref::<rusqlite::Error>().is_some() {
        tracing::warn!("vault storage error: {error:#}");
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "vault_internal: storage error".to_owned(),
        );
    }
    invalid_request(&format!("{error:#}"))
}

/// The one message every refused public identity login carries.
const LOGIN_REFUSED: &str = "login rejected";

/// Map the store error of a public native machine login
/// (`/api/vault/auth/{jwt,cert,aws,kubernetes}/login`).
///
/// These routes answer before any authentication, so the error must not tell
/// the caller which identity names exist, how they log in, whether one is
/// disabled, or why a credential failed: every typed refusal is the same 403.
/// The real reason is in the audit log. `Sealed` and `AuditUnavailable` say
/// nothing about the identity and stay 503 so the caller can retry; anything
/// that is not a typed vault refusal (a storage failure) goes through
/// [`vault_error`].
pub(super) fn login_refusal(error: anyhow::Error) -> Response {
    match error.downcast_ref::<VaultError>() {
        Some(VaultError::Sealed | VaultError::AuditUnavailable) | None => vault_error(error),
        Some(_) => json_error(
            StatusCode::FORBIDDEN,
            VaultError::Denied(LOGIN_REFUSED.to_owned()).to_string(),
        ),
    }
}

/// `{ "token": … }` for a successful public native login, else
/// [`login_refusal`].
pub(super) fn login_token_response<T: Serialize>(result: anyhow::Result<T>) -> Response {
    match result {
        Ok(token) => respond(json!({ "token": token })),
        Err(error) => login_refusal(error),
    }
}

pub(super) fn store() -> Result<&'static PluginSecretStore, Response> {
    crate::plugin_secrets::global().ok_or_else(|| {
        json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "vault_unavailable: encrypted secret store is not available".to_owned(),
        )
    })
}

fn current_node() -> Option<RegisteredNode> {
    crate::sidecar::control_plane::registered_node()
}

fn current_node_id(node: Option<&RegisteredNode>) -> String {
    node.map(|registered| registered.node_id.clone())
        .unwrap_or_else(crate::server::agent_sync::local_node_id)
}

fn node_scope_label(node: Option<&RegisteredNode>) -> &'static str {
    match node.map(|registered| registered.scope) {
        Some(NodeScope::Org) => "org",
        Some(NodeScope::Team) => "team",
        Some(NodeScope::Personal) => "personal",
        None => "local",
    }
}

fn role_label(role: OrgRole) -> &'static str {
    role.label()
}

/// The raw user JWT on the request (forwarded to the control plane).
///
/// `x-ryu-user-jwt` wins. The bearer is forwarded only when it is the verified
/// user JWT that admitted the request (`bearer_is_user_jwt`, from
/// `resolve_managed_user_jwt`). Every other admitting bearer (the node's owner
/// token, a paired token, a node delegation) is a node-local secret, never a
/// user JWT, so it must not travel upstream as one (for example from the CLI
/// while a forwarding tunnel stops the local Core minting a JWT).
fn user_jwt(headers: &HeaderMap, bearer_is_user_jwt: bool) -> Option<String> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    header("x-ryu-user-jwt").or_else(|| {
        if !bearer_is_user_jwt {
            return None;
        }
        header("authorization").and_then(|value| value.strip_prefix("Bearer ").map(str::to_owned))
    })
}

// ── Boundaries (unchanged pre-policy rules) ───────────────────────────────

/// Whether a verified caller is inside the registered node's organization,
/// team, or personal-owner boundary. A missing caller is accepted only for the
/// node-bearer management path; shared scopes still require a caller below.
///
/// An org Admin is admitted on any team node of their organization here, which
/// governs this node's own values. Team and Organization values are decided by
/// the control plane, which (like `/gateway/vault/resolve`) acts through a team
/// node only for a live member of that team, so the node's operators can never
/// replay an admin's JWT through it. For an admin who is not on the team it
/// answers `node_proxy_required`, which the proxy passes through as a caller
/// refusal (`is_caller_refusal`).
fn caller_can_use_node(node: Option<&RegisteredNode>, caller: Option<&VerifiedCaller>) -> bool {
    let Some(node) = node else {
        return true;
    };
    let Some(caller) = caller else {
        return true;
    };
    match node.scope {
        NodeScope::Org => caller.org_id.as_deref() == Some(node.org.id.as_str()),
        NodeScope::Team => {
            caller.org_id.as_deref() == Some(node.org.id.as_str())
                && (caller.role.satisfies(OrgRole::Admin)
                    || node
                        .team_id
                        .as_deref()
                        .is_some_and(|team_id| caller.teams.iter().any(|team| team.id == team_id)))
        }
        NodeScope::Personal => node.owner_user_id.as_deref() == Some(caller.user_id.as_str()),
    }
}

fn scope_visible(
    scope: SecretScope,
    scope_id: &str,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
    node_id: &str,
) -> bool {
    match scope {
        SecretScope::Node => scope_id == node_id && caller_can_use_node(node, caller),
        SecretScope::User => {
            if node.is_none() && scope_id == LOCAL_SCOPE_ID && caller.is_none() {
                return true;
            }
            caller.is_some_and(|caller| {
                scope_id == caller.user_id && caller_can_use_node(node, Some(caller))
            })
        }
        SecretScope::Team => {
            let (Some(node), Some(caller)) = (node, caller) else {
                return false;
            };
            if !caller_can_use_node(Some(node), Some(caller))
                || caller.org_id.as_deref() != Some(node.org.id.as_str())
            {
                return false;
            }
            caller.role.satisfies(OrgRole::Admin)
                || caller
                    .teams
                    .iter()
                    .any(|team| team.id == scope_id && team.org_id == node.org.id)
        }
        SecretScope::Org => {
            let (Some(node), Some(caller)) = (node, caller) else {
                return false;
            };
            caller_can_use_node(Some(node), Some(caller))
                && caller.org_id.as_deref() == Some(scope_id)
                && caller.org_id.as_deref() == Some(node.org.id.as_str())
        }
    }
}

#[cfg(test)]
fn record_visible(
    record: &VaultSecretInfo,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
    node_id: &str,
) -> bool {
    scope_visible(record.scope, &record.scope_id, node, caller, node_id)
}

fn normalized_optional_id(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

struct SecretTarget {
    scope: SecretScope,
    scope_id: String,
    binding: Option<SecretBinding>,
}

fn resolve_target(
    scope: SecretScope,
    requested_scope_id: Option<String>,
    binding: Option<SecretBinding>,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
) -> Result<SecretTarget, &'static str> {
    if let Some(binding) = binding.as_ref() {
        if binding.validate().is_err() {
            return Err("the MCP binding id is invalid");
        }
    }
    let requested_scope_id = normalized_optional_id(requested_scope_id);
    let node_id = current_node_id(node);
    let scope_id = match scope {
        SecretScope::Node => {
            if requested_scope_id
                .as_deref()
                .is_some_and(|value| value != node_id)
            {
                return Err("node scope_id must name the current node");
            }
            node_id
        }
        SecretScope::User => {
            if !caller_can_use_node(node, caller) {
                return Err("the caller is outside this node's boundary");
            }
            let expected = match (node, caller) {
                (Some(_), None) => return Err("user scope requires a verified user identity"),
                (_, Some(caller)) => caller.user_id.clone(),
                (None, None) => LOCAL_SCOPE_ID.to_owned(),
            };
            if requested_scope_id
                .as_deref()
                .is_some_and(|value| value != expected)
            {
                return Err("user scope_id must name the verified caller");
            }
            expected
        }
        SecretScope::Org => {
            let Some(node) = node else {
                return Err("organization scope is unavailable on an unbound node");
            };
            if caller.is_some_and(|caller| {
                caller.org_id.as_deref() != Some(node.org.id.as_str())
                    || !caller_can_use_node(Some(node), Some(caller))
            }) {
                return Err("organization membership is required");
            }
            if requested_scope_id
                .as_deref()
                .is_some_and(|value| value != node.org.id)
            {
                return Err("organization scope_id must name this node's organization");
            }
            node.org.id.clone()
        }
        SecretScope::Team => {
            let Some(node) = node else {
                return Err("team scope is unavailable on an unbound node");
            };
            let Some(scope_id) = requested_scope_id else {
                return Err("team scope requires scope_id");
            };
            if !is_valid_scope_id(&scope_id) {
                return Err("team scope_id is invalid");
            }
            if node.scope == NodeScope::Team && node.team_id.as_deref() != Some(scope_id.as_str()) {
                return Err("a team-bound node can only use its own team scope");
            }
            match caller {
                Some(caller)
                    if caller.org_id.as_deref() == Some(node.org.id.as_str())
                        && caller_can_use_node(Some(node), Some(caller))
                        && (caller.role.satisfies(OrgRole::Admin)
                            || caller
                                .teams
                                .iter()
                                .any(|team| team.id == scope_id && team.org_id == node.org.id)) => {
                }
                None if node.scope == NodeScope::Team
                    && node.team_id.as_deref() == Some(scope_id.as_str()) => {}
                _ => return Err("team membership is required"),
            }
            scope_id
        }
    };

    Ok(SecretTarget {
        scope,
        scope_id,
        binding,
    })
}

async fn can_manage_shared(
    state: &ServerState,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
) -> bool {
    let Some(node) = node else {
        return false;
    };
    let Some(caller) = caller else {
        // Shared team/org/node writes are governance operations. A node bearer
        // proves machine admission, not which human may mutate shared secrets.
        return false;
    };
    if !caller_can_use_node(Some(node), Some(caller)) {
        return false;
    }
    if node.scope == NodeScope::Personal
        && node.owner_user_id.as_deref() == Some(caller.user_id.as_str())
    {
        return true;
    }
    super::enforce_permission(
        state,
        &Some(caller.clone()),
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_ok()
}

// ── The request principal ─────────────────────────────────────────────────

/// Policy-binding subjects of a verified caller.
fn caller_subjects(caller: Option<&VerifiedCaller>) -> Vec<String> {
    let mut subjects = Vec::new();
    if let Some(caller) = caller {
        subjects.push(format!("user:{}", caller.user_id));
        subjects.push(format!("role:{}", role_label(caller.role)));
        subjects.extend(caller.teams.iter().map(|team| format!("team:{}", team.id)));
    }
    subjects
}

/// Everything a vault handler needs to authorize one request.
pub(super) struct Ctx {
    pub store: &'static PluginSecretStore,
    pub node: Option<RegisteredNode>,
    pub node_id: String,
    pub caller: Option<VerifiedCaller>,
    /// Configuration manager (or the unbound local operator).
    pub manager: bool,
    pub policies: Vec<Policy>,
    pub jwt: Option<String>,
}

impl Ctx {
    pub(super) async fn load(
        state: &ServerState,
        caller: Option<VerifiedCaller>,
        headers: &HeaderMap,
    ) -> Result<Self, Response> {
        let store = store()?;
        let node = current_node();
        let node_id = current_node_id(node.as_ref());
        let manager =
            node.is_none() || can_manage_shared(state, node.as_ref(), caller.as_ref()).await;
        let subjects = caller_subjects(caller.as_ref());
        let policies = {
            let conn = store.conn.lock().await;
            crate::vault::policy::policies_for(&conn, &subjects).map_err(vault_error)?
        };
        Ok(Self {
            store,
            node,
            node_id,
            caller,
            manager,
            policies,
            jwt: user_jwt(headers, super::request_bearer_is_user_jwt()),
        })
    }

    pub(super) fn actor(&self) -> AuditActor {
        match &self.caller {
            Some(caller) => AuditActor::new("user", Some(&caller.user_id)),
            None => AuditActor::new("operator", None),
        }
    }

    /// Baseline capabilities for a scope, before policies.
    fn baseline(&self, scope: SecretScope, scope_id: &str) -> CapabilitySet {
        let node = self.node.as_ref();
        let caller = self.caller.as_ref();
        if !scope_visible(scope, scope_id, node, caller, &self.node_id) {
            return CapabilitySet::new();
        }
        if node.is_none() {
            return Capability::ALL.into_iter().collect();
        }
        let mut caps: CapabilitySet = [Capability::List, Capability::Use].into_iter().collect();
        if scope == SecretScope::User {
            caps.extend([Capability::Read, Capability::Write, Capability::Delete]);
        }
        if self.manager {
            caps.extend(Capability::ALL);
        }
        caps
    }

    /// Policy-binding subjects of this caller (empty for the local operator).
    pub(super) fn subjects(&self) -> Vec<String> {
        caller_subjects(self.caller.as_ref())
    }

    /// What a change request records about its requester, so each approval
    /// can re-check the requester against the policy bindings in force then.
    fn requester_authority(&self, coords: &SecretCoords) -> RequesterAuthority {
        RequesterAuthority {
            subjects: self.subjects(),
            baseline: self.baseline(coords.scope, &coords.scope_id),
        }
    }

    /// Identity values policy templates expand against.
    pub(super) fn template_context(&self) -> TemplateContext {
        TemplateContext::from_subjects(&self.subjects())
    }

    /// Effective capabilities on one value.
    ///
    /// A value outside the caller's scope boundary (another user's personal
    /// value, a team the caller is not in, another org or node) yields no
    /// capabilities: `ENV/folder/NAME` policy keys carry no scope or owner,
    /// so a policy must never widen visibility past [`scope_visible`]. Every
    /// row-iterating caller (listing, `to_wire`, `scan`, audit events) and
    /// every per-item check therefore agrees with [`resolve_target`].
    pub(super) fn caps(&self, coords: &SecretCoords) -> CapabilitySet {
        if !scope_visible(
            coords.scope,
            &coords.scope_id,
            self.node.as_ref(),
            self.caller.as_ref(),
            &self.node_id,
        ) {
            return CapabilitySet::new();
        }
        self.policy_caps(coords)
    }

    /// Capabilities on a submitted change request's target for its
    /// approvers. Approval is the one flow that acts on a value outside the
    /// approver's own scope (an admin approving a member's personal write in
    /// a protected environment), so the scope gate of [`Self::caps`] is not
    /// applied: the baseline is still empty there and only an explicit
    /// policy grant of `approve` counts.
    fn approval_caps(&self, coords: &SecretCoords) -> CapabilitySet {
        self.policy_caps(coords)
    }

    fn policy_caps(&self, coords: &SecretCoords) -> CapabilitySet {
        let baseline = self.baseline(coords.scope, &coords.scope_id);
        crate::vault::policy::evaluate_with(
            &baseline,
            &self.policies,
            &coords.policy_key(),
            &self.template_context(),
        )
    }

    /// The control group gating a `read` of `coords`, if any. The unbound
    /// local operator (no verified caller) is the root equivalent and is never
    /// gated.
    pub(super) fn read_control_group(&self, coords: &SecretCoords) -> Option<ControlGroupSpec> {
        self.sys_read_control_group(&coords.policy_key())
    }

    /// [`Self::read_control_group`] for a non-secret policy key such as
    /// `sys/items/<env>/<folder>/<key>`.
    pub(super) fn sys_read_control_group(&self, key: &str) -> Option<ControlGroupSpec> {
        self.caller.as_ref()?;
        crate::vault::policy_ext::control_group_for(
            &self.policies,
            key,
            Capability::Read,
            &self.template_context(),
        )
    }

    /// Whether `read` releases the value directly (no control group pending).
    pub(super) fn can_read_directly(&self, coords: &SecretCoords) -> bool {
        self.caps(coords).contains(&Capability::Read) && self.read_control_group(coords).is_none()
    }

    /// The first parameter-constraint violation a write of `value` to
    /// `coords` would commit, if any. A JSON-object value contributes its
    /// top-level keys; any other value is the single parameter `value`.
    pub(super) fn write_parameters_violation(
        &self,
        coords: &SecretCoords,
        value: &str,
    ) -> Option<String> {
        let parameters: BTreeMap<String, Value> = match serde_json::from_str::<Value>(value) {
            Ok(Value::Object(map)) => map.into_iter().collect(),
            _ => BTreeMap::from([("value".to_owned(), Value::String(value.to_owned()))]),
        };
        crate::vault::policy_ext::check_parameters(
            &self.policies,
            &coords.policy_key(),
            Capability::Write,
            &self.template_context(),
            &parameters,
        )
        .err()
    }

    /// Whether any rule granting `write` on `coords` carries parameter
    /// constraints (so a value-less write path must load and check the value).
    pub(super) fn write_parameters_constrained(&self, coords: &SecretCoords) -> bool {
        crate::vault::policy_ext::has_parameter_constraints(
            &self.policies,
            &coords.policy_key(),
            Capability::Write,
            &self.template_context(),
        )
    }

    /// Check a write's parameters against the rules' parameter constraints.
    pub(super) fn require_write_parameters(
        &self,
        coords: &SecretCoords,
        value: Option<&str>,
    ) -> Result<(), Response> {
        let Some(value) = value else {
            return Ok(());
        };
        match self.write_parameters_violation(coords, value) {
            None => Ok(()),
            Some(message) => Err(json_error(
                StatusCode::FORBIDDEN,
                format!("vault_denied: {message} on `{}`", coords.policy_key()),
            )),
        }
    }

    /// Refuse a read that a control group gates on a path that cannot open
    /// a control-group request (it would release the value without approval).
    pub(super) fn require_ungated_read(&self, key: &str) -> Result<(), Response> {
        if self.sys_read_control_group(key).is_some() {
            return Err(control_group_required(key));
        }
        Ok(())
    }

    pub(super) fn require(
        &self,
        coords: &SecretCoords,
        capability: Capability,
    ) -> Result<(), Response> {
        if self.caps(coords).contains(&capability) {
            Ok(())
        } else {
            Err(denied(capability, &coords.policy_key()))
        }
    }

    /// Capabilities on a non-secret key such as `sys/transit/payments`.
    pub(super) fn sys_caps(&self, key: &str) -> CapabilitySet {
        let baseline: CapabilitySet = if self.manager {
            Capability::ALL.into_iter().collect()
        } else {
            CapabilitySet::new()
        };
        crate::vault::policy::evaluate_with(
            &baseline,
            &self.policies,
            key,
            &self.template_context(),
        )
    }

    pub(super) fn require_sys(&self, key: &str, capability: Capability) -> Result<(), Response> {
        if self.sys_caps(key).contains(&capability) {
            Ok(())
        } else {
            Err(denied(capability, key))
        }
    }

    /// The runtime context the resolver would use for this caller.
    fn resolution_context(&self, environment: Option<String>) -> SecretResolutionContext {
        let user_id = match (&self.caller, &self.node) {
            (Some(caller), _) => Some(caller.user_id.clone()),
            (None, None) => Some(LOCAL_SCOPE_ID.to_owned()),
            (None, Some(_)) => None,
        };
        SecretResolutionContext {
            user_id,
            org_id: self.node.as_ref().map(|node| node.org.id.clone()),
            team_id: self.node.as_ref().and_then(|node| node.team_id.clone()),
            team_authority: self
                .caller
                .as_ref()
                .and_then(crate::plugin_secrets::VerifiedTeamSecretScope::from_verified_caller),
            node_id: self.node_id.clone(),
            mcp_ids: Vec::new(),
            environment,
            conversation_id: None,
            roles: self
                .caller
                .iter()
                .map(|caller| caller.role.label().to_owned())
                .collect(),
            principal_unverified: false,
            minted_subjects: Vec::new(),
        }
    }

    /// Whether team/org values for this request live in the control plane.
    pub(super) fn shared_remote(&self, scope: SecretScope) -> bool {
        matches!(scope, SecretScope::Team | SecretScope::Org) && crate::vault::shared::is_enabled()
    }

    /// The team/org id for a shared request, defaulting to this node's own.
    fn shared_scope_id(&self, coords: &CoordsBody) -> String {
        coords
            .scope_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .or_else(|| {
                let node = self.node.as_ref()?;
                match coords.scope {
                    SecretScope::Team => node.team_id.clone(),
                    SecretScope::Org => Some(node.org.id.clone()),
                    SecretScope::User | SecretScope::Node => None,
                }
            })
            .unwrap_or_default()
    }

    /// Whether this node may vouch for a shared plaintext read (reveal or
    /// export), so the control plane does not ask for a step-up. The gateway
    /// key goes with every proxied request; the vouch
    /// (`x-ryu-node-vouch: 1`) only with these. See [`node_key_may_vouch`].
    pub(super) async fn node_vouches(&self) -> bool {
        let Some(jwt) = self.jwt.as_deref() else {
            return false;
        };
        let local_owner = super::request_is_from_local_owner();
        // Cheap checks first: the JWT is only verified when the rest holds.
        if !node_key_may_vouch(
            self.node.as_ref(),
            self.caller.as_ref(),
            self.caller.as_ref(),
            local_owner,
        ) {
            return false;
        }
        let forwarded = super::verified_caller_from_token(jwt).await;
        node_key_may_vouch(
            self.node.as_ref(),
            self.caller.as_ref(),
            forwarded.as_ref(),
            local_owner,
        )
    }
}

/// Load the request's [`Ctx`] or return its error response from the handler.
macro_rules! ctx {
    ($state:expr, $caller:expr, $headers:expr) => {
        match Ctx::load(&$state, $caller, &$headers).await {
            Ok(ctx) => ctx,
            Err(response) => return response,
        }
    };
}
pub(super) use ctx;

/// Unwrap `Ok(value)` or return the `Err(response)` from the handler.
macro_rules! try_response {
    ($expr:expr) => {
        match $expr {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
}
pub(super) use try_response;

#[cfg(test)]
impl Ctx {
    /// A Member caller `user_id` on the org-1 ("Acme") org node `node-1`, not a
    /// manager, holding `policies`.
    pub(super) fn test_member(
        store: &'static PluginSecretStore,
        user_id: &str,
        policies: Vec<Policy>,
    ) -> Self {
        use crate::sidecar::control_plane::RegisteredOrg;
        Self {
            store,
            node: Some(RegisteredNode {
                org: RegisteredOrg {
                    id: "org-1".to_owned(),
                    name: "Acme".to_owned(),
                    slug: None,
                },
                node_id: "node-1".to_owned(),
                scope: NodeScope::Org,
                team_id: None,
                owner_user_id: None,
            }),
            node_id: "node-1".to_owned(),
            caller: Some(VerifiedCaller {
                user_id: user_id.to_owned(),
                email: None,
                email_verified: false,
                org_id: Some("org-1".to_owned()),
                role: OrgRole::Member,
                teams: Vec::new(),
            }),
            manager: false,
            policies,
            jwt: None,
        }
    }
}

/// Whether the node key may vouch for a shared plaintext read. All of these
/// must hold, or the control plane asks the session for a step-up instead:
///
/// - the node is an org or team node (a personal key never vouches: it
///   cannot resolve shared values at run time, so it would add reach);
/// - the request comes from this machine (a trusted local peer, so not a
///   remote holder of a token, and not while a forwarding tunnel makes
///   remote streams look local) AND was admitted with this node's owner token
///   (`local_owner`, from [`super::request_is_from_local_owner`]). A user JWT,
///   paired token or delegation as the bearer is not enough: a script on a
///   CORS-allowed web origin can mint a user JWT from the session cookie and
///   send it to this machine's loopback port, but it cannot read the owner
///   token from the data directory;
/// - the JWT forwarded to the control plane verifies to the same user (and
///   org) as the request's verified caller, so a second JWT riding in a
///   header cannot borrow this node's key.
///
/// Every other request is forwarded without the vouch, and the control plane
/// asks for the `org.credentials` step-up (`ryu secrets confirm` in the CLI,
/// the confirmation prompt in Desktop and the web console).
fn node_key_may_vouch(
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
    forwarded: Option<&VerifiedCaller>,
    local_owner: bool,
) -> bool {
    let (Some(node), Some(caller), Some(forwarded)) = (node, caller, forwarded) else {
        return false;
    };
    local_owner
        && matches!(node.scope, NodeScope::Org | NodeScope::Team)
        && caller.org_id.as_deref() == Some(node.org.id.as_str())
        && forwarded.user_id == caller.user_id
        && forwarded.org_id == caller.org_id
}

async fn proxy(
    ctx: &Ctx,
    method: reqwest::Method,
    subpath: &str,
    query: &[(String, String)],
    body: Option<Value>,
) -> Response {
    proxy_with_proof(ctx, method, subpath, query, body, false).await
}

/// [`proxy`], optionally with this node's vouch for a plaintext
/// read (decided by [`Ctx::node_vouches`]).
async fn proxy_with_proof(
    ctx: &Ctx,
    method: reqwest::Method,
    subpath: &str,
    query: &[(String, String)],
    body: Option<Value>,
    node_proof: bool,
) -> Response {
    let Some(jwt) = ctx.jwt.as_deref() else {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "vault_user_required: shared values need a signed-in user".to_owned(),
        );
    };
    match crate::vault::shared::proxy(method, subpath, query, jwt, body, node_proof).await {
        // The control plane may send epoch millis; normalize like local answers.
        Ok(value) => no_store_response(Json(rfc3339_fields(value)).into_response()),
        Err(crate::vault::shared::ProxyError::Status(status, value)) => {
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
            no_store_response((status, Json(value)).into_response())
        }
        Err(crate::vault::shared::ProxyError::Unavailable) => json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "vault_shared_unavailable: this node is not connected to the control plane".to_owned(),
        ),
        Err(crate::vault::shared::ProxyError::Transport(error)) => json_error(
            StatusCode::BAD_GATEWAY,
            format!("vault_shared_unreachable: {error}"),
        ),
    }
}

// ── Coordinates on the wire ───────────────────────────────────────────────

/// Scope used when a request names none: the caller's own values.
fn default_scope() -> SecretScope {
    SecretScope::User
}

/// Coordinates of one value (body form). `environment` defaults to
/// `default`, `path` to `/`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordsBody {
    #[serde(default = "default_scope")]
    pub(super) scope: SecretScope,
    #[serde(default)]
    scope_id: Option<String>,
    #[serde(default)]
    binding: Option<SecretBinding>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

/// Coordinates of one value (query form; `mcpId` is the binding).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordsQuery {
    #[serde(default = "default_scope")]
    scope: SecretScope,
    #[serde(default)]
    scope_id: Option<String>,
    #[serde(default)]
    mcp_id: Option<String>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

impl From<CoordsQuery> for CoordsBody {
    fn from(query: CoordsQuery) -> Self {
        Self {
            scope: query.scope,
            scope_id: query.scope_id,
            binding: query.mcp_id.map(|id| SecretBinding {
                kind: SecretBindingKind::Mcp,
                id,
            }),
            environment: query.environment,
            path: query.path,
        }
    }
}

impl CoordsBody {
    fn query_pairs(&self, target_scope_id: &str) -> Vec<(String, String)> {
        let mut pairs = vec![
            ("scope".to_owned(), self.scope.as_str().to_owned()),
            ("scopeId".to_owned(), target_scope_id.to_owned()),
            (
                "environment".to_owned(),
                self.environment
                    .clone()
                    .unwrap_or_else(|| DEFAULT_ENVIRONMENT.to_owned()),
            ),
            (
                "path".to_owned(),
                self.path.clone().unwrap_or_else(|| ROOT_PATH.to_owned()),
            ),
        ];
        if let Some(binding) = &self.binding {
            pairs.push(("mcpId".to_owned(), binding.id.clone()));
        }
        pairs
    }
}

pub(super) fn coords_for(
    ctx: &Ctx,
    name: &str,
    body: CoordsBody,
) -> Result<SecretCoords, Response> {
    if !is_valid_vault_secret_name(name) {
        return Err(invalid_request(
            "name must be an environment-compatible identifier",
        ));
    }
    let target = resolve_target(
        body.scope,
        body.scope_id,
        body.binding,
        ctx.node.as_ref(),
        ctx.caller.as_ref(),
    )
    .map_err(invalid_request)?;
    SecretCoords {
        scope: target.scope,
        scope_id: target.scope_id,
        environment: body
            .environment
            .unwrap_or_else(|| DEFAULT_ENVIRONMENT.to_owned()),
        path: body.path.unwrap_or_else(|| ROOT_PATH.to_owned()),
        binding: target.binding,
        name: name.to_owned(),
    }
    .normalize()
    .map_err(|error| invalid_request(&error.to_string()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SecretWire {
    name: String,
    scope: SecretScope,
    scope_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    binding: Option<SecretBinding>,
    environment: String,
    path: String,
    version: i64,
    /// Metadata check-and-set counter (`expectedMetadataVersion`).
    metadata_version: i64,
    status: crate::plugin_secrets::SecretStatus,
    metadata: crate::plugin_secrets::SecretMetadata,
    capabilities: Vec<Capability>,
    created_at: i64,
    created_by: Option<String>,
    updated_at: i64,
    updated_by: Option<String>,
    rotated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'static str>,
}

pub(super) fn to_wire(ctx: &Ctx, info: VaultSecretInfo) -> SecretWire {
    let caps = ctx.caps(&info.coords());
    let status = info.status(crate::vault::now_millis());
    SecretWire {
        capabilities: caps.into_iter().collect(),
        status,
        name: info.name,
        scope: info.scope,
        scope_id: info.scope_id,
        binding: info.binding,
        environment: info.environment,
        path: info.path,
        version: info.version,
        metadata_version: info.metadata_version,
        metadata: info.metadata,
        created_at: info.created_at,
        created_by: info.created_by,
        updated_at: info.updated_at,
        updated_by: info.updated_by,
        rotated_at: info.rotated_at,
        deleted_at: info.deleted_at,
        source: None,
    }
}

// ── Values ────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    recursive: Option<bool>,
    #[serde(default)]
    include_deleted: Option<bool>,
    /// Keyset cursor (`nextAfter` of the previous page). Setting `after` or
    /// `limit` switches to stable `(environment, path, name)` order.
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    /// Include each value's version summaries (KV v2 detailed metadata).
    #[serde(default)]
    detailed: Option<bool>,
}

/// GET /api/vault/secrets lists the caller's visible vault metadata.
#[utoipa::path(
    get,
    path = "/api/vault/secrets",
    tag = "Vault",
    summary = "List visible vault secret metadata (never values)",
    params(
        ("environment" = Option<String>, Query, description = "Environment slug filter"),
        ("path" = Option<String>, Query, description = "Folder filter"),
        ("recursive" = Option<bool>, Query, description = "Include sub-folders (default true)"),
        ("includeDeleted" = Option<bool>, Query, description = "Include soft-deleted values"),
        ("after" = Option<String>, Query, description = "Page cursor: `nextAfter` from the previous page"),
        ("limit" = Option<usize>, Query, description = "Page size (default 200, max 1000); enables paging"),
        ("detailed" = Option<bool>, Query, description = "Include per-version summaries (requires paging)"),
    ),
    responses((status = 200, description = "Metadata only", body = serde_json::Value))
)]
pub async fn list_secrets(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let filter = ListFilter {
        environment: query.environment.clone(),
        path: query.path.clone(),
        recursive: query.recursive.unwrap_or(true),
        include_deleted: query.include_deleted.unwrap_or(false),
    };
    let paged = query.after.is_some() || query.limit.is_some();
    let detailed = query.detailed.unwrap_or(false);
    // Version summaries are bounded by the page size: an unpaged listing has
    // no bound, so `detailed` requires paging.
    if detailed && !paged {
        return invalid_request("detailed=true requires paging: pass limit (or after)");
    }
    let can_list = |info: &VaultSecretInfo| ctx.caps(&info.coords()).contains(&Capability::List);
    let mut next_after = None;
    let mut page_ids = Vec::new();
    let local = if paged {
        match ctx
            .store
            .list_secrets_page(
                &filter,
                query.after.as_deref(),
                query
                    .limit
                    .unwrap_or(crate::plugin_secrets::kv_meta::DEFAULT_PAGE_LIMIT),
                can_list,
            )
            .await
        {
            Ok(page) => {
                next_after = page.next_after;
                page_ids = page.ids;
                page.secrets
            }
            Err(error) => return vault_error(error),
        }
    } else {
        match ctx.store.list_vault_secrets_filtered(&filter).await {
            Ok(secrets) => secrets.into_iter().filter(|info| can_list(info)).collect(),
            Err(error) => return vault_error(error),
        }
    };
    let mut versions = if detailed {
        match ctx.store.versions_for_page(&page_ids).await {
            Ok(versions) => Some(versions),
            Err(error) => return vault_error(error),
        }
    } else {
        None
    };
    let mut secrets: Vec<Value> = Vec::with_capacity(local.len());
    for (index, info) in local.into_iter().enumerate() {
        let mut wire = serde_json::to_value(to_wire(&ctx, info)).unwrap_or(Value::Null);
        if let (Some(versions), Some(id)) = (versions.as_mut(), page_ids.get(index)) {
            let summaries = versions.remove(id).unwrap_or_default();
            if let Some(object) = wire.as_object_mut() {
                object.insert("versions".into(), json!(summaries));
            }
        }
        secrets.push(wire);
    }
    // Shared values on a managed node come from the control plane; a
    // failure there degrades to local values with a flag, not an error.
    // Paging covers local values; shared values arrive on the first page.
    let mut shared_error = None;
    if crate::vault::shared::is_enabled() && query.after.is_none() {
        if let Some(jwt) = ctx.jwt.as_deref() {
            let mut pairs = Vec::new();
            if let Some(environment) = &query.environment {
                pairs.push(("environment".to_owned(), environment.clone()));
            }
            if let Some(path) = &query.path {
                pairs.push(("path".to_owned(), path.clone()));
            }
            pairs.push(("recursive".to_owned(), filter.recursive.to_string()));
            pairs.push((
                "includeDeleted".to_owned(),
                filter.include_deleted.to_string(),
            ));
            match crate::vault::shared::proxy(
                reqwest::Method::GET,
                "/secrets",
                &pairs,
                jwt,
                None,
                false,
            )
            .await
            {
                Ok(value) => {
                    if let Some(remote) = value.get("secrets").and_then(Value::as_array) {
                        for mut secret in remote.iter().cloned() {
                            if let Some(object) = secret.as_object_mut() {
                                object.insert("source".into(), json!("control-plane"));
                            }
                            secrets.push(secret);
                        }
                    }
                }
                Err(error) => shared_error = Some(format!("{error:?}")),
            }
        }
    }
    let node = ctx.node.as_ref();
    respond(json!({
        "secrets": secrets,
        "nextAfter": next_after,
        "node": {
            "id": ctx.node_id,
            "scope": node_scope_label(node),
            "orgId": node.map(|registered| registered.org.id.clone()),
            "teamId": node.and_then(|registered| registered.team_id.clone()),
            "ownerUserId": node.and_then(|registered| registered.owner_user_id.clone()),
        },
        "caller": ctx.caller.as_ref().map(|caller| json!({
            "userId": caller.user_id,
            "orgId": caller.org_id,
            "role": role_label(caller.role),
            "teamIds": caller.teams.iter().map(|team| team.id.clone()).collect::<Vec<_>>(),
        })),
        "canManageShared": ctx.node.is_some() && ctx.manager,
        "sharedRemote": crate::vault::shared::is_enabled(),
        "sharedError": shared_error,
        "activeEnvironment": crate::vault::active_environment(),
        "seal": ctx.store.keyring.status(),
    }))
}

/// Body of `PUT /api/vault/secrets/{name}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutSecretBody {
    #[serde(flatten)]
    coords: CoordsBody,
    /// New value. Omit for a metadata-only update; an empty string clears the
    /// value (legacy behavior).
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    expected_version: Option<i64>,
    /// Metadata check-and-set: the `metadataVersion` the caller last saw.
    #[serde(default)]
    expected_metadata_version: Option<i64>,
}

/// Body of `DELETE /api/vault/secrets/{name}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSecretBody {
    #[serde(flatten)]
    coords: CoordsBody,
}

/// Refusal for a version or bulk operation on a protected environment by a
/// caller without `admin` there. Change requests cover writes and deletes
/// only, so these operations are reserved to admins rather than bypassing
/// the configured approvals.
pub(super) fn protected_denied(environment: &str) -> Response {
    json_error(
        StatusCode::FORBIDDEN,
        format!(
            "vault_denied: `{environment}` is a protected environment; this operation needs \
             the `admin` capability (a plain write opens a change request instead)"
        ),
    )
}

pub(super) async fn protected_environment(
    ctx: &Ctx,
    environment: &str,
) -> Result<Option<u8>, Response> {
    match ctx.store.environment(environment).await {
        Ok(Some(env)) if env.protected => Ok(Some(env.required_approvals.max(1))),
        Ok(_) => Ok(None),
        Err(error) => Err(vault_error(error)),
    }
}

/// PUT /api/vault/secrets/{name} writes a value and/or metadata.
#[utoipa::path(
    put,
    path = "/api/vault/secrets/{name}",
    tag = "Vault",
    summary = "Set a write-only scoped vault secret, its metadata, or both",
    params(("name" = String, Path, description = "Env-compatible secret name")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Stored metadata only", body = serde_json::Value),
        (status = 202, description = "Change request created for a protected environment", body = serde_json::Value),
        (status = 409, description = "expectedVersion or expectedMetadataVersion is stale", body = serde_json::Value),
    )
)]
pub async fn put_secret(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    // `customMetadata` keys are user-defined; keep them out of the RFC 3339
    // `…At` conversion.
    let custom_metadata = super::vault_kv_api::take_custom_metadata(&mut body);
    let mut body: PutSecretBody = match parse_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    super::vault_kv_api::restore_custom_metadata(&mut body.metadata, custom_metadata);
    if body
        .value
        .as_ref()
        .is_some_and(|value| value.len() > MAX_VAULT_SECRET_VALUE_LEN)
    {
        return invalid_request("value exceeds the maximum allowed size");
    }
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if ctx.shared_remote(body.coords.scope) {
        let mut forwarded = json!({
            "scope": body.coords.scope,
            "scopeId": ctx.shared_scope_id(&body.coords),
            "binding": body.coords.binding,
            "environment": body.coords.environment,
            "path": body.coords.path,
            "value": body.value,
            "metadata": body.metadata,
            "expectedVersion": body.expected_version,
            "expectedMetadataVersion": body.expected_metadata_version,
        });
        if let Some(object) = forwarded.as_object_mut() {
            object.retain(|_, value| !value.is_null());
        }
        // The control-plane contract uses RFC 3339, like this API's own wire.
        let forwarded = rfc3339_fields(forwarded);
        return proxy(
            &ctx,
            reqwest::Method::PUT,
            &format!("/secrets/{}", urlencoding::encode(&name)),
            &[],
            Some(forwarded),
        )
        .await;
    }
    let coords = match coords_for(&ctx, &name, body.coords) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    let actor = ctx.actor();
    // Legacy clear: an empty value deletes.
    if body.value.as_deref() == Some("") {
        return delete_coords(&ctx, coords, &actor).await;
    }
    if let Err(response) = ctx.require(&coords, Capability::Write) {
        return response;
    }
    if let Err(response) = ctx.require_write_parameters(&coords, body.value.as_deref()) {
        return response;
    }
    let patch_value = body.metadata.clone().unwrap_or_else(|| json!({}));
    let patch: SecretMetadataPatch = match serde_json::from_value(patch_value.clone()) {
        Ok(patch) => patch,
        Err(error) => return invalid_request(&format!("metadata: {error}")),
    };
    match protected_environment(&ctx, &coords.environment).await {
        Ok(Some(required)) if !ctx.caps(&coords).contains(&Capability::Admin) => {
            let authority = ctx.requester_authority(&coords);
            return match ctx
                .store
                .create_change_request_from(
                    // A stale edit is refused now, like a direct write, not
                    // pinned to a version the requester never saw.
                    ChangeBase {
                        version: body.expected_version,
                        metadata_version: body.expected_metadata_version,
                    },
                    coords,
                    ChangeOperation::Write,
                    body.value.as_deref(),
                    patch_value,
                    required,
                    &actor,
                    &authority,
                )
                .await
            {
                Ok(request) => no_store_response(
                    (
                        StatusCode::ACCEPTED,
                        Json(rfc3339_fields(
                            json!({ "ok": true, "changeRequest": request }),
                        )),
                    )
                        .into_response(),
                ),
                Err(error) => vault_error(error),
            };
        }
        Ok(_) => {}
        Err(response) => return response,
    }
    match ctx
        .store
        .write_secret_with(
            WriteRequest {
                coords,
                value: body.value.as_deref(),
                patch,
                actor: &actor,
                source: VersionSource::Write,
                expected_version: body.expected_version,
            },
            crate::plugin_secrets::WriteOptions {
                expected_metadata_version: body.expected_metadata_version,
            },
        )
        .await
    {
        Ok(info) => respond(json!({ "ok": true, "secret": to_wire(&ctx, info) })),
        Err(error) => vault_error(error),
    }
}

async fn delete_coords(ctx: &Ctx, coords: SecretCoords, actor: &AuditActor) -> Response {
    if let Err(response) = ctx.require(&coords, Capability::Delete) {
        return response;
    }
    match protected_environment(ctx, &coords.environment).await {
        Ok(Some(required)) if !ctx.caps(&coords).contains(&Capability::Admin) => {
            let authority = ctx.requester_authority(&coords);
            return match ctx
                .store
                .create_change_request(
                    coords,
                    ChangeOperation::Delete,
                    None,
                    json!({}),
                    required,
                    actor,
                    &authority,
                )
                .await
            {
                Ok(request) => no_store_response(
                    (
                        StatusCode::ACCEPTED,
                        Json(rfc3339_fields(
                            json!({ "ok": true, "changeRequest": request }),
                        )),
                    )
                        .into_response(),
                ),
                Err(error) => vault_error(error),
            };
        }
        Ok(_) => {}
        Err(response) => return response,
    }
    match ctx.store.soft_delete(coords.clone(), actor).await {
        Ok(_) => respond(json!({
            "ok": true,
            "deleted": true,
            "name": coords.name,
            "scope": coords.scope,
            "scopeId": coords.scope_id,
            "binding": coords.binding,
            "environment": coords.environment,
            "path": coords.path,
        })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/secrets/{name} soft-deletes one value. Idempotent.
#[utoipa::path(
    delete,
    path = "/api/vault/secrets/{name}",
    tag = "Vault",
    summary = "Soft-delete a scoped vault secret (restorable)",
    params(("name" = String, Path, description = "Env-compatible secret name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Deleted", body = serde_json::Value))
)]
pub async fn delete_secret(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<CoordsQuery>,
    body: Option<Json<DeleteSecretBody>>,
) -> Response {
    // Some HTTP clients drop DELETE bodies, so query coordinates work too.
    let body = body.map_or_else(
        || DeleteSecretBody {
            coords: query.into(),
        },
        |Json(body)| body,
    );
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if ctx.shared_remote(body.coords.scope) {
        let target_id = ctx.shared_scope_id(&body.coords);
        return proxy(
            &ctx,
            reqwest::Method::DELETE,
            &format!("/secrets/{}", urlencoding::encode(&name)),
            &body.coords.query_pairs(&target_id),
            None,
        )
        .await;
    }
    let coords = match coords_for(&ctx, &name, body.coords) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    let actor = ctx.actor();
    delete_coords(&ctx, coords, &actor).await
}

/// GET /api/vault/secrets/{name}/versions lists version history.
#[utoipa::path(
    get,
    path = "/api/vault/secrets/{name}/versions",
    tag = "Vault",
    summary = "List a value's versions (never values)",
    params(("name" = String, Path, description = "Secret name")),
    responses((status = 200, description = "Versions, newest first", body = serde_json::Value))
)]
pub async fn list_versions(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<CoordsQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let body: CoordsBody = query.into();
    if ctx.shared_remote(body.scope) {
        let target_id = ctx.shared_scope_id(&body);
        return proxy(
            &ctx,
            reqwest::Method::GET,
            &format!("/secrets/{}/versions", urlencoding::encode(&name)),
            &body.query_pairs(&target_id),
            None,
        )
        .await;
    }
    let coords = match coords_for(&ctx, &name, body) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require(&coords, Capability::List) {
        return response;
    }
    match ctx.store.list_versions(&coords).await {
        Ok(versions) => respond(json!({ "versions": versions })),
        Err(error) => vault_error(error),
    }
}

/// Body for version-targeted actions.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionActionBody {
    #[serde(flatten)]
    coords: CoordsBody,
    #[serde(default)]
    version: Option<i64>,
    #[serde(default)]
    versions: Option<Vec<i64>>,
}

/// POST /api/vault/secrets/{name}/{action} for `reveal`, `rollback`,
/// `restore`, and `destroy`.
#[utoipa::path(
    post,
    path = "/api/vault/secrets/{name}/{action}",
    tag = "Vault",
    summary = "Reveal (read), roll back (write), restore (write), or destroy (delete) a value",
    params(
        ("name" = String, Path, description = "Secret name"),
        ("action" = String, Path, description = "`reveal`, `rollback`, `restore`, or `destroy`"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value))
)]
pub async fn secret_action(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((name, action)): Path<(String, String)>,
    Json(body): Json<VersionActionBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    secret_action_with(&ctx, &name, &action, body).await
}

async fn secret_action_with(
    ctx: &Ctx,
    name: &str,
    action: &str,
    body: VersionActionBody,
) -> Response {
    if !matches!(action, "reveal" | "rollback" | "restore" | "destroy") {
        return json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: unknown action".to_owned(),
        );
    }
    if ctx.shared_remote(body.coords.scope) {
        let forwarded = json!({
            "scope": body.coords.scope,
            "scopeId": ctx.shared_scope_id(&body.coords),
            "binding": body.coords.binding,
            "environment": body.coords.environment,
            "path": body.coords.path,
            "version": body.version,
            "versions": body.versions,
        });
        // Only a reveal returns plaintext, so only a reveal carries the node
        // key as proof; the other actions never need it.
        let node_proof = action == "reveal" && ctx.node_vouches().await;
        return proxy_with_proof(
            &ctx,
            reqwest::Method::POST,
            &format!("/secrets/{}/{action}", urlencoding::encode(&name)),
            &[],
            Some(forwarded),
            node_proof,
        )
        .await;
    }
    let coords = match coords_for(&ctx, &name, body.coords) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    let actor = ctx.actor();
    let capability = match action {
        "reveal" => Capability::Read,
        "destroy" => Capability::Delete,
        _ => Capability::Write,
    };
    if let Err(response) = ctx.require(&coords, capability) {
        return response;
    }
    if action != "reveal" {
        match protected_environment(&ctx, &coords.environment).await {
            Ok(Some(_)) if !ctx.caps(&coords).contains(&Capability::Admin) => {
                return protected_denied(&coords.environment);
            }
            Ok(_) => {}
            Err(response) => return response,
        }
    }
    let result = match action {
        "reveal" => {
            if let Some(spec) = ctx.read_control_group(&coords) {
                return super::vault_policy_ext_api::open_control_group(
                    &ctx,
                    &coords,
                    body.version,
                    &spec,
                )
                .await;
            }
            return match ctx.store.reveal(&coords, body.version, &actor).await {
                Ok(value) => respond(json!({ "value": value })),
                Err(error) => vault_error(error),
            };
        }
        "rollback" => {
            let Some(version) = body.version else {
                return invalid_request("version is required");
            };
            if let Err(response) = require_stored_parameters(&ctx, &coords, Some(version)).await {
                return response;
            }
            ctx.store.rollback(coords, version, &actor).await
        }
        "restore" => {
            if let Err(response) = require_stored_parameters(&ctx, &coords, None).await {
                return response;
            }
            ctx.store.restore(coords, &actor).await
        }
        _ => {
            return match ctx
                .store
                .destroy(coords, body.versions.as_deref(), &actor)
                .await
            {
                Ok(result) => respond(json!({ "ok": true, "destroyed": result })),
                Err(error) => vault_error(error),
            };
        }
    };
    match result {
        Ok(info) => respond(json!({ "ok": true, "secret": to_wire(&ctx, info) })),
        Err(error) => vault_error(error),
    }
}

/// 403 for a read gated by a control group on a path that cannot request one.
pub(super) fn control_group_required(key: &str) -> Response {
    json_error(
        StatusCode::FORBIDDEN,
        format!(
            "vault_control_group_required: `{key}` needs control-group approval, which this route cannot request"
        ),
    )
}

/// Rollback and restore put a stored value back without a request body, so
/// check that value (one `version`, or the current one) against the caller's
/// write parameter constraints. Values are decrypted only when a constraint
/// applies.
pub(super) async fn require_stored_parameters(
    ctx: &Ctx,
    coords: &SecretCoords,
    version: Option<i64>,
) -> Result<(), Response> {
    if !ctx.write_parameters_constrained(coords) {
        return Ok(());
    }
    let value = ctx
        .store
        .version_value_unaudited(coords, version)
        .await
        .map_err(vault_error)?;
    ctx.require_write_parameters(coords, Some(&value))
}

// ── Export, import, run, scan ─────────────────────────────────────────────

/// True for the control plane's step-up refusal (`error: "STEP_UP_REQUIRED"`).
fn is_step_up_required(value: &Value) -> bool {
    value.get("error").and_then(Value::as_str) == Some("STEP_UP_REQUIRED")
}

/// The `sharedError` prefix for an export the control plane refused for the
/// caller; the refusal's code follows (`vault_shared_refused: org_ip_not_allowed`),
/// so the CLI and Desktop can say what to do about it.
const SHARED_REFUSED_PREFIX: &str = "vault_shared_refused: ";

/// Whether a control-plane refusal of a proxied export is about the caller's
/// access rather than about the values: a forwarded JWT the control plane
/// would not bind (`node_proxy_required`, `user_jwt_*`), the organization's
/// access policy (`org_*`) or the two-factor mandates. The export goes on
/// with this node's and the caller's own values and names the refusal in
/// `sharedError`, as for an outage, so `ryu secrets run` keeps working for a
/// member with no shared values and warns one who has them. Only the step-up
/// prompt fails the export ([`is_step_up_required`]): the control plane asks
/// for it only when there are shared values to hand over.
///
/// Not one: `not_an_org_member` (403), which the control plane answers to a
/// caller who is not on the node's organization's roster. There is nothing
/// shared for them, so the export goes on without a warning.
fn is_caller_refusal(status: u16, value: &Value) -> bool {
    if !matches!(status, 401 | 403) || is_step_up_required(value) {
        return false;
    }
    crate::vault::shared::refusal_code(value).is_some_and(|code| {
        code == "node_proxy_required"
            || code == "mfa_enrollment_required"
            || code == "staff_session_factor_required"
            || code.starts_with("user_jwt_")
            || code.starts_with("org_")
    })
}

/// Body of `POST /api/vault/export`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBody {
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
    /// `dotenv` (default), `json`, `yaml`, `shell`, `k8s-secret`.
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    names: Option<Vec<String>>,
    #[serde(default)]
    k8s_name: Option<String>,
    #[serde(default)]
    k8s_namespace: Option<String>,
}

/// POST /api/vault/export returns the effective values for an environment
/// and folder, rendered in one format. Requires `read` on every included value.
#[utoipa::path(
    post,
    path = "/api/vault/export",
    tag = "Vault",
    summary = "Export effective values (dotenv, JSON, YAML, shell, or a Kubernetes Secret)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Rendered content", body = serde_json::Value))
)]
pub async fn export(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<ExportBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let format = match body.format.as_deref().map(dotenv::Format::parse) {
        None => dotenv::Format::Dotenv,
        Some(Some(format)) => format,
        Some(None) => return invalid_request("unknown format"),
    };
    let environment = body
        .environment
        .clone()
        .unwrap_or_else(crate::vault::active_environment);
    let path = body.path.clone().unwrap_or_else(|| ROOT_PATH.to_owned());
    let context = ctx.resolution_context(Some(environment.clone()));
    let local = match ctx
        .store
        .effective_local_values(&context, &environment, &path, |coords| {
            ctx.can_read_directly(coords)
        })
        .await
    {
        Ok(values) => values,
        Err(error) => return vault_error(error),
    };
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    let mut shared_error: Option<String> = None;
    // Shared values first so local user/node values win, matching runtime order.
    if crate::vault::shared::is_enabled() {
        if let Some(jwt) = ctx.jwt.as_deref() {
            let request = json!({ "environment": environment, "path": path });
            let node_proof = ctx.node_vouches().await;
            match crate::vault::shared::proxy(
                reqwest::Method::POST,
                "/export",
                &[],
                jwt,
                Some(request),
                node_proof,
            )
            .await
            {
                Ok(value) => {
                    if let Some(map) = value.get("values").and_then(Value::as_object) {
                        for (key, value) in map {
                            if let Some(text) = value.as_str() {
                                values.insert(key.clone(), text.to_owned());
                            }
                        }
                    }
                }
                // The control plane wants a fresh step-up before it hands over
                // the shared plaintext it holds for this caller. Pass that on so
                // the caller can confirm and retry, instead of quietly
                // exporting without values they have.
                Err(crate::vault::shared::ProxyError::Status(status, value))
                    if matches!(status, 401 | 403) && is_step_up_required(&value) =>
                {
                    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::FORBIDDEN);
                    return no_store_response((status, Json(value)).into_response());
                }
                // The control plane refused the caller's access (the sign-in
                // ended or is not accepted, an organization policy applies, or
                // the request did not come through this node). Export what does
                // not depend on it and name the refusal, so the CLI and Desktop
                // warn with what to do.
                Err(crate::vault::shared::ProxyError::Status(status, value))
                    if is_caller_refusal(status, &value) =>
                {
                    let code = crate::vault::shared::refusal_code(&value).unwrap_or("refused");
                    shared_error = Some(format!("{SHARED_REFUSED_PREFIX}{code}"));
                }
                // An outage (including the control plane's 503 when it cannot
                // check the forwarded sign-in): export what this node holds and
                // say that the shared values are missing (`sharedError`, as the
                // list does), so the CLI and Desktop warn. Values that never
                // depended on the control plane keep working through it.
                Err(crate::vault::shared::ProxyError::Status(status, _)) if status >= 500 => {
                    shared_error = Some(format!(
                        "vault_shared_unreachable: the control plane answered {status}"
                    ));
                }
                Err(crate::vault::shared::ProxyError::Transport(error)) => {
                    shared_error = Some(format!("vault_shared_unreachable: {error}"));
                }
                // Not a member of this node's organization
                // (`not_an_org_member`), or a vault that is closed (a family
                // workspace): there are no shared values for this caller. Not
                // connected: none either.
                Err(crate::vault::shared::ProxyError::Status(_, _))
                | Err(crate::vault::shared::ProxyError::Unavailable) => {}
            }
        }
    }
    for (name, (_, value)) in local {
        values.insert(name, value);
    }
    if let Some(names) = &body.names {
        values.retain(|name, _| names.contains(name));
    }
    if !ctx
        .store
        .audit(
            &AuditEntry::new(&ctx.actor(), "vault.export", "ok").details(json!({
                "environment": environment, "path": path, "count": values.len(),
                "names": values.keys().collect::<Vec<_>>(),
            })),
        )
        .await
    {
        return vault_error(VaultError::AuditUnavailable.into());
    }
    let options = dotenv::K8sOptions {
        name: body.k8s_name,
        namespace: body.k8s_namespace,
    };
    match dotenv::serialize(&values, format, &options) {
        Ok(content) => respond(json!({
            "format": format,
            "contentType": format.content_type(),
            "count": values.len(),
            "environment": environment,
            "path": path,
            "content": content,
            "sharedError": shared_error,
        })),
        Err(error) => vault_error(error),
    }
}

/// Body of `POST /api/vault/import`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBody {
    #[serde(flatten)]
    coords: CoordsBody,
    /// `dotenv`, `json`, or `snapshot`.
    format: String,
    content: String,
    #[serde(default)]
    passphrase: Option<String>,
    #[serde(default)]
    on_conflict: snapshot::OnConflict,
}

/// POST /api/vault/import writes values from `.env`, JSON, or an encrypted snapshot.
#[utoipa::path(
    post,
    path = "/api/vault/import",
    tag = "Vault",
    summary = "Import values from .env, JSON, or an encrypted snapshot",
    request_body = serde_json::Value,
    responses((status = 200, description = "Counts", body = serde_json::Value))
)]
pub async fn import(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<ImportBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    import_with(&ctx, body).await
}

async fn import_with(ctx: &Ctx, body: ImportBody) -> Response {
    if ctx.shared_remote(body.coords.scope) && body.format != "snapshot" {
        let forwarded = json!({
            "scope": body.coords.scope, "scopeId": ctx.shared_scope_id(&body.coords),
            "environment": body.coords.environment, "path": body.coords.path,
            "format": body.format, "content": body.content, "onConflict": body.on_conflict,
        });
        return proxy(&ctx, reqwest::Method::POST, "/import", &[], Some(forwarded)).await;
    }
    let actor = ctx.actor();
    // Imports write directly, so on a protected environment they are limited
    // to admins (see `protected_denied`).
    let protected: std::collections::HashSet<String> = match ctx.store.list_environments().await {
        Ok(environments) => environments
            .into_iter()
            .filter(|environment| environment.protected)
            .map(|environment| environment.slug)
            .collect(),
        Err(error) => return vault_error(error),
    };
    // Imports honour the same parameter constraints as `PUT`; a value that
    // breaks one is skipped like any other unauthorized entry.
    let allow = |coords: &SecretCoords, value: &str| {
        let caps = ctx.caps(coords);
        caps.contains(&Capability::Write)
            && (!protected.contains(&coords.environment) || caps.contains(&Capability::Admin))
            && ctx.write_parameters_violation(coords, value).is_none()
    };
    if body.format == "snapshot" {
        let envelope: snapshot::Envelope = match serde_json::from_str(&body.content) {
            Ok(envelope) => envelope,
            Err(_) => return invalid_request("content is not a Ryu vault snapshot"),
        };
        let Some(passphrase) = body.passphrase.as_deref() else {
            return invalid_request("passphrase is required for snapshots");
        };
        return match ctx
            .store
            .snapshot_import(&envelope, passphrase, body.on_conflict, allow, &actor)
            .await
        {
            Ok(report) => respond(json!({ "ok": true, "report": report })),
            Err(error) => vault_error(error),
        };
    }
    let parsed = match body.format.as_str() {
        "dotenv" | "env" => dotenv::parse(&body.content),
        "json" => dotenv::parse_json(&body.content),
        _ => return invalid_request("format must be dotenv, json, or snapshot"),
    };
    let values = match parsed {
        Ok(values) => values,
        Err(error) => return invalid_request(&error.to_string()),
    };
    let mut entries = Vec::with_capacity(values.len());
    for (name, value) in values {
        if value.len() > MAX_VAULT_SECRET_VALUE_LEN {
            return invalid_request(&format!("`{name}` exceeds the maximum value size"));
        }
        let coords = match coords_for(&ctx, &name, body.coords.clone()) {
            Ok(coords) => coords,
            Err(response) => return response,
        };
        entries.push(snapshot::Entry {
            coords,
            value,
            metadata: Default::default(),
        });
    }
    match ctx
        .store
        .import_entries(entries, body.on_conflict, allow, &actor)
        .await
    {
        Ok(report) => {
            ctx.store
                .audit(
                    &AuditEntry::new(&actor, "vault.import", "ok")
                        .details(serde_json::to_value(&report).unwrap_or(Value::Null)),
                )
                .await;
            respond(json!({ "ok": true, "report": report }))
        }
        Err(error) => vault_error(error),
    }
}

/// Body of `POST /api/vault/snapshot`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBody {
    passphrase: String,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

/// POST /api/vault/snapshot exports a passphrase-sealed snapshot.
#[utoipa::path(
    post,
    path = "/api/vault/snapshot",
    tag = "Vault",
    summary = "Export an encrypted, portable snapshot of readable values",
    request_body = serde_json::Value,
    responses((status = 200, description = "Snapshot envelope", body = serde_json::Value))
)]
pub async fn snapshot_export(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<SnapshotBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let filter = ListFilter {
        environment: body.environment,
        path: body.path,
        recursive: true,
        include_deleted: false,
    };
    match ctx
        .store
        .snapshot_export(
            &filter,
            |coords| ctx.can_read_directly(coords),
            &body.passphrase,
            &ctx.actor(),
        )
        .await
    {
        Ok(envelope) => no_store_response(Json(envelope).into_response()),
        Err(error) => vault_error(error),
    }
}

/// One file to scan.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFile {
    #[serde(default)]
    path: Option<String>,
    content: String,
}

/// Body of `POST /api/vault/scan`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanBody {
    files: Vec<ScanFile>,
    /// Finding fingerprints to suppress.
    #[serde(default)]
    allow: Vec<String>,
    /// Also match values stored in the vault that the caller may read (default true).
    #[serde(default)]
    known_values: Option<bool>,
}

/// POST /api/vault/scan finds leaked credentials in text.
#[utoipa::path(
    post,
    path = "/api/vault/scan",
    tag = "Vault",
    summary = "Scan text for leaked credentials and stored vault values",
    request_body = serde_json::Value,
    responses((status = 200, description = "Findings (no secret values)", body = serde_json::Value))
)]
pub async fn scan(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<ScanBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let known: Vec<(String, String)> = if body.known_values.unwrap_or(true) {
        match ctx.store.current_values(&ListFilter::default()).await {
            Ok(values) => values
                .into_iter()
                .filter(|(info, _)| ctx.can_read_directly(&info.coords()))
                .map(|(info, value)| (info.coords().policy_key(), value))
                .collect(),
            Err(error) => return vault_error(error),
        }
    } else {
        Vec::new()
    };
    let known_refs: Vec<scan::KnownValue<'_>> = known
        .iter()
        .map(|(label, value)| scan::KnownValue { label, value })
        .collect();
    let mut findings = Vec::new();
    for file in &body.files {
        findings.extend(scan::scan(
            &file.content,
            file.path.as_deref(),
            &known_refs,
            &body.allow,
        ));
    }
    ctx.store
        .audit(
            &AuditEntry::new(&ctx.actor(), "vault.scan", "ok").details(json!({
                "files": body.files.len(), "findings": findings.len()
            })),
        )
        .await;
    respond(json!({ "findings": findings }))
}

// ── Environments, folders, imports ────────────────────────────────────────

/// GET /api/vault/environments.
#[utoipa::path(get, path = "/api/vault/environments", tag = "Vault",
    summary = "List environments",
    responses((status = 200, description = "Environments", body = serde_json::Value)))]
pub async fn list_environments(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    match ctx.store.list_environments().await {
        Ok(environments) => respond(json!({
            "environments": environments,
            "active": crate::vault::active_environment(),
        })),
        Err(error) => vault_error(error),
    }
}

/// PUT /api/vault/environments/{slug} creates or updates an environment.
#[utoipa::path(put, path = "/api/vault/environments/{slug}", tag = "Vault",
    summary = "Create or update an environment (admin)",
    params(("slug" = String, Path, description = "Environment slug")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value)))]
pub async fn put_environment(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(&format!("sys/environments/{slug}"), Capability::Admin) {
        return response;
    }
    if let Some(object) = body.as_object_mut() {
        object.insert("slug".into(), json!(slug));
        object.entry("name").or_insert_with(|| json!(slug));
    }
    let environment: Environment = match parse_body(body) {
        Ok(environment) => environment,
        Err(response) => return response,
    };
    match ctx.store.put_environment(&environment, &ctx.actor()).await {
        Ok(()) => respond(json!({ "ok": true, "environment": environment })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/environments/{slug} removes an empty environment.
#[utoipa::path(delete, path = "/api/vault/environments/{slug}", tag = "Vault",
    summary = "Delete an empty environment (admin)",
    params(("slug" = String, Path, description = "Environment slug")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn delete_environment(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(&format!("sys/environments/{slug}"), Capability::Admin) {
        return response;
    }
    match ctx.store.delete_environment(&slug, &ctx.actor()).await {
        Ok(deleted) => respond(json!({ "ok": true, "deleted": deleted })),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderQuery {
    environment: String,
    #[serde(default)]
    path: Option<String>,
}

/// GET /api/vault/folders?environment=.
#[utoipa::path(get, path = "/api/vault/folders", tag = "Vault",
    summary = "List folders in an environment",
    params(("environment" = String, Query, description = "Environment slug")),
    responses((status = 200, description = "Folder paths", body = serde_json::Value)))]
pub async fn list_folders(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<FolderQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    match ctx.store.list_folders(&query.environment).await {
        Ok(folders) => respond(json!({ "folders": folders })),
        Err(error) => vault_error(error),
    }
}

/// Validate a folder target and build its policy key from the canonical path,
/// so `a/b`, `/a/b/`, and `/a/b` all evaluate as `sys/folders/<env>/a/b` (the
/// root folder is `sys/folders/<env>`, like secret keys omit the root slash).
/// Returns `(normalized_path, policy_key)`.
fn folder_policy_key(environment: &str, path: &str) -> Result<(String, String), Response> {
    if !crate::vault::is_valid_environment(environment) {
        return Err(invalid_request("invalid environment"));
    }
    let path =
        crate::vault::normalize_path(path).ok_or_else(|| invalid_request("invalid folder path"))?;
    let key = if path == ROOT_PATH {
        format!("sys/folders/{environment}")
    } else {
        format!("sys/folders/{environment}{path}")
    };
    Ok((path, key))
}

/// POST /api/vault/folders creates a folder; DELETE removes an empty one.
#[utoipa::path(post, path = "/api/vault/folders", tag = "Vault",
    summary = "Create a folder",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created", body = serde_json::Value)))]
pub async fn create_folder(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<FolderQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let (path, key) =
        match folder_policy_key(&body.environment, body.path.as_deref().unwrap_or_default()) {
            Ok(target) => target,
            Err(response) => return response,
        };
    // Creating a folder is a write in the environment, not an admin action.
    // Managers (and the unbound local operator) hold every capability as the
    // `sys_caps` baseline, so a deny bound to them still applies.
    if let Err(response) = ctx.require_sys(&key, Capability::Write) {
        return response;
    }
    match ctx.store.create_folder(&body.environment, &path).await {
        Ok(path) => respond(json!({ "ok": true, "path": path })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/folders?environment=&path=.
#[utoipa::path(delete, path = "/api/vault/folders", tag = "Vault",
    summary = "Delete an empty folder",
    params(
        ("environment" = String, Query, description = "Environment slug"),
        ("path" = String, Query, description = "Folder path"),
    ),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn delete_folder(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<FolderQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let (path, key) = match folder_policy_key(
        &query.environment,
        query.path.as_deref().unwrap_or_default(),
    ) {
        Ok(target) => target,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(&key, Capability::Admin) {
        return response;
    }
    match ctx.store.delete_folder(&query.environment, &path).await {
        Ok(deleted) => respond(json!({ "ok": true, "deleted": deleted })),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/imports.
#[utoipa::path(get, path = "/api/vault/imports", tag = "Vault",
    summary = "List folder imports",
    responses((status = 200, description = "Imports", body = serde_json::Value)))]
pub async fn list_imports(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    match ctx.store.list_imports().await {
        Ok(imports) => respond(json!({ "imports": imports })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/imports adds a folder import.
#[utoipa::path(post, path = "/api/vault/imports", tag = "Vault",
    summary = "Import another folder as a fallback (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created", body = serde_json::Value)))]
pub async fn add_import(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(import): Json<FolderImport>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/imports", Capability::Admin) {
        return response;
    }
    match ctx.store.add_import(&import, &ctx.actor()).await {
        Ok(import) => respond(json!({ "ok": true, "import": import })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/imports/{id}.
#[utoipa::path(delete, path = "/api/vault/imports/{id}", tag = "Vault",
    summary = "Remove a folder import (admin)",
    params(("id" = String, Path, description = "Import id")),
    responses((status = 200, description = "Removed", body = serde_json::Value)))]
pub async fn remove_import(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/imports", Capability::Admin) {
        return response;
    }
    match ctx.store.remove_import(&id, &ctx.actor()).await {
        Ok(removed) => respond(json!({ "ok": true, "removed": removed })),
        Err(error) => vault_error(error),
    }
}

// ── Policies ──────────────────────────────────────────────────────────────

/// GET /api/vault/policies lists policies and bindings.
#[utoipa::path(get, path = "/api/vault/policies", tag = "Vault",
    summary = "List vault policies and bindings (admin)",
    responses((status = 200, description = "Policies", body = serde_json::Value)))]
pub async fn list_policies(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/policies", Capability::Admin) {
        return response;
    }
    let conn = ctx.store.conn.lock().await;
    let policies = crate::vault::policy::list_policies(&conn);
    let bindings = crate::vault::policy::list_bindings(&conn);
    drop(conn);
    match (policies, bindings) {
        (Ok(policies), Ok(bindings)) => {
            respond(json!({ "policies": policies, "bindings": bindings }))
        }
        (Err(error), _) | (_, Err(error)) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyBody {
    #[serde(default)]
    description: String,
    rules: Vec<PolicyRule>,
}

/// PUT /api/vault/policies/{name}.
#[utoipa::path(put, path = "/api/vault/policies/{name}", tag = "Vault",
    summary = "Create or replace a vault policy (admin)",
    params(("name" = String, Path, description = "Policy name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value)))]
pub async fn put_policy(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<PolicyBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/policies", Capability::Admin) {
        return response;
    }
    let policy = Policy {
        name,
        description: body.description,
        rules: body.rules,
    };
    if let Err(error) = crate::vault::policy::validate(&policy) {
        return invalid_request(&error.to_string());
    }
    let conn = ctx.store.conn.lock().await;
    if let Err(error) = crate::vault::policy::put_policy(&conn, &policy) {
        return vault_error(error);
    }
    ctx.store.audit_locked(
        &conn,
        &AuditEntry::new(&ctx.actor(), "policy.put", "ok")
            .details(json!({ "policy": policy.name })),
    );
    respond(json!({ "ok": true, "policy": policy }))
}

/// DELETE /api/vault/policies/{name}.
#[utoipa::path(delete, path = "/api/vault/policies/{name}", tag = "Vault",
    summary = "Delete a vault policy and its bindings (admin)",
    params(("name" = String, Path, description = "Policy name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn delete_policy(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/policies", Capability::Admin) {
        return response;
    }
    let conn = ctx.store.conn.lock().await;
    match crate::vault::policy::delete_policy(&conn, &name) {
        Ok(deleted) => {
            ctx.store.audit_locked(
                &conn,
                &AuditEntry::new(&ctx.actor(), "policy.delete", "ok")
                    .details(json!({ "policy": name })),
            );
            respond(json!({ "ok": true, "deleted": deleted }))
        }
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingBody {
    policy: String,
    subject: String,
    #[serde(default)]
    expires_at: Option<i64>,
}

/// POST /api/vault/policy-bindings attaches a policy, optionally temporarily.
#[utoipa::path(post, path = "/api/vault/policy-bindings", tag = "Vault",
    summary = "Bind a policy to a user, team, role, or machine (admin; optional expiry)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Bound", body = serde_json::Value)))]
pub async fn add_binding(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let body: BindingBody = match parse_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/policies", Capability::Admin) {
        return response;
    }
    let actor = ctx.actor();
    let conn = ctx.store.conn.lock().await;
    match crate::vault::policy::bind(
        &conn,
        &body.policy,
        &body.subject,
        body.expires_at,
        actor.id.as_deref(),
    ) {
        Ok(binding) => {
            ctx.store.audit_locked(
                &conn,
                &AuditEntry::new(&actor, "policy.bind", "ok").details(json!({
                    "policy": binding.policy, "subject": binding.subject, "expiresAt": binding.expires_at,
                })),
            );
            respond(json!({ "ok": true, "binding": binding }))
        }
        Err(error) => invalid_request(&error.to_string()),
    }
}

/// DELETE /api/vault/policy-bindings/{id}.
#[utoipa::path(delete, path = "/api/vault/policy-bindings/{id}", tag = "Vault",
    summary = "Remove a policy binding (admin)",
    params(("id" = String, Path, description = "Binding id")),
    responses((status = 200, description = "Removed", body = serde_json::Value)))]
pub async fn remove_binding(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/policies", Capability::Admin) {
        return response;
    }
    let conn = ctx.store.conn.lock().await;
    match crate::vault::policy::unbind(&conn, &id) {
        Ok(removed) => {
            ctx.store.audit_locked(
                &conn,
                &AuditEntry::new(&ctx.actor(), "policy.unbind", "ok")
                    .details(json!({ "binding": id })),
            );
            respond(json!({ "ok": true, "removed": removed }))
        }
        Err(error) => vault_error(error),
    }
}

// ── Change requests ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeQuery {
    #[serde(default)]
    status: Option<ChangeStatus>,
}

/// GET /api/vault/change-requests lists requests the caller may see.
#[utoipa::path(get, path = "/api/vault/change-requests", tag = "Vault",
    summary = "List change requests for protected environments",
    params(("status" = Option<String>, Query, description = "pending, applied, rejected, canceled")),
    responses((status = 200, description = "Requests (never proposed values)", body = serde_json::Value)))]
pub async fn list_change_requests(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<ChangeQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let me = ctx.actor();
    let mine = crate::vault::changes::subject_of(&me);
    match ctx.store.list_change_requests(query.status).await {
        Ok(requests) => {
            let mut visible: Vec<Value> = requests
                .into_iter()
                .filter(|request| {
                    let caps = ctx.approval_caps(&request.coords);
                    caps.contains(&Capability::Approve) || request.requested_by == mine
                })
                .map(|request| serde_json::to_value(request).unwrap_or(Value::Null))
                .collect();
            // Requests on shared values live in the control plane, which
            // applies its own visibility rules.
            let mut shared_error = None;
            if let (true, Some(jwt)) = (crate::vault::shared::is_enabled(), ctx.jwt.as_deref()) {
                let mut pairs = Vec::new();
                if let Some(status) = query.status {
                    if let Some(status) = serde_json::to_value(status)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_owned))
                    {
                        pairs.push(("status".to_owned(), status));
                    }
                }
                match crate::vault::shared::proxy(
                    reqwest::Method::GET,
                    "/change-requests",
                    &pairs,
                    jwt,
                    None,
                    false,
                )
                .await
                {
                    Ok(value) => {
                        let remote = value.get("changeRequests").and_then(Value::as_array);
                        for mut request in remote.into_iter().flatten().cloned() {
                            if let Some(object) = request.as_object_mut() {
                                object.insert("source".into(), json!("control-plane"));
                            }
                            visible.push(request);
                        }
                    }
                    Err(error) => shared_error = Some(format!("{error:?}")),
                }
            }
            respond(json!({ "changeRequests": visible, "sharedError": shared_error }))
        }
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionBody {
    #[serde(default)]
    reason: Option<String>,
}

/// POST /api/vault/change-requests/{id}/{decision} for `approve`, `reject`, `cancel`.
#[utoipa::path(post, path = "/api/vault/change-requests/{id}/{decision}", tag = "Vault",
    summary = "Approve, reject, or cancel a change request",
    params(
        ("id" = String, Path, description = "Change request id"),
        ("decision" = String, Path, description = "`approve`, `reject`, or `cancel`"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Updated request", body = serde_json::Value)))]
pub async fn decide_change_request(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((id, decision)): Path<(String, String)>,
    body: Option<Json<DecisionBody>>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let reason = body.and_then(|Json(body)| body.reason);
    let request = match ctx.store.change_request(&id).await {
        Ok(request) => request,
        Err(error) => {
            // Not a local request: it may be one on a shared value.
            let not_found = matches!(
                error.downcast_ref::<VaultError>(),
                Some(VaultError::NotFound(_))
            );
            if not_found && crate::vault::shared::is_enabled() && ctx.jwt.is_some() {
                return proxy(
                    &ctx,
                    reqwest::Method::POST,
                    &format!(
                        "/change-requests/{}/{}",
                        urlencoding::encode(&id),
                        urlencoding::encode(&decision)
                    ),
                    &[],
                    Some(json!({ "reason": reason })),
                )
                .await;
            }
            return vault_error(error);
        }
    };
    let actor = ctx.actor();
    let result = match decision.as_str() {
        "approve" | "reject" => {
            if !ctx
                .approval_caps(&request.coords)
                .contains(&Capability::Approve)
            {
                return denied(Capability::Approve, &request.coords.policy_key());
            }
            if decision == "approve" {
                // Re-read the environment so a raised threshold also covers
                // requests that were already pending.
                let current_required =
                    match protected_environment(&ctx, &request.coords.environment).await {
                        Ok(required) => required,
                        Err(response) => return response,
                    };
                ctx.store
                    .approve_change_request(&id, &actor, current_required)
                    .await
            } else {
                ctx.store
                    .close_change_request(&id, &actor, reason.as_deref(), false)
                    .await
            }
        }
        "cancel" => {
            ctx.store
                .close_change_request(&id, &actor, reason.as_deref(), true)
                .await
        }
        _ => {
            return json_error(
                StatusCode::NOT_FOUND,
                "vault_not_found: unknown decision".to_owned(),
            )
        }
    };
    match result {
        Ok(request) => respond(json!({ "ok": true, "changeRequest": request })),
        Err(error) => vault_error(error),
    }
}

// ── Audit ─────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    #[serde(default)]
    before: Option<i64>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    actor_id: Option<String>,
    #[serde(default)]
    environment: Option<String>,
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
    share: Option<String>,
    #[serde(default)]
    shares: Option<u8>,
    #[serde(default)]
    threshold: Option<u8>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_verify::TeamMembership;

    fn node(
        scope: NodeScope,
        team_id: Option<&str>,
        owner_user_id: Option<&str>,
    ) -> RegisteredNode {
        RegisteredNode {
            org: crate::sidecar::control_plane::RegisteredOrg {
                id: "org-1".to_owned(),
                name: "Acme".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope,
            team_id: team_id.map(str::to_owned),
            owner_user_id: owner_user_id.map(str::to_owned),
        }
    }

    fn caller(user_id: &str, role: OrgRole, team_ids: &[&str]) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".to_owned()),
            role,
            teams: team_ids
                .iter()
                .map(|id| TeamMembership {
                    id: (*id).to_owned(),
                    org_id: "org-1".to_owned(),
                    role: "member".to_owned(),
                })
                .collect(),
        }
    }

    fn info(scope: SecretScope, scope_id: &str) -> VaultSecretInfo {
        VaultSecretInfo {
            name: "GITHUB_TOKEN".to_owned(),
            scope,
            scope_id: scope_id.to_owned(),
            binding: None,
            updated_at: 1,
            environment: DEFAULT_ENVIRONMENT.to_owned(),
            path: ROOT_PATH.to_owned(),
            version: 1,
            metadata: Default::default(),
            created_at: 1,
            created_by: None,
            updated_by: None,
            rotated_at: 1,
            deleted_at: None,
            metadata_version: 1,
        }
    }

    async fn parts(response: Response) -> (StatusCode, String) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn a_login_refusal_is_one_403_whatever_the_store_said() {
        let causes: Vec<anyhow::Error> = vec![
            VaultError::NotFound("machine identity `ci-deploy`".into()).into(),
            VaultError::Invalid("identity does not use jwt login".into()).into(),
            VaultError::Denied("identity is disabled".into()).into(),
            VaultError::Denied("JWT rejected: ExpiredSignature".into()).into(),
            VaultError::Conflict("already exists".into()).into(),
        ];
        let mut seen = Vec::new();
        for cause in causes {
            let (status, body) = parts(login_refusal(cause)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            for leak in ["ci-deploy", "jwt", "JWT", "disabled", "Expired", "exists"] {
                assert!(!body.contains(leak), "`{leak}` leaked: {body}");
            }
            seen.push(body);
        }
        assert!(seen.windows(2).all(|pair| pair[0] == pair[1]), "{seen:?}");
        assert_eq!(seen[0], r#"{"error":"vault_denied: login rejected"}"#);
    }

    #[tokio::test]
    async fn a_login_refusal_leaves_retryable_and_unexpected_failures_to_vault_error() {
        type Cause = fn() -> anyhow::Error;
        let cases: [(&str, Cause, StatusCode); 4] = [
            (
                "sealed",
                || VaultError::Sealed.into(),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                "audit unavailable",
                || VaultError::AuditUnavailable.into(),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                "storage",
                || rusqlite::Error::QueryReturnedNoRows.into(),
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
            (
                "unexpected",
                || anyhow::anyhow!("boom"),
                StatusCode::BAD_REQUEST,
            ),
        ];
        for (label, cause, status) in cases {
            let refused = parts(login_refusal(cause())).await;
            assert_eq!(refused.0, status, "{label}: {}", refused.1);
            assert_eq!(refused, parts(vault_error(cause())).await, "{label}");
        }
    }

    fn ctx(
        node: Option<RegisteredNode>,
        caller: Option<VerifiedCaller>,
        manager: bool,
        policies: Vec<Policy>,
    ) -> Ctx {
        Ctx {
            store: Box::leak(Box::new(PluginSecretStore::in_memory().unwrap())),
            node_id: "node-1".to_owned(),
            manager: manager || node.is_none(),
            node,
            caller,
            policies,
            jwt: None,
        }
    }

    #[test]
    fn visibility_matches_the_four_scope_boundaries() {
        let org_node = node(NodeScope::Org, None, None);
        let member = caller("user-1", OrgRole::Member, &["team-1"]);
        assert!(record_visible(
            &info(SecretScope::Node, "node-1"),
            Some(&org_node),
            Some(&member),
            "node-1"
        ));
        assert!(record_visible(
            &info(SecretScope::User, "user-1"),
            Some(&org_node),
            Some(&member),
            "node-1"
        ));
        assert!(record_visible(
            &info(SecretScope::Team, "team-1"),
            Some(&org_node),
            Some(&member),
            "node-1"
        ));
        assert!(record_visible(
            &info(SecretScope::Org, "org-1"),
            Some(&org_node),
            Some(&member),
            "node-1"
        ));
        assert!(!record_visible(
            &info(SecretScope::User, "user-2"),
            Some(&org_node),
            Some(&member),
            "node-1"
        ));
    }

    #[test]
    fn team_and_org_metadata_are_not_visible_without_verified_identity() {
        let org_node = node(NodeScope::Org, None, None);
        assert!(!record_visible(
            &info(SecretScope::Team, "team-1"),
            Some(&org_node),
            None,
            "node-1"
        ));
        assert!(!record_visible(
            &info(SecretScope::Org, "org-1"),
            Some(&org_node),
            None,
            "node-1"
        ));
        assert!(record_visible(
            &info(SecretScope::Node, "node-1"),
            Some(&org_node),
            None,
            "node-1"
        ));
    }

    #[test]
    fn target_scope_ids_cannot_be_repointed() {
        let org_node = node(NodeScope::Org, None, None);
        let member = caller("user-1", OrgRole::Member, &["team-1"]);
        assert!(resolve_target(
            SecretScope::User,
            Some("user-2".to_owned()),
            None,
            Some(&org_node),
            Some(&member)
        )
        .is_err());
        assert!(resolve_target(
            SecretScope::Org,
            Some("org-2".to_owned()),
            None,
            Some(&org_node),
            Some(&member)
        )
        .is_err());
        assert!(resolve_target(
            SecretScope::Team,
            Some("team-2".to_owned()),
            None,
            Some(&org_node),
            Some(&member)
        )
        .is_err());
    }

    #[test]
    fn baseline_capabilities_preserve_the_pre_policy_rules() {
        let org_node = node(NodeScope::Org, None, None);
        let member = ctx(
            Some(org_node.clone()),
            Some(caller("user-1", OrgRole::Member, &["team-1"])),
            false,
            vec![],
        );
        let own = info(SecretScope::User, "user-1").coords();
        assert!(member.caps(&own).contains(&Capability::Read));
        let team = info(SecretScope::Team, "team-1").coords();
        let caps = member.caps(&team);
        assert!(caps.contains(&Capability::Use) && !caps.contains(&Capability::Read));
        let manager = ctx(
            Some(org_node),
            Some(caller("admin", OrgRole::Admin, &[])),
            true,
            vec![],
        );
        assert!(manager
            .caps(&info(SecretScope::Org, "org-1").coords())
            .contains(&Capability::Approve));
        let local = ctx(None, None, true, vec![]);
        assert_eq!(
            local.caps(&info(SecretScope::User, "local").coords()).len(),
            Capability::ALL.len()
        );
    }

    #[test]
    fn policies_grant_and_deny_on_top_of_the_baseline() {
        let org_node = node(NodeScope::Org, None, None);
        let reader = Policy {
            name: "read-team".into(),
            description: String::new(),
            rules: vec![
                PolicyRule {
                    path: "default/**".into(),
                    capabilities: vec![Capability::Read],
                    deny: false,
                    ..Default::default()
                },
                PolicyRule {
                    path: "default/PROD_*".into(),
                    capabilities: vec![Capability::Use],
                    deny: true,
                    ..Default::default()
                },
            ],
        };
        let member = ctx(
            Some(org_node),
            Some(caller("user-1", OrgRole::Member, &["team-1"])),
            false,
            vec![reader],
        );
        let mut team = info(SecretScope::Team, "team-1").coords();
        assert!(member.caps(&team).contains(&Capability::Read));
        team.name = "PROD_KEY".into();
        assert!(!member.caps(&team).contains(&Capability::Use));
    }

    #[test]
    fn folder_policy_keys_are_canonical_and_denies_bind_managers() {
        for raw in [
            "restricted",
            "/restricted",
            "/restricted/",
            "  restricted/ ",
        ] {
            let (path, key) = folder_policy_key("prod", raw).unwrap();
            assert_eq!(path, "/restricted");
            assert_eq!(key, "sys/folders/prod/restricted");
        }
        assert_eq!(
            folder_policy_key("prod", "").unwrap(),
            ("/".to_owned(), "sys/folders/prod".to_owned())
        );
        assert!(folder_policy_key("prod", "a/../b").is_err());
        assert!(folder_policy_key("prod", "a//b").is_err());
        assert!(folder_policy_key("Prod", "a").is_err());
        assert!(folder_policy_key("sys", "a").is_err());

        let policy = Policy {
            name: "prod-folders-locked".into(),
            description: String::new(),
            rules: vec![
                PolicyRule {
                    path: "**".into(),
                    capabilities: vec![Capability::Write, Capability::Admin],
                    deny: false,
                    ..Default::default()
                },
                PolicyRule {
                    path: "sys/folders/prod/**".into(),
                    capabilities: vec![Capability::Write, Capability::Admin],
                    deny: true,
                    ..Default::default()
                },
            ],
        };
        let org_node = node(NodeScope::Org, None, None);
        for manager in [false, true] {
            let ctx = ctx(
                Some(org_node.clone()),
                Some(caller("user-1", OrgRole::Member, &[])),
                manager,
                vec![policy.clone()],
            );
            // Omitting the leading slash no longer slips past the deny.
            let (_, key) = folder_policy_key("prod", "restricted").unwrap();
            assert!(ctx.require_sys(&key, Capability::Write).is_err());
            assert!(ctx.require_sys(&key, Capability::Admin).is_err());
            // Other environments stay writable.
            let (_, key) = folder_policy_key("staging", "restricted").unwrap();
            assert!(ctx.require_sys(&key, Capability::Write).is_ok());
            assert!(ctx.require_sys(&key, Capability::Admin).is_ok());
        }
        // A manager with no policies keeps folder write/admin.
        let manager = ctx(
            Some(org_node),
            Some(caller("admin", OrgRole::Admin, &[])),
            true,
            vec![],
        );
        let (_, key) = folder_policy_key("prod", "restricted").unwrap();
        assert!(manager.require_sys(&key, Capability::Write).is_ok());
        assert!(manager.require_sys(&key, Capability::Admin).is_ok());
    }

    #[tokio::test]
    async fn policies_never_widen_visibility_past_the_scope_boundary() {
        let org_node = node(NodeScope::Org, None, None);
        let broad = Policy {
            name: "broad".into(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: "default/**".into(),
                capabilities: vec![
                    Capability::List,
                    Capability::Read,
                    Capability::Use,
                    Capability::Approve,
                ],
                deny: false,
                ..Default::default()
            }],
        };
        let member = ctx(
            Some(org_node),
            Some(caller("user-1", OrgRole::Member, &["team-1"])),
            false,
            vec![broad],
        );
        for (scope, scope_id, name, value) in [
            (SecretScope::User, "user-1", "MINE", "mine-value-1234567890"),
            (
                SecretScope::User,
                "user-2",
                "THEIRS",
                "theirs-value-1234567890",
            ),
            (
                SecretScope::Team,
                "team-1",
                "MY_TEAM",
                "team-one-value-1234567890",
            ),
            (
                SecretScope::Team,
                "team-2",
                "OTHER_TEAM",
                "team-two-value-1234567890",
            ),
        ] {
            member
                .store
                .set_vault_secret(scope, scope_id, None, name, value)
                .await
                .unwrap();
        }

        // Another member's personal value and a non-member team get nothing,
        // even though the policy path matches them.
        assert!(member
            .caps(&info(SecretScope::User, "user-2").coords())
            .is_empty());
        assert!(member
            .caps(&info(SecretScope::Team, "team-2").coords())
            .is_empty());
        // The caller's own scopes keep the policy grant.
        assert!(member
            .caps(&info(SecretScope::Team, "team-1").coords())
            .contains(&Capability::Read));
        assert!(member
            .caps(&info(SecretScope::User, "user-1").coords())
            .contains(&Capability::List));

        // The listing filter (`list_secrets`) omits the out-of-scope rows.
        let page = member
            .store
            .list_secrets_page(&ListFilter::default(), None, 50, |info| {
                member.caps(&info.coords()).contains(&Capability::List)
            })
            .await
            .unwrap();
        let mut listed: Vec<&str> = page.secrets.iter().map(|info| info.name.as_str()).collect();
        listed.sort_unstable();
        assert_eq!(listed, ["MINE", "MY_TEAM"]);

        // `scan` known values come only from directly readable, visible rows.
        let known: Vec<String> = member
            .store
            .current_values(&ListFilter::default())
            .await
            .unwrap()
            .into_iter()
            .filter(|(info, _)| member.can_read_directly(&info.coords()))
            .map(|(_, value)| value)
            .collect();
        assert!(known.iter().any(|value| value == "mine-value-1234567890"));
        assert!(!known.iter().any(|value| value == "theirs-value-1234567890"));
        assert!(!known
            .iter()
            .any(|value| value == "team-two-value-1234567890"));

        // A submitted change request stays approvable by an explicit policy
        // grant, which is the one flow that acts outside the approver's scope.
        assert!(member
            .approval_caps(&info(SecretScope::User, "user-2").coords())
            .contains(&Capability::Approve));
    }

    async fn body_json(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn constrained_writer() -> Policy {
        Policy {
            name: "constrained".into(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: "**".into(),
                capabilities: vec![Capability::Read, Capability::Write],
                deny: false,
                denied_parameters: Some(BTreeMap::from([(
                    "value".to_owned(),
                    vec!["bad*".to_owned()],
                )])),
                ..Default::default()
            }],
        }
    }

    #[tokio::test]
    async fn import_and_rollback_cannot_bypass_write_parameter_constraints() {
        let ctx = ctx(
            None,
            Some(caller("alice", OrgRole::Member, &[])),
            true,
            vec![constrained_writer()],
        );
        // v1 predates the constraint; v2 is the current, compliant value.
        for value in ["bad-old", "good"] {
            ctx.store
                .set_vault_secret(SecretScope::User, "alice", None, "API_KEY", value)
                .await
                .unwrap();
        }
        let coords = SecretCoords::root(SecretScope::User, "alice", None, "API_KEY");
        assert!(ctx
            .require_write_parameters(&coords, Some("bad-new"))
            .is_err());
        assert!(ctx.require_write_parameters(&coords, Some("fine")).is_ok());

        let import = |content: &str| -> ImportBody {
            serde_json::from_value(json!({
                "scope": "user", "scopeId": "alice", "format": "dotenv",
                "content": content, "onConflict": "overwrite",
            }))
            .unwrap()
        };
        let response = import_with(&ctx, import("API_KEY=bad-new\n")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let report = body_json(response).await;
        assert_eq!(report["report"]["skipped"], 1);
        let actor = ctx.actor();
        assert_eq!(
            ctx.store.reveal(&coords, None, &actor).await.unwrap(),
            "good"
        );
        let response = import_with(&ctx, import("API_KEY=fine\n")).await;
        assert_eq!(body_json(response).await["report"]["updated"], 1);

        let action = |version: i64| -> VersionActionBody {
            serde_json::from_value(json!({
                "scope": "user", "scopeId": "alice", "version": version,
            }))
            .unwrap()
        };
        let response = secret_action_with(&ctx, "API_KEY", "rollback", action(1)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = secret_action_with(&ctx, "API_KEY", "rollback", action(2)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            ctx.store.reveal(&coords, None, &actor).await.unwrap(),
            "good"
        );
    }

    #[test]
    fn timestamps_render_as_rfc3339_both_ways() {
        let out = rfc3339_fields(
            json!({ "createdAt": 0, "nested": [{ "expiresAt": 1000 }], "version": 3 }),
        );
        assert_eq!(out["createdAt"], "1970-01-01T00:00:00+00:00");
        assert_eq!(out["nested"][0]["expiresAt"], "1970-01-01T00:00:01+00:00");
        assert_eq!(out["version"], 3);
        let engines = rfc3339_fields(json!({
            "approvals": [{ "at": 0 }], "notAfter": 1000, "validBefore": 1,
        }));
        assert_eq!(engines["approvals"][0]["at"], "1970-01-01T00:00:00+00:00");
        assert_eq!(engines["notAfter"], "1970-01-01T00:00:01+00:00");
        assert_eq!(engines["validBefore"], "1970-01-01T00:00:01+00:00");
        let back = millis_fields(json!({ "expiresAt": "1970-01-01T00:00:01Z" })).unwrap();
        assert_eq!(back["expiresAt"], 1000);
        assert!(millis_fields(json!({ "expiresAt": "tomorrow" })).is_err());
    }

    #[test]
    fn the_step_up_refusal_is_recognized_by_its_error_code() {
        assert!(is_step_up_required(
            &json!({ "error": "STEP_UP_REQUIRED", "scope": "org.credentials" })
        ));
        assert!(!is_step_up_required(&json!({ "error": "forbidden" })));
        assert!(!is_step_up_required(
            &json!({ "message": "STEP_UP_REQUIRED" })
        ));
        assert!(!is_step_up_required(&Value::Null));
    }

    #[test]
    fn the_node_key_vouches_only_for_its_verified_local_caller_on_a_shared_node() {
        let alice = caller("alice", OrgRole::Member, &["team-a"]);
        let org = node(NodeScope::Org, None, None);
        let team = node(NodeScope::Team, Some("team-a"), None);
        // The legitimate path: `ryu secrets` on this org or team node's own
        // machine, with the JWT that produced the verified caller.
        assert!(node_key_may_vouch(
            Some(&org),
            Some(&alice),
            Some(&alice),
            true
        ));
        assert!(node_key_may_vouch(
            Some(&team),
            Some(&alice),
            Some(&alice),
            true
        ));

        // A personal node never vouches, even for its owner.
        let personal = node(NodeScope::Personal, None, Some("alice"));
        assert!(!node_key_may_vouch(
            Some(&personal),
            Some(&alice),
            Some(&alice),
            true
        ));
        // A remote holder of a node or paired token gets no proof, and neither
        // does a loopback request whose bearer is not the owner token (a
        // session-riding page sending a minted user JWT to this port).
        assert!(!node_key_may_vouch(
            Some(&org),
            Some(&alice),
            Some(&alice),
            false
        ));
        // The forwarded JWT names someone else, or does not verify at all.
        let mallory = caller("mallory", OrgRole::Admin, &[]);
        assert!(!node_key_may_vouch(
            Some(&org),
            Some(&alice),
            Some(&mallory),
            true
        ));
        assert!(!node_key_may_vouch(Some(&org), Some(&alice), None, true));
        let mut alice_elsewhere = alice.clone();
        alice_elsewhere.org_id = Some("org-2".to_owned());
        assert!(!node_key_may_vouch(
            Some(&org),
            Some(&alice),
            Some(&alice_elsewhere),
            true
        ));
        // No verified caller, a caller from another org, or no node at all.
        assert!(!node_key_may_vouch(Some(&org), None, Some(&alice), true));
        assert!(!node_key_may_vouch(
            Some(&org),
            Some(&alice_elsewhere),
            Some(&alice_elsewhere),
            true
        ));
        assert!(!node_key_may_vouch(None, Some(&alice), Some(&alice), true));
    }

    #[tokio::test]
    async fn the_vouch_is_withheld_unless_the_forwarded_jwt_verifies_locally() {
        let alice = caller("alice", OrgRole::Member, &[]);
        let mut with_jwt = ctx(
            Some(node(NodeScope::Org, None, None)),
            Some(alice),
            false,
            Vec::new(),
        );
        // No JWT to forward: nothing to vouch for.
        assert!(!with_jwt.node_vouches().await);
        with_jwt.jwt = Some("not-a-jwt".to_owned());
        // Outside an HTTP request, locality is unknown and counts as remote.
        assert!(!with_jwt.node_vouches().await);
        // A local request whose bearer is not the owner token gets no proof.
        assert!(
            !crate::server::REQUEST_PEER_IS_LOCAL
                .scope(true, with_jwt.node_vouches())
                .await
        );
        // Nor does a remote one.
        assert!(
            !crate::server::REQUEST_PEER_IS_LOCAL
                .scope(false, with_jwt.node_vouches())
                .await
        );
        // Nor a local owner-token request whose JWT does not verify.
        assert!(
            !crate::server::REQUEST_PEER_IS_LOCAL
                .scope(
                    true,
                    crate::server::REQUEST_PRESENTS_OWNER_TOKEN
                        .scope(true, with_jwt.node_vouches())
                )
                .await
        );
    }

    #[tokio::test]
    async fn only_a_local_request_admitted_with_the_owner_token_is_the_local_owner() {
        use crate::authorization::{AuthorizationContext, CredentialKind};
        let local_owner = |local: bool, owner: bool| {
            crate::server::REQUEST_PEER_IS_LOCAL.scope(
                local,
                crate::server::REQUEST_PRESENTS_OWNER_TOKEN.scope(owner, async {
                    crate::server::request_is_from_local_owner()
                }),
            )
        };
        assert!(local_owner(true, true).await);
        // A browser script on a CORS-allowed origin reaches loopback with a
        // minted user JWT as its bearer: local, but not the owner token.
        assert!(!local_owner(true, false).await);
        // The owner token from a remote peer, or through a forwarding tunnel.
        assert!(!local_owner(false, true).await);
        assert!(!local_owner(false, false).await);
        // Outside an HTTP request it fails closed.
        assert!(!crate::server::request_is_from_local_owner());
        assert!(
            !crate::server::REQUEST_PEER_IS_LOCAL
                .scope(true, async { crate::server::request_is_from_local_owner() })
                .await
        );

        let owner = AuthorizationContext::owner(0);
        assert!(crate::server::presents_owner_token(&owner));
        for credential in [
            CredentialKind::None,
            CredentialKind::ManagedUserJwt,
            CredentialKind::ManagedDelegation,
            CredentialKind::HostedOAuth,
            CredentialKind::PluginHostGrant,
            CredentialKind::NodeWorkload,
            CredentialKind::PairedCapability {
                grant_id: "grant".to_owned(),
            },
        ] {
            let context = AuthorizationContext {
                credential,
                ..AuthorizationContext::owner(0)
            };
            assert!(!crate::server::presents_owner_token(&context));
        }
    }

    #[test]
    fn only_a_verified_user_jwt_bearer_is_forwarded_as_the_user_jwt() {
        let headers = |pairs: &[(&'static str, &str)]| {
            let mut map = HeaderMap::new();
            for (name, value) in pairs {
                map.insert(*name, value.parse().unwrap());
            }
            map
        };
        // A bearer that admitted the request as anything but a user JWT (the
        // owner token, a paired token, a node delegation) never goes upstream.
        let node_bearer = headers(&[("authorization", "Bearer node-local-secret")]);
        assert_eq!(user_jwt(&node_bearer, false), None);
        // The header JWT is forwarded beside such a bearer.
        let with_header = headers(&[
            ("authorization", "Bearer node-local-secret"),
            ("x-ryu-user-jwt", "user.jwt.value"),
        ]);
        assert_eq!(
            user_jwt(&with_header, false).as_deref(),
            Some("user.jwt.value")
        );
        // A bearer that admitted the request as a verified user JWT is that JWT.
        let jwt_bearer = headers(&[("authorization", "Bearer user.jwt.value")]);
        assert_eq!(
            user_jwt(&jwt_bearer, true).as_deref(),
            Some("user.jwt.value")
        );
        assert_eq!(user_jwt(&HeaderMap::new(), true), None);
    }

    #[test]
    fn only_a_managed_user_jwt_admission_marks_the_bearer_as_the_user_jwt() {
        use crate::authorization::{AuthorizationContext, CredentialKind};
        let admitted_by = |credential| AuthorizationContext {
            credential,
            ..AuthorizationContext::owner(0)
        };
        assert!(crate::server::bearer_is_user_jwt(&admitted_by(
            CredentialKind::ManagedUserJwt
        )));
        for credential in [
            CredentialKind::None,
            CredentialKind::OwnerRecoveryToken,
            CredentialKind::ManagedDelegation,
            CredentialKind::HostedOAuth,
            CredentialKind::PluginHostGrant,
            CredentialKind::NodeWorkload,
            CredentialKind::PairedCapability {
                grant_id: "grant".to_owned(),
            },
        ] {
            assert!(!crate::server::bearer_is_user_jwt(&admitted_by(credential)));
        }
    }

    #[tokio::test]
    async fn the_user_jwt_bearer_flag_is_read_only_inside_the_request_scope() {
        assert!(!crate::server::request_bearer_is_user_jwt());
        assert!(
            crate::server::REQUEST_BEARER_IS_USER_JWT
                .scope(true, async { crate::server::request_bearer_is_user_jwt() })
                .await
        );
        assert!(
            !crate::server::REQUEST_BEARER_IS_USER_JWT
                .scope(false, async { crate::server::request_bearer_is_user_jwt() })
                .await
        );
    }

    #[tokio::test]
    async fn the_owner_token_flag_is_read_only_inside_the_request_scope() {
        assert!(!crate::server::request_presents_owner_token());
        assert!(
            crate::server::REQUEST_PRESENTS_OWNER_TOKEN
                .scope(true, async {
                    crate::server::request_presents_owner_token()
                })
                .await
        );
        assert!(
            !crate::server::REQUEST_PRESENTS_OWNER_TOKEN
                .scope(false, async {
                    crate::server::request_presents_owner_token()
                })
                .await
        );
    }

    #[test]
    fn export_warns_on_caller_refusals_and_fails_only_on_step_up() {
        let coded = |code: &str| json!({ "code": code, "error": "Unauthorized" });
        for code in [
            "node_proxy_required",
            "user_jwt_invalid",
            "user_jwt_session_ended",
            "user_jwt_org_not_admitted",
            "org_ip_not_allowed",
            "org_mfa_session_required",
            "org_session_expired",
            "mfa_enrollment_required",
            "staff_session_factor_required",
        ] {
            assert!(is_caller_refusal(401, &coded(code)), "{code}");
            assert!(is_caller_refusal(403, &coded(code)), "{code}");
            assert!(!is_caller_refusal(400, &coded(code)), "{code}");
        }
        // The step-up prompt is passed through instead (it fails the export).
        let step_up = json!({ "error": "STEP_UP_REQUIRED", "scope": "org.credentials" });
        assert!(is_step_up_required(&step_up));
        assert!(!is_caller_refusal(403, &step_up));
        // Not a member of the node's organization, or a closed (family) vault:
        // there are simply no shared values for this caller.
        assert!(!is_caller_refusal(403, &coded("not_an_org_member")));
        assert!(!is_caller_refusal(
            403,
            &json!({ "error": "not a member of this org" })
        ));
        assert!(!is_caller_refusal(401, &Value::Null));
        // An outage is never a caller refusal; the export goes on and warns.
        assert!(!is_caller_refusal(503, &coded("org_ip_not_allowed")));
        assert!(!is_caller_refusal(
            503,
            &coded("user_jwt_lookup_unavailable")
        ));
        assert_eq!(
            format!("{SHARED_REFUSED_PREFIX}org_ip_not_allowed"),
            "vault_shared_refused: org_ip_not_allowed"
        );
    }
}
