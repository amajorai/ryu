use super::*;
use crate::sidecar::adapters::UiContent;
use serde_json::json;

fn user(text: &str) -> UiMessage {
    UiMessage {
        metadata: None,
        role: "user".to_owned(),
        content: UiContent::Text(text.to_owned()),
        parts: vec![],
    }
}
fn system(text: &str) -> UiMessage {
    UiMessage {
        metadata: None,
        role: "system".to_owned(),
        content: UiContent::Text(text.to_owned()),
        parts: vec![],
    }
}

fn cfg(max: usize, reserve: usize) -> ContextWindowConfig {
    ContextWindowConfig {
        max_tokens: max,
        reserve_output: reserve,
        auto_compact: false,
        compact_on_cache_expire: false,
        compact_model: "m".to_owned(),
        compact_effort: String::new(),
    }
}

#[test]
fn estimate_is_ceil_len_over_3_5() {
    assert_eq!(estimate_tokens(""), 0);
    assert_eq!(estimate_tokens("abcd"), 2); // ceil(4/3.5)=2
    assert_eq!(estimate_tokens(&"a".repeat(7)), 2); // ceil(7/3.5)=2
    assert_eq!(estimate_tokens(&"a".repeat(8)), 3); // ceil(8/3.5)=3
}

#[test]
fn window_keeps_newest_within_budget() {
    let est = vec![10, 10, 10, 10]; // oldest..newest
    assert_eq!(window_count(&est, 25), 2); // 10+10 fit, +10 would exceed
    assert_eq!(window_count(&est, 100), 4);
    assert_eq!(window_count(&est, 0), 1); // always keep at least the last
    assert_eq!(window_count(&est, 5), 1);
}

#[test]
fn window_empty_is_zero() {
    assert_eq!(window_count(&[], 100), 0);
}

#[test]
fn stable_drop_is_zero_when_everything_fits() {
    assert_eq!(stable_drop_count(&[], 100, 50), 0);
    assert_eq!(stable_drop_count(&[10, 10, 10], 100, 50), 0);
}

#[test]
fn stable_drop_still_fits_the_budget_and_keeps_the_last_turn() {
    let est = vec![10; 20];
    for (budget, step) in [(0, 1), (5, 1), (25, 10), (50, 25), (99, 40), (150, 500)] {
        let drop = stable_drop_count(&est, budget, step);
        assert!(drop < est.len(), "budget {budget} dropped the last turn");
        let minimal = est.len() - window_count(&est, budget);
        assert!(drop >= minimal, "budget {budget} kept more than fits");
    }
}

#[test]
fn stable_drop_holds_the_cut_while_history_grows() {
    // Grow a conversation one 10-token turn at a time against a 100-token
    // budget. A plain sliding window moves the cut on every over-budget turn;
    // the stable cut must move far less often, and never backwards.
    let budget = 100;
    let mut est = Vec::new();
    let mut previous = 0;
    let mut moves = 0;
    let mut sliding_moves = 0;
    let mut previous_sliding = 0;
    for _ in 0..60 {
        est.push(10);
        let drop = stable_drop_count(&est, budget, 50);
        assert!(drop >= previous, "cut moved backwards");
        if drop != previous {
            moves += 1;
        }
        previous = drop;
        let sliding = est.len() - window_count(&est, budget);
        if sliding != previous_sliding {
            sliding_moves += 1;
        }
        previous_sliding = sliding;
    }
    assert_eq!(sliding_moves, 50);
    assert!(moves <= 10, "stable cut moved {moves} times");
}

#[test]
fn stable_drop_resists_a_budget_that_jitters_every_turn() {
    // Real turns re-estimate the system block (recall, memory) each time, so
    // the history budget wobbles. The checkpoint step comes from settings and
    // must not wobble with it, and the held cut must never move backwards.
    let step = 250;
    let key = hash_all(["jitter-test"]);
    let mut est = Vec::new();
    let mut previous = 0;
    let mut moves = 0;
    let mut sliding_moves = 0;
    let mut previous_sliding = 0;
    for turn in 0..600usize {
        est.push(10);
        let budget = 850 + (turn * 97) % 301; // 850..=1150, changes every turn
        let cut = stable_drop_count(&est, budget, step);
        let drop = hold_cut(key, est.len(), cut, step, |n| n as u64);
        let minimal = est.len() - window_count(&est, budget);
        assert!(drop >= minimal, "turn {turn} kept more than fits");
        assert!(drop >= previous, "turn {turn} moved the cut backwards");
        if drop != previous {
            moves += 1;
        }
        previous = drop;
        if minimal != previous_sliding {
            sliding_moves += 1;
        }
        previous_sliding = minimal;
    }
    assert!(
        moves * 5 < sliding_moves,
        "stable cut moved {moves} times, sliding window {sliding_moves}"
    );
}

