#[test]
fn kiro_http_model_route_contains_only_local_proxy_custody() {
    with_temp_dir(|| {
        ensure_kiro_models_json(Some("fixture/kiro-model")).unwrap();
        let models = read_models();
        let entry = &models["providers"][KIRO_PROVIDER_ID];
        assert_eq!(entry["api"], "openai-completions");
        assert!(entry["baseUrl"]
            .as_str()
            .unwrap()
            .ends_with("/api/pi-config/kiro/v1"));
        assert_eq!(entry["apiKey"], "ryu-local-proxy");
        assert_eq!(
            entry["headers"]["x-ryu-session-id"],
            "$RYU_PI_HOST_CONVERSATION_ID"
        );
        assert_eq!(entry["models"][0]["input"], json!(["text"]));
        assert!(!read_auth().contains_key(KIRO_PROVIDER_ID));
        let mut retained = entry.as_object().unwrap().clone();
        retained.insert(
            "models".into(),
            json!([{"id":"fixture/kiro-model", "contextWindow":4096, "x-ryu-enabled":false}]),
        );
        upsert_provider(KIRO_PROVIDER_ID, retained).unwrap();
        ensure_kiro_models_json(Some("fixture/other-model")).unwrap();
        assert_eq!(
            read_models()["providers"][KIRO_PROVIDER_ID]["models"][0]["contextWindow"],
            4096
        );
        assert_eq!(
            read_models()["providers"][KIRO_PROVIDER_ID]["models"][0]["x-ryu-enabled"],
            false
        );
        assert_eq!(
            read_models()["providers"][KIRO_PROVIDER_ID]["models"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    });
}

#[test]
fn named_compatible_vendors_have_discovery_and_account_routing() {
    for id in NAMED_COMPATIBLE_PROVIDERS {
        let meta = provider_meta(id).expect("first-class provider");
        let base = ryu_gw_credentials::direct_compatible_provider_url(id).unwrap();
        assert_eq!(meta.models_url, format!("{base}/models"));
        assert_eq!(meta.auth_key, *id);
        assert_eq!(meta.auth_kind, "api-key");
        assert!(sdk_account_routing::supported(id));
        assert_eq!(
            sdk_account_routing::credential_kinds(id),
            vec![accounts::KIND_API_KEY]
        );
    }
}

#[test]
fn named_compatible_vendors_configure_and_activate_sdk_model_entries() {
    with_temp_vault_dir(|| {
        for id in NAMED_COMPATIBLE_PROVIDERS {
            configure_provider(ProviderConfigInput {
                provider: (*id).into(),
                api_key: Some("fixture-key".into()),
                base_url: None,
                api: None,
                routing: Some("direct".into()),
            })
            .unwrap();
            let model = "fixture/selected";
            let input = || PiConfigInput {
                provider: (*id).into(),
                model: Some(model.into()),
                thinking_level: None,
                api_key: None,
                base_url: None,
                api: None,
            };
            apply(input()).unwrap();
            let models = read_models();
            let entry = &models["providers"][*id];
            assert_eq!(
                entry["baseUrl"],
                ryu_gw_credentials::direct_compatible_provider_url(id).unwrap()
            );
            assert_eq!(entry["api"], "openai-completions");
            assert_eq!(entry["models"][0]["id"], model);
            assert!(
                entry.get("apiKey").is_none(),
                "credential stays in auth.json"
            );
            assert_eq!(read_settings().default_provider.as_deref(), Some(*id));
            let mut retained = entry.as_object().unwrap().clone();
            retained.insert(
                "models".into(),
                json!([{"id":model,"contextWindow":4096,"x-ryu-enabled":false}]),
            );
            upsert_provider(id, retained).unwrap();
            apply(input()).unwrap();
            assert_eq!(
                read_models()["providers"][*id]["models"][0]["contextWindow"],
                4096
            );
            assert_eq!(
                read_models()["providers"][*id]["models"][0]["x-ryu-enabled"],
                false
            );
        }
    });
}

#[test]
fn access_only_chatgpt_token_remains_usable_until_expiry() {
    let entry = serde_json::json!({"expires_at": 1030});
    assert!(!super::subscription_needs_refresh(
        super::CHATGPT_PLAN_AUTH_KEY,
        &entry,
        1000
    ));
    assert!(super::subscription_needs_refresh(
        super::CHATGPT_PLAN_AUTH_KEY,
        &entry,
        1030
    ));
    let renewable = serde_json::json!({"expires_at": 1030, "refresh": "fixture"});
    assert!(super::subscription_needs_refresh(
        super::CHATGPT_PLAN_AUTH_KEY,
        &renewable,
        1000
    ));
    assert!(super::subscription_needs_refresh("anthropic", &entry, 1000));
    assert!(super::subscription_needs_refresh(
        super::CHATGPT_PLAN_AUTH_KEY,
        &serde_json::json!({}),
        1000
    ));
}
use super::*;

#[test]
fn custom_model_discovery_preserves_existing_rows_and_filters_bad_ids() {
    let mut rows = vec![json!({ "id": "already-here", "enabled": false, "contextWindow": 8192 })];
    let added = append_discovered_model_ids(
        &mut rows,
        &[
            json!({ "id": "already-here" }),
            json!({ "id": "new-model", "name": "New model" }),
            json!({ "id": "bad\nmodel" }),
            json!({ "id": "new-model" }),
        ],
    );
    assert_eq!(added, 1);
    assert_eq!(rows[0]["enabled"], false);
    assert_eq!(rows[0]["contextWindow"], 8192);
    assert_eq!(rows[1], json!({ "id": "new-model" }));
}

#[test]
fn only_literal_loopback_hosts_bypass_discovery_egress_screen() {
    for host in ["127.0.0.1", "[::1]", "localhost"] {
        let url = reqwest::Url::parse(&format!("http://{host}:11434/v1/models")).unwrap();
        assert!(is_literal_loopback_endpoint(&url), "{host}");
    }
    for host in [
        "10.0.0.2",
        "169.254.169.254",
        "model.internal",
        "localhost.example",
    ] {
        let url = reqwest::Url::parse(&format!("http://{host}:11434/v1/models")).unwrap();
        assert!(!is_literal_loopback_endpoint(&url), "{host}");
    }
    let with_userinfo = reqwest::Url::parse("http://user:pass@localhost:11434/v1/models").unwrap();
    assert!(!is_literal_loopback_endpoint(&with_userinfo));
}

#[test]
fn saved_keyless_custom_provider_fetches_and_stores_openai_models() {
    with_temp_dir(|| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("loopback listener");
            let base_url = format!("http://127.0.0.1:{}/v1", listener.local_addr().unwrap().port());
            let serve = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.expect("discovery request");
                let mut request = [0_u8; 2048];
                let size = stream.read(&mut request).await.expect("read request");
                let text = String::from_utf8_lossy(&request[..size]);
                assert!(text.starts_with("GET /v1/models HTTP/1.1"));
                let body = r#"{"object":"list","data":[{"id":"local-a"},{"id":"local-b"}]}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.expect("write response");
            });
            configure_provider(ProviderConfigInput {
                provider: "my-local".to_owned(),
                api_key: None,
                base_url: Some(base_url),
                api: Some("openai-responses".to_owned()),
                routing: None,
            })
            .expect("save provider");
            assert_eq!(refresh_custom_provider_models("my-local").await.unwrap(), 2);
            serve.await.expect("served request");
            let models = read_models();
            assert_eq!(models["providers"]["my-local"]["models"], json!([
                { "id": "local-a" }, { "id": "local-b" }
            ]));
            let row = catalog()["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == "my-local")
                .cloned()
                .expect("custom provider row");
            assert_eq!(row["configured"], true);
            assert_eq!(row["api"], "openai-responses");
            let offline = discover_models(DiscoverInput {
                provider: Some("my-local".to_owned()),
                base_url: None,
                api_key: None,
                api: None,
            })
            .await;
            assert_eq!(offline["source"], "saved");
            assert_eq!(offline["models"], json!([
                { "id": "local-a" }, { "id": "local-b" }
            ]));
        });
    });
}

#[tokio::test]
async fn refreshing_a_saved_oauth_account_does_not_select_it() {
    let vault = accounts::AccountVault::in_memory().expect("vault");
    let scope = accounts::provider_scope("anthropic");
    let first = json!({
        "type": "oauth",
        "access": "first-token",
        "refresh": "first-refresh",
        "expires": now_unix().saturating_add(3600).saturating_mul(1000)
    });
    let second = json!({
        "type": "oauth",
        "access": "second-token",
        "refresh": "second-refresh",
        "expires": now_unix().saturating_add(3600).saturating_mul(1000)
    });
    vault
        .upsert(
            &scope,
            "first",
            "First",
            accounts::KIND_OAUTH,
            Some(first.clone()),
        )
        .expect("first login");
    vault
        .upsert(
            &scope,
            "second",
            "Second",
            accounts::KIND_OAUTH,
            Some(second.clone()),
        )
        .expect("second login");

    let returned = refresh_subscription_account_with_vault(&vault, "anthropic", "first")
        .await
        .expect("fresh account");
    assert_eq!(returned, first);
    assert_eq!(
        vault
            .active_info(&scope)
            .expect("active")
            .expect("account")
            .account_id,
        "second"
    );
    assert_eq!(
        vault.credential(&scope, "second").expect("credential"),
        Some(second)
    );
}

#[tokio::test]
async fn subscription_request_captures_the_selected_account_credential() {
    let vault = accounts::AccountVault::in_memory().expect("vault");
    let scope = accounts::provider_scope(CHATGPT_AUTH_KEY);
    let expiry = now_unix().saturating_add(3600).saturating_mul(1000);
    let first = json!({"type":"oauth","access":"first","refresh":"first-refresh","expires":expiry});
    let second =
        json!({"type":"oauth","access":"second","refresh":"second-refresh","expires":expiry});
    vault
        .upsert(
            &scope,
            "first",
            "First",
            accounts::KIND_OAUTH,
            Some(first.clone()),
        )
        .expect("first account");
    vault
        .upsert(
            &scope,
            "second",
            "Second",
            accounts::KIND_OAUTH,
            Some(second.clone()),
        )
        .expect("second account");

    assert_eq!(
        subscription_request_credential_with_vault(&vault, CHATGPT_AUTH_KEY)
            .await
            .expect("selected credential"),
        Some(second)
    );
    vault.set_active(&scope, "first").expect("switch account");
    assert_eq!(
        subscription_request_credential_with_vault(&vault, CHATGPT_AUTH_KEY)
            .await
            .expect("new selected credential"),
        Some(first)
    );
}

#[test]
fn merged_refresh_retains_account_metadata_and_pi_expiry() {
    let original =
        json!({"type":"oauth","access":"old","refresh":"old-refresh","accountId":"subject"});
    let updated =
        merged_oauth_credential(&original, "new", Some("new-refresh"), Some(1_800_000_000))
            .expect("merge");
    assert_eq!(updated["accountId"], "subject");
    assert_eq!(updated["access"], "new");
    assert_eq!(updated["refresh"], "new-refresh");
    assert_eq!(updated["expires_at"], 1_800_000_000);
    assert_eq!(updated["expires"], 1_800_000_000_000_u64);
}

#[test]
fn claude_proxy_placeholder_is_distinct_from_a_sealed_login() {
    let placeholder = claude_proxy_credential();
    assert!(is_claude_proxy_credential(CLAUDE_AUTH_KEY, &placeholder));
    assert!(!is_claude_proxy_credential(
        CLAUDE_AUTH_KEY,
        &json!({ "type": "oauth", "access": "sk-ant-oat-real-account" })
    ));
    assert_eq!(placeholder["type"], "oauth");
    assert!(placeholder["expires"].as_u64().unwrap() > now_unix() * 1000);
    let patch = claude_provider_patch();
    assert_eq!(patch["api"], "anthropic-messages");
    assert_eq!(
        patch["headers"]["x-ryu-session-id"],
        "$RYU_PI_HOST_CONVERSATION_ID"
    );
    assert!(patch["baseUrl"]
        .as_str()
        .is_some_and(|url| url.ends_with("/api/pi-config/claude")));

    let mut models = json!({ "providers": { "anthropic": {
        "apiKey": "old-key",
        "headers": { "x-user-header": "keep" }
    } } });
    update_claude_model_route(&mut models, true).expect("OAuth route");
    let entry = &models["providers"][CLAUDE_AUTH_KEY];
    assert!(entry.get("apiKey").is_none());
    assert_eq!(entry["headers"]["x-user-header"], "keep");
    assert_eq!(
        entry["headers"]["x-ryu-session-id"],
        "$RYU_PI_HOST_CONVERSATION_ID"
    );
    update_claude_model_route(&mut models, false).expect("direct API-key route");
    let entry = &models["providers"][CLAUDE_AUTH_KEY];
    assert_eq!(entry["baseUrl"], "https://api.anthropic.com");
    assert!(entry["headers"].get("x-ryu-session-id").is_none());
    assert_eq!(entry["headers"]["x-user-header"], "keep");
}

#[test]
fn oauth_refresh_keeps_rotated_token_on_the_account_that_started_it() {
    with_temp_dir(|| {
        let vault = accounts::AccountVault::in_memory().expect("vault");
        let scope = accounts::provider_scope("anthropic");
        let first = json!({"type":"oauth","access":"first","refresh":"first-refresh"});
        let second = json!({"type":"oauth","access":"second","refresh":"second-refresh"});
        vault
            .upsert(
                &scope,
                "first",
                "First",
                accounts::KIND_OAUTH,
                Some(first.clone()),
            )
            .expect("first login");
        vault
            .upsert(
                &scope,
                "second",
                "Second",
                accounts::KIND_OAUTH,
                Some(second.clone()),
            )
            .expect("second login");
        vault.set_active(&scope, "first").expect("select first");
        ensure_dir().expect("pi directory");
        write_secret_file(&auth_path(), &json!({"anthropic": first}).to_string())
            .expect("first auth");

        // The network exchange started with first; another selection completed
        // before its rotated token arrived.
        vault.set_active(&scope, "second").expect("select second");
        write_secret_file(&auth_path(), &json!({"anthropic": second}).to_string())
            .expect("second auth");
        persist_oauth_refresh_with_vault(
            "anthropic",
            &first,
            Some("first"),
            "rotated-first",
            Some("rotated-refresh"),
            None,
            Some(&vault),
        )
        .expect("save to original account");

        assert_eq!(
            vault
                .credential(&scope, "first")
                .expect("first credential")
                .expect("first row")["access"],
            "rotated-first"
        );
        assert_eq!(
            vault
                .credential(&scope, "second")
                .expect("second credential"),
            Some(second.clone())
        );
        assert_eq!(read_auth()["anthropic"], second);
        assert_eq!(
            vault
                .active_info(&scope)
                .expect("active")
                .expect("account")
                .account_id,
            "second"
        );
    });
}

