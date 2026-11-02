use super::*;

#[test]
fn new_rejects_empty_app_token() {
    assert!(build(make_cfg("   ", "xoxb-1")).is_err());
}

#[test]
fn new_rejects_empty_bot_token() {
    assert!(build(make_cfg("xapp-1", "")).is_err());
}

#[test]
fn new_accepts_valid_tokens() {
    let mut cfg = make_cfg("xapp-1", "xoxb-1");
    cfg.common.system_prompt = Some("be terse".to_string());
    let channel = build(cfg).unwrap();
    assert_eq!(channel.name(), "slack");
    assert_eq!(channel.model(), "gpt-4o");
    assert_eq!(channel.system_prompt(), Some("be terse"));
}

#[test]
fn new_stores_agent_id_and_core_url() {
    let mut cfg = make_cfg("xapp-1", "xoxb-1");
    cfg.common.agent_id = Some("acp:pi".to_string());
    cfg.common.core_url = "http://127.0.0.1:7980".to_string();
    let channel = build(cfg).unwrap();
    assert_eq!(channel.runtime().cfg.agent_id.as_deref(), Some("acp:pi"));
    assert_eq!(channel.runtime().cfg.core_url, "http://127.0.0.1:7980");
    // An agent id is what routes the bot through Core's session seam.
    assert!(channel.runtime().routes_via_core());
}

/// Slack declares the platform's real surface: threads, files, reactions and
/// mrkdwn, but NOT a command menu (only the app manifest can register a slash
/// command) and not streaming.
#[test]
fn caps_declare_what_slack_can_do() {
    let channel = build(make_cfg("xapp-1", "xoxb-1")).unwrap();
    let caps = channel.caps();
    assert!(caps.threads && caps.rich_text && caps.attachments && caps.reactions);
    assert!(caps.voice && caps.typing);
    assert!(!caps.command_menu, "slash commands are manifest-only");
    assert!(!caps.streaming, "slack has no draft surface");
}

// ─── Thread keys (previously `make_chat_id` / `split_chat_id`, now the
// kernel's one shared convention) ──────────────────────────────────────────

#[test]
fn chat_id_round_trips_channel_and_thread() {
    let packed = pack_thread("C123", Some("169.45"));
    assert_eq!(packed, "C123:169.45");
    assert_eq!(unpack_thread(&packed), ("C123", Some("169.45")));
}

#[test]
fn split_chat_id_without_thread() {
    assert_eq!(unpack_thread("C123"), ("C123", None));
}

/// A top-level message anchors its own thread; a message already in a thread
/// answers in the PARENT's, never in a thread of a thread.
#[test]
fn thread_anchor_prefers_the_parent() {
    let top_level = pack_message_id("111.222", None);
    assert_eq!(top_level, "111.222");
    assert_eq!(thread_anchor(&top_level), "111.222");

    let in_thread = pack_message_id("333.444", Some("111.222"));
    assert_eq!(thread_anchor(&in_thread), "111.222");

    // Slack repeats `thread_ts` on the parent message itself; the anchor is
    // then the ts, packed only once.
    let parent = pack_message_id("111.222", Some("111.222"));
    assert_eq!(parent, "111.222");
    assert_eq!(thread_anchor(&parent), "111.222");
}

#[test]
fn active_threads_expire_and_stay_bounded() {
    let t0 = Instant::now();
    let mut threads = HashMap::new();
    remember_active_thread(&mut threads, "C1:1.0".to_owned(), t0);
    assert!(thread_is_active(&threads, "C1:1.0", t0));
    assert!(thread_is_active(
        &threads,
        "C1:1.0",
        t0 + ACTIVE_THREAD_IDLE_TTL - Duration::from_secs(1)
    ));
    assert!(!thread_is_active(
        &threads,
        "C1:1.0",
        t0 + ACTIVE_THREAD_IDLE_TTL
    ));
    assert!(!thread_is_active(&threads, "C1:2.0", t0));

    // A reply refreshes the thread, so a live conversation never expires.
    remember_active_thread(
        &mut threads,
        "C1:1.0".to_owned(),
        t0 + Duration::from_secs(3600),
    );
    assert!(thread_is_active(
        &threads,
        "C1:1.0",
        t0 + ACTIVE_THREAD_IDLE_TTL
    ));

    // Remembering anything after the TTL drops the idle threads.
    remember_active_thread(
        &mut threads,
        "C1:3.0".to_owned(),
        t0 + ACTIVE_THREAD_IDLE_TTL * 2,
    );
    assert_eq!(threads.len(), 1);
    assert!(threads.contains_key("C1:3.0"));

    // The map never grows past the cap; the least recently used goes first.
    let mut threads = HashMap::new();
    for index in 0..=MAX_ACTIVE_THREADS {
        let seconds = u64::try_from(index).expect("index fits u64");
        remember_active_thread(
            &mut threads,
            format!("C1:{index}"),
            t0 + Duration::from_secs(seconds),
        );
    }
    assert_eq!(threads.len(), MAX_ACTIVE_THREADS);
    assert!(!threads.contains_key("C1:0"));
    assert!(threads.contains_key(&format!("C1:{MAX_ACTIVE_THREADS}")));

    // Refreshing an existing thread at the cap evicts nothing.
    let refreshed = t0 + Duration::from_secs(10_000);
    remember_active_thread(&mut threads, "C1:1".to_owned(), refreshed);
    assert_eq!(threads.len(), MAX_ACTIVE_THREADS);
    assert_eq!(threads.get("C1:1"), Some(&refreshed));
    // ...and the refreshed thread survives the next eviction.
    remember_active_thread(&mut threads, "C1:new".to_owned(), refreshed);
    assert!(threads.contains_key("C1:1"));
    assert!(!threads.contains_key("C1:2"));
}

