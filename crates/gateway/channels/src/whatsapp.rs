//! WhatsApp Business channel adapter (Meta Cloud API).
//!
//! Unlike Telegram/Discord, the WhatsApp Cloud API has no polling endpoint:
//! inbound messages arrive as webhook callbacks. This adapter's
//! [`run`](Channel::run) loop therefore binds a small HTTP receiver that handles
//! Meta's two webhook flows:
//!
//! - `GET`  the subscription verification handshake (`hub.challenge`).
//! - `POST` inbound message deliveries, which are parsed, have their media
//!   ingested, and are then handed to the shared [`handle_turn`] path.
//!
//! Replies go back out via the Graph API `POST /{version}/{phone_number_id}/messages`.
//! In production, front [`WhatsAppChannelConfig::webhook_bind`] with a public
//! HTTPS reverse proxy — Meta requires HTTPS for webhook delivery.
//!
//! ## Everything is one endpoint
//!
//! The Cloud API is unusually narrow: text, reactions, read receipts and the
//! typing indicator are all the *same* `POST .../messages` call with a different
//! body. That is why the payload builders below are pure functions — they are the
//! only thing that distinguishes those verbs, so they are also the only thing
//! worth unit-testing.
//!
//! ## The typing indicator needs an inbound message id
//!
//! `{status:"read", message_id, typing_indicator:{type:"text"}}` marks the
//! inbound message read *and* shows "typing…". It cannot be addressed to a chat —
//! only to a specific inbound message id — and Meta dismisses it as soon as the
//! bot replies, expiring it after ~25s otherwise. The kernel's [`crate::keep_typing`]
//! keepalive hands us only a chat id, so this adapter keeps a small map of the
//! latest inbound wamid per conversation and looks the id up there. With no id
//! known there is simply nothing to show, so [`Channel::send_typing`] no-ops.
//!
//! ## Commands are discovered here, not executed here
//!
//! Plugin/skill/agent commands already *work* on WhatsApp: Core's `pre_user_turn`
//! hooks intercept them inside `run_reply_text`, so the text only has to reach
//! Core intact — which it does. What WhatsApp lacks is any way to *discover* them,
//! because the platform has no command menu to publish to. So `/help` (and
//! `/commands`) is answered locally from the menu Core serves, and every other
//! command is routed to the agent untouched.
//!
//! ## Voice replies are declined, not faked
//!
//! Core's TTS emits WAV and the Cloud API's audio type accepts ogg/opus, mpeg,
//! mp4, amr and aac — not WAV. [`media::wav_delivery`] therefore reports
//! `Unsupported` for this platform and [`handle_turn`] never asks for speech;
//! [`Channel::send_voice`] fails loudly rather than uploading a file the
//! recipient's phone cannot play.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::commands::{self, ChannelCommand};
use crate::media::{self, Attachment, AttachmentKind, VoiceDelivery};
use crate::pairing::{Decision, PairingStore};
use crate::status::StatusReporter;
use crate::whatsapp_format;
use crate::{
    claim_inbound_delivery, handle_turn_with_delivery, run_claimed_delivery_with_permit,
    try_reserve_delivery, Channel, ChannelCaps, ChannelHost, ChannelRuntime, ChannelTurnOutcome,
    InboundMessage, WhatsAppChannelConfig,
};

/// Meta Graph API host. The version segment is appended per request.
const GRAPH_HOST: &str = "https://graph.facebook.com";

/// This adapter's channel name, used for the pairing-store key and every log.
const PLATFORM: &str = "whatsapp";

/// How often the typing indicator is re-asserted. Meta expires it after ~25
/// seconds, so this sits comfortably inside that window without hammering the
/// messages endpoint (which is also the send endpoint, and rate-limited as one).
const TYPING_INTERVAL: Duration = Duration::from_secs(20);

/// Ceiling on the "latest inbound message id" map. It exists only to feed the
/// typing indicator, so a coarse wholesale eviction costs at most one turn's
/// indicator — far better than leaking a map slot for every person who has ever
/// messaged the bot over the process's lifetime.
const MAX_TRACKED_CHATS: usize = 1024;

pub struct WhatsAppChannel {
    runtime: ChannelRuntime,
    access_token: String,
    phone_number_id: String,
    verify_token: String,
    app_secret: String,
    webhook_bind: String,
    webhook_path: String,
    graph_version: String,
    /// Latest inbound wamid per conversation. See the module docs: the Cloud API
    /// addresses read receipts and the typing indicator to a message, never to a
    /// chat, but the keepalive only knows the chat.
    last_inbound: RwLock<HashMap<String, String>>,
}

impl WhatsAppChannel {
    /// Build a channel with no status reporting (env-configured bots).
    ///
    /// `pairing` is required here too: a caller that genuinely wants
    /// process-lifetime pairings (tests, or a gateway with no writable data dir)
    /// says so by passing [`PairingStore::ephemeral`], rather than getting a
    /// private store by accident.
    pub fn new(
        cfg: WhatsAppChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
    ) -> anyhow::Result<Self> {
        Self::new_with_status(cfg, http, pairing, None)
    }

