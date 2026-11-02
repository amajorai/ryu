use super::*;

#[tokio::test]
async fn webhook_claims_before_ack_and_suppresses_duplicate_updates() {
    let channel = Arc::new(
        TelegramChannel::new(
            make_cfg("token"),
            reqwest::Client::new(),
            PairingStore::ephemeral(),
        )
        .unwrap(),
    );
    let (tx, mut rx) = mpsc::channel(2);
    let state = TelegramWebhookState {
        tx,
        secret: "secret".to_string(),
        channel: Arc::downgrade(&channel),
    };
    let body = Bytes::from_static(br#"{"update_id":42}"#);
    let mut headers = HeaderMap::new();
    headers.insert("x-telegram-bot-api-secret-token", "secret".parse().unwrap());

    assert_eq!(
        telegram_webhook(State(state.clone()), headers.clone(), body.clone()).await,
        StatusCode::OK
    );
    let pending = rx.try_recv().expect("first update should be queued");
    assert_eq!(pending.update.update_id, 42);

    assert_eq!(
        telegram_webhook(State(state), headers, body).await,
        StatusCode::OK
    );
    assert!(
        rx.try_recv().is_err(),
        "the retry must not enqueue a second update"
    );
    assert_eq!(
        channel
            .runtime
            .pairing
            .claim_delivery("telegram", "telegram:update:42")
            .await
            .unwrap(),
        crate::pairing::DeliveryClaim::InFlight
    );
}

#[test]
fn webhook_secret_matches_only_the_exact_secret() {
    assert!(webhook_secret_matches("s3cr3t-Token_9", "s3cr3t-Token_9"));
    for wrong in [
        "",
        "s",
        "s3cr3t-Token_",
        "s3cr3t-Token_9x",
        "s3cr3t-Token_8",
        "S3CR3T-TOKEN_9",
        " s3cr3t-Token_9",
    ] {
        assert!(
            !webhook_secret_matches("s3cr3t-Token_9", wrong),
            "{wrong:?} must not match the configured secret"
        );
    }
}

#[tokio::test]
async fn webhook_rejects_a_wrong_or_missing_secret_token() {
    let channel = Arc::new(
        TelegramChannel::new(
            make_cfg("token"),
            reqwest::Client::new(),
            PairingStore::ephemeral(),
        )
        .unwrap(),
    );
    let (tx, mut rx) = mpsc::channel(2);
    let state = TelegramWebhookState {
        tx,
        secret: "secret".to_string(),
        channel: Arc::downgrade(&channel),
    };
    let body = Bytes::from_static(br#"{"update_id":7}"#);

    assert_eq!(
        telegram_webhook(State(state.clone()), HeaderMap::new(), body.clone()).await,
        StatusCode::UNAUTHORIZED,
        "a request without the header must be refused"
    );
    for wrong in ["secre", "secrets", "secreT"] {
        let mut headers = HeaderMap::new();
        headers.insert("x-telegram-bot-api-secret-token", wrong.parse().unwrap());
        assert_eq!(
            telegram_webhook(State(state.clone()), headers, body.clone()).await,
            StatusCode::UNAUTHORIZED,
            "{wrong:?} must be refused"
        );
    }
    assert!(
        rx.try_recv().is_err(),
        "a refused request must not enqueue an update"
    );
}

// ─── decide_reply: the group gate ───────────────────────────────────────

#[test]
fn private_chat_always_replies_with_raw_text() {
    let message = Message {
        chat: Chat {
            id: 1,
            chat_type: "private".to_string(),
        },
        text: Some("hello".to_string()),
        ..Default::default()
    };
    let routed = decide_reply(&message, "hello", &me(), GroupReplyMode::Mentions);
    assert_eq!(routed.as_deref(), Some("hello"));
}

#[test]
fn group_mentions_mode_ignores_unaddressed_message() {
    let message = group_message("just chatting", "Ada");
    assert!(decide_reply(&message, "just chatting", &me(), GroupReplyMode::Mentions).is_none());
}

#[test]
fn group_mentions_mode_replies_when_mentioned_and_strips_mention() {
    let raw = "@ryubot what is 2+2";
    let message = group_message(raw, "Ada");
    let routed = decide_reply(&message, raw, &me(), GroupReplyMode::Mentions);
    // Mention stripped, speaker prefixed.
    assert_eq!(routed.as_deref(), Some("Ada: what is 2+2"));
}

#[test]
fn group_mentions_mode_replies_to_command() {
    let raw = "/help";
    let message = group_message(raw, "Ada");
    let routed = decide_reply(&message, raw, &me(), GroupReplyMode::Mentions);
    assert_eq!(routed.as_deref(), Some("Ada: /help"));
}

#[test]
fn group_command_detection_accepts_the_bot_suffixed_form() {
    // What a Telegram client actually sends in a group.
    let raw = "/help@ryubot";
    let message = group_message(raw, "Ada");
    // The mention is stripped as part of the reply text, leaving the command.
    let routed = decide_reply(&message, raw, &me(), GroupReplyMode::Mentions);
    assert_eq!(routed.as_deref(), Some("Ada: /help"));

    // A lone slash is not a command and must not open the group gate.
    let bare = group_message("/", "Ada");
    assert!(decide_reply(&bare, "/", &me(), GroupReplyMode::Mentions).is_none());
}

#[test]
fn group_mentions_mode_replies_to_a_reply_to_the_bot() {
    let mut message = group_message("thanks", "Ada");
    message.reply_to_message = Some(Box::new(Message {
        chat: Chat {
            id: 42,
            chat_type: "supergroup".to_string(),
        },
        text: Some("earlier bot reply".to_string()),
        from: Some(TgUser {
            id: 999,
            first_name: "Ryu".to_string(),
            ..Default::default()
        }),
        ..Default::default()
    }));
    let routed = decide_reply(&message, "thanks", &me(), GroupReplyMode::Mentions);
    assert_eq!(routed.as_deref(), Some("Ada: thanks"));
}

#[test]
fn group_all_mode_replies_to_every_message() {
    let message = group_message("just chatting", "Ada");
    let routed = decide_reply(&message, "just chatting", &me(), GroupReplyMode::All);
    assert_eq!(routed.as_deref(), Some("Ada: just chatting"));
}

#[test]
fn a_media_only_group_message_is_still_a_turn() {
    // A caption-less photo in an `All`-mode group: the text is empty but the
    // message is not, and dropping it would ignore what the operator asked
    // for. It routes with no text; the attachment becomes the prompt.
    let mut photo = group_message("", "Ada");
    photo.text = None;
    photo.photo = vec![TgFile {
        file_id: "p1".to_string(),
        ..Default::default()
    }];
    assert_eq!(
        decide_reply(&photo, "", &me(), GroupReplyMode::All).as_deref(),
        Some("")
    );

    // The same photo captioned only with the bot's @mention, in Mentions
    // mode: addressed, empty once stripped, still a real "look at this".
    let mut mentioned = photo;
    mentioned.text = Some("@ryubot".to_string());
    assert_eq!(
        decide_reply(&mentioned, "@ryubot", &me(), GroupReplyMode::Mentions).as_deref(),
        Some("")
    );

    // With nothing attached there is genuinely nothing to route.
    let empty = group_message("@ryubot", "Ada");
    assert!(decide_reply(&empty, "@ryubot", &me(), GroupReplyMode::Mentions).is_none());
}

#[test]
fn empty_identity_disables_mention_detection_but_allows_commands() {
    let empty = BotIdentity::default();
    let message = group_message("@ryubot hi", "Ada");
    // Without an identity the @mention can't be recognised → ignored.
    assert!(decide_reply(&message, "@ryubot hi", &empty, GroupReplyMode::Mentions).is_none());
    // Commands still work (identity-independent).
    let cmd = group_message("/start", "Ada");
    assert!(decide_reply(&cmd, "/start", &empty, GroupReplyMode::Mentions).is_some());
}

// ─── Construction ───────────────────────────────────────────────────────

#[test]
fn new_rejects_empty_token() {
    let result = TelegramChannel::new(
        make_cfg("   "),
        reqwest::Client::new(),
        PairingStore::ephemeral(),
    );
    assert!(result.is_err());
}

#[test]
fn new_builds_api_and_file_bases_from_token() {
    let mut cfg = make_cfg("123:ABC");
    cfg.common.system_prompt = Some("hi".to_string());
    let channel =
        TelegramChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral()).unwrap();
    assert_eq!(channel.api_base, "https://api.telegram.org/bot123:ABC");
    assert_eq!(
        channel.file_base,
        "https://api.telegram.org/file/bot123:ABC"
    );
    assert_eq!(channel.name(), "telegram");
    assert_eq!(channel.model(), "gpt-4o");
    assert_eq!(channel.system_prompt(), Some("hi"));
}

// ─── 401 classification: a replaced token must stop the adapter ─────────

#[test]
fn http_401_is_unauthorized() {
    assert!(is_unauthorized(
        Some(reqwest::StatusCode::UNAUTHORIZED),
        None
    ));
}

#[test]
fn envelope_error_code_401_is_unauthorized() {
    // The Bot API rejects a dead token with HTTP 200 + ok:false, so the
    // envelope must classify the same as the status code.
    assert!(is_unauthorized(Some(reqwest::StatusCode::OK), Some(401)));
}

#[test]
fn other_failures_are_not_unauthorized() {
    // 429 and 5xx are exactly the cases the adapter must keep backing off on
    // rather than tearing itself down for a token refresh.
    assert!(!is_unauthorized(
        Some(reqwest::StatusCode::TOO_MANY_REQUESTS),
        None
    ));
    assert!(!is_unauthorized(
        Some(reqwest::StatusCode::BAD_GATEWAY),
        None
    ));
    assert!(!is_unauthorized(Some(reqwest::StatusCode::OK), Some(400)));
    assert!(!is_unauthorized(None, None));
}

#[test]
fn get_updates_response_reads_the_error_code() {
    let body: GetUpdatesResponse =
        serde_json::from_value(json!({ "ok": false, "error_code": 401 })).unwrap();
    assert!(!body.ok);
    assert!(is_unauthorized(None, body.error_code));
}

#[test]
fn get_updates_response_without_an_error_code_still_parses() {
    // An older/other rejection carries only a description; a missing
    // `error_code` must not fail the whole batch parse.
    let body: GetUpdatesResponse =
        serde_json::from_value(json!({ "ok": true, "result": [] })).unwrap();
    assert!(body.ok);
    assert!(body.error_code.is_none());
}

#[test]
fn token_rejected_survives_a_context_wrap() {
    // The supervisor classifies by walking the chain, so an adapter is free
    // to annotate the error on the way out.
    let err = anyhow::Error::from(TokenRejected).context("telegram getUpdates");
    assert!(is_token_rejected(&err));
}

#[test]
fn a_plain_transport_error_is_not_token_rejected() {
    let err = anyhow::anyhow!("connection reset");
    assert!(!is_token_rejected(&err));
}

#[test]
fn token_rejected_never_names_the_token() {
    // The whole point of the payload-free marker: the failing URL contains
    // the token, and this string is logged and shipped to the control plane.
    let rendered = TokenRejected.to_string();
    assert!(!rendered.contains("api.telegram.org"));
    assert!(rendered.contains("401"));
}

#[test]
fn new_stores_the_core_route() {
    let mut cfg = make_cfg("tok:1");
    cfg.common.agent_id = Some("acp:pi".to_string());
    let channel =
        TelegramChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral()).unwrap();
    assert!(channel.runtime().routes_via_core());
    assert_eq!(channel.runtime().cfg.core_url, "http://127.0.0.1:7980");
}

