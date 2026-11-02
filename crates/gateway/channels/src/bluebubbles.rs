//! BlueBubbles channel adapter — iMessage, bridged through a Mac.
//!
//! Apple ships no iMessage API. The only way to send and receive iMessage
//! programmatically is to drive a signed-in Mac, and [BlueBubbles
//! Server](https://bluebubbles.app) is the community bridge that does exactly
//! that: the operator installs it on a Mac that is logged into their Apple ID, and
//! it exposes a small REST API over the LAN plus an outbound webhook for new
//! messages. Ryu talks to that REST API.
//!
//! ## Why this is an adapter and not a sidecar
//!
//! The Mac-side process already exists and is not ours — BlueBubbles Server is the
//! sidecar, it is just one the operator runs. From the gateway's point of view what
//! remains is an HTTP client plus a webhook receiver, which is precisely the shape
//! of every other adapter in this crate. There is no channel-sidecar mechanism in
//! this repo and inventing one here would buy nothing: this file is a transport and
//! a handful of platform verbs, and [`handle_turn`] does everything in between.
//!
//! ## What the operator has to set up
//!
//! 1. BlueBubbles Server installed and running on a Mac signed into iMessage, with
//!    a server password set.
//! 2. `server_url` pointing at that Mac (`http://192.168.1.10:1234`) and `password`
//!    matching its server password.
//! 3. A webhook in BlueBubbles' settings pointing at THIS gateway's
//!    `webhook_bind` + `webhook_path` — with the shared-secret token appended (see
//!    below). The exact URL to paste is logged at INFO when the receiver binds.
//! 4. Optionally the **Private API** helper (a bundled dylib the operator installs
//!    into Messages). Without it iMessage can only send text and attachments;
//!    typing indicators, read receipts and tapback reactions all require it, which
//!    is why [`ChannelCaps`] for this adapter is computed from
//!    [`BlueBubblesChannelConfig::private_api`] rather than being a constant.
//!
//! ## Webhook security, honestly
//!
//! BlueBubbles does **not** sign its webhooks — there is no HMAC header to verify
//! the way WhatsApp's `X-Hub-Signature-256` lets [`crate::whatsapp`] fail closed.
//! Anything that can reach the receiver can therefore claim to be an inbound
//! iMessage. Two things stand between that and an open relay:
//!
//! - **A shared-secret token.** The receiver derives a high-entropy token from the
//!   server password (see [`derive_webhook_secret`]) and refuses any POST that does
//!   not present it, as a trailing path segment, a `?token=` query parameter, or an
//!   `x-ryu-webhook-token` header. It is compared in constant time. The token is
//!   *derived*, not random, so it survives a gateway restart without the operator
//!   re-pasting the URL.
//! - **The access gate.** Even a forged payload still has to get past
//!   [`crate::pairing`], so a spoofed sender is answered with a pairing code, not an
//!   agent turn.
//!
//! Residual risk, stated plainly: the token travels in a URL over plain HTTP on the
//! LAN (BlueBubbles has no HTTPS of its own), so anyone who can observe that traffic
//! can replay it, and there is no nonce or timestamp to make a replay stale. Bind
//! `webhook_bind` to loopback or a private interface — the adapter warns loudly at
//! startup if it is asked to listen on a routable address — and front it with a
//! reverse proxy if it must leave the LAN.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Router,
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::{debug, info, warn};

use crate::{
    claim_inbound_delivery,
    commands::parse_command,
    handle_turn_with_delivery, i18n,
    media::{self, Attachment, AttachmentKind, VoiceDelivery},
    pairing::PairingStore,
    run_claimed_delivery_with_permit,
    status::StatusReporter,
    try_reserve_delivery, BlueBubblesChannelConfig, Channel, ChannelCaps, ChannelHost,
    ChannelRuntime, ChannelTurnOutcome, GroupReplyMode, InboundMessage,
};

mod channel;
mod inbound;

