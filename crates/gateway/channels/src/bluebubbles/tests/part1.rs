use super::*;

#[test]
fn new_rejects_missing_transport_secrets() {
    let mut blank_url = sample_config();
    blank_url.server_url = "   ".to_string();
    assert!(
        BlueBubblesChannel::new(blank_url, reqwest::Client::new(), PairingStore::ephemeral())
            .is_err()
    );

    let mut bad_url = sample_config();
    bad_url.server_url = "not a url".to_string();
    assert!(
        BlueBubblesChannel::new(bad_url, reqwest::Client::new(), PairingStore::ephemeral())
            .is_err()
    );

    let mut blank_password = sample_config();
    blank_password.password = "  ".to_string();
    assert!(BlueBubblesChannel::new(
        blank_password,
        reqwest::Client::new(),
        PairingStore::ephemeral()
    )
    .is_err());
}

#[test]
fn caps_track_the_private_api_helper() {
    let plain = channel(sample_config());
    assert!(!plain.caps().typing, "typing needs the Private API helper");
    assert!(!plain.caps().reactions);
    assert!(plain.caps().attachments, "iMessage always carries files");
    assert!(!plain.caps().rich_text);
    assert!(!plain.caps().threads);
    assert!(!plain.caps().command_menu);
    assert!(!plain.caps().streaming);
    // Voice rides the ordinary attachment upload, so it must NOT be gated on
    // the helper: gating it would silently drop a spoken reply the operator
    // asked for, on a bridge whose upload path works fine.
    assert!(
        plain.caps().voice,
        "voice uses the attachment path and must not require the Private API"
    );

    let mut cfg = sample_config();
    cfg.private_api = true;
    let helper = channel(cfg);
    assert!(helper.caps().typing);
    assert!(helper.caps().reactions);
    assert!(helper.caps().voice);
}

#[test]
fn parse_inbound_reads_a_direct_message() {
    let parsed = parse_inbound(&new_message("hello there", false, 45))
        .expect("a 1:1 new-message must parse");
    assert_eq!(parsed.chat_id, "iMessage;-;+15551234567");
    assert_eq!(parsed.text, "hello there");
    assert_eq!(parsed.sender_id.as_deref(), Some("+15551234567"));
    assert_eq!(parsed.message_id.as_deref(), Some("msg-guid-1"));
    assert!(!parsed.is_group);
    // The pairing gate keys on the handle, not the chat guid.
    assert_eq!(parsed.identity(), "+15551234567");
}

#[test]
fn parse_inbound_skips_our_own_messages() {
    // The single most important check in the adapter: the bot's own reply comes
    // straight back through the webhook, so answering it is an infinite loop.
    assert!(parse_inbound(&new_message("my own reply", true, 45)).is_none());
}

#[test]
fn parse_inbound_detects_group_style() {
    let group = parse_inbound(&new_message("hi all", false, CHAT_STYLE_GROUP)).unwrap();
    assert!(group.is_group);
    // An unrecognised style is treated as 1:1.
    let odd = parse_inbound(&new_message("hi", false, 99)).unwrap();
    assert!(!odd.is_group);
}

#[test]
fn parse_inbound_ignores_other_event_types_without_panicking() {
    for event in [
        "typing-indicator",
        "chat-read-status-change",
        "updated-message",
    ] {
        let payload = json!({ "type": event, "data": { "guid": "x" } });
        assert!(parse_inbound(&payload).is_none(), "{event} must be ignored");
    }
    // Wholly unexpected shapes must not panic either.
    assert!(parse_inbound(&json!({})).is_none());
    assert!(parse_inbound(&json!({ "type": "new-message" })).is_none());
    assert!(parse_inbound(&json!({ "type": "new-message", "data": { "text": "hi" } })).is_none());
}

#[test]
fn parse_inbound_drops_a_message_with_no_content() {
    assert!(parse_inbound(&new_message("   ", false, 45)).is_none());
}

