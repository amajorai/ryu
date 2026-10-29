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
//! Validate/verify/pubkey are read-only governance computations over
//! caller-supplied data (they mutate no gateway state and expose no secret —
//! only the public key), so they are not behind the master-key admin gate that
//! `config`/`audit` use. Signing is the exception: it is a trusted-signature
//! oracle, so it always requires the master key (a keyless gateway cannot sign).

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    error::GatewayError,
    governance,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

// ── grant validation ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ValidateGrantsRequest {
    /// Manifest id of the app requesting the grants. **Load-bearing**, not just
    /// log context: it is the subject of the capability grammar's owner-scoped
    /// rule (`@ryu/monitors` may self-grant `monitors:*`). Absent ⇒ the
    /// grammar falls back to allowlist-only, which is the fail-closed direction.
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
///
/// `app_id` is forwarded into the decision (not merely logged): the capability
/// grammar approves a scope in the requesting app's *own* namespace without an
/// allowlist entry, which is what lets a third-party app enable at all. Host
/// primitives stay gated on the reviewed allowlist regardless of who asks.
pub async fn validate_grants(
    State(_state): State<SharedState>,
    Json(req): Json<ValidateGrantsRequest>,
) -> Result<Json<ValidateGrantsResponse>, GatewayError> {
    let decision = governance::validate_grants_for(req.app_id.as_deref(), &req.grants);
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
/// arbitrary caller input), so unlike verify/validate/pubkey it requires the
/// Gateway master/admin credential (`Authorization: Bearer <master>`):
///
/// - **the master key authorizes it from any peer and in any mode.** Signing is
///   an administrator operation like `/v1/config` and `/v1/audit`, which the
///   master key already governs from any peer, so the control-plane publisher
///   can sign against a hosted (fleet) Gateway over TLS.
/// - **loopback is never proof of identity.** Any co-resident process —
///   including a sandboxed plugin granted `127.0.0.1` HTTP egress — or an
///   external caller behind a same-host reverse proxy also arrives as
///   127.0.0.1, so the keyless zero-config loopback allowance of
///   `require_local_admin` is deliberately NOT extended to the signing oracle.
///
/// A gateway with no master key provisioned cannot sign at all (fail closed).
pub async fn sign_manifest(
    State(state): State<SharedState>,
    ConnectInfo(_peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<SignManifestRequest>,
) -> Result<Json<SignManifestResponse>, GatewayError> {
    // CSRF defense (F3): reject any request a browser stamped as a cross/same-site
    // fetch. Server-side callers (the control-plane publisher, curl) omit
    // `Sec-Fetch-Site` and are unaffected; no legitimate signer is a browser page.
    crate::api::config::reject_cross_origin_browser(&headers, "manifest signing")?;
    // Credential gate: loopback is a location, not an identity. Require the
    // master/admin key the way the batch/admin surfaces do, from any peer and in
    // any mode (fleet, mesh); a keyless gateway has no master key, so it refuses.
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    if !ctx.is_master_key {
        return Err(GatewayError::Unauthorized(
            "manifest signing requires the Gateway master key".to_string(),
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

    const MASTER: &str = "gwadm_signing_fixture_0123456789abcdef";

    /// A gateway with a provisioned master key (the shape every managed or
    /// deployed signing gateway has).
    fn master_state() -> SharedState {
        let mut config = crate::config::GatewayConfig::default();
        config.auth.master_key = Some(MASTER.to_owned());
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let evals = crate::evals::EvalsRunner::new(config.evals.clone());
        Arc::new(AppState::new_for_test(config, audit, evals))
    }

    fn master_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {MASTER}").parse().unwrap());
        headers
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
        assert!(resp
            .denied
            .contains(&"definitely-not-a-real-grant-xyz".to_string()));
        assert!(!resp.all_approved, "a bogus grant makes all_approved false");
    }

    #[tokio::test]
    async fn sign_then_verify_roundtrips_under_the_gateway_key() {
        let manifest = json!({ "id": "com.acme.app", "version": "1.2.3" });
        let Json(signed) = sign_manifest(
            State(master_state()),
            loopback(),
            master_headers(),
            Json(SignManifestRequest {
                manifest: manifest.clone(),
            }),
        )
        .await
        .expect("a loopback caller holding the master key may sign");
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
        // so a loopback caller presenting the master key still signs.
        let res_ok = sign_manifest(
            State(master_state()),
            loopback(),
            master_headers(),
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

    /// With a master key configured, a bare loopback caller (a co-resident
    /// process, or an external caller behind a same-host proxy that rewrote
    /// `Host`) cannot mint signatures; only the master key can.
    #[tokio::test]
    async fn sign_requires_the_master_key_when_one_is_configured() {
        use crate::config::GatewayConfig;
        use crate::evals::{EvalsConfig, EvalsRunner};
        let mut config = GatewayConfig::default();
        config.auth.master_key = Some("gwadm_signing_test_0123456789abcdef".to_owned());
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let keyed = Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ));
        for (credential, allowed) in [
            (None, false),
            (Some("Bearer wrong"), false),
            (Some("Bearer gwadm_signing_test_0123456789abcdef"), true),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("host", "127.0.0.1:7981".parse().unwrap());
            if let Some(credential) = credential {
                headers.insert("authorization", credential.parse().unwrap());
            }
            let res = sign_manifest(
                State(keyed.clone()),
                loopback(),
                headers,
                Json(SignManifestRequest {
                    manifest: json!({ "id": "x", "grants": ["shell:exec"] }),
                }),
            )
            .await;
            if allowed {
                assert!(res.is_ok(), "the master key may sign");
            } else {
                assert!(
                    matches!(res, Err(GatewayError::Unauthorized(_))),
                    "{credential:?} must not reach the signing oracle"
                );
            }
        }
    }

    /// The master key is the administrator credential, so the control-plane
    /// publisher may sign against a hosted (fleet) Gateway from the network with
    /// a public `Host`; without it the same request is refused.
    #[tokio::test]
    async fn the_master_key_signs_from_any_peer_including_fleet_mode() {
        use crate::config::GatewayConfig;
        use crate::evals::{EvalsConfig, EvalsRunner};
        let mut config = GatewayConfig {
            fleet: true,
            ..GatewayConfig::default()
        };
        config.auth.master_key = Some("gwadm_fleet_signing_0123456789abcdef".to_owned());
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let fleet = Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ));
        for (credential, allowed) in [
            (None, false),
            (Some("Bearer wrong"), false),
            (Some("Bearer gwadm_fleet_signing_0123456789abcdef"), true),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("host", "gateway.example.com".parse().unwrap());
            if let Some(credential) = credential {
                headers.insert("authorization", credential.parse().unwrap());
            }
            let res = sign_manifest(
                State(fleet.clone()),
                ConnectInfo("203.0.113.7:443".parse().unwrap()),
                headers,
                Json(SignManifestRequest {
                    manifest: json!({ "id": "x" }),
                }),
            )
            .await;
            if allowed {
                assert!(res.is_ok(), "the master key signs from the network");
            } else {
                assert!(
                    matches!(res, Err(GatewayError::Unauthorized(_))),
                    "{credential:?} must not reach the signing oracle"
                );
            }
        }
    }

    #[tokio::test]
    async fn sign_requires_the_master_key_even_from_loopback() {
        // A local process (e.g. a plugin granted 127.0.0.1 HTTP egress) is a
        // loopback peer; without the master key it must not mint signatures,
        // whether the gateway has no master key (zero-config) or a different one.
        for (state, headers) in [
            (state(), HeaderMap::new()),
            (master_state(), HeaderMap::new()),
            (master_state(), {
                let mut wrong = HeaderMap::new();
                wrong.insert("authorization", "Bearer not-the-master".parse().unwrap());
                wrong
            }),
        ] {
            let res = sign_manifest(
                State(state),
                loopback(),
                headers,
                Json(SignManifestRequest {
                    manifest: json!({ "id": "x" }),
                }),
            )
            .await;
            assert!(
                matches!(res, Err(GatewayError::Unauthorized(_))),
                "a keyless loopback caller must not reach the signing oracle"
            );
        }
    }

    #[tokio::test]
    async fn get_pubkey_returns_algorithm_and_key_without_secret() {
        let Json(resp) = get_pubkey(State(state())).await.unwrap();
        assert_eq!(resp.algorithm, governance::SIGNING_ALGORITHM);
        assert!(!resp.public_key.is_empty());
    }
}
