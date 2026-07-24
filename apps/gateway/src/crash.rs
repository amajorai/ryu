//! Crash reporting tier (#544, P3) — Sentry for Rust PANICS in the gateway.
//!
//! Mirrors Core's `crash.rs`. The gateway has no `PreferencesStore`, so it reads
//! its consent from env: `RYU_CRASH_REPORTS_ENABLED` (default ON, opt-out) plus a
//! DSN (`SENTRY_DSN`/`RYU_SENTRY_DSN`). Core's `gateway_spawn_env()` forwards the
//! user's desktop `crash-reports-enabled` pref + the DSN into these env vars when
//! it spawns the gateway as a sidecar, so the gateway tier follows the same single
//! consent toggle. With the flag off or no DSN this is a true no-op (never crashes
//! boot).
//!
//! Captures *panics only* — no `sentry-tracing`/`sentry-log`, since gateway log
//! lines can carry model/provider/prompt-adjacent data. `send_default_pii = false`,
//! `server_name = None`, and a `before_send` scrubs home-dir paths from the panic
//! message + every stack frame.
//!
//! Placement (Core vs Gateway): this reports *what crashed in the gateway* for the
//! user's own diagnostics; it enforces no policy. The DSN is a swappable config
//! value, never a hardcoded vendor.

/// The Sentry DSN env vars, in resolution order (Ryu mirror first).
const SENTRY_DSN_ENVS: [&str; 2] = ["RYU_SENTRY_DSN", "SENTRY_DSN"];

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

/// Resolve the configured DSN (Ryu mirror first). Empty/unset → no destination.
fn resolve_dsn() -> Option<String> {
    for key in SENTRY_DSN_ENVS {
        if let Ok(dsn) = std::env::var(key) {
            let trimmed = dsn.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
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

/// Scrub home-dir prefixes out of the panic message + every stack-frame path.
fn scrub_event(home: Option<&str>, event: &mut sentry::protocol::Event<'static>) {
    for exception in &mut event.exception.values {
        if let Some(value) = &exception.value {
            exception.value = Some(scrub_home(home, value));
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
}