#[test]
fn caps_declare_the_full_telegram_surface() {
    let channel = TelegramChannel::new(
        make_cfg("t:1"),
        reqwest::Client::new(),
        PairingStore::ephemeral(),
    )
    .unwrap();
    let caps = channel.caps();
    assert!(caps.typing && caps.rich_text && caps.streaming && caps.threads);
    assert!(caps.command_menu && caps.voice && caps.attachments && caps.reactions);
    // Under Telegram's 5s chat-action expiry, or the indicator visibly gaps.
    assert!(channel.typing_interval() < Duration::from_secs(5));
}

// ─── Thread packing ─────────────────────────────────────────────────────

#[test]
fn thread_is_packed_off_a_message_and_unpacked_for_the_api() {
    let mut message = group_message("hi", "Ada");
    message.message_thread_id = Some(77);

    let tag = thread_of(&message);
    assert_eq!(tag.as_deref(), Some("t77"));
    let key = pack_thread(&message.chat.id.to_string(), tag.as_deref());
    assert_eq!(key, "42:t77");

    let (chat, thread) = target(&key).unwrap();
    assert_eq!(chat, 42);
    assert_eq!(thread_params(thread), (Some(77), None));
}

#[test]
fn direct_messages_topic_maps_to_its_own_parameter() {
    let mut message = group_message("hi", "Ada");
    message.message_thread_id = Some(5);
    message.direct_messages_topic = Some(DirectMessagesTopic { topic_id: 9 });
    // The more specific of the two wins.
    assert_eq!(thread_of(&message).as_deref(), Some("d9"));
    assert_eq!(thread_params(Some("d9")), (None, Some(9)));
}

