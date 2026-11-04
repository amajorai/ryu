use crate::server::*;

#[test]
fn add_and_remove_promotes_the_next_key_without_exposing_it() {
    let mut providers = toml::map::Map::new();
    patch_gateway_provider_accounts(&mut providers, "deepgram", None, "add", Some("first"), None)
        .unwrap();
    patch_gateway_provider_accounts(
        &mut providers,
        "deepgram",
        None,
        "add",
        Some("second"),
        None,
    )
    .unwrap();
    let duplicate = patch_gateway_provider_accounts(
        &mut providers,
        "deepgram",
        None,
        "add",
        Some("second"),
        None,
    );
    assert!(duplicate.is_err());
    patch_gateway_provider_accounts(&mut providers, "deepgram", None, "remove", None, Some(0))
        .unwrap();
    assert_eq!(providers["deepgram"]["api_key"].as_str(), Some("second"));
    assert!(providers["deepgram"]["api_keys"]
        .as_array()
        .unwrap()
        .is_empty());
    patch_gateway_provider_accounts(&mut providers, "deepgram", None, "remove", None, Some(0))
        .unwrap();
    assert!(!providers.contains_key("deepgram"));
}

#[test]
fn compatible_account_edit_keeps_the_pinned_direct_endpoint() {
    let mut providers = toml::map::Map::new();
    patch_gateway_provider_accounts(
        &mut providers,
        "mistral",
        Some("https://api.mistral.ai/v1"),
        "add",
        Some("key"),
        None,
    )
    .unwrap();
    assert_eq!(
        providers["compatible"]["mistral"]["base_url"].as_str(),
        Some("https://api.mistral.ai/v1")
    );
    assert_eq!(
        providers["compatible"]["mistral"]["api_key"].as_str(),
        Some("key")
    );
}

