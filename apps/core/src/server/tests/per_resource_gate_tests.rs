use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::server::{acl_principals_payload, resource_permission_admission};
use axum::http::StatusCode;

#[test]
fn managed_unregistered_resource_permissions_fail_closed() {
    let caller = VerifiedCaller {
        user_id: "alice".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    };

    assert_eq!(
        resource_permission_admission(true, None, None),
        Err(StatusCode::FORBIDDEN)
    );
    assert_eq!(
        resource_permission_admission(true, None, Some(&caller)),
        Err(StatusCode::FORBIDDEN)
    );
    assert_eq!(resource_permission_admission(false, None, None), Ok(()));
    assert_eq!(
        resource_permission_admission(false, None, Some(&caller)),
        Ok(())
    );
    assert_eq!(
        resource_permission_admission(true, Some("org1"), Some(&caller)),
        Ok(())
    );
}

/// A web-delegated request never inherits the unbound-node owner allowance: no
/// binding (unbound, or managed but unregistered) refuses, an org member and the
/// personal owner pass, and an org/scope refusal stays a refusal.
#[test]
fn web_delegated_candidacy_refuses_without_a_node_binding() {
    use crate::server::web_delegated_candidacy;
    assert_eq!(
        web_delegated_candidacy(Ok(None)),
        Err(StatusCode::FORBIDDEN)
    );
    assert_eq!(web_delegated_candidacy(Ok(Some(false))), Ok(false));
    assert_eq!(web_delegated_candidacy(Ok(Some(true))), Ok(true));
    assert_eq!(
        web_delegated_candidacy(Err(StatusCode::FORBIDDEN)),
        Err(StatusCode::FORBIDDEN)
    );
}

/// The test process is an unbound node, the case the shared web portal must
/// never be admitted on, for an anonymous and a verified caller alike.
#[test]
fn web_delegated_candidate_refuses_on_an_unbound_node() {
    use crate::server::web_delegated_candidate;
    let caller = VerifiedCaller {
        user_id: "alice".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    };
    assert!(crate::sidecar::control_plane::registered_org().is_none());
    assert_eq!(
        web_delegated_candidate(&Some(caller)),
        Err(StatusCode::FORBIDDEN)
    );
    assert_eq!(web_delegated_candidate(&None), Err(StatusCode::FORBIDDEN));
}

/// EVERY `/api/acl/*` read handler must check a permission.
///
/// This exists because the same omission happened three times in a row while
/// gating these by hand: `acl_get_resource`, `acl_list_resources` and
/// `acl_principals` were each shipped ungated and caught one at a time. They
/// are not ordinary reads — between them they disclose who has access to what,
/// which resources have been customised, and the entire org roster with names
/// and emails. A source scan catches the next one on the way in, which
/// eyeballing a route list demonstrably does not.
///
/// `acl_vocabulary` is deliberately EXEMPT: it lists the permission ids this
/// node understands, which is a static capability description carrying no
/// tenant data — the equivalent of an OpenAPI schema.
#[test]
fn every_acl_read_handler_enforces_a_permission() {
    let src = crate::server::tests::source_text::server_source();
    for handler in [
        "async fn acl_get_resource(",
        "async fn acl_list_resources(",
        "async fn acl_principals(",
    ] {
        let start = src
            .find(handler)
            .unwrap_or_else(|| panic!("{handler} no longer exists; update this guard"));
        // Scan to the END OF THE FUNCTION, not a fixed byte window. A window
        // large enough to cover the body also ran past it into this very test
        // module — whose own source contains the literal being searched for —
        // so the guard passed with the gate deleted. Verified by mutation
        // after the fix: removing the gate reddens this.
        let after = &src[start..];
        let body_end = after
            .find("\n}\n")
            .unwrap_or_else(|| panic!("{handler} has no closing brace"));
        let body = &after[..body_end];
        // Search for the CALL, not the word: prose mentioning the helper (this
        // handler's own doc comment does) satisfied a bare substring check, so
        // the guard passed with the gate deleted. Verified by mutation after
        // the fix.
        let gated = body.contains("if enforce_permission(")
            || body.contains("if enforce_permission_on(")
            || body.contains("enforce_node_acl_management(");
        assert!(
            gated,
            "{handler} performs no permission check — it discloses tenant data to any \
                 holder of the node token"
        );
    }
}

/// The ACL write path must apply the grant ceiling before it stores rows, or a
/// delegated `roles.manage` holder can allow themselves anything on the
/// resource (the rules themselves are unit-tested in `acl::edit_ceiling_tests`).
#[test]
fn acl_put_resource_applies_the_grant_ceiling_before_storing() {
    let src = crate::server::tests::source_text::server_source();
    let start = src
        .find("async fn acl_put_resource(")
        .expect("acl_put_resource no longer exists; update this guard");
    let after = &src[start..];
    let body = &after[..after.find("\n}\n").expect("closing brace")];
    let ceiling = body
        .find("enforce_acl_edit_ceiling(&state, &caller, &kind, &id, &body.overwrites).await?")
        .expect("acl_put_resource no longer calls enforce_acl_edit_ceiling");
    let store = body
        .find("crate::acl::store::set_overwrites(")
        .expect("acl_put_resource no longer stores overwrites");
    assert!(
        ceiling < store,
        "the ceiling must run before the overwrites are stored"
    );
}

