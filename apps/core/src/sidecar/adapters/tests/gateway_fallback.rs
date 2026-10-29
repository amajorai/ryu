use super::*;

// ── Gateway fallback decision (U015) ─────────────────────────────────────

#[test]
fn gateway_up_and_via_gateway_true_forwards_through_gateway() {
    assert!(forward_via_gateway(true, true));
}

#[test]
fn gateway_down_causes_direct_provider_fallback() {
    // When via_gateway is true but the gateway is unreachable, the route
    // must fall back to the direct provider path instead of hard-failing.
    assert!(!forward_via_gateway(true, false));
}

#[test]
fn non_gateway_route_never_forwards_via_gateway() {
    // A route with via_gateway:false (e.g. degraded-mode direct fallback)
    // is never forwarded through the gateway regardless of health status.
    assert!(!forward_via_gateway(false, true));
    assert!(!forward_via_gateway(false, false));
}

#[test]
fn acp_prompt_orders_memory_then_message() {
    let prompt = build_acp_prompt(
        Some("Remembered: likes tea".to_owned()),
        Some("Conversation so far:\nuser: hi".to_owned()),
        "what did I just say?",
    );
    let lt = prompt.find("Remembered").unwrap();
    let st = prompt.find("Conversation so far").unwrap();
    let msg = prompt.find("what did I just say?").unwrap();
    assert!(lt < st, "long-term should precede short-term");
    assert!(st < msg, "short-term should precede the user message");
}

#[test]
fn acp_prompt_without_memory_is_just_message() {
    let prompt = build_acp_prompt(None, None, "hello");
    assert_eq!(prompt, "hello");
}

#[test]
fn context_prompt_suffix_accepts_only_appended_text() {
    assert_eq!(
        context_prompt_suffix("preamble\n\nhi", "preamble\n\nhi\n\n<rules/>").as_deref(),
        Some("\n\n<rules/>")
    );
    assert_eq!(
        context_prompt_suffix("preamble\n\nhi", "preamble\n\nhi"),
        None
    );
    assert_eq!(
        context_prompt_suffix("preamble\n\nhi", "hi\n\n<rules/>"),
        None,
        "dropping part of the preamble breaks the cached prefix"
    );
}

#[test]
fn context_rewrite_may_only_change_the_latest_user_message() {
    let original = vec![
        serde_json::json!({ "role": "system", "content": "base\n\nAGENTS.md" }),
        serde_json::json!({ "role": "user", "content": "first" }),
        serde_json::json!({ "role": "assistant", "content": "answer" }),
        serde_json::json!({ "role": "user", "content": "latest" }),
    ];

    let mut tail_only = original.clone();
    tail_only[3] = serde_json::json!({ "role": "user", "content": "latest\n\n<rules/>" });
    assert_eq!(
        accept_context_rewrite(&original, tail_only.clone()),
        Some(tail_only)
    );

    let mut system_edit = original.clone();
    system_edit[0] = serde_json::json!({ "role": "system", "content": "base" });
    assert_eq!(accept_context_rewrite(&original, system_edit), None);

    let mut history_edit = original.clone();
    history_edit[1] = serde_json::json!({ "role": "user", "content": "first (cleaned)" });
    assert_eq!(accept_context_rewrite(&original, history_edit), None);

    assert_eq!(
        accept_context_rewrite(&original, original[1..].to_vec()),
        None,
        "dropping an earlier row shifts the prefix"
    );
}

#[test]
fn context_rewrite_without_a_user_row_may_only_append() {
    let original = vec![serde_json::json!({ "role": "system", "content": "base" })];
    let mut appended = original.clone();
    appended.push(serde_json::json!({ "role": "user", "content": "<rules/>" }));
    assert_eq!(
        accept_context_rewrite(&original, appended.clone()),
        Some(appended)
    );
    assert_eq!(accept_context_rewrite(&original, Vec::new()), None);
}

#[test]
fn long_term_scope_falls_back_to_default() {
    assert_eq!(long_term_agent_scope(None), "default");
    assert_eq!(long_term_agent_scope(Some("")), "default");
    assert_eq!(long_term_agent_scope(Some("acp:claude")), "acp:claude");
}

#[test]
fn sensitive_captures_use_user_scope_even_inside_a_project() {
    let memory = infer_new_memory(
        "I have a medical condition",
        Some("/work/ryu"),
        Some("agent-a"),
    );
    assert_eq!(memory.scope, MemoryScope::User);
    assert!(memory.scope_id.is_none());

    let unassigned = infer_new_memory("I have a medical condition", Some("/work/ryu"), None);
    assert_eq!(unassigned.scope, MemoryScope::User);
    assert!(unassigned.scope_id.is_none());
}

