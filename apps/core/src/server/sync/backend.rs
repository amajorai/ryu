//! Which backend Core sends the signed-in account's bearer to, for cloud sync,
//! managed-bot pairing, the Challenges tools and the profile activity ping.
//!
//! Order: `RYU_SERVER_URL` when it is set and not blank, else the backend the
//! last device sign-in succeeded against (`crate::auth::load_backend_url`).
//! There is no default address. A stored backend must use https, even on a
//! loopback host: a plain http port has no server identity, so any local
//! program could listen there and receive the bearer. A developer who signs in
//! against a local server sets `RYU_SERVER_URL`, which is used as given.

use std::fmt;

/// Environment override for the account backend. Used as given, http included.
pub const SERVER_URL_ENV: &str = "RYU_SERVER_URL";

/// Why no account backend can be used. Nothing is sent in either case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendError {
    /// Neither `RYU_SERVER_URL` nor a stored sign-in backend.
    NoBackend,
    /// The stored sign-in backend does not use https.
    InsecureStoredBackend(String),
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BackendError::NoBackend => write!(
                f,
                "no account backend is known for this node; sign in on this node again, \
                 or set RYU_SERVER_URL"
            ),
            BackendError::InsecureStoredBackend(url) => write!(
                f,
                "the sign-in backend {url} does not use https; sign in again against an \
                 https backend, or set RYU_SERVER_URL to use a local server"
            ),
        }
    }
}

impl std::error::Error for BackendError {}

/// Pure resolution: `env` is the value of `RYU_SERVER_URL`, `stored` the
/// backend of the last device sign-in. Returns the base URL without a trailing
/// slash. A blank `env` counts as unset.
pub fn resolve_backend_base(
    env: Option<String>,
    stored: Option<String>,
) -> Result<String, BackendError> {
    let non_blank = |value: Option<String>| {
        value
            .map(|value| value.trim().trim_end_matches('/').to_owned())
            .filter(|value| !value.is_empty())
    };
    if let Some(explicit) = non_blank(env) {
        return Ok(explicit);
    }
    let stored = non_blank(stored).ok_or(BackendError::NoBackend)?;
    let https = url::Url::parse(&stored)
        .is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some());
    if https {
        Ok(stored)
    } else {
        Err(BackendError::InsecureStoredBackend(stored))
    }
}

/// The account backend for this process: `RYU_SERVER_URL`, then the stored
/// sign-in backend.
pub fn backend_base() -> Result<String, BackendError> {
    resolve_backend_base(
        std::env::var(SERVER_URL_ENV).ok(),
        crate::auth::load_backend_url(),
    )
}

/// Environment override for the control plane, read before `RYU_SERVER_URL` by
/// the control-plane calls made as the signed-in account. Used as given.
pub const CONTROL_PLANE_URL_ENV: &str = "RYU_CONTROL_PLANE_URL";

/// Pure resolution for the control-plane calls made as the signed-in account
/// (the Challenges tools and the profile activity ping): `control_plane_env`
/// (`RYU_CONTROL_PLANE_URL`) when it is set and not blank, else the rules of
/// [`resolve_backend_base`]. There is no default address, and the control plane
/// of a fleet enrollment is not a source: the bearer belongs to the backend the
/// account signed in against.
pub fn resolve_account_api_base(
    control_plane_env: Option<String>,
    server_env: Option<String>,
    stored: Option<String>,
) -> Result<String, BackendError> {
    let explicit = control_plane_env.filter(|value| !value.trim().is_empty());
    resolve_backend_base(explicit.or(server_env), stored)
}

/// The control plane this process calls as the signed-in account:
/// `RYU_CONTROL_PLANE_URL`, then `RYU_SERVER_URL`, then the stored sign-in
/// backend. Blocking: reads the stored backend from disk.
pub fn account_api_base() -> Result<String, BackendError> {
    resolve_account_api_base(
        std::env::var(CONTROL_PLANE_URL_ENV).ok(),
        std::env::var(SERVER_URL_ENV).ok(),
        crate::auth::load_backend_url(),
    )
}

/// Log a missing or refused backend once until a client can be built again.
pub(super) fn note_backend_refused(warned: &mut bool, error: &BackendError) {
    if !*warned {
        tracing::warn!("cloud sync is on but paused, nothing is sent: {error}");
        *warned = true;
    }
}
