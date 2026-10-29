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
    commands::{parse_command, ChannelCommand},
    handle_turn_with_delivery,
    media::{self, Attachment, AttachmentKind, VoiceDelivery},
    pairing::PairingStore,
    run_claimed_delivery_with_permit,
    status::StatusReporter,
    try_reserve_delivery, BlueBubblesChannelConfig, Channel, ChannelCaps, ChannelHost,
    ChannelRuntime, ChannelTurnOutcome, GroupReplyMode, InboundMessage,
};

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

// ─── Webhook receiver ───────────────────────────────────────────────────────

/// State shared into the axum handlers.
#[derive(Clone)]
struct WebhookState {
    channel: Arc<BlueBubblesChannel>,
    host: Arc<dyn ChannelHost>,
}

/// The token may also arrive as a query parameter.
#[derive(Debug, Default, Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

/// Bare route: the token must come from `?token=` or the header.
async fn receive_webhook(
    State(state): State<WebhookState>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let presented = query
        .token
        .or_else(|| header_token(&headers))
        .unwrap_or_default();
    ingest(state, &presented, &body).await
}

/// Token-in-path route, which is the form the operator actually pastes.
async fn receive_webhook_token(
    State(state): State<WebhookState>,
    Path(token): Path<String>,
    body: Bytes,
) -> StatusCode {
    ingest(state, &token, &body).await
}

fn header_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// Authenticate, parse, and dispatch one webhook delivery.
///
/// Always answers quickly after a durable claim — the turn runs on its own task —
/// so BlueBubbles does not retry a delivery that is already being handled.
/// Unknown event types are a 200, not an error: the server emits typing, read-status
/// and message-update events on the same hook and treating those as failures would
/// make the operator's log useless.
async fn ingest(state: WebhookState, presented: &str, body: &[u8]) -> StatusCode {
    if !token_ok(&state.channel.webhook_secret, presented) {
        warn!(
            channel = "bluebubbles",
            "webhook rejected: missing or wrong shared token"
        );
        return StatusCode::FORBIDDEN;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(body) else {
        warn!(
            channel = "bluebubbles",
            "webhook rejected: body is not JSON"
        );
        return StatusCode::BAD_REQUEST;
    };
    let Some(message) = parse_inbound(&payload) else {
        return StatusCode::OK;
    };

    let provider_id = inbound_delivery_id(&message, body);
    let (delivery_id, claim) = match claim_inbound_delivery(&*state.channel, &provider_id).await {
        Ok(result) => result,
        Err(error) => {
            warn!(%error, "bluebubbles webhook delivery could not be durably claimed");
            return StatusCode::SERVICE_UNAVAILABLE;
        }
    };
    if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
        debug!(
            delivery_id = %delivery_id,
            ?claim,
            "duplicate bluebubbles webhook delivery suppressed"
        );
        return StatusCode::OK;
    }
    let Some(permit) = try_reserve_delivery(&*state.channel) else {
        if let Err(error) = state
            .channel
            .runtime
            .pairing
            .fail_delivery("bluebubbles", &delivery_id)
            .await
        {
            warn!(%error, "bluebubbles webhook capacity failure could not be persisted");
        }
        warn!("bluebubbles webhook capacity is exhausted; asking the bridge to retry");
        return StatusCode::SERVICE_UNAVAILABLE;
    };

    let channel = Arc::clone(&state.channel);
    let host = Arc::clone(&state.host);
    tokio::spawn(async move {
        let mut message = message;
        prepare_message(&channel, &mut message).await;
        let work_channel = Arc::clone(&channel);
        let work_host = Arc::clone(&host);
        let work_delivery_id = delivery_id.clone();
        run_claimed_delivery_with_permit(channel, delivery_id, permit, move || {
            let channel = Arc::clone(&work_channel);
            let host = Arc::clone(&work_host);
            let message = message.clone();
            let delivery_id = work_delivery_id.clone();
            async move { dispatch(channel, host, message, &delivery_id).await }
        })
        .await;
    });
    StatusCode::OK
}

