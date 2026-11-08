use super::*;

#[test]
fn stored_id_settlement_charges_org_member_team_key_and_service_account_scopes() {
    let state = AppState::new_for_test_default();
    let subject = crate::org_limits::OrgLimitSubject {
        org_id: "org1".into(),
        user_id: Some("u1".into()),
        team_ids: vec!["t1".into(), "t2".into()],
        credential_id: Some("cred1".into()),
        service_account_id: Some("sa1".into()),
        tags: vec!["eu".into()],
        budgeted_tags: vec!["eu".into()],
        project_id: Some("p1".into()),
        bot_id: Some("bot1".into()),
    };
    // An async video completion / external-tool receipt settles from
    // stored ids, after the request context is gone.
    record_charged_budget_for_ids(
        &state,
        "owner",
        Some("org1"),
        Some("u1"),
        None,
        None,
        BudgetChargeKind::Media,
        40,
        Some(&subject),
    );
    let now = crate::budget::unix_now();
    let spent = |scope: &str, id: &str| {
        state
            .spend_store
            .spent(scope, id, crate::budget::BudgetWindow::Monthly, now)
    };
    assert_eq!(spent("org", "org1"), 40);
    assert_eq!(spent("member", "org1:u1"), 40);
    assert_eq!(spent("team", "org1:t1"), 40);
    // Builder tags count under their own scope (Treg parity C6).
    assert_eq!(spent("tag", "org1:eu"), 40);
    assert_eq!(spent("team", "org1:t2"), 40);
    assert_eq!(spent("key", "cred1"), 40);
    assert_eq!(spent("service_account", "org1:sa1"), 40);
    assert_eq!(spent("project", "org1:p1"), 40);
    assert_eq!(spent("bot", "org1:bot1"), 40);
}

#[test]
fn account_affinity_isolates_callers_and_ambiguous_scope_segments() {
    let mut first = test_support::plain_request_context();
    first.org_id = Some("org".into());
    first.user_id = Some("first".into());
    let body = json!({"conversation_id":"shared"});
    let first_affinity = account_affinity(&first, &body).unwrap();
    let mut second = first.clone();
    second.user_id = Some("second".into());
    assert_ne!(first_affinity, account_affinity(&second, &body).unwrap());
    first.user_id = None;
    second.user_id = None;
    second.owner_binding = "another-credential".into();
    assert_ne!(
        account_affinity(&first, &body),
        account_affinity(&second, &body)
    );
    first.org_id = Some("a".into());
    first.user_id = Some("bc".into());
    second.org_id = Some("ab".into());
    second.user_id = Some("c".into());
    assert_ne!(
        account_affinity(&first, &body),
        account_affinity(&second, &body)
    );
    let affinity = account_affinity(&first, &body).unwrap();
    let (length, suffix) = affinity.split_once(':').unwrap();
    let length: usize = length.parse().unwrap();
    assert_eq!(&suffix[length..], "shared");
    assert_eq!(account_affinity(&first, &body), Some(affinity));
}

#[test]
fn litellm_caller_routing_overrides_are_stripped_before_dispatch() {
    let state = AppState::new_for_test_default();
    let ctx = test_support::plain_request_context();
    let mut body = serde_json::json!({
        "model": "router/cheap",
        "messages": [],
        "fallbacks": ["gpt-5-pro"],
        "mock_testing_fallbacks": true,
        "context_window_fallbacks": [{"router/cheap": ["big"]}],
        "user_config": {"model_list": []},
        "temperature": 0.2
    });
    let restored = apply_node_openrouter_preferences(&state, &ctx, "litellm", &mut body, true);
    assert_eq!(restored, (None, None));
    assert_eq!(
        body,
        serde_json::json!({"model": "router/cheap", "messages": [], "temperature": 0.2})
    );

    // Other providers keep their bodies untouched by this rule.
    let mut other = serde_json::json!({"model": "gpt-4o", "fallbacks": ["x"]});
    apply_node_openrouter_preferences(&state, &ctx, "openai", &mut other, true);
    assert_eq!(other["fallbacks"], serde_json::json!(["x"]));
}

#[test]
fn openrouter_fallbacks_enforce_policy_for_defaults_and_explicit_models() {
    let state = AppState::new_for_test_default();
    let mut ctx = test_support::plain_request_context();
    ctx.openrouter_routing_enabled = true;
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_models: vec!["approved".into(), "second".into()],
        ..Default::default()
    });
    ctx.node_routing = Some(node_routing::NodeRoutingPrefs {
        openrouter_model_fallbacks: vec!["blocked".into(), "approved".into(), "second".into()],
        ..Default::default()
    });
    let mut defaults = json!({"model":"approved"});
    apply_node_openrouter_preferences(&state, &ctx, "openrouter", &mut defaults, true);
    assert_eq!(defaults["models"], json!(["approved", "second"]));
    for include_defaults in [false, true] {
        let mut explicit = json!({"model":"approved","models":["blocked","second",7,"approved"]});
        apply_node_openrouter_preferences(
            &state,
            &ctx,
            "openrouter",
            &mut explicit,
            include_defaults,
        );
        assert_eq!(explicit["models"], json!(["second", "approved"]));
    }
    for models in [json!(["blocked"]), json!({"model":"blocked"})] {
        let mut body = json!({"model":"approved","models":models});
        apply_node_openrouter_preferences(&state, &ctx, "openrouter", &mut body, true);
        assert!(body.get("models").is_none());
        assert_eq!(body["model"], "approved");
    }
    ctx.is_master_key = true;
    let mut admin = json!({"models":["blocked","approved"]});
    apply_node_openrouter_preferences(&state, &ctx, "openrouter", &mut admin, true);
    assert_eq!(admin["models"], json!(["blocked", "approved"]));
    ctx.is_master_key = false;
    ctx.resolved_policy = None;
    let mut unrestricted = json!({"models":["blocked"]});
    apply_node_openrouter_preferences(&state, &ctx, "openrouter", &mut unrestricted, true);
    assert_eq!(unrestricted["models"], json!(["blocked"]));
}

