//! Outbox tests. Content is the spec 00.9 sentinels only.

use super::*;

const ORG: &str = "6650c0a1b2c3d4e5f6a7b8c9";

fn event(request_id: &str, detector: &str, category: &str) -> ViolationEvent {
    let event_id = uuid_like(request_id, detector, category);
    ViolationEvent {
        event_id,
        occurred_at: "2026-10-24T10:00:00.000Z".into(),
        request_id: request_id.into(),
        attempt: 0,
        dedupe_key: dedupe_key(request_id, 0, detector, category),
        org_id: Some(ORG.into()),
        credential_id: Some("cred-1".into()),
        custodian_user_id: None,
        actor_user_id: None,
        forwarded_user_hash: None,
        end_user_hash: None,
        previous_end_user_hash: None,
        actor_kind: ActorKind::Credential,
        actor_ref: "cred-1".into(),
        upstream_subject: None,
        team_ids: vec![],
        agent_id: None,
        session_id: None,
        route: "/v1/chat/completions".into(),
        provider: None,
        slot_id: None,
        model: None,
        upstream_request_id: None,
        spend: SpendOwner::Ryu,
        category: category.into(),
        detector: DetectorRef {
            kind: DetectorKind::Classifier,
            id: detector.into(),
            version: Some("test-model@00000000#t1".into()),
        },
        severity: Severity::High,
        confidence: Some(0.9),
        action: EnforcementAction::Blocked,
        direction: ViolationDirection::Inbound,
        policy: Some(PolicyRef {
            policy_id: None,
            assignment_id: None,
            layer: PolicyLayer::Platform,
        }),
        fail_mode: FailMode::ClassifierOk,
        enforcement: EnforcementMode::Enforced,
        impersonated_by: None,
        processor_id: None,
        screening_id: Some("scr_test".into()),
        evidence_ref: None,
        evidence_hmac: Some("evh1.test".into()),
    }
}

/// A deterministic id per event for these tests; the gateway mints UUID v7.
fn uuid_like(request_id: &str, detector: &str, category: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(
        format!("{request_id}|{detector}|{category}").as_bytes(),
    ));
    format!(
        "{}-{}-7{}-8{}-{}",
        &digest[0..8],
        &digest[8..12],
        &digest[13..16],
        &digest[17..20],
        &digest[20..32]
    )
}

fn outbox() -> ViolationOutbox {
    ViolationOutbox::in_memory().expect("in-memory outbox")
}

#[test]
fn the_dedupe_key_carries_the_category() {
    assert_eq!(
        dedupe_key("req-1", 2, "decision_local", "hazard.S9"),
        "req-1:2:decision_local:hazard.S9"
    );
}

#[test]
fn the_wire_form_is_camel_case_with_snake_case_enums() {
    let wire = serde_json::to_value(event("req-1", "decision_local", "hazard.S9")).unwrap();
    assert_eq!(wire["orgId"], ORG);
    assert_eq!(wire["dedupeKey"], "req-1:0:decision_local:hazard.S9");
    assert_eq!(wire["actorKind"], "credential");
    assert_eq!(wire["detector"]["kind"], "classifier");
    assert_eq!(wire["failMode"], "classifier_ok");
    assert_eq!(wire["action"], "blocked");
    assert_eq!(wire["policy"]["layer"], "platform");
    assert_eq!(wire["enforcement"], "enforced");
    assert!(wire.get("processorId").is_some());
}

#[test]
fn one_row_per_dedupe_key() {
    let outbox = outbox();
    let first = event("req-1", "decision_local", "hazard.S9");
    assert_eq!(
        outbox.record(&first, None).unwrap(),
        RecordOutcome::Inserted
    );
    // A re-screen of the same body mints a new event id but keeps the key.
    let mut again = first.clone();
    again.event_id = uuid_like("req-1", "decision_local", "again");
    assert_eq!(
        outbox.record(&again, None).unwrap(),
        RecordOutcome::Duplicate
    );
    // Another code from the same detector for the same attempt is its own row.
    let other = event("req-1", "decision_local", "hazard.S1");
    assert_eq!(
        outbox.record(&other, None).unwrap(),
        RecordOutcome::Inserted
    );
    assert_eq!(outbox.len().unwrap(), 2);
}