#[test]
fn hold_cut_holds_until_history_or_settings_change() {
    let key = hash_all(["hold-cut-test"]);
    assert_eq!(hold_cut(key, 20, 8, 50, |n| n as u64), 8);
    // Same history, smaller cut this turn (or none at all): the cut holds.
    assert_eq!(hold_cut(key, 21, 5, 50, |n| n as u64), 8);
    assert_eq!(hold_cut(key, 21, 0, 50, |n| n as u64), 8);
    // Different dropped messages under the same key: start fresh.
    assert_eq!(hold_cut(key, 21, 5, 50, |n| n as u64 + 1), 5);
    // Settings changed (a new step): start fresh.
    assert_eq!(hold_cut(key, 21, 2, 80, |n| n as u64 + 1), 2);
    // A remembered cut that would drop the newest message is ignored.
    assert_eq!(hold_cut(key, 2, 1, 80, |n| n as u64 + 1), 1);
    // Nothing dropped and nothing held: the memo forgets the conversation.
    assert_eq!(hold_cut(key, 30, 0, 90, |n| n as u64), 0);
    assert_eq!(hold_cut(key, 30, 0, 90, |n| n as u64), 0);
}

#[test]
fn checkpoint_step_ignores_the_per_turn_system_block() {
    let config = cfg(10_000, 1_000);
    assert_eq!(
        config.checkpoint_step(),
        (10_000 - 1_000 - SKILLS_RESERVE) / 4
    );
    assert_eq!(cfg(0, 0).checkpoint_step(), 1);
}

#[tokio::test]
async fn apply_openai_drops_oldest_keeps_system_and_last() {
    // Big per-message text so each turn is ~many tokens; tiny budget forces
    // a drop. System message must survive regardless and move to the front.
    let big = "x".repeat(350); // ~100 tokens each
    let mut msgs = vec![
        system("you are helpful"),
        user(&big),
        user(&big),
        user("latest"),
    ];
    // budget after reserves is small -> only the last user turn fits.
    let summary = replay::apply_openai(&mut msgs, 0, &cfg(200, 0)).await;
    assert!(summary.is_none()); // auto_compact off
    assert_eq!(msgs.first().map(|m| m.role.as_str()), Some("system"));
    assert_eq!(
        msgs.last().map(|m| ui_message_text(m)),
        Some("latest".to_owned())
    );
    // system + at least the last user turn; oldest big turns dropped.
    assert!(msgs.len() < 4);
}

#[tokio::test]
async fn apply_openai_noop_when_everything_fits() {
    let mut msgs = vec![system("sys"), user("hi"), user("there")];
    let before = msgs.len();
    let summary = replay::apply_openai(&mut msgs, 0, &cfg(100_000, 1024)).await;
    assert!(summary.is_none());
    assert_eq!(msgs.len(), before);
    assert_eq!(
        msgs.last().map(|m| ui_message_text(m)),
        Some("there".to_owned())
    );
}

#[tokio::test]
async fn bare_message_arrays_cannot_inherit_another_callers_context_cut() {
    let opening = "Review the attached report.";
    let config = cfg(8192, 1024);
    let mut attacker = vec![
        system(&"x".repeat(24_000)),
        user(opening),
        user("attacker latest"),
    ];
    apply_openai(&mut attacker, 0, &config).await;
    assert_eq!(attacker.len(), 2);
    let mut victim = vec![user(opening), user("private follow-up")];
    apply_openai(&mut victim, 0, &config).await;
    assert_eq!(victim.len(), 2);
    assert_eq!(ui_message_text(&victim[0]), opening);
}

#[test]
fn images_counted_flat_not_by_payload() {
    // A message whose only content is a giant base64 image part must not be
    // estimated as a huge token count.
    let huge_b64 = "A".repeat(200_000);
    let msg = UiMessage {
        metadata: None,
        role: "user".to_owned(),
        content: UiContent::Empty,
        parts: vec![json!({
            "type": "file",
            "mediaType": "image/png",
            "url": format!("data:image/png;base64,{huge_b64}")
        })],
    };
    // Whatever message_image_parts detects, the estimate must be small
    // (flat per-image cost), never ~57k tokens from the base64 length.
    assert!(estimate_ui_message_tokens(&msg) <= IMAGE_TOKEN_COST + PER_MESSAGE_OVERHEAD + 8);
}

