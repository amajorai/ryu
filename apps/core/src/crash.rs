//! Crash reporting tier (#544, P3) — Sentry for Rust PANICS, gated on the
//! `crash-reports-enabled` pref (a consent tier SEPARATE from product analytics)
//! and a DSN env var.
//!
//! This is the §4.2 "crash tier (separate, separately consentable)" made literal
//! for the Rust data plane. It captures *panics only* — never `tracing`/log events
//! (those can carry prompt/agent content and `~/.ryu` paths), so we deliberately do
//! NOT add `sentry-tracing`/`sentry-log`. The only integrations are panic +
//! backtrace + contexts, and a `before_send` scrubs the user's home-dir prefix out
//! of the panic message and every stack frame's path, and strips quoted strings,
//! PII and secrets from the panic message (see `scrub_message`). We also force
//! `send_default_pii = false` and `server_name = None` so the machine hostname
//! never leaves the box.
//!
//! Gates (both must hold, else a true no-op):
//!   1. `crash-reports-enabled` is on (default ON, opt-out) — resolved via
//!      [`crate::privacy::crash_reports_enabled`] from the pref → env → default.
//!   2. A DSN is configured (`SENTRY_DSN`). With no DSN the
//!      whole module is a graceful no-op, so a fresh local install reports nothing
//!      and never crashes boot.
//!
//! Live-toggle note (restart-to-apply): like the OTel export seam, the Rust side
//! reads the pref once at boot. Flipping the desktop toggle off takes effect on the
//! next Core restart (the renderer tier flips live). The `before_send` scrub is the
//! load-bearing invariant; the gate is the consent boundary.
//!
//! Placement (Core vs Gateway): this reports *what crashed in Core* for the user's
//! own diagnostics; it enforces no policy. The DSN destination is a swappable config
//! value, never a hardcoded vendor.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::server::preferences::PreferencesStore;

/// Process-global mirror of the resolved `crash-reports-enabled` consent, seeded
/// once at startup (see [`init`]). The gateway sidecar spawn-env reads this to
/// forward the same consent to the gateway tier (which has no `PreferencesStore`),
/// so both tiers follow one toggle. Default-true matches the §6 opt-out posture so
/// a spawn that races startup seeding errs to the documented default.
static CRASH_CONSENT: AtomicBool = AtomicBool::new(true);

/// Whether the user consented to crash reporting (the seeded process-global). Used
/// by `gateway_spawn_env()` to forward consent into the gateway sidecar.
pub fn is_consented() -> bool {
    CRASH_CONSENT.load(Ordering::Relaxed)
}

/// The configured DSN (env), exposed so `gateway_spawn_env()` can forward it to the
/// gateway under the canonical `RYU_SENTRY_DSN` name.
pub fn dsn() -> Option<String> {
    resolve_dsn()
}

/// The Sentry DSN env var Core reads (the Sentry-standard name the desktop sets).
/// Core forwards the resolved value to the gateway as `RYU_SENTRY_DSN`.
const SENTRY_DSN_ENV: &str = "SENTRY_DSN";

/// Resolve the configured DSN. An empty / unset value means "no crash reporting
/// destination" → no-op.
fn resolve_dsn() -> Option<String> {
    std::env::var(SENTRY_DSN_ENV)
        .ok()
        .map(|dsn| dsn.trim().to_string())
        .filter(|dsn| !dsn.is_empty())
}

/// Replace the current user's home-dir prefix in `s` with `~` so absolute paths
/// (`C:\Users\alice\.ryu\...`, `/home/alice/...`) never leave the machine in a
/// panic message or a stack-frame path. Pure so it is unit-testable.
fn scrub_home(home: Option<&str>, s: &str) -> String {
    match home {
        Some(h) if !h.is_empty() && s.contains(h) => s.replace(h, "~"),
        _ => s.to_string(),
    }
}