    /// Like [`Self::new`] but takes the node's shared pairing store and attaches a
    /// liveness reporter so the bot heartbeats its connection status back to the
    /// control plane.
    pub fn new_with_status(
        cfg: WhatsAppChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
        status: Option<StatusReporter>,
    ) -> anyhow::Result<Self> {
        if cfg.access_token.trim().is_empty() {
            anyhow::bail!("whatsapp channel access_token is empty");
        }
        if cfg.phone_number_id.trim().is_empty() {
            anyhow::bail!("whatsapp channel phone_number_id is empty");
        }
        if cfg.verify_token.trim().is_empty() {
            anyhow::bail!("whatsapp channel verify_token is empty");
        }
        if cfg.app_secret.trim().is_empty() {
            anyhow::bail!(
                "whatsapp channel app_secret is empty (set WHATSAPP_APP_SECRET); \
                 required to verify inbound webhook signatures"
            );
        }
        Ok(Self {
            runtime: ChannelRuntime::new(http, cfg.common, pairing, status),
            access_token: cfg.access_token,
            phone_number_id: cfg.phone_number_id,
            verify_token: cfg.verify_token,
            app_secret: cfg.app_secret,
            webhook_bind: cfg.webhook_bind,
            webhook_path: cfg.webhook_path,
            graph_version: cfg.graph_version,
            last_inbound: RwLock::new(HashMap::new()),
        })
    }

    fn messages_url(&self) -> String {
        format!(
            "{GRAPH_HOST}/{}/{}/messages",
            self.graph_version, self.phone_number_id
        )
    }

    /// The media-resolve endpoint: a media id is exchanged here for a short-lived
    /// download URL that must *itself* be fetched with the bearer token.
    fn media_url(&self, media_id: &str) -> String {
        format!("{GRAPH_HOST}/{}/{media_id}", self.graph_version)
    }

