use super::*;
use crate::config::{ApiKeyConfig, AuthConfig, GatewayConfig};
use crate::state::AppState;

fn state_with_auth(auth: AuthConfig) -> AppState {
    let config = GatewayConfig {
        auth,
        ..GatewayConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    AppState::new_for_test(config, audit, evals)
}

fn api_key(key: &str, name: &str, trusted_forwarder: bool) -> ApiKeyConfig {
    ApiKeyConfig {
        allowed_operations: vec![crate::config::ApiKeyOperation::Inference],
        key: key.to_string(),
        name: name.to_string(),
        org_id: Some("org-acme".to_string()),
        team_id: Some("team-1".to_string()),
        channel_id: None,
        project_id: Some("proj-1".to_string()),
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder,
    }
}

#[tokio::test]
async fn anonymous_inference_never_grants_web_services() {
    let mut client = api_key("synthetic-web-client", "web-client", false);
    client.allowed_operations = vec![ApiKeyOperation::WebSearch];
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        master_key: None,
        api_keys: vec![client],
    });
    for bearer in [None, Some("unknown"), Some("gws1.invalid")] {
        assert!(authenticate_for_operation(
            &state,
            AuthInputs::with_key(bearer),
            ApiKeyOperation::WebSearch
        )
        .await
        .is_err());
    }
    let context = authenticate_for_operation(
        &state,
        AuthInputs::with_key(Some("synthetic-web-client")),
        ApiKeyOperation::WebSearch,
    )
    .await
    .unwrap();
    assert_eq!(context.authorized_operation, ApiKeyOperation::WebSearch);
    assert_eq!(context.user_id.as_deref(), Some("web-client"));
    assert!(!context.is_master_key);
    assert!(authenticate_for_operation(
        &state,
        AuthInputs::with_key(Some("synthetic-web-client")),
        ApiKeyOperation::WebFetch
    )
    .await
    .is_err());
}

const BOX_ID: &str = "bx_0123456789abcdef0123456789abcdef";

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn box_scope(org_id: &str, expires_at: u64) -> ryu_gw_credentials::BoxInferenceScope {
    ryu_gw_credentials::BoxInferenceScope {
        org_id: org_id.to_owned(),
        user_id: Some("user-a".to_owned()),
        session_id: "conv-1".to_owned(),
        box_id: BOX_ID.to_owned(),
        lease_epoch: 3,
        expires_at,
        key_epoch: 0,
    }
}

const LOCAL_CORE_KEY: &str = "gwcore_0123456789abcdef0123456789abcdef";

#[path = "authenticate_box_hosted_tests.rs"]
mod box_hosted;

fn local_core_state() -> AppState {
    state_with_auth(AuthConfig {
        require_auth: true,
        master_key: Some("sk-master-gwb1".to_string()),
        api_keys: vec![api_key(LOCAL_CORE_KEY, "local-core", true)],
    })
}

#[tokio::test]
async fn gwb1_local_core_key_is_accepted_for_inference_only() {
    let state = local_core_state();
    let token = box_scope("org-acme", unix_now() + 600)
        .sign(LOCAL_CORE_KEY)
        .unwrap();
    let bearer = format!("Bearer {token}");
    let context = authenticate(&state, AuthInputs::with_key(Some(&bearer)))
        .await
        .unwrap();
    assert!(
        caller_identity_is_core_forwarded(&context),
        "the Core-signed Box user's policy applies"
    );
    assert_eq!(context.org_id.as_deref(), Some("org-acme"));
    assert_eq!(context.user_id.as_deref(), Some("user-a"));
    assert_eq!(context.session_id.as_deref(), Some("conv-1"));
    assert_eq!(context.feature.as_deref(), Some("box"));
    assert_eq!(context.agent_id, None);
    assert!(!context.is_master_key);
    assert!(context.key_config.is_none(), "gwb1 is never a forwarder");
    assert!(!context.api_key.contains(&token));
    assert_eq!(context.api_key, format!("box:org-acme:{BOX_ID}"));

    // A forwarded feature header cannot re-label Box spend.
    let mut relabel = AuthInputs::with_key(Some(&bearer));
    relabel.feature = Some("chat".to_owned());
    assert_eq!(
        authenticate(&state, relabel)
            .await
            .unwrap()
            .feature
            .as_deref(),
        Some("box")
    );

    for operation in [ApiKeyOperation::WebSearch, ApiKeyOperation::WebFetch] {
        assert!(matches!(
            authenticate_for_operation(&state, AuthInputs::with_key(Some(&bearer)), operation)
                .await,
            Err(GatewayError::Unauthorized(_))
        ));
    }
}