#[cfg(test)]
use channel::*;
use inbound::*;

/// Timeout for one call to the BlueBubbles Server. Generous because the Mac is on
/// the far side of a LAN and AppleScript sends are not fast, but bounded so a
/// sleeping Mac cannot wedge a channel task forever.
const API_TIMEOUT: Duration = Duration::from_secs(30);

/// Ceiling on a webhook body. BlueBubbles posts JSON metadata only — attachment
/// bytes are fetched separately by guid — so a megabyte is already luxurious, and a
/// cap is mandatory on an unauthenticated-by-design ingress.
const MAX_WEBHOOK_BYTES: usize = 1024 * 1024;

/// Chat `style` BlueBubbles reports for a group iMessage. `45` is a 1:1 chat;
/// anything we do not recognise is treated as 1:1, which is the conservative
/// direction (a DM is gated per-sender by pairing rather than by a group allowlist).
const CHAT_STYLE_GROUP: i64 = 43;

/// Used when `webhook_path` is empty. Mirrors the shape the other webhook adapter
/// uses so operator-facing config looks the same across channels.
const DEFAULT_WEBHOOK_PATH: &str = "/webhooks/bluebubbles";

/// iMessage substitutes U+FFFC (OBJECT REPLACEMENT CHARACTER) into the message text
/// wherever an attachment sits. Left in, every photo turns into a stray glyph in the
/// prompt; [`media::annotate`] describes the attachment properly instead.
const OBJECT_REPLACEMENT: char = '\u{fffc}';

/// The header a caller may present the webhook token in, as an alternative to the
/// path segment or query parameter. BlueBubbles itself only lets the operator
/// configure a URL, so the header exists for reverse proxies that strip queries.
const TOKEN_HEADER: &str = "x-ryu-webhook-token";

pub struct BlueBubblesChannel {
    runtime: ChannelRuntime,
    /// Base URL of the Mac's BlueBubbles Server, trailing slash removed.
    server_url: String,
    /// Server password, sent as the `password` query parameter on every call.
    password: String,
    webhook_bind: String,
    /// Normalised path (leading slash, no trailing slash) the receiver serves.
    webhook_path: String,
    /// The operator installed the Private API helper, so typing indicators, read
    /// receipts and tapbacks are available.
    private_api: bool,
    /// Explicit group-addressing patterns. BlueBubbles webhooks do not carry a
    /// native mention entity, so these are the only configurable way to address
    /// the bot in a group beyond the built-in `ryu`/`@ryu` prefixes.
    mention_patterns: Vec<String>,
    /// Optional operator-selected home chat for future outbound sends. It is kept
    /// on the adapter so store/config parity does not collapse it into a global
    /// channel setting.
    home_channel: Option<String>,
    /// Shared secret an inbound webhook must present. Derived, not random — see the
    /// module doc.
    webhook_secret: String,
}

impl BlueBubblesChannel {
    /// Build the adapter with no liveness reporting (env-configured bots).
    ///
    /// There is deliberately no constructor that defaults the pairing store: iMessage
    /// DMs default to [`crate::pairing::DmPolicy::Pairing`], so an adapter handed a
    /// private [`PairingStore::ephemeral`] would re-challenge every sender on
    /// restart and never see an approval granted through the node's store. A caller
    /// that really wants process-lifetime pairings (tests) passes `ephemeral()`
    /// explicitly and can be seen doing it.
    pub fn new(
        cfg: BlueBubblesChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
    ) -> anyhow::Result<Self> {
        Self::new_with_status(cfg, http, pairing, None)
    }

