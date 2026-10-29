//! Core edits the same canonical SDK account configuration Gateway loads.
use ryu_gw_credentials::{
    sdk_provider_by_id, sdk_provider_by_kind, GenAiProviderConfig, SdkAuthKind, SdkEndpointConfig,
    SdkProviderDescriptor,
};
use toml::{map::Map, Value};

pub(super) fn descriptor(scope: &str) -> Option<&'static SdkProviderDescriptor> {
    if scope == "gemini" {
        sdk_provider_by_kind("gemini")
    } else {
        sdk_provider_by_id(scope).filter(|value| value.account_scope == scope)
    }
}

fn load(providers: &Map<String, Value>) -> Result<GenAiProviderConfig, String> {
    match providers.get("genai") {
        Some(value) => value
            .clone()
            .try_into()
            .map_err(|_| "invalid SDK account configuration".into()),
        None => Ok(GenAiProviderConfig::default()),
    }
}

pub(super) fn account_keys(
    providers: &Map<String, Value>,
    scope: &str,
) -> Result<Vec<String>, String> {
    let descriptor = descriptor(scope).ok_or("unknown SDK account scope")?;
    Ok(load(providers)?
        .accounts
        .get(descriptor.kind)
        .map(|account| account.all_keys())
        .unwrap_or_default())
}

