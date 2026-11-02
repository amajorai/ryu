//! Turning Bot API updates into channel turns: voice-note download, turn spawning
//! with delivery claims, update dispatch (messages, callbacks, reactions, guest
//! queries) and the webhook server.

use super::*;

impl TelegramChannel {
    /// Resolve and download every SPEECH attachment, returning
    /// `(index, bytes)` pairs for [`ChannelRuntime::ingest_media`].
    ///
    /// Only speech is fetched: `ingest_media` skips anything else, and
    /// [`handle_turn`] annotates images and documents from their metadata alone,
    /// so downloading a 20 MB video would buy nothing. Failures are logged and the
    /// attachment is skipped — one unreadable file must not lose the turn.
    pub(super) async fn download_speech(
        &self,
        attachments: &[Attachment],
    ) -> Vec<(usize, Vec<u8>)> {
        let mut out = Vec::new();
        for (index, attachment) in attachments.iter().enumerate() {
            if !attachment.resolved_kind().is_speech() {
                continue;
            }
            // Refuse an oversized file on the declared size, before spending the
            // bandwidth; `media::download` re-checks what actually arrives.
            if let Some(size) = attachment.size {
                if size as usize > media::MAX_ATTACHMENT_BYTES {
                    warn!(
                        size,
                        "telegram attachment exceeds the size cap; skipping download"
                    );
                    continue;
                }
            }
            let Some(file_id) = attachment.file_id.as_deref() else {
                continue;
            };
            let path = match self.call("getFile", json!({ "file_id": file_id })).await {
                Ok(result) => result["file_path"].as_str().map(str::to_string),
                Err(err) => {
                    warn!(%err, "telegram getFile failed; attachment skipped");
                    continue;
                }
            };
            let Some(path) = path else {
                warn!("telegram getFile returned no file_path; attachment skipped");
                continue;
            };
            if self.options.local_mode {
                match tokio::fs::read(&path).await {
                    Ok(bytes) if bytes.len() <= media::MAX_ATTACHMENT_BYTES => {
                        out.push((index, bytes));
                    }
                    Ok(_) => warn!("telegram local attachment exceeds the size cap"),
                    Err(err) => warn!(%err, "telegram local attachment read failed"),
                }
            } else {
                let url = format!("{}/{path}", self.file_base);
                match media::download(&self.runtime.http, &url, &[]).await {
                    Ok(bytes) => out.push((index, bytes)),
                    Err(err) => warn!(%err, "telegram attachment download failed"),
                }
            }
        }
        out
    }