async fn dispatch(
    channel: Arc<BlueBubblesChannel>,
    host: Arc<dyn ChannelHost>,
    message: InboundMessage,
    delivery_id: &str,
) -> ChannelTurnOutcome {
    if message.is_group
        && !should_reply_in_group(
            channel.runtime.cfg.group_reply_mode,
            &message.text,
            &channel.mention_patterns,
        )
    {
        debug!(
            channel = "bluebubbles",
            "group message not addressed to the bot; staying quiet"
        );
        return ChannelTurnOutcome::Completed;
    }

    // iMessage has no native command menu, so `/help` is answered here rather
    // than being registered with the platform.
    if let Some(reply) = local_command_reply(&channel.runtime.commands().await, &message.text) {
        if channel
            .runtime
            .already_admitted(channel.name(), &message)
            .await
        {
            return match channel.send_message(&message.chat_id, &reply).await {
                Ok(()) => ChannelTurnOutcome::Completed,
                Err(err) => {
                    warn!(channel = "bluebubbles", %err, "failed to deliver command list");
                    ChannelTurnOutcome::Failed
                }
            };
        }
        // Let the shared turn gate make the authoritative decision. Denied
        // callers stay silent and pairing callers receive only its challenge.
    }

    handle_turn_with_delivery(channel, host, message, Some(delivery_id)).await
}

async fn prepare_message(channel: &BlueBubblesChannel, message: &mut InboundMessage) {
    // Transcribe before any text-based decision below: a voice note in a group
    // has no text to check for a command or an address until it is transcribed.
    // Only fetch and transcribe for a sender the gate would admit. The webhook is
    // unauthenticated by design (BlueBubbles does not sign its posts), so without
    // this a forged payload could spend the operator's STT budget.
    if channel
        .runtime
        .already_admitted(channel.name(), message)
        .await
    {
        let downloaded = channel.download_speech(message).await;
        if !downloaded.is_empty() {
            channel.runtime.ingest_media(message, downloaded).await;
        }
    }
}

fn inbound_delivery_id(message: &InboundMessage, body: &[u8]) -> String {
    message
        .message_id
        .as_deref()
        .filter(|message_id| !message_id.trim().is_empty())
        .map_or_else(
            || format!("payload:{}", hex::encode(Sha256::digest(body))),
            |message_id| format!("message:{message_id}"),
        )
}

// ─── Pure helpers (payloads, parsing, decisions) ────────────────────────────

/// Parse a BlueBubbles webhook body into an inbound turn, or `None` when there is
/// nothing to answer.
///
/// Pure and synchronous so every rule below is unit-testable without a Mac:
///
/// - only `new-message` is handled; `typing-indicator`, `chat-read-status-change`,
///   `updated-message` and anything else the server grows later fall through,
/// - **`isFromMe` is dropped**. This is the load-bearing check in the whole adapter:
///   the bot's own reply comes straight back through the same webhook, so without it
///   the bot answers itself forever, in a loop nothing else here would break,
/// - the reply target is `chats[0].guid`, and a missing one means we could not
///   answer even if we wanted to.
fn parse_inbound(payload: &Value) -> Option<InboundMessage> {
    if payload["type"].as_str() != Some("new-message") {
        return None;
    }
    let data = &payload["data"];
    if data["isFromMe"].as_bool().unwrap_or(false) {
        debug!(channel = "bluebubbles", "ignoring our own outbound message");
        return None;
    }
    let chat = data["chats"].as_array().and_then(|c| c.first())?;
    let chat_id = chat["guid"].as_str()?.to_string();

    let text = data["text"]
        .as_str()
        .unwrap_or_default()
        .replace(OBJECT_REPLACEMENT, "")
        .trim()
        .to_string();
    let attachments: Vec<Attachment> = data["attachments"]
        .as_array()
        .map(|list| list.iter().filter_map(parse_attachment).collect())
        .unwrap_or_default();
    if text.is_empty() && attachments.is_empty() {
        return None;
    }

    Some(InboundMessage {
        chat_id,
        access_chat_id: None,
        text,
        // iMessage has no display name on the wire — the address IS the identity,
        // and resolving a contact card is the recipient's device's job, not ours.
        author_name: None,
        sender_id: data["handle"]["address"].as_str().map(str::to_string),
        message_id: data["guid"].as_str().map(str::to_string),
        is_group: chat["style"].as_i64() == Some(CHAT_STYLE_GROUP),
        attachments,
        channel_action: None,
    })
}

