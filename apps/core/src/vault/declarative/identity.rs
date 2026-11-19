//! Token roles, quotas, and machine identities.
//!
//! A declared machine identity never carries or issues credentials: AppRole
//! secret ids and tokens are still issued through the API, so the file stays
//! free of secrets. An identity's auth method cannot be changed in place
//! (recreating it would revoke every credential it issued), so auth drift is
//! only ever reported. A declared `disabled: true` is still applied on
//! `reconcile`: cutting an identity off never needs its auth method to match.
//! Identities are matched by name only, so a stale file can disable a
//! same-named identity; it can never enable one across auth drift.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use super::{plan, ApplyReport, InitSpec, Plan};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::dynamic::target_guard::RoleWriter;
use crate::vault::machine::{
    AuthMethod, MachineIdentity, DEFAULT_TOKEN_TTL_SECS, MAX_TOKEN_TTL_SECS,
};
use crate::vault::quotas::{QuotaRule, DEFAULT_LOGIN_QUOTA};
use crate::vault::tokens::{TokenConfig, TokenRole};

/// A declared quota.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredQuota {
    pub name: String,
    #[serde(flatten)]
    pub rule: QuotaRule,
}

impl DeclaredQuota {
    pub(super) fn normalize(&mut self) -> Result<()> {
        if self.name == DEFAULT_LOGIN_QUOTA {
            bail!("quota `{DEFAULT_LOGIN_QUOTA}` is built in; configure it with RYU_VAULT_LOGIN_RATE_PER_MIN");
        }
        self.rule = self.rule.clone().normalize()?;
        Ok(())
    }
}

/// A declared machine identity (no secret ids or tokens).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredMachine {
    pub name: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub policies: Vec<String>,
    #[serde(default)]
    pub token_ttl_secs: Option<i64>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub token_config: TokenConfig,
}

impl DeclaredMachine {
    pub(super) fn normalize(&mut self) -> Result<()> {
        if let AuthMethod::AppRole { role_id } = &self.auth {
            if !role_id.is_empty() {
                bail!(
                    "machine `{}`: roleId is generated; leave it out of the init file",
                    self.name
                );
            }
        }
        self.token_config = self.token_config.clone().normalize()?;
        Ok(())
    }

    fn ttl(&self) -> i64 {
        self.token_ttl_secs
            .unwrap_or(DEFAULT_TOKEN_TTL_SECS)
            .clamp(60, MAX_TOKEN_TTL_SECS)
    }

    fn same_settings(&self, current: &MachineIdentity) -> bool {
        current.policies == self.policies
            && current.token_ttl_secs == self.ttl()
            && current.disabled == self.disabled
            && current.token_config == self.token_config
    }
}

/// Whether two auth methods are the same; an AppRole's generated role id is
/// not part of the declaration.
fn same_auth(current: &AuthMethod, declared: &AuthMethod) -> bool {
    match (current, declared) {
        (AuthMethod::AppRole { .. }, AuthMethod::AppRole { .. }) => true,
        _ => current == declared,
    }
}

async fn create_machine(
    store: &PluginSecretStore,
    declared: &DeclaredMachine,
    actor: &AuditActor,
) -> Result<()> {
    let created = store
        .machine_create_as(
            &declared.name,
            declared.auth.clone(),
            declared.policies.clone(),
            Some(declared.ttl()),
            RoleWriter::Manager,
            actor,
        )
        .await?;
    if declared.token_config != TokenConfig::default() {
        store
            .machine_set_token_config(&created.id, declared.token_config.clone(), actor)
            .await?;
    }
    if declared.disabled {
        store
            .machine_update(&created.id, None, None, Some(true), actor)
            .await?;
    }
    Ok(())
}

async fn update_machine(
    store: &PluginSecretStore,
    current: &MachineIdentity,
    declared: &DeclaredMachine,
    actor: &AuditActor,
) -> Result<()> {
    store
        .machine_update(
            &current.id,
            Some(declared.policies.clone()),
            Some(declared.ttl()),
            Some(declared.disabled),
            actor,
        )
        .await?;
    if current.token_config != declared.token_config {
        store
            .machine_set_token_config(&current.id, declared.token_config.clone(), actor)
            .await?;
    }
    Ok(())
}

