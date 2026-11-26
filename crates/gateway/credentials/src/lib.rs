//! Private local Gateway credentials shared by the standalone and Core hosts.
pub mod config_file;
mod org_box_proof;
pub use org_box_proof::derive_org_box_proof_key;
mod org_core_relay;
pub use org_core_relay::{
    derive_org_core_relay_key, valid_org_core_relay_org, verify_org_core_relay_key,
    ORG_CORE_RELAY_PREFIX,
};
pub mod provider_apply;
pub use provider_apply::{ProviderApplyErrorCode, ProviderApplyOutcome, ProviderRuntimeEpoch};
pub mod sdk;
pub mod sealed_config;
pub use config_file::{ConfigCommitError, ConfigFileTransaction, ConfigRevision, ConfigSnapshot};
pub mod sdk_accounts;
pub mod web;
pub use sdk_accounts::{GenAiAccountConfig, GenAiProviderConfig, ResolvedSdkKey, SdkKeySource};

pub use sdk::{
    sdk_provider_by_id, sdk_provider_by_kind, SdkAuthKind, SdkContextKind, SdkEndpointConfig,
    SdkOperation, SdkProviderDescriptor, SDK_PROVIDERS,
};
mod inference_scope;
pub use inference_scope::{
    is_provider_access_id, BoxInferenceScope, InferenceScope, BOX_INFERENCE_MAX_TTL_SECS,
};
mod readiness;
pub use readiness::{
    readiness_request_signature, verify_readiness_request, ProtocolClaim, Readiness, ReadinessProof,
};

use anyhow::{bail, Context, Result};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::Path,
};

/// Non-secret account settings shared by Core's editor and Gateway dispatch.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderAccountPolicy {
    pub name: String,
    pub enabled: bool,
    pub priority: u16,
    #[serde(
        default,
        deserialize_with = "deserialize_drain_threshold",
        skip_serializing_if = "Option::is_none"
    )]
    pub drain_threshold_percent: Option<u8>,
}

impl Default for ProviderAccountPolicy {
    fn default() -> Self {
        Self {
            name: String::new(),
            enabled: true,
            priority: 0,
            drain_threshold_percent: None,
        }
    }
}

pub type ProviderAccountPolicies =
    std::collections::HashMap<String, std::collections::HashMap<String, ProviderAccountPolicy>>;

fn deserialize_drain_threshold<'de, D>(deserializer: D) -> Result<Option<u8>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = <Option<u8> as serde::Deserialize>::deserialize(deserializer)?;
    if value.is_some_and(|percent| percent > 100) {
        return Err(serde::de::Error::custom(
            "account drain threshold must be between 0 and 100",
        ));
    }
    Ok(value)
}

impl ProviderAccountPolicy {
    pub fn normalized(&self) -> std::result::Result<Self, String> {
        let mut policy = self.clone();
        if policy
            .drain_threshold_percent
            .is_some_and(|percent| percent > 100)
        {
            return Err("account drain threshold must be between 0 and 100".to_owned());
        }
        policy.name = policy.name.trim().to_owned();
        if policy.name.is_empty()
            || policy.name.chars().count() > 80
            || policy.name.chars().any(char::is_control)
        {
            return Err(
                "account name must contain 1–80 characters without control characters".to_owned(),
            );
        }
        Ok(policy)
    }

    pub fn effective_drain_threshold(&self, inherited: u8) -> u8 {
        self.drain_threshold_percent.unwrap_or(inherited)
    }
}

/// Stable opaque identity; labels and positions do not identify an account.
pub fn provider_account_id(provider: &str, key: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(b"ryu-provider-account-v1\0");
    digest.update(provider.as_bytes());
    digest.update(b"\0");
    digest.update(key.as_bytes());
    format!("{:x}", digest.finalize())
}

/// Direct OpenAI-compatible provider endpoints shared by Core's key editor and
/// Gateway registration. A caller cannot choose an arbitrary outbound URL via
/// the provider-key API; custom endpoints remain operator-authored config.
pub const DIRECT_COMPATIBLE_PROVIDERS: &[(&str, &str)] = &[
    ("voyage", "https://api.voyageai.com/v1"),
    ("jina", "https://api.jina.ai/v1"),
    ("mistral", "https://api.mistral.ai/v1"),
    ("huggingface", "https://router.huggingface.co/v1"),
    ("nvidia", "https://integrate.api.nvidia.com/v1"),
    ("together", "https://api.together.xyz/v1"),
    ("fireworks", "https://api.fireworks.ai/inference/v1"),
    ("chutes", "https://llm.chutes.ai/v1"),
    ("hyperbolic", "https://api.hyperbolic.xyz/v1"),
    ("siliconflow", "https://api.siliconflow.com/v1"),
    ("venice", "https://api.venice.ai/api/v1"),
    ("featherless", "https://api.featherless.ai/v1"),
    (
        "qwen",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    ),
];