/// Best-effort home-dir string for the scrub. Resolved once at init.
fn home_dir_string() -> Option<String> {
    dirs::home_dir().map(|p| p.to_string_lossy().to_string())
}

/// Initialize Sentry crash reporting if (and only if) the user consented AND a DSN
/// is configured. Returns the `ClientInitGuard` the caller MUST keep alive for the
/// whole process — dropping it early tears down the transport before a panic event
/// can flush. Returns `None` (a no-op) when disabled or unconfigured.
///
/// The returned guard is bound (NOT leaked) in `main.rs` so it flushes on a clean
/// shutdown path too.
pub async fn init(prefs: &PreferencesStore) -> Option<sentry::ClientInitGuard> {
    let consented = crate::privacy::crash_reports_enabled(prefs).await;
    // Seed the process-global so the gateway-spawn forwarding mirrors this consent.
    CRASH_CONSENT.store(consented, Ordering::Relaxed);
    if !consented {
        return None;
    }
    let dsn = resolve_dsn()?;
    Some(init_with_dsn(dsn))
}

/// Build the Sentry client with the PII-scrubbing `before_send` and the
/// crate-version release tag. Split out so the scrub wiring is testable in spirit.
fn init_with_dsn(dsn: String) -> sentry::ClientInitGuard {
    let home = home_dir_string();
    sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(env!("CARGO_PKG_VERSION").into()),
            // Never attach PII (IP, request data, machine username heuristics).
            send_default_pii: false,
            // Suppress the auto-captured machine hostname.
            server_name: None,
            // Scrub home-dir paths out of the panic message + every frame's path.
            before_send: Some(std::sync::Arc::new(move |mut event| {
                scrub_event(home.as_deref(), &mut event);
                Some(event)
            })),
            ..Default::default()
        },
    ))
}

/// Longest panic message (in bytes) that leaves the machine. A panic message is
/// diagnostic text, not content: anything past this is cut on a char boundary.
const MAX_SCRUBBED_MESSAGE_BYTES: usize = 512;

/// Scrub one panic or log message before it leaves the machine:
///
/// 1. home-dir prefixes become `~`;
/// 2. the quoted string std embeds in slicing panics (`... of `<up to 256 bytes
///    of the string>``, `when slicing `...``, `it is inside 'é'`) is replaced, since
///    that string is often prompt or document text;
/// 3. PII and secrets are replaced by the locked export redactor
///    (`conversation_history::redaction::redact_text`), which also folds
///    fullwidth and zero-width obfuscation;
/// 4. the result is capped at [`MAX_SCRUBBED_MESSAGE_BYTES`].
fn scrub_message(home: Option<&str>, message: &str) -> String {
    static SLICED_STRING: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static INSIDE_CHAR: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let sliced = SLICED_STRING.get_or_init(|| {
        regex::Regex::new(r"(?s)(\bof |\bslicing )`.*`").expect("static slicing-panic regex")
    });
    let inside = INSIDE_CHAR
        .get_or_init(|| regex::Regex::new(r"(\binside )'.'").expect("static char-boundary regex"));
    let scrubbed = scrub_home(home, message);
    let scrubbed = sliced.replace_all(&scrubbed, "${1}`[redacted]`");
    let scrubbed = inside.replace_all(&scrubbed, "${1}'?'");
    let mut counts = crate::server::conversation_history::redaction::RedactionCounts::default();
    let mut redacted =
        crate::server::conversation_history::redaction::redact_text(&scrubbed, &mut counts);
    if redacted.len() > MAX_SCRUBBED_MESSAGE_BYTES {
        let mut end = MAX_SCRUBBED_MESSAGE_BYTES;
        while !redacted.is_char_boundary(end) {
            end -= 1;
        }
        redacted.truncate(end);
        redacted.push_str(" [truncated]");
    }
    redacted
}

