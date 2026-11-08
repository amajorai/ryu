//! Broker services.
//!
//! A service names its credentials as references (`secret:NAME`, password
//! manager refs), never values. A password-manager reference without an
//! account is qualified with the account it resolves to, as the API does, so
//! a re-apply compares like with like.

use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use serde_json::json;

use super::{plan, ApplyReport, InitSpec};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::broker::services::{self, ServiceInput};
use crate::vault::broker::substitute;
use crate::vault::password_managers::PmRef;

async fn qualified(store: &PluginSecretStore, declared: &ServiceInput) -> Result<ServiceInput> {
    let mut service = declared.clone();
    let mut replacements = BTreeMap::new();
    for reference in declared.refs() {
        let Some(text) = substitute::pm_ref_text(&reference) else {
            continue;
        };
        let parsed =
            PmRef::parse(text).ok_or_else(|| anyhow!("invalid reference `{reference}`"))?;
        if parsed.account.is_some() {
            continue;
        }
        let account = store.pm_account_for_ref(&parsed).await?;
        let prefix = &reference[..reference.len() - text.len()];
        replacements.insert(
            reference.clone(),
            format!("{prefix}{}", parsed.qualified(&account.name)),
        );
    }
    if !replacements.is_empty() {
        service.replace_refs(&replacements);
    }
    Ok(service)
}

async fn write(
    store: &PluginSecretStore,
    service: ServiceInput,
    exists: bool,
    actor: &AuditActor,
) -> Result<()> {
    let (stored, action) = {
        let conn = store.conn.lock().await;
        if exists {
            (services::update(&conn, service)?, "broker.service.update")
        } else {
            (services::insert(&conn, service)?, "broker.service.create")
        }
    };
    store
        .audit(&AuditEntry::new(actor, action, "ok").details(json!({
            "service": stored.name(), "host": stored.input.host, "refs": stored.refs(),
        })))
        .await;
    Ok(())
}

pub(super) async fn apply(
    store: &PluginSecretStore,
    spec: &InitSpec,
    actor: &AuditActor,
    report: &mut ApplyReport,
) -> Result<()> {
    if spec.broker_services.is_empty() {
        return Ok(());
    }
    let existing = {
        let conn = store.conn.lock().await;
        services::list(&conn, None)?
    };
    for declared in &spec.broker_services {
        let label = format!("brokerService:{}", declared.name);
        let service = match qualified(store, declared).await {
            Ok(service) => service,
            Err(error) => {
                report.fail(&label, &error);
                continue;
            }
        };
        let current = existing
            .iter()
            .find(|stored| stored.name() == declared.name)
            .map(|stored| &stored.input);
        let exists = current.is_some();
        if report.decide(label.clone(), plan(&service, current), spec.reconcile) {
            if let Err(error) = write(store, service, exists, actor).await {
                report.fail(&label, &error);
            }
        }
    }
    Ok(())
}
