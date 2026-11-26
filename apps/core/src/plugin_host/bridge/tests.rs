use super::*;

#[test]
fn manual_run_guard_refuses_a_second_claim_and_releases_on_drop() {
    let key = format!("test-plugin:user:conv-{}", uuid::Uuid::new_v4().simple());
    let first = ManualRunGuard::claim(&key).expect("first claim");
    assert!(ManualRunGuard::claim(&key).is_none());
    drop(first);
    assert!(ManualRunGuard::claim(&key).is_some());
}

/// A dropped handler future (client disconnect, an outer sandbox timeout)
/// must release the slot; the old begin/end pair left it claimed forever.
#[tokio::test]
async fn manual_run_slot_is_released_when_the_run_is_cancelled() {
    let key = format!("test-plugin:user:conv-{}", uuid::Uuid::new_v4().simple());
    let (claimed_tx, claimed_rx) = tokio::sync::oneshot::channel();
    let run_key = key.clone();
    let run = tokio::spawn(async move {
        let _slot = ManualRunGuard::claim(&run_key).expect("claim");
        let _ = claimed_tx.send(());
        std::future::pending::<()>().await;
    });
    claimed_rx.await.expect("the run holds its slot");
    assert!(ManualRunGuard::claim(&key).is_none());
    run.abort();
    let _ = run.await;
    assert!(
        ManualRunGuard::claim(&key).is_some(),
        "a cancelled run must release its slot"
    );
}

#[test]
fn execution_control_rejects_non_admin_and_cross_org_callers() {
    let mut caller = crate::identity_verify::VerifiedCaller {
        user_id: "user".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org".to_owned()),
        role: crate::identity_verify::OrgRole::Viewer,
        teams: vec![],
    };
    assert!(!is_org_admin(None, "org"));
    assert!(!is_org_admin(Some(&caller), "org"));
    caller.role = crate::identity_verify::OrgRole::Admin;
    assert!(is_org_admin(Some(&caller), "org"));
    assert!(!is_org_admin(Some(&caller), "other-org"));
    caller.org_id = None;
    assert!(!is_org_admin(Some(&caller), "org"));
}

// We can exercise the pure gating logic without a ServerState by checking the
// grant-set membership directly through the constants the bridge uses; the
// full async path is covered by the live double-check verification (M7).
#[test]
fn grant_constants_are_stable() {
    assert_eq!(GRANT_CATALOG, "core:list_agents");
    assert_eq!(GRANT_SIDE_MODEL, "hook:side-model");
    assert_eq!(GRANT_STORAGE, "storage:kv");
    assert_eq!(GRANT_RUN_AGENT, "hook:run-agent");
    assert_eq!(GRANT_SPACES, "spaces:docs");
    assert_eq!(GRANT_SPACES_DATABASE, "spaces:database");
    assert_eq!(GRANT_SET_TITLE, "conversation:set-title");
    assert_eq!(GRANT_PREFERENCES_READ, "preferences:read");
    assert_eq!(GRANT_BACKGROUND_CONTROL, "background:control");
    assert_eq!(GRANT_NOTIFY, "notifications:send");
    assert_eq!(GRANT_NOTIFY_TARGET, "notifications:send-to-user");
}

#[test]
fn preference_host_reads_reject_credential_keys() {
    assert!(crate::server::preferences::is_secret_preference_key(
        "openrouter-api-key"
    ));
    assert!(crate::server::preferences::is_secret_preference_key(
        "node-onboarding-state"
    ));
    assert!(!crate::server::preferences::is_secret_preference_key(
        "theme"
    ));
}

#[test]
fn catalog_provider_projection_never_exposes_account_identity() {
    let projected = project_catalog_provider(&json!({
        "id": "openai",
        "label": "OpenAI",
        "accounts": [{
            "accountId": "personal",
            "label": "person@example.com",
            "kind": "oauth",
            "active": true,
            "updatedAt": 123,
        }],
    }));
    assert_eq!(projected.get("id").and_then(Value::as_str), Some("openai"));
    assert!(projected.get("accounts").is_none());
    assert!(!projected.to_string().contains("person@example.com"));
}

