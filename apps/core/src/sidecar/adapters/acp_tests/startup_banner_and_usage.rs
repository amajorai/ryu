use super::*;

/// The `session/new` meta shape pi-acp actually returns, so the reader is
/// pinned to the real wire form and not to a shape someone imagined.
fn session_meta(startup_info: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    let mut m = serde_json::Map::new();
    m.insert(
        "piAcp".to_owned(),
        serde_json::json!({ "startupInfo": startup_info }),
    );
    m
}

#[test]
fn a_declared_startup_banner_is_read_from_the_session_meta() {
    let banner = "pi v1.2.3\n---\n\n## Skills\n- a\n- b";
    assert_eq!(
        declared_startup_banner(Some(&session_meta(banner.into()))),
        Some(banner.to_owned())
    );
}

/// Every way an agent can decline to declare one. All of them must leave the
/// slot empty, because an empty slot is what makes this whole path inert for
/// agents other than pi-acp — no other agent's first chunk may ever be
/// reclassified as chrome.
#[test]
fn no_declared_banner_leaves_the_slot_empty() {
    // Quiet startup with no update available: pi sends the key as null.
    assert_eq!(
        declared_startup_banner(Some(&session_meta(serde_json::Value::Null))),
        None
    );
    // Declared but empty is not a banner either.
    assert_eq!(
        declared_startup_banner(Some(&session_meta("".into()))),
        None
    );
    // An agent that namespaces nothing under `piAcp`.
    assert_eq!(declared_startup_banner(Some(&serde_json::Map::new())), None);
    // An agent that returns no `_meta` at all (claude-code-acp, codex, …).
    assert_eq!(declared_startup_banner(None), None);
}

/// The banner is matched by IDENTITY against what the agent declared, and it
/// is consumed on the way through.
///
/// The consume is the guard against the pooled-session trap: one ACP instance
/// serves every turn of a chat, so anything shaped like "the first agent
/// chunk is chrome" would eat a real answer on turn 2. Here the same text
/// arriving again is plain assistant text.
#[test]
fn the_startup_banner_is_taken_at_most_once() {
    let banner = "## Skills\n- one";
    let slot = Mutex::new(Some(banner.to_owned()));
    assert!(
        take_startup_banner(&slot, banner),
        "first match is the banner"
    );
    assert!(
        !take_startup_banner(&slot, banner),
        "a later chunk with the same text is a real reply, not chrome"
    );
}

/// A real reply must never be swallowed, however much it looks like the
/// banner — which is exactly why this matches the declared string instead of
/// sniffing for a `## Skills` heading.
#[test]
fn a_reply_that_merely_discusses_skills_is_not_the_banner() {
    let slot = Mutex::new(Some("pi v1.2.3\n---\n\n## Skills\n- a".to_owned()));
    for reply in [
        "## Skills\n- a", // the banner's tail, not the banner
        "Sure — here are your skills:\n\n## Skills\n- a",
        "pi v1.2.3\n---\n\n## Skills\n- a\n", // one trailing newline off
    ] {
        assert!(
            !take_startup_banner(&slot, reply),
            "must stay assistant text: {reply:?}"
        );
    }
    // …and the banner itself still matches afterwards: a near miss must not
    // consume the slot and let the real banner through as a persisted reply.
    assert!(take_startup_banner(
        &slot,
        "pi v1.2.3\n---\n\n## Skills\n- a"
    ));
}

/// Per-turn, as claude-agent-acp and codex-acp send it: each turn's counts
/// are its own, so the first turn is reported (it used to have no baseline)
/// and turn 2 is not `turn2 − turn1`.
#[test]
fn prompt_response_usage_is_read_as_this_turns_usage() {
    let turn2 = AcpUsageSnapshot::from_value(&serde_json::json!({
        "inputTokens": 1500_u64,
        "outputTokens": 350_u64,
        "totalTokens": 1850_u64,
    }));
    assert_eq!(turn2.prompt_tokens_with_cache(), Some(1500));
    assert_eq!(turn2.output_tokens, Some(350));
    assert_eq!(turn2.total_tokens, Some(1850));
}

/// claude-agent-acp / codex-acp exclude cache tokens from `inputTokens`; the
/// desktop divides cache reads by total input, so they are added back.
#[test]
fn prompt_tokens_include_cache_reads_and_writes_when_the_agent_excludes_them() {
    let claude = AcpUsageSnapshot::from_value(&serde_json::json!({
        "inputTokens": 12_u64,
        "outputTokens": 300_u64,
        "cachedReadTokens": 40_000_u64,
        "cachedWriteTokens": 2_000_u64,
        "totalTokens": 42_312_u64,
    }));
    assert_eq!(claude.prompt_tokens_with_cache(), Some(42_012));

    // An agent whose input already counts the cache says so through its total.
    let inclusive = AcpUsageSnapshot::from_value(&serde_json::json!({
        "inputTokens": 42_012_u64,
        "outputTokens": 300_u64,
        "cachedReadTokens": 40_000_u64,
        "totalTokens": 42_312_u64,
    }));
    assert_eq!(inclusive.prompt_tokens_with_cache(), Some(42_012));
}

/// An absent optional counter must stay absent — never become a zero the UI
/// would render as a real "0 tokens" reading.
#[test]
fn absent_usage_counters_stay_absent() {
    let snap = AcpUsageSnapshot::from_value(&serde_json::json!({
        "inputTokens": 10_u64,
        "outputTokens": 5_u64,
        "totalTokens": 15_u64,
    }));
    assert_eq!(snap.thought_tokens, None);
    assert_eq!(snap.cached_read_tokens, None);
    assert_eq!(snap.cached_write_tokens, None);
    let empty = AcpUsageSnapshot::from_value(&serde_json::json!({}));
    assert_eq!(empty, AcpUsageSnapshot::default());
    assert_eq!(empty.prompt_tokens_with_cache(), None);
}

