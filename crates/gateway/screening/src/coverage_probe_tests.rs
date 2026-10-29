//! Coverage probe for P2-G1 and G2 (screener addendum section 13.1): the
//! backends crate exercised in the shape of every floor-bound surface.
//!
//! The gateway does not call this crate yet (admission glue is G4), so each
//! route is probed through its crate-level equivalent:
//!
//! - chat, compat and responses: `Direction::Inbound` under the chat deadline;
//! - stream windows: `Direction::Outbound` on the output role;
//! - tool rounds: `ToolArgs` and `ToolResult` under the tool-round deadline;
//! - media: `MediaInput` and `MediaOutput` on the vision role;
//! - embeddings and rerank: a multi-item batch through the concurrency gate;
//! - fallback attempts and cache hits: a shared `SegmentCache`.
//!
//! Content is the spec 00.9 sentinels only, against `TestBackend` and the
//! mock guard and systemone engines.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::backend::{
    BackendError, CodeSet, Direction, LeafClass, Locality, ScreenImage, ScreenItem, ScreenRequest,
    ScreenTier, ScreenerBackend, TaxonomyId,
};
use crate::backends::decision::{DecisionBackend, DecisionConfig, RemotePermit};
use crate::backends::guard_model::{
    parse_llama_guard, parse_qwen3guard, GuardDialect, GuardModelBackend, GuardModelConfig,
};
use crate::backends::test::{
    TestBackend, SENTINEL_HAZARD_S1, SENTINEL_HAZARD_S4, SENTINEL_HAZARD_S9, SENTINEL_PROMPT_ATTACK,
};
use crate::cache::{SegmentCache, SegmentKey};
use crate::chain::{ChainPolicy, QualificationRecord, Role, ScreenerChain};
use crate::testing::MockServer;

const ORG_A: &[u8] = b"org-a-scope-key";
const ORG_B: &[u8] = b"org-b-scope-key";

/// Surface deadlines from spec 02.7.
const CHAT_MS: u64 = 600;
const TOOL_ROUND_MS: u64 = 400;
const MEDIA_MS: u64 = 3_000;

fn text_item(scope: &[u8], class: LeafClass, text: &str) -> ScreenItem {
    ScreenItem::text(
        SegmentKey::for_text(scope, class, text),
        class,
        text.to_string(),
    )
}

fn image_item(scope: &[u8], class: LeafClass, bytes: &[u8]) -> ScreenItem {
    let image = ScreenImage::new(bytes.to_vec(), "image/png");
    ScreenItem::image(
        SegmentKey::for_image(scope, class, &image.sha256),
        class,
        image,
    )
}

fn request<'a>(
    items: &'a [ScreenItem],
    wanted: &'a CodeSet,
    direction: Direction,
    tier: ScreenTier,
    budget_ms: u64,
) -> ScreenRequest<'a> {
    ScreenRequest {
        correlation_id: "corr-probe",
        direction,
        tier,
        items,
        wanted,
        deadline: Instant::now() + Duration::from_millis(budget_ms),
    }
}

fn qualify(backend: &dyn ScreenerBackend, codes: CodeSet) -> QualificationRecord {
    let r = &backend.descriptor().reference;
    QualificationRecord {
        backend_id: r.id.clone(),
        model: r.model.clone(),
        weights_sha256: r.weights_sha256.clone(),
        template_version: r.template_version,
        codes,
    }
}

fn floor_policy(backends: &[&dyn ScreenerBackend]) -> ChainPolicy {
    ChainPolicy {
        qualifications: backends
            .iter()
            .map(|b| qualify(*b, CodeSet::from([TaxonomyId::S4, TaxonomyId::S9])))
            .collect(),
        ..ChainPolicy::default()
    }
}

fn guard_backend(mock: &MockServer, dialect: GuardDialect, images: bool) -> GuardModelBackend {
    GuardModelBackend::new(GuardModelConfig {
        id: if images { "guard_vision" } else { "guard_text" }.into(),
        base_url: mock.base_url.clone(),
        locality: Locality::PrivateNetwork,
        model: "mock-guard".into(),
        weights_sha256: Some("abcdef0123456789".into()),
        template_version: 1,
        dialect,
        images,
        bearer: None,
        hard_timeout_ms: 800,
        max_concurrency: 4,
    })
    .expect("guard backend")
}

