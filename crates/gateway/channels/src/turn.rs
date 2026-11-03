//! The shared inbound path every adapter calls ([`handle_turn`]), token
//! rejection, and spawning a channel's run loop.

use super::*;

// ─── The shared inbound path ────────────────────────────────────────────────

/// Handle one inbound message end to end: gate it, ingest its media, run it, and
/// deliver the reply with the best verbs the platform has.
///
/// This is what makes channel registration reusable — every adapter funnels
/// through here, so only the transport and the platform verbs differ per channel.
pub async fn handle_turn<C: Channel + 'static>(
    channel: Arc<C>,
    host: Arc<dyn ChannelHost>,
    message: InboundMessage,
) -> ChannelTurnOutcome {
    handle_turn_with_delivery(channel, host, message, None).await
}

/// Handle one inbound message with its provider delivery identity. The identity
/// is forwarded to Core for session-backed turns, where Core can replay a
/// completed result if the outbound provider call timed out after the model turn
/// already persisted. Callers without a provider event id use [`handle_turn`].
pub async fn handle_turn_with_delivery<C: Channel + 'static>(
    channel: Arc<C>,
    host: Arc<dyn ChannelHost>,
    mut message: InboundMessage,
    delivery_id: Option<&str>,
) -> ChannelTurnOutcome {
    let runtime = channel.runtime();
    let platform = channel.name();

    // 1. Access gate. Groups are static; DMs may issue a pairing challenge, which
    //    is the one "denied" case that still sends a reply.
    let decision = if message.is_group {
        runtime
            .cfg
            .access
            .decide_group_for_sender(message.access_chat(), message.sender_id.as_deref())
    } else {
        runtime
            .cfg
            .access
            .decide_dm(&runtime.pairing, platform, message.identity())
            .await
    };
    match decision {
        Decision::Allow => {}
        Decision::Deny => {
            warn!(
                channel = platform,
                is_group = message.is_group,
                "channel inbound refused by access policy"
            );
            return ChannelTurnOutcome::Completed;
        }
        Decision::Challenge(code) | Decision::Pending(code) => {
            info!(
                channel = platform,
                "channel inbound held for pairing approval"
            );
            let locale = runtime.reply_locale(message.locale.as_deref()).await;
            if let Err(err) = channel
                .send_message(&message.chat_id, &i18n::pairing_prompt(locale, &code))
                .await
            {
                warn!(channel = platform, %err, "failed to deliver pairing prompt");
                return ChannelTurnOutcome::Failed;
            }
            return ChannelTurnOutcome::Completed;
        }
    }

    // 2. Acknowledge receipt on platforms that support it, before the slow part.
    //    Gated on its OWN setting: an operator who turned typing off has not
    //    asked to stop marking messages read, and vice versa.
    if runtime.cfg.send_read_receipts {
        if let Some(message_id) = message.message_id.clone() {
            let _ = channel.mark_read(&message.chat_id, &message_id).await;
        }
    }

    // A reaction is an acknowledgement, not a second conversation turn. Keep it
    // best-effort so a missing reactions scope never blocks the actual answer.
    if runtime.cfg.lifecycle_reactions && channel.caps().reactions {
        if let Some(message_id) = message.message_id.as_deref() {
            let _ = channel
                .react(&message.chat_id, message_id, WORKING_REACTION)
                .await;
        }
    }

    // 3. Fold attachments into the turn text (voice → transcript, others → note).
    if !message.attachments.is_empty() {
        message.text = media::annotate(&message.text, &message.attachments);
    }
    if message.text.trim().is_empty() {
        warn!(
            channel = platform,
            "channel inbound had no usable text after media ingest; dropping"
        );
        return ChannelTurnOutcome::Completed;
    }

    // 4. Thread the reply where the platform supports it, and key the Core
    //    conversation to the thread so each one keeps its own history.
    let platform_target = if channel.caps().threads {
        channel.open_thread(&message.chat_id, &message).await
    } else {
        message.chat_id.clone()
    };
    let conversation_id = runtime.core_conversation_id(&platform_target);

    // 5. Typing indicator for the duration of the agent call. The guard aborts on
    //    drop, so every early return below stops it too.
    let _typing = if runtime.cfg.typing_indicator && channel.caps().typing {
        Some(keep_typing(Arc::clone(&channel), platform_target.clone()))
    } else {
        None
    };

    info!(
        channel = platform,
        voice = message.is_voice(),
        "channel inbound message received"
    );

    // 6. Run the turn: Core's session seam when an agent/team is bound (history
    //    persists, governance stays on path), else the legacy gateway pipeline.
    let mut run_succeeded = true;
    let mut assistant_message_ids = Vec::new();
    let mut interactive_markup = None;
    let mut agent_reactions = Vec::new();
    let reply = if runtime.routes_via_core() {
        match runtime
            .run_via_core(
                &conversation_id,
                &message.text,
                message.author_name.as_deref(),
                delivery_id,
                message.channel_action.as_ref(),
            )
            .await
        {
            Ok(result) if !result.reply.is_empty() => {
                assistant_message_ids = result.assistant_message_ids;
                interactive_markup = result.interactive_markup;
                agent_reactions = result.agent_reactions;
                result.reply
            }
            Ok(result) => {
                assistant_message_ids = result.assistant_message_ids;
                interactive_markup = result.interactive_markup;
                agent_reactions = result.agent_reactions;
                let locale = runtime.reply_locale(message.locale.as_deref()).await;
                i18n::render(locale, i18n::messages::NO_RESPONSE_MESSAGE, &[])
            }
            Err(err) => {
                run_succeeded = false;
                // The full error stays in the log: reqwest's `Display` carries
                // the internal Core URL, which chat users must not see.
                warn!(channel = platform, %err, "channel Core session run failed");
                // Deliberately generic: the cause stays in the log above.
                let locale = runtime.reply_locale(message.locale.as_deref()).await;
                i18n::render(locale, i18n::messages::TURN_FAILED_MESSAGE, &[])
            }
        }
    } else {
        let body = build_request_body(channel.model(), channel.system_prompt(), &message.text);
        match host.run_pipeline(platform, body).await {
            Ok(response) => match extract_reply(&response) {
                Some(reply) => reply,
                None => {
                    let locale = runtime.reply_locale(message.locale.as_deref()).await;
                    i18n::render(locale, i18n::messages::NO_RESPONSE_MESSAGE, &[])
                }
            },
            Err(err) => {
                run_succeeded = false;
                // The Gateway's English error text stays in the log; the
                // reply is one localized sentence per actionable kind.
                warn!(channel = platform, %err, "channel pipeline run failed");
                let locale = runtime.reply_locale(message.locale.as_deref()).await;
                crate::turn_error::failure_reply(locale, &err)
            }
        }
    };

    // 7. Deliver. Rich text when the platform and the operator both want it.
    let sent = channel
        .send_reply_with_markup(
            &platform_target,
            &reply,
            runtime.cfg.rich_text,
            interactive_markup.as_ref(),
        )
        .await;
    let provider_message_ids = match sent {
        Ok(ids) => ids,
        Err(err) => {
            warn!(
                channel = platform,
                %err,
                "failed to deliver channel reply"
            );
            return ChannelTurnOutcome::Failed;
        }
    };
    if !assistant_message_ids.is_empty() {
        runtime
            .bind_sent_messages(
                platform,
                &platform_target,
                &provider_message_ids,
                &assistant_message_ids,
            )
            .await;
    }

    if channel.caps().reactions {
        if let Some(message_id) = message.message_id.as_deref() {
            for (op, emoji) in finish_reactions(
                runtime.cfg.lifecycle_reactions,
                run_succeeded,
                &agent_reactions,
            ) {
                let _ = match op {
                    ReactionOp::Add => channel.react(&message.chat_id, message_id, emoji).await,
                    ReactionOp::Remove => {
                        channel
                            .remove_reaction(&message.chat_id, message_id, emoji)
                            .await
                    }
                };
            }
        }
    }

    // 8. Optional spoken reply, alongside (never instead of) the text — a voice
    //    note the user cannot skim is worse than one they can.
    if runtime.cfg.voice_reply.should_speak(message.is_voice()) && channel.caps().voice {
        let delivery = media::wav_delivery(platform);
        if delivery == VoiceDelivery::Unsupported {
            warn!(
                channel = platform,
                "voice reply requested but the platform cannot carry Core's WAV output"
            );
        } else {
            match media::speak(&runtime.http, &runtime.cfg.core_url, &reply).await {
                Ok(wav) => {
                    if let Err(err) = channel.send_voice(&platform_target, wav, delivery).await {
                        warn!(channel = platform, %err, "failed to deliver spoken reply");
                    }
                }
                Err(err) => warn!(channel = platform, %err, "speech synthesis failed"),
            }
        }
    }
    ChannelTurnOutcome::Completed
}

