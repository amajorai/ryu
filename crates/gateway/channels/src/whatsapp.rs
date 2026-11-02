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

use crate::commands;
use crate::i18n;
use crate::media::{self, Attachment, AttachmentKind, VoiceDelivery};
use crate::pairing::{Decision, PairingStore};
use crate::status::StatusReporter;
use crate::whatsapp_format;
use crate::{
    claim_inbound_delivery, handle_turn_with_delivery, run_claimed_delivery_with_permit,
    try_reserve_delivery, Channel, ChannelCaps, ChannelHost, ChannelRuntime, ChannelTurnOutcome,
    InboundMessage, WhatsAppChannelConfig,
};

mod channel;
mod inbound;

use channel::*;
use inbound::*;

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

#[cfg(test)]
mod tests;
