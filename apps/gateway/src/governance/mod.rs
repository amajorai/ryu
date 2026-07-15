//! Marketplace governance: grant validation + manifest signing (#468, ties #450).
//!
//! CLAUDE.md §1 places "what is allowed/shared/measured/paid for" in the
//! Gateway. Publishing an App to the Ryu Marketplace is a *governed* action, so
//! the two governance primitives it needs live here, reached over HTTP by the
//! control-plane server (publish) and by Core (verify-on-install):
//!
//!   - **Grant validation** (`validate_grants`): the manifest declares the
//!     permission grants it wants (tool/capability scopes). The Gateway checks
//!     them against its grant policy and returns `{ approved, denied }`. A
//!     non-empty `denied` blocks publish. This fills the seam Core's plugin
//!     lifecycle already calls (`POST /v1/grants/validate`,
//!     `apps/core/src/plugins/lifecycle.rs`), which until now only had a
//!     `RYU_STUB_GRANT_VALIDATION` allow-all stub on the Core side.
//!
//!   - **Manifest signing** (`sign_manifest` / `verify_manifest`): the Gateway
//!     owns the signing key (ed25519). On publish it signs the manifest; on
//!     install Core asks the Gateway to verify the signature, so a manifest
//!     tampered with anywhere along TS -> Mongo -> Core is rejected.
//!
//! Both sign and verify canonicalize the manifest (recursively sorted object
//! keys) before hashing, so re-serialization across the stack (Mongo, JSON
//! round-trips) never changes the signed bytes. Doing both here keeps one
//! canonicalization code path.

use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey, SECRET_KEY_LENGTH};
use serde_json::{Map, Value};

/// Env var holding the ed25519 signing seed (32-byte secret), base64-encoded.
/// The production source of truth: set it and every gateway replica signs with
/// the same key, so signatures survive restarts and horizontal scale. When
/// unset the Gateway falls back to a **dev-persisted** key on disk (see
/// [`signing_key`]) so signatures still survive a local restart. No secret is
/// ever in code.
const ENV_SIGNING_KEY: &str = "RYU_MARKETPLACE_SIGNING_KEY";

/// Optional override for the on-disk dev-persisted signing key path. When unset
/// the key lives at `$XDG_DATA_HOME/ryu/marketplace-signing-key` (mirrors the
/// audit db location in `config.rs`). Only consulted when `ENV_SIGNING_KEY` is
/// unset. No secret is ever in code.
const ENV_SIGNING_KEY_PATH: &str = "RYU_MARKETPLACE_SIGNING_KEY_PATH";

/// The signing algorithm advertised in responses and stored alongside a
/// signature. Stable identifier so clients/verifiers can branch on it.
pub const SIGNING_ALGORITHM: &str = "ed25519";

/// Env var holding a comma/whitespace-separated allowlist of permission grants
/// the marketplace will approve. When unset a sensible built-in default
/// allowlist is used (see [`default_grant_allowlist`]). A grant not on the
/// allowlist is denied, which blocks publish.
const ENV_GRANT_ALLOWLIST: &str = "RYU_MARKETPLACE_GRANT_ALLOWLIST";

