//! Inbound Discord events: command publishing, Gateway message dispatch,
//! backfill polling and slash-command interactions.

use super::*;

mod command_menu;
use command_menu::command_payload;

impl DiscordChannel {
    /// Register Core's command registry as Discord application commands. The
    /// Gateway delivers the resulting `INTERACTION_CREATE` events to the same
    /// connection as messages, so the menu is real rather than decorative.
    pub(super) async fn publish_commands(
        &self,
        cmds: &[crate::commands::ChannelCommand],
    ) -> anyhow::Result<()> {
        let Some(application_id) = self.application_id.get() else {
            anyhow::bail!("discord application id is not known yet")
        };
        if cmds.is_empty() {
            return Ok(());
        }
        let commands: Vec<Value> = cmds.iter().take(100).map(command_payload).collect();
        self.http()
            .put(format!("{API_BASE}/applications/{application_id}/commands"))
            .header("Authorization", self.auth_header())
            .json(&commands)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub(super) async fn gateway_url(&self) -> anyhow::Result<String> {
        let body: GatewayUrlResponse = self
            .http()
            .get(format!("{API_BASE}/gateway/bot"))
            .header("Authorization", self.auth_header())
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        body.url
            .filter(|url| !url.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("discord Gateway response contained no url"))
    }

    /// Look up whether `channel_id` is a thread and, if so, its parent channel.
    ///
    /// `None` means the lookup failed and the answer is unknown (do not cache
    /// it); `Some(None)` means an ordinary channel; `Some(Some(parent))` a thread.
    pub(super) async fn parent_channel_id(&self, channel_id: &str) -> Option<Option<String>> {
        let response = self
            .http()
            .get(format!("{API_BASE}/channels/{channel_id}"))
            .header("Authorization", self.auth_header())
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        let channel = response.json::<DiscordChannelRef>().await.ok()?;
        Some(thread_parent(&channel))
    }

    pub(super) async fn dispatch_gateway_message(
        self: &Arc<Self>,
        host: Arc<dyn ChannelHost>,
        value: Value,
        me_id: &str,
        thread_parents: &mut ThreadParents,
        last_seen: &mut HashMap<String, String>,
    ) {
        let Ok(message) = serde_json::from_value::<DiscordMessage>(value) else {
            return;
        };
        if message.channel_id.is_empty() || message.id.is_empty() {
            return;
        }
        last_seen.insert(message.channel_id.clone(), message.id.clone());
        if message.author.id == me_id {
            return;
        }
        if message.author.bot.unwrap_or(false) && !self.options.allow_bots {
            return;
        }
        // Checked before the parent lookup so an ignored channel costs no REST.
        if self
            .options
            .ignored_channels
            .iter()
            .any(|id| id == &message.channel_id)
        {
            return;
        }
        let is_group = message.guild_id.is_some();
        let parent = if is_group {
            if let Some(parent) = thread_parents.get(&message.channel_id) {
                parent.clone()
            } else if self.channel_ids.iter().any(|id| id == &message.channel_id) {
                None
            } else {
                // A failed lookup scopes this message to the channel itself and
                // is not cached, so the next message asks again.
                match self.parent_channel_id(&message.channel_id).await {
                    Some(parent) => {
                        remember_thread_parent(thread_parents, &message.channel_id, parent.clone());
                        parent
                    }
                    None => None,
                }
            }
        } else {
            None
        };
        let scope_channel = parent.as_deref().unwrap_or(&message.channel_id);
        if !self.channel_ids.is_empty()
            && is_group
            && !self.channel_ids.iter().any(|id| id == scope_channel)
        {
            return;
        }
        if self
            .options
            .ignored_channels
            .iter()
            .any(|id| id == scope_channel)
        {
            return;
        }
        if is_group
            && !self.options.allowed_channels.is_empty()
            && !self
                .options
                .allowed_channels
                .iter()
                .any(|id| id == scope_channel || id == &message.channel_id)
        {
            return;
        }
        let in_thread = parent.is_some();
        let Some(routed_text) = decide_reply_with_options(
            &message,
            me_id,
            self.runtime.cfg.group_reply_mode,
            in_thread,
            &self.options,
        ) else {
            return;
        };
        let chat_id = inbound_chat_id(&message.channel_id, parent.as_deref());
        let inbound = InboundMessage {
            chat_id,
            access_chat_id: parent.or_else(|| is_group.then(|| message.channel_id.clone())),
            text: routed_text,
            author_name: Some(message.author.username.clone())
                .filter(|name| !name.trim().is_empty()),
            sender_id: Some(message.author.id.clone()).filter(|id| !id.is_empty()),
            message_id: Some(message.id.clone()),
            is_group,
            attachments: parse_attachments(&message),
            channel_action: None,
            // A gateway message carries no locale; replies use the owner's.
            locale: None,
        };
        let provider_id = format!("message:{}", message.id);
        let channel = Arc::clone(self);
        tokio::spawn(async move {
            let (delivery_id, claim) = match claim_inbound_delivery(&*channel, &provider_id).await {
                Ok(result) => result,
                Err(error) => {
                    warn!(
                        channel = "discord",
                        %error,
                        "discord delivery could not be durably claimed; processing once without dedupe"
                    );
                    let delivery_id = scoped_delivery_id(&*channel, &provider_id);
                    let mut inbound = inbound;
                    let downloaded = channel.download_speech(&inbound).await;
                    if !downloaded.is_empty() {
                        channel.runtime.ingest_media(&mut inbound, downloaded).await;
                    }
                    let _ =
                        handle_turn_with_delivery(channel, host, inbound, Some(&delivery_id)).await;
                    return;
                }
            };
            if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
                debug!(
                    channel = "discord",
                    delivery_id = %delivery_id,
                    ?claim,
                    "duplicate discord delivery suppressed"
                );
                return;
            }
            let mut inbound = inbound;
            let downloaded = channel.download_speech(&inbound).await;
            if !downloaded.is_empty() {
                channel.runtime.ingest_media(&mut inbound, downloaded).await;
            }
            let work_channel = Arc::clone(&channel);
            let work_host = Arc::clone(&host);
            let work_delivery_id = delivery_id.clone();
            run_claimed_delivery(channel, delivery_id, move || {
                let channel = Arc::clone(&work_channel);
                let host = Arc::clone(&work_host);
                let message = inbound.clone();
                let delivery_id = work_delivery_id.clone();
                async move {
                    handle_turn_with_delivery(channel, host, message, Some(&delivery_id)).await
                }
            })
            .await;
        });
    }

