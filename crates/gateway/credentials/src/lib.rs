//! Private local Gateway credentials shared by the standalone and Core hosts.
pub mod config_file;
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

/// Core-issued inference identity. The recipient can replay its own scope but
/// cannot choose another agent, user or session without Core's signing secret.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceScope {
    pub agent_id: String,
    pub user_id: Option<String>,
    pub session_id: Option<String>,
    /// Unix timestamp after which the scoped credential must be rejected.
    pub expires_at: u64,
    /// The user's model providers this agent may use (registry ids). `None`
    /// is unrestricted; `Some` (even empty) limits the agent to these plus the
    /// platform-credit and keyless local slots, and a hosted organisation's
    /// fleet-served managed inference. Absent from tokens minted
    /// before the field existed, so their signed bytes are unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_access: Option<Vec<String>>,
}

/// Whether `id` is a well-formed provider registry id for an agent's provider
/// access list: short, lowercase ASCII letters, digits, `-`, `_` or `.`. A
/// malformed id is dropped (Core) or rejected (a signed scope), so it can never
/// widen access or smuggle a separator into the CSV header form.
pub fn is_provider_access_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        })
}

impl InferenceScope {
    fn validate(&self) -> Result<()> {
        for value in [
            Some(self.agent_id.as_str()),
            self.user_id.as_deref(),
            self.session_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty()
                || value.trim() != value
                || value.len() > 256
                || value.chars().any(char::is_control)
            {
                bail!("invalid scoped inference identity");
            }
        }
        if self
            .provider_access
            .as_deref()
            .is_some_and(|ids| ids.len() > 256 || !ids.iter().all(|id| is_provider_access_id(id)))
        {
            bail!("invalid scoped inference provider access");
        }
        if self.expires_at <= unix_now() {
            bail!("scoped inference credential is expired");
        }
        Ok(())
    }

    pub fn sign(&self, core_key: &str) -> Result<String> {
        use hmac::Mac;
        self.validate()?;
        let payload = hex::encode(serde_json::to_vec(self)?);
        let signed = format!("gws1.{payload}");
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(core_key.as_bytes())?;
        mac.update(signed.as_bytes());
        Ok(format!(
            "{signed}.{}",
            hex::encode(mac.finalize().into_bytes())
        ))
    }

    pub fn verify(token: &str, core_key: &str) -> Result<Self> {
        use hmac::Mac;
        if token.len() > 4096 {
            bail!("scoped inference credential is too large");
        }
        let (signed, signature) = token
            .rsplit_once('.')
            .context("invalid scoped inference credential")?;
        let payload = signed
            .strip_prefix("gws1.")
            .context("invalid scoped inference version")?;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(core_key.as_bytes())?;
        mac.update(signed.as_bytes());
        mac.verify_slice(&hex::decode(signature)?)
            .map_err(|_| anyhow::anyhow!("invalid scoped inference signature"))?;
        let scope: Self = serde_json::from_slice(&hex::decode(payload)?)?;
        scope.validate()?;
        Ok(scope)
    }
}

/// Longest lifetime a `gwb1` Box inference key may have, in seconds.
pub const BOX_INFERENCE_MAX_TTL_SECS: u64 = 20 * 60;
const BOX_INFERENCE_PREFIX: &str = "gwb1.";

/// Core-issued inference identity for one session Box (`gwb1`). It is
/// inference-only, bound to an org, a session, a Box and the lease epoch the
/// Box runs under, and lives at most [`BOX_INFERENCE_MAX_TTL_SECS`]. Core
/// signs it with its Core proof key; the Gateway verifies it with the same key
/// (the org-derived key in the hosted fleet, the local trusted-forwarder key on
/// a local Gateway).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoxInferenceScope {
    pub org_id: String,
    pub user_id: Option<String>,
    pub session_id: String,
    pub box_id: String,
    /// Bumped on every park and resume; a key for an old epoch dies with its TTL.
    pub lease_epoch: u64,
    /// Unix timestamp after which the key must be rejected.
    pub expires_at: u64,
}

impl BoxInferenceScope {
    fn validate_at(&self, now: u64) -> Result<()> {
        for value in [
            Some(self.org_id.as_str()),
            self.user_id.as_deref(),
            Some(self.session_id.as_str()),
            Some(self.box_id.as_str()),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty()
                || value.trim() != value
                || value.len() > 256
                || value.chars().any(char::is_control)
            {
                bail!("invalid Box inference identity");
            }
        }
        if self.expires_at <= now {
            bail!("Box inference credential is expired");
        }
        if self.expires_at > now.saturating_add(BOX_INFERENCE_MAX_TTL_SECS) {
            bail!("Box inference credential lives longer than 20 minutes");
        }
        Ok(())
    }