#[tokio::test]
async fn gwb1_refuses_wrong_keys_expiry_and_identity_mismatch() {
    let state = local_core_state();
    let now = unix_now();
    let valid = box_scope("org-acme", now + 600)
        .sign(LOCAL_CORE_KEY)
        .unwrap();
    let wrong_key = box_scope("org-acme", now + 600)
        .sign("gwcore_another_org_key_0000000000000000")
        .unwrap();
    let expired = box_scope("org-acme", now - 30)
        .sign_at(LOCAL_CORE_KEY, now - 600)
        .unwrap();
    let other_org = box_scope("org-other", now + 600)
        .sign(LOCAL_CORE_KEY)
        .unwrap();
    let tampered = format!("{valid}0");
    for token in [&wrong_key, &expired, &other_org, &tampered] {
        let bearer = format!("Bearer {token}");
        assert!(
            matches!(
                authenticate(&state, AuthInputs::with_key(Some(&bearer))).await,
                Err(GatewayError::Unauthorized(_))
            ),
            "{token}"
        );
    }
    let bearer = format!("Bearer {valid}");
    for (user_id, session_id) in [(Some("user-b"), None), (None, Some("conv-2"))] {
        let mut input = AuthInputs::with_key(Some(&bearer));
        input.user_id = user_id.map(str::to_owned);
        input.session_id = session_id.map(str::to_owned);
        assert!(matches!(
            authenticate(&state, input).await,
            Err(GatewayError::Unauthorized(_))
        ));
    }
    let mut matching = AuthInputs::with_key(Some(&bearer));
    matching.user_id = Some("user-a".to_owned());
    matching.session_id = Some("conv-1".to_owned());
    assert!(authenticate(&state, matching).await.is_ok());
}

#[tokio::test]
async fn inference_only_static_keys_cannot_authorize_web_operations() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        master_key: Some("synthetic-master".into()),
        api_keys: vec![api_key("synthetic-inference", "legacy", true)],
    });
    assert!(authenticate_for_operation(
        &state,
        AuthInputs::with_key(Some("synthetic-inference")),
        ApiKeyOperation::WebSearch
    )
    .await
    .is_err());
    assert!(authenticate_for_operation(
        &state,
        AuthInputs::with_key(Some("synthetic-inference")),
        ApiKeyOperation::WebFetch
    )
    .await
    .is_err());
    let master = authenticate_for_operation(
        &state,
        AuthInputs::with_key(Some("synthetic-master")),
        ApiKeyOperation::WebFetch,
    )
    .await
    .unwrap();
    assert!(master.is_master_key);
    assert_eq!(master.authorized_operation, ApiKeyOperation::WebFetch);
}

// ─── no-auth mode ────────────────────────────────────────────────────────

#[tokio::test]
async fn no_auth_mode_makes_unknown_callers_anonymous() {
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![],
        master_key: None,
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("whatever")))
        .await
        .expect("no-auth accepts any key");
    assert!(!ctx.is_master_key);
    assert_eq!(ctx.api_key, "whatever");
    assert!(ctx.org_id.is_none());
}

#[tokio::test]
async fn no_auth_mode_with_no_key_labels_api_key_anonymous() {
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![],
        master_key: None,
    });
    let ctx = authenticate(&state, AuthInputs::with_key(None))
        .await
        .expect("no-auth accepts missing key");
    assert_eq!(ctx.api_key, "anonymous");
    assert!(!ctx.is_master_key);
}

