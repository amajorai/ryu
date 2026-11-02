use super::*;

#[tokio::test]
async fn callback_update_routes_typed_action_and_sends_returned_buttons() {
    use crate::pairing::{AccessPolicy, DmPolicy};
    use axum::extract::Path;

    async fn telegram_api(
        Path((_token, method)): Path<(String, String)>,
        State(calls): State<mpsc::UnboundedSender<(String, Value)>>,
        axum::Json(body): axum::Json<Value>,
    ) -> axum::Json<Value> {
        let result = if method == "sendMessage" {
            json!({ "message_id": 89 })
        } else {
            json!(true)
        };
        let _ = calls.send((method, body));
        axum::Json(json!({ "ok": true, "result": result }))
    }

    let (core_tx, mut core_rx) = mpsc::unbounded_channel();
    let core_app = Router::new().route(
        "/api/channels/run",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let core_tx = core_tx.clone();
            async move {
                let _ = core_tx.send(body);
                axum::Json(json!({
                    "reply": "Choose what to do next.",
                    "assistantMessageId": "assistant-1",
                    "assistantMessageIds": ["assistant-1"],
                    "interactiveMarkup": {
                        "layout": "inline",
                        "rows": [[{
                            "label": "Continue",
                            "action": {
                                "type": "callback",
                                "actionId": "workflow.continue",
                                "payload": { "ticketId": "42" }
                            }
                        }]]
                    }
                }))
            }
        }),
    );
    let core_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let core_url = format!("http://{}", core_listener.local_addr().unwrap());
    let core_server = tokio::spawn(async move {
        axum::serve(core_listener, core_app).await.unwrap();
    });

    let (telegram_tx, mut telegram_rx) = mpsc::unbounded_channel();
    let telegram_app = Router::new()
        .route("/:token/:method", axum::routing::post(telegram_api))
        .with_state(telegram_tx);
    let telegram_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let telegram_base = format!(
        "http://{}/bot-test",
        telegram_listener.local_addr().unwrap()
    );
    let telegram_server = tokio::spawn(async move {
        axum::serve(telegram_listener, telegram_app).await.unwrap();
    });

    let mut config = make_cfg("test-token");
    config.common.core_url = core_url;
    config.common.channel_id = Some("channel-test".to_owned());
    config.common.access = AccessPolicy {
        dm: DmPolicy::Open,
        ..Default::default()
    };
    config.options.base_url = Some(telegram_base);
    let channel = Arc::new(
        TelegramChannel::new(
            config,
            reqwest::Client::new(),
            crate::pairing::PairingStore::ephemeral(),
        )
        .unwrap(),
    );

    let action = ChannelActionEvent {
        action_id: "workflow.continue".to_owned(),
        label: "Continue".to_owned(),
        payload: json!({ "ticketId": "42" }),
    };
    let callback_data = encode_callback_data(&action).unwrap();
    channel.dispatch_update(
        Arc::new(TestHost),
        Update {
            update_id: 54,
            callback_query: Some(CallbackQuery {
                id: "callback-54".to_owned(),
                from: TgUser {
                    id: 7,
                    first_name: "Ada".to_owned(),
                    ..Default::default()
                },
                message: Some(Message {
                    chat: Chat {
                        id: 42,
                        chat_type: "private".to_owned(),
                    },
                    message_id: 88,
                    reply_markup: Some(json!({
                        "inline_keyboard": [[{
                            "text": "Continue",
                            "callback_data": callback_data.clone()
                        }]]
                    })),
                    ..Default::default()
                }),
                data: Some(callback_data),
            }),
            ..Default::default()
        },
        &me(),
        None,
    );

    let core_request = tokio::time::timeout(Duration::from_secs(3), core_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(core_request["text"], "Selected: Continue");
    assert_eq!(
        core_request["channelAction"]["actionId"],
        "workflow.continue"
    );
    assert_eq!(core_request["channelAction"]["payload"]["ticketId"], "42");

    let mut methods = Vec::new();
    let mut sent_markup = None;
    for _ in 0..4 {
        let (method, body) = tokio::time::timeout(Duration::from_secs(3), telegram_rx.recv())
            .await
            .unwrap()
            .unwrap();
        if method == "sendMessage" {
            sent_markup = Some(body["reply_markup"].clone());
        }
        methods.push(method);
        if methods.iter().any(|method| method == "answerCallbackQuery") && sent_markup.is_some() {
            break;
        }
    }
    assert!(methods.iter().any(|method| method == "answerCallbackQuery"));
    assert!(
        sent_markup.is_some(),
        "Telegram methods called: {methods:?}"
    );
    assert_eq!(
        sent_markup.unwrap()["inline_keyboard"][0][0]["text"],
        "Continue"
    );

    core_server.abort();
    telegram_server.abort();
}