    /// Show a "Thinking…" draft, ingest media, then run the shared path — all on
    /// a dedicated task so a slow agent call never stalls polling for other chats.
    ///
    /// The draft goes FIRST, before the download and transcription of a voice
    /// note, because that is the slowest stretch of the turn (media I/O allows
    /// itself two minutes) and the one with no other feedback: the typing
    /// keepalive does not start until [`handle_turn`] reaches its agent call.
    ///
    /// Both the draft and the media round trip therefore run BEFORE the access
    /// gate, which lives inside `handle_turn` along with the Core call and the
    /// send. Two consequences worth stating rather than discovering: an unpaired
    /// stranger sees "Thinking…" a beat ahead of the pairing prompt, and their
    /// voice note costs one Core STT call before being refused. Avoiding either
    /// would mean re-implementing the gate out here, which is exactly what this
    /// kernel exists to prevent.
    pub(super) fn spawn_turn(
        self: &Arc<Self>,
        host: Arc<dyn ChannelHost>,
        message: InboundMessage,
        draft: Option<i64>,
        provider_id: String,
        claimed_delivery_id: Option<String>,
    ) {
        let channel = Arc::clone(self);
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
                            "telegram delivery could not be durably claimed; processing once without dedupe"
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
                    "duplicate telegram delivery suppressed"
                );
                return;
            }

            let mut message = message;
            // A stranger should see the pairing prompt, not a "Thinking…" draft and
            // a transcription bill. Both of those run ahead of `handle_turn`'s
            // authoritative gate, so consult its read-only twin first.
            let admitted = channel
                .runtime
                .already_admitted(channel.name(), &message)
                .await;
            if admitted {
                if let Some(draft_id) = draft {
                    if let Err(err) = channel.send_draft(&message.chat_id, draft_id, "").await {
                        debug!(%err, "telegram draft placeholder not shown");
                    }
                }
                if !message.attachments.is_empty() {
                    let downloaded = channel.download_speech(&message.attachments).await;
                    channel.runtime.ingest_media(&mut message, downloaded).await;
                }
            }
            let work_channel = Arc::clone(&channel);
            let work_host = Arc::clone(&host);
            let work_delivery_id = delivery_id.clone();
            run_claimed_delivery(channel, delivery_id, move || {
                let channel = Arc::clone(&work_channel);
                let host = Arc::clone(&work_host);
                let message = message.clone();
                let delivery_id = work_delivery_id.clone();
                async move {
                    handle_turn_with_delivery(channel, host, message, Some(&delivery_id)).await
                }
            })
            .await;
        });
    }

    /// Normalize and dispatch one update. Keeping this separate means webhook
    /// delivery and long polling share exactly the same mention, topic, guest,
    /// media and access behavior.
    pub(super) fn dispatch_update(
        self: &Arc<Self>,
        host: Arc<dyn ChannelHost>,
        update: Update,
        me: &BotIdentity,
        claimed_delivery_id: Option<String>,
    ) {
        let provider_id = format!("update:{}", update.update_id);
        if let Some(guest) = update.guest_message {
            if self.options.guest_mode {
                if let Some(inbound) = guest_inbound(&guest) {
                    self.spawn_turn(host, inbound, None, provider_id, claimed_delivery_id);
                } else {
                    warn!("telegram guest_message had no guest_query_id; dropped");
                    complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
                }
            } else {
                complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            }
            return;
        }

        if let Some(reaction) = update.message_reaction {
            if self.runtime.cfg.reaction_learning.enabled {
                spawn_reaction_delivery(
                    Arc::clone(self),
                    reaction,
                    me.id,
                    provider_id,
                    claimed_delivery_id,
                );
            } else {
                complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            }
            return;
        }

        if let Some(callback) = update.callback_query {
            let callback_id = callback.id.clone();
            let channel = Arc::clone(self);
            tokio::spawn(async move {
                if let Err(error) = channel
                    .call(
                        "answerCallbackQuery",
                        json!({ "callback_query_id": callback_id }),
                    )
                    .await
                {
                    debug!(%error, "telegram callback acknowledgement failed");
                }
            });

            let Some(data) = callback.data.as_deref() else {
                complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
                return;
            };
            let action = match decode_callback_data(data) {
                Ok(action) => action,
                Err(error) => {
                    debug!(%error, "telegram callback data was not issued by Ryu");
                    complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
                    return;
                }
            };
            let Some(message) = callback.message else {
                // Inline-mode messages have no chat id, so this channel session
                // cannot safely route them to the originating conversation.
                complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
                return;
            };
            let mut action = action;
            if let Some(label) = callback_button_label(&message, data) {
                action.label = label;
            }
            let thread = thread_of(&message);
            let inbound = InboundMessage {
                chat_id: pack_thread(&message.chat.id.to_string(), thread.as_deref()),
                access_chat_id: is_group_chat(&message.chat.chat_type)
                    .then(|| message.chat.id.to_string()),
                text: format!("Selected: {}", action.label),
                author_name: (!callback.from.first_name.is_empty())
                    .then_some(callback.from.first_name.clone()),
                sender_id: Some(callback.from.id.to_string()),
                message_id: (message.message_id != 0).then(|| message.message_id.to_string()),
                is_group: is_group_chat(&message.chat.chat_type),
                channel_action: Some(action),
                locale: callback.from.language_code.clone(),
                ..Default::default()
            };
            self.spawn_turn(host, inbound, None, provider_id, claimed_delivery_id);
            return;
        }

        let Some(message) = update.message else {
            complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            return;
        };
        let raw_text = message
            .text
            .clone()
            .or_else(|| message.caption.clone())
            .unwrap_or_default();
        let attachments = attachments_from(&message);
        if raw_text.trim().is_empty() && attachments.is_empty() {
            complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            return;
        }
        let Some(routed_text) = decide_reply_with_options(
            &message,
            &raw_text,
            me,
            self.runtime.cfg.group_reply_mode,
            &self.options,
        ) else {
            complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            return;
        };
        let thread = thread_of(&message);
        if self.options.ignored_threads.iter().any(|ignored| {
            let ignored = ignored.trim();
            thread.as_deref() == Some(ignored)
                || thread
                    .as_deref()
                    .and_then(|value| value.get(1..))
                    .is_some_and(|value| value == ignored)
        }) {
            complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            return;
        }
        let chat_id = pack_thread(&message.chat.id.to_string(), thread.as_deref());
        let is_private = message.chat.chat_type == "private";
        let draft = (self.runtime.cfg.streaming && is_private && message.message_id != 0)
            .then_some(message.message_id);
        let inbound = InboundMessage {
            chat_id,
            access_chat_id: is_group_chat(&message.chat.chat_type)
                .then(|| message.chat.id.to_string()),
            text: routed_text,
            author_name: message
                .from
                .as_ref()
                .map(|from| from.first_name.clone())
                .filter(|name| !name.is_empty()),
            sender_id: message.from.as_ref().map(|from| from.id.to_string()),
            message_id: (message.message_id != 0).then(|| message.message_id.to_string()),
            is_group: is_group_chat(&message.chat.chat_type),
            attachments,
            channel_action: None,
            locale: sender_locale(&message),
        };
        self.spawn_turn(host, inbound, draft, provider_id, claimed_delivery_id);
    }

    pub(super) async fn run_webhook(
        self: Arc<Self>,
        host: Arc<dyn ChannelHost>,
        me: BotIdentity,
    ) -> anyhow::Result<()> {
        let public_url = self
            .options
            .webhook_url
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("telegram webhook URL is missing"))?;
        let secret = self
            .options
            .webhook_secret
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("telegram webhook secret is missing"))?;
        self.call(
            "setWebhook",
            json!({
                "url": public_url,
                "secret_token": secret,
                "allowed_updates": ["message", "guest_message", "message_reaction", "callback_query"],
                "drop_pending_updates": false,
            }),
        )
        .await?;

        let bind = self.options.webhook_bind.clone();
        let path = normalize_webhook_path(&self.options.webhook_path);
        let listener = TcpListener::bind(&bind).await?;
        let (tx, mut rx) = mpsc::channel::<PendingUpdate>(128);
        let app = Router::new()
            .route(&path, post(telegram_webhook))
            .with_state(TelegramWebhookState {
                tx,
                secret: secret.to_string(),
                channel: Arc::downgrade(&self),
            });
        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, app).await {
                warn!(%err, "telegram webhook listener stopped");
            }
        });
        info!(bind = %bind, path = %path, "telegram webhook listener started");
        if let Some(reporter) = &self.runtime.status {
            reporter.online().await;
        }

        while let Some(pending) = rx.recv().await {
            self.dispatch_update(
                Arc::clone(&host),
                pending.update,
                &me,
                Some(pending.delivery_id),
            );
            if let Some(reporter) = &self.runtime.status {
                reporter.online().await;
            }
        }
        anyhow::bail!("telegram webhook receiver closed")
    }
}