// NOTE: the legacy `handle_message(&C, host, InboundMessage)` entry point is
// deliberately GONE rather than kept as a deprecated shim. It could not honestly
// be made backwards compatible: the shared path now runs the pairing gate, media
// ingest and thread packing, so a "compatible" shim would have quietly changed
// the behaviour of every caller that kept using it — including gating inbound
// that used to flow. Deleting it turns that into a compile error at each call
// site, which is where the decision belongs. Every adapter calls `handle_turn`.

/// The platform rejected the adapter's own credential — its token is no longer
/// valid, and no amount of retrying with it will help.
///
/// This exists as a distinct type rather than a string an operator greps for
/// because it is the one transport failure a *supervisor* must act on instead of
/// back off on: a Telegram token can be replaced out from under a running
/// adapter (the owner rotates it in Telegram, or `replaceManagedBotToken` mints a
/// new one), and the only recovery is a fresh token plus a new adapter — the
/// token is baked into the API base at construction, so it cannot be mutated in
/// place. Treated as a generic transport error it becomes an unauthorized poll
/// every few seconds, forever, with the bot silently deaf.
///
/// Deliberately carries no payload: the failing URL contains the token, so the
/// message must never be built from the transport error's own `Display`.
#[derive(Debug, Clone, Copy)]
pub struct TokenRejected;

