//! Slack Web API calls the adapter makes on its own behalf: posting and uploading,
//! attachment ingest, giving up after repeated failures, and interactive payloads.

use super::*;

impl SlackChannel {
    /// Post one message, threaded when `chat_id` carries a `thread_ts`.
    ///
    /// `mrkdwn` is Slack's default for `text`, so both the plain and the rich
    /// path land here; only what they put in `text` differs.
    pub(super) async fn post_text(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let (channel, thread_ts) = unpack_thread(chat_id);
        let url = format!("{SLACK_API_BASE}/chat.postMessage");

        let text = match self.options.reply_prefix.as_deref() {
            Some(prefix) if !prefix.is_empty() => format!("{prefix}{text}"),
            _ => text.to_string(),
        };
        let mut payload = json!({
            "channel": channel,
            "text": text,
        });
        if (self.options.rich_blocks || self.options.feedback_buttons)
            && text.chars().count() <= 3000
        {
            let mut blocks = vec![json!({
                "type": "section",
                "text": { "type": "mrkdwn", "text": text },
            })];
            if self.options.feedback_buttons {
                // Slack reports no per-user locale here; buttons use the owner's.
                let locale = self.runtime().owner_locale().await;
                let helpful = i18n::render(locale, i18n::messages::SLACK_HELPFUL_MESSAGE, &[]);
                let needs_work =
                    i18n::render(locale, i18n::messages::SLACK_NEEDS_WORK_MESSAGE, &[]);
                blocks.push(json!({
                    "type": "actions",
                    "elements": [
                        {
                            "type": "button",
                            "text": { "type": "plain_text", "text": helpful },
                            "action_id": "ryu_feedback_helpful",
                            "value": "helpful",
                        },
                        {
                            "type": "button",
                            "text": { "type": "plain_text", "text": needs_work },
                            "action_id": "ryu_feedback_needs_work",
                            "value": "needs_work",
                        },
                    ],
                }));
            }
            payload["blocks"] = Value::Array(blocks);
        }
        // Reply in-thread so multi-turn conversations stay grouped.
        if self.options.reply_in_thread {
            if let Some(ts) = thread_ts {
                payload["thread_ts"] = json!(ts);
                payload["reply_broadcast"] = json!(self.options.reply_broadcast);
            }
        }

        let body: ApiAck = self
            .http()
            .post(&url)
            .bearer_auth(&self.bot_token)
            .json(&payload)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        body.into_result("chat.postMessage")
    }

    /// Upload a file to a channel (and thread) with Slack's modern external
    /// upload flow: reserve a URL, PUT the bytes at it, then complete the upload
    /// so the file is shared into the conversation.
    ///
    /// The legacy `files.upload` fallback is deliberately not implemented — it is
    /// retired, and every failure mode here (missing `files:write`, a workspace
    /// that refuses the upload) is reported to the caller, which already has a
    /// text reply in the conversation to fall back on.
    ///
    /// # Errors
    /// Returns `Err` on transport failure or an `ok:false` from any of the three
    /// steps, carrying Slack's own error string so the operator can act on it.
    pub(super) async fn upload_file(
        &self,
        channel: &str,
        thread_ts: Option<&str>,
        filename: &str,
        bytes: Vec<u8>,
    ) -> anyhow::Result<()> {
        // 1. Reserve an upload URL. This method takes FORM parameters, not a JSON
        //    body (a JSON body is rejected with `invalid_arguments`), and `length`
        //    must be the exact byte count.
        let length = bytes.len().to_string();
        let reserved: UploadUrlResponse = self
            .http()
            .post(format!("{SLACK_API_BASE}/files.getUploadURLExternal"))
            .bearer_auth(&self.bot_token)
            .form(&[("filename", filename), ("length", length.as_str())])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if !reserved.ok {
            anyhow::bail!(
                "slack files.getUploadURLExternal returned ok=false: {}",
                reserved.error.unwrap_or_default()
            );
        }
        let (upload_url, file_id) = match (reserved.upload_url, reserved.file_id) {
            (Some(url), Some(id)) => (url, id),
            _ => anyhow::bail!("slack files.getUploadURLExternal returned no upload url"),
        };

        // 2. POST the bytes to the reserved URL. This one is a plain multipart
        //    upload and answers with text, not JSON.
        let part = reqwest::multipart::Part::bytes(bytes).file_name(filename.to_string());
        let form = reqwest::multipart::Form::new().part("file", part);
        self.http()
            .post(&upload_url)
            .multipart(form)
            .send()
            .await?
            .error_for_status()?;

        // 3. Share it into the conversation. `channel_id` is singular here — the
        //    legacy `channels` list belongs to the retired `files.upload`.
        let mut payload = json!({
            "files": [{ "id": file_id, "title": filename }],
            "channel_id": channel,
        });
        if let Some(ts) = thread_ts {
            payload["thread_ts"] = json!(ts);
        }
        let body: ApiAck = self
            .http()
            .post(format!("{SLACK_API_BASE}/files.completeUploadExternal"))
            .bearer_auth(&self.bot_token)
            .json(&payload)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        body.into_result("files.completeUploadExternal")
    }

