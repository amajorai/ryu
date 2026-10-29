//! Per-agent account access at the Composio trigger-subscription route: a
//! trigger runs on one of the user's connected accounts, so the agent's
//! identity mode and allowlist must allow that account before Core registers
//! anything with Composio. Real handler and agent store; refusals happen before
//! any network call.
use super::*;
use crate::agents::{AgentIdentityMode, CreateAgent};
use axum::extract::{Extension, State};
use serde_json::json;

async fn subscribe(state: &ServerState, agent_id: &str, account: &str) -> (StatusCode, Value) {
    let body: ComposioSubscribeBody = serde_json::from_value(json!({
        "agent_id": agent_id,
        "toolkit": "gmail",
        "trigger_slug": "GMAIL_NEW_GMAIL_MESSAGE",
        "connected_account_id": account,
    }))
    .unwrap();
    let (status, Json(body)) =
        composio_trigger_subscribe(State(state.clone()), Extension(None), Json(body)).await;
    (status, body)
}

async fn agent(state: &ServerState, mode: AgentIdentityMode, access: Option<Vec<&str>>) -> String {
    state
        .agent_store
        .create(CreateAgent {
            name: format!("{mode:?} agent"),
            identity_mode: mode,
            account_access: access.map(|keys| keys.into_iter().map(str::to_owned).collect()),
            ..Default::default()
        })
        .await
        .unwrap()
        .id
}

#[tokio::test]
async fn trigger_subscription_refuses_accounts_the_agent_may_not_use() {
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());

    let individual = agent(&state, AgentIdentityMode::Individual, None).await;
    let managed_allowlisted = agent(
        &state,
        AgentIdentityMode::Managed,
        Some(vec!["composio:ca_allowed"]),
    )
    .await;
    let mixed_empty = agent(&state, AgentIdentityMode::Mixed, Some(Vec::new())).await;
    let malformed = agent(
        &state,
        AgentIdentityMode::Managed,
        Some(vec!["composio: ca_user"]),
    )
    .await;

    for (agent_id, account) in [
        (&individual, "ca_user"),
        (&managed_allowlisted, "ca_user"),
        (&mixed_empty, "ca_user"),
        (&malformed, "ca_user"),
    ] {
        let (status, body) = subscribe(&state, agent_id, account).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{agent_id}: {body}");
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("not allowed to use that connected account"),
            "{body}"
        );
    }
}

#[tokio::test]
async fn connect_target_binding_uses_the_same_account_gate() {
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());

    let individual = agent(&state, AgentIdentityMode::Individual, None).await;
    let allowlisted = agent(
        &state,
        AgentIdentityMode::Managed,
        Some(vec!["composio:ca_allowed"]),
    )
    .await;
    let legacy = agent(&state, AgentIdentityMode::Managed, None).await;

    for (agent_id, account) in [(&individual, "ca_allowed"), (&allowlisted, "ca_user")] {
        let (status, Json(body)) =
            connect_events::agent_trigger_account_refusal(&state, agent_id, account)
                .await
                .expect("refused");
        assert_eq!(status, StatusCode::FORBIDDEN, "{agent_id}: {body}");
    }
    for (agent_id, account) in [
        (allowlisted.as_str(), "ca_allowed"),
        (legacy.as_str(), "ca_user"),
        // An agent without a record keeps today's behaviour.
        ("no-such-agent", "ca_user"),
    ] {
        assert!(
            connect_events::agent_trigger_account_refusal(&state, agent_id, account)
                .await
                .is_none(),
            "{agent_id}"
        );
    }
}

#[tokio::test]
async fn an_agent_with_an_allowlist_may_use_the_account_it_creates() {
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());

    let limited = agent(
        &state,
        AgentIdentityMode::Mixed,
        Some(vec!["composio:ca_allowed"]),
    )
    .await;
    vault_agent_accounts_api::allow_created_account(&state, &limited, "acc_new").await;
    vault_agent_accounts_api::allow_created_account(&state, &limited, "acc_new").await;
    let record = state.agent_store.get(&limited).await.unwrap().unwrap();
    assert_eq!(
        record.account_access,
        Some(vec![
            "composio:ca_allowed".to_owned(),
            "agent:acc_new".to_owned()
        ])
    );

    // An unlimited agent may already use it, so its record is left alone.
    let open = agent(&state, AgentIdentityMode::Individual, None).await;
    vault_agent_accounts_api::allow_created_account(&state, &open, "acc_new").await;
    let record = state.agent_store.get(&open).await.unwrap().unwrap();
    assert!(record.account_access.is_none());
}