#[test]
fn excerpts_are_sealed_at_rest_and_travel_with_an_evidence_ref() {
    let dir = std::env::temp_dir().join(format!("ryu-violation-seal-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("violations.db");
    let outbox = ViolationOutbox::open(&path).unwrap();
    let e = event("req-seal", "decision_local", "hazard.S9");
    outbox
        .record(&e, Some("RYU_TEST_HAZARD_S9 excerpt"))
        .unwrap();
    let rows = outbox.pending(10).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].excerpt.as_deref(),
        Some("RYU_TEST_HAZARD_S9 excerpt")
    );
    assert_eq!(
        rows[0].event.evidence_ref.as_deref(),
        Some(format!("evd_{}", e.event_id).as_str())
    );
    drop(outbox);
    let bytes = std::fs::read(&path).unwrap();
    let wal = std::fs::read(path.with_extension("db-wal")).unwrap_or_default();
    for file in [&bytes, &wal] {
        assert!(
            !String::from_utf8_lossy(file).contains("RYU_TEST_HAZARD_S9"),
            "the excerpt is never stored in clear"
        );
    }
    // Reopening with the same key file reads the excerpt back.
    let reopened = ViolationOutbox::open(&path).unwrap();
    assert!(reopened.pending(10).unwrap()[0].excerpt.is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_s4_row_never_holds_an_excerpt_and_purges_its_request() {
    let outbox = outbox();
    let s9 = event("req-s4", "decision_local", "hazard.S9");
    outbox.record(&s9, Some("RYU_TEST_HAZARD_S9")).unwrap();
    assert!(outbox.has_excerpt(&s9.event_id).unwrap());
    let s4 = event("req-s4", "decision_local", "hazard.S4");
    outbox.record(&s4, Some("RYU_TEST_HAZARD_S4")).unwrap();
    assert!(!outbox.has_excerpt(&s4.event_id).unwrap());
    assert!(
        !outbox.has_excerpt(&s9.event_id).unwrap(),
        "an S4 verdict purges every excerpt for its request"
    );
    // A later excerpt for the same request is refused.
    let late = event("req-s4", "output_guard", "hazard.S1");
    outbox.record(&late, Some("RYU_TEST_HAZARD_S1")).unwrap();
    assert!(!outbox.has_excerpt(&late.event_id).unwrap());
    for row in outbox.pending(10).unwrap() {
        assert!(row.excerpt.is_none());
        assert!(row.event.evidence_ref.is_none());
    }
    // Another request keeps its excerpt.
    let other = event("req-other", "decision_local", "hazard.S9");
    outbox.record(&other, Some("RYU_TEST_HAZARD_S9")).unwrap();
    assert!(outbox.has_excerpt(&other.event_id).unwrap());
}

#[test]
fn excerpts_are_capped_at_2048_bytes_on_a_char_boundary() {
    let outbox = outbox();
    let e = event("req-long", "decision_local", "hazard.S9");
    let long = "\u{e9}".repeat(3000);
    outbox.record(&e, Some(&long)).unwrap();
    let excerpt = outbox.pending(1).unwrap()[0].excerpt.clone().unwrap();
    assert!(excerpt.len() <= MAX_EXCERPT_BYTES);
    assert_eq!(excerpt.len(), 2048);
    assert_eq!(truncate_bytes("ab\u{e9}", 3), "ab");
}

#[test]
fn acknowledging_advances_the_cursor_and_clears_excerpts() {
    let outbox = outbox();
    let a = event("req-a", "decision_local", "hazard.S9");
    let b = event("req-b", "decision_local", "hazard.S9");
    outbox.record(&a, Some("RYU_TEST_HAZARD_S9")).unwrap();
    outbox.record(&b, Some("RYU_TEST_HAZARD_S9")).unwrap();
    let rows = outbox.pending(1).unwrap();
    assert_eq!(rows.len(), 1);
    outbox.acknowledge(rows[0].id).unwrap();
    assert!(!outbox.has_excerpt(&a.event_id).unwrap());
    assert!(outbox.has_excerpt(&b.event_id).unwrap());
    let rest = outbox.pending(10).unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].event.event_id, b.event_id);
    // The cursor never moves backwards.
    outbox.acknowledge(0).unwrap();
    assert_eq!(outbox.cursor().unwrap(), rows[0].id);
}

#[test]
fn excerpts_expire_after_72_hours_and_hold_under_the_cap() {
    let outbox = outbox().with_limits(OutboxLimits {
        max_excerpt_bytes_total: 200,
        ..OutboxLimits::default()
    });
    let now = now_secs();
    let old = event("req-old", "decision_local", "hazard.S9");
    outbox
        .record_at(&old, Some("RYU_TEST_HAZARD_S9"), now - EXCERPT_TTL_SECS - 1)
        .unwrap();
    for n in 0..5 {
        let e = event(&format!("req-{n}"), "decision_local", "hazard.S9");
        outbox
            .record_at(&e, Some(&"x".repeat(60)), now - 10 + n)
            .unwrap();
    }
    let summary = outbox.maintain_at(now).unwrap();
    assert_eq!(summary.expired_excerpts, 1);
    assert!(summary.capped_excerpts >= 1);
    assert!(outbox.excerpt_bytes().unwrap() <= 200);
    assert!(!outbox.has_excerpt(&old.event_id).unwrap());
    // Metadata and hashes stay.
    assert_eq!(outbox.len().unwrap(), 6);
    let newest = event("req-4", "decision_local", "hazard.S9");
    assert!(
        outbox.has_excerpt(&newest.event_id).unwrap(),
        "oldest go first"
    );
}