    /// Fetch the bytes of every attachment that needs transcribing and fold the
    /// transcripts into the turn text.
    ///
    /// Slack file URLs are private: they answer only to the bot token presented
    /// as a bearer header (an unauthenticated GET quietly returns a login page,
    /// not a 401), which is why the download lives here and not in the kernel.
    /// Non-speech media is not downloaded at all — [`handle_turn`] annotates it
    /// from the filename, and pulling a 20 MB video the agent cannot read would
    /// buy nothing.
    pub(super) async fn ingest_attachments(&self, message: &mut InboundMessage) {
        if message.attachments.is_empty() {
            return;
        }
        // Downloading and transcribing is the expensive part of a turn, and it runs
        // ahead of the access gate inside `handle_turn` — so an unadmitted sender
        // could otherwise spend the operator's STT budget just by attaching audio.
        // `already_admitted` is that gate's read-only twin; the kernel still
        // answers an unknown sender with a pairing prompt.
        if !self.runtime.already_admitted(self.name(), message).await {
            return;
        }
        let auth = format!("Bearer {}", self.bot_token);
        let mut downloaded = Vec::new();
        for (index, attachment) in message.attachments.iter().enumerate() {
            if !attachment.resolved_kind().is_speech() {
                continue;
            }
            let Some(url) = attachment.url.as_deref() else {
                continue;
            };
            // Refuse an oversized file on its declared size, before spending the
            // bandwidth; `media::download` re-checks what actually arrives.
            if attachment
                .size
                .is_some_and(|size| size as usize > media::MAX_ATTACHMENT_BYTES)
            {
                warn!(
                    size = attachment.size,
                    "slack: skipping an attachment over the size cap"
                );
                continue;
            }
            match media::download(self.http(), url, &[("Authorization", auth.as_str())]).await {
                Ok(bytes) => downloaded.push((index, bytes)),
                Err(err) => warn!(%err, "slack: attachment download failed"),
            }
        }
        self.runtime.ingest_media(message, downloaded).await;
    }

    /// Terminal state: the reconnect budget is spent. Report a real, actionable
    /// error to the control plane (the bot's status dot) and stop, instead of
    /// hammering Slack forever on a failure that will never clear by itself.
    pub(super) async fn give_up(&self, attempts: u32, err: &anyhow::Error) -> anyhow::Result<()> {
        let message = format!(
            "slack: giving up after {attempts} failed connection attempts ({err}). Check that \
             the app token starts with xapp-, carries the connections:write scope, and that \
             Socket Mode is enabled for the app."
        );
        warn!("{message}");
        if let Some(reporter) = &self.runtime.status {
            reporter.error(&message).await;
        }
        Err(anyhow::anyhow!(message))
    }

    /// Clear the assistant status after the final reply. Slack's status API is
    /// best-effort for ordinary bot tokens, just like `send_typing`.
    pub(super) async fn clear_typing(&self, chat_id: &str) {
        let (channel, Some(thread_ts)) = unpack_thread(chat_id) else {
            return;
        };
        let result = self
            .http()
            .post(format!("{SLACK_API_BASE}/assistant.threads.setStatus"))
            .bearer_auth(&self.bot_token)
            .json(&json!({
                "channel_id": channel,
                "thread_ts": thread_ts,
                "status": "",
            }))
            .send()
            .await;
        if let Err(err) = result {
            debug!(%err, "slack assistant status clear failed");
        }
    }

    /// Acknowledge feedback buttons rendered in rich replies. Socket Mode
    /// delivers interactive payloads on the same WebSocket as messages; the
    /// envelope is acknowledged by the caller, while the reaction gives the
    /// person a visible confirmation without starting another agent turn.
    pub(super) async fn handle_interactive(&self, raw: &str) -> bool {
        let value: Value = match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(_) => return false,
        };
        if value["type"].as_str() != Some("interactive") {
            return false;
        }

        let payload = &value["payload"];
        if payload["type"].as_str() != Some("block_actions") {
            return true;
        }
        let action_id = payload["actions"]
            .as_array()
            .and_then(|actions| actions.first())
            .and_then(|action| action["action_id"].as_str());
        let emoji = match action_id {
            Some("ryu_feedback_helpful") => "white_check_mark",
            Some("ryu_feedback_needs_work") => "x",
            _ => return true,
        };
        if !self.options.feedback_buttons {
            return true;
        }
        let channel = payload["container"]["channel_id"]
            .as_str()
            .or_else(|| payload["channel"]["id"].as_str());
        let message_ts = payload["container"]["message_ts"]
            .as_str()
            .or_else(|| payload["message"]["ts"].as_str());
        if let (Some(channel), Some(message_ts)) = (channel, message_ts) {
            let _ = self.react(channel, message_ts, emoji).await;
        }
        true
    }
}
