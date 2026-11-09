use super::*;

fn app(id: &str, purge_version: Option<&str>, categories: &[&str]) -> PluginManifest {
    let mut provides = vec![json!({ "capability": "data.count", "version": "1.0.0" })];
    if let Some(version) = purge_version {
        provides.push(json!({ "capability": "data.purge", "version": version }));
    }
    let categories: Vec<Value> = categories
        .iter()
        .map(|id| json!({ "id": id, "title": "Delete", "noun": "items", "detail": "Gone." }))
        .collect();
    serde_json::from_value(json!({
        "id": id, "name": id, "version": "1.0.0", "runnables": [],
        "provides": provides,
        "contributes": { "data_categories": categories },
    }))
    .expect("manifest parses")
}

fn member(user_id: &str, org: Option<&str>, role: OrgRole) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: org.map(str::to_owned),
        role,
        teams: Vec::new(),
    }
}

#[test]
fn only_apps_that_promise_a_per_member_purge_are_called() {
    let manifests = [
        app("@ryu/new", Some("1.1.0"), &["items", "notes"]),
        app("@ryu/newer", Some("2.0.0"), &["files"]),
        app("@ryu/old", Some("1.0.0"), &["things"]),
        app("@ryu/bad-version", Some("one"), &["x"]),
        app("@ryu/no-purge", None, &["y"]),
        app("@ryu/no-categories", Some("1.1.0"), &[]),
        app("@ryu/disabled", Some("1.1.0"), &["z"]),
    ];
    let plan = plan_user_purge(manifests.iter(), &|id: &str| id != "@ryu/disabled");
    assert_eq!(
        plan.targets,
        vec![
            (
                "@ryu/new".to_owned(),
                vec!["items".to_owned(), "notes".to_owned()]
            ),
            ("@ryu/newer".to_owned(), vec!["files".to_owned()]),
        ]
    );
    assert_eq!(
        plan.skipped,
        vec![
            "@ryu/old".to_owned(),
            "@ryu/bad-version".to_owned(),
            "@ryu/no-purge".to_owned()
        ]
    );
    assert_eq!(plan.disabled, vec!["@ryu/disabled".to_owned()]);
    assert!(!plan.reaches_every_app());
}

#[test]
fn a_disabled_app_holding_data_is_reported_never_dropped() {
    // Opted in or not, a disabled app's sidecar cannot be asked, so the plan
    // must not reach every app.
    let manifests = [
        app("@ryu/meetings", Some("1.1.0"), &["recaps"]),
        app("@ryu/old", Some("1.0.0"), &["things"]),
        app("@ryu/no-data", Some("1.1.0"), &[]),
    ];
    let plan = plan_user_purge(manifests.iter(), &|_: &str| false);
    assert!(plan.targets.is_empty());
    assert!(plan.skipped.is_empty());
    assert_eq!(
        plan.disabled,
        vec!["@ryu/meetings".to_owned(), "@ryu/old".to_owned()]
    );
    assert!(!plan.reaches_every_app());

    let enabled = plan_user_purge(manifests[..1].iter(), &|_: &str| true);
    assert!(enabled.reaches_every_app());
}

#[test]
fn a_member_purges_only_their_own_data_unless_an_admin_or_the_owner() {
    let bound = Some("org-1");
    // The owner token: anywhere on a personal node, only locally on a bound one.
    assert!(may_purge(OwnerToken::Remote, None, "anyone", None));
    assert!(may_purge(OwnerToken::LocalPeer, None, "anyone", None));
    assert!(may_purge(OwnerToken::LocalPeer, None, "anyone", bound));
    assert!(!may_purge(OwnerToken::Remote, None, "anyone", bound));
    assert!(!may_purge(OwnerToken::Absent, None, "anyone", None));
    assert!(!may_purge(OwnerToken::Absent, None, "anyone", bound));
    // A member, for their own data.
    let own = member("u1", Some("org-1"), OrgRole::Member);
    assert!(may_purge(OwnerToken::Absent, Some(&own), "u1", bound));
    assert!(may_purge(OwnerToken::Absent, Some(&own), "u1", None));
    assert!(!may_purge(OwnerToken::Absent, Some(&own), "u2", bound));
    let viewer = member("u3", Some("org-1"), OrgRole::Viewer);
    assert!(!may_purge(OwnerToken::Absent, Some(&viewer), "u2", bound));
    // An admin or owner of this node's organization, for anyone on it.
    let admin = member("a1", Some("org-1"), OrgRole::Admin);
    assert!(may_purge(OwnerToken::Absent, Some(&admin), "u2", bound));
    let owner = member("o1", Some("org-1"), OrgRole::Owner);
    assert!(may_purge(OwnerToken::Absent, Some(&owner), "u2", bound));
    // An admin of another organization is refused here.
    let foreign = member("a3", Some("org-2"), OrgRole::Admin);
    assert!(!may_purge(OwnerToken::Absent, Some(&foreign), "u2", bound));
    assert!(!may_purge(OwnerToken::Remote, Some(&foreign), "u2", bound));
    // An org role grants nothing over other people on a personal node, or
    // from no organization.
    assert!(!may_purge(OwnerToken::Absent, Some(&admin), "u2", None));
    let orgless = member("a2", None, OrgRole::Admin);
    assert!(!may_purge(OwnerToken::Absent, Some(&orgless), "u2", bound));
}

