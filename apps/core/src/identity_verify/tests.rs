// Moved verbatim from the inline test module of mod.rs. The named imports tie
// each split file to these tests.
use super::*;
#[allow(unused_imports)]
use super::{access::can_access, mint::unbound_or_old_enough, types::OrgRole, verify::RawClaims};

#[test]
fn a_token_names_its_session_only_with_a_non_empty_ryu_sid() {
    use base64::Engine as _;
    let token = |claims: serde_json::Value| {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.sig",
            engine.encode(br#"{"alg":"EdDSA"}"#),
            engine.encode(claims.to_string())
        )
    };
    assert!(token_names_session(&token(
        serde_json::json!({ "sub": "u", "ryu_sid": "s1" })
    )));
    assert!(!token_names_session(&token(
        serde_json::json!({ "sub": "u" })
    )));
    assert!(!token_names_session(&token(
        serde_json::json!({ "ryu_sid": "" })
    )));
    assert!(!token_names_session(&token(
        serde_json::json!({ "ryu_sid": 7 })
    )));
    assert!(!token_names_session("not-a-jwt"));
    assert!(!token_names_session("a.!!!.c"));
}

#[test]
fn an_unbound_token_is_dropped_on_a_refusal_whatever_its_age() {
    // A token minted before the control plane bound tokens to sessions.
    assert!(unbound_or_old_enough(false, 1_000, 1_001, 60));
    // A bound token only once it is old enough.
    assert!(!unbound_or_old_enough(true, 1_000, 1_010, 60));
    assert!(unbound_or_old_enough(true, 1_000, 1_060, 60));
}

#[test]
fn a_refused_token_is_dropped_only_once_it_is_old_enough() {
    assert!(!minted_long_enough_ago(1_000, 1_010, 60));
    assert!(minted_long_enough_ago(1_000, 1_060, 60));
    assert!(minted_long_enough_ago(1_000, 2_000, 60));
    // A clock that went backwards never counts as old enough.
    assert!(!minted_long_enough_ago(1_000, 900, 60));
}

#[test]
fn loopback_host_detection() {
    assert!(is_loopback_host("localhost"));
    assert!(is_loopback_host("LocalHost"));
    assert!(is_loopback_host("127.0.0.1"));
    assert!(is_loopback_host("127.5.5.5"));
    assert!(is_loopback_host("::1"));
    assert!(is_loopback_host("[::1]"));
    assert!(!is_loopback_host("auth.example.com"));
    assert!(!is_loopback_host("10.0.0.5"));
    assert!(!is_loopback_host("0.0.0.0"));
}

#[test]
fn role_rank_ladder() {
    assert!(OrgRole::Owner.rank() > OrgRole::Admin.rank());
    assert!(OrgRole::Admin.rank() > OrgRole::Member.rank());
    assert!(OrgRole::Member.rank() > OrgRole::Viewer.rank());
}

#[test]
fn from_ba_str_takes_highest_and_fails_closed() {
    assert_eq!(OrgRole::from_ba_str("admin,member"), OrgRole::Admin);
    assert_eq!(OrgRole::from_ba_str("owner"), OrgRole::Owner);
    assert_eq!(OrgRole::from_ba_str(""), OrgRole::Viewer);
    assert_eq!(OrgRole::from_ba_str("nonsense"), OrgRole::Viewer);
    assert_eq!(OrgRole::from_ba_str(" Member "), OrgRole::Member);
}

#[test]
fn satisfies_is_rank_ordered() {
    assert!(OrgRole::Admin.satisfies(OrgRole::Member));
    assert!(OrgRole::Member.satisfies(OrgRole::Member));
    assert!(!OrgRole::Viewer.satisfies(OrgRole::Member));
}

fn caller(user: &str, org: Option<&str>, role: OrgRole) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user.to_owned(),
        email: None,
        email_verified: false,
        org_id: org.map(str::to_owned),
        role,
        teams: Vec::new(),
    }
}

