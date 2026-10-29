//! Violation event tests. Content is the spec 00.9 sentinels only.

use super::test_support::{tenant_ctx, CREDENTIAL_OWNER, TENANT_CREDENTIAL, TENANT_ORG};
use super::*;
use crate::identity::IdentityKeys;
use crate::state::AppState;

fn keys() -> IdentityKeys {
    IdentityKeys::for_test(&[7u8; 32], None)
}

fn s9_block() -> VerdictInput {
    VerdictInput::classifier(
        TaxonomyId::S9,
        "decision_local",
        "test-model@00000000#t1".to_owned(),
        0.97,
        EnforcementAction::Blocked,
        ViolationDirection::Inbound,
        PolicyLayer::Platform,
    )
    .with_screening_id("scr_test")
}

fn build(custody: GatewayCustody, ctx: &RequestContext, input: VerdictInput) -> ViolationEvent {
    build_event(custody, &keys(), &|text| text.to_owned(), ctx, None, input).0
}

#[test]
fn every_event_names_the_tenant_org_and_credential() {
    let ctx = tenant_ctx("req-tenant");
    let event = build(GatewayCustody::Fleet, &ctx, s9_block());
    assert_eq!(event.org_id.as_deref(), Some(TENANT_ORG));
    assert_eq!(event.credential_id.as_deref(), Some(TENANT_CREDENTIAL));
    assert_eq!(event.custodian_user_id.as_deref(), Some(CREDENTIAL_OWNER));
    assert_eq!(event.actor_kind, ActorKind::Credential);
    assert_eq!(event.actor_ref, TENANT_CREDENTIAL);
    assert_eq!(
        event.end_user_hash.as_deref(),
        Some("eu1.1.0123456789abcdef0123456789abcdef")
    );
    assert_eq!(event.spend, SpendOwner::Ryu);
    assert_eq!(event.enforcement, EnforcementMode::Enforced);
    assert_eq!(event.severity, Severity::High);
    assert_eq!(event.fail_mode, FailMode::ClassifierOk);
    assert_eq!(
        event.dedupe_key,
        format!("req-tenant:0:{}:{}", event.detector.id, event.category)
    );
    assert_eq!(event.dedupe_key, "req-tenant:0:decision_local:hazard.S9");
    assert!(uuid::Uuid::parse_str(&event.event_id).is_ok());
    assert_eq!(
        uuid::Uuid::parse_str(&event.event_id)
            .unwrap()
            .get_version_num(),
        7
    );
    assert!(chrono::DateTime::parse_from_rfc3339(&event.occurred_at).is_ok());
}

#[test]
fn an_actor_without_a_reference_falls_back_to_the_credential() {
    let mut ctx = tenant_ctx("req-fallback");
    let mut identity = (**ctx.identity.as_ref().unwrap()).clone();
    identity.actor.subject_ref.clear();
    ctx.identity = Some(Arc::new(identity));
    let event = build(GatewayCustody::Fleet, &ctx, s9_block());
    assert_eq!(event.actor_kind, ActorKind::Credential);
    assert_eq!(event.actor_ref, TENANT_CREDENTIAL);

    let mut bare = crate::pipeline::test_support::plain_request_context();
    bare.identity = None;
    bare.org_limits = None;
    bare.org_id = None;
    let event = build(GatewayCustody::SelfHosted, &bare, s9_block());
    assert_eq!(event.actor_kind, ActorKind::Node);
    assert!(!event.actor_ref.is_empty());
    assert_eq!(
        event.spend,
        SpendOwner::Tenant,
        "self-hosted is never Ryu spend"
    );
}

#[test]
fn s4_never_carries_an_excerpt_only_its_keyed_hash() {
    let ctx = tenant_ctx("req-s4");
    let input = VerdictInput::classifier(
        TaxonomyId::S4,
        "decision_local",
        "test-model@00000000#t1".to_owned(),
        0.99,
        EnforcementAction::Blocked,
        ViolationDirection::Inbound,
        PolicyLayer::Platform,
    )
    .with_evidence("RYU_TEST_HAZARD_S4");
    let (event, excerpt) = build_event(
        GatewayCustody::Fleet,
        &keys(),
        &|text| text.to_owned(),
        &ctx,
        None,
        input,
    );
    assert!(excerpt.is_none());
    assert_eq!(event.severity, Severity::Critical);
    let hmac = event
        .evidence_hmac
        .as_deref()
        .expect("S4 keeps its keyed hash");
    assert!(hmac.starts_with("evh1."));
    let wire = serde_json::to_string(&event).unwrap();
    assert!(!wire.contains("RYU_TEST_HAZARD_S4"));
}

