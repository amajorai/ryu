//! Shadow API bearer resolution for the desktop's own (Rust-side) Shadow calls.
//!
//! Shadow's HTTP surface is bearer-gated (`apps/shadow/src/server.rs`:
//! everything except `/health` requires a shared secret). Native clients read
//! the same persisted token Shadow resolves: `SHADOW_API_TOKEN` env first
//! (operator override), then the token file Core mints/injects at spawn
//! (`<ryu-dir>/shadow/api-token` — profile-aware, mirroring Core's
//! `sidecar/tools/shadow::api_token`), then the standalone default
//! `~/.shadow/api-token` (a dev-started `shadow start` with no
//! `SHADOW_DATA_DIR`). `None` = no token found; Shadow will reject the call
//! (fail closed) and callers degrade like an absent Shadow.

use std::path::PathBuf;

/// The persisted token file candidates, in resolution order.
fn token_paths() -> Vec<PathBuf> {
	let mut paths = Vec::new();
	// Core honours an explicit RYU_DIR override before the profile default; read
	// the same location so a relocated data dir still resolves the token.
	if let Ok(dir) = std::env::var("RYU_DIR") {
		let dir = dir.trim();
		if !dir.is_empty() {
			paths.push(PathBuf::from(dir).join("shadow").join("api-token"));
		}
	}
	paths.push(crate::profile::ryu_home_dir().join("shadow").join("api-token"));
	if let Some(home) = dirs::home_dir() {
		paths.push(home.join(".shadow").join("api-token"));
	}
	paths
}

/// Resolve the Shadow API token, or `None` when unavailable.
pub fn api_token() -> Option<String> {
	if let Ok(env_token) = std::env::var("SHADOW_API_TOKEN") {
		let trimmed = env_token.trim();
		if !trimmed.is_empty() {
			return Some(trimmed.to_owned());
		}
	}
	for path in token_paths() {
		if let Ok(existing) = std::fs::read_to_string(&path) {
			let trimmed = existing.trim();
			if !trimmed.is_empty() {
				return Some(trimmed.to_owned());
			}
		}
	}
	None
}

/// Attach the Shadow bearer to a request when a token is available.
pub fn with_auth(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
	match api_token() {
		Some(token) => req.bearer_auth(token),
		None => req,
	}
}