#[test]
fn only_a_known_reason_is_logged() {
    assert_eq!(
        PurgeReason::parse("account_deleted").as_str(),
        "account_deleted"
    );
    assert_eq!(
        PurgeReason::parse(" member_removed ").as_str(),
        "member_removed"
    );
    assert_eq!(PurgeReason::parse("self").as_str(), "self");
    assert_eq!(
        PurgeReason::parse("deleted jane@example.com at her request").as_str(),
        "other"
    );
}

#[test]
fn only_a_complete_purge_is_ok() {
    let complete = json!({ "apps": [{ "removed": 2 }], "complete": true });
    assert_eq!(purge_report_status(&complete), StatusCode::OK);
    let skipped = json!({ "apps": [], "skipped": ["@ryu/old"], "complete": false });
    assert_eq!(purge_report_status(&skipped), StatusCode::CONFLICT);
    let failed = json!({ "apps": [{ "error": "purge failed" }], "complete": false });
    assert_eq!(purge_report_status(&failed), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn a_purge_with_no_opted_in_apps_reports_the_skipped_ones() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.app_store.insert("@ryu/old", "1.0.0").await.unwrap();
    state.app_store.set_enabled("@ryu/old", &[]).await.unwrap();
    state
        .app_manifests
        .write()
        .await
        .push(app("@ryu/old", Some("1.0.0"), &["things"]));
    let report = purge_user_app_data(&state, "member-1").await;
    assert_eq!(report["removed"], 0);
    assert_eq!(report["apps"], json!([]));
    assert_eq!(report["skipped"], json!(["@ryu/old"]));
    assert_eq!(report["disabled"], json!([]));
    assert_eq!(report["complete"], false);
    assert_eq!(purge_report_status(&report), StatusCode::CONFLICT);
}

#[tokio::test]
async fn a_purge_reports_a_disabled_app_holding_data_as_incomplete() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state
        .app_manifests
        .write()
        .await
        .push(app("@ryu/meetings", Some("1.1.0"), &["recaps"]));
    let report = purge_user_app_data(&state, "member-1").await;
    assert_eq!(report["apps"], json!([]));
    assert_eq!(report["disabled"], json!(["@ryu/meetings"]));
    assert_eq!(report["complete"], false);
    assert_eq!(purge_report_status(&report), StatusCode::CONFLICT);
}

#[tokio::test]
async fn a_purge_with_no_app_data_is_complete() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let report = purge_user_app_data(&state, "member-1").await;
    assert_eq!(report["complete"], true);
    assert_eq!(purge_report_status(&report), StatusCode::OK);
}

#[tokio::test]
async fn a_blank_user_id_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let (status, _) = purge_user(
        State(state),
        Extension(None),
        None,
        Json(PurgeUserRequest {
            user_id: "  ".to_owned(),
            reason: None,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

fn purge_delegation(subject: &str) -> Extension<ResolvedAuthorization> {
    use crate::authorization::{
        AuthorizationContext, CapabilitySet, CredentialKind, GrantConstraints, Principal,
        RequestBindings,
    };
    Extension(ResolvedAuthorization {
        context: AuthorizationContext {
            credential: CredentialKind::ManagedDelegation,
            principal: Principal::User {
                subject_id: subject.to_owned(),
            },
            capabilities: CapabilitySet::new(std::iter::empty()),
            constraints: GrantConstraints {
                subject_id: Some(subject.to_owned()),
                client_id: Some(crate::authorization::delegation::DATA_PURGE_CLIENT_ID.to_owned()),
                ..GrantConstraints::default()
            },
            issued_at: 0,
            expires_at: Some(60),
        },
        bindings: RequestBindings::default(),
        caller: Some(member(subject, Some("org-1"), OrgRole::Member)),
        verified_user_jwt: None,
    })
}

async fn purge_as_control_plane(
    state: ServerState,
    subject: &str,
    user_id: &str,
    reason: Option<&str>,
) -> StatusCode {
    purge_user(
        State(state),
        Extension(Some(member(subject, Some("org-1"), OrgRole::Member))),
        Some(purge_delegation(subject)),
        Json(PurgeUserRequest {
            user_id: user_id.to_owned(),
            reason: reason.map(str::to_owned),
        }),
    )
    .await
    .0
}

#[tokio::test]
async fn a_purge_delegation_purges_only_its_member_for_a_departure() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let subject = format!("purged-{}", uuid::Uuid::new_v4().simple());
    for (user_id, reason) in [
        ("someone-else", Some("member_removed")),
        (subject.as_str(), Some("self")),
        (subject.as_str(), Some("other")),
        (subject.as_str(), None),
    ] {
        assert_eq!(
            purge_as_control_plane(state.clone(), &subject, user_id, reason).await,
            StatusCode::FORBIDDEN,
            "{user_id} {reason:?}"
        );
    }
    // No refused purge recorded an epoch for the member. (A process-wide
    // all-members epoch from another test may exist, so check the member's own.)
    assert_eq!(
        crate::server::app_route_revocation::user_epoch(&subject),
        None
    );
    // Captured before the purge: the epoch is the second it runs, which may
    // be a later second than an `iat` read after it returns.
    let before = crate::pairing::now_secs();
    assert_eq!(
        purge_as_control_plane(state, &subject, &subject, Some("member_removed")).await,
        StatusCode::OK
    );
    // The departure also revoked the member's app route delegations, and only
    // those issued up to it.
    assert!(crate::server::app_route_revocation::user_epoch(&subject)
        .is_some_and(|epoch| epoch >= before));
    assert!(crate::server::app_route_revocation::is_revoked(
        Some(&subject),
        before
    ));
    assert!(!crate::server::app_route_revocation::is_revoked(
        Some(&subject),
        before + 10_000
    ));
}