#[test]
fn owner_always_writes() {
    let c = caller("u1", None, OrgRole::Viewer);
    assert_eq!(
        can_access(&c, Some("u1"), Some("o1"), "private", None, &[]),
        Access::Write
    );
}

#[test]
fn access_at_least_orders_none_read_write() {
    assert!(Access::Write.at_least(Access::Read));
    assert!(Access::Read.at_least(Access::Read));
    assert!(!Access::Read.at_least(Access::Write));
    assert!(!Access::None.at_least(Access::Read));
}

#[test]
fn private_denies_non_owner() {
    let c = caller("u2", Some("o1"), OrgRole::Owner);
    assert_eq!(
        can_access(&c, Some("u1"), Some("o1"), "private", None, &[]),
        Access::None
    );
}

#[test]
fn direct_collaborators_get_their_role_only_inside_the_resource_org() {
    let viewer = caller("u2", Some("o1"), OrgRole::Viewer);
    let collaborators = vec![ResourceCollaborator {
        user_id: "u2".to_owned(),
        access: Access::Read,
    }];
    assert_eq!(
        can_access(
            &viewer,
            Some("u1"),
            Some("o1"),
            "private",
            None,
            &collaborators,
        ),
        Access::Read
    );

    let outsider = caller("u2", Some("o2"), OrgRole::Owner);
    assert_eq!(
        can_access(
            &outsider,
            Some("u1"),
            Some("o1"),
            "private",
            None,
            &collaborators,
        ),
        Access::None
    );
}

#[test]
fn org_member_writes_viewer_reads() {
    let member = caller("u2", Some("o1"), OrgRole::Member);
    assert_eq!(
        can_access(&member, Some("u1"), Some("o1"), "org", None, &[]),
        Access::Write
    );
    let viewer = caller("u3", Some("o1"), OrgRole::Viewer);
    assert_eq!(
        can_access(&viewer, Some("u1"), Some("o1"), "org", None, &[]),
        Access::Read
    );
}

#[test]
fn team_visibility_requires_matching_membership_and_role() {
    let member = caller("u2", Some("o1"), OrgRole::Member);
    let mut member = member;
    member.teams.push(TeamMembership {
        id: "t1".to_owned(),
        org_id: "o1".to_owned(),
        role: "member".to_owned(),
    });
    assert_eq!(
        can_access(&member, Some("u1"), Some("o1"), "team", Some("t1"), &[]),
        Access::Write
    );
    assert_eq!(
        can_access(&member, Some("u1"), Some("o1"), "team", Some("t2"), &[]),
        Access::None
    );

    let mut viewer = caller("u3", Some("o1"), OrgRole::Viewer);
    viewer.teams.push(TeamMembership {
        id: "t1".to_owned(),
        org_id: "o1".to_owned(),
        role: "viewer".to_owned(),
    });
    assert_eq!(
        can_access(&viewer, Some("u1"), Some("o1"), "team", Some("t1"), &[]),
        Access::Read
    );
}

#[test]
fn org_non_member_denied() {
    // A non-member has org_id = None, so the same-org check cannot match.
    let outsider = caller("u4", None, OrgRole::Viewer);
    assert_eq!(
        can_access(&outsider, Some("u1"), Some("o1"), "org", None, &[]),
        Access::None
    );
    // Different org also denied.
    let other = caller("u5", Some("o2"), OrgRole::Owner);
    assert_eq!(
        can_access(&other, Some("u1"), Some("o1"), "org", None, &[]),
        Access::None
    );
}

#[test]
fn unknown_visibility_denied() {
    let c = caller("u2", Some("o1"), OrgRole::Owner);
    assert_eq!(
        can_access(&c, Some("u1"), Some("o1"), "weird", None, &[]),
        Access::None
    );
}

