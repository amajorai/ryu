//! Inbound webhook handling: Meta's verification handshake, signature checks,
//! delivery claims, the local help answer and parsing webhook payloads into
//! channel messages.

use super::*;

// ─── Webhook handlers ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub(super) struct VerifyQuery {
    #[serde(rename = "hub.mode")]
    pub(super) mode: Option<String>,
    #[serde(rename = "hub.verify_token")]
    pub(super) verify_token: Option<String>,
    #[serde(rename = "hub.challenge")]
    pub(super) challenge: Option<String>,
}

/// Meta's subscription handshake: echo back `hub.challenge` iff the mode is
/// `subscribe` and the verify token matches the configured value.
pub(super) async fn verify_webhook(
    State(state): State<WebhookState>,
    Query(query): Query<VerifyQuery>,
) -> impl IntoResponse {
    let mode_ok = query.mode.as_deref() == Some("subscribe");
    let token_ok = query
        .verify_token
        .as_deref()
        .is_some_and(|t| constant_time_eq(t.as_bytes(), state.channel.verify_token.as_bytes()));
    if mode_ok && token_ok {
        if let Some(challenge) = query.challenge {
            return (StatusCode::OK, challenge);
        }
    }
    warn!("whatsapp webhook verification rejected");
    (StatusCode::FORBIDDEN, "forbidden".to_string())
}

/// Inbound message delivery. Authenticate and durably claim every message before
/// returning `200`; only then is the slow turn dispatched onto its own task.
///
/// Meta retries callbacks, so the message's stable `wamid` is the provider
/// idempotency key. Payloads without a message id use a bounded hash fallback,
/// which keeps an identical retry from duplicating work while avoiding a
/// made-up identity that could collide with a real `wamid`.
///
/// Every POST must carry a valid `X-Hub-Signature-256` HMAC of the raw body
/// keyed by the Meta App Secret; otherwise the payload is spoofable. We take the
/// raw `Bytes` (not `Json`) so the signature is computed over the exact bytes
/// Meta signed, reject on any mismatch, and only then parse the JSON.
pub(super) async fn receive_webhook(
    State(state): State<WebhookState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let sig = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok());
    if !verify_signature(&state.channel.app_secret, sig, &body) {
        warn!("whatsapp webhook rejected: missing or invalid X-Hub-Signature-256");
        return StatusCode::FORBIDDEN;
    }

    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        warn!("whatsapp webhook rejected: body is not valid JSON");
        return StatusCode::BAD_REQUEST;
    };

    for (index, inbound) in parse_inbound(&payload).into_iter().enumerate() {
        let provider_id = inbound_delivery_id(&inbound, &body, index);
        let (delivery_id, claim) = match claim_inbound_delivery(&*state.channel, &provider_id).await
        {
            Ok(result) => result,
            Err(error) => {
                warn!(%error, "whatsapp webhook delivery could not be durably claimed");
                // A 5xx is intentional here: Meta can retry a valid event when
                // local durable acceptance is unavailable.
                return StatusCode::SERVICE_UNAVAILABLE;
            }
        };
        if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
            debug!(
                delivery_id = %delivery_id,
                ?claim,
                "duplicate whatsapp webhook delivery suppressed"
            );
            continue;
        }
        let Some(permit) = try_reserve_delivery(&*state.channel) else {
            if let Err(error) = state
                .channel
                .runtime
                .pairing
                .fail_delivery(PLATFORM, &delivery_id)
                .await
            {
                warn!(%error, "whatsapp webhook capacity failure could not be persisted");
            }
            warn!("whatsapp webhook capacity is exhausted; asking Meta to retry");
            return StatusCode::SERVICE_UNAVAILABLE;
        };
        let channel = Arc::clone(&state.channel);
        let host = Arc::clone(&state.host);
        tokio::spawn(async move {
            let mut inbound = inbound;
            prepare_message(&channel, &mut inbound).await;
            let work_channel = Arc::clone(&channel);
            let work_host = Arc::clone(&host);
            let work_delivery_id = delivery_id.clone();
            run_claimed_delivery_with_permit(channel, delivery_id, permit, move || {
                let channel = Arc::clone(&work_channel);
                let host = Arc::clone(&work_host);
                let inbound = inbound.clone();
                let delivery_id = work_delivery_id.clone();
                async move { dispatch(channel, host, inbound, &delivery_id).await }
            })
            .await;
        });
    }
    StatusCode::OK
}