#[test]
fn input_budget_saturates_when_reserves_exceed_max() {
    // reserve_output + system + SKILLS_RESERVE all subtract from max_tokens;
    // when they exceed it the budget floors at 0 (never underflows/panics).
    let c = cfg(100, 1000); // reserve_output alone dwarfs max_tokens
    assert_eq!(c.input_budget(0), 0);
    // Even a modest max is fully consumed by system_tokens + SKILLS_RESERVE.
    let c2 = cfg(1000, 0);
    assert_eq!(c2.input_budget(10_000), 0);
}

#[test]
fn ui_message_text_joins_text_parts_when_content_empty() {
    // With empty content, the text is reconstructed from the `text` parts.
    let msg = UiMessage {
        metadata: None,
        role: "user".to_owned(),
        content: UiContent::Empty,
        parts: vec![
            json!({ "type": "text", "text": "foo" }),
            json!({ "type": "image", "url": "x" }), // no `text` key → skipped
            json!({ "type": "text", "text": "bar" }),
        ],
    };
    assert_eq!(ui_message_text(&msg), "foobar");
}

#[test]
fn ui_message_text_prefers_content_over_parts() {
    let msg = UiMessage {
        metadata: None,
        role: "user".to_owned(),
        content: UiContent::Text("primary".to_owned()),
        parts: vec![json!({ "type": "text", "text": "ignored" })],
    };
    assert_eq!(ui_message_text(&msg), "primary");
}

// ── budgeted_short_term (ACP short-term window) ─────────────────────────

use crate::server::conversations::ConversationStore;

#[tokio::test]
async fn budgeted_short_term_none_without_prior_turns() {
    let store = ConversationStore::open_in_memory().unwrap();
    // No messages at all → None.
    assert!(budgeted_short_term(&store, "empty-conv", 0, &cfg(1000, 0))
        .await
        .is_none());
    // A single message is JUST the current turn — no prior context to replay.
    store
        .append_message("one-conv", "user", "only turn", None, None, None)
        .await
        .unwrap();
    assert!(budgeted_short_term(&store, "one-conv", 0, &cfg(1000, 0))
        .await
        .is_none());
}

#[tokio::test]
async fn budgeted_short_term_replays_prefix_excluding_current_turn() {
    let store = ConversationStore::open_in_memory().unwrap();
    for (role, text) in [
        ("user", "remember 42"),
        ("assistant", "noted"),
        ("user", "what number?"), // current turn — must be excluded
    ] {
        store
            .append_message("c", role, text, None, None, None)
            .await
            .unwrap();
    }
    let block = budgeted_short_term(&store, "c", 0, &cfg(100_000, 0))
        .await
        .expect("prior turns replayed");
    assert!(block.starts_with("Conversation so far:\n"));
    assert!(block.contains("user: remember 42"));
    assert!(block.contains("assistant: noted"));
    // The just-persisted current turn is never echoed back into context.
    assert!(!block.contains("what number?"));
}

#[tokio::test]
async fn budgeted_short_term_drops_oldest_when_over_budget() {
    let store = ConversationStore::open_in_memory().unwrap();
    let big = "x".repeat(400); // ~114 tokens each
    for _ in 0..4 {
        store
            .append_message("cb", "user", &big, None, None, None)
            .await
            .unwrap();
    }
    store
        .append_message("cb", "user", "current", None, None, None)
        .await
        .unwrap();
    // Tiny budget (auto_compact off) → only the newest prefix turn survives,
    // older ones are silently dropped rather than summarized.
    let block = budgeted_short_term(&store, "cb", 0, &cfg(200, 0))
        .await
        .expect("some prior context");
    let big_occurrences = block.matches(&big).count();
    assert_eq!(
        big_occurrences, 1,
        "over-budget prefix keeps only the newest turn"
    );
    assert!(!block.contains("current"), "current turn excluded");
}

