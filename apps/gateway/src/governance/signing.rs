//! Signing key custody and manifest signing.
//!
//! Moved as is out of `mod.rs`, which went over the file size limits. The module
//! doc of `mod.rs` describes the key sources and the canonical encoding.

use super::*;

// ── Signing ─────────────────────────────────────────────────────────────────

/// Resolve the process signing key, in priority order:
///   1. `RYU_MARKETPLACE_SIGNING_KEY` env (base64 32-byte seed) — the production
///      source of truth. Stable across restarts and across replicas.
///   2. A dev-persisted key file (`<data dir>/secrets/marketplace-signing-key`,
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
pub(super) fn signing_key() -> &'static SigningKey {
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
        //    The seed is sealed (`encc:v1:`) with the Gateway's sealing key; a
        //    legacy plaintext seed is read and resealed in place.
        if let Some(path) = signing_key_path() {
            let sealer = signing_key_sealer();
            match read_persisted_signing_key(&path, sealer.as_deref()) {
                Ok(Some(key)) => {
                    tracing::info!(
                        path = %path.display(),
                        public_key = %B64.encode(key.verifying_key().to_bytes()),
                        "governance: loaded dev-persisted marketplace signing key (set {ENV_SIGNING_KEY} for production)"
                    );
                    return key;
                }
                Ok(None) => {}
                Err(error) => {
                    // Never mint a replacement over a key we cannot open: that
                    // would silently rotate the marketplace trust root.
                    tracing::error!(
                        path = %path.display(),
                        "governance: the persisted marketplace signing key could not be opened ({error}); using an EPHEMERAL key and leaving the file untouched (start the Gateway with its sealing key, or set {ENV_SIGNING_KEY})"
                    );
                    let mut csprng = rand::rngs::OsRng;
                    return SigningKey::generate(&mut csprng);
                }
            }
            // Before keys were profile-scoped every profile shared one file. Adopt
            // that key on first start of a non-release profile so signatures it
            // already issued keep verifying; fresh installs stay isolated. The
            // shared file is the release profile's own key, sealed (if at all)
            // under the release key, so it is only read here, never rewritten.
            if let Some(key) = legacy_signing_key_path(&path)
                .and_then(|legacy| adopt_legacy_signing_key(&legacy, &path, sealer.as_deref()))
            {
                tracing::info!(
                    path = %path.display(),
                    public_key = %B64.encode(key.verifying_key().to_bytes()),
                    "governance: adopted the pre-profile marketplace signing key for this profile"
                );
                return key;
            }
            let mut csprng = rand::rngs::OsRng;
            let key = SigningKey::generate(&mut csprng);
            if persist_signing_key(&path, &key, sealer.as_deref()) {
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
/// `<RYU_DIR>/secrets/marketplace-signing-key` under Core, else the standalone
/// profile's `$XDG_DATA_HOME/ryu{suffix}/marketplace-signing-key` (mirrors the
/// audit db location, profile-scoped so a dev Gateway never signs with the
/// release key).
/// `None` when no data dir can be resolved.
pub(super) fn signing_key_path() -> Option<std::path::PathBuf> {
    let ryu_dir = std::env::var_os("RYU_DIR")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);
    signing_key_path_for(
        std::env::var(ENV_SIGNING_KEY_PATH).ok().as_deref(),
        ryu_dir.as_deref(),
        dirs::data_local_dir().as_deref(),
        &crate::profile::suffix(),
    )
}

/// Pure half of [`signing_key_path`], testable without process-global env.
pub(super) fn signing_key_path_for(
    override_path: Option<&str>,
    ryu_dir: Option<&std::path::Path>,
    data_local_dir: Option<&std::path::Path>,
    profile_suffix: &str,
) -> Option<std::path::PathBuf> {
    if let Some(trimmed) = override_path.map(str::trim).filter(|raw| !raw.is_empty()) {
        return Some(std::path::PathBuf::from(trimmed));
    }
    if let Some(root) = ryu_dir {
        return Some(ryu_sidecar_runtime::layout::secret_path(
            root,
            "marketplace-signing-key",
        ));
    }
    data_local_dir.map(|dir| {
        dir.join(format!("ryu{profile_suffix}"))
            .join("marketplace-signing-key")
    })
}

/// The shared pre-profile key file (`$XDG_DATA_HOME/ryu/marketplace-signing-key`)
/// for a profile-scoped default path (`ryu-<profile>/marketplace-signing-key`).
/// `None` for the release profile, an explicit override, or any other shape.
pub(super) fn legacy_signing_key_path(
    profile_path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    if std::env::var(ENV_SIGNING_KEY_PATH).is_ok_and(|raw| !raw.trim().is_empty()) {
        return None;
    }
    legacy_signing_key_path_for(profile_path)
}

/// Pure half of [`legacy_signing_key_path`].
pub(super) fn legacy_signing_key_path_for(
    profile_path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let profile_dir = profile_path.parent()?;
    let dir_name = profile_dir.file_name()?.to_str()?;
    if !dir_name.starts_with("ryu-") || profile_path.file_name()? != "marketplace-signing-key" {
        return None;
    }
    Some(
        profile_dir
            .parent()?
            .join("ryu")
            .join("marketplace-signing-key"),
    )
}

/// Adopt the shared pre-profile seed at `legacy` into this profile's own `path`.
///
/// The legacy file is the release profile's live key, so it is read strictly
/// read-only: with no sealer, so [`read_persisted_signing_key`] never reseals it
/// under this profile's key (which would leave the release Gateway unable to
/// open it and rotate its trust root on the next restart). A plaintext seed is
/// adopted; a sealed one cannot be opened without the release key, so it is
/// skipped and the profile mints its own. The seed is then persisted only to
/// `path`, sealed under this profile's sealer.
pub(super) fn adopt_legacy_signing_key(
    legacy: &std::path::Path,
    path: &std::path::Path,
    sealer: Option<&dyn ryu_crypto::SecretSealer>,
) -> Option<SigningKey> {
    read_persisted_signing_key(legacy, None)
        .ok()
        .flatten()
        .filter(|key| persist_signing_key(path, key, sealer))
}

/// The Gateway's sealing key for the persisted seed: the subkey Core delivered,
/// or the one a standalone Gateway derived from `RYU_MASTER_KEY`. `None` when
/// this process has no key.
pub(super) fn signing_key_sealer() -> Option<std::sync::Arc<dyn ryu_crypto::SecretSealer>> {
    <ryu_crypto::GatewayScope as ryu_crypto::SealScope>::sealer().ok()
}

/// Read the persisted base64 32-byte seed from `path`.
///
/// * `Ok(None)`: no file.
/// * `Ok(Some(key))`: a sealed or legacy plaintext seed; a plaintext seed is
///   resealed in place when `sealer` is available (best effort).
/// * `Err`: the file exists but cannot be opened (sealed without a usable key)
///   or does not hold a valid seed. The caller must not overwrite it.
pub(super) fn read_persisted_signing_key(
    path: &std::path::Path,
    sealer: Option<&dyn ryu_crypto::SecretSealer>,
) -> anyhow::Result<Option<SigningKey>> {
    let Some(opened) = ryu_crypto::read_secret_file(path, sealer)? else {
        return Ok(None);
    };
    let key = signing_key_from_seed(opened.value.trim())
        .ok_or_else(|| anyhow::anyhow!("not a base64 32-byte ed25519 seed"))?;
    if opened.needs_reseal {
        if let Some(sealer) = sealer {
            match ryu_crypto::write_secret_file(path, &opened.value, sealer) {
                Ok(()) => tracing::info!(
                    path = %path.display(),
                    "governance: sealed the plaintext marketplace signing key in place"
                ),
                Err(error) => tracing::warn!(
                    path = %path.display(),
                    "governance: could not seal the plaintext marketplace signing key: {error}"
                ),
            }
        }
    }
    Ok(Some(key))
}

/// Persist a signing key's 32-byte seed (base64) to `path`, sealed with the
/// Gateway's sealing key. Returns `true` on success. Never panics.
///
/// Fails closed: without a sealer nothing is written (the caller then runs on
/// an ephemeral key and says so). The write is atomic (owner-only temporary
/// file, fsync, rename), so a crash never truncates the seed and silently
/// rotates the trust root, and the parent directory is tightened to `0700`.
pub(super) fn persist_signing_key(
    path: &std::path::Path,
    key: &SigningKey,
    sealer: Option<&dyn ryu_crypto::SecretSealer>,
) -> bool {
    let Some(sealer) = sealer else {
        tracing::warn!(
            path = %path.display(),
            "governance: no Gateway sealing key, so the marketplace signing key is not persisted (start the Gateway with RYU_MASTER_KEY, or set {ENV_SIGNING_KEY})"
        );
        return false;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Best-effort: the file itself is written 0600 regardless.
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let seed_b64 = B64.encode(key.to_bytes());
    match ryu_crypto::write_secret_file(path, &seed_b64, sealer) {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(path = %path.display(), "governance: could not persist the sealed signing key: {error}");
            false
        }
    }
}

/// The base64-encoded public verifying key, exposed so clients can pin it.
pub fn public_key_b64() -> String {
    ryu_gw_governance::public_key_b64(&signing_key().verifying_key())
}

/// Sign a manifest with the gateway's process signing key, returning the
/// base64-encoded ed25519 signature over the canonicalized manifest bytes.
pub fn sign_manifest(manifest: &Value) -> String {
    ryu_gw_governance::sign_manifest(signing_key(), manifest)
}

/// Verify a base64 signature against a manifest. When `public_key_b64` is
/// `None` the process key is used (the common case: same Gateway signed and
/// verifies). A malformed pinned public key, a tampered manifest, or a wrong
/// key returns `false`.
pub fn verify_manifest(
    manifest: &Value,
    signature_b64: &str,
    public_key_b64: Option<&str>,
) -> bool {
    let verifying_key = match public_key_b64 {
        Some(pk) => match verifying_key_from_b64(pk) {
            Some(k) => k,
            None => return false,
        },
        None => signing_key().verifying_key(),
    };
    ryu_gw_governance::verify_manifest(manifest, signature_b64, &verifying_key)
}
