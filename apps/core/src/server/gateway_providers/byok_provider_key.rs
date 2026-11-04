//! BYOK provider-key vault (Unit U026).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── BYOK provider-key vault (Unit U026) ────────────────────────────────────
//
// `PUT /api/gateway/providers` writes a provider API key (or clears it when
// `api_key` is null) directly to gateway.toml, then restarts the gateway so
// the change takes effect. The key value is never logged.
//
// Supported providers: openai, anthropic, openrouter (local/core are keyless),
// and SDK kinds under [providers.genai.accounts]. Each kind owns its credentials
// and endpoint context independently.

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetProviderBody {
    pub(in crate::server) provider: String,
    pub(in crate::server) api_key: Option<String>,
    pub(in crate::server) account_action: Option<String>,
    pub(in crate::server) account_index: Option<usize>,
    #[serde(rename = "accountId")]
    pub(in crate::server) account_id: Option<String>,
    #[serde(rename = "accountPolicy")]
    pub(in crate::server) account_policy: Option<ryu_gw_credentials::ProviderAccountPolicy>,
    #[serde(rename = "sdkContext")]
    pub(in crate::server) sdk_context: Option<ryu_gw_credentials::SdkEndpointConfig>,
    #[serde(rename = "allowEnvironment")]
    pub(in crate::server) allow_environment: Option<bool>,
    #[serde(rename = "expectedRevision")]
    pub(in crate::server) expected_revision: Option<ryu_gw_credentials::ConfigRevision>,
}

pub(in crate::server) fn gateway_account_keys(
    providers: &toml::map::Map<String, toml::Value>,
    provider: &str,
) -> Result<Vec<String>, String> {
    if sdk_accounts::descriptor(provider).is_some() {
        return sdk_accounts::account_keys(providers, provider);
    }
    let config = if ryu_gw_credentials::direct_compatible_provider_url(provider).is_some() {
        providers.get("compatible").and_then(|v| v.get(provider))
    } else {
        providers.get(provider)
    };
    let Some(config) = config else {
        return Ok(Vec::new());
    };
    let primary = config.get("api_key");
    let extras = config.get("api_keys");
    let mut keys = Vec::new();
    if let Some(primary) = primary {
        let key = primary
            .as_str()
            .ok_or("provider primary key must be a string")?;
        if !key.is_empty() {
            keys.push(key.to_owned());
        }
    }
    if let Some(extras) = extras {
        for entry in extras
            .as_array()
            .ok_or("provider extra keys must be an array")?
        {
            let key = entry
                .as_str()
                .ok_or("provider extra keys must contain strings")?;
            if !key.is_empty() && !keys.iter().any(|existing| existing == key) {
                keys.push(key.to_owned());
            }
        }
    }
    Ok(keys)
}

pub(in crate::server) fn gateway_account_policy_patch(
    provider: &str,
    body: &SetProviderBody,
) -> Result<serde_json::Value, String> {
    if body.api_key.is_some()
        || body.account_index.is_some()
        || body.sdk_context.is_some()
        || body.allow_environment.is_some()
    {
        return Err("account configuration requires accountId and accountPolicy only".to_owned());
    }
    let id = body.account_id.as_deref().ok_or("accountId is required")?;
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("accountId must be a valid opaque account identity".to_owned());
    }
    let policy = body
        .account_policy
        .as_ref()
        .ok_or("accountPolicy is required")?
        .normalized()?;
    let updates = std::collections::HashMap::from([(
        provider.to_owned(),
        std::collections::HashMap::from([(id.to_owned(), policy)]),
    )]);
    Ok(json!({"providerAccountPolicies": updates, "expectedRevision": body.expected_revision}))
}

pub(in crate::server) fn clear_gateway_provider_keys(
    entries: &mut toml::map::Map<String, toml::Value>,
    provider: &str,
) {
    if provider == "modal" {
        if let Some(config) = entries
            .get_mut(provider)
            .and_then(toml::Value::as_table_mut)
        {
            config.insert("api_key".to_owned(), toml::Value::String(String::new()));
            config.remove("api_keys");
            return;
        }
    }
    entries.remove(provider);
}

