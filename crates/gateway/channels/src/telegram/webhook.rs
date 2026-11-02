//! The webhook receiver, delivery completion and reaction spawning, plus the pure
//! id and retry helpers (API base, path normalising, message splitting, chat
//! targets) that every send path shares.

use super::*;

// ─── Pure helpers (payload building, id packing, message parsing) ─────────────
//
// Everything below takes primitives and returns values, so the wire shapes are
// unit-testable without a Telegram to talk to. That is the whole reason the
// `send_*` methods are thin.

#[derive(Clone)]
pub(super) struct TelegramWebhookState {
    pub(super) tx: mpsc::Sender<PendingUpdate>,
    pub(super) secret: String,
    pub(super) channel: Weak<TelegramChannel>,
}

pub(super) struct PendingUpdate {
    pub(super) update: Update,
    pub(super) delivery_id: String,
}

/// Constant-time check of the presented `X-Telegram-Bot-Api-Secret-Token`
/// against the configured webhook secret. Both sides are hashed first so the
/// comparison always runs over two fixed-width digests: how long a rejection
/// takes reveals neither how many leading bytes matched nor the secret's
/// length (the operator chooses it, so unlike a fixed-width token it is not
/// public).
pub(super) fn webhook_secret_matches(expected: &str, presented: &str) -> bool {
    let expected = Sha256::digest(expected.as_bytes());
    let presented = Sha256::digest(presented.as_bytes());
    let mut diff = 0u8;
    for (x, y) in expected.iter().zip(presented.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub(super) async fn telegram_webhook(
    State(state): State<TelegramWebhookState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let presented = headers
        .get("x-telegram-bot-api-secret-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !webhook_secret_matches(&state.secret, presented) {
        return StatusCode::UNAUTHORIZED;
    }
    if body.len() > 1024 * 1024 {
        return StatusCode::PAYLOAD_TOO_LARGE;
    }
    let Ok(update) = serde_json::from_slice::<Update>(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    let provider_id = format!("update:{}", update.update_id);
    let Some(channel) = state.channel.upgrade() else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    let (delivery_id, claim) = match claim_inbound_delivery(&*channel, &provider_id).await {
        Ok(result) => result,
        Err(error) => {
            warn!(%error, "telegram webhook delivery could not be durably claimed");
            return StatusCode::SERVICE_UNAVAILABLE;
        }
    };
    if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
        debug!(
            delivery_id = %delivery_id,
            ?claim,
            "duplicate telegram webhook delivery suppressed"
        );
        return StatusCode::OK;
    }

    let pending = PendingUpdate {
        update,
        delivery_id: delivery_id.clone(),
    };
    match state.tx.try_send(pending) {
        Ok(()) => StatusCode::OK,
        Err(error) => {
            if let Err(persist_error) = channel
                .runtime
                .pairing
                .fail_delivery("telegram", &delivery_id)
                .await
            {
                warn!(%persist_error, "telegram webhook queue failure could not be persisted");
            }
            warn!(%error, "telegram webhook queue is unavailable; asking Telegram to retry");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

pub(super) fn complete_claimed_delivery(
    channel: Arc<TelegramChannel>,
    delivery_id: Option<String>,
) {
    let Some(delivery_id) = delivery_id else {
        return;
    };
    tokio::spawn(async move {
        if let Err(error) = channel
            .runtime
            .pairing
            .complete_delivery("telegram", &delivery_id)
            .await
        {
            warn!(%error, "telegram ignored delivery could not be marked complete");
        }
    });
}

pub(super) fn spawn_reaction_delivery(
    channel: Arc<TelegramChannel>,
    reaction: MessageReactionUpdated,
    bot_id: i64,
    provider_id: String,
    claimed_delivery_id: Option<String>,
) {
    tokio::spawn(async move {
        let (delivery_id, claim) = if let Some(delivery_id) = claimed_delivery_id {
            (delivery_id, crate::pairing::DeliveryClaim::Claimed)
        } else {
            match claim_inbound_delivery(&*channel, &provider_id).await {
                Ok(result) => result,
                Err(error) => {
                    warn!(
                        channel = "telegram",
                        %error,
                        "telegram reaction could not be durably claimed; processing once without dedupe"
                    );
                    (
                        scoped_delivery_id(&*channel, &provider_id),
                        crate::pairing::DeliveryClaim::Claimed,
                    )
                }
            }
        };
        if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
            debug!(
                channel = "telegram",
                delivery_id = %delivery_id,
                ?claim,
                "duplicate telegram reaction suppressed"
            );
            return;
        }

        let work_channel = Arc::clone(&channel);
        run_claimed_delivery(channel, delivery_id, move || {
            let channel = Arc::clone(&work_channel);
            let reaction = reaction.clone();
            async move {
                let Some(user) = reaction.user.as_ref() else {
                    // Anonymous group/channel reactions carry actor_chat rather
                    // than a person. They are intentionally not attributed to
                    // Learning's node-wide feedback sink.
                    return ChannelTurnOutcome::Completed;
                };
                if user.id == bot_id {
                    return ChannelTurnOutcome::Completed;
                }
                let is_group = reaction.chat.chat_type != "private";
                if is_group && !channel.runtime.cfg.reaction_learning.allow_group {
                    return ChannelTurnOutcome::Completed;
                }
                let thread = reaction
                    .message_thread_id
                    .map(|id| format!("{TOPIC_TAG}{id}"));
                let target = pack_thread(&reaction.chat.id.to_string(), thread.as_deref());
                let emoji = reaction
                    .new_reaction
                    .iter()
                    .find_map(|item| item.emoji.as_deref())
                    .unwrap_or_default();
                match channel
                    .runtime
                    .record_reaction_feedback(
                        "telegram",
                        &target,
                        &reaction.message_id.to_string(),
                        emoji,
                    )
                    .await
                {
                    Ok(true) => {
                        info!(
                            message_id = reaction.message_id,
                            "telegram reaction recorded as Learning feedback"
                        );
                        ChannelTurnOutcome::Completed
                    }
                    Ok(false) => {
                        debug!(
                            message_id = reaction.message_id,
                            "telegram reaction was not linked to a Core assistant reply"
                        );
                        ChannelTurnOutcome::Completed
                    }
                    Err(error) => {
                        warn!(
                            message_id = reaction.message_id,
                            %error,
                            "telegram reaction feedback failed"
                        );
                        ChannelTurnOutcome::Failed
                    }
                }
            }
        })
        .await;
    });
}

/// Build a Telegram Bot API base from either the public endpoint or a custom
/// local endpoint. A full `/bot<TOKEN>` URL is also accepted for deployments
/// that already template the token into their endpoint.
pub(super) fn api_base(custom: Option<&str>, token: &str, file: bool) -> String {
    let default = if file {
        format!("https://api.telegram.org/file/bot{token}")
    } else {
        format!("https://api.telegram.org/bot{token}")
    };
    let Some(custom) = custom.map(str::trim).filter(|value| !value.is_empty()) else {
        return default;
    };
    let custom = custom.trim_end_matches('/');
    if custom.contains("/bot") {
        return custom.to_string();
    }
    let prefix = if file { "/file" } else { "" };
    format!("{custom}{prefix}/bot{token}")
}

pub(super) fn normalize_webhook_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        "/webhooks/telegram".to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// Split Telegram text at line boundaries and hard-split only when a single
/// line itself exceeds the Bot API ceiling.
pub(super) fn split_message(text: &str, max: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in text.split_inclusive('\n') {
        if line.chars().count() <= max && current.chars().count() + line.chars().count() <= max {
            current.push_str(line);
            continue;
        }
        if !current.trim().is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
        if line.chars().count() > max {
            let mut hard = String::new();
            for ch in line.chars() {
                hard.push(ch);
                if hard.chars().count() == max {
                    chunks.push(std::mem::take(&mut hard));
                }
            }
            current = hard;
        } else {
            current.push_str(line);
        }
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Does this `getUpdates` outcome mean "your token is not valid any more"?
///
/// Telegram says so two ways for the same cause, and both must classify the
/// same: an HTTP `401` on the request, and — because a rejected call arrives with
/// HTTP 200 (see the module header) — `{"ok":false,"error_code":401}` in the
/// envelope. Kept as a pure predicate over the two signals so the rule that
/// decides whether an adapter stops is testable without a Telegram to talk to.
pub(super) fn is_unauthorized(
    status: Option<reqwest::StatusCode>,
    error_code: Option<i64>,
) -> bool {
    status == Some(reqwest::StatusCode::UNAUTHORIZED) || error_code == Some(401)
}

/// How long to wait before retrying a Bot API call that hit flood control, or
/// `None` when the call must fail now.
///
/// Telegram signals flood control as HTTP 429 and/or `error_code: 429`, with
/// the required wait in `parameters.retry_after` seconds. A wait above
/// [`MAX_INLINE_RETRY_AFTER`], or a 429 without a wait, is not retried in place.
/// Pure over the two signals, like [`is_unauthorized`], so the rule is testable
/// without a Telegram to talk to.
pub(super) fn retry_delay(status: reqwest::StatusCode, envelope: &ApiEnvelope) -> Option<Duration> {
    let flood_control =
        status == reqwest::StatusCode::TOO_MANY_REQUESTS || envelope.error_code == Some(429);
    if !flood_control {
        return None;
    }
    let delay = Duration::from_secs(envelope.parameters.as_ref()?.retry_after?);
    (delay <= MAX_INLINE_RETRY_AFTER).then_some(delay)
}

/// The guest query id inside a conversation key, if this is a guest turn.
pub(super) fn guest_query_of(chat_id: &str) -> Option<&str> {
    chat_id.strip_prefix(GUEST_KEY_PREFIX)
}

/// Split a packed conversation key into `(chat_id, thread_tag)`.
///
/// # Errors
/// Returns `Err` when the chat part is not a Telegram integer chat id.
pub(super) fn target(chat_id: &str) -> anyhow::Result<(i64, Option<&str>)> {
    let (chat, thread) = unpack_thread(chat_id);
    let parsed: i64 = chat
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid telegram chat id: {chat_id}"))?;
    Ok((parsed, thread))
}

/// Is this chat type a multi-user room?
pub(super) fn is_group_chat(chat_type: &str) -> bool {
    chat_type == "group" || chat_type == "supergroup"
}
