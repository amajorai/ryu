use super::*;

#[tokio::test]
async fn scoped_inference_auth_binds_identity_and_enforces_agent_budget() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, calls) = agent_budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Stop,
        downgrade_to: None,
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let signer = "gwcore_0123456789abcdef0123456789abcdef";
    state.update_auth_config(vec![serde_json::from_value(serde_json::json!({
        "key": signer, "name":"local-core", "trusted_forwarder":true,
    }))
    .unwrap()]);
    let token = ryu_gw_credentials::InferenceScope {
        agent_id: "agent-a".into(),
        user_id: Some("user-a".into()),
        session_id: Some("session-a".into()),
        expires_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600,
        provider_access: None,
    }
    .sign(signer)
    .unwrap();
    let bearer = format!("Bearer {token}");
    for operation in [
        crate::config::ApiKeyOperation::WebSearch,
        crate::config::ApiKeyOperation::WebFetch,
    ] {
        assert!(matches!(
            super::super::authenticate_for_operation(
                &state,
                super::super::AuthInputs::with_key(Some(&bearer)),
                operation
            )
            .await,
            Err(GatewayError::Unauthorized(_))
        ));
    }
    let context =
        super::super::authenticate(&state, super::super::AuthInputs::with_key(Some(&bearer)))
            .await
            .unwrap();
    assert_eq!(context.agent_id.as_deref(), Some("agent-a"));
    assert_eq!(context.user_id.as_deref(), Some("user-a"));
    assert_eq!(context.session_id.as_deref(), Some("session-a"));
    assert!(!context.is_master_key);
    assert!(!context
        .key_config
        .as_ref()
        .is_some_and(|key| key.trusted_forwarder));
    for (agent_id, user_id, session_id) in [
        (Some("agent-b"), None, None),
        (None, Some("user-b"), None),
        (None, None, Some("session-b")),
    ] {
        let mut input = super::super::AuthInputs::with_key(Some(&bearer));
        input.agent_id = agent_id.map(str::to_owned);
        input.user_id = user_id.map(str::to_owned);
        input.session_id = session_id.map(str::to_owned);
        assert!(matches!(
            super::super::authenticate(&state, input).await,
            Err(GatewayError::Unauthorized(_))
        ));
    }
    let tampered = format!("{token}0");
    assert!(matches!(
        super::super::authenticate(&state, super::super::AuthInputs::with_key(Some(&tampered)))
            .await,
        Err(GatewayError::Unauthorized(_))
    ));
    // A scope's provider list binds the bearer; a header can only narrow it.
    let limited = ryu_gw_credentials::InferenceScope {
        agent_id: "agent-a".into(),
        user_id: None,
        session_id: None,
        expires_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600,
        provider_access: Some(vec!["anthropic".into()]),
    }
    .sign(signer)
    .unwrap();
    let limited_bearer = format!("Bearer {limited}");
    let mut input = super::super::AuthInputs::with_key(Some(&limited_bearer));
    input.agent_provider_access = Some("openai,anthropic".into());
    let scoped = super::super::authenticate(&state, input).await.unwrap();
    let access = scoped.agent_provider_access.expect("scope applies");
    assert_eq!(access.len(), 1);
    assert!(access.contains("anthropic"));
    let unscoped_header = super::super::authenticate(&state, {
        let mut input = super::super::AuthInputs::with_key(Some(&bearer));
        input.agent_provider_access = Some("none".into());
        input
    })
    .await
    .unwrap();
    assert!(unscoped_header
        .agent_provider_access
        .expect("header applies")
        .is_empty());

    let result = run(Arc::clone(&state), context, ping_body()).await;
    assert!(matches!(result, Err(GatewayError::BudgetExceeded(_))));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "scoped agent budget must stop before provider dispatch"
    );
}

#[tokio::test]
async fn scoped_inference_owner_survives_a_remint_but_not_a_scope_change() {
    let (state, _) = agent_budget_state(crate::config::BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: crate::config::BudgetAction::Stop,
        downgrade_to: None,
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let signer = "gwcore_0123456789abcdef0123456789abcdef";
    state.update_auth_config(vec![serde_json::from_value(serde_json::json!({
        "key": signer, "name":"local-core", "trusted_forwarder":true,
    }))
    .unwrap()]);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let owner_with = |agent: &str,
                      user: Option<&str>,
                      session: Option<&str>,
                      expires_at: u64,
                      provider_access: Option<&[&str]>| {
        let token = ryu_gw_credentials::InferenceScope {
            agent_id: agent.into(),
            user_id: user.map(str::to_owned),
            session_id: session.map(str::to_owned),
            expires_at,
            provider_access: provider_access
                .map(|ids| ids.iter().map(|id| (*id).to_owned()).collect()),
        }
        .sign(signer)
        .unwrap();
        let state = Arc::clone(&state);
        async move {
            let bearer = format!("Bearer {token}");
            super::super::authenticate(&state, super::super::AuthInputs::with_key(Some(&bearer)))
                .await
                .unwrap()
                .owner_binding
        }
    };
    let owner = |agent: &str, user: Option<&str>, session: Option<&str>, expires_at: u64| {
        owner_with(agent, user, session, expires_at, None)
    };
    let first = owner("agent-a", None, Some("chat-1"), now + 3600).await;
    let reminted = owner("agent-a", None, Some("chat-1"), now + 1800).await;
    assert_eq!(first, reminted, "a reminted bearer keeps its responses");
    for other in [
        owner("agent-b", None, Some("chat-1"), now + 3600).await,
        owner("agent-a", Some("user-a"), Some("chat-1"), now + 3600).await,
        owner("agent-a", None, Some("chat-2"), now + 3600).await,
        owner("agent-a", None, None, now + 3600).await,
    ] {
        assert_ne!(first, other, "distinct scopes never share responses");
    }
    // The signed provider list is part of the scope, in any order.
    let limited = owner_with(
        "agent-a",
        None,
        Some("chat-1"),
        now + 3600,
        Some(&["b", "a"]),
    )
    .await;
    let limited_reminted = owner_with(
        "agent-a",
        None,
        Some("chat-1"),
        now + 1800,
        Some(&["a", "b"]),
    )
    .await;
    assert_eq!(limited, limited_reminted);
    assert_ne!(
        first, limited,
        "a limited bearer never shares an unlimited one's responses"
    );
    let empty = owner_with("agent-a", None, Some("chat-1"), now + 3600, Some(&[])).await;
    assert_ne!(first, empty);
    assert_ne!(limited, empty);
}

/// A `Stop` budget rule at/over its limit rejects the request with a hard
/// `BudgetExceeded` before the provider is reached.
#[tokio::test]
async fn budget_stop_rejects_over_limit_before_dispatch() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, calls) = budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Stop,
        downgrade_to: None,
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let err = match run(Arc::clone(&state), u1_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("an over-limit Stop budget must reject"),
    };
    assert!(
        matches!(err, GatewayError::BudgetExceeded(_)),
        "expected BudgetExceeded, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "a hard budget stop must not reach the provider"
    );
}

