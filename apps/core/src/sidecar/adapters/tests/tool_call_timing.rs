use super::*;

// ── Per-tool-call timing ────────────────────────────────────────────────

#[test]
fn tool_timing_meta_carries_duration_only_once_closed() {
    // Open: a start with no end, so a client can tick a live counter but has
    // nothing to freeze on yet.
    let open = tool_timing_meta(1_000, None);
    assert_eq!(open["ryu"]["startedAt"], serde_json::json!(1_000));
    assert!(open["ryu"].get("completedAt").is_none());
    assert!(open["ryu"].get("durationMs").is_none());

    // Closed: the pair PLUS the precomputed duration, so no consumer has to
    // subtract two epoch stamps to render a number.
    let closed = tool_timing_meta(1_000, Some(3_500));
    assert_eq!(closed["ryu"]["startedAt"], serde_json::json!(1_000));
    assert_eq!(closed["ryu"]["completedAt"], serde_json::json!(3_500));
    assert_eq!(closed["ryu"]["durationMs"], serde_json::json!(2_500));
}

#[test]
fn tool_timing_meta_clamps_a_backwards_clock() {
    // A wall clock can step backwards (NTP correction mid-call). A negative
    // duration would render as garbage, so it floors at zero rather than
    // propagating.
    let closed = tool_timing_meta(5_000, Some(4_000));
    assert_eq!(closed["ryu"]["durationMs"], serde_json::json!(0));
}

#[test]
fn tool_clock_reuses_the_opening_stamp_across_reemits() {
    // The load-bearing property: an ACP `tool_call_update` re-emits the
    // opening frame to fill in late arguments, and a plan/thought snapshot
    // re-emits on every chunk. If either restarted the clock, a long call
    // would perpetually read as just-started — erasing exactly the wait this
    // feature exists to show.
    let mut clock = ToolClock::default();
    let first = clock.start("call-a");
    let second = clock.start("call-a");
    assert_eq!(first, second, "re-emitting must not restart the clock");

    let (started, completed) = clock.finish("call-a").expect("call was opened");
    assert_eq!(started, first);
    assert!(completed >= started, "completion cannot precede the start");

    // Finishing consumes the entry, so a repeated terminal frame does not
    // resurrect a second, wrong start.
    assert!(clock.finish("call-a").is_none());
}

#[test]
fn tool_clock_finish_is_none_for_an_unopened_call() {
    // A bare output frame with no matching input is not renderable anyway;
    // it must not fabricate a zero-length duration.
    let mut clock = ToolClock::default();
    assert!(clock.finish("never-opened").is_none());
}

#[test]
fn tool_frames_carry_timing_under_the_ryu_provider_namespace() {
    // `providerMetadata` is the sanctioned open channel: a bare extra key on
    // the chunk would be stripped by the AI SDK's schema, and this one lands
    // on the part as `callProviderMetadata`.
    let input = decode_frame(ui_tool_input(
        "call-a",
        "Bash",
        &serde_json::json!({ "command": "ls" }),
        false,
        Some(1_000),
    ));
    assert_eq!(
        input["providerMetadata"]["ryu"]["startedAt"],
        serde_json::json!(1_000)
    );

    let output = decode_frame(ui_tool_output(
        "call-a",
        &serde_json::json!({ "ok": true }),
        false,
        Some((1_000, 4_000)),
    ));
    // The closing frame REPEATS `startedAt` because the SDK replaces
    // `callProviderMetadata` wholesale rather than merging it — contributing
    // `completedAt` alone would drop the start.
    assert_eq!(
        output["providerMetadata"]["ryu"]["startedAt"],
        serde_json::json!(1_000)
    );
    assert_eq!(
        output["providerMetadata"]["ryu"]["durationMs"],
        serde_json::json!(3_000)
    );
}

#[test]
fn question_tool_frame_keeps_the_stable_tool_call_id() {
    let input = decode_frame(ui_tool_input(
        "acp-question-7",
        "Question",
        &serde_json::json!({
            "toolCallId": "acp-question-7",
            "questions": [{ "id": "q-0", "title": "Pick one", "kind": "single" }]
        }),
        false,
        None,
    ));
    assert_eq!(input["toolCallId"], serde_json::json!("acp-question-7"));
    assert_eq!(
        input["input"]["toolCallId"],
        serde_json::json!("acp-question-7")
    );
}

#[test]
fn unstamped_tool_frames_are_byte_identical_to_before() {
    // `None` must add no key at all, so an unstamped producer's wire format
    // is unchanged.
    let input = decode_frame(ui_tool_input(
        "call-a",
        "Bash",
        &serde_json::json!({}),
        false,
        None,
    ));
    assert!(input.get("providerMetadata").is_none());

    let output = decode_frame(ui_tool_output(
        "call-a",
        &serde_json::json!({}),
        false,
        None,
    ));
    assert!(output.get("providerMetadata").is_none());
}

