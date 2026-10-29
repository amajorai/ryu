//! WhatsApp Personal channel adapter backed by a self-hosted OpenWA instance.
//!
//! OpenWA is an unofficial WhatsApp Web bridge. Ryu keeps that distinction
//! explicit: this adapter is named `whatsapp_personal`, uses OpenWA's
//! `X-API-Key` REST contract, and never shares credentials or webhook semantics
//! with the official Meta Cloud API adapter in [`crate::whatsapp`].
//!
//! The adapter owns the OpenWA lifecycle seam that makes a channel record
//! usable: it starts an existing session when needed, creates/updates the
//! per-session webhook, verifies OpenWA's HMAC delivery signature, and maps
//! OpenWA messages into the shared access/media/Core turn path.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::IntoResponse,
    routing::post,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::{debug, info, warn};

use crate::commands::{self, ChannelCommand};
use crate::media::{self, Attachment, AttachmentKind, VoiceDelivery};
use crate::pairing::{Decision, PairingStore};
use crate::status::StatusReporter;
use crate::whatsapp_format;
use crate::{
    claim_inbound_delivery, handle_turn_with_delivery, run_claimed_delivery_with_permit,
    try_reserve_delivery, Channel, ChannelCaps, ChannelHost, ChannelRuntime, ChannelTurnOutcome,
    InboundMessage, OpenWaChannelConfig,
};

const PLATFORM: &str = "whatsapp_personal";
const TYPING_INTERVAL: Duration = Duration::from_secs(8);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWaSession {
    #[serde(default)]
    status: String,
    #[serde(default)]
    engine_loaded: bool,
}

#[derive(Debug, Deserialize)]
struct OpenWaWebhook {
    id: String,
    url: String,
    #[serde(default)]
    active: bool,
}

pub struct OpenWaChannel {
    runtime: ChannelRuntime,
    base_url: String,
    api_key: String,
    session_id: String,
    webhook_url: String,
    webhook_secret: String,
    webhook_bind: String,
    webhook_path: String,
    self_chat_only: bool,
}

impl OpenWaChannel {
    /// Build a channel with no status reporter (for non-store config).
    pub fn new(
        cfg: OpenWaChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
    ) -> anyhow::Result<Self> {
        Self::new_with_status(cfg, http, pairing, None)
    }

    /// Build a channel with the node's shared pairing store and optional
    /// control-plane liveness reporter.
    pub fn new_with_status(
        cfg: OpenWaChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
        status: Option<StatusReporter>,
    ) -> anyhow::Result<Self> {
        for (field, value) in [
            ("base_url", cfg.base_url.as_str()),
            ("api_key", cfg.api_key.as_str()),
            ("session_id", cfg.session_id.as_str()),
            ("webhook_url", cfg.webhook_url.as_str()),
            ("webhook_secret", cfg.webhook_secret.as_str()),
            ("webhook_bind", cfg.webhook_bind.as_str()),
            ("webhook_path", cfg.webhook_path.as_str()),
        ] {
            if value.trim().is_empty() {
                anyhow::bail!("whatsapp personal channel {field} is empty");
            }
        }
        let base_url = reqwest::Url::parse(cfg.base_url.trim_end_matches('/'))
            .map_err(|err| anyhow::anyhow!("invalid OpenWA base_url: {err}"))?;
        if !matches!(base_url.scheme(), "http" | "https") {
            anyhow::bail!("OpenWA base_url must use http or https");
        }
        let webhook_url = reqwest::Url::parse(&cfg.webhook_url)
            .map_err(|err| anyhow::anyhow!("invalid OpenWA webhook_url: {err}"))?;
        if !matches!(webhook_url.scheme(), "http" | "https") {
            anyhow::bail!("OpenWA webhook_url must use http or https");
        }
        if !cfg.webhook_path.starts_with('/') {
            anyhow::bail!("OpenWA webhook_path must start with '/'");
        }
        if cfg
            .webhook_path
            .chars()
            .any(|character| matches!(character, ':' | '*' | '{' | '}'))
        {
            anyhow::bail!("OpenWA webhook_path must be a literal route path");
        }

        Ok(Self {
            runtime: ChannelRuntime::new(http, cfg.common, pairing, status),
            base_url: cfg.base_url.trim_end_matches('/').to_string(),
            api_key: cfg.api_key,
            session_id: cfg.session_id,
            webhook_url: cfg.webhook_url,
            webhook_secret: cfg.webhook_secret,
            webhook_bind: cfg.webhook_bind,
            webhook_path: cfg.webhook_path,
            self_chat_only: cfg.self_chat_only,
        })
    }

