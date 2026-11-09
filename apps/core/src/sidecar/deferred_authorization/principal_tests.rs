use super::super::{node_binding, sign, Envelope};
use super::*;
use crate::sidecar::control_plane;

const KEY: &str = "test-signing-key";

#[test]
fn a_forwarded_principal_names_the_member_for_one_app_only() {
    let forwarded = sign(
        &Envelope {
            purpose: "principal".to_owned(),
            plugin: "@ryu/example".to_owned(),
            node: node_binding(),
            org: control_plane::registered_org().map(|org| org.id),
            user: Some("member-2".to_owned()),
            expires_at: Some(chrono::Utc::now().timestamp() + 60),
            permission: None,
            resource: None,
            agent: None,
        },
        KEY,
    )
    .expect("sign");
    assert!(verify_forwarded_principal_with(&forwarded, "@ryu/example", "other-key").is_err());
    let caller = verify_forwarded_principal_with(&forwarded, "@ryu/example", KEY)
        .expect("verify")
        .expect("names a member");
    assert_eq!(caller.user_id, "member-2");
    assert!(verify_forwarded_principal_with(&forwarded, "@ryu/other", KEY).is_err());
}

#[test]
fn a_forwarded_principal_without_a_user_is_the_unbound_owner() {
    let owner = sign(
        &Envelope {
            purpose: "principal".to_owned(),
            plugin: "@ryu/example".to_owned(),
            node: node_binding(),
            org: control_plane::registered_org().map(|org| org.id),
            user: None,
            expires_at: Some(chrono::Utc::now().timestamp() + 60),
            permission: None,
            resource: None,
            agent: None,
        },
        KEY,
    )
    .expect("sign");
    assert!(verify_forwarded_principal_with(&owner, "@ryu/example", KEY)
        .expect("verify")
        .is_none());
}

#[test]
fn a_proof_minted_for_another_purpose_or_expired_is_refused() {
    let envelope = |purpose: &str, expires_at: i64| Envelope {
        purpose: purpose.to_owned(),
        plugin: "@ryu/example".to_owned(),
        node: node_binding(),
        org: control_plane::registered_org().map(|org| org.id),
        user: Some("member-1".to_owned()),
        expires_at: Some(expires_at),
        permission: None,
        resource: None,
        agent: None,
    };
    let now = chrono::Utc::now().timestamp();
    let other = sign(&envelope("tool-principal", now + 60), KEY).expect("sign");
    assert!(verify_forwarded_principal_with(&other, "@ryu/example", KEY).is_err());
    let expired = sign(&envelope("principal", now - 1), KEY).expect("sign");
    assert!(verify_forwarded_principal_with(&expired, "@ryu/example", KEY).is_err());
}
