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

mod audit_sys;
mod boundaries;
mod coords;
mod folders;
mod policies;
mod principal;
#[cfg(test)]
mod routes_tests;
mod scan_route;
#[cfg(test)]
mod tests;
mod transfer;
#[cfg(test)]
mod transfer_test;
mod value_actions;
mod values;
mod wire;

pub(crate) use audit_sys::*;
use boundaries::*;
pub(crate) use coords::*;
pub(crate) use folders::*;
pub(crate) use policies::*;
pub(crate) use principal::*;
pub(crate) use scan_route::*;
pub(crate) use transfer::*;
pub(crate) use value_actions::*;
pub(crate) use values::*;
pub(crate) use wire::*;
