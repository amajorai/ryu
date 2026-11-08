//! Declarative vault self-initialization.
//!
//! A fleet node or a headless setup (`RYU_KEYCHAIN=off`) can declare its vault
//! baseline in a JSON file named by `RYU_VAULT_INIT_FILE` instead of scripting
//! imperative API calls. The file declares environments, policies, policy
//! bindings, transit keys, audit devices, token roles, quotas, machine
//! identities, folders, folder imports, dynamic and static roles, and broker
//! services:
//!
//! ```json
//! {
//!   "reconcile": false,
//!   "environments": [{ "slug": "prod", "name": "Production", "protected": true }],
//!   "policies": [{ "name": "ci", "rules": [{ "path": "prod/*", "capabilities": ["use"] }] }],
//!   "bindings": [{ "policy": "ci", "subject": "machine:mi_ci" }],
//!   "transitKeys": [{ "name": "payments", "type": "aes256-gcm96" }],
//!   "auditDevices": [{ "id": "file", "kind": "file", "options": { "path": "/var/log/ryu/vault-audit.jsonl" } }],
//!   "tokenRoles": [{ "name": "deploy", "allowedPolicies": ["ci"], "ttlSecs": 900 }],
//!   "quotas": [{ "name": "agent-rate", "kind": "rate-limit", "path": "agent/", "rate": 120 }],
//!   "machines": [{ "name": "ci", "auth": { "kind": "approle" }, "policies": ["ci"] }],
//!   "folders": [{ "environment": "prod", "path": "/payments" }],
//!   "imports": [{ "environment": "prod", "path": "/payments", "sourceEnvironment": "prod", "sourcePath": "/shared" }],
//!   "dynamicRoles": [{
//!     "name": "pg-ro",
//!     "provider": { "kind": "postgres", "creationStatements": ["CREATE ROLE \"{{name}}\" LOGIN PASSWORD '{{password}}'"] },
//!     "secretRefs": { "connectionUrl": "env:PG_ADMIN_URL" }
//!   }],
//!   "staticRoles": [{
//!     "name": "app-db",
//!     "provider": { "kind": "postgres", "username": "app" },
//!     "secretRefs": { "connectionUrl": "file:/run/secrets/pg-admin-url" },
//!     "target": { "environment": "prod", "name": "APP_DB_PASSWORD" },
//!     "rotationPeriodSecs": 86400
//!   }],
//!   "brokerServices": [{
//!     "name": "stripe", "environment": "prod", "host": "api.stripe.com",
//!     "auth": { "type": "bearer", "token": "secret:STRIPE_KEY" }
//!   }]
//! }
//! ```
//!
//! The file holds no secrets. A provider credential (a dynamic or static
//! role's admin connection URL, access key, signing secret, or admin API key)
//! is given only as an `env:NAME` or `file:/path` reference in `secretRefs`,
//! resolved when the item is applied; a device signing secret is given the
//! same way in `secretRef`. Inline secrets are rejected. Broker services name
//! vault values (`secret:NAME`), never values. Unknown fields are rejected at
//! every level. The example's file device path needs
//! `RYU_VAULT_AUDIT_DIRS=/var/log/ryu`.
//!
//! Applying is idempotent: missing items are created, matching items are left
//! alone, and items that differ are reported as drift and left unchanged
//! unless the file sets `"reconcile": true`. Changes that would lose data or
//! credentials (a transit key's type, a machine identity's auth method) are
//! only ever reported. It runs at startup once the store opens, and again from
//! `POST /api/vault/sys/init/apply`. Every change is audited with the actor
//! `system:bootstrap`.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::audit::{AuditActor, AuditEntry};
use super::audit_devices::AuditDevice;
use super::broker::services::ServiceInput;
use super::policy::Policy;
use super::tokens::TokenRole;
use super::transit::TransitKeyType;
use crate::plugin_secrets::kv::Environment;
use crate::plugin_secrets::PluginSecretStore;

mod base;
mod fields;
mod folders;
mod identity;
#[cfg(test)]
mod module_tests;
mod parse;
#[cfg(test)]
mod platform_tests;
mod roles;
mod secret_refs;
mod services;
#[cfg(test)]
mod tests;

pub use folders::{DeclaredFolder, DeclaredImport};
pub use identity::{DeclaredMachine, DeclaredQuota};
pub use parse::parse;
pub use roles::{DeclaredDynamicRole, DeclaredStaticRole};

/// Env var naming the declarative init file.
pub const ENV_INIT_FILE: &str = "RYU_VAULT_INIT_FILE";
/// Upper bound on the init file size.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// A declared policy binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredBinding {
    pub policy: String,
    pub subject: String,
}

/// A declared transit key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredTransitKey {
    pub name: String,
    #[serde(rename = "type", default = "default_key_type")]
    pub key_type: TransitKeyType,
}

fn default_key_type() -> TransitKeyType {
    TransitKeyType::Aes256Gcm96
}

