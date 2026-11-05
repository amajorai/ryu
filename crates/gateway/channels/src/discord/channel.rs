//! The [`Channel`] implementation: the Gateway or polling loop, and the send,
//! typing, thread, reaction and media verbs.

use super::*;

#[async_trait]
impl Channel for DiscordChannel {
    fn name(&self) -> &'static str {
        "discord"
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    /// Discord speaks typing indicators, threads, arbitrary file attachments and
    /// reactions.
    ///
    /// `rich_text` is deliberately FALSE: Discord message content already renders
    /// the markdown our replies are written in, so plain `content` *is* the rich
    /// surface. Claiming otherwise would send replies through [`Channel::send_rich`]
    /// for no behavioural difference. Streaming drafts are false because Discord
    /// has no draft surface; command menus are registered through interactions.
    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            typing: true,
            rich_text: false,
            streaming: false,
            threads: true,
            command_menu: true,
            voice: true,
            attachments: true,
            reactions: true,
            reply_keyboards: false,
            inline_buttons: false,
        }
    }

    /// Discord's typing indicator lasts 10 seconds, so re-assert it a little under
    /// that rather than on the kernel's tighter Telegram-shaped default.
    fn typing_interval(&self) -> Duration {
        Duration::from_secs(8)
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let target = target_channel(chat_id).to_string();
        for chunk in split_message(text, MAX_MESSAGE_CHARS) {
            self.post_content(&target, &chunk).await?;
        }
        Ok(())
    }

    async fn send_typing(&self, chat_id: &str) -> anyhow::Result<()> {
        let target = target_channel(chat_id);
        let url = format!("{API_BASE}/channels/{target}/typing");
        self.http()
            .post(&url)
            .header("Authorization", self.auth_header())
            // Discord requires a body on this POST; an empty JSON object is the
            // documented shape.
            .json(&json!({}))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Upload the synthesized WAV as a file attachment.
    ///
    /// Discord's true voice-message flag needs an OGG/Opus body plus a waveform,
    /// which Core's TTS does not produce — so [`media::wav_delivery`] reports
    /// [`VoiceDelivery::AudioFile`] and this sends a playable attachment instead of
    /// faking a voice bubble.
    async fn send_voice(
        &self,
        chat_id: &str,
        wav: Vec<u8>,
        delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        if delivery == VoiceDelivery::Unsupported {
            anyhow::bail!("discord was asked to deliver audio it cannot carry");
        }
        let target = target_channel(chat_id);
        let url = format!("{API_BASE}/channels/{target}/messages");
        let part = reqwest::multipart::Part::bytes(wav)
            .file_name(VOICE_FILENAME)
            .mime_str("audio/wav")?;
        let form = reqwest::multipart::Form::new()
            .text("payload_json", voice_payload(VOICE_FILENAME).to_string())
            .part("files[0]", part);
        self.http()
            .post(&url)
            .header("Authorization", self.auth_header())
            .multipart(form)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn react(&self, chat_id: &str, message_id: &str, emoji: &str) -> anyhow::Result<()> {
        let target = target_channel(chat_id);
        let encoded = encode_emoji(emoji);
        let url =
            format!("{API_BASE}/channels/{target}/messages/{message_id}/reactions/{encoded}/@me");
        self.http()
            .put(&url)
            // Discord requires a length on this bodyless PUT; reqwest emits
            // `content-length: 0` for an empty body, so nothing else is needed.
            .body(Vec::new())
            .header("Authorization", self.auth_header())
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Take back this bot's own reaction (`DELETE …/reactions/{emoji}/@me`).
    async fn remove_reaction(
        &self,
        chat_id: &str,
        message_id: &str,
        emoji: &str,
    ) -> anyhow::Result<()> {
        let target = target_channel(chat_id);
        let encoded = encode_emoji(emoji);
        let url =
            format!("{API_BASE}/channels/{target}/messages/{message_id}/reactions/{encoded}/@me");
        self.http()
            .delete(&url)
            .header("Authorization", self.auth_header())
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Push the operator's bot profile. Discord splits it across two objects: the
    /// bot USER carries the name, the APPLICATION carries the description shown on
    /// the app's profile. There is no equivalent of a short bio, so that field is
    /// left unpublished rather than crammed into the description.
    async fn publish_profile(&self, profile: &BotProfile) -> anyhow::Result<()> {
        if let Some(name) = profile.name.as_deref().filter(|n| !n.trim().is_empty()) {
            self.http()
                .patch(format!("{API_BASE}/users/@me"))
                .header("Authorization", self.auth_header())
                .json(&json!({ "username": name }))
                .timeout(REQUEST_TIMEOUT)
                .send()
                .await?
                .error_for_status()?;
        }
        if let Some(description) = profile
            .description
            .as_deref()
            .filter(|d| !d.trim().is_empty())
        {
            self.http()
                .patch(format!("{API_BASE}/applications/@me"))
                .header("Authorization", self.auth_header())
                .json(&json!({ "description": description }))
                .timeout(REQUEST_TIMEOUT)
                .send()
                .await?
                .error_for_status()?;
        }
        Ok(())
    }

    /// Answer inside a thread hung off the triggering message, keeping a busy
    /// channel readable and giving each exchange its own Core history (the packed
    /// key is the conversation id).
    ///
    /// Returns a conversation key, not a `Result`: a thread that could not be
    /// created must degrade to the parent channel, because losing the reply is far
    /// worse than losing the thread.
    async fn open_thread(&self, chat_id: &str, message: &InboundMessage) -> String {
        if !self.thread_replies {
            return chat_id.to_string();
        }
        let (channel_id, existing) = unpack_thread(chat_id);
        if self
            .options
            .no_thread_channels
            .iter()
            .any(|id| id == channel_id)
        {
            return chat_id.to_string();
        }
        if existing.is_some() {
            // Already inside a thread — nest no further.
            return chat_id.to_string();
        }
        let Some(message_id) = message.message_id.as_deref() else {
            return chat_id.to_string();
        };
        let locale = self.runtime.reply_locale(message.locale.as_deref()).await;
        let name = thread_name(&message.text, locale);
        match self.create_thread(channel_id, message_id, &name).await {
            Ok(thread_id) => pack_thread(channel_id, Some(&thread_id)),
            Err(err) => {
                warn!(
                    channel_id = %channel_id,
                    %err,
                    "discord thread creation failed; answering in the parent channel"
                );
                chat_id.to_string()
            }
        }
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        debug!("discord channel Gateway loop started");
        if let Some(reporter) = &self.runtime.status {
            reporter.connecting().await;
        }
        let profile = self.runtime.cfg.profile.clipped();
        if !profile.is_empty() {
            if let Err(err) = self.publish_profile(&profile).await {
                warn!(%err, "discord profile publish failed");
            }
        }
        let me_id = match self.get_me_id().await {
            Ok(id) => id,
            Err(err) => {
                warn!(error = %err, "discord get_me failed; mention detection disabled");
                String::new()
            }
        };
        let _ = self.application_id.set(me_id.clone());
        if self.runtime.cfg.publish_commands {
            let commands = self.runtime.refresh_commands().await;
            if let Err(err) = self.publish_commands(&commands).await {
                warn!(%err, "discord application commands not published");
            }
        }

        let mut reconnect_attempt = 0u32;
        let mut last_seen: HashMap<String, String> = HashMap::new();
        loop {
            let gateway = match self.gateway_url().await {
                Ok(url) => url,
                Err(err) => {
                    reconnect_attempt = reconnect_attempt.saturating_add(1);
                    warn!(%err, "discord Gateway URL lookup failed");
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error(&err.to_string()).await;
                    }
                    tokio::time::sleep(reconnect_delay(reconnect_attempt)).await;
                    continue;
                }
            };
            let url = format!("{gateway}?v=10&encoding=json");
            // Nagle off: a heartbeat or resume frame is never held for an ACK.
            let dialed = tokio_tungstenite::connect_async_with_config(&url, None, true).await;
            let (mut ws, _) = match dialed {
                Ok(pair) => pair,
                Err(err) => {
                    reconnect_attempt = reconnect_attempt.saturating_add(1);
                    warn!(%err, "discord Gateway connection failed");
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error(&err.to_string()).await;
                    }
                    tokio::time::sleep(reconnect_delay(reconnect_attempt)).await;
                    continue;
                }
            };
            // Do NOT reset the backoff on a bare socket open: Discord closes a
            // session right after IDENTIFY for a revoked token (4004) or
            // disallowed intents (4014). Resetting here re-IDENTIFIED every 3 s,
            // burning the 1000-per-day identify budget (Discord then resets the
            // bot token). The counter resets only on READY/RESUMED below.
            reconnect_attempt = reconnect_attempt.saturating_add(1);

            let hello = match ws.next().await {
                Some(Ok(WsMessage::Text(text))) => serde_json::from_str::<GatewayEnvelope>(&text)
                    .ok()
                    .filter(|envelope| envelope.op == 10),
                _ => None,
            };
            let Some(hello) = hello else {
                warn!("discord Gateway did not send HELLO");
                tokio::time::sleep(reconnect_delay(reconnect_attempt)).await;
                continue;
            };
            let heartbeat_ms = hello
                .d
                .as_ref()
                .and_then(|value| value["heartbeat_interval"].as_u64())
                .unwrap_or(41_250);
            ws.send(WsMessage::Text(
                json!({
                    "op": 2,
                    "d": {
                        "token": self.token,
                        "intents": DISCORD_GATEWAY_INTENTS,
                            "properties": {
                                "os": "ryu",
                                "browser": "ryu",
                                "device": "ryu",
                            },
                            "presence": {
                                "since": 0,
                                "activities": [{"name": "Ryu", "type": 0}],
                                "status": "online",
                                "afk": false
                            }
                    }
                })
                .to_string(),
            ))
            .await?;

            let mut heartbeat = tokio::time::interval(Duration::from_millis(heartbeat_ms));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut thread_parents = ThreadParents::new();
            loop {
                tokio::select! {
                    _ = heartbeat.tick() => {
                        if ws.send(WsMessage::Text(json!({"op": 1, "d": Value::Null}).to_string())).await.is_err() {
                            break;
                        }
                    }
                    frame = ws.next() => {
                        let Some(frame) = frame else { break; };
                        let payload = match frame {
                            Ok(WsMessage::Text(text)) => text,
                            Ok(WsMessage::Ping(data)) => { let _ = ws.send(WsMessage::Pong(data)).await; continue; }
                            Ok(WsMessage::Close(_)) => break,
                            Ok(_) => continue,
                            Err(err) => { warn!(%err, "discord Gateway frame failed"); break; }
                        };
                        let Ok(envelope) = serde_json::from_str::<GatewayEnvelope>(&payload) else { continue; };
                        if envelope.op == 7 || envelope.op == 9 {
                            break;
                        }
                        if envelope.op == 0 {
                            match envelope.event_name.as_deref() {
                                Some("READY") | Some("RESUMED") => {
                                    reconnect_attempt = 0;
                                    if let Some(reporter) = &self.runtime.status { reporter.online().await; }
                                    if self.options.history_backfill {
                                        self.backfill(&host, &me_id, &mut last_seen, &mut thread_parents).await;
                                    }
                                }
                                Some("MESSAGE_CREATE") => {
                                    if let Some(data) = envelope.d {
                                        self.dispatch_gateway_message(Arc::clone(&host), data, &me_id, &mut thread_parents, &mut last_seen).await;
                                    }
                                }
                                Some("INTERACTION_CREATE") => {
                                    if let Some(data) = envelope.d {
                                        // Off the select loop: the interaction runs a whole
                                        // turn, which can take minutes, and awaiting it here
                                        // would starve the heartbeat branch.
                                        let channel = Arc::clone(&self);
                                        let host = Arc::clone(&host);
                                        let me_id = me_id.clone();
                                        tokio::spawn(async move {
                                            channel.handle_interaction(data, host, &me_id).await;
                                        });
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            if let Some(reporter) = &self.runtime.status {
                reporter.connecting().await;
            }
            tokio::time::sleep(reconnect_delay(reconnect_attempt)).await;
        }
    }
}
