//! WhatsApp Business channel adapter (Meta Cloud API).
//!
//! Unlike Telegram/Discord, the WhatsApp Cloud API has no polling endpoint:
//! inbound messages arrive as webhook callbacks. This adapter's
//! [`run`](Channel::run) loop therefore binds a small HTTP receiver that handles
//! Meta's two webhook flows:
//!
//! - `GET`  the subscription verification handshake (`hub.challenge`).
//! - `POST` inbound message deliveries, parsed and handed to
//!   [`handle_message`](super::handle_message) (legacy) or the Core session
//!   seam (`POST <core_url>/api/channels/run`) when `agent_id` is set.
//!
//! Replies go back out via the Graph API `POST /{phone_number_id}/messages`.
//! In production, front [`WhatsAppChannelConfig::webhook_bind`] with a public
//! HTTPS reverse proxy — Meta requires HTTPS for webhook delivery.
//!
//! ## Core session seam (M11 / #228)
//!
//! When [`WhatsAppChannelConfig::agent_id`] is set the inbound handler uses
//! `conversation_id = sender_phone_number` so every sender has their own
//! persistent conversation in `conversations.db`. Model calls still flow
//! Core → Gateway — the moat remains on path.

use std::net::SocketAddr;
use std::sync::Arc;

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
use sha2::Sha256;
use tracing::{debug, info, warn};

use crate::{config::WhatsAppChannelConfig, state::SharedState};

use super::{handle_message, status::StatusReporter, Channel, InboundMessage};

/// Meta Graph API host. The version segment is appended per request.
const GRAPH_HOST: &str = "https://graph.facebook.com";

pub struct WhatsAppChannel {
    model: String,
    system_prompt: Option<String>,
    http: reqwest::Client,
    access_token: String,
    phone_number_id: String,
    verify_token: String,
    app_secret: String,
    webhook_bind: String,
    webhook_path: String,
    graph_version: String,
    /// When set, inbound messages route through Core's `/api/channels/run`
    /// endpoint using this agent id so conversation history is persisted in
    /// the Core session store. `None` falls back to the legacy gateway-pipeline
    /// path.
    agent_id: Option<String>,
    /// When set, inbound messages route to this Core team (a lead agent
    /// orchestrating its members) instead of a single agent. Takes precedence
    /// over `agent_id`; also uses Core's `/api/channels/run` seam.
    team_id: Option<String>,
    /// Base URL of the Core sidecar. Used when `agent_id` or `team_id` is set.
    core_url: String,
    /// Reports this bot's live connection status to the control plane. `None`
    /// for env-configured bots (no store id), which then show as `unknown`.
    status: Option<StatusReporter>,
}

impl WhatsAppChannel {
    pub fn new(cfg: WhatsAppChannelConfig, http: reqwest::Client) -> anyhow::Result<Self> {
        Self::new_with_status(cfg, http, None)
    }

    /// Like [`Self::new`] but attaches a liveness reporter so the bot heartbeats
    /// its connection status back to the control plane.
    pub fn new_with_status(
        cfg: WhatsAppChannelConfig,
        http: reqwest::Client,
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
            model: cfg.model,
            system_prompt: cfg.system_prompt,
            http,
            access_token: cfg.access_token,
            phone_number_id: cfg.phone_number_id,
            verify_token: cfg.verify_token,
            app_secret: cfg.app_secret,
            webhook_bind: cfg.webhook_bind,
            webhook_path: cfg.webhook_path,
            graph_version: cfg.graph_version,
            agent_id: cfg.agent_id,
            team_id: cfg.team_id,
            core_url: cfg.core_url,
            status,
        })
    }

    /// True when this bot routes through Core's session seam (a single agent or
    /// a team) rather than the legacy gateway-pipeline path.
    fn routes_via_core(&self) -> bool {
        self.agent_id.is_some() || self.team_id.is_some()
    }

    fn messages_url(&self) -> String {
        format!(
            "{GRAPH_HOST}/{}/{}/messages",
            self.graph_version, self.phone_number_id
        )
    }

    /// Route an inbound message through Core's session seam and return the reply.
    ///
    /// Calls `POST <core_url>/api/channels/run` with `conversation_id` set to
    /// the sender's phone number so multi-turn exchanges share conversation
    /// history. Model calls still flow Core → Gateway — the moat remains on path.
    ///
    /// # Errors
    /// Returns `Err` on HTTP transport failure or when Core returns a non-2xx
    /// status.
    async fn run_via_core(&self, chat_id: &str, text: &str) -> anyhow::Result<String> {
        let url = format!("{}/api/channels/run", self.core_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "conversation_id": chat_id,
                "agent_id": self.agent_id,
                "team_id": self.team_id,
                "text": text,
            }))
            .send()
            .await?
            .error_for_status()?;
        let body: serde_json::Value = resp.json().await?;
        let reply = body["reply"].as_str().unwrap_or("").to_owned();
        Ok(reply)
    }
}

