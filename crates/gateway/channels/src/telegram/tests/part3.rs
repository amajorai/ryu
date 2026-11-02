use super::*;

#[tokio::test]
async fn rich_fallback_sends_only_the_undelivered_chunks_as_plain_text() {
    let (channel, calls, server) =
        channel_with_mock_bot_api(Arc::new(|method, earlier| match (method, earlier) {
            ("sendRichMessage", 0) => sent(1),
            ("sendRichMessage", _) => (
                StatusCode::OK,
                json!({ "ok": false, "description": "Bad Request: can't parse entities" }),
            ),
            (_, earlier) => sent(2 + i64::try_from(earlier).unwrap()),
        }))
        .await;
    let reply = format!(
        "{}\n{}\n{}",
        "a".repeat(3000),
        "b".repeat(3000),
        "c".repeat(3000)
    );
    let ids = channel.send_rich_with_ids("42", &reply).await.unwrap();
    assert_eq!(ids, vec!["1", "2", "3"]);

    let calls = calls.lock().unwrap();
    let methods: Vec<&str> = calls.iter().map(|(method, _)| method.as_str()).collect();
    assert_eq!(
        methods,
        vec![
            "sendRichMessage",
            "sendRichMessage",
            "sendMessage",
            "sendMessage"
        ]
    );
    let plain: Vec<&str> = calls
        .iter()
        .filter(|(method, _)| method == "sendMessage")
        .filter_map(|(_, body)| body["text"].as_str())
        .collect();
    assert!(plain[0].starts_with('b') && plain[1].starts_with('c'));
    assert!(
        !plain.iter().any(|text| text.starts_with('a')),
        "the chunk already delivered as rich text must not be resent"
    );
    drop(calls);
    server.abort();
}

#[test]
fn the_senders_telegram_language_rides_on_the_inbound_turn() {
    let message: Message = serde_json::from_value(json!({
        "chat": { "id": 99, "type": "private" },
        "guest_query_id": "gq-9",
        "text": "こんにちは",
        "from": { "id": 5, "first_name": "Aki", "language_code": "ja" }
    }))
    .unwrap();
    assert_eq!(sender_locale(&message).as_deref(), Some("ja"));
    assert_eq!(
        guest_inbound(&message).unwrap().locale.as_deref(),
        Some("ja")
    );

    // Telegram omits the field when the user hides it: the owner's applies.
    let hidden: Message = serde_json::from_value(json!({
        "chat": { "id": 99, "type": "private" },
        "text": "hi",
        "from": { "id": 6, "first_name": "Bo" }
    }))
    .unwrap();
    assert_eq!(sender_locale(&hidden), None);

    // A button press carries the presser's language too.
    let update: Update = serde_json::from_value(json!({
        "update_id": 1,
        "callback_query": {
            "id": "cb-1",
            "data": "x",
            "from": { "id": 7, "first_name": "Ada", "language_code": "pt-br" }
        }
    }))
    .unwrap();
    let callback = update.callback_query.expect("callback");
    assert_eq!(callback.from.language_code.as_deref(), Some("pt-br"));
}