#[test]
fn last_account_removal_clears_legacy_slots_without_removing_model_configuration() {
    with_temp_dir(|| {
        ensure_dir().unwrap();
        write_secret_file(&auth_path(), &json!({"baseten":{"type":"api_key","key":"synthetic"},"openai":{"type":"api_key","key":"other"}}).to_string()).unwrap();
        write_models(&json!({"providers":{"baseten":{"apiKey":"synthetic","baseUrl":"https://example.com/v1","models":[{"id":"test-model"}]}}})).unwrap();
        clear_provider_active_slot("baseten").unwrap();
        assert!(!read_auth().contains_key("baseten"));
        assert_eq!(read_auth()["openai"]["key"], "other");
        let models = read_models();
        assert!(models["providers"]["baseten"].get("apiKey").is_none());
        assert_eq!(
            models["providers"]["baseten"]["models"][0]["id"],
            "test-model"
        );
        assert_eq!(
            models["providers"]["baseten"]["baseUrl"],
            "https://example.com/v1"
        );
    });
}

#[test]
fn initialized_vault_never_falls_back_to_a_removed_oauth_account() {
    let vault = accounts::AccountVault::in_memory().expect("vault");
    let scope = accounts::provider_scope("anthropic");
    assert!(active_oauth_credential_from_vault(&vault, &scope)
        .expect("empty vault")
        .is_none());

    vault
        .upsert(
            &scope,
            "api-key",
            "API key",
            accounts::KIND_API_KEY,
            Some(json!({ "type": "api_key", "key": "synthetic" })),
        )
        .expect("API-key account");
    assert!(active_oauth_credential_from_vault(&vault, &scope)
        .expect("API-key account")
        .is_none());

    let oauth = json!({ "type": "oauth", "access": "synthetic", "refresh": "synthetic" });
    vault
        .upsert(
            &scope,
            "oauth",
            "Claude login",
            accounts::KIND_OAUTH,
            Some(oauth.clone()),
        )
        .expect("OAuth account");
    assert_eq!(
        active_oauth_credential_from_vault(&vault, &scope).expect("OAuth account"),
        Some(oauth)
    );
    vault.remove(&scope, "oauth").expect("remove OAuth account");
    assert!(active_oauth_credential_from_vault(&vault, &scope)
        .expect("removed OAuth account")
        .is_none());
}

/// Point the config dir at a temp location for the duration of a test.
///
/// Takes the **registry** env lock as well as the pi-config one. Several of
/// these tests reach `default_gateway_model()` → `ProviderRegistry::load()`,
/// which reads the process-global `RYU_LOCAL_CHAT_MODEL_*` /
/// `RYU_REGISTRY_PATH` vars that `registry::tests` mutate transiently under
/// *their* lock. Without this, `gateway_patch_upgrades_bare_default_model_metadata`
/// — which calls `default_gateway_model()` twice, once to build the entry and
/// once inside `ensure_gateway_models_json` — can read two different ids across
/// a concurrent `RYU_LOCAL_CHAT_MODEL_ID` override and fail its `"Gemma 4 E2B IT
/// Q4_K_M"` assertion. A cross-module flake, not a bug in either test.
///
/// Lock order is pi-config → registry, and it is the only order taken anywhere:
/// `registry::tests` never acquire the pi-config lock, and `sidecar::adapters`'
/// two pi-config users acquire nothing else. Keep it that way — the inverse
/// order in any new test deadlocks the whole suite, which is far worse than the
/// flake this closes.
/// [`with_temp_dir`] plus a thread-local sealed account vault, for tests
/// that store provider keys (a key is never written without one).
pub(crate) fn with_temp_vault_dir<F: FnOnce()>(f: F) {
    with_temp_dir(|| accounts::with_test_vault(|_| f()));
}

pub(crate) fn with_temp_dir<F: FnOnce()>(f: F) {
    let _guard = lock_pi_config_test_env();
    let _registry_guard = crate::registry::lock_registry_env();
    let dir = std::env::temp_dir().join(format!("ryu-pi-config-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    std::env::set_var("RYU_PI_AGENT_DIR", &dir);
    f();
    std::env::remove_var("RYU_PI_AGENT_DIR");
    let _ = fs::remove_dir_all(&dir);
}

/// A limited agent's Pi reads a config dir with the managed settings and
/// extensions but none of the user's provider credentials: no auth.json,
/// and only the Gateway pin in models.json.
#[test]
fn a_limited_agents_pi_config_dir_holds_no_user_provider_credentials() {
    with_temp_dir(|| {
        let managed = config_dir();
        fs::create_dir_all(managed.join("extensions")).unwrap();
        fs::write(
            managed.join("settings.json"),
            r#"{"defaultProvider":"anthropic","defaultModel":"gpt-5","skills":[]}"#,
        )
        .unwrap();
        fs::write(
            managed.join("auth.json"),
            r#"{"anthropic":{"type":"api_key","key":"sk-user-anthropic"}}"#,
        )
        .unwrap();
        fs::write(
            managed.join("models.json"),
            r#"{"providers":{
                    "openai":{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-user-openai","models":[{"id":"fixture/model"}]},
                    "my-proxy":{"baseUrl":"https://proxy.example","apiKey":"sk-user-custom"}
                }}"#,
        )
        .unwrap();
        fs::write(managed.join("extensions").join("ryu-mcp.ts"), "// mcp").unwrap();
        let legacy = managed.join(LEGACY_LIMITED_AGENT_DIR);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("models.json"), "{}").unwrap();
        let root = limited_agents_root();
        let _ = fs::remove_dir_all(&root);
        let limited = limited_agent_dir(Some("agent-a"));
        fs::create_dir_all(limited.join("extensions").join("planted")).unwrap();
        fs::write(limited.join("auth.json"), "{}").unwrap();
        fs::write(limited.join("extensions").join("gone.ts"), "// stale").unwrap();
        fs::write(
            limited.join("extensions").join("planted").join("index.ts"),
            "// planted",
        )
        .unwrap();
        for planted in ["SYSTEM.md", "APPEND_SYSTEM.md", "AGENTS.md"] {
            fs::write(limited.join(planted), "planted").unwrap();
        }
        fs::create_dir_all(limited.join("skills")).unwrap();
        fs::create_dir_all(limited.join("bin")).unwrap();
        fs::write(limited.join("bin").join("rg"), "planted").unwrap();
        // Pi's own data: a running Pi's session and its debug log.
        fs::create_dir_all(limited.join("sessions").join("cwd")).unwrap();
        fs::write(
            limited.join("sessions").join("cwd").join("session.jsonl"),
            "{}",
        )
        .unwrap();
        fs::write(limited.join("pi-debug.log"), "log").unwrap();
        // The older shared layout left its files at the top of the folder.
        fs::write(root.join("settings.json"), "{}").unwrap();
        fs::create_dir_all(root.join("extensions")).unwrap();

        assert_eq!(
            agent_config_dir_str(Some("agent-a"), None).unwrap(),
            managed.to_string_lossy()
        );
        let dir = PathBuf::from(agent_config_dir_str(Some("agent-a"), Some(&[])).unwrap());

        assert_eq!(dir, limited);
        assert_eq!(dir.parent(), Some(root.as_path()));
        assert!(
            !dir.starts_with(&managed),
            "the limited dir sits outside the managed dir, so the sandbox can hide that"
        );
        assert!(is_managed_agent_dir(&dir));
        assert!(!is_managed_agent_dir(&root));
        assert!(!is_managed_agent_dir(&root.join("agent-not-a-hash")));
        assert!(!legacy.exists(), "the legacy nested dir is removed");
        assert!(!root.join("settings.json").exists());
        assert!(!root.join("extensions").exists());
        assert!(!dir.join("auth.json").exists());
        let models = fs::read_to_string(dir.join("models.json")).unwrap();
        assert!(!models.contains("sk-user"), "{models}");
        let models: Value = serde_json::from_str(&models).unwrap();
        let providers = models["providers"].as_object().unwrap();
        assert_eq!(providers.keys().collect::<Vec<_>>(), vec!["openai"]);
        assert_eq!(providers["openai"]["apiKey"], "${OPENAI_API_KEY}");
        assert_eq!(providers["openai"]["models"][0]["id"], "fixture/model");
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings["defaultProvider"], "openai");
        // With no provider of the user's allowed, the agent starts on the
        // zero-key local model, never one Gateway would refuse it.
        assert_eq!(settings["defaultModel"], default_gateway_model().as_str());
        assert!(dir.join("extensions").join("ryu-mcp.ts").is_file());
        assert!(!dir.join("extensions").join("gone.ts").exists());
        // Nothing the agent planted survives into its next start.
        assert!(!dir.join("extensions").join("planted").exists());
        for planted in [
            "SYSTEM.md",
            "APPEND_SYSTEM.md",
            "AGENTS.md",
            "skills",
            "bin",
        ] {
            assert!(!dir.join(planted).exists(), "{planted}");
        }
        // Pi's sessions and debug log are data, and another Pi of the
        // same agent may be using them, so the rebuild leaves them alone.
        assert!(dir
            .join("sessions")
            .join("cwd")
            .join("session.jsonl")
            .is_file());
        assert!(dir.join("pi-debug.log").is_file());

        // With the default model's provider allowed, the managed default
        // stands, in a folder of its own for every agent.
        let other = PathBuf::from(
            agent_config_dir_str(Some("agent-b"), Some(&["openai".to_owned()])).unwrap(),
        );
        assert_ne!(other, dir);
        assert_eq!(other.parent(), Some(root.as_path()));
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(other.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings["defaultModel"], "gpt-5");
        assert!(
            dir.join("settings.json").is_file(),
            "other agents' folders stay"
        );
        let _ = fs::remove_dir_all(&root);
    });
}

/// What an agent writes into its own limited Pi config dir while its Pi
/// runs is gone before its next Pi starts, without the route running again.
#[test]
fn deleting_an_agent_removes_only_its_limited_pi_config_dir() {
    with_temp_dir(|| {
        let root = limited_agents_root();
        let _ = fs::remove_dir_all(&root);
        for agent in ["agent-a", "agent-b"] {
            let sessions = limited_agent_dir(Some(agent)).join("sessions");
            fs::create_dir_all(&sessions).unwrap();
            fs::write(sessions.join("x.jsonl"), "{}").unwrap();
        }
        remove_limited_agent_dir("agent-a").unwrap();
        assert!(!limited_agent_dir(Some("agent-a")).exists());
        assert!(limited_agent_dir(Some("agent-b"))
            .join("sessions")
            .join("x.jsonl")
            .is_file());
        // Removing it again, or one that never existed, is fine.
        remove_limited_agent_dir("agent-a").unwrap();
        remove_limited_agent_dir("never-created").unwrap();
    });
}

#[test]
fn a_limited_agents_pi_config_is_rebuilt_before_its_pi_starts() {
    with_temp_dir(|| {
        let managed = config_dir();
        fs::create_dir_all(managed.join("extensions")).unwrap();
        fs::write(
            managed.join("settings.json"),
            r#"{"defaultModel":"gpt-5","skills":[]}"#,
        )
        .unwrap();
        fs::write(managed.join("extensions").join("ryu-mcp.ts"), "// mcp").unwrap();
        let root = limited_agents_root();
        let _ = fs::remove_dir_all(&root);
        let dir = PathBuf::from(
            agent_config_dir_str(Some("agent-a"), Some(&["openai".to_owned()])).unwrap(),
        );
        let planted_extension = dir.join("extensions").join("planted.ts");
        fs::write(&planted_extension, "// planted").unwrap();
        fs::write(dir.join("AGENTS.md"), "planted").unwrap();
        fs::write(
            dir.join("settings.json"),
            r#"{"defaultModel":"anthropic/claude","packages":["/tmp/evil"]}"#,
        )
        .unwrap();
        fs::write(dir.join("models.json"), r#"{"providers":{"anthropic":{}}}"#).unwrap();

        refresh_limited_agent_dir(&dir).unwrap();

        assert!(!planted_extension.exists());
        assert!(!dir.join("AGENTS.md").exists());
        assert!(dir.join("extensions").join("ryu-mcp.ts").is_file());
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings["defaultProvider"], "openai");
        assert_eq!(settings["defaultModel"], default_gateway_model().as_str());
        assert!(settings.get("packages").is_none(), "{settings}");
        let models: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("models.json")).unwrap()).unwrap();
        let providers = models["providers"].as_object().unwrap();
        assert_eq!(providers.keys().collect::<Vec<_>>(), vec!["openai"]);

        // The managed default the route chose stands.
        agent_config_dir_str(Some("agent-a"), Some(&["openai".to_owned()])).unwrap();
        refresh_limited_agent_dir(&dir).unwrap();
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings["defaultModel"], "gpt-5");

        // Only a limited agent's own folder is rebuilt.
        assert!(refresh_limited_agent_dir(&managed).is_err());
        assert!(refresh_limited_agent_dir(&root).is_err());
        assert!(refresh_limited_agent_dir(&root.join("agent-not-a-hash")).is_err());
        let _ = fs::remove_dir_all(&root);
    });
}

