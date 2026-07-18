//! Inlined BYOK SMTP sink (tracer copy of the bits of `apps/core/src/email/mod.rs`
//! + `apps/core/src/smtp_auth.rs` that `send.rs` uses).
//!
//! Behavior deviation vs Core (documented port-gap): the in-process transport
//! cache (`set_transport`/`TRANSPORT`) and the `smtp_auth` preferences path are
//! DROPPED. Out-of-process, the sidecar has no access to Core's desktop-Settings
//! prefs cache, so SMTP is resolved ENV-ONLY from `RYU_SMTP_*` / `RYU_SMTP_PASSWORD`.
//! Productionization follow-up: Core passes the resolved transport to the sidecar
//! (or this and `crate::email` are factored into a shared crate). The send path
//! itself (lettre wiring, MIME assembly, threading headers) is identical.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use lettre::message::header::ContentType;
use lettre::message::{Attachment as LettreAttachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

/// A wedged relay must not hang an inbox-send request forever.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// Non-secret SMTP transport config.
#[derive(Debug, Clone)]
pub struct EmailTransportConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub from: String,
    pub starttls: bool,
}

/// A file attached to an outbound email.
#[derive(Debug, Clone)]
pub struct Attachment {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// A fully-specified outbound email.
#[derive(Debug, Clone, Default)]
pub struct OutboundEmail {
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub reply_to: Option<String>,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug)]
pub enum EmailError {
    /// No relay configured — kept for parity with Core's enum (unused in the
    /// sidecar, where `resolve_transport` returns `None` before an error is built).
    #[allow(dead_code)]
    NotConfigured,
    InvalidAddress(String),
    Build(String),
    Transport(String),
    Send(String),
    Timeout,
}

impl std::fmt::Display for EmailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => write!(f, "email transport is not configured"),
            Self::InvalidAddress(a) => write!(f, "invalid email address: {a}"),
            Self::Build(e) => write!(f, "failed to build email: {e}"),
            Self::Transport(e) => write!(f, "failed to build SMTP transport: {e}"),
            Self::Send(e) => write!(f, "SMTP send failed: {e}"),
            Self::Timeout => write!(f, "SMTP send timed out"),
        }
    }
}

impl std::error::Error for EmailError {}

/// Resolve the SMTP password from `RYU_SMTP_PASSWORD` (env-only in the sidecar).
fn password() -> Option<String> {
    std::env::var("RYU_SMTP_PASSWORD")
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// Resolve the effective transport from `RYU_SMTP_*` env. Returns `None` when no
/// host or no password is available (email disabled) — identical to the headless
/// fallback branch of Core's `resolve_transport`.
pub fn resolve_transport() -> Option<EmailTransportConfig> {
    let password = password()?;

    let host = std::env::var("RYU_SMTP_HOST").ok()?;
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    let port = std::env::var("RYU_SMTP_PORT")
        .ok()
        .and_then(|p| p.trim().parse::<u16>().ok())
        .unwrap_or(587);
    let username = std::env::var("RYU_SMTP_USERNAME").unwrap_or_default();
    let from = std::env::var("RYU_SMTP_FROM").unwrap_or_else(|_| username.clone());
    let starttls = std::env::var("RYU_SMTP_STARTTLS")
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true);
    Some(EmailTransportConfig {
        host: host.to_string(),
        port,
        username: username.trim().to_string(),
        password,
        from: from.trim().to_string(),
        starttls,
    })
}

fn parse_mailbox(addr: &str) -> Result<Mailbox, EmailError> {
    addr.trim()
        .parse::<Mailbox>()
        .map_err(|e| EmailError::InvalidAddress(format!("{addr}: {e}")))
}

fn generate_message_id(from: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let domain = from
        .rsplit_once('@')
        .map(|(_, d)| d.trim_end_matches('>').trim())
        .filter(|d| !d.is_empty())
        .unwrap_or("ryu.local");
    format!("<{nanos}.{seq}@{domain}>")
}

enum MultiPartOrSingle {
    Multi(MultiPart),
    Single(SinglePart),
}

fn build_body(msg: &OutboundEmail) -> Result<MultiPartOrSingle, EmailError> {
    let content = match (msg.text.as_ref(), msg.html.as_ref()) {
        (Some(text), Some(html)) => {
            MultiPartOrSingle::Multi(MultiPart::alternative_plain_html(text.clone(), html.clone()))
        }
        (Some(text), None) => MultiPartOrSingle::Single(SinglePart::plain(text.clone())),
        (None, Some(html)) => MultiPartOrSingle::Single(SinglePart::html(html.clone())),
        (None, None) => MultiPartOrSingle::Single(SinglePart::plain(String::new())),
    };

    if msg.attachments.is_empty() {
        return Ok(content);
    }

    let mut mixed = MultiPart::mixed().multipart(match content {
        MultiPartOrSingle::Multi(m) => m,
        MultiPartOrSingle::Single(s) => MultiPart::mixed().singlepart(s),
    });
    for att in &msg.attachments {
        let ct = ContentType::parse(&att.content_type)
            .unwrap_or(ContentType::parse("application/octet-stream").unwrap());
        mixed = mixed.singlepart(
            LettreAttachment::new(att.filename.clone()).body(att.bytes.clone(), ct),
        );
    }
    Ok(MultiPartOrSingle::Multi(mixed))
}

/// Send a fully-specified email over the given BYO SMTP transport. Returns the
/// Message-ID on success. Bounded by [`SEND_TIMEOUT`].
pub async fn send_email(
    cfg: &EmailTransportConfig,
    msg: &OutboundEmail,
) -> Result<String, EmailError> {
    if msg.to.is_empty() {
        return Err(EmailError::InvalidAddress("no recipients".to_string()));
    }
    let from_addr = msg.from.as_deref().unwrap_or(cfg.from.as_str());
    let message_id = generate_message_id(from_addr);

    let mut builder = Message::builder()
        .from(parse_mailbox(from_addr)?)
        .subject(msg.subject.clone())
        .message_id(Some(message_id.clone()));

    for to in &msg.to {
        builder = builder.to(parse_mailbox(to)?);
    }
    for cc in &msg.cc {
        builder = builder.cc(parse_mailbox(cc)?);
    }
    for bcc in &msg.bcc {
        builder = builder.bcc(parse_mailbox(bcc)?);
    }
    if let Some(reply_to) = msg.reply_to.as_ref() {
        builder = builder.reply_to(parse_mailbox(reply_to)?);
    }
    if let Some(in_reply_to) = msg.in_reply_to.as_ref() {
        builder = builder.in_reply_to(in_reply_to.clone());
    }
    if let Some(references) = msg.references.as_ref() {
        builder = builder.references(references.clone());
    }

    let body = build_body(msg)?;
    let email = match body {
        MultiPartOrSingle::Multi(m) => builder.multipart(m),
        MultiPartOrSingle::Single(s) => builder.singlepart(s),
    }
    .map_err(|e| EmailError::Build(e.to_string()))?;

    let creds = Credentials::new(cfg.username.clone(), cfg.password.clone());
    let transport = if cfg.starttls {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)
    }
    .map_err(|e| EmailError::Transport(e.to_string()))?
    .port(cfg.port)
    .credentials(creds)
    .build();

    match tokio::time::timeout(SEND_TIMEOUT, transport.send(email)).await {
        Err(_) => Err(EmailError::Timeout),
        Ok(Err(e)) => Err(EmailError::Send(e.to_string())),
        Ok(Ok(_response)) => Ok(message_id),
    }
}