fn provider_call(provider: &str, account: Option<&str>) -> ryu_app_events::ManagedProviderCall {
    serde_json::from_value(json!({
        "provider": provider,
        "toolId": "x.x.post.create",
        "accountId": account,
        "method": "POST",
        "requestId": "req-1",
    }))
    .unwrap()
}

fn grant_headers(grant: Option<&str>) -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    if let Some(grant) = grant {
        headers.insert(
            crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER,
            grant.parse().unwrap(),
        );
    }
    headers
}

async fn provider_refusal(
    state: &ServerState,
    plugin: &str,
    grant: Option<&str>,
    call: &ryu_app_events::ManagedProviderCall,
) -> Option<(StatusCode, Value)> {
    let response = super::provider_router::authorize_agent_provider_call(
        state,
        plugin,
        &grant_headers(grant),
        call,
    )
    .await
    .err()?;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    Some((status, serde_json::from_slice(&bytes).unwrap()))
}

/// While an app serves a limited agent's request it must hand back the grant on
/// every provider call, except the account-less Composio `capabilities` lookup:
/// that reads public toolkit metadata and could never be allowed for an agent.
#[tokio::test]
async fn a_capabilities_lookup_needs_no_grant_while_an_agent_request_is_active() {
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());
    // An app id no other test forwards agent requests to.
    let plugin = "@ryu/provider-capabilities-test";
    let _context = crate::sidecar::deferred_authorization::enter_agent_request(plugin);

    let lookup = |provider: &str, operation: &str, account: Option<&str>| {
        let mut call = provider_call(provider, account);
        call.operation = Some(operation.to_owned());
        call
    };
    assert!(provider_refusal(
        &state,
        plugin,
        None,
        &lookup("composio", "capabilities", None)
    )
    .await
    .is_none());
    for refused in [
        lookup("composio", "execute", None),
        lookup("composio", "capabilities", Some("ca_user")),
        lookup("treg", "capabilities", None),
    ] {
        let (status, body) = provider_refusal(&state, plugin, None, &refused)
            .await
            .expect("a grant-less call is refused while an agent request is active");
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["reason"], "agent_account_access");
    }
}