fn decision_config(url: &str, id: &str) -> DecisionConfig {
    DecisionConfig {
        id: id.into(),
        url: url.into(),
        model: "laya".into(),
        weights_sha256: Some("0123456789abcdef0123".into()),
        hard_timeout_ms: 800,
        max_concurrency: 4,
    }
}

fn jev(mock: &MockServer, permit: RemotePermit) -> DecisionBackend {
    DecisionBackend::remote_plaintext_for_test(
        decision_config(&mock.base_url, "jev"),
        "typesafe",
        Some("screener-key".into()),
        permit,
    )
    .expect("jev backend")
}

fn body_text(body: &Value) -> String {
    body.to_string()
}

// ---------------------------------------------------------------------------
// Chat, compat and responses (inbound, chat deadline)
// ---------------------------------------------------------------------------

/// Every inbound leaf class a compat or responses body projects to reaches
/// the primary local decision model, and S4 and S9 are decided per class.
#[tokio::test]
async fn probe_chat_and_compat_classes_decide_hard_codes_on_the_decision_model() {
    let mock = MockServer::systemone().await;
    let local = Arc::new(
        DecisionBackend::local(
            decision_config(&mock.base_url, "decision_local"),
            Locality::Loopback,
        )
        .expect("local decision"),
    );
    let chain = ScreenerChain::new(floor_policy(&[local.as_ref()]))
        .with_role(Role::TextHazard, vec![local.clone()]);
    let classes = [
        LeafClass::User,
        LeafClass::System,
        LeafClass::Assistant,
        LeafClass::Freeform,
        LeafClass::Decoded,
        LeafClass::Definition,
    ];
    let items: Vec<ScreenItem> = classes
        .iter()
        .map(|c| text_item(ORG_A, *c, &format!("{} {SENTINEL_HAZARD_S4}", c.as_str())))
        .collect();
    let wanted = CodeSet::hazards();
    let v = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                CHAT_MS,
            ),
        )
        .await;
    assert_eq!(mock.calls(), classes.len());
    for item in &v.items {
        assert!(item.score(TaxonomyId::S4).unwrap() >= 0.9, "{item:?}");
        assert!(item.decided.contains(TaxonomyId::S4));
        assert!(item.decided.contains(TaxonomyId::S9));
    }
    assert!(v.undecided_hard(chain.policy()).is_empty());
    for captured in mock.requests() {
        assert_eq!(captured.body["state"]["direction"], "inbound");
    }
}

/// The prompt-attack role on the decision model scores the sentinel from the
/// same question set.
#[tokio::test]
async fn probe_prompt_attack_role_on_the_decision_model() {
    let mock = MockServer::systemone().await;
    let local = Arc::new(
        DecisionBackend::local(
            decision_config(&mock.base_url, "decision_local"),
            Locality::Loopback,
        )
        .expect("local decision"),
    );
    let chain = ScreenerChain::new(floor_policy(&[local.as_ref()]))
        .with_role(Role::PromptAttack, vec![local.clone()]);
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_PROMPT_ATTACK)];
    let wanted = CodeSet::from([TaxonomyId::PROMPT_INJECTION]);
    let v = chain
        .screen(
            Role::PromptAttack,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                CHAT_MS,
            ),
        )
        .await;
    assert!(v.max_score(TaxonomyId::PROMPT_INJECTION).unwrap() >= 0.9);
    assert!(v.undecided().is_empty());
}

// ---------------------------------------------------------------------------
// Stream windows and final output (outbound)
// ---------------------------------------------------------------------------

/// Output windows reach the guard in response-classification form: the prior
/// user turn as `user`, the window as `assistant`.
#[tokio::test]
async fn probe_stream_window_uses_response_classification_form() {
    let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
    let guard = Arc::new(guard_backend(&mock, GuardDialect::LlamaGuard, false));
    let chain = ScreenerChain::new(floor_policy(&[guard.as_ref()]))
        .with_role(Role::Output, vec![guard.clone()]);
    let items = [text_item(
        ORG_A,
        LeafClass::Assistant,
        &format!("window {SENTINEL_HAZARD_S9}"),
    )
    .with_context("prior user turn")];
    let wanted = CodeSet::hazards();
    let v = chain
        .screen(
            Role::Output,
            &request(
                &items,
                &wanted,
                Direction::Outbound,
                ScreenTier::Floor,
                CHAT_MS,
            ),
        )
        .await;
    assert!(v.max_score(TaxonomyId::S9).unwrap() >= 0.5);
    let captured = mock.requests();
    let messages = captured[0].body["messages"].as_array().unwrap();
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
}

