//! The [`Channel`] implementation: long-poll or webhook mode, and the send,
//! typing, draft, reaction, command-menu and media verbs.

use super::*;

#[async_trait]
impl Channel for TelegramChannel {
    fn name(&self) -> &'static str {
        "telegram"
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    /// Telegram does all of it. `streaming` declares that the platform has a
    /// draft surface — see [`Channel::send_draft`] for what Ryu can currently
    /// put in it.
    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            typing: true,
            rich_text: true,
            streaming: true,
            threads: true,
            command_menu: true,
            voice: true,
            attachments: true,
            reactions: true,
            reply_keyboards: true,
            inline_buttons: true,
        }
    }

    fn typing_interval(&self) -> Duration {
        TYPING_INTERVAL
    }

    /// Plain-text reply. A guest key is answered through `answerGuestQuery`
    /// instead — that is a different outbound path, not a different chat.
    ///
    /// Telegram caps `sendMessage` at 4096 characters. Split on line boundaries
    /// first, then hard-split a single oversized line so a long agent answer is
    /// delivered instead of being rejected as one oversized request.
    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        self.send_text_with_ids(chat_id, text).await?;
        Ok(())
    }

    async fn send_reply(
        &self,
        chat_id: &str,
        text: &str,
        rich_text: bool,
    ) -> anyhow::Result<Vec<String>> {
        if rich_text && self.caps().rich_text {
            self.send_rich_with_ids(chat_id, text).await
        } else {
            self.send_text_with_ids(chat_id, text).await
        }
    }

    async fn send_reply_with_markup(
        &self,
        chat_id: &str,
        text: &str,
        rich_text: bool,
        markup: Option<&InteractiveMarkup>,
    ) -> anyhow::Result<Vec<String>> {
        let Some(markup) = markup else {
            return self.send_reply(chat_id, text, rich_text).await;
        };
        if guest_query_of(chat_id).is_some() {
            return self.send_reply(chat_id, text, rich_text).await;
        }
        let (chat, thread) = target(chat_id)?;
        let chunks = split_message(text, 4096);
        let Some((last, preceding)) = chunks.split_last() else {
            anyhow::bail!("interactive Telegram replies cannot be empty");
        };
        let mut ids = self.send_plain_chunks(chat, thread, preceding).await?;
        let payload = interactive_payload(chat, thread, last, markup)?;
        let result = self.call("sendMessage", payload).await?;
        if let Some(message_id) = result.get("message_id").and_then(Value::as_i64) {
            ids.push(message_id.to_string());
        }
        Ok(ids)
    }

    /// Rich-text reply: `sendRichMessage` with `rich_message = { markdown }`.
    ///
    /// Agent replies are already markdown, so this is the cheap correct mapping.
    /// Any rejection — an older Bot API server that has no such method, a chat
    /// that refuses rich messages — falls back to plain text for the chunk that
    /// failed and every chunk after it: the reply matters more than its
    /// formatting, and chunks already delivered are never resent.
    async fn send_rich(&self, chat_id: &str, markdown: &str) -> anyhow::Result<()> {
        self.send_rich_with_ids(chat_id, markdown).await?;
        Ok(())
    }

    /// Push an ephemeral draft into a PRIVATE chat.
    ///
    /// Telegram's drafts are a 30-second preview that must still be finalized
    /// with a real send, and they are rejected outright in groups.
    ///
    /// **What this is not:** token streaming. Core's `/api/channels/run` is a
    /// single non-streaming request, so there is no partial output to animate.
    /// What the caller gets is the documented empty-text draft — Telegram renders
    /// it as "Thinking…" — held while the agent works, and then replaced by the
    /// real reply from [`handle_turn`]. The `partial` argument is honoured for
    /// the day the Core seam grows a streaming variant; until then it is empty.
    async fn send_draft(&self, chat_id: &str, draft_id: i64, partial: &str) -> anyhow::Result<()> {
        if guest_query_of(chat_id).is_some() {
            return Ok(());
        }
        let (chat, thread) = target(chat_id)?;
        // Defensive: the caller gates on `chat.type == "private"`. A negative id
        // is a group or channel, where the API rejects drafts.
        if chat < 0 {
            return Ok(());
        }
        let (method, payload) = draft_payload(
            chat,
            thread,
            draft_id,
            partial,
            self.runtime.cfg.rich_text && self.caps().rich_text,
        );
        self.call(method, payload).await?;
        Ok(())
    }

    /// `sendChatAction` — the status lasts at most 5 seconds and is cleared the
    /// moment the bot's message lands, so [`crate::keep_typing`] re-asserts it on
    /// [`Self::typing_interval`]. Channel chats do not support it; the resulting
    /// `ok: false` stops the keepalive for that turn rather than looping.
    async fn send_typing(&self, chat_id: &str) -> anyhow::Result<()> {
        if guest_query_of(chat_id).is_some() {
            return Ok(());
        }
        let (chat, thread) = target(chat_id)?;
        self.call("sendChatAction", action_payload(chat, thread, "typing"))
            .await?;
        Ok(())
    }

    /// Send Core's synthesized WAV.
    ///
    /// `sendVoice` accepts only OGG/OPUS, MP3 or M4A, so a WAV must go out as an
    /// audio attachment — which is why [`media::wav_delivery`] returns
    /// [`VoiceDelivery::AudioFile`] for this platform. The `VoiceNote` arm is
    /// kept for the day an encoder makes a real voice bubble possible.
    async fn send_voice(
        &self,
        chat_id: &str,
        wav: Vec<u8>,
        delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        let (method, field) = match delivery {
            VoiceDelivery::AudioFile => ("sendAudio", "audio"),
            VoiceDelivery::VoiceNote => ("sendVoice", "voice"),
            VoiceDelivery::Unsupported => anyhow::bail!("telegram cannot carry this audio"),
        };
        if guest_query_of(chat_id).is_some() {
            anyhow::bail!("telegram guest replies cannot carry audio");
        }
        let (chat, thread) = target(chat_id)?;
        let (topic, dm_topic) = thread_params(thread);

        let part = reqwest::multipart::Part::bytes(wav)
            .file_name("reply.wav")
            .mime_str("audio/wav")?;
        let mut form = reqwest::multipart::Form::new()
            .text("chat_id", chat.to_string())
            .part(field.to_string(), part);
        if let Some(topic) = topic {
            form = form.text("message_thread_id", topic.to_string());
        }
        if let Some(dm_topic) = dm_topic {
            form = form.text("direct_messages_topic_id", dm_topic.to_string());
        }

        let url = format!("{}/{method}", self.api_base);
        let resp = self
            .runtime
            .http
            .post(&url)
            .multipart(form)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?
            .error_for_status()
            .map_err(reqwest::Error::without_url)?;
        let envelope: ApiEnvelope = resp.json().await.map_err(reqwest::Error::without_url)?;
        if !envelope.ok {
            anyhow::bail!(
                "telegram {method} rejected: {}",
                envelope
                    .description
                    .unwrap_or_else(|| "ok=false with no description".to_string())
            );
        }
        Ok(())
    }

    /// Place an emoji reaction (`setMessageReaction`).
    ///
    /// Bots may only use Telegram's fixed reaction set, and a bot holds one
    /// reaction per message, so a new reaction replaces the previous one. An
    /// emoji outside the set is mapped to its closest allowed form, or skipped.
    async fn react(&self, chat_id: &str, message_id: &str, emoji: &str) -> anyhow::Result<()> {
        if guest_query_of(chat_id).is_some() {
            return Ok(());
        }
        let Some(emoji) = telegram_reaction(emoji) else {
            debug!(
                channel = "telegram",
                emoji, "no Telegram bot reaction matches this emoji; skipping"
            );
            return Ok(());
        };
        self.set_reaction(
            chat_id,
            message_id,
            json!([{ "type": "emoji", "emoji": emoji }]),
        )
        .await
    }

    /// Clear this bot's reaction. Telegram keeps one bot reaction per message,
    /// so clearing is setting an empty list rather than naming the emoji.
    async fn remove_reaction(
        &self,
        chat_id: &str,
        message_id: &str,
        _emoji: &str,
    ) -> anyhow::Result<()> {
        if guest_query_of(chat_id).is_some() {
            return Ok(());
        }
        self.set_reaction(chat_id, message_id, json!([])).await
    }

    /// No-op: the Bot API has no way for a bot to mark a chat read. Stated
    /// explicitly rather than inherited so the omission reads as deliberate.
    async fn mark_read(&self, _chat_id: &str, _message_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    /// Register the command menu with `setMyCommands`: the default menu, then one
    /// per catalog language (`language_code`). An EMPTY list leaves the
    /// published menu untouched rather than clearing it with `deleteMyCommands`.
    ///
    /// The instinct is the other way round — a stale menu advertises commands that
    /// no longer exist — but an empty list here is ambiguous: [`commands::fetch`]
    /// returns an empty vec both when Core genuinely publishes nothing AND when it
    /// could not be reached, answered non-2xx, or returned a body that did not
    /// parse. The gateway refreshes the menu once at connect, which is exactly when
    /// it is most likely to win the startup race against Core, so clearing on that
    /// ambiguity would silently wipe the operator's menu on a restart. The two
    /// failures are not symmetric: a stale entry degrades to the agent answering
    /// the command as ordinary text (Core intercepts what it still knows), whereas
    /// a deleted menu is invisible until the operator notices it is gone.
    async fn publish_commands(&self, cmds: &[ChannelCommand]) -> anyhow::Result<()> {
        if cmds.is_empty() {
            debug!("telegram command registry empty; leaving the published menu as it is");
            return Ok(());
        }
        let max = self.options.command_menu_max.clamp(1, 100);
        let menu = &cmds[..cmds.len().min(max)];
        self.call("setMyCommands", commands_payload(menu)).await?;
        // One menu per catalog language. Best-effort: a rejected language keeps
        // Telegram's default (English) menu for those users.
        for (language_code, payload) in localized_commands_payloads(menu) {
            if let Err(err) = self.call("setMyCommands", payload).await {
                warn!(%err, language_code, "telegram localized command menu rejected");
            }
        }
        Ok(())
    }

    /// Push the operator's bot profile. Each field is a separate API call and an
    /// unset field is skipped, so setting only a bio never wipes the name.
    /// Best-effort per field: one rejected call must not drop the other two.
    async fn publish_profile(&self, profile: &BotProfile) -> anyhow::Result<()> {
        let profile = profile.clipped();
        let calls = [
            ("setMyName", "name", profile.name),
            (
                "setMyShortDescription",
                "short_description",
                profile.short_bio,
            ),
            ("setMyDescription", "description", profile.description),
        ];
        let mut failed = Vec::new();
        for (method, field, value) in calls {
            let Some(value) = value else {
                continue;
            };
            if let Err(err) = self.call(method, json!({ field: value })).await {
                warn!(%err, method, "telegram profile field not published");
                failed.push(method);
            }
        }
        // Every field is attempted before reporting, so one rejection does not
        // cost the other two — but the caller is still told, rather than being
        // handed an Ok that means "check the logs".
        if !failed.is_empty() {
            anyhow::bail!("telegram profile fields rejected: {}", failed.join(", "));
        }
        Ok(())
    }

    /// The topic is already packed into the conversation key by the run loop —
    /// Telegram topics are created by users, not by bots, so there is nothing to
    /// open here.
    async fn open_thread(&self, chat_id: &str, _message: &InboundMessage) -> String {
        chat_id.to_string()
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        debug!("telegram channel long-poll loop started");
        // Announce that the bot is registered and connecting before the first
        // (up to 25s) long poll returns, so the sidebar dot lights up promptly.
        if let Some(reporter) = &self.runtime.status {
            reporter.connecting().await;
        }
        // Resolve the bot's own identity once so group-mention detection can
        // recognise `@username` and replies to the bot. A failure here is
        // non-fatal: private chats reply regardless, and group Mentions mode
        // simply falls back to command-only until the next restart.
        let me = match self.get_me().await {
            Ok(identity) => {
                info!(
                    username = identity.username.as_deref().unwrap_or("?"),
                    supports_guest_queries = identity.supports_guest_queries,
                    has_topics_enabled = identity.has_topics_enabled,
                    "telegram bot identity resolved"
                );
                identity
            }
            Err(err) => {
                warn!(
                    error = %err,
                    "telegram getMe failed; group mention detection disabled (private chats unaffected)"
                );
                BotIdentity::default()
            }
        };

        // Publish the menu and profile once per connect. Both are best-effort:
        // a bot with no menu still works, because a typed command reaches Core
        // whether or not the platform advertises it.
        if self.runtime.cfg.publish_commands {
            let cmds = self.runtime.refresh_commands().await;
            if let Err(err) = self.publish_commands(&cmds).await {
                warn!(error = %err, "telegram command menu not published");
            }
        }
        if !self.runtime.cfg.profile.is_empty() {
            let profile = self.runtime.cfg.profile.clone();
            if let Err(err) = self.publish_profile(&profile).await {
                warn!(error = %err, "telegram bot profile not published");
            }
        }

        if self.options.webhook_url.is_some() {
            return self.run_webhook(Arc::clone(&host), me).await;
        }

        // Telegram acknowledges processed updates by advancing the offset to
        // (last update_id + 1); anything below the offset is never re-delivered.
        let mut offset: i64 = 0;

        loop {
            match self.get_updates(offset).await {
                Ok(updates) => {
                    // A successful poll means the bot is live — heartbeat online.
                    if let Some(reporter) = &self.runtime.status {
                        reporter.online().await;
                    }
                    for update in updates {
                        offset = offset.max(update.update_id + 1);
                        self.dispatch_update(Arc::clone(&host), update, &me, None);
                    }
                }
                // A rejected token is terminal for THIS adapter: the token is
                // baked into `api_base`, so recovery means a new adapter built
                // from a new token. Return so the host's supervisor can refresh
                // and respawn — backing off here would poll 401 forever while
                // the bot sits deaf.
                Err(err) if is_token_rejected(&err) => {
                    warn!("telegram token rejected (401); stopping this adapter so the host can refresh it");
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error("bot token rejected by Telegram (401)").await;
                    }
                    return Err(err);
                }
                Err(err) => {
                    warn!(error = %err, "telegram getUpdates failed, backing off");
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error(&err.to_string()).await;
                    }
                    tokio::time::sleep(ERROR_BACKOFF).await;
                }
            }
        }
    }
}