#[test]
fn persisted_parts_carry_the_same_timing_as_the_wire_frames() {
    // The whole point of the Core-side stamp: a reopened conversation must
    // show the same duration the user watched live. If the accumulator
    // dropped the metadata, timing would be visible during the turn and gone
    // on reload — the exact failure this replaced.
    let mut acc = PartsAccumulator::default();
    acc.tool_input(
        "call-a",
        "Bash",
        &serde_json::json!({ "command": "sleep 3" }),
        false,
        Some(1_000),
    );
    assert_eq!(
        acc.parts[0]["callProviderMetadata"]["ryu"]["startedAt"],
        serde_json::json!(1_000)
    );

    acc.tool_output(
        "call-a",
        &serde_json::json!({ "ok": true }),
        false,
        Some((1_000, 4_000)),
    );
    assert_eq!(
        acc.parts[0]["callProviderMetadata"]["ryu"]["durationMs"],
        serde_json::json!(3_000)
    );
    assert_eq!(
        acc.parts[0]["callProviderMetadata"]["ryu"]["completedAt"],
        serde_json::json!(4_000)
    );
}

#[test]
fn parts_file_appends_media_part_and_to_json_roundtrips() {
    let mut acc = PartsAccumulator::default();
    acc.text_delta("0", "see image");
    acc.file("image/png", "data:image/png;base64,AAAA");
    assert_eq!(acc.parts[1]["type"], serde_json::json!("file"));
    assert_eq!(acc.parts[1]["mediaType"], serde_json::json!("image/png"));

    // to_json serializes the exact parts array persisted to the DB column.
    let json = acc.to_json();
    let round: Vec<Value> = serde_json::from_str(&json).unwrap();
    assert_eq!(round.len(), 2);
    assert_eq!(round[0]["text"], serde_json::json!("see image"));
    assert_eq!(
        round[1]["url"],
        serde_json::json!("data:image/png;base64,AAAA")
    );
}

#[test]
fn parts_data_roundtrips_for_transcript_metadata() {
    let mut acc = PartsAccumulator::default();
    acc.data(
        "ryu-agent-control",
        &serde_json::json!({ "effective_agent_id": "research-agent" }),
    );

    let round: Vec<Value> = serde_json::from_str(&acc.to_json()).unwrap();
    assert_eq!(
        round[0]["type"],
        serde_json::json!("data-ryu-agent-control")
    );
    assert_eq!(
        round[0]["data"]["effective_agent_id"],
        serde_json::json!("research-agent")
    );
}

#[test]
fn memory_citations_frame_and_persisted_part_share_the_same_payload() {
    let citations = vec![MemoryCitation {
        id: "memory-1".to_owned(),
        content: "Prefers dark mode".to_owned(),
    }];
    let frame = String::from_utf8(ui_memory_citations(&citations)).unwrap();
    assert!(frame.contains("data-ryu-memory-citations"));
    assert!(frame.contains("Prefers dark mode"));

    let mut acc = PartsAccumulator::default();
    acc.data(
        "ryu-memory-citations",
        &memory_citations_payload(&citations),
    );
    let round: Vec<Value> = serde_json::from_str(&acc.to_json()).unwrap();
    assert_eq!(
        round[0]["type"],
        serde_json::json!("data-ryu-memory-citations")
    );
    assert_eq!(
        round[0]["data"]["citations"][0]["id"],
        serde_json::json!("memory-1")
    );
}

#[test]
fn chat_request_preserves_openai_model_pin() {
    let request: ChatStreamRequest = serde_json::from_value(serde_json::json!({
        "messages": [],
        "model": "provider/model"
    }))
    .expect("chat request should accept the desktop model field");

    assert_eq!(request.model.as_deref(), Some("provider/model"));
}

#[test]
fn chat_request_defaults_to_everyday_response_mode() {
    let request: ChatStreamRequest = serde_json::from_value(serde_json::json!({
        "messages": []
    }))
    .expect("chat request should default its response mode");

    assert_eq!(
        request.response_mode,
        crate::ryu_platform::RyuResponseMode::Everyday
    );
}

#[test]
fn chat_request_accepts_developer_response_mode() {
    let request: ChatStreamRequest = serde_json::from_value(serde_json::json!({
        "messages": [],
        "response_mode": "developer"
    }))
    .expect("chat request should accept developer response mode");

    assert_eq!(
        request.response_mode,
        crate::ryu_platform::RyuResponseMode::Developer
    );
}

#[test]
fn parts_empty_accumulator_serializes_to_empty_array() {
    let acc = PartsAccumulator::default();
    assert_eq!(acc.to_json(), "[]");
}

#[test]
fn parts_accumulator_persists_a_failed_turn_as_an_error_card() {
    let mut acc = PartsAccumulator::default();
    acc.error(
        "provider_payment_required",
        "OpenRouter credits exhausted",
        "Add credits to your OpenRouter account, then retry.",
    );
    let parts: Vec<Value> = serde_json::from_str(&acc.to_json()).unwrap();
    assert_eq!(
        parts,
        vec![serde_json::json!({
            "type": "error",
            "code": "provider_payment_required",
            "title": "OpenRouter credits exhausted",
            "message": "Add credits to your OpenRouter account, then retry."
        })]
    );
}

