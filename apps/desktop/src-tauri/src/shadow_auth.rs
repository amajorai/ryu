//! Shadow API bearer resolution for the desktop's own (Rust-side) Shadow calls.
//!
//! Shadow's HTTP surface is bearer-gated (`apps/shadow/src/server.rs`:
//! everything except `/health` requires a shared secret). Native clients read
//! the same persisted token Shadow resolves: `SHADOW_API_TOKEN` env first
//! (operator override), then the token file Core mints/injects at spawn
//! (`<data dir>/services/shadow/api-token`, mirroring Core's
//! `sidecar/tools/shadow::api_token`).
//!
//! The token is never attached blindly. Any local process can bind Shadow's
//! port while Shadow is down, so [`send_verified`] first runs the loopback peer
//! proof (`ryu_sidecar_runtime::peer_proof`): the listener must answer a fresh
//! `/health?challenge=...` with an HMAC proof that it holds the token. A
//! listener that cannot prove it, or a missing token, fails the call before
//! anything is sent, and callers degrade like an absent Shadow.

use std::path::PathBuf;
use std::time::Duration;

use ryu_sidecar_runtime::peer_proof::{send_with_verified_bearer, ProofCache};

/// The desktop's recent Shadow proof, so a burst of calls (the companion poll,
/// the tray's read-then-write toggle) does not re-challenge Shadow each time.
static SHADOW_PEER_PROOF: ProofCache = ProofCache::new(Duration::from_secs(2));

/// The persisted token file: `<data dir>/services/shadow/api-token`, with the
/// data dir resolved like Core (`RYU_DIR` > Storage pointer > profile default).
fn token_path() -> PathBuf {
    ryu_sidecar_runtime::layout::service_dir(&crate::profile::ryu_home_dir(), "shadow")
        .join("api-token")
}

/// Resolve the Shadow API token, or `None` when unavailable.
pub fn api_token() -> Option<String> {
    if let Ok(env_token) = std::env::var("SHADOW_API_TOKEN") {
        let trimmed = env_token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    let existing = std::fs::read_to_string(token_path()).ok()?;
    let trimmed = existing.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// Send `req` to Shadow with its bearer, but only once the listener at the
/// request's origin proved it holds the token. Fails closed: with no token, or
/// a listener that gives no valid proof, nothing is sent and the error says
/// why.
pub async fn send_verified(req: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let token = api_token().ok_or_else(|| {
        "no Shadow API token found (SHADOW_API_TOKEN or services/shadow/api-token); \
         nothing was sent to Shadow"
            .to_owned()
    })?;
    send_with_verified_bearer(req, &token, &SHADOW_PEER_PROOF)
        .await
        .map_err(|error| format!("Shadow request not sent or failed: {error}"))
}
