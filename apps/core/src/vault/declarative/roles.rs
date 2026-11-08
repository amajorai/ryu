//! Dynamic and static roles.
//!
//! Provider credentials come from `secretRefs` (see [`super::secret_refs`]).
//! Drift compares the whole sealed provider configuration with the declared
//! one after its references are resolved, so a credential rotated at its
//! source shows up as drift; labels and errors never carry values. A new
//! static role is due at once, so the scheduler performs its first rotation.

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::fields::typed;
use super::secret_refs::{self, Family};
use super::{ApplyReport, InitSpec, Plan};
use crate::plugin_secrets::{PluginSecretStore, SecretCoords, SecretScope};
use crate::vault::audit::AuditActor;
use crate::vault::dynamic::static_roles::{
    StaticProvider, StaticRoleInput, MAX_ROTATION_SECS, MIN_ROTATION_SECS,
};
use crate::vault::dynamic::target_guard::RoleWriter;
use crate::vault::dynamic::{is_valid_role_name, ProviderConfig, DEFAULT_TTL_SECS, MAX_TTL_SECS};

/// A declared dynamic role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredDynamicRole {
    pub name: String,
    /// The provider configuration without its credentials.
    pub provider: Value,
    /// Where each credential comes from (`env:NAME` or `file:/path`).
    #[serde(default)]
    pub secret_refs: BTreeMap<String, String>,
    #[serde(default)]
    pub default_ttl_secs: Option<i64>,
    #[serde(default)]
    pub max_ttl_secs: Option<i64>,
}

impl DeclaredDynamicRole {
    pub(super) fn check(&self) -> Result<()> {
        if !is_valid_role_name(&self.name) {
            bail!("invalid role name");
        }
        secret_refs::check(Family::Dynamic, &self.provider, &self.secret_refs)?;
        typed::<ProviderConfig>(
            &secret_refs::with_placeholders(&self.provider, &self.secret_refs),
            "provider",
        )?;
        Ok(())
    }

    /// The TTLs `dynamic_put_role` stores for this declaration.
    fn ttls(&self) -> (i64, i64) {
        let max = self
            .max_ttl_secs
            .unwrap_or(24 * 3600)
            .clamp(1, MAX_TTL_SECS);
        let default = self
            .default_ttl_secs
            .unwrap_or(DEFAULT_TTL_SECS.min(max))
            .clamp(1, max);
        (default, max)
    }
}

/// Where a static role writes its value (node scope).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredTarget {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    pub name: String,
}

impl DeclaredTarget {
    fn coords(&self) -> Result<SecretCoords> {
        SecretCoords {
            scope: SecretScope::Node,
            scope_id: crate::vault::broker::local_node_id(),
            environment: self
                .environment
                .clone()
                .unwrap_or_else(|| crate::vault::DEFAULT_ENVIRONMENT.to_owned()),
            path: self
                .path
                .clone()
                .unwrap_or_else(|| crate::vault::ROOT_PATH.to_owned()),
            binding: None,
            name: self.name.clone(),
        }
        .normalize()
    }
}

/// A declared static role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredStaticRole {
    pub name: String,
    /// The provider configuration without its credentials.
    pub provider: Value,
    #[serde(default)]
    pub secret_refs: BTreeMap<String, String>,
    pub target: DeclaredTarget,
    pub rotation_period_secs: i64,
    #[serde(default)]
    pub password_length: Option<u16>,
}

impl DeclaredStaticRole {
    pub(super) fn check(&mut self) -> Result<()> {
        if !is_valid_role_name(&self.name) {
            bail!("invalid role name");
        }
        secret_refs::check(Family::Static, &self.provider, &self.secret_refs)?;
        typed::<StaticProvider>(
            &secret_refs::with_placeholders(&self.provider, &self.secret_refs),
            "provider",
        )?;
        if !(MIN_ROTATION_SECS..=MAX_ROTATION_SECS).contains(&self.rotation_period_secs) {
            bail!("rotationPeriodSecs must be {MIN_ROTATION_SECS} to {MAX_ROTATION_SECS}");
        }
        let coords = self.target.coords()?;
        self.target.environment = Some(coords.environment);
        self.target.path = Some(coords.path);
        Ok(())
    }
}

