//! Crash reporting tier (#544, P3) — Sentry for Rust PANICS in the gateway.
//!
//! Mirrors Core's `crash.rs`. The gateway has no `PreferencesStore`, so it reads
//! its consent from env: `RYU_CRASH_REPORTS_ENABLED` (default ON, opt-out) plus a
//! DSN (`RYU_SENTRY_DSN`). Core's `gateway_spawn_env()` forwards the
//! user's desktop `crash-reports-enabled` pref + the DSN into these env vars when
//! it spawns the gateway as a sidecar, so the gateway tier follows the same single
//! consent toggle. With the flag off or no DSN this is a true no-op (never crashes
//! boot).
//!
//! Captures *panics only* — no `sentry-tracing`/`sentry-log`, since gateway log
//! lines can carry model/provider/prompt-adjacent data. `send_default_pii = false`,
//! `server_name = None`, and a `before_send` scrubs home-dir paths from the panic
//! message + every stack frame. Panic payloads can carry request text (a str
//! slicing panic quotes up to 256 bytes of the string, `expect` messages format
//! values), so every message is also neutralized, PII/secret-redacted over the
//! Unicode-folded text, and capped before it leaves the machine.
//!
//! Placement (Core vs Gateway): this reports *what crashed in the gateway* for the
//! user's own diagnostics; it enforces no policy. The DSN is a swappable config
//! value, never a hardcoded vendor.

/// The Sentry DSN env var. Core forwards its DSN under this name.
const SENTRY_DSN_ENV: &str = "RYU_SENTRY_DSN";

/// Env mirror of the `crash-reports-enabled` consent. Default ON (opt-out), matching
/// Core's pref default; only an explicit falsey value disables.
const CRASH_REPORTS_ENABLED_ENV: &str = "RYU_CRASH_REPORTS_ENABLED";

/// Parse a boolean env value (mirrors Core's `privacy::parse_bool`).
fn parse_bool(value: &str, default: bool) -> bool {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => true,
        "false" | "0" | "off" | "no" => false,
        _ => default,
    }
}

/// Whether crash reporting is enabled per env (default ON, opt-out).
fn enabled() -> bool {
    std::env::var(CRASH_REPORTS_ENABLED_ENV)
        .map(|v| parse_bool(&v, true))
        .unwrap_or(true)
}

/// Resolve the configured DSN. Empty/unset → no destination.
fn resolve_dsn() -> Option<String> {
    std::env::var(SENTRY_DSN_ENV)
        .ok()
        .map(|dsn| dsn.trim().to_string())
        .filter(|dsn| !dsn.is_empty())
}

/// Replace the home-dir prefix in `s` with `~` so absolute paths never egress.
fn scrub_home(home: Option<&str>, s: &str) -> String {
    match home {
        Some(h) if !h.is_empty() && s.contains(h) => s.replace(h, "~"),
        _ => s.to_string(),
    }
}

fn home_dir_string() -> Option<String> {
    dirs::home_dir().map(|p| p.to_string_lossy().to_string())
}

/// Initialize Sentry crash reporting if consent (env) is on AND a DSN is set.
/// Returns the `ClientInitGuard` the caller MUST keep alive for the whole process.
/// `None` (a no-op) when disabled or unconfigured.
pub fn init() -> Option<sentry::ClientInitGuard> {
    if !enabled() {
        return None;
    }
    let dsn = resolve_dsn()?;
    Some(init_with_dsn(dsn))
}

fn init_with_dsn(dsn: String) -> sentry::ClientInitGuard {
    let home = home_dir_string();
    sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(env!("CARGO_PKG_VERSION").into()),
            send_default_pii: false,
            server_name: None,
            before_send: Some(std::sync::Arc::new(move |mut event| {
                scrub_event(home.as_deref(), &mut event);
                Some(event)
            })),
            ..Default::default()
        },
    ))
}

/// Longest message text, in bytes, a crash event may carry.
const MAX_MESSAGE_BYTES: usize = 512;

/// The curated secret, outbound-secret and PII patterns, compiled once.
fn content_patterns() -> &'static [(String, regex::Regex)] {
    static PATTERNS: std::sync::OnceLock<Vec<(String, regex::Regex)>> = std::sync::OnceLock::new();
    PATTERNS.get_or_init(|| {
        let mut patterns = ryu_gw_firewall::build_secret_patterns();
        patterns.extend(
            ryu_gw_firewall::build_outbound_patterns()
                .into_iter()
                .map(|(marker, re)| (marker.to_string(), re)),
        );
        patterns.extend(ryu_gw_firewall::build_pii_patterns());
        patterns
    })
}

