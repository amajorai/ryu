//! Environments, policies, bindings, audit devices, and transit keys.

use anyhow::Result;
use serde_json::json;

use super::{plan, ApplyReport, InitSpec, Plan};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::{audit_devices, policy};

pub(super) async fn apply(
    store: &PluginSecretStore,
    spec: &InitSpec,
    actor: &AuditActor,
    report: &mut ApplyReport,
) -> Result<()> {
    let environments = store.list_environments().await?;
    for declared in &spec.environments {
        let label = format!("environment:{}", declared.slug);
        let existing = environments.iter().find(|env| env.slug == declared.slug);
        if report.decide(label.clone(), plan(declared, existing), spec.reconcile) {
            if let Err(error) = store.put_environment(declared, actor).await {
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
                            &AuditEntry::new(actor, "policy.put", "ok")
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
                            &AuditEntry::new(actor, "policy.bind", "ok").details(json!({
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
                            &AuditEntry::new(actor, "audit.device.put", "ok").details(json!({
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
                .transit_create(&declared.name, declared.key_type, actor)
                .await
            {
                report.fail(&label, &error);
            }
        }
    }
    Ok(())
}