/// Everything between "a message was parsed" and the shared inbound path:
/// remember the wamid the platform verbs address, pull down any voice note, and
/// intercept the one command WhatsApp cannot express as a menu.
pub(super) async fn dispatch(
    channel: Arc<WhatsAppChannel>,
    host: Arc<dyn ChannelHost>,
    message: InboundMessage,
    delivery_id: &str,
) -> ChannelTurnOutcome {
    // `/help` is the discovery affordance a platform with a command menu gets for
    // free. Every OTHER command falls through untouched — Core's `pre_user_turn`
    // hooks are what execute them, and they only need the text to arrive intact.
    if is_help_request(&message.text) && channel.access_allows(&message).await {
        let locale = channel
            .runtime
            .reply_locale(message.locale.as_deref())
            .await;
        let help = i18n::whatsapp_command_help(locale, &channel.runtime.commands().await);
        return match channel.send_message(&message.chat_id, &help).await {
            Ok(()) => ChannelTurnOutcome::Completed,
            Err(err) => {
                warn!(channel = PLATFORM, %err, "failed to deliver the command list");
                ChannelTurnOutcome::Failed
            }
        };
    }

    handle_turn_with_delivery(channel, host, message, Some(delivery_id)).await
}

pub(super) async fn prepare_message(channel: &WhatsAppChannel, message: &mut InboundMessage) {
    if let Some(message_id) = message.message_id.clone() {
        channel.remember_inbound(&message.chat_id, message_id).await;
    }

    // Fetch and transcribe only for a sender the gate would admit. Meta's webhook
    // is authenticated, but the SENDER is not — anyone who knows the business
    // number can message it, so an unpaired stranger could otherwise spend the
    // operator's STT budget by sending audio. `already_admitted` is the read-only
    // twin of the gate inside `handle_turn`, which still issues the pairing prompt.
    if !message.attachments.is_empty()
        && channel
            .runtime
            .already_admitted(channel.name(), message)
            .await
    {
        let downloaded = channel.fetch_media(&message.attachments).await;
        channel.runtime.ingest_media(message, downloaded).await;
    }
}

pub(super) fn inbound_delivery_id(message: &InboundMessage, body: &[u8], index: usize) -> String {
    if let Some(message_id) = message
        .message_id
        .as_deref()
        .filter(|message_id| !message_id.trim().is_empty())
    {
        return format!("wamid:{message_id}");
    }
    let digest = Sha256::digest(body);
    format!("payload:{}:{index}", hex::encode(digest))
}

// ─── Payload builders ──────────────────────────────────────────────────────────
//
// The Cloud API expresses every outbound verb as the same POST with a different
// body, so these pure builders are where the verbs actually differ — and the only
// part worth testing without a Graph API to talk to.

/// A plain text reply.
pub(super) fn text_payload(to: &str, body: &str) -> Value {
    json!({
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": { "body": body },
    })
}

// ─── Webhook signature ─────────────────────────────────────────────────────────