/// The declarative init document.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitSpec {
    /// Overwrite drifted items instead of only reporting them.
    #[serde(default)]
    pub reconcile: bool,
    #[serde(default)]
    pub environments: Vec<Environment>,
    #[serde(default)]
    pub policies: Vec<Policy>,
    #[serde(default)]
    pub bindings: Vec<DeclaredBinding>,
    #[serde(default)]
    pub transit_keys: Vec<DeclaredTransitKey>,
    #[serde(default)]
    pub audit_devices: Vec<AuditDevice>,
    #[serde(default)]
    pub token_roles: Vec<TokenRole>,
    #[serde(default)]
    pub quotas: Vec<DeclaredQuota>,
    #[serde(default)]
    pub machines: Vec<DeclaredMachine>,
    #[serde(default)]
    pub folders: Vec<DeclaredFolder>,
    #[serde(default)]
    pub imports: Vec<DeclaredImport>,
    #[serde(default)]
    pub dynamic_roles: Vec<DeclaredDynamicRole>,
    #[serde(default)]
    pub static_roles: Vec<DeclaredStaticRole>,
    #[serde(default)]
    pub broker_services: Vec<ServiceInput>,
}

/// What one apply did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// `kind:id` of each created item.
    pub created: Vec<String>,
    /// `kind:id` of each drifted item that `reconcile` overwrote.
    pub updated: Vec<String>,
    /// `kind:id` of each drifted item left unchanged.
    pub drifted: Vec<String>,
    pub unchanged: usize,
    /// Per-item failures; one bad item does not stop the rest.
    pub errors: Vec<String>,
}

/// The configured init file, if any.
pub fn configured_path() -> Option<PathBuf> {
    std::env::var(ENV_INIT_FILE)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Read and parse an init file.
pub fn load(path: &Path) -> Result<InitSpec> {
    let size = std::fs::metadata(path)
        .with_context(|| format!("reading {}", path.display()))?
        .len();
    if size > MAX_FILE_BYTES {
        bail!("the vault init file exceeds {MAX_FILE_BYTES} bytes");
    }
    parse(&std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?)
}

fn actor() -> AuditActor {
    AuditActor::new("system", Some("bootstrap"))
}

/// Outcome of comparing one declared item with the stored one.
enum Plan {
    Create,
    Same,
    Drift,
}

fn plan<T: PartialEq>(declared: &T, existing: Option<&T>) -> Plan {
    match existing {
        None => Plan::Create,
        Some(current) if current == declared => Plan::Same,
        Some(_) => Plan::Drift,
    }
}

impl ApplyReport {
    /// Record a plan for `label`; returns whether the caller should write.
    fn decide(&mut self, label: String, plan: Plan, reconcile: bool) -> bool {
        match plan {
            Plan::Create => {
                self.created.push(label);
                true
            }
            Plan::Same => {
                self.unchanged += 1;
                false
            }
            Plan::Drift if reconcile => {
                self.updated.push(label);
                true
            }
            Plan::Drift => {
                self.drifted.push(label);
                false
            }
        }
    }

    fn fail(&mut self, label: &str, error: &anyhow::Error) {
        // The label was already recorded as created/updated; move it.
        self.created.retain(|item| item != label);
        self.updated.retain(|item| item != label);
        self.errors.push(format!("{label}: {error:#}"));
    }
}

/// Apply `spec` to `store` idempotently.
pub async fn apply(store: &PluginSecretStore, spec: &InitSpec) -> Result<ApplyReport> {
    let mut report = ApplyReport::default();
    let actor = actor();

    base::apply(store, spec, &actor, &mut report).await?;
    identity::apply(store, spec, &actor, &mut report).await?;
    folders::apply(store, spec, &actor, &mut report).await?;
    roles::apply(store, spec, &actor, &mut report).await?;
    services::apply(store, spec, &actor, &mut report).await?;

    let changed = !(report.created.is_empty() && report.updated.is_empty());
    if changed || !report.drifted.is_empty() || !report.errors.is_empty() {
        store
            .audit(
                &AuditEntry::new(
                    &actor,
                    "bootstrap.apply",
                    if report.errors.is_empty() {
                        "ok"
                    } else {
                        "error"
                    },
                )
                .details(json!({
                    "created": report.created.len(),
                    "updated": report.updated.len(),
                    "drifted": report.drifted.len(),
                    "errors": report.errors.len(),
                    "reconcile": spec.reconcile,
                })),
            )
            .await;
    }
    Ok(report)
}

/// Load the configured init file and apply it. `Ok(None)` when no file is
/// configured.
pub async fn apply_configured(store: &PluginSecretStore) -> Result<Option<ApplyReport>> {
    let Some(path) = configured_path() else {
        return Ok(None);
    };
    let spec = load(&path)?;
    apply(store, &spec).await.map(Some)
}

/// Startup hook: apply the configured file and log the outcome. Never fails
/// startup; a broken file is reported and the vault keeps its current state.
pub async fn apply_at_startup(store: &PluginSecretStore) {
    match apply_configured(store).await {
        Ok(None) => {}
        Ok(Some(report)) => {
            if !report.drifted.is_empty() {
                tracing::warn!(
                    drifted = ?report.drifted,
                    "vault init file: drifted items left unchanged (set reconcile: true to overwrite)"
                );
            }
            if !report.errors.is_empty() {
                tracing::warn!(errors = ?report.errors, "vault init file: some items failed");
            }
            tracing::info!(
                created = report.created.len(),
                updated = report.updated.len(),
                unchanged = report.unchanged,
                "vault init file applied"
            );
        }
        Err(error) => tracing::warn!("vault init file not applied: {error:#}"),
    }
}
