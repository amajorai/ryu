//! Health-check loop for the Identity Vault (Unit 6, #524).
//!
//! A connection can go `AUTHENTICATED` and then quietly lapse — a captured
//! session expires, a token is revoked, a cookie jar is cleared upstream. The
//! health loop catches that: it periodically re-validates every
//! `AUTHENTICATED` connection through its [`CredentialSource`] and flips the
//! stale ones back to `NEEDS_AUTH`, so the next tool call that targets the
//! domain raises a fresh human-in-the-loop login instead of failing opaquely.
//!
//! ## Placement (Core vs Gateway)
//!
//! Per `CLAUDE.md` §1 this is Core: it decides *what runs and when*. It mirrors
//! [`crate::monitors`] — a single process-global [`HealthEngine`] backed by a
//! [`crate::scheduler`] job ([`JobTarget::IdentityHealth`]) so the sweep rides
//! the same 30s tick loop as monitors/workflows/agents instead of spawning its
//! own interval. The interval is a swappable env knob, never a constant
//! (`RYU_IDENTITY_HEALTH_INTERVAL`, default [`DEFAULT_INTERVAL`]).
//!
//! [`JobTarget::IdentityHealth`]: crate::scheduler::store::JobTarget::IdentityHealth
//!
//! ## Validation signal (why `fetch_state`, not `poll`)
//!
//! A connection is "alive" iff its backend can still produce sealed state for
//! its domain. So the sweep resolves the per-domain [`CredentialBackend`] and
//! calls [`CredentialSource::fetch_state`]: `Ok(_)` → alive (stamp
//! `last_checked`), `Err(_)` → stale (flip to `NEEDS_AUTH` + broadcast). We do
//! **not** use [`CredentialSource::poll`]: for the default [`ManualImport`]
//! backend `poll` always returns `NeedsAuth` (its flow only completes on
//! import), which would spuriously flip every connection on the first sweep.
//!
//! In v1 only the manual backend is really usable, and its `fetch_state` is a
//! local vault read (no transient network failures), so flip-on-error is safe.
//! Live capture backends added later may need to distinguish a transient fetch
//! error from genuine auth-staleness before flipping.
//!
//! [`CredentialSource`]: crate::identity::CredentialSource
//! [`CredentialBackend`]: crate::identity::CredentialSource
//! [`ManualImport`]: crate::identity::ManualImport

use serde::Serialize;
use tokio::sync::broadcast;

use super::{ConnectionStatus, CredentialSourceRegistry, IdentityStore};

/// Env knob overriding the health-check interval (any `humantime` duration,
/// e.g. `15m`, `1h`). Falls back to [`DEFAULT_INTERVAL`] when unset/unparseable.
pub const INTERVAL_ENV: &str = "RYU_IDENTITY_HEALTH_INTERVAL";

/// Default health-check interval when [`INTERVAL_ENV`] is unset. Conservative —
/// re-validating sessions hourly is plenty for catching lapsed logins without
/// hammering live capture backends.
pub const DEFAULT_INTERVAL: &str = "1h";

/// A status change the health loop made (or observed), fanned out to SSE
/// subscribers so the desktop reflects a connection going stale without a poll.
///
/// **Never carries credential state** — only the identifying fields and the new
/// status. (The [`super::SealedState`] newtype also makes leaking the blob hard,
/// but this struct simply never reads it.)
#[derive(Debug, Clone, Serialize)]
pub struct HealthEvent {
    /// The connection whose status the sweep touched.
    pub connection_id: String,
    /// The profile the connection belongs to.
    pub profile_id: String,
    /// The domain (e.g. `app.netflix.com`).
    pub domain: String,
    /// The status after the check (today only [`ConnectionStatus::NeedsAuth`]
    /// is broadcast — a flip — but the field is general so a later
    /// re-authentication can broadcast `AUTHENTICATED` too).
    pub status: ConnectionStatus,
}

/// The health-check runtime: owns the [`IdentityStore`] and the per-domain
/// [`CredentialSourceRegistry`] used to resolve each connection's backend, plus
/// a broadcast channel for status changes. Cheap to clone (`Arc`/`Sender`
/// inside). Shared by the scheduler (via a process-global handle) and exposed
/// so a later HTTP unit can subscribe an SSE stream — mirroring
/// [`crate::monitors::MonitorEngine`].
#[derive(Clone)]
pub struct HealthEngine {
    store: IdentityStore,
    registry: CredentialSourceRegistry,
    tx: broadcast::Sender<HealthEvent>,
}