/// Edit the provider's rotation set without returning any credential to the client.
/// Indexes use the same deduplicated order that Gateway reports as api_key_count:
/// the primary key first, followed by additional keys.
pub(in crate::server) fn patch_gateway_provider_accounts(
    providers: &mut toml::map::Map<String, toml::Value>,
    provider: &str,
    compatible_url: Option<&str>,
    action: &str,
    api_key: Option<&str>,
    account_index: Option<usize>,
) -> Result<(), String> {
    let entries = if compatible_url.is_some() {
        providers
            .entry("compatible".to_owned())
            .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
            .as_table_mut()
            .ok_or("compatible provider configuration must be a table")?
    } else {
        providers
    };
    let mut keys = if let Some(existing) = entries.get(provider) {
        let table = existing
            .as_table()
            .ok_or("provider configuration must be a table")?;
        let mut values = Vec::new();
        if let Some(primary) = table.get("api_key") {
            let primary = primary.as_str().ok_or("api_key must be a string")?;
            if !primary.is_empty() {
                values.push(primary.to_owned());
            }
        }
        if let Some(extra) = table.get("api_keys") {
            for item in extra.as_array().ok_or("api_keys must be an array")? {
                let key = item.as_str().ok_or("api_keys must contain strings")?;
                if !key.is_empty() && !values.iter().any(|value| value == key) {
                    values.push(key.to_owned());
                }
            }
        }
        values
    } else {
        Vec::new()
    };
    match action {
        "add" => {
            let key = api_key.ok_or("api_key is required when adding an account")?;
            if account_index.is_some() {
                return Err("account_index is not used when adding an account".to_owned());
            }
            if keys.iter().any(|existing| existing == key) {
                return Err("this provider key is already connected".to_owned());
            }
            keys.push(key.to_owned());
        }
        "remove" => {
            if api_key.is_some() {
                return Err("api_key is not used when removing an account".to_owned());
            }
            let index =
                account_index.ok_or("account_index is required when removing an account")?;
            if index >= keys.len() {
                return Err("account_index is out of range".to_owned());
            }
            keys.remove(index);
        }
        "replace" => {
            let key = api_key.ok_or("api_key is required when replacing an account")?;
            let index =
                account_index.ok_or("account_index is required when replacing an account")?;
            if index >= keys.len() {
                return Err("account_index is out of range".to_owned());
            }
            if keys
                .iter()
                .enumerate()
                .any(|(existing_index, existing)| existing_index != index && existing == key)
            {
                return Err("this provider key is already connected".to_owned());
            }
            keys[index] = key.to_owned();
        }
        _ => return Err("unknown account_action".to_owned()),
    }
    if keys.is_empty() {
        clear_gateway_provider_keys(entries, provider);
        return Ok(());
    }
    let entry = entries
        .entry(provider.to_owned())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
        .as_table_mut()
        .ok_or("provider configuration must be a table")?;
    entry.insert("api_key".to_owned(), toml::Value::String(keys.remove(0)));
    entry.insert(
        "api_keys".to_owned(),
        toml::Value::Array(keys.into_iter().map(toml::Value::String).collect()),
    );
    if let Some(base_url) = compatible_url {
        entry.insert(
            "base_url".to_owned(),
            toml::Value::String(base_url.to_owned()),
        );
    }
    Ok(())
}

/// A replacement changes the material-derived opaque ID. Move its one policy
/// row in the same authored document so name, enabled, and priority stay bound
/// to the account position the user replaced.
pub(in crate::server) fn carry_gateway_provider_account_policy(
    providers: &mut toml::map::Map<String, toml::Value>,
    provider: &str,
    old_id: &str,
    new_id: &str,
) -> Result<(), String> {
    if old_id == new_id {
        return Ok(());
    }
    let Some(policies) = providers
        .get_mut("accountPolicies")
        .and_then(toml::Value::as_table_mut)
        .and_then(|table| table.get_mut(provider))
        .and_then(toml::Value::as_table_mut)
    else {
        return Ok(());
    };
    let Some(policy) = policies.remove(old_id) else {
        return Ok(());
    };
    if policies.contains_key(new_id) {
        policies.insert(old_id.to_owned(), policy);
        return Err("replacement account identity already has a policy".to_owned());
    }
    policies.insert(new_id.to_owned(), policy);
    Ok(())
}
