//! The folder and environment one Vault secret path addresses, and the
//! folder-level and protected-environment authorization shared by the KV v2
//! handlers.

use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;

use super::*;
use crate::plugin_secrets::{
    KvFolder, KvFolderState, PluginSecretStore, SecretCoords, SecretScope, VaultSecretInfo,
};
use crate::server::vault_engines_api::Who;
use crate::vault::policy::{glob_matches, may_match_child, Capability};
use crate::vault::ROOT_PATH;

/// The folder and environment one Vault secret path addresses.
pub(super) struct Target {
    pub(super) environment: String,
    pub(super) folder: String,
    pub(super) node_id: String,
}

impl Target {
    pub(super) fn resolve(
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

    pub(super) fn coords(&self, name: &str) -> Result<SecretCoords, Response> {
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

    pub(super) fn owns(&self, info: &VaultSecretInfo) -> bool {
        info.scope == SecretScope::Node && info.scope_id == self.node_id && info.binding.is_none()
    }

    pub(super) fn kv_folder(&self) -> KvFolder {
        KvFolder {
            scope_id: self.node_id.clone(),
            environment: self.environment.clone(),
            path: self.folder.clone(),
        }
    }

    /// The node's keys directly in this folder (including soft-deleted ones)
    /// and the folder's KV v2 version.
    pub(super) async fn state(&self, store: &PluginSecretStore) -> Result<KvFolderState, Response> {
        store
            .kv_folder_state(&self.kv_folder())
            .await
            .map_err(|error| store_error(&error))
    }

    /// `ENV/folder`, the prefix of every key's policy key.
    pub(super) fn folder_key(&self) -> String {
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
    pub(super) fn require_folder(
        &self,
        who: &Who,
        capabilities: &[Capability],
    ) -> Result<(), Response> {
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
    pub(super) async fn require_unprotected(
        &self,
        who: &Who,
        keys: &[SecretCoords],
    ) -> Result<(), Response> {
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