pub(super) fn mutate(
    providers: &mut Map<String, Value>,
    scope: &str,
    action: &str,
    api_key: Option<&str>,
    account_index: Option<usize>,
    context: Option<&SdkEndpointConfig>,
    allow_environment: Option<bool>,
) -> Result<(), String> {
    let descriptor = descriptor(scope).ok_or("unknown SDK account scope")?;
    let mut config = load(providers)?;
    let account = config
        .accounts
        .entry(descriptor.kind.to_owned())
        .or_default();
    let mut keys = account.all_keys();
    if descriptor.auth_kind == SdkAuthKind::NoAuth
        && (api_key.is_some() || matches!(action, "add" | "remove" | "replace"))
    {
        return Err("this SDK connection has no credential accounts".into());
    }
    let mut replaced = None;
    match action {
        "set" => {
            if let Some(key) = api_key {
                if let Some(old) = keys.first() {
                    replaced = Some((old.clone(), key.to_owned()));
                }
                if !keys.is_empty() {
                    keys.remove(0);
                }
                keys.retain(|old| old != key);
                keys.insert(0, key.to_owned());
            } else if context.is_none() && allow_environment.is_none() {
                return Err("credential or endpoint context is required".into());
            }
        }
        "add" => {
            let key = api_key.ok_or("credential is required when adding an account")?;
            if account_index.is_some() {
                return Err("account index is not used when adding".into());
            }
            if !keys.iter().any(|old| old == key) {
                keys.push(key.to_owned());
            }
        }
        "replace" => {
            let key = api_key.ok_or("replacement credential is required")?;
            let index = account_index
                .filter(|index| *index < keys.len())
                .ok_or("account is no longer configured")?;
            if keys
                .iter()
                .enumerate()
                .any(|(other, old)| other != index && old == key)
            {
                return Err("replacement credential is already connected".into());
            }
            replaced = Some((keys[index].clone(), key.to_owned()));
            keys[index] = key.to_owned();
        }
        "remove" => {
            if api_key.is_some() {
                return Err("credential is not used when removing".into());
            }
            let index = account_index
                .filter(|index| *index < keys.len())
                .ok_or("account is no longer configured")?;
            keys.remove(index);
        }
        "clear" => {
            if allow_environment == Some(true) {
                return Err("clearing accounts cannot enable environment credentials".into());
            }
            if api_key.is_some() {
                return Err("credential is not used when clearing".into());
            }
            keys.clear();
            account.allow_env = false;
        }
        _ => return Err("unknown SDK account action".into()),
    }
    if let Some(context) = context {
        account.context = context.clone();
    }
    if let Some(allow) = allow_environment {
        account.allow_env = allow;
    }
    account.api_key = keys.first().cloned().unwrap_or_default();
    account.api_keys = keys.into_iter().skip(1).collect();
    account.validate(descriptor.kind)?;
    let value =
        Value::try_from(config).map_err(|_| "SDK account configuration could not be encoded")?;
    if let Some((old, new)) = replaced.filter(|(old, new)| old != new) {
        let old_id = ryu_gw_credentials::provider_account_id(scope, &old);
        let new_id = ryu_gw_credentials::provider_account_id(scope, &new);
        if let Some(policies) = providers
            .get_mut("accountPolicies")
            .and_then(Value::as_table_mut)
            .and_then(|table| table.get_mut(scope))
            .and_then(Value::as_table_mut)
        {
            if let Some(policy) = policies.remove(&old_id) {
                policies.insert(new_id, policy);
            }
        }
    }
    providers.insert("genai".into(), value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn legacy() -> Map<String, Value> {
        toml::from_str::<Value>(
            r#"[genai]
            keys = { gemini = "first", groq = "groq-first" }
            gemini_api_keys = ["second"]"#,
        )
        .unwrap()
        .as_table()
        .unwrap()
        .clone()
    }
    #[test]
    fn migration_and_clear_preserve_other_kinds_and_close_environment_import() {
        let mut providers = legacy();
        mutate(
            &mut providers,
            "gemini",
            "remove",
            None,
            Some(0),
            None,
            None,
        )
        .unwrap();
        assert_eq!(account_keys(&providers, "gemini").unwrap(), vec!["second"]);
        assert_eq!(
            account_keys(&providers, "genai-groq").unwrap(),
            vec!["groq-first"]
        );
        assert!(providers["genai"].get("keys").is_none());
        mutate(&mut providers, "gemini", "clear", None, None, None, None).unwrap();
        assert!(!providers["genai"]["accounts"]["gemini"]["allow_env"]
            .as_bool()
            .unwrap());
        assert_eq!(
            account_keys(&providers, "genai-groq").unwrap(),
            vec!["groq-first"]
        );
    }
    #[test]
    fn repeated_add_and_targeted_replace_preserve_order_and_policy() {
        let mut providers = legacy();
        mutate(
            &mut providers,
            "genai-groq",
            "add",
            Some("backup"),
            None,
            None,
            None,
        )
        .unwrap();
        mutate(
            &mut providers,
            "genai-groq",
            "add",
            Some("backup"),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            account_keys(&providers, "genai-groq").unwrap(),
            vec!["groq-first", "backup"]
        );
        let old_id = ryu_gw_credentials::provider_account_id("genai-groq", "backup");
        providers.insert(
            "accountPolicies".into(),
            Value::Table(Map::from_iter([(
                "genai-groq".into(),
                Value::Table(Map::from_iter([(
                    old_id,
                    Value::Table(Map::from_iter([(
                        "name".into(),
                        Value::String("Backup".into()),
                    )])),
                )])),
            )])),
        );
        mutate(
            &mut providers,
            "genai-groq",
            "replace",
            Some("replacement"),
            Some(1),
            None,
            None,
        )
        .unwrap();
        let new_id = ryu_gw_credentials::provider_account_id("genai-groq", "replacement");
        assert_eq!(
            providers["accountPolicies"]["genai-groq"][new_id]["name"].as_str(),
            Some("Backup")
        );
    }
    #[test]
    fn failed_mutation_is_atomic_and_keyless_context_never_becomes_a_key_account() {
        let mut providers = legacy();
        let before = providers.clone();
        assert!(mutate(
            &mut providers,
            "gemini",
            "clear",
            None,
            None,
            None,
            Some(true)
        )
        .is_err());
        assert_eq!(providers, before);
        assert!(mutate(
            &mut providers,
            "genai-groq",
            "add",
            Some("bad\nkey"),
            None,
            None,
            None
        )
        .is_err());
        assert_eq!(providers, before);
        let context = SdkEndpointConfig::Ollama {
            base_url: "http://127.0.0.1:11434".into(),
        };
        mutate(
            &mut providers,
            "genai-ollama",
            "set",
            None,
            None,
            Some(&context),
            None,
        )
        .unwrap();
        assert!(account_keys(&providers, "genai-ollama").unwrap().is_empty());
        assert!(mutate(
            &mut providers,
            "genai-ollama",
            "add",
            Some("fake"),
            None,
            None,
            None
        )
        .is_err());
    }
}