/// Built-in default grant allowlist. These mirror the capability scopes a
/// first-party App declares in its `ryu.json` `permission_grants`. Anything
/// outside this set is denied so an over-privileged manifest cannot publish.
fn default_grant_allowlist() -> Vec<String> {
    [
        // tool / MCP capability scopes
        "mcp.tools",
        "tools.read",
        "tools.invoke",
        // data scopes
        "memory.read",
        "memory.write",
        "spaces.read",
        "spaces.write",
        "files.read",
        // model / network scopes
        "model.chat",
        "model.embed",
        "network.fetch",
        // identity-vault scopes (#523): a connection-capture flow and a sealed
        // credential read. Like every scope here they stay swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "browser.connect",
        "identity.read",
        // Widget-render consent: a plugin (built-in Ryu App or third-party MCP
        // server) that declares a `contributes.widgets[]` binding must hold this
        // grant for its tool to auto-promote a sandboxed widget into chat. Gated
        // in Core at the single widget-emit choke point; on the allowlist here so
        // the lifecycle enable path (`/v1/grants/validate`) approves it instead of
        // denying a widget-bearing plugin at enable.
        "widget:render",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

/// Resolve the active grant allowlist from env, falling back to the built-in
/// default. Cached for the process lifetime.
fn grant_allowlist() -> &'static Vec<String> {
    static ALLOWLIST: OnceLock<Vec<String>> = OnceLock::new();
    ALLOWLIST.get_or_init(|| match std::env::var(ENV_GRANT_ALLOWLIST) {
        Ok(raw) if !raw.trim().is_empty() => raw
            .split([',', ' ', '\n', '\t'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        _ => default_grant_allowlist(),
    })
}

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

/// Validate the requested grants against the gateway's allowlist. A grant not
/// on the allowlist is denied. Matching is case-insensitive on the trimmed
/// scope string. An empty request approves trivially.
pub fn validate_grants(grants: &[String]) -> GrantDecision {
    let allow = grant_allowlist();
    let allowed = |g: &str| allow.iter().any(|a| a.eq_ignore_ascii_case(g.trim()));

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

// ── Signing ─────────────────────────────────────────────────────────────────

/// Resolve the process signing key, in priority order:
///   1. `RYU_MARKETPLACE_SIGNING_KEY` env (base64 32-byte seed) — the production
///      source of truth. Stable across restarts and across replicas.
///   2. A dev-persisted key file (`$XDG_DATA_HOME/ryu/marketplace-signing-key`,
///      or `RYU_MARKETPLACE_SIGNING_KEY_PATH`): read it if present, else
///      generate a fresh key AND write it there so it is stable across local
///      restarts. This is what closes the "signatures die on every bounce" gap
///      for a managed local gateway where no env key is configured.
///   3. Only if disk persistence is impossible (no data dir / write fails) do we
///      fall back to an ephemeral key, and we say so loudly.
///
/// The public half is always discoverable via [`public_key_b64`] (same process
/// key), which is how the verify side (`POST /v1/manifests/verify` with no
/// pinned `public_key`) checks a signature — so a persistent private key gives a
/// persistent public key and prior signatures keep verifying.
fn signing_key() -> &'static SigningKey {
    static KEY: OnceLock<SigningKey> = OnceLock::new();
    KEY.get_or_init(|| {
        // 1. Configured production key (env).
        if let Ok(raw) = std::env::var(ENV_SIGNING_KEY) {
            if let Some(key) = signing_key_from_seed(raw.trim()) {
                tracing::info!(
                    "governance: marketplace signing key configured from {ENV_SIGNING_KEY} (production)"
                );
                return key;
            }
            tracing::warn!(
                "governance: {ENV_SIGNING_KEY} set but not a valid base64 32-byte seed; falling back to a dev-persisted key"
            );
        }

        // 2. Dev-persisted key on disk (read existing, else generate + persist).
        if let Some(path) = signing_key_path() {
            if let Some(key) = read_persisted_signing_key(&path) {
                tracing::info!(
                    path = %path.display(),
                    public_key = %B64.encode(key.verifying_key().to_bytes()),
                    "governance: loaded dev-persisted marketplace signing key (set {ENV_SIGNING_KEY} for production)"
                );
                return key;
            }
            let mut csprng = rand::rngs::OsRng;
            let key = SigningKey::generate(&mut csprng);
            if persist_signing_key(&path, &key) {
                tracing::warn!(
                    path = %path.display(),
                    public_key = %B64.encode(key.verifying_key().to_bytes()),
                    "governance: generated and PERSISTED a dev marketplace signing key (stable across restarts; set {ENV_SIGNING_KEY} for production)"
                );
                return key;
            }
            tracing::error!(
                path = %path.display(),
                "governance: could not persist a dev signing key; using EPHEMERAL key (signatures will NOT survive restart — set {ENV_SIGNING_KEY})"
            );
            return key;
        }

        // 3. No data dir at all — ephemeral, loudly.
        tracing::error!(
            "governance: no data dir for a persisted signing key; using EPHEMERAL key (signatures will NOT survive restart — set {ENV_SIGNING_KEY})"
        );
        let mut csprng = rand::rngs::OsRng;
        SigningKey::generate(&mut csprng)
    })
}

/// Resolve the on-disk path for the dev-persisted signing key: the
/// `RYU_MARKETPLACE_SIGNING_KEY_PATH` override, else
/// `$XDG_DATA_HOME/ryu/marketplace-signing-key` (mirrors the audit db location).
/// `None` when no data dir can be resolved.
fn signing_key_path() -> Option<std::path::PathBuf> {
    if let Ok(raw) = std::env::var(ENV_SIGNING_KEY_PATH) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(std::path::PathBuf::from(trimmed));
        }
    }
    dirs::data_local_dir().map(|d| d.join("ryu").join("marketplace-signing-key"))
}

/// Read a base64 32-byte seed from the persisted key file, if it exists and
/// parses. Any read/parse error returns `None` (the caller then regenerates).
fn read_persisted_signing_key(path: &std::path::Path) -> Option<SigningKey> {
    let raw = std::fs::read_to_string(path).ok()?;
    signing_key_from_seed(raw.trim())
}

/// Persist a signing key's 32-byte seed (base64) to `path`, creating parent
/// directories. Returns `true` on success. Never panics.
///
/// On Unix the file is created **atomically at mode `0600`** via an owner-only
/// `open` (not written-then-chmod'd), so the private seed is never observable at
/// a permissive umask, and the parent directory is tightened to `0700`. Closing
/// the write-then-chmod TOCTOU window matters because this is an ed25519 signing
/// key — a brief world-readable moment is a real disclosure.
fn persist_signing_key(path: &std::path::Path, key: &SigningKey) -> bool {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Best-effort: the file itself is created 0600 below regardless, so a
            // failure to tighten the dir is not fatal — but do it so the key is
            // not readable via a permissive parent.
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let seed_b64 = B64.encode(key.to_bytes());

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = match opts.open(path) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "governance: could not create persisted signing key file");
            return false;
        }
    };
    use std::io::Write;
    if let Err(e) = file.write_all(seed_b64.as_bytes()) {
        tracing::warn!(path = %path.display(), error = %e, "governance: could not write persisted signing key");
        return false;
    }
    true
}