/// A decision model on the output role is told the content is outbound.
#[tokio::test]
async fn probe_decision_model_marks_outbound_windows() {
    let mock = MockServer::systemone().await;
    let local = Arc::new(
        DecisionBackend::local(
            decision_config(&mock.base_url, "decision_local"),
            Locality::Loopback,
        )
        .expect("local decision"),
    );
    let chain = ScreenerChain::new(floor_policy(&[local.as_ref()]))
        .with_role(Role::Output, vec![local.clone()]);
    let items = [text_item(ORG_A, LeafClass::Assistant, SENTINEL_HAZARD_S4)];
    let wanted = CodeSet::hazards();
    let v = chain
        .screen(
            Role::Output,
            &request(
                &items,
                &wanted,
                Direction::Outbound,
                ScreenTier::Floor,
                CHAT_MS,
            ),
        )
        .await;
    assert!(v.max_score(TaxonomyId::S4).unwrap() >= 0.9);
    assert_eq!(mock.requests()[0].body["state"]["direction"], "outbound");
}

// ---------------------------------------------------------------------------
// Tool rounds
// ---------------------------------------------------------------------------

/// Tool arguments and tool results are screened under the 400 ms tool-round
/// budget; a backend slower than the budget leaves hard codes undecided
/// rather than passing them.
#[tokio::test]
async fn probe_tool_round_budget_is_enforced_and_fails_undecided() {
    let fast = Arc::new(TestBackend::new("guard_text"));
    let chain = ScreenerChain::new(floor_policy(&[fast.as_ref()]))
        .with_role(Role::TextHazard, vec![fast.clone()]);
    let items = [
        text_item(ORG_A, LeafClass::ToolArgs, SENTINEL_HAZARD_S9),
        text_item(ORG_A, LeafClass::ToolResult, SENTINEL_HAZARD_S4),
    ];
    let wanted = CodeSet::hazards();
    for direction in [Direction::ToolArgs, Direction::ToolResult] {
        let v = chain
            .screen(
                Role::TextHazard,
                &request(&items, &wanted, direction, ScreenTier::Floor, TOOL_ROUND_MS),
            )
            .await;
        assert_eq!(v.items[0].score(TaxonomyId::S9), Some(1.0));
        assert_eq!(v.items[1].score(TaxonomyId::S4), Some(1.0));
    }

    let slow = Arc::new(TestBackend::new("guard_slow").delay(Duration::from_secs(5)));
    let chain = ScreenerChain::new(floor_policy(&[slow.as_ref()]))
        .with_role(Role::TextHazard, vec![slow.clone()]);
    let started = Instant::now();
    let v = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::ToolArgs,
                ScreenTier::Floor,
                TOOL_ROUND_MS,
            ),
        )
        .await;
    assert!(started.elapsed() < Duration::from_millis(1_500));
    let undecided = v.undecided_hard(chain.policy());
    assert!(undecided.contains(TaxonomyId::S4) && undecided.contains(TaxonomyId::S9));
    assert_eq!(v.outcomes[0].error, Some(BackendError::Timeout));
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/// No vision backend: an input image is left undecided on S4 (the gateway
/// turns this into 403 `media_unscreenable`), never decided as allowed.
#[tokio::test]
async fn probe_media_without_a_vision_backend_is_undecided_on_s4() {
    let text = Arc::new(TestBackend::new("guard_text"));
    let chain = ScreenerChain::new(floor_policy(&[text.as_ref()]))
        .with_role(Role::TextHazard, vec![text.clone()]);
    let items = [image_item(ORG_A, LeafClass::User, b"png-bytes")];
    let wanted = CodeSet::hazards();
    for role in [Role::Vision, Role::TextHazard] {
        let v = chain
            .screen(
                role,
                &request(
                    &items,
                    &wanted,
                    Direction::MediaInput,
                    ScreenTier::Floor,
                    MEDIA_MS,
                ),
            )
            .await;
        assert!(v.undecided_hard(chain.policy()).contains(TaxonomyId::S4));
        assert!(v.items[0].score(TaxonomyId::S4).is_none());
    }
    assert_eq!(text.calls(), 0);
}

