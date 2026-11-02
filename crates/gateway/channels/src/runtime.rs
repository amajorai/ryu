//! [`ChannelRuntime`], the per-bot state the shared path reads, with Core
//! routing, reply links and the command menu; plus turn outcomes and the
//! lifecycle-reaction plan.

use super::*;

/// Per-bot state shared by the transport-agnostic path.
///
/// One of these is embedded in each adapter and exposed via [`Channel::runtime`].
/// It owns the Core route, the access policy, and the cached command menu, so
/// those live in exactly one place rather than being duplicated per adapter.
pub struct ChannelRuntime {
    pub http: reqwest::Client,
    pub cfg: CommonChannelConfig,
    /// Pairing state for this node, shared across every channel on it.
    pub pairing: PairingStore,
    /// Reports this bot's live connection status to the control plane. `None`
    /// for env-configured bots (no store id), which then show as `unknown`.
    pub status: Option<StatusReporter>,
    /// The command menu last fetched from Core.
    pub(super) commands: RwLock<Vec<ChannelCommand>>,
    /// Bound concurrent channel turns so a public webhook cannot create an
    /// unbounded number of model/media tasks while the provider is retrying.
    pub(super) delivery_slots: Arc<Semaphore>,
    /// The Gateway owner's UI language, for senders with no platform locale.
    pub owner_locale: i18n::OwnerLocale,
}

/// The response metadata a Core-routed channel turn needs in addition to text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChannelRunResult {
    pub reply: String,
    pub assistant_message_id: Option<String>,
    pub assistant_message_ids: Vec<String>,
    pub interactive_markup: Option<InteractiveMarkup>,
    /// Emojis the agent reacted to the user's message with (`agents.react`),
    /// oldest first. Mirrored onto the provider message that started the turn.
    pub agent_reactions: Vec<String>,
}

/// Lifecycle reaction placed while a turn is running.
pub const WORKING_REACTION: &str = "👀";

/// Lifecycle reaction placed when a turn fails.
pub const FAILED_REACTION: &str = "❌";

/// Whether a finishing reaction step adds or takes back an emoji.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReactionOp {
    Add,
    Remove,
}

/// The reaction steps that close a turn on the provider message that started it.
///
/// Mirrors how people (and other chat assistants) react: the working 👀 is taken
/// back once the answer is there, the agent's own `agents.react` choice is what
/// stays, and only a failure is marked. A successful turn the agent chose not to
/// react to ends with no reaction at all — the reply is the acknowledgement, and
/// a ✅ on every message would drown out the reactions that carry meaning.
///
/// The agent's reactions are mirrored regardless of `lifecycle_reactions`: they
/// are part of the agent's answer, not the transport's progress signal.
pub fn finish_reactions<'a>(
    lifecycle_reactions: bool,
    run_succeeded: bool,
    agent_reactions: &'a [String],
) -> Vec<(ReactionOp, &'a str)> {
    let mut steps = Vec::new();
    let agent_placed_working = agent_reactions
        .iter()
        .any(|emoji| emoji == WORKING_REACTION);
    if lifecycle_reactions && !agent_placed_working {
        steps.push((ReactionOp::Remove, WORKING_REACTION));
    }
    if run_succeeded {
        steps.extend(
            agent_reactions
                .iter()
                .map(|emoji| (ReactionOp::Add, emoji.as_str())),
        );
    } else if lifecycle_reactions {
        steps.push((ReactionOp::Add, FAILED_REACTION));
    }
    steps
}

/// Outcome of one normalized inbound turn.
///
/// `Completed` includes an intentional access-policy drop and a pairing prompt:
/// neither should be re-run when the provider retries the same callback. Only a
/// transport failure that prevented the final response from being delivered is
/// retryable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelTurnOutcome {
    Completed,
    Failed,
}

/// Maximum number of local attempts after a provider delivery is durably
/// claimed. The provider remains the outer retry mechanism after this budget is
/// exhausted, while the durable ledger keeps concurrent callbacks from
/// multiplying work.
pub(super) const DELIVERY_MAX_ATTEMPTS: u32 = 3;