impl HealthEngine {
    /// Build an engine over `store`, resolving each connection's backend from
    /// the supplied per-domain `registry` (main wires a
    /// [`CredentialSourceRegistry::from_env`]).
    pub fn new(store: IdentityStore, registry: CredentialSourceRegistry) -> Self {
        let (tx, _rx) = broadcast::channel(128);
        Self {
            store,
            registry,
            tx,
        }
    }

    /// Subscribe to health status-change events (for the SSE stream a later
    /// unit hangs off this). Like monitors, the channel may have zero
    /// subscribers — a send with no receivers is simply dropped.
    pub fn subscribe(&self) -> broadcast::Receiver<HealthEvent> {
        self.tx.subscribe()
    }

    /// Re-validate every `AUTHENTICATED` connection once. Alive connections get
    /// their `last_checked` stamped; stale ones (the backend can no longer
    /// produce sealed state) are flipped to `NEEDS_AUTH` and broadcast.
    ///
    /// Returns the number of connections flipped to `NEEDS_AUTH`.
    ///
    /// The store lock is taken and released by each call (`list`, then per
    /// connection `touch_checked`/`mark_needs_auth`); the lock is **never** held
    /// across the `fetch_state` await.
    pub async fn run_sweep(&self) -> Result<usize, String> {
        let connections = self.store.list().await.map_err(|e| e.to_string())?;
        let mut flipped = 0usize;
        for conn in connections {
            // Only AUTHENTICATED rows are candidates; NEEDS_AUTH is already the
            // safe state and a transient flow (IN_PROGRESS) should not be flipped.
            if conn.status != ConnectionStatus::Authenticated {
                continue;
            }
            let backend = self.registry.resolve(&conn.domain);
            match backend.fetch_state(&conn.profile_id, &conn.domain).await {
                Ok(_sealed) => {
                    // Alive — record the successful check. The sealed blob is
                    // intentionally dropped here; nothing logs it.
                    if let Err(e) = self.store.touch_checked(&conn.id).await {
                        tracing::warn!(
                            "identity health: failed to stamp last_checked for {}: {e}",
                            conn.id
                        );
                    }
                }
                Err(_stale) => {
                    // Stale — flip back to NEEDS_AUTH and broadcast. The error is
                    // deliberately not logged: a backend error can embed request
                    // detail, and we never want credential context in a log line.
                    match self.store.mark_needs_auth(&conn.id).await {
                        Ok(true) => {
                            flipped += 1;
                            let _ = self.tx.send(HealthEvent {
                                connection_id: conn.id.clone(),
                                profile_id: conn.profile_id.clone(),
                                domain: conn.domain.clone(),
                                status: ConnectionStatus::NeedsAuth,
                            });
                            tracing::info!(
                                "identity health: connection {} for domain {} went stale → NEEDS_AUTH",
                                conn.id,
                                conn.domain
                            );
                        }
                        Ok(false) => {}
                        Err(e) => tracing::warn!(
                            "identity health: failed to flip {} to NEEDS_AUTH: {e}",
                            conn.id
                        ),
                    }
                }
            }
        }
        Ok(flipped)
    }
}

// ── Process-global engine (set_global/global, like monitors) ─────────────────

/// Process-global health engine, published once at startup from `main.rs`.
///
/// The scheduler runs as a state-free background loop, so the
/// `JobTarget::IdentityHealth` arm reads the engine from here when its job
/// fires. Mirrors [`crate::monitors::global_engine`].
static ENGINE: std::sync::OnceLock<HealthEngine> = std::sync::OnceLock::new();

/// Publish the global health engine. Idempotent: a second call is ignored.
pub fn set_global_engine(engine: HealthEngine) {
    let _ = ENGINE.set(engine);
}

/// The global health engine, if it has been published.
pub fn global_engine() -> Option<&'static HealthEngine> {
    ENGINE.get()
}