#[test]
fn parse_inbound_reads_attachments_and_strips_the_placeholder_glyph() {
    let mut payload = new_message("\u{fffc}listen to this", false, 45);
    payload["data"]["attachments"] = json!([
        {
            "guid": "att-1",
            "mimeType": "audio/x-m4a",
            "transferName": "Audio Message.caf",
            "totalBytes": 4096,
            "isAudioMessage": true
        },
        {
            "guid": "att-2",
            "mimeType": "image/png",
            "transferName": "IMG_0001.png",
            "totalBytes": 90210
        }
    ]);
    let parsed = parse_inbound(&payload).unwrap();
    assert_eq!(
        parsed.text, "listen to this",
        "the U+FFFC glyph is stripped"
    );
    assert_eq!(parsed.attachments.len(), 2);
    assert_eq!(parsed.attachments[0].kind, Some(AttachmentKind::Voice));
    assert_eq!(parsed.attachments[0].file_id.as_deref(), Some("att-1"));
    assert_eq!(parsed.attachments[0].size, Some(4096));
    assert!(
        parsed.is_voice(),
        "a voice memo makes the turn a voice turn"
    );
    // The photo carries no explicit kind; MIME resolves it.
    assert_eq!(parsed.attachments[1].kind, None);
    assert_eq!(parsed.attachments[1].resolved_kind(), AttachmentKind::Image);
}

#[test]
fn temp_guid_is_deterministic_shaped_and_clock_sensitive() {
    let a = temp_guid("chat", "hello", 42);
    assert_eq!(a, temp_guid("chat", "hello", 42), "pure in its inputs");
    assert!(a.starts_with("ryu-"));
    assert_eq!(a.len(), 4 + 32, "128 bits of hex");
    assert!(a[4..].chars().all(|c| c.is_ascii_hexdigit()));
    // Every input varies the id, so two identical sends are distinguishable.
    assert_ne!(a, temp_guid("chat", "hello", 43));
    assert_ne!(a, temp_guid("other", "hello", 42));
    assert_ne!(a, temp_guid("chat", "goodbye", 42));
}

#[test]
fn send_text_payload_picks_the_send_method() {
    let script = send_text_payload("iMessage;-;+1555", "ryu-abc", "hi", false);
    assert_eq!(script["chatGuid"], "iMessage;-;+1555");
    assert_eq!(script["tempGuid"], "ryu-abc");
    assert_eq!(script["message"], "hi");
    assert_eq!(
        script["method"], "apple-script",
        "AppleScript is the always-available path"
    );

    let helper = send_text_payload("iMessage;-;+1555", "ryu-abc", "hi", true);
    assert_eq!(helper["method"], "private-api");
}

#[test]
fn api_and_attachment_urls_are_built_safely() {
    let ch = channel(sample_config());
    assert_eq!(
        ch.api("message/text"),
        "http://192.168.1.10:1234/api/v1/message/text"
    );
    let url = ch.attachment_url("att/../1").unwrap();
    assert!(
        url.contains("/api/v1/attachment/att%2F..%2F1/download"),
        "a guid must not be able to escape its path segment: {url}"
    );
    assert!(url.contains("password=hunter2"));
}

#[test]
fn webhook_secret_is_stable_and_scoped() {
    let a = derive_webhook_secret("hunter2", "/webhooks/bluebubbles");
    assert_eq!(a, derive_webhook_secret("hunter2", "/webhooks/bluebubbles"));
    assert_eq!(a.len(), 32);
    assert_ne!(a, derive_webhook_secret("hunter3", "/webhooks/bluebubbles"));
    assert_ne!(a, derive_webhook_secret("hunter2", "/webhooks/other"));
    assert!(!a.contains("hunter2"));
}

#[test]
fn token_check_rejects_everything_but_the_exact_token() {
    let expected = derive_webhook_secret("hunter2", "/hook");
    assert!(token_ok(&expected, &expected));
    assert!(!token_ok(&expected, ""));
    assert!(!token_ok(&expected, &expected[..31]));
    assert!(!token_ok(&expected, &format!("{expected}x")));
    let mut wrong = expected.clone();
    wrong.replace_range(0..1, if expected.starts_with('a') { "b" } else { "a" });
    assert!(!token_ok(&expected, &wrong));
}

#[test]
fn webhook_path_is_normalised_for_routing() {
    assert_eq!(normalize_webhook_path("/hook"), "/hook");
    assert_eq!(normalize_webhook_path("hook"), "/hook");
    assert_eq!(normalize_webhook_path("/hook/"), "/hook");
    assert_eq!(normalize_webhook_path("  /a/b/  "), "/a/b");
    // The bare root would make the token route `//:token`, so it is replaced.
    assert_eq!(normalize_webhook_path("/"), DEFAULT_WEBHOOK_PATH);
    assert_eq!(normalize_webhook_path(""), DEFAULT_WEBHOOK_PATH);
}

