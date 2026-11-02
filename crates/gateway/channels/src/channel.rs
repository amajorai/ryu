//! The [`Channel`] trait adapters implement, provider-delivery claiming and
//! retries, and the [`ChannelHost`] pipeline seam.

use super::*;

/// A registered channel: a messaging surface the gateway can receive from and
/// reply to. Implementors own their transport and their platform verbs.
///
/// Every method past [`Channel::send_message`] has a default, so an adapter for a
/// text-only platform implements exactly what the old trait required.
#[async_trait]
pub trait Channel: Send + Sync {
    /// Stable identifier for this channel, e.g. `"telegram"`.
    fn name(&self) -> &'static str;

    /// Shared per-bot state (Core route, access policy, command cache).
    fn runtime(&self) -> &ChannelRuntime;

    /// Stable non-secret identity for this channel instance in the node delivery
    /// ledger. Store-backed records use their control-plane id, so two Telegram
    /// bots or two WhatsApp numbers cannot collide on the same provider event
    /// number. Env-configured deployments have at most one instance per
    /// platform and fall back to the platform name.
    fn delivery_scope(&self) -> String {
        self.runtime()
            .cfg
            .channel_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| self.name().to_string())
    }

    /// Deliver an outbound reply back to the originating chat.
    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()>;

    /// Deliver the assistant reply and optionally return provider message ids.
    /// The default keeps older/text-only adapters unchanged; adapters that
    /// receive reaction events override it so the shared runtime can bind the
    /// reaction to the exact Core assistant row.
    async fn send_reply(
        &self,
        chat_id: &str,
        text: &str,
        rich_text: bool,
    ) -> anyhow::Result<Vec<String>> {
        if rich_text && self.caps().rich_text {
            self.send_rich(chat_id, text).await?;
        } else {
            self.send_message(chat_id, text).await?;
        }
        Ok(Vec::new())
    }

    /// Send a reply with channel-neutral buttons when the platform supports
    /// their layout. Text-only adapters use the same reply text as a fallback.
    async fn send_reply_with_markup(
        &self,
        chat_id: &str,
        text: &str,
        rich_text: bool,
        _markup: Option<&InteractiveMarkup>,
    ) -> anyhow::Result<Vec<String>> {
        self.send_reply(chat_id, text, rich_text).await
    }

    /// Run the channel's inbound loop until the process exits. Each inbound
    /// message should be passed to [`handle_turn`].
    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()>;

    /// What this platform can express beyond plain text.
    fn caps(&self) -> ChannelCaps {
        ChannelCaps::default()
    }

    /// Model the inbound messages should be routed to.
    fn model(&self) -> &str {
        &self.runtime().cfg.model
    }

    /// Optional system prompt prepended to every conversation.
    fn system_prompt(&self) -> Option<&str> {
        self.runtime().cfg.system_prompt.as_deref()
    }

    /// Show a typing indicator. Best-effort: platforms expire it after a few
    /// seconds, so [`keep_typing`] re-asserts it on [`Channel::typing_interval`].
    ///
    /// `chat_id` is the PACKED conversation key, exactly like every other send —
    /// after [`Channel::open_thread`] it may be `"<chat>:<thread>"`. Unpack it
    /// with [`unpack_thread`] before calling the platform, or a threaded turn
    /// spends the whole agent call posting to a chat id that does not exist.
    async fn send_typing(&self, _chat_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    /// How often the typing indicator must be re-asserted to stay visible.
    /// Telegram expires after 5s and Discord after 10s, so the default is set
    /// under the tighter of the two.
    fn typing_interval(&self) -> Duration {
        Duration::from_secs(4)
    }

    /// Send a reply rendered as platform rich text. Defaults to plain text, which
    /// is exactly right for a platform without a rich-text surface.
    async fn send_rich(&self, chat_id: &str, markdown: &str) -> anyhow::Result<()> {
        self.send_message(chat_id, markdown).await
    }

    /// Push a partial, ephemeral draft while the reply is still being generated.
    /// `draft_id` is stable across one turn so the platform animates the diff.
    async fn send_draft(
        &self,
        _chat_id: &str,
        _draft_id: i64,
        _partial: &str,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    /// Send synthesized speech. `wav` is Core's TTS output; `delivery` states what
    /// the platform will accept (see [`media::wav_delivery`]).
    async fn send_voice(
        &self,
        _chat_id: &str,
        _wav: Vec<u8>,
        _delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        anyhow::bail!("{} cannot send audio", self.name())
    }

    /// Place an emoji reaction on a message. Used to acknowledge receipt without
    /// adding a message to the conversation.
    async fn react(&self, _chat_id: &str, _message_id: &str, _emoji: &str) -> anyhow::Result<()> {
        Ok(())
    }

    /// Take back a reaction this bot placed with [`Channel::react`]. Clears the
    /// working 👀 once a turn finishes so it never lingers beside the answer.
    async fn remove_reaction(
        &self,
        _chat_id: &str,
        _message_id: &str,
        _emoji: &str,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    /// Mark the conversation read on the platform (blue ticks).
    async fn mark_read(&self, _chat_id: &str, _message_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    /// Register the command menu with the platform.
    async fn publish_commands(&self, _cmds: &[ChannelCommand]) -> anyhow::Result<()> {
        Ok(())
    }

    /// Push the operator-configured bot profile (name / bio / description).
    async fn publish_profile(&self, _profile: &BotProfile) -> anyhow::Result<()> {
        Ok(())
    }

    /// Open a thread for this turn and return the conversation key to answer in.
    /// Defaults to answering in the originating chat.
    async fn open_thread(&self, chat_id: &str, _message: &InboundMessage) -> String {
        chat_id.to_string()
    }
}

/// Build the node-local delivery id from a provider's stable event/message id.
/// The provider id itself is never used as an unscoped global key because one
/// node can host multiple channel records of the same platform.
pub fn scoped_delivery_id<C: Channel + ?Sized>(channel: &C, provider_id: &str) -> String {
    format!("{}:{}", channel.delivery_scope(), provider_id.trim())
}

/// Claim one inbound provider delivery before accepting it for asynchronous
/// processing. Webhook handlers call this while the HTTP request is still open;
/// a persistence error therefore becomes a provider-visible retry rather than a
/// `200` for work that was never durably accepted.
pub async fn claim_inbound_delivery<C: Channel + ?Sized>(
    channel: &C,
    provider_id: &str,
) -> anyhow::Result<(String, DeliveryClaim)> {
    let delivery_id = scoped_delivery_id(channel, provider_id);
    let claim = channel
        .runtime()
        .pairing
        .claim_delivery(channel.name(), &delivery_id)
        .await?;
    Ok((delivery_id, claim))
}

/// Process a delivery that has already been claimed. The closure is invoked
/// serially for up to [`DELIVERY_MAX_ATTEMPTS`] attempts; it must construct a
/// fresh future (and usually a cloned `InboundMessage`) on each invocation.
///
/// A completed record is written only after the shared turn reports that its
/// terminal action was delivered. A failed record remains reclaimable by a later
/// provider callback, while an in-flight record suppresses concurrent retries.
pub async fn run_claimed_delivery<C, F, Fut>(channel: Arc<C>, delivery_id: String, mut work: F)
where
    C: Channel + 'static,
    F: FnMut() -> Fut + Send,
    Fut: Future<Output = ChannelTurnOutcome> + Send,
{
    let platform = channel.name();
    let ledger = channel.runtime().pairing.clone();
    for attempt in 1..=DELIVERY_MAX_ATTEMPTS {
        if work().await == ChannelTurnOutcome::Completed {
            if let Err(error) = ledger.complete_delivery(platform, &delivery_id).await {
                warn!(
                    channel = platform,
                    %error,
                    "channel delivery completed but its durable completion could not be persisted"
                );
            }
            return;
        }

        if attempt == DELIVERY_MAX_ATTEMPTS {
            if let Err(error) = ledger.fail_delivery(platform, &delivery_id).await {
                warn!(
                    channel = platform,
                    %error,
                    "channel delivery failed and its failure state could not be persisted"
                );
            }
            warn!(
                channel = platform,
                delivery_id = %delivery_id,
                attempts = DELIVERY_MAX_ATTEMPTS,
                "channel delivery exhausted local retries; waiting for provider redelivery"
            );
            if let Some(reporter) = &channel.runtime().status {
                reporter
                    .error("inbound delivery failed after local retries")
                    .await;
            }
            return;
        }

        warn!(
            channel = platform,
            delivery_id = %delivery_id,
            attempt,
            "channel delivery failed; retrying"
        );
        if let Err(error) = ledger.touch_delivery(platform, &delivery_id).await {
            warn!(
                channel = platform,
                %error,
                "channel delivery retry lease could not be persisted"
            );
        }
        tokio::time::sleep(delivery_retry_delay(attempt)).await;
    }
}

/// Process a claimed webhook while holding a bounded concurrency slot acquired
/// before the HTTP acknowledgement. Dropping the permit after the terminal
/// state lets the next provider callback enter without widening the public
/// queue.
pub async fn run_claimed_delivery_with_permit<C, F, Fut>(
    channel: Arc<C>,
    delivery_id: String,
    permit: OwnedSemaphorePermit,
    work: F,
) where
    C: Channel + 'static,
    F: FnMut() -> Fut + Send,
    Fut: Future<Output = ChannelTurnOutcome> + Send,
{
    run_claimed_delivery(channel, delivery_id, work).await;
    drop(permit);
}

/// Try to reserve a webhook processing slot without exposing the semaphore
/// itself to provider adapters.
pub fn try_reserve_delivery<C: Channel + ?Sized>(channel: &C) -> Option<OwnedSemaphorePermit> {
    channel.runtime().try_reserve_delivery()
}

/// Claim and process one delivery for transports that do not need to return an
/// HTTP acknowledgement themselves (polling, sockets, or a queued webhook
/// worker).
pub async fn deliver_inbound<C, F, Fut>(channel: Arc<C>, provider_id: String, mut work: F)
where
    C: Channel + 'static,
    F: FnMut() -> Fut + Send,
    Fut: Future<Output = ChannelTurnOutcome> + Send,
{
    let (delivery_id, claim) = match claim_inbound_delivery(channel.as_ref(), &provider_id).await {
        Ok(result) => result,
        Err(error) => {
            warn!(
                channel = channel.name(),
                %error,
                "channel delivery could not be durably claimed; processing once without dedupe"
            );
            let _ = work().await;
            return;
        }
    };
    match claim {
        DeliveryClaim::Claimed => run_claimed_delivery(channel, delivery_id, work).await,
        DeliveryClaim::InFlight | DeliveryClaim::Completed => {
            debug!(channel = channel.name(), delivery_id = %delivery_id, ?claim, "duplicate channel delivery suppressed");
        }
    }
}

/// The gateway seam a channel needs: run one channel-originated request body
/// through the gateway pipeline and return the raw completion response.
///
/// This is the whole coupling between the channel-layer engine and the gateway.
/// The host (implemented in `apps/gateway/src/channels_host.rs`) owns
/// `RequestContext` construction — api-key namespacing, priority — and the
/// `pipeline::run` call. Keeping it behind this trait is what lets the
/// transport adapters live in their own crate without dragging in `SharedState`,
/// the pipeline, or `RequestContext` ("engine moves, wiring stays").
#[async_trait]
pub trait ChannelHost: Send + Sync {
    /// Run `body` (an OpenAI-style chat request built by [`build_request_body`])
    /// through the gateway pipeline, tagging audit/rate-limit buckets by
    /// `channel_name`. Returns the raw completion response.
    async fn run_pipeline(&self, channel_name: &str, body: Value) -> anyhow::Result<Value>;
}

/// Build the OpenAI-style request body for an inbound channel message.
///
/// Pure and synchronous so it can be unit-tested without a running gateway.
pub fn build_request_body(model: &str, system_prompt: Option<&str>, text: &str) -> Value {
    let mut messages = Vec::with_capacity(2);
    if let Some(system) = system_prompt {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": text }));

    json!({
        "model": model,
        "messages": messages,
        "stream": false,
    })
}

/// Extract the assistant reply text from a gateway pipeline response.
pub fn extract_reply(response: &Value) -> Option<String> {
    response["choices"]
        .as_array()
        .and_then(|choices| choices.first())
        .and_then(|choice| choice["message"]["content"].as_str())
        .map(|s| s.to_string())
}