/// One entry of `data.attachments[]`.
///
/// The guid goes in `file_id` (not `url`) because BlueBubbles serves attachment
/// bytes from an authenticated endpoint keyed by guid — exactly the "opaque id
/// needing a resolve step" case [`Attachment`] documents.
fn parse_attachment(value: &Value) -> Option<Attachment> {
    let guid = value["guid"].as_str()?.to_string();
    // Apple marks a recorded voice memo explicitly; without that flag an m4a is
    // just as likely to be a shared song, which `resolved_kind` handles from MIME.
    let kind = value["isAudioMessage"]
        .as_bool()
        .unwrap_or(false)
        .then_some(AttachmentKind::Voice);
    Some(Attachment {
        kind,
        url: None,
        file_id: Some(guid),
        mime: value["mimeType"].as_str().map(str::to_string),
        filename: value["transferName"].as_str().map(str::to_string),
        size: value["totalBytes"].as_u64(),
    })
}

/// Body for `POST /api/v1/message/text`.
///
/// `method` picks the send path on the Mac: `apple-script` always works, while
/// `private-api` (the helper) is what allows subject lines, effects and replies.
/// Pure so the shape is pinned by a test rather than by a live server.
fn send_text_payload(chat_guid: &str, temp_guid: &str, text: &str, private_api: bool) -> Value {
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
fn temp_guid(chat_guid: &str, text: &str, nanos: u128) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-bluebubbles-temp-guid\0");
    hasher.update(chat_guid.as_bytes());
    hasher.update(b"\0");
    hasher.update(text.as_bytes());
    hasher.update(nanos.to_le_bytes());
    format!("ryu-{}", hex::encode(&hasher.finalize()[..16]))
}

/// Nanoseconds since the epoch, saturating to 0 before it.
fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Derive the shared secret the webhook must present.
///
/// Derived from the server password rather than drawn randomly so it is stable
/// across gateway restarts — an operator who pasted a URL into BlueBubbles once
/// should not have to redo it on every deploy. The path is mixed in so two channels
/// on one node do not share a token, and the password itself is never recoverable
/// from it.
fn derive_webhook_secret(password: &str, webhook_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-bluebubbles-webhook\0");
    hasher.update(password.as_bytes());
    hasher.update(b"\0");
    hasher.update(webhook_path.as_bytes());
    hex::encode(&hasher.finalize()[..16])
}

/// Constant-time comparison of the presented token against the expected one.
/// Length is not secret (the token is a fixed-width hex string), so an early return
/// on a length mismatch leaks nothing.
fn token_ok(expected: &str, presented: &str) -> bool {
    let (a, b) = (expected.as_bytes(), presented.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Coerce an operator-supplied webhook path into something axum can route: a
/// leading slash, no trailing slash, and never the bare root (the token route would
/// otherwise become `//:token`).
fn normalize_webhook_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    let trimmed = trimmed.trim_start_matches('/');
    if trimmed.is_empty() {
        return DEFAULT_WEBHOOK_PATH.to_string();
    }
    format!("/{trimmed}")
}

/// Is this bind address reachable from outside the operator's network?
///
/// Used only to warn. The unspecified address counts as routable because binding
/// `0.0.0.0` exposes the receiver on every interface the host happens to have.
fn is_publicly_routable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_loopback() || v4.is_private() || v4.is_link_local()) || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            if v6.is_unspecified() {
                return true;
            }
            let first = v6.segments()[0];
            // `is_unique_local` / `is_unicast_link_local` are still unstable, so the
            // fc00::/7 and fe80::/10 prefixes are matched by hand.
            let unique_local = first & 0xfe00 == 0xfc00;
            let link_local = first & 0xffc0 == 0xfe80;
            !(v6.is_loopback() || unique_local || link_local)
        }
    }
}

/// Should the bot answer this GROUP message?
///
/// iMessage has no @mention primitive a bridge can observe, so `Mentions` mode is
/// approximated: a slash command, or a message that opens by addressing the bot by
/// name. That is a heuristic and is documented as one — the alternative, answering
/// every message in a family group chat, is the failure mode this mode exists to
/// prevent.
fn should_reply_in_group(mode: GroupReplyMode, text: &str, mention_patterns: &[String]) -> bool {
    match mode {
        GroupReplyMode::All => true,
        GroupReplyMode::Mentions => {
            if parse_command(text).is_some() {
                return true;
            }
            let lowered = text.trim_start().to_ascii_lowercase();
            if ["ryu", "@ryu", "hey ryu"]
                .iter()
                .any(|prefix| lowered.starts_with(prefix))
            {
                return true;
            }
            mention_patterns.iter().any(|pattern| {
                let pattern = pattern.trim().to_ascii_lowercase();
                !pattern.is_empty() && lowered.contains(&pattern)
            })
        }
    }
}

