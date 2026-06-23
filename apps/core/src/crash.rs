//! Crash reporting tier (#544, P3) — Sentry for Rust PANICS, gated on the
//! `crash-reports-enabled` pref (a consent tier SEPARATE from product analytics)
//! and a DSN env var.
//!
//! This is the §4.2 "crash tier (separate, separately consentable)" made literal
//! for the Rust data plane. It captures *panics only* — never `tracing`/log events
//! (those can carry prompt/agent content and `~/.ryu` paths), so we deliberately do
//! NOT add `sentry-tracing`/`sentry-log`. The only integrations are panic +
//! backtrace + contexts, and a `before_send` scrubs the user's home-dir prefix out
//! of the panic message and every stack frame's path. We also force
//! `send_default_pii = false` and `server_name = None` so the machine hostname
//! never leaves the box.
//!
//! Gates (both must hold, else a true no-op):
//!   1. `crash-reports-enabled` is on (default ON, opt-out) — resolved via
//!      [`crate::privacy::crash_reports_enabled`] from the pref → env → default.
//!   2. A DSN is configured (`SENTRY_DSN` / `RYU_SENTRY_DSN`). With no DSN the
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

/// The Sentry DSN env vars, in resolution order. `SENTRY_DSN` is the Sentry-standard
/// name; `RYU_SENTRY_DSN` is the Ryu-namespaced mirror Core forwards to the gateway.
const SENTRY_DSN_ENVS: [&str; 2] = ["RYU_SENTRY_DSN", "SENTRY_DSN"];

/// Resolve the configured DSN (Ryu mirror first, then the Sentry-standard name).
/// An empty / unset value means "no crash reporting destination" → no-op.
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

/// Scrub a captured event in place: home-dir prefixes out of the exception value
/// (the panic message) and every stack-frame `abs_path`/`filename`. Pure over the
/// home string so it can be reasoned about; mutates the event the caller forwards.
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
    fn dsn_resolution_prefers_ryu_mirror() {
        // Guard against env pollution from a parallel test: set both, expect mirror.
        // (std::env is process-global; this test sets+clears its own keys.)
        // SAFETY: single-threaded test access to these specific keys.
        unsafe {
            std::env::set_var("RYU_SENTRY_DSN", "https://ryu@example/1");
            std::env::set_var("SENTRY_DSN", "https://std@example/2");
        }
        assert_eq!(resolve_dsn().as_deref(), Some("https://ryu@example/1"));
        unsafe {
            std::env::remove_var("RYU_SENTRY_DSN");
        }
        assert_eq!(resolve_dsn().as_deref(), Some("https://std@example/2"));
        unsafe {
            std::env::remove_var("SENTRY_DSN");
        }
        assert_eq!(resolve_dsn(), None);
    }
}