/// A limited agent starts on a model Gateway would serve it: the managed
/// default when its slot is allowed or needs none of the user's
/// credentials, else the first model of an allowed provider, else local.
#[test]
fn a_limited_agents_default_model_is_one_gateway_lets_it_use() {
    let local = || "gemma-local".to_owned();
    let ids = |list: &[&str]| list.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
    let no_candidates = Vec::new;
    let choose = |managed: &str, access: &[&str], free: &[&str], candidates: &[&str]| {
        let candidates = ids(candidates);
        choose_limited_agent_model(
            Some(managed),
            &ids(access),
            &ids(free),
            move || candidates,
            local(),
        )
    };

    // A Ryu-credit default is kept for "Its own identity": Ryu's own
    // supply needs none of the user's credentials.
    for credit in [
        "ryu-code/standard",
        "ryu-reasoning/o3",
        "@cf/meta/llama-3.1-8b-instruct",
        "amazon.nova-pro-v1:0",
    ] {
        assert_eq!(
            choose(credit, &[], &[], &[]),
            LimitedModelChoice {
                model: credit.to_owned(),
                source: LimitedModelSource::RyuCredits,
            },
            "{credit}"
        );
    }
    // So is a Ryu Router pick Ryu serves on free credit, and the Auto
    // Router while anything is free; not once nothing is.
    assert_eq!(
        choose("openrouter/auto", &[], &["z-ai/glm-5"], &[]).source,
        LimitedModelSource::RyuCredits
    );
    assert_eq!(
        choose("z-ai/glm-5", &[], &["z-ai/glm-5"], &[]).source,
        LimitedModelSource::RyuCredits
    );
    assert_eq!(
        choose("openrouter/auto", &[], &[], &[]).model,
        "gemma-local"
    );
    assert_eq!(
        choose("anthropic/claude-sonnet-4", &[], &["z-ai/glm-5"], &[]).model,
        "gemma-local"
    );

    // An Anthropic default with only OpenAI allowed falls back to the
    // first model of an allowed provider.
    let fallback = choose(
        "claude-sonnet-4-5",
        &["openai"],
        &[],
        &["claude-opus-4-5", "gpt-5", "gpt-5-mini"],
    );
    assert_eq!(
        fallback,
        LimitedModelChoice {
            model: "gpt-5".to_owned(),
            source: LimitedModelSource::FirstAllowedModel,
        }
    );
    // The default stands when its provider is allowed.
    assert_eq!(
        choose("claude-sonnet-4-5", &["anthropic"], &[], &["gpt-5"]).source,
        LimitedModelSource::AllowedProvider
    );
    // An id only the Gateway's own config would place is never assumed.
    assert_eq!(
        choose("fixture/model", &["openai"], &[], &[]).model,
        "gemma-local"
    );

    // Local when nothing else fits.
    let local_only = choose("claude-sonnet-4-5", &["openai"], &[], &["claude-opus-4-5"]);
    assert_eq!(
        local_only,
        LimitedModelChoice {
            model: "gemma-local".to_owned(),
            source: LimitedModelSource::Local,
        }
    );
    assert_eq!(
        choose_limited_agent_model(None, &[], &[], no_candidates, local()).source,
        LimitedModelSource::Local
    );
    // Another model on the local engine is kept as local.
    assert_eq!(
        choose("qwen3-8b", &[], &[], &[]),
        LimitedModelChoice {
            model: "qwen3-8b".to_owned(),
            source: LimitedModelSource::Local,
        }
    );
}

#[test]
fn the_limited_agents_root_is_a_sibling_of_the_managed_dir() {
    let managed = PathBuf::from("/data/runtimes/pi-agent");
    let limited = limited_agents_root_for(&managed);
    assert_eq!(limited, PathBuf::from("/data/runtimes/pi-agent-limited"));
    assert!(!limited.starts_with(&managed));
}

#[test]
fn limited_agent_dir_names_are_one_safe_component_per_agent() {
    let name = limited_agent_dir_name(Some("../../etc"));
    assert!(is_limited_agent_dir_name(std::ffi::OsStr::new(&name)));
    assert!(!name.contains('/') && !name.contains('.'));
    assert_ne!(name, limited_agent_dir_name(Some("agent-a")));
    assert_eq!(
        limited_agent_dir_name(Some("agent-a")),
        limited_agent_dir_name(Some("agent-a"))
    );
}

#[test]
fn removing_an_account_promotes_a_survivor_and_clears_the_slot_when_empty() {
    with_temp_dir(|| {
        let vault = accounts::AccountVault::in_memory().expect("vault");
        let scope = accounts::provider_scope("anthropic");
        for id in ["a", "b"] {
            vault
                .upsert(
                    &scope,
                    id,
                    id,
                    accounts::KIND_API_KEY,
                    Some(json!({ "type": "api_key", "key": format!("sk-{id}") })),
                )
                .expect("save account");
        }
        vault.set_active(&scope, "a").expect("select a");

        // Removing the active account selects the survivor.
        assert!(vault.remove(&scope, "a").expect("remove a"));
        settle_provider_scope_after_removal(&vault, &scope).expect("settle");
        let remaining = vault.list(&scope).expect("list");
        assert_eq!(remaining.len(), 1);
        assert!(remaining[0].active, "the survivor must become active");

        // Removing the last account clears the legacy slot, so materialization
        // cannot re-import the removed credential from auth.json.
        // `set_auth_key_with_vault` refuses to run without a vault (and would
        // add another account here), so write the materialized slot directly.
        let mut auth = read_auth();
        auth.insert("anthropic".to_owned(), auth_key_reference("anthropic"));
        write_secret_file(
            &auth_path(),
            &serde_json::to_string_pretty(&auth).expect("serialize auth.json"),
        )
        .expect("materialized slot");
        assert!(read_auth().contains_key("anthropic"));
        assert!(vault.remove(&scope, "b").expect("remove b"));
        settle_provider_scope_after_removal(&vault, &scope).expect("settle");
        assert!(!read_auth().contains_key("anthropic"));
    });
}

#[test]
fn removing_a_pi_acp_account_still_materializes_when_settling_fails() {
    with_temp_dir(|| {
        let vault = accounts::AccountVault::in_memory().expect("vault");
        let scope = accounts::provider_scope("anthropic");
        vault
            .upsert(
                &scope,
                "a",
                "a",
                accounts::KIND_API_KEY,
                Some(json!({ "type": "api_key", "key": "sk-a" })),
            )
            .expect("save account");

        let mut materialized = false;
        let removed = remove_pi_account_from(
            &vault,
            "a",
            |_, _| Err(anyhow::anyhow!("auth.json is not writable")),
            || materialized = true,
        )
        .expect("a removed account is reported as removed");
        assert!(removed);
        assert!(materialized, "materialization must still run");
        assert!(vault.list(&scope).expect("list").is_empty());

        // An unknown account is not removed and nothing is materialized.
        let mut materialized_again = false;
        let removed = remove_pi_account_from(
            &vault,
            "missing",
            |_, _| Ok(()),
            || materialized_again = true,
        )
        .expect("remove");
        assert!(!removed);
        assert!(!materialized_again);
    });
}

#[test]
fn gateway_is_default_routing() {
    with_temp_dir(|| {
        assert!(is_gateway_routing());
        let view = current();
        assert_eq!(view.provider, GATEWAY_PROVIDER_ID);
        assert_eq!(view.routing, "gateway");
    });
}

#[test]
fn pi_mcp_extension_is_shipped_and_registered_idempotently() {
    with_temp_dir(|| {
        // First call: writes the extension source and registers its absolute
        // path in settings.json "extensions".
        ensure_pi_mcp_extension().expect("first ensure");
        let ext_path = pi_mcp_extension_path();
        assert!(
            ext_path.exists(),
            "extension file is shipped to the managed dir"
        );
        let shipped = fs::read_to_string(&ext_path).unwrap();
        assert_eq!(
            shipped, PI_MCP_EXTENSION_SRC,
            "shipped source matches the embed"
        );

        let abs = ext_path.to_string_lossy().into_owned();
        let settings = read_settings();
        let exts = settings
            .extra
            .get("extensions")
            .and_then(Value::as_array)
            .cloned();
        let exts = exts.expect("extensions array present");
        assert!(
            exts.iter()
                .filter(|v| v.as_str() == Some(abs.as_str()))
                .count()
                == 1,
            "registered exactly once"
        );

        // Second call: idempotent — no duplicate path, source unchanged.
        ensure_pi_mcp_extension().expect("second ensure");
        let settings2 = read_settings();
        let exts2 = settings2
            .extra
            .get("extensions")
            .and_then(Value::as_array)
            .cloned()
            .expect("extensions array present");
        assert_eq!(
            exts2
                .iter()
                .filter(|v| v.as_str() == Some(abs.as_str()))
                .count(),
            1,
            "second ensure does not duplicate the registration"
        );
    });
}

#[test]
fn pi_mcp_extension_preserves_unrelated_extensions() {
    with_temp_dir(|| {
        // A user (or another Ryu write) already listed an extension; ours must
        // be appended, not clobber theirs.
        let mut settings = read_settings();
        settings
            .extra
            .insert("extensions".to_owned(), json!(["/tmp/other-ext.ts"]));
        write_settings(&settings).unwrap();

        ensure_pi_mcp_extension().expect("ensure");
        let exts = read_settings()
            .extra
            .get("extensions")
            .and_then(Value::as_array)
            .cloned()
            .expect("extensions array");
        let abs = pi_mcp_extension_path().to_string_lossy().into_owned();
        assert!(exts.iter().any(|v| v.as_str() == Some("/tmp/other-ext.ts")));
        assert!(exts.iter().any(|v| v.as_str() == Some(abs.as_str())));
    });
}

#[test]
fn pi_lsp_extension_is_shipped_and_registered_idempotently() {
    with_temp_dir(|| {
        ensure_pi_lsp_extension().expect("first ensure");
        let ext_path = pi_lsp_extension_path();
        let shipped = fs::read_to_string(&ext_path).expect("extension file is shipped");
        assert_eq!(
            shipped, PI_LSP_EXTENSION_SRC,
            "shipped source matches the embed"
        );

        // A second ensure must neither rewrite the source nor double-register.
        let mtime = fs::metadata(&ext_path).unwrap().modified().unwrap();
        ensure_pi_lsp_extension().expect("second ensure");
        assert_eq!(
            fs::metadata(&ext_path).unwrap().modified().unwrap(),
            mtime,
            "identical source is not rewritten"
        );

        let abs = ext_path.to_string_lossy().into_owned();
        let exts = read_settings()
            .extra
            .get("extensions")
            .and_then(Value::as_array)
            .cloned()
            .expect("extensions array present");
        assert_eq!(
            exts.iter()
                .filter(|v| v.as_str() == Some(abs.as_str()))
                .count(),
            1,
            "registered exactly once"
        );
    });
}

#[test]
fn pi_plan_extension_is_shipped_and_registered_idempotently() {
    with_temp_dir(|| {
        ensure_pi_plan_extension().expect("first ensure");
        let ext_path = pi_plan_extension_path();
        let shipped = fs::read_to_string(&ext_path).expect("extension file is shipped");
        assert_eq!(
            shipped, PI_PLAN_EXTENSION_SRC,
            "shipped source matches the embed"
        );

        // A second ensure must neither rewrite the source nor double-register.
        let mtime = fs::metadata(&ext_path).unwrap().modified().unwrap();
        ensure_pi_plan_extension().expect("second ensure");
        assert_eq!(
            fs::metadata(&ext_path).unwrap().modified().unwrap(),
            mtime,
            "identical source is not rewritten"
        );

        let abs = ext_path.to_string_lossy().into_owned();
        let exts = read_settings()
            .extra
            .get("extensions")
            .and_then(Value::as_array)
            .cloned()
            .expect("extensions array present");
        assert_eq!(
            exts.iter()
                .filter(|v| v.as_str() == Some(abs.as_str()))
                .count(),
            1,
            "registered exactly once"
        );
    });
}

#[test]
fn pi_plan_extension_preserves_unrelated_extensions() {
    with_temp_dir(|| {
        let mut settings = read_settings();
        settings
            .extra
            .insert("extensions".to_owned(), json!(["/tmp/other-ext.ts"]));
        write_settings(&settings).unwrap();

        ensure_pi_plan_extension().expect("ensure");
        let exts = read_settings()
            .extra
            .get("extensions")
            .and_then(Value::as_array)
            .cloned()
            .expect("extensions array");
        let abs = pi_plan_extension_path().to_string_lossy().into_owned();
        assert!(exts.iter().any(|v| v.as_str() == Some("/tmp/other-ext.ts")));
        assert!(exts.iter().any(|v| v.as_str() == Some(abs.as_str())));
    });
}

/// The sentinel is a CONTRACT with `ryu-plan.ts`, not a free-form string: the
/// extension matches it with `/^\/plan(-off)?(?![\w-])[ \t]*(.*)$/` against the
/// first line of the prompt (or of its final `\n\n` block), then strips it. If
/// this drifts, plan mode does not fail loudly — the token simply reaches the
/// model as literal text and the mode never engages. So these assertions pin
/// the exact bytes the extension's regexes accept.
#[test]
fn plan_mode_sentinel_matches_the_extension_grammar() {
    assert_eq!(plan_mode_sentinel(true), "/plan");
    assert_eq!(plan_mode_sentinel(false), "/plan off");

    // The extension's own two regexes, transcribed. `regex` is not a Core
    // dependency, so this is a hand-rolled equivalent of what they accept —
    // the point is that the token is a bare `/plan`, optionally followed by
    // the word `off`, with nothing else attached to it.
    for on in [true, false] {
        let s = plan_mode_sentinel(on);
        assert!(s.starts_with("/plan"), "{s}: sentinel token is `/plan`");
        let rest = &s["/plan".len()..];
        assert!(
            rest.is_empty() || rest == " off",
            "{s}: only the `off` word may follow, separated by a space"
        );
        // `(?![\w-])` — the character after the token must never extend it,
        // or `/planning` and `/plan-offsite` would match too.
        assert!(
            !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_' || c == '-'),
            "{s}: the token must not run into a word character"
        );
        // Single line: callers place this as its own first line, and a
        // newline inside it would push the sentinel off that line.
        assert!(!s.contains('\n'), "{s}: sentinel is a single line");
        assert_eq!(s.trim(), s, "{s}: no leading/trailing whitespace");
    }

    // ON and OFF must be distinguishable — `/plan off` starting with `/plan`
    // is exactly why the extension checks the `off` word before concluding
    // "enter". A helper that returned the same string for both would silently
    // make the pill a one-way switch.
    assert_ne!(plan_mode_sentinel(true), plan_mode_sentinel(false));
}

#[test]
fn managed_defaults_ship_every_compiled_in_extension() {
    with_temp_dir(|| {
        ensure_managed_defaults().expect("managed defaults");
        assert!(pi_mcp_extension_path().exists());
        assert!(
            pi_lsp_extension_path().exists(),
            "the LSP binding rides the same spawn-time invariant pass as the MCP bridge"
        );
        assert!(pi_plan_extension_path().exists());
    });
}

