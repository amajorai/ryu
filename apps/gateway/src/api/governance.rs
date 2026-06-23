//! Marketplace governance HTTP surface (#468).
//!
//! Three endpoints the control-plane server (publish) and Core (install) call:
//!   POST /v1/grants/validate   → { approved, denied, all_approved }
//!   POST /v1/manifests/sign    → { algorithm, signature, public_key }
//!   POST /v1/manifests/verify  → { valid }
//!   GET  /v1/manifests/pubkey  → { algorithm, public_key }
//!
//! Grant validation fills the seam Core's plugin lifecycle already calls
//! (`apps/core/src/plugins/lifecycle.rs`); the shape `{ approved, denied }`
//! matches what that caller parses. Signing/verify is the manifest-integrity
//! primitive #468 adds: the server signs on publish, Core verifies on install.
//!
//! These are read-only governance computations over caller-supplied data (they
//! mutate no gateway state and expose no secret — only the public key), so they
//! are not behind the master-key admin gate that `config`/`audit` use.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{error::GatewayError, governance, state::SharedState};

// ── grant validation ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ValidateGrantsRequest {
    /// App id requesting the grants (for logging/audit context only).
    #[serde(default)]
    pub app_id: Option<String>,
    /// The permission grant scopes the manifest declares.
    #[serde(default)]
    pub grants: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ValidateGrantsResponse {
    pub approved: Vec<String>,
    pub denied: Vec<String>,
    pub all_approved: bool,
}

/// POST /v1/grants/validate — validate requested grants against gateway policy.
pub async fn validate_grants(
    State(_state): State<SharedState>,
    Json(req): Json<ValidateGrantsRequest>,
) -> Result<Json<ValidateGrantsResponse>, GatewayError> {
    let decision = governance::validate_grants(&req.grants);
    if !decision.all_approved() {
        tracing::info!(
            app_id = req.app_id.as_deref().unwrap_or("?"),
            denied = ?decision.denied,
            "governance: grant validation denied some grants"
        );
    }
    Ok(Json(ValidateGrantsResponse {
        all_approved: decision.all_approved(),
        approved: decision.approved,
        denied: decision.denied,
    }))
}

// ── manifest signing ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SignManifestRequest {
    /// The manifest to sign. Signed over a canonical (key-sorted) encoding so
    /// the signature survives re-serialization across stacks.
    pub manifest: Value,
}

#[derive(Debug, Serialize)]
pub struct SignManifestResponse {
    pub algorithm: &'static str,
    pub signature: String,
    pub public_key: String,
}

/// POST /v1/manifests/sign — sign a manifest with the gateway's ed25519 key.
///
/// Signing is a privileged oracle (it produces a trusted signature over
/// arbitrary caller input), so unlike verify/validate/pubkey it is restricted to
/// loopback peers. The only legitimate caller is the control-plane server on
/// publish, which is co-located on loopback. The gateway can bind `0.0.0.0`
/// (config default), so a network-reachable signing oracle would let anyone get
/// any manifest signed under the trusted key, defeating the point of signing.
pub async fn sign_manifest(
    State(_state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<SignManifestRequest>,
) -> Result<Json<SignManifestResponse>, GatewayError> {
    // Loopback-only, neutralized under mesh (#478, B-9): under userspace
    // networking a tailnet peer appears as 127.0.0.1, so a bare loopback check
    // would expose this trusted signing oracle to the whole tailnet.
    if !peer.ip().is_loopback() || crate::tools::mesh_enabled() {
        return Err(GatewayError::Unauthorized(
            "manifest signing is restricted to loopback callers".to_string(),
        ));
    }
    let signature = governance::sign_manifest(&req.manifest);
    Ok(Json(SignManifestResponse {
        algorithm: governance::SIGNING_ALGORITHM,
        signature,
        public_key: governance::public_key_b64(),
    }))
}

#[derive(Debug, Deserialize)]
pub struct VerifyManifestRequest {
    pub manifest: Value,
    pub signature: String,
    /// Optional base64 public key to verify against. When omitted the gateway's
    /// own key is used (the common case: same gateway signed and verifies).
    #[serde(default)]
    pub public_key: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct VerifyManifestResponse {
    pub valid: bool,
}

/// POST /v1/manifests/verify — verify a manifest signature (the install hook).
pub async fn verify_manifest(
    State(_state): State<SharedState>,
    Json(req): Json<VerifyManifestRequest>,
) -> Result<Json<VerifyManifestResponse>, GatewayError> {
    let valid =
        governance::verify_manifest(&req.manifest, &req.signature, req.public_key.as_deref());
    Ok(Json(VerifyManifestResponse { valid }))
}

#[derive(Debug, Serialize)]
pub struct PubKeyResponse {
    pub algorithm: &'static str,
    pub public_key: String,
}

/// GET /v1/manifests/pubkey — the gateway's public verifying key (no secret).
pub async fn get_pubkey(
    State(_state): State<SharedState>,
) -> Result<Json<PubKeyResponse>, GatewayError> {
    Ok(Json(PubKeyResponse {
        algorithm: governance::SIGNING_ALGORITHM,
        public_key: governance::public_key_b64(),
    }))
}