#[test]
fn a_threadless_chat_round_trips_unchanged() {
    let message = group_message("hi", "Ada");
    assert!(thread_of(&message).is_none());
    let key = pack_thread("-1001", None);
    assert_eq!(key, "-1001");
    let (chat, thread) = target(&key).unwrap();
    assert_eq!(chat, -1001);
    assert!(thread.is_none());
    assert_eq!(thread_params(thread), (None, None));
}

#[test]
fn an_unrecognised_thread_tag_degrades_to_the_room() {
    // A key written by an older or newer build must not fail the send.
    assert_eq!(thread_params(Some("zzz")), (None, None));
    assert_eq!(thread_params(Some("tnot-a-number")), (None, None));
    assert!(target("not-a-chat").is_err());
}

// ─── Payload building ───────────────────────────────────────────────────

#[test]
fn message_payload_carries_the_topic() {
    let plain = message_payload(42, None, "hi");
    assert_eq!(plain["chat_id"], 42);
    assert_eq!(plain["text"], "hi");
    assert!(plain.get("message_thread_id").is_none());

    let threaded = message_payload(42, Some("t7"), "hi");
    assert_eq!(threaded["message_thread_id"], 7);

    let dm = message_payload(42, Some("d7"), "hi");
    assert_eq!(dm["direct_messages_topic_id"], 7);
    assert!(dm.get("message_thread_id").is_none());
}