#[test]
fn rich_payload_sends_markdown_and_nothing_else() {
    let payload = rich_payload(42, Some("t7"), "# Title\n\n- a");
    assert_eq!(payload["chat_id"], 42);
    assert_eq!(payload["message_thread_id"], 7);
    assert_eq!(payload["rich_message"]["markdown"], "# Title\n\n- a");
    // InputRichMessage takes EXACTLY ONE of html/markdown/blocks.
    let rich = payload["rich_message"].as_object().unwrap();
    assert_eq!(rich.len(), 1);
    assert!(!rich.contains_key("html") && !rich.contains_key("blocks"));
}

#[test]
fn draft_payload_uses_the_plain_placeholder_when_empty() {
    // Empty text is the documented "Thinking…" placeholder, and only the
    // plain draft method expresses it.
    let (method, payload) = draft_payload(42, None, 5, "", true);
    assert_eq!(method, "sendMessageDraft");
    assert_eq!(payload["text"], "");
    assert_eq!(payload["draft_id"], 5);

    // A partial with rich text on uses the rich draft method.
    let (method, payload) = draft_payload(42, Some("t7"), 5, "partial", true);
    assert_eq!(method, "sendRichMessageDraft");
    assert_eq!(payload["rich_message"]["markdown"], "partial");
    assert_eq!(payload["message_thread_id"], 7);

    // Rich text off keeps the plain method for a partial too.
    let (method, payload) = draft_payload(42, None, 5, "partial", false);
    assert_eq!(method, "sendMessageDraft");
    assert_eq!(payload["text"], "partial");
}

#[test]
fn commands_payload_is_a_bot_command_array() {
    let cmds = vec![
        ChannelCommand {
            name: "proof".to_string(),
            description: "prove it".to_string(),
            source: "plugin".to_string(),
        },
        ChannelCommand {
            name: "goal".to_string(),
            description: "set a goal".to_string(),
            source: "builtin".to_string(),
        },
    ];
    let payload = commands_payload(&cmds);
    let list = payload["commands"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["command"], "proof");
    assert_eq!(list[0]["description"], "prove it");
    // `source` is Ryu-internal and has no place in a BotCommand.
    assert!(list[0].get("source").is_none());
}

#[test]
fn guest_reply_payload_is_an_inline_article() {
    let payload = guest_reply_payload("q-123", "the answer");
    assert_eq!(payload["guest_query_id"], "q-123");
    assert_eq!(payload["result"]["type"], "article");
    assert_eq!(
        payload["result"]["input_message_content"]["message_text"],
        "the answer"
    );
    // InlineQueryResult.id is capped at 64 bytes; a constant cannot bust it.
    assert!(payload["result"]["id"].as_str().unwrap().len() <= 64);
}

#[test]
fn guest_turns_are_keyed_on_the_query_id_not_the_chat() {
    let message: Message = serde_json::from_value(json!({
        "chat": { "id": 99, "type": "private" },
        "message_id": 3,
        "guest_query_id": "gq-7",
        "text": "hello there",
        "from": { "id": 5, "first_name": "Ada" }
    }))
    .unwrap();

    let inbound = guest_inbound(&message).unwrap();
    // The CONVERSATION is the query…
    assert_eq!(inbound.chat_id, "guest#gq-7");
    // …but the pairing IDENTITY is the person, or every guest message would
    // present as a new stranger and mint a pairing code nobody can use.
    assert_eq!(inbound.identity(), "5");
    assert_eq!(inbound.author_name.as_deref(), Some("Ada"));
    assert!(!inbound.is_group);
    // The chat id (99) must never surface — the docs warn it may collide
    // with an unrelated chat.
    assert!(!inbound.chat_id.contains("99"));
    assert_eq!(guest_query_of(&inbound.chat_id), Some("gq-7"));
    assert_eq!(guest_query_of("42:t7"), None);

    // With no sender, `identity()` falls back to the conversation key —
    // closed-by-default, same as any unknown DM.
    let anonymous: Message = serde_json::from_value(json!({
        "chat": { "id": 99 },
        "guest_query_id": "gq-8",
        "text": "hi"
    }))
    .unwrap();
    assert_eq!(guest_inbound(&anonymous).unwrap().identity(), "guest#gq-8");

    // A message with no query id is not a guest turn.
    let plain = Message::default();
    assert!(guest_inbound(&plain).is_none());
}