    pub(super) async fn backfill(
        self: &Arc<Self>,
        host: &Arc<dyn ChannelHost>,
        me_id: &str,
        last_seen: &mut HashMap<String, String>,
        thread_parents: &mut ThreadParents,
    ) {
        for channel_id in &self.channel_ids {
            let Some(after) = last_seen.get(channel_id) else {
                continue;
            };
            match self.fetch_messages(channel_id, Some(after)).await {
                Ok(mut messages) => {
                    messages.reverse();
                    for message in messages {
                        let Ok(value) = serde_json::to_value(message) else {
                            continue;
                        };
                        self.dispatch_gateway_message(
                            Arc::clone(host),
                            value,
                            me_id,
                            thread_parents,
                            last_seen,
                        )
                        .await;
                    }
                }
                Err(err) => warn!(%err, channel_id, "discord history backfill failed"),
            }
        }
    }

    pub(super) async fn handle_interaction(
        self: &Arc<Self>,
        value: Value,
        host: Arc<dyn ChannelHost>,
        _me_id: &str,
    ) {
        if value["type"].as_u64() != Some(2) {
            return;
        }
        let Some(interaction_id) = value["id"].as_str().map(str::to_string) else {
            return;
        };
        let Some(token) = value["token"].as_str() else {
            return;
        };
        let Some(name) = value["data"]["name"].as_str() else {
            return;
        };
        let mut text = format!("/{name}");
        if let Some(options) = value["data"]["options"].as_array() {
            for option in options {
                if let Some(option_value) = option["value"].as_str() {
                    text.push(' ');
                    text.push_str(option_value);
                }
            }
        }
        let callback = format!("{API_BASE}/interactions/{interaction_id}/{token}/callback");
        if self
            .http()
            .post(callback)
            .json(&json!({ "type": 5 }))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .is_err()
        {
            return;
        }
        let channel_id = value["channel_id"].as_str().unwrap_or_default().to_string();
        if channel_id.is_empty() {
            return;
        }
        let sender_id = value["member"]["user"]["id"]
            .as_str()
            .or_else(|| value["user"]["id"].as_str())
            .map(str::to_string);
        let author_name = value["member"]["user"]["username"]
            .as_str()
            .or_else(|| value["user"]["username"].as_str())
            .map(str::to_string);
        let is_group = value["guild_id"].as_str().is_some();
        if is_group
            && !self.options.allowed_roles.is_empty()
            && !value["member"]["roles"].as_array().is_some_and(|roles| {
                roles.iter().any(|role| {
                    role.as_str().is_some_and(|role| {
                        self.options
                            .allowed_roles
                            .iter()
                            .any(|allowed| allowed == role)
                    })
                })
            })
        {
            return;
        }
        let scope_channel = if is_group {
            self.parent_channel_id(&channel_id)
                .await
                .flatten()
                .unwrap_or_else(|| channel_id.clone())
        } else {
            channel_id.clone()
        };
        if self
            .options
            .ignored_channels
            .iter()
            .any(|id| id == &channel_id || id == &scope_channel)
        {
            return;
        }
        if is_group
            && (!self.channel_ids.is_empty()
                && !self
                    .channel_ids
                    .iter()
                    .any(|id| id == &channel_id || id == &scope_channel)
                || !self.options.allowed_channels.is_empty()
                    && !self
                        .options
                        .allowed_channels
                        .iter()
                        .any(|id| id == &channel_id || id == &scope_channel))
        {
            return;
        }
        let inbound = InboundMessage {
            chat_id: channel_id.clone(),
            access_chat_id: is_group.then_some(scope_channel),
            text,
            author_name,
            sender_id,
            message_id: None,
            is_group,
            attachments: Vec::new(),
            channel_action: None,
            locale: interaction_locale(&value),
        };
        let channel = Arc::clone(self);
        let provider_id = format!("interaction:{interaction_id}");
        let turn_delivery_id = scoped_delivery_id(&*channel, &provider_id);
        deliver_inbound(channel, provider_id, move || {
            let channel = Arc::clone(self);
            let host = Arc::clone(&host);
            let inbound = inbound.clone();
            let delivery_id = turn_delivery_id.clone();
            async move {
                handle_turn_with_delivery(channel, host, inbound, Some(&delivery_id)).await
            }
        })
        .await;
    }
}
