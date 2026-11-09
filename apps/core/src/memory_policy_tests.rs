use super::*;

#[test]
fn defaults_reproduce_pre_policy_behaviour() {
    let p = MemoryPolicy::default();
    assert!(p.should_auto_recall(true));
    assert!(p.should_write(true));
    assert!(!p.include_sensitive_topics);
    assert_eq!(p.recall_budget.long_term_limit(), DEFAULT_LONG_TERM_LIMIT);
}

#[test]
fn per_user_sensitive_consent_is_an_explicit_overlay() {
    let policy = MemoryPolicy::default().with_sensitive_topics(true);
    assert!(policy.include_sensitive_topics);
    assert_eq!(
        MemoryPolicy::default().with_sensitive_topics(false),
        MemoryPolicy::default()
    );
}

#[test]
fn absent_or_garbled_preferences_fall_back_to_the_defaults() {
    assert_eq!(
        MemoryPolicy::from_raw(None, None, None),
        MemoryPolicy::default()
    );
    // A typo must not silently disable someone's memory.
    let p = MemoryPolicy::from_raw(Some("of"), Some("huge"), Some("newer"));
    assert_eq!(p, MemoryPolicy::default());
}

#[test]
fn the_request_opt_in_can_only_be_narrowed_never_widened() {
    // Privacy-by-default: no preference turns memory on for a caller that did
    // not ask for it.
    for mode in ["off", "manual", "auto"] {
        for freq in ["never", "per_turn", "reviewed"] {
            let p = MemoryPolicy::from_raw(Some(mode), None, Some(freq));
            assert!(!p.should_auto_recall(false), "{mode} widened recall");
            assert!(!p.should_write(false), "{freq} widened writes");
        }
    }
}

#[test]
fn recall_off_stops_automatic_injection_but_write_is_independent() {
    let p = MemoryPolicy::from_raw(Some("off"), None, None);
    assert!(!p.should_auto_recall(true));
    // "Stop reading my memory" is not "stop recording" — they are separate knobs.
    assert!(p.should_write(true));
}

#[test]
fn manual_mode_also_stops_automatic_injection() {
    // Manual differs from Off in intent (tools stay useful) but both must stop
    // the un-asked-for injection; a reader that only special-cased Off would
    // leak memory into every prompt in manual mode.
    let p = MemoryPolicy::from_raw(Some("manual"), None, None);
    assert!(!p.should_auto_recall(true));
}

#[test]
fn write_never_stops_capture_while_recall_keeps_working() {
    let p = MemoryPolicy::from_raw(None, None, Some("never"));
    assert!(!p.should_write(true));
    assert!(p.should_auto_recall(true));
}

#[test]
fn reviewed_stores_no_raw_turns_and_leaves_recall_alone() {
    let p = MemoryPolicy::from_raw(None, None, Some("reviewed"));
    assert_eq!(p.write_frequency, WriteFrequency::Reviewed);
    assert!(!p.should_write(true));
    assert!(p.should_auto_recall(true));
    assert_eq!(WriteFrequency::default(), WriteFrequency::PerTurn);
}

#[test]
fn temporary_context_requires_the_explicit_flag() {
    assert!(!MemoryPolicy::temporary_context_enabled(false, false));
    assert!(MemoryPolicy::temporary_context_enabled(false, true));
    assert!(!MemoryPolicy::temporary_context_enabled(true, true));
    assert!(!MemoryPolicy::context_enabled(true, false, false));
    assert!(MemoryPolicy::context_enabled(true, false, true));
    assert!(MemoryPolicy::context_enabled(true, true, false));
    assert!(!MemoryPolicy::context_enabled(false, true, false));
}

#[test]
fn budget_maps_to_distinct_ascending_limits() {
    assert!(
        RecallBudget::Low.long_term_limit() < RecallBudget::Mid.long_term_limit()
            && RecallBudget::Mid.long_term_limit() < RecallBudget::High.long_term_limit()
    );
}

#[test]
fn char_budget_scales_with_the_recall_budget() {
    assert_eq!(RecallBudget::Low.char_budget(), 1_000);
    assert_eq!(RecallBudget::Mid.char_budget(), 2_500);
    assert_eq!(RecallBudget::High.char_budget(), 6_000);
    assert_eq!(
        MemoryPolicy::default().recall_budget.char_budget(),
        RecallBudget::Mid.char_budget()
    );
}

#[test]
fn the_external_bridges_have_deliberate_and_asymmetric_defaults() {
    let p = MemoryPolicy::default();
    // Mirroring on: having chosen an external provider, a built-in write that
    // never reaches it is the surprising outcome.
    assert!(p.mirror_builtin);
    // Sync off: raw turns leaving the node must be asked for.
    assert!(!p.sync_turns);
    // Context off: it spends prompt space on EVERY turn.
    assert!(!p.provider_context);
}

