//! The [`Channel`] implementation (webhook server, send, typing, read-receipt,
//! reaction and media verbs) and the Cloud API payloads it posts.

use super::*;

/// State shared into the webhook axum handlers.
#[derive(Clone)]
pub(super) struct WebhookState {
    pub(super) channel: Arc<WhatsAppChannel>,
    pub(super) host: Arc<dyn ChannelHost>,
}

#[async_trait]
impl Channel for WhatsAppChannel {
    fn name(&self) -> &'static str {
        PLATFORM
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    /// WhatsApp shows a typing indicator, carries arbitrary media, and takes emoji
    /// reactions. It has no rich text (only the `*bold*` shorthand plain text
    /// already carries), no message editing to stream a draft into, no threads,
    /// no command menu, and cannot play Core's WAV output.
    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            typing: true,
            attachments: true,
            reactions: true,
            rich_text: false,
            streaming: false,
            threads: false,
            command_menu: false,
            voice: false,
            reply_keyboards: false,
            inline_buttons: false,
        }
    }

    fn typing_interval(&self) -> Duration {
        TYPING_INTERVAL
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let rendered = whatsapp_format::render_markdown(text);
        for part in whatsapp_format::split_text(&rendered) {
            self.post_message(&text_payload(chat_id, &part)).await?;
        }
        Ok(())
    }

    /// Show "typing…" against the newest inbound message in this conversation.
    ///
    /// Returns `Ok` with nothing sent when no inbound id is known — that is a
    /// normal state (an outbound-first conversation), not an error. A genuine
    /// transport failure *is* propagated, because [`crate::keep_typing`] stops the
    /// keepalive on `Err`; swallowing it would re-POST to a broken endpoint every
    /// 20 seconds for the rest of the turn.
    async fn send_typing(&self, chat_id: &str) -> anyhow::Result<()> {
        let Some(message_id) = self.latest_inbound(chat_id).await else {
            debug!(
                channel = PLATFORM,
                "no inbound message id known; skipping typing indicator"
            );
            return Ok(());
        };
        self.post_message(&read_status_payload(&message_id, true))
            .await
    }

    /// Blue-tick the inbound message. Best-effort: logged and swallowed, never
    /// propagated into the message loop.
    ///
    /// Note that WhatsApp's typing indicator is this same call plus one field, so
    /// a turn with both read receipts and the typing indicator enabled makes two
    /// POSTs. That is expected: the read receipt fires immediately on pickup, the
    /// indicator only once the agent starts working.
    ///
    /// [`handle_turn`] already checks `send_read_receipts` before calling this;
    /// re-checking costs nothing and keeps a direct caller (an operator verb, a
    /// future adapter-internal ack) from silently overriding the setting.
    async fn mark_read(&self, _chat_id: &str, message_id: &str) -> anyhow::Result<()> {
        if !self.runtime.cfg.send_read_receipts {
            debug!(
                channel = PLATFORM,
                "read receipts disabled by config; not marking read"
            );
            return Ok(());
        }
        if let Err(err) = self
            .post_message(&read_status_payload(message_id, false))
            .await
        {
            warn!(channel = PLATFORM, %err, "failed to mark whatsapp message read");
        }
        Ok(())
    }

    /// Place an emoji reaction on a message. Best-effort: an acknowledgement that
    /// fails must never take down the turn that produced it.
    async fn react(&self, chat_id: &str, message_id: &str, emoji: &str) -> anyhow::Result<()> {
        if let Err(err) = self
            .post_message(&reaction_payload(chat_id, message_id, emoji))
            .await
        {
            warn!(channel = PLATFORM, %err, "failed to react to whatsapp message");
        }
        Ok(())
    }

    /// WhatsApp removes a reaction by sending the same reaction with an empty
    /// emoji, so the named emoji is not needed.
    async fn remove_reaction(
        &self,
        chat_id: &str,
        message_id: &str,
        _emoji: &str,
    ) -> anyhow::Result<()> {
        if let Err(err) = self
            .post_message(&reaction_payload(chat_id, message_id, ""))
            .await
        {
            warn!(channel = PLATFORM, %err, "failed to remove whatsapp reaction");
        }
        Ok(())
    }

    /// Refuse rather than upload something unplayable. See the module docs: the
    /// Cloud API's audio type does not accept `audio/wav` in any form, so
    /// [`media::wav_delivery`] reports `Unsupported` and [`handle_turn`] never
    /// reaches here. This exists so a direct caller gets an explanation instead of
    /// a silently broken voice note.
    async fn send_voice(
        &self,
        _chat_id: &str,
        _wav: Vec<u8>,
        _delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        anyhow::bail!(
            "whatsapp cannot send Core's WAV output: the Cloud API accepts only \
             ogg/opus, mpeg, mp4, amr and aac audio"
        )
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        if let Some(reporter) = &self.runtime.status {
            reporter.connecting().await;
        }

        // WhatsApp has no menu to publish to, but `/help` is answered from this
        // list, so it is fetched once at startup all the same.
        let commands = self.runtime.refresh_commands().await;
        debug!(
            channel = PLATFORM,
            count = commands.len(),
            "loaded command list for text-triggered help"
        );

        let addr: SocketAddr = self.webhook_bind.parse().map_err(|e| {
            if let Some(reporter) = &self.runtime.status {
                let reporter = reporter.clone();
                let detail = format!("invalid webhook_bind {}", self.webhook_bind);
                tokio::spawn(async move { reporter.error(&detail).await });
            }
            anyhow::anyhow!("invalid whatsapp webhook_bind {}: {e}", self.webhook_bind)
        })?;
        let path = self.webhook_path.clone();

        let webhook_state = WebhookState {
            channel: Arc::clone(&self),
            host,
        };

        let app = Router::new()
            .route(&path, get(verify_webhook).post(receive_webhook))
            .with_state(webhook_state);

        let listener = tokio::net::TcpListener::bind(addr).await?;
        info!(addr = %addr, path = %path, "whatsapp webhook receiver listening");
        // The webhook receiver has no inbound poll cadence — it blocks in `serve`
        // — so a background ticker re-asserts `online` while it's listening. It's
        // aborted when `serve` returns so a stopped bot goes stale (→ offline).
        let heartbeat = self
            .runtime
            .status
            .clone()
            .map(StatusReporter::spawn_heartbeat);
        let result = axum::serve(listener, app).await;
        if let Some(handle) = heartbeat {
            handle.abort();
        }
        result?;
        Ok(())
    }
}

/// A read receipt, optionally carrying the typing indicator.
///
/// Both are addressed to an inbound message id, never to a chat. With
/// `typing = true` WhatsApp shows "typing…" for ~25 seconds or until the bot
/// replies, whichever comes first; without it the message is merely marked read.
pub(super) fn read_status_payload(message_id: &str, typing: bool) -> Value {
    let mut payload = json!({
        "messaging_product": "whatsapp",
        "status": "read",
        "message_id": message_id,
    });
    if typing {
        payload["typing_indicator"] = json!({ "type": "text" });
    }
    payload
}

/// An emoji reaction on a previous message. An empty `emoji` removes it, which is
/// the platform's documented behaviour and is left intact.
pub(super) fn reaction_payload(to: &str, message_id: &str, emoji: &str) -> Value {
    json!({
        "messaging_product": "whatsapp",
        "to": to,
        "type": "reaction",
        "reaction": {
            "message_id": message_id,
            "emoji": emoji,
        },
    })
}