    /// POST one body to the messages endpoint. Every outbound verb — text,
    /// reaction, read receipt, typing indicator — is this call with a different
    /// payload.
    ///
    /// # Errors
    /// Returns `Err` on transport failure or a non-2xx from the Graph API.
    async fn post_message(&self, payload: &Value) -> anyhow::Result<()> {
        self.runtime
            .http
            .post(self.messages_url())
            .bearer_auth(&self.access_token)
            .json(payload)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Record the wamid of the newest inbound message in a conversation, so the
    /// typing indicator has something to address.
    async fn remember_inbound(&self, chat_id: &str, message_id: String) {
        let mut map = self.last_inbound.write().await;
        if map.len() >= MAX_TRACKED_CHATS {
            map.clear();
        }
        map.insert(chat_id.to_string(), message_id);
    }

    /// The wamid last seen in a conversation, if any.
    async fn latest_inbound(&self, chat_id: &str) -> Option<String> {
        self.last_inbound.read().await.get(chat_id).cloned()
    }

    /// Does the shared access policy already admit this sender?
    ///
    /// Consults the same [`crate::pairing::AccessPolicy`] handle that
    /// [`handle_turn`] consults rather than re-deriving the rules, and exists for
    /// exactly one reason: `/help` is answered locally, so without this check a
    /// stranger would be told the operator's whole command list — leaking both the
    /// menu and the fact that the bot exists, which the `Deny` arm of the gate is
    /// specifically there to avoid.
    ///
    /// Asking twice is harmless. An unknown sender is challenged here (minting a
    /// code), falls through to [`handle_turn`], and is answered `Pending` with the
    /// *same* code inside its TTL — so the sender still receives exactly one
    /// pairing prompt, sent by the kernel, as they would have anyway.
    ///
    /// Cloud API conversations are one-to-one, so only the DM arm can apply.
    async fn access_allows(&self, message: &InboundMessage) -> bool {
        let decision = self
            .runtime
            .cfg
            .access
            .decide_dm(&self.runtime.pairing, PLATFORM, message.identity())
            .await;
        matches!(decision, Decision::Allow)
    }

    /// Resolve and download every attachment whose bytes the turn actually needs.
    ///
    /// Only speech is fetched: [`ChannelRuntime::ingest_media`] discards bytes for
    /// anything else, and an image the agent cannot see is not worth the round
    /// trip — [`media::annotate`] already tells it one arrived. Returns the
    /// `(index, bytes)` pairs `ingest_media` expects.
    ///
    /// Failures are logged and skipped rather than propagated: a voice note that
    /// cannot be downloaded degrades to a placeholder in the turn text, which is a
    /// far better outcome than dropping the message.
    async fn fetch_media(&self, attachments: &[Attachment]) -> Vec<(usize, Vec<u8>)> {
        let mut out = Vec::new();
        for (index, attachment) in attachments.iter().enumerate() {
            if !attachment.resolved_kind().is_speech() {
                continue;
            }
            let Some(media_id) = attachment.file_id.as_deref() else {
                continue;
            };
            match self.download_media(media_id).await {
                Ok(bytes) => out.push((index, bytes)),
                Err(err) => warn!(
                    channel = PLATFORM,
                    media_id, %err, "failed to download inbound whatsapp media"
                ),
            }
        }
        out
    }

    /// Two-step media fetch: exchange the media id for a URL, then download that
    /// URL. Both calls need the bearer token — the resolved URL is *not* public.
    ///
    /// # Errors
    /// Returns `Err` when either call fails, the resolve response carries no URL,
    /// or the payload exceeds [`media::MAX_ATTACHMENT_BYTES`].
    async fn download_media(&self, media_id: &str) -> anyhow::Result<Vec<u8>> {
        let resolved: Value = self
            .runtime
            .http
            .get(self.media_url(media_id))
            .bearer_auth(&self.access_token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let Some(link) = resolved["url"].as_str() else {
            anyhow::bail!("whatsapp media {media_id} resolved without a url");
        };
        let auth = format!("Bearer {}", self.access_token);
        media::download(
            &self.runtime.http,
            link,
            &[("Authorization", auth.as_str())],
        )
        .await
    }
}

/// State shared into the webhook axum handlers.
#[derive(Clone)]
struct WebhookState {
    channel: Arc<WhatsAppChannel>,
    host: Arc<dyn ChannelHost>,
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

// ─── Webhook handlers ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct VerifyQuery {
    #[serde(rename = "hub.mode")]
    mode: Option<String>,
    #[serde(rename = "hub.verify_token")]
    verify_token: Option<String>,
    #[serde(rename = "hub.challenge")]
    challenge: Option<String>,
}

/// Meta's subscription handshake: echo back `hub.challenge` iff the mode is
/// `subscribe` and the verify token matches the configured value.
async fn verify_webhook(
    State(state): State<WebhookState>,
    Query(query): Query<VerifyQuery>,
) -> impl IntoResponse {
    let mode_ok = query.mode.as_deref() == Some("subscribe");
    let token_ok = query
        .verify_token
        .as_deref()
        .is_some_and(|t| constant_time_eq(t.as_bytes(), state.channel.verify_token.as_bytes()));
    if mode_ok && token_ok {
        if let Some(challenge) = query.challenge {
            return (StatusCode::OK, challenge);
        }
    }
    warn!("whatsapp webhook verification rejected");
    (StatusCode::FORBIDDEN, "forbidden".to_string())
}

/// Inbound message delivery. Authenticate and durably claim every message before
/// returning `200`; only then is the slow turn dispatched onto its own task.
///
/// Meta retries callbacks, so the message's stable `wamid` is the provider
/// idempotency key. Payloads without a message id use a bounded hash fallback,
/// which keeps an identical retry from duplicating work while avoiding a
/// made-up identity that could collide with a real `wamid`.
///
/// Every POST must carry a valid `X-Hub-Signature-256` HMAC of the raw body
/// keyed by the Meta App Secret; otherwise the payload is spoofable. We take the
/// raw `Bytes` (not `Json`) so the signature is computed over the exact bytes
/// Meta signed, reject on any mismatch, and only then parse the JSON.
async fn receive_webhook(
    State(state): State<WebhookState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let sig = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok());
    if !verify_signature(&state.channel.app_secret, sig, &body) {
        warn!("whatsapp webhook rejected: missing or invalid X-Hub-Signature-256");
        return StatusCode::FORBIDDEN;
    }

    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        warn!("whatsapp webhook rejected: body is not valid JSON");
        return StatusCode::BAD_REQUEST;
    };

    for (index, inbound) in parse_inbound(&payload).into_iter().enumerate() {
        let provider_id = inbound_delivery_id(&inbound, &body, index);
        let (delivery_id, claim) = match claim_inbound_delivery(&*state.channel, &provider_id).await
        {
            Ok(result) => result,
            Err(error) => {
                warn!(%error, "whatsapp webhook delivery could not be durably claimed");
                // A 5xx is intentional here: Meta can retry a valid event when
                // local durable acceptance is unavailable.
                return StatusCode::SERVICE_UNAVAILABLE;
            }
        };
        if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
            debug!(
                delivery_id = %delivery_id,
                ?claim,
                "duplicate whatsapp webhook delivery suppressed"
            );
            continue;
        }
        let Some(permit) = try_reserve_delivery(&*state.channel) else {
            if let Err(error) = state
                .channel
                .runtime
                .pairing
                .fail_delivery(PLATFORM, &delivery_id)
                .await
            {
                warn!(%error, "whatsapp webhook capacity failure could not be persisted");
            }
            warn!("whatsapp webhook capacity is exhausted; asking Meta to retry");
            return StatusCode::SERVICE_UNAVAILABLE;
        };
        let channel = Arc::clone(&state.channel);
        let host = Arc::clone(&state.host);
        tokio::spawn(async move {
            let mut inbound = inbound;
            prepare_message(&channel, &mut inbound).await;
            let work_channel = Arc::clone(&channel);
            let work_host = Arc::clone(&host);
            let work_delivery_id = delivery_id.clone();
            run_claimed_delivery_with_permit(channel, delivery_id, permit, move || {
                let channel = Arc::clone(&work_channel);
                let host = Arc::clone(&work_host);
                let inbound = inbound.clone();
                let delivery_id = work_delivery_id.clone();
                async move { dispatch(channel, host, inbound, &delivery_id).await }
            })
            .await;
        });
    }
    StatusCode::OK
}