/// Parse a base64-encoded 32-byte ed25519 seed into a signing key.
fn signing_key_from_seed(b64: &str) -> Option<SigningKey> {
    let bytes = B64.decode(b64).ok()?;
    let seed: [u8; SECRET_KEY_LENGTH] = bytes.try_into().ok()?;
    Some(SigningKey::from_bytes(&seed))
}

/// The base64-encoded public verifying key, exposed so clients can pin it.
pub fn public_key_b64() -> String {
    B64.encode(signing_key().verifying_key().to_bytes())
}

/// Sign a manifest, returning the base64-encoded ed25519 signature over the
/// canonicalized manifest bytes.
pub fn sign_manifest(manifest: &Value) -> String {
    let bytes = canonical_bytes(manifest);
    let sig = signing_key().sign(&bytes);
    B64.encode(sig.to_bytes())
}

/// Verify a base64 signature against a manifest. When `public_key_b64` is
/// `None` the process key is used (the common case: same Gateway signed and
/// verifies). A tampered manifest or a wrong key returns `false`.
pub fn verify_manifest(
    manifest: &Value,
    signature_b64: &str,
    public_key_b64: Option<&str>,
) -> bool {
    let Ok(sig_bytes) = B64.decode(signature_b64) else {
        return false;
    };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig_bytes.as_slice()) else {
        return false;
    };
    let signature = Signature::from_bytes(&sig_arr);

    let verifying_key = match public_key_b64 {
        Some(pk) => {
            let Ok(pk_bytes) = B64.decode(pk) else {
                return false;
            };
            let Ok(pk_arr) = <[u8; 32]>::try_from(pk_bytes.as_slice()) else {
                return false;
            };
            match VerifyingKey::from_bytes(&pk_arr) {
                Ok(k) => k,
                Err(_) => return false,
            }
        }
        None => signing_key().verifying_key(),
    };

    let bytes = canonical_bytes(manifest);
    verifying_key.verify(&bytes, &signature).is_ok()
}

