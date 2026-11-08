//! Routing-table precedence, modality slots, fallback chains and A/B picks.

use super::*;

/// Resolve which provider a builtin prefix maps to, for the index/identity
/// assertions that behavior alone cannot make.

/// The positional twin of `builtin_prefix_order_puts_classify_gemma_before_local_gemma`,
/// for the one new row that shares a prefix with an existing one. Asserted by
/// INDEX, not just by behavior: an alphabetical tidy-up of the table would put
/// `mistral` above `mistral.` while every behavioral assertion elsewhere still
/// looked reasonable, and Bedrock's Mistral models would silently be asked of
/// the resident local engine.
#[test]
fn builtin_prefix_order_puts_bedrock_mistral_before_local_mistral() {
    let prefixes = builtin_prefixes();
    let idx = |p: &str| {
        prefixes
            .iter()
            .position(|(prefix, _)| prefix == p)
            .unwrap_or_else(|| panic!("builtin prefix {p} missing"))
    };
    assert!(
        idx("mistral.") < idx("mistral"),
        "mistral.→bedrock must precede mistral→local; route() is first-match, not longest-match"
    );
}

/// Regression guard for the ids that already routed before the pool rows were
/// added. The new prefixes are all anchored at position 0, so none of these
/// can be captured — but "added a broad prefix, silently re-homed the local
/// engine" is exactly the failure this table invites.
#[test]
fn pool_prefixes_do_not_capture_existing_routes() {
    let t = bare("openai");
    assert_eq!(t.route("llama3.2:latest").0, "local");
    assert_eq!(t.route("mistral:latest").0, "local");
    assert_eq!(t.route("mixtral-8x7b").0, "local");
    assert_eq!(t.route("claude-sonnet-4-5").0, "anthropic");
    assert_eq!(t.route("gpt-4o").0, "openai");
    assert_eq!(t.route("o3-mini").0, "openai");
    assert_eq!(t.route("gemini-1.5-pro").0, "genai");
    assert_eq!(t.route("mistral.mistral-large-2407-v1:0").0, "bedrock");
    assert_eq!(t.route("gemma-3-270m-it-qat-Q4_0").0, "classify");
    assert_eq!(
        t.route("openrouter/mistralai/mistral-7b-instruct").0,
        "openrouter"
    );
    // Still the default: nothing about the new rows makes an unknown id pooled.
    assert_eq!(t.route("some-unknown-model").0, "openai");
}

#[test]
fn exact_map_and_longest_prefix_win_over_builtin() {
    let mut model_map = HashMap::new();
    model_map.insert(
        "gpt-4o".to_string(),
        ("local".to_string(), Some("gemma".to_string())),
    );
    model_map.insert("gpt-".to_string(), ("openrouter".to_string(), None));
    let t = tables(
        model_map,
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        Vec::new(),
        0.0,
        "openai",
    );
    // Exact hit rewrites the model and wins over the builtin gpt-→openai.
    assert_eq!(
        t.route("gpt-4o"),
        ("local".to_string(), "gemma".to_string())
    );
    // Longest user prefix ("gpt-") wins over builtin for a non-exact model.
    assert_eq!(
        t.route("gpt-4-turbo"),
        ("openrouter".to_string(), "gpt-4-turbo".to_string())
    );
}

#[test]
fn default_provider_when_nothing_matches() {
    let t = bare("local");
    assert_eq!(
        t.route("some-unknown-model"),
        ("local".to_string(), "some-unknown-model".to_string())
    );
}