/// State shared into the webhook axum handlers.
#[derive(Clone)]
struct WebhookState {
    channel: Arc<WhatsAppChannel>,
    gateway: SharedState,
}

#[async_trait]
impl Channel for WhatsAppChannel {
    fn name(&self) -> &'static str {
        "whatsapp"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn system_prompt(&self) -> Option<&str> {
        self.system_prompt.as_deref()
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        self.http
            .post(self.messages_url())
            .bearer_auth(&self.access_token)
            .json(&json!({
                "messaging_product": "whatsapp",
                "to": chat_id,
                "type": "text",
                "text": { "body": text },
            }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn run(self: Arc<Self>, state: SharedState) -> anyhow::Result<()> {
        if let Some(reporter) = &self.status {
            reporter.connecting().await;
        }
        let addr: SocketAddr = self.webhook_bind.parse().map_err(|e| {
            if let Some(reporter) = &self.status {
                let reporter = reporter.clone();
                let detail = format!("invalid webhook_bind {}", self.webhook_bind);
                tokio::spawn(async move { reporter.error(&detail).await });
            }
            anyhow::anyhow!("invalid whatsapp webhook_bind {}: {e}", self.webhook_bind)
        })?;
        let path = self.webhook_path.clone();

        let webhook_state = WebhookState {
            channel: Arc::clone(&self),
            gateway: state,
        };

        let app = Router::new()
            .route(&path, get(verify_webhook).post(receive_webhook))
            .with_state(webhook_state);

        let listener = tokio::net::TcpListener::bind(addr).await?;
        info!(addr = %addr, path = %path, "whatsapp webhook receiver listening");
        // The webhook receiver has no inbound poll cadence — it blocks in `serve`
        // — so a background ticker re-asserts `online` while it's listening. It's
        // aborted when `serve` returns so a stopped bot goes stale (→ offline).
        let heartbeat = self.status.clone().map(StatusReporter::spawn_heartbeat);
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

/// Inbound message delivery. Always returns 200 quickly so Meta does not retry;
/// each message is dispatched onto its own task through the gateway pipeline.
///
/// Every POST must carry a valid `X-Hub-Signature-256` HMAC of the raw body
/// keyed by the Meta App Secret; otherwise the payload is spoofable. We take the
/// raw `Bytes` (not `Json`) so the signature is computed over the exact bytes
/// Meta signed, reject on any mismatch, and only then parse the JSON.
async fn receive_webhook(
    State(state): State<WebhookState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
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

    for inbound in parse_inbound(&payload) {
        let channel = Arc::clone(&state.channel);
        let gateway = Arc::clone(&state.gateway);
        tokio::spawn(async move {
            if channel.routes_via_core() {
                // M11 / #228: route through Core session seam so conversation
                // history is persisted and model calls flow Core → Gateway
                // (moat stays on path). conversation_id = sender phone number.
                // Target is a single agent or a team (Core picks).
                info!(
                    chat_id = %inbound.chat_id,
                    agent_id = ?channel.agent_id,
                    team_id = ?channel.team_id,
                    "whatsapp: routing via Core session seam"
                );
                let reply = match channel
                    .run_via_core(&inbound.chat_id, &inbound.text)
                    .await
                {
                    Ok(r) if !r.is_empty() => r,
                    Ok(_) => "(no response)".to_string(),
                    Err(err) => {
                        warn!(
                            chat_id = %inbound.chat_id,
                            error = %err,
                            "whatsapp: Core session run failed"
                        );
                        format!("Sorry, something went wrong: {err}")
                    }
                };
                if let Err(err) = channel.send_message(&inbound.chat_id, &reply).await {
                    warn!(
                        chat_id = %inbound.chat_id,
                        error = %err,
                        "whatsapp: failed to deliver reply"
                    );
                }
            } else {
                // Legacy path: handle_message → gateway pipeline.
                handle_message(channel.as_ref(), gateway, inbound).await;
            }
        });
    }
    StatusCode::OK
}

/// Verify Meta's `X-Hub-Signature-256` header against `hmac_sha256(app_secret,
/// raw_body)`. The header is formatted `sha256=<hex>`. Verification is
/// constant-time (via `Mac::verify_slice`), and a missing/malformed header or
/// non-hex digest fails closed.
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

/// Extract user text messages from a WhatsApp Cloud API webhook payload.
///
/// Pure and synchronous so it can be unit-tested without a running gateway. The
/// payload nests messages under `entry[].changes[].value.messages[]`; status
/// callbacks (delivery receipts) carry no `messages` array and are ignored.
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
                // Only handle plain text messages for now.
                let Some(text) = message["text"]["body"].as_str() else {
                    continue;
                };
                let Some(from) = message["from"].as_str() else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                out.push(InboundMessage {
                    chat_id: from.to_string(),
                    text: text.to_string(),
                });
            }
        }
    }
    debug!(count = out.len(), "parsed whatsapp inbound messages");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> WhatsAppChannelConfig {
        WhatsAppChannelConfig {
            access_token: "token".to_string(),
            phone_number_id: "12345".to_string(),
            verify_token: "verifyme".to_string(),
            app_secret: "shhh".to_string(),
            webhook_bind: "0.0.0.0:8443".to_string(),
            webhook_path: "/webhooks/whatsapp".to_string(),
            graph_version: "v21.0".to_string(),
            model: "gpt-4o".to_string(),
            system_prompt: None,
            agent_id: None,
            team_id: None,
            core_url: "http://127.0.0.1:7980".to_string(),
        }
    }

    #[test]
    fn new_rejects_empty_app_secret() {
        let mut cfg = sample_config();
        cfg.app_secret = "   ".to_string();
        assert!(WhatsAppChannel::new(cfg, reqwest::Client::new()).is_err());
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

    #[test]
    fn new_rejects_empty_access_token() {
        let mut cfg = sample_config();
        cfg.access_token = "   ".to_string();
        assert!(WhatsAppChannel::new(cfg, reqwest::Client::new()).is_err());
    }

    #[test]
    fn builds_messages_url() {
        let channel = WhatsAppChannel::new(sample_config(), reqwest::Client::new()).unwrap();
        assert_eq!(
            channel.messages_url(),
            "https://graph.facebook.com/v21.0/12345/messages"
        );
        assert_eq!(channel.name(), "whatsapp");
        assert_eq!(channel.model(), "gpt-4o");
    }

    #[test]
    fn parse_inbound_reads_text_message() {
        let payload = json!({
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "messages": [
                                    {
                                        "from": "15551234567",
                                        "type": "text",
                                        "text": { "body": "hello there" }
                                    }
                                ]
                            }
                        }
                    ]
                }
            ]
        });
        let parsed = parse_inbound(&payload);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].chat_id, "15551234567");
        assert_eq!(parsed[0].text, "hello there");
    }

    #[test]
    fn parse_inbound_ignores_status_callbacks() {
        let payload = json!({
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "statuses": [ { "status": "delivered" } ]
                            }
                        }
                    ]
                }
            ]
        });
        assert!(parse_inbound(&payload).is_empty());
    }

    #[test]
    fn parse_inbound_skips_non_text_messages() {
        let payload = json!({
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "messages": [
                                    { "from": "1555", "type": "image", "image": {} }
                                ]
                            }
                        }
                    ]
                }
            ]
        });
        assert!(parse_inbound(&payload).is_empty());
    }

    #[test]
    fn new_stores_agent_id_and_core_url() {
        let mut cfg = sample_config();
        cfg.agent_id = Some("acp:pi".to_string());
        cfg.core_url = "http://127.0.0.1:7980".to_string();
        let channel = WhatsAppChannel::new(cfg, reqwest::Client::new()).unwrap();
        assert_eq!(channel.agent_id.as_deref(), Some("acp:pi"));
        assert_eq!(channel.core_url, "http://127.0.0.1:7980");
    }

    #[test]
    fn new_defaults_no_agent_id() {
        let channel = WhatsAppChannel::new(sample_config(), reqwest::Client::new()).unwrap();
        assert!(channel.agent_id.is_none());
        assert_eq!(channel.core_url, "http://127.0.0.1:7980");
    }

    #[test]
    fn verify_webhook_rejects_bad_verify_token() {
        // confirm constant_time_eq rejects a mismatched token
        assert!(!constant_time_eq(b"correct", b"wrongtoken"));
        assert!(!constant_time_eq(b"correct", b"correc"));
        assert!(constant_time_eq(b"correct", b"correct"));
    }
}