#[test]
fn interactive_payloads_render_both_button_layouts() {
    let reply = InteractiveMarkup {
        layout: InteractiveLayout::ReplyKeyboard,
        rows: vec![vec![crate::InteractiveButton {
            label: "Option 1".to_owned(),
            action: InteractiveAction::Reply,
        }]],
    };
    let reply_payload = interactive_payload(42, None, "Choose an option", &reply).unwrap();
    assert_eq!(
        reply_payload["reply_markup"]["keyboard"][0][0]["text"],
        "Option 1"
    );
    assert_eq!(reply_payload["reply_markup"]["resize_keyboard"], true);

    let inline = InteractiveMarkup {
        layout: InteractiveLayout::Inline,
        rows: vec![vec![crate::InteractiveButton {
            label: "Approve".to_owned(),
            action: InteractiveAction::Callback {
                action_id: "review.approve".to_owned(),
                payload: json!({ "requestId": "7" }),
            },
        }]],
    };
    let inline_payload =
        interactive_payload(42, Some("t7"), "Review this request", &inline).unwrap();
    assert_eq!(inline_payload["message_thread_id"], 7);
    let callback_data = inline_payload["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
        .as_str()
        .unwrap();
    assert_eq!(
        decode_callback_data(callback_data).unwrap(),
        ChannelActionEvent {
            action_id: "review.approve".to_owned(),
            label: "Approve".to_owned(),
            payload: json!({ "requestId": "7" }),
        }
    );
}