/// Whether the stored dynamic role matches; `None` when there is none.
async fn dynamic_role_matches(
    store: &PluginSecretStore,
    declared: &DeclaredDynamicRole,
    config: &ProviderConfig,
) -> Result<Option<bool>> {
    let conn = store.conn.lock().await;
    let row: Option<(i64, i64, Vec<u8>, Vec<u8>, u32)> = conn
        .query_row(
            "SELECT default_ttl_secs, max_ttl_secs, nonce, ciphertext, key_version
             FROM vault_dynamic_roles WHERE name = ?1",
            params![declared.name],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((default, max, nonce, ciphertext, key_version)) = row else {
        return Ok(None);
    };
    let stored: Value =
        serde_json::from_slice(&store.open_row(key_version, &nonce, &ciphertext)?)?;
    Ok(Some(
        (default, max) == declared.ttls() && stored == serde_json::to_value(config)?,
    ))
}

fn plan_for(found: Option<bool>) -> Plan {
    match found {
        None => Plan::Create,
        Some(true) => Plan::Same,
        Some(false) => Plan::Drift,
    }
}

async fn apply_dynamic(
    store: &PluginSecretStore,
    declared: &DeclaredDynamicRole,
    reconcile: bool,
    actor: &AuditActor,
    report: &mut ApplyReport,
) -> Result<()> {
    let label = format!("dynamicRole:{}", declared.name);
    let config: ProviderConfig =
        match secret_refs::resolve(&declared.provider, &declared.secret_refs)
            .and_then(secret_refs::into_typed)
        {
            Ok(config) => config,
            Err(error) => {
                report.fail(&label, &error);
                return Ok(());
            }
        };
    let found = match dynamic_role_matches(store, declared, &config).await {
        Ok(found) => found,
        Err(error) => {
            report.fail(&label, &error);
            return Ok(());
        }
    };
    if report.decide(label.clone(), plan_for(found), reconcile) {
        let (default, max) = declared.ttls();
        if let Err(error) = store
            .dynamic_put_role_as(
                &declared.name,
                &config,
                (Some(default), Some(max)),
                RoleWriter::Manager,
                actor,
            )
            .await
        {
            report.fail(&label, &error);
        }
    }
    Ok(())
}

async fn apply_static(
    store: &PluginSecretStore,
    declared: &DeclaredStaticRole,
    reconcile: bool,
    actor: &AuditActor,
    report: &mut ApplyReport,
) -> Result<()> {
    let label = format!("staticRole:{}", declared.name);
    let resolved = secret_refs::resolve(&declared.provider, &declared.secret_refs)
        .and_then(secret_refs::into_typed::<StaticProvider>)
        .and_then(|provider| Ok((provider, declared.target.coords()?)));
    let (provider, target) = match resolved {
        Ok(resolved) => resolved,
        Err(error) => {
            report.fail(&label, &error);
            return Ok(());
        }
    };
    let input = StaticRoleInput {
        provider,
        rotation_period_secs: declared.rotation_period_secs,
        password_length: declared.password_length,
    };
    let found = match store
        .static_role_matches(&declared.name, &input, &target)
        .await
    {
        Ok(found) => found,
        Err(error) => {
            report.fail(&label, &error);
            return Ok(());
        }
    };
    if report.decide(label.clone(), plan_for(found), reconcile) {
        if let Err(error) = store
            .static_put_role_as(&declared.name, &input, target, RoleWriter::Manager, actor)
            .await
        {
            report.fail(&label, &error);
        }
    }
    Ok(())
}

pub(super) async fn apply(
    store: &PluginSecretStore,
    spec: &InitSpec,
    actor: &AuditActor,
    report: &mut ApplyReport,
) -> Result<()> {
    for declared in &spec.dynamic_roles {
        apply_dynamic(store, declared, spec.reconcile, actor, report).await?;
    }
    for declared in &spec.static_roles {
        apply_static(store, declared, spec.reconcile, actor, report).await?;
    }
    Ok(())
}