#[test]
fn route_modality_slot_then_map_then_fallback() {
    let mut modality_map = HashMap::new();
    modality_map.insert(
        "image".to_string(),
        ("openai".to_string(), Some("dall-e-3".to_string())),
    );
    let t = tables(
        HashMap::new(),
        modality_map,
        Vec::new(),
        HashMap::new(),
        Vec::new(),
        0.0,
        "local",
    );
    // Slot override wins.
    assert_eq!(
        t.route_modality("image", "x", Some("fal"), Some("flux")),
        ("fal".to_string(), "flux".to_string())
    );
    // Then the modality map (pinned model wins over caller model).
    assert_eq!(
        t.route_modality("image", "whatever", None, None),
        ("openai".to_string(), "dall-e-3".to_string())
    );
    // No entry ⇒ fall through to model routing (gpt-→openai builtin).
    assert_eq!(t.route_modality("tts", "gpt-4o", None, None).0, "openai");
}

#[test]
fn fallback_chain_pins_primary_then_sorts_by_tier() {
    let mut tiers = HashMap::new();
    tiers.insert("openai".to_string(), 0u8);
    tiers.insert("local".to_string(), 1u8);
    tiers.insert("openrouter".to_string(), 2u8);
    let t = tables(
        HashMap::new(),
        HashMap::new(),
        vec![
            "openrouter".to_string(),
            "local".to_string(),
            "openai".to_string(),
        ],
        tiers,
        Vec::new(),
        0.0,
        "openai",
    );
    // Primary stays first even though it is the most expensive tier.
    assert_eq!(
        t.fallback_chain("openrouter"),
        vec![
            "openrouter".to_string(),
            "openai".to_string(),
            "local".to_string()
        ]
    );
}

#[test]
fn fallback_chain_empty_tiers_preserves_order() {
    let t = tables(
        HashMap::new(),
        HashMap::new(),
        vec!["local".to_string(), "openai".to_string()],
        HashMap::new(),
        Vec::new(),
        0.0,
        "openai",
    );
    assert_eq!(
        t.fallback_chain("anthropic"),
        vec![
            "anthropic".to_string(),
            "local".to_string(),
            "openai".to_string()
        ]
    );
}

fn ab_tables(explore_ratio: f32) -> RoutingTables {
    tables(
        HashMap::new(),
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        vec!["openai".to_string(), "anthropic".to_string()],
        explore_ratio,
        "openai",
    )
}

#[test]
fn eval_route_none_when_under_two_candidates() {
    let t = bare("openai");
    assert!(t.eval_route("gpt-4o", &|_| Some(0.5), &|| 0).is_none());
}

#[test]
fn eval_route_explores_unscored_candidate_first() {
    let t = ab_tables(0.0);
    let provider = t
        .eval_route(
            "gpt-4o",
            &|p| if p == "openai" { Some(0.9) } else { None },
            &|| 0,
        )
        .expect("eval routing active");
    assert_eq!(provider, "anthropic");
}

#[test]
fn eval_route_exploits_leader_when_all_scored() {
    let t = ab_tables(0.0);
    for _ in 0..20 {
        let provider = t
            .eval_route(
                "gpt-4o",
                &|p| match p {
                    "openai" => Some(0.3),
                    "anthropic" => Some(0.8),
                    _ => None,
                },
                &|| 0,
            )
            .expect("eval routing active");
        assert_eq!(provider, "anthropic");
    }
}

#[test]
fn eval_route_reserves_traffic_for_exploration() {
    let t = ab_tables(0.25);
    let counter = std::sync::atomic::AtomicU64::new(0);
    let mut leader_hits = 0;
    let mut explore_hits = 0;
    for _ in 0..100 {
        let provider = t
            .eval_route(
                "gpt-4o",
                &|p| match p {
                    "openai" => Some(0.3),
                    "anthropic" => Some(0.8),
                    _ => None,
                },
                &|| counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            )
            .expect("eval routing active");
        if provider == "anthropic" {
            leader_hits += 1;
        } else {
            explore_hits += 1;
        }
    }
    assert!(explore_hits > 0, "expected some exploration traffic");
    assert!(leader_hits > explore_hits, "leader should win most traffic");
}

#[test]
fn the_tables_module_routes_an_unmatched_model_to_the_default() {
    let tables: crate::tables::RoutingTables = bare("azure-credits");
    assert_eq!(tables.route("my-deployment").0, "azure-credits");
}
