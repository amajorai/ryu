//! Request-parameter constraints on `write` rules.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::super::policy::{wildcard_matches, Capability, Policy, PolicyRule};
use super::*;

// ── Parameter constraints ─────────────────────────────────────────────────

/// Parameter-value constraints: parameter name (or `*`) → allowed value globs.
pub type ParameterMap = BTreeMap<String, Vec<String>>;

pub(super) fn validate_parameter_map(map: &ParameterMap, label: &str) -> Result<()> {
    if map.len() > MAX_PARAMETERS {
        bail!("{label} lists more than {MAX_PARAMETERS} parameters");
    }
    for (name, values) in map {
        if name.is_empty() || name.len() > MAX_PARAMETER_TEXT_LEN {
            bail!("{label} has an empty or too long parameter name");
        }
        if values.len() > MAX_PARAMETER_VALUES {
            bail!("{label}.{name} lists more than {MAX_PARAMETER_VALUES} values");
        }
        for value in values {
            if value.len() > MAX_PARAMETER_TEXT_LEN {
                bail!("{label}.{name} has a value that is too long");
            }
            validate_template(value).with_context(|| format!("{label}.{name}"))?;
        }
    }
    Ok(())
}

/// Validate a rule's extension fields at policy write time.
pub fn validate_rule(rule: &PolicyRule) -> Result<()> {
    validate_template(&rule.path).context("rule path")?;
    let has_parameters = rule.allowed_parameters.is_some()
        || rule.denied_parameters.is_some()
        || !rule.required_parameters.is_empty();
    if has_parameters {
        if rule.deny {
            bail!(
                "rule `{}`: parameter constraints cannot be set on a deny rule",
                rule.path
            );
        }
        if !rule.capabilities.contains(&Capability::Write) {
            bail!(
                "rule `{}`: parameter constraints need the `write` capability",
                rule.path
            );
        }
    }
    if let Some(map) = &rule.allowed_parameters {
        validate_parameter_map(map, "allowedParameters")?;
    }
    if let Some(map) = &rule.denied_parameters {
        validate_parameter_map(map, "deniedParameters")?;
    }
    if rule.required_parameters.len() > MAX_PARAMETERS {
        bail!("requiredParameters lists more than {MAX_PARAMETERS} parameters");
    }
    if rule
        .required_parameters
        .iter()
        .any(|name| name.is_empty() || name.len() > MAX_PARAMETER_TEXT_LEN || name == "*")
    {
        bail!("requiredParameters has an empty, too long, or wildcard name");
    }
    if let Some(group) = &rule.control_group {
        if rule.deny {
            bail!(
                "rule `{}`: a control group cannot be set on a deny rule",
                rule.path
            );
        }
        if !rule.capabilities.contains(&Capability::Read) {
            bail!(
                "rule `{}`: a control group needs the `read` capability",
                rule.path
            );
        }
        group.validate()?;
    }
    Ok(())
}

pub(super) fn parameter_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

pub(super) fn value_matches(
    globs: &[String],
    value: &str,
    context: &TemplateContext,
    deny: bool,
) -> bool {
    if globs.is_empty() {
        return true;
    }
    globs.iter().any(|glob| match expand(glob, context) {
        Expansion::Concrete(patterns) => patterns
            .iter()
            .any(|pattern| wildcard_matches(pattern, value)),
        Expansion::Unresolved(widened) => deny && wildcard_matches(&widened, value),
    })
}

pub(super) fn lookup<'m>(map: &'m ParameterMap, name: &str) -> Option<&'m Vec<String>> {
    map.get(name).or_else(|| map.get("*"))
}

/// Whether any allow rule matching `path` that grants `capability` carries
/// parameter constraints.
pub fn has_parameter_constraints<'a>(
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
    capability: Capability,
    context: &TemplateContext,
) -> bool {
    policies.into_iter().any(|policy| {
        policy.rules.iter().any(|rule| {
            !rule.deny
                && rule.capabilities.contains(&capability)
                && (rule.allowed_parameters.is_some()
                    || rule.denied_parameters.is_some()
                    || !rule.required_parameters.is_empty())
                && rule_matches(rule, path, context)
        })
    })
}

/// Check request `parameters` against every rule matching `path` that grants
/// `capability`. Returns the first violation as a message.
pub fn check_parameters<'a>(
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
    capability: Capability,
    context: &TemplateContext,
    parameters: &BTreeMap<String, Value>,
) -> std::result::Result<(), String> {
    let mut allowed: Vec<&ParameterMap> = Vec::new();
    for policy in policies {
        for rule in &policy.rules {
            if rule.deny
                || !rule.capabilities.contains(&capability)
                || !rule_matches(rule, path, context)
            {
                continue;
            }
            for required in &rule.required_parameters {
                if !parameters.contains_key(required) {
                    return Err(format!(
                        "policy `{}` requires parameter `{required}`",
                        policy.name
                    ));
                }
            }
            if let Some(denied) = &rule.denied_parameters {
                for (name, value) in parameters {
                    if let Some(globs) = lookup(denied, name) {
                        if value_matches(globs, &parameter_text(value), context, true) {
                            return Err(format!(
                                "policy `{}` denies parameter `{name}`{}",
                                policy.name,
                                if globs.is_empty() {
                                    ""
                                } else {
                                    " with this value"
                                }
                            ));
                        }
                    }
                }
            }
            if let Some(map) = &rule.allowed_parameters {
                allowed.push(map);
            }
        }
    }
    if allowed.is_empty() {
        return Ok(());
    }
    for (name, value) in parameters {
        let text = parameter_text(value);
        let permitted = allowed.iter().any(|map| {
            lookup(map, name).is_some_and(|globs| value_matches(globs, &text, context, false))
        });
        if !permitted {
            return Err(format!("parameter `{name}` is not allowed by policy"));
        }
    }
    Ok(())
}
