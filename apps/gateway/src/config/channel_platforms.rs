//! Discord, WhatsApp and BlueBubbles channel configs.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DiscordChannelConfig {
    /// Bot token issued in the Discord developer portal (without the `Bot ` prefix).
    pub token: String,
    /// Optional legacy channel IDs the bot watches for inbound messages. An
    /// empty list keeps Discord DMs working; platform options can further scope
    /// guild channels.
    #[serde(default)]
    pub channel_ids: Vec<String>,
    /// Answer inside a thread opened on the triggering message instead of in the
    /// channel itself, which keeps a busy channel readable. Off by default so an
    /// existing deployment's replies stay where its users expect them.
    #[serde(default)]
    pub thread_replies: bool,
    #[serde(default)]
    pub history_backfill: bool,
    #[serde(default)]
    pub free_response_channels: Vec<String>,
    #[serde(default)]
    pub allowed_channels: Vec<String>,
    #[serde(default)]
    pub allowed_roles: Vec<String>,
    #[serde(default)]
    pub thread_require_mention: bool,
    #[serde(default)]
    pub mention_patterns: Vec<String>,
    #[serde(default)]
    pub ignored_channels: Vec<String>,
    #[serde(default)]
    pub no_thread_channels: Vec<String>,
    #[serde(default)]
    pub allow_bots: bool,
    #[serde(default)]
    pub home_channel: Option<String>,
    /// Model, agent binding, access policy and presentation knobs. Flattened, so
    /// these keys sit directly under `[channels.discord]`.
    #[serde(flatten)]
    pub common: CommonChannelFileConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WhatsAppChannelConfig {
    /// Permanent or temporary access token for the Meta Graph API.
    pub access_token: String,
    /// Phone-number ID issued by Meta for the WhatsApp Business number.
    pub phone_number_id: String,
    /// Token used to verify Meta's webhook subscription handshake.
    pub verify_token: String,
    /// Meta App Secret, used to verify the `X-Hub-Signature-256` HMAC on every
    /// inbound webhook POST so spoofed messages are rejected. Required: the
    /// channel refuses to start if this is empty.
    #[serde(default)]
    pub app_secret: String,
    /// Local address the webhook receiver binds to. Meta delivers inbound
    /// messages here (front this with a public HTTPS reverse proxy in prod).
    #[serde(default = "default_whatsapp_bind")]
    pub webhook_bind: String,
    /// Path the webhook receiver listens on. Defaults to `/webhooks/whatsapp`.
    #[serde(default = "default_whatsapp_path")]
    pub webhook_path: String,
    /// Graph API version segment, e.g. `v21.0`.
    #[serde(default = "default_whatsapp_graph_version")]
    pub graph_version: String,
    /// Mark inbound messages read (blue ticks) when the bot picks them up. On by
    /// default: the bot is about to answer anyway, so withholding the receipt
    /// only makes it look unresponsive while it thinks.
    #[serde(default = "default_true")]
    pub send_read_receipts: bool,
    /// Model, agent binding, access policy and presentation knobs. Flattened, so
    /// these keys sit directly under `[channels.whatsapp]`.
    #[serde(flatten)]
    pub common: CommonChannelFileConfig,
}

pub(crate) fn default_whatsapp_bind() -> String {
    "0.0.0.0:8443".to_string()
}

pub(crate) fn default_whatsapp_path() -> String {
    "/webhooks/whatsapp".to_string()
}

pub(crate) fn default_whatsapp_graph_version() -> String {
    "v21.0".to_string()
}

/// Default listener for a channel-level WhatsApp Personal/OpenWA webhook.
/// Kept separate from the Cloud API port so both adapters can be enabled in one
/// gateway without an accidental bind collision.
pub(crate) fn default_whatsapp_personal_bind() -> String {
    "0.0.0.0:8444".to_string()
}

pub(crate) fn default_whatsapp_personal_path() -> String {
    "/webhooks/whatsapp-personal".to_string()
}

/// BlueBubbles (iMessage) channel config.
///
/// BlueBubbles is a bridge the operator runs on a Mac: it talks to Messages.app
/// locally and exposes an HTTP API plus an outbound webhook. So unlike the other
/// channels there is no vendor cloud in the middle — the "credentials" are the
/// bridge's own URL and password, and the gateway must be reachable *from* that
/// Mac for the webhook to land.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BlueBubblesChannelConfig {
    /// Base URL of the BlueBubbles Server, e.g. `http://192.168.1.10:1234`.
    pub server_url: String,
    /// The server password, sent as the `password` query parameter on every call.
    pub password: String,
    /// Local address the webhook receiver binds to. BlueBubbles POSTs new
    /// messages here.
    #[serde(default = "default_bluebubbles_bind")]
    pub webhook_bind: String,
    /// Path BlueBubbles is configured to POST to.
    #[serde(default = "default_bluebubbles_path")]
    pub webhook_path: String,
    /// Use the Private API helper for typing indicators, read receipts and
    /// tapbacks. Off by default because it requires the operator to have
    /// installed the helper on the Mac; enabling it without that just produces
    /// failing calls.
    #[serde(default)]
    pub private_api: bool,
    /// Mark chats read when the bot picks a message up. Requires `private_api`.
    #[serde(default)]
    pub send_read_receipts: bool,
    #[serde(default)]
    pub mention_patterns: Vec<String>,
    #[serde(default)]
    pub home_channel: Option<String>,
    /// Model, agent binding, access policy and presentation knobs. Flattened, so
    /// these keys sit directly under `[channels.bluebubbles]`.
    #[serde(flatten)]
    pub common: CommonChannelFileConfig,
}

pub(crate) fn default_bluebubbles_bind() -> String {
    "0.0.0.0:8446".to_string()
}

pub(crate) fn default_bluebubbles_path() -> String {
    "/webhooks/bluebubbles".to_string()
}

// ─── Phase-2 config structs ───────────────────────────────────────────────────