use crate::sidecar::control_plane::{NotifyTargetUser, OrgTeam};

fn member(user_id: &str, name: Option<&str>, email: Option<&str>) -> NotifyTargetUser {
    NotifyTargetUser {
        user_id: user_id.to_owned(),
        email: email.map(str::to_owned),
        image: None,
        role: None,
        name: name.map(str::to_owned),
    }
}

#[test]
fn acl_kind_constants_are_frozen_wire_strings() {
    // These are persisted verbatim (`<kind>:<id>` in `resource-acl.json`) and
    // travel in `/api/acl/resources/:kind/:id`. Renaming a value orphans every
    // rule already stored under the old one, so the values are frozen even
    // though the constants are free to move.
    assert_eq!(crate::acl::KIND_SPACE, "space");
    assert_eq!(crate::acl::KIND_CONVERSATION, "conversation");
    assert_eq!(crate::acl::KIND_AGENT, "agent");
    assert_eq!(crate::acl::KIND_WORKFLOW, "workflow");
    assert_eq!(crate::acl::KIND_NODE, "node");
}

#[test]
fn per_resource_gates_never_name_a_resource_kind_by_literal() {
    // A handler that spells its kind as a bare string can drift from the
    // constant the editor writes under, and the resulting always-empty ACL is
    // invisible: the request still succeeds, the rule just never applies. The
    // only non-constant kind allowed is the one the URL carries (`acl_put_resource`).
    // Production source only: this module's own prose mentions the call it is
    // scanning for, and it lives under `server/tests/`, outside the scanned text.
    let src = crate::server::tests::source_text::server_source();
    let lines: Vec<&str> = src.lines().collect();
    let mut checked = 0usize;
    for (i, line) in lines.iter().enumerate() {
        let head = line.trim_start();
        if !line.contains("enforce_permission_on(")
            || head.starts_with("//")
            || line.contains("fn enforce_permission_on(")
        {
            continue;
        }
        // Include the call's first line: rustfmt keeps short calls on one
        // line, while longer calls place their arguments below it.
        let args = lines[i..(i + 8).min(lines.len())].join("\n");
        let kind_arg = args
            .lines()
            .find(|a| a.contains("crate::acl::KIND_") || matches!(a.trim(), "&kind," | "kind,"));
        assert!(
            kind_arg.is_some(),
            "enforce_permission_on at line {} names its kind by literal:\n{args}",
            i + 1
        );
        checked += 1;
    }
    assert!(
        checked >= 20,
        "expected the per-resource gate to be wired on the identified-resource \
             handlers; found only {checked} call sites"
    );
}

#[test]
fn principals_degrade_to_empty_teams_and_members_but_never_empty_roles() {
    // An unbound personal node has no org directory, and an unreachable control
    // plane looks identical. Roles are LOCAL, so they must survive both — a
    // picker with no targets at all is an unusable editor, not a safe default.
    let payload = acl_principals_payload(Vec::new(), Vec::new(), Vec::new());
    assert_eq!(payload["teams"].as_array().unwrap().len(), 0);
    assert_eq!(payload["members"].as_array().unwrap().len(), 0);
    let roles = payload["roles"].as_array().unwrap();
    let ids: Vec<&str> = roles.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["owner", "admin", "member", "viewer"]);
    assert_eq!(roles[0]["label"], "Owner");
}

#[test]
fn a_member_row_is_always_selectable_even_with_no_name_or_email() {
    let payload = acl_principals_payload(
        Vec::new(),
        vec![
            member("u1", Some("Ada"), Some("ada@example.com")),
            member("u2", None, Some("grace@example.com")),
            member("u3", None, None),
        ],
        Vec::new(),
    );
    let members = payload["members"].as_array().unwrap();
    assert_eq!(members[0]["name"], "Ada");
    // No mirrored name: the email's local part reads better than a raw id.
    assert_eq!(members[1]["name"], "grace");
    assert_eq!(members[1]["email"], "grace@example.com");
    // Neither: the id, never a blank row the admin cannot tell apart.
    assert_eq!(members[2]["name"], "u3");
    assert_eq!(members[2]["email"], "");
    // The id stays the user id in every case — it is what an overwrite targets.
    assert_eq!(members[1]["id"], "u2");
}

#[test]
fn an_unnamed_team_falls_back_to_its_id() {
    let payload = acl_principals_payload(
        vec![
            OrgTeam {
                id: "t1".to_owned(),
                name: Some("Platform".to_owned()),
            },
            OrgTeam {
                id: "t2".to_owned(),
                name: None,
            },
        ],
        Vec::new(),
        Vec::new(),
    );
    let teams = payload["teams"].as_array().unwrap();
    assert_eq!(teams[0]["name"], "Platform");
    assert_eq!(teams[1]["name"], "t2");
}
