use super::*;
use crate::commands::ChannelCommand;
use crate::CommonChannelConfig;

fn sample_config() -> WhatsAppChannelConfig {
    WhatsAppChannelConfig {
        access_token: "token".to_string(),
        phone_number_id: "12345".to_string(),
        verify_token: "verifyme".to_string(),
        app_secret: "shhh".to_string(),
        webhook_bind: "0.0.0.0:8443".to_string(),
        webhook_path: "/webhooks/whatsapp".to_string(),
        graph_version: "v21.0".to_string(),
        common: CommonChannelConfig {
            model: "gpt-4o".to_string(),
            ..Default::default()
        },
    }
}

fn cmd(name: &str, description: &str) -> ChannelCommand {
    ChannelCommand {
        name: name.to_string(),
        description: description.to_string(),
        source: "plugin".to_string(),
    }
}

/// Wrap message objects in the `entry[].changes[].value` envelope Meta sends.
fn envelope(value: Value) -> Value {
    json!({ "entry": [ { "changes": [ { "value": value } ] } ] })
}

struct NoopHost;

#[async_trait]
impl ChannelHost for NoopHost {
    async fn run_pipeline(&self, _channel_name: &str, _body: Value) -> anyhow::Result<Value> {
        anyhow::bail!("noop host is not used by this webhook test")
    }
}

#[test]
fn new_rejects_empty_app_secret() {
    let mut cfg = sample_config();
    cfg.app_secret = "   ".to_string();
    assert!(WhatsAppChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral()).is_err());
}

#[test]
fn new_rejects_empty_access_token() {
    let mut cfg = sample_config();
    cfg.access_token = "   ".to_string();
    assert!(WhatsAppChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral()).is_err());
}

#[test]
fn verifies_valid_signature_and_rejects_tampering() {
    let secret = "shhh";
    let body = br#"{"entry":[]}"#;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    let sig = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

    assert!(verify_signature(secret, Some(&sig), body));
    // wrong secret, missing header, malformed prefix, and tampered body all fail
    assert!(!verify_signature("other", Some(&sig), body));
    assert!(!verify_signature(secret, None, body));
    assert!(!verify_signature(secret, Some("deadbeef"), body));
    assert!(!verify_signature(secret, Some(&sig), br#"{"entry":[1]}"#));
}

#[tokio::test]
async fn webhook_claims_wamid_before_ack_and_suppresses_retry() {
    let mut config = sample_config();
    config.common.access.dm = crate::pairing::DmPolicy::Disabled;
    let channel = Arc::new(
        WhatsAppChannel::new(config, reqwest::Client::new(), PairingStore::ephemeral()).unwrap(),
    );
    let state = WebhookState {
        channel: Arc::clone(&channel),
        host: Arc::new(NoopHost),
    };
    let body = br#"{
        "entry":[{"changes":[{"value":{"messages":[{
            "id":"wamid.test","from":"1555","type":"text",
            "text":{"body":"hello"}
        }]}}]}]
    }"#;
    let mut mac = Hmac::<Sha256>::new_from_slice(b"shhh").unwrap();
    mac.update(body);
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-hub-signature-256",
        format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
            .parse()
            .unwrap(),
    );

    assert_eq!(
        receive_webhook(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(body)
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        receive_webhook(State(state), headers, Bytes::from_static(body)).await,
        StatusCode::OK
    );
    assert!(matches!(
        channel
            .runtime
            .pairing
            .claim_delivery("whatsapp", "whatsapp:wamid:wamid.test")
            .await
            .unwrap(),
        crate::pairing::DeliveryClaim::InFlight | crate::pairing::DeliveryClaim::Completed
    ));
}

#[test]
fn verify_webhook_rejects_bad_verify_token() {
    // confirm constant_time_eq rejects a mismatched token
    assert!(!constant_time_eq(b"correct", b"wrongtoken"));
    assert!(!constant_time_eq(b"correct", b"correc"));
    assert!(constant_time_eq(b"correct", b"correct"));
}

#[test]
fn builds_graph_urls() {
    let channel = WhatsAppChannel::new(
        sample_config(),
        reqwest::Client::new(),
        PairingStore::ephemeral(),
    )
    .unwrap();
    assert_eq!(
        channel.messages_url(),
        "https://graph.facebook.com/v21.0/12345/messages"
    );
    assert_eq!(
        channel.media_url("media-1"),
        "https://graph.facebook.com/v21.0/media-1"
    );
    assert_eq!(channel.name(), "whatsapp");
    assert_eq!(channel.model(), "gpt-4o");
}

#[test]
fn caps_match_what_the_cloud_api_can_do() {
    let channel = WhatsAppChannel::new(
        sample_config(),
        reqwest::Client::new(),
        PairingStore::ephemeral(),
    )
    .unwrap();
    let caps = channel.caps();
    assert!(caps.typing && caps.attachments && caps.reactions);
    // No rich text, no drafts, no threads, no menu, and no WAV playback.
    assert!(!caps.rich_text && !caps.streaming && !caps.threads);
    assert!(!caps.command_menu && !caps.voice);
    // Meta expires the indicator after ~25s, so it must be re-asserted sooner.
    assert!(channel.typing_interval() < Duration::from_secs(25));
}

#[test]
fn new_reads_the_common_config() {
    let mut cfg = sample_config();
    cfg.common.agent_id = Some("acp:pi".to_string());
    let channel =
        WhatsAppChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral()).unwrap();
    assert_eq!(channel.runtime().cfg.agent_id.as_deref(), Some("acp:pi"));
    assert!(channel.runtime().routes_via_core());

    let bare = WhatsAppChannel::new(
        sample_config(),
        reqwest::Client::new(),
        PairingStore::ephemeral(),
    )
    .unwrap();
    assert!(!bare.runtime().routes_via_core());
}

