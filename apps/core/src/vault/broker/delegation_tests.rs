use super::*;
use crate::vault::broker::sessions::{self, MintRequest};

fn request() -> MintRequest {
    MintRequest {
        environment: "default".into(),
        services: vec!["github".into()],
        label: String::new(),
        minted_by: "machine:m1".into(),
        ttl_secs: None,
        not_after: None,
        minted_token: None,
        minter_scope: None,
    }
}

#[tokio::test]
async fn attributes_round_trip_and_follow_their_session() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    let (_, delegated) = sessions::mint(&conn, request()).unwrap();
    let (_, plain) = sessions::mint(&conn, request()).unwrap();
    let attrs = SessionAttrs {
        on_behalf_of: Some(Member {
            user_id: "alice".into(),
            subjects: vec!["user:alice".into(), "role:member".into()],
        }),
        remote: true,
    };
    insert(&conn, &delegated.id, &attrs).unwrap();
    insert(&conn, &plain.id, &SessionAttrs::default()).unwrap();
    assert_eq!(get(&conn, &delegated.id).unwrap(), attrs);
    assert_eq!(get(&conn, &plain.id).unwrap(), SessionAttrs::default());
    assert_eq!(
        attrs.on_behalf_of.as_ref().unwrap().roles(),
        vec!["member".to_owned()]
    );
    // Pruning removes rows only once their session is gone. A revoked session
    // stays in the history (up to `MAX_HISTORY_ROWS`), so its attributes stay
    // with it until the history drops the row.
    assert_eq!(prune(&conn).unwrap(), 0);
    sessions::revoke(&conn, &delegated.id).unwrap();
    sessions::prune(&conn, crate::vault::now_millis()).unwrap();
    assert_eq!(prune(&conn).unwrap(), 0);
    assert_eq!(get(&conn, &delegated.id).unwrap(), attrs);
    conn.execute(
        "DELETE FROM vault_broker_sessions WHERE id = ?1",
        [&delegated.id],
    )
    .unwrap();
    assert_eq!(prune(&conn).unwrap(), 1);
    assert_eq!(get(&conn, &delegated.id).unwrap(), SessionAttrs::default());
}

#[tokio::test]
async fn a_corrupt_member_fails_closed() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    conn.execute(
        "INSERT INTO vault_broker_session_attrs (session_id, on_behalf_of) VALUES ('bvs_x', '{')",
        [],
    )
    .unwrap();
    assert!(get(&conn, "bvs_x").is_err());
}

#[test]
fn members_are_user_ids() {
    assert_eq!(parse_member("user:alice").unwrap(), "alice");
    assert_eq!(parse_member(" u_1-2.x ").unwrap(), "u_1-2.x");
    for bad in ["", "user:", "role:admin", "a/b", "a b", &"x".repeat(129)] {
        assert!(parse_member(bad).is_err(), "{bad}");
    }
    assert_eq!(delegate_key("alice"), "sys/broker/delegate/alice");
}

#[test]
fn subjects_need_the_complete_team_list() {
    let caller = crate::identity_verify::VerifiedCaller {
        user_id: "alice".into(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".into()),
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    };
    let subjects = subjects_of(&caller, Some(vec!["t1".into()])).unwrap();
    assert_eq!(subjects, vec!["user:alice", "role:member", "team:t1"]);
    assert!(subjects_of(&caller, None).is_err());
}

#[tokio::test]
async fn an_unbound_node_has_no_members_to_act_for() {
    // No test member registered for this id and no control plane.
    let error = verify_member("nobody-registered").await.unwrap_err();
    assert_eq!(error.code(), "vault_invalid_request");
    set_test_member("bob", &["user:bob", "role:viewer"]);
    let member = verify_member("user:bob").await.unwrap();
    assert_eq!(member.subject(), "user:bob");
    assert_eq!(member.roles(), vec!["viewer".to_owned()]);
}