#[tokio::test]
async fn rejected_turn_fails_only_its_own_running_claim() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-reject", "user", "hello", None, None, None)
        .await
        .unwrap();
    store
        .set_run_status("conv-reject", "running")
        .await
        .unwrap();
    let claimed_at = store
        .get_run_summary("conv-reject")
        .await
        .unwrap()
        .expect("conversation row")
        .updated_at;
    let run_status = |store: ConversationStore| async move {
        store
            .get_run_summary("conv-reject")
            .await
            .unwrap()
            .and_then(|run| run.run_status)
    };

    // A claim a newer turn has since replaced leaves that turn running.
    TurnRejection {
        conversations: store.clone(),
        claim: Some(("conv-reject".to_owned(), claimed_at - 1)),
    }
    .reject("stale".to_owned())
    .await;
    assert_eq!(run_status(store.clone()).await.as_deref(), Some("running"));

    // The turn's own claim ends as failed, so boot never auto-resumes it.
    TurnRejection {
        conversations: store.clone(),
        claim: Some(("conv-reject".to_owned(), claimed_at)),
    }
    .reject("No model is configured yet".to_owned())
    .await;
    assert_eq!(run_status(store.clone()).await.as_deref(), Some("failed"));
}

#[tokio::test]
async fn short_term_context_contains_prior_turns() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message(
            "conv-st",
            "user",
            "remember the number 42",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    store
        .append_message("conv-st", "assistant", "noted, 42", None, None, None)
        .await
        .unwrap();
    // Current turn (persisted before routing in the real flow).
    store
        .append_message("conv-st", "user", "what number?", None, None, None)
        .await
        .unwrap();

    let context = assemble_short_term_context(&store, "conv-st")
        .await
        .expect("context should be assembled");
    assert!(context.contains("remember the number 42"));
    assert!(context.contains("noted, 42"));
    // The current (last) turn is excluded from the replayed prefix.
    assert!(!context.contains("what number?"));
}

#[tokio::test]
async fn referenced_chat_context_is_bounded_and_excludes_current_chat() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("source", "user", "the launch code is 42", None, None, None)
        .await
        .unwrap();
    store
        .append_message("current", "user", "private current text", None, None, None)
        .await
        .unwrap();

    let context = assemble_referenced_chat_context(
        &store,
        &[
            "source".to_owned(),
            "source".to_owned(),
            "current".to_owned(),
        ],
        Some("current"),
    )
    .await
    .expect("source chat should be attached");

    assert!(context.contains("the launch code is 42"));
    assert!(!context.contains("private current text"));
    assert_eq!(context.matches("Referenced chat source").count(), 1);
    assert!(context.contains("EXTERNAL_UNTRUSTED_CONTENT"));
}

#[tokio::test]
async fn long_term_recall_is_cross_session_not_current_turn() {
    // Mirrors route_chat_stream's ordering: recall BEFORE recording the
    // current turn, so the just-sent message never echoes back as memory.
    let memory = MemoryStore::open_in_memory().unwrap();

    // First opted-in turn of a fresh conversation: nothing prior exists.
    let before_first =
        assemble_long_term_system_message(&memory, true, None, DEFAULT_LONG_TERM_LIMIT).await;
    assert!(
        before_first.is_none(),
        "first turn has no cross-session memory"
    );
    memory
        .record(LOCAL_USER, "default", "turn one")
        .await
        .unwrap();

    // Second turn: recall now surfaces turn one, but not the current turn.
    let before_second =
        assemble_long_term_system_message(&memory, true, None, DEFAULT_LONG_TERM_LIMIT)
            .await
            .expect("turn one should be recalled");
    assert!(before_second.contains("turn one"));
    assert!(!before_second.contains("turn two"));
    memory
        .record(LOCAL_USER, "default", "turn two")
        .await
        .unwrap();
}

#[tokio::test]
async fn long_term_system_message_disabled_when_opt_out() {
    let memory = MemoryStore::open_in_memory().unwrap();
    memory
        .record(LOCAL_USER, "default", "a fact")
        .await
        .unwrap();
    // Disabled: nothing recalled even though an entry exists.
    let disabled =
        assemble_long_term_system_message(&memory, false, None, DEFAULT_LONG_TERM_LIMIT).await;
    assert!(disabled.is_none());
    // Enabled: the fact is surfaced.
    let enabled = assemble_long_term_system_message(&memory, true, None, DEFAULT_LONG_TERM_LIMIT)
        .await
        .expect("memory enabled");
    assert!(enabled.contains("a fact"));
}

