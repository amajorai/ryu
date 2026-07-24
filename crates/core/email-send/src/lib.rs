//! BYOK SMTP email sink for self-host — an extracted Core capability crate.
//!
//! The delivery leg for self-host alerts (budget/firewall policy alerts, monitor
//! notifications) and, later, agent-inbox send. Delivery is "what runs" (Core),
//! not policy (Gateway): the Gateway decides an alert fires; the node opens the
//! socket and sends.
//!
//! Nothing hardcoded: the transport is a swappable BYO SMTP relay resolved from
//! preferences (desktop Settings) first, then environment for headless setups.
//! There is no default provider — with no relay configured the sink is a no-op
//! (`resolve_transport` returns `None`) and callers simply skip email. SMTP is one
//! swappable sink; the SES agent-inbox path (`packages/mail`) is another.
//!
//! The public sink is a rich builder ([`OutboundEmail`]) — multi-recipient,
//! cc/bcc/reply-to, text+html multipart, threading headers, and attachments — so
//! the agent-inbox send path (which needs all of that to preserve mail-client
//! threading) and the one-line alert path ([`send_email_alert`]) share one
//! transport.
//!
//! Secret custody stays kernel-side: the SMTP password is never held here. Core
//! injects a resolver via [`set_password_resolver`] (backed by its `smtp_auth`
//! BYO-key store), so this crate has ZERO dependency on `apps/core`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use lettre::message::header::ContentType;
use lettre::message::{Attachment as LettreAttachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

/// The injected SMTP-password resolver. The secret itself is custodied Core-side
/// (`smtp_auth`, prefs-first + `RYU_SMTP_PASSWORD` env fallback); this crate only
/// calls the hook at resolve time. `None` (unwired) means email is disabled — a
/// fail-safe no-op, never a plaintext leak.
type PasswordResolver = Box<dyn Fn() -> Option<String> + Send + Sync>;
static PASSWORD_RESOLVER: RwLock<Option<PasswordResolver>> = RwLock::new(None);

/// Wire the SMTP-password resolver. Core calls this once at startup with a closure
/// over its `smtp_auth` store. Idempotent replace.
pub fn set_password_resolver<F>(resolver: F)
where
    F: Fn() -> Option<String> + Send + Sync + 'static,
{
    if let Ok(mut guard) = PASSWORD_RESOLVER.write() {
        *guard = Some(Box::new(resolver));
    }
}

/// Resolve the active SMTP password through the injected hook (`None` when the
/// hook is unwired or the store has no password).
fn resolve_password() -> Option<String> {
    let guard = PASSWORD_RESOLVER.read().ok()?;
    let resolver = guard.as_ref()?;
    resolver()
}

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
    let password = resolve_password()?;

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
        (Some(text), Some(html)) => MultiPartOrSingle::Multi(MultiPart::alternative_plain_html(
            text.clone(),
            html.clone(),
        )),
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
        mixed = mixed
            .singlepart(LettreAttachment::new(att.filename.clone()).body(att.bytes.clone(), ct));
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

#[cfg(test)]
mod tests {
    //! Unit coverage for the pure/private message-construction seams and the
    //! `send_email` early-return validation paths. None of these tests touch the
    //! process-global `TRANSPORT` / `PASSWORD_RESOLVER` statics or environment, so
    //! they are parallel-safe. The env-fallback + transport-cache branches (which
    //! *do* mutate globals) live in the single serialized `tests/sink.rs` test.

    use super::*;

    fn body_bytes(msg: &OutboundEmail) -> Vec<u8> {
        match build_body(msg).expect("body builds") {
            MultiPartOrSingle::Multi(m) => m.formatted(),
            MultiPartOrSingle::Single(s) => s.formatted(),
        }
    }

    // --- generate_message_id: domain extraction + uniqueness -----------------

    #[test]
    fn message_id_extracts_domain_from_bare_address() {
        let id = generate_message_id("alerts@node.example");
        assert!(id.starts_with('<'), "wrapped: {id}");
        assert!(id.ends_with("@node.example>"), "domain from address: {id}");
    }

    #[test]
    fn message_id_extracts_domain_from_display_name_form() {
        // `Name <local@domain>` — the trailing `>` must be stripped.
        let id = generate_message_id("Ryu <alerts@node.example>");
        assert!(id.ends_with("@node.example>"), "stripped `>`: {id}");
    }

    #[test]
    fn message_id_falls_back_when_no_at_sign() {
        let id = generate_message_id("no-at-sign-here");
        assert!(id.ends_with("@ryu.local>"), "placeholder domain: {id}");
    }

    #[test]
    fn message_id_falls_back_on_empty_domain() {
        // `local@` — an empty domain part must not produce `@>`.
        let id = generate_message_id("local@");
        assert!(id.ends_with("@ryu.local>"), "empty domain → placeholder: {id}");
    }

    #[test]
    fn message_ids_are_unique_across_calls() {
        let a = generate_message_id("a@b.com");
        let b = generate_message_id("a@b.com");
        assert_ne!(a, b, "monotonic counter must differ consecutive ids");
    }

    // --- parse_mailbox: valid / display-name / trimming / invalid ------------

    #[test]
    fn parse_mailbox_accepts_bare_and_display_forms() {
        assert!(parse_mailbox("a@b.com").is_ok());
        assert!(parse_mailbox("Alice <a@b.com>").is_ok());
    }

    #[test]
    fn parse_mailbox_trims_surrounding_whitespace() {
        assert!(parse_mailbox("   a@b.com   ").is_ok());
    }

    #[test]
    fn parse_mailbox_rejects_garbage() {
        match parse_mailbox("not-an-email") {
            Err(EmailError::InvalidAddress(a)) => assert!(a.contains("not-an-email")),
            other => panic!("expected InvalidAddress, got {other:?}"),
        }
    }

    // --- build_body: every content branch + attachment fallback --------------

    #[test]
    fn build_body_text_only_is_singlepart_plain() {
        let bytes = body_bytes(&OutboundEmail {
            text: Some("hello".into()),
            ..Default::default()
        });
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("text/plain"), "plain part: {s}");
        assert!(s.contains("hello"));
    }

    #[test]
    fn build_body_html_only_is_singlepart_html() {
        let bytes = body_bytes(&OutboundEmail {
            html: Some("<b>hi</b>".into()),
            ..Default::default()
        });
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("text/html"), "html part: {s}");
    }

    #[test]
    fn build_body_text_and_html_is_alternative_multipart() {
        let bytes = body_bytes(&OutboundEmail {
            text: Some("plain".into()),
            html: Some("<i>rich</i>".into()),
            ..Default::default()
        });
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("multipart/alternative"), "alternative: {s}");
        assert!(s.contains("text/plain") && s.contains("text/html"));
    }

    #[test]
    fn build_body_empty_is_singlepart_plain() {
        // Neither text nor html ⇒ an empty plain part (not an error).
        match build_body(&OutboundEmail::default()).expect("builds") {
            MultiPartOrSingle::Single(_) => {}
            MultiPartOrSingle::Multi(_) => panic!("empty body should be singlepart"),
        }
    }

    #[test]
    fn build_body_with_attachment_wraps_in_mixed_multipart() {
        let bytes = body_bytes(&OutboundEmail {
            text: Some("see attached".into()),
            attachments: vec![Attachment {
                filename: "report.pdf".into(),
                content_type: "application/pdf".into(),
                bytes: b"%PDF-1.4".to_vec(),
            }],
            ..Default::default()
        });
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("multipart/mixed"), "mixed wrapper: {s}");
        assert!(s.contains("report.pdf"), "attachment filename present");
        assert!(s.contains("application/pdf"), "attachment content-type present");
    }

    #[test]
    fn build_body_alternative_with_attachment_nests_multipart() {
        // text + html (an alternative multipart) *and* an attachment: the
        // alternative body is nested directly inside the mixed wrapper.
        let bytes = body_bytes(&OutboundEmail {
            text: Some("plain".into()),
            html: Some("<i>rich</i>".into()),
            attachments: vec![Attachment {
                filename: "a.txt".into(),
                content_type: "text/plain".into(),
                bytes: b"data".to_vec(),
            }],
            ..Default::default()
        });
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("multipart/mixed"), "outer mixed: {s}");
        assert!(s.contains("multipart/alternative"), "nested alternative: {s}");
        assert!(s.contains("a.txt"), "attachment present");
    }

    #[test]
    fn build_body_malformed_content_type_falls_back_to_octet_stream() {
        // A bad content-type must not panic — it falls back to octet-stream.
        let bytes = body_bytes(&OutboundEmail {
            html: Some("body".into()),
            attachments: vec![Attachment {
                filename: "blob.bin".into(),
                content_type: "this is not a mime type".into(),
                bytes: vec![0, 1, 2, 3],
            }],
            ..Default::default()
        });
        let s = String::from_utf8_lossy(&bytes);
        assert!(
            s.contains("application/octet-stream"),
            "fallback content-type: {s}"
        );
    }

    // --- EmailError: Display for every variant + Debug ------------------------

    #[test]
    fn email_error_display_covers_all_variants() {
        assert_eq!(
            EmailError::NotConfigured.to_string(),
            "email transport is not configured"
        );
        assert_eq!(
            EmailError::InvalidAddress("x@".into()).to_string(),
            "invalid email address: x@"
        );
        assert_eq!(
            EmailError::Build("boom".into()).to_string(),
            "failed to build email: boom"
        );
        assert_eq!(
            EmailError::Transport("tls".into()).to_string(),
            "failed to build SMTP transport: tls"
        );
        assert_eq!(
            EmailError::Send("550".into()).to_string(),
            "SMTP send failed: 550"
        );
        assert_eq!(EmailError::Timeout.to_string(), "SMTP send timed out");
        // Debug is derived; exercise it so the derive is covered.
        assert!(format!("{:?}", EmailError::Timeout).contains("Timeout"));
    }

    // --- TransportPrefs: serde defaults for omitted fields -------------------

    #[test]
    fn transport_prefs_apply_serde_defaults() {
        let prefs: TransportPrefs =
            serde_json::from_str(r#"{"host":"smtp.example.com"}"#).expect("parses");
        assert_eq!(prefs.host, "smtp.example.com");
        assert_eq!(prefs.port, 587, "default_port");
        assert_eq!(prefs.username, "", "default username");
        assert_eq!(prefs.from, "", "default from");
        assert!(prefs.starttls, "default_starttls");
    }

    #[test]
    fn transport_prefs_honour_explicit_values() {
        let prefs: TransportPrefs = serde_json::from_str(
            r#"{"host":"h","port":465,"username":"u","from":"f@x.io","starttls":false}"#,
        )
        .expect("parses");
        assert_eq!(prefs.port, 465);
        assert_eq!(prefs.username, "u");
        assert_eq!(prefs.from, "f@x.io");
        assert!(!prefs.starttls);
    }

    // --- send_email: validation error paths (return before any socket) -------

    fn a_config() -> EmailTransportConfig {
        EmailTransportConfig {
            host: "127.0.0.1".into(),
            port: 0,
            username: "u".into(),
            password: "p".into(),
            from: "from@node.example".into(),
            starttls: true,
        }
    }

    #[tokio::test]
    async fn send_email_rejects_empty_recipient_list() {
        let cfg = a_config();
        let msg = OutboundEmail {
            subject: "s".into(),
            text: Some("b".into()),
            ..Default::default()
        };
        match send_email(&cfg, &msg).await {
            Err(EmailError::InvalidAddress(a)) => assert!(a.contains("no recipients")),
            other => panic!("expected no-recipients error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_email_rejects_invalid_from_override() {
        let cfg = a_config();
        let msg = OutboundEmail {
            from: Some("garbage".into()),
            to: vec!["ok@node.example".into()],
            ..Default::default()
        };
        assert!(matches!(
            send_email(&cfg, &msg).await,
            Err(EmailError::InvalidAddress(_))
        ));
    }

    #[tokio::test]
    async fn send_email_rejects_invalid_to() {
        let cfg = a_config();
        let msg = OutboundEmail {
            to: vec!["not valid".into()],
            ..Default::default()
        };
        assert!(matches!(
            send_email(&cfg, &msg).await,
            Err(EmailError::InvalidAddress(_))
        ));
    }

    #[tokio::test]
    async fn send_email_rejects_invalid_cc() {
        let cfg = a_config();
        let msg = OutboundEmail {
            to: vec!["ok@node.example".into()],
            cc: vec!["bad cc".into()],
            ..Default::default()
        };
        assert!(matches!(
            send_email(&cfg, &msg).await,
            Err(EmailError::InvalidAddress(_))
        ));
    }

    #[tokio::test]
    async fn send_email_rejects_invalid_bcc() {
        let cfg = a_config();
        let msg = OutboundEmail {
            to: vec!["ok@node.example".into()],
            bcc: vec!["bad bcc".into()],
            ..Default::default()
        };
        assert!(matches!(
            send_email(&cfg, &msg).await,
            Err(EmailError::InvalidAddress(_))
        ));
    }

    #[tokio::test]
    async fn send_email_rejects_invalid_reply_to() {
        let cfg = a_config();
        let msg = OutboundEmail {
            to: vec!["ok@node.example".into()],
            reply_to: Some("bad reply".into()),
            ..Default::default()
        };
        assert!(matches!(
            send_email(&cfg, &msg).await,
            Err(EmailError::InvalidAddress(_))
        ));
    }

    #[tokio::test]
    async fn send_email_alert_rejects_invalid_recipient() {
        let cfg = a_config();
        assert!(matches!(
            send_email_alert(&cfg, "not an address", "subj", "body").await,
            Err(EmailError::InvalidAddress(_))
        ));
    }

    // --- send_email: the SMTP transport-build + send() legs, exercised against
    // a loopback listener that accepts then immediately closes. This is fully
    // hermetic (loopback only, ephemeral port, no DNS, no external egress, no
    // secret leaves the box); the reset surfaces as `EmailError::Send`. Covers
    // both transport-build branches (STARTTLS submission vs implicit-TLS relay).

    fn accept_then_close_listener() -> u16 {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            // Accept a few connection attempts, dropping each at once so the peer
            // sees a reset while reading the SMTP greeting / TLS handshake.
            for conn in listener.incoming().take(4) {
                if let Ok(stream) = conn {
                    drop(stream);
                }
            }
        });
        port
    }

    async fn expect_send_failure(starttls: bool, multipart_body: bool) {
        let port = accept_then_close_listener();
        let cfg = EmailTransportConfig {
            host: "127.0.0.1".into(),
            port,
            username: "u".into(),
            password: "p".into(),
            from: "from@node.example".into(),
            starttls,
        };
        // `multipart_body` toggles the send-path body branch: a text+html
        // alternative (multipart send) vs a text-only singlepart send.
        let msg = OutboundEmail {
            to: vec!["to@node.example".into()],
            cc: vec!["cc@node.example".into()],
            bcc: vec!["bcc@node.example".into()],
            reply_to: Some("reply@node.example".into()),
            subject: "hi".into(),
            text: Some("plain".into()),
            html: multipart_body.then(|| "<b>rich</b>".to_string()),
            in_reply_to: Some("<prev@node.example>".into()),
            references: Some("<root@node.example>".into()),
            ..Default::default()
        };
        // The message + transport build must succeed; the send itself must fail
        // (never NotConfigured — the config here is fully specified).
        match send_email(&cfg, &msg).await {
            Err(EmailError::Send(_)) => {}
            Err(EmailError::Transport(_)) => {}
            other => panic!("expected a send/transport failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_email_starttls_multipart_send_failure() {
        expect_send_failure(true, true).await;
    }

    #[tokio::test]
    async fn send_email_implicit_tls_singlepart_send_failure() {
        // Implicit-TLS branch *and* the singlepart send branch.
        expect_send_failure(false, false).await;
    }
}