#[test]
fn conversation_key_packs_channel_and_thread() {
    assert_eq!(
        conversation_key("C999", Some(&pack_message_id("111.222", None))),
        "C999:111.222"
    );
    assert_eq!(
        conversation_key("C999", Some(&pack_message_id("333.444", Some("111.222")))),
        "C999:111.222"
    );
    // Idempotent: an already-packed key is not re-rooted.
    assert_eq!(
        conversation_key("C999:111.222", Some("999.999")),
        "C999:111.222"
    );
    // With nothing to anchor on, the channel itself is the conversation.
    assert_eq!(conversation_key("C999", None), "C999");
}

#[test]
fn parse_envelope_id_reads_field() {
    let raw = json!({ "envelope_id": "abc-123", "type": "events_api" }).to_string();
    assert_eq!(parse_envelope_id(&raw).as_deref(), Some("abc-123"));
}

#[test]
fn parse_inbound_extracts_message() {
    let raw = json!({
        "type": "events_api",
        "envelope_id": "e1",
        "payload": {
            "event": {
            "type": "message",
                "channel": "C999",
                "user": "U1",
                "text": "hello bot",
                "ts": "111.222"
            }
        }
    })
    .to_string();
    let inbound = parse_inbound(&raw).unwrap();
    assert_eq!(inbound.text, "hello bot");
    // The chat id is the BARE channel — the group allowlist is keyed on it —
    // and the thread only appears in the conversation key.
    assert_eq!(inbound.channel, "C999");
    assert_eq!(inbound.sender_id.as_deref(), Some("U1"));
    assert_eq!(
        conversation_key(&inbound.channel, inbound.message_id.as_deref()),
        "C999:111.222"
    );
}

#[test]
fn parse_inbound_prefers_existing_thread() {
    let raw = json!({
        "type": "events_api",
        "payload": {
            "event": {
                "type": "message",
                "subtype": "bot_message",
                "channel": "C999",
                "text": "in a thread",
                "ts": "333.444",
                "thread_ts": "111.222"
            }
        }
    })
    .to_string();
    let inbound = parse_inbound(&raw).unwrap();
    assert_eq!(
        conversation_key(&inbound.channel, inbound.message_id.as_deref()),
        "C999:111.222"
    );
}

#[test]
fn parse_inbound_ignores_bot_messages() {
    let raw = json!({
        "type": "events_api",
        "payload": {
            "event": {
                "type": "message",
                "channel": "C999",
                "bot_id": "B1",
                "text": "i am a bot",
                "ts": "1.2"
            }
        }
    })
    .to_string();
    let inbound = parse_inbound(&raw).expect("bot messages remain available for allow_bots");
    assert!(inbound.is_bot);
    assert!(decide_reply_with_options(
        &inbound,
        GroupReplyMode::All,
        "U999",
        false,
        &SlackChannelOptions::default(),
    )
    .is_none());
}

#[test]
fn parse_inbound_ignores_subtype_messages() {
    let raw = json!({
        "type": "events_api",
        "payload": {
            "event": {
                "type": "message",
                "subtype": "channel_join",
                "channel": "C999",
                "text": "joined",
                "ts": "1.2"
            }
        }
    })
    .to_string();
    assert!(parse_inbound(&raw).is_none());
}