/// Replace the quoted string payload of std's str-slicing panics (`... of
/// `<text>``, `when slicing `<text>``, `it is inside '<char>'`), which is a
/// verbatim piece of whatever string was being sliced.
fn neutralize_slice_payload(text: &str) -> String {
    static QUOTED: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static INSIDE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let quoted = QUOTED.get_or_init(|| {
        regex::Regex::new(r"(?s)(?P<lead>(?:\bof|when slicing) )`.*`")
            .expect("static slice-payload regex")
    });
    let inside = INSIDE.get_or_init(|| {
        regex::Regex::new(r"(?s)it is inside .*? \(bytes").expect("static char-payload regex")
    });
    let text = inside.replace_all(text, "it is inside [redacted] (bytes");
    quoted
        .replace_all(&text, "${lead}`[redacted]`")
        .into_owned()
}

/// Replaces a crash message whose PII or secret survives the folded rewrite.
const SURVIVOR_MASK: &str = "[REDACTED:CONTENT]";

/// Whether the normalized scan view (every fold plus the TAG-stripped and
/// TAG-decoded views) still finds a content pattern, with the card and IPv4
/// validators the firewall applies.
fn content_survives(text: &str) -> bool {
    let normalized = ryu_gw_firewall::normalize_for_scan(text);
    let hay = normalized.as_ref();
    content_patterns()
        .iter()
        .any(|(name, re)| match name.as_str() {
            "credit_card" => re
                .find_iter(hay)
                .any(|m| ryu_gw_firewall::is_credit_card_number(m.as_str())),
            "ipv4" => re
                .find_iter(hay)
                .any(|m| ryu_gw_firewall::is_public_ipv4(m.as_str())),
            _ => re.is_match(hay),
        })
}

/// One rewrite of every content pattern over `text`. Private IPv4 addresses
/// stay readable for diagnostics. Returns whether anything was replaced.
fn redact_content(text: &str) -> (String, bool) {
    let mut text = text.to_owned();
    let mut changed = false;
    for (name, re) in content_patterns() {
        let placeholder = format!("[REDACTED:{}]", name.to_uppercase());
        let next = re.replace_all(&text, |caps: &regex::Captures| {
            if name == "ipv4" && !ryu_gw_firewall::is_public_ipv4(&caps[0]) {
                caps[0].to_string()
            } else {
                placeholder.clone()
            }
        });
        if next != text {
            changed = true;
            text = next.into_owned();
        }
    }
    (text, changed)
}

/// Everything a crash message goes through before egress: home-dir scrub,
/// slice-payload neutralization, PII/secret redaction, and a
/// [`MAX_MESSAGE_BYTES`] cap cut on a char boundary. When the normalized scan
/// still finds content after the raw rewrite (zero-width, fullwidth, TAG or
/// other obfuscation), the Unicode-folded text is rewritten instead, and the
/// whole message becomes [`SURVIVOR_MASK`] if content still survives or the
/// folded rewrite found nothing to replace.
fn scrub_text(home: Option<&str>, text: &str) -> String {
    let text = neutralize_slice_payload(&scrub_home(home, text));
    let (mut text, _) = redact_content(&text);
    if content_survives(&text) {
        let (folded, changed) = redact_content(&ryu_gw_firewall::fold_for_redaction(&text));
        text = if changed && !content_survives(&folded) {
            folded
        } else {
            SURVIVOR_MASK.to_owned()
        };
    }
    if text.len() > MAX_MESSAGE_BYTES {
        let mut end = MAX_MESSAGE_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("[truncated]");
    }
    text
}