    /// Like [`Self::new`] but attaches a liveness reporter so the bot heartbeats its
    /// connection status back to the control plane. The pairing store is shared
    /// across every channel on a node, so the gateway passes the same one to each
    /// adapter it spawns.
    pub fn new_with_status(
        cfg: BlueBubblesChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
        status: Option<StatusReporter>,
    ) -> anyhow::Result<Self> {
        let server_url = cfg.server_url.trim().trim_end_matches('/').to_string();
        if server_url.is_empty() {
            anyhow::bail!(
                "bluebubbles channel server_url is empty; set it to the Mac running \
                 BlueBubbles Server, e.g. http://192.168.1.10:1234"
            );
        }
        if reqwest::Url::parse(&server_url).is_err() {
            anyhow::bail!("bluebubbles channel server_url {server_url:?} is not a valid URL");
        }
        let password = cfg.password.trim().to_string();
        if password.is_empty() {
            anyhow::bail!(
                "bluebubbles channel password is empty; it is the BlueBubbles Server \
                 password and authenticates every request"
            );
        }
        let webhook_path = normalize_webhook_path(&cfg.webhook_path);
        // axum PANICS when a route path contains its parameter syntax, and this one
        // is operator-supplied, so it is rejected at construction rather than
        // brought down the whole gateway task at bind time.
        if webhook_path.contains([':', '*', '{', '}']) {
            anyhow::bail!(
                "bluebubbles channel webhook_path {webhook_path:?} contains route-parameter \
                 syntax (: * {{ }}); use a plain literal path"
            );
        }
        let webhook_secret = derive_webhook_secret(&password, &webhook_path);
        Ok(Self {
            runtime: ChannelRuntime::new(http, cfg.common, pairing, status),
            server_url,
            password,
            webhook_bind: cfg.webhook_bind,
            webhook_path,
            private_api: cfg.private_api,
            mention_patterns: cfg.mention_patterns,
            home_channel: cfg.home_channel,
            webhook_secret,
        })
    }

    /// Absolute URL for a BlueBubbles REST path, e.g. `message/text`.
    fn api(&self, path: &str) -> String {
        format!(
            "{}/api/v1/{}",
            self.server_url,
            path.trim_start_matches('/')
        )
    }

    /// BlueBubbles accepts a direct phone number or email address as the
    /// `any;-;<address>` chat GUID form. Preserve full GUIDs for group chats and
    /// webhook-originated replies, while making configured home/outbound targets
    /// ergonomic instead of requiring operators to discover an opaque GUID.
    fn target_chat_guid(&self, chat_id: &str) -> anyhow::Result<String> {
        let raw = if chat_id.trim().is_empty() {
            self.home_channel.as_deref().unwrap_or_default()
        } else {
            chat_id
        };
        let raw = raw.trim();
        if raw.is_empty() {
            anyhow::bail!(
                "bluebubbles outbound message has no chat target; set home_channel or provide a chat id"
            );
        }
        if raw.contains(";-;") || raw.contains(";+;") {
            return Ok(raw.to_string());
        }
        Ok(format!("any;-;{raw}"))
    }

