//! Vault route tests: boundaries, capabilities, and policy visibility.

use super::boundaries::{record_visible, resolve_target};
use super::folders::folder_policy_key;
use super::principal::Ctx;
use super::values::list_secrets;
use super::wire::{login_refusal, vault_error};
use super::*;
use crate::identity_verify::TeamMembership;

pub(super) fn node(
    scope: NodeScope,
    team_id: Option<&str>,
    owner_user_id: Option<&str>,
) -> RegisteredNode {
    RegisteredNode {
        org: crate::sidecar::control_plane::RegisteredOrg {
            id: "org-1".to_owned(),
            name: "Acme".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope,
        team_id: team_id.map(str::to_owned),
        owner_user_id: owner_user_id.map(str::to_owned),
    }
}

pub(super) fn caller(user_id: &str, role: OrgRole, team_ids: &[&str]) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role,
        teams: team_ids
            .iter()
            .map(|id| TeamMembership {
                id: (*id).to_owned(),
                org_id: "org-1".to_owned(),
                role: "member".to_owned(),
            })
            .collect(),
    }
}

pub(super) fn info(scope: SecretScope, scope_id: &str) -> VaultSecretInfo {
    VaultSecretInfo {
        name: "GITHUB_TOKEN".to_owned(),
        scope,
        scope_id: scope_id.to_owned(),
        binding: None,
        updated_at: 1,
        environment: DEFAULT_ENVIRONMENT.to_owned(),
        path: ROOT_PATH.to_owned(),
        version: 1,
        metadata: Default::default(),
        created_at: 1,
        created_by: None,
        updated_by: None,
        rotated_at: 1,
        deleted_at: None,
        metadata_version: 1,
    }
}

pub(super) async fn parts(response: Response) -> (StatusCode, String) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

