//! The [`Channel`] implementation: the Socket Mode read loop and the send,
//! typing, reaction and media verbs.

use super::*;

#[async_trait]
impl Channel for SlackChannel {
    fn name(&self) -> &'static str {
        "slack"
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    /// What Slack actually does.
    ///
    /// `command_menu` is FALSE on purpose: a Slack slash command only exists if
    /// it is declared in the app's manifest and re-installed by the operator —
    /// there is no runtime "register these commands" API the way Telegram has
    /// `setMyCommands`. Publishing a menu from here is impossible, so claiming
    /// the capability would only produce a call that always fails.
    ///
    /// `streaming` is FALSE because Slack has no draft/partial surface; a stream
    /// would have to be faked by editing a posted message, which reads worse than
    /// one complete answer.
    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            // Best-effort: a real typing indicator needs the (retired) RTM API, so
            // this is the assistant thread status — see `send_typing`.
            typing: true,
            rich_text: true,
            streaming: false,
            threads: true,
            command_menu: false,
            voice: true,
            attachments: true,
            reactions: true,
            reply_keyboards: false,
            inline_buttons: false,
        }
    }

    /// The assistant status is sticky rather than expiring after a few seconds
    /// like Telegram's, so it only needs re-asserting rarely — often enough to
    /// recover from a dropped call, not often enough to be a poll loop.
    fn typing_interval(&self) -> Duration {
        Duration::from_secs(20)
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        for chunk in split_slack_text(text, 4000) {
            self.post_text(chat_id, &chunk).await?;
        }
        self.clear_typing(chat_id).await;
        Ok(())
    }

    /// Post the reply as mrkdwn. Without the conversion Slack renders the agent's
    /// CommonMark literally: `**bold**` shows its asterisks and `[a](b)` shows its
    /// brackets.
    async fn send_rich(&self, chat_id: &str, markdown: &str) -> anyhow::Result<()> {
        self.send_message(chat_id, &to_mrkdwn(markdown)).await
    }

    /// Show that the agent is working.
    ///
    /// A bot **cannot** send a real typing indicator over the Web API — that was
    /// an RTM feature and RTM is retired. The supported modern equivalent is
    /// `assistant.threads.setStatus`, which needs the assistant scopes; for a
    /// plain bot it simply fails, and that is fine.
    ///
    /// Returning `Err` on that failure is deliberate: [`crate::keep_typing`]
    /// treats one error as "this platform will not show an indicator this turn"
    /// and stops re-asserting, so a bot without the assistant scopes makes
    /// exactly one wasted call per turn instead of one every interval. The error
    /// never reaches the message loop.
    ///
    async fn send_typing(&self, chat_id: &str) -> anyhow::Result<()> {
        // Slack scopes the status to a thread; with no thread there is nothing to
        // set, which is not a failure.
        let (channel, thread_ts) = unpack_thread(chat_id);
        let Some(thread_ts) = thread_ts else {
            return Ok(());
        };
        // The assistant thread status, shown italicised under the conversation
        // header where a human's "is typing…" would appear.
        let locale = self.runtime().owner_locale().await;
        let status = i18n::render(locale, i18n::messages::SLACK_THINKING_MESSAGE, &[]);
        let body: ApiAck = self
            .http()
            .post(format!("{SLACK_API_BASE}/assistant.threads.setStatus"))
            .bearer_auth(&self.bot_token)
            .json(&json!({
                "channel_id": channel,
                "thread_ts": thread_ts,
                "status": status,
            }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        body.into_result("assistant.threads.setStatus")
    }

    /// Send synthesized speech as a file. Slack has no voice-note bubble, so
    /// [`media::wav_delivery`] classifies it as an audio file; anything else
    /// means the caller and this adapter disagree and is refused loudly.
    async fn send_voice(
        &self,
        chat_id: &str,
        wav: Vec<u8>,
        delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        if delivery == VoiceDelivery::Unsupported {
            anyhow::bail!("slack cannot deliver this audio");
        }
        let (channel, thread_ts) = unpack_thread(chat_id);
        self.upload_file(channel, thread_ts, "reply.wav", wav).await
    }

    /// Place an emoji reaction on the triggering message.
    ///
    /// Best-effort by contract: a duplicate reaction, a missing `reactions:write`
    /// scope or a deleted message are all logged and swallowed, because a failed
    /// acknowledgement must never affect the turn that follows it.
    async fn react(&self, chat_id: &str, message_id: &str, emoji: &str) -> anyhow::Result<()> {
        self.reaction_call("reactions.add", chat_id, message_id, emoji)
            .await;
        Ok(())
    }

    /// Take back a reaction this bot placed. Same best-effort contract as
    /// [`Channel::react`]: `no_reaction` is logged, never surfaced.
    async fn remove_reaction(
        &self,
        chat_id: &str,
        message_id: &str,
        emoji: &str,
    ) -> anyhow::Result<()> {
        self.reaction_call("reactions.remove", chat_id, message_id, emoji)
            .await;
        Ok(())
    }

    /// No-op. Slack's `conversations.mark` moves a *user's* read cursor and needs
    /// a user token with `conversations.write`; a bot has no unread state of its
    /// own to clear, so there is nothing honest to call here.
    async fn mark_read(&self, _chat_id: &str, _message_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    /// Answer inside the triggering message's thread: its own thread when it
    /// already had one, otherwise a new thread rooted at the message — which is
    /// what keeps a busy channel readable. No API call is needed; on Slack a
    /// thread comes into existence when the first reply carries `thread_ts`.
    async fn open_thread(&self, chat_id: &str, message: &InboundMessage) -> String {
        if !self.options.reply_in_thread {
            return chat_id.to_string();
        }
        conversation_key(chat_id, message.message_id.as_deref())
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        debug!("slack channel socket-mode loop started");
        if let Some(reporter) = &self.runtime.status {
            reporter.connecting().await;
        }

        // Learn our own user id up front: the mention gate matches against it.
        // FAIL-OPEN — a bot that can't resolve its id (missing `users:read`-free
        // `auth.test` access, a revoked token) still connects and answers every
        // channel message, exactly as it did before this gate existed. Turning a
        // scope gap into a silent, dead bot would be the worse failure.
        match self.auth_test().await {
            Ok(id) => {
                info!(bot_user_id = %id, "slack: bot identity resolved");
                let _ = self.bot_user_id.set(id);
            }
            Err(err) => {
                warn!(
                    error = %err,
                    "slack auth.test failed; the mention gate will fail open (the bot \
                     answers every channel message it can see)"
                );
            }
        }

        // Consecutive failed opens/connects. Reset the moment a socket comes up.
        let mut attempts: u32 = 0;

        loop {
            let ws_url = match self.open_connection().await {
                Ok(url) => url,
                Err(err) => {
                    attempts += 1;
                    if attempts >= MAX_RECONNECT_ATTEMPTS {
                        return self.give_up(attempts, &err).await;
                    }
                    let delay = reconnect_delay(attempts);
                    warn!(
                        error = %err,
                        attempt = attempts,
                        max_attempts = MAX_RECONNECT_ATTEMPTS,
                        backoff_ms = delay.as_millis() as u64,
                        "slack apps.connections.open failed, backing off"
                    );
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error(&err.to_string()).await;
                    }
                    tokio::time::sleep(delay).await;
                    continue;
                }
            };

            // Nagle off: an envelope ack is never held for the peer's ACK.
            match tokio_tungstenite::connect_async_with_config(&ws_url, None, true).await {
                Ok((mut ws, _)) => {
                    debug!("slack socket-mode websocket connected");
                    // A live socket clears the failure budget: the next outage
                    // starts its backoff from scratch.
                    attempts = 0;
                    // The socket is open — the bot is live. Re-asserted below on
                    // each idle timeout so a quiet channel stays fresh.
                    if let Some(reporter) = &self.runtime.status {
                        reporter.online().await;
                    }
                    // Read frames, but wake every HEARTBEAT_INTERVAL even when idle
                    // to re-report `online` (the connection is still healthy).
                    loop {
                        let next = tokio::time::timeout(HEARTBEAT_INTERVAL, ws.next()).await;
                        let frame = match next {
                            Ok(Some(frame)) => frame,
                            Ok(None) => break,
                            Err(_) => {
                                if let Some(reporter) = &self.runtime.status {
                                    reporter.online().await;
                                }
                                continue;
                            }
                        };
                        let payload = match frame {
                            Ok(WsMessage::Text(text)) => text,
                            Ok(WsMessage::Ping(data)) => {
                                let _ = ws.send(WsMessage::Pong(data)).await;
                                continue;
                            }
                            Ok(WsMessage::Close(_)) => break,
                            Ok(_) => continue,
                            Err(err) => {
                                warn!(error = %err, "slack websocket read error");
                                break;
                            }
                        };

                        // Slack requires an ack envelope echoing the envelope_id
                        // for every events_api / interactive payload it sends.
                        let envelope_id = parse_envelope_id(&payload);
                        if let Some(envelope_id) = envelope_id.as_deref() {
                            let ack = json!({ "envelope_id": envelope_id }).to_string();
                            let _ = ws.send(WsMessage::Text(ack)).await;
                        }

                        if self.handle_interactive(&payload).await {
                            continue;
                        }

                        let Some(parsed) =
                            parse_inbound(&payload).or_else(|| parse_slash_command(&payload))
                        else {
                            continue;
                        };

                        if self
                            .options
                            .ignored_channels
                            .iter()
                            .any(|channel| channel == &parsed.channel)
                        {
                            debug!(channel = %parsed.channel, "slack: channel is ignored");
                            continue;
                        }
                        if !parsed.is_dm
                            && !self.options.allowed_channels.is_empty()
                            && !self
                                .options
                                .allowed_channels
                                .iter()
                                .any(|channel| channel == &parsed.channel)
                        {
                            debug!(channel = %parsed.channel, "slack: channel is not allowed");
                            continue;
                        }

                        // Second loop guard, on the bot's own USER id rather than
                        // on `bot_id`. It matters now that the adapter uploads
                        // files: a file the bot shares comes back as an inbound
                        // `file_share`, and one that slipped through would be
                        // downloaded and transcribed before any gate saw it —
                        // the bot answering its own voice note, forever.
                        if is_self_authored(parsed.sender_id.as_deref(), self.bot_user_id()) {
                            debug!("slack: ignoring the bot's own message");
                            continue;
                        }

                        // The conversation key the reply will land in. Computed
                        // here as well as in `open_thread` (same function, so the
                        // two cannot drift) because the active-thread memory is
                        // keyed by it.
                        let conversation =
                            conversation_key(&parsed.channel, parsed.message_id.as_deref());

                        // Honour the admin's group-reply choice. A channel message
                        // that doesn't address the bot is dropped here, before any
                        // model call is made.
                        let in_active_thread = self.active_threads.lock().is_ok_and(|threads| {
                            thread_is_active(&threads, &conversation, Instant::now())
                        });
                        let Some(text) = decide_reply_with_options(
                            &parsed,
                            self.runtime.cfg.group_reply_mode,
                            self.bot_user_id(),
                            in_active_thread,
                            &self.options,
                        ) else {
                            debug!(
                                channel = %parsed.channel,
                                "slack: message not addressed to the bot, ignoring"
                            );
                            continue;
                        };
                        // The bot now owns this thread: follow-ups in it continue
                        // without a re-@mention (matches the hosted connector).
                        if !parsed.is_dm && self.options.reply_in_thread {
                            if let Ok(mut threads) = self.active_threads.lock() {
                                remember_active_thread(&mut threads, conversation, Instant::now());
                            }
                        }

                        let inbound = InboundMessage {
                            // The BARE channel id: the group allowlist is written
                            // in channel ids, and `open_thread` adds the thread.
                            chat_id: parsed.channel,
                            access_chat_id: None,
                            text,
                            // Slack events carry a user id, not a display name;
                            // resolving it needs `users:read` and a call per
                            // message, so the id is left to the pairing gate and
                            // no name is claimed.
                            author_name: None,
                            sender_id: parsed.sender_id,
                            message_id: parsed.message_id,
                            is_group: !parsed.is_dm,
                            attachments: parsed.attachments,
                            channel_action: None,
                            // No users.info call: replies use the owner's language.
                            locale: None,
                        };
                        let provider_id = inbound.message_id.clone().map_or_else(
                            || {
                                envelope_id
                                    .clone()
                                    .unwrap_or_else(|| "frame:unknown".to_string())
                            },
                            |message_id| format!("message:{message_id}"),
                        );

                        self.spawn_delivery(&host, inbound, provider_id);
                    }
                    debug!("slack socket-mode websocket closed, reconnecting");
                }
                Err(err) => {
                    attempts += 1;
                    if attempts >= MAX_RECONNECT_ATTEMPTS {
                        return self.give_up(attempts, &err.into()).await;
                    }
                    warn!(
                        error = %err,
                        attempt = attempts,
                        max_attempts = MAX_RECONNECT_ATTEMPTS,
                        "slack websocket connect failed, backing off"
                    );
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error(&err.to_string()).await;
                    }
                }
            }

            tokio::time::sleep(reconnect_delay(attempts)).await;
        }
    }
}
