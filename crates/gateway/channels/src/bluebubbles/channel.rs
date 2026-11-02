//! The [`Channel`] implementation (webhook server, send, typing, read-receipt,
//! tapback and media verbs) and the BlueBubbles API payloads it posts.

use super::*;

#[async_trait]
impl Channel for BlueBubblesChannel {
    fn name(&self) -> &'static str {
        "bluebubbles"
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    /// iMessage is plain text with attachments and nothing else — no markdown, no
    /// streaming edits, no threads, no command menu. Everything expressive it *does*
    /// have rides on the Private API helper, so those capabilities are reported from
    /// config rather than hard-coded: claiming `typing` without the helper would make
    /// [`handle_turn`] spin a keepalive against an endpoint that always 404s.
    ///
    /// `voice` is NOT gated on the helper. [`Channel::send_voice`] uploads the WAV
    /// through the ordinary attachment endpoint — the same one `attachments: true`
    /// already claims unconditionally — so it works on a plain bridge. Gating it
    /// would not avoid a silent failure; it would BE one, dropping a spoken reply
    /// the operator explicitly asked for even though the path that delivers it works.
    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            typing: self.private_api,
            reactions: self.private_api,
            voice: true,
            attachments: true,
            rich_text: false,
            streaming: false,
            threads: false,
            command_menu: false,
            reply_keyboards: false,
            inline_buttons: false,
        }
    }

    /// The Private API indicator persists until cleared rather than expiring on a
    /// few seconds like Telegram's, so this only needs to be slow liveness.
    fn typing_interval(&self) -> Duration {
        Duration::from_secs(8)
    }

    /// `POST /api/v1/message/text`.
    ///
    /// `tempGuid` is the client-side idempotency key BlueBubbles echoes back on the
    /// resulting `new-message` event; it must be unique per send, which is what
    /// [`temp_guid`] derives.
    ///
    /// # Errors
    /// Returns `Err` on transport failure, a non-2xx, or an error envelope from the
    /// server (a chat guid that no longer exists, AppleScript refusing the send).
    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let chat_guid = self.target_chat_guid(chat_id)?;
        let payload = send_text_payload(
            &chat_guid,
            &temp_guid(&chat_guid, text, nanos()),
            text,
            self.private_api,
        );
        let body: Value = self
            .request(Method::POST, "message/text")
            .json(&payload)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?
            .error_for_status()
            .map_err(reqwest::Error::without_url)?
            .json()
            .await?;
        check_envelope(&body)?;
        self.clear_typing(&chat_guid).await;
        Ok(())
    }

    /// Send Core's synthesized WAV as an iMessage attachment.
    ///
    /// iMessage has no voice-note primitive a bridge can drive, so
    /// [`media::wav_delivery`] classifies this platform as [`VoiceDelivery::AudioFile`]
    /// and the user receives a playable audio attachment rather than a waveform
    /// bubble.
    ///
    /// **Assumed endpoint**: `POST /api/v1/message/attachment`, multipart, with the
    /// file under the `attachment` field alongside `chatGuid`/`tempGuid`/`name`.
    ///
    /// # Errors
    /// Returns `Err` when the platform cannot carry the audio at all, or the upload
    /// fails.
    async fn send_voice(
        &self,
        chat_id: &str,
        wav: Vec<u8>,
        delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        if delivery == VoiceDelivery::Unsupported {
            anyhow::bail!("bluebubbles cannot carry this audio format");
        }
        let chat_guid = self.target_chat_guid(chat_id)?;
        let name = "reply.wav";
        let temp = temp_guid(&chat_guid, name, nanos());
        let part = reqwest::multipart::Part::bytes(wav)
            .file_name(name.to_string())
            .mime_str("audio/wav")?;
        let form = reqwest::multipart::Form::new()
            .text("chatGuid", chat_guid.clone())
            .text("tempGuid", temp)
            .text("name", name.to_string())
            .part("attachment", part);
        self.request(Method::POST, "message/attachment")
            .multipart(form)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?
            .error_for_status()
            .map_err(reqwest::Error::without_url)?;
        self.clear_typing(&chat_guid).await;
        Ok(())
    }

    /// Place a tapback on a message. iMessage has exactly six, so an arbitrary emoji
    /// is mapped onto the nearest one and anything unmappable is skipped rather than
    /// sent as a reply message — a stray "👍" as its own bubble is worse than no
    /// acknowledgement.
    ///
    /// **Assumed endpoint**: `POST /api/v1/message/react` with
    /// `{chatGuid, selectedMessageGuid, reaction}`. Best-effort throughout: the
    /// error is logged, never propagated.
    async fn react(&self, chat_id: &str, message_id: &str, emoji: &str) -> anyhow::Result<()> {
        if !self.private_api {
            return Ok(());
        }
        let chat_guid = self.target_chat_guid(chat_id)?;
        let Some(reaction) = tapback_for_emoji(emoji) else {
            debug!(
                channel = "bluebubbles",
                emoji, "no iMessage tapback matches this emoji; skipping"
            );
            return Ok(());
        };
        self.best_effort(
            "react",
            self.request(Method::POST, "message/react").json(&json!({
                "chatGuid": chat_guid,
                "selectedMessageGuid": message_id,
                "reaction": reaction,
            })),
        )
        .await;
        Ok(())
    }

    /// Mark the chat read (clears the badge on the operator's other devices).
    ///
    /// **Assumed endpoint**: `POST /api/v1/chat/{guid}/read`. Private API only, and
    /// additionally gated on `send_read_receipts` because a bot silently clearing an
    /// operator's unread badges is a surprising default. Best-effort.
    async fn mark_read(&self, chat_id: &str, _message_id: &str) -> anyhow::Result<()> {
        if !(self.private_api && self.runtime.cfg.send_read_receipts) {
            return Ok(());
        }
        let chat_guid = self.target_chat_guid(chat_id)?;
        self.best_effort(
            "mark read",
            self.request(Method::POST, &format!("chat/{chat_guid}/read")),
        )
        .await;
        Ok(())
    }

    /// Show the "…" bubble.
    ///
    /// **Assumed endpoint**: `POST /api/v1/chat/{guid}/typing`. Unlike the other
    /// best-effort verbs this one propagates its failure, because that is how
    /// [`crate::keep_typing`] learns to stop re-asserting an indicator the platform
    /// will never show — the error is logged there and the turn continues.
    ///
    /// # Errors
    /// Returns `Err` when the Private API helper is absent or the call fails.
    async fn send_typing(&self, chat_id: &str) -> anyhow::Result<()> {
        if !self.private_api {
            anyhow::bail!("bluebubbles typing indicator needs the Private API helper");
        }
        let chat_guid = self.target_chat_guid(chat_id)?;
        self.request(Method::POST, &format!("chat/{chat_guid}/typing"))
            .send()
            .await
            .map_err(reqwest::Error::without_url)?
            .error_for_status()
            .map_err(reqwest::Error::without_url)?;
        Ok(())
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        if let Some(reporter) = &self.runtime.status {
            reporter.connecting().await;
        }

        // iMessage has no command menu to publish, but `/help` still lists what Core
        // offers, so the menu is fetched once at startup like every other channel.
        let cmds = self.runtime.refresh_commands().await;
        debug!(
            channel = "bluebubbles",
            count = cmds.len(),
            "cached channel command menu"
        );

        // Reachability is reported but NOT fatal: the Mac may be asleep, and the
        // receiver is still worth binding — BlueBubbles will deliver as soon as it
        // wakes, and a dead outbound path surfaces on the first reply attempt.
        match self.ping().await {
            Ok(()) => info!(
                channel = "bluebubbles",
                server = %self.server_url,
                private_api = self.private_api,
                "bluebubbles server reachable"
            ),
            Err(err) => {
                warn!(
                    channel = "bluebubbles",
                    server = %self.server_url,
                    %err,
                    "bluebubbles server did not answer ping; binding the receiver anyway"
                );
                if let Some(reporter) = &self.runtime.status {
                    reporter
                        .error(&format!("bluebubbles ping failed: {err}"))
                        .await;
                }
            }
        }

        let addr: SocketAddr = self.webhook_bind.parse().map_err(|e| {
            anyhow::anyhow!(
                "invalid bluebubbles webhook_bind {}: {e}",
                self.webhook_bind
            )
        })?;
        if is_publicly_routable(addr.ip()) {
            warn!(
                channel = "bluebubbles",
                %addr,
                "bluebubbles webhook is bound to a routable address — BlueBubbles does \
                 not sign its webhooks, so this ingress is protected only by the shared \
                 token; prefer a loopback/LAN bind behind a reverse proxy"
            );
        }

        let state = WebhookState {
            channel: Arc::clone(&self),
            host,
        };
        // Two routes for one handler: BlueBubbles' settings screen only takes a URL,
        // so the token normally rides as the trailing path segment, but a proxy that
        // rewrites paths can pass it as `?token=` or a header on the bare route.
        let app = Router::new()
            .route(&self.webhook_path, post(receive_webhook))
            .route(
                &format!("{}/:token", self.webhook_path),
                post(receive_webhook_token),
            )
            .layer(DefaultBodyLimit::max(MAX_WEBHOOK_BYTES))
            .with_state(state);

        let listener = tokio::net::TcpListener::bind(addr).await?;
        info!(
            channel = "bluebubbles",
            url = %self.webhook_url_hint(&addr),
            "bluebubbles webhook receiver listening — paste this URL into BlueBubbles \
             Server → Settings → Webhooks"
        );

        // A webhook receiver blocks in `serve` with no poll cadence of its own, so a
        // ticker re-asserts `online`; aborting it when `serve` returns lets a stopped
        // bot go stale (→ offline) instead of looking healthy forever.
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

/// Body for `POST /api/v1/message/text`.
///
/// `method` picks the send path on the Mac: `apple-script` always works, while
/// `private-api` (the helper) is what allows subject lines, effects and replies.
/// Pure so the shape is pinned by a test rather than by a live server.
pub(super) fn send_text_payload(
    chat_guid: &str,
    temp_guid: &str,
    text: &str,
    private_api: bool,
) -> Value {
    json!({
        "chatGuid": chat_guid,
        "tempGuid": temp_guid,
        "message": text,
        "method": if private_api { "private-api" } else { "apple-script" },
    })
}

/// Derive the per-send idempotency key BlueBubbles calls `tempGuid`.
///
/// This crate has neither a UUID nor an RNG dependency, so the id is a SHA-256 over
/// the chat, the text and a nanosecond clock read — the same trick
/// [`crate::pairing`] uses to mint codes without an RNG. Uniqueness comes from the
/// clock, not from the message, so sending identical text twice yields two ids;
/// `nanos` is a parameter precisely so a test can pin the mapping.
pub(super) fn temp_guid(chat_guid: &str, text: &str, nanos: u128) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-bluebubbles-temp-guid\0");
    hasher.update(chat_guid.as_bytes());
    hasher.update(b"\0");
    hasher.update(text.as_bytes());
    hasher.update(nanos.to_le_bytes());
    format!("ryu-{}", hex::encode(&hasher.finalize()[..16]))
}

/// Nanoseconds since the epoch, saturating to 0 before it.
pub(super) fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Map an emoji onto one of iMessage's six tapbacks, or `None` when nothing fits.
pub(super) fn tapback_for_emoji(emoji: &str) -> Option<&'static str> {
    match emoji.trim() {
        "❤️" | "❤" | "🥰" | "😍" => Some("love"),
        "👍" | "✅" | "🙂" => Some("like"),
        "👎" | "❌" => Some("dislike"),
        "😂" | "🤣" | "😄" => Some("laugh"),
        "‼️" | "‼" | "❗" | "🔥" => Some("emphasize"),
        "❓" | "?" | "🤔" => Some("question"),
        _ => None,
    }
}