#[tokio::test]
async fn no_auth_mode_still_recognizes_provisioned_master_key() {
    // A provisioned master key stays authoritative even with require_auth off.
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![],
        master_key: Some("master-secret".to_string()),
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("master-secret")))
        .await
        .expect("master key recognized");
    assert!(ctx.is_master_key);
    assert_eq!(ctx.user_name.as_deref(), Some("master"));
}

#[tokio::test]
async fn no_auth_master_key_honors_bearer_prefix() {
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![],
        master_key: Some("master-secret".to_string()),
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("Bearer master-secret")))
        .await
        .expect("bearer-prefixed master key recognized");
    assert!(ctx.is_master_key);
}

/// A no-auth Gateway cannot tell a local tool from a DNS-rebound web page, so
/// an anonymous caller must never pick the agent whose Core tool allowlist the
/// tool loop executes under. A provisioned master key keeps it.
#[tokio::test]
async fn no_auth_anonymous_caller_cannot_choose_the_agent() {
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![api_key("sk-core", "ryu-core", true)],
        master_key: Some("master-secret".to_string()),
    });
    let with_key = |key: Option<&'static str>| AuthInputs {
        raw_api_key: key,
        agent_id: Some("a1".to_string()),
        ..Default::default()
    };
    for key in [None, Some("whatever"), Some("sk-core")] {
        let ctx = authenticate(&state, with_key(key)).await.expect("accepted");
        assert!(!ctx.is_master_key);
        assert_eq!(ctx.agent_id, None, "{key:?}");
    }
    let master = authenticate(&state, with_key(Some("master-secret")))
        .await
        .expect("accepted");
    assert!(master.is_master_key);
    assert_eq!(master.agent_id.as_deref(), Some("a1"));
}

// ─── require_auth mode ───────────────────────────────────────────────────

#[tokio::test]
async fn require_auth_rejects_missing_key() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![],
        master_key: None,
    });
    let err = authenticate(&state, AuthInputs::with_key(None))
        .await
        .expect_err("missing key must be rejected");
    assert!(matches!(err, GatewayError::Unauthorized(_)));
}

#[tokio::test]
async fn require_auth_rejects_unknown_key() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![api_key("sk-known", "known", false)],
        master_key: None,
    });
    let err = authenticate(&state, AuthInputs::with_key(Some("sk-unknown")))
        .await
        .expect_err("unknown key must be rejected");
    assert!(matches!(err, GatewayError::Unauthorized(_)));
}

#[tokio::test]
async fn require_auth_matches_master_key() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![],
        master_key: Some("master-secret".to_string()),
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("Bearer master-secret")))
        .await
        .expect("master key accepted");
    assert!(ctx.is_master_key);
}

#[tokio::test]
async fn static_key_match_populates_org_team_project() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![api_key("sk-acme", "acme-key", false)],
        master_key: None,
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("sk-acme")))
        .await
        .expect("static key accepted");
    assert!(!ctx.is_master_key);
    assert_eq!(ctx.org_id.as_deref(), Some("org-acme"));
    assert_eq!(ctx.team_id.as_deref(), Some("team-1"));
    assert_eq!(ctx.project_id.as_deref(), Some("proj-1"));
    assert_eq!(ctx.user_name.as_deref(), Some("acme-key"));
    assert!(ctx.key_config.is_some());
}

#[tokio::test]
async fn untrusted_key_ignores_forwarded_identity_headers() {
    // trusted_forwarder = false => the client-supplied x-ryu-user-id /
    // x-ryu-agent-id are ignored and budget identity binds to the key name,
    // so a caller cannot spoof or rotate identity to evade its quota.
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![api_key("sk-acme", "acme-key", false)],
        master_key: None,
    });
    let inputs = AuthInputs {
        raw_api_key: Some("sk-acme"),
        user_id: Some("spoofed-user".to_string()),
        agent_id: Some("spoofed-agent".to_string()),
        ..Default::default()
    };
    let ctx = authenticate(&state, inputs).await.expect("accepted");
    assert_eq!(
        ctx.user_id.as_deref(),
        Some("acme-key"),
        "budget identity must bind to the key name, not the spoofed header"
    );
    assert!(ctx.agent_id.is_none());
}