    /// Build an OpenWA API URL while treating every id as a path segment.
    /// Chat ids contain `@`, and message ids can contain other punctuation, so
    /// string concatenation here would make a malformed or ambiguous route.
    fn api_url(&self, segments: &[&str]) -> anyhow::Result<reqwest::Url> {
        let mut url = reqwest::Url::parse(&self.base_url)?;
        let base_segments: Vec<String> = url
            .path_segments()
            .map(|parts| parts.map(str::to_string).collect())
            .unwrap_or_default();
        url.set_path("");
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| anyhow::anyhow!("OpenWA base_url cannot carry path segments"))?;
            for segment in base_segments.iter().filter(|segment| !segment.is_empty()) {
                path.push(segment);
            }
            path.push("api");
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }

    fn request(
        &self,
        method: Method,
        segments: &[&str],
    ) -> anyhow::Result<reqwest::RequestBuilder> {
        Ok(self
            .runtime
            .http
            .request(method, self.api_url(segments)?)
            .header("X-API-Key", &self.api_key))
    }

    async fn get_json<T: DeserializeOwned>(&self, segments: &[&str]) -> anyhow::Result<T> {
        Ok(self
            .request(Method::GET, segments)?
            .send()
            .await?
            .error_for_status()?
            .json::<T>()
            .await?)
    }

    async fn send_json(
        &self,
        method: Method,
        segments: &[&str],
        body: &Value,
    ) -> anyhow::Result<()> {
        self.request(method, segments)?
            .json(body)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn send_empty(&self, method: Method, segments: &[&str]) -> anyhow::Result<()> {
        self.request(method, segments)?
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn send_json_value(
        &self,
        method: Method,
        segments: &[&str],
        body: &Value,
    ) -> anyhow::Result<Value> {
        let bytes = self
            .request(method, segments)?
            .json(body)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        if bytes.is_empty() {
            Ok(Value::Null)
        } else {
            Ok(serde_json::from_slice(&bytes)?)
        }
    }

    async fn ensure_session_started(&self) -> anyhow::Result<()> {
        let session: OpenWaSession = self.get_json(&["sessions", &self.session_id]).await?;
        if !session.engine_loaded && matches!(session.status.as_str(), "created" | "disconnected") {
            self.send_empty(Method::POST, &["sessions", &self.session_id, "start"])
                .await?;
            info!(channel = PLATFORM, session = %self.session_id, "started OpenWA session");
        }
        Ok(())
    }

    async fn ensure_webhook(&self) -> anyhow::Result<()> {
        let hooks: Vec<OpenWaWebhook> = self
            .get_json(&["sessions", &self.session_id, "webhooks"])
            .await?;
        let body = json!({
            "url": self.webhook_url,
            "events": ["message.received", "session.status"],
            "secret": self.webhook_secret,
            "active": true,
            "retryCount": 3,
        });
        if let Some(hook) = hooks.iter().find(|hook| hook.url == self.webhook_url) {
            if !hook.active {
                info!(channel = PLATFORM, webhook = %hook.id, "reactivating OpenWA webhook");
            }
            self.send_json(
                Method::PUT,
                &["sessions", &self.session_id, "webhooks", &hook.id],
                &body,
            )
            .await
        } else {
            self.send_json(
                Method::POST,
                &["sessions", &self.session_id, "webhooks"],
                &body,
            )
            .await
        }
    }

    async fn access_allows(&self, message: &InboundMessage) -> bool {
        if message.is_group {
            return matches!(
                self.runtime
                    .cfg
                    .access
                    .decide_group_for_sender(message.access_chat(), message.sender_id.as_deref(),),
                Decision::Allow
            );
        }
        matches!(
            self.runtime
                .cfg
                .access
                .decide_dm(&self.runtime.pairing, PLATFORM, message.identity())
                .await,
            Decision::Allow
        )
    }

    async fn fetch_media(
        &self,
        chat_id: &str,
        attachments: &[Attachment],
    ) -> Vec<(usize, Vec<u8>)> {
        let mut out = Vec::new();
        for (index, attachment) in attachments.iter().enumerate() {
            if !attachment.resolved_kind().is_speech() {
                continue;
            }
            let Some(message_id) = attachment.file_id.as_deref() else {
                continue;
            };
            let result = if let Some(direct_url) = attachment.url.as_deref() {
                media::download(
                    &self.runtime.http,
                    direct_url,
                    &[("X-API-Key", self.api_key.as_str())],
                )
                .await
            } else {
                let path = [
                    "sessions",
                    &self.session_id,
                    "messages",
                    chat_id,
                    message_id,
                    "media",
                ];
                let Ok(url) = self.api_url(&path) else {
                    continue;
                };
                media::download(
                    &self.runtime.http,
                    url.as_str(),
                    &[("X-API-Key", self.api_key.as_str())],
                )
                .await
            };
            match result {
                Ok(bytes) => out.push((index, bytes)),
                Err(err) => {
                    warn!(channel = PLATFORM, message_id, %err, "failed to download OpenWA media")
                }
            }
        }
        out
    }
}

#[derive(Clone)]
struct WebhookState {
    channel: Arc<OpenWaChannel>,
    host: Arc<dyn ChannelHost>,
}

#[async_trait]
impl Channel for OpenWaChannel {
    fn name(&self) -> &'static str {
        PLATFORM
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            typing: true,
            rich_text: false,
            streaming: false,
            threads: false,
            command_menu: false,
            voice: true,
            attachments: true,
            reactions: true,
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
            self.send_json_value(
                Method::POST,
                &["sessions", &self.session_id, "messages", "send-text"],
                &json!({ "chatId": chat_id, "text": part, "linkPreview": false }),
            )
            .await?;
        }
        Ok(())
    }

    async fn send_typing(&self, chat_id: &str) -> anyhow::Result<()> {
        self.send_json(
            Method::POST,
            &["sessions", &self.session_id, "chats", "typing"],
            &json!({ "chatId": chat_id, "state": "typing" }),
        )
        .await
    }

    async fn mark_read(&self, chat_id: &str, _message_id: &str) -> anyhow::Result<()> {
        if !self.runtime.cfg.send_read_receipts {
            return Ok(());
        }
        self.send_json(
            Method::POST,
            &["sessions", &self.session_id, "chats", "read"],
            &json!({ "chatId": chat_id }),
        )
        .await
    }

    async fn react(&self, chat_id: &str, message_id: &str, emoji: &str) -> anyhow::Result<()> {
        self.send_json(
            Method::POST,
            &["sessions", &self.session_id, "messages", "react"],
            &json!({ "chatId": chat_id, "messageId": message_id, "emoji": emoji }),
        )
        .await
    }

    async fn send_voice(
        &self,
        chat_id: &str,
        wav: Vec<u8>,
        _delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        // OpenWA's documented ptt path requires OGG/Opus. Its optional media
        // conversion endpoint is the safe bridge from Core's WAV output.
        let converted = self
            .send_json_value(
                Method::POST,
                &["sessions", &self.session_id, "media", "convert", "voice"],
                &json!({ "base64": STANDARD.encode(wav) }),
            )
            .await
            .map_err(|err| {
                anyhow::anyhow!(
                    "OpenWA voice conversion failed; enable MEDIA_CONVERSION_ENABLED: {err}"
                )
            })?;
        let Some(base64) = converted["base64"].as_str() else {
            anyhow::bail!("OpenWA voice conversion returned no base64 payload");
        };
        let mimetype = converted["mimetype"]
            .as_str()
            .unwrap_or("audio/ogg; codecs=opus");
        self.send_json_value(
            Method::POST,
            &["sessions", &self.session_id, "messages", "send-audio"],
            &json!({
                "chatId": chat_id,
                "base64": base64,
                "mimetype": mimetype,
                "ptt": true,
            }),
        )
        .await?;
        Ok(())
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        if let Some(reporter) = &self.runtime.status {
            reporter.connecting().await;
        }
        if let Err(err) = self.ensure_session_started().await {
            if let Some(reporter) = &self.runtime.status {
                reporter
                    .error(&format!("OpenWA session setup failed: {err}"))
                    .await;
            }
            return Err(err);
        }
        if let Err(err) = self.ensure_webhook().await {
            if let Some(reporter) = &self.runtime.status {
                reporter
                    .error(&format!("OpenWA webhook setup failed: {err}"))
                    .await;
            }
            return Err(err);
        }

        let commands = self.runtime.refresh_commands().await;
        debug!(
            channel = PLATFORM,
            count = commands.len(),
            "loaded command list for WhatsApp Personal"
        );

        let addr: SocketAddr = self.webhook_bind.parse().map_err(|err| {
            anyhow::anyhow!(
                "invalid whatsapp personal webhook_bind {}: {err}",
                self.webhook_bind
            )
        })?;
        let app = Router::new()
            .route(&self.webhook_path, post(receive_webhook))
            .with_state(WebhookState {
                channel: Arc::clone(&self),
                host,
            });
        let listener = tokio::net::TcpListener::bind(addr).await?;
        info!(addr = %addr, path = %self.webhook_path, session = %self.session_id, "whatsapp personal webhook receiver listening");
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

async fn receive_webhook(
    State(state): State<WebhookState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let signature = headers
        .get("x-openwa-signature")
        .and_then(|value| value.to_str().ok());
    if !verify_signature(&state.channel.webhook_secret, signature, &body) {
        warn!(
            channel = PLATFORM,
            "OpenWA webhook rejected: invalid signature"
        );
        return StatusCode::FORBIDDEN;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    if payload["sessionId"].as_str() != Some(state.channel.session_id.as_str()) {
        return StatusCode::FORBIDDEN;
    }
    if payload["event"].as_str() != Some("message.received") {
        return StatusCode::OK;
    }

    let webhook_delivery_id = headers
        .get("x-openwa-idempotency-key")
        .and_then(|value| value.to_str().ok())
        .or_else(|| payload["idempotencyKey"].as_str())
        .or_else(|| payload["deliveryId"].as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    for (index, inbound) in parse_inbound(&payload["data"], state.channel.self_chat_only)
        .into_iter()
        .enumerate()
    {
        let provider_id = inbound_delivery_id(&inbound, webhook_delivery_id, &body, index);
        let (delivery_id, claim) = match claim_inbound_delivery(&*state.channel, &provider_id).await
        {
            Ok(result) => result,
            Err(error) => {
                warn!(%error, "OpenWA webhook delivery could not be durably claimed");
                return StatusCode::SERVICE_UNAVAILABLE;
            }
        };
        if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
            debug!(
                delivery_id = %delivery_id,
                ?claim,
                "duplicate OpenWA webhook delivery suppressed"
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
                warn!(%error, "OpenWA webhook capacity failure could not be persisted");
            }
            warn!("OpenWA webhook capacity is exhausted; asking OpenWA to retry");
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

async fn dispatch(
    channel: Arc<OpenWaChannel>,
    host: Arc<dyn ChannelHost>,
    message: InboundMessage,
    delivery_id: &str,
) -> ChannelTurnOutcome {
    if is_help_request(&message.text) && channel.access_allows(&message).await {
        let help = format_command_help(&channel.runtime.commands().await);
        return match channel.send_message(&message.chat_id, &help).await {
            Ok(()) => ChannelTurnOutcome::Completed,
            Err(err) => {
                warn!(channel = PLATFORM, %err, "failed to deliver WhatsApp Personal command list");
                ChannelTurnOutcome::Failed
            }
        };
    }
    handle_turn_with_delivery(channel, host, message, Some(delivery_id)).await
}

async fn prepare_message(channel: &OpenWaChannel, message: &mut InboundMessage) {
    if !message.attachments.is_empty()
        && channel
            .runtime
            .already_admitted(channel.name(), message)
            .await
    {
        let downloaded = channel
            .fetch_media(&message.chat_id, &message.attachments)
            .await;
        channel.runtime.ingest_media(message, downloaded).await;
    }
}

fn inbound_delivery_id(
    message: &InboundMessage,
    webhook_delivery_id: Option<&str>,
    body: &[u8],
    index: usize,
) -> String {
    if let Some(message_id) = message
        .message_id
        .as_deref()
        .filter(|message_id| !message_id.trim().is_empty())
    {
        return format!("message:{message_id}");
    }
    if let Some(webhook_delivery_id) = webhook_delivery_id {
        return format!("delivery:{webhook_delivery_id}:{index}");
    }
    format!("payload:{}:{index}", hex::encode(Sha256::digest(body)))
}

fn parse_inbound(data: &Value, self_chat_only: bool) -> Vec<InboundMessage> {
    let Some(chat_id) = data
        .get("chatId")
        .or_else(|| data.get("from"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    else {
        return Vec::new();
    };
    let kind = data["kind"].as_str().unwrap_or_default();
    if matches!(kind, "status" | "broadcast") {
        return Vec::new();
    }
    let is_group =
        data["isGroup"].as_bool().unwrap_or(false) || kind == "group" || chat_id.ends_with("@g.us");
    if self_chat_only && (is_group || !data["fromMe"].as_bool().unwrap_or(false)) {
        return Vec::new();
    }
    let text = message_text(data);
    let attachments = attachment_from(data).into_iter().collect::<Vec<_>>();
    if text.trim().is_empty() && attachments.is_empty() {
        return Vec::new();
    }
    let sender_id = if is_group {
        data["author"]
            .as_str()
            .or_else(|| data["senderPhone"].as_str())
            .or_else(|| data["from"].as_str())
    } else {
        data["senderPhone"]
            .as_str()
            .or_else(|| data["from"].as_str())
    };
    vec![InboundMessage {
        chat_id: chat_id.to_string(),
        access_chat_id: None,
        text,
        author_name: author_name(data),
        sender_id: sender_id.map(str::to_string),
        message_id: data["id"].as_str().map(str::to_string),
        is_group,
        attachments,
        channel_action: None,
    }]
}

fn author_name(data: &Value) -> Option<String> {
    data["contact"]["name"]
        .as_str()
        .or_else(|| data["contact"]["pushName"].as_str())
        .or_else(|| data["senderName"].as_str())
        .or_else(|| data["pushName"].as_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
}

fn message_text(data: &Value) -> String {
    let mut text = data["body"]
        .as_str()
        .or_else(|| data["caption"].as_str())
        .unwrap_or_default()
        .to_string();
    if text.is_empty() {
        if let Some(quoted) = data["quotedMessage"]["body"].as_str() {
            text = format!("[replying to: {quoted}]");
        }
    }
    match data["type"].as_str().unwrap_or_default() {
        "location" => {
            let latitude = data["location"]["latitude"]
                .as_f64()
                .map(|value| value.to_string())
                .unwrap_or_else(|| data["latitude"].to_string());
            let longitude = data["location"]["longitude"]
                .as_f64()
                .map(|value| value.to_string())
                .unwrap_or_else(|| data["longitude"].to_string());
            let description = data["location"]["description"]
                .as_str()
                .or_else(|| data["location"]["address"].as_str())
                .unwrap_or_default();
            text = format!("[location: {latitude}, {longitude}{description}]");
        }
        "poll" => {
            let name = data["poll"]["name"]
                .as_str()
                .or_else(|| data["pollName"].as_str())
                .unwrap_or("Poll");
            text = format!("[poll: {name}]");
        }
        "contact" if text.is_empty() => text = "[contact card]".to_string(),
        _ => {}
    }
    text
}

fn attachment_from(data: &Value) -> Option<Attachment> {
    let kind_name = data["type"].as_str()?;
    let kind = match kind_name {
        "audio" => {
            if data["voice"].as_bool().unwrap_or(false)
                || data["media"]["voice"].as_bool().unwrap_or(false)
                || kind_name == "voice"
            {
                AttachmentKind::Voice
            } else {
                AttachmentKind::Audio
            }
        }
        "voice" => AttachmentKind::Voice,
        "image" | "sticker" => AttachmentKind::Image,
        "video" => AttachmentKind::Video,
        "document" => AttachmentKind::Document,
        _ => return None,
    };
    let media = data.get("media").filter(|value| value.is_object());
    let has_media = data["hasMedia"].as_bool().unwrap_or(false) || media.is_some();
    if !has_media {
        return None;
    }
    let media = media.unwrap_or(data);
    Some(Attachment {
        kind: Some(kind),
        url: media["url"].as_str().map(str::to_string),
        // OpenWA's webhook payload may omit large inline bytes. The message id
        // resolves through its authenticated media archive endpoint instead.
        file_id: data["id"].as_str().map(str::to_string),
        mime: media["mimetype"]
            .as_str()
            .or_else(|| media["mimeType"].as_str())
            .map(str::to_string),
        filename: media["filename"].as_str().map(str::to_string),
        size: media["sizeBytes"].as_u64(),
    })
}

fn verify_signature(secret: &str, signature: Option<&str>, body: &[u8]) -> bool {
    let Some(signature) = signature.and_then(|value| value.strip_prefix("sha256=")) else {
        return false;
    };
    let Ok(expected) = hex::decode(signature) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

fn is_help_request(text: &str) -> bool {
    match commands::parse_command(text) {
        Some((name, _)) => matches!(name.as_str(), "help" | "commands"),
        None => false,
    }
}

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

    fn sample_config() -> OpenWaChannelConfig {
        OpenWaChannelConfig {
            base_url: "http://localhost:2785".to_string(),
            api_key: "operator-key".to_string(),
            session_id: "personal-1".to_string(),
            webhook_url: "https://example.com/webhooks/whatsapp-personal".to_string(),
            webhook_secret: "webhook-secret".to_string(),
            webhook_bind: "127.0.0.1:8444".to_string(),
            webhook_path: "/webhooks/whatsapp-personal".to_string(),
            self_chat_only: false,
            common: CommonChannelConfig {
                model: "gpt-4o".to_string(),
                ..Default::default()
            },
        }
    }

    #[test]
    fn constructor_rejects_missing_openwa_credentials() {
        let mut config = sample_config();
        config.api_key.clear();
        assert!(
            OpenWaChannel::new(config, reqwest::Client::new(), PairingStore::ephemeral()).is_err()
        );
    }

    #[test]
    fn verifies_openwa_signature() {
        let body = br#"{"event":"message.received"}"#;
        let mut mac = Hmac::<Sha256>::new_from_slice(b"webhook-secret").unwrap();
        mac.update(body);
        let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
        assert!(verify_signature("webhook-secret", Some(&signature), body));
        assert!(!verify_signature("wrong", Some(&signature), body));
        assert!(!verify_signature("webhook-secret", None, body));
    }

    #[test]
    fn parses_text_group_media_and_contact_identity() {
        let parsed = parse_inbound(
            &json!({
                "id": "msg-1",
                "from": "120363@g.us",
                "author": "1555@c.us",
                "isGroup": true,
                "kind": "group",
                "body": "hello",
                "type": "audio",
                "voice": true,
                "media": { "mimetype": "audio/ogg", "filename": "note.ogg" },
                "contact": { "name": "Ada" }
            }),
            false,
        );
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].chat_id, "120363@g.us");
        assert_eq!(parsed[0].sender_id.as_deref(), Some("1555@c.us"));
        assert!(parsed[0].is_group);
        assert_eq!(parsed[0].author_name.as_deref(), Some("Ada"));
        assert_eq!(
            parsed[0].attachments[0].resolved_kind(),
            AttachmentKind::Voice
        );
        assert_eq!(parsed[0].attachments[0].file_id.as_deref(), Some("msg-1"));
    }

    #[test]
    fn ignores_media_types_without_media_bytes() {
        let parsed = parse_inbound(
            &json!({
                "id": "msg-2",
                "from": "1555@c.us",
                "body": "",
                "type": "audio",
                "hasMedia": false
            }),
            false,
        );
        assert!(parsed.is_empty());
    }

    #[test]
    fn self_chat_mode_ignores_other_senders_and_groups() {
        let other = json!({
            "id": "msg-1", "from": "1555@c.us", "body": "hello", "type": "text", "fromMe": false
        });
        let group = json!({
            "id": "msg-2", "from": "120363@g.us", "body": "hello", "type": "text", "isGroup": true, "fromMe": true
        });
        assert!(parse_inbound(&other, true).is_empty());
        assert!(parse_inbound(&group, true).is_empty());
    }

    #[test]
    fn inbound_delivery_id_prefers_the_provider_message_id() {
        let message = InboundMessage {
            message_id: Some("msg-1".to_string()),
            ..InboundMessage::default()
        };
        assert_eq!(
            inbound_delivery_id(&message, Some("delivery-1"), b"body", 0),
            "message:msg-1"
        );

        let anonymous = InboundMessage::default();
        assert_eq!(
            inbound_delivery_id(&anonymous, Some("delivery-1"), b"body", 2),
            "delivery:delivery-1:2"
        );
        assert!(inbound_delivery_id(&anonymous, None, b"body", 0).starts_with("payload:"));
    }

    #[test]
    fn personal_channel_exposes_voice_and_whatsapp_verbs() {
        let channel = OpenWaChannel::new(
            sample_config(),
            reqwest::Client::new(),
            PairingStore::ephemeral(),
        )
        .unwrap();
        let caps = channel.caps();
        assert!(caps.typing && caps.attachments && caps.reactions && caps.voice);
        assert!(!caps.rich_text && !caps.streaming && !caps.threads);
        assert_eq!(channel.name(), "whatsapp_personal");
    }
}