    fn mac(signed: &str, core_key: &str) -> Result<hmac::Hmac<sha2::Sha256>> {
        use hmac::Mac;
        if core_key.is_empty() {
            bail!("Box inference signing key is empty");
        }
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(core_key.as_bytes())?;
        mac.update(signed.as_bytes());
        Ok(mac)
    }

    /// Sign as `gwb1.<hex payload>.<hex hmac>`.
    pub fn sign(&self, core_key: &str) -> Result<String> {
        self.sign_at(core_key, unix_now())
    }

    /// [`Self::sign`] with an explicit clock.
    pub fn sign_at(&self, core_key: &str, now: u64) -> Result<String> {
        use hmac::Mac;
        self.validate_at(now)?;
        let payload = hex::encode(serde_json::to_vec(self)?);
        let signed = format!("{BOX_INFERENCE_PREFIX}{payload}");
        let mac = Self::mac(&signed, core_key)?;
        Ok(format!(
            "{signed}.{}",
            hex::encode(mac.finalize().into_bytes())
        ))
    }

    /// Verify a `gwb1` key against `core_key`.
    pub fn verify(token: &str, core_key: &str) -> Result<Self> {
        Self::verify_at(token, core_key, unix_now())
    }

    /// [`Self::verify`] with an explicit clock.
    pub fn verify_at(token: &str, core_key: &str, now: u64) -> Result<Self> {
        use hmac::Mac;
        if token.len() > 4096 {
            bail!("Box inference credential is too large");
        }
        let (signed, signature) = token
            .rsplit_once('.')
            .context("invalid Box inference credential")?;
        let payload = signed
            .strip_prefix(BOX_INFERENCE_PREFIX)
            .context("invalid Box inference version")?;
        let mac = Self::mac(signed, core_key)?;
        mac.verify_slice(&hex::decode(signature)?)
            .map_err(|_| anyhow::anyhow!("invalid Box inference signature"))?;
        let scope: Self = serde_json::from_slice(&hex::decode(payload)?)?;
        scope.validate_at(now)?;
        Ok(scope)
    }