impl std::fmt::Display for TokenRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("channel credential rejected by the platform (401 unauthorized)")
    }
}

impl std::error::Error for TokenRejected {}

/// Is this error (or anything it wraps) a [`TokenRejected`]?
///
/// Walks the whole chain rather than testing the outermost error so an adapter
/// stays free to add `.context(...)` on the way out without changing how a
/// supervisor classifies the failure.
pub fn is_token_rejected(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| cause.is::<TokenRejected>())
}

/// Spawn one channel's inbound loop on a dedicated task. A channel that fails to
/// construct or whose loop errors is logged and skipped so it never takes down
/// the gateway or any sibling channel.
pub fn spawn_channel<C: Channel + 'static>(
    host: &Arc<dyn ChannelHost>,
    channel: anyhow::Result<C>,
) {
    let host = Arc::clone(host);
    tokio::spawn(async move {
        // The error is already logged inside `run_channel`; a fire-and-forget
        // caller has nothing further to do with it.
        let _ = run_channel(&host, channel).await;
    });
}

/// Register a channel and await its inbound loop on the *current* task,
/// returning why it ended.
///
/// Split out of [`spawn_channel`] so a caller that must observe the outcome —
/// the gateway's token-rotation supervisor, which respawns a Telegram adapter
/// whose token was replaced ([`TokenRejected`]) — runs the same registration
/// path (the DM-policy warning, the `registering channel` line) instead of
/// re-deriving it and drifting from it.
///
/// # Errors
/// Returns the construction error, or whatever the channel's loop exited with.
/// Both are logged here, so the two callers stay symmetrical in the log.
pub async fn run_channel<C: Channel + 'static>(
    host: &Arc<dyn ChannelHost>,
    channel: anyhow::Result<C>,
) -> anyhow::Result<()> {
    let channel = match channel {
        Ok(channel) => Arc::new(channel),
        Err(err) => {
            warn!(error = %err, "failed to register channel");
            return Err(err);
        }
    };
    let name = channel.name();
    let access = &channel.runtime().cfg.access;
    match access.dm {
        DmPolicy::Open => warn!(
            channel = name,
            "channel registered in OPEN mode — every DM is answered and billed to this operator"
        ),
        DmPolicy::Pairing => info!(
            channel = name,
            "channel registered with DM pairing — unknown senders get a code to be approved"
        ),
        DmPolicy::Allowlist | DmPolicy::Disabled => {}
    }
    info!(channel = name, "registering channel");
    let opening = tokio::spawn(run_proactive_opening(Arc::clone(&channel)));
    let result = Arc::clone(&channel).run(Arc::clone(host)).await;
    opening.abort();
    if let Err(err) = &result {
        warn!(channel = name, error = %err, "channel loop exited with error");
    }
    result
}