// ─── Inbound media ──────────────────────────────────────────────────────

#[test]
fn attachment_parsing_reads_every_media_field() {
    let message: Message = serde_json::from_value(json!({
        "chat": { "id": 1, "type": "private" },
        "message_id": 8,
        "voice": { "file_id": "v1", "mime_type": "audio/ogg", "file_size": 2048 },
        "photo": [
            { "file_id": "small", "file_size": 100 },
            { "file_id": "large", "file_size": 900 }
        ],
        "document": { "file_id": "d1", "mime_type": "application/pdf", "file_name": "spec.pdf" }
    }))
    .unwrap();

    let attachments = attachments_from(&message);
    assert_eq!(attachments.len(), 3);

    let voice = &attachments[0];
    assert_eq!(voice.resolved_kind(), AttachmentKind::Voice);
    assert!(voice.resolved_kind().is_speech());
    assert_eq!(voice.file_id.as_deref(), Some("v1"));
    assert_eq!(voice.size, Some(2048));
    // No filename on a voice note; the MIME gives it a usable extension.
    assert_eq!(voice.safe_filename(), "audio.ogg");

    // The LARGEST photo size is taken — Telegram lists smallest first.
    let photo = &attachments[1];
    assert_eq!(photo.file_id.as_deref(), Some("large"));
    assert_eq!(photo.resolved_kind(), AttachmentKind::Image);
    assert!(!photo.resolved_kind().is_speech());

    // A document is classified by its MIME rather than assumed to be a file.
    let doc = &attachments[2];
    assert_eq!(doc.resolved_kind(), AttachmentKind::Document);
    assert_eq!(doc.filename.as_deref(), Some("spec.pdf"));

    // A text-only message has nothing to download.
    let bare: Message =
        serde_json::from_value(json!({ "chat": { "id": 1 }, "text": "hi" })).unwrap();
    assert!(attachments_from(&bare).is_empty());
}

#[test]
fn an_audio_document_is_still_transcribed() {
    // Telegram delivers an uncompressed voice recording as a document; the
    // MIME fallback is what keeps it on the speech path.
    let message: Message = serde_json::from_value(json!({
        "chat": { "id": 1 },
        "document": { "file_id": "d2", "mime_type": "audio/mpeg", "file_name": "note.mp3" }
    }))
    .unwrap();
    let attachments = attachments_from(&message);
    assert_eq!(attachments[0].resolved_kind(), AttachmentKind::Audio);
    assert!(attachments[0].resolved_kind().is_speech());
}

// ─── Wire parsing ───────────────────────────────────────────────────────

#[test]
fn parses_getupdates_response() {
    let raw = json!({
        "ok": true,
        "result": [
            {
                "update_id": 42,
                "message": {
                    "chat": { "id": 99 },
                    "text": "hello bot"
                }
            }
        ]
    });
    let parsed: GetUpdatesResponse = serde_json::from_value(raw).unwrap();
    assert!(parsed.ok);
    assert_eq!(parsed.result.len(), 1);
    let update = &parsed.result[0];
    assert_eq!(update.update_id, 42);
    let message = update.message.as_ref().unwrap();
    assert_eq!(message.chat.id, 99);
    assert_eq!(message.text.as_deref(), Some("hello bot"));
    // Absent optional fields must parse as "not present".
    assert!(message.message_thread_id.is_none());
    assert!(message.voice.is_none());
    assert_eq!(message.message_id, 0);
}

#[test]
fn parses_reaction_updates_without_treating_them_as_new_messages() {
    let raw = json!({
        "update_id": 43,
        "message_reaction": {
            "chat": { "id": 99, "type": "private" },
            "message_id": 17,
            "user": { "id": 7, "first_name": "Ada" },
            "new_reaction": [{ "type": "emoji", "emoji": "👍" }],
            "message_thread_id": 4
        }
    });
    let parsed: Update = serde_json::from_value(raw).unwrap();
    assert!(parsed.message.is_none());
    let reaction = parsed.message_reaction.expect("reaction update");
    assert_eq!(reaction.chat.id, 99);
    assert_eq!(reaction.message_id, 17);
    assert_eq!(reaction.user.as_ref().map(|user| user.id), Some(7));
    assert_eq!(reaction.message_thread_id, Some(4));
    assert_eq!(reaction.new_reaction[0].emoji.as_deref(), Some("👍"));
}

