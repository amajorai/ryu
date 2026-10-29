//! The one crate-wide lock for tests that write `RYU_SANDBOX_BOX_*` or the
//! installed Box credential source.
//!
//! The process environment and [`crate::box_credential::install_source`] are
//! process-wide, and tests run in parallel threads. Every test that sets or
//! clears a Box env var (or installs a credential source) holds this lock for
//! its whole body, so another test never reads a value it did not set. Take
//! it before snapshotting the env to restore, and bind it first so it drops
//! last, after the env is restored.

use tokio::sync::{Mutex, MutexGuard};

static BOX_ENV: Mutex<()> = Mutex::const_new(());

/// Hold the Box env lock in an async test.
pub(crate) async fn lock_box_env() -> MutexGuard<'static, ()> {
    BOX_ENV.lock().await
}

/// Hold the Box env lock in a plain `#[test]`. Panics inside a Tokio runtime;
/// async tests use [`lock_box_env`].
pub(crate) fn lock_box_env_blocking() -> MutexGuard<'static, ()> {
    BOX_ENV.blocking_lock()
}