/// An agent-specific `Stop` budget rejects the matching agent before the
/// provider is reached.
#[tokio::test]
async fn agent_budget_stop_rejects_over_limit_before_dispatch() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, calls) = agent_budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Stop,
        downgrade_to: None,
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let err = match run(Arc::clone(&state), agent_a_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("an over-limit agent Stop budget must reject"),
    };
    assert!(
        matches!(err, GatewayError::BudgetExceeded(_)),
        "expected BudgetExceeded, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "a hard agent budget stop must not reach the provider"
    );
}

/// A `Downgrade` rule rewrites the request's model to the cheaper target and
/// still serves the turn.
#[tokio::test]
async fn budget_downgrade_rewrites_model_and_serves() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, calls) = budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Downgrade,
        downgrade_to: Some("cheap-model".to_string()),
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let out = run(Arc::clone(&state), u1_ctx(), ping_body())
        .await
        .expect("downgrade still serves");
    assert_eq!(out.model_used, "cheap-model", "the model was downgraded");
    assert_eq!(out.provider_used, "primary");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn an_unhealthy_spend_store_refuses_metered_requests_only() {
    use crate::config::{BudgetAction, BudgetRule};

    struct Mismatched;
    impl crate::budget::SpendStore for Mismatched {
        fn spent(&self, _: &str, _: &str, _: crate::budget::BudgetWindow, _: i64) -> u64 {
            0
        }
        fn add(&self, _: &str, _: &str, _: u64, _: i64) {}
        fn health(&self) -> Result<(), String> {
            Err(crate::budget::KEY_MISMATCH.to_owned())
        }
    }

    let mut config = GatewayConfig::default();
    config.budgets.users.insert(
        "capped".to_owned(),
        BudgetRule {
            limit: 1_000,
            window: Default::default(),
            action: BudgetAction::Stop,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        },
    );
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    state.spend_store = Arc::new(Mismatched);

    let mut capped = plain_ctx();
    capped.user_id = Some("capped".to_owned());
    match super::super::spend_store_gate(&state, &capped) {
        Some(GatewayError::BudgetStoreUnavailable(reason)) => {
            assert_eq!(reason, "budget store key mismatch");
        }
        other => panic!("a capped caller must be refused, got {other:?}"),
    }
    let mut uncapped = plain_ctx();
    uncapped.user_id = Some("free".to_owned());
    assert!(super::super::spend_store_gate(&state, &uncapped).is_none());
    capped.is_master_key = true;
    assert!(super::super::spend_store_gate(&state, &capped).is_none());
}

#[test]
fn a_keyless_gateway_keeps_metering_on_a_legacy_plaintext_spend_db() {
    let dir = std::env::temp_dir().join(format!(
        "ryu-gw-keyless-spend-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(crate::budget::SPEND_STORE);
    {
        // spend.db as a pre-sealing Gateway wrote it.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE spend_counters (
                     scope TEXT NOT NULL, id TEXT NOT NULL, window TEXT NOT NULL,
                     window_start INTEGER NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
                     PRIMARY KEY (scope, id, window, window_start));
                 INSERT INTO spend_counters VALUES ('org', 'org-legacy', 'lifetime', 0, 70);",
        )
        .unwrap();
    }
    let store =
        crate::budget::SqliteSpendStore::open(&path, Err("no sealing key".to_owned())).unwrap();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(GatewayConfig::default(), audit, evals);
    state.spend_store = Arc::new(store);
    assert_eq!(state.spend_store.sealing(), "no key");
    assert_eq!(
        state.spend_store.spent(
            "org",
            "org-legacy",
            crate::budget::BudgetWindow::Lifetime,
            crate::budget::unix_now()
        ),
        70
    );

    let mut tenant = plain_ctx();
    tenant.org_limits = Some(Arc::new(crate::org_limits::OrgLimitContext {
        org_id: "org-legacy".to_owned(),
        limits: Arc::new(crate::org_limits::OrgLimits::default()),
        credential_id: None,
        service_account_id: None,
        bound_user_id: None,
        team_ids: Vec::new(),
        remote_spend: None,
        active_gateways: None,
        tags: Vec::new(),
        project_id: None,
        bot_id: None,
        funding_draw_source: None,
    }));
    assert!(
        super::super::spend_store_gate(&state, &tenant).is_none(),
        "a keyless Gateway on a never-sealed spend.db must keep serving metered traffic"
    );
    drop(state);
    let _ = std::fs::remove_dir_all(dir);
}