/// Resolve the configured health-check interval from [`INTERVAL_ENV`], falling
/// back to [`DEFAULT_INTERVAL`] when the env var is unset or not a valid
/// `humantime` duration. Returned as the raw duration string for a
/// `Schedule::Every`.
pub fn interval_setting() -> String {
    match std::env::var(INTERVAL_ENV) {
        Ok(v) if humantime::parse_duration(&v).is_ok() => v,
        _ => DEFAULT_INTERVAL.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::source::AlwaysStale;
    use crate::identity::SecretState;

    /// Seed the process-global cipher with a deterministic test key so
    /// `seal`/`open` work without an OS keychain (mirrors Unit 0's helper).
    fn ensure_test_cipher() {
        use base64::Engine as _;
        let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        // SAFETY: a fixed test constant, set never unset; tests run per-process.
        unsafe {
            std::env::set_var("RYU_MASTER_KEY", key);
        }
    }

    /// An `AUTHENTICATED` connection whose backend can no longer produce sealed
    /// state must be flipped to `NEEDS_AUTH` by a sweep, and the flip must be
    /// broadcast. We drive the stale signal deterministically by overriding the
    /// connection's domain to the test-only [`AlwaysStale`] backend, whose
    /// `fetch_state` always errors — standing in for a real backend that has
    /// lost the live session. (It is `#[cfg(test)]`, so unlike the retired
    /// `browser-tool` stub it can never be selected in a real binary.) The
    /// engine holds its own in-memory store so the test never depends on the
    /// set-once process-global.
    #[tokio::test]
    async fn stale_connection_flips_to_needs_auth() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();

        // A connection that imports state → AUTHENTICATED.
        let conn = store
            .create("prof_1", "stale.example.com", None)
            .await
            .unwrap();
        store
            .import_state(&conn.id, &SecretState::new("cookie=live".to_owned()))
            .await
            .unwrap();
        assert_eq!(
            store.get(&conn.id).await.unwrap().unwrap().status,
            ConnectionStatus::Authenticated
        );

        // Resolve this domain to a backend whose `fetch_state` errors, simulating
        // a session that lapsed upstream.
        let registry = CredentialSourceRegistry::with_default("manual")
            .with_override("stale.example.com", AlwaysStale::ID)
            .unwrap();
        let engine = HealthEngine::new(store.clone(), registry);
        let mut events = engine.subscribe();

        let flipped = engine.run_sweep().await.unwrap();
        assert_eq!(flipped, 1, "the stale connection should be flipped");

        // The store reflects the flip.
        let after = store.get(&conn.id).await.unwrap().unwrap();
        assert_eq!(after.status, ConnectionStatus::NeedsAuth);
        assert!(after.last_checked > 0, "the flip stamps last_checked");

        // And the status change was broadcast (state never leaks into the event).
        let event = events
            .try_recv()
            .expect("a HealthEvent should be broadcast");
        assert_eq!(event.connection_id, conn.id);
        assert_eq!(event.domain, "stale.example.com");
        assert_eq!(event.status, ConnectionStatus::NeedsAuth);
    }

    /// A connection that is already `NEEDS_AUTH` is left untouched by the sweep:
    /// only `AUTHENTICATED` rows are candidates, so the backend is never even
    /// resolved for it (which keeps this assertion free of the set-once global
    /// the manual backend's `fetch_state` reads).
    #[tokio::test]
    async fn needs_auth_connection_is_skipped() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        // Created connections start NEEDS_AUTH with no state.
        let conn = store
            .create("prof_pending", "pending.example.com", None)
            .await
            .unwrap();
        assert_eq!(conn.status, ConnectionStatus::NeedsAuth);

        // Even an override to the always-erroring stub backend must not flip it,
        // because the sweep skips non-AUTHENTICATED rows before resolving a
        // backend.
        let registry = CredentialSourceRegistry::with_default("manual")
            .with_override("pending.example.com", AlwaysStale::ID)
            .unwrap();
        let engine = HealthEngine::new(store.clone(), registry);
        let flipped = engine.run_sweep().await.unwrap();
        assert_eq!(flipped, 0, "a NEEDS_AUTH connection is not a candidate");
        // Untouched: last_checked stays 0 (no backend call, no stamp).
        assert_eq!(store.get(&conn.id).await.unwrap().unwrap().last_checked, 0);
    }

    #[test]
    fn interval_falls_back_to_default() {
        // SAFETY: single-threaded test mutation of an env var local to this test.
        unsafe {
            std::env::remove_var(INTERVAL_ENV);
        }
        assert_eq!(interval_setting(), DEFAULT_INTERVAL);
        unsafe {
            std::env::set_var(INTERVAL_ENV, "not-a-duration");
        }
        assert_eq!(interval_setting(), DEFAULT_INTERVAL);
        unsafe {
            std::env::set_var(INTERVAL_ENV, "15m");
        }
        assert_eq!(interval_setting(), "15m");
        unsafe {
            std::env::remove_var(INTERVAL_ENV);
        }
    }
}