#[test]
fn to_caller_selects_node_org_membership() {
    let claims = VerifiedClaims {
        user_id: "u1".to_owned(),
        email: Some("a@b.c".to_owned()),
        email_verified: true,
        orgs: vec![
            OrgMembership {
                id: "o1".to_owned(),
                role: "admin".to_owned(),
            },
            OrgMembership {
                id: "o2".to_owned(),
                role: "viewer".to_owned(),
            },
        ],
        teams: Vec::new(),
        feature_flags: BTreeSet::new(),
        feature_flags_org: None,
        limits: None,
    };
    let c = to_caller_for_org(&claims, Some("o1"));
    assert_eq!(c.org_id.as_deref(), Some("o1"));
    assert_eq!(c.role, OrgRole::Admin);
    assert!(c.email_verified, "the verification bit survives narrowing");
    assert_eq!(c.verified_email(), Some("a@b.c"));

    // Not a member of the node's org → no org context, viewer, fail-closed.
    let outsider = to_caller_for_org(&claims, Some("o3"));
    assert_eq!(outsider.org_id, None);
    assert_eq!(outsider.role, OrgRole::Viewer);

    // Node not org-bound → no org context.
    let unbound = to_caller_for_org(&claims, None);
    assert_eq!(unbound.org_id, None);
    assert_eq!(unbound.role, OrgRole::Viewer);
}

/// Pins the wire contract against the TypeScript minter: `definePayload`
/// emits `teams: [{ id, org, role }]`. If either side renames a key the teams
/// silently vanish (they would never match a node org), so this decodes the
/// literal JSON shape rather than a struct literal.
#[test]
fn claims_decode_team_memberships_from_the_payload_shape() {
    let raw: RawClaims = serde_json::from_str(
        r#"{"id":"u1","email":"a@b.c",
            "orgs":[{"id":"o1","role":"admin"}],
            "teams":[{"id":"t1","org":"o1","role":"admin"}]}"#,
    )
    .expect("payload with teams must decode");
    assert_eq!(raw.teams.len(), 1);
    assert_eq!(raw.teams[0].id, "t1");
    assert_eq!(raw.teams[0].org, "o1");
    assert_eq!(raw.teams[0].role, "admin");
}