// ── Self-healing fallback chain (U043) ────────────────────────────────────

#[test]
fn default_agent_gets_fallback_chain() {
    // The registry must always return at least one fallback entry for the
    // default/"ryu" agent so a primary failure has somewhere to recover to.
    let reg = acp_reg();
    let chain = reg.fallback_chain_for_default();
    assert!(
        !chain.is_empty(),
        "default agent must have a non-empty fallback chain"
    );
}

#[test]
fn fallback_chain_url_env_override() {
    // The fallback chain must be swappable via env var (AC2: registry-configured,
    // not hardcoded). Verify that RYU_FALLBACK_LLM_BASE_URL is respected.
    std::env::set_var("RYU_FALLBACK_LLM_BASE_URL", "http://127.0.0.1:9999");
    std::env::set_var("RYU_FALLBACK_LLM_MODEL", "custom-model");
    let reg = acp_reg();
    let chain = reg.fallback_chain_for_default();
    assert_eq!(chain[0].base_url, "http://127.0.0.1:9999");
    assert_eq!(chain[0].model, "custom-model");
    std::env::remove_var("RYU_FALLBACK_LLM_BASE_URL");
    std::env::remove_var("RYU_FALLBACK_LLM_MODEL");
}

#[tokio::test]
async fn connect_with_fallback_tries_fallback_on_primary_failure() {
    // Simulate a primary provider failure by pointing at a guaranteed-
    // unreachable port. The fallback also points at an unreachable port, but
    // the test asserts the *fallback was attempted* by checking the combined
    // error message includes both provider URLs — proving the fallback path ran.
    let messages: Vec<Value> = vec![];
    let fallback = vec![FallbackProvider {
        base_url: "http://127.0.0.1:19998".to_owned(),
        model: "test-model".to_owned(),
        api_key: None,
    }];
    let result = connect_with_fallback(
        &messages,
        "http://127.0.0.1:19999",
        "primary-model",
        None,
        None,
        None, // no user id
        None, // no user JWT
        &[],  // no active skills
        &[],  // no composio actions
        None, // no session id
        &fallback,
        &AgentSlots::default(),
        false, // not companion-sourced
        false, // not background fan-out
        &crate::inference::SamplingConfig::default(),
        crate::inference::Engine::Other,
        &[],   // no tools
        None,  // no tool allowlist
        None,  // no capability hints
        None,  // no per-agent smart-route override
        None,  // no node routing preferences
        false, // no provider-native reasoning control
        false, // owner turn, not an unverified caller
        StreamHop::Provider,
        None, // no host conversation
    )
    .await;
    // Both primary and fallback should fail; the error message must mention
    // both failures so the operator can diagnose the full chain.
    let err = result.expect_err("both providers are unreachable");
    assert!(
        err.contains("Primary provider failed"),
        "error should describe primary failure: {err}"
    );
    assert!(
        err.contains("fallback also failed"),
        "error should describe fallback failure: {err}"
    );
}

#[tokio::test]
async fn connect_with_fallback_returns_primary_error_when_no_fallback_configured() {
    // When the fallback chain is empty (non-default agents, or fallback disabled),
    // the primary error is returned directly with no fallback attempt.
    let messages: Vec<Value> = vec![];
    let result = connect_with_fallback(
        &messages,
        "http://127.0.0.1:19999",
        "model",
        None,
        None,
        None, // no user id
        None, // no user JWT
        &[],  // no active skills
        &[],  // no composio actions
        None, // no session id
        &[],  // empty fallback chain
        &AgentSlots::default(),
        false, // not companion-sourced
        false, // not background fan-out
        &crate::inference::SamplingConfig::default(),
        crate::inference::Engine::Other,
        &[],   // no tools
        None,  // no tool allowlist
        None,  // no capability hints
        None,  // no per-agent smart-route override
        None,  // no node routing preferences
        false, // no provider-native reasoning control
        false, // owner turn, not an unverified caller
        StreamHop::Provider,
        None, // no host conversation
    )
    .await;
    let err = result.expect_err("unreachable primary");
    // Must be a plain transport error, not a "combined" message.
    assert!(
        !err.contains("fallback"),
        "no fallback should be mentioned when chain is empty: {err}"
    );
}
