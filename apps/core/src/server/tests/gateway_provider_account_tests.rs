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

// ── The plan's per-provider account limit (crate::server::plan_limits) ───────────────

type Providers = toml::map::Map<String, toml::Value>;

fn add_key(providers: &mut Providers, provider: &str, key: &str) -> Result<(), String> {
    patch_gateway_provider_accounts(providers, provider, None, "add", Some(key), None)
}

fn key_count(providers: &Providers, provider: &str) -> usize {
    1 + providers[provider]["api_keys"].as_array().unwrap().len()
}

fn sdk_edit(
    providers: &mut Providers,
    action: &str,
    key: Option<&str>,
    index: Option<usize>,
) -> Result<(), String> {
    sdk_accounts::mutate(providers, "genai-groq", action, key, index, None, None)
}

#[test]
fn a_full_key_list_refuses_a_new_key_but_still_replaces_and_removes() {
    let limit = crate::server::plan_limits::account_limit();
    let mut providers = Providers::new();
    // One below the limit, then the key at the limit takes the last place.
    for index in 0..limit {
        add_key(&mut providers, "deepgram", &format!("key-{index}")).unwrap();
        assert_eq!(key_count(&providers, "deepgram"), index + 1);
    }

    // The next key is refused and the list is unchanged.
    let _ = crate::server::plan_limits::take_refusal();
    let refused = add_key(&mut providers, "deepgram", "key-over").unwrap_err();
    assert_eq!(refused, crate::server::plan_limits::ACCOUNT_LIMIT_MESSAGE);
    assert_eq!(key_count(&providers, "deepgram"), limit);
    let (status, Json(body)) = account_edit_refusal(refused);
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "provider_account_limit");
    assert_eq!(body["provider"], "deepgram");
    assert_eq!(body["limit"], limit);
    assert_eq!(body["count"], limit);
    assert_eq!(body["success"], false);

    // Another provider has its own places.
    add_key(&mut providers, "openai", "other-key").unwrap();

    // Replacing and removing are not adds, so they pass on a full list.
    let replace = |providers: &mut Providers, key: &str| {
        patch_gateway_provider_accounts(providers, "deepgram", None, "replace", Some(key), Some(0))
    };
    replace(&mut providers, "key-replaced").unwrap();
    assert_eq!(key_count(&providers, "deepgram"), limit);
    patch_gateway_provider_accounts(&mut providers, "deepgram", None, "remove", None, Some(0))
        .unwrap();
    add_key(&mut providers, "deepgram", "key-again").unwrap();
    assert_eq!(key_count(&providers, "deepgram"), limit);

    // Any other refused edit stays a 400 with its own sentence.
    let other = add_key(&mut providers, "deepgram", "key-again").unwrap_err();
    let (status, Json(body)) = account_edit_refusal(other);
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "this provider key is already connected");
    assert_eq!(body["success"], false);
}

#[test]
fn a_key_list_above_the_limit_keeps_every_key_and_refuses_only_new_ones() {
    let limit = crate::server::plan_limits::account_limit();
    // A list from before the limit, or edited by hand: two keys more than allowed.
    let extra = (0..=limit)
        .map(|index| toml::Value::String(format!("extra-{index}")))
        .collect();
    let mut entry = Providers::new();
    entry.insert("api_key".to_owned(), toml::Value::String("primary".into()));
    entry.insert("api_keys".to_owned(), toml::Value::Array(extra));
    let mut providers = Providers::new();
    providers.insert("anthropic".to_owned(), toml::Value::Table(entry));
    assert_eq!(key_count(&providers, "anthropic"), limit + 2);

    assert!(add_key(&mut providers, "anthropic", "new").is_err());
    patch_gateway_provider_accounts(
        &mut providers,
        "anthropic",
        None,
        "replace",
        Some("rotated"),
        Some(3),
    )
    .unwrap();
    assert_eq!(key_count(&providers, "anthropic"), limit + 2);

    // Down to the limit is still full; one below it has room again.
    let remove_first = |providers: &mut Providers| {
        patch_gateway_provider_accounts(providers, "anthropic", None, "remove", None, Some(0))
    };
    remove_first(&mut providers).unwrap();
    remove_first(&mut providers).unwrap();
    assert!(add_key(&mut providers, "anthropic", "new").is_err());
    remove_first(&mut providers).unwrap();
    add_key(&mut providers, "anthropic", "new").unwrap();
    assert_eq!(key_count(&providers, "anthropic"), limit);
}

#[test]
fn a_full_sdk_account_list_refuses_a_new_credential_only() {
    let limit = crate::server::plan_limits::account_limit();
    let mut providers = Providers::new();
    let count = |providers: &Providers| {
        sdk_accounts::account_keys(providers, "genai-groq")
            .unwrap()
            .len()
    };
    for index in 0..limit {
        sdk_edit(&mut providers, "add", Some(&format!("key-{index}")), None).unwrap();
    }
    assert_eq!(count(&providers), limit);

    let refused = sdk_edit(&mut providers, "add", Some("key-over"), None).unwrap_err();
    assert_eq!(refused, crate::server::plan_limits::ACCOUNT_LIMIT_MESSAGE);
    let (status, Json(body)) = account_edit_refusal(refused);
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["provider"], "genai-groq");
    assert_eq!(count(&providers), limit);

    // Adding a saved credential again, setting the first one and replacing one
    // are not new accounts.
    sdk_edit(&mut providers, "add", Some("key-3"), None).unwrap();
    sdk_edit(&mut providers, "set", Some("key-first"), None).unwrap();
    sdk_edit(&mut providers, "replace", Some("key-replaced"), Some(1)).unwrap();
    assert_eq!(count(&providers), limit);

    sdk_edit(&mut providers, "remove", None, Some(0)).unwrap();
    sdk_edit(&mut providers, "add", Some("key-new"), None).unwrap();
    assert_eq!(count(&providers), limit);
}
