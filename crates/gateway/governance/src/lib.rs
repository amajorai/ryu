//! Marketplace governance crypto core: grant-allowlist matching + ed25519
//! manifest signing / verification (#468, ties #450).
//!
//! This crate holds the **pure** governance primitives — everything that
//! operates over caller-supplied data and *explicit* keys / allowlists, with no
//! env, disk, or process-global state:
//!
//!   - **Grant validation** ([`validate_grants`]): match a manifest's requested
//!     permission grants against an *explicit* allowlist, returning
//!     `{ approved, denied }`. The allowlist *policy* (the built-in default and
//!     the `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override) is resolved by the
//!     gateway wiring and passed in.
//!
//!   - **Manifest signing** ([`sign_manifest`] / [`verify_manifest`]): sign and
//!     verify over a canonicalized (recursively key-sorted) JSON encoding, so a
//!     faithfully-preserved manifest verifies even after a Mongo / JSON
//!     round-trip. Both take an *explicit* `SigningKey` / `VerifyingKey`; the
//!     gateway owns the key custody (env source-of-truth + dev-persisted disk
//!     key) and passes the resolved key in.
//!
//! The signing-key custody path (`RYU_MARKETPLACE_SIGNING_KEY` resolution, the
//! dev-persisted on-disk key, the process `OnceLock`) and the default grant
//! allowlist stay in `apps/gateway/src/governance/mod.rs` — the marketplace
//! trust root, kept where the secret is custodied. This crate is the crypto it
//! calls. Behavior is identical: the gateway wrappers resolve the key/allowlist
//! and delegate here.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey, SECRET_KEY_LENGTH};
use serde_json::{Map, Value};

/// The signing algorithm advertised in responses and stored alongside a
/// signature. Stable identifier so clients/verifiers can branch on it.
pub const SIGNING_ALGORITHM: &str = "ed25519";

// ── grant validation ──────────────────────────────────────────────────────────

/// Outcome of validating a manifest's requested grants against gateway policy.
pub struct GrantDecision {
    pub approved: Vec<String>,
    pub denied: Vec<String>,
}

impl GrantDecision {
    pub fn all_approved(&self) -> bool {
        self.denied.is_empty()
    }
}

/// Validate the requested grants against an explicit allowlist. A grant not on
/// the allowlist is denied. Matching is case-insensitive on the trimmed scope
/// string. An empty request approves trivially. The allowlist *policy* (default
/// set + env override) is resolved by the gateway and passed in.
pub fn validate_grants(grants: &[String], allowlist: &[String]) -> GrantDecision {
    let allowed = |g: &str| allowlist.iter().any(|a| a.eq_ignore_ascii_case(g.trim()));

    let mut approved = Vec::new();
    let mut denied = Vec::new();
    for g in grants {
        let scope = g.trim();
        if scope.is_empty() {
            continue;
        }
        if allowed(scope) {
            approved.push(scope.to_string());
        } else {
            denied.push(scope.to_string());
        }
    }
    GrantDecision { approved, denied }
}

// ── signing ─────────────────────────────────────────────────────────────────

/// Parse a base64-encoded 32-byte ed25519 seed into a signing key.
pub fn signing_key_from_seed(b64: &str) -> Option<SigningKey> {
    let bytes = B64.decode(b64).ok()?;
    let seed: [u8; SECRET_KEY_LENGTH] = bytes.try_into().ok()?;
    Some(SigningKey::from_bytes(&seed))
}

/// Parse a base64-encoded 32-byte ed25519 public key into a verifying key.
/// Returns `None` on malformed base64, wrong length, or an invalid point — the
/// caller then treats a signature as unverifiable (`false`).
pub fn verifying_key_from_b64(b64: &str) -> Option<VerifyingKey> {
    let pk_bytes = B64.decode(b64).ok()?;
    let pk_arr = <[u8; 32]>::try_from(pk_bytes.as_slice()).ok()?;
    VerifyingKey::from_bytes(&pk_arr).ok()
}

/// The base64-encoded form of a verifying key, exposed so clients can pin it.
pub fn public_key_b64(key: &VerifyingKey) -> String {
    B64.encode(key.to_bytes())
}

/// Sign a manifest, returning the base64-encoded ed25519 signature over the
/// canonicalized manifest bytes. The signing key is supplied by the caller (the
/// gateway resolves it from env / dev-persisted disk custody).
pub fn sign_manifest(key: &SigningKey, manifest: &Value) -> String {
    let bytes = canonical_bytes(manifest);
    let sig = key.sign(&bytes);
    B64.encode(sig.to_bytes())
}

/// Verify a base64 signature against a manifest with an *explicit* verifying
/// key. A tampered manifest or a wrong key returns `false`. The gateway wrapper
/// resolves the verifying key (a caller-pinned public key, else the process
/// key) and passes it in.
pub fn verify_manifest(
    manifest: &Value,
    signature_b64: &str,
    verifying_key: &VerifyingKey,
) -> bool {
    let Ok(sig_bytes) = B64.decode(signature_b64) else {
        return false;
    };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig_bytes.as_slice()) else {
        return false;
    };
    let signature = Signature::from_bytes(&sig_arr);

    let bytes = canonical_bytes(manifest);
    verifying_key.verify(&bytes, &signature).is_ok()
}