/// Everything between "a message was parsed" and the shared inbound path:
/// remember the wamid the platform verbs address, pull down any voice note, and
/// intercept the one command WhatsApp cannot express as a menu.
async fn dispatch(
    channel: Arc<WhatsAppChannel>,
    host: Arc<dyn ChannelHost>,
    message: InboundMessage,
    delivery_id: &str,
) -> ChannelTurnOutcome {
    // `/help` is the discovery affordance a platform with a command menu gets for
    // free. Every OTHER command falls through untouched — Core's `pre_user_turn`
    // hooks are what execute them, and they only need the text to arrive intact.
    if is_help_request(&message.text) && channel.access_allows(&message).await {
        let help = format_command_help(&channel.runtime.commands().await);
        return match channel.send_message(&message.chat_id, &help).await {
            Ok(()) => ChannelTurnOutcome::Completed,
            Err(err) => {
                warn!(channel = PLATFORM, %err, "failed to deliver the command list");
                ChannelTurnOutcome::Failed
            }
        };
    }

    handle_turn_with_delivery(channel, host, message, Some(delivery_id)).await
}

async fn prepare_message(channel: &WhatsAppChannel, message: &mut InboundMessage) {
    if let Some(message_id) = message.message_id.clone() {
        channel.remember_inbound(&message.chat_id, message_id).await;
    }

    // Fetch and transcribe only for a sender the gate would admit. Meta's webhook
    // is authenticated, but the SENDER is not — anyone who knows the business
    // number can message it, so an unpaired stranger could otherwise spend the
    // operator's STT budget by sending audio. `already_admitted` is the read-only
    // twin of the gate inside `handle_turn`, which still issues the pairing prompt.
    if !message.attachments.is_empty()
        && channel
            .runtime
            .already_admitted(channel.name(), message)
            .await
    {
        let downloaded = channel.fetch_media(&message.attachments).await;
        channel.runtime.ingest_media(message, downloaded).await;
    }
}

fn inbound_delivery_id(message: &InboundMessage, body: &[u8], index: usize) -> String {
    if let Some(message_id) = message
        .message_id
        .as_deref()
        .filter(|message_id| !message_id.trim().is_empty())
    {
        return format!("wamid:{message_id}");
    }
    let digest = Sha256::digest(body);
    format!("payload:{}:{index}", hex::encode(digest))
}

// ─── Payload builders ──────────────────────────────────────────────────────────
//
// The Cloud API expresses every outbound verb as the same POST with a different
// body, so these pure builders are where the verbs actually differ — and the only
// part worth testing without a Graph API to talk to.

/// A plain text reply.
fn text_payload(to: &str, body: &str) -> Value {
    json!({
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": { "body": body },
    })
}