// ── payload builders ──

#[test]
fn read_status_payload_adds_typing_only_when_asked() {
    let read = read_status_payload("wamid.1", false);
    assert_eq!(read["status"], "read");
    assert_eq!(read["message_id"], "wamid.1");
    assert!(
        read.get("typing_indicator").is_none(),
        "a plain read receipt must not show the indicator"
    );

    let typing = read_status_payload("wamid.1", true);
    assert_eq!(typing["typing_indicator"]["type"], "text");
    assert_eq!(
        typing["status"], "read",
        "the typing call also marks the message read"
    );
}

#[test]
fn text_and_reaction_payloads_target_the_right_ids() {
    let text = text_payload("15551234567", "hi");
    assert_eq!(text["messaging_product"], "whatsapp");
    assert_eq!(text["to"], "15551234567");
    assert_eq!(text["text"]["body"], "hi");

    let reaction = reaction_payload("15551234567", "wamid.7", "👍");
    assert_eq!(reaction["type"], "reaction");
    assert_eq!(reaction["reaction"]["message_id"], "wamid.7");
    assert_eq!(reaction["reaction"]["emoji"], "👍");
}

// ── inbound parsing ──

#[test]
fn parse_inbound_reads_text_message() {
    let payload = envelope(json!({
        "contacts": [ { "wa_id": "15551234567", "profile": { "name": "Ada" } } ],
        "messages": [
            {
                "id": "wamid.abc",
                "from": "15551234567",
                "type": "text",
                "text": { "body": "hello there" }
            }
        ]
    }));
    let parsed = parse_inbound(&payload);
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].chat_id, "15551234567");
    assert_eq!(parsed[0].text, "hello there");
    // The pairing gate keys on the person, so the wa_id must be the identity.
    assert_eq!(parsed[0].sender_id.as_deref(), Some("15551234567"));
    assert_eq!(parsed[0].identity(), "15551234567");
    assert_eq!(parsed[0].message_id.as_deref(), Some("wamid.abc"));
    assert_eq!(parsed[0].author_name.as_deref(), Some("Ada"));
    // Cloud API conversations are one-to-one.
    assert!(!parsed[0].is_group);
}

#[test]
fn parse_inbound_ignores_status_callbacks() {
    let payload = envelope(json!({ "statuses": [ { "status": "delivered" } ] }));
    assert!(parse_inbound(&payload).is_empty());
}

#[test]
fn parse_inbound_turns_an_image_into_an_attachment() {
    // Previously an image was dropped; it now arrives as media with a caption.
    let payload = envelope(json!({
        "messages": [
            {
                "id": "wamid.img",
                "from": "1555",
                "type": "image",
                "image": { "id": "media-9", "mime_type": "image/jpeg", "caption": "look" }
            }
        ]
    }));
    let parsed = parse_inbound(&payload);
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].text, "look", "the caption is the turn text");
    assert_eq!(parsed[0].attachments.len(), 1);
    let attachment = &parsed[0].attachments[0];
    assert_eq!(attachment.file_id.as_deref(), Some("media-9"));
    assert_eq!(attachment.resolved_kind(), AttachmentKind::Image);
    assert!(
        attachment.url.is_none(),
        "cloud API media must be resolved by id, never fetched directly"
    );
    assert!(!parsed[0].is_voice());
}

#[test]
fn parse_inbound_reads_a_voice_note() {
    let payload = envelope(json!({
        "messages": [
            {
                "id": "wamid.v",
                "from": "1555",
                "type": "audio",
                "audio": { "id": "media-v", "mime_type": "audio/ogg", "voice": true }
            }
        ]
    }));
    let parsed = parse_inbound(&payload);
    assert_eq!(parsed.len(), 1);
    assert!(
        parsed[0].text.is_empty(),
        "the transcript is folded in later, by ingest_media"
    );
    assert_eq!(
        parsed[0].attachments[0].resolved_kind(),
        AttachmentKind::Voice
    );
    assert!(parsed[0].is_voice());

    // An audio FILE is the same type without the flag, and is still speech.
    let as_file = envelope(json!({
        "messages": [
            {
                "id": "wamid.a",
                "from": "1555",
                "type": "audio",
                "audio": { "id": "media-a", "mime_type": "audio/mpeg" }
            }
        ]
    }));
    let parsed = parse_inbound(&as_file);
    assert_eq!(
        parsed[0].attachments[0].resolved_kind(),
        AttachmentKind::Audio
    );
    assert!(parsed[0].is_voice(), "an audio file is transcribed too");
}

