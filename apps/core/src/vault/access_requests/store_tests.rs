use super::super::super::now_millis;
use super::super::super::policy::{evaluate, CapabilitySet};
use super::super::super::policy_ext::ControlGroupSpec;
use super::super::{put_policy, AccessPolicy};
use super::*;

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    policy::init_schema(&conn).unwrap();
    init_schema(&conn).unwrap();
    conn
}

fn lead(name: &str, approver: &str) -> ControlGroupFactor {
    ControlGroupFactor {
        name: name.to_owned(),
        approvers: vec![approver.to_owned()],
        approvals: 1,
    }
}

fn access_policy(name: &str, path: &str) -> AccessPolicy {
    AccessPolicy {
        name: name.to_owned(),
        description: String::new(),
        path: path.to_owned(),
        capabilities: vec![Capability::List, Capability::Use, Capability::Read],
        max_duration_secs: 3600,
        request_ttl_secs: None,
        steps: vec![lead("lead", "user:bob")],
    }
}

fn ask(path: &str, capabilities: &[Capability], duration_secs: i64) -> NewAccessRequest {
    NewAccessRequest {
        path: path.to_owned(),
        capabilities: capabilities.to_vec(),
        duration_secs,
        reason: "incident 42".to_owned(),
    }
}

fn caps_of(conn: &Connection, who: &str, key: &str) -> CapabilitySet {
    let policies = policy::policies_for(conn, &[format!("user:{who}")]).unwrap();
    evaluate(&CapabilitySet::new(), &policies, key)
}

#[test]
fn prune_lapses_pending_requests_and_forgets_old_history() {
    let conn = Connection::open_in_memory().unwrap();
    policy::init_schema(&conn).unwrap();
    init_schema(&conn).unwrap();
    put_policy(
        &conn,
        &AccessPolicy {
            name: "prod".to_owned(),
            description: String::new(),
            path: "prod/**".to_owned(),
            capabilities: vec![Capability::Use],
            max_duration_secs: 600,
            request_ttl_secs: Some(60),
            steps: vec![ControlGroupFactor {
                name: "lead".to_owned(),
                approvers: vec!["user:bob".to_owned()],
                approvals: 1,
            }],
        },
    )
    .unwrap();
    let ask = NewAccessRequest {
        path: "prod/**".to_owned(),
        capabilities: vec![Capability::Use],
        duration_secs: 600,
        reason: "deploy".to_owned(),
    };
    let lapsing = create_request(&conn, "user:alice", &ask, 0).unwrap();
    assert_eq!(lapsing.expires_at, 60_000);
    assert_eq!(prune(&conn, 59_999).unwrap(), 0);
    assert_eq!(prune(&conn, 60_000).unwrap(), 1);
    let stored = load(&conn, &lapsing.id).unwrap().unwrap();
    assert_eq!(stored.status, AccessRequestStatus::Expired);
    prune(&conn, 60_000 + HISTORY_MILLIS - 1).unwrap();
    assert!(load(&conn, &lapsing.id).unwrap().is_some());
    prune(&conn, 60_000 + HISTORY_MILLIS).unwrap();
    assert!(load(&conn, &lapsing.id).unwrap().is_none());
}

#[test]
fn requests_never_reach_the_reserved_system_prefix() {
    let conn = conn();
    let mut any = access_policy("any", "**");
    any.capabilities = vec![Capability::List, Capability::Use, Capability::Read];
    put_policy(&conn, &any).unwrap();
    let now = now_millis();
    for path in ["sys/**", "sys/broker/github", "sys/static/db"] {
        assert!(
            create_request(
                &conn,
                "user:alice",
                &ask(path, &[Capability::Use], 600),
                now
            )
            .is_err(),
            "{path} must be refused"
        );
        assert!(plan(&[any.clone()], path, &[Capability::Use], 600).is_err());
    }
    assert!(list_requests(&conn, &[], true, now).unwrap().is_empty());
    assert!(caps_of(&conn, "alice", "sys/broker/github").is_empty());
    assert!(create_request(
        &conn,
        "user:alice",
        &ask("prod/**", &[Capability::Use], 600),
        now
    )
    .is_ok());
}

#[test]
fn a_control_group_added_mid_flight_blocks_the_read_grant() {
    let conn = conn();
    put_policy(
        &conn,
        &access_policy("prod", "prod/**"),
    )
    .unwrap();
    let now = now_millis();
    let request = create_request(
        &conn,
        "user:alice",
        &ask("prod/**", &[Capability::Read], 600),
        now,
    )
    .unwrap();
    policy::put_policy(
        &conn,
        &Policy {
            name: "gate".to_owned(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: "prod/payments/**".to_owned(),
                capabilities: vec![Capability::Read],
                control_group: Some(ControlGroupSpec {
                    ttl_secs: None,
                    factors: vec![lead("sec", "user:carol")],
                }),
                ..Default::default()
            }],
        },
    )
    .unwrap();
    let refused = approve(&conn, &request.id, "user:bob", &["user:bob".to_owned()], now).unwrap_err();
    assert!(matches!(
        refused.downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    ));
    let grant = format!("{GRANT_POLICY_PREFIX}{}", request.id);
    assert!(policy::list_policies(&conn)
        .unwrap()
        .iter()
        .all(|p| p.name != grant));
    assert!(caps_of(&conn, "alice", "prod/payments/KEY").is_empty());
    assert_eq!(
        get_request(&conn, &request.id, now)
            .unwrap()
            .unwrap()
            .status,
        AccessRequestStatus::Pending
    );
}
