//! Declarative vault self-initialization.
//!
//! A fleet node or a headless setup (`RYU_KEYCHAIN=off`) can declare its vault
//! baseline in a JSON file named by `RYU_VAULT_INIT_FILE` instead of scripting
//! imperative API calls. The file declares environments, policies, policy
//! bindings, transit keys, and audit devices:
//!
//! ```json
//! {
//!   "reconcile": false,
//!   "environments": [{ "slug": "prod", "name": "Production", "protected": true }],
//!   "policies": [{ "name": "ci", "rules": [{ "path": "prod/*", "capabilities": ["use"] }] }],
//!   "bindings": [{ "policy": "ci", "subject": "machine:mi_ci" }],
//!   "transitKeys": [{ "name": "payments", "type": "aes256-gcm96" }],
//!   "auditDevices": [{ "id": "file", "kind": "file", "options": { "path": "/var/log/ryu/vault-audit.jsonl" } }]
//! }
//! ```
//!
//! The file holds no secrets. A device signing secret is given only as an
//! `env:NAME` or `file:/path` reference, and inline secrets are rejected.
//! Unknown fields are rejected at every level, including device options. The
//! example's file device path needs `RYU_VAULT_AUDIT_DIRS=/var/log/ryu`.
//!
//! Applying is idempotent: missing items are created, matching items are left
//! alone, and items that differ are reported as drift and left unchanged
//! unless the file sets `"reconcile": true`. It runs at startup once the store
//! opens, and again from `POST /api/vault/sys/init/apply`. Every change is
//! audited with the actor `system:bootstrap`.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::audit::{AuditActor, AuditEntry};
use super::audit_devices::{self, AuditDevice};
use super::policy::{self, Policy};
use super::transit::TransitKeyType;
use crate::plugin_secrets::kv::Environment;
use crate::plugin_secrets::PluginSecretStore;

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

/// Keys each nested item may carry. The nested types are shared with the API,
/// so unknown keys are rejected here rather than with `deny_unknown_fields`.
const ITEM_KEYS: &[(&str, &[&str])] = &[
    (
        "environments",
        &[
            "slug",
            "name",
            "protected",
            "requiredApprovals",
            "position",
            "casRequired",
        ],
    ),
    ("policies", &["name", "description", "rules"]),
    ("bindings", &["policy", "subject"]),
    ("transitKeys", &["name", "type"]),
    (
        "auditDevices",
        &[
            "id",
            "kind",
            "enabled",
            "description",
            "hmacFields",
            "options",
        ],
    ),
];
const RULE_KEYS: &[&str] = &[
    "path",
    "capabilities",
    "deny",
    "allowedParameters",
    "deniedParameters",
    "requiredParameters",
    "controlGroup",
];
const CONTROL_GROUP_KEYS: &[&str] = &["ttlSecs", "factors"];
const CONTROL_GROUP_FACTOR_KEYS: &[&str] = &["name", "approvers", "approvals"];

fn reject_unknown_keys(value: &serde_json::Value, what: &str, allowed: &[&str]) -> Result<()> {
    if let Some(map) = value.as_object() {
        if let Some(unknown) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
            bail!("{what} has unknown field `{unknown}`");
        }
    }
    Ok(())
}