/// Answer `/help` and `/commands` locally, since there is no menu to register.
///
/// Returns `None` for ordinary text (and for any other command, which belongs to
/// Core and must reach it intact).
fn local_command_reply(commands: &[ChannelCommand], text: &str) -> Option<String> {
    let (name, _) = parse_command(text)?;
    if name != "help" && name != "commands" {
        return None;
    }
    if commands.is_empty() {
        return Some("No commands are available right now.".to_string());
    }
    let mut out = String::from("Available commands:");
    for cmd in commands {
        out.push_str(&format!("\n/{} — {}", cmd.name, cmd.description));
    }
    Some(out)
}

/// Map an emoji onto one of iMessage's six tapbacks, or `None` when nothing fits.
fn tapback_for_emoji(emoji: &str) -> Option<&'static str> {
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

/// Reject a BlueBubbles error envelope (`{status, message, data}`).
///
/// The server answers 200 with a non-200 `status` field in some paths, so the HTTP
/// code alone is not enough to know a send landed.
///
/// # Errors
/// Returns `Err` when `status` is present and outside the 2xx range.
fn check_envelope(body: &Value) -> anyhow::Result<()> {
    let Some(status) = body["status"].as_i64() else {
        return Ok(());
    };
    if (200..300).contains(&status) {
        return Ok(());
    }
    let message = body["message"].as_str().unwrap_or("unknown error");
    anyhow::bail!("bluebubbles server returned status {status}: {message}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CommonChannelConfig;

    fn sample_config() -> BlueBubblesChannelConfig {
        BlueBubblesChannelConfig {
            server_url: "http://192.168.1.10:1234".to_string(),
            password: "hunter2".to_string(),
            webhook_bind: "127.0.0.1:8765".to_string(),
            webhook_path: "/webhooks/bluebubbles".to_string(),
            private_api: false,
            mention_patterns: Vec::new(),
            home_channel: None,
            common: CommonChannelConfig::default(),
        }
    }

    fn channel(cfg: BlueBubblesChannelConfig) -> BlueBubblesChannel {
        BlueBubblesChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral())
            .expect("config should be valid")
    }

    fn new_message(text: &str, is_from_me: bool, style: i64) -> Value {
        json!({
            "type": "new-message",
            "data": {
                "guid": "msg-guid-1",
                "text": text,
                "isFromMe": is_from_me,
                "handle": { "address": "+15551234567", "service": "iMessage" },
                "chats": [ { "guid": "iMessage;-;+15551234567", "style": style } ]
            }
        })
    }

    #[test]
    fn new_rejects_missing_transport_secrets() {
        let mut blank_url = sample_config();
        blank_url.server_url = "   ".to_string();
        assert!(BlueBubblesChannel::new(
            blank_url,
            reqwest::Client::new(),
            PairingStore::ephemeral()
        )
        .is_err());

        let mut bad_url = sample_config();
        bad_url.server_url = "not a url".to_string();
        assert!(BlueBubblesChannel::new(
            bad_url,
            reqwest::Client::new(),
            PairingStore::ephemeral()
        )
        .is_err());

        let mut blank_password = sample_config();
        blank_password.password = "  ".to_string();
        assert!(BlueBubblesChannel::new(
            blank_password,
            reqwest::Client::new(),
            PairingStore::ephemeral()
        )
        .is_err());
    }

    #[test]
    fn caps_track_the_private_api_helper() {
        let plain = channel(sample_config());
        assert!(!plain.caps().typing, "typing needs the Private API helper");
        assert!(!plain.caps().reactions);
        assert!(plain.caps().attachments, "iMessage always carries files");
        assert!(!plain.caps().rich_text);
        assert!(!plain.caps().threads);
        assert!(!plain.caps().command_menu);
        assert!(!plain.caps().streaming);
        // Voice rides the ordinary attachment upload, so it must NOT be gated on
        // the helper: gating it would silently drop a spoken reply the operator
        // asked for, on a bridge whose upload path works fine.
        assert!(
            plain.caps().voice,
            "voice uses the attachment path and must not require the Private API"
        );

        let mut cfg = sample_config();
        cfg.private_api = true;
        let helper = channel(cfg);
        assert!(helper.caps().typing);
        assert!(helper.caps().reactions);
        assert!(helper.caps().voice);
    }

    #[test]
    fn parse_inbound_reads_a_direct_message() {
        let parsed = parse_inbound(&new_message("hello there", false, 45))
            .expect("a 1:1 new-message must parse");
        assert_eq!(parsed.chat_id, "iMessage;-;+15551234567");
        assert_eq!(parsed.text, "hello there");
        assert_eq!(parsed.sender_id.as_deref(), Some("+15551234567"));
        assert_eq!(parsed.message_id.as_deref(), Some("msg-guid-1"));
        assert!(!parsed.is_group);
        // The pairing gate keys on the handle, not the chat guid.
        assert_eq!(parsed.identity(), "+15551234567");
    }

    #[test]
    fn parse_inbound_skips_our_own_messages() {
        // The single most important check in the adapter: the bot's own reply comes
        // straight back through the webhook, so answering it is an infinite loop.
        assert!(parse_inbound(&new_message("my own reply", true, 45)).is_none());
    }

    #[test]
    fn parse_inbound_detects_group_style() {
        let group = parse_inbound(&new_message("hi all", false, CHAT_STYLE_GROUP)).unwrap();
        assert!(group.is_group);
        // An unrecognised style is treated as 1:1.
        let odd = parse_inbound(&new_message("hi", false, 99)).unwrap();
        assert!(!odd.is_group);
    }

    #[test]
    fn parse_inbound_ignores_other_event_types_without_panicking() {
        for event in [
            "typing-indicator",
            "chat-read-status-change",
            "updated-message",
        ] {
            let payload = json!({ "type": event, "data": { "guid": "x" } });
            assert!(parse_inbound(&payload).is_none(), "{event} must be ignored");
        }
        // Wholly unexpected shapes must not panic either.
        assert!(parse_inbound(&json!({})).is_none());
        assert!(parse_inbound(&json!({ "type": "new-message" })).is_none());
        assert!(
            parse_inbound(&json!({ "type": "new-message", "data": { "text": "hi" } })).is_none()
        );
    }

    #[test]
    fn parse_inbound_drops_a_message_with_no_content() {
        assert!(parse_inbound(&new_message("   ", false, 45)).is_none());
    }

    #[test]
    fn parse_inbound_reads_attachments_and_strips_the_placeholder_glyph() {
        let mut payload = new_message("\u{fffc}listen to this", false, 45);
        payload["data"]["attachments"] = json!([
            {
                "guid": "att-1",
                "mimeType": "audio/x-m4a",
                "transferName": "Audio Message.caf",
                "totalBytes": 4096,
                "isAudioMessage": true
            },
            {
                "guid": "att-2",
                "mimeType": "image/png",
                "transferName": "IMG_0001.png",
                "totalBytes": 90210
            }
        ]);
        let parsed = parse_inbound(&payload).unwrap();
        assert_eq!(
            parsed.text, "listen to this",
            "the U+FFFC glyph is stripped"
        );
        assert_eq!(parsed.attachments.len(), 2);
        assert_eq!(parsed.attachments[0].kind, Some(AttachmentKind::Voice));
        assert_eq!(parsed.attachments[0].file_id.as_deref(), Some("att-1"));
        assert_eq!(parsed.attachments[0].size, Some(4096));
        assert!(
            parsed.is_voice(),
            "a voice memo makes the turn a voice turn"
        );
        // The photo carries no explicit kind; MIME resolves it.
        assert_eq!(parsed.attachments[1].kind, None);
        assert_eq!(parsed.attachments[1].resolved_kind(), AttachmentKind::Image);
    }

    #[test]
    fn temp_guid_is_deterministic_shaped_and_clock_sensitive() {
        let a = temp_guid("chat", "hello", 42);
        assert_eq!(a, temp_guid("chat", "hello", 42), "pure in its inputs");
        assert!(a.starts_with("ryu-"));
        assert_eq!(a.len(), 4 + 32, "128 bits of hex");
        assert!(a[4..].chars().all(|c| c.is_ascii_hexdigit()));
        // Every input varies the id, so two identical sends are distinguishable.
        assert_ne!(a, temp_guid("chat", "hello", 43));
        assert_ne!(a, temp_guid("other", "hello", 42));
        assert_ne!(a, temp_guid("chat", "goodbye", 42));
    }

    #[test]
    fn send_text_payload_picks_the_send_method() {
        let script = send_text_payload("iMessage;-;+1555", "ryu-abc", "hi", false);
        assert_eq!(script["chatGuid"], "iMessage;-;+1555");
        assert_eq!(script["tempGuid"], "ryu-abc");
        assert_eq!(script["message"], "hi");
        assert_eq!(
            script["method"], "apple-script",
            "AppleScript is the always-available path"
        );

        let helper = send_text_payload("iMessage;-;+1555", "ryu-abc", "hi", true);
        assert_eq!(helper["method"], "private-api");
    }

    #[test]
    fn api_and_attachment_urls_are_built_safely() {
        let ch = channel(sample_config());
        assert_eq!(
            ch.api("message/text"),
            "http://192.168.1.10:1234/api/v1/message/text"
        );
        let url = ch.attachment_url("att/../1").unwrap();
        assert!(
            url.contains("/api/v1/attachment/att%2F..%2F1/download"),
            "a guid must not be able to escape its path segment: {url}"
        );
        assert!(url.contains("password=hunter2"));
    }

    #[test]
    fn webhook_secret_is_stable_and_scoped() {
        let a = derive_webhook_secret("hunter2", "/webhooks/bluebubbles");
        assert_eq!(a, derive_webhook_secret("hunter2", "/webhooks/bluebubbles"));
        assert_eq!(a.len(), 32);
        assert_ne!(a, derive_webhook_secret("hunter3", "/webhooks/bluebubbles"));
        assert_ne!(a, derive_webhook_secret("hunter2", "/webhooks/other"));
        assert!(!a.contains("hunter2"));
    }

    #[test]
    fn token_check_rejects_everything_but_the_exact_token() {
        let expected = derive_webhook_secret("hunter2", "/hook");
        assert!(token_ok(&expected, &expected));
        assert!(!token_ok(&expected, ""));
        assert!(!token_ok(&expected, &expected[..31]));
        assert!(!token_ok(&expected, &format!("{expected}x")));
        let mut wrong = expected.clone();
        wrong.replace_range(0..1, if expected.starts_with('a') { "b" } else { "a" });
        assert!(!token_ok(&expected, &wrong));
    }

    #[test]
    fn webhook_path_is_normalised_for_routing() {
        assert_eq!(normalize_webhook_path("/hook"), "/hook");
        assert_eq!(normalize_webhook_path("hook"), "/hook");
        assert_eq!(normalize_webhook_path("/hook/"), "/hook");
        assert_eq!(normalize_webhook_path("  /a/b/  "), "/a/b");
        // The bare root would make the token route `//:token`, so it is replaced.
        assert_eq!(normalize_webhook_path("/"), DEFAULT_WEBHOOK_PATH);
        assert_eq!(normalize_webhook_path(""), DEFAULT_WEBHOOK_PATH);
    }

    #[test]
    fn webhook_url_hint_is_pasteable() {
        let ch = channel(sample_config());
        let addr: SocketAddr = "127.0.0.1:8765".parse().unwrap();
        let hint = ch.webhook_url_hint(&addr);
        assert!(hint.starts_with("http://127.0.0.1:8765/webhooks/bluebubbles/"));
        assert!(hint.ends_with(&ch.webhook_secret));
    }

    #[test]
    fn routable_binds_are_flagged_and_lan_binds_are_not() {
        assert!(!is_publicly_routable("127.0.0.1".parse().unwrap()));
        assert!(!is_publicly_routable("192.168.1.5".parse().unwrap()));
        assert!(!is_publicly_routable("10.0.0.7".parse().unwrap()));
        assert!(!is_publicly_routable("::1".parse().unwrap()));
        assert!(
            !is_publicly_routable("fd12::1".parse().unwrap()),
            "unique-local"
        );
        assert!(
            !is_publicly_routable("fe80::1".parse().unwrap()),
            "link-local"
        );
        assert!(is_publicly_routable("0.0.0.0".parse().unwrap()));
        assert!(is_publicly_routable("::".parse().unwrap()));
        assert!(is_publicly_routable("203.0.113.9".parse().unwrap()));
        assert!(is_publicly_routable("2001:db8::1".parse().unwrap()));
    }

    #[test]
    fn new_rejects_a_webhook_path_that_would_panic_the_router() {
        // axum treats `:` and `*` as route-parameter syntax and panics on them.
        for bad in ["/hook/:token", "/hook/*rest", "/hook/{id}"] {
            let mut cfg = sample_config();
            cfg.webhook_path = bad.to_string();
            assert!(
                BlueBubblesChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral())
                    .is_err(),
                "{bad} must be refused at construction"
            );
        }
    }

    #[test]
    fn group_reply_mode_approximates_mentions() {
        assert!(should_reply_in_group(GroupReplyMode::All, "anything", &[]));
        assert!(should_reply_in_group(
            GroupReplyMode::Mentions,
            "/help",
            &[]
        ));
        assert!(should_reply_in_group(
            GroupReplyMode::Mentions,
            "Ryu what's up",
            &[]
        ));
        assert!(should_reply_in_group(
            GroupReplyMode::Mentions,
            "hey ryu",
            &[]
        ));
        assert!(!should_reply_in_group(
            GroupReplyMode::Mentions,
            "dinner at 7?",
            &[]
        ));

        let patterns = vec!["assistant".to_string()];
        assert!(should_reply_in_group(
            GroupReplyMode::Mentions,
            "assistant, summarize this",
            &patterns
        ));
    }

    #[test]
    fn local_command_reply_lists_only_help_and_commands() {
        let cmds = vec![ChannelCommand {
            name: "proof".into(),
            description: "prove it".into(),
            source: "plugin".into(),
        }];
        let help = local_command_reply(&cmds, "/help").expect("help is answered locally");
        assert!(help.contains("/proof — prove it"));
        assert!(local_command_reply(&cmds, "/commands").is_some());
        // Anything else belongs to Core and must reach it intact.
        assert!(local_command_reply(&cmds, "/proof").is_none());
        assert!(local_command_reply(&cmds, "just talking").is_none());
        assert!(local_command_reply(&[], "/help").is_some());
    }

    /// A BlueBubbles Server stand-in that records every `message/text` it is
    /// asked to send, so a test can see exactly what reached the iMessage user.
    async fn recording_bluebubbles_server() -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorder = Arc::clone(&sent);
        let app = Router::new().route(
            "/api/v1/message/text",
            post(move |axum::Json(body): axum::Json<Value>| {
                let recorder = Arc::clone(&recorder);
                async move {
                    recorder
                        .lock()
                        .expect("recorder")
                        .push(body["message"].as_str().unwrap_or_default().to_owned());
                    axum::Json(json!({ "status": 200, "message": "Success" }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), sent)
    }

    /// Counts model turns; none of the denied cases may reach one.
    struct CountingHost(std::sync::atomic::AtomicUsize);

    #[async_trait]
    impl ChannelHost for CountingHost {
        async fn run_pipeline(&self, _channel_name: &str, _body: Value) -> anyhow::Result<Value> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            anyhow::bail!("this test never expects a model turn")
        }
    }

    /// Dispatch one `/help` from `+15551234567` (in a group when `is_group`)
    /// under `access`, returning every text sent back and the model-turn count.
    async fn dispatch_help(
        access: crate::pairing::AccessPolicy,
        is_group: bool,
    ) -> (Vec<String>, usize) {
        dispatch_help_with_store(access, is_group, PairingStore::ephemeral()).await
    }

    /// [`dispatch_help`] against a pairing store the caller has pre-seeded
    /// (for example with a blocked or pending sender).
    async fn dispatch_help_with_store(
        access: crate::pairing::AccessPolicy,
        is_group: bool,
        pairing: PairingStore,
    ) -> (Vec<String>, usize) {
        let (server_url, sent) = recording_bluebubbles_server().await;
        let mut cfg = sample_config();
        cfg.server_url = server_url;
        cfg.common.access = access;
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let channel = Arc::new(BlueBubblesChannel::new(cfg, http, pairing).unwrap());
        let host = Arc::new(CountingHost(std::sync::atomic::AtomicUsize::new(0)));
        let style = if is_group { CHAT_STYLE_GROUP } else { 45 };
        let message = parse_inbound(&new_message("/help", false, style)).expect("parses");
        dispatch(channel, host.clone(), message, "message:msg-guid-1").await;
        let texts = sent.lock().expect("recorder").clone();
        (texts, host.0.load(std::sync::atomic::Ordering::SeqCst))
    }

    #[tokio::test]
    async fn local_help_is_silent_for_denied_senders_and_rooms() {
        use crate::pairing::{AccessPolicy, DmPolicy, GroupPolicy};
        let denied = [
            (
                AccessPolicy {
                    dm: DmPolicy::Disabled,
                    ..Default::default()
                },
                false,
            ),
            (
                AccessPolicy {
                    dm: DmPolicy::Allowlist,
                    dm_allowlist: vec!["+15550000000".into()],
                    ..Default::default()
                },
                false,
            ),
            (
                AccessPolicy {
                    group: GroupPolicy::Disabled,
                    dm: DmPolicy::Open,
                    ..Default::default()
                },
                true,
            ),
            (
                AccessPolicy {
                    group: GroupPolicy::Allowlist,
                    group_allowlist: vec!["iMessage;+;other-room".into()],
                    ..Default::default()
                },
                true,
            ),
            // An unlisted room where only a different sender has a per-sender
            // override: the override must not admit this sender.
            (
                AccessPolicy {
                    group: GroupPolicy::Allowlist,
                    group_allowlist: vec!["iMessage;+;other-room".into()],
                    group_sender_allowlist: vec!["+15550000000".into()],
                    ..Default::default()
                },
                true,
            ),
        ];
        for (access, is_group) in denied {
            let label = format!("{access:?} group={is_group}");
            let (sent, turns) = dispatch_help(access, is_group).await;
            assert!(
                sent.is_empty(),
                "a denied caller must get no reply, not the command list: {label}: {sent:?}"
            );
            assert_eq!(turns, 0, "{label}");
        }
    }

    #[tokio::test]
    async fn local_help_gives_an_unpaired_sender_only_the_pairing_prompt() {
        let (sent, turns) = dispatch_help(
            crate::pairing::AccessPolicy {
                dm: crate::pairing::DmPolicy::Pairing,
                ..Default::default()
            },
            false,
        )
        .await;
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert!(sent[0].contains("pairing code"), "{sent:?}");
        assert!(!sent[0].contains("commands"), "{sent:?}");
        assert_eq!(turns, 0);
    }

    #[tokio::test]
    async fn local_help_is_silent_for_a_blocked_pairing_sender() {
        let pairing = PairingStore::ephemeral();
        pairing.block("bluebubbles", "+15551234567").await;
        let (sent, turns) = dispatch_help_with_store(
            crate::pairing::AccessPolicy {
                dm: crate::pairing::DmPolicy::Pairing,
                ..Default::default()
            },
            false,
            pairing,
        )
        .await;
        assert!(sent.is_empty(), "a blocked sender gets nothing: {sent:?}");
        assert_eq!(turns, 0);
    }

    #[tokio::test]
    async fn local_help_gives_a_pending_pairing_sender_only_the_pairing_prompt() {
        let pairing = PairingStore::ephemeral();
        let crate::pairing::Decision::Challenge(code) =
            pairing.challenge("bluebubbles", "+15551234567").await
        else {
            panic!("an unknown sender is challenged");
        };
        let (sent, turns) = dispatch_help_with_store(
            crate::pairing::AccessPolicy {
                dm: crate::pairing::DmPolicy::Pairing,
                ..Default::default()
            },
            false,
            pairing,
        )
        .await;
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert!(
            sent[0].contains(&code),
            "the same live code is repeated: {sent:?}"
        );
        assert!(!sent[0].contains("commands"), "{sent:?}");
        assert_eq!(turns, 0);
    }

    #[tokio::test]
    async fn local_help_still_answers_an_admitted_sender_locally() {
        let (sent, turns) = dispatch_help(
            crate::pairing::AccessPolicy {
                dm: crate::pairing::DmPolicy::Open,
                ..Default::default()
            },
            false,
        )
        .await;
        assert_eq!(
            sent,
            vec!["No commands are available right now.".to_owned()]
        );
        assert_eq!(turns, 0, "the local answer never reaches the model");
    }

    #[test]
    fn tapbacks_cover_the_six_and_refuse_the_rest() {
        assert_eq!(tapback_for_emoji("👍"), Some("like"));
        assert_eq!(tapback_for_emoji("❤️"), Some("love"));
        assert_eq!(tapback_for_emoji("👎"), Some("dislike"));
        assert_eq!(tapback_for_emoji("😂"), Some("laugh"));
        assert_eq!(tapback_for_emoji("‼️"), Some("emphasize"));
        assert_eq!(tapback_for_emoji("❓"), Some("question"));
        // No tapback exists for this, and sending it as a message would be worse.
        assert_eq!(tapback_for_emoji("🦀"), None);
    }

    #[test]
    fn envelope_errors_are_surfaced() {
        assert!(check_envelope(&json!({ "status": 200, "message": "ok" })).is_ok());
        // A body without the envelope field is not treated as an error.
        assert!(check_envelope(&json!({ "data": "pong" })).is_ok());
        let err = check_envelope(&json!({ "status": 400, "message": "Chat not found" }))
            .expect_err("a 4xx envelope must fail");
        assert!(err.to_string().contains("Chat not found"));
    }
}
