use super::*;

fn row(id: &str, slot: &str, upstream: &str, priority: i64) -> OwnSupplyRow {
    OwnSupplyRow {
        id: id.to_owned(),
        slot: slot.to_owned(),
        upstream: upstream.to_owned(),
        priority,
        canary_required: false,
        user_price: Some(OwnSupplyPrice::flat(1, 2)),
        supplier_cost: None,
        paid_rollout_bps: 0,
    }
}

#[test]
fn paid_rollout_admits_only_priced_rows_below_the_dial() {
    let mut priced = row("a/b", "anthropic-credits", "b", 0);
    assert!(!priced.admits_paid(0), "the default dial admits nobody");
    priced.paid_rollout_bps = 2_500;
    assert!(priced.admits_paid(0));
    assert!(priced.admits_paid(2_499));
    assert!(!priced.admits_paid(2_500));
    priced.paid_rollout_bps = u16::MAX;
    assert!(priced.admits_paid(9_999), "an oversized dial means all");
    let mut unpriced = priced.clone();
    unpriced.user_price = None;
    assert!(
        !unpriced.admits_paid(0),
        "a seed row never takes paid traffic"
    );
    let mut free = priced.clone();
    free.user_price = Some(OwnSupplyPrice::flat(0, 0));
    assert!(
        !free.admits_paid(0),
        "a zero price would serve paid traffic for nothing"
    );
}

#[test]
fn cache_legs_are_priced_at_their_own_rates() {
    // Claude Sonnet 4.5 on OpenRouter: $3/M prompt, $15/M completion,
    // $0.30/M cache read, $3.75/M cache write.
    let price = OwnSupplyPrice {
        in_per_1k_micro_usd: 3_000,
        out_per_1k_micro_usd: 15_000,
        cache_read_per_1k_micro_usd: Some(300),
        cache_write_per_1k_micro_usd: Some(3_750),
    };
    let legs = |read: u64, write: u64, write_1h: u64| CacheTokens {
        read,
        write,
        write_1h,
    };
    // 100k cache read + 1k fresh prompt (prompt_tokens = 101k) + 500 out.
    assert_eq!(
        price.cost_with_cache(101_000, 500, legs(100_000, 0, 0)),
        30_000 + 3_000 + 7_500
    );
    // Cache writes carry their premium.
    assert_eq!(price.cost_with_cache(10_000, 0, legs(0, 10_000, 0)), 37_500);
    // No cache counts: the flat price.
    assert_eq!(
        price.cost_with_cache(1_000, 1_000, CacheTokens::default()),
        price.cost(1_000, 1_000)
    );
    // Cache counts above the prompt are clamped, never underflow.
    assert_eq!(price.cost_with_cache(100, 0, legs(500, 500, 900)), 30);
    // A price without cache rates bills cache legs at the prompt price.
    assert_eq!(
        OwnSupplyPrice::flat(3_000, 15_000).cost_with_cache(101_000, 500, legs(100_000, 0, 0)),
        303_000 + 7_500
    );
}

#[test]
fn one_hour_cache_writes_are_billed_at_twice_the_prompt_price() {
    // Sonnet 4.5: a 100k one-hour write costs $0.60 at Anthropic (2x of
    // $3/M), not the catalog's five-minute $0.375.
    let price = OwnSupplyPrice {
        in_per_1k_micro_usd: 3_000,
        out_per_1k_micro_usd: 15_000,
        cache_read_per_1k_micro_usd: Some(300),
        cache_write_per_1k_micro_usd: Some(3_750),
    };
    let one_hour = CacheTokens {
        read: 0,
        write: 100_000,
        write_1h: 100_000,
    };
    assert_eq!(price.cost_with_cache(100_000, 0, one_hour), 600_000);
    // A split write: 40k five-minute, 60k one-hour.
    let split = CacheTokens {
        write_1h: 60_000,
        ..one_hour
    };
    assert_eq!(price.cost_with_cache(100_000, 0, split), 150_000 + 360_000);
    // A one-hour count larger than the writes is clamped to them.
    let overstated = CacheTokens {
        read: 0,
        write: 10,
        write_1h: 1_000,
    };
    assert_eq!(price.cost_with_cache(10, 0, overstated), 60);
}

#[test]
fn rollout_buckets_are_stable_bounded_and_spread() {
    const PINNED_BUCKET: u16 = 8_708;
    // Pinned: a changed hash would silently move every org's cohort.
    assert_eq!(
        rollout_bucket("org_1", "anthropic/claude-sonnet-4.5"),
        PINNED_BUCKET
    );
    assert_eq!(
        rollout_bucket("org_1", "Anthropic/Claude-Sonnet-4.5"),
        PINNED_BUCKET
    );
    let buckets: Vec<u16> = (0..2_000)
        .map(|i| rollout_bucket(&format!("org_{i}"), "openai/gpt-5"))
        .collect();
    assert!(buckets.iter().all(|b| *b < PAID_ROLLOUT_ALL_BPS));
    let below_half = buckets.iter().filter(|b| **b < 5_000).count();
    assert!(
        (800..1_200).contains(&below_half),
        "{below_half} of 2000 under 50%"
    );
}

