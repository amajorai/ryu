//! Inbound webhook handling: the shared-secret token check, delivery claims, the
//! group reply gate, the local help answer and parsing BlueBubbles events into
//! channel messages.

use super::*;

// ─── Webhook receiver ───────────────────────────────────────────────────────

/// State shared into the axum handlers.
#[derive(Clone)]
pub(super) struct WebhookState {
    pub(super) channel: Arc<BlueBubblesChannel>,
    pub(super) host: Arc<dyn ChannelHost>,
}

/// The token may also arrive as a query parameter.
#[derive(Debug, Default, Deserialize)]
pub(super) struct TokenQuery {
    pub(super) token: Option<String>,
}

/// Bare route: the token must come from `?token=` or the header.
pub(super) async fn receive_webhook(
    State(state): State<WebhookState>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let presented = query
        .token
        .or_else(|| header_token(&headers))
        .unwrap_or_default();
    ingest(state, &presented, &body).await
}

/// Token-in-path route, which is the form the operator actually pastes.
pub(super) async fn receive_webhook_token(
    State(state): State<WebhookState>,
    Path(token): Path<String>,
    body: Bytes,
) -> StatusCode {
    ingest(state, &token, &body).await
}

pub(super) fn header_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// Authenticate, parse, and dispatch one webhook delivery.
///
/// Always answers quickly after a durable claim — the turn runs on its own task —
/// so BlueBubbles does not retry a delivery that is already being handled.
/// Unknown event types are a 200, not an error: the server emits typing, read-status
/// and message-update events on the same hook and treating those as failures would
/// make the operator's log useless.
pub(super) async fn ingest(state: WebhookState, presented: &str, body: &[u8]) -> StatusCode {
    if !token_ok(&state.channel.webhook_secret, presented) {
        warn!(
            channel = "bluebubbles",
            "webhook rejected: missing or wrong shared token"
        );
        return StatusCode::FORBIDDEN;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(body) else {
        warn!(
            channel = "bluebubbles",
            "webhook rejected: body is not JSON"
        );
        return StatusCode::BAD_REQUEST;
    };
    let Some(message) = parse_inbound(&payload) else {
        return StatusCode::OK;
    };

    let provider_id = inbound_delivery_id(&message, body);
    let (delivery_id, claim) = match claim_inbound_delivery(&*state.channel, &provider_id).await {
        Ok(result) => result,
        Err(error) => {
            warn!(%error, "bluebubbles webhook delivery could not be durably claimed");
            return StatusCode::SERVICE_UNAVAILABLE;
        }
    };
    if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
        debug!(
            delivery_id = %delivery_id,
            ?claim,
            "duplicate bluebubbles webhook delivery suppressed"
        );
        return StatusCode::OK;
    }
    let Some(permit) = try_reserve_delivery(&*state.channel) else {
        if let Err(error) = state
            .channel
            .runtime
            .pairing
            .fail_delivery("bluebubbles", &delivery_id)
            .await
        {
            warn!(%error, "bluebubbles webhook capacity failure could not be persisted");
        }
        warn!("bluebubbles webhook capacity is exhausted; asking the bridge to retry");
        return StatusCode::SERVICE_UNAVAILABLE;
    };

    let channel = Arc::clone(&state.channel);
    let host = Arc::clone(&state.host);
    tokio::spawn(async move {
        let mut message = message;
        prepare_message(&channel, &mut message).await;
        let work_channel = Arc::clone(&channel);
        let work_host = Arc::clone(&host);
        let work_delivery_id = delivery_id.clone();
        run_claimed_delivery_with_permit(channel, delivery_id, permit, move || {
            let channel = Arc::clone(&work_channel);
            let host = Arc::clone(&work_host);
            let message = message.clone();
            let delivery_id = work_delivery_id.clone();
            async move { dispatch(channel, host, message, &delivery_id).await }
        })
        .await;
    });
    StatusCode::OK
}

