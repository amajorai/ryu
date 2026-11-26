//! User identity verification (Phase 0 of the multi-user collaboration epic).
//!
//! This module is the USER-identity layer. It is distinct from two existing
//! concerns that must not be conflated:
//!   - `crate::auth` — node-admittance via the shared `RYU_TOKEN` plus the
//!     device-authorization grant that fetches a control-plane bearer.
//!   - `crate::identity` — the Composio credential vault (a different concern).
//!
//! A normal remote client presents BOTH a node-admittance credential (`RYU_TOKEN`,
//! enforced in `server::require_auth`) AND a Better Auth JWT that carries the
//! verified user identity. An organization-bound managed client may use that
//! verified JWT as its primary bearer because the control plane does not expose a
//! reusable node secret. This module verifies the JWT entirely OFFLINE:
//! Better Auth signs tokens with EdDSA/Ed25519 and publishes its public keys at
//! `{BASE_URL}/api/auth/jwks`; Core caches that key set and validates the
//! signature, expiry, issuer, and audience locally — no live round-trip per
//! request.
//!
//! Security posture (fail-closed throughout):
//!   - EdDSA only. `alg=none` and algorithm confusion are rejected both by an
//!     explicit header check and by `Validation::new(Algorithm::EdDSA)`.
//!   - `exp`, `iss` (== BASE_URL), and `aud` (== BASE_URL) are all validated.
//!   - BASE_URL comes from `issuer`: a loopback one is trusted only on a dev
//!     Core (not managed, enrolled or registered, and listening on loopback).
//!   - The `kid` selects the JWKS key; an unknown `kid` triggers a single
//!     refresh, then denies if still unknown.
//!   - Any verification failure returns an error (the caller is anonymous,
//!     never spoofable-as-privileged).

pub mod permissions;

use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use jsonwebtoken::{
    decode, decode_header,
    jwk::{Jwk, JwkSet},
    Algorithm, DecodingKey, Validation,
};
use serde::Deserialize;
use tokio::sync::RwLock;

mod access;
mod issuer;
mod jwks;
mod mint;
mod types;
mod verify;

pub use access::*;
use issuer::*;
pub use jwks::*;
pub use mint::*;
pub use types::*;
pub use verify::*;

#[cfg(test)]
mod tests;