/// Scrub the panic message, any event/log/breadcrumb message, and every
/// stack-frame path (home-dir prefixes only for paths).
fn scrub_event(home: Option<&str>, event: &mut sentry::protocol::Event<'static>) {
    if let Some(message) = &event.message {
        event.message = Some(scrub_text(home, message));
    }
    if let Some(logentry) = &mut event.logentry {
        logentry.message = scrub_text(home, &logentry.message);
        logentry.params.clear();
    }
    for breadcrumb in &mut event.breadcrumbs.values {
        if let Some(message) = &breadcrumb.message {
            breadcrumb.message = Some(scrub_text(home, message));
        }
    }
    for exception in &mut event.exception.values {
        if let Some(value) = &exception.value {
            exception.value = Some(scrub_text(home, value));
        }
        if let Some(stacktrace) = &mut exception.stacktrace {
            for frame in &mut stacktrace.frames {
                if let Some(abs) = &frame.abs_path {
                    frame.abs_path = Some(scrub_home(home, abs));
                }
                if let Some(file) = &frame.filename {
                    frame.filename = Some(scrub_home(home, file));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_home_replaces_prefix() {
        assert_eq!(
            scrub_home(Some("/home/alice"), "panic at /home/alice/.ryu/x"),
            "panic at ~/.ryu/x"
        );
    }

    #[test]
    fn scrub_home_is_noop_without_match() {
        assert_eq!(scrub_home(None, "/home/alice/x"), "/home/alice/x");
        assert_eq!(scrub_home(Some(""), "/home/alice/x"), "/home/alice/x");
    }

    #[test]
    fn enabled_defaults_on_and_honors_falsey() {
        assert!(parse_bool("", true));
        assert!(!parse_bool("0", true));
        assert!(!parse_bool("off", true));
        assert!(parse_bool("1", false));
    }

    #[test]
    fn scrub_event_redacts_home_from_message_and_every_frame() {
        use sentry::protocol::{Event, Exception, Frame, Stacktrace};

        let home = "/home/alice";
        let mut event: Event<'static> = Event {
            exception: vec![Exception {
                ty: "panic".to_string(),
                value: Some("panic at /home/alice/.ryu/secret.toml".to_string()),
                stacktrace: Some(Stacktrace {
                    frames: vec![Frame {
                        abs_path: Some("/home/alice/src/main.rs".to_string()),
                        filename: Some("/home/alice/src/main.rs".to_string()),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            }]
            .into(),
            ..Default::default()
        };

        scrub_event(Some(home), &mut event);

        let ex = &event.exception.values[0];
        assert_eq!(ex.value.as_deref(), Some("panic at ~/.ryu/secret.toml"));
        let frame = &ex.stacktrace.as_ref().unwrap().frames[0];
        assert_eq!(frame.abs_path.as_deref(), Some("~/src/main.rs"));
        assert_eq!(frame.filename.as_deref(), Some("~/src/main.rs"));
    }

    #[test]
    fn scrub_event_is_a_noop_without_a_home_prefix() {
        use sentry::protocol::{Event, Exception};

        let mut event: Event<'static> = Event {
            exception: vec![Exception {
                ty: "panic".to_string(),
                value: Some("panic at /var/log/app.log".to_string()),
                ..Default::default()
            }]
            .into(),
            ..Default::default()
        };
        scrub_event(Some("/home/alice"), &mut event);
        assert_eq!(
            event.exception.values[0].value.as_deref(),
            Some("panic at /var/log/app.log")
        );
    }

    /// Panic text can quote request content: it must leave redacted, with the
    /// slicing payload neutralized and the length capped.
    #[test]
    fn scrub_event_redacts_content_from_every_message() {
        use sentry::protocol::{Breadcrumb, Event, Exception, LogEntry};

        let panic = "byte index 5 is not a char boundary; it is inside '\u{e9}' (bytes 4..6) of `secret prompt`[...] mail alice@example.com key sk-ant-abcdefghijklmnopqrstuvwxyz0123";
        let mut event: Event<'static> = Event {
            message: Some("token ghp_abcdefghijklmnopqrstuvwxyz0123456789".to_string()),
            logentry: Some(LogEntry {
                message: "card 4111 1111 1111 1111".to_string(),
                params: vec!["alice@example.com".into()],
            }),
            breadcrumbs: vec![Breadcrumb {
                message: Some("ssn 123-45-6789".to_string()),
                ..Default::default()
            }]
            .into(),
            exception: vec![Exception {
                ty: "panic".to_string(),
                value: Some(panic.to_string()),
                ..Default::default()
            }]
            .into(),
            ..Default::default()
        };
        scrub_event(None, &mut event);

        let value = event.exception.values[0].value.clone().unwrap();
        for leaked in ["secret prompt", "\u{e9}", "alice@example.com", "sk-ant-abc"] {
            assert!(!value.contains(leaked), "{leaked} leaked: {value}");
        }
        assert!(value.contains("is not a char boundary"), "{value}");
        let message = event.message.unwrap();
        assert!(!message.contains("ghp_abc"), "{message}");
        let logentry = event.logentry.unwrap();
        assert!(!logentry.message.contains("4111"), "{}", logentry.message);
        assert!(logentry.params.is_empty());
        let crumb = event.breadcrumbs.values[0].message.clone().unwrap();
        assert!(!crumb.contains("6789"), "{crumb}");
    }

    #[test]
    fn scrub_text_folds_obfuscation_and_caps_length() {
        let folded = scrub_text(
            None,
            "mail alice\u{FF20}example\u{FF0E}com and al\u{200B}ice@example.com",
        );
        assert!(!folded.contains("example"), "{folded}");
        // Private addresses stay readable for diagnostics; public ones do not.
        let ips = scrub_text(None, "connect 127.0.0.1 then 8.8.8.8");
        assert!(
            ips.contains("127.0.0.1") && !ips.contains("8.8.8.8"),
            "{ips}"
        );
        // A TAG space inside an address survives the in-place fold (it decodes
        // to a real space) but not the scan view, so the message is dropped.
        let tagged = scrub_text(None, "panic near alice@exa\u{E0020}mple.com");
        assert_eq!(tagged, SURVIVOR_MASK);
        let underlined = scrub_text(None, "ssn 1\u{0332}2\u{0332}3-45-6789 \u{FE6B}");
        assert!(!underlined.contains("6789"), "{underlined}");
        assert_eq!(
            scrub_text(None, "index 7 out of range"),
            "index 7 out of range"
        );
        let long = scrub_text(None, &"\u{e9}".repeat(600));
        assert!(long.len() <= MAX_MESSAGE_BYTES + "[truncated]".len());
        assert!(long.ends_with("[truncated]"));
    }
}