/// Maximum number of webhook turns allowed to run concurrently for one channel
/// runtime. A full set returns `503` at the provider boundary.
pub(super) const MAX_ACTIVE_DELIVERIES: usize = 128;

pub(super) fn delivery_retry_delay(attempt: u32) -> Duration {
    match attempt {
        1 => Duration::from_secs(2),
        _ => Duration::from_secs(5),
    }
}

/// Upper bound for one Core-routed agent turn (`POST /api/channels/run`).
///
/// Overrides the shared HTTP client's 60 s timeout: an agent turn with web
/// search and several model rounds routinely takes longer, and cutting it off
/// makes the user see an error while Core finishes (and bills) a reply nobody
/// fetches. It must stay below Core's 15-minute stale channel-turn reclaim
/// (`claim_channel_turn` in `apps/core/src/server/conversations.rs`) and the
/// 30-minute delivery lease in [`pairing`], so a slow turn never outlives
/// either claim.
pub(super) const CORE_TURN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

const _: () = assert!(
    CORE_TURN_TIMEOUT.as_secs() > 60 && CORE_TURN_TIMEOUT.as_secs() < 15 * 60,
    "CORE_TURN_TIMEOUT must exceed the shared 60 s client timeout and stay below Core's 15-minute reclaim"
);

impl ChannelRuntime {
    pub fn new(
        http: reqwest::Client,
        cfg: CommonChannelConfig,
        pairing: PairingStore,
        status: Option<StatusReporter>,
    ) -> Self {
        Self {
            http,
            cfg,
            pairing,
            status,
            commands: RwLock::new(Vec::new()),
            delivery_slots: Arc::new(Semaphore::new(MAX_ACTIVE_DELIVERIES)),
            owner_locale: i18n::OwnerLocale::default(),
        }
    }