/// The UPGRADE path: a Core that ships a newer extension body must overwrite
/// the copy an OLDER Core already wrote to the user's managed Pi dir.
///
/// **Why this is a test and not a comment.** The extensions are `include_str!`d
/// into the Core binary, so they travel with a Core upgrade for free — but only
/// as far as the binary. Reaching the user's `~/.ryu/pi-agent/extensions/`
/// depends entirely on [`ship_pi_extension`] doing a CONTENT compare
/// (`existing != src`) rather than an existence check. Those two are one word
/// apart and behave identically on a fresh install, so the difference is
/// invisible to every other test here — `managed_defaults_ship_every_ryu_extension`
/// and the per-extension idempotency tests all start from an empty dir.
///
/// If someone "optimises" that to write-if-absent, every EXISTING user is frozen
/// on whatever extension body their first install wrote, forever, while the
/// release notes say the fix shipped. That is the silent-degradation class this
/// file's guards exist to prevent, so it gets pinned from the upgrade side too.
///
/// Registration is asserted as well: the settings entry must not be duplicated
/// by the rewrite, since the path is unchanged.
#[test]
fn a_stale_extension_body_is_replaced_on_upgrade() {
    with_temp_dir(|| {
        // An older Core's install: every extension present, but with a body
        // that predates the current embed.
        ensure_managed_defaults().expect("first install");
        let stale = "// shipped by an older Ryu\n";
        let paths = [
            pi_mcp_extension_path(),
            pi_lsp_extension_path(),
            pi_plan_extension_path(),
        ];
        for path in &paths {
            fs::write(path, stale).expect("age the installed extension");
        }

        // The upgraded Core's spawn-time invariant pass.
        ensure_managed_defaults().expect("upgrade");

        for (path, expected) in paths.iter().zip([
            PI_MCP_EXTENSION_SRC,
            PI_LSP_EXTENSION_SRC,
            PI_PLAN_EXTENSION_SRC,
        ]) {
            let on_disk = fs::read_to_string(path).expect("extension still present");
            assert_ne!(
                on_disk,
                stale,
                "{} was left at the older body — an upgraded Core never reached the user",
                path.display()
            );
            assert_eq!(
                on_disk,
                expected,
                "{} does not match the embed after upgrade",
                path.display()
            );
        }

        let exts = read_settings()
            .extra
            .get("extensions")
            .and_then(Value::as_array)
            .cloned()
            .expect("extensions array present");
        for path in &paths {
            let abs = path.to_string_lossy().into_owned();
            assert_eq!(
                exts.iter()
                    .filter(|v| v.as_str() == Some(abs.as_str()))
                    .count(),
                1,
                "{abs} registered exactly once after the upgrade rewrite"
            );
        }
    });
}

/// The bijection guard: every `.ts` asset under `apps/core/assets/pi-extensions/`
/// must actually reach the managed Pi dir when Core runs its spawn-time
/// invariant pass.
///
/// **Why this exists.** Nothing forces a new pi-extension asset to be wired up.
/// Dropping a `.ts` into that folder without an `include_str!` +
/// `ensure_pi_*_extension()` + a line in [`ensure_managed_defaults`] compiles,
/// ships nothing, and fails **silently** at runtime — the feature looks landed
/// and is simply absent. That is exactly how `ryu-plan.ts` could have gone in.
///
/// This guard now covers only the **compiled-in** road. The plugin road
/// (`contributes.pi_extensions`) has its own pair in
/// [`crate::plugin_manifest`]: `builtin_pi_extension_table_matches_package_manifests`
/// (declared ⇄ embedded) and `packaged_pi_extension_files_are_all_declared`
/// (nothing on disk is undeclared), plus
/// [`super::app_extensions_round_trip_writes_then_removes`] for the bytes
/// actually reaching the managed dir. The three assets left here are the ones
/// that must never become plugins; see the chain comment in
/// [`ensure_managed_defaults`].
///
/// Three properties, and all three are load-bearing:
/// 1. it drives [`ensure_managed_defaults`], not the individual `ensure_pi_*`
///    fns — so forgetting the chain line fails here even though every
///    per-extension test above still passes;
/// 2. it compares BYTES, not existence — so an `include_str!` pointing at the
///    wrong asset (a copy/paste of the trio above) fails here;
/// 3. it asserts the exact asset count, so a globbing or extension-filter
///    mistake that skips a file cannot pass by vacuous truth.
#[test]
fn every_pi_extension_asset_is_shipped() {
    with_temp_dir(|| {
        ensure_managed_defaults().expect("managed defaults");

        let assets_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets")
            .join("pi-extensions");
        let shipped_dir = config_dir().join("extensions");

        let mut assets: Vec<PathBuf> = fs::read_dir(&assets_dir)
            .expect("read the pi-extensions asset dir")
            .map(|entry| entry.expect("asset dir entry").path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("ts"))
            .collect();
        assets.sort();

        // Every extension shipped by `ensure_managed_defaults` today. Change
        // this deliberately when adding one — or when moving one out to a
        // plugin package, which is what took it from 5 to 3.
        const EXPECTED_ASSETS: usize = 3;
        assert_eq!(
            assets.len(),
            EXPECTED_ASSETS,
            "a pi-extension asset was added or removed without updating the \
                 shipping chain in ensure_managed_defaults: {assets:?}"
        );

        for asset in &assets {
            let name = asset
                .file_name()
                .expect("asset file name")
                .to_string_lossy()
                .into_owned();
            let shipped = shipped_dir.join(&name);
            let shipped_src = fs::read_to_string(&shipped).unwrap_or_else(|err| {
                panic!(
                    "{name} is a pi-extension asset but ensure_managed_defaults never \
                         shipped it ({err}). Two valid answers: if it must be compiled in \
                         (see the chain comment in ensure_managed_defaults), add a \
                         PI_*_EXTENSION_SRC include_str!, a pi_*_extension_path(), an \
                         ensure_pi_*_extension() and a chain line. Otherwise it belongs in a \
                         plugin package as a contributes.pi_extensions row — move the file to \
                         plugins-store/{{plugins,lsp,external_plugins}}/<pkg>/pi-extensions/ and drop EXPECTED_ASSETS by one."
                )
            });
            let asset_src = fs::read_to_string(asset).expect("read asset source");
            assert_eq!(
                shipped_src, asset_src,
                "{name} was shipped, but not from its own asset — an include_str! \
                     points at the wrong file"
            );
        }
    });
}

/// One resolved plugin extension, as [`app_extensions::resolve_pi_extensions`]
/// would produce it.
fn resolved_ext(plugin: &str, id: &str, source: &str) -> app_extensions::PiExtensionResolution {
    app_extensions::PiExtensionResolution {
        extensions: vec![app_extensions::ResolvedPiExtension {
            plugin_id: plugin.to_owned(),
            extension_id: id.to_owned(),
            file_name: format!(
                "ext-{}-{id}.ts",
                crate::plugin_manifest::plugin_dir_name(plugin)
            ),
            source: source.to_owned(),
        }],
        skipped: vec![],
    }
}

/// The whole point of the seam: an enabled plugin's extension is WRITTEN with
/// its own bytes and registered, and disabling that plugin (an empty
/// resolution) takes both the file and its `settings.json` entry away again.
///
/// The byte compare is not decoration. A wrong file name or a prefix mismatch
/// in the reconciler would still satisfy the table⇄manifest bijection tests
/// while the extension silently never loads — which is the exact failure
/// `every_pi_extension_asset_is_shipped` exists to prevent on the other road.
#[test]
fn app_extensions_round_trip_writes_then_removes() {
    with_temp_dir(|| {
        let source = "// background bash\nexport default {};\n";
        sync_app_pi_extensions(&resolved_ext("@ryu/pi-shell", "shell", source))
            .expect("materialize");

        let path = pi_extensions_dir().join("ext-@ryu+pi-shell-shell.ts");
        assert_eq!(
            fs::read_to_string(&path).expect("extension written"),
            source,
            "the materialized file must carry the resolved source verbatim"
        );
        let abs = path.to_string_lossy().into_owned();
        let registered = |settings: &PiSettings| {
            settings
                .extra
                .get("extensions")
                .and_then(Value::as_array)
                .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(abs.as_str())))
        };
        assert!(registered(&read_settings()), "path registered in settings");

        // Disable: the reconcile is driven by the resolution, so an empty one is
        // exactly what an uninstall or a disable produces.
        sync_app_pi_extensions(&app_extensions::PiExtensionResolution::default())
            .expect("reconcile empty");
        assert!(
            !path.exists(),
            "disabling the plugin must delete the file — Pi auto-discovers this \
                 directory, so an orphan keeps loading forever"
        );
        assert!(
            !registered(&read_settings()),
            "the settings.json registration must be pruned with the file"
        );
    });
}

/// The ownership boundary: the reconciler owns `ext-*.ts` and NOTHING else.
///
/// This is the invariant whose failure bricks the flagship agent — an empty
/// resolution (every extension-contributing plugin disabled) must not be able
/// to delete `ryu-mcp.ts`, which is the managed Pi's only road to Ryu's tools.
#[test]
fn the_reconciler_never_touches_files_it_does_not_own() {
    with_temp_dir(|| {
        ensure_managed_defaults().expect("managed defaults");
        let dir = pi_extensions_dir();
        let hand_written = dir.join("my-own.ts");
        fs::write(&hand_written, "// dropped in by hand\n").expect("write");

        // A user entry in the array that is not even in this folder.
        let mut settings = read_settings();
        let elsewhere = "/somewhere/else/mine.ts";
        settings
            .extra
            .entry("extensions".to_owned())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("array")
            .push(Value::String(elsewhere.to_owned()));
        write_settings(&settings).expect("write settings");

        sync_app_pi_extensions(&app_extensions::PiExtensionResolution::default())
            .expect("reconcile empty");

        assert!(
            dir.join("ryu-mcp.ts").exists(),
            "compiled-in extension kept"
        );
        assert!(
            dir.join("ryu-lsp.ts").exists(),
            "compiled-in extension kept"
        );
        assert!(
            dir.join("ryu-plan.ts").exists(),
            "compiled-in extension kept"
        );
        assert!(
            hand_written.exists(),
            "a user's own file is not ours to delete"
        );

        let arr = read_settings()
            .extra
            .get("extensions")
            .and_then(Value::as_array)
            .cloned()
            .expect("extensions array");
        assert!(
            arr.iter().any(|v| v.as_str() == Some(elsewhere)),
            "an unrelated registration must survive the prune"
        );
        assert_eq!(
            arr.iter()
                .filter(|v| v
                    .as_str()
                    .is_some_and(|s| s.contains("ryu-mcp.ts") || s.contains("ryu-plan.ts")))
                .count(),
            2,
            "the compiled-in registrations must survive the prune"
        );
    });
}

/// Re-materializing an unchanged set must not rewrite the file: this runs on
/// every managed-Pi spawn, so an unconditional write would churn the disk on
/// every new chat. Same content-compare contract as [`ship_pi_extension`].
#[test]
fn app_extensions_are_written_only_when_they_change() {
    with_temp_dir(|| {
        let resolution = resolved_ext("@ryu/pi-shell", "shell", "// v1\n");
        sync_app_pi_extensions(&resolution).expect("first");
        let path = pi_extensions_dir().join("ext-@ryu+pi-shell-shell.ts");
        let first = fs::metadata(&path)
            .expect("stat")
            .modified()
            .expect("mtime");

        sync_app_pi_extensions(&resolution).expect("second");
        assert_eq!(
            fs::metadata(&path)
                .expect("stat")
                .modified()
                .expect("mtime"),
            first,
            "an unchanged resolution must not rewrite the file"
        );

        // A changed source DOES land, so idempotency never becomes staleness.
        sync_app_pi_extensions(&resolved_ext("@ryu/pi-shell", "shell", "// v2\n"))
            .expect("upgrade");
        assert_eq!(fs::read_to_string(&path).expect("read"), "// v2\n");
    });
}

/// One resolved stdio server, built through serde so the Claude Code defaults
/// (`restartOnCrash` / `diagnostics` = true) come from the contract itself.
fn resolved_go_server() -> crate::lsp::LspResolution {
    let config = serde_json::from_value(json!({
        "command": "gopls",
        "extensionToLanguage": { ".go": "go" },
    }))
    .expect("valid declaration");
    crate::lsp::LspResolution {
        servers: vec![crate::lsp::ResolvedLspServer {
            plugin_id: "com.example.go".to_owned(),
            server_name: "go".to_owned(),
            config,
        }],
        skipped: vec![],
    }
}

#[test]
fn lsp_servers_file_lands_where_the_extension_reads_it() {
    with_temp_dir(|| {
        write_lsp_servers_file(&resolved_go_server()).expect("write");

        // The path is a contract with assets/pi-extensions/ryu-lsp.ts, which
        // reads `<PI_CODING_AGENT_DIR>/extensions/ryu-lsp.json`.
        let path = config_dir().join("extensions").join("ryu-lsp.json");
        let doc: Value = serde_json::from_str(&fs::read_to_string(&path).expect("file written"))
            .expect("valid JSON");
        let entry = &doc["servers"]["com.example.go/go"];
        assert_eq!(entry["command"], "gopls");
        assert_eq!(entry["extensionToLanguage"][".go"], "go");
        assert_eq!(entry["restartOnCrash"], true);
    });
}

#[test]
fn lsp_servers_file_is_written_once_and_removed_when_nothing_is_declared() {
    with_temp_dir(|| {
        let path = config_dir().join("extensions").join("ryu-lsp.json");
        write_lsp_servers_file(&resolved_go_server()).expect("write");
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();

        write_lsp_servers_file(&resolved_go_server()).expect("second write");
        assert_eq!(
            fs::metadata(&path).unwrap().modified().unwrap(),
            mtime,
            "an unchanged table is not rewritten on every Pi spawn"
        );

        // Disabling the last contributing plugin must actually stop the
        // servers, so the stale table is removed rather than left behind.
        write_lsp_servers_file(&crate::lsp::LspResolution::default()).expect("empty write");
        assert!(!path.exists(), "an empty resolution deletes the file");

        // ...and removing an already-absent file is not an error.
        write_lsp_servers_file(&crate::lsp::LspResolution::default()).expect("idempotent");
    });
}

#[test]
fn explicit_cache_control_format_matches_supported_model_families() {
    // Explicit Anthropic-style cache_control families.
    assert_eq!(
        explicit_cache_control_format("claude-sonnet-4"),
        Some("anthropic")
    );
    assert_eq!(
        explicit_cache_control_format("anthropic/claude-3.5-sonnet"),
        Some("anthropic")
    );
    assert_eq!(
        explicit_cache_control_format("qwen/qwen3-coder-plus"),
        Some("anthropic")
    );
    assert_eq!(
        explicit_cache_control_format("deepseek/deepseek-v3.2"),
        Some("anthropic")
    );
    // Auto-caching or non-caching families: no marker.
    assert_eq!(explicit_cache_control_format("gpt-4o"), None);
    assert_eq!(explicit_cache_control_format("openai/gpt-4o"), None);
    assert_eq!(explicit_cache_control_format("google/gemini-2.5-pro"), None);
    assert_eq!(
        explicit_cache_control_format("google/gemini-2.0-flash"),
        Some("anthropic")
    );
    assert_eq!(
        explicit_cache_control_format("google/gemini-3.0-flash"),
        None
    );
    assert_eq!(
        explicit_cache_control_format("deepseek/deepseek-chat"),
        None
    );
    assert_eq!(
        explicit_cache_control_format("qwen/qwen3.5-plus-02-15"),
        None
    );
    assert_eq!(explicit_cache_control_format("x-ai/grok-4"), None);
}