/// An app's `providers.call` for an agent carries the grant Core stamped when it
/// forwarded the agent's request, also when the app runs the call later from
/// its scheduler. Core applies the agent's current account access to it before
/// anything reaches Gateway.
#[tokio::test]
async fn app_provider_calls_follow_the_granting_agents_treg_switch() {
    use crate::sidecar::deferred_authorization::agent_grant;
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());

    let limited = agent(&state, AgentIdentityMode::Managed, Some(Vec::new())).await;
    let treg = agent(
        &state,
        AgentIdentityMode::Managed,
        Some(vec!["platform:treg"]),
    )
    .await;
    let own_identity = agent(&state, AgentIdentityMode::Individual, None).await;
    let legacy = agent(&state, AgentIdentityMode::Managed, None).await;
    let treg_call = provider_call("treg", None);
    let grant = |agent_id: &str| agent_grant("@ryu/social", agent_id).expect("node token");

    // No grant: not on an agent's behalf, unchanged. (An app id no other test
    // forwards agent requests to, so no other test's agent context applies.)
    assert!(
        provider_refusal(&state, "@ryu/provider-no-grant-test", None, &treg_call)
            .await
            .is_none()
    );
    for allowed in [&treg, &own_identity, &legacy] {
        assert!(
            provider_refusal(&state, "@ryu/social", Some(&grant(allowed)), &treg_call)
                .await
                .is_none(),
            "{allowed}"
        );
    }

    let (status, body) =
        provider_refusal(&state, "@ryu/social", Some(&grant(&limited)), &treg_call)
            .await
            .expect("an agent without platform:treg is refused");
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["reason"], "agent_account_access");
    assert!(body["error"].as_str().unwrap().contains("Treg"), "{body}");

    // The policy is read at call time, so a grant stored with a scheduled post
    // follows a later change to the agent's settings.
    let stored = grant(&treg);
    state
        .agent_store
        .update(
            &treg,
            crate::agents::UpdateAgent {
                account_access: Some(Some(Vec::new())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        provider_refusal(&state, "@ryu/social", Some(&stored), &treg_call)
            .await
            .is_some()
    );

    // Composio calls must name an account this agent may use.
    let mixed = agent(
        &state,
        AgentIdentityMode::Mixed,
        Some(vec!["composio:ca_1"]),
    )
    .await;
    assert!(provider_refusal(
        &state,
        "@ryu/social",
        Some(&grant(&mixed)),
        &provider_call("composio", Some("ca_1"))
    )
    .await
    .is_none());
    for call in [
        provider_call("composio", Some("ca_2")),
        provider_call("composio", None),
    ] {
        assert!(
            provider_refusal(&state, "@ryu/social", Some(&grant(&mixed)), &call)
                .await
                .is_some()
        );
    }
}

#[tokio::test]
async fn app_provider_calls_refuse_grants_that_do_not_verify() {
    use crate::sidecar::deferred_authorization::agent_grant;
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());
    let treg = agent(
        &state,
        AgentIdentityMode::Managed,
        Some(vec!["platform:treg"]),
    )
    .await;
    let call = provider_call("treg", None);

    // A grant minted for another app cannot be presented by this one.
    let other_app = agent_grant("@ryu/ugc", &treg).expect("node token");
    // An agent that no longer exists, and a forged grant, fail closed.
    let unknown = agent_grant("@ryu/social", "agent-that-was-deleted").expect("node token");
    for grant in [other_app.as_str(), unknown.as_str(), "forged.grant"] {
        let (status, body) = provider_refusal(&state, "@ryu/social", Some(grant), &call)
            .await
            .expect("refused");
        assert_eq!(status, StatusCode::FORBIDDEN, "{grant}: {body}");
        assert_eq!(body["reason"], "agent_account_access");
    }
}

/// A grant stored before the node token rotated no longer verifies. Work an
/// agent started still goes out when that agent is now unrestricted (a call
/// with no grant would), and stays refused when its access is limited.
#[tokio::test]
async fn a_stale_grant_passes_only_for_an_agent_that_is_now_unrestricted() {
    use crate::sidecar::deferred_authorization::agent_grant_signed_with;
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());
    let unrestricted = agent(&state, AgentIdentityMode::Managed, None).await;
    let limited = agent(
        &state,
        AgentIdentityMode::Managed,
        Some(vec!["platform:treg"]),
    )
    .await;
    let call = provider_call("treg", None);
    let stale = |agent_id: &str| {
        agent_grant_signed_with("@ryu/social", agent_id, "a-rotated-node-token").expect("sign")
    };

    assert!(
        provider_refusal(&state, "@ryu/social", Some(&stale(&unrestricted)), &call)
            .await
            .is_none()
    );
    let (status, body) = provider_refusal(&state, "@ryu/social", Some(&stale(&limited)), &call)
        .await
        .expect("a limited agent's stale grant is refused");
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["reason"], "agent_account_access");
    // A stale grant naming an agent that no longer exists stays refused.
    assert!(
        provider_refusal(&state, "@ryu/social", Some(&stale("agent-gone")), &call)
            .await
            .is_some()
    );
}

async fn subscribe_own(state: &ServerState, agent_id: &str, account: &str) -> (StatusCode, Value) {
    let body: ComposioSubscribeBody = serde_json::from_value(json!({
        "agent_id": agent_id,
        "toolkit": "gmail",
        "trigger_slug": "GMAIL_NEW_GMAIL_MESSAGE",
        "connected_account_id": account,
        "own_account": true,
    }))
    .unwrap();
    let (status, Json(body)) =
        composio_trigger_subscribe(State(state.clone()), Extension(None), Json(body)).await;
    (status, body)
}

