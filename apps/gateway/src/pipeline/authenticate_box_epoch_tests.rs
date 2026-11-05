//! A hosted `gwb1` is refused once its org's Box proof-key epoch moves past
//! the epoch it was signed at, so a removed admin who copied a node's key
//! cannot keep minting Box keys for the org.

use super::*;
use crate::pipeline::core_proof::box_key_epoch::box_hosted_keys_at_epoch_from;

const GOVERNED: &str = r#""managedInference":true,"remainingBudgetMicroUsd":5000000,"governance":{"policy":{"rules":{}},"limits":{},"standing":{"state":"active","refuses":"none"}}"#;

fn budget_at(epoch: u64) -> &'static str {
    Box::leak(format!("{{{GOVERNED},\"boxProofKeyEpoch\":{epoch}}}").into_boxed_str())
}

fn hosted_state() -> AppState {
    state_with_auth(AuthConfig {
        require_auth: true,
        master_key: None,
        api_keys: Vec::new(),
    })
}

fn scope_for(
    org: &str,
    user: Option<&str>,
    key_epoch: u64,
) -> ryu_gw_credentials::BoxInferenceScope {
    let mut scope = box_scope(org, unix_now() + 600);
    scope.user_id = user.map(str::to_owned);
    scope.key_epoch = key_epoch;
    scope
}

async fn authenticate_token(state: &AppState, token: &str) -> Result<RequestContext, GatewayError> {
    let bearer = format!("Bearer {token}");
    authenticate(state, AuthInputs::with_key(Some(&bearer))).await
}

#[tokio::test]
async fn gwb1_signed_at_a_retired_epoch_is_refused_with_or_without_a_member() {
    let master = "gwb1-test-master-epoch-0123456789abcdef012";
    let _master = MasterKeyEnv::set(master).await;
    let state = hosted_state();
    // The plane reports epoch 1: an admin who held the epoch-0 key left.
    let (url, _) = fake_budget_plane(200, budget_at(1)).await;
    let _source = BoxBudgetOverride::set(&url);
    let org = format!("org-epoch-{}", Uuid::new_v4().simple());
    let retired = ryu_gw_credentials::derive_org_core_proof_key(master, &org).unwrap();
    for user in [None, Some("user-a")] {
        let token = scope_for(&org, user, 0).sign(&retired).unwrap();
        assert!(matches!(
            authenticate_token(&state, &token).await,
            Err(GatewayError::Unauthorized(_))
        ));
    }
    // Claiming the new epoch does not help without the new key.
    let claimed = scope_for(&org, None, 1).sign(&retired).unwrap();
    assert!(matches!(
        authenticate_token(&state, &claimed).await,
        Err(GatewayError::Unauthorized(_))
    ));
    // A node re-keyed at epoch 1 is served.
    let current = ryu_gw_credentials::derive_org_box_proof_key(master, &org, 1).unwrap();
    for user in [None, Some("user-a")] {
        let token = scope_for(&org, user, 1).sign(&current).unwrap();
        let context = authenticate_token(&state, &token).await.unwrap();
        assert_eq!(context.org_id.as_deref(), Some(org.as_str()));
        assert!(context.managed_inference);
    }
}

#[tokio::test]
async fn gwb1_at_the_current_epoch_zero_keeps_working() {
    let master = "gwb1-test-master-epoch0-0123456789abcdef01";
    let _master = MasterKeyEnv::set(master).await;
    let state = hosted_state();
    let (url, _) = fake_budget_plane(200, budget_at(0)).await;
    let _source = BoxBudgetOverride::set(&url);
    let org = format!("org-epoch0-{}", Uuid::new_v4().simple());
    let key = ryu_gw_credentials::derive_org_core_proof_key(master, &org).unwrap();
    let token = scope_for(&org, Some("user-a"), 0).sign(&key).unwrap();
    assert!(authenticate_token(&state, &token).await.is_ok());
    // A later-epoch key is refused while the org is still at epoch 0.
    let ahead = ryu_gw_credentials::derive_org_box_proof_key(master, &org, 1).unwrap();
    let token = scope_for(&org, None, 1).sign(&ahead).unwrap();
    assert!(matches!(
        authenticate_token(&state, &token).await,
        Err(GatewayError::Unauthorized(_))
    ));
}

#[test]
fn later_epochs_verify_only_under_the_master_derived_key() {
    let master = "gwb1-test-master-epochkeys-0123456789abcd";
    let expected = ryu_gw_credentials::derive_org_box_proof_key(master, "org-a", 2).unwrap();
    assert_eq!(
        box_hosted_keys_at_epoch_from(Some(master), "org-a", 2),
        vec![expected]
    );
    assert!(box_hosted_keys_at_epoch_from(None, "org-a", 2).is_empty());
    assert!(box_hosted_keys_at_epoch_from(Some(master), "", 2).is_empty());
}