/// Back-compat: every token minted before teams were embedded carries no
/// `teams` key at all. Absence means "no team memberships" — decoding must
/// still succeed, or every live session breaks the moment this ships.
#[test]
fn claims_without_teams_still_decode_as_no_memberships() {
    let raw: RawClaims =
        serde_json::from_str(r#"{"id":"u1","email":"a@b.c","orgs":[{"id":"o1","role":"admin"}]}"#)
            .expect("pre-teams token must still decode");
    assert!(raw.teams.is_empty());

    // A team entry missing `org` is kept but unmatchable rather than fatal:
    // one malformed row must not reject an otherwise valid token.
    let partial: RawClaims =
        serde_json::from_str(r#"{"id":"u1","teams":[{"id":"t1","role":"admin"}]}"#)
            .expect("team entry without org must not fail the token");
    assert_eq!(partial.teams[0].org, "");
}

/// `ryu_limits` is `{ "boxConcurrency": n }`, minted beside `ryu_flags`
/// (`CORE_LIMITS_CLAIM` in `packages/auth/src/lib/plans.ts`). Absence and
/// malformed shapes read as no claim without failing the token.
#[test]
fn identity_verify_limits_claim_parses_and_defaults_to_none() {
    let raw: RawClaims = serde_json::from_str(r#"{"id":"u1","ryu_limits":{"boxConcurrency":3}}"#)
        .expect("payload with limits must decode");
    assert_eq!(raw.ryu_limits, Some(VerifiedLimits { box_concurrency: 3 }));
    let zero: RawClaims =
        serde_json::from_str(r#"{"id":"u1","ryu_limits":{"boxConcurrency":0}}"#).unwrap();
    assert_eq!(zero.ryu_limits, Some(VerifiedLimits { box_concurrency: 0 }));
    let absent: RawClaims = serde_json::from_str(r#"{"id":"u1"}"#).unwrap();
    assert_eq!(absent.ryu_limits, None);
    for malformed in [
        r#"{"id":"u1","ryu_limits":null}"#,
        r#"{"id":"u1","ryu_limits":3}"#,
        r#"{"id":"u1","ryu_limits":{}}"#,
        r#"{"id":"u1","ryu_limits":{"boxConcurrency":"3"}}"#,
        r#"{"id":"u1","ryu_limits":{"boxConcurrency":-1}}"#,
        r#"{"id":"u1","ryu_limits":{"boxConcurrency":1.5}}"#,
        r#"{"id":"u1","ryu_limits":{"boxConcurrency":4294967296}}"#,
    ] {
        let raw: RawClaims =
            serde_json::from_str(malformed).expect("malformed limits never fail the token");
        assert_eq!(raw.ryu_limits, None, "{malformed}");
    }
}

/// The minter (`packages/auth/src/lib/core-flag-claim.ts`) emits
/// `ryu_flags: ["key", ...]` only when a flag is on. Absence and malformed
/// shapes must read as "no flags" without failing the token.
#[test]
fn flag_claim_parses_and_defaults_closed() {
    let raw: RawClaims =
        serde_json::from_str(r#"{"id":"u1","ryu_flags":["cloud_tasks.box_backend","other.flag"]}"#)
            .expect("payload with flags must decode");
    assert!(raw.ryu_flags.contains("cloud_tasks.box_backend"));
    assert_eq!(raw.ryu_flags.len(), 2);

    let absent: RawClaims =
        serde_json::from_str(r#"{"id":"u1"}"#).expect("pre-flag token must decode");
    assert!(absent.ryu_flags.is_empty());

    for malformed in [
        r#"{"id":"u1","ryu_flags":null}"#,
        r#"{"id":"u1","ryu_flags":"cloud_tasks.box_backend"}"#,
        r#"{"id":"u1","ryu_flags":{"cloud_tasks.box_backend":true}}"#,
    ] {
        let raw: RawClaims =
            serde_json::from_str(malformed).expect("a malformed flag claim must not fail");
        assert!(raw.ryu_flags.is_empty(), "{malformed}");
    }

    let mixed: RawClaims =
        serde_json::from_str(r#"{"id":"u1","ryu_flags":["a.b",1,null,"",{"x":1}]}"#)
            .expect("mixed entries must decode");
    assert_eq!(
        mixed.ryu_flags.into_iter().collect::<Vec<_>>(),
        vec!["a.b".to_owned()]
    );
}

/// `ryu_flags_org` names the org the flags were evaluated for. A missing or
/// malformed value reads as "no org context" without failing the token.
#[test]
fn flag_org_claim_parses_and_defaults_to_no_org() {
    let raw: RawClaims = serde_json::from_str(
        r#"{"id":"u1","ryu_flags":["cloud_tasks.box_backend"],"ryu_flags_org":"org_a"}"#,
    )
    .expect("payload with a flag org must decode");
    assert_eq!(raw.ryu_flags_org.as_deref(), Some("org_a"));

    let absent: RawClaims =
        serde_json::from_str(r#"{"id":"u1"}"#).expect("pre-org-claim token must decode");
    assert_eq!(absent.ryu_flags_org, None);

    let oversized = format!(r#"{{"id":"u1","ryu_flags_org":"{}"}}"#, "o".repeat(129));
    for malformed in [
        r#"{"id":"u1","ryu_flags_org":null}"#.to_owned(),
        r#"{"id":"u1","ryu_flags_org":""}"#.to_owned(),
        r#"{"id":"u1","ryu_flags_org":7}"#.to_owned(),
        r#"{"id":"u1","ryu_flags_org":{"id":"org_a"}}"#.to_owned(),
        oversized,
    ] {
        let raw: RawClaims =
            serde_json::from_str(&malformed).expect("a malformed flag org must not fail");
        assert_eq!(raw.ryu_flags_org, None, "{malformed}");
    }
}

/// The narrowing is what makes a team claim safe to trust: a team is only
/// meaningful inside its own org, so anything from another org must be gone
/// before a team-scoped check ever sees the caller.
#[test]
fn to_caller_narrows_teams_to_the_node_org() {
    let claims = VerifiedClaims {
        user_id: "u1".to_owned(),
        email: None,
        email_verified: false,
        orgs: vec![
            OrgMembership {
                id: "o1".to_owned(),
                role: "member".to_owned(),
            },
            OrgMembership {
                id: "o2".to_owned(),
                role: "owner".to_owned(),
            },
        ],
        teams: vec![
            TeamMembership {
                id: "t1".to_owned(),
                org_id: "o1".to_owned(),
                role: "member".to_owned(),
            },
            TeamMembership {
                id: "t2".to_owned(),
                org_id: "o2".to_owned(),
                role: "owner".to_owned(),
            },
        ],
        feature_flags: BTreeSet::new(),
        feature_flags_org: None,
        limits: None,
    };

    let c = to_caller_for_org(&claims, Some("o1"));
    let ids: Vec<&str> = c.teams.iter().map(|t| t.id.as_str()).collect();
    // t2 is a real membership of this user — but in a DIFFERENT org, so on an
    // o1-bound node it must not be reachable.
    assert_eq!(ids, vec!["t1"]);
    assert_eq!(c.teams[0].role, "member");

    // Non-member of the node's org: no org context and therefore no teams,
    // even though the user does hold team memberships elsewhere.
    let outsider = to_caller_for_org(&claims, Some("o3"));
    assert!(outsider.teams.is_empty());

    // Node not org-bound: no org to narrow against, so no team context.
    let unbound = to_caller_for_org(&claims, None);
    assert!(unbound.teams.is_empty());
}

/// Pins the `email_verified` wire contract against the TypeScript minter
/// (`definePayload` emits `email_verified: user.emailVerified === true`).
/// Only a JSON `true` proves mailbox ownership; an absent claim (every token
/// minted before it existed), `false`, or a non-boolean is unverified, and a
/// malformed value never rejects the token as a whole.
#[test]
fn claims_decode_email_verified_strictly() {
    let decode = |payload: &str| -> RawClaims {
        serde_json::from_str(payload).expect("payload must decode")
    };
    assert!(decode(r#"{"id":"u1","email":"a@b.c","email_verified":true}"#).email_verified);
    for payload in [
        r#"{"id":"u1","email":"a@b.c"}"#,
        r#"{"id":"u1","email":"a@b.c","email_verified":false}"#,
        r#"{"id":"u1","email":"a@b.c","email_verified":"true"}"#,
        r#"{"id":"u1","email":"a@b.c","email_verified":1}"#,
        r#"{"id":"u1","email":"a@b.c","email_verified":null}"#,
    ] {
        assert!(!decode(payload).email_verified, "{payload}");
    }
}

/// A caller carrying an unverified address keeps it for display, but it is
/// never offered as the address to match email-addressed grants.
#[test]
fn verified_email_requires_the_verification_bit() {
    let claims = |email: Option<&str>, email_verified: bool| VerifiedClaims {
        user_id: "u1".to_owned(),
        email: email.map(str::to_owned),
        email_verified,
        orgs: Vec::new(),
        teams: Vec::new(),
        feature_flags: BTreeSet::new(),
        feature_flags_org: None,
        limits: None,
    };

    let unverified = to_caller_for_org(&claims(Some("victim@example.com"), false), None);
    assert_eq!(unverified.email.as_deref(), Some("victim@example.com"));
    assert_eq!(unverified.verified_email(), None);

    let verified = to_caller_for_org(&claims(Some(" owner@example.com "), true), None);
    assert_eq!(verified.verified_email(), Some("owner@example.com"));

    let blank = to_caller_for_org(&claims(Some("  "), true), None);
    assert_eq!(blank.verified_email(), None);
    let missing = to_caller_for_org(&claims(None, true), None);
    assert_eq!(missing.verified_email(), None);
}