    /// A request against the server with the `password` auth parameter and the
    /// shared timeout already applied. Building it here is what keeps the password
    /// out of every format string in this file — `query` percent-encodes it and
    /// reqwest never logs it.
    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.runtime
            .http
            .request(method, self.api(path))
            .query(&[("password", self.password.as_str())])
            .timeout(API_TIMEOUT)
    }

    /// Connect check: `GET /api/v1/ping` answers `{"status":200,…,"data":"pong"}`.
    ///
    /// # Errors
    /// Returns `Err` when the Mac is unreachable, the password is wrong (401), or
    /// the reply is not the expected envelope.
    async fn ping(&self) -> anyhow::Result<()> {
        let body: Value = self
            .request(Method::GET, "ping")
            .send()
            .await
            .map_err(reqwest::Error::without_url)?
            .error_for_status()
            .map_err(reqwest::Error::without_url)?
            .json()
            .await?;
        check_envelope(&body)?;
        if body["data"].as_str() == Some("pong") {
            Ok(())
        } else {
            anyhow::bail!("bluebubbles ping did not answer pong: {body}")
        }
    }

    /// URL to fetch one attachment's bytes by guid.
    ///
    /// **Assumed endpoint**: `GET /api/v1/attachment/{guid}/download`. Built through
    /// [`reqwest::Url`] rather than `format!` so a guid containing a path character
    /// is percent-encoded instead of escaping the route.
    ///
    /// # Errors
    /// Returns `Err` when `server_url` cannot be used as a base URL.
    fn attachment_url(&self, guid: &str) -> anyhow::Result<String> {
        let mut url = reqwest::Url::parse(&self.server_url)?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("bluebubbles server_url cannot be a base URL"))?
            .extend(["api", "v1", "attachment", guid, "download"]);
        url.query_pairs_mut()
            .append_pair("password", &self.password);
        Ok(url.to_string())
    }

    /// Download the SPEECH attachments on a message, paired with their index.
    ///
    /// Only speech is fetched: [`ChannelRuntime::ingest_media`] transcribes speech
    /// and ignores everything else, and [`handle_turn`] describes non-speech media
    /// from its metadata alone — so pulling a 12 MB photo across the LAN would buy
    /// nothing. A failed download degrades to "no bytes for that index", which
    /// leaves the turn as an annotated attachment rather than dropping it.
    async fn download_speech(&self, message: &InboundMessage) -> Vec<(usize, Vec<u8>)> {
        let mut out = Vec::new();
        for (index, attachment) in message.attachments.iter().enumerate() {
            if !attachment.resolved_kind().is_speech() {
                continue;
            }
            let Some(guid) = attachment.file_id.as_deref() else {
                continue;
            };
            if attachment
                .size
                .is_some_and(|n| n as usize > media::MAX_ATTACHMENT_BYTES)
            {
                warn!(
                    channel = "bluebubbles",
                    size = attachment.size,
                    "skipping oversized inbound attachment"
                );
                continue;
            }
            let url = match self.attachment_url(guid) {
                Ok(url) => url,
                Err(err) => {
                    warn!(channel = "bluebubbles", %err, "could not build attachment URL");
                    continue;
                }
            };
            match media::download(&self.runtime.http, &url, &[]).await {
                Ok(bytes) => out.push((index, bytes)),
                Err(err) => warn!(
                    channel = "bluebubbles",
                    %err,
                    "failed to download inbound iMessage attachment"
                ),
            }
        }
        out
    }

    /// Clear the typing indicator after a send.
    ///
    /// [`crate::TypingGuard`] only aborts its keepalive task; it has no "stop" verb,
    /// and the Private API's indicator persists until it is explicitly cleared. So
    /// every successful send drops it, otherwise the bubble would sit in the chat
    /// after the reply has already landed.
    async fn clear_typing(&self, chat_guid: &str) {
        if !self.private_api {
            return;
        }
        let Ok(chat_guid) = self.target_chat_guid(chat_guid) else {
            return;
        };
        self.best_effort(
            "stop typing",
            self.request(Method::DELETE, &format!("chat/{chat_guid}/typing")),
        )
        .await;
    }

    /// Fire a Private-API call whose failure must never reach the message loop.
    /// Typing indicators, read receipts and tapbacks are all decoration: if the
    /// helper is missing or the endpoint has moved, the conversation still works.
    async fn best_effort(&self, what: &str, req: reqwest::RequestBuilder) {
        match req.send().await.map_err(reqwest::Error::without_url) {
            Ok(resp) if resp.status().is_success() => {}
            Ok(resp) => debug!(
                channel = "bluebubbles",
                status = %resp.status(),
                what,
                "bluebubbles private-api call returned non-2xx (helper installed?)"
            ),
            Err(err) => debug!(
                channel = "bluebubbles",
                %err, what, "bluebubbles private-api call failed"
            ),
        }
    }

    /// The URL the operator must paste into BlueBubbles' webhook settings.
    fn webhook_url_hint(&self, addr: &SocketAddr) -> String {
        format!("http://{addr}{}/{}", self.webhook_path, self.webhook_secret)
    }
}

#[cfg(test)]
mod tests;