#[test]
fn the_wire_shape_defaults_the_dial_to_zero() {
    let parsed: OwnSupplyRow = serde_json::from_value(serde_json::json!({
        "id": "a/b", "slot": "bedrock", "upstream": "b"
    }))
    .unwrap();
    assert_eq!(parsed.paid_rollout_bps, 0);
    let parsed: OwnSupplyRow = serde_json::from_value(serde_json::json!({
        "id": "a/b", "slot": "bedrock", "upstream": "b", "paidRolloutBps": 500
    }))
    .unwrap();
    assert_eq!(parsed.paid_rollout_bps, 500);
}

#[test]
fn the_seed_table_answers_like_the_seed_functions() {
    let seed = OwnSupplyTable::seed();
    for (id, slot, upstream) in crate::SEED_OWN_SUPPLY_EQUIVALENTS {
        assert_eq!(
            seed.equivalents(id)
                .map(|r| (r.slot.as_str(), r.upstream.as_str()))
                .collect::<Vec<_>>(),
            crate::pool_model_equivalents(id).collect::<Vec<_>>(),
            "{id}"
        );
        assert_eq!(seed.equivalent_id(slot, upstream), Some(*id));
    }
    // Case-insensitive, slot-keyed, and the delisted Claude 3.5 row is gone.
    assert_eq!(
        seed.equivalents("Anthropic/Claude-Sonnet-4.5")
            .next()
            .map(|r| r.upstream.as_str()),
        Some("claude-sonnet-4-5")
    );
    assert_eq!(seed.equivalent_id("anthropic", "claude-sonnet-4-5"), None);
    assert_eq!(seed.equivalent_id("openai", "o3"), None);
    assert_eq!(seed.equivalents("anthropic/claude-3.5-sonnet").next(), None);
    // No seed row reaches the retired Bedrock pool.
    assert!(seed.row("bedrock", "amazon.nova-pro-v1:0").is_none());
    assert!(
        !seed
            .row("anthropic-credits", "claude-opus-4-5")
            .unwrap()
            .canary_required
    );
}

#[test]
fn seed_pool_defaults_follow_the_standard_alias() {
    let seed = OwnSupplyTable::seed();
    let default = |pool: &str| {
        seed.pool_default(pool, |slot| slot == pool)
            .map(|r| r.id.as_str())
    };
    assert_eq!(
        default("anthropic-credits"),
        Some("anthropic/claude-sonnet-4.5")
    );
    assert_eq!(default("openai-credits"), Some("openai/o3"));
    assert_eq!(
        default("cloudflare"),
        Some("meta-llama/llama-3.1-8b-instruct")
    );
    assert_eq!(default("vertex"), Some("google/gemini-2.5-flash"));
    assert_eq!(default("bedrock"), None);
    assert_eq!(default("openrouter"), None);
}

#[test]
fn a_published_table_is_ordered_deduplicated_and_priced() {
    let table = OwnSupplyTable::from_rows(
        7,
        vec![
            row("x/model", "bedrock", "b-up", 5),
            row("x/model", "cloudflare", "@cf/x/model", 1),
            // Same (slot, upstream) again: dropped.
            row("y/other", "cloudflare", "@CF/x/model", 0),
            // Same (id, slot) again: dropped.
            row("X/Model", "bedrock", "b-up-2", 9),
        ],
        HashMap::from([("bedrock".to_owned(), "X/MODEL".to_owned())]),
    );
    assert_eq!(table.version(), 7);
    assert_eq!(
        table
            .equivalents("x/model")
            .map(|r| r.slot.as_str())
            .collect::<Vec<_>>(),
        ["cloudflare", "bedrock"]
    );
    assert_eq!(table.equivalents("y/other").next(), None);
    assert_eq!(
        table.equivalent_id("cloudflare", "@cf/X/MODEL"),
        Some("x/model")
    );
    assert_eq!(
        table.price("bedrock", "b-up").map(|p| p.cost(2000, 1000)),
        Some(4)
    );
    assert_eq!(
        table
            .pool_default("bedrock", |slot| slot == "bedrock")
            .map(|r| r.upstream.as_str()),
        Some("b-up")
    );
    assert!(OwnSupplyTable::empty().is_empty());
}

#[test]
fn the_wire_row_parses_with_optional_fields() {
    let parsed: OwnSupplyRow = serde_json::from_value(serde_json::json!({
        "id": "openai/o3",
        "slot": "openai-credits",
        "upstream": "o3",
        "userPrice": {"inPer1kMicroUsd": 2000, "outPer1kMicroUsd": 8000}
    }))
    .unwrap();
    assert_eq!(parsed.priority, 0);
    assert!(!parsed.canary_required);
    assert_eq!(parsed.user_price.unwrap().out_per_1k_micro_usd, 8000);
    assert_eq!(parsed.user_price.unwrap().cache_read_per_1k_micro_usd, None);
    let cached: OwnSupplyRow = serde_json::from_value(serde_json::json!({
        "id": "anthropic/claude-sonnet-4.5",
        "slot": "anthropic-credits",
        "upstream": "claude-sonnet-4-5",
        "userPrice": {
            "inPer1kMicroUsd": 3000,
            "outPer1kMicroUsd": 15000,
            "cacheReadPer1kMicroUsd": 300,
            "cacheWritePer1kMicroUsd": 3750
        }
    }))
    .unwrap();
    let price = cached.user_price.unwrap();
    assert_eq!(price.cache_read_per_1k_micro_usd, Some(300));
    assert_eq!(price.cache_write_per_1k_micro_usd, Some(3750));
}