#[test]
fn webhook_url_hint_is_pasteable() {
    let ch = channel(sample_config());
    let addr: SocketAddr = "127.0.0.1:8765".parse().unwrap();
    let hint = ch.webhook_url_hint(&addr);
    assert!(hint.starts_with("http://127.0.0.1:8765/webhooks/bluebubbles/"));
    assert!(hint.ends_with(&ch.webhook_secret));
}

#[test]
fn routable_binds_are_flagged_and_lan_binds_are_not() {
    assert!(!is_publicly_routable("127.0.0.1".parse().unwrap()));
    assert!(!is_publicly_routable("192.168.1.5".parse().unwrap()));
    assert!(!is_publicly_routable("10.0.0.7".parse().unwrap()));
    assert!(!is_publicly_routable("::1".parse().unwrap()));
    assert!(
        !is_publicly_routable("fd12::1".parse().unwrap()),
        "unique-local"
    );
    assert!(
        !is_publicly_routable("fe80::1".parse().unwrap()),
        "link-local"
    );
    assert!(is_publicly_routable("0.0.0.0".parse().unwrap()));
    assert!(is_publicly_routable("::".parse().unwrap()));
    assert!(is_publicly_routable("203.0.113.9".parse().unwrap()));
    assert!(is_publicly_routable("2001:db8::1".parse().unwrap()));
}

#[test]
fn new_rejects_a_webhook_path_that_would_panic_the_router() {
    // axum treats `:` and `*` as route-parameter syntax and panics on them.
    for bad in ["/hook/:token", "/hook/*rest", "/hook/{id}"] {
        let mut cfg = sample_config();
        cfg.webhook_path = bad.to_string();
        assert!(
            BlueBubblesChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral())
                .is_err(),
            "{bad} must be refused at construction"
        );
    }
}

#[test]
fn group_reply_mode_approximates_mentions() {
    assert!(should_reply_in_group(GroupReplyMode::All, "anything", &[]));
    assert!(should_reply_in_group(
        GroupReplyMode::Mentions,
        "/help",
        &[]
    ));
    assert!(should_reply_in_group(
        GroupReplyMode::Mentions,
        "Ryu what's up",
        &[]
    ));
    assert!(should_reply_in_group(
        GroupReplyMode::Mentions,
        "hey ryu",
        &[]
    ));
    assert!(!should_reply_in_group(
        GroupReplyMode::Mentions,
        "dinner at 7?",
        &[]
    ));

    let patterns = vec!["assistant".to_string()];
    assert!(should_reply_in_group(
        GroupReplyMode::Mentions,
        "assistant, summarize this",
        &patterns
    ));
}

#[test]
fn local_command_reply_lists_only_help_and_commands() {
    let cmds = vec![ChannelCommand {
        name: "proof".into(),
        description: "prove it".into(),
        source: "plugin".into(),
    }];
    assert!(is_local_help("/help"));
    assert!(is_local_help("/commands"));
    let help = i18n::command_help("en", &cmds);
    assert_eq!(help, "Available commands:\n/proof — prove it");
    // Anything else belongs to Core and must reach it intact.
    assert!(!is_local_help("/proof"));
    assert!(!is_local_help("just talking"));
    assert_eq!(
        i18n::command_help("en", &[]),
        "No commands are available right now."
    );
}