#[tokio::test]
async fn own_account_triggers_need_an_own_identity_and_an_allowed_account() {
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());

    let legacy = agent(&state, AgentIdentityMode::Managed, None).await;
    let managed_allowlisted = agent(
        &state,
        AgentIdentityMode::Managed,
        Some(vec!["agent-composio:own_1"]),
    )
    .await;
    let individual_other = agent(
        &state,
        AgentIdentityMode::Individual,
        Some(vec!["agent-composio:own_2"]),
    )
    .await;
    // A user-account key never covers an account on the agent's own entity.
    let mixed_user_key = agent(
        &state,
        AgentIdentityMode::Mixed,
        Some(vec!["composio:own_1"]),
    )
    .await;
    for agent_id in [
        &legacy,
        &managed_allowlisted,
        &individual_other,
        &mixed_user_key,
    ] {
        let (status, body) = subscribe_own(&state, agent_id, "own_1").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{agent_id}: {body}");
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("not allowed to use that connected account"),
            "{body}"
        );
    }

    // Unlike a user account, an own account needs the agent to exist.
    let (status, body) = subscribe_own(&state, "no-such-agent", "own_1").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    // An allowed agent passes the policy and goes on to the ownership check,
    // which needs Composio (unconfigured or unreachable in tests), so it is
    // never registered without that listing.
    let allowed = agent(
        &state,
        AgentIdentityMode::Individual,
        Some(vec!["agent-composio:own_1"]),
    )
    .await;
    let (status, body) = subscribe_own(&state, &allowed, "own_1").await;
    assert!(
        matches!(
            status,
            StatusCode::SERVICE_UNAVAILABLE | StatusCode::BAD_GATEWAY
        ),
        "{status}: {body}"
    );
}

/// While Core forwards an agent's request to an app, that app's provider calls
/// must hand back the agent grant; one without it is refused rather than run
/// with the user's accounts. Once the request ends, a grant-less call is the
/// app's own again.
#[tokio::test]
async fn a_provider_call_without_the_grant_is_refused_while_an_agent_request_is_in_flight() {
    use crate::sidecar::deferred_authorization::{agent_grant, enter_agent_request};
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());
    let plugin = "@ryu/provider-agent-context-test";
    let open = agent(&state, AgentIdentityMode::Managed, None).await;
    let call = provider_call("treg", None);

    assert!(provider_refusal(&state, plugin, None, &call)
        .await
        .is_none());

    let first = enter_agent_request(plugin);
    let second = enter_agent_request(plugin);
    let (status, body) = provider_refusal(&state, plugin, None, &call)
        .await
        .expect("a grant-less call during an agent request is refused");
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["reason"], "agent_account_access");
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("forward the agent grant"),
        "{body}"
    );
    // Another app is unaffected.
    assert!(
        provider_refusal(&state, "@ryu/provider-other-app-test", None, &call)
            .await
            .is_none()
    );
    // The grant it should have forwarded still works.
    let grant = agent_grant(plugin, &open).expect("node token");
    assert!(provider_refusal(&state, plugin, Some(&grant), &call)
        .await
        .is_none());

    // The context lasts until every agent request to the app has ended.
    drop(first);
    assert!(provider_refusal(&state, plugin, None, &call)
        .await
        .is_some());
    drop(second);
    assert!(provider_refusal(&state, plugin, None, &call)
        .await
        .is_none());

    // `providers.authorize` applies the same rules to a provider the app
    // reaches itself: an unrestricted agent passes, a limited one does not.
    let limited = agent(&state, AgentIdentityMode::Managed, Some(Vec::new())).await;
    let authorize = |agent_id: String| {
        let state = state.clone();
        async move {
            super::provider_router::authorize_agent_provider(
                &state,
                plugin,
                &grant_headers(Some(&agent_grant(plugin, &agent_id).unwrap())),
                "bluesky",
                None,
            )
            .await
        }
    };
    assert!(authorize(open.clone()).await.is_ok());
    let refused = authorize(limited).await.expect_err("limited agent refused");
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
}
