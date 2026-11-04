use super::super::policy::{evaluate_with, CapabilitySet};
// Each section's surface by its own path; `super::*` brings the shared
// constants and helpers.
use super::constraints::{check_parameters, validate_rule};
use super::control_group_store::{authorize, constant_time_eq, create_request, redeem};
use super::control_groups::{ControlGroupSpec, ControlGroupStatus};
use super::templates::{expand, validate_template, TemplateContext};
use super::*;
use serde_json::json;

fn subjects(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn rule(path: &str, caps: &[Capability], deny: bool) -> PolicyRule {
    PolicyRule {
        path: path.into(),
        capabilities: caps.to_vec(),
        deny,
        ..PolicyRule::default()
    }
}

fn policy(name: &str, rules: Vec<PolicyRule>) -> Policy {
    Policy {
        name: name.into(),
        description: String::new(),
        rules,
    }
}

#[test]
fn templates_validate_at_write_time() {
    assert!(validate_template("prod/{{identity.user.id}}/*").is_ok());
    assert!(validate_template("prod/u-{{ identity.user.id }}").is_ok());
    assert!(validate_template("prod/{{identity.secret}}").is_err());
    assert!(validate_template("prod/{{identity.user.id").is_err());
    assert!(validate_template("prod/{x}").is_err());
    assert!(validate_template("prod/}}").is_err());
    let mut bad = rule("prod/{{identity.nope}}", &[Capability::Read], false);
    assert!(super::super::policy::validate(&policy("p", vec![bad.clone()])).is_err());
    bad.path = "prod/{{identity.user.id}}".into();
    assert!(super::super::policy::validate(&policy("p", vec![bad])).is_ok());
}

#[test]
fn templates_expand_only_safe_identity_values() {
    let ctx = TemplateContext::from_subjects(&subjects(&[
        "user:alice",
        "team:t1",
        "team:t2",
        "machine:../evil",
    ]));
    assert_eq!(
        expand("u/{{identity.user.id}}/*", &ctx),
        Expansion::Concrete(vec!["u/alice/*".into()])
    );
    assert_eq!(
        expand("t/{{identity.team.ids}}", &ctx),
        Expansion::Concrete(vec!["t/t1".into(), "t/t2".into()])
    );
    // Unsafe value is never substituted; the template is unresolved.
    assert_eq!(
        expand("m/{{identity.machine.id}}", &ctx),
        Expansion::Unresolved("m/*".into())
    );
    for value in ["*", "a/b", "..", "a?", "{x}", "", "a b"] {
        assert!(!is_safe_template_value(value), "{value}");
    }
}

#[test]
fn unresolved_templates_fail_closed() {
    let policies = vec![
        policy(
            "own",
            vec![rule(
                "users/{{identity.user.id}}/**",
                &[Capability::Read],
                false,
            )],
        ),
        policy(
            "block",
            vec![rule(
                "prod/{{identity.machine.id}}",
                &[Capability::Use],
                true,
            )],
        ),
    ];
    let base: CapabilitySet = [Capability::Use].into_iter().collect();
    let alice = TemplateContext::from_subjects(&subjects(&["user:alice"]));
    assert!(evaluate_with(&base, &policies, "users/alice/KEY", &alice).contains(&Capability::Read));
    assert!(!evaluate_with(&base, &policies, "users/bob/KEY", &alice).contains(&Capability::Read));
    // No machine id: the deny widens to prod/* and removes `use`.
    assert!(!evaluate_with(&base, &policies, "prod/KEY", &alice).contains(&Capability::Use));
    let machine = TemplateContext::from_subjects(&subjects(&["machine:m1"]));
    assert!(evaluate_with(&base, &policies, "prod/KEY", &machine).contains(&Capability::Use));
    assert!(!evaluate_with(&base, &policies, "prod/m1", &machine).contains(&Capability::Use));
}

#[test]
fn parameter_constraints_follow_openbao_semantics() {
    let mut writer = rule("prod/**", &[Capability::Write], false);
    writer.allowed_parameters = Some(BTreeMap::from([
        ("region".into(), vec!["eu-*".into(), "us-east".into()]),
        ("owner".into(), vec!["{{identity.user.id}}".into()]),
        ("note".into(), vec![]),
    ]));
    writer.denied_parameters = Some(BTreeMap::from([("region".into(), vec!["eu-dev".into()])]));
    writer.required_parameters = vec!["owner".into()];
    let policies = vec![policy("w", vec![writer])];
    super::super::policy::validate(&policies[0]).unwrap();
    let ctx = TemplateContext::from_subjects(&subjects(&["user:alice"]));
    let check = |params: Value| {
        let map: BTreeMap<String, Value> = serde_json::from_value(params).unwrap();
        check_parameters(&policies, "prod/KEY", Capability::Write, &ctx, &map)
    };
    assert!(check(json!({"owner": "alice", "region": "eu-west", "note": 1})).is_ok());
    assert!(check(json!({"owner": "alice", "region": "us-east"})).is_ok());
    assert!(check(json!({"owner": "bob"})).is_err());
    assert!(check(json!({"region": "eu-west"})).is_err());
    assert!(check(json!({"owner": "alice", "region": "eu-dev"})).is_err());
    assert!(check(json!({"owner": "alice", "region": "ap-south"})).is_err());
    assert!(check(json!({"owner": "alice", "extra": "x"})).is_err());
    // Other paths are unconstrained.
    let map = BTreeMap::from([("anything".to_owned(), json!("x"))]);
    assert!(check_parameters(&policies, "dev/KEY", Capability::Write, &ctx, &map).is_ok());

    let mut bad = rule("prod/**", &[Capability::Read], false);
    bad.required_parameters = vec!["x".into()];
    assert!(validate_rule(&bad).is_err());
}

fn gated_policies() -> Vec<Policy> {
    let mut gated = rule("prod/**", &[Capability::Read], false);
    gated.control_group = Some(ControlGroupSpec {
        ttl_secs: Some(3600),
        factors: vec![ControlGroupFactor {
            name: "security".into(),
            approvers: vec!["team:sec".into(), "user:carol".into()],
            approvals: 2,
        }],
    });
    vec![policy("prod-read", vec![gated])]
}

#[test]
fn control_groups_require_distinct_non_requester_approvals_and_redeem_once() {
    let policies = gated_policies();
    super::super::policy::validate(&policies[0]).unwrap();
    let ctx = TemplateContext::default();
    let spec = control_group_for(&policies, "prod/KEY", Capability::Read, &ctx).unwrap();
    assert_eq!(spec.factors[0].name, "prod-read/0/security");
    assert!(control_group_for(&policies, "dev/KEY", Capability::Read, &ctx).is_none());
    assert!(read_gated_for_anyone(&policies, "prod/KEY"));
    assert!(!read_gated_for_anyone(&policies, "dev/KEY"));
    let mut templated = rule("dev/{{identity.user.id}}/**", &[Capability::Read], false);
    templated.control_group = policies[0].rules[0].control_group.clone();
    let templated = vec![policy("per-user", vec![templated])];
    assert!(read_gated_for_anyone(&templated, "dev/alice/KEY"));
    assert!(!read_gated_for_anyone(&templated, "prod/KEY"));

    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    let now = 1_000_000;
    let (request, token) = create_request(
        &conn,
        "user:alice",
        "prod/KEY",
        &json!({"k": 1}),
        &spec,
        now,
    )
    .unwrap();
    // Not approved yet.
    assert!(redeem(&conn, &token, "user:alice", now + 1).is_err());
    // Requester cannot approve, even through a team.
    assert!(authorize(
        &conn,
        &request.id,
        "user:alice",
        &subjects(&["user:alice", "team:sec"]),
        now
    )
    .is_err());
    // Non-approver cannot approve.
    assert!(authorize(
        &conn,
        &request.id,
        "user:dave",
        &subjects(&["user:dave"]),
        now
    )
    .is_err());
    let one = authorize(
        &conn,
        &request.id,
        "user:bob",
        &subjects(&["user:bob", "team:sec"]),
        now,
    )
    .unwrap();
    assert_eq!(one.status, ControlGroupStatus::Pending);
    // The same approver twice does not count twice.
    let again = authorize(
        &conn,
        &request.id,
        "user:bob",
        &subjects(&["user:bob", "team:sec"]),
        now,
    )
    .unwrap();
    assert_eq!(again.status, ControlGroupStatus::Pending);
    let two = authorize(
        &conn,
        &request.id,
        "user:carol",
        &subjects(&["user:carol"]),
        now,
    )
    .unwrap();
    assert_eq!(two.status, ControlGroupStatus::Approved);

    // Wrong requester or tampered token: indistinguishable not-found.
    assert!(redeem(&conn, &token, "user:bob", now + 2).is_err());
    // Change the secret's last hex digit to a different one: always writing
    // `0` left the token intact whenever it already ended in `0` (1 in 16).
    let (head, last) = token.split_at(token.len() - 1);
    let tampered = format!("{head}{}", if last == "0" { "1" } else { "0" });
    assert_ne!(tampered, token);
    assert!(redeem(&conn, &tampered, "user:alice", now + 2).is_err());
    assert!(redeem(&conn, "garbage", "user:alice", now + 2).is_err());

    let redeemed = redeem(&conn, &token, "user:alice", now + 3).unwrap();
    assert_eq!(redeemed.target, json!({"k": 1}));
    assert_eq!(redeemed.status, ControlGroupStatus::Redeemed);
    // Single use.
    assert!(redeem(&conn, &token, "user:alice", now + 4).is_err());
    assert!(authorize(
        &conn,
        &request.id,
        "user:carol",
        &subjects(&["user:carol"]),
        now + 4
    )
    .is_err());
}

#[test]
fn control_groups_and_same_named_factors_across_rules_of_one_policy() {
    let factor = |approvers: &[&str], approvals: u8| ControlGroupSpec {
        ttl_secs: None,
        factors: vec![ControlGroupFactor {
            name: "approval".into(),
            approvers: approvers.iter().map(|s| (*s).to_owned()).collect(),
            approvals,
        }],
    };
    let mut broad = rule("prod/**", &[Capability::Read], false);
    broad.control_group = Some(factor(&["team:leads"], 1));
    let mut payments = rule("prod/payments/*", &[Capability::Read], false);
    payments.control_group = Some(factor(&["user:cfo", "user:ceo"], 2));
    let one = policy("prod-access", vec![broad, payments]);
    super::super::policy::validate(&one).unwrap();
    // The same policy reached twice (user + team binding) still collapses.
    let policies = vec![one.clone(), one];
    let ctx = TemplateContext::default();
    let spec = control_group_for(
        &policies,
        "prod/payments/STRIPE_KEY",
        Capability::Read,
        &ctx,
    )
    .unwrap();
    assert_eq!(spec.factors.len(), 2);

    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    let now = 1_000_000;
    let (request, token) = create_request(
        &conn,
        "user:alice",
        "prod/payments/STRIPE_KEY",
        &json!({"k": 1}),
        &spec,
        now,
    )
    .unwrap();
    // One lead satisfies only the broad rule's factor.
    let lead = authorize(
        &conn,
        &request.id,
        "user:lee",
        &subjects(&["user:lee", "team:leads"]),
        now,
    )
    .unwrap();
    assert_eq!(lead.status, ControlGroupStatus::Pending);
    assert!(redeem(&conn, &token, "user:alice", now + 1).is_err());
    for approver in ["user:cfo", "user:ceo"] {
        authorize(&conn, &request.id, approver, &subjects(&[approver]), now).unwrap();
    }
    assert!(redeem(&conn, &token, "user:alice", now + 2).is_ok());
}

#[test]
fn control_group_requests_expire() {
    let policies = gated_policies();
    let spec = control_group_for(
        &policies,
        "prod/KEY",
        Capability::Read,
        &TemplateContext::default(),
    )
    .unwrap();
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    let (request, token) =
        create_request(&conn, "user:alice", "prod/KEY", &json!({}), &spec, 0).unwrap();
    authorize(&conn, &request.id, "user:bob", &subjects(&["team:sec"]), 1).unwrap();
    authorize(
        &conn,
        &request.id,
        "user:carol",
        &subjects(&["user:carol"]),
        2,
    )
    .unwrap();
    let after = 3600 * 1000 + 1;
    assert_eq!(
        get_request(&conn, &request.id, after)
            .unwrap()
            .unwrap()
            .status,
        ControlGroupStatus::Expired
    );
    assert!(redeem(&conn, &token, "user:alice", after).is_err());
    assert_eq!(prune(&conn, after + 24 * 3600 * 1000).unwrap(), 1);
}

#[test]
fn control_group_specs_are_validated() {
    let mut gated = gated_policies().remove(0).rules.remove(0);
    gated.control_group.as_mut().unwrap().factors[0].approvers = vec!["group:x".into()];
    assert!(validate_rule(&gated).is_err());
    let mut no_read = gated_policies().remove(0).rules.remove(0);
    no_read.capabilities = vec![Capability::Use];
    assert!(validate_rule(&no_read).is_err());
    let mut short = gated_policies().remove(0).rules.remove(0);
    short.control_group.as_mut().unwrap().ttl_secs = Some(5);
    assert!(validate_rule(&short).is_err());
}

#[test]
fn constant_time_compare() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(!constant_time_eq(b"abc", b"ab"));
}