/// Input images reach a vision guard as the exact bytes, as a data URL.
#[tokio::test]
async fn probe_media_input_sends_the_image_bytes() {
    let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
    let vision = Arc::new(guard_backend(&mock, GuardDialect::LlamaGuard, true));
    let chain = ScreenerChain::new(floor_policy(&[vision.as_ref()]))
        .with_role(Role::Vision, vec![vision.clone()]);
    let items = [image_item(ORG_A, LeafClass::User, b"input-image-bytes")];
    let wanted = CodeSet::hazards();
    let _ = chain
        .screen(
            Role::Vision,
            &request(
                &items,
                &wanted,
                Direction::MediaInput,
                ScreenTier::Floor,
                MEDIA_MS,
            ),
        )
        .await;
    let captured = mock.requests();
    assert_eq!(captured.len(), 1);
    assert!(body_text(&captured[0].body).contains("data:image/png;base64,"));
}

/// Generated images (section 9 rule 3) are screened before return, so the
/// vision guard must receive their bytes. Today the output branch of the
/// guard body builds text-only messages and drops the image.
#[tokio::test]
async fn probe_media_output_sends_the_generated_image_bytes() {
    let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
    let vision = Arc::new(guard_backend(&mock, GuardDialect::LlamaGuard, true));
    let chain = ScreenerChain::new(floor_policy(&[vision.as_ref()]))
        .with_role(Role::Vision, vec![vision.clone()]);
    let items = [
        image_item(ORG_A, LeafClass::Assistant, b"generated-image-bytes")
            .with_context("prompt for the image"),
    ];
    let wanted = CodeSet::hazards();
    let _ = chain
        .screen(
            Role::Vision,
            &request(
                &items,
                &wanted,
                Direction::MediaOutput,
                ScreenTier::Floor,
                MEDIA_MS,
            ),
        )
        .await;
    let captured = mock.requests();
    assert_eq!(captured.len(), 1);
    assert!(
        body_text(&captured[0].body).contains("data:image/png;base64,"),
        "generated image never reached the vision guard: {}",
        captured[0].body
    );
}

// ---------------------------------------------------------------------------
// Embeddings and rerank (batched inputs)
// ---------------------------------------------------------------------------

/// Every input of an embeddings batch is screened (one item per call, fanned
/// out under the concurrency gate) and a hazard in any one of them is found.
#[tokio::test]
async fn probe_embeddings_batch_screens_every_input() {
    let backend = Arc::new(
        TestBackend::new("guard_text")
            .concurrency(2)
            .delay(Duration::from_millis(10)),
    );
    let chain = ScreenerChain::new(floor_policy(&[backend.as_ref()]))
        .with_role(Role::TextHazard, vec![backend.clone()]);
    let mut items: Vec<ScreenItem> = (0..8)
        .map(|i| text_item(ORG_A, LeafClass::User, &format!("input {i}")))
        .collect();
    items.push(text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S9));
    let wanted = CodeSet::hazards();
    let v = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                CHAT_MS,
            ),
        )
        .await;
    assert_eq!(backend.calls(), items.len());
    assert!(v.undecided().is_empty(), "{:?}", v.undecided());
    assert_eq!(v.items.last().unwrap().score(TaxonomyId::S9), Some(1.0));
}

// ---------------------------------------------------------------------------
// Fallback attempts and cache hits
// ---------------------------------------------------------------------------

/// An own-supply fallback re-screens the identical body: the second attempt
/// is served from the cache (backend call count 1, spec K1) and still
/// decides the hard codes.
#[tokio::test]
async fn probe_fallback_attempt_reuses_cached_scores() {
    let backend = Arc::new(TestBackend::new("guard_text"));
    let cache = Arc::new(SegmentCache::default());
    let chain = ScreenerChain::new(floor_policy(&[backend.as_ref()]))
        .with_role(Role::TextHazard, vec![backend.clone()])
        .with_cache(cache.clone());
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S9)];
    let wanted = CodeSet::hazards();
    for _attempt in 0..2 {
        let v = chain
            .screen(
                Role::TextHazard,
                &request(
                    &items,
                    &wanted,
                    Direction::Inbound,
                    ScreenTier::Floor,
                    CHAT_MS,
                ),
            )
            .await;
        assert_eq!(v.items[0].score(TaxonomyId::S9), Some(1.0));
        assert!(v.undecided_hard(chain.policy()).is_empty());
    }
    assert_eq!(backend.calls(), 1);
    assert_eq!(cache.stats().hits, 1);
}

