//! Environment selection, protected environments, control groups, and
//! parameter constraints on the folder a Vault path addresses.

use super::fixture_test::*;

#[tokio::test]
async fn environment_header_and_protected_environments() {
    let fixture = fixture(vec![
        all_caps("staging/**"),
        all_caps("prod/**"),
        rule("prod/admin/**", &[Capability::Admin], false),
    ])
    .await;
    let admin = AuditActor::new("user", Some("admin"));
    for (slug, protected) in [("staging", false), ("prod", true)] {
        fixture
            .store
            .put_environment(
                &Environment {
                    slug: slug.into(),
                    name: slug.into(),
                    protected,
                    required_approvals: 1,
                    position: 1,
                    cas_required: false,
                },
                &admin,
            )
            .await
            .unwrap();
    }
    let token = login(&fixture).await;
    let app = &fixture.app;

    let (status, body) = call_in(
        app,
        Some("staging"),
        "PUT",
        "/v1/secret/data/svc",
        Some(&token),
        Some(json!({ "data": { "KEY": "staged" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = call_in(
        app,
        Some("staging"),
        "GET",
        "/v1/secret/data/svc",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["data"], json!({ "KEY": "staged" }));
    // Without the header the node's active (default) environment is used,
    // where this caller holds nothing.
    let (status, _) = call(app, "GET", "/v1/secret/data/svc", Some(&token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call_in(
        app,
        Some("Not A Slug"),
        "GET",
        "/v1/secret/data/svc",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Protected environment: direct writes need admin on every key.
    let (status, body) = call_in(
        app,
        Some("prod"),
        "PUT",
        "/v1/secret/data/svc",
        Some(&token),
        Some(json!({ "data": { "KEY": "live" } })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body["errors"][0]
        .as_str()
        .unwrap()
        .contains("change approval"));
    let (status, body) = call_in(
        app,
        Some("prod"),
        "PUT",
        "/v1/secret/data/admin/svc",
        Some(&token),
        Some(json!({ "data": { "KEY": "live" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn control_groups_and_parameter_constraints_apply_to_compat() {
    use crate::vault::policy_ext::{ControlGroupFactor, ControlGroupSpec};
    let mut gated = all_caps("default/gated/**");
    gated.control_group = Some(ControlGroupSpec {
        ttl_secs: None,
        factors: vec![ControlGroupFactor {
            name: "security".into(),
            approvers: vec!["user:bob".into()],
            approvals: 1,
        }],
    });
    let mut constrained = all_caps("default/limited/**");
    constrained.allowed_parameters = Some(BTreeMap::from([(
        "value".to_owned(),
        vec!["ok-*".to_owned()],
    )]));
    let fixture = fixture(vec![gated, constrained]).await;
    let token = login(&fixture).await;
    let app = &fixture.app;

    // A machine token cannot open a control group, so a gated read is refused.
    let (status, body) = put(
        app,
        &token,
        "/v1/secret/data/gated/db",
        json!({ "data": { "PASSWORD": "p" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = call(app, "GET", "/v1/secret/data/gated/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body.to_string().find("\"p\"").is_none());

    // Parameter constraints gate compat writes like native ones.
    let (status, body) = put(
        app,
        &token,
        "/v1/secret/data/limited/cfg",
        json!({ "data": { "A": "bad" } }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = put(
        app,
        &token,
        "/v1/secret/data/limited/cfg",
        json!({ "data": { "A": "ok-1" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = call(
        app,
        "GET",
        "/v1/secret/data/limited/cfg",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["data"], json!({ "A": "ok-1" }));
}
