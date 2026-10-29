//! The Pi subscription login route refuses Sign in with ChatGPT on a Ryu-hosted
//! node unless the caller's signed flags include the hosted OpenAI flag
//! (`chatgpt_plan_hosted_unavailable`). A self-hosted node, and every other
//! provider, is not gated. The flag-allows case needs a verified JWT and the
//! control plane, so it stays with `subscription_cloud` tests.
use super::*;
use crate::sidecar::control_plane::with_test_node_binding;

fn owner_without_hosted_flag() -> ResolvedAuthorization {
    ResolvedAuthorization {
        context: crate::authorization::AuthorizationContext::owner(0),
        bindings: crate::authorization::RequestBindings::default(),
        caller: None,
        verified_user_jwt: None,
    }
}

async fn login_refusal_body(
    auth: Option<ResolvedAuthorization>,
) -> (StatusCode, serde_json::Value) {
    let response = start_pi_provider_login(
        auth.map(Extension),
        Path(crate::pi_config::CHATGPT_PLAN_PROVIDER_ID.to_owned()),
        Query(PiLoginOptions::default()),
    )
    .await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn a_managed_node_owner_without_the_hosted_flag_cannot_start_a_chatgpt_login() {
    let (status, body) = with_test_node_binding(
        true,
        None,
        login_refusal_body(Some(owner_without_hosted_flag())),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "chatgpt_plan_hosted_unavailable");
}

#[tokio::test]
async fn a_managed_node_with_no_resolved_caller_cannot_start_a_chatgpt_login() {
    let (status, body) = with_test_node_binding(true, None, login_refusal_body(None)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "chatgpt_plan_hosted_unavailable");
}

#[tokio::test]
async fn a_self_hosted_node_and_other_providers_pass_the_chatgpt_gate() {
    let chatgpt = crate::pi_config::CHATGPT_PLAN_PROVIDER_ID;
    let owner = owner_without_hosted_flag();
    // Self-hosted: allowed with or without a resolved caller.
    assert!(with_test_node_binding(
        false,
        None,
        chatgpt_plan_login_refusal(chatgpt, Some(&owner))
    )
    .await
    .is_none());
    assert!(
        with_test_node_binding(false, None, chatgpt_plan_login_refusal(chatgpt, None))
            .await
            .is_none()
    );
    // Other providers are never gated, even on a managed node.
    assert!(with_test_node_binding(
        true,
        None,
        chatgpt_plan_login_refusal("anthropic", Some(&owner))
    )
    .await
    .is_none());
}