#[test]
fn delegated_max_tokens_cap_is_stricter_than_agent_default() {
    let mut sampling = crate::inference::SamplingConfig {
        max_tokens: Some(4096),
        ..Default::default()
    };
    apply_max_tokens_cap(&mut sampling, 512);
    assert_eq!(sampling.max_tokens, Some(512));

    apply_max_tokens_cap(&mut sampling, 2048);
    assert_eq!(sampling.max_tokens, Some(512));
}

#[test]
fn hook_effort_does_not_invent_an_acp_config_option() {
    let mut req = ChatStreamRequest::default();

    apply_hook_effort(&mut req, "high");

    assert_eq!(
        req.inference
            .as_ref()
            .and_then(|inference| inference.extra.get("reasoning_effort")),
        Some(&serde_json::json!("high"))
    );
    assert!(req.acp_config.is_none());
}

#[test]
fn hook_effort_uses_the_configured_effort_option() {
    let mut req = ChatStreamRequest {
        acp_config: Some(std::collections::HashMap::from([(
            "effort".to_owned(),
            "low".to_owned(),
        )])),
        ..Default::default()
    };

    apply_hook_effort(&mut req, "high");

    assert_eq!(
        req.acp_config.unwrap().get("effort"),
        Some(&"high".to_owned())
    );
}

#[test]
fn hook_acp_config_merges_and_overrides_same_turn_values() {
    let mut req = ChatStreamRequest {
        acp_config: Some(std::collections::HashMap::from([(
            "fast_mode".to_owned(),
            "false".to_owned(),
        )])),
        ..Default::default()
    };
    let hook_config = std::collections::HashMap::from([
        ("fast_mode".to_owned(), "true".to_owned()),
        ("service_tier".to_owned(), "priority".to_owned()),
    ]);

    apply_hook_acp_config(&mut req, &hook_config);

    assert_eq!(
        req.acp_config.unwrap(),
        std::collections::HashMap::from([
            ("fast_mode".to_owned(), "true".to_owned()),
            ("service_tier".to_owned(), "priority".to_owned()),
        ])
    );
}

async fn assistant_rows(store: &ConversationStore, conversation_id: &str) -> Vec<String> {
    store
        .get_active_messages(conversation_id)
        .await
        .unwrap()
        .into_iter()
        .filter(|message| message.role == "assistant")
        .map(|message| message.content)
        .collect()
}

/// Make the next `observe` due without sleeping through the interval.
async fn backdate(checkpoint: &ReplyCheckpoint) {
    checkpoint.state.lock().await.due_from =
        Some(std::time::Instant::now() - REPLY_CHECKPOINT_INTERVAL);
}

#[tokio::test]
async fn reply_checkpoint_keeps_one_row_that_the_terminal_persist_finishes() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-cp", "user", "hi", None, None, None)
        .await
        .unwrap();
    let checkpoint = ReplyCheckpoint::new(store.clone(), "conv-cp".into(), None);

    // The first token only arms the timer.
    checkpoint.observe("", "Hel").await;
    assert!(assistant_rows(&store, "conv-cp").await.is_empty());

    backdate(&checkpoint).await;
    checkpoint.observe("Hel", "lo").await;
    assert_eq!(assistant_rows(&store, "conv-cp").await, ["Hello"]);

    backdate(&checkpoint).await;
    checkpoint.observe("Hello", " world").await;
    assert_eq!(assistant_rows(&store, "conv-cp").await, ["Hello world"]);

    let checkpointed = checkpoint.message_id().await;
    let finished = persist_assistant_reply(
        store.clone(),
        Some("conv-cp".into()),
        None,
        "Hello world!".into(),
        "completed",
        vec![],
        Some(checkpoint),
        Vec::new(),
    )
    .await;
    assert_eq!(finished, checkpointed);
    assert_eq!(assistant_rows(&store, "conv-cp").await, ["Hello world!"]);
}

#[tokio::test]
async fn short_reply_is_written_once_at_the_end() {
    let store = ConversationStore::open_in_memory().unwrap();
    let checkpoint = ReplyCheckpoint::new(store.clone(), "conv-short".into(), None);
    checkpoint.observe("", "Quick").await;
    checkpoint.observe("", "Quick answer").await;
    assert!(assistant_rows(&store, "conv-short").await.is_empty());
    persist_assistant_reply(
        store.clone(),
        Some("conv-short".into()),
        None,
        "Quick answer.".into(),
        "completed",
        vec![],
        Some(checkpoint),
        Vec::new(),
    )
    .await;
    assert_eq!(
        assistant_rows(&store, "conv-short").await,
        ["Quick answer."]
    );
}