pub fn direct_compatible_provider_url(id: &str) -> Option<&'static str> {
    DIRECT_COMPATIBLE_PROVIDERS
        .iter()
        .find(|(name, _)| *name == id)
        .map(|(_, url)| *url)
}

/// Native chat transports with session-aware account selection.
pub fn supports_chat_account_routing(id: &str) -> bool {
    id == "gemini" || supports_observed_quota_account_routing(id)
}

/// Transports whose account-qualified quota headers can drive quota selection.
pub fn supports_observed_quota_account_routing(id: &str) -> bool {
    matches!(
        id,
        "openai"
            | "anthropic"
            | "openrouter"
            | "mistral"
            | "huggingface"
            | "nvidia"
            | "together"
            | "fireworks"
            | "qwen"
    )
}

/// Bearers are opaque printable values; reject empty values and public dev placeholders.
pub fn validate(key: &str) -> Result<()> {
    if key.len() < 24
        || !key.bytes().all(|b| b.is_ascii_graphic())
        || matches!(key, "ryu-local" | "changeme" | "password")
    {
        bail!("Gateway credentials must contain at least 24 non-whitespace printable characters");
    }
    Ok(())
}

/// Prevent same-UID child processes from reading this process's environment or
/// memory through procfs/ptrace. Core uses this unconditionally because some of
/// its privileged Gateway credentials are generated or loaded after startup.
/// The caller must still scrub credentials from every child environment.
pub fn protect_process_environment() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        let result = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}

/// Protect a process only when one of the named environment variables holds a
/// secret. Use [`protect_process_environment`] for secrets loaded after boot.
pub fn protect_process_environment_if_present(keys: &[&str]) -> Result<()> {
    let has_secret = keys.iter().any(|name| {
        std::env::var(name)
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    });
    if !has_secret {
        return Ok(());
    }
    protect_process_environment()
}

#[cfg(all(test, target_os = "linux"))]
mod process_protection_tests {
    use super::protect_process_environment;
    use std::process::Command;

    const CHILD_PROBE: &str = "RYU_GW_CREDENTIALS_PROC_PROBE";

    #[test]
    fn process_environment_and_memory_are_not_readable_by_same_uid_children() {
        if std::env::var_os(CHILD_PROBE).is_some() {
            let _generated_secret = std::hint::black_box("generated-core-secret".to_owned());
            protect_process_environment().expect("Core must enable the process read boundary");
            let status = Command::new("/bin/sh")
                .args([
                    "-c",
                    "if cat /proc/$PPID/environ >/dev/null 2>&1; then exit 1; fi; if cat /proc/$PPID/mem >/dev/null 2>&1; then exit 2; fi",
                ])
                .status()
                .expect("spawn procfs probe");
            assert!(status.success(), "same-UID child read Core's process state");
            return;
        }

        let output = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "process_protection_tests::process_environment_and_memory_are_not_readable_by_same_uid_children",
            ])
            .env(CHILD_PROBE, "1")
            .env_remove("GATEWAY_ADMIN_KEY")
            .output()
            .expect("spawn isolated protection probe");
        assert!(
            output.status.success(),
            "isolated process protection test failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

fn read_private(path: &Path) -> Result<String> {
    let key = read_private_body(path)?;
    if ryu_crypto::looks_sealed(&key) {
        bail!(
            "credential {} is sealed; this process has no key to open it",
            path.display()
        );
    }
    validate(&key)?;
    Ok(key)
}

/// The trimmed body of an owner-only, non-symlink credential file, unvalidated
/// (it may be a sealed envelope).
fn read_private_body(path: &Path) -> Result<String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("cannot read credential {}", path.display()))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("credential must be a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            bail!(
                "credential {} must be owned by the current user and have owner-only permissions",
                path.display()
            );
        }
    }
    if metadata.len() > 4096 {
        bail!("credential file is too large");
    }
    let mut key = String::new();
    file.read_to_string(&mut key)?;
    Ok(key.trim().to_owned())
}

/// Publish a complete private file without replacing an existing credential.
/// Concurrent bootstrap callers converge on the same persisted key.
///
/// The file holds the key in PLAINTEXT (owner-only). Use
/// [`load_or_create_sealed`] whenever the process holds a sealing key; this
/// form remains for a standalone Gateway started without any key, and it
/// refuses a file that is already sealed rather than misreading it.
pub fn load_or_create(path: &Path, prefix: &str) -> Result<String> {
    if existing_credential(path)? {
        return read_private(path);
    }
    let key = format!("{prefix}{}", uuid::Uuid::new_v4().simple());
    publish_private_new(path, &key)?;
    read_private(path)
}