#[test]
fn parse_inbound_ignores_non_events_frames() {
    let hello = json!({ "type": "hello" }).to_string();
    assert!(parse_inbound(&hello).is_none());
}

#[test]
fn slash_commands_are_addressed_without_a_message_thread_anchor() {
    let raw = json!({
        "type": "slash_commands",
        "payload": {
            "command": "/hermes",
            "text": "status",
            "channel_id": "C999",
            "channel_name": "general",
            "user_id": "U1",
            "trigger_id": "123.456.789"
        }
    })
    .to_string();
    let inbound = parse_slash_command(&raw).unwrap();
    assert!(inbound.force_reply);
    assert_eq!(inbound.message_id, None);
    assert_eq!(
        conversation_key(&inbound.channel, inbound.message_id.as_deref()),
        "C999"
    );
    assert_eq!(
        decide_reply(&inbound, GroupReplyMode::Mentions, "UBOT", false).as_deref(),
        Some("/hermes status")
    );
}

/// Verify that the conversation key derived from `parse_inbound` is stable per
/// channel/thread — the same raw frame always yields the same conversation_id
/// so multi-turn context is preserved across messages in the same thread.
#[test]
fn parse_inbound_chat_id_stable_per_thread() {
    let frame = json!({
        "type": "events_api",
        "envelope_id": "e1",
        "payload": {
            "event": {
                "type": "message",
                "channel": "C999",
                "user": "U1",
                "text": "turn two",
                "ts": "555.666",
                "thread_ts": "111.222"
            }
        }
    })
    .to_string();
    let key = |raw: &str| {
        let parsed = parse_inbound(raw).unwrap();
        conversation_key(&parsed.channel, parsed.message_id.as_deref())
    };
    // conversation_id must be deterministic for the same channel+thread…
    assert_eq!(key(&frame), key(&frame));
    // …and encode both the channel and the thread timestamp so Core can key
    // separate conversations per thread.
    assert_eq!(key(&frame), "C999:111.222");
}

/// Verify that two messages in different threads produce different
/// conversation keys so their Core conversations are kept separate.
#[test]
fn parse_inbound_different_threads_get_different_chat_ids() {
    let frame = |ts: &str, thread: &str| {
        json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "C999",
                    "text": "hello",
                    "ts": ts,
                    "thread_ts": thread
                }
            }
        })
        .to_string()
    };
    let key = |raw: String| {
        let parsed = parse_inbound(&raw).unwrap();
        conversation_key(&parsed.channel, parsed.message_id.as_deref())
    };
    assert_ne!(key(frame("1.1", "1.0")), key(frame("2.1", "2.0")));
}

// ─── Media (a file upload arrives as subtype `file_share`, which the old
// "any subtype ⇒ ignore" rule dropped on the floor) ─────────────────────────

#[test]
fn parse_inbound_accepts_a_caption_less_file_share() {
    let raw = json!({
        "type": "events_api",
        "payload": {
            "event": {
                "type": "message",
                "subtype": "file_share",
                "channel": "C999",
                "user": "U1",
                "text": "",
                "ts": "1.2",
                "files": [{
                    "id": "F1",
                    "name": "diagram.png",
                    "mimetype": "image/png",
                    "size": 4096,
                    "url_private": "https://files.slack.com/private",
                    "url_private_download": "https://files.slack.com/download"
                }]
            }
        }
    })
    .to_string();
    let inbound = parse_inbound(&raw).unwrap();
    assert!(inbound.text.is_empty());
    let file = &inbound.attachments[0];
    // The download URL is preferred: it serves bytes, not the viewer page.
    assert_eq!(
        file.url.as_deref(),
        Some("https://files.slack.com/download")
    );
    assert_eq!(file.filename.as_deref(), Some("diagram.png"));
    assert_eq!(file.size, Some(4096));
    assert_eq!(file.resolved_kind(), AttachmentKind::Image);
}

#[test]
fn parse_inbound_marks_a_voice_memo_as_speech() {
    let raw = json!({
        "type": "events_api",
        "payload": {
            "event": {
                "type": "message",
                "subtype": "file_share",
                "channel": "D1",
                "channel_type": "im",
                "user": "U1",
                "ts": "1.2",
                "files": [{
                    "id": "F2",
                    "name": "audio_message.webm",
                    "mimetype": "audio/webm",
                    "subtype": "slack_audio",
                    "url_private": "https://files.slack.com/private"
                }]
            }
        }
    })
    .to_string();
    let inbound = parse_inbound(&raw).unwrap();
    assert_eq!(
        inbound.attachments[0].resolved_kind(),
        AttachmentKind::Voice
    );
    // A media-only DM still routes: the transcript becomes the prompt.
    assert_eq!(
        decide_reply(&inbound, GroupReplyMode::Mentions, "UBOT", false).as_deref(),
        Some("")
    );
}

