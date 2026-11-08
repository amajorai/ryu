use rusqlite::Connection;

use super::super::policy::{self, evaluate, CapabilitySet, PolicyRule};
use super::super::policy_ext::{ControlGroupFactor, ControlGroupSpec};
use super::*;

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    policy::init_schema(&conn).unwrap();
    init_schema(&conn).unwrap();
    conn
}

fn step(name: &str, approvers: &[&str], approvals: u8) -> ControlGroupFactor {
    ControlGroupFactor {
        name: name.to_owned(),
        approvers: approvers.iter().map(|a| (*a).to_owned()).collect(),
        approvals,
    }
}

fn access_policy(name: &str, path: &str, steps: Vec<ControlGroupFactor>) -> AccessPolicy {
    AccessPolicy {
        name: name.to_owned(),
        description: String::new(),
        path: path.to_owned(),
        capabilities: vec![Capability::List, Capability::Use, Capability::Read],
        max_duration_secs: 3600,
        request_ttl_secs: None,
        steps,
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

fn subjects(id: &str) -> Vec<String> {
    vec![format!("user:{id}")]
}

fn caps_of(conn: &Connection, who: &str, key: &str) -> CapabilitySet {
    let policies = policy::policies_for(conn, &subjects(who)).unwrap();
    evaluate(&CapabilitySet::new(), &policies, key)
}

#[test]
fn sequential_steps_grant_a_binding_that_expires() {
    let conn = conn();
    put_policy(
        &conn,
        &access_policy(
            "prod",
            "prod/**",
            vec![
                step("lead", &["user:bob"], 1),
                step("security", &["user:carol", "user:dan"], 2),
            ],
        ),
    )
    .unwrap();
    let now = now_millis();
    let request = create_request(
        &conn,
        "user:alice",
        &ask("prod/api/*", &[Capability::Read], 600),
        now,
    )
    .unwrap();
    assert_eq!(request.status, AccessRequestStatus::Pending);
    assert_eq!(request.environment, "prod");
    assert_eq!(request.current_step.as_deref(), Some("prod/lead"));
    assert!(caps_of(&conn, "alice", "prod/api/KEY").is_empty());

    // The requester never decides; a later step cannot jump the queue.
    let own = approve(&conn, &request.id, "user:alice", &subjects("alice"), now);
    assert!(own.unwrap_err().to_string().contains("their own request"));
    let early = approve(&conn, &request.id, "user:carol", &subjects("carol"), now);
    assert!(early.unwrap_err().to_string().contains("prod/lead"));

    let after_lead = approve(&conn, &request.id, "user:bob", &subjects("bob"), now).unwrap();
    assert_eq!(after_lead.current_step.as_deref(), Some("prod/security"));
    let one = approve(&conn, &request.id, "user:carol", &subjects("carol"), now).unwrap();
    assert_eq!(
        one.status,
        AccessRequestStatus::Pending,
        "security needs two"
    );
    // Repeating an approval does not count twice.
    let again = approve(&conn, &request.id, "user:carol", &subjects("carol"), now).unwrap();
    assert_eq!(again.status, AccessRequestStatus::Pending);
    assert!(caps_of(&conn, "alice", "prod/api/KEY").is_empty());

    let granted = approve(&conn, &request.id, "user:dan", &subjects("dan"), now).unwrap();
    assert_eq!(granted.status, AccessRequestStatus::Granted);
    let grant_policy = granted.grant_policy.clone().unwrap();
    assert_eq!(grant_policy, format!("access-{}", request.id));
    assert_eq!(granted.grant_expires_at, Some(now + 600_000));
    assert!(caps_of(&conn, "alice", "prod/api/KEY").contains(&Capability::Read));
    assert!(caps_of(&conn, "alice", "prod/api/nested/KEY").is_empty());
    assert!(caps_of(&conn, "alice", "staging/api/KEY").is_empty());
    assert!(caps_of(&conn, "bob", "prod/api/KEY").is_empty());

    // Once the duration passes the grant reads expired and pruning removes it.
    let later = now + 601_000;
    let lapsed = get_request(&conn, &request.id, later).unwrap().unwrap();
    assert_eq!(lapsed.status, AccessRequestStatus::Expired);
    assert!(prune(&conn, later).unwrap() >= 1);
    assert!(!policy::list_policies(&conn)
        .unwrap()
        .iter()
        .any(|p| p.name == grant_policy));
    assert!(caps_of(&conn, "alice", "prod/api/KEY").is_empty());
}

#[test]
fn one_person_counts_toward_one_step_only() {
    let conn = conn();
    put_policy(
        &conn,
        &access_policy(
            "prod",
            "prod/**",
            vec![
                step("a", &["user:bob"], 1),
                step("b", &["user:bob", "user:carol"], 1),
            ],
        ),
    )
    .unwrap();
    let now = now_millis();
    let request = create_request(
        &conn,
        "user:alice",
        &ask("prod/**", &[Capability::Use], 600),
        now,
    )
    .unwrap();
    approve(&conn, &request.id, "user:bob", &subjects("bob"), now).unwrap();
    let twice = approve(&conn, &request.id, "user:bob", &subjects("bob"), now);
    assert!(twice.unwrap_err().to_string().contains("one step only"));
    let granted = approve(&conn, &request.id, "user:carol", &subjects("carol"), now).unwrap();
    assert_eq!(granted.status, AccessRequestStatus::Granted);
}

#[test]
fn requests_fail_closed_without_a_covering_policy() {
    let conn = conn();
    let now = now_millis();
    let none = create_request(
        &conn,
        "user:alice",
        &ask("prod/**", &[Capability::Use], 600),
        now,
    );
    assert!(none
        .unwrap_err()
        .to_string()
        .contains("no access policy covers"));

    put_policy(
        &conn,
        &access_policy("api", "prod/api/**", vec![step("lead", &["user:bob"], 1)]),
    )
    .unwrap();
    let wider = create_request(
        &conn,
        "user:alice",
        &ask("prod/**", &[Capability::Use], 600),
        now,
    );
    assert!(
        wider.is_err(),
        "a narrower policy never covers a wider request"
    );
    let admin = create_request(
        &conn,
        "user:alice",
        &ask("prod/api/*", &[Capability::Admin], 600),
        now,
    );
    assert!(admin
        .unwrap_err()
        .to_string()
        .contains("cannot be requested"));
    let write = create_request(
        &conn,
        "user:alice",
        &ask("prod/api/*", &[Capability::Write], 600),
        now,
    );
    assert!(write.unwrap_err().to_string().contains("does not allow"));
    let long = create_request(
        &conn,
        "user:alice",
        &ask("prod/api/*", &[Capability::Use], 7200),
        now,
    );
    assert!(long.unwrap_err().to_string().contains("at most 3600"));
    let mut blank = ask("prod/api/*", &[Capability::Use], 600);
    blank.reason = "  ".to_owned();
    assert!(create_request(&conn, "user:alice", &blank, now).is_err());
}

#[test]
fn overlapping_policies_chain_in_name_order_and_take_the_strictest_limits() {
    let conn = conn();
    put_policy(
        &conn,
        &access_policy("a-prod", "prod/**", vec![step("lead", &["user:bob"], 1)]),
    )
    .unwrap();
    let mut payments = access_policy(
        "b-payments",
        "prod/payments/**",
        vec![step("cfo", &["user:carol"], 1)],
    );
    payments.max_duration_secs = 300;
    put_policy(&conn, &payments).unwrap();
    let chain = plan(
        &list_policies(&conn).unwrap(),
        "prod/**",
        &[Capability::Use],
        300,
    )
    .unwrap();
    assert_eq!(chain.policies, vec!["a-prod", "b-payments"]);
    let names: Vec<&str> = chain.steps.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["a-prod/lead", "b-payments/cfo"]);
    assert_eq!(chain.max_duration_secs, 300);
    // A path that cannot reach payments needs only the prod chain.
    let api = plan(
        &list_policies(&conn).unwrap(),
        "prod/api/*",
        &[Capability::Use],
        3600,
    )
    .unwrap();
    assert_eq!(api.policies, vec!["a-prod"]);
}

#[test]
fn a_changed_chain_never_grants() {
    let conn = conn();
    put_policy(
        &conn,
        &access_policy("prod", "prod/**", vec![step("lead", &["user:bob"], 1)]),
    )
    .unwrap();
    let now = now_millis();
    let request = create_request(
        &conn,
        "user:alice",
        &ask("prod/**", &[Capability::Use], 600),
        now,
    )
    .unwrap();
    put_policy(
        &conn,
        &access_policy("prod", "prod/**", vec![step("lead", &["user:bob"], 2)]),
    )
    .unwrap();
    let stale = approve(&conn, &request.id, "user:bob", &subjects("bob"), now);
    assert!(stale
        .unwrap_err()
        .to_string()
        .contains("access policy changed"));
    assert!(caps_of(&conn, "alice", "prod/KEY").is_empty());
}

#[test]
fn deny_cancel_revoke_and_lapse_are_terminal() {
    let conn = conn();
    put_policy(
        &conn,
        &access_policy("prod", "prod/**", vec![step("lead", &["user:bob"], 1)]),
    )
    .unwrap();
    let now = now_millis();
    let make = || {
        create_request(
            &conn,
            "user:alice",
            &ask("prod/**", &[Capability::Use], 600),
            now,
        )
        .unwrap()
    };

    let denied = make();
    assert!(deny(
        &conn,
        &denied.id,
        "user:carol",
        &subjects("carol"),
        None,
        now
    )
    .is_err());
    let denied = deny(
        &conn,
        &denied.id,
        "user:bob",
        &subjects("bob"),
        Some("not now"),
        now,
    )
    .unwrap();
    assert_eq!(denied.status, AccessRequestStatus::Denied);
    assert_eq!(denied.decision_reason.as_deref(), Some("not now"));
    assert!(approve(&conn, &denied.id, "user:bob", &subjects("bob"), now).is_err());

    let cancelled = make();
    assert!(cancel(&conn, &cancelled.id, "user:bob", now).is_err());
    let cancelled = cancel(&conn, &cancelled.id, "user:alice", now).unwrap();
    assert_eq!(cancelled.status, AccessRequestStatus::Cancelled);

    let granted = make();
    approve(&conn, &granted.id, "user:bob", &subjects("bob"), now).unwrap();
    assert!(caps_of(&conn, "alice", "prod/KEY").contains(&Capability::Use));
    let revoked = revoke(&conn, &granted.id, "user:alice", now).unwrap();
    assert_eq!(revoked.status, AccessRequestStatus::Revoked);
    assert!(caps_of(&conn, "alice", "prod/KEY").is_empty());
    assert!(revoke(&conn, &granted.id, "user:alice", now).is_err());

    let lapsing = make();
    let after = lapsing.expires_at + 1;
    assert_eq!(
        get_request(&conn, &lapsing.id, after)
            .unwrap()
            .unwrap()
            .status,
        AccessRequestStatus::Expired
    );
    assert!(approve(&conn, &lapsing.id, "user:bob", &subjects("bob"), after).is_err());

    let mine = list_requests(&conn, &subjects("alice"), false, now).unwrap();
    assert_eq!(mine.len(), 4);
    assert_eq!(
        list_requests(&conn, &subjects("bob"), false, now)
            .unwrap()
            .len(),
        4
    );
    assert!(list_requests(&conn, &subjects("eve"), false, now)
        .unwrap()
        .is_empty());
    assert_eq!(list_requests(&conn, &[], true, now).unwrap().len(), 4);
}

#[test]
fn read_is_refused_where_a_control_group_may_gate_it() {
    let conn = conn();
    put_policy(
        &conn,
        &access_policy("prod", "prod/**", vec![step("lead", &["user:bob"], 1)]),
    )
    .unwrap();
    policy::put_policy(
        &conn,
        &Policy {
            name: "gate".to_owned(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: "prod/payments/*".to_owned(),
                capabilities: vec![Capability::Read],
                control_group: Some(ControlGroupSpec {
                    ttl_secs: None,
                    factors: vec![step("sec", &["user:carol"], 1)],
                }),
                ..Default::default()
            }],
        },
    )
    .unwrap();
    let now = now_millis();
    let gated = create_request(
        &conn,
        "user:alice",
        &ask("prod/**", &[Capability::Read], 600),
        now,
    );
    assert!(gated.unwrap_err().to_string().contains("control group"));
    assert!(create_request(
        &conn,
        "user:alice",
        &ask("prod/**", &[Capability::Use], 600),
        now
    )
    .is_ok());
    assert!(create_request(
        &conn,
        "user:alice",
        &ask("prod/api/*", &[Capability::Read], 600),
        now
    )
    .is_ok());
}

#[test]
fn access_policies_validate_their_shape() {
    let conn = conn();
    let mut bad = access_policy("prod", "prod/**", vec![]);
    assert!(put_policy(&conn, &bad).is_err(), "needs a step");
    bad.steps = vec![step("lead", &["user:bob"], 1)];
    bad.capabilities = vec![Capability::Approve];
    assert!(put_policy(&conn, &bad).is_err());
    bad.capabilities = vec![Capability::Use];
    bad.max_duration_secs = 10;
    assert!(put_policy(&conn, &bad).is_err());
    bad.max_duration_secs = 600;
    bad.path = "prod/{{identity.user.id}}".to_owned();
    assert!(put_policy(&conn, &bad).is_err());
    bad.path = "prod/**".to_owned();
    put_policy(&conn, &bad).unwrap();
    assert_eq!(list_policies(&conn).unwrap(), vec![bad]);
    assert!(delete_policy(&conn, "prod").unwrap());
    assert!(list_policies(&conn).unwrap().is_empty());
}