#[test]
fn parse_inbound_keeps_a_document_filename() {
    let payload = envelope(json!({
        "messages": [
            {
                "id": "wamid.d",
                "from": "1555",
                "type": "document",
                "document": {
                    "id": "media-d",
                    "mime_type": "application/pdf",
                    "filename": "report.pdf",
                    "file_size": 4096
                }
            }
        ]
    }));
    let parsed = parse_inbound(&payload);
    let attachment = &parsed[0].attachments[0];
    assert_eq!(attachment.filename.as_deref(), Some("report.pdf"));
    assert_eq!(attachment.size, Some(4096));
    assert_eq!(attachment.resolved_kind(), AttachmentKind::Document);
}

#[test]
fn parse_inbound_drops_messages_with_nothing_to_route() {
    // A reaction carries neither text nor media.
    let reaction = envelope(json!({
        "messages": [
            {
                "id": "wamid.r",
                "from": "1555",
                "type": "reaction",
                "reaction": { "message_id": "wamid.abc", "emoji": "👍" }
            }
        ]
    }));
    assert!(parse_inbound(&reaction).is_empty());

    // …as does an empty text body.
    let blank = envelope(json!({
        "messages": [
            { "id": "wamid.b", "from": "1555", "type": "text", "text": { "body": "   " } }
        ]
    }));
    assert!(parse_inbound(&blank).is_empty());
}

#[test]
fn contact_name_matches_on_wa_id_only() {
    let change = json!({
        "value": {
            "contacts": [
                { "wa_id": "111", "profile": { "name": "Ada" } },
                { "wa_id": "222", "profile": { "name": "Grace" } }
            ]
        }
    });
    assert_eq!(contact_name(&change, "222").as_deref(), Some("Grace"));
    assert!(contact_name(&change, "333").is_none());
    assert!(contact_name(&json!({}), "111").is_none());
}

// ── text-triggered help ──

#[test]
fn help_is_recognised_only_as_a_command() {
    assert!(is_help_request("/help"));
    assert!(is_help_request("  /Commands"));
    assert!(is_help_request("/help@ryubot"));
    // Prose asking for help belongs to the agent, not to the menu.
    assert!(!is_help_request("help me write a poem"));
    assert!(!is_help_request("can you help?"));
    // Any other command is routed to Core, which is what executes it.
    assert!(!is_help_request("/goal ship it"));
}

#[test]
fn format_command_help_lists_every_command() {
    let rendered = crate::i18n::whatsapp_command_help(
        "en",
        &[cmd("goal", "set a goal"), cmd("proof", "prove it")],
    );
    assert!(rendered.starts_with("*Available commands*"));
    assert!(rendered.contains("/goal — set a goal"));
    assert!(rendered.contains("/proof — prove it"));

    // A command with no description still lists, without a dangling dash.
    let sparse = crate::i18n::whatsapp_command_help("en", &[cmd("goal", "")]);
    assert!(sparse.contains("/goal\n"), "got {sparse:?}");
    assert!(!sparse.contains("—"));
}

#[test]
fn format_command_help_says_so_when_there_are_none() {
    // Core unreachable at startup ⇒ an empty menu, which must still explain
    // itself rather than sending a bare heading.
    let rendered = crate::i18n::whatsapp_command_help("en", &[]);
    assert!(rendered.contains("No commands"));
    assert!(!rendered.contains('/'));
}

#[tokio::test]
async fn latest_inbound_is_remembered_per_chat_and_bounded() {
    let channel = WhatsAppChannel::new(
        sample_config(),
        reqwest::Client::new(),
        PairingStore::ephemeral(),
    )
    .unwrap();
    assert!(channel.latest_inbound("1555").await.is_none());

    channel.remember_inbound("1555", "wamid.1".into()).await;
    channel.remember_inbound("1666", "wamid.2".into()).await;
    assert_eq!(
        channel.latest_inbound("1555").await.as_deref(),
        Some("wamid.1")
    );

    // The newest id wins — the indicator must attach to the live message.
    channel.remember_inbound("1555", "wamid.3".into()).await;
    assert_eq!(
        channel.latest_inbound("1555").await.as_deref(),
        Some("wamid.3")
    );

    // The map is capped, so a long-lived process cannot leak a slot per sender.
    for i in 0..MAX_TRACKED_CHATS {
        channel
            .remember_inbound(&format!("chat-{i}"), "wamid.x".into())
            .await;
    }
    assert!(channel.last_inbound.read().await.len() <= MAX_TRACKED_CHATS);
}
