//! Parsing and validating the init document.

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::fields::{check_nested_fields, typed};
use super::InitSpec;
use crate::vault::broker::services::ServiceInput;
use crate::vault::machine::AuthMethod;
use crate::vault::tokens::TokenConfig;
use crate::vault::{audit_devices, policy};

fn section<'a>(document: &'a Value, name: &str) -> &'a [Value] {
    document
        .get(name)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// Round-trip checks for nested types that serde would otherwise accept with
/// unknown keys.
fn check_typed_sections(document: &Value) -> Result<()> {
    for (index, machine) in section(document, "machines").iter().enumerate() {
        if let Some(auth) = machine.get("auth") {
            typed::<AuthMethod>(auth, &format!("machines[{index}].auth"))?;
        }
        if let Some(token_config) = machine.get("tokenConfig") {
            typed::<TokenConfig>(token_config, &format!("machines[{index}].tokenConfig"))?;
        }
    }
    for (index, service) in section(document, "brokerServices").iter().enumerate() {
        typed::<ServiceInput>(service, &format!("brokerServices[{index}]"))?;
    }
    Ok(())
}

/// Parse and validate an init document.
pub fn parse(text: &str) -> Result<InitSpec> {
    let document: Value = serde_json::from_str(text).context("parsing the vault init file")?;
    check_nested_fields(&document).context("parsing the vault init file")?;
    check_typed_sections(&document).context("parsing the vault init file")?;
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
    for role in &mut spec.token_roles {
        role.created_at = 0;
        role.updated_at = 0;
        role.token = role
            .token
            .clone()
            .normalize()
            .with_context(|| format!("token role `{}` is invalid", role.name))?;
    }
    for quota in &mut spec.quotas {
        quota.normalize()?;
    }
    for machine in &mut spec.machines {
        machine.normalize()?;
    }
    for folder in &mut spec.folders {
        folder.normalize()?;
    }
    for import in &mut spec.imports {
        import.normalize()?;
    }
    for role in &spec.dynamic_roles {
        role.check()
            .with_context(|| format!("dynamic role `{}` is invalid", role.name))?;
    }
    for role in &mut spec.static_roles {
        role.check()
            .with_context(|| format!("static role `{}` is invalid", role.name))?;
    }
    let mut services = Vec::with_capacity(spec.broker_services.len());
    for service in spec.broker_services.drain(..) {
        let name = service.name.clone();
        services.push(
            service
                .normalize()
                .with_context(|| format!("broker service `{name}` is invalid"))?,
        );
    }
    spec.broker_services = services;
    Ok(spec)
}