#[test]
fn side_model_images_are_bounded_by_count_type_and_size() {
    let png = "data:image/png;base64,aGVsbG8=";
    assert!(validate_side_model_images(&json!({})).unwrap().is_empty());
    assert_eq!(
        validate_side_model_images(&json!({ "images": [png, "data:image/jpeg;base64,aGk=", "data:image/webp;base64,aGk="] }))
            .unwrap()
            .len(),
        3
    );
    let too_many = vec![png; MAX_SIDE_MODEL_IMAGES + 1];
    assert!(validate_side_model_images(&json!({ "images": too_many }))
        .unwrap_err()
        .contains("at most 8"));
    for bad in [
        json!({ "images": "data:image/png;base64,aGk=" }),
        json!({ "images": [42] }),
        json!({ "images": ["https://example.test/a.png"] }),
        json!({ "images": ["data:image/svg+xml;base64,PHN2Zz4="] }),
        json!({ "images": ["data:image/gif;base64,R0lGOA=="] }),
        json!({ "images": ["data:image/png;base64,"] }),
        json!({ "images": ["data:image/png;base64,not base64!"] }),
    ] {
        assert!(validate_side_model_images(&bad).is_err(), "{bad}");
    }
    // Each image under the cap, but together over it.
    let chunk = format!(
        "data:image/png;base64,{}",
        "A".repeat(MAX_SIDE_MODEL_IMAGE_BYTES / 2)
    );
    assert!(validate_side_model_images(&json!({ "images": [chunk.clone()] })).is_ok());
    assert!(
        validate_side_model_images(&json!({ "images": [chunk.clone(), chunk] }))
            .unwrap_err()
            .contains("1.5 MiB")
    );
}

#[test]
fn side_model_request_is_bounded_by_its_encoded_size() {
    // Within every per-field limit, but escaped text plus a full image
    // budget encodes past the Gateway's 2 MiB chat body limit.
    let escaped = "\u{1}".repeat(64 * 1024);
    let image = format!(
        "data:image/png;base64,{}",
        "A".repeat(MAX_SIDE_MODEL_IMAGE_BYTES - 64)
    );
    let images = validate_side_model_images(&json!({ "images": [image] })).unwrap();
    let payload = crate::server::side_model_payload("m", "", &escaped, &escaped, &images);
    let error = crate::server::encode_side_model_request(&payload).unwrap_err();
    assert!(error.contains("2 MiB chat request limit"), "{error}");

    let fits = crate::server::side_model_payload("m", "", "system", "describe", &images);
    let bytes = crate::server::encode_side_model_request(&fits).unwrap();
    assert!(bytes.len() <= crate::server::MAX_SIDE_MODEL_REQUEST_BYTES);
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), fits);
}