/// Org B never reuses org A's cached score for the same text or image: the
/// keyed segment hash differs, so B's content is screened on its own.
#[tokio::test]
async fn probe_cache_is_never_shared_across_orgs() {
    let backend = Arc::new(TestBackend::new("guard_text"));
    let cache = Arc::new(SegmentCache::default());
    let chain = ScreenerChain::new(floor_policy(&[backend.as_ref()]))
        .with_role(Role::TextHazard, vec![backend.clone()])
        .with_cache(cache.clone());
    let wanted = CodeSet::hazards();
    let text = format!("shared {SENTINEL_HAZARD_S1}");
    for scope in [ORG_A, ORG_B] {
        let items = [text_item(scope, LeafClass::User, &text)];
        let v = chain
            .screen(
                Role::TextHazard,
                &request(
                    &items,
                    &wanted,
                    Direction::Inbound,
                    ScreenTier::Floor,
                    CHAT_MS,
                ),
            )
            .await;
        assert_eq!(v.outcomes[0].cache_hits, 0);
    }
    assert_eq!(backend.calls(), 2);

    let a = image_item(ORG_A, LeafClass::User, b"same-bytes");
    let b = image_item(ORG_B, LeafClass::User, b"same-bytes");
    assert_ne!(a.key, b.key);
}

/// A failure for org A (timeout, garbage) is never cached, so it cannot
/// poison the next request for the same segment.
#[tokio::test]
async fn probe_failed_answer_never_poisons_the_cache() {
    let failing = Arc::new(TestBackend::new("guard_text").fail_always(BackendError::Malformed));
    let cache = Arc::new(SegmentCache::default());
    let chain = ScreenerChain::new(floor_policy(&[failing.as_ref()]))
        .with_role(Role::TextHazard, vec![failing.clone()])
        .with_cache(cache.clone());
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S4)];
    let wanted = CodeSet::hazards();
    let _ = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                CHAT_MS,
            ),
        )
        .await;
    assert_eq!(cache.stats().entries, 0);

    // Same id and build, now healthy, sharing the cache: a miss, then decided.
    let healthy = Arc::new(TestBackend::new("guard_text"));
    let chain = ScreenerChain::new(floor_policy(&[healthy.as_ref()]))
        .with_role(Role::TextHazard, vec![healthy.clone()])
        .with_cache(cache.clone());
    let v = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                CHAT_MS,
            ),
        )
        .await;
    assert_eq!(healthy.calls(), 1);
    assert_eq!(v.items[0].score(TaxonomyId::S4), Some(1.0));
}

// ---------------------------------------------------------------------------
// Backend timeout, outage and garbage output
// ---------------------------------------------------------------------------

/// A guard engine that sleeps past the chat deadline: the chain returns
/// inside the budget with S4 and S9 undecided.
#[tokio::test]
async fn probe_engine_timeout_leaves_hard_codes_undecided_inside_the_budget() {
    let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
    mock.set(|b| b.delay = Some(Duration::from_secs(5)));
    let guard = Arc::new(guard_backend(&mock, GuardDialect::LlamaGuard, false));
    let chain = ScreenerChain::new(floor_policy(&[guard.as_ref()]))
        .with_role(Role::TextHazard, vec![guard.clone()]);
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S9)];
    let wanted = CodeSet::hazards();
    let started = Instant::now();
    let v = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                CHAT_MS,
            ),
        )
        .await;
    assert!(started.elapsed() < Duration::from_millis(1_500));
    assert_eq!(v.outcomes[0].error, Some(BackendError::Timeout));
    let undecided = v.undecided_hard(chain.policy());
    assert!(undecided.contains(TaxonomyId::S4) && undecided.contains(TaxonomyId::S9));
}

/// Engine outages (500, 503, a closed port) are `Unavailable`, never Allow.
#[tokio::test]
async fn probe_engine_outage_is_unavailable_for_every_wire() {
    for status in [500u16, 503] {
        let guard_mock = MockServer::guard(GuardDialect::LlamaGuard).await;
        guard_mock.set(|b| b.status = Some(status));
        let decision_mock = MockServer::systemone().await;
        decision_mock.set(|b| b.status = Some(status));
        let guard = Arc::new(guard_backend(&guard_mock, GuardDialect::LlamaGuard, false));
        let decision = Arc::new(
            DecisionBackend::local(
                decision_config(&decision_mock.base_url, "decision_local"),
                Locality::Loopback,
            )
            .expect("local decision"),
        );
        let chain = ScreenerChain::new(floor_policy(&[guard.as_ref(), decision.as_ref()]))
            .with_role(Role::TextHazard, vec![guard.clone(), decision.clone()]);
        let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S4)];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(
                Role::TextHazard,
                &request(
                    &items,
                    &wanted,
                    Direction::Inbound,
                    ScreenTier::Floor,
                    CHAT_MS,
                ),
            )
            .await;
        for outcome in &v.outcomes {
            assert!(
                matches!(outcome.error, Some(BackendError::Unavailable(_))),
                "{status}: {outcome:?}"
            );
        }
        assert_eq!(v.undecided(), wanted, "{status}");
    }

    let closed = DecisionBackend::local(
        decision_config("http://127.0.0.1:9/v1/systemone", "decision_local"),
        Locality::Loopback,
    )
    .expect("local decision");
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S4)];
    let wanted = CodeSet::hazards();
    let err = closed
        .screen(&request(
            &items,
            &wanted,
            Direction::Inbound,
            ScreenTier::Floor,
            CHAT_MS,
        ))
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        BackendError::Unavailable(_) | BackendError::Timeout
    ));
}