/// Scrub a captured event in place: the exception values (panic messages), the
/// event message and log entry go through [`scrub_message`], and every
/// stack-frame `abs_path`/`filename` loses its home-dir prefix. Pure over the
/// home string so it can be reasoned about; mutates the event the caller forwards.
fn scrub_event(home: Option<&str>, event: &mut sentry::protocol::Event<'static>) {
    if let Some(message) = &event.message {
        event.message = Some(scrub_message(home, message));
    }
    if let Some(entry) = &mut event.logentry {
        entry.message = scrub_message(home, &entry.message);
        for param in &mut entry.params {
            let text = match &*param {
                serde_json::Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            *param = serde_json::Value::String(scrub_message(home, &text));
        }
    }
    for exception in &mut event.exception.values {
        if let Some(value) = &exception.value {
            exception.value = Some(scrub_message(home, value));
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
        let home = Some("/home/alice");
        assert_eq!(
            scrub_home(home, "failed to open /home/alice/.ryu/agents.db"),
            "failed to open ~/.ryu/agents.db"
        );
        // Windows-style path.
        let win = Some(r"C:\Users\alice");
        assert_eq!(
            scrub_home(win, r"C:\Users\alice\.ryu\traces.db"),
            r"~\.ryu\traces.db"
        );
    }

    #[test]
    fn scrub_home_is_noop_without_match() {
        assert_eq!(scrub_home(Some("/home/alice"), "boom"), "boom");
        assert_eq!(scrub_home(None, "/home/alice/x"), "/home/alice/x");
        assert_eq!(scrub_home(Some(""), "/home/alice/x"), "/home/alice/x");
    }

    #[test]
    fn scrub_event_strips_pii_secrets_and_sliced_strings_from_panics() {
        let mut event = sentry::protocol::Event {
            message: Some("lost contact alice@example.com".to_owned()),
            ..Default::default()
        };
        event.exception.values.push(sentry::protocol::Exception {
            ty: "panic".to_owned(),
            value: Some(
                "byte index 5 is not a char boundary; it is inside 'é' (bytes 4..6) of `secret prompt for alice@example.com` key sk-ant-abcdefghijklmnopqrstuvwxyz0123 in /home/alice/.ryu/x"
                    .to_owned(),
            ),
            ..Default::default()
        });
        scrub_event(Some("/home/alice"), &mut event);
        let value = event.exception.values[0].value.clone().unwrap();
        for leaked in [
            "alice@example.com",
            "sk-ant-abcdefghijklmnopqrstuvwxyz0123",
            "secret prompt",
            "'é'",
            "/home/alice",
        ] {
            assert!(!value.contains(leaked), "{leaked} leaked: {value}");
        }
        assert!(value.contains("is not a char boundary"), "{value}");
        assert!(value.contains("~/.ryu/x"), "{value}");
        let message = event.message.unwrap();
        assert!(!message.contains("alice@example.com"), "{message}");
    }

    #[test]
    fn scrub_message_caps_length_on_a_char_boundary() {
        let long = "é".repeat(600);
        let scrubbed = scrub_message(None, &long);
        assert!(scrubbed.len() <= MAX_SCRUBBED_MESSAGE_BYTES + " [truncated]".len());
        assert!(scrubbed.ends_with(" [truncated]"));
    }

    #[test]
    fn scrub_message_keeps_diagnostic_text() {
        assert_eq!(
            scrub_message(None, "called `Option::unwrap()` on a `None` value"),
            "called `Option::unwrap()` on a `None` value"
        );
    }

    #[test]
    fn dsn_resolution_reads_sentry_dsn() {
        // std::env is process-global; this test sets+clears its own key.
        // SAFETY: single-threaded test access to this specific key.
        unsafe {
            std::env::set_var("SENTRY_DSN", "  https://std@example/2  ");
        }
        assert_eq!(resolve_dsn().as_deref(), Some("https://std@example/2"));
        unsafe {
            std::env::remove_var("SENTRY_DSN");
        }
        assert_eq!(resolve_dsn(), None);
    }
}