#[test]
fn the_excerpt_is_redacted_and_cut_to_2_kb() {
    let ctx = tenant_ctx("req-excerpt");
    let long = format!("RYU_TEST_HAZARD_S9 {}", "y".repeat(4000));
    let (event, excerpt) = build_event(
        GatewayCustody::Fleet,
        &keys(),
        &|text| text.replace("RYU_TEST_HAZARD_S9", "[REDACTED]"),
        &ctx,
        None,
        s9_block().with_evidence(&long),
    );
    let excerpt = excerpt.expect("S9 allows a redacted excerpt");
    assert!(excerpt.starts_with("[REDACTED]"));
    assert!(excerpt.len() <= 2048);
    assert!(event.evidence_ref.is_none(), "set by the outbox, not here");
    let wire = serde_json::to_string(&event).unwrap();
    assert!(
        !wire.contains("RYU_TEST_HAZARD_S9"),
        "no prompt text on the event"
    );
    assert!(!wire.contains("yyyy"));
}

#[test]
fn the_evidence_hash_is_keyed_and_normalized() {
    let a = keys().evidence_hmac(&normalize("RYU_TEST_HAZARD_S9   one"));
    let b = keys().evidence_hmac(&normalize("ryu_test_hazard_s9 ONE"));
    assert_eq!(a, b);
    let other = IdentityKeys::for_test(&[8u8; 32], None).evidence_hmac(&normalize("x"));
    assert_ne!(other, keys().evidence_hmac(&normalize("x")));
}

#[test]
fn regex_matches_map_to_the_taxonomy() {
    assert_eq!(
        category_for_match(&DetectionKind::Secret, false),
        TaxonomyId::SECRET
    );
    assert_eq!(
        category_for_match(&DetectionKind::Hazard(TaxonomyId::S4), false),
        TaxonomyId::S4
    );
    assert_eq!(
        category_for_match(&DetectionKind::Pii, true).as_str(),
        "content.custom_pattern"
    );
    assert_eq!(
        category_for_match(&DetectionKind::PromptInjection, false),
        TaxonomyId::PROMPT_INJECTION
    );
}

#[test]
fn record_violation_writes_one_row_per_dedupe_key() {
    let state = AppState::new_for_test_default();
    let ctx = tenant_ctx("req-record");
    let first = state.record_violation(&ctx, s9_block());
    assert!(first.is_some());
    assert!(
        state.record_violation(&ctx, s9_block()).is_none(),
        "a re-screen of the same attempt does not double count"
    );
    let flagged = VerdictInput::classifier(
        TaxonomyId::S1,
        "decision_local",
        "test-model@00000000#t1".to_owned(),
        0.7,
        EnforcementAction::LoggedOnly,
        ViolationDirection::Inbound,
        PolicyLayer::Platform,
    );
    assert!(state.record_violation(&ctx, flagged).is_some());
    let events = state.violations.all_events().unwrap();
    assert_eq!(events.len(), 2);
    assert!(events
        .iter()
        .all(|e| e.org_id.as_deref() == Some(TENANT_ORG)
            && e.credential_id.as_deref() == Some(TENANT_CREDENTIAL)));
    assert_ne!(events[0].dedupe_key, events[1].dedupe_key);
}

#[test]
fn an_output_block_upgrades_an_unreported_admission_flag_for_the_same_key() {
    let state = AppState::new_for_test_default();
    let ctx = tenant_ctx("req-upgrade");
    let flag = VerdictInput::classifier(
        TaxonomyId::S9,
        "decision_local",
        "test-model@00000000#t1".to_owned(),
        0.6,
        EnforcementAction::LoggedOnly,
        ViolationDirection::Inbound,
        PolicyLayer::Platform,
    );
    let first = state.record_violation(&ctx, flag).unwrap();
    let block = VerdictInput::classifier(
        TaxonomyId::S9,
        "decision_local",
        "test-model@00000000#t1".to_owned(),
        0.98,
        EnforcementAction::StreamTerminated,
        ViolationDirection::Outbound,
        PolicyLayer::Platform,
    );
    assert_eq!(state.record_violation(&ctx, block), Some(first.clone()));
    let events = state.violations.all_events().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_id, first);
    assert_eq!(events[0].action, EnforcementAction::StreamTerminated);
    assert_eq!(events[0].direction, ViolationDirection::Outbound);
}

#[test]
fn a_self_hosted_node_keeps_no_excerpt() {
    let ctx = tenant_ctx("req-self-hosted");
    let (event, excerpt) = build_event(
        GatewayCustody::SelfHosted,
        &keys(),
        &|text| text.to_owned(),
        &ctx,
        None,
        s9_block().with_evidence("RYU_TEST_HAZARD_S9 local"),
    );
    assert!(
        excerpt.is_none(),
        "no screened text leaves a self-hosted node"
    );
    assert!(event.evidence_hmac.is_some());
    assert_eq!(event.spend, SpendOwner::Tenant);
}