pub(super) async fn apply(
    store: &PluginSecretStore,
    spec: &InitSpec,
    actor: &AuditActor,
    report: &mut ApplyReport,
) -> Result<()> {
    let roles: Vec<TokenRole> = store
        .token_role_list()
        .await?
        .into_iter()
        .map(|role| TokenRole {
            created_at: 0,
            updated_at: 0,
            ..role
        })
        .collect();
    for declared in &spec.token_roles {
        let label = format!("tokenRole:{}", declared.name);
        let existing = roles.iter().find(|role| role.name == declared.name);
        if report.decide(label.clone(), plan(declared, existing), spec.reconcile) {
            if let Err(error) = store.token_role_put(declared.clone(), actor).await {
                report.fail(&label, &error);
            }
        }
    }

    let quotas = store.quota_list().await?;
    for declared in &spec.quotas {
        let label = format!("quota:{}", declared.name);
        let existing = quotas
            .iter()
            .find(|quota| !quota.builtin && quota.name == declared.name)
            .map(|quota| &quota.rule);
        if report.decide(
            label.clone(),
            plan(&declared.rule, existing),
            spec.reconcile,
        ) {
            if let Err(error) = store
                .quota_put(&declared.name, declared.rule.clone(), actor)
                .await
            {
                report.fail(&label, &error);
            }
        }
    }

    let machines = store.machine_list().await?;
    for declared in &spec.machines {
        let label = format!("machine:{}", declared.name);
        let Some(current) = machines.iter().find(|m| m.name == declared.name) else {
            report.created.push(label.clone());
            if let Err(error) = create_machine(store, declared, actor).await {
                report.fail(&label, &error);
            }
            continue;
        };
        if declared.disabled && current.disabled {
            retry_cut_off(store, current, spec.reconcile, actor, report).await;
        }
        if !same_auth(&current.auth, &declared.auth) {
            report.drifted.push(label.clone());
            // Only the disable is applied; enabling, or any other setting,
            // would act on an identity the file no longer describes.
            if spec.reconcile && declared.disabled && !current.disabled {
                report.updated.push(label.clone());
                if let Err(error) = store
                    .machine_update(&current.id, None, None, Some(true), actor)
                    .await
                {
                    report.fail(&label, &error);
                }
            }
            continue;
        }
        let plan = if declared.same_settings(current) {
            Plan::Same
        } else {
            Plan::Drift
        };
        if report.decide(label.clone(), plan, spec.reconcile) {
            if let Err(error) = update_machine(store, current, declared, actor).await {
                report.fail(&label, &error);
            }
        }
    }
    Ok(())
}

/// A declared-disabled identity that is disabled but still has live leases:
/// an earlier disable failed closed on a lease its provider refused, and
/// `disabled` was committed, so nothing else differs. On `reconcile` the
/// revoke tree runs again (`machine:<name>:leases` in `updated`, or in
/// `errors` naming the leases still live); without it the leases are
/// reported as drift.
async fn retry_cut_off(
    store: &PluginSecretStore,
    current: &MachineIdentity,
    reconcile: bool,
    actor: &AuditActor,
    report: &mut ApplyReport,
) {
    let label = format!("machine:{}:leases", current.name);
    let live = match store.machine_live_leases(&current.id).await {
        Ok(live) => live,
        Err(error) => return report.errors.push(format!("{label}: {error:#}")),
    };
    if live.is_empty() {
        return;
    }
    if !reconcile {
        report.drifted.push(label);
        return;
    }
    report.updated.push(label.clone());
    match store.machine_revoke_tokens(&current.id, actor).await {
        Ok(revocation) if revocation.leases_left.is_empty() => {}
        Ok(revocation) => report.fail(
            &label,
            &anyhow::anyhow!(
                "disabled, but {} lease(s) are still live: {}",
                revocation.leases_left.len(),
                revocation.leases_left.join(", ")
            ),
        ),
        Err(error) => report.fail(&label, &error),
    }
}
