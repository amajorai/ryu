use super::*;

fn caps(list: &[Capability]) -> CapabilitySet {
    list.iter().copied().collect()
}

#[test]
fn globs_match_segments_and_recursive_wildcards() {
    assert!(glob_matches("prod/*", "prod/API_KEY"));
    assert!(!glob_matches("prod/*", "prod/db/API_KEY"));
    assert!(glob_matches("prod/**", "prod/db/main/API_KEY"));
    assert!(glob_matches("prod/**", "prod/API_KEY"));
    assert!(glob_matches("**/PASSWORD", "staging/db/PASSWORD"));
    assert!(glob_matches("*/db/DB_*", "prod/db/DB_PASSWORD"));
    assert!(!glob_matches("*/db/DB_*", "prod/db/API_KEY"));
    assert!(glob_matches("prod/STRIPE_?EY", "prod/STRIPE_KEY"));
    assert!(!glob_matches("prod", "prod/A"));
}

#[test]
fn child_globs_match_some_name_under_a_folder() {
    assert!(may_match_child("default/app/**", "default/app/db"));
    assert!(may_match_child("default/**", "default/app/db"));
    assert!(may_match_child("**", "default/app/db"));
    assert!(may_match_child("default/app/db/*", "default/app/db"));
    assert!(may_match_child("default/app/db/PASSWORD", "default/app/db"));
    assert!(may_match_child("*/app/db/DB_*", "prod/app/db"));
    assert!(may_match_child("**/PASSWORD", "default/app/db"));
    assert!(!may_match_child("default/app/db", "default/app/db"));
    assert!(!may_match_child("default/app/db/x/*", "default/app/db"));
    assert!(!may_match_child("default/other/**", "default/app/db"));
    assert!(!may_match_child("default/app/*", "default/app/db"));
    assert!(may_match_child("default/*", "default"));
}

#[test]
fn deny_wins_over_baseline_and_allow() {
    let policies = vec![
        Policy {
            name: "read-staging".into(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: "staging/**".into(),
                capabilities: vec![Capability::Read],
                deny: false,
                ..PolicyRule::default()
            }],
        },
        Policy {
            name: "no-prod".into(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: "prod/**".into(),
                capabilities: vec![Capability::Use, Capability::List],
                deny: true,
                ..PolicyRule::default()
            }],
        },
    ];
    let baseline = caps(&[Capability::List, Capability::Use]);
    assert_eq!(
        evaluate(&baseline, &policies, "staging/db/PASSWORD"),
        caps(&[Capability::List, Capability::Use, Capability::Read])
    );
    assert_eq!(evaluate(&baseline, &policies, "prod/API_KEY"), caps(&[]));
}

#[test]
fn shared_fixture_cases_pass() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        baseline: Vec<Capability>,
        policies: Vec<Policy>,
        path: String,
        expected: Vec<Capability>,
        #[serde(default)]
        subjects: Vec<String>,
        #[serde(default)]
        parameters: Option<BTreeMap<String, serde_json::Value>>,
        #[serde(default)]
        expected_parameters_allowed: Option<bool>,
        #[serde(default)]
        expected_control_group: Option<bool>,
        #[serde(default)]
        expected_control_group_factors: Option<Vec<String>>,
    }
    let raw = include_str!("../../../tests/fixtures/vault-policy-cases.json");
    let cases: Vec<Case> = serde_json::from_str(raw).unwrap();
    assert!(cases.len() >= 5);
    for case in cases {
        for policy in &case.policies {
            validate(policy).unwrap_or_else(|e| panic!("case `{}`: {e}", case.name));
        }
        let context = TemplateContext::from_subjects(&case.subjects);
        let got = evaluate_with(&caps(&case.baseline), &case.policies, &case.path, &context);
        assert_eq!(got, caps(&case.expected), "case `{}`", case.name);
        if let (Some(parameters), Some(expected)) =
            (&case.parameters, case.expected_parameters_allowed)
        {
            let result = super::super::policy_ext::check_parameters(
                &case.policies,
                &case.path,
                Capability::Write,
                &context,
                parameters,
            );
            assert_eq!(result.is_ok(), expected, "case `{}`: {result:?}", case.name);
        }
        if let Some(expected) = case.expected_control_group {
            let group = super::super::policy_ext::control_group_for(
                &case.policies,
                &case.path,
                Capability::Read,
                &context,
            );
            assert_eq!(group.is_some(), expected, "case `{}`", case.name);
            if let Some(expected_factors) = &case.expected_control_group_factors {
                let mut names: Vec<String> = group
                    .map(|group| group.factors.into_iter().map(|f| f.name).collect())
                    .unwrap_or_default();
                names.sort();
                let mut expected_factors = expected_factors.clone();
                expected_factors.sort();
                assert_eq!(names, expected_factors, "case `{}`", case.name);
            }
        }
    }
}

#[test]
fn bindings_expire_and_attach_policies_to_subjects() {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    let policy = Policy {
        name: "ci".into(),
        description: "CI reads staging".into(),
        rules: vec![PolicyRule {
            path: "staging/**".into(),
            capabilities: vec![Capability::Read],
            deny: false,
            ..PolicyRule::default()
        }],
    };
    put_policy(&conn, &policy).unwrap();
    bind(&conn, "ci", "machine:m1", None, Some("admin")).unwrap();
    let temp = bind(
        &conn,
        "ci",
        "user:u1",
        Some(now_millis() + 60_000),
        Some("admin"),
    )
    .unwrap();
    assert_eq!(
        policies_for(&conn, &["machine:m1".into()]).unwrap().len(),
        1
    );
    assert_eq!(policies_for(&conn, &["user:u1".into()]).unwrap().len(), 1);
    assert!(policies_for(&conn, &["user:u2".into()]).unwrap().is_empty());

    conn.execute(
        "UPDATE vault_policy_bindings SET expires_at = 1 WHERE id = ?1",
        params![temp.id],
    )
    .unwrap();
    assert!(policies_for(&conn, &["user:u1".into()]).unwrap().is_empty());
    assert_eq!(prune_expired(&conn).unwrap(), 1);

    assert!(bind(&conn, "missing", "user:u1", None, None).is_err());
    assert!(bind(&conn, "ci", "group:x", None, None).is_err());
    assert!(delete_policy(&conn, "ci").unwrap());
    assert!(list_bindings(&conn).unwrap().is_empty());
}

#[test]
fn invalid_policies_are_rejected() {
    let mut policy = Policy {
        name: "Bad Name".into(),
        description: String::new(),
        rules: vec![],
    };
    assert!(validate(&policy).is_err());
    policy.name = "ok".into();
    assert!(validate(&policy).is_err());
    policy.rules.push(PolicyRule {
        path: "prod/../x".into(),
        capabilities: vec![Capability::Read],
        deny: false,
        ..PolicyRule::default()
    });
    assert!(validate(&policy).is_err());
}