/// [`load_or_create`] with the file body sealed by `sealer` (`enc:v1:` from
/// Core's master key, `encc:v1:` from the Gateway's component subkey).
///
/// * A new key is sealed before the temporary file is written, so no plaintext
///   byte reaches disk, and the create-new + hard-link publish keeps concurrent
///   callers converging on one key.
/// * An existing sealed file must open with `sealer`; a wrong key or a corrupt
///   body is an error, never a fresh key (that would silently rotate a bearer
///   other processes hold).
/// * An existing legacy plaintext file is accepted and atomically rewritten
///   sealed (same key, owner-only temp file + rename).
pub fn load_or_create_sealed(
    path: &Path,
    prefix: &str,
    sealer: &dyn ryu_crypto::SecretSealer,
) -> Result<String> {
    if !existing_credential(path)? {
        let key = format!("{prefix}{}", uuid::Uuid::new_v4().simple());
        let sealed = sealer
            .seal(&key)
            .with_context(|| format!("sealing credential {}", path.display()))?;
        publish_private_new(path, &sealed)?;
    }
    open_private_sealed(path, sealer)
}

/// Read and open a credential file written by [`load_or_create_sealed`] (or a
/// legacy plaintext one, which is resealed in place). Never creates a key.
pub fn read_sealed(path: &Path, sealer: &dyn ryu_crypto::SecretSealer) -> Result<String> {
    if !existing_credential(path)? {
        bail!("credential {} does not exist", path.display());
    }
    open_private_sealed(path, sealer)
}

fn open_private_sealed(path: &Path, sealer: &dyn ryu_crypto::SecretSealer) -> Result<String> {
    let body = read_private_body(path)?;
    if !ryu_crypto::looks_sealed(&body) {
        validate(&body)?;
        ryu_crypto::write_secret_file(path, &body, sealer)
            .with_context(|| format!("sealing legacy plaintext credential {}", path.display()))?;
        return Ok(body);
    }
    let key = sealer
        .open(&body)
        .with_context(|| format!("opening sealed credential {}", path.display()))?;
    validate(&key)?;
    Ok(key)
}

/// Whether a (non-symlink) credential exists at `path`.
fn existing_credential(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                bail!("credential path must not be a symlink");
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// Publish `body` at `path` only if nothing is there yet: write a complete
/// owner-only temporary file, then hard-link it into place. A concurrent
/// publisher that won keeps its file.
fn publish_private_new(path: &Path, body: &str) -> Result<()> {
    let parent = path.parent().context("credential path has no parent")?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".gateway-key-{}", uuid::Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        match std::fs::hard_link(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error.into()),
        }
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(u64::MAX)
}

pub fn fingerprint(key: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(key.as_bytes()))
}

/// Sign an agent route with a Core-only proof key while binding the assertion to
/// the inference bearer that will carry it. The bearer is not a signing key.
pub fn sign_agent_route_proof(core_key: &str, bearer: &str, agent_id: &str) -> Result<String> {
    use hmac::Mac;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(core_key.as_bytes())?;
    mac.update(b"ryu-agent-route-v2\0");
    mac.update(fingerprint(bearer).as_bytes());
    mac.update(agent_id.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// Derive one organization's Core proof key from the fleet master.
///
/// Managed Cores used to share one proof key across every organization, so
/// anyone holding one node's key held them all. The control plane now gives
/// each node `HMAC-SHA256(master, "ryu-core-proof-org-v1\0" || org_id)` and the
/// hosted Gateway derives the same value for the organization its `rgw_`
/// bearer resolves to, so a key only ever proves Core identity for its own
/// organization. `packages/api/src/lib/core-proof-key.ts` must stay identical.
pub fn derive_org_core_proof_key(master: &str, org_id: &str) -> Result<String> {
    use hmac::Mac;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(master.as_bytes())?;
    mac.update(b"ryu-core-proof-org-v1\0");
    mac.update(org_id.as_bytes());
    Ok(format!(
        "gwproof_org_{}",
        hex::encode(mac.finalize().into_bytes())
    ))
}

/// Verify an agent route proof against a configured Core-only proof key.
pub fn verify_agent_route_proof(core_key: &str, bearer: &str, agent_id: &str, proof: &str) -> bool {
    use hmac::Mac;
    let Ok(expected) = hex::decode(proof.trim()) else {
        return false;
    };
    let Ok(mut mac) = hmac::Hmac::<sha2::Sha256>::new_from_slice(core_key.as_bytes()) else {
        return false;
    };
    mac.update(b"ryu-agent-route-v2\0");
    mac.update(fingerprint(bearer).as_bytes());
    mac.update(agent_id.as_bytes());
    mac.verify_slice(&expected).is_ok()
}

#[cfg(test)]
mod org_core_proof_key_tests {
    use super::derive_org_core_proof_key;

    #[test]
    fn matches_the_control_plane_vector_and_separates_orgs() {
        let master = "gwproof_master_cross_language_vector";
        assert_eq!(
            derive_org_core_proof_key(master, "org_123").unwrap(),
            "gwproof_org_e3899a4488adf67c895054c66b8fd9c7b0efbb86f2fbe20fb138c8e7a4c32cfc"
        );
        assert_ne!(
            derive_org_core_proof_key(master, "org_123").unwrap(),
            derive_org_core_proof_key(master, "org_124").unwrap()
        );
    }
}

#[cfg(test)]
#[path = "lib_test.rs"]
mod tests;