#[test]
fn a_garbled_toggle_keeps_its_default_rather_than_flipping() {
    assert!(MemoryPolicy::parse_flag(Some("yes"), true));
    assert!(!MemoryPolicy::parse_flag(Some("yes"), false));
    assert!(MemoryPolicy::parse_flag(None, true));
    // Only the exact stored spellings move a bridge.
    assert!(!MemoryPolicy::parse_flag(Some("false"), true));
    assert!(MemoryPolicy::parse_flag(Some("true"), false));
}

#[test]
fn from_raw_leaves_the_bridge_toggles_at_their_defaults() {
    // `from_raw` covers only the three recall/write knobs; the bridges are read
    // separately in `load`. If it ever zeroed them, mirroring would silently turn
    // itself off for every caller of this constructor.
    let p = MemoryPolicy::from_raw(Some("off"), Some("high"), Some("never"));
    assert_eq!(p.mirror_builtin, MemoryPolicy::default().mirror_builtin);
    assert_eq!(p.sync_turns, MemoryPolicy::default().sync_turns);
    assert_eq!(p.provider_context, MemoryPolicy::default().provider_context);
}

#[test]
fn recall_min_relevance_defaults_off_and_matches_the_retrieval_default() {
    assert_eq!(
        MemoryPolicy::default().recall_min_relevance,
        RecallMinRelevance::Off
    );
    assert_eq!(
        RecallMinRelevance::Off.min_score(),
        ryu_rag::RetrievalOptions::default().min_score,
        "Off must reproduce the unfiltered retrieval default"
    );
    for raw in [None, Some(""), Some("strict"), Some("0.5"), Some("off")] {
        assert_eq!(RecallMinRelevance::from_pref(raw), RecallMinRelevance::Off);
    }
}

#[test]
fn recall_min_relevance_levels_parse_and_ascend() {
    assert_eq!(
        RecallMinRelevance::from_pref(Some(" low ")),
        RecallMinRelevance::Low
    );
    assert_eq!(
        RecallMinRelevance::from_pref(Some("medium")),
        RecallMinRelevance::Medium
    );
    assert_eq!(
        RecallMinRelevance::from_pref(Some("high")),
        RecallMinRelevance::High
    );
    let scores = [
        RecallMinRelevance::Off,
        RecallMinRelevance::Low,
        RecallMinRelevance::Medium,
        RecallMinRelevance::High,
    ]
    .map(RecallMinRelevance::min_score);
    assert!(scores.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(scores.iter().all(|score| (0.0..1.0).contains(score)));
}

#[test]
fn recall_levels_sit_above_the_embedders_unrelated_baseline() {
    let close = |a: f32, b: f32| (a - b).abs() < 1e-6;
    // A hosted embedder that scores unrelated text at 0.6 needs a higher cut
    // than the raw level, or Low would keep everything.
    assert!(close(RecallMinRelevance::Low.min_score_above(0.6), 0.68));
    assert!(close(RecallMinRelevance::Medium.min_score_above(0.6), 0.74));
    assert!(close(RecallMinRelevance::High.min_score_above(0.6), 0.8));
    // A zero baseline reproduces the raw levels.
    for level in [
        RecallMinRelevance::Low,
        RecallMinRelevance::Medium,
        RecallMinRelevance::High,
    ] {
        assert!(close(level.min_score_above(0.0), level.min_score()));
        assert!(level.min_score_above(0.6) > 0.6);
    }
    // Off never filters; a broken or out-of-range baseline cannot push a level
    // past what any match can reach.
    assert_eq!(RecallMinRelevance::Off.min_score_above(0.6), 0.0);
    assert!(close(
        RecallMinRelevance::Low.min_score_above(f32::NAN),
        RecallMinRelevance::Low.min_score()
    ));
    assert!(close(RecallMinRelevance::Low.min_score_above(-3.0), 0.2));
    assert!(RecallMinRelevance::High.min_score_above(5.0) < 1.0);
}

fn retrieval_with(embedder: ryu_rag::Embedder) -> ryu_rag::RetrievalStore {
    ryu_rag::RetrievalStore::open_in_memory_with_embedder(
        embedder,
        crate::registry::DEFAULT_RERANKER_MODEL.to_owned(),
    )
    .unwrap()
}

#[tokio::test]
async fn the_calibrated_floor_uses_the_local_baseline_and_fails_open() {
    let local = retrieval_with(ryu_rag::Embedder::Local {
        dims: crate::registry::DEFAULT_EMBED_DIMS,
    });
    assert_eq!(
        RecallMinRelevance::Medium
            .calibrated_min_score(&local)
            .await,
        RecallMinRelevance::Medium.min_score()
    );

    let unreachable = retrieval_with(ryu_rag::Embedder::remote(
        "http://127.0.0.1:1",
        "recall-floor-unreachable",
        8,
        None,
    ));
    assert_eq!(
        RecallMinRelevance::Off
            .calibrated_min_score(&unreachable)
            .await,
        0.0
    );
    assert_eq!(
        RecallMinRelevance::High
            .calibrated_min_score(&unreachable)
            .await,
        0.0,
        "an embedder that cannot be measured must not hide memories"
    );
}