/// A read receipt, optionally carrying the typing indicator.
///
/// Both are addressed to an inbound message id, never to a chat. With
/// `typing = true` WhatsApp shows "typing…" for ~25 seconds or until the bot
/// replies, whichever comes first; without it the message is merely marked read.
fn read_status_payload(message_id: &str, typing: bool) -> Value {
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
fn reaction_payload(to: &str, message_id: &str, emoji: &str) -> Value {
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

// ─── Webhook signature ─────────────────────────────────────────────────────────

/// Verify Meta's `X-Hub-Signature-256` header against `hmac_sha256(app_secret,
/// raw_body)`. The header is formatted `sha256=<hex>`. Verification is
/// constant-time (via `Mac::verify_slice`), and a missing/malformed header or
/// non-hex digest fails closed.
///
/// This is the *only* thing authenticating the webhook — the receiver is a public
/// HTTP endpoint — so it stays strict and must never grow an escape hatch.
fn verify_signature(app_secret: &str, signature: Option<&str>, body: &[u8]) -> bool {
    let Some(sig) = signature else {
        return false;
    };
    let Some(hex_digest) = sig.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(expected) = hex::decode(hex_digest) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(app_secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

/// Constant-time byte-slice equality (length-independent short-circuit only on
/// differing lengths, which are not secret here).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ─── Inbound parsing ───────────────────────────────────────────────────────────

/// Extract user messages from a WhatsApp Cloud API webhook payload.
///
/// Pure and synchronous — media is carried as an id to be resolved later, by
/// [`WhatsAppChannel::fetch_media`] — so the whole shape of an inbound message is
/// testable without a network.
///
/// The payload nests messages under `entry[].changes[].value.messages[]`; status
/// callbacks (delivery receipts) carry no `messages` array and are ignored.
/// `sender_id` is the sender's phone number (`wa_id`), which is what the pairing
/// gate keys on, and `is_group` is always false: Cloud API conversations are
/// one-to-one, so the person and the conversation are the same thing.
fn parse_inbound(payload: &Value) -> Vec<InboundMessage> {
    let mut out = Vec::new();
    let Some(entries) = payload["entry"].as_array() else {
        return out;
    };
    for entry in entries {
        let Some(changes) = entry["changes"].as_array() else {
            continue;
        };
        for change in changes {
            let Some(messages) = change["value"]["messages"].as_array() else {
                continue;
            };
            for message in messages {
                let Some(from) = message["from"].as_str() else {
                    continue;
                };
                let text = message_text(message);
                let attachments: Vec<Attachment> = attachment_from(message).into_iter().collect();
                // Reactions, system notices and message types we cannot render
                // carry neither text nor media; there is nothing to route.
                if text.trim().is_empty() && attachments.is_empty() {
                    continue;
                }
                out.push(InboundMessage {
                    chat_id: from.to_string(),
                    access_chat_id: None,
                    text,
                    author_name: contact_name(change, from),
                    sender_id: Some(from.to_string()),
                    message_id: message["id"].as_str().map(str::to_string),
                    is_group: false,
                    attachments,
                    channel_action: None,
                });
            }
        }
    }
    debug!(count = out.len(), "parsed whatsapp inbound messages");
    out
}

/// The typed text of a message: the body of a text message, or the caption a
/// media message was sent with.
fn message_text(message: &Value) -> String {
    if let Some(body) = message["text"]["body"].as_str() {
        return body.to_string();
    }
    if let Some(title) = message["interactive"]["button_reply"]["title"].as_str() {
        return title.to_string();
    }
    if let Some(title) = message["interactive"]["list_reply"]["title"].as_str() {
        return title.to_string();
    }
    if let Some(location) = message["location"].as_object() {
        let latitude = location
            .get("latitude")
            .and_then(Value::as_f64)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let longitude = location
            .get("longitude")
            .and_then(Value::as_f64)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let label = location
            .get("name")
            .or_else(|| location.get("address"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!(" ({value})"))
            .unwrap_or_default();
        return format!("[location: {latitude}, {longitude}{label}]");
    }
    message["type"]
        .as_str()
        .and_then(|kind| message[kind]["caption"].as_str())
        .unwrap_or_default()
        .to_string()
}

/// Turn a media message into an [`Attachment`] carrying the media id.
///
/// The Cloud API distinguishes a voice note from an audio file with
/// `audio.voice = true` rather than a separate type. Both are transcribed, so
/// mis-reading that flag only changes the label used when annotating the turn.
fn attachment_from(message: &Value) -> Option<Attachment> {
    let kind_name = message["type"].as_str()?;
    let node = &message[kind_name];
    let kind = match kind_name {
        "audio" => {
            if node["voice"].as_bool().unwrap_or(false) {
                AttachmentKind::Voice
            } else {
                AttachmentKind::Audio
            }
        }
        "image" | "sticker" => AttachmentKind::Image,
        "video" => AttachmentKind::Video,
        "document" => AttachmentKind::Document,
        _ => return None,
    };
    let file_id = node["id"].as_str()?.to_string();
    Some(Attachment {
        kind: Some(kind),
        // Cloud API media is never directly fetchable; the id resolves to a
        // short-lived URL that still needs the bearer token.
        url: None,
        file_id: Some(file_id),
        mime: node["mime_type"].as_str().map(str::to_string),
        filename: node["filename"].as_str().map(str::to_string),
        size: node["file_size"].as_u64(),
    })
}

/// The WhatsApp profile name of a sender, from the `contacts[]` array that
/// accompanies the messages in the same change. Unverified display text — it is
/// recorded on the turn for attribution, never used for authorization.
fn contact_name(change: &Value, wa_id: &str) -> Option<String> {
    change["value"]["contacts"]
        .as_array()?
        .iter()
        .find(|contact| contact["wa_id"].as_str() == Some(wa_id))
        .and_then(|contact| contact["profile"]["name"].as_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
}

// ─── Text-triggered command discovery ──────────────────────────────────────────

/// Is this message asking what the bot can do?
///
/// Only `/help` and `/commands` qualify: bare "help" is a plausible thing to ask
/// an assistant in prose, and hijacking it would make the agent unreachable for
/// anyone who genuinely wanted help with something.
fn is_help_request(text: &str) -> bool {
    match commands::parse_command(text) {
        Some((name, _)) => matches!(name.as_str(), "help" | "commands"),
        None => false,
    }
}

/// Render the command menu as a WhatsApp message.
///
/// Plain text with the platform's `*bold*` shorthand — WhatsApp has no rich text
/// beyond that, which is why [`Channel::caps`] reports `rich_text: false`.
fn format_command_help(commands: &[ChannelCommand]) -> String {
    if commands.is_empty() {
        return "No commands are available right now.".to_string();
    }
    let mut out = String::from("*Commands*\n");
    for command in commands {
        out.push('\n');
        out.push('/');
        out.push_str(&command.name);
        if !command.description.is_empty() {
            out.push_str(" — ");
            out.push_str(&command.description);
        }
    }
    out.push_str("\n\nSend one exactly as shown.");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CommonChannelConfig;

    fn sample_config() -> WhatsAppChannelConfig {
        WhatsAppChannelConfig {
            access_token: "token".to_string(),
            phone_number_id: "12345".to_string(),
            verify_token: "verifyme".to_string(),
            app_secret: "shhh".to_string(),
            webhook_bind: "0.0.0.0:8443".to_string(),
            webhook_path: "/webhooks/whatsapp".to_string(),
            graph_version: "v21.0".to_string(),
            common: CommonChannelConfig {
                model: "gpt-4o".to_string(),
                ..Default::default()
            },
        }
    }

    fn cmd(name: &str, description: &str) -> ChannelCommand {
        ChannelCommand {
            name: name.to_string(),
            description: description.to_string(),
            source: "plugin".to_string(),
        }
    }

    /// Wrap message objects in the `entry[].changes[].value` envelope Meta sends.
    fn envelope(value: Value) -> Value {
        json!({ "entry": [ { "changes": [ { "value": value } ] } ] })
    }

    struct NoopHost;

    #[async_trait]
    impl ChannelHost for NoopHost {
        async fn run_pipeline(&self, _channel_name: &str, _body: Value) -> anyhow::Result<Value> {
            anyhow::bail!("noop host is not used by this webhook test")
        }
    }

    #[test]
    fn new_rejects_empty_app_secret() {
        let mut cfg = sample_config();
        cfg.app_secret = "   ".to_string();
        assert!(
            WhatsAppChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral()).is_err()
        );
    }

    #[test]
    fn new_rejects_empty_access_token() {
        let mut cfg = sample_config();
        cfg.access_token = "   ".to_string();
        assert!(
            WhatsAppChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral()).is_err()
        );
    }

    #[test]
    fn verifies_valid_signature_and_rejects_tampering() {
        let secret = "shhh";
        let body = br#"{"entry":[]}"#;
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body);
        let sig = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

        assert!(verify_signature(secret, Some(&sig), body));
        // wrong secret, missing header, malformed prefix, and tampered body all fail
        assert!(!verify_signature("other", Some(&sig), body));
        assert!(!verify_signature(secret, None, body));
        assert!(!verify_signature(secret, Some("deadbeef"), body));
        assert!(!verify_signature(secret, Some(&sig), br#"{"entry":[1]}"#));
    }

    #[tokio::test]
    async fn webhook_claims_wamid_before_ack_and_suppresses_retry() {
        let mut config = sample_config();
        config.common.access.dm = crate::pairing::DmPolicy::Disabled;
        let channel = Arc::new(
            WhatsAppChannel::new(config, reqwest::Client::new(), PairingStore::ephemeral())
                .unwrap(),
        );
        let state = WebhookState {
            channel: Arc::clone(&channel),
            host: Arc::new(NoopHost),
        };
        let body = br#"{
            "entry":[{"changes":[{"value":{"messages":[{
                "id":"wamid.test","from":"1555","type":"text",
                "text":{"body":"hello"}
            }]}}]}]
        }"#;
        let mut mac = Hmac::<Sha256>::new_from_slice(b"shhh").unwrap();
        mac.update(body);
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-hub-signature-256",
            format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
                .parse()
                .unwrap(),
        );

        assert_eq!(
            receive_webhook(
                State(state.clone()),
                headers.clone(),
                Bytes::from_static(body)
            )
            .await,
            StatusCode::OK
        );
        assert_eq!(
            receive_webhook(State(state), headers, Bytes::from_static(body)).await,
            StatusCode::OK
        );
        assert!(matches!(
            channel
                .runtime
                .pairing
                .claim_delivery("whatsapp", "whatsapp:wamid:wamid.test")
                .await
                .unwrap(),
            crate::pairing::DeliveryClaim::InFlight | crate::pairing::DeliveryClaim::Completed
        ));
    }

    #[test]
    fn verify_webhook_rejects_bad_verify_token() {
        // confirm constant_time_eq rejects a mismatched token
        assert!(!constant_time_eq(b"correct", b"wrongtoken"));
        assert!(!constant_time_eq(b"correct", b"correc"));
        assert!(constant_time_eq(b"correct", b"correct"));
    }

    #[test]
    fn builds_graph_urls() {
        let channel = WhatsAppChannel::new(
            sample_config(),
            reqwest::Client::new(),
            PairingStore::ephemeral(),
        )
        .unwrap();
        assert_eq!(
            channel.messages_url(),
            "https://graph.facebook.com/v21.0/12345/messages"
        );
        assert_eq!(
            channel.media_url("media-1"),
            "https://graph.facebook.com/v21.0/media-1"
        );
        assert_eq!(channel.name(), "whatsapp");
        assert_eq!(channel.model(), "gpt-4o");
    }

    #[test]
    fn caps_match_what_the_cloud_api_can_do() {
        let channel = WhatsAppChannel::new(
            sample_config(),
            reqwest::Client::new(),
            PairingStore::ephemeral(),
        )
        .unwrap();
        let caps = channel.caps();
        assert!(caps.typing && caps.attachments && caps.reactions);
        // No rich text, no drafts, no threads, no menu, and no WAV playback.
        assert!(!caps.rich_text && !caps.streaming && !caps.threads);
        assert!(!caps.command_menu && !caps.voice);
        // Meta expires the indicator after ~25s, so it must be re-asserted sooner.
        assert!(channel.typing_interval() < Duration::from_secs(25));
    }

    #[test]
    fn new_reads_the_common_config() {
        let mut cfg = sample_config();
        cfg.common.agent_id = Some("acp:pi".to_string());
        let channel =
            WhatsAppChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral()).unwrap();
        assert_eq!(channel.runtime().cfg.agent_id.as_deref(), Some("acp:pi"));
        assert!(channel.runtime().routes_via_core());

        let bare = WhatsAppChannel::new(
            sample_config(),
            reqwest::Client::new(),
            PairingStore::ephemeral(),
        )
        .unwrap();
        assert!(!bare.runtime().routes_via_core());
    }

    // ── payload builders ──

    #[test]
    fn read_status_payload_adds_typing_only_when_asked() {
        let read = read_status_payload("wamid.1", false);
        assert_eq!(read["status"], "read");
        assert_eq!(read["message_id"], "wamid.1");
        assert!(
            read.get("typing_indicator").is_none(),
            "a plain read receipt must not show the indicator"
        );

        let typing = read_status_payload("wamid.1", true);
        assert_eq!(typing["typing_indicator"]["type"], "text");
        assert_eq!(
            typing["status"], "read",
            "the typing call also marks the message read"
        );
    }

    #[test]
    fn text_and_reaction_payloads_target_the_right_ids() {
        let text = text_payload("15551234567", "hi");
        assert_eq!(text["messaging_product"], "whatsapp");
        assert_eq!(text["to"], "15551234567");
        assert_eq!(text["text"]["body"], "hi");

        let reaction = reaction_payload("15551234567", "wamid.7", "👍");
        assert_eq!(reaction["type"], "reaction");
        assert_eq!(reaction["reaction"]["message_id"], "wamid.7");
        assert_eq!(reaction["reaction"]["emoji"], "👍");
    }

    // ── inbound parsing ──

    #[test]
    fn parse_inbound_reads_text_message() {
        let payload = envelope(json!({
            "contacts": [ { "wa_id": "15551234567", "profile": { "name": "Ada" } } ],
            "messages": [
                {
                    "id": "wamid.abc",
                    "from": "15551234567",
                    "type": "text",
                    "text": { "body": "hello there" }
                }
            ]
        }));
        let parsed = parse_inbound(&payload);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].chat_id, "15551234567");
        assert_eq!(parsed[0].text, "hello there");
        // The pairing gate keys on the person, so the wa_id must be the identity.
        assert_eq!(parsed[0].sender_id.as_deref(), Some("15551234567"));
        assert_eq!(parsed[0].identity(), "15551234567");
        assert_eq!(parsed[0].message_id.as_deref(), Some("wamid.abc"));
        assert_eq!(parsed[0].author_name.as_deref(), Some("Ada"));
        // Cloud API conversations are one-to-one.
        assert!(!parsed[0].is_group);
    }

    #[test]
    fn parse_inbound_ignores_status_callbacks() {
        let payload = envelope(json!({ "statuses": [ { "status": "delivered" } ] }));
        assert!(parse_inbound(&payload).is_empty());
    }

    #[test]
    fn parse_inbound_turns_an_image_into_an_attachment() {
        // Previously an image was dropped; it now arrives as media with a caption.
        let payload = envelope(json!({
            "messages": [
                {
                    "id": "wamid.img",
                    "from": "1555",
                    "type": "image",
                    "image": { "id": "media-9", "mime_type": "image/jpeg", "caption": "look" }
                }
            ]
        }));
        let parsed = parse_inbound(&payload);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "look", "the caption is the turn text");
        assert_eq!(parsed[0].attachments.len(), 1);
        let attachment = &parsed[0].attachments[0];
        assert_eq!(attachment.file_id.as_deref(), Some("media-9"));
        assert_eq!(attachment.resolved_kind(), AttachmentKind::Image);
        assert!(
            attachment.url.is_none(),
            "cloud API media must be resolved by id, never fetched directly"
        );
        assert!(!parsed[0].is_voice());
    }

    #[test]
    fn parse_inbound_reads_a_voice_note() {
        let payload = envelope(json!({
            "messages": [
                {
                    "id": "wamid.v",
                    "from": "1555",
                    "type": "audio",
                    "audio": { "id": "media-v", "mime_type": "audio/ogg", "voice": true }
                }
            ]
        }));
        let parsed = parse_inbound(&payload);
        assert_eq!(parsed.len(), 1);
        assert!(
            parsed[0].text.is_empty(),
            "the transcript is folded in later, by ingest_media"
        );
        assert_eq!(
            parsed[0].attachments[0].resolved_kind(),
            AttachmentKind::Voice
        );
        assert!(parsed[0].is_voice());

        // An audio FILE is the same type without the flag, and is still speech.
        let as_file = envelope(json!({
            "messages": [
                {
                    "id": "wamid.a",
                    "from": "1555",
                    "type": "audio",
                    "audio": { "id": "media-a", "mime_type": "audio/mpeg" }
                }
            ]
        }));
        let parsed = parse_inbound(&as_file);
        assert_eq!(
            parsed[0].attachments[0].resolved_kind(),
            AttachmentKind::Audio
        );
        assert!(parsed[0].is_voice(), "an audio file is transcribed too");
    }

    #[test]
    fn parse_inbound_keeps_a_document_filename() {
        let payload = envelope(json!({
            "messages": [
                {
                    "id": "wamid.d",
                    "from": "1555",
                    "type": "document",
                    "document": {
                        "id": "media-d",
                        "mime_type": "application/pdf",
                        "filename": "report.pdf",
                        "file_size": 4096
                    }
                }
            ]
        }));
        let parsed = parse_inbound(&payload);
        let attachment = &parsed[0].attachments[0];
        assert_eq!(attachment.filename.as_deref(), Some("report.pdf"));
        assert_eq!(attachment.size, Some(4096));
        assert_eq!(attachment.resolved_kind(), AttachmentKind::Document);
    }

    #[test]
    fn parse_inbound_drops_messages_with_nothing_to_route() {
        // A reaction carries neither text nor media.
        let reaction = envelope(json!({
            "messages": [
                {
                    "id": "wamid.r",
                    "from": "1555",
                    "type": "reaction",
                    "reaction": { "message_id": "wamid.abc", "emoji": "👍" }
                }
            ]
        }));
        assert!(parse_inbound(&reaction).is_empty());

        // …as does an empty text body.
        let blank = envelope(json!({
            "messages": [
                { "id": "wamid.b", "from": "1555", "type": "text", "text": { "body": "   " } }
            ]
        }));
        assert!(parse_inbound(&blank).is_empty());
    }

    #[test]
    fn contact_name_matches_on_wa_id_only() {
        let change = json!({
            "value": {
                "contacts": [
                    { "wa_id": "111", "profile": { "name": "Ada" } },
                    { "wa_id": "222", "profile": { "name": "Grace" } }
                ]
            }
        });
        assert_eq!(contact_name(&change, "222").as_deref(), Some("Grace"));
        assert!(contact_name(&change, "333").is_none());
        assert!(contact_name(&json!({}), "111").is_none());
    }

    // ── text-triggered help ──

    #[test]
    fn help_is_recognised_only_as_a_command() {
        assert!(is_help_request("/help"));
        assert!(is_help_request("  /Commands"));
        assert!(is_help_request("/help@ryubot"));
        // Prose asking for help belongs to the agent, not to the menu.
        assert!(!is_help_request("help me write a poem"));
        assert!(!is_help_request("can you help?"));
        // Any other command is routed to Core, which is what executes it.
        assert!(!is_help_request("/goal ship it"));
    }

    #[test]
    fn format_command_help_lists_every_command() {
        let rendered = format_command_help(&[cmd("goal", "set a goal"), cmd("proof", "prove it")]);
        assert!(rendered.starts_with("*Commands*"));
        assert!(rendered.contains("/goal — set a goal"));
        assert!(rendered.contains("/proof — prove it"));

        // A command with no description still lists, without a dangling dash.
        let sparse = format_command_help(&[cmd("goal", "")]);
        assert!(sparse.contains("/goal\n"), "got {sparse:?}");
        assert!(!sparse.contains("—"));
    }

    #[test]
    fn format_command_help_says_so_when_there_are_none() {
        // Core unreachable at startup ⇒ an empty menu, which must still explain
        // itself rather than sending a bare heading.
        let rendered = format_command_help(&[]);
        assert!(rendered.contains("No commands"));
        assert!(!rendered.contains('/'));
    }

    #[tokio::test]
    async fn latest_inbound_is_remembered_per_chat_and_bounded() {
        let channel = WhatsAppChannel::new(
            sample_config(),
            reqwest::Client::new(),
            PairingStore::ephemeral(),
        )
        .unwrap();
        assert!(channel.latest_inbound("1555").await.is_none());

        channel.remember_inbound("1555", "wamid.1".into()).await;
        channel.remember_inbound("1666", "wamid.2".into()).await;
        assert_eq!(
            channel.latest_inbound("1555").await.as_deref(),
            Some("wamid.1")
        );

        // The newest id wins — the indicator must attach to the live message.
        channel.remember_inbound("1555", "wamid.3".into()).await;
        assert_eq!(
            channel.latest_inbound("1555").await.as_deref(),
            Some("wamid.3")
        );

        // The map is capped, so a long-lived process cannot leak a slot per sender.
        for i in 0..MAX_TRACKED_CHATS {
            channel
                .remember_inbound(&format!("chat-{i}"), "wamid.x".into())
                .await;
        }
        assert!(channel.last_inbound.read().await.len() <= MAX_TRACKED_CHATS);
    }
}
