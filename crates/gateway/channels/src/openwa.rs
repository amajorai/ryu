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

use crate::commands;
use crate::i18n;
use crate::media::{self, Attachment, AttachmentKind, VoiceDelivery};
use crate::pairing::{Decision, PairingStore};
use crate::status::StatusReporter;
use crate::whatsapp_format;
use crate::{
    claim_inbound_delivery, handle_turn_with_delivery, run_claimed_delivery_with_permit,
    try_reserve_delivery, Channel, ChannelCaps, ChannelHost, ChannelRuntime, ChannelTurnOutcome,
    InboundMessage, OpenWaChannelConfig,
};

mod channel;
mod inbound;

use channel::*;
use inbound::*;

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

#[cfg(test)]
mod tests;
