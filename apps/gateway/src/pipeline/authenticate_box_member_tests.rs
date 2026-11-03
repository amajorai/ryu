//! A hosted `gwb1` key is signed with its org's node-held proof key, so it
//! does not prove the member it names: the control plane must vouch that the
//! member is current, and the key never reaches a member's personal Composio
//! entity.

use super::*;
use crate::pipeline::auth_identity::box_governance::composio_entity_user;

#[tokio::test]
async fn gwb1_hosted_key_naming_a_non_member_is_refused() {
    let master = "gwb1-test-master-member-0123456789abcdef01";
    let _master = MasterKeyEnv::set(master).await;
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        master_key: None,
        api_keys: Vec::new(),
    });
    // The plane answers 403 for a user who is not a current member.
    let (url, heads) = fake_budget_plane(403, r#"{"error":"not_a_member"}"#).await;
    let org = format!("org-member-{}", Uuid::new_v4().simple());
    let key = ryu_gw_credentials::derive_org_core_proof_key(master, &org).unwrap();
    let token = box_scope(&org, unix_now() + 600).sign(&key).unwrap();
    let bearer = format!("Bearer {token}");
    let _source = BoxBudgetOverride::set(&url);
    for _ in 0..2 {
        let outcome = authenticate(&state, AuthInputs::with_key(Some(&bearer))).await;
        // Refused outright: never a context carrying the named user's id,
        // and never a retryable outage.
        assert!(matches!(outcome, Err(GatewayError::Unauthorized(_))));
    }
    // A refusal is never cached, so a re-added member recovers at once.
    assert_eq!(heads.lock().unwrap().len(), 2);
    assert!(heads.lock().unwrap()[0].starts_with(&format!(
        "GET /api/gateway/orgs/{org}/budget?userId=user-a HTTP/1.1"
    )));
}

#[tokio::test]
async fn gwb1_hosted_key_never_selects_the_members_personal_composio_entity() {
    let master = "gwb1-test-master-composio-0123456789abcdef";
    let _master = MasterKeyEnv::set(master).await;
    let context = hosted_box_auth(
        master,
        "org-composio",
        r#"{"managedInference":true,"remainingBudgetMicroUsd":5000000,"governance":{"policy":{"rules":{}},"limits":{},"standing":{"state":"active","refuses":"none"}}}"#,
    )
    .await
    .unwrap();
    // The member still attributes spend and selects caps...
    assert_eq!(context.user_id.as_deref(), Some("user-a"));
    // ...but acts only through the org-shared Composio entity, in the
    // unified tool loop too.
    assert_eq!(composio_entity_user(&context), None);
    let org = context.org_id.clone().unwrap();
    let tenant = crate::composio::ComposioTenantScope::new(&org).unwrap();
    let state = state_with_auth(AuthConfig::default());
    let (unified, _) =
        crate::pipeline::tool_loop_select::unified_composio_identity(&state, &context).unwrap();
    assert_eq!(unified, Some(tenant.default_user_id()));

    // Any other authenticated caller keeps its accepted identity.
    let mut other = context.clone();
    other.feature = None;
    other.api_key = "rgw_org:org-composio".to_owned();
    assert_eq!(composio_entity_user(&other), Some("user-a"));
    let (unified, _) =
        crate::pipeline::tool_loop_select::unified_composio_identity(&state, &other).unwrap();
    assert_eq!(unified, Some(tenant.user_id("user-a")));
}
