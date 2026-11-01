//! The Claude plan on a Ryu-hosted (managed) node: a managed node would send the plan
//! from a datacenter IP, so its Claude plan backends stay off without
//! `cloud_tasks.subscription_backends_hosted_anthropic` in the caller's verified signed
//! flags, exactly like the ChatGPT plan's hosted gate. A self-hosted node keeps them.
//! Shares the parent suite's fake CLI, store and `SERIAL`.
use super::*;
use crate::sidecar::control_plane::with_test_node_binding;

/// Whether the fake `claude` was asked to start any session.
fn started_a_claude_session(fake: &FakeCli) -> bool {
    fake.calls().iter().any(|call| {
        call.first().is_some_and(|program| program == "claude")
            && call
                .get(1)
                .is_some_and(|arg| arg == "--cloud" || arg == "-p")
    })
}

#[test]
fn the_hosted_anthropic_flag_matches_the_catalog_key() {
    assert_eq!(
        HOSTED_ANTHROPIC_FLAG,
        "cloud_tasks.subscription_backends_hosted_anthropic"
    );
    assert_ne!(HOSTED_ANTHROPIC_FLAG, HOSTED_OPENAI_FLAG);
}

#[tokio::test]
async fn a_claude_plan_is_allowed_only_on_a_self_hosted_node_without_the_flag() {
    // A self-hosted node is the owner's own network: allowed with no flag.
    with_test_node_binding(false, None, async {
        assert!(anthropic_plan_allowed(&node_owner()).await);
        assert!(anthropic_plan_allowed(&other_user()).await);
    })
    .await;
    // A managed node with no verified signed flags fails closed.
    with_test_node_binding(true, None, async {
        assert!(!anthropic_plan_allowed(&node_owner()).await);
        let mut unverifiable = node_owner();
        unverifiable.verified_user_jwt = Some("not.a.jwt".into());
        assert!(!anthropic_plan_allowed(&unverifiable).await);
        // The same answer as the ChatGPT gate on the same node.
        assert_eq!(
            anthropic_plan_allowed(&node_owner()).await,
            openai_plan_allowed(&node_owner()).await
        );
    })
    .await;
}

#[tokio::test]
async fn a_managed_node_refuses_or_falls_back_from_claude_plan_backends() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    let fake = FakeCli::install(claude_with(started_claude));

    with_test_node_binding(true, None, async {
        // A strict pin to either Claude plan backend is refused, not started.
        for backend in [
            CloudTaskBackend::AnthropicSubscriptionCli,
            CloudTaskBackend::AnthropicSubscriptionSdk,
        ] {
            let pin = SessionPin {
                backend: Some(backend),
                fallback: false,
            };
            let error = start_or_fall_back(
                &node_owner(),
                request(&fresh_conversation(), "claude-code", pin),
            )
            .await
            .expect_err("strict pin, Claude plan off on a hosted node");
            assert_eq!(error_code(&error), "subscription_backend_unavailable");
        }

        // With plans on and no pin, the task falls back to the Ryu Box quietly:
        // a plan that is turned off is not news.
        let outcome = start_or_fall_back(
            &node_owner(),
            request(&fresh_conversation(), "claude-code", unpinned()),
        )
        .await
        .expect("falls back");
        let RouteOutcome::UseBox { notices } = outcome else {
            panic!("expected the Box, got {outcome:?}");
        };
        assert!(notices.is_empty(), "{notices:?}");
    })
    .await;

    assert!(
        !started_a_claude_session(&fake),
        "no Claude session starts from a hosted node"
    );
    assert!(store::runs_for("node-owner").is_empty());
}

#[tokio::test]
async fn a_self_hosted_node_runs_the_task_on_the_claude_plan() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    let fake = FakeCli::install(claude_with(started_claude));

    let outcome = with_test_node_binding(
        false,
        None,
        start_or_fall_back(
            &node_owner(),
            request(&fresh_conversation(), "claude-code", unpinned()),
        ),
    )
    .await
    .expect("routes");
    let RouteOutcome::Started { record, notices } = outcome else {
        panic!("expected a plan run, got {outcome:?}");
    };
    assert!(notices.is_empty());
    assert_eq!(record.backend, CloudTaskBackend::AnthropicSubscriptionCli);
    assert!(started_a_claude_session(&fake));
}