#[test]
fn side_model_payload_uses_image_url_parts_only_when_images_are_present() {
    let plain = crate::server::side_model_payload("m", "", "sys", "describe", &[]);
    assert_eq!(plain["messages"][1]["content"], json!("describe"));
    assert!(plain.get("reasoning_effort").is_none());

    let images = vec![
        "data:image/png;base64,aGVsbG8=".to_owned(),
        "data:image/jpeg;base64,aGk=".to_owned(),
    ];
    let vision = crate::server::side_model_payload("m", "low", "sys", "tag these", &images);
    assert_eq!(
        vision["messages"][0],
        json!({ "role": "system", "content": "sys" })
    );
    assert_eq!(
        vision["messages"][1]["content"],
        json!([
            { "type": "text", "text": "tag these" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,aGVsbG8=" } },
            { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,aGk=" } },
        ])
    );
    assert_eq!(vision["reasoning_effort"], json!("low"));
    assert_eq!(vision["stream"], json!(false));
}

#[test]
fn fanout_token_cap_is_hard_bounded() {
    let caps = DelegationCaps {
        max_tokens: u32::MAX,
        ..Default::default()
    };
    assert_eq!(caps.effective_max_tokens(), MAX_DELEGATION_TOKENS);
    assert_eq!(DelegationCaps::default().effective_max_tokens(), 4096);
}

/// The bridge's local grant consts MUST equal the single-sourced grant the
/// `ryu-kernel-contracts` host-API table assigns to the corresponding method,
/// so this gate and the TS app host / `required_grant_for` never drift. Each
/// const family maps to one representative method in the table. (`GRANT_NAVIGATE`
/// is intentionally absent: `host.navigate` is a broker verb, not an
/// `/api/plugins/:id/host` RPC method, so it has no row in the table.)
#[test]
fn grant_constants_match_kernel_contracts_table() {
    use ryu_kernel_contracts::host_api::grant_for;
    assert_eq!(grant_for("catalog.snapshot"), Some(GRANT_CATALOG));
    assert_eq!(grant_for("catalog.models"), Some(GRANT_CATALOG));
    assert_eq!(grant_for("model.complete"), Some(GRANT_SIDE_MODEL));
    assert_eq!(grant_for("agent.run"), Some(GRANT_RUN_AGENT));
    assert_eq!(grant_for("storage.get"), Some(GRANT_STORAGE));
    assert_eq!(grant_for("spaces.createDoc"), Some(GRANT_SPACES));
    assert_eq!(
        grant_for("spaces.queryDatabase"),
        Some(GRANT_SPACES_DATABASE)
    );
    assert_eq!(
        grant_for("spaces.deleteDatabase"),
        Some(GRANT_SPACES_DATABASE)
    );
    // `finetune.*` keeps its host-API grant row (host API is additive within a
    // major) but has no Core bridge path: hosts forward it to the app's own
    // sidecar through the generic ext-proxy.
    assert_eq!(grant_for("finetune.start"), Some("finetune:runs"));
    assert_eq!(dispatch_path_for("finetune.start"), None);
    assert_eq!(grant_for("conversation.setTitle"), Some(GRANT_SET_TITLE));
    assert_eq!(
        grant_for("conversation.addReaction"),
        Some(GRANT_CONVERSATION_REACTIONS)
    );
    assert_eq!(grant_for("preferences.get"), Some(GRANT_PREFERENCES_READ));
    assert_eq!(grant_for("background.list"), Some(GRANT_BACKGROUND_CONTROL));
    assert_eq!(grant_for("gateway.budgetSpend"), Some(GRANT_USAGE_READ));
    assert_eq!(grant_for("gateway.audit"), Some(GRANT_USAGE_AUDIT));
    assert_ne!(grant_for("gateway.audit"), grant_for("usage.snapshot"));
    assert_eq!(grant_for("usage.snapshot"), Some(GRANT_USAGE_READ));
    assert_eq!(
        grant_for("subscriptions.list"),
        Some(GRANT_SUBSCRIPTIONS_READ)
    );
    assert_eq!(
        grant_for("subscriptions.usage"),
        Some(GRANT_SUBSCRIPTIONS_READ)
    );
    assert_eq!(grant_for("notifications.send"), Some(GRANT_NOTIFY_TARGET));
}

/// Every method `dispatch_path_for` maps MUST (a) carry a grant in the
/// single-sourced kernel-contracts table (so `/api/host/rpc` can always grant-gate
/// it) and (b) resolve to a `host.*` path the bridge's `handle_inner` actually
/// matches. The bridge deliberately dispatches a SUBSET of the grant families
/// (e.g. `agent.cancel` / `*.stream` are not unary-bridged), so we assert the
/// forward direction — a mapped method is always grantable + handled — rather than
/// requiring every grant-family method to have a path.
#[test]
fn dispatch_paths_are_grantable_and_handled() {
    use ryu_kernel_contracts::host_api::{grant_for, HOST_API_METHODS};
    for m in HOST_API_METHODS {
        let Some(path) = dispatch_path_for(m.method) else {
            continue;
        };
        assert!(
            grant_for(m.method).is_some(),
            "dispatch path for '{}' but no grant in the kernel-contracts table",
            m.method
        );
        let internal = path
            .strip_prefix("host.")
            .expect("dispatch path is host.<...>");
        assert!(
            handled_method(internal),
            "dispatch path '{path}' for '{}' is not matched by the bridge",
            m.method
        );
    }
}

/// Positive coverage: every bridge capability family has at least one representative
/// method that maps, so a family accidentally dropped from `dispatch_path_for` is
/// caught.
#[test]
fn dispatch_path_covers_every_bridge_family() {
    for method in [
        "catalog.snapshot",
        "catalog.models",
        "model.complete",
        "agent.run",
        "agent.runFanout",
        "storage.get",
        "spaces.createDoc",
        "spaces.createDatabase",
        "conversation.setTitle",
        "conversation.addReaction",
        "preferences.get",
        "background.list",
        "background.stop",
        "gateway.budgetSpend",
        "gateway.audit",
        "subscriptions.list",
        "subscriptions.usage",
    ] {
        assert!(
            dispatch_path_for(method).is_some(),
            "missing dispatch path for representative method '{method}'"
        );
    }
}

/// The set of `host.<method>` names `handle_inner` matches (kept in sync with the
/// `match` in that fn). Used to prove every `dispatch_path_for` target is real.
fn handled_method(m: &str) -> bool {
    matches!(
        m,
        "security_check"
            | "identity_current"
            | "authorization_issue"
            | "authorization_check"
            | "execution_pause"
            | "execution_resume"
            | "execution_status"
            | "catalogSnapshot"
            | "catalogModels"
            | "sideModel"
            | "runAgent"
            | "runFanout"
            | "backups_destinations"
            | "backups_create"
            | "backups_list"
            | "backups_get"
            | "backups_restore"
            | "storage_get"
            | "storage_set"
            | "storage_delete"
            | "storage_keys"
            | "storage_compare_and_set"
            | "crypto_seal"
            | "crypto_open"
            | "crypto_status"
            | "spaces_search"
            | "spaces_ensure_space"
            | "spaces_create_doc"
            | "spaces_get_doc"
            | "spaces_update_doc"
            | "spaces_list_docs"
            | "spaces_delete_doc"
            | "spaces_create_database"
            | "spaces_list_databases"
            | "spaces_get_database"
            | "spaces_update_database"
            | "spaces_query_database"
            | "spaces_delete_database"
            | "setConversationTitle"
            | "addMessageReaction"
            | "getPreference"
            | "usageSnapshot"
            | "subscriptions_list"
            | "subscriptions_usage"
            | "gatewayBudgetSpend"
            | "gatewayAudit"
            | "background_list"
            | "background_stop"
            | "recordFeedback"
            | "synthesizeSkill"
            | "runHook"
            | "notify"
            | "notifications_send"
            | "navigate"
    )
}

#[test]
fn dispatch_path_rejects_unknown_method() {
    assert_eq!(dispatch_path_for("widget.setState"), None);
    assert_eq!(dispatch_path_for("nonsense.method"), None);
    assert_eq!(dispatch_path_for("model.complete"), Some("host.sideModel"));
}

#[test]
fn subscriptions_gate_denies_missing_grant_before_checking_the_caller() {
    let error = subscriptions_gate("com.x.app", false, || {
        panic!("the caller check must not run without the grant")
    })
    .expect_err("ungranted");
    assert!(
        error.starts_with("capability 'subscriptions:read' not granted"),
        "{error}"
    );
}

#[test]
fn subscriptions_gate_denies_a_non_admin_caller() {
    assert_eq!(
        subscriptions_gate("com.x.app", true, || false),
        Err("subscriptions are visible to the node owner only".to_owned())
    );
    assert_eq!(subscriptions_gate("com.x.app", true, || true), Ok(()));
}

#[test]
fn subscriptions_args_reject_unknown_fields_and_force() {
    assert!(serde_json::from_value::<SubscriptionsListArgs>(json!({})).is_ok());
    assert!(serde_json::from_value::<SubscriptionsListArgs>(json!({ "provider": "x" })).is_err());
    assert!(serde_json::from_value::<SubscriptionsUsageArgs>(
        json!({ "providerId": "claude-pro-max", "accountId": "acct_1", "label": true })
    )
    .is_err());
    assert!(serde_json::from_value::<SubscriptionsUsageArgs>(json!({})).is_err());
    assert!(parse_list_usage(Some("force")).is_err());
    assert_eq!(
        parse_list_usage(None),
        Ok(crate::subscriptions::UsageMode::Cached)
    );
    assert_eq!(
        parse_list_usage(Some("refresh")),
        Ok(crate::subscriptions::UsageMode::Refresh)
    );
    assert!(validate_subscription_id("providerId", "").is_err());
    assert!(validate_subscription_id("providerId", &"a".repeat(257)).is_err());
    assert!(validate_subscription_id("providerId", &"a".repeat(256)).is_ok());
}

#[test]
fn subscription_live_reads_are_limited_per_plugin_provider_and_account() {
    let limiter = LiveReadLimiter::default();
    let start = std::time::Instant::now();
    let interval = SUBSCRIPTION_LIVE_READ_INTERVAL;
    let key = |plugin: &str, account: &str| {
        (
            plugin.to_owned(),
            "claude-pro-max".to_owned(),
            account.to_owned(),
        )
    };
    assert!(limiter.try_acquire(key("a", "acct_1"), start, interval));
    assert!(!limiter.try_acquire(key("a", "acct_1"), start, interval));
    assert!(limiter.try_acquire(key("a", "acct_2"), start, interval));
    assert!(limiter.try_acquire(key("b", "acct_1"), start, interval));
    assert!(limiter.try_acquire(key("a", "acct_1"), start + interval, interval));
}

#[test]
fn usage_args_accept_exactly_one_form() {
    assert_eq!(
        parse_usage_args(&json!({ "agent_id": " claude " })),
        Ok(UsageArgs::Agent("claude"))
    );
    assert_eq!(
        parse_usage_args(&json!({ "provider_id": "claude-pro-max" })),
        Ok(UsageArgs::Provider {
            provider_id: "claude-pro-max",
            account_id: None
        })
    );
    assert_eq!(
        parse_usage_args(&json!({ "provider_id": "claude-pro-max", "account_id": "acct_1" })),
        Ok(UsageArgs::Provider {
            provider_id: "claude-pro-max",
            account_id: Some("acct_1")
        })
    );
    for invalid in [
        json!({ "agent_id": "claude", "provider_id": "claude-pro-max" }),
        json!({ "agent_id": "claude", "account_id": "acct_1" }),
        json!({ "account_id": "acct_1" }),
        json!({ "agent_id": "" }),
        json!({ "provider_id": "" }),
        json!({ "provider_id": 7 }),
        json!({}),
    ] {
        assert!(
            parse_usage_args(&invalid).is_err(),
            "{invalid} must be rejected"
        );
    }
}