pub(super) async fn dispatch(
    channel: Arc<BlueBubblesChannel>,
    host: Arc<dyn ChannelHost>,
    message: InboundMessage,
    delivery_id: &str,
) -> ChannelTurnOutcome {
    if message.is_group
        && !should_reply_in_group(
            channel.runtime.cfg.group_reply_mode,
            &message.text,
            &channel.mention_patterns,
        )
    {
        debug!(
            channel = "bluebubbles",
            "group message not addressed to the bot; staying quiet"
        );
        return ChannelTurnOutcome::Completed;
    }

    // iMessage has no native command menu, so `/help` is answered here rather
    // than being registered with the platform.
    // A caller who is not admitted yet falls through: the shared turn gate makes
    // the authoritative decision. Denied callers stay silent and pairing callers
    // receive only its challenge.
    if is_local_help(&message.text)
        && channel
            .runtime
            .already_admitted(channel.name(), &message)
            .await
    {
        let locale = channel
            .runtime
            .reply_locale(message.locale.as_deref())
            .await;
        let reply = i18n::command_help(locale, &channel.runtime.commands().await);
        return match channel.send_message(&message.chat_id, &reply).await {
            Ok(()) => ChannelTurnOutcome::Completed,
            Err(err) => {
                warn!(channel = "bluebubbles", %err, "failed to deliver command list");
                ChannelTurnOutcome::Failed
            }
        };
    }

    handle_turn_with_delivery(channel, host, message, Some(delivery_id)).await
}

pub(super) async fn prepare_message(channel: &BlueBubblesChannel, message: &mut InboundMessage) {
    // Transcribe before any text-based decision below: a voice note in a group
    // has no text to check for a command or an address until it is transcribed.
    // Only fetch and transcribe for a sender the gate would admit. The webhook is
    // unauthenticated by design (BlueBubbles does not sign its posts), so without
    // this a forged payload could spend the operator's STT budget.
    if channel
        .runtime
        .already_admitted(channel.name(), message)
        .await
    {
        let downloaded = channel.download_speech(message).await;
        if !downloaded.is_empty() {
            channel.runtime.ingest_media(message, downloaded).await;
        }
    }
}

pub(super) fn inbound_delivery_id(message: &InboundMessage, body: &[u8]) -> String {
    message
        .message_id
        .as_deref()
        .filter(|message_id| !message_id.trim().is_empty())
        .map_or_else(
            || format!("payload:{}", hex::encode(Sha256::digest(body))),
            |message_id| format!("message:{message_id}"),
        )
}

// ─── Pure helpers (payloads, parsing, decisions) ────────────────────────────

/// Parse a BlueBubbles webhook body into an inbound turn, or `None` when there is
/// nothing to answer.
///
/// Pure and synchronous so every rule below is unit-testable without a Mac:
///
/// - only `new-message` is handled; `typing-indicator`, `chat-read-status-change`,
///   `updated-message` and anything else the server grows later fall through,
/// - **`isFromMe` is dropped**. This is the load-bearing check in the whole adapter:
///   the bot's own reply comes straight back through the same webhook, so without it
///   the bot answers itself forever, in a loop nothing else here would break,
/// - the reply target is `chats[0].guid`, and a missing one means we could not
///   answer even if we wanted to.
pub(super) fn parse_inbound(payload: &Value) -> Option<InboundMessage> {
    if payload["type"].as_str() != Some("new-message") {
        return None;
    }
    let data = &payload["data"];
    if data["isFromMe"].as_bool().unwrap_or(false) {
        debug!(channel = "bluebubbles", "ignoring our own outbound message");
        return None;
    }
    let chat = data["chats"].as_array().and_then(|c| c.first())?;
    let chat_id = chat["guid"].as_str()?.to_string();

    let text = data["text"]
        .as_str()
        .unwrap_or_default()
        .replace(OBJECT_REPLACEMENT, "")
        .trim()
        .to_string();
    let attachments: Vec<Attachment> = data["attachments"]
        .as_array()
        .map(|list| list.iter().filter_map(parse_attachment).collect())
        .unwrap_or_default();
    if text.is_empty() && attachments.is_empty() {
        return None;
    }

    Some(InboundMessage {
        chat_id,
        access_chat_id: None,
        text,
        // iMessage has no display name on the wire — the address IS the identity,
        // and resolving a contact card is the recipient's device's job, not ours.
        author_name: None,
        sender_id: data["handle"]["address"].as_str().map(str::to_string),
        message_id: data["guid"].as_str().map(str::to_string),
        is_group: chat["style"].as_i64() == Some(CHAT_STYLE_GROUP),
        attachments,
        channel_action: None,
        // iMessage reports no language; replies use the owner's.
        locale: None,
    })
}

/// One entry of `data.attachments[]`.
///
/// The guid goes in `file_id` (not `url`) because BlueBubbles serves attachment
/// bytes from an authenticated endpoint keyed by guid — exactly the "opaque id
/// needing a resolve step" case [`Attachment`] documents.
pub(super) fn parse_attachment(value: &Value) -> Option<Attachment> {
    let guid = value["guid"].as_str()?.to_string();
    // Apple marks a recorded voice memo explicitly; without that flag an m4a is
    // just as likely to be a shared song, which `resolved_kind` handles from MIME.
    let kind = value["isAudioMessage"]
        .as_bool()
        .unwrap_or(false)
        .then_some(AttachmentKind::Voice);
    Some(Attachment {
        kind,
        url: None,
        file_id: Some(guid),
        mime: value["mimeType"].as_str().map(str::to_string),
        filename: value["transferName"].as_str().map(str::to_string),
        size: value["totalBytes"].as_u64(),
    })
}

