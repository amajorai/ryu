//! Outbound send for self-host inboxes — reuses the Stage 2a SMTP sink.
//!
//! An inbox sends AS its own address. Gateway send governance (DLP/audit verdict)
//! is fail-open in v1: a blocked agent send is a lost action, so blocking is
//! opt-in and not wired here yet; the send always proceeds and is recorded.

use anyhow::{anyhow, Result};
use chrono::Utc;

use super::store::MailStore;
use super::EmailMessage;
use crate::email::{self, OutboundEmail};

/// A compose/send request against an inbox.
pub struct SendRequest {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub in_reply_to: Option<String>,
}

/// Send a message from an inbox and record the outbound row. Returns the stored
/// message (with its provider message id).
pub async fn send_from_inbox(
    store: &MailStore,
    inbox_id: &str,
    req: SendRequest,
) -> Result<EmailMessage> {
    let inbox = store
        .get_inbox(inbox_id)
        .await?
        .ok_or_else(|| anyhow!("inbox not found"))?;
    let cfg = email::resolve_transport()
        .ok_or_else(|| anyhow!("email transport not configured (set SMTP in Settings)"))?;

    let from = inbox.address.clone();
    let outbound = OutboundEmail {
        from: Some(from.clone()),
        to: req.to.clone(),
        cc: req.cc.clone(),
        subject: req.subject.clone(),
        text: req.text.clone(),
        html: req.html.clone(),
        in_reply_to: req.in_reply_to.clone(),
        ..Default::default()
    };
    let provider_message_id = email::send_email(&cfg, &outbound)
        .await
        .map_err(|e| anyhow!(e.to_string()))?;

    let msg = EmailMessage {
        id: uuid::Uuid::new_v4().to_string(),
        inbox_id: inbox_id.to_string(),
        direction: "outbound".to_string(),
        message_id: provider_message_id.clone(),
        in_reply_to: req.in_reply_to,
        from_addr: from,
        to_addrs: req.to,
        cc_addrs: req.cc,
        subject: req.subject,
        text: req.text,
        html: req.html,
        provider_message_id: Some(provider_message_id),
        attachments: Vec::new(),
        created_at: Utc::now().to_rfc3339(),
    };
    store.insert_message(msg, Vec::new()).await
}