/// Canonicalize a JSON value into deterministic bytes: object keys recursively
/// sorted, no insignificant whitespace. This makes the signed representation
/// independent of key ordering introduced by Mongo storage or JSON
/// re-serialization across stacks, so a faithfully-preserved manifest verifies
/// even after a round-trip.
fn canonical_bytes(value: &Value) -> Vec<u8> {
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
    use serde_json::json;

    #[test]
    fn default_allowlist_approves_known_grant() {
        let d = validate_grants(&["mcp.tools".to_string(), "memory.read".to_string()]);
        assert!(d.all_approved());
        assert_eq!(d.approved.len(), 2);
        assert!(d.denied.is_empty());
    }

    #[test]
    fn unknown_grant_is_denied_and_blocks() {
        let d = validate_grants(&["mcp.tools".to_string(), "filesystem.write_all".to_string()]);
        assert!(!d.all_approved());
        assert_eq!(d.denied, vec!["filesystem.write_all".to_string()]);
        assert_eq!(d.approved, vec!["mcp.tools".to_string()]);
    }

    #[test]
    fn empty_grants_approve() {
        let d = validate_grants(&[]);
        assert!(d.all_approved());
    }

    #[test]
    fn identity_vault_scopes_are_approved() {
        // #523: the identity-vault grant scopes must be on the built-in allowlist
        // so a credential-read/connect flow is governed, not denied.
        let d = validate_grants(&["browser.connect".to_string(), "identity.read".to_string()]);
        assert!(d.all_approved());
        assert_eq!(d.approved.len(), 2);
        assert!(d.denied.is_empty());
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let manifest = json!({"id": "acme/widget", "version": "1.0.0", "grants": ["mcp.tools"]});
        let sig = sign_manifest(&manifest);
        assert!(verify_manifest(&manifest, &sig, None));
    }

    #[test]
    fn verify_is_order_independent() {
        // Same content, different key order — must still verify (canonicalized).
        let a = json!({"id": "x", "version": "1.0.0", "nested": {"b": 2, "a": 1}});
        let b = json!({"version": "1.0.0", "nested": {"a": 1, "b": 2}, "id": "x"});
        let sig = sign_manifest(&a);
        assert!(verify_manifest(&b, &sig, None));
    }

    #[test]
    fn tampered_manifest_fails_verify() {
        let manifest = json!({"id": "acme/widget", "version": "1.0.0"});
        let sig = sign_manifest(&manifest);
        let tampered = json!({"id": "acme/widget", "version": "9.9.9"});
        assert!(!verify_manifest(&tampered, &sig, None));
    }

    #[test]
    fn explicit_public_key_verifies() {
        let manifest = json!({"id": "x"});
        let sig = sign_manifest(&manifest);
        let pk = public_key_b64();
        assert!(verify_manifest(&manifest, &sig, Some(&pk)));
    }

    #[test]
    fn seed_roundtrip_parses() {
        let seed = [7u8; 32];
        let b64 = B64.encode(seed);
        assert!(signing_key_from_seed(&b64).is_some());
        assert!(signing_key_from_seed("not-base64!!!").is_none());
    }

    #[test]
    fn persist_then_read_signing_key_roundtrips() {
        // A generated key persisted to disk must read back as the SAME key, so a
        // signature made before a restart still verifies after (the dev-persist
        // path that closes the "ephemeral key dies on bounce" gap). We exercise
        // the helpers directly since `signing_key()` is a process-wide OnceLock.
        let mut csprng = rand::rngs::OsRng;
        let key = SigningKey::generate(&mut csprng);
        let dir = std::env::temp_dir().join(format!("ryu-govtest-{}", std::process::id()));
        let path = dir.join("marketplace-signing-key");

        assert!(persist_signing_key(&path, &key), "persist should succeed");
        let loaded = read_persisted_signing_key(&path).expect("read back the key");

        // Same public key ⇒ same verifying identity across a simulated restart.
        assert_eq!(
            loaded.verifying_key().to_bytes(),
            key.verifying_key().to_bytes()
        );
        // A signature made with the original verifies against the reloaded key.
        let manifest = json!({"id": "acme/widget", "version": "1.0.0"});
        let sig = B64.encode(key.sign(&canonical_bytes(&manifest)).to_bytes());
        assert!(verify_manifest(
            &manifest,
            &sig,
            Some(&B64.encode(loaded.verifying_key().to_bytes()))
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