/// Derive the shared secret the webhook must present.
///
/// Derived from the server password rather than drawn randomly so it is stable
/// across gateway restarts — an operator who pasted a URL into BlueBubbles once
/// should not have to redo it on every deploy. The path is mixed in so two channels
/// on one node do not share a token, and the password itself is never recoverable
/// from it.
pub(super) fn derive_webhook_secret(password: &str, webhook_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-bluebubbles-webhook\0");
    hasher.update(password.as_bytes());
    hasher.update(b"\0");
    hasher.update(webhook_path.as_bytes());
    hex::encode(&hasher.finalize()[..16])
}

/// Constant-time comparison of the presented token against the expected one.
/// Length is not secret (the token is a fixed-width hex string), so an early return
/// on a length mismatch leaks nothing.
pub(super) fn token_ok(expected: &str, presented: &str) -> bool {
    let (a, b) = (expected.as_bytes(), presented.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Coerce an operator-supplied webhook path into something axum can route: a
/// leading slash, no trailing slash, and never the bare root (the token route would
/// otherwise become `//:token`).
pub(super) fn normalize_webhook_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    let trimmed = trimmed.trim_start_matches('/');
    if trimmed.is_empty() {
        return DEFAULT_WEBHOOK_PATH.to_string();
    }
    format!("/{trimmed}")
}

/// Is this bind address reachable from outside the operator's network?
///
/// Used only to warn. The unspecified address counts as routable because binding
/// `0.0.0.0` exposes the receiver on every interface the host happens to have.
pub(super) fn is_publicly_routable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_loopback() || v4.is_private() || v4.is_link_local()) || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            if v6.is_unspecified() {
                return true;
            }
            let first = v6.segments()[0];
            // `is_unique_local` / `is_unicast_link_local` are still unstable, so the
            // fc00::/7 and fe80::/10 prefixes are matched by hand.
            let unique_local = first & 0xfe00 == 0xfc00;
            let link_local = first & 0xffc0 == 0xfe80;
            !(v6.is_loopback() || unique_local || link_local)
        }
    }
}

/// Should the bot answer this GROUP message?
///
/// iMessage has no @mention primitive a bridge can observe, so `Mentions` mode is
/// approximated: a slash command, or a message that opens by addressing the bot by
/// name. That is a heuristic and is documented as one — the alternative, answering
/// every message in a family group chat, is the failure mode this mode exists to
/// prevent.
pub(super) fn should_reply_in_group(
    mode: GroupReplyMode,
    text: &str,
    mention_patterns: &[String],
) -> bool {
    match mode {
        GroupReplyMode::All => true,
        GroupReplyMode::Mentions => {
            if parse_command(text).is_some() {
                return true;
            }
            let lowered = text.trim_start().to_ascii_lowercase();
            if ["ryu", "@ryu", "hey ryu"]
                .iter()
                .any(|prefix| lowered.starts_with(prefix))
            {
                return true;
            }
            mention_patterns.iter().any(|pattern| {
                let pattern = pattern.trim().to_ascii_lowercase();
                !pattern.is_empty() && lowered.contains(&pattern)
            })
        }
    }
}

/// `/help` and `/commands` are answered locally, since there is no menu to
/// register. Ordinary text and every other command belong to Core and must
/// reach it intact.
pub(super) fn is_local_help(text: &str) -> bool {
    parse_command(text).is_some_and(|(name, _)| name == "help" || name == "commands")
}

/// Reject a BlueBubbles error envelope (`{status, message, data}`).
///
/// The server answers 200 with a non-200 `status` field in some paths, so the HTTP
/// code alone is not enough to know a send landed.
///
/// # Errors
/// Returns `Err` when `status` is present and outside the 2xx range.
pub(super) fn check_envelope(body: &Value) -> anyhow::Result<()> {
    let Some(status) = body["status"].as_i64() else {
        return Ok(());
    };
    if (200..300).contains(&status) {
        return Ok(());
    }
    let message = body["message"].as_str().unwrap_or("unknown error");
    anyhow::bail!("bluebubbles server returned status {status}: {message}")
}
