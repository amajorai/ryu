//! Self-host Agent Inboxes (Stage 3).
//!
//! Receive + store + send agent email on the node itself, BYO domain, no AWS
//! SES. Managed inboxes (`packages/mail`, control-plane SES/S3) are untouched;
//! this is the Core-owned variant so a self-hosted node has inboxes too.
//!
//! Placement (AGENTS.md §1): receiving and storing mail is "what RUNS" — durable
//! MIME storage, attachment blobs, a public inbound endpoint — so it is Core, NOT
//! the gateway (a single-replica in-process policy kernel is not a store). The
//! gateway's only legitimate mail role is an outbound-send DLP/audit verdict.
//!
//! Single-tenant per node: there is no `org_id` scoping — any holder of the
//! node's `RYU_TOKEN` can read all inboxes. That is the node-local trust model,
//! stated explicitly, matching every other Core store.
//!
//! Inbound arrives as raw RFC822 POSTed to `/api/mail/inbound/:inbox_id` by the
//! user's mail provider (own domain → a forwarder that HMAC-signs the body). SEND
//! reuses the Stage 2a [`crate::email`] SMTP sink.

pub mod api;
pub mod mime;
pub mod send;
pub mod store;

use serde::{Deserialize, Serialize};

pub use store::MailStore;

/// How a self-host inbox receives mail.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InboxProvider {
    /// A mail provider (own domain) forwards raw MIME to the node webhook.
    Webhook,
    /// The node polls an IMAP mailbox (v1: reserved; not yet driven).
    Imap,
}

impl InboxProvider {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Webhook => "webhook",
            Self::Imap => "imap",
        }
    }
    fn from_str(s: &str) -> Self {
        match s {
            "imap" => Self::Imap,
            _ => Self::Webhook,
        }
    }
}

/// One self-host inbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Inbox {
    pub id: String,
    pub name: String,
    /// The address that receives mail (BYO domain, operator-supplied).
    pub address: String,
    pub provider: InboxProvider,
    /// HMAC secret the inbound forwarder signs the raw body with. Revealed to the
    /// operator so they can paste it into their forwarder; rotatable.
    pub inbound_secret: String,
    pub created_at: String,
}

/// A stored message (inbound or outbound).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailMessage {
    pub id: String,
    pub inbox_id: String,
    /// "inbound" | "outbound".
    pub direction: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    pub from_addr: String,
    pub to_addrs: Vec<String>,
    #[serde(default)]
    pub cc_addrs: Vec<String>,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    /// The SMTP/provider id for an outbound send (shared-contract alias for the
    /// managed `sesMessageId`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_message_id: Option<String>,
    pub attachments: Vec<AttachmentMeta>,
    pub created_at: String,
}

/// Attachment metadata (the bytes live on the filesystem, keyed by sha256).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentMeta {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: u64,
}