#[test]
fn a_rejected_call_is_visible_despite_http_200() {
    // The failure mode the fallback in `send_rich` depends on.
    let envelope: ApiEnvelope = serde_json::from_value(json!({
        "ok": false,
        "description": "Bad Request: method not found"
    }))
    .unwrap();
    assert!(!envelope.ok);
    assert_eq!(
        envelope.description.as_deref(),
        Some("Bad Request: method not found")
    );
}

#[test]
fn getme_exposes_the_bot_level_feature_flags() {
    let me: BotUser = serde_json::from_value(json!({
        "id": 999,
        "username": "ryubot",
        "has_topics_enabled": true,
        "supports_guest_queries": true
    }))
    .unwrap();
    assert!(me.has_topics_enabled && me.supports_guest_queries);

    // An older Bot API server omits both; they must default to false rather
    // than failing the whole getMe.
    let old: BotUser = serde_json::from_value(json!({ "id": 1 })).unwrap();
    assert!(!old.has_topics_enabled && !old.supports_guest_queries);
}

#[test]
fn retry_delay_waits_out_only_short_flood_control() {
    assert_eq!(
        retry_delay(reqwest::StatusCode::TOO_MANY_REQUESTS, &flood_envelope(7)),
        Some(Duration::from_secs(7))
    );
    // The envelope alone is enough: a rejected call may arrive with HTTP 200.
    assert_eq!(
        retry_delay(reqwest::StatusCode::OK, &flood_envelope(7)),
        Some(Duration::from_secs(7))
    );
    // Longer than the inline cap: fail now and leave it to the outer retry.
    assert_eq!(
        retry_delay(reqwest::StatusCode::TOO_MANY_REQUESTS, &flood_envelope(31)),
        None
    );
    let bad_request: ApiEnvelope = serde_json::from_value(json!({
        "ok": false,
        "error_code": 400,
        "description": "Bad Request: chat not found",
        "parameters": { "retry_after": 7 }
    }))
    .unwrap();
    assert_eq!(
        retry_delay(reqwest::StatusCode::BAD_REQUEST, &bad_request),
        None
    );
    let no_wait: ApiEnvelope =
        serde_json::from_value(json!({ "ok": false, "error_code": 429 })).unwrap();
    assert_eq!(
        retry_delay(reqwest::StatusCode::TOO_MANY_REQUESTS, &no_wait),
        None
    );
}

#[tokio::test]
async fn flood_control_is_waited_out_and_retried_once() {
    let (channel, calls, server) = channel_with_mock_bot_api(Arc::new(|_, earlier| {
        if earlier == 0 {
            flood_control()
        } else {
            sent(5)
        }
    }))
    .await;
    let ids = channel.send_text_with_ids("42", "hello").await.unwrap();
    assert_eq!(ids, vec!["5".to_owned()]);
    assert_eq!(calls.lock().unwrap().len(), 2);
    server.abort();

    let (channel, calls, server) =
        channel_with_mock_bot_api(Arc::new(|_, _| flood_control())).await;
    let error = channel
        .send_text_with_ids("42", "hello")
        .await
        .expect_err("a second 429 must fail the call");
    assert!(error.to_string().contains("Too Many Requests"));
    assert_eq!(
        calls.lock().unwrap().len(),
        2,
        "flood control is retried in place exactly once"
    );
    server.abort();
}

#[tokio::test]
async fn a_429_without_an_envelope_still_names_the_status_and_is_not_retried() {
    let (channel, calls, server) = channel_with_mock_bot_api(Arc::new(|_, _| {
        (StatusCode::TOO_MANY_REQUESTS, json!("Too Many Requests"))
    }))
    .await;
    let error = channel
        .send_text_with_ids("42", "hello")
        .await
        .expect_err("a 429 must fail the call");
    assert!(error.to_string().contains("HTTP 429"), "{error}");
    assert!(!error.to_string().contains("test-token"), "{error}");
    assert_eq!(calls.lock().unwrap().len(), 1);
    server.abort();
}
