//! Row admission, parsing and bookkeeping for the pending-purge pull. The
//! cycle against a fake control plane is in `data_purge_pull_cycle_tests.rs`.

use super::*;

fn row(id: &str, user_id: &str, reason: &str, delegation: Option<&str>) -> PulledPurge {
    PulledPurge {
        id: id.to_owned(),
        user_id: user_id.to_owned(),
        reason: reason.to_owned(),
        delegation: delegation.map(str::to_owned),
    }
}

/// Accepts `ok:<member>` as a purge delegation for `<member>`.
fn signed(token: &str, _: u64) -> Option<String> {
    token.strip_prefix("ok:").map(str::to_owned)
}

#[test]
fn only_account_deleted_and_member_removed_rows_are_admitted() {
    let token = Some("ok:u1");
    assert_eq!(
        admit(&row("a", "u1", "account_deleted", token), &signed, 100),
        Ok(PurgeReason::AccountDeleted)
    );
    assert_eq!(
        admit(&row("a", "u1", "member_removed", token), &signed, 100),
        Ok(PurgeReason::MemberRemoved)
    );
    for reason in ["self", "", "other", "ACCOUNT_DELETED"] {
        assert_eq!(
            admit(&row("a", "u1", reason, token), &signed, 100),
            Err(Refusal::InvalidReason)
        );
    }
}

#[test]
fn malformed_member_ids_are_refused() {
    let long = "u".repeat(257);
    for user_id in ["", " u1", "u1 ", "u\n1", long.as_str()] {
        let token = format!("ok:{user_id}");
        assert_eq!(
            admit(
                &row("a", user_id, "member_removed", Some(&token)),
                &signed,
                100
            ),
            Err(Refusal::InvalidUserId)
        );
    }
}

#[test]
fn every_row_must_carry_a_delegation() {
    // Even a well-formed departure row is never run on the transport alone.
    for reason in ["account_deleted", "member_removed"] {
        assert_eq!(
            admit(&row("a", "u1", reason, None), &signed, 100),
            Err(Refusal::MissingDelegation)
        );
    }
}

#[test]
fn a_delegation_must_verify_for_that_member() {
    assert_eq!(
        admit(
            &row("a", "u1", "member_removed", Some("ok:u1")),
            &signed,
            100
        ),
        Ok(PurgeReason::MemberRemoved)
    );
    // Invalid token, or valid for a different member: refused.
    assert_eq!(
        admit(
            &row("a", "u1", "member_removed", Some("forged")),
            &signed,
            100
        ),
        Err(Refusal::InvalidDelegation)
    );
    assert_eq!(
        admit(
            &row("a", "u2", "member_removed", Some("ok:u1")),
            &signed,
            100
        ),
        Err(Refusal::InvalidDelegation)
    );
    // The real verifier: no registered node in tests, so it fails closed.
    assert_eq!(
        admit(
            &row("a", "u1", "member_removed", Some("a.b.c")),
            &verified_purge_subject,
            100
        ),
        Err(Refusal::InvalidDelegation)
    );
}

#[test]
fn only_rows_the_cloud_got_wrong_are_acknowledged_incomplete() {
    assert_eq!(Refusal::InvalidUserId.ack(), Some(AckStatus::Incomplete));
    assert_eq!(Refusal::InvalidReason.ack(), Some(AckStatus::Incomplete));
    assert_eq!(Refusal::MissingDelegation.ack(), None);
    assert_eq!(Refusal::InvalidDelegation.ack(), None);
}

#[test]
fn an_unverifiable_token_is_not_a_purge_subject() {
    // No registered node in tests: the real verifier fails closed.
    assert_eq!(verified_purge_subject("a.b.c", 0), None);
    assert_eq!(verified_purge_subject("", 0), None);
}

#[test]
fn row_ids_are_bounded_and_free_of_control_characters() {
    assert!(valid_row_id("665f1c2a9b3e4d0012ab34cd"));
    assert!(valid_row_id("665f1c2a9b3e4d0012ab34cd:user_abc"));
    assert!(valid_row_id("a/b?c#d%e"));
    assert!(valid_row_id(&format!(
        "{}:{}",
        "n".repeat(64),
        "u".repeat(256)
    )));
    for id in [
        "",
        ".",
        "..",
        "a\nb",
        "a\u{0}b",
        &"x".repeat(MAX_ID_BYTES + 1),
    ] {
        assert!(!valid_row_id(id), "{id:?}");
    }
}

#[test]
fn ack_urls_encode_the_id_as_one_path_segment() {
    let url = ack_url("https://cp.example/", "665f:user_abc").expect("url");
    assert_eq!(
        url.as_str(),
        "https://cp.example/api/control-plane/gateway/data-purges/665f:user_abc/ack"
    );
    let url = ack_url("https://cp.example", "n:a/b?c#d%e").expect("url");
    assert_eq!(
        url.path(),
        "/api/control-plane/gateway/data-purges/n:a%2Fb%3Fc%23d%25e/ack"
    );
    assert!(ack_url("not a url", "p1").is_none());
}

#[test]
fn the_pull_body_drops_bad_rows_and_duplicates() {
    let body = json!({ "purges": [
        { "id": "p1", "user_id": "u1", "reason": "account_deleted" },
        { "id": "p1", "user_id": "u1", "reason": "account_deleted" },
        { "id": "", "user_id": "u2", "reason": "member_removed" },
        { "id": "p3", "reason": "member_removed" },
        "nonsense",
    ]});
    let (rows, malformed) = parse_pull_body(&body).expect("parses");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "p1");
    assert_eq!(malformed, 3);
    // The cloud's real row ids are `<node id>:<user id>`.
    let body = json!({ "purges": [
        { "id": "665f1c2a9b3e4d0012ab34cd:user_abc", "user_id": "user_abc", "reason": "account_deleted" },
    ]});
    let (rows, malformed) = parse_pull_body(&body).expect("parses");
    assert_eq!(malformed, 0);
    assert_eq!(rows[0].id, "665f1c2a9b3e4d0012ab34cd:user_abc");
    assert_eq!(parse_pull_body(&json!({})).err(), Some(CycleError::Decode));
    assert_eq!(
        parse_pull_body(&json!({ "purges": {} })).err(),
        Some(CycleError::Decode)
    );
}

#[test]
fn the_pull_body_is_capped_per_cycle() {
    let purges: Vec<Value> = (0..80)
        .map(|n| json!({ "id": format!("p{n}"), "user_id": "u", "reason": "member_removed" }))
        .collect();
    let (rows, _) = parse_pull_body(&json!({ "purges": purges })).expect("parses");
    assert_eq!(rows.len(), MAX_ROWS_PER_CYCLE);
}

#[test]
fn pending_acks_are_bounded_oldest_first() {
    let mut pending = PendingAcks::default();
    for n in 0..(MAX_PENDING_ACKS + 3) {
        pending.insert(&format!("p{n}"), AckStatus::Done);
    }
    assert_eq!(pending.len(), MAX_PENDING_ACKS);
    assert!(!pending.contains("p0"));
    assert!(pending.contains(&format!("p{}", MAX_PENDING_ACKS + 2)));
    pending.remove("p5");
    assert!(!pending.contains("p5"));
    assert_eq!(pending.len(), MAX_PENDING_ACKS - 1);
}