/// Reject unknown fields in every nested item, so a typo (or a stray value)
/// fails loudly instead of being silently ignored.
fn check_nested_fields(document: &serde_json::Value) -> Result<()> {
    for (section, allowed) in ITEM_KEYS {
        let items = document
            .get(*section)
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for (index, item) in items.iter().enumerate() {
            reject_unknown_keys(item, &format!("{section}[{index}]"), allowed)?;
            if *section == "policies" {
                let rules = item
                    .get("rules")
                    .and_then(serde_json::Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                for (rule_index, rule) in rules.iter().enumerate() {
                    let rule_path = format!("policies[{index}].rules[{rule_index}]");
                    reject_unknown_keys(rule, &rule_path, RULE_KEYS)?;
                    if let Some(group) = rule.get("controlGroup") {
                        let group_path = format!("{rule_path}.controlGroup");
                        reject_unknown_keys(group, &group_path, CONTROL_GROUP_KEYS)?;
                        let factors = group
                            .get("factors")
                            .and_then(serde_json::Value::as_array)
                            .map(Vec::as_slice)
                            .unwrap_or_default();
                        for (factor_index, factor) in factors.iter().enumerate() {
                            reject_unknown_keys(
                                factor,
                                &format!("{group_path}.factors[{factor_index}]"),
                                CONTROL_GROUP_FACTOR_KEYS,
                            )?;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// Parse and validate an init document.
pub fn parse(text: &str) -> Result<InitSpec> {
    let document: serde_json::Value =
        serde_json::from_str(text).context("parsing the vault init file")?;
    check_nested_fields(&document).context("parsing the vault init file")?;
    let mut spec: InitSpec =
        serde_json::from_value(document).context("parsing the vault init file")?;
    for policy_def in &spec.policies {
        policy::validate(policy_def)
            .with_context(|| format!("policy `{}` is invalid", policy_def.name))?;
    }
    for binding in &spec.bindings {
        if !policy::is_valid_subject(&binding.subject) {
            bail!("binding subject `{}` is invalid", binding.subject);
        }
    }
    for device in &mut spec.audit_devices {
        device.source = "declarative".to_owned();
        audit_devices::validate(device)
            .with_context(|| format!("audit device `{}` is invalid", device.id))?;
    }
    Ok(spec)
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

    let environments = store.list_environments().await?;
    for declared in &spec.environments {
        let label = format!("environment:{}", declared.slug);
        let existing = environments.iter().find(|env| env.slug == declared.slug);
        if report.decide(label.clone(), plan(declared, existing), spec.reconcile) {
            if let Err(error) = store.put_environment(declared, &actor).await {
                report.fail(&label, &error);
            }
        }
    }

    {
        let conn = store.conn.lock().await;
        let policies = policy::list_policies(&conn)?;
        for declared in &spec.policies {
            let label = format!("policy:{}", declared.name);
            let existing = policies.iter().find(|p| p.name == declared.name);
            if report.decide(label.clone(), plan(declared, existing), spec.reconcile) {
                match policy::put_policy(&conn, declared) {
                    Ok(()) => {
                        store.audit_locked(
                            &conn,
                            &AuditEntry::new(&actor, "policy.put", "ok")
                                .details(json!({ "policy": declared.name })),
                        );
                    }
                    Err(error) => report.fail(&label, &error),
                }
            }
        }

        let bindings = policy::list_bindings(&conn)?;
        for declared in &spec.bindings {
            let label = format!("binding:{}@{}", declared.policy, declared.subject);
            let exists = bindings.iter().any(|binding| {
                binding.policy == declared.policy
                    && binding.subject == declared.subject
                    && binding.expires_at.is_none()
            });
            let plan = if exists { Plan::Same } else { Plan::Create };
            if report.decide(label.clone(), plan, spec.reconcile) {
                match policy::bind(
                    &conn,
                    &declared.policy,
                    &declared.subject,
                    None,
                    Some("bootstrap"),
                ) {
                    Ok(binding) => {
                        store.audit_locked(
                            &conn,
                            &AuditEntry::new(&actor, "policy.bind", "ok").details(json!({
                                "policy": binding.policy, "subject": binding.subject, "id": binding.id,
                            })),
                        );
                    }
                    Err(error) => report.fail(&label, &error),
                }
            }
        }

        let devices = audit_devices::list(&conn)?;
        for declared in &spec.audit_devices {
            let label = format!("auditDevice:{}", declared.id);
            let existing = devices.iter().find(|device| device.id == declared.id);
            if report.decide(label.clone(), plan(declared, existing), spec.reconcile) {
                match audit_devices::put(&conn, declared) {
                    Ok(()) => {
                        store.audit_locked(
                            &conn,
                            &AuditEntry::new(&actor, "audit.device.put", "ok").details(json!({
                                "id": declared.id, "kind": declared.kind, "enabled": declared.enabled,
                            })),
                        );
                    }
                    Err(error) => report.fail(&label, &error),
                }
            }
        }
    }

    let keys = store.transit_list().await?;
    for declared in &spec.transit_keys {
        let label = format!("transitKey:{}", declared.name);
        let existing = keys.iter().find(|key| key.name == declared.name);
        let plan = match existing {
            None => Plan::Create,
            Some(key) if key.key_type == declared.key_type => Plan::Same,
            // A key's type cannot change without losing data; drift is only
            // ever reported, even with `reconcile`.
            Some(_) => {
                report.drifted.push(label);
                continue;
            }
        };
        if report.decide(label.clone(), plan, spec.reconcile) {
            if let Err(error) = store
                .transit_create(&declared.name, declared.key_type, &actor)
                .await
            {
                report.fail(&label, &error);
            }
        }
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::audit::AuditFilter;

    fn spec_text(dir: &Path, reconcile: bool, protected: bool) -> String {
        audit_devices::allow_audit_dir_for_test(dir);
        json!({
            "reconcile": reconcile,
            "environments": [{ "slug": "prod", "name": "Production", "protected": protected }],
            "policies": [{ "name": "ci", "rules": [{ "path": "prod/*", "capabilities": ["use"] }] }],
            "bindings": [{ "policy": "ci", "subject": "machine:mi_ci" }],
            "transitKeys": [{ "name": "payments" }],
            "auditDevices": [{
                "id": "file", "kind": "file",
                "options": { "path": dir.join("audit.jsonl").to_string_lossy() }
            }],
        })
        .to_string()
    }

    #[tokio::test]
    async fn applying_twice_is_idempotent_and_audited_as_bootstrap() {
        let dir = tempfile::tempdir().unwrap();
        let store = PluginSecretStore::in_memory().unwrap();
        let spec = parse(&spec_text(dir.path(), false, true)).unwrap();
        let first = apply(&store, &spec).await.unwrap();
        assert!(first.errors.is_empty(), "{first:?}");
        assert_eq!(first.created.len(), 5, "{first:?}");
        let second = apply(&store, &spec).await.unwrap();
        assert!(
            second.created.is_empty() && second.drifted.is_empty(),
            "{second:?}"
        );
        assert_eq!(second.unchanged, 5);

        let conn = store.conn.lock().await;
        assert_eq!(audit_devices::list(&conn).unwrap()[0].source, "declarative");
        let rows = crate::vault::audit::list(
            &conn,
            &AuditFilter {
                limit: 50,
                action: Some("bootstrap.apply".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].actor.id.as_deref(), Some("bootstrap"));
        drop(conn);
        // The declared file device now receives every audit row.
        let written = std::fs::read_to_string(dir.path().join("audit.jsonl")).unwrap();
        assert!(written.contains("\"action\":\"bootstrap.apply\""));
    }

    #[tokio::test]
    async fn drift_is_reported_unless_reconcile_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let store = PluginSecretStore::in_memory().unwrap();
        apply(&store, &parse(&spec_text(dir.path(), false, true)).unwrap())
            .await
            .unwrap();
        let drifted = apply(
            &store,
            &parse(&spec_text(dir.path(), false, false)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(drifted.drifted, vec!["environment:prod".to_owned()]);
        let prod = |envs: Vec<Environment>| envs.into_iter().find(|e| e.slug == "prod").unwrap();
        assert!(prod(store.list_environments().await.unwrap()).protected);

        let reconciled = apply(&store, &parse(&spec_text(dir.path(), true, false)).unwrap())
            .await
            .unwrap();
        assert_eq!(reconciled.updated, vec!["environment:prod".to_owned()]);
        assert!(!prod(store.list_environments().await.unwrap()).protected);
    }

    fn protected_spec_text(reconcile: bool) -> String {
        json!({
            "reconcile": reconcile,
            "environments": [{ "slug": "prod", "name": "Production", "casRequired": true }],
            "policies": [{ "name": "prod-read", "rules": [
                {
                    "path": "prod/*",
                    "capabilities": ["read", "write"],
                    "allowedParameters": { "*": ["*"] },
                    "deniedParameters": { "owner": ["root"] },
                    "requiredParameters": ["ticket"],
                    "controlGroup": {
                        "ttlSecs": 3600,
                        "factors": [{ "name": "leads", "approvers": ["role:lead"], "approvals": 1 }]
                    }
                }
            ] }],
        })
        .to_string()
    }

    #[tokio::test]
    async fn reconcile_keeps_declared_cas_and_control_groups() {
        let store = PluginSecretStore::in_memory().unwrap();
        let spec = parse(&protected_spec_text(true)).unwrap();
        assert!(spec.environments[0].cas_required);
        let rule = &spec.policies[0].rules[0];
        assert!(rule.control_group.is_some());
        assert!(rule.allowed_parameters.is_some() && rule.denied_parameters.is_some());
        assert_eq!(rule.required_parameters, vec!["ticket".to_owned()]);

        let first = apply(&store, &spec).await.unwrap();
        assert!(first.errors.is_empty(), "{first:?}");
        let second = apply(&store, &spec).await.unwrap();
        assert!(
            second.created.is_empty() && second.updated.is_empty() && second.drifted.is_empty(),
            "{second:?}"
        );
        assert_eq!(second.unchanged, 2);
        let prod = store
            .list_environments()
            .await
            .unwrap()
            .into_iter()
            .find(|env| env.slug == "prod")
            .unwrap();
        assert!(prod.cas_required);
    }

    #[test]
    fn inline_secrets_and_unknown_fields_are_rejected() {
        let inline = json!({
            "auditDevices": [{
                "id": "siem", "kind": "http",
                "options": { "url": "https://siem.example", "secret": "sixteen-chars-long!" }
            }]
        });
        assert!(parse(&inline.to_string()).is_err());
        assert!(parse(r#"{"secrets": [{"name": "X", "value": "y"}]}"#).is_err());
        let referenced = json!({
            "auditDevices": [{
                "id": "siem", "kind": "http",
                "options": { "url": "https://siem.example", "secretRef": "env:SIEM_SIGNING_KEY" }
            }]
        });
        assert!(parse(&referenced.to_string()).is_ok());
        for nested in [
            json!({ "environments": [{ "slug": "prod", "name": "P", "value": "s3cr3t" }] }),
            json!({ "environments": [{ "slug": "prod", "name": "P", "requiredApproval": 2 }] }),
            json!({ "policies": [{ "name": "ci", "rules": [
                { "path": "prod/*", "capabilities": ["use"], "value": "x" }
            ] }] }),
            json!({ "policies": [{ "name": "ci", "rules": [{
                "path": "prod/*", "capabilities": ["read"],
                "controlGroup": { "factors": [{ "name": "a", "approvers": ["role:lead"] }], "x": 1 }
            }] }] }),
            json!({ "policies": [{ "name": "ci", "rules": [{
                "path": "prod/*", "capabilities": ["read"],
                "controlGroup": { "factors": [{ "name": "a", "approvers": ["role:lead"], "x": 1 }] }
            }] }] }),
            json!({ "bindings": [{ "policy": "ci", "subject": "machine:mi_ci", "x": 1 }] }),
            json!({ "transitKeys": [{ "name": "payments", "material": "abc" }] }),
            json!({ "auditDevices": [{
                "id": "siem", "kind": "http",
                "options": { "url": "https://siem.example", "token": "abc" }
            }] }),
            json!({ "auditDevices": [{
                "id": "siem", "kind": "http",
                "options": { "url": "https://user:pass@siem.example" }
            }] }),
        ] {
            assert!(parse(&nested.to_string()).is_err(), "{nested}");
        }
    }
}
