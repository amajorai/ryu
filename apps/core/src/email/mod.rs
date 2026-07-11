//! BYOK SMTP email sink for self-host.
//!
//! The Core-side delivery leg for self-host alerts (budget/firewall policy
//! alerts, monitor notifications) and, later, agent-inbox send. Delivery is
//! "what runs" (Core), not policy (Gateway): the Gateway decides an alert fires;
//! Core opens the socket and sends.
//!
//! Nothing hardcoded: the transport is a swappable BYO SMTP relay resolved from
//! preferences (desktop Settings) first, then environment for headless setups.
//! There is no default provider — with no relay configured the sink is a no-op
//! (`resolve_transport` returns `None`) and callers simply skip email.
//!
//! The public sink is a rich builder ([`OutboundEmail`]) — multi-recipient,
//! cc/bcc/reply-to, text+html multipart, threading headers, and attachments — so
//! the agent-inbox send path (which needs all of that to preserve mail-client
//! threading) and the one-line alert path ([`send_email_alert`]) share one
//! transport.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use lettre::message::header::ContentType;
use lettre::message::{Attachment as LettreAttachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::smtp_auth;

/// A wedged relay must not hang a monitor check or an inbox-send request forever
/// — `lettre` has no built-in timeout, so every send is bounded by this.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// Preferences key holding the non-secret transport JSON (host/port/username/
/// from/starttls). The password is stored separately via [`crate::smtp_auth`].
/// Core loads it on startup and on change so the desktop card takes effect with
/// no restart.
pub const SMTP_TRANSPORT_PREF_KEY: &str = "smtp-transport";

/// The non-secret transport fields persisted under [`SMTP_TRANSPORT_PREF_KEY`] and
/// exchanged with the desktop SMTP card. The password never appears here.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TransportPrefs {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub from: String,
    #[serde(default = "default_starttls")]
    pub starttls: bool,
}

fn default_port() -> u16 {
    587
}

fn default_starttls() -> bool {
    true
}

/// Apply a persisted [`TransportPrefs`] JSON value to the in-process cache. Called
/// at startup and whenever the pref changes. A malformed value clears the cache.
pub fn apply_transport_prefs_json(json: &str) {
    match serde_json::from_str::<TransportPrefs>(json) {
        Ok(t) => set_transport(&t.host, t.port, &t.username, &t.from, t.starttls),
        Err(_) => set_transport("", 0, "", "", true),
    }
}

/// Read the currently-cached non-secret transport prefs, if any (for `GET`).
pub fn current_transport_prefs() -> Option<TransportPrefs> {
    let guard = TRANSPORT.read().ok()?;
    let t = guard.as_ref()?;
    Some(TransportPrefs {
        host: t.host.clone(),
        port: t.port,
        username: t.username.clone(),
        from: t.from.clone(),
        starttls: t.starttls,
    })
}

/// Non-secret SMTP transport config. The password is resolved separately via
/// [`crate::smtp_auth`] so the secret surface stays isolated.
#[derive(Debug, Clone)]
pub struct EmailTransportConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// The `From` mailbox, e.g. `"Ryu <alerts@your-node.example>"`.
    pub from: String,
    /// STARTTLS on a submission port (587) vs implicit TLS (465).
    pub starttls: bool,
}

/// A file attached to an outbound email.
#[derive(Debug, Clone)]
pub struct Attachment {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// A fully-specified outbound email. Built once; the alert path wraps it.
#[derive(Debug, Clone, Default)]
pub struct OutboundEmail {
    /// Overrides the transport `from` when set (agent inboxes send as an inbox).
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub reply_to: Option<String>,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    /// RFC 5322 threading headers (agent-inbox replies).
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug)]
pub enum EmailError {
    /// No relay configured (no host or no password) — email is disabled.
    NotConfigured,
    /// A recipient/from address failed to parse.
    InvalidAddress(String),
    /// Building the MIME message failed.
    Build(String),
    /// Building the SMTP transport failed (bad host/TLS).
    Transport(String),
    /// The relay rejected the send.
    Send(String),
    /// The send exceeded [`SEND_TIMEOUT`].
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

/// In-process transport config cache, populated from preferences (the desktop
/// SMTP card writes it; a prefs handler calls [`set_transport`]). `None` falls
/// back to the `RYU_SMTP_*` environment for headless self-host.
static TRANSPORT: RwLock<Option<StoredTransport>> = RwLock::new(None);

/// The non-secret transport fields held in the cache (password comes from
/// [`crate::smtp_auth`] at resolve time, never cached here).
#[derive(Debug, Clone)]
struct StoredTransport {
    host: String,
    port: u16,
    username: String,
    from: String,
    starttls: bool,
}

/// Set (or clear, when `host` is empty) the in-process transport config from a
/// preferences value. The password is set separately via
/// [`crate::smtp_auth::set_password`].
pub fn set_transport(host: &str, port: u16, username: &str, from: &str, starttls: bool) {
    let host = host.trim();
    if let Ok(mut guard) = TRANSPORT.write() {
        *guard = if host.is_empty() {
            None
        } else {
            Some(StoredTransport {
                host: host.to_string(),
                port,
                username: username.trim().to_string(),
                from: from.trim().to_string(),
                starttls,
            })
        };
    }
}

/// Resolve the effective transport: cached prefs first, else `RYU_SMTP_*` env.
/// Returns `None` when no host or no password is available (email disabled).
pub fn resolve_transport() -> Option<EmailTransportConfig> {
    let password = smtp_auth::password()?;

    if let Ok(guard) = TRANSPORT.read() {
        if let Some(t) = guard.as_ref() {
            return Some(EmailTransportConfig {
                host: t.host.clone(),
                port: t.port,
                username: t.username.clone(),
                password,
                from: t.from.clone(),
                starttls: t.starttls,
            });
        }
    }

    // Headless self-host fallback: RYU_SMTP_HOST / _PORT / _USERNAME / _FROM /
    // _STARTTLS (password already resolved above).
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

/// Generate a deterministic-enough, collision-free Message-ID for threading.
fn generate_message_id(from: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    // Domain part from the `from` address if present, else a stable placeholder.
    let domain = from
        .rsplit_once('@')
        .map(|(_, d)| d.trim_end_matches('>').trim())
        .filter(|d| !d.is_empty())
        .unwrap_or("ryu.local");
    format!("<{nanos}.{seq}@{domain}>")
}

/// Assemble the MIME body (text / html / multipart) plus any attachments.
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

    // With attachments, wrap the body in a mixed multipart.
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

enum MultiPartOrSingle {
    Multi(MultiPart),
    Single(SinglePart),
}

/// Send a fully-specified email over the given BYO SMTP transport. Returns the
/// Message-ID on success (for threading / provider-id records). Bounded by
/// [`SEND_TIMEOUT`].
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

/// Thin single-recipient plain-text alert send over the given transport.
pub async fn send_email_alert(
    cfg: &EmailTransportConfig,
    to: &str,
    subject: &str,
    body: &str,
) -> Result<String, EmailError> {
    send_email(
        cfg,
        &OutboundEmail {
            to: vec![to.to_string()],
            subject: subject.to_string(),
            text: Some(body.to_string()),
            ..Default::default()
        },
    )
    .await
}
