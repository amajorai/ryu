use super::*;

/// A Pi spawn command as the managed route builds it, with `bearer` as its
/// Gateway key.
fn scoped_pi_spawn(bearer: &str) -> String {
    acp_stdio_spawn_json(
        "ryu-pi",
        PathBuf::from("node"),
        vec!["/home/u/.ryu/pi/generations/generation-1/ryu-index.js".into()],
        vec![
            (
                "OPENAI_BASE_URL".into(),
                "http://127.0.0.1:1/v1/agents/ryu".into(),
            ),
            ("OPENAI_API_KEY".into(), bearer.to_owned()),
            ("PI_CODING_AGENT_DIR".into(), "/home/u/.ryu/pi/agent".into()),
        ],
    )
    .unwrap()
}

const FIXTURE_SIGNER: &str = "gwcore_fixture_signing_1234567890";

fn fixture_verify(token: &str) -> Option<(ryu_gw_credentials::InferenceScope, String)> {
    ryu_gw_credentials::InferenceScope::verify(token, FIXTURE_SIGNER)
        .ok()
        .map(|scope| (scope, "fixture-signer".to_owned()))
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn redeemed_key(redeemed: &RedeemedInference) -> String {
    let mut security = acp_security_key(
        &None,
        &None,
        &[],
        "ryu",
        &[],
        &None,
        &None,
        &Some("conv".into()),
        None,
        None,
    );
    redeemed.extend_security_key(&mut security);
    acp_pool_key(
        "conv",
        "ryu",
        &redeemed.spawn_cmd,
        &PathBuf::from("/w"),
        "",
        "",
        &security,
    )
}

#[test]
fn a_pooled_instance_is_reused_across_the_bearer_remint_boundary() {
    use crate::sidecar::gateway::{cached_inference_bearer, InferenceBearerCache};
    let now = unix_now();
    let mut cache = InferenceBearerCache::new();
    let mut redeem_at = |at: u64| {
        let bearer = cached_inference_bearer(
            &mut cache,
            FIXTURE_SIGNER,
            "ryu",
            None,
            Some("conv"),
            None,
            at,
        )
        .unwrap();
        let redeemed = redeem_inference_bearer(
            &scoped_pi_spawn(&bearer),
            "ryu",
            Some("conv"),
            fixture_verify,
        )
        .expect("this turn's own bearer is redeemed");
        (bearer, redeemed)
    };
    let (first_bearer, first) = redeem_at(now);
    // Past the remint margin the route builds the command with a new bearer.
    let (reminted_bearer, reminted) = redeem_at(now + 31 * 60);
    assert_ne!(first_bearer, reminted_bearer, "the bearer was reminted");
    assert_eq!(
        first, reminted,
        "the redeemed command and scope do not change"
    );
    assert_eq!(redeemed_key(&first), redeemed_key(&reminted));
    for redeemed in [&first, &reminted] {
        assert!(
            !redeemed.spawn_cmd.contains("gws1."),
            "no bearer reaches the process"
        );
        assert!(redeemed
            .spawn_cmd
            .contains(INFERENCE_CREDENTIAL_PLACEHOLDER));
        assert!(redeemed
            .spawn_cmd
            .contains(&crate::sidecar::gateway::acp_inference_proxy_v1()));
    }
    assert_eq!(
        first.scope,
        crate::server::acp_inference_proxy::AcpInferenceScope {
            agent_id: "ryu".into(),
            user_id: None,
            session_id: Some("conv".into()),
            provider_access: None,
        }
    );
}

#[test]
fn redeemed_scopes_and_signers_never_share_a_pooled_instance() {
    let expires_at = unix_now() + 3600;
    let redeem = |agent: &str, user: Option<&str>, session: Option<&str>, signer: &str| {
        let bearer = ryu_gw_credentials::InferenceScope {
            agent_id: agent.into(),
            user_id: user.map(str::to_owned),
            session_id: session.map(str::to_owned),
            expires_at,
            provider_access: None,
        }
        .sign(FIXTURE_SIGNER)
        .unwrap();
        redeem_inference_bearer(&scoped_pi_spawn(&bearer), agent, Some("conv"), |token| {
            fixture_verify(token).map(|(scope, _)| (scope, signer.to_owned()))
        })
        .unwrap()
    };
    let base = redeemed_key(&redeem("ryu", None, Some("conv"), "signer-a"));
    for separated in [
        redeem("other", None, Some("conv"), "signer-a"),
        redeem("ryu", Some("user-b"), Some("conv"), "signer-a"),
        redeem("ryu", None, None, "signer-a"),
        redeem("ryu", None, Some("conv"), "signer-b"),
    ] {
        assert_ne!(base, redeemed_key(&separated));
    }
}

#[test]
fn only_this_turns_valid_bearer_is_redeemed() {
    let expires_at = unix_now() + 3600;
    let sign = |agent: &str, session: Option<&str>, key: &str, expires_at: u64| {
        ryu_gw_credentials::InferenceScope {
            agent_id: agent.into(),
            user_id: None,
            session_id: session.map(str::to_owned),
            expires_at,
            provider_access: None,
        }
        .sign(key)
        .unwrap()
    };
    let redeem = |spawn_cmd: &str, conversation: Option<&str>| {
        redeem_inference_bearer(spawn_cmd, "ryu", conversation, fixture_verify)
    };
    let own = sign("ryu", Some("conv"), FIXTURE_SIGNER, expires_at);
    assert!(redeem(&scoped_pi_spawn(&own), Some("conv")).is_some());
    // An agent-wide bearer (no session) serves any of the agent's chats.
    let agent_wide = sign("ryu", None, FIXTURE_SIGNER, expires_at);
    assert!(redeem(&scoped_pi_spawn(&agent_wide), Some("conv")).is_some());
    assert!(redeem(&scoped_pi_spawn(&agent_wide), None).is_some());

    let other_agent = sign("other", Some("conv"), FIXTURE_SIGNER, expires_at);
    let other_chat = sign("ryu", Some("conv-b"), FIXTURE_SIGNER, expires_at);
    let foreign_signer = sign(
        "ryu",
        Some("conv"),
        "gwcore_some_other_signing_key_123",
        expires_at,
    );
    let tampered = format!("{own}0");
    for refused in [
        scoped_pi_spawn(&other_agent),
        scoped_pi_spawn(&other_chat),
        scoped_pi_spawn(&foreign_signer),
        scoped_pi_spawn(&tampered),
        scoped_pi_spawn("gwrelay_static_key"),
        scoped_pi_spawn(INFERENCE_CREDENTIAL_PLACEHOLDER),
    ] {
        assert_eq!(redeem(&refused, Some("conv")), None);
    }
    // A session-bound bearer is not redeemed for an unscoped turn.
    assert_eq!(redeem(&scoped_pi_spawn(&own), None), None);
    // Two keys in one command are ambiguous; neither is redeemed.
    let doubled = serde_json::json!({
        "name": "ryu-pi",
        "command": "node",
        "args": [],
        "env": [
            {"name": "OPENAI_API_KEY", "value": own},
            {"name": "openai_api_key", "value": own},
        ],
    })
    .to_string();
    assert_eq!(redeem(&doubled, Some("conv")), None);
}

#[test]
fn scoped_bearers_never_reach_a_probe_cache_key() {
    let expires_at = unix_now() + 3600;
    let bearer = ryu_gw_credentials::InferenceScope {
        agent_id: "ryu".into(),
        user_id: None,
        session_id: None,
        expires_at,
        provider_access: None,
    }
    .sign(FIXTURE_SIGNER)
    .unwrap();
    let reminted = ryu_gw_credentials::InferenceScope {
        agent_id: "ryu".into(),
        user_id: None,
        session_id: None,
        expires_at: expires_at + 60,
        provider_access: None,
    }
    .sign(FIXTURE_SIGNER)
    .unwrap();
    let key = without_scoped_bearers(&scoped_pi_spawn(&bearer)).into_owned();
    assert!(!key.contains(&bearer));
    assert_eq!(key, without_scoped_bearers(&scoped_pi_spawn(&reminted)));
    let plain = scoped_pi_spawn("sk-user");
    assert_eq!(without_scoped_bearers(&plain), plain);
}

#[test]
fn an_agent_on_the_inference_proxy_counts_as_gateway_routed() {
    let redeemed = redeem_inference_bearer(
        &scoped_pi_spawn(
            &ryu_gw_credentials::InferenceScope {
                agent_id: "ryu".into(),
                user_id: None,
                session_id: None,
                expires_at: unix_now() + 3600,
                provider_access: None,
            }
            .sign(FIXTURE_SIGNER)
            .unwrap(),
        ),
        "ryu",
        None,
        fixture_verify,
    )
    .unwrap();
    let McpServer::Stdio(stdio) = AcpSpawn::from_str(&redeemed.spawn_cmd)
        .unwrap()
        .into_server()
    else {
        panic!("stdio spawn");
    };
    assert!(stdio_targets_inference_proxy(&stdio));
    assert!(stdio_targets_local_gateway(&stdio));
    assert!(!targets_inference_proxy("https://api.openai.com/v1"));
    let core = crate::sidecar::gateway::core_self_url();
    assert!(!targets_inference_proxy(&format!("{core}/api/acp/tools")));
}

#[test]
fn an_inference_credential_is_accepted_only_in_or_just_after_a_turn() {
    use crate::server::acp_inference_proxy as proxy;
    let scope = proxy::AcpInferenceScope {
        agent_id: "ryu".into(),
        user_id: None,
        session_id: Some("conv".into()),
        provider_access: None,
    };
    let activity = AcpInstanceActivity::new();
    activity.mark_admitted();
    let grant = proxy::issue(scope.clone(), Some(Arc::clone(&activity)));
    let credential = grant.credential().to_owned();
    // Busy: in a turn.
    assert_eq!(proxy::authorize(&credential), Some(scope.clone()));
    // Just went idle: trailing calls of the turn still land.
    activity.mark_idle();
    assert_eq!(proxy::authorize(&credential), Some(scope.clone()));
    // Idle past the grace period: refused until the next turn starts.
    let long_ago = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - 10 * 60 * 1000;
    activity
        .idle_since_ms
        .store(long_ago, std::sync::atomic::Ordering::Release);
    assert_eq!(proxy::authorize(&credential), None);
    activity.mark_busy();
    assert_eq!(proxy::authorize(&credential), Some(scope));
    assert!(proxy::is_current(grant.grant_id()));
    // Revoked when the instance task drops its grant.
    let grant_id = grant.grant_id();
    drop(grant);
    assert_eq!(proxy::authorize(&credential), None);
    assert!(!proxy::is_current(grant_id));
}

#[test]
fn evicting_an_idle_instance_revokes_its_inference_credential() {
    use crate::server::acp_inference_proxy as proxy;
    let activity = AcpInstanceActivity::new();
    activity.mark_admitted();
    activity.mark_idle();
    let grant = proxy::issue(
        proxy::AcpInferenceScope {
            agent_id: "ryu".into(),
            user_id: None,
            session_id: None,
            provider_access: None,
        },
        Some(Arc::clone(&activity)),
    );
    let credential = grant.credential().to_owned();
    let (turns, _turns_rx) = mpsc::unbounded_channel();
    let entry = AcpPoolEntry {
        turns,
        capability_session_id: None,
        inference_grant_id: Some(grant.grant_id()),
        activity,
    };
    assert!(proxy::authorize(&credential).is_some());
    revoke_evicted_credentials(&entry);
    assert_eq!(proxy::authorize(&credential), None);
    drop(grant);
}

#[test]
fn acp_pool_key_separates_security_contexts() {
    let no_tools = acp_security_key(
        &None,
        &None,
        &[],
        "agent",
        &[],
        &None,
        &None,
        &Some("conv".into()),
        None,
        None,
    );
    let explicit_no_tools = acp_security_key(
        &None,
        &Some(Vec::new()),
        &[],
        "agent",
        &[],
        &None,
        &None,
        &Some("conv".into()),
        None,
        None,
    );
    let different_action = acp_security_key(
        &None,
        &Some(vec!["tool:read".into()]),
        &["composio:write".into()],
        "agent",
        &["vault-profile".into()],
        &None,
        &None,
        &Some("conv".into()),
        None,
        None,
    );
    assert_ne!(no_tools, explicit_no_tools);
    assert_ne!(explicit_no_tools, different_action);

    let account_a = acp_security_key(
        &None,
        &None,
        &[],
        "agent",
        &[],
        &None,
        &None,
        &Some("conv".into()),
        None,
        Some("anthropic:account-a"),
    );
    let account_b = acp_security_key(
        &None,
        &None,
        &[],
        "agent",
        &[],
        &None,
        &None,
        &Some("conv".into()),
        None,
        Some("anthropic:account-b"),
    );
    assert_ne!(account_a, account_b);
}

#[test]
fn managed_pi_session_identity_separates_provider_accounts() {
    let account_a = managed_pi_session_identity("anthropic", Some("account-a"));
    let account_b = managed_pi_session_identity("anthropic", Some("account-b"));

    assert_ne!(account_a, account_b);
    assert_eq!(managed_pi_session_identity("anthropic", None), "anthropic");
}
