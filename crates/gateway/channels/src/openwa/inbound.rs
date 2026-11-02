//! Inbound webhook handling: signature check, delivery claims, the local help
//! answer and parsing OpenWA events into channel messages.

use super::*;

pub(super) async fn receive_webhook(
    State(state): State<WebhookState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let signature = headers
        .get("x-openwa-signature")
        .and_then(|value| value.to_str().ok());
    if !verify_signature(&state.channel.webhook_secret, signature, &body) {
        warn!(
            channel = PLATFORM,
            "OpenWA webhook rejected: invalid signature"
        );
        return StatusCode::FORBIDDEN;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    if payload["sessionId"].as_str() != Some(state.channel.session_id.as_str()) {
        return StatusCode::FORBIDDEN;
    }
    if payload["event"].as_str() != Some("message.received") {
        return StatusCode::OK;
    }

    let webhook_delivery_id = headers
        .get("x-openwa-idempotency-key")
        .and_then(|value| value.to_str().ok())
        .or_else(|| payload["idempotencyKey"].as_str())
        .or_else(|| payload["deliveryId"].as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    for (index, inbound) in parse_inbound(&payload["data"], state.channel.self_chat_only)
        .into_iter()
        .enumerate()
    {
        let provider_id = inbound_delivery_id(&inbound, webhook_delivery_id, &body, index);
        let (delivery_id, claim) = match claim_inbound_delivery(&*state.channel, &provider_id).await
        {
            Ok(result) => result,
            Err(error) => {
                warn!(%error, "OpenWA webhook delivery could not be durably claimed");
                return StatusCode::SERVICE_UNAVAILABLE;
            }
        };
        if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
            debug!(
                delivery_id = %delivery_id,
                ?claim,
                "duplicate OpenWA webhook delivery suppressed"
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
                warn!(%error, "OpenWA webhook capacity failure could not be persisted");
            }
            warn!("OpenWA webhook capacity is exhausted; asking OpenWA to retry");
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

pub(super) async fn dispatch(
    channel: Arc<OpenWaChannel>,
    host: Arc<dyn ChannelHost>,
    message: InboundMessage,
    delivery_id: &str,
) -> ChannelTurnOutcome {
    if is_help_request(&message.text) && channel.access_allows(&message).await {
        let locale = channel
            .runtime
            .reply_locale(message.locale.as_deref())
            .await;
        let help = i18n::whatsapp_command_help(locale, &channel.runtime.commands().await);
        return match channel.send_message(&message.chat_id, &help).await {
            Ok(()) => ChannelTurnOutcome::Completed,
            Err(err) => {
                warn!(channel = PLATFORM, %err, "failed to deliver WhatsApp Personal command list");
                ChannelTurnOutcome::Failed
            }
        };
    }
    handle_turn_with_delivery(channel, host, message, Some(delivery_id)).await
}

pub(super) async fn prepare_message(channel: &OpenWaChannel, message: &mut InboundMessage) {
    if !message.attachments.is_empty()
        && channel
            .runtime
            .already_admitted(channel.name(), message)
            .await
    {
        let downloaded = channel
            .fetch_media(&message.chat_id, &message.attachments)
            .await;
        channel.runtime.ingest_media(message, downloaded).await;
    }
}

pub(super) fn inbound_delivery_id(
    message: &InboundMessage,
    webhook_delivery_id: Option<&str>,
    body: &[u8],
    index: usize,
) -> String {
    if let Some(message_id) = message
        .message_id
        .as_deref()
        .filter(|message_id| !message_id.trim().is_empty())
    {
        return format!("message:{message_id}");
    }
    if let Some(webhook_delivery_id) = webhook_delivery_id {
        return format!("delivery:{webhook_delivery_id}:{index}");
    }
    format!("payload:{}:{index}", hex::encode(Sha256::digest(body)))
}

pub(super) fn parse_inbound(data: &Value, self_chat_only: bool) -> Vec<InboundMessage> {
    let Some(chat_id) = data
        .get("chatId")
        .or_else(|| data.get("from"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    else {
        return Vec::new();
    };
    let kind = data["kind"].as_str().unwrap_or_default();
    if matches!(kind, "status" | "broadcast") {
        return Vec::new();
    }
    let is_group =
        data["isGroup"].as_bool().unwrap_or(false) || kind == "group" || chat_id.ends_with("@g.us");
    if self_chat_only && (is_group || !data["fromMe"].as_bool().unwrap_or(false)) {
        return Vec::new();
    }
    let text = message_text(data);
    let attachments = attachment_from(data).into_iter().collect::<Vec<_>>();
    if text.trim().is_empty() && attachments.is_empty() {
        return Vec::new();
    }
    let sender_id = if is_group {
        data["author"]
            .as_str()
            .or_else(|| data["senderPhone"].as_str())
            .or_else(|| data["from"].as_str())
    } else {
        data["senderPhone"]
            .as_str()
            .or_else(|| data["from"].as_str())
    };
    vec![InboundMessage {
        chat_id: chat_id.to_string(),
        access_chat_id: None,
        text,
        author_name: author_name(data),
        sender_id: sender_id.map(str::to_string),
        message_id: data["id"].as_str().map(str::to_string),
        is_group,
        attachments,
        channel_action: None,
        // WhatsApp reports no language; replies use the owner's.
        locale: None,
    }]
}

pub(super) fn author_name(data: &Value) -> Option<String> {
    data["contact"]["name"]
        .as_str()
        .or_else(|| data["contact"]["pushName"].as_str())
        .or_else(|| data["senderName"].as_str())
        .or_else(|| data["pushName"].as_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
}

pub(super) fn message_text(data: &Value) -> String {
    let mut text = data["body"]
        .as_str()
        .or_else(|| data["caption"].as_str())
        .unwrap_or_default()
        .to_string();
    if text.is_empty() {
        if let Some(quoted) = data["quotedMessage"]["body"].as_str() {
            text = format!("[replying to: {quoted}]");
        }
    }
    match data["type"].as_str().unwrap_or_default() {
        "location" => {
            let latitude = data["location"]["latitude"]
                .as_f64()
                .map(|value| value.to_string())
                .unwrap_or_else(|| data["latitude"].to_string());
            let longitude = data["location"]["longitude"]
                .as_f64()
                .map(|value| value.to_string())
                .unwrap_or_else(|| data["longitude"].to_string());
            let description = data["location"]["description"]
                .as_str()
                .or_else(|| data["location"]["address"].as_str())
                .unwrap_or_default();
            text = format!("[location: {latitude}, {longitude}{description}]");
        }
        "poll" => {
            let name = data["poll"]["name"]
                .as_str()
                .or_else(|| data["pollName"].as_str())
                .unwrap_or("Poll");
            text = format!("[poll: {name}]");
        }
        "contact" if text.is_empty() => text = "[contact card]".to_string(),
        _ => {}
    }
    text
}

pub(super) fn attachment_from(data: &Value) -> Option<Attachment> {
    let kind_name = data["type"].as_str()?;
    let kind = match kind_name {
        "audio" => {
            if data["voice"].as_bool().unwrap_or(false)
                || data["media"]["voice"].as_bool().unwrap_or(false)
                || kind_name == "voice"
            {
                AttachmentKind::Voice
            } else {
                AttachmentKind::Audio
            }
        }
        "voice" => AttachmentKind::Voice,
        "image" | "sticker" => AttachmentKind::Image,
        "video" => AttachmentKind::Video,
        "document" => AttachmentKind::Document,
        _ => return None,
    };
    let media = data.get("media").filter(|value| value.is_object());
    let has_media = data["hasMedia"].as_bool().unwrap_or(false) || media.is_some();
    if !has_media {
        return None;
    }
    let media = media.unwrap_or(data);
    Some(Attachment {
        kind: Some(kind),
        url: media["url"].as_str().map(str::to_string),
        // OpenWA's webhook payload may omit large inline bytes. The message id
        // resolves through its authenticated media archive endpoint instead.
        file_id: data["id"].as_str().map(str::to_string),
        mime: media["mimetype"]
            .as_str()
            .or_else(|| media["mimeType"].as_str())
            .map(str::to_string),
        filename: media["filename"].as_str().map(str::to_string),
        size: media["sizeBytes"].as_u64(),
    })
}

pub(super) fn verify_signature(secret: &str, signature: Option<&str>, body: &[u8]) -> bool {
    let Some(signature) = signature.and_then(|value| value.strip_prefix("sha256=")) else {
        return false;
    };
    let Ok(expected) = hex::decode(signature) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

pub(super) fn is_help_request(text: &str) -> bool {
    match commands::parse_command(text) {
        Some((name, _)) => matches!(name.as_str(), "help" | "commands"),
        None => false,
    }
}