/// Verify Meta's `X-Hub-Signature-256` header against `hmac_sha256(app_secret,
/// raw_body)`. The header is formatted `sha256=<hex>`. Verification is
/// constant-time (via `Mac::verify_slice`), and a missing/malformed header or
/// non-hex digest fails closed.
///
/// This is the *only* thing authenticating the webhook — the receiver is a public
/// HTTP endpoint — so it stays strict and must never grow an escape hatch.
pub(super) fn verify_signature(app_secret: &str, signature: Option<&str>, body: &[u8]) -> bool {
    let Some(sig) = signature else {
        return false;
    };
    let Some(hex_digest) = sig.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(expected) = hex::decode(hex_digest) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(app_secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

/// Constant-time byte-slice equality (length-independent short-circuit only on
/// differing lengths, which are not secret here).
pub(super) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ─── Inbound parsing ───────────────────────────────────────────────────────────

/// Extract user messages from a WhatsApp Cloud API webhook payload.
///
/// Pure and synchronous — media is carried as an id to be resolved later, by
/// [`WhatsAppChannel::fetch_media`] — so the whole shape of an inbound message is
/// testable without a network.
///
/// The payload nests messages under `entry[].changes[].value.messages[]`; status
/// callbacks (delivery receipts) carry no `messages` array and are ignored.
/// `sender_id` is the sender's phone number (`wa_id`), which is what the pairing
/// gate keys on, and `is_group` is always false: Cloud API conversations are
/// one-to-one, so the person and the conversation are the same thing.
pub(super) fn parse_inbound(payload: &Value) -> Vec<InboundMessage> {
    let mut out = Vec::new();
    let Some(entries) = payload["entry"].as_array() else {
        return out;
    };
    for entry in entries {
        let Some(changes) = entry["changes"].as_array() else {
            continue;
        };
        for change in changes {
            let Some(messages) = change["value"]["messages"].as_array() else {
                continue;
            };
            for message in messages {
                let Some(from) = message["from"].as_str() else {
                    continue;
                };
                let text = message_text(message);
                let attachments: Vec<Attachment> = attachment_from(message).into_iter().collect();
                // Reactions, system notices and message types we cannot render
                // carry neither text nor media; there is nothing to route.
                if text.trim().is_empty() && attachments.is_empty() {
                    continue;
                }
                out.push(InboundMessage {
                    chat_id: from.to_string(),
                    access_chat_id: None,
                    text,
                    author_name: contact_name(change, from),
                    sender_id: Some(from.to_string()),
                    message_id: message["id"].as_str().map(str::to_string),
                    is_group: false,
                    attachments,
                    channel_action: None,
                    // WhatsApp reports no language; replies use the owner's.
                    locale: None,
                });
            }
        }
    }
    debug!(count = out.len(), "parsed whatsapp inbound messages");
    out
}

/// The typed text of a message: the body of a text message, or the caption a
/// media message was sent with.
pub(super) fn message_text(message: &Value) -> String {
    if let Some(body) = message["text"]["body"].as_str() {
        return body.to_string();
    }
    if let Some(title) = message["interactive"]["button_reply"]["title"].as_str() {
        return title.to_string();
    }
    if let Some(title) = message["interactive"]["list_reply"]["title"].as_str() {
        return title.to_string();
    }
    if let Some(location) = message["location"].as_object() {
        let latitude = location
            .get("latitude")
            .and_then(Value::as_f64)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let longitude = location
            .get("longitude")
            .and_then(Value::as_f64)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let label = location
            .get("name")
            .or_else(|| location.get("address"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!(" ({value})"))
            .unwrap_or_default();
        return format!("[location: {latitude}, {longitude}{label}]");
    }
    message["type"]
        .as_str()
        .and_then(|kind| message[kind]["caption"].as_str())
        .unwrap_or_default()
        .to_string()
}

/// Turn a media message into an [`Attachment`] carrying the media id.
///
/// The Cloud API distinguishes a voice note from an audio file with
/// `audio.voice = true` rather than a separate type. Both are transcribed, so
/// mis-reading that flag only changes the label used when annotating the turn.
pub(super) fn attachment_from(message: &Value) -> Option<Attachment> {
    let kind_name = message["type"].as_str()?;
    let node = &message[kind_name];
    let kind = match kind_name {
        "audio" => {
            if node["voice"].as_bool().unwrap_or(false) {
                AttachmentKind::Voice
            } else {
                AttachmentKind::Audio
            }
        }
        "image" | "sticker" => AttachmentKind::Image,
        "video" => AttachmentKind::Video,
        "document" => AttachmentKind::Document,
        _ => return None,
    };
    let file_id = node["id"].as_str()?.to_string();
    Some(Attachment {
        kind: Some(kind),
        // Cloud API media is never directly fetchable; the id resolves to a
        // short-lived URL that still needs the bearer token.
        url: None,
        file_id: Some(file_id),
        mime: node["mime_type"].as_str().map(str::to_string),
        filename: node["filename"].as_str().map(str::to_string),
        size: node["file_size"].as_u64(),
    })
}

/// The WhatsApp profile name of a sender, from the `contacts[]` array that
/// accompanies the messages in the same change. Unverified display text — it is
/// recorded on the turn for attribution, never used for authorization.
pub(super) fn contact_name(change: &Value, wa_id: &str) -> Option<String> {
    change["value"]["contacts"]
        .as_array()?
        .iter()
        .find(|contact| contact["wa_id"].as_str() == Some(wa_id))
        .and_then(|contact| contact["profile"]["name"].as_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
}

// ─── Text-triggered command discovery ──────────────────────────────────────────

/// Is this message asking what the bot can do?
///
/// Only `/help` and `/commands` qualify: bare "help" is a plausible thing to ask
/// an assistant in prose, and hijacking it would make the agent unreachable for
/// anyone who genuinely wanted help with something.
pub(super) fn is_help_request(text: &str) -> bool {
    match commands::parse_command(text) {
        Some((name, _)) => matches!(name.as_str(), "help" | "commands"),
        None => false,
    }
}