/// The managed Pi reports each assistant message; the turn-end frame gets
/// their sum, with cache tokens counted into the prompt.
#[test]
fn managed_pi_reported_usage_fills_the_turn_end_frame() {
    let conversation = "reported-usage-test";
    let message = |input: u64, read: u64| {
        serde_json::json!({
            "input": input, "output": 50, "cacheRead": read, "cacheWrite": 0,
            "totalTokens": input + 50 + read,
        })
    };
    assert!(record_reported_usage(
        conversation,
        "ryu",
        &message(100, 9_000)
    ));
    assert!(record_reported_usage(
        conversation,
        "ryu",
        &message(20, 9_100)
    ));
    assert!(!record_reported_usage(
        conversation,
        "ryu",
        &serde_json::json!({})
    ));

    let mut frame = serde_json::json!({ "done": true });
    merge_reported_usage(conversation, "ryu", &mut frame);
    assert_eq!(frame["promptTokens"], 18_220);
    assert_eq!(frame["completionTokens"], 100);
    assert_eq!(frame["cachedReadTokens"], 18_100);
    assert_eq!(frame["totalTokens"], 18_320);
    assert!(frame.get("thoughtTokens").is_none());
    // Taken: the next turn starts from nothing.
    assert!(take_reported_usage(conversation, "ryu").is_none());

    // The agent's own counts win, but the report is still cleared.
    assert!(record_reported_usage(conversation, "ryu", &message(1, 1)));
    let mut own = serde_json::json!({ "done": true, "promptTokens": 7 });
    merge_reported_usage(conversation, "ryu", &mut own);
    assert_eq!(own["promptTokens"], 7);
    assert!(take_reported_usage(conversation, "ryu").is_none());
}

/// gemini-cli reports tokens only in `_meta.quota.token_count`, snake_case.
#[test]
fn quota_meta_supplies_usage_when_the_response_has_none() {
    let gemini = usage_from_quota_meta(&serde_json::json!({
        "quota": { "token_count": { "input_tokens": 900, "output_tokens": 120 } }
    }))
    .expect("gemini quota usage");
    assert_eq!(gemini["inputTokens"], 900);
    assert_eq!(gemini["outputTokens"], 120);
    assert!(gemini.get("thoughtTokens").is_none());

    let claude = usage_from_quota_meta(&serde_json::json!({
        "quota": { "token_count": {
            "inputTokens": 5, "outputTokens": 7, "totalTokens": 112,
            "cachedInputTokens": 90, "cachedWriteTokens": 10,
            "reasoningOutputTokens": 0
        } }
    }))
    .expect("claude quota usage");
    assert_eq!(claude["cachedReadTokens"], 90);
    assert_eq!(claude["cachedWriteTokens"], 10);
    assert!(
        claude.get("thoughtTokens").is_none(),
        "a zero is not a reading"
    );

    assert!(usage_from_quota_meta(&serde_json::json!({ "quota": {} })).is_none());
    assert!(usage_from_quota_meta(&serde_json::json!({})).is_none());
}

#[test]
fn overflowing_prompt_and_completion_counts_have_no_total() {
    assert_eq!(total_usage_tokens(7, 3), Some(10));
    assert_eq!(total_usage_tokens(u64::MAX, 1), None);
}

/// An agent that declared nothing can never have a chunk reclassified.
#[test]
fn an_empty_slot_never_matches() {
    let slot: Mutex<Option<String>> = Mutex::new(None);
    assert!(!take_startup_banner(&slot, ""));
    assert!(!take_startup_banner(&slot, "hello"));
}

/// A probe that FAILS must still be cached — the whole bug this path exists
/// to fix.
///
/// Before the cache stored failures, nothing was recorded on the error path,
/// so every read re-spawned the agent and re-waited the 30s ceiling. Measured
/// against a live node, three consecutive `GET /api/agents/ryu/acp-config`
/// calls took 30.7s each and 502'd every time; the desktop retries twice per
/// mount, so opening a chat could burn 90s before showing an empty picker.
/// Asserting on the cache entry (rather than on wall-clock) keeps this
/// deterministic while still driving the real `probe_acp_config` path.
#[tokio::test]
async fn a_failed_probe_is_cached_instead_of_respawning_the_agent() {
    // A binary that cannot exist, so the probe fails fast and spawns nothing
    // that outlives the test.
    let spawn_cmd = "ryu-nonexistent-acp-agent-for-tests --stdio".to_owned();
    let cwd = std::env::temp_dir();

    assert!(
        probe_cache::lookup(&spawn_cmd).is_none(),
        "precondition: nothing cached for this command yet"
    );

    let first = probe_acp_config(spawn_cmd.clone(), cwd.clone()).await;
    assert!(first.is_err(), "a missing binary cannot be probed");

    let hit =
        probe_cache::lookup(&spawn_cmd).expect("the failure must be cached, not silently dropped");
    assert!(hit.outcome.is_err(), "the cached outcome is the failure");
    assert!(!hit.stale, "a just-recorded failure is still fresh");

    // The second read is served from that entry rather than re-spawning.
    assert!(probe_acp_config(spawn_cmd.clone(), cwd).await.is_err());

    // …and an auth transition drops it, so signing in doesn't wait out the TTL.
    probe_cache::invalidate(&spawn_cmd);
    assert!(probe_cache::lookup(&spawn_cmd).is_none());
}
