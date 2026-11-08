//! Unknown-field checks for the init document.
//!
//! Several nested types are shared with the API, which tolerates unknown keys,
//! so the init file checks them here: a typo (or a stray value) must fail
//! loudly instead of being silently ignored.

use anyhow::{bail, Result};
use serde_json::Value;

/// Keys each item of a section may carry, for sections whose types are shared
/// with the API.
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
    (
        "tokenRoles",
        &[
            "name",
            "allowedPolicies",
            "disallowedPolicies",
            "orphan",
            "ttlSecs",
            "maxTtlSecs",
            "explicitMaxTtlSecs",
            "periodSecs",
            "numUses",
            "boundCidrs",
            "renewable",
        ],
    ),
    (
        "quotas",
        &[
            "name",
            "kind",
            "path",
            "rate",
            "intervalSecs",
            "blockIntervalSecs",
            "role",
            "maxLeases",
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

fn reject_unknown_keys(value: &Value, what: &str, allowed: &[&str]) -> Result<()> {
    if let Some(map) = value.as_object() {
        if let Some(unknown) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
            bail!("{what} has unknown field `{unknown}`");
        }
    }
    Ok(())
}

fn items<'a>(value: Option<&'a Value>) -> &'a [Value] {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn check_policy_rules(policy: &Value, index: usize) -> Result<()> {
    for (rule_index, rule) in items(policy.get("rules")).iter().enumerate() {
        let rule_path = format!("policies[{index}].rules[{rule_index}]");
        reject_unknown_keys(rule, &rule_path, RULE_KEYS)?;
        if let Some(group) = rule.get("controlGroup") {
            let group_path = format!("{rule_path}.controlGroup");
            reject_unknown_keys(group, &group_path, CONTROL_GROUP_KEYS)?;
            for (factor_index, factor) in items(group.get("factors")).iter().enumerate() {
                reject_unknown_keys(
                    factor,
                    &format!("{group_path}.factors[{factor_index}]"),
                    CONTROL_GROUP_FACTOR_KEYS,
                )?;
            }
        }
    }
    Ok(())
}

/// Reject unknown fields in every item of the sections listed in
/// [`ITEM_KEYS`].
pub(super) fn check_nested_fields(document: &Value) -> Result<()> {
    for (section, allowed) in ITEM_KEYS {
        for (index, item) in items(document.get(*section)).iter().enumerate() {
            reject_unknown_keys(item, &format!("{section}[{index}]"), allowed)?;
            if *section == "policies" {
                check_policy_rules(item, index)?;
            }
        }
    }
    Ok(())
}

/// Whether a value carries nothing (so a key that serialization omits for
/// being empty is not mistaken for an unknown one).
fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::String(text) => text.is_empty(),
        Value::Array(list) => list.is_empty(),
        Value::Object(map) => map.is_empty(),
        Value::Number(_) => false,
    }
}

/// Reject keys of `input` that do not survive a round trip through its typed
/// form (`output` is the typed value serialized again). Serde ignores unknown
/// keys of the shared API types, so a key missing from `output` was ignored.
pub(super) fn reject_unserialized_keys(input: &Value, output: &Value, what: &str) -> Result<()> {
    match (input, output) {
        (Value::Object(given), Value::Object(kept)) => {
            for (key, value) in given {
                match kept.get(key) {
                    Some(kept_value) => {
                        reject_unserialized_keys(value, kept_value, &format!("{what}.{key}"))?;
                    }
                    None if is_empty(value) => {}
                    None => bail!("{what} has unknown field `{key}`"),
                }
            }
            Ok(())
        }
        (Value::Array(given), Value::Array(kept)) if given.len() == kept.len() => {
            for (index, (value, kept_value)) in given.iter().zip(kept).enumerate() {
                reject_unserialized_keys(value, kept_value, &format!("{what}[{index}]"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Deserialize `value` as `T` and reject keys `T` would ignore.
pub(super) fn typed<T>(value: &Value, what: &str) -> Result<T>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let parsed: T = serde_json::from_value(value.clone())
        .map_err(|error| anyhow::anyhow!("{what} is invalid: {error}"))?;
    reject_unserialized_keys(value, &serde_json::to_value(&parsed)?, what)?;
    Ok(parsed)
}