#[test]
fn the_row_cap_drops_acknowledged_rows_first() {
    let outbox = outbox().with_limits(OutboxLimits {
        max_rows: 3,
        ..OutboxLimits::default()
    });
    for n in 0..5 {
        outbox
            .record(
                &event(&format!("req-{n}"), "decision_local", "hazard.S9"),
                None,
            )
            .unwrap();
    }
    let rows = outbox.pending(2).unwrap();
    outbox.acknowledge(rows[1].id).unwrap();
    outbox.maintain().unwrap();
    assert_eq!(outbox.len().unwrap(), 3);
    assert_eq!(
        outbox.pending(10).unwrap().len(),
        3,
        "no unreported row lost"
    );
}

#[test]
fn a_dropped_excerpt_keeps_the_event() {
    let outbox = outbox();
    let e = event("req-drop", "decision_local", "hazard.S9");
    outbox.record(&e, Some("RYU_TEST_HAZARD_S9")).unwrap();
    outbox.drop_excerpt(&e.event_id).unwrap();
    let rows = outbox.pending(10).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].excerpt.is_none());
    assert!(rows[0].event.evidence_ref.is_none());
    assert_eq!(rows[0].event.evidence_hmac.as_deref(), Some("evh1.test"));
}

#[test]
fn a_stronger_action_on_an_unreported_key_upgrades_the_row_in_place() {
    let outbox = outbox();
    let mut flag = event("req-up", "decision_local", "hazard.S9");
    flag.action = EnforcementAction::LoggedOnly;
    flag.direction = ViolationDirection::Inbound;
    outbox.record(&flag, None).unwrap();
    let mut block = flag.clone();
    block.event_id = uuid_like("req-up", "decision_local", "output");
    block.action = EnforcementAction::Blocked;
    block.direction = ViolationDirection::Outbound;
    assert_eq!(
        outbox.record(&block, Some("RYU_TEST_HAZARD_S9")).unwrap(),
        RecordOutcome::Upgraded {
            event_id: flag.event_id.clone()
        }
    );
    let rows = outbox.pending(10).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].event.action, EnforcementAction::Blocked);
    assert_eq!(rows[0].event.direction, ViolationDirection::Outbound);
    assert_eq!(
        rows[0].event.event_id, flag.event_id,
        "the unsent id is kept"
    );
    assert!(rows[0].excerpt.is_some());
    // A weaker repeat never downgrades it.
    assert_eq!(
        outbox.record(&flag, None).unwrap(),
        RecordOutcome::Duplicate
    );
    assert_eq!(
        outbox.pending(10).unwrap()[0].event.action,
        EnforcementAction::Blocked
    );
}

#[test]
fn an_acknowledged_row_is_never_upgraded() {
    let outbox = outbox();
    let mut flag = event("req-acked", "decision_local", "hazard.S9");
    flag.action = EnforcementAction::LoggedOnly;
    outbox.record(&flag, None).unwrap();
    let id = outbox.pending(1).unwrap()[0].id;
    outbox.acknowledge(id).unwrap();
    let mut block = flag.clone();
    block.action = EnforcementAction::StreamTerminated;
    assert_eq!(
        outbox.record(&block, None).unwrap(),
        RecordOutcome::Duplicate
    );
    assert_eq!(
        outbox.all_events().unwrap()[0].action,
        EnforcementAction::LoggedOnly
    );
}

#[test]
fn opening_the_outbox_expires_old_excerpts() {
    let dir = std::env::temp_dir().join(format!("ryu-violation-open-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("violations.db");
    let old = event("req-stale", "decision_local", "hazard.S9");
    {
        let outbox = ViolationOutbox::open(&path).unwrap();
        outbox
            .record_at(
                &old,
                Some("RYU_TEST_HAZARD_S9"),
                now_secs() - EXCERPT_TTL_SECS - 5,
            )
            .unwrap();
        assert!(outbox.has_excerpt(&old.event_id).unwrap());
    }
    let reopened = ViolationOutbox::open(&path).unwrap();
    assert!(!reopened.has_excerpt(&old.event_id).unwrap());
    assert_eq!(reopened.len().unwrap(), 1, "metadata kept");
    drop(reopened);
    let _ = std::fs::remove_dir_all(&dir);
}
