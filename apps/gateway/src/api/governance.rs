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
    http::HeaderMap,
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
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<SignManifestRequest>,
) -> Result<Json<SignManifestResponse>, GatewayError> {
    // CSRF defense (F3): the loopback-only gate below authorizes on peer posture
    // alone (no credential), so a browser page could `fetch()` this signing oracle
    // cross-origin against the desktop's own loopback gateway. Reject any request a
    // browser stamped as a cross/same-site fetch; server-side callers (the
    // control-plane publisher, curl) omit `Sec-Fetch-Site` and are unaffected.
    crate::api::config::reject_cross_origin_browser(&headers, "manifest signing")?;
    // Anti–DNS-rebinding (F3): reject a non-loopback `Host`. sign_manifest has no
    // master-key concept — it is loopback-only always — so the Host check is
    // unconditional here. `Host` is a browser-forbidden header, so this rejects a
    // rebinding page (same-origin post-rebind, `Host: evil.com`) that the
    // Sec-Fetch-Site check alone would miss; server-side callers send a loopback Host.
    crate::api::config::reject_non_loopback_host(&headers, "manifest signing")?;
    // Loopback-only, neutralized under mesh (#478, B-9) AND fleet (managed-cloud
    // WS2): under userspace networking a tailnet peer appears as 127.0.0.1, and
    // behind a co-located fleet LB/reverse-proxy an EXTERNAL caller also appears
    // as 127.0.0.1 — either would otherwise expose this trusted signing oracle
    // (external attacker gets any manifest signed under the gateway key, which
    // Core's install-time verify_manifest then trusts). Mirror the admin gate,
    // which drops loopback trust under mesh OR fleet (see admin_loopback_allowed).
    if !peer.ip().is_loopback() || crate::tools::mesh_enabled() || state.config.fleet {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use serde_json::json;
    use std::sync::Arc;

    fn state() -> SharedState {
        Arc::new(AppState::new_for_test_default())
    }

    fn loopback() -> ConnectInfo<SocketAddr> {
        ConnectInfo("127.0.0.1:9999".parse().unwrap())
    }

    #[tokio::test]
    async fn validate_grants_partitions_approved_and_denied() {
        // Mix a clearly-safe grant with a bogus one so we exercise both buckets and
        // the `all_approved` roll-up without pinning the exact allowlist policy.
        let req = ValidateGrantsRequest {
            app_id: Some("com.acme.app".to_string()),
            grants: vec![
                "read:clipboard".to_string(),
                "definitely-not-a-real-grant-xyz".to_string(),
            ],
        };
        let Json(resp) = validate_grants(State(state()), Json(req)).await.unwrap();
        // Every input grant lands in exactly one bucket.
        assert_eq!(resp.approved.len() + resp.denied.len(), 2);
        assert!(resp.denied.contains(&"definitely-not-a-real-grant-xyz".to_string()));
        assert!(!resp.all_approved, "a bogus grant makes all_approved false");
    }

    #[tokio::test]
    async fn sign_then_verify_roundtrips_under_the_gateway_key() {
        let manifest = json!({ "id": "com.acme.app", "version": "1.2.3" });
        let Json(signed) = sign_manifest(
            State(state()),
            loopback(),
            HeaderMap::new(),
            Json(SignManifestRequest {
                manifest: manifest.clone(),
            }),
        )
        .await
        .expect("loopback caller may sign");
        assert_eq!(signed.algorithm, governance::SIGNING_ALGORITHM);
        assert!(!signed.signature.is_empty());

        // The freshly-produced signature verifies against the same key (omitted ⇒
        // gateway's own key).
        let Json(verify) = verify_manifest(
            State(state()),
            Json(VerifyManifestRequest {
                manifest: manifest.clone(),
                signature: signed.signature.clone(),
                public_key: None,
            }),
        )
        .await
        .unwrap();
        assert!(verify.valid, "a genuine signature must verify");

        // Tampering with the manifest invalidates the signature.
        let Json(bad) = verify_manifest(
            State(state()),
            Json(VerifyManifestRequest {
                manifest: json!({ "id": "com.acme.app", "version": "6.6.6" }),
                signature: signed.signature,
                public_key: None,
            }),
        )
        .await
        .unwrap();
        assert!(!bad.valid, "a tampered manifest must fail verification");
    }

    #[tokio::test]
    async fn sign_rejects_non_loopback_callers() {
        let res = sign_manifest(
            State(state()),
            ConnectInfo("8.8.8.8:443".parse().unwrap()),
            HeaderMap::new(),
            Json(SignManifestRequest {
                manifest: json!({ "id": "x" }),
            }),
        )
        .await;
        assert!(
            matches!(res, Err(GatewayError::Unauthorized(_))),
            "a network peer must not reach the signing oracle"
        );
    }

    #[tokio::test]
    async fn sign_rejects_loopback_callers_under_fleet_mode() {
        // Under fleet mode a co-located reverse proxy makes EXTERNAL callers appear
        // as 127.0.0.1, so a bare loopback check would expose the signing oracle to
        // the internet. Mirror the admin gate: drop loopback trust under fleet.
        use crate::config::GatewayConfig;
        use crate::evals::{EvalsConfig, EvalsRunner};
        let config = GatewayConfig {
            fleet: true,
            ..GatewayConfig::default()
        };
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let fleet_state = Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ));
        let res = sign_manifest(
            State(fleet_state),
            loopback(),
            HeaderMap::new(),
            Json(SignManifestRequest {
                manifest: json!({ "id": "x" }),
            }),
        )
        .await;
        assert!(
            matches!(res, Err(GatewayError::Unauthorized(_))),
            "a fleet gateway must not sign for a loopback (LB-fronted) caller"
        );
    }

    #[tokio::test]
    async fn sign_rejects_cross_origin_browser_requests() {
        // CSRF defense (F3): the signing oracle authorizes on loopback posture
        // alone, so a browser page on the user's machine could `fetch()` it
        // cross-origin against the desktop's own gateway to get an arbitrary
        // manifest signed under the trusted key. Browsers stamp `Sec-Fetch-Site`
        // and page JS cannot forge it; a cross-site fetch is never a legitimate
        // signer.
        let mut cross = HeaderMap::new();
        cross.insert("sec-fetch-site", "cross-site".parse().unwrap());
        let res = sign_manifest(
            State(state()),
            loopback(),
            cross,
            Json(SignManifestRequest {
                manifest: json!({ "id": "x" }),
            }),
        )
        .await;
        assert!(
            matches!(res, Err(GatewayError::Unauthorized(_))),
            "a cross-origin browser fetch must not reach the signing oracle"
        );

        // The server-side control-plane publisher omits Sec-Fetch-Site entirely,
        // so a bare loopback caller still signs successfully.
        let res_ok = sign_manifest(
            State(state()),
            loopback(),
            HeaderMap::new(),
            Json(SignManifestRequest {
                manifest: json!({ "id": "x" }),
            }),
        )
        .await;
        assert!(
            res_ok.is_ok(),
            "a server-side loopback caller (no Sec-Fetch-Site) must still sign"
        );
    }

    #[tokio::test]
    async fn get_pubkey_returns_algorithm_and_key_without_secret() {
        let Json(resp) = get_pubkey(State(state())).await.unwrap();
        assert_eq!(resp.algorithm, governance::SIGNING_ALGORITHM);
        assert!(!resp.public_key.is_empty());
    }
}