#[tokio::test]
async fn cold_cache_recut_keeps_the_warm_cut_when_no_summary_exists() {
    let store = ConversationStore::open_in_memory().unwrap();
    let turn = "y".repeat(350); // ~100 tokens each
    for _ in 0..6 {
        store
            .append_message("cold", "user", &turn, None, None, None)
            .await
            .unwrap();
    }
    store
        .append_message("cold", "user", "current", None, None, None)
        .await
        .unwrap();
    let mut config = cfg(1_200, 0);
    config.auto_compact = true;
    config.compact_on_cache_expire = true;
    // Warm turn: the whole prefix fits the budget, nothing is cut.
    let warm = replay::budgeted_short_term_replay(&store, "cold", 0, &config, false)
        .await
        .expect("prior context");
    assert_eq!(warm.block.matches(&turn).count(), 6);
    assert!(!warm.compacted_on_cache_expiry);
    // Cold turn with no reachable summarizer: the deeper cut is not committed,
    // so no turn is lost and the agent keeps its session.
    let cold = replay::budgeted_short_term_replay(&store, "cold", 0, &config, true)
        .await
        .expect("prior context");
    assert_eq!(cold.block.matches(&turn).count(), 6);
    assert!(!cold.compacted_on_cache_expiry);
}

#[tokio::test]
async fn cold_cache_recut_uses_the_memoized_summary() {
    let store = ConversationStore::open_in_memory().unwrap();
    let turns: Vec<String> = (0..6)
        .map(|index| format!("turn {index} {}", "z".repeat(340)))
        .collect();
    for turn in &turns {
        store
            .append_message("cold-memo", "user", turn, None, None, None)
            .await
            .unwrap();
    }
    store
        .append_message("cold-memo", "user", "current", None, None, None)
        .await
        .unwrap();
    let mut config = cfg(1_200, 0);
    config.auto_compact = true;
    config.compact_on_cache_expire = true;
    config.compact_model = "cold-cache-test-model".to_owned();
    // Seed the summary memo for every possible deeper cut so no gateway is
    // needed; only the cut the replay actually takes is read back.
    for cut in 1..turns.len() {
        let mut hasher = DefaultHasher::new();
        SummaryKind::Compact.hash(&mut hasher);
        config.compact_model.hash(&mut hasher);
        for turn in &turns[..cut] {
            "user".hash(&mut hasher);
            turn.hash(&mut hasher);
        }
        summary_cache().lock().await.insert(
            hasher.finish(),
            format!("[Earlier conversation summary]\n- first {cut} turns"),
        );
    }
    let cold = replay::budgeted_short_term_replay(&store, "cold-memo", 0, &config, true)
        .await
        .expect("prior context");
    assert!(cold.compacted_on_cache_expiry);
    assert!(cold.block.contains("[Earlier conversation summary]"));
    let kept = turns
        .iter()
        .filter(|turn| cold.block.contains(*turn))
        .count();
    assert!(kept < turns.len(), "older turns were summarized");
    assert!(cold.block.contains(&turns[5]), "newest turn kept verbatim");
    // The next, warm turn holds the deeper cut instead of re-growing the prefix.
    let warm = replay::budgeted_short_term_replay(&store, "cold-memo", 0, &config, false)
        .await
        .expect("prior context");
    assert_eq!(warm.block, cold.block);
    assert!(!warm.compacted_on_cache_expiry);
}

// ── Compaction hooks ──────────────────────────────────────────────────────

#[test]
fn hook_messages_mirror_the_flattened_summarizer_view() {
    // The hook must see the same rows the side model was handed, in order —
    // deriving a second view would let a hook act on turns that were not the
    // ones actually dropped.
    let convo = vec![
        ("user".to_owned(), "remember 42".to_owned()),
        ("assistant".to_owned(), "noted".to_owned()),
    ];
    let msgs = compact_hooks::hook_messages(&convo);
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].content, "remember 42");
    assert_eq!(msgs[1].role, "assistant");
    assert_eq!(msgs[1].content, "noted");
}

#[tokio::test]
async fn compact_hook_reentrancy_keeps_the_original_summary() {
    // A hook whose side effects re-enter compaction in the same task must not
    // dispatch again (and must not lose the summary it was handed).
    let convo = vec![("user".to_owned(), "hi".to_owned())];
    let original = "[Earlier conversation summary]\n- said hi".to_owned();
    let out = IN_COMPACT_HOOK
        .scope(
            (),
            compact_hooks::apply_compact_hooks(None, &convo, original.clone()),
        )
        .await;
    assert_eq!(out, original);
}