#[test]
fn parse_inbound_drops_an_empty_message_with_no_media() {
    let raw = json!({
        "type": "events_api",
        "payload": {
            "event": { "type": "message", "channel": "C999", "text": "   ", "ts": "1.2" }
        }
    })
    .to_string();
    assert!(parse_inbound(&raw).is_none());
}

#[test]
fn parse_inbound_flags_a_dm_via_channel_type() {
    let raw = json!({
        "type": "events_api",
        "payload": {
            "event": {
                "type": "message",
                "channel_type": "im",
                "channel": "D1",
                "user": "U1",
                "text": "hi",
                "ts": "1.1"
            }
        }
    })
    .to_string();
    assert!(parse_inbound(&raw).unwrap().is_dm);
}

/// The failure direction matters: an event with NO `channel_type` must be
/// treated as a group, or a pairing code could be posted in public.
#[test]
fn parse_inbound_treats_an_unlabelled_channel_as_a_group() {
    let raw = json!({
        "type": "events_api",
        "payload": {
            "event": {
                "type": "message",
                "channel": "C999",
                "user": "U1",
                "text": "hi",
                "ts": "1.1"
            }
        }
    })
    .to_string();
    assert!(!parse_inbound(&raw).unwrap().is_dm);
}

/// The loop guard the file-upload path made necessary: a file the bot itself
/// shared arrives back as an inbound `file_share`, and answering it would
/// transcribe the bot's own voice note and reply to it forever.
#[test]
fn a_message_the_bot_wrote_is_never_answered() {
    assert!(is_self_authored(Some("UBOT"), "UBOT"));
    assert!(!is_self_authored(Some("U1"), "UBOT"));
    assert!(!is_self_authored(None, "UBOT"));
    // Fail-open: with no known identity nothing is dropped as "our own",
    // exactly as the mention gate degrades.
    assert!(!is_self_authored(Some("UBOT"), ""));
    assert!(!is_self_authored(None, ""));
}

/// THE BITE: in `Mentions` mode an un-addressed channel message is now
/// dropped. Before this gate existed the adapter routed it to the agent.
#[test]
fn mentions_mode_ignores_unaddressed_channel_message() {
    let msg = channel_msg("just chatting with my colleague");
    assert!(decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).is_none());
}

#[test]
fn mentions_mode_answers_when_mentioned_and_strips_the_mention() {
    let msg = channel_msg("<@UBOT> what's   up");
    let routed = decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).unwrap();
    assert_eq!(routed, "what's up");

    // The `<@U…|name>` form Slack also emits.
    let piped = channel_msg("<@UBOT|ryu> hi");
    assert_eq!(
        decide_reply(&piped, GroupReplyMode::Mentions, "UBOT", false).unwrap(),
        "hi"
    );
}

/// A mention of SOMEONE ELSE is not a mention of the bot.
#[test]
fn mentions_mode_ignores_a_mention_of_another_user() {
    let msg = channel_msg("<@USOMEONE> can you look at this?");
    assert!(decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).is_none());
}

/// Once the bot is in a thread, follow-ups continue without a re-mention.
#[test]
fn mentions_mode_continues_an_active_thread_without_a_mention() {
    let msg = channel_msg("and what about tuesday?");
    let routed = decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", true).unwrap();
    assert_eq!(routed, "and what about tuesday?");
}

#[test]
fn all_mode_answers_every_channel_message() {
    let msg = channel_msg("just chatting");
    assert_eq!(
        decide_reply(&msg, GroupReplyMode::All, "UBOT", false).unwrap(),
        "just chatting"
    );
}

#[test]
fn dms_always_answer_regardless_of_mode() {
    let msg = dm("hello");
    assert_eq!(
        decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).unwrap(),
        "hello"
    );
}

/// Fail-open: `auth.test` failed, so the gate cannot be evaluated. A scope gap
/// must not silently turn an over-chatty bot into a dead one.
#[test]
fn unknown_bot_id_fails_open_in_mentions_mode() {
    let msg = channel_msg("just chatting");
    assert_eq!(
        decide_reply(&msg, GroupReplyMode::Mentions, "", false).unwrap(),
        "just chatting"
    );
    // ...and an empty bot id never matches a bare mention of anyone.
    assert!(!mentions_bot("<@USOMEONE> hey", ""));
}