/// Garbage bodies on a 200 (not JSON, wrong shape, empty answers) are
/// `Malformed` on both wires and decide nothing.
#[tokio::test]
async fn probe_garbage_bodies_are_malformed_on_both_wires() {
    let wanted = CodeSet::hazards();
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S9)];
    for raw in [
        "<html>oops</html>",
        "{}",
        r#"{"choices": []}"#,
        r#"{"choices": [{"message": {"content": 7}}]}"#,
        r#"{"choices": [{"message": {"content": "I cannot help with that."}}]}"#,
    ] {
        let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
        mock.set(|b| b.raw_body = Some(raw.to_string()));
        let guard = guard_backend(&mock, GuardDialect::LlamaGuard, false);
        let err = guard
            .screen(&request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                CHAT_MS,
            ))
            .await
            .unwrap_err();
        assert_eq!(err, BackendError::Malformed, "{raw}");
    }
    for raw in [
        "not json",
        "{}",
        r#"{"answers": {}}"#,
        r#"{"answers": {"s4": {"choice": "no"}}}"#,
    ] {
        let mock = MockServer::systemone().await;
        mock.set(|b| b.raw_body = Some(raw.to_string()));
        let local = DecisionBackend::local(
            decision_config(&mock.base_url, "decision_local"),
            Locality::Loopback,
        )
        .expect("local decision");
        let err = local
            .screen(&request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                CHAT_MS,
            ))
            .await
            .unwrap_err();
        assert_eq!(err, BackendError::Malformed, "{raw}");
    }
}

/// A Llama Guard reply of `unsafe\nS9` whose first-token logprobs say `safe`
/// with certainty is inconsistent output. It must not score the listed code
/// as 0 (which reads as a confident allow); it is `Malformed` or falls back
/// to the fixed unsafe confidence.
#[test]
fn probe_llama_guard_unsafe_reply_with_contradicting_logprobs_never_scores_zero() {
    let logprobs = json!({"content": [{
        "token": "safe",
        "logprob": 0.0,
        "top_logprobs": [{"token": "safe", "logprob": 0.0}],
    }]});
    match parse_llama_guard("unsafe\nS9", Some(&logprobs)) {
        Err(BackendError::Malformed) => {}
        Ok(answer) => {
            let s9 = answer
                .scores
                .iter()
                .find_map(|(c, s)| (*c == TaxonomyId::S9).then_some(*s))
                .unwrap();
            assert!(s9 >= 0.5, "listed S9 scored {s9} on an unsafe reply");
        }
        Err(other) => panic!("unexpected {other:?}"),
    }
}

/// Two contradictory `Safety:` lines are outside the closed grammar.
#[test]
fn probe_qwen3guard_contradictory_safety_lines_are_malformed() {
    let reply = "Safety: Safe\nCategories: None\nSafety: Unsafe\nCategories: Violent";
    assert_eq!(
        parse_qwen3guard(reply, None).unwrap_err(),
        BackendError::Malformed
    );
}

/// `Safe` carrying a hazard category is contradictory, as `safe` with codes
/// is for Llama Guard.
#[test]
fn probe_qwen3guard_safe_with_a_category_is_malformed() {
    assert_eq!(
        parse_qwen3guard("Safety: Safe\nCategories: Violent", None).unwrap_err(),
        BackendError::Malformed
    );
}

// ---------------------------------------------------------------------------
// Remote Jev without a retention record
// ---------------------------------------------------------------------------