/// Canonicalize a JSON value into deterministic bytes: object keys recursively
/// sorted, no insignificant whitespace. This makes the signed representation
/// independent of key ordering introduced by Mongo storage or JSON
/// re-serialization across stacks, so a faithfully-preserved manifest verifies
/// even after a round-trip.
pub fn canonical_bytes(value: &Value) -> Vec<u8> {
    let canonical = canonicalize(value);
    serde_json::to_vec(&canonical).unwrap_or_default()
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: Vec<(&String, &Value)> = map.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(b.0));
            let mut out = Map::new();
            for (k, v) in sorted {
                out.insert(k.clone(), canonicalize(v));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    fn test_key() -> SigningKey {
        // Deterministic in-test key (the gateway owns real key custody).
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn validate_grants_approves_allowlisted() {
        let allow = vec!["mcp.tools".to_string(), "memory.read".to_string()];
        let d = validate_grants(
            &["mcp.tools".to_string(), "memory.read".to_string()],
            &allow,
        );
        assert!(d.all_approved());
        assert_eq!(d.approved.len(), 2);
        assert!(d.denied.is_empty());
    }

    #[test]
    fn validate_grants_denies_unlisted_and_is_case_insensitive() {
        let allow = vec!["mcp.tools".to_string()];
        let d = validate_grants(
            &["MCP.Tools".to_string(), "filesystem.write_all".to_string()],
            &allow,
        );
        assert!(!d.all_approved());
        assert_eq!(d.denied, vec!["filesystem.write_all".to_string()]);
        assert_eq!(d.approved, vec!["MCP.Tools".to_string()]);
    }

    #[test]
    fn validate_grants_skips_empty_scopes() {
        let allow = vec!["mcp.tools".to_string()];
        let d = validate_grants(&["".to_string(), "  ".to_string()], &allow);
        assert!(d.all_approved());
        assert!(d.approved.is_empty());
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let key = test_key();
        let manifest = json!({"id": "acme/widget", "version": "1.0.0", "grants": ["mcp.tools"]});
        let sig = sign_manifest(&key, &manifest);
        assert!(verify_manifest(&manifest, &sig, &key.verifying_key()));
    }

    #[test]
    fn verify_is_order_independent() {
        // Same content, different key order — must still verify (canonicalized).
        let key = test_key();
        let a = json!({"id": "x", "version": "1.0.0", "nested": {"b": 2, "a": 1}});
        let b = json!({"version": "1.0.0", "nested": {"a": 1, "b": 2}, "id": "x"});
        let sig = sign_manifest(&key, &a);
        assert!(verify_manifest(&b, &sig, &key.verifying_key()));
    }

    #[test]
    fn tampered_manifest_fails_verify() {
        let key = test_key();
        let manifest = json!({"id": "acme/widget", "version": "1.0.0"});
        let sig = sign_manifest(&key, &manifest);
        let tampered = json!({"id": "acme/widget", "version": "9.9.9"});
        assert!(!verify_manifest(&tampered, &sig, &key.verifying_key()));
    }

    #[test]
    fn wrong_key_fails_verify() {
        let key = test_key();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let manifest = json!({"id": "x"});
        let sig = sign_manifest(&key, &manifest);
        assert!(!verify_manifest(&manifest, &sig, &other.verifying_key()));
    }

    #[test]
    fn malformed_signature_fails_verify() {
        let key = test_key();
        let manifest = json!({"id": "x"});
        assert!(!verify_manifest(
            &manifest,
            "not-base64!!!",
            &key.verifying_key()
        ));
        assert!(!verify_manifest(
            &manifest,
            &B64.encode([0u8; 10]),
            &key.verifying_key()
        ));
    }

    #[test]
    fn seed_roundtrip_parses() {
        let seed = [7u8; 32];
        let b64 = B64.encode(seed);
        assert!(signing_key_from_seed(&b64).is_some());
        assert!(signing_key_from_seed("not-base64!!!").is_none());
        // Wrong length is rejected.
        assert!(signing_key_from_seed(&B64.encode([0u8; 16])).is_none());
    }

    #[test]
    fn verifying_key_from_b64_parses_and_rejects_malformed() {
        let key = test_key();
        let pk = public_key_b64(&key.verifying_key());
        assert!(verifying_key_from_b64(&pk).is_some());
        assert!(verifying_key_from_b64("not-base64!!!").is_none());
        assert!(verifying_key_from_b64(&B64.encode([0u8; 16])).is_none());
    }

    #[test]
    fn public_key_b64_roundtrips_through_verifying_key_from_b64() {
        let key = test_key();
        let pk = public_key_b64(&key.verifying_key());
        let parsed = verifying_key_from_b64(&pk).expect("parse pubkey");
        assert_eq!(parsed.to_bytes(), key.verifying_key().to_bytes());
    }
}