#[test]
fn reflected_provider_material_is_excluded_from_log_fields() {
    use std::io::Write;
    #[derive(Clone)]
    struct LogBuffer(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl Write for LogBuffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuffer {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }
    const SECRET: &str = "reflected-private-prompt-and-key";
    let buffer = LogBuffer(std::sync::Arc::new(std::sync::Mutex::new(Vec::new())));
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(buffer.clone())
        .finish();
    let guard = tracing::subscriber::set_default(subscriber);
    for error in [
        GatewayError::ProviderError(SECRET.into()),
        GatewayError::ProviderTransport(SECRET.into()),
        GatewayError::ProviderDeliveryUncertain(SECRET.into()),
        GatewayError::ProviderPaymentRequired {
            provider: "known-provider".into(),
            message: SECRET.into(),
        },
    ] {
        log_provider_failure("known-provider", &error, "completion fallback");
    }
    drop(guard);
    let captured = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
    assert!(!captured.contains(SECRET));
    assert!(captured.contains("known-provider"));
    assert!(captured.contains("payment_required"));
    assert!(captured.contains("provider_error"));
}

#[test]
fn legacy_composio_header_can_only_narrow_configured_actions() {
    let configured = vec!["ALLOWED_ACTION".to_owned()];
    assert_eq!(legacy_composio_allowlist(None, &configured), configured);
    assert_eq!(
        legacy_composio_allowlist(
            Some("FORBIDDEN_ACTION,ALLOWED_ACTION,*,ALLOWED_ACTION"),
            &configured,
        ),
        configured
    );
    assert!(legacy_composio_allowlist(Some("FORBIDDEN_ACTION"), &configured).is_empty());
}

#[test]
fn session_budget_key_is_bound_to_the_authenticated_owner() {
    let owner_a = budget_session_key("bearer-a", Some("org-a"), None, Some("known-session"))
        .expect("session key");
    assert_eq!(
        budget_session_key("bearer-a", Some("org-a"), None, Some("known-session")),
        Some(owner_a.clone())
    );
    assert_ne!(
        budget_session_key("bearer-b", Some("org-a"), None, Some("known-session")),
        Some(owner_a.clone())
    );
    assert_ne!(
        budget_session_key("bearer-a", Some("org-b"), None, Some("known-session")),
        Some(owner_a.clone())
    );
    assert_ne!(
        budget_session_key(
            "bearer-a",
            Some("org-a"),
            Some("different-user"),
            Some("known-session")
        ),
        Some(owner_a)
    );
    assert!(budget_session_key("bearer-a", Some("org-a"), None, None).is_none());
}

#[tokio::test]
async fn accepted_video_poll_uses_owned_origin_and_preserves_blocked_job() {
    let state = Arc::new(AppState::new_for_test_default());
    let ctx = test_support::plain_request_context();
    let origin = Arc::new(ScriptedVideoOrigin(std::sync::atomic::AtomicUsize::new(0)));
    assert!(state
        .provider_runtime
        .snapshot()
        .providers
        .get_owned("retired-origin")
        .is_none());
    state.jobs.insert(crate::jobs::MediaJob {
        modality: crate::config::Modality::Video,
        id: "origin-pipeline".into(),
        provider: ProviderId::from("retired-origin"),
        origin: Some(origin.clone()),
        poll_blocked: None,
        model: "video-model".into(),
        status: crate::jobs::JobStatus::Queued,
        output: None,
        error: None,
        created_ms: crate::jobs::now_ms(),
        last_activity_ms: crate::jobs::now_ms(),
        org_id: None,
        user_id: None,
        agent_id: None,
        session_id: None,
        client_key_binding: crate::jobs::JobClientKeyBinding::new(&ctx.api_key),
        owner_binding: ctx.owner_binding.clone(),
        reservation: None,
        org_limit_subject: None,
    });
    let mut wrong = test_support::plain_request_context();
    wrong.owner_binding = "other-owner".into();
    assert!(
        poll_video_job(state.clone(), wrong, "origin-pipeline".into())
            .await
            .is_err()
    );
    assert_eq!(origin.0.load(std::sync::atomic::Ordering::SeqCst), 0);
    let blocked = poll_video_job(state.clone(), ctx, "origin-pipeline".into())
        .await
        .unwrap();
    assert_eq!(blocked["status"], "queued");
    assert_eq!(
        blocked["poll_blocked"]["message"],
        "origin credential was rejected"
    );
    assert!(blocked.get("error").is_none());
    let completed = poll_video_job(
        state.clone(),
        test_support::plain_request_context(),
        "origin-pipeline".into(),
    )
    .await
    .unwrap();
    assert_eq!(completed["status"], "succeeded");
    assert!(completed.get("poll_blocked").is_none());
    assert!(state.jobs.get("origin-pipeline").unwrap().origin.is_none());
    let repeated = poll_video_job(
        state,
        test_support::plain_request_context(),
        "origin-pipeline".into(),
    )
    .await
    .unwrap();
    assert_eq!(repeated, completed);
    assert_eq!(origin.0.load(std::sync::atomic::Ordering::SeqCst), 2);
}