#[test]
fn gateway_model_entry_uses_chat_completions_for_explicit_cache_models() {
    // Cache-control families use the Pi adapter that emits per-block
    // breakpoints; Responses only forwards automatic cache hints.
    let entry = gateway_model_entry("anthropic/claude-sonnet-4", None);
    assert_eq!(
        entry["compat"]["cacheControlFormat"],
        json!("anthropic"),
        "claude entry should opt into anthropic cache_control markers"
    );
    assert_eq!(entry["api"], json!("openai-completions"));
    assert_eq!(entry["id"], json!("anthropic/claude-sonnet-4"));

    let qwen = gateway_model_entry("qwen/qwen3-coder-plus", None);
    assert_eq!(
        qwen["compat"]["cacheControlFormat"],
        json!("anthropic"),
        "Qwen entry should also opt into Anthropic-style cache markers"
    );

    assert_eq!(qwen["api"], json!("openai-completions"));

    // OpenAI relies on provider-side automatic caching and stays on Responses.
    let openai = gateway_model_entry("gpt-4o", None);
    assert!(openai.get("compat").is_none());
    assert_eq!(openai["api"], json!("openai-responses"));
}

#[test]
fn gateway_model_entries_keep_responses_except_explicit_cache_models() {
    let old_entry = json!({ "id": "gpt-4o", "api": "openai-completions" });
    let existing = gateway_model_entry("gpt-4o", Some(&old_entry));
    let local_id = default_gateway_model();
    let local = gateway_model_entry(&local_id, None);

    assert_eq!(existing["api"], json!("openai-responses"));
    assert_eq!(local["api"], json!("openai-responses"));
    assert_eq!(
        gateway_model_entry("qwen/qwen3-max", None)["api"],
        json!("openai-completions")
    );
}

#[test]
fn bundled_local_model_preserves_vision_capability_on_existing_settings() {
    let local_id = crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID;
    let existing = json!({ "id": local_id, "input": ["text"] });
    let entry = gateway_model_entry(local_id, Some(&existing));

    assert_eq!(entry["input"], json!(["text", "image"]));
}

#[test]
fn apply_cache_compat_preserves_caller_declared_compat() {
    // Do not clobber an existing compat block or a caller's own format.
    let mut entry = json!({
        "id": "anthropic/claude-sonnet-4",
        "compat": { "cacheControlFormat": "anthropic", "supportsStrictMode": true }
    });
    apply_cache_compat("anthropic/claude-sonnet-4", &mut entry);
    assert_eq!(entry["compat"]["supportsStrictMode"], json!(true));
    assert_eq!(entry["compat"]["cacheControlFormat"], json!("anthropic"));
}

