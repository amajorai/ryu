use super::push_tokens::resolve_push_token_owner;
use super::*;
use crate::identity_verify::OrgRole;

fn caller(user_id: &str) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: None,
        role: OrgRole::Member,
        teams: Vec::new(),
    }
}

/// The deterministic security core (independent of node binding): with a verified
/// caller, the effective viewer is ALWAYS the caller's own id, and a `requested`
/// id that names a DIFFERENT member is a 403 — one teammate can never read
/// another's inbox by passing their user_id.
#[test]
fn verified_caller_is_pinned_to_own_id() {
    // Matching requested id → OK, resolves to the caller.
    assert_eq!(
        resolve_viewer(Some(caller("alice")), Some("alice")),
        Ok("alice".to_owned())
    );
    // No requested id → still the caller's own id (never anonymous).
    assert_eq!(
        resolve_viewer(Some(caller("alice")), None),
        Ok("alice".to_owned())
    );
    // Empty requested id is ignored (filtered) → the caller's own id.
    assert_eq!(
        resolve_viewer(Some(caller("alice")), Some("")),
        Ok("alice".to_owned())
    );
}

#[test]
fn verified_caller_reading_another_member_is_forbidden() {
    // Bob presents a valid JWT but asks for Alice's feed → 403, no data leak.
    assert_eq!(
        resolve_viewer(Some(caller("bob")), Some("alice")),
        Err(StatusCode::FORBIDDEN)
    );
}

#[test]
fn push_token_owner_uses_verified_caller_not_requested_member() {
    assert_eq!(
        resolve_push_token_owner(Some(caller("alice")), Some("alice")),
        Ok(Some("alice".to_owned()))
    );
    assert_eq!(
        resolve_push_token_owner(Some(caller("alice")), Some("bob")),
        Err(StatusCode::FORBIDDEN)
    );
}

/// The anonymous branch depends on the node's org-binding — a process-global read
/// that a sibling test (`control_plane`) mutates. Assert only against the binding
/// state observed at call time so this stays deterministic under parallel runs.
#[test]
fn anonymous_viewer_matches_node_binding() {
    let bound = crate::sidecar::control_plane::registered_org().is_some();
    let with_id = resolve_viewer(None, Some("alice"));
    let without_id = resolve_viewer(None, None);
    if bound {
        // Org-bound node: a member feed is never readable unauthenticated.
        assert_eq!(with_id, Err(StatusCode::UNAUTHORIZED));
        assert_eq!(without_id, Err(StatusCode::UNAUTHORIZED));
    } else {
        // Unbound local (single-user) node: trust the requested id, but an absent
        // id is a 400 (the surface must name whose feed it wants).
        assert_eq!(with_id, Ok("alice".to_owned()));
        assert_eq!(without_id, Err(StatusCode::BAD_REQUEST));
    }
}

/// The list query defaults an absent `limit`/`user_id` and the handler clamps
/// `limit` into `[1, MAX_LIMIT]` — a caller cannot request an unbounded page.
#[test]
fn list_query_defaults_and_limit_clamps() {
    let q: ListQuery = serde_json::from_value(json!({})).unwrap();
    assert!(q.user_id.is_none());
    assert!(q.limit.is_none());

    // The handler's clamp: `q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)`.
    assert_eq!(0i64.clamp(1, MAX_LIMIT), 1);
    assert_eq!(10_000i64.clamp(1, MAX_LIMIT), MAX_LIMIT);
    assert_eq!((-5i64).clamp(1, MAX_LIMIT), 1);
    assert_eq!(DEFAULT_LIMIT.clamp(1, MAX_LIMIT), DEFAULT_LIMIT);
}

#[test]
fn mention_targets_payload_preserves_member_avatar_data() {
    let payload = mention_targets_payload(vec![crate::sidecar::control_plane::NotifyTargetUser {
        email: Some("ada@example.test".to_owned()),
        image: Some("https://cdn.example.test/ada.webp".to_owned()),
        name: Some("Ada Lovelace".to_owned()),
        role: Some("member".to_owned()),
        user_id: "user-ada".to_owned(),
    }]);
    assert_eq!(
        payload,
        json!({
            "users": [{
                "email": "ada@example.test",
                "image": "https://cdn.example.test/ada.webp",
                "name": "Ada Lovelace",
                "role": "member",
                "userId": "user-ada",
            }]
        })
    );
}

/// The app's UI language rides on registration; an older build omits it, which
/// must leave the stored locale alone rather than clear it.
#[test]
fn push_token_body_carries_an_optional_locale() {
    let body: super::push_tokens::PushTokenBody =
        serde_json::from_value(json!({ "token": "tok", "locale": "pt-BR" })).unwrap();
    assert_eq!(body.locale.as_deref(), Some("pt-BR"));
    let legacy: super::push_tokens::PushTokenBody =
        serde_json::from_value(json!({ "token": "tok" })).unwrap();
    assert!(legacy.locale.is_none());
    assert!(legacy.run_finished.is_none());
}
