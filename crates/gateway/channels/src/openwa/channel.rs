//! The [`Channel`] implementation: the webhook server loop and the send, typing,
//! reaction and media verbs.

use super::*;

#[derive(Clone)]
pub(super) struct WebhookState {
    pub(super) channel: Arc<OpenWaChannel>,
    pub(super) host: Arc<dyn ChannelHost>,
}

#[async_trait]
impl Channel for OpenWaChannel {
    fn name(&self) -> &'static str {
        PLATFORM
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            typing: true,
            rich_text: false,
            streaming: false,
            threads: false,
            command_menu: false,
            voice: true,
            attachments: true,
            reactions: true,
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
            self.send_json_value(
                Method::POST,
                &["sessions", &self.session_id, "messages", "send-text"],
                &json!({ "chatId": chat_id, "text": part, "linkPreview": false }),
            )
            .await?;
        }
        Ok(())
    }

    async fn send_typing(&self, chat_id: &str) -> anyhow::Result<()> {
        self.send_json(
            Method::POST,
            &["sessions", &self.session_id, "chats", "typing"],
            &json!({ "chatId": chat_id, "state": "typing" }),
        )
        .await
    }

    async fn mark_read(&self, chat_id: &str, _message_id: &str) -> anyhow::Result<()> {
        if !self.runtime.cfg.send_read_receipts {
            return Ok(());
        }
        self.send_json(
            Method::POST,
            &["sessions", &self.session_id, "chats", "read"],
            &json!({ "chatId": chat_id }),
        )
        .await
    }

    async fn react(&self, chat_id: &str, message_id: &str, emoji: &str) -> anyhow::Result<()> {
        self.send_json(
            Method::POST,
            &["sessions", &self.session_id, "messages", "react"],
            &json!({ "chatId": chat_id, "messageId": message_id, "emoji": emoji }),
        )
        .await
    }

    async fn send_voice(
        &self,
        chat_id: &str,
        wav: Vec<u8>,
        _delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        // OpenWA's documented ptt path requires OGG/Opus. Its optional media
        // conversion endpoint is the safe bridge from Core's WAV output.
        let converted = self
            .send_json_value(
                Method::POST,
                &["sessions", &self.session_id, "media", "convert", "voice"],
                &json!({ "base64": STANDARD.encode(wav) }),
            )
            .await
            .map_err(|err| {
                anyhow::anyhow!(
                    "OpenWA voice conversion failed; enable MEDIA_CONVERSION_ENABLED: {err}"
                )
            })?;
        let Some(base64) = converted["base64"].as_str() else {
            anyhow::bail!("OpenWA voice conversion returned no base64 payload");
        };
        let mimetype = converted["mimetype"]
            .as_str()
            .unwrap_or("audio/ogg; codecs=opus");
        self.send_json_value(
            Method::POST,
            &["sessions", &self.session_id, "messages", "send-audio"],
            &json!({
                "chatId": chat_id,
                "base64": base64,
                "mimetype": mimetype,
                "ptt": true,
            }),
        )
        .await?;
        Ok(())
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        if let Some(reporter) = &self.runtime.status {
            reporter.connecting().await;
        }
        if let Err(err) = self.ensure_session_started().await {
            if let Some(reporter) = &self.runtime.status {
                reporter
                    .error(&format!("OpenWA session setup failed: {err}"))
                    .await;
            }
            return Err(err);
        }
        if let Err(err) = self.ensure_webhook().await {
            if let Some(reporter) = &self.runtime.status {
                reporter
                    .error(&format!("OpenWA webhook setup failed: {err}"))
                    .await;
            }
            return Err(err);
        }

        let commands = self.runtime.refresh_commands().await;
        debug!(
            channel = PLATFORM,
            count = commands.len(),
            "loaded command list for WhatsApp Personal"
        );

        let addr: SocketAddr = self.webhook_bind.parse().map_err(|err| {
            anyhow::anyhow!(
                "invalid whatsapp personal webhook_bind {}: {err}",
                self.webhook_bind
            )
        })?;
        let app = Router::new()
            .route(&self.webhook_path, post(receive_webhook))
            .with_state(WebhookState {
                channel: Arc::clone(&self),
                host,
            });
        let listener = tokio::net::TcpListener::bind(addr).await?;
        info!(addr = %addr, path = %self.webhook_path, session = %self.session_id, "whatsapp personal webhook receiver listening");
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