#[tokio::test]
async fn trusted_forwarder_honors_forwarded_identity_headers() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![api_key("sk-core", "ryu-core", true)],
        master_key: None,
    });
    let inputs = AuthInputs {
        raw_api_key: Some("sk-core"),
        user_id: Some("real-user".to_string()),
        agent_id: Some("real-agent".to_string()),
        ..Default::default()
    };
    let ctx = authenticate(&state, inputs).await.expect("accepted");
    assert_eq!(ctx.user_id.as_deref(), Some("real-user"));
    assert_eq!(ctx.agent_id.as_deref(), Some("real-agent"));
}

/// Core's host-conversation proof is relayed to the tool loop only from
/// Core's own trusted-forwarder key. Any other bearer (an ordinary key, the
/// master key, an anonymous caller) has the headers dropped, so the tool
/// loop keeps Core's fail-closed node-wide principal for it.
#[tokio::test]
async fn host_conversation_proof_is_kept_only_for_a_trusted_forwarder() {
    let host = crate::tools::HostConversation {
        id: "conv-1".into(),
        proof: "proof-1".into(),
    };
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![
            api_key("sk-core", "ryu-core", true),
            api_key("sk-acme", "acme-key", false),
        ],
        master_key: Some("master-secret".into()),
    });
    let with_key = |key: &'static str| AuthInputs {
        raw_api_key: Some(key),
        host_conversation: Some(host.clone()),
        ..Default::default()
    };
    let trusted = authenticate(&state, with_key("sk-core"))
        .await
        .expect("accepted");
    assert_eq!(trusted.host_conversation.as_ref(), Some(&host));
    for key in ["sk-acme", "master-secret"] {
        let ctx = authenticate(&state, with_key(key)).await.expect("accepted");
        assert_eq!(ctx.host_conversation, None, "{key}");
    }

    let open = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![],
        master_key: None,
    });
    let anonymous = authenticate(&open, with_key("anything"))
        .await
        .expect("accepted");
    assert_eq!(anonymous.host_conversation, None);
}

#[tokio::test]
async fn rgw_token_without_resolve_cache_is_hard_rejected() {
    // An rgw_-shaped bearer only reaches the dynamic path when a resolve cache
    // is configured; the test state has none, so it must NOT fall open into
    // anonymous — it is a hard 401.
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![],
        master_key: None,
    });
    let err = authenticate(&state, AuthInputs::with_key(Some("rgw_sometoken")))
        .await
        .expect_err("rgw_ token with no resolve cache must be rejected");
    assert!(matches!(err, GatewayError::Unauthorized(_)));
}

#[tokio::test]
async fn static_key_match_strips_bearer_prefix() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![api_key("sk-acme", "acme-key", false)],
        master_key: None,
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("Bearer sk-acme")))
        .await
        .expect("bearer-prefixed static key accepted");
    assert_eq!(ctx.user_name.as_deref(), Some("acme-key"));
}

#[test]
fn ct_eq_is_functionally_equivalent_to_str_eq() {
    // Constant-time compare returns the exact same boolean as `==`: the only
    // difference is the removed per-byte timing signal (see `ct_eq` doc comment).
    assert!(ct_eq("sk-abc", "sk-abc"));
    // Single trailing-byte difference (the case a naive `==` would leak).
    assert!(!ct_eq("sk-abc", "sk-abd"));
    // Length mismatch short-circuits to false (key length is not secret).
    assert!(!ct_eq("sk-ab", "sk-abc"));
    // Empty vs empty is equal.
    assert!(ct_eq("", ""));
}
