use super::*;
use crate::CommonChannelConfig;

fn sample_config() -> OpenWaChannelConfig {
    OpenWaChannelConfig {
        base_url: "http://localhost:2785".to_string(),
        api_key: "operator-key".to_string(),
        session_id: "personal-1".to_string(),
        webhook_url: "https://example.com/webhooks/whatsapp-personal".to_string(),
        webhook_secret: "webhook-secret".to_string(),
        webhook_bind: "127.0.0.1:8444".to_string(),
        webhook_path: "/webhooks/whatsapp-personal".to_string(),
        self_chat_only: false,
        common: CommonChannelConfig {
            model: "gpt-4o".to_string(),
            ..Default::default()
        },
    }
}

#[test]
fn constructor_rejects_missing_openwa_credentials() {
    let mut config = sample_config();
    config.api_key.clear();
    assert!(OpenWaChannel::new(config, reqwest::Client::new(), PairingStore::ephemeral()).is_err());
}

#[test]
fn verifies_openwa_signature() {
    let body = br#"{"event":"message.received"}"#;
    let mut mac = Hmac::<Sha256>::new_from_slice(b"webhook-secret").unwrap();
    mac.update(body);
    let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
    assert!(verify_signature("webhook-secret", Some(&signature), body));
    assert!(!verify_signature("wrong", Some(&signature), body));
    assert!(!verify_signature("webhook-secret", None, body));
}

#[test]
fn parses_text_group_media_and_contact_identity() {
    let parsed = parse_inbound(
        &json!({
            "id": "msg-1",
            "from": "120363@g.us",
            "author": "1555@c.us",
            "isGroup": true,
            "kind": "group",
            "body": "hello",
            "type": "audio",
            "voice": true,
            "media": { "mimetype": "audio/ogg", "filename": "note.ogg" },
            "contact": { "name": "Ada" }
        }),
        false,
    );
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].chat_id, "120363@g.us");
    assert_eq!(parsed[0].sender_id.as_deref(), Some("1555@c.us"));
    assert!(parsed[0].is_group);
    assert_eq!(parsed[0].author_name.as_deref(), Some("Ada"));
    assert_eq!(
        parsed[0].attachments[0].resolved_kind(),
        AttachmentKind::Voice
    );
    assert_eq!(parsed[0].attachments[0].file_id.as_deref(), Some("msg-1"));
}

#[test]
fn ignores_media_types_without_media_bytes() {
    let parsed = parse_inbound(
        &json!({
            "id": "msg-2",
            "from": "1555@c.us",
            "body": "",
            "type": "audio",
            "hasMedia": false
        }),
        false,
    );
    assert!(parsed.is_empty());
}

#[test]
fn self_chat_mode_ignores_other_senders_and_groups() {
    let other = json!({
        "id": "msg-1", "from": "1555@c.us", "body": "hello", "type": "text", "fromMe": false
    });
    let group = json!({
        "id": "msg-2", "from": "120363@g.us", "body": "hello", "type": "text", "isGroup": true, "fromMe": true
    });
    assert!(parse_inbound(&other, true).is_empty());
    assert!(parse_inbound(&group, true).is_empty());
}

#[test]
fn inbound_delivery_id_prefers_the_provider_message_id() {
    let message = InboundMessage {
        message_id: Some("msg-1".to_string()),
        ..InboundMessage::default()
    };
    assert_eq!(
        inbound_delivery_id(&message, Some("delivery-1"), b"body", 0),
        "message:msg-1"
    );

    let anonymous = InboundMessage::default();
    assert_eq!(
        inbound_delivery_id(&anonymous, Some("delivery-1"), b"body", 2),
        "delivery:delivery-1:2"
    );
    assert!(inbound_delivery_id(&anonymous, None, b"body", 0).starts_with("payload:"));
}

#[test]
fn personal_channel_exposes_voice_and_whatsapp_verbs() {
    let channel = OpenWaChannel::new(
        sample_config(),
        reqwest::Client::new(),
        PairingStore::ephemeral(),
    )
    .unwrap();
    let caps = channel.caps();
    assert!(caps.typing && caps.attachments && caps.reactions && caps.voice);
    assert!(!caps.rich_text && !caps.streaming && !caps.threads);
    assert_eq!(channel.name(), "whatsapp_personal");
}