#[test]
fn assemblyai_account_edit_keeps_poll_settings() {
    let mut providers = toml::map::Map::new();
    providers.insert(
        "assemblyai".to_owned(),
        toml::Value::Table(toml::map::Map::from_iter([
            (
                "api_key".to_owned(),
                toml::Value::String("first".to_owned()),
            ),
            ("poll_timeout_secs".to_owned(), toml::Value::Integer(240)),
        ])),
    );
    patch_gateway_provider_accounts(
        &mut providers,
        "assemblyai",
        None,
        "add",
        Some("second"),
        None,
    )
    .unwrap();
    assert_eq!(
        providers["assemblyai"]["poll_timeout_secs"].as_integer(),
        Some(240)
    );
    assert_eq!(
        providers["assemblyai"]["api_keys"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn replace_keeps_target_position_and_provider_settings() {
    let mut providers = toml::map::Map::from_iter([(
        "assemblyai".to_owned(),
        toml::Value::Table(toml::map::Map::from_iter([
            (
                "api_key".to_owned(),
                toml::Value::String("first".to_owned()),
            ),
            (
                "api_keys".to_owned(),
                toml::Value::Array(vec![
                    toml::Value::String("second".to_owned()),
                    toml::Value::String("third".to_owned()),
                ]),
            ),
            ("poll_timeout_secs".to_owned(), toml::Value::Integer(240)),
        ])),
    )]);

    patch_gateway_provider_accounts(
        &mut providers,
        "assemblyai",
        None,
        "replace",
        Some("replacement"),
        Some(1),
    )
    .unwrap();

    assert_eq!(
        gateway_account_keys(&providers, "assemblyai").unwrap(),
        vec!["first", "replacement", "third"]
    );
    assert_eq!(
        providers["assemblyai"]["poll_timeout_secs"].as_integer(),
        Some(240)
    );
}

#[test]
fn replace_rejects_duplicate_or_missing_target_without_mutating_keys() {
    let mut providers = toml::map::Map::new();
    patch_gateway_provider_accounts(&mut providers, "deepgram", None, "add", Some("first"), None)
        .unwrap();
    patch_gateway_provider_accounts(
        &mut providers,
        "deepgram",
        None,
        "add",
        Some("second"),
        None,
    )
    .unwrap();
    let before = toml::Value::Table(providers.clone());

    assert!(patch_gateway_provider_accounts(
        &mut providers,
        "deepgram",
        None,
        "replace",
        Some("second"),
        Some(0),
    )
    .is_err());
    assert_eq!(toml::Value::Table(providers.clone()), before);

    assert!(patch_gateway_provider_accounts(
        &mut providers,
        "deepgram",
        None,
        "replace",
        None,
        Some(0),
    )
    .is_err());
    assert_eq!(toml::Value::Table(providers), before);
}

#[test]
fn replacement_carries_the_existing_policy_to_its_new_identity() {
    let old_id = ryu_gw_credentials::provider_account_id("fal", "old");
    let new_id = ryu_gw_credentials::provider_account_id("fal", "new");
    let other_id = ryu_gw_credentials::provider_account_id("fal", "other");
    let mut providers: toml::map::Map<String, toml::Value> = toml::from_str(
        &format!(
            "[accountPolicies.fal.\"{old_id}\"]\nname = \"Primary\"\nenabled = false\npriority = 7\n\n[accountPolicies.fal.\"{other_id}\"]\nname = \"Other\"\nenabled = true\npriority = 2\n"
        ),
    )
    .unwrap();

    carry_gateway_provider_account_policy(&mut providers, "fal", &old_id, &new_id).unwrap();

    assert!(providers["accountPolicies"]["fal"].get(&old_id).is_none());
    assert_eq!(
        providers["accountPolicies"]["fal"][&new_id]["name"].as_str(),
        Some("Primary")
    );
    assert_eq!(
        providers["accountPolicies"]["fal"][&new_id]["enabled"].as_bool(),
        Some(false)
    );
    assert!(providers["accountPolicies"]["fal"].get(&other_id).is_some());
}

#[test]
fn modal_account_removal_and_clear_keep_its_deployment_endpoint() {
    let mut providers = toml::map::Map::from_iter([(
        "modal".to_owned(),
        toml::Value::Table(toml::map::Map::from_iter([
            (
                "base_url".to_owned(),
                toml::Value::String("https://deployment.modal.run/v1".to_owned()),
            ),
            (
                "api_key".to_owned(),
                toml::Value::String("first".to_owned()),
            ),
        ])),
    )]);
    patch_gateway_provider_accounts(&mut providers, "modal", None, "add", Some("second"), None)
        .unwrap();
    patch_gateway_provider_accounts(&mut providers, "modal", None, "remove", None, Some(0))
        .unwrap();
    assert_eq!(providers["modal"]["api_key"].as_str(), Some("second"));
    patch_gateway_provider_accounts(&mut providers, "modal", None, "remove", None, Some(0))
        .unwrap();
    assert_eq!(providers["modal"]["api_key"].as_str(), Some(""));
    assert_eq!(
        providers["modal"]["base_url"].as_str(),
        Some("https://deployment.modal.run/v1")
    );
    patch_gateway_provider_accounts(&mut providers, "modal", None, "add", Some("third"), None)
        .unwrap();
    clear_gateway_provider_keys(&mut providers, "modal");
    assert_eq!(providers["modal"]["api_key"].as_str(), Some(""));
    assert!(providers["modal"].get("api_keys").is_none());
    assert_eq!(
        providers["modal"]["base_url"].as_str(),
        Some("https://deployment.modal.run/v1")
    );
}

#[test]
fn gemini_account_edits_promote_and_clear_without_erasing_other_genai_keys() {
    let mut providers = toml::map::Map::new();
    sdk_accounts::mutate(
        &mut providers,
        "gemini",
        "set",
        Some("first"),
        None,
        None,
        None,
    )
    .unwrap();
    sdk_accounts::mutate(
        &mut providers,
        "gemini",
        "add",
        Some("second"),
        None,
        None,
        None,
    )
    .unwrap();
    sdk_accounts::mutate(
        &mut providers,
        "gemini",
        "add",
        Some("second"),
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        gateway_account_keys(&providers, "gemini").unwrap(),
        vec!["first", "second"]
    );
    sdk_accounts::mutate(
        &mut providers,
        "gemini",
        "set",
        Some("replacement"),
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        gateway_account_keys(&providers, "gemini").unwrap(),
        vec!["replacement", "second"]
    );
    sdk_accounts::mutate(
        &mut providers,
        "gemini",
        "remove",
        None,
        Some(0),
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        gateway_account_keys(&providers, "gemini").unwrap(),
        vec!["second"]
    );
    sdk_accounts::mutate(
        &mut providers,
        "genai-groq",
        "set",
        Some("groq-key"),
        None,
        None,
        None,
    )
    .unwrap();
    sdk_accounts::mutate(&mut providers, "gemini", "clear", None, None, None, None).unwrap();
    assert!(gateway_account_keys(&providers, "gemini")
        .unwrap()
        .is_empty());
    assert_eq!(
        gateway_account_keys(&providers, "genai-groq").unwrap(),
        vec!["groq-key"]
    );
    assert!(!providers["genai"]["accounts"]["gemini"]["allow_env"]
        .as_bool()
        .unwrap());
}