/// Fleet floor traffic with Jev as the only text-hazard backend and no
/// `remoteProcessors` record: Jev is never contacted, nothing is attributed
/// to the processor and every code stays undecided.
#[tokio::test]
async fn probe_jev_without_record_is_absent_on_floor_traffic() {
    let mock = MockServer::systemone().await;
    let permit = RemotePermit::new();
    let remote = Arc::new(jev(&mock, permit.clone()));
    let chain = ScreenerChain::new(floor_policy(&[remote.as_ref()]))
        .with_role(Role::TextHazard, vec![remote.clone()]);
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S9)];
    let wanted = CodeSet::hazards();
    let v = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                MEDIA_MS,
            ),
        )
        .await;
    assert_eq!(mock.calls(), 0);
    assert!(v.processors.is_empty());
    assert_eq!(v.outcomes[0].items_sent, 0);
    assert_eq!(v.outcomes[0].error, Some(BackendError::NotPermitted));
    assert_eq!(v.undecided(), wanted);
}

/// With the primary local decision model healthy, Jev (even permitted) is
/// never called: a third party sees nothing a local backend decided.
#[tokio::test]
async fn probe_jev_is_fallback_only_behind_the_local_decision_model() {
    let local_mock = MockServer::systemone().await;
    let jev_mock = MockServer::systemone().await;
    let local = Arc::new(
        DecisionBackend::local(
            decision_config(&local_mock.base_url, "decision_local"),
            Locality::Loopback,
        )
        .expect("local decision"),
    );
    let permit = RemotePermit::new();
    permit.set_floor_record(true);
    let remote = Arc::new(jev(&jev_mock, permit));
    let chain = ScreenerChain::new(floor_policy(&[local.as_ref(), remote.as_ref()]))
        .with_role(Role::TextHazard, vec![remote.clone(), local.clone()]);
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S4)];
    let wanted = CodeSet::hazards();
    let v = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                CHAT_MS,
            ),
        )
        .await;
    assert_eq!(local_mock.calls(), 1);
    assert_eq!(jev_mock.calls(), 0);
    assert!(v.processors.is_empty());
    assert!(v.undecided_hard(chain.policy()).is_empty());
}

/// A score Jev returned for node-tier traffic (operator opt-in) is cached
/// before the permit is checked, so a floor-tier request for the same segment
/// with no `remoteProcessors` record still takes Jev's scores. Jev without a
/// record must be treated as absent on floor traffic, cache included.
#[tokio::test]
async fn probe_jev_cached_node_scores_never_decide_unpermitted_floor_traffic() {
    let mock = MockServer::systemone().await;
    let permit = RemotePermit::new();
    permit.set_node_opt_in(true);
    let remote = Arc::new(jev(&mock, permit.clone()));
    let cache = Arc::new(SegmentCache::default());
    let chain = ScreenerChain::new(ChainPolicy::default())
        .with_role(Role::TextHazard, vec![remote.clone()])
        .with_cache(cache.clone());
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S1)];
    let wanted = CodeSet::hazards();
    let node = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Node,
                MEDIA_MS,
            ),
        )
        .await;
    assert_eq!(mock.calls(), 1);
    assert!(node.items[0].decided.contains(TaxonomyId::S1));

    let floor = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Floor,
                MEDIA_MS,
            ),
        )
        .await;
    assert_eq!(mock.calls(), 1, "no new content reached Jev");
    assert_eq!(
        floor.outcomes[0].cache_hits, 0,
        "an unpermitted processor's cached score was served to floor traffic"
    );
    assert!(
        floor.items[0].decided.is_empty(),
        "Jev decided {:?} on floor traffic without a record",
        floor.items[0].decided
    );
}

// ---------------------------------------------------------------------------
// Self-hosted custody (node tier)
// ---------------------------------------------------------------------------

/// A self-hosted node operator's own opt-in classifier is never bound by
/// Ryu's floor: with a node policy that names no hard codes and holds no Ryu
/// qualification, the node's backend still decides S4 from its own score.
#[tokio::test]
async fn probe_self_hosted_node_classifier_is_not_bound_by_floor_qualification() {
    let backend = Arc::new(TestBackend::new("node_guard"));
    let node_policy = ChainPolicy {
        hard_codes: CodeSet::new(),
        qualifications: Vec::new(),
        ..ChainPolicy::default()
    };
    let chain = ScreenerChain::new(node_policy).with_role(Role::TextHazard, vec![backend.clone()]);
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S4)];
    let wanted = CodeSet::hazards();
    let v = chain
        .screen(
            Role::TextHazard,
            &request(
                &items,
                &wanted,
                Direction::Inbound,
                ScreenTier::Node,
                CHAT_MS,
            ),
        )
        .await;
    assert_eq!(backend.calls(), 1);
    assert_eq!(
        v.items[0].score(TaxonomyId::S4),
        Some(1.0),
        "node classifier's S4 score was withheld for lack of a Ryu qualification: {:?}",
        v.items[0].unqualified_scores
    );
    assert!(v.items[0].decided.contains(TaxonomyId::S4));
}