#[tokio::test]
pub(super) async fn a_login_refusal_is_one_403_whatever_the_store_said() {
    let causes: Vec<anyhow::Error> = vec![
        VaultError::NotFound("machine identity `ci-deploy`".into()).into(),
        VaultError::Invalid("identity does not use jwt login".into()).into(),
        VaultError::Denied("identity is disabled".into()).into(),
        VaultError::Denied("JWT rejected: ExpiredSignature".into()).into(),
        VaultError::Conflict("already exists".into()).into(),
    ];
    let mut seen = Vec::new();
    for cause in causes {
        let (status, body) = parts(login_refusal(cause)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        for leak in ["ci-deploy", "jwt", "JWT", "disabled", "Expired", "exists"] {
            assert!(!body.contains(leak), "`{leak}` leaked: {body}");
        }
        seen.push(body);
    }
    assert!(seen.windows(2).all(|pair| pair[0] == pair[1]), "{seen:?}");
    assert_eq!(seen[0], r#"{"error":"vault_denied: login rejected"}"#);
}

#[tokio::test]
pub(super) async fn a_login_refusal_leaves_retryable_and_unexpected_failures_to_vault_error() {
    type Cause = fn() -> anyhow::Error;
    let cases: [(&str, Cause, StatusCode); 4] = [
        (
            "sealed",
            || VaultError::Sealed.into(),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        (
            "audit unavailable",
            || VaultError::AuditUnavailable.into(),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        (
            "storage",
            || rusqlite::Error::QueryReturnedNoRows.into(),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        (
            "unexpected",
            || anyhow::anyhow!("boom"),
            StatusCode::BAD_REQUEST,
        ),
    ];
    for (label, cause, status) in cases {
        let refused = parts(login_refusal(cause())).await;
        assert_eq!(refused.0, status, "{label}: {}", refused.1);
        assert_eq!(refused, parts(vault_error(cause())).await, "{label}");
    }
}

pub(super) fn ctx(
    node: Option<RegisteredNode>,
    caller: Option<VerifiedCaller>,
    manager: bool,
    policies: Vec<Policy>,
) -> Ctx {
    Ctx {
        store: Box::leak(Box::new(PluginSecretStore::in_memory().unwrap())),
        node_id: "node-1".to_owned(),
        manager: manager || node.is_none(),
        node,
        caller,
        policies,
        jwt: None,
    }
}

#[test]
pub(super) fn visibility_matches_the_four_scope_boundaries() {
    let org_node = node(NodeScope::Org, None, None);
    let member = caller("user-1", OrgRole::Member, &["team-1"]);
    assert!(record_visible(
        &info(SecretScope::Node, "node-1"),
        Some(&org_node),
        Some(&member),
        "node-1"
    ));
    assert!(record_visible(
        &info(SecretScope::User, "user-1"),
        Some(&org_node),
        Some(&member),
        "node-1"
    ));
    assert!(record_visible(
        &info(SecretScope::Team, "team-1"),
        Some(&org_node),
        Some(&member),
        "node-1"
    ));
    assert!(record_visible(
        &info(SecretScope::Org, "org-1"),
        Some(&org_node),
        Some(&member),
        "node-1"
    ));
    assert!(!record_visible(
        &info(SecretScope::User, "user-2"),
        Some(&org_node),
        Some(&member),
        "node-1"
    ));
}

#[test]
pub(super) fn team_and_org_metadata_are_not_visible_without_verified_identity() {
    let org_node = node(NodeScope::Org, None, None);
    assert!(!record_visible(
        &info(SecretScope::Team, "team-1"),
        Some(&org_node),
        None,
        "node-1"
    ));
    assert!(!record_visible(
        &info(SecretScope::Org, "org-1"),
        Some(&org_node),
        None,
        "node-1"
    ));
    assert!(record_visible(
        &info(SecretScope::Node, "node-1"),
        Some(&org_node),
        None,
        "node-1"
    ));
}

#[test]
pub(super) fn target_scope_ids_cannot_be_repointed() {
    let org_node = node(NodeScope::Org, None, None);
    let member = caller("user-1", OrgRole::Member, &["team-1"]);
    assert!(resolve_target(
        SecretScope::User,
        Some("user-2".to_owned()),
        None,
        Some(&org_node),
        Some(&member)
    )
    .is_err());
    assert!(resolve_target(
        SecretScope::Org,
        Some("org-2".to_owned()),
        None,
        Some(&org_node),
        Some(&member)
    )
    .is_err());
    assert!(resolve_target(
        SecretScope::Team,
        Some("team-2".to_owned()),
        None,
        Some(&org_node),
        Some(&member)
    )
    .is_err());
}

#[test]
pub(super) fn baseline_capabilities_preserve_the_pre_policy_rules() {
    let org_node = node(NodeScope::Org, None, None);
    let member = ctx(
        Some(org_node.clone()),
        Some(caller("user-1", OrgRole::Member, &["team-1"])),
        false,
        vec![],
    );
    let own = info(SecretScope::User, "user-1").coords();
    assert!(member.caps(&own).contains(&Capability::Read));
    let team = info(SecretScope::Team, "team-1").coords();
    let caps = member.caps(&team);
    assert!(caps.contains(&Capability::Use) && !caps.contains(&Capability::Read));
    let manager = ctx(
        Some(org_node),
        Some(caller("admin", OrgRole::Admin, &[])),
        true,
        vec![],
    );
    assert!(manager
        .caps(&info(SecretScope::Org, "org-1").coords())
        .contains(&Capability::Approve));
    let local = ctx(None, None, true, vec![]);
    assert_eq!(
        local.caps(&info(SecretScope::User, "local").coords()).len(),
        Capability::ALL.len()
    );
}

#[test]
pub(super) fn policies_grant_and_deny_on_top_of_the_baseline() {
    let org_node = node(NodeScope::Org, None, None);
    let reader = Policy {
        name: "read-team".into(),
        description: String::new(),
        rules: vec![
            PolicyRule {
                path: "default/**".into(),
                capabilities: vec![Capability::Read],
                deny: false,
                ..Default::default()
            },
            PolicyRule {
                path: "default/PROD_*".into(),
                capabilities: vec![Capability::Use],
                deny: true,
                ..Default::default()
            },
        ],
    };
    let member = ctx(
        Some(org_node),
        Some(caller("user-1", OrgRole::Member, &["team-1"])),
        false,
        vec![reader],
    );
    let mut team = info(SecretScope::Team, "team-1").coords();
    assert!(member.caps(&team).contains(&Capability::Read));
    team.name = "PROD_KEY".into();
    assert!(!member.caps(&team).contains(&Capability::Use));
}

#[test]
pub(super) fn folder_policy_keys_are_canonical_and_denies_bind_managers() {
    for raw in [
        "restricted",
        "/restricted",
        "/restricted/",
        "  restricted/ ",
    ] {
        let (path, key) = folder_policy_key("prod", raw).unwrap();
        assert_eq!(path, "/restricted");
        assert_eq!(key, "sys/folders/prod/restricted");
    }
    assert_eq!(
        folder_policy_key("prod", "").unwrap(),
        ("/".to_owned(), "sys/folders/prod".to_owned())
    );
    assert!(folder_policy_key("prod", "a/../b").is_err());
    assert!(folder_policy_key("prod", "a//b").is_err());
    assert!(folder_policy_key("Prod", "a").is_err());
    assert!(folder_policy_key("sys", "a").is_err());

    let policy = Policy {
        name: "prod-folders-locked".into(),
        description: String::new(),
        rules: vec![
            PolicyRule {
                path: "**".into(),
                capabilities: vec![Capability::Write, Capability::Admin],
                deny: false,
                ..Default::default()
            },
            PolicyRule {
                path: "sys/folders/prod/**".into(),
                capabilities: vec![Capability::Write, Capability::Admin],
                deny: true,
                ..Default::default()
            },
        ],
    };
    let org_node = node(NodeScope::Org, None, None);
    for manager in [false, true] {
        let ctx = ctx(
            Some(org_node.clone()),
            Some(caller("user-1", OrgRole::Member, &[])),
            manager,
            vec![policy.clone()],
        );
        // Omitting the leading slash no longer slips past the deny.
        let (_, key) = folder_policy_key("prod", "restricted").unwrap();
        assert!(ctx.require_sys(&key, Capability::Write).is_err());
        assert!(ctx.require_sys(&key, Capability::Admin).is_err());
        // Other environments stay writable.
        let (_, key) = folder_policy_key("staging", "restricted").unwrap();
        assert!(ctx.require_sys(&key, Capability::Write).is_ok());
        assert!(ctx.require_sys(&key, Capability::Admin).is_ok());
    }
    // A manager with no policies keeps folder write/admin.
    let manager = ctx(
        Some(org_node),
        Some(caller("admin", OrgRole::Admin, &[])),
        true,
        vec![],
    );
    let (_, key) = folder_policy_key("prod", "restricted").unwrap();
    assert!(manager.require_sys(&key, Capability::Write).is_ok());
    assert!(manager.require_sys(&key, Capability::Admin).is_ok());
}

#[tokio::test]
pub(super) async fn policies_never_widen_visibility_past_the_scope_boundary() {
    let org_node = node(NodeScope::Org, None, None);
    let broad = Policy {
        name: "broad".into(),
        description: String::new(),
        rules: vec![PolicyRule {
            path: "default/**".into(),
            capabilities: vec![
                Capability::List,
                Capability::Read,
                Capability::Use,
                Capability::Approve,
            ],
            deny: false,
            ..Default::default()
        }],
    };
    let member = ctx(
        Some(org_node),
        Some(caller("user-1", OrgRole::Member, &["team-1"])),
        false,
        vec![broad],
    );
    for (scope, scope_id, name, value) in [
        (SecretScope::User, "user-1", "MINE", "mine-value-1234567890"),
        (
            SecretScope::User,
            "user-2",
            "THEIRS",
            "theirs-value-1234567890",
        ),
        (
            SecretScope::Team,
            "team-1",
            "MY_TEAM",
            "team-one-value-1234567890",
        ),
        (
            SecretScope::Team,
            "team-2",
            "OTHER_TEAM",
            "team-two-value-1234567890",
        ),
    ] {
        member
            .store
            .set_vault_secret(scope, scope_id, None, name, value)
            .await
            .unwrap();
    }

    // Another member's personal value and a non-member team get nothing,
    // even though the policy path matches them.
    assert!(member
        .caps(&info(SecretScope::User, "user-2").coords())
        .is_empty());
    assert!(member
        .caps(&info(SecretScope::Team, "team-2").coords())
        .is_empty());
    // The caller's own scopes keep the policy grant.
    assert!(member
        .caps(&info(SecretScope::Team, "team-1").coords())
        .contains(&Capability::Read));
    assert!(member
        .caps(&info(SecretScope::User, "user-1").coords())
        .contains(&Capability::List));

    // The listing filter (`list_secrets`) omits the out-of-scope rows.
    let page = member
        .store
        .list_secrets_page(&ListFilter::default(), None, 50, |info| {
            member.caps(&info.coords()).contains(&Capability::List)
        })
        .await
        .unwrap();
    let mut listed: Vec<&str> = page.secrets.iter().map(|info| info.name.as_str()).collect();
    listed.sort_unstable();
    assert_eq!(listed, ["MINE", "MY_TEAM"]);

    // `scan` known values come only from directly readable, visible rows.
    let known: Vec<String> = member
        .store
        .current_values(&ListFilter::default())
        .await
        .unwrap()
        .into_iter()
        .filter(|(info, _)| member.can_read_directly(&info.coords()))
        .map(|(_, value)| value)
        .collect();
    assert!(known.iter().any(|value| value == "mine-value-1234567890"));
    assert!(!known.iter().any(|value| value == "theirs-value-1234567890"));
    assert!(!known
        .iter()
        .any(|value| value == "team-two-value-1234567890"));

    // A submitted change request stays approvable by an explicit policy
    // grant, which is the one flow that acts outside the approver's scope.
    assert!(member
        .approval_caps(&info(SecretScope::User, "user-2").coords())
        .contains(&Capability::Approve));
}