    /// The Gateway owner's UI language (Core's `ui-language`, cached).
    pub async fn owner_locale(&self) -> &'static str {
        self.owner_locale.get(&self.http, &self.cfg.core_url).await
    }

    /// The locale for the bridge's own reply to a sender: the one their
    /// platform reported, else the owner's.
    pub async fn reply_locale(&self, sender_locale: Option<&str>) -> &'static str {
        match i18n::stored(sender_locale) {
            Some(locale) => locale,
            None => self.owner_locale().await,
        }
    }

    /// Reserve one processing slot for a webhook before acknowledging it. A
    /// failed reservation must be translated into a provider-visible retry.
    pub fn try_reserve_delivery(&self) -> Option<OwnedSemaphorePermit> {
        self.delivery_slots.clone().try_acquire_owned().ok()
    }

    /// True when this bot routes through Core's session seam. Store-backed
    /// channel records use Core even when they target the default agent so the
    /// same transcript is visible in the desktop chat history.
    pub fn routes_via_core(&self) -> bool {
        self.cfg.agent_id.is_some() || self.cfg.team_id.is_some() || self.cfg.channel_id.is_some()
    }

    /// Map the platform's reply target to the stable Core session id for this
    /// bot. The raw target remains the value passed to platform send/typing
    /// verbs; only the Core key is namespaced.
    pub fn core_conversation_id(&self, platform_target: &str) -> String {
        self.cfg
            .channel_id
            .as_deref()
            .map(|channel_id| format!("channel:{channel_id}:{platform_target}"))
            .unwrap_or_else(|| platform_target.to_owned())
    }

    /// Route one turn through Core's session seam and return the reply plus the
    /// durable assistant message id that can later receive a reaction.
    ///
    /// `POST <core_url>/api/channels/run` with `conversation_id` keyed to the
    /// chat (or packed chat+thread), so multi-turn exchanges share history. Model
    /// calls still flow Core → Gateway, keeping the governance layer (firewall,
    /// DLP, budgets, audit) on path for every bot-initiated call.
    ///
    /// # Errors
    /// Returns `Err` on HTTP transport failure or a non-2xx from Core.
    pub async fn run_via_core(
        &self,
        conversation_id: &str,
        text: &str,
        author_name: Option<&str>,
        idempotency_key: Option<&str>,
        channel_action: Option<&ChannelActionEvent>,
    ) -> anyhow::Result<ChannelRunResult> {
        let payload = json!({
            "conversation_id": conversation_id,
            "channel_id": self.cfg.channel_id,
            "agent_id": self.cfg.agent_id,
            "team_id": self.cfg.team_id,
            "text": text,
            "author_name": author_name,
            "idempotencyKey": idempotency_key,
            "channelAction": channel_action,
        });
        let resp = self
            .core_run_request(&payload)
            .send()
            .await?
            .error_for_status()?;
        let body: Value = resp.json().await?;
        if let Some(warning) = body["fallbackWarning"].as_str() {
            warn!(
                channel_id = ?self.cfg.channel_id,
                warning,
                "channel session agent binding was resolved to the default agent"
            );
        }
        let assistant_message_id = body["assistantMessageId"].as_str().map(str::to_owned);
        let assistant_message_ids = body["assistantMessageIds"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|ids| !ids.is_empty())
            .unwrap_or_else(|| assistant_message_id.clone().into_iter().collect());
        // Older Cores omit the field; that only means there is nothing to mirror.
        let agent_reactions = body["agentReactions"]
            .as_array()
            .map(|emojis| {
                emojis
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|emoji| !emoji.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Ok(ChannelRunResult {
            reply: body["reply"].as_str().unwrap_or("").to_owned(),
            assistant_message_id,
            assistant_message_ids,
            agent_reactions,
            interactive_markup: body
                .get("interactiveMarkup")
                .filter(|value| !value.is_null())
                .cloned()
                .map(serde_json::from_value)
                .transpose()?,
        })
    }

    /// The `POST /api/channels/run` request for one turn, with the per-turn
    /// [`CORE_TURN_TIMEOUT`] in place of the shared client's shorter default.
    pub(super) fn core_run_request(&self, payload: &Value) -> reqwest::RequestBuilder {
        let url = format!(
            "{}/api/channels/run",
            self.cfg.core_url.trim_end_matches('/')
        );
        self.http.post(url).timeout(CORE_TURN_TIMEOUT).json(payload)
    }

    /// Bind provider message ids to the Core assistant row that produced them.
    /// Providers may split one reply into several messages, so all returned ids
    /// receive the same Learning target.
    pub async fn bind_sent_messages(
        &self,
        platform: &str,
        platform_target: &str,
        provider_message_ids: &[String],
        assistant_message_ids: &[String],
    ) {
        if !self.cfg.reaction_learning.enabled
            || provider_message_ids.is_empty()
            || assistant_message_ids.is_empty()
        {
            return;
        }
        self.pairing
            .bind_reply_messages(
                platform,
                &self.core_conversation_id(platform_target),
                provider_message_ids,
                assistant_message_ids,
            )
            .await;
    }

    /// Record one adapter-normalized reaction against a previously confirmed
    /// bot reply. Returns `false` when Learning is disabled or the provider id
    /// is not linked to a Core assistant row (for example after a restart).
    pub async fn record_reaction_feedback(
        &self,
        platform: &str,
        platform_target: &str,
        provider_message_id: &str,
        emoji: &str,
    ) -> anyhow::Result<bool> {
        if !self.cfg.reaction_learning.enabled || !self.routes_via_core() {
            return Ok(false);
        }
        let conversation_id = self.core_conversation_id(platform_target);
        let core_message_ids = self
            .pairing
            .reply_message(platform, &conversation_id, provider_message_id)
            .await;
        let Some(core_message_ids) = core_message_ids else {
            return Ok(false);
        };
        for core_message_id in core_message_ids {
            let url = format!(
                "{}/api/conversations/{}/messages/{}/feedback",
                self.cfg.core_url.trim_end_matches('/'),
                encode_path_segment(&conversation_id),
                encode_path_segment(&core_message_id)
            );
            self.http
                .post(url)
                .json(&json!({
                    "rating": self.cfg.reaction_learning.classify(emoji),
                    "allow_latest_fallback": false,
                }))
                .send()
                .await?
                .error_for_status()?;
        }
        Ok(true)
    }

    /// Refresh the cached command menu from Core. Returns the new list.
    pub async fn refresh_commands(&self) -> Vec<ChannelCommand> {
        let fetched = commands::fetch(&self.http, &self.cfg.core_url).await;
        *self.commands.write().await = fetched.clone();
        fetched
    }

    /// The cached command menu.
    pub async fn commands(&self) -> Vec<ChannelCommand> {
        self.commands.read().await.clone()
    }

    /// Transcribe every speech attachment and fold the transcripts into the turn
    /// text. `downloaded` pairs an index into `message.attachments` with its
    /// bytes; the adapter does the download because only it knows the platform's
    /// auth and resolve step.
    ///
    /// Is this sender ALREADY admitted — without minting anything?
    ///
    /// The read-only twin of the gate in [`handle_turn`]. It exists because the
    /// authoritative gate necessarily runs *inside* `handle_turn`, while the
    /// expensive part of an inbound turn — downloading a voice note and paying for
    /// a transcription — happens in the adapter *before* it. Without this check an
    /// unpaired stranger on an unauthenticated ingress could spend the operator's
    /// STT budget simply by sending audio, which is exactly what the gate is for.
    ///
    /// Deliberately non-mutating, unlike [`AccessPolicy::decide_dm`]: that one
    /// *mints* a pairing code and writes the store, so calling it speculatively on
    /// every inbound would let forged senders drive disk writes. An unknown sender
    /// answers `false` here and is challenged once, later, by the real gate.
    ///
    /// Policy is not duplicated — this reads the same [`AccessPolicy`] and the same
    /// [`PairingStore`] the gate does; it just declines to create state.
    pub async fn already_admitted(&self, platform: &str, message: &InboundMessage) -> bool {
        if message.is_group {
            return matches!(
                self.cfg
                    .access
                    .decide_group_for_sender(message.access_chat(), message.sender_id.as_deref(),),
                Decision::Allow
            );
        }
        let identity = message.identity();
        if self.cfg.access.dm_allowlist.iter().any(|id| id == identity) {
            return true;
        }
        match self.cfg.access.dm {
            DmPolicy::Open => true,
            DmPolicy::Allowlist | DmPolicy::Disabled => false,
            DmPolicy::Pairing => matches!(
                self.pairing.get(platform, identity).await,
                Some(pairing::PairState::Paired { .. })
            ),
        }
    }

    /// A transcription failure degrades to a placeholder rather than dropping the
    /// turn — the user gets an answer that acknowledges the voice note instead of
    /// silence. Annotation of NON-speech media is not done here; [`handle_turn`]
    /// applies it once, for every adapter.
    pub async fn ingest_media(
        &self,
        message: &mut InboundMessage,
        downloaded: Vec<(usize, Vec<u8>)>,
    ) {
        for (index, bytes) in downloaded {
            let Some(attachment) = message.attachments.get(index) else {
                continue;
            };
            if !attachment.resolved_kind().is_speech() {
                continue;
            }
            let filename = attachment.safe_filename();
            match media::transcribe(&self.http, &self.cfg.core_url, bytes, &filename).await {
                Ok(transcript) if !transcript.trim().is_empty() => {
                    if message.text.trim().is_empty() {
                        message.text = transcript;
                    } else {
                        message.text = format!("{}\n\n{transcript}", message.text);
                    }
                }
                Ok(_) => {
                    warn!("channel voice note transcribed to nothing");
                    if message.text.trim().is_empty() {
                        message.text = "[voice message — nothing could be transcribed]".to_string();
                    }
                }
                Err(err) => {
                    warn!(%err, "channel voice transcription failed");
                    if message.text.trim().is_empty() {
                        message.text = "[voice message — transcription unavailable]".to_string();
                    }
                }
            }
        }
    }
}