/// Node tier with operator opt-in reaches Jev; floor tier with only the
/// operator opt-in does not.
#[tokio::test]
async fn probe_node_opt_in_reaches_jev_only_for_node_tier() {
    let mock = MockServer::systemone().await;
    let permit = RemotePermit::new();
    permit.set_node_opt_in(true);
    let remote = jev(&mock, permit);
    let items = [text_item(ORG_A, LeafClass::User, SENTINEL_HAZARD_S9)];
    let wanted = CodeSet::hazards();
    let err = remote
        .screen(&request(
            &items,
            &wanted,
            Direction::Inbound,
            ScreenTier::Floor,
            MEDIA_MS,
        ))
        .await
        .unwrap_err();
    assert_eq!(err, BackendError::NotPermitted);
    assert_eq!(mock.calls(), 0);
    let ok = remote
        .screen(&request(
            &items,
            &wanted,
            Direction::Inbound,
            ScreenTier::Node,
            MEDIA_MS,
        ))
        .await
        .expect("node tier permitted");
    assert_eq!(mock.calls(), 1);
    assert!(ok.items[0].score(TaxonomyId::S9).unwrap() >= 0.9);
}

// ---------------------------------------------------------------------------
// Qualification pinning for the primary decision model
// ---------------------------------------------------------------------------

/// Qualification pins model, weights and template (section 5.3), so the
/// primary local decision model must carry a weights hash. It has none, so a
/// record can match it only with `weightsSha256` absent, which pins nothing:
/// swapping the weights behind the endpoint keeps hard-code authority and
/// reuses cached scores.
#[test]
fn probe_local_decision_model_pins_its_weights() {
    let local = DecisionBackend::local(
        decision_config("http://127.0.0.1:11435/v1/systemone", "decision_local"),
        Locality::Loopback,
    )
    .expect("local decision");
    let reference = &local.descriptor().reference;
    assert!(
        reference.weights_sha256.is_some(),
        "decision_local has no weights hash; cache scope {} and any qualification cannot pin the model build",
        reference.cache_scope()
    );
}

// ---------------------------------------------------------------------------
// Taxonomy (G2)
// ---------------------------------------------------------------------------

/// Every vendor mapping target is a taxonomy code, and only the Llama Guard
/// and OpenAI `sexual/minors` mappings can source S4.
#[test]
fn probe_vendor_mappings_target_known_codes_and_s4_sources_are_narrow() {
    let tax = ryu_gw_firewall::taxonomy::taxonomy();
    for vendor in [
        "llama_guard",
        "qwen3guard",
        "shieldgemma",
        "openai_moderation",
        "inspector",
    ] {
        let mapping: Vec<_> = tax
            .vendor_mapping(vendor)
            .unwrap_or_else(|| panic!("missing vendor {vendor}"))
            .collect();
        assert!(!mapping.is_empty(), "{vendor}");
        for (label, codes) in mapping {
            assert!(!codes.is_empty(), "{vendor}:{label}");
            for code in codes {
                assert!(tax.code(*code).is_some(), "{vendor}:{label} -> {code}");
                if *code == TaxonomyId::S4 {
                    assert!(
                        (vendor == "llama_guard" && label == "S4")
                            || (vendor == "openai_moderation" && label == "sexual/minors"),
                        "{vendor}:{label} sources S4"
                    );
                }
            }
        }
    }
    assert!(!GuardDialect::Qwen3Guard.covers().contains(TaxonomyId::S4));
    assert!(tax.code(TaxonomyId::S4).unwrap().hard_block);
}

/// The firewall's new detection kinds carry taxonomy ids.
#[test]
fn probe_detection_kinds_for_hazards_and_prompt_attacks() {
    use ryu_gw_firewall::DetectionKind;
    let hazard = DetectionKind::Hazard(TaxonomyId::S9);
    assert_eq!(hazard.as_str(), "hazard.S9");
    assert_eq!(DetectionKind::PromptAttack.as_str(), "prompt_attack");
}
