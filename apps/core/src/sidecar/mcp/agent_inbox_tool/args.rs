//! Tool-argument parsing for the `agent_inbox.*` tools.

use super::*;

pub(super) fn optional_string(arguments: &Value, key: &str) -> Result<Option<String>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.trim().to_owned())),
        Some(_) => Err(anyhow!("argument '{key}' must be a string")),
    }
}

pub(super) fn required_string(arguments: &Value, key: &str) -> Result<String> {
    optional_string(arguments, key)?
        .ok_or_else(|| anyhow!("missing required string argument '{key}'"))
}

/// A body field: kept verbatim (a subject or body may be any text), but it
/// must be present and a string.
pub(super) fn required_text(arguments: &Value, key: &str) -> Result<String> {
    match arguments.get(key) {
        Some(Value::String(value)) => Ok(value.clone()),
        None | Some(Value::Null) => Err(anyhow!("missing required string argument '{key}'")),
        Some(_) => Err(anyhow!("argument '{key}' must be a string")),
    }
}

pub(super) fn optional_bool(arguments: &Value, key: &str) -> Result<Option<bool>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(anyhow!("argument '{key}' must be a boolean")),
    }
}

pub(super) fn optional_bounded(arguments: &Value, key: &str, max: u64) -> Result<Option<u64>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match value.as_u64() {
            Some(number) if (1..=max).contains(&number) => Ok(Some(number)),
            _ => Err(anyhow!(
                "argument '{key}' must be an integer from 1 to {max}"
            )),
        },
    }
}

pub(super) fn address_list(
    arguments: &Value,
    key: &str,
    required: bool,
) -> Result<Option<Vec<String>>> {
    let items = match arguments.get(key) {
        None | Some(Value::Null) if required => {
            return Err(anyhow!("missing required argument '{key}'"))
        }
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(anyhow!("argument '{key}' must be an array of addresses")),
    };
    let addresses = items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|address| !address.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("argument '{key}' must contain only non-empty addresses"))
        })
        .collect::<Result<Vec<_>>>()?;
    if required && addresses.is_empty() {
        return Err(anyhow!("argument '{key}' needs at least one address"));
    }
    Ok(Some(addresses))
}

/// The local part to ask the service for, folded exactly as it folds it: the
/// explicit `local_part`, else the slug of `base_name` (the display name or
/// the agent's name). `None` when neither is known here, so the service
/// derives it from the agent id. The inner `Err` is an unusable name.
pub(super) fn requested_local_part(
    arguments: &Value,
    base_name: Option<&str>,
) -> Result<std::result::Result<Option<String>, AliasInputError>> {
    let explicit = match arguments.get("local_part") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => return Err(anyhow!("argument 'local_part' must be a string")),
    };
    let blank = explicit.is_none_or(|value| value.trim().is_empty());
    if blank && base_name.is_none() {
        return Ok(Ok(None));
    }
    Ok(normalize_alias_request(explicit, base_name.unwrap_or_default()).map(Some))
}

pub(super) fn alias_invalid(error: AliasInputError) -> Value {
    let message = match error {
        AliasInputError::Empty => {
            "That name has no letters or digits to make an address from. Choose a different name."
        }
        AliasInputError::TooLong => {
            "Email names are at most 32 letters, digits, or dashes. Choose a shorter name."
        }
    };
    LocalRefusal::new(400, "alias_invalid", message).into_value()
}