/// Managed reaches the HOSTED fleet while the synthetic gateway provider
/// stays LOCAL — both on the same node — and managed falls back to local when
/// no fleet coordinates are configured.
///
/// Regression: both used to resolve to the local gateway, so a self-hosted
/// user who picked "Ryu (managed · included with your plan)" was routed into
/// their own keyless gateway and could never spend the plan they paid for.
///
/// One test, not three: these mutate PROCESS-GLOBAL env and `cargo test` runs
/// test fns in parallel, so separate cases race each other's vars.
#[test]
fn managed_routes_at_the_fleet_while_byok_stays_local() {
    struct EnvGuard(&'static str, Option<String>);
    impl EnvGuard {
        fn set(k: &'static str, v: &str) -> Self {
            let prev = std::env::var(k).ok();
            std::env::set_var(k, v);
            Self(k, prev)
        }
        fn clear(k: &'static str) -> Self {
            let prev = std::env::var(k).ok();
            std::env::remove_var(k);
            Self(k, prev)
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.1 {
                Some(v) => std::env::set_var(self.0, v),
                None => std::env::remove_var(self.0),
            }
        }
    }

    with_temp_dir(|| {
        {
            let _u = EnvGuard::set("RYU_MANAGED_GATEWAY_URL", "https://gw.example.test");
            let _t = EnvGuard::set("RYU_MANAGED_GATEWAY_TOKEN", "rgw_unit_test");

            let managed = gateway_openai_patch_for(Some("openrouter/auto"), true);
            assert_eq!(
                managed.get("api").and_then(Value::as_str),
                Some("openai-responses")
            );
            assert_eq!(
                managed.get("baseUrl").and_then(Value::as_str),
                Some("https://gw.example.test/v1")
            );
            // The fleet bearer travels in the Pi spawn environment only.
            assert_eq!(
                managed.get("apiKey").and_then(Value::as_str),
                Some("${RYU_PI_FLEET_TOKEN}")
            );
            assert!(secret_env::secret_env().contains(&(
                secret_env::FLEET_TOKEN_ENV.to_owned(),
                "rgw_unit_test".to_owned()
            )));

            // BYOK keeps the local gateway even while managed is configured.
            let local = gateway_openai_patch_for(Some("gpt-4o"), false);
            assert_eq!(
                local.get("api").and_then(Value::as_str),
                Some("openai-responses")
            );
            assert_eq!(
                local.get("apiKey").and_then(Value::as_str),
                Some("${OPENAI_API_KEY}"),
                "shared Pi configuration must preserve the process-scoped bearer"
            );
            let base = local.get("baseUrl").and_then(Value::as_str).unwrap();
            assert!(
                base.contains("127.0.0.1"),
                "BYOK must stay on the local gateway, got {base}"
            );
        }
        {
            // No coordinates ⇒ managed falls back to local (opt-in must not
            // regress a node that never opted in).
            let _u = EnvGuard::clear("RYU_MANAGED_GATEWAY_URL");
            let _t = EnvGuard::clear("RYU_MANAGED_GATEWAY_TOKEN");
            crate::sidecar::gateway::set_managed_fleet_pref(None, None);
            let patch = gateway_openai_patch_for(Some("openrouter/auto"), true);
            let base = patch.get("baseUrl").and_then(Value::as_str).unwrap();
            assert!(
                base.contains("127.0.0.1"),
                "expected local fallback, got {base}"
            );
        }
    });
}

fn apply_gateway_writes_openai_provider_and_marker() {
    with_temp_dir(|| {
        let view = apply(PiConfigInput {
            provider: GATEWAY_PROVIDER_ID.to_owned(),
            model: Some("gpt-4o".to_owned()),
            thinking_level: Some("medium".to_owned()),
            api_key: None,
            base_url: None,
            api: None,
        })
        .unwrap();
        assert_eq!(view.provider, "gateway");
        assert_eq!(view.routing, "gateway");
        assert_eq!(view.model.as_deref(), Some("gpt-4o"));
        // On disk, gateway mode stores the openai provider + routing marker.
        let settings = read_settings();
        assert_eq!(settings.default_provider.as_deref(), Some("openai"));
        assert!(is_gateway_routing());
    });
}

#[test]
fn apply_direct_provider_disables_gateway_routing() {
    with_temp_vault_dir(|| {
        let view = apply(PiConfigInput {
            provider: "anthropic".to_owned(),
            model: Some("claude-sonnet-4-20250514".to_owned()),
            thinking_level: None,
            api_key: Some("sk-ant-test".to_owned()),
            base_url: None,
            api: None,
        })
        .unwrap();
        assert_eq!(view.provider, "anthropic");
        assert_eq!(view.routing, "direct");
        assert!(!is_gateway_routing());
        // The key is written to auth.json under the provider's auth key.
        assert!(auth_has_key("anthropic"));
    });
}

#[test]
fn claude_subscription_uses_pis_registered_anthropic_provider() {
    with_temp_dir(|| {
        let view = apply(PiConfigInput {
            provider: "claude-pro-max".to_owned(),
            model: Some("claude-sonnet-4-20250514".to_owned()),
            thinking_level: None,
            api_key: None,
            base_url: None,
            api: None,
        })
        .unwrap();
        assert_eq!(view.provider, "claude-pro-max");
        assert_eq!(
            read_settings().default_provider.as_deref(),
            Some("anthropic")
        );

        persist_turn_model("claude-pro-max/claude-opus-4-20250514").unwrap();
        assert_eq!(
            read_settings().default_provider.as_deref(),
            Some("anthropic")
        );
        assert_eq!(current().provider, "claude-pro-max");
    });
}

#[test]
fn managed_defaults_repair_legacy_claude_provider_id() {
    with_temp_dir(|| {
        let mut settings = PiSettings {
            default_provider: Some("claude-pro-max".to_owned()),
            default_model: Some("claude-sonnet-4-20250514".to_owned()),
            ..Default::default()
        };
        settings.extra.insert(
            ROUTING_KEY.to_owned(),
            Value::String(ROUTING_DIRECT.to_owned()),
        );
        write_settings(&settings).unwrap();

        ensure_managed_defaults().unwrap();
        let repaired = read_settings();
        assert_eq!(repaired.default_provider.as_deref(), Some("anthropic"));
        assert_eq!(current().provider, "claude-pro-max");
        assert_eq!(repaired.default_model, settings.default_model);
        ensure_managed_defaults().unwrap();
        assert_eq!(read_settings().default_provider, repaired.default_provider);
    });
}

#[test]
fn apply_custom_provider_writes_models_json() {
    with_temp_vault_dir(|| {
        apply(PiConfigInput {
            provider: "ollama".to_owned(),
            model: Some("llama3.1:8b".to_owned()),
            thinking_level: None,
            api_key: Some("ollama".to_owned()),
            base_url: Some("http://localhost:11434/v1".to_owned()),
            api: None,
        })
        .unwrap();
        let models = read_models();
        let entry = &models["providers"]["ollama"];
        assert_eq!(
            entry["apiKey"],
            secret_env::reference(&secret_env::provider_key_env("ollama"))
        );
        assert_eq!(provider_api_key("ollama").as_deref(), Some("ollama"));
        assert_eq!(entry["baseUrl"], "http://localhost:11434/v1");
        assert_eq!(entry["api"], "openai-completions");
        assert_eq!(entry["models"][0]["id"], "llama3.1:8b");
        assert!(!is_gateway_routing());
    });
}

#[test]
fn apply_chatgpt_provider_writes_native_core_proxy_config() {
    with_temp_dir(|| {
        let view = apply(PiConfigInput {
            provider: CHATGPT_PROVIDER_ID.to_owned(),
            model: Some("gpt-5.4".to_owned()),
            thinking_level: None,
            api_key: None,
            base_url: None,
            api: None,
        })
        .expect("activate native ChatGPT provider");

        assert_eq!(view.provider, CHATGPT_PROVIDER_ID);
        let entry = &read_models()["providers"][CHATGPT_PROVIDER_ID];
        assert_eq!(entry["api"], "openai-codex-responses");
        assert_eq!(entry["apiKey"], CHATGPT_PROXY_API_KEY);
        assert!(entry["headers"]["x-ryu-node-token"].is_string());
        assert_eq!(entry["models"][0]["id"], "gpt-6.1-sol");
        assert!(entry["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| { model.get("id").and_then(Value::as_str) == Some("gpt-5.4") }));
        assert!(
            entry["baseUrl"]
                .as_str()
                .is_some_and(|url| url.ends_with("/api/pi-config/chatgpt")),
            "native provider must point at Core's credential-resolving proxy"
        );
        assert_eq!(
            read_settings().default_provider.as_deref(),
            Some(CHATGPT_PROVIDER_ID)
        );
    });
}

/// A sidecar-declared provider round-trips: registered at the sidecar's loopback
/// port with ownership stamped, then removed again on deregistration.
#[test]
fn sidecar_provider_registers_and_deregisters() {
    with_temp_dir(|| {
        let spec = ProviderRegistrationSpec {
            id: "chatgpt-bridge".to_owned(),
            label: Some("ChatGPT bridge".to_owned()),
            api: None,
            base_path: None,
            models: vec!["gpt-5".to_owned()],
        };
        register_sidecar_provider("com.example.bridge", &spec, 7997, Some("ext-tok")).unwrap();

        let entry = read_models()["providers"]["chatgpt-bridge"].clone();
        assert_eq!(entry["baseUrl"], "http://127.0.0.1:7997/v1");
        assert_eq!(entry["api"], "openai-completions");
        assert_eq!(entry[PROVIDER_OWNER_FIELD], "com.example.bridge");
        assert_eq!(entry["models"][0]["id"], "gpt-5");
        // The ext-token MUST reach Pi as the apiKey: Pi calls baseUrl directly,
        // bypassing the ext-proxy, and the extension-host bootstrap 401s any request
        // without this exact bearer. models.json names it by reference; the value
        // rides in the Pi spawn environment and never touches the file.
        let env_name = secret_env::ext_token_env("chatgpt-bridge");
        assert_eq!(entry["apiKey"], secret_env::reference(&env_name));
        assert!(!fs::read_to_string(models_path())
            .unwrap()
            .contains("ext-tok"));
        assert!(secret_env::secret_env().contains(&(env_name.clone(), "ext-tok".to_owned())));

        assert!(deregister_sidecar_provider("com.example.bridge", "chatgpt-bridge").unwrap());
        assert!(read_models()["providers"].get("chatgpt-bridge").is_none());
        assert!(!secret_env::secret_env()
            .iter()
            .any(|(name, _)| name == &env_name));
    });
}

/// The boot purge: an unclean exit leaves a sidecar-owned entry holding a loopback
/// `baseUrl` and the plugin's minted ext token, and Pi dials that `baseUrl`
/// DIRECTLY — bypassing the ext-proxy and its registration gate — so if any other
/// process now holds the port it is handed the token and every request body. The
/// sweep must take every owned entry and leave hand-configured ones alone: the
/// ownership stamp is the whole authority for touching an entry.
#[test]
fn stale_owned_provider_entries_are_purged_at_boot() {
    with_temp_dir(|| {
        let spec = ProviderRegistrationSpec {
            id: "chatgpt-bridge".to_owned(),
            label: None,
            api: None,
            base_path: None,
            models: vec![],
        };
        register_sidecar_provider("com.example.bridge", &spec, 7997, Some("ext-tok")).unwrap();
        // A provider the USER configured by hand — no owner stamp, so not ours.
        let mut mine = Map::new();
        mine.insert(
            "baseUrl".to_owned(),
            Value::String("http://127.0.0.1:11434/v1".to_owned()),
        );
        upsert_provider("my-ollama", mine).unwrap();

        assert_eq!(purge_sidecar_providers().unwrap(), 1);

        let providers = read_models()["providers"].clone();
        assert!(
            providers.get("chatgpt-bridge").is_none(),
            "the stale sidecar entry (and its ext token) must be gone"
        );
        assert_eq!(
            providers["my-ollama"]["baseUrl"], "http://127.0.0.1:11434/v1",
            "an unowned, hand-configured provider must survive untouched"
        );

        // Idempotent: nothing owned left to purge.
        assert_eq!(purge_sidecar_providers().unwrap(), 0);
    });
}

// A `purged_sidecar_provider_is_absent_then_restored_on_reregister` test used to
// sit here, claiming to cover "defect 3, the state half". It did not: every call it
// made — `register_sidecar_provider`, `purge_sidecar_providers`, `read_models` — is
// pre-existing behavior covered by the two tests above, so reverting the defect-3
// fix (the `provides_provider` ⇒ eager-start coercion) in its entirety left it
// passing. A test that cannot fail for the defect it names is worse than no test:
// it reads as coverage. The coercion is a `sidecar::manifest_sidecar` concern and is
// covered there — `provider_declaring_sidecar_starts_eagerly_even_when_lazy` for the
// predicate, `apply_sidecars_gates_the_register_only_branch_on_starts_eagerly` for
// the call site that makes the predicate matter.

/// The load-bearing guard: a plugin may NOT claim a built-in provider id. Allowing
/// it would let a plugin repoint `openai-codex`'s baseUrl at its own server and
/// collect the user's live subscription token on the next request.
#[test]
fn sidecar_provider_cannot_override_builtin() {
    with_temp_dir(|| {
        let spec = ProviderRegistrationSpec {
            id: "openai-codex".to_owned(),
            label: None,
            api: None,
            base_path: None,
            models: vec![],
        };
        let err = register_sidecar_provider("com.evil.plugin", &spec, 9999, None).unwrap_err();
        assert!(
            err.to_string().contains("built-in"),
            "expected built-in collision refusal, got: {err}"
        );
        assert!(read_models()["providers"].get("openai-codex").is_none());
    });
}

/// A plugin may not hijack, or delete, a provider another owner created.
#[test]
fn sidecar_provider_respects_ownership() {
    with_temp_dir(|| {
        let spec = ProviderRegistrationSpec {
            id: "shared-id".to_owned(),
            label: None,
            api: None,
            base_path: None,
            models: vec![],
        };
        register_sidecar_provider("com.first.plugin", &spec, 7001, None).unwrap();

        let err = register_sidecar_provider("com.second.plugin", &spec, 7002, None).unwrap_err();
        assert!(
            err.to_string().contains("already owned by"),
            "expected ownership refusal, got: {err}"
        );
        // The original entry is untouched.
        assert_eq!(
            read_models()["providers"]["shared-id"]["baseUrl"],
            "http://127.0.0.1:7001/v1"
        );
        // And a non-owner cannot remove it.
        assert!(!deregister_sidecar_provider("com.second.plugin", "shared-id").unwrap());
        assert!(read_models()["providers"].get("shared-id").is_some());
    });
}

/// An id that is not a safe token is refused before it can reach the models file.
#[test]
fn sidecar_provider_rejects_unsafe_id() {
    with_temp_dir(|| {
        for bad in ["", "../escape", "Has-Caps", "with space", "sla/sh"] {
            let spec = ProviderRegistrationSpec {
                id: bad.to_owned(),
                label: None,
                api: None,
                base_path: None,
                models: vec![],
            };
            let err =
                register_sidecar_provider("com.example.bridge", &spec, 7003, None).unwrap_err();
            assert!(
                err.to_string().contains("not a safe token"),
                "id {bad:?} should be refused, got: {err}"
            );
        }
    });
}

/// A hand-configured provider (no owner stamp) is never adopted or clobbered.
#[test]
fn sidecar_provider_refuses_unowned_existing() {
    with_temp_dir(|| {
        configure_provider(ProviderConfigInput {
            provider: "handmade".to_owned(),
            api_key: None,
            base_url: Some("http://localhost:1234/v1".to_owned()),
            api: None,
            routing: None,
        })
        .unwrap();

        let spec = ProviderRegistrationSpec {
            id: "handmade".to_owned(),
            label: None,
            api: None,
            base_path: None,
            models: vec![],
        };
        let err = register_sidecar_provider("com.example.bridge", &spec, 7004, None).unwrap_err();
        assert!(
            err.to_string().contains("unowned provider"),
            "expected unowned refusal, got: {err}"
        );
        assert_eq!(
            read_models()["providers"]["handmade"]["baseUrl"],
            "http://localhost:1234/v1"
        );
    });
}

#[test]
fn unknown_provider_without_base_url_is_rejected() {
    with_temp_dir(|| {
        let err = apply(PiConfigInput {
            provider: "made-up".to_owned(),
            model: None,
            thinking_level: None,
            api_key: None,
            base_url: None,
            api: None,
        })
        .unwrap_err();
        assert!(err.to_string().contains("unknown provider"));
    });
}

#[test]
fn managed_defaults_fill_model_provider_and_disable_pi_skills() {
    with_temp_dir(|| {
        ensure_managed_defaults().unwrap();
        let settings = read_settings();
        // Fresh install (gateway-routed by default): a non-empty zero-key
        // default model + the gateway-redirected provider are written…
        let model = settings.default_model.clone().unwrap();
        assert!(!model.trim().is_empty());
        assert_eq!(settings.default_provider.as_deref(), Some("openai"));
        // …Pi's own skill auto-discovery is disabled…
        assert_eq!(
            settings.extra.get("skills"),
            Some(&json!([PI_SKILLS_DISABLED]))
        );
        // …and the model is declared on the gateway-pinned openai provider.
        let models = read_models();
        let declared = models["providers"]["openai"]["models"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let default = declared
            .iter()
            .find(|m| m["id"] == json!(model.clone()))
            .expect("default model declared");
        assert_eq!(default["api"], json!("openai-responses"));
        assert_eq!(default["contextWindow"], json!(128_000));
        assert_eq!(default["maxTokens"], json!(8_192));
        assert_eq!(
            default["cost"],
            json!({
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0
            })
        );
    });
}

#[test]
fn managed_defaults_do_not_clobber_user_choices() {
    with_temp_dir(|| {
        let _ = ensure_dir();
        fs::write(
            settings_path(),
            r#"{"defaultProvider":"openai","defaultModel":"my-model","skills":["+/keep/me"]}"#,
        )
        .unwrap();
        ensure_managed_defaults().unwrap();
        let settings = read_settings();
        assert_eq!(settings.default_model.as_deref(), Some("my-model"));
        assert_eq!(settings.extra.get("skills"), Some(&json!(["+/keep/me"])));
    });
}

/// The managed default that stops a brand-new chat opening with the whole
/// machine's skills list already sitting in it as an assistant message.
///
/// pi-acp's `getQuietStartup` defaults to **false**, so without this key it
/// builds a "## Skills" listing of all three skill roots (including the
/// hard-coded `~/.agents/skills`) on every `session/new` and emits it as an
/// `agent_message_chunk` — which Core then persists as an assistant row.
/// The `skills: ["!**"]` write next to it does NOT cover this: the bridge's
/// banner builder never consults the skills setting at all.
#[test]
fn managed_defaults_quiet_the_pi_startup_banner() {
    with_temp_dir(|| {
        ensure_managed_defaults().unwrap();
        assert_eq!(
            read_settings().extra.get(PI_QUIET_STARTUP),
            Some(&json!(true))
        );
    });
}

/// Same "an explicit user choice stands" guard the `skills` write has — and
/// it has to hold for the legacy key too, because `getQuietStartup` reads
/// `quietStartup` first but falls back to `quietStart`. Writing our default
/// alongside a user's `quietStart: false` would take precedence over it and
/// silently reverse their choice, which is the one failure mode a "only when
/// unset" guard exists to prevent.
#[test]
fn managed_defaults_respect_an_explicit_startup_banner_choice() {
    for key in [PI_QUIET_STARTUP, PI_QUIET_STARTUP_LEGACY] {
        with_temp_dir(|| {
            let _ = ensure_dir();
            fs::write(settings_path(), format!(r#"{{"{key}":false}}"#)).unwrap();
            ensure_managed_defaults().unwrap();
            let settings = read_settings();
            assert_eq!(
                settings.extra.get(key),
                Some(&json!(false)),
                "{key}: the user's choice must survive"
            );
            assert!(
                !(key == PI_QUIET_STARTUP_LEGACY && settings.extra.contains_key(PI_QUIET_STARTUP)),
                "the legacy key is what pi falls back to; writing the current \
                     one next to it would override the user's `false`"
            );
        });
    }
}

#[test]
fn managed_defaults_enable_codemode_without_overriding_a_tool_choice() {
    with_temp_dir(|| {
        ensure_managed_defaults().unwrap();
        assert_eq!(
            read_settings().extra.get(PI_DEFAULT_TOOLS),
            Some(&json!([PI_CODEMODE_DEFAULT_TOOL]))
        );
    });
    with_temp_dir(|| {
        let _ = ensure_dir();
        fs::write(settings_path(), r#"{"defaultTools":["-codemode"]}"#).unwrap();
        ensure_managed_defaults().unwrap();
        assert_eq!(
            read_settings().extra.get(PI_DEFAULT_TOOLS),
            Some(&json!(["-codemode"])),
            "an explicit tool selection must survive"
        );
    });
}

#[test]
fn persist_turn_model_gateway_openai_pick_is_persisted_and_declared() {
    with_temp_dir(|| {
        persist_turn_model("openai/gpt-4o").unwrap();
        let settings = read_settings();
        assert_eq!(settings.default_provider.as_deref(), Some("openai"));
        assert_eq!(settings.default_model.as_deref(), Some("gpt-4o"));
        let models = read_models();
        let declared = models["providers"]["openai"]["models"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(declared.iter().any(|m| m["id"] == json!("gpt-4o")));
    });
}

#[test]
fn persist_turn_model_gateway_skips_non_openai_providers() {
    with_temp_dir(|| {
        persist_turn_model("anthropic/claude-sonnet-4").unwrap();
        let settings = read_settings();
        // Gateway mode must not be flipped onto a direct provider by a pick.
        assert!(settings.default_model.is_none());
        assert!(settings.default_provider.is_none());
    });
}

#[test]
fn persist_turn_model_direct_mode_mirrors_pick() {
    with_temp_vault_dir(|| {
        apply(PiConfigInput {
            provider: "anthropic".to_owned(),
            model: Some("claude-3-5-haiku-20241022".to_owned()),
            thinking_level: None,
            api_key: Some("sk-ant-test".to_owned()),
            base_url: None,
            api: None,
        })
        .unwrap();
        persist_turn_model("anthropic/claude-sonnet-4-20250514").unwrap();
        let settings = read_settings();
        assert_eq!(settings.default_provider.as_deref(), Some("anthropic"));
        assert_eq!(
            settings.default_model.as_deref(),
            Some("claude-sonnet-4-20250514")
        );
        // Direct mode is preserved.
        assert!(!is_gateway_routing());
    });
}

#[test]
fn persist_turn_model_direct_switch_updates_logical_provider_before_account_capture() {
    with_temp_dir(|| {
        let mut settings = PiSettings::default();
        settings.extra.insert(
            ROUTING_KEY.to_owned(),
            Value::String(ROUTING_DIRECT.to_owned()),
        );
        settings
            .extra
            .insert(ACTIVE_KEY.to_owned(), Value::String("anthropic".to_owned()));
        write_settings(&settings).unwrap();

        // A requested SDK model configures a model-less direct installation.
        persist_turn_model("openai/gpt-4o-mini").unwrap();
        assert_eq!(current().provider, "openai");
        assert_eq!(current().model.as_deref(), Some("gpt-4o-mini"));
        assert_eq!(read_settings().default_provider.as_deref(), Some("openai"));
        assert!(!is_gateway_routing());

        persist_turn_model("custom-sdk/model-two").unwrap();
        assert_eq!(current().provider, "custom-sdk");
        assert_eq!(current().model.as_deref(), Some("model-two"));
        assert_eq!(
            read_settings().default_provider.as_deref(),
            Some("custom-sdk")
        );
        // An unqualified pick keeps the logical provider/account scope.
        persist_turn_model("model-three").unwrap();
        assert_eq!(current().provider, "custom-sdk");
        assert_eq!(current().model.as_deref(), Some("model-three"));
    });
}

#[test]
fn gateway_patch_merges_declared_models_instead_of_replacing() {
    with_temp_dir(|| {
        persist_turn_model("openai/model-a").unwrap();
        persist_turn_model("openai/model-b").unwrap();
        let models = read_models();
        let declared: Vec<String> = models["providers"]["openai"]["models"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|m| m["id"].as_str().map(str::to_owned))
            .collect();
        // Both picks stay declared so the user can switch back.
        assert!(declared.iter().any(|id| id == "model-a"));
        assert!(declared.iter().any(|id| id == "model-b"));
    });
}

#[test]
fn gateway_patch_upgrades_bare_default_model_metadata() {
    with_temp_dir(|| {
        let default_model = default_gateway_model();
        upsert_provider(
            "openai",
            json!({
                "api": "openai-completions",
                "models": [
                    { "id": default_model },
                    { "id": "gpt-4o" }
                ]
            })
            .as_object()
            .cloned()
            .unwrap(),
        )
        .unwrap();
        ensure_gateway_models_json().unwrap();
        let models = read_models();
        let declared = models["providers"]["openai"]["models"].as_array().unwrap();
        let default = declared
            .iter()
            .find(|m| m["id"] == json!(default_model))
            .expect("default model declared");
        assert_eq!(default["name"], json!("Gemma 4 E2B IT Q4_K_M"));
        assert_eq!(default["api"], json!("openai-responses"));
        assert_eq!(default["contextWindow"], json!(128_000));
        assert_eq!(default["maxTokens"], json!(8_192));
        assert!(declared
            .iter()
            .any(|m| { m["id"] == "gpt-4o" && m["api"] == "openai-responses" }));
    });
}

/// A saved or older-desktop selection of a RETIRED per-tier managed row
/// resolves to the single Ryu Router row instead of breaking.
#[test]
fn a_retired_tier_row_resolves_to_ryu_router() {
    for id in LEGACY_MANAGED_TIER_IDS {
        with_temp_dir(|| {
            let view = apply(PiConfigInput {
                provider: (*id).to_owned(),
                model: None,
                thinking_level: None,
                api_key: None,
                base_url: None,
                api: None,
            })
            .unwrap();
            assert_eq!(view.provider, MANAGED_OPENROUTER_ID, "{id}");
            assert_eq!(view.routing, "gateway", "{id} must stay metered");
            assert_eq!(view.model.as_deref(), Some(MANAGED_DEFAULT_MODEL));
            assert_eq!(read_settings().default_provider.as_deref(), Some("openai"));
        });
    }
}

/// The spawn-time migration rewrites a saved retired-tier selection: the
/// active row becomes Ryu Router and the saved alias becomes the real model
/// it named (or the default when Ryu Router does not list it).
#[test]
fn spawn_time_migration_moves_saved_tier_selections_to_ryu_router() {
    for (alias, expected) in [
        ("ryu-code/standard", "anthropic/claude-sonnet-4.5"),
        ("ryu-reasoning/standard", "openai/o3"),
        ("ryu-vision/max", "google/gemini-2.5-pro"),
        ("ryu-fast/max", MANAGED_DEFAULT_MODEL),
    ] {
        with_temp_dir(|| {
            let mut settings = read_settings();
            settings.extra.insert(
                ACTIVE_KEY.to_owned(),
                Value::String(MANAGED_ANTHROPIC_CREDITS_ID.to_owned()),
            );
            settings.default_provider = Some("openai".to_owned());
            settings.default_model = Some(alias.to_owned());
            write_settings(&settings).unwrap();

            ensure_managed_defaults().unwrap();

            let settings = read_settings();
            assert_eq!(
                settings.extra.get(ACTIVE_KEY).and_then(Value::as_str),
                Some(MANAGED_OPENROUTER_ID)
            );
            assert_eq!(settings.default_model.as_deref(), Some(expected), "{alias}");
        });
    }
    assert_eq!(
        migrate_legacy_tier_model("anthropic/claude-sonnet-4.5"),
        None
    );
    assert_eq!(migrate_legacy_tier_model("openrouter/auto"), None);
}

/// The catalog offers ONE managed provider, Ryu Router, carrying the
/// "Free"-eligible model list from the control plane's projection; no
/// retired tier row and no supplier is offered.
#[test]
fn the_catalog_offers_one_managed_ryu_router_row_with_its_free_models() {
    with_temp_dir(|| {
        let catalog = catalog();
        let providers = catalog["providers"].as_array().unwrap();
        let managed: Vec<_> = providers
            .iter()
            .filter(|p| p["managed"] == json!(true))
            .collect();
        assert_eq!(managed.len(), 1, "exactly one managed row");
        let row = managed[0];
        assert_eq!(row["id"], json!(MANAGED_OPENROUTER_ID));
        assert_eq!(row["label"], json!("Ryu Router"));
        assert_eq!(row["routingLocked"], json!(true));
        assert_eq!(row["configured"], json!(true));
        // The Free list is the control plane's projection: before the
        // first fetch it is empty (it under-promises), and it is always an
        // array of Ryu Router ids, never a supplier.
        let free = row["freeModels"].as_array().expect("freeModels is a list");
        assert!(
            free.iter()
                .all(|id| id.as_str().is_some_and(|id| id.contains('/'))),
            "{free:?}"
        );
        for id in LEGACY_MANAGED_TIER_IDS {
            assert!(
                providers.iter().all(|p| p["id"] != json!(id)),
                "{id} is retired"
            );
        }
        // A BYOK row is none of those things.
        let byok = providers.iter().find(|p| p["id"] == json!("anthropic"));
        if let Some(byok) = byok {
            assert_eq!(byok["managed"], json!(false));
            assert_eq!(byok["creditPool"], json!(""));
            assert_eq!(byok["freeModels"], json!([]));
        }
    });
}

/// A pool row keeps its curated model list instead of the Gateway's merged one.
///
/// Gateway discovery returns every configured provider's models in one flat
/// list with no provider or pool on any entry. Offering that under "Ryu Fast"
/// would put ids in front of the user that route somewhere else entirely and
/// silently bill a pool they hold nothing in.
#[test]
fn a_pool_row_does_not_take_the_gateways_merged_model_list() {
    with_temp_dir(|| {
        assert!(resolve_provider_discovery(MANAGED_CLOUDFLARE_ID, None).is_none());
        assert!(resolve_provider_discovery(MANAGED_BEDROCK_ID, None).is_none());
        assert!(resolve_provider_discovery(MANAGED_VERTEX_ID, None).is_none());
        assert!(resolve_provider_discovery(MANAGED_OPENAI_CREDITS_ID, None).is_none());
        assert!(resolve_provider_discovery(MANAGED_ANTHROPIC_CREDITS_ID, None).is_none());
        // The retail managed row still does — it has no curated list.
        assert!(resolve_provider_discovery(MANAGED_OPENROUTER_ID, None).is_some());
    });
}

/// A pool row's suggested models must reach that pool's supply, and must
/// never carry ANOTHER pool's prefix.
///
/// This is the money guard. Core cannot pin a provider — every Gateway-routed
/// row writes the same `defaultProvider: "openai"` pin — so the model id's
/// PREFIX is the only thing deciding which supply a turn bills, and a wrong id
/// bills a pool the user did not choose with no error anywhere.
///
/// Two rules, because the pools are not symmetric:
///
///  - A SEGREGATED pool must be reached by prefix (cloudflare, bedrock) or by
///    its explicit namespace (vertex, openai-credits, anthropic-credits). Its
///    ids are useless otherwise: with neither present they fall through to the
///    fleet's `default_provider`, which is the retail pool.
///  - The RESIDUAL pool (openrouter) is that fallback, so its ids legitimately
///    carry no prefix — `anthropic/claude-sonnet-4` is an OpenRouter id that
///    routes by falling through, and demanding a prefix of it would be
///    demanding a router row that must not exist (an `anthropic/` builtin
///    would re-home the id onto a provider that cannot even serve its dialect).
///    What it must NOT do is carry a segregated pool's prefix, which would
///    silently spend a donated allowance on retail traffic.
///
/// The prefixes are restated here as literals ON PURPOSE. Importing them would
/// make this test agree with a router change automatically, and agreeing
/// automatically is exactly what must not happen when the disagreement is
/// somebody's money.
#[test]
fn every_pool_row_model_reaches_its_own_supply() {
    // Mirrors the alias namespaces of `POOL_MODEL_ALIASES` (and the
    // segregated rows of `builtin_prefixes()` / `POOL_NAMESPACES`) in
    // crates/gateway/router/src/lib.rs. Pool rows offer only Ryu aliases.
    let segregated: &[(&str, &[&str])] = &[
        ("cloudflare", &["ryu-fast/"]),
        ("bedrock", &["ryu-frontier/"]),
        ("vertex", &["ryu-vision/"]),
        ("openai-credits", &["ryu-reasoning/"]),
        ("anthropic-credits", &["ryu-code/"]),
    ];
    /// The pool a request lands in when no builtin prefix claims the id.
    const RESIDUAL_POOL: &str = "openrouter";

    for meta in PROVIDERS.iter().filter(|m| !m.credit_pool.is_empty()) {
        assert!(
            !meta.suggested_models.is_empty(),
            "`{}` has no suggested models, and a pool row gets no discovery — \
                 the picker would show an empty list",
            meta.id
        );
        let own = segregated
            .iter()
            .find(|(pool, _)| *pool == meta.credit_pool);
        assert!(
            own.is_some() || meta.credit_pool == RESIDUAL_POOL,
            "provider `{}` claims pool `{}`, which the router has no builtin \
                 prefix for and which is not the residual pool — its traffic would \
                 fall through to `default_provider` and debit the wrong supply",
            meta.id,
            meta.credit_pool
        );
        for model in meta.suggested_models {
            if let Some((_, prefixes)) = own {
                // A managed tier never names its supplier: only the Ryu
                // alias form `ryu-<tier>/<lite|standard|max>` is offered.
                let size = model.rsplit_once('/').map(|(_, size)| size);
                assert!(
                    matches!(size, Some("lite" | "standard" | "max")),
                    "`{}` suggests `{model}`, which is not a Ryu model alias",
                    meta.id
                );
                assert!(
                    prefixes.iter().any(|p| model.starts_with(p)),
                    "`{}` suggests `{model}`, which carries no prefix routing to \
                         `{}` — that turn would fall through to the residual pool",
                    meta.id,
                    meta.credit_pool
                );
            } else {
                // The residual row: no prefix required, but it must not steal
                // a segregated pool's.
                for (pool, prefixes) in segregated {
                    assert!(
                        !prefixes.iter().any(|p| model.starts_with(p)),
                        "`{}` (residual) suggests `{model}`, which carries a \
                             `{pool}` prefix — retail traffic would silently spend \
                             the donated {pool} allowance",
                        meta.id
                    );
                }
                // Nor a pre-alias supplier prefix the router still honors.
                for prefix in ["@cf/", "anthropic.", "amazon.", "meta.", "mistral."] {
                    assert!(
                        !model.starts_with(prefix),
                        "`{}` (residual) suggests `{model}`, which routes to a \
                             donated pool by its `{prefix}` prefix",
                        meta.id
                    );
                }
            }
        }
    }
}

#[test]
fn managed_openrouter_activation_pins_gateway_and_defaults_auto() {
    with_temp_dir(|| {
        let view = apply(PiConfigInput {
            provider: MANAGED_OPENROUTER_ID.to_owned(),
            model: None,
            thinking_level: None,
            api_key: None,
            base_url: None,
            api: None,
        })
        .unwrap();
        // Logical active provider is reported as managed (not raw "openai").
        assert_eq!(view.provider, MANAGED_OPENROUTER_ID);
        assert_eq!(view.routing, "gateway");
        // Managed users default to the Auto Router.
        assert_eq!(view.model.as_deref(), Some(MANAGED_DEFAULT_MODEL));
        assert!(is_gateway_routing());
        // On disk it rides the openai gateway pin so egress is governed.
        let settings = read_settings();
        assert_eq!(settings.default_provider.as_deref(), Some("openai"));
        let models = read_models();
        assert!(models["providers"]["openai"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == json!(MANAGED_DEFAULT_MODEL)));
        assert!(PROVIDERS
            .iter()
            .find(|provider| provider.id == MANAGED_OPENROUTER_ID)
            .is_some_and(|provider| {
                provider
                    .suggested_models
                    .contains(&OPENROUTER_PARETO_CODE_MODEL_ID)
            }));
    });
}

#[test]
fn configure_provider_stores_key_without_activating() {
    with_temp_vault_dir(|| {
        // Fresh install is gateway-routed; configuring a BYOK provider must not
        // steal the active selection.
        let catalog = configure_provider(ProviderConfigInput {
            provider: "anthropic".to_owned(),
            api_key: Some("sk-ant-test".to_owned()),
            base_url: None,
            api: None,
            routing: None,
        })
        .unwrap();
        // Still gateway-active.
        assert!(is_gateway_routing());
        assert_eq!(current().provider, GATEWAY_PROVIDER_ID);
        // Key is stored + surfaced as configured, but not active.
        assert!(auth_has_key("anthropic"));
        let anthropic = catalog["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "anthropic")
            .unwrap();
        assert_eq!(anthropic["configured"], json!(true));
        assert_eq!(anthropic["active"], json!(false));
    });
}

#[test]
fn expanded_pi_builtin_api_key_providers_have_isolated_multi_account_catalogs() {
    with_temp_vault_dir(|| {
        let vault = accounts::AccountVault::in_memory().unwrap();
        for id in [
            "ant-ling",
            "baseten",
            "minimax-cn",
            "moonshotai-cn",
            "opencode",
            "opencode-go",
            "qwen-token-plan",
            "qwen-token-plan-cn",
            "qwen-token-plan-individual",
            "vercel-ai-gateway",
            "xiaomi",
            "xiaomi-token-plan-ams",
            "xiaomi-token-plan-cn",
            "xiaomi-token-plan-sgp",
            "zai-coding-cn",
        ] {
            for index in 0..2 {
                configure_provider(ProviderConfigInput {
                    provider: id.to_owned(),
                    api_key: Some(format!("{id}-synthetic-key-{index}")),
                    base_url: None,
                    api: None,
                    routing: Some(ROUTING_DIRECT.to_owned()),
                })
                .unwrap();
            }
            let scope = provider_account_scope(id).unwrap();
            assert_eq!(scope, accounts::provider_scope(id));
            for index in 0..2 {
                vault
                    .upsert(
                        &scope,
                        &format!("acct-{index}"),
                        &format!("Account {index}"),
                        accounts::KIND_API_KEY,
                        Some(Value::String(format!("{id}-synthetic-key-{index}"))),
                    )
                    .unwrap();
            }
            assert_eq!(
                vault.list(&scope).unwrap().len(),
                2,
                "{id} account scopes must be distinct"
            );
            let view = catalog();
            let row = view["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == id)
                .unwrap();
            assert_eq!(row["authKind"], "api-key");
            assert_eq!(row["configured"], true);
            assert_eq!(row["routing"], ROUTING_DIRECT);
            assert_eq!(row["custom"], false);
            assert_eq!(
                row["supportsDiscovery"], true,
                "{id} must expose its Pi catalog in the UI"
            );
            assert!(
                !view.to_string().contains("synthetic-key"),
                "catalog must not expose provider keys"
            );
            assert_eq!(current().provider, GATEWAY_PROVIDER_ID);
        }
    });
}

#[test]
fn same_api_key_capture_reuses_account_across_legacy_shapes_but_not_scopes() {
    let vault = accounts::AccountVault::in_memory().unwrap();
    vault
        .upsert(
            "provider:baseten",
            "original",
            "Original",
            accounts::KIND_API_KEY,
            Some(json!({"type":"api_key","key":"test-key"})),
        )
        .unwrap();
    assert_eq!(
        existing_api_key_account(
            &vault,
            "provider:baseten",
            &Value::String("test-key".to_owned())
        )
        .unwrap(),
        Some("original".to_owned())
    );
    assert_eq!(
        existing_api_key_account(
            &vault,
            "provider:baseten",
            &json!({"type":"api_key","key":"other-key"})
        )
        .unwrap(),
        None
    );
    assert_eq!(
        existing_api_key_account(
            &vault,
            "provider:xiaomi",
            &json!({"type":"api_key","key":"test-key"})
        )
        .unwrap(),
        None
    );
}

#[test]
fn legacy_plaintext_keys_are_sealed_and_replaced_by_references_on_materialize() {
    with_temp_vault_dir(|| {
        ensure_dir().unwrap();
        write_secret_file(
            &auth_path(),
            &json!({"anthropic": {"type": "api_key", "key": "sk-ant-legacy-fixture"}}).to_string(),
        )
        .unwrap();
        fs::write(
            models_path(),
            json!({"providers": {
                "my-vllm": {"baseUrl": "http://127.0.0.1:9/v1", "apiKey": "vllm-legacy-fixture"},
                "kiro": {"apiKey": "ryu-local-proxy", "headers": {"x-ryu-node-token": "node-legacy-fixture"}}
            }})
            .to_string(),
        )
        .unwrap();

        materialize_active_accounts();

        let auth_bytes = fs::read_to_string(auth_path()).unwrap();
        let models_bytes = fs::read_to_string(models_path()).unwrap();
        for secret in [
            "sk-ant-legacy-fixture",
            "vllm-legacy-fixture",
            "node-legacy-fixture",
        ] {
            assert!(!auth_bytes.contains(secret), "{secret} left in auth.json");
            assert!(
                !models_bytes.contains(secret),
                "{secret} left in models.json"
            );
        }
        assert_eq!(read_auth()["anthropic"], auth_key_reference("anthropic"));
        let models = read_models();
        assert_eq!(
            models["providers"]["my-vllm"]["apiKey"],
            secret_env::reference(&secret_env::provider_key_env("my-vllm"))
        );
        // Proxy sentinels are not secrets and stay as they are.
        assert_eq!(models["providers"]["kiro"]["apiKey"], "ryu-local-proxy");
        assert_eq!(
            models["providers"]["kiro"]["headers"]["x-ryu-node-token"],
            "${RYU_PI_NODE_TOKEN}"
        );
        // Readers resolve the references from the sealed vault.
        assert_eq!(
            auth_key_value("anthropic").as_deref(),
            Some("sk-ant-legacy-fixture")
        );
        assert_eq!(
            provider_api_key("my-vllm").as_deref(),
            Some("vllm-legacy-fixture")
        );
        let env = secret_env::secret_env();
        assert!(env.contains(&(
            secret_env::provider_key_env("anthropic"),
            "sk-ant-legacy-fixture".to_owned()
        )));
        assert!(env.contains(&(
            secret_env::provider_key_env("my-vllm"),
            "vllm-legacy-fixture".to_owned()
        )));

        // Idempotent: a second pass neither re-imports a reference as a key
        // nor duplicates the account.
        materialize_active_accounts();
        let vault = accounts::global().unwrap();
        assert_eq!(
            vault.count(&accounts::provider_scope("anthropic")).unwrap(),
            1
        );
        assert_eq!(read_auth()["anthropic"], auth_key_reference("anthropic"));
    });
}

#[test]
fn storing_an_api_key_without_the_sealed_vault_fails_closed() {
    with_temp_dir(|| {
        let error = set_auth_key_with_vault("anthropic", "sk-ant-unsealed", None).unwrap_err();
        assert!(!error.to_string().contains("sk-ant-unsealed"));
        assert!(
            !auth_path().exists()
                || !fs::read_to_string(auth_path())
                    .unwrap()
                    .contains("sk-ant-unsealed")
        );
        assert!(seal_custom_provider_key(None, "my-vllm", "vllm-unsealed").is_err());
    });
}

#[test]
fn a_masked_or_reference_api_key_keeps_the_stored_key() {
    with_temp_vault_dir(|| {
        configure_provider(ProviderConfigInput {
            provider: "anthropic".to_owned(),
            api_key: Some("sk-ant-kept".to_owned()),
            base_url: None,
            api: None,
            routing: None,
        })
        .unwrap();
        for echoed in [
            ryu_crypto::redact::REDACTED.to_owned(),
            "***".to_owned(),
            secret_env::reference(&secret_env::provider_key_env("anthropic")),
        ] {
            configure_provider(ProviderConfigInput {
                provider: "anthropic".to_owned(),
                api_key: Some(echoed),
                base_url: None,
                api: None,
                routing: None,
            })
            .unwrap();
            assert_eq!(auth_key_value("anthropic").as_deref(), Some("sk-ant-kept"));
        }
        let vault = accounts::global().unwrap();
        assert_eq!(
            vault.count(&accounts::provider_scope("anthropic")).unwrap(),
            1
        );
    });
}

#[test]
fn api_key_save_failure_keeps_the_previous_active_credential_and_reports_no_secret() {
    with_temp_dir(|| {
        let vault = accounts::AccountVault::in_memory().unwrap();
        let scope = accounts::provider_scope("baseten");
        set_auth_key_with_vault("baseten", "synthetic-original", Some(&vault)).unwrap();
        let before = read_auth();
        let original = vault.active_info(&scope).unwrap().unwrap();
        vault.reject_writes_for_test().unwrap();

        let failure =
            set_auth_key_with_vault("baseten", "synthetic-replacement", Some(&vault)).unwrap_err();

        assert_eq!(read_auth(), before);
        assert_eq!(vault.list(&scope).unwrap().len(), 1);
        assert_eq!(
            vault.active_info(&scope).unwrap().unwrap().account_id,
            original.account_id
        );
        assert!(!failure.to_string().contains("synthetic-replacement"));
        assert!(failure.to_string().contains("Could not store"));
    });
}

#[test]
fn configure_custom_provider_replaces_key_without_resending_endpoint() {
    with_temp_vault_dir(|| {
        configure_provider(ProviderConfigInput {
            provider: "custom-key-test".to_owned(),
            api_key: Some("synthetic-original-key".to_owned()),
            base_url: Some("https://models.example/v1".to_owned()),
            api: Some("openai-responses".to_owned()),
            routing: None,
        })
        .unwrap();
        upsert_provider(
            "custom-key-test",
            Map::from_iter([(
                "models".to_owned(),
                json!([{ "id": "model-a", "enabled": false }]),
            )]),
        )
        .unwrap();
        let catalog = configure_provider(ProviderConfigInput {
            provider: "custom-key-test".to_owned(),
            api_key: Some("synthetic-replacement-key".to_owned()),
            base_url: None,
            api: None,
            routing: None,
        })
        .unwrap();
        let models = read_models();
        let entry = &models["providers"]["custom-key-test"];
        assert_eq!(
            entry["apiKey"],
            secret_env::reference(&secret_env::provider_key_env("custom-key-test"))
        );
        let on_disk = fs::read_to_string(models_path()).unwrap();
        assert!(!on_disk.contains("synthetic-replacement-key"));
        assert!(!on_disk.contains("synthetic-original-key"));
        assert_eq!(
            provider_api_key("custom-key-test").as_deref(),
            Some("synthetic-replacement-key")
        );
        assert_eq!(entry["baseUrl"], "https://models.example/v1");
        assert_eq!(entry["api"], "openai-responses");
        assert_eq!(entry["models"][0]["enabled"], false);
        assert_eq!(current().provider, GATEWAY_PROVIDER_ID);
        assert!(!catalog.to_string().contains("synthetic-replacement-key"));
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};

                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base = format!("http://{}/v1", listener.local_addr().unwrap());
                upsert_provider(
                    "custom-key-test",
                    Map::from_iter([("baseUrl".to_owned(), json!(base))]),
                )
                .unwrap();
                let serve = tokio::spawn(async move {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = [0_u8; 2048];
                    let size = stream.read(&mut request).await.unwrap();
                    let request = String::from_utf8_lossy(&request[..size]).to_ascii_lowercase();
                    assert!(request.starts_with("get /v1/models http/1.1"));
                    assert!(request.contains("authorization: bearer synthetic-replacement-key"));
                    assert!(!request.contains("synthetic-original-key"));
                    let body = r#"{"data":[{"id":"model-b"}]}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                });
                assert_eq!(refresh_custom_provider_models("custom-key-test").await.unwrap(), 1);
                serve.await.unwrap();
                let models = read_models();
                assert_eq!(models["providers"]["custom-key-test"]["models"][0]["enabled"], false);
                assert_eq!(models["providers"]["custom-key-test"]["models"][1]["id"], "model-b");
            });
    });
}

#[test]
fn per_provider_routing_toggle_persists() {
    with_temp_vault_dir(|| {
        configure_provider(ProviderConfigInput {
            provider: "openai".to_owned(),
            api_key: Some("sk-test".to_owned()),
            base_url: None,
            api: None,
            routing: Some("gateway".to_owned()),
        })
        .unwrap();
        assert_eq!(provider_routing("openai"), "gateway");
        configure_provider(ProviderConfigInput {
            provider: "openai".to_owned(),
            api_key: None,
            base_url: None,
            api: None,
            routing: Some("direct".to_owned()),
        })
        .unwrap();
        assert_eq!(provider_routing("openai"), "direct");
    });
}

#[test]
fn managed_and_gateway_routing_cannot_be_flipped() {
    with_temp_dir(|| {
        // set_provider_routing is a no-op for locked providers.
        set_provider_routing(MANAGED_OPENROUTER_ID, "direct").unwrap();
        assert_eq!(provider_routing(MANAGED_OPENROUTER_ID), "gateway");
        assert_eq!(provider_routing(GATEWAY_PROVIDER_ID), "gateway");
    });
}

#[test]
fn remove_provider_clears_key_and_reverts_active() {
    with_temp_vault_dir(|| {
        apply(PiConfigInput {
            provider: "anthropic".to_owned(),
            model: Some("claude-sonnet-4-20250514".to_owned()),
            thinking_level: None,
            api_key: Some("sk-ant-test".to_owned()),
            base_url: None,
            api: None,
        })
        .unwrap();
        assert_eq!(current().provider, "anthropic");
        assert!(auth_has_key("anthropic"));

        remove_provider("anthropic").unwrap();
        // Key gone, active reverts to the managed/gateway default.
        assert!(!auth_has_key("anthropic"));
        assert_eq!(current().provider, GATEWAY_PROVIDER_ID);
        assert!(is_gateway_routing());
    });
}

#[test]
fn managed_provider_cannot_be_configured_or_removed() {
    with_temp_dir(|| {
        assert!(configure_provider(ProviderConfigInput {
            provider: MANAGED_OPENROUTER_ID.to_owned(),
            api_key: Some("nope".to_owned()),
            base_url: None,
            api: None,
            routing: None,
        })
        .is_err());
        assert!(remove_provider(GATEWAY_PROVIDER_ID).is_err());
    });
}

#[test]
fn subscription_account_credential_rejects_non_subscription_providers() {
    with_temp_dir(|| {
        let error = subscription_account_credential("openai", "acct-1")
            .expect_err("API-key providers must not enter the usage reader");
        assert!(error.to_string().contains("is not a subscription provider"));
    });
}

#[test]
fn discover_models_falls_back_when_provider_unknown_and_registry_offline() {
    // An unknown provider with the models.dev registry pointed at an
    // unreachable host: tier-1 (no url) and tier-2 (not in registry) both yield
    // nothing, so we get the tier-3 fallback with an empty model list. Free-text
    // entry covers this case in the UI. Deterministic + offline.
    with_temp_dir(|| {
        std::env::set_var("RYU_MODELS_DEV_URL", "http://127.0.0.1:1/none");
        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt.block_on(discover_models(DiscoverInput {
            provider: Some("definitely-not-a-provider-xyz".to_owned()),
            base_url: None,
            api_key: None,
            api: None,
        }));
        std::env::remove_var("RYU_MODELS_DEV_URL");
        assert_eq!(out["source"], "fallback");
        assert_eq!(out["models"].as_array().unwrap().len(), 0);
    });
}

#[test]
fn settings_round_trip_preserves_unknown_keys() {
    with_temp_dir(|| {
        let _ = ensure_dir();
        fs::write(settings_path(), r#"{"theme":"light","defaultModel":"old"}"#).unwrap();
        apply(PiConfigInput {
            provider: GATEWAY_PROVIDER_ID.to_owned(),
            model: Some("gpt-4o".to_owned()),
            thinking_level: None,
            api_key: None,
            base_url: None,
            api: None,
        })
        .unwrap();
        let settings = read_settings();
        // Unmanaged key survives.
        assert_eq!(
            settings.extra.get("theme").and_then(Value::as_str),
            Some("light")
        );
        assert_eq!(settings.default_model.as_deref(), Some("gpt-4o"));
    });
}

#[test]
fn disabling_a_model_records_only_that_model() {
    with_temp_dir(|| {
        let catalog = set_model_enabled(ModelEnabledInput {
            provider: "openai".to_owned(),
            model: "gpt-4o".to_owned(),
            enabled: false,
        })
        .expect("toggle");
        let openai = catalog["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "openai")
            .expect("openai row");
        assert_eq!(openai["modelOverrides"]["gpt-4o"], json!(false));
        // Untoggled models stay absent — absent means enabled, so an existing
        // config keeps every model it had before the feature existed.
        assert!(openai["modelOverrides"].as_object().unwrap().len() == 1);

        // Re-enabling records `true` rather than deleting, which is what lets
        // the desktop show the switch as explicitly on.
        let catalog = set_model_enabled(ModelEnabledInput {
            provider: "openai".to_owned(),
            model: "gpt-4o".to_owned(),
            enabled: true,
        })
        .expect("re-enable");
        let openai = catalog["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "openai")
            .expect("openai row");
        assert_eq!(openai["modelOverrides"]["gpt-4o"], json!(true));
    });
}

#[test]
fn agent_model_overrides_are_scoped_and_never_look_like_a_provider() {
    with_temp_dir(|| {
        let catalog = set_model_enabled(ModelEnabledInput {
            provider: format!("{AGENT_OVERRIDE_PREFIX}claude"),
            model: "claude-haiku-4-5".to_owned(),
            enabled: false,
        })
        .expect("toggle an agent's model");

        // Surfaced under its own map, keyed by the bare agent id.
        assert_eq!(
            catalog["agentModelOverrides"]["claude"]["claude-haiku-4-5"],
            json!(false)
        );

        // …and NOT as a custom provider. A leaked `agent:claude` row would
        // render an unconfigured provider in the picker and the providers tab,
        // and would be accepted as a routing target.
        let ids: Vec<&str> = catalog["providers"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["id"].as_str())
            .collect();
        assert!(
            !ids.iter().any(|id| id.starts_with(AGENT_OVERRIDE_PREFIX)),
            "agent scopes must not appear as providers: {ids:?}"
        );
        assert!(
            !custom_provider_ids()
                .iter()
                .any(|id| id.starts_with(AGENT_OVERRIDE_PREFIX)),
            "agent scopes must not be treated as custom providers"
        );
    });
}

#[test]
fn gateway_discovery_offers_only_chat_rows_to_the_model_picker() {
    // The Gateway's `/v1/models` merges OpenRouter's whole catalog, labelling
    // every non-chat row. None of those can serve as an agent's chat model.
    let body = json!({
        "object": "list",
        "data": [
            { "id": "openrouter/auto", "name": "Auto Router", "modality": "chat" },
            { "id": "gpt-4o", "owned_by": "openai" },
            { "id": "openrouter/elevenlabs/eleven-v3", "modality": "tts" },
            { "id": "openrouter/openai/whisper-1", "modality": "stt" },
            { "id": "openrouter/google/veo-3.1", "modality": "video" },
            { "id": "openrouter/voyageai/voyage-4", "modality": "embedding" },
            { "id": "openrouter/cohere/rerank-v3.5", "modality": "rerank" },
            { "id": "openrouter/google/gemini-2.5-flash-image", "modality": "image" }
        ]
    });
    assert_eq!(
        parse_discovered_models(&body),
        vec![
            json!({ "id": "openrouter/auto", "name": "Auto Router" }),
            json!({ "id": "gpt-4o" }),
        ]
    );
}

#[test]
fn provider_discovery_rejects_loopback_before_connecting() {
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let error = runtime
        .block_on(fetch_models(
            "http://127.0.0.1:1/models",
            DiscoveryAuth::None,
            false,
        ))
        .expect_err("custom provider checks must reject loopback");
    assert!(
        error.to_string().contains("screen discovery endpoint"),
        "unexpected loopback rejection: {error}"
    );
}