#[tokio::test]
async fn local_help_is_silent_for_denied_senders_and_rooms() {
    use crate::pairing::{AccessPolicy, DmPolicy, GroupPolicy};
    let denied = [
        (
            AccessPolicy {
                dm: DmPolicy::Disabled,
                ..Default::default()
            },
            false,
        ),
        (
            AccessPolicy {
                dm: DmPolicy::Allowlist,
                dm_allowlist: vec!["+15550000000".into()],
                ..Default::default()
            },
            false,
        ),
        (
            AccessPolicy {
                group: GroupPolicy::Disabled,
                dm: DmPolicy::Open,
                ..Default::default()
            },
            true,
        ),
        (
            AccessPolicy {
                group: GroupPolicy::Allowlist,
                group_allowlist: vec!["iMessage;+;other-room".into()],
                ..Default::default()
            },
            true,
        ),
        // An unlisted room where only a different sender has a per-sender
        // override: the override must not admit this sender.
        (
            AccessPolicy {
                group: GroupPolicy::Allowlist,
                group_allowlist: vec!["iMessage;+;other-room".into()],
                group_sender_allowlist: vec!["+15550000000".into()],
                ..Default::default()
            },
            true,
        ),
    ];
    for (access, is_group) in denied {
        let label = format!("{access:?} group={is_group}");
        let (sent, turns) = dispatch_help(access, is_group).await;
        assert!(
            sent.is_empty(),
            "a denied caller must get no reply, not the command list: {label}: {sent:?}"
        );
        assert_eq!(turns, 0, "{label}");
    }
}

#[tokio::test]
async fn local_help_gives_an_unpaired_sender_only_the_pairing_prompt() {
    let (sent, turns) = dispatch_help(
        crate::pairing::AccessPolicy {
            dm: crate::pairing::DmPolicy::Pairing,
            ..Default::default()
        },
        false,
    )
    .await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(sent[0].contains("pairing code"), "{sent:?}");
    assert!(!sent[0].contains("commands"), "{sent:?}");
    assert_eq!(turns, 0);
}

#[tokio::test]
async fn local_help_is_silent_for_a_blocked_pairing_sender() {
    let pairing = PairingStore::ephemeral();
    pairing.block("bluebubbles", "+15551234567").await;
    let (sent, turns) = dispatch_help_with_store(
        crate::pairing::AccessPolicy {
            dm: crate::pairing::DmPolicy::Pairing,
            ..Default::default()
        },
        false,
        pairing,
        "en",
    )
    .await;
    assert!(sent.is_empty(), "a blocked sender gets nothing: {sent:?}");
    assert_eq!(turns, 0);
}

#[tokio::test]
async fn local_help_gives_a_pending_pairing_sender_only_the_pairing_prompt() {
    let pairing = PairingStore::ephemeral();
    let crate::pairing::Decision::Challenge(code) =
        pairing.challenge("bluebubbles", "+15551234567").await
    else {
        panic!("an unknown sender is challenged");
    };
    let (sent, turns) = dispatch_help_with_store(
        crate::pairing::AccessPolicy {
            dm: crate::pairing::DmPolicy::Pairing,
            ..Default::default()
        },
        false,
        pairing,
        "en",
    )
    .await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(
        sent[0].contains(&code),
        "the same live code is repeated: {sent:?}"
    );
    assert!(!sent[0].contains("commands"), "{sent:?}");
    assert_eq!(turns, 0);
}

#[tokio::test]
async fn local_help_still_answers_an_admitted_sender_locally() {
    let (sent, turns) = dispatch_help(
        crate::pairing::AccessPolicy {
            dm: crate::pairing::DmPolicy::Open,
            ..Default::default()
        },
        false,
    )
    .await;
    assert_eq!(
        sent,
        vec!["No commands are available right now.".to_owned()]
    );
    assert_eq!(turns, 0, "the local answer never reaches the model");
}

#[test]
fn tapbacks_cover_the_six_and_refuse_the_rest() {
    assert_eq!(tapback_for_emoji("👍"), Some("like"));
    assert_eq!(tapback_for_emoji("❤️"), Some("love"));
    assert_eq!(tapback_for_emoji("👎"), Some("dislike"));
    assert_eq!(tapback_for_emoji("😂"), Some("laugh"));
    assert_eq!(tapback_for_emoji("‼️"), Some("emphasize"));
    assert_eq!(tapback_for_emoji("❓"), Some("question"));
    // No tapback exists for this, and sending it as a message would be worse.
    assert_eq!(tapback_for_emoji("🦀"), None);
}

#[test]
fn envelope_errors_are_surfaced() {
    assert!(check_envelope(&json!({ "status": 200, "message": "ok" })).is_ok());
    // A body without the envelope field is not treated as an error.
    assert!(check_envelope(&json!({ "data": "pong" })).is_ok());
    let err = check_envelope(&json!({ "status": 400, "message": "Chat not found" }))
        .expect_err("a 4xx envelope must fail");
    assert!(err.to_string().contains("Chat not found"));
}
