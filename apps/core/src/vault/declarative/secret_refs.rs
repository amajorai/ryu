//! Provider credentials as references.
//!
//! Dynamic and static roles need a provider credential (an admin connection
//! URL, an access key, a signing secret, an admin API key). The init file
//! never holds it: the role's `provider` object omits those fields, and
//! `secretRefs` names where each one comes from, `env:NAME` or
//! `file:/absolute/path`. References are resolved only when the item is
//! applied, and errors name the field and the reference, never the value.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;

use crate::vault::audit_devices::validate_secret_ref;

/// Largest credential read from a `file:` reference.
const MAX_REF_BYTES: u64 = 64 * 1024;
/// Stand-in used to check a provider object's shape before references are
/// resolved.
const PLACEHOLDER: &str = "declared-secret-reference";

/// Which provider family a role belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Family {
    Dynamic,
    Static,
}

/// The credential fields of a provider kind; `None` for an unknown kind.
fn secret_fields(family: Family, kind: &str) -> Option<&'static [&'static str]> {
    let fields: &'static [&'static str] = match (family, kind) {
        (_, "postgres" | "redis" | "valkey") => &["connectionUrl"],
        (_, "webhook") => &["signingSecret"],
        (Family::Dynamic, "aws-sts") | (Family::Static, "aws-iam") => {
            &["accessKeyId", "secretAccessKey"]
        }
        (Family::Dynamic, "random") => &[],
        (Family::Static, "openai" | "anthropic") => &["adminApiKey"],
        _ => return None,
    };
    Some(fields)
}

/// Fields that are one-time operator inputs, never part of a declaration.
const UNDECLARABLE: &[&str] = &["replacementApiKey"];

/// Check a provider object and its references; returns the provider kind.
pub(super) fn check(
    family: Family,
    provider: &Value,
    refs: &BTreeMap<String, String>,
) -> Result<String> {
    let object = provider
        .as_object()
        .ok_or_else(|| anyhow!("provider must be an object"))?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("provider.kind is required"))?;
    let fields = secret_fields(family, kind)
        .ok_or_else(|| anyhow!("provider kind `{kind}` is not supported"))?;
    for field in UNDECLARABLE {
        if object.contains_key(*field) || refs.contains_key(*field) {
            bail!("provider.{field} is staged through the API, not declared");
        }
    }
    for field in fields {
        if object.contains_key(*field) {
            bail!(
                "provider.{field} is a credential; inline secrets are not accepted, \
                 set secretRefs.{field} to env:NAME or file:/path"
            );
        }
        if !refs.contains_key(*field) {
            bail!("secretRefs.{field} is required for provider kind `{kind}`");
        }
    }
    for (field, reference) in refs {
        if !fields.contains(&field.as_str()) {
            bail!("secretRefs.{field} is not a credential of provider kind `{kind}`");
        }
        validate_secret_ref(reference).with_context(|| format!("secretRefs.{field}"))?;
    }
    Ok(kind.to_owned())
}

/// The provider object with placeholders for its credentials, to check its
/// shape at parse time.
pub(super) fn with_placeholders(provider: &Value, refs: &BTreeMap<String, String>) -> Value {
    let mut filled = provider.clone();
    if let Some(object) = filled.as_object_mut() {
        for field in refs.keys() {
            object.insert(field.clone(), Value::String(PLACEHOLDER.to_owned()));
        }
    }
    filled
}

fn resolve_one(field: &str, reference: &str) -> Result<String> {
    validate_secret_ref(reference).with_context(|| format!("secretRefs.{field}"))?;
    let value = if let Some(name) = reference.strip_prefix("env:") {
        std::env::var(name).map_err(|_| anyhow!("secretRefs.{field}: env var {name} is not set"))?
    } else {
        let path = reference.trim_start_matches("file:");
        let size = std::fs::metadata(path)
            .map_err(|_| anyhow!("secretRefs.{field}: cannot read {path}"))?
            .len();
        if size > MAX_REF_BYTES {
            bail!("secretRefs.{field}: {path} exceeds {MAX_REF_BYTES} bytes");
        }
        std::fs::read_to_string(path)
            .map_err(|_| anyhow!("secretRefs.{field}: cannot read {path}"))?
    };
    let value = value.trim().to_owned();
    if value.is_empty() {
        bail!("secretRefs.{field}: {reference} is empty");
    }
    Ok(value)
}

/// The provider object with every reference resolved.
pub(super) fn resolve(provider: &Value, refs: &BTreeMap<String, String>) -> Result<Value> {
    let mut filled = provider.clone();
    let object = filled
        .as_object_mut()
        .ok_or_else(|| anyhow!("provider must be an object"))?;
    for (field, reference) in refs {
        object.insert(field.clone(), Value::String(resolve_one(field, reference)?));
    }
    Ok(filled)
}

/// Deserialize a resolved provider object. Serde's messages can quote a
/// field's value, so they are replaced: the shape was already checked with
/// placeholders, and only a resolved credential can fail here.
pub(super) fn into_typed<T: serde::de::DeserializeOwned>(resolved: Value) -> Result<T> {
    serde_json::from_value(resolved)
        .map_err(|_| anyhow!("a resolved credential does not fit the provider configuration"))
}