    /// Whether `token` has the `gwb1` shape (not whether it verifies).
    pub fn is_box_token(token: &str) -> bool {
        token.starts_with(BOX_INFERENCE_PREFIX)
    }
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

/// Authenticate a readiness challenge without disclosing the admin bearer to
/// a listener whose identity Core has not verified yet. Request and response
/// MACs use distinct messages so a response cannot authorize another challenge.
pub fn readiness_request_signature(nonce: &str, admin: &str) -> Result<String> {
    use hmac::Mac;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(admin.as_bytes())?;
    mac.update(b"ryu-gateway-readiness-request-v1:");
    mac.update(nonce.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

pub fn verify_readiness_request(nonce: &str, signature: &str, admin: &str) -> Result<()> {
    use hmac::Mac;
    if nonce.len() != 64
        || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
        || signature.len() != 64
    {
        bail!("invalid readiness request proof");
    }
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(admin.as_bytes())?;
    mac.update(b"ryu-gateway-readiness-request-v1:");
    mac.update(nonce.as_bytes());
    mac.verify_slice(&hex::decode(signature)?)
        .map_err(|_| anyhow::anyhow!("invalid readiness request proof"))
}

/// Signed, non-secret startup facts. Listener is the bound socket address supplied
/// by the host after TcpListener::bind, never a caller-controlled HTTP authority.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Readiness {
    pub protocol: String,
    pub version: String,
    pub nonce: String,
    pub listener: std::net::SocketAddr,
    pub require_auth: bool,
    pub inference_keys: Vec<String>,
    pub core_keys: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ReadinessProof {
    pub readiness: Readiness,
    pub signature: String,
}

impl ReadinessProof {
    pub fn sign(readiness: Readiness, admin: &str) -> Result<Self> {
        use hmac::Mac;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(admin.as_bytes())?;
        mac.update(&serde_json::to_vec(&readiness)?);
        Ok(Self {
            readiness,
            signature: hex::encode(mac.finalize().into_bytes()),
        })
    }

    pub fn verify(
        &self,
        admin: &str,
        nonce: &str,
        listener: std::net::SocketAddr,
        version: &str,
        relay: &str,
        core: &str,
    ) -> Result<()> {
        use hmac::Mac;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(admin.as_bytes())?;
        mac.update(&serde_json::to_vec(&self.readiness)?);
        mac.verify_slice(&hex::decode(&self.signature)?)
            .map_err(|_| anyhow::anyhow!("Gateway readiness signature is invalid"))?;
        let ready = &self.readiness;
        if ready.protocol != "ryu-gateway-readiness-v1"
            || ready.nonce != nonce
            || ready.listener != listener
            || ready.version != version
            || !ready.require_auth
        {
            bail!("Gateway readiness does not match this listener, nonce, version, or authenticated configuration");
        }
        let relay = fingerprint(relay);
        let core = fingerprint(core);
        let admin = fingerprint(admin);
        if relay == core
            || relay == admin
            || core == admin
            || !ready.inference_keys.contains(&relay)
            || !ready.core_keys.contains(&core)
            || ready.core_keys.contains(&relay)
            || ready.inference_keys.contains(&core)
            || ready.inference_keys.contains(&admin)
            || ready.core_keys.contains(&admin)
        {
            bail!("Gateway readiness credential roles do not match the managed configuration");
        }
        Ok(())
    }
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
mod tests {
    use super::*;

    #[test]
    fn readiness_request_proof_binds_nonce_and_admin_before_signing() {
        let nonce = "a".repeat(64);
        let proof = readiness_request_signature(&nonce, "admin").unwrap();
        assert!(verify_readiness_request(&nonce, &proof, "admin").is_ok());
        assert!(verify_readiness_request(&nonce, "", "admin").is_err());
        assert!(verify_readiness_request(&nonce, &proof, "wrong").is_err());
        assert!(verify_readiness_request(&"b".repeat(64), &proof, "admin").is_err());
        assert!(verify_readiness_request("bad", &proof, "admin").is_err());
    }

    #[test]
    fn direct_compatible_provider_urls_are_explicitly_allowlisted() {
        let providers = [
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
        ];

        for (provider, expected_url) in providers {
            assert_eq!(direct_compatible_provider_url(provider), Some(expected_url));
        }
        for unknown in ["openai", "Voyage", "https://example.com"] {
            assert_eq!(direct_compatible_provider_url(unknown), None);
        }
    }

    #[test]
    fn persists_distinct_private_keys_and_rejects_invalid_existing_files() {
        let dir = std::env::temp_dir().join(format!("ryu-credentials-{}", uuid::Uuid::new_v4()));
        let path = dir.join("relay.key");
        let key = load_or_create(&path, "gwrelay_").unwrap();
        assert_eq!(load_or_create(&path, "gwrelay_").unwrap(), key);
        assert_ne!(
            load_or_create(&dir.join("admin.key"), "gwadm_").unwrap(),
            key
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(load_or_create(&path, "gwrelay_").is_err());
            let link = dir.join("link.key");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(load_or_create(&link, "gwrelay_").is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    fn test_sealer() -> ryu_crypto::ComponentCipher {
        ryu_crypto::ComponentCipher::from_subkey_b64(
            ryu_crypto::components::GATEWAY,
            "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        )
        .unwrap()
    }

    #[test]
    fn sealed_credentials_round_trip_without_plaintext_on_disk() {
        let dir = std::env::temp_dir().join(format!("ryu-sealed-cred-{}", uuid::Uuid::new_v4()));
        let path = dir.join("gateway-admin.key");
        let sealer = test_sealer();
        let key = load_or_create_sealed(&path, "gwadm_", &sealer).unwrap();
        assert!(key.starts_with("gwadm_"));
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.starts_with("encc:v1:"), "file body must be sealed");
        assert!(!raw.contains(&key), "raw key on disk");
        assert_eq!(
            load_or_create_sealed(&path, "gwadm_", &sealer).unwrap(),
            key
        );
        assert_eq!(read_sealed(&path, &sealer).unwrap(), key);
        // The plaintext loader refuses a sealed file instead of misreading it.
        assert!(load_or_create(&path, "gwadm_").is_err());
        // A wrong key is an error, never a silently minted replacement key.
        let other = ryu_crypto::ComponentCipher::from_subkey_b64(
            ryu_crypto::components::GATEWAY,
            "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
        )
        .unwrap();
        assert!(load_or_create_sealed(&path, "gwadm_", &other).is_err());
        assert_eq!(read_sealed(&path, &sealer).unwrap(), key);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_plaintext_credentials_are_resealed_in_place() {
        let dir = std::env::temp_dir().join(format!("ryu-legacy-cred-{}", uuid::Uuid::new_v4()));
        let path = dir.join("gateway-relay.key");
        let legacy = load_or_create(&path, "gwrelay_").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        let sealer = ryu_crypto::FieldCipher::new(&[9u8; 32]);
        assert_eq!(
            load_or_create_sealed(&path, "gwrelay_", &sealer).unwrap(),
            legacy
        );
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.starts_with("enc:v1:"));
        assert!(!raw.contains(&legacy));
        assert_eq!(
            load_or_create_sealed(&path, "gwrelay_", &sealer).unwrap(),
            legacy
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let link = dir.join("link.key");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(load_or_create_sealed(&link, "gwrelay_", &sealer).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_sealed_bootstrap_converges_on_one_key() {
        let directory =
            std::env::temp_dir().join(format!("ryu-sealed-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("relay.key");
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    load_or_create_sealed(&path, "gwrelay_", &test_sealer()).unwrap()
                })
            })
            .collect();
        let keys: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(keys.iter().all(|key| key == &keys[0]));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_blank_short_and_header_injection_values() {
        for key in [
            "",
            "ryu-local",
            "operator-key",
            "abcdefghijklmnopqrstuvwx\n",
        ] {
            assert!(validate(key).is_err());
        }
        assert!(validate("gwrelay_0123456789abcdef0123456789abcdef").is_ok());
    }
    #[test]
    fn concurrent_bootstrap_converges_and_storage_failure_is_fatal() {
        let directory = std::env::temp_dir().join(format!("ryu-key-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("relay.key");
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || load_or_create(&path, "gwrelay_").unwrap())
            })
            .collect();
        let keys: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(keys.iter().all(|key| key == &keys[0]));
        let blocked = directory.join("not-a-directory");
        std::fs::write(&blocked, b"block").unwrap();
        assert!(load_or_create(&blocked.join("key"), "gwrelay_").is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn readiness_binds_nonce_socket_version_and_roles() {
        let readiness = Readiness {
            protocol: "ryu-gateway-readiness-v1".into(),
            version: "1".into(),
            nonce: "nonce".into(),
            listener: "127.0.0.1:1234".parse().unwrap(),
            require_auth: true,
            inference_keys: vec![fingerprint("relay")],
            core_keys: vec![fingerprint("core")],
        };
        let proof = ReadinessProof::sign(readiness, "admin").unwrap();
        assert!(proof
            .verify(
                "admin",
                "nonce",
                "127.0.0.1:1234".parse().unwrap(),
                "1",
                "relay",
                "core"
            )
            .is_ok());
        assert!(proof
            .verify(
                "wrong",
                "nonce",
                "127.0.0.1:1234".parse().unwrap(),
                "1",
                "relay",
                "core"
            )
            .is_err());
        assert!(proof
            .verify(
                "admin",
                "other-nonce",
                "127.0.0.1:1234".parse().unwrap(),
                "1",
                "relay",
                "core"
            )
            .is_err());
        assert!(proof
            .verify(
                "admin",
                "nonce",
                "127.0.0.1:5678".parse().unwrap(),
                "1",
                "relay",
                "core"
            )
            .is_err());
        assert!(proof
            .verify(
                "admin",
                "nonce",
                "127.0.0.1:1234".parse().unwrap(),
                "2",
                "relay",
                "core"
            )
            .is_err());
        assert!(proof
            .verify(
                "admin",
                "nonce",
                "127.0.0.1:1234".parse().unwrap(),
                "1",
                "core",
                "relay"
            )
            .is_err());
    }
    #[test]
    fn scoped_inference_identity_cannot_be_changed_by_its_recipient() {
        let scope = InferenceScope {
            agent_id: "agent-a".into(),
            user_id: Some("user-a".into()),
            session_id: Some("session-a".into()),
            expires_at: unix_now() + 3600,
            provider_access: None,
        };
        let token = scope.sign("core-only-signing-key").unwrap();
        assert_eq!(
            InferenceScope::verify(&token, "core-only-signing-key").unwrap(),
            scope
        );
        assert!(InferenceScope::verify(&token, "exported-inference-relay").is_err());
        let mut other = scope.clone();
        other.agent_id = "agent-b".into();
        let payload = hex::encode(serde_json::to_vec(&other).unwrap());
        let (_, signature) = token.rsplit_once('.').unwrap();
        assert!(InferenceScope::verify(
            &format!("gws1.{payload}.{signature}"),
            "core-only-signing-key"
        )
        .is_err());
        other.agent_id = " ".into();
        assert!(other.sign("core-only-signing-key").is_err());
    }

    #[test]
    fn scoped_inference_provider_access_round_trips_and_stays_optional() {
        let key = "core-only-signing-key";
        let limited = InferenceScope {
            agent_id: "agent-a".into(),
            user_id: None,
            session_id: None,
            expires_at: unix_now() + 3600,
            provider_access: Some(vec!["anthropic".into(), "genai".into()]),
        };
        let token = limited.sign(key).unwrap();
        assert_eq!(InferenceScope::verify(&token, key).unwrap(), limited);

        // A token minted without the field (as before it existed) still
        // verifies, reads back unrestricted, and keeps its exact payload.
        let legacy = InferenceScope {
            provider_access: None,
            ..limited.clone()
        };
        let legacy_token = legacy.sign(key).unwrap();
        assert!(!String::from_utf8(
            hex::decode(
                legacy_token
                    .strip_prefix("gws1.")
                    .unwrap()
                    .rsplit_once('.')
                    .unwrap()
                    .0
            )
            .unwrap()
        )
        .unwrap()
        .contains("providerAccess"));
        assert_eq!(
            InferenceScope::verify(&legacy_token, key)
                .unwrap()
                .provider_access,
            None
        );

        // Unknown fields are still refused, and malformed ids cannot be signed.
        let mut unknown = serde_json::to_value(&legacy).unwrap();
        unknown["extra"] = serde_json::json!(true);
        assert!(serde_json::from_value::<InferenceScope>(unknown).is_err());
        for bad in ["", "open,ai", "OpenAI", "a b"] {
            let scope = InferenceScope {
                provider_access: Some(vec![bad.to_owned()]),
                ..limited.clone()
            };
            assert!(scope.sign(key).is_err(), "{bad:?}");
        }
        assert!(InferenceScope {
            provider_access: Some(Vec::new()),
            ..limited
        }
        .sign(key)
        .is_ok());
    }

    #[test]
    fn scoped_inference_credentials_expire() {
        let scope = InferenceScope {
            agent_id: "agent-a".into(),
            user_id: None,
            session_id: None,
            expires_at: unix_now().saturating_sub(1),
            provider_access: None,
        };
        assert!(scope.sign("core-only-signing-key").is_err());
    }

    fn box_scope(expires_at: u64) -> BoxInferenceScope {
        BoxInferenceScope {
            org_id: "org_1".into(),
            user_id: Some("user_1".into()),
            session_id: "conv_1".into(),
            box_id: "bx_0123456789abcdef0123456789abcdef".into(),
            lease_epoch: 3,
            expires_at,
        }
    }

    #[test]
    fn box_inference_scope_round_trips() {
        let now = 1_800_000_000;
        let scope = box_scope(now + BOX_INFERENCE_MAX_TTL_SECS);
        let token = scope.sign_at("core-proof-key", now).unwrap();
        assert!(token.starts_with("gwb1."));
        assert!(BoxInferenceScope::is_box_token(&token));
        assert_eq!(
            BoxInferenceScope::verify_at(&token, "core-proof-key", now).unwrap(),
            scope
        );
        // The wall-clock entry points agree for a live key.
        let live = box_scope(unix_now() + 600);
        let token = live.sign("core-proof-key").unwrap();
        assert_eq!(
            BoxInferenceScope::verify(&token, "core-proof-key").unwrap(),
            live
        );
    }

    #[test]
    fn box_inference_scope_refuses_the_wrong_key() {
        let now = 1_800_000_000;
        let token = box_scope(now + 600).sign_at("org-a-key", now).unwrap();
        assert!(BoxInferenceScope::verify_at(&token, "org-b-key", now).is_err());
        assert!(BoxInferenceScope::verify_at(&token, "", now).is_err());
        assert!(box_scope(now + 600).sign_at("", now).is_err());
    }

    #[test]
    fn box_inference_scope_expires() {
        let now = 1_800_000_000;
        let token = box_scope(now + 600).sign_at("core-proof-key", now).unwrap();
        assert!(BoxInferenceScope::verify_at(&token, "core-proof-key", now + 600).is_err());
        assert!(BoxInferenceScope::verify_at(&token, "core-proof-key", now + 599).is_ok());
        assert!(box_scope(now).sign_at("core-proof-key", now).is_err());
        let stale = box_scope(unix_now().saturating_sub(1));
        assert!(stale.sign("core-proof-key").is_err());
    }

    #[test]
    fn box_inference_scope_refuses_a_ttl_over_twenty_minutes() {
        let now = 1_800_000_000;
        assert!(box_scope(now + BOX_INFERENCE_MAX_TTL_SECS + 1)
            .sign_at("core-proof-key", now)
            .is_err());
        // A key signed for a 20-minute life is refused by a verifier whose clock
        // says it would live longer (a far-future expiry forged with the key).
        let forged = box_scope(now + 24 * 3600);
        let payload = hex::encode(serde_json::to_vec(&forged).unwrap());
        let signed = format!("gwb1.{payload}");
        let mac = BoxInferenceScope::mac(&signed, "core-proof-key").unwrap();
        use hmac::Mac;
        let token = format!("{signed}.{}", hex::encode(mac.finalize().into_bytes()));
        assert!(BoxInferenceScope::verify_at(&token, "core-proof-key", now).is_err());
    }

    #[test]
    fn box_inference_scope_rejects_a_tampered_payload_and_other_versions() {
        let now = 1_800_000_000;
        let scope = box_scope(now + 600);
        let token = scope.sign_at("core-proof-key", now).unwrap();
        let (_, signature) = token.rsplit_once('.').unwrap();
        for tamper in [
            BoxInferenceScope {
                box_id: "bx_other".into(),
                ..scope.clone()
            },
            BoxInferenceScope {
                org_id: "org_2".into(),
                ..scope.clone()
            },
            BoxInferenceScope {
                lease_epoch: 4,
                ..scope.clone()
            },
            BoxInferenceScope {
                session_id: "conv_2".into(),
                ..scope.clone()
            },
        ] {
            let payload = hex::encode(serde_json::to_vec(&tamper).unwrap());
            assert!(BoxInferenceScope::verify_at(
                &format!("gwb1.{payload}.{signature}"),
                "core-proof-key",
                now
            )
            .is_err());
        }
        // A gws1 token is never a gwb1 token, and vice versa.
        let gws1 = InferenceScope {
            agent_id: "agent".into(),
            user_id: None,
            session_id: None,
            expires_at: unix_now() + 600,
            provider_access: None,
        }
        .sign("core-proof-key")
        .unwrap();
        assert!(BoxInferenceScope::verify(&gws1, "core-proof-key").is_err());
        assert!(!BoxInferenceScope::is_box_token(&gws1));
        let gwb1 = box_scope(unix_now() + 600).sign("core-proof-key").unwrap();
        assert!(InferenceScope::verify(&gwb1, "core-proof-key").is_err());
        // Identity fields are validated like gws1's.
        let mut invalid = scope.clone();
        invalid.session_id = " padded".into();
        assert!(invalid.sign_at("core-proof-key", now).is_err());
        invalid.session_id = "conv\n".into();
        assert!(invalid.sign_at("core-proof-key", now).is_err());
        assert!(BoxInferenceScope::verify_at(&"a".repeat(5000), "core-proof-key", now).is_err());
    }

    #[test]
    fn account_drain_override_inherits_zero_and_removal_restores_inheritance() {
        let mut policy: ProviderAccountPolicy =
            serde_json::from_value(serde_json::json!({"name":"Work","enabled":true,"priority":0}))
                .unwrap();
        assert_eq!(policy.effective_drain_threshold(80), 80);
        policy.drain_threshold_percent = Some(0);
        assert_eq!(policy.effective_drain_threshold(60), 0);
        let encoded = serde_json::to_vec(&policy).unwrap();
        assert_eq!(
            serde_json::from_slice::<ProviderAccountPolicy>(&encoded).unwrap(),
            policy
        );
        let removed: ProviderAccountPolicy = serde_json::from_value(
            serde_json::json!({"name":"Work","drain_threshold_percent":null}),
        )
        .unwrap();
        assert_eq!(removed.effective_drain_threshold(60), 60);
        assert!(serde_json::to_value(removed)
            .unwrap()
            .get("drain_threshold_percent")
            .is_none());
        assert!(serde_json::from_value::<ProviderAccountPolicy>(
            serde_json::json!({"name":"Work","drain_threshold_percent":101}),
        )
        .is_err());
    }
}
