//! Auto-unseal seal providers, recovery shares, and authenticated rekey.
//!
//! The base keyring ([`super::keyring`]) has two seal modes: `auto` (the Core
//! master key wraps the data keys) and `shamir` (a random root key, split into
//! key shares, wraps them). This module layers two HashiCorp Vault / OpenBao
//! features on top of the `shamir` mode without a third mode:
//!
//! * **Seal providers** ([`SealProvider`]). The `shamir` root key is also
//!   wrapped by an external key: `static` (a 32-byte key from
//!   `RYU_VAULT_SEAL_KEY` or `RYU_VAULT_SEAL_KEY_FILE`, for containers and
//!   headless nodes running `RYU_KEYCHAIN=off`) or `transit` (another Ryu
//!   node's transit key, for fleet auto-unseal). The transit node's address
//!   and credential both come from the operator's environment:
//!   `RYU_VAULT_SEAL_TRANSIT_ADDRESS` pins the node (an API-supplied address
//!   must match it exactly, so the credential is never sent anywhere else),
//!   and Core logs in on every use with the AppRole pair in
//!   `RYU_VAULT_SEAL_TRANSIT_ROLE_ID` / `RYU_VAULT_SEAL_TRANSIT_SECRET_ID`, so
//!   a boot or rekey long after setup still gets a fresh token. A fixed
//!   `RYU_VAULT_SEAL_TRANSIT_TOKEN` is accepted as a fallback, but it works
//!   only within that token's TTL. At boot Core asks the provider to unwrap
//!   the root and unseals without operator input. The provider secret is
//!   never stored in the vault database; only the wrapped root and the
//!   non-secret provider settings are.
//! * **Recovery shares.** Configuring a provider splits the same root into
//!   Shamir shares. They unseal the vault when the provider is unreachable and
//!   authorize a rekey. Unlike HashiCorp Vault recovery keys, which cannot
//!   unseal an auto-unseal vault, Ryu's recovery shares are full Shamir unseal
//!   shares of the root, so guard them exactly like unseal keys.
//! * **Rekey** (`init` → `update` × threshold → done, or `cancel`). A quorum of
//!   the current shares authorizes a new root key with a new share count and
//!   threshold. Every data key is rewrapped with the new root in one
//!   transaction, and the provider-wrapped copy (if any) is replaced in the
//!   same transaction. The HTTP surface is admin-only and authenticated; Ryu
//!   never exposes an unauthenticated rekey.
//!
//! Cloud KMS providers (AWS KMS, GCP KMS, Azure Key Vault) are not built in:
//! they are external configuration, and the `transit` provider pointed at a
//! Ryu node covers fleet auto-unseal without vendor SDKs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use rusqlite::Connection;
use ryu_crypto::FieldCipher;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::audit::{AuditActor, AuditEntry};
use super::keyring::{meta_get, Keyring, RootSource, SealMode, SealStatus};
use super::shamir::{self, Share};
use super::{now_millis, random_bytes, random_token, sha256_hex, VaultError};
use crate::plugin_secrets::PluginSecretStore;

/// `vault_meta` key holding the provider settings (JSON, no secrets).
pub const META_PROVIDER_CONFIG: &str = "seal_provider_config";
/// `vault_meta` key holding the provider-wrapped root key.
pub const META_PROVIDER_WRAPPED: &str = "seal_provider_wrapped_root";
/// Env var with the static seal key (64 hex characters or base64 of 32 bytes).
pub const ENV_STATIC_KEY: &str = "RYU_VAULT_SEAL_KEY";
/// Env var naming a file that holds the static seal key.
pub const ENV_STATIC_KEY_FILE: &str = "RYU_VAULT_SEAL_KEY_FILE";
/// Env var with a fixed machine token (`rvt_…`) for the transit seal
/// provider (fallback; expires with the token's TTL).
pub const ENV_TRANSIT_TOKEN: &str = "RYU_VAULT_SEAL_TRANSIT_TOKEN";
/// Env var pinning the transit seal node's base URL. Required: the transit
/// credential is only ever sent to this address.
pub const ENV_TRANSIT_ADDRESS: &str = "RYU_VAULT_SEAL_TRANSIT_ADDRESS";
/// Env vars with the AppRole pair the transit provider logs in with.
pub const ENV_TRANSIT_ROLE_ID: &str = "RYU_VAULT_SEAL_TRANSIT_ROLE_ID";
pub const ENV_TRANSIT_SECRET_ID: &str = "RYU_VAULT_SEAL_TRANSIT_SECRET_ID";
/// A rekey that is not completed within this window is discarded.
const REKEY_TTL_MILLIS: i64 = 60 * 60 * 1000;
const STATIC_WRAP_PREFIX: &str = "rsw1:";
const TRANSIT_TIMEOUT: Duration = Duration::from_secs(15);

/// Seal provider settings. Stored in `vault_meta`; never holds key material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SealProviderConfig {
    /// A 32-byte key from [`ENV_STATIC_KEY`] or [`ENV_STATIC_KEY_FILE`].
    #[serde(rename = "static")]
    Static {
        /// Fingerprint of the key that wrapped the root (set by Core), so a
        /// boot with a different key fails with a clear error.
        #[serde(default)]
        key_fingerprint: Option<String>,
    },
    /// A transit key on another Ryu node.
    #[serde(rename = "transit", rename_all = "camelCase")]
    Transit {
        /// Base URL of the Ryu node, e.g. `https://vault.example.com:7980`
        /// (`http://` only for loopback).
        address: String,
        /// Transit key name on that node.
        key_name: String,
    },
}

impl SealProviderConfig {
    /// Stable provider name.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Static { .. } => "static",
            Self::Transit { .. } => "transit",
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::Static { .. } => Ok(()),
            Self::Transit { address, key_name } => {
                let url = url::Url::parse(address).map_err(|_| anyhow!("address is not a URL"))?;
                let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
                if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
                    bail!("address must be https (http is allowed only for loopback)");
                }
                if !url.username().is_empty() || url.password().is_some() {
                    bail!("address must not embed credentials");
                }
                if !super::transit::is_valid_key_name(key_name) {
                    bail!("keyName is not a valid transit key name");
                }
                Ok(())
            }
        }
    }
}

/// How the transit seal provider authenticates to the transit node.
pub enum TransitAuth {
    /// Log in with AppRole on every use (a fresh short-lived token).
    AppRole { role_id: String, secret_id: String },
    /// A fixed token; works only within its TTL.
    Token(String),
}

/// A resolved seal provider: settings plus the secret read from the
/// environment. Wraps and unwraps the vault root key.
pub enum SealProvider {
    Static {
        key: [u8; 32],
    },
    Transit {
        address: String,
        key_name: String,
        auth: TransitAuth,
    },
}

/// Read a provider env var. Tests override values per thread so they never
/// touch the process environment.
fn provider_env(name: &str) -> Option<String> {
    if let Some(value) = env_override(name) {
        return value;
    }
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
fn env_override(name: &str) -> Option<Option<String>> {
    tests::env_override(name)
}

#[cfg(not(test))]
fn env_override(_name: &str) -> Option<Option<String>> {
    None
}

fn normalize_address(address: &str) -> String {
    address.trim().trim_end_matches('/').to_owned()
}

fn decode_static_key(text: &str) -> Result<[u8; 32]> {
    let text = text.trim();
    let bytes = if text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex::decode(text).map_err(|_| anyhow!("static seal key is not valid hex"))?
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(|_| anyhow!("static seal key must be 64 hex characters or base64"))?
    };
    bytes
        .try_into()
        .map_err(|_| anyhow!("static seal key must be exactly 32 bytes"))
}

fn static_key_from_env() -> Result<[u8; 32]> {
    if let Some(value) = provider_env(ENV_STATIC_KEY) {
        return decode_static_key(&value);
    }
    if let Some(path) = provider_env(ENV_STATIC_KEY_FILE) {
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {ENV_STATIC_KEY_FILE}"))?;
        return decode_static_key(&text);
    }
    bail!("set {ENV_STATIC_KEY} or {ENV_STATIC_KEY_FILE} to use the static seal provider")
}

fn key_fingerprint(key: &[u8; 32]) -> String {
    let mut input = b"ryu-vault-static-seal:".to_vec();
    input.extend_from_slice(key);
    sha256_hex(&input)[..16].to_owned()
}

impl SealProvider {
    /// Resolve `config` with its secret from the environment.
    pub fn resolve(config: &SealProviderConfig) -> Result<Self> {
        config.validate()?;
        match config {
            SealProviderConfig::Static {
                key_fingerprint: expected,
            } => {
                let key = static_key_from_env()?;
                if let Some(expected) = expected {
                    if &key_fingerprint(&key) != expected {
                        bail!(
                            "the configured static seal key is not the key that sealed this vault"
                        );
                    }
                }
                Ok(Self::Static { key })
            }
            SealProviderConfig::Transit { address, key_name } => {
                // The credential belongs to the operator-pinned node only; an
                // API-supplied address can never redirect it.
                let pinned = provider_env(ENV_TRANSIT_ADDRESS).ok_or_else(|| {
                    anyhow!("set {ENV_TRANSIT_ADDRESS} to use the transit seal provider")
                })?;
                let pinned = normalize_address(&pinned);
                if normalize_address(address) != pinned {
                    bail!("address must match {ENV_TRANSIT_ADDRESS} exactly");
                }
                let auth = match (
                    provider_env(ENV_TRANSIT_ROLE_ID),
                    provider_env(ENV_TRANSIT_SECRET_ID),
                ) {
                    (Some(role_id), Some(secret_id)) => TransitAuth::AppRole { role_id, secret_id },
                    (Some(_), None) | (None, Some(_)) => {
                        bail!("set both {ENV_TRANSIT_ROLE_ID} and {ENV_TRANSIT_SECRET_ID}")
                    }
                    (None, None) => {
                        TransitAuth::Token(provider_env(ENV_TRANSIT_TOKEN).ok_or_else(|| {
                            anyhow!(
                                "set {ENV_TRANSIT_ROLE_ID} and {ENV_TRANSIT_SECRET_ID} \
                                 (or {ENV_TRANSIT_TOKEN}) to use the transit seal provider"
                            )
                        })?)
                    }
                };
                Ok(Self::Transit {
                    address: pinned,
                    key_name: key_name.clone(),
                    auth,
                })
            }
        }
    }

    /// The settings to persist for this provider (static records the key
    /// fingerprint).
    fn persisted(&self, config: &SealProviderConfig) -> SealProviderConfig {
        match (self, config) {
            (Self::Static { key }, SealProviderConfig::Static { .. }) => {
                SealProviderConfig::Static {
                    key_fingerprint: Some(key_fingerprint(key)),
                }
            }
            _ => config.clone(),
        }
    }

    async fn transit_call(
        address: &str,
        key_name: &str,
        auth: &TransitAuth,
        op: &str,
        body: Value,
    ) -> Result<Value> {
        let url = format!("{address}/api/vault/agent/transit/{op}/{key_name}");
        // The credential goes only to the pinned node, never via a redirect.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let fresh;
        let token = match auth {
            TransitAuth::Token(token) => token.as_str(),
            TransitAuth::AppRole { role_id, secret_id } => {
                let response = client
                    .post(format!("{address}/api/vault/auth/approle/login"))
                    .timeout(TRANSIT_TIMEOUT)
                    .json(&json!({ "roleId": role_id, "secretId": secret_id }))
                    .send()
                    .await
                    .context("logging in to the transit seal provider")?;
                let status = response.status();
                if !status.is_success() {
                    bail!("transit seal provider rejected the AppRole login ({status})");
                }
                let answer: Value = response
                    .json()
                    .await
                    .context("transit seal provider returned invalid JSON")?;
                fresh = answer
                    .pointer("/token/token")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow!("transit seal provider returned no token"))?;
                fresh.as_str()
            }
        };
        let response = client
            .post(&url)
            .timeout(TRANSIT_TIMEOUT)
            .header("x-ryu-vault-token", token)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("calling the transit seal provider ({op})"))?;
        let status = response.status();
        if !status.is_success() {
            bail!("transit seal provider returned {status} for {op}");
        }
        response
            .json()
            .await
            .context("transit seal provider returned invalid JSON")
    }

    /// Wrap the raw root key.
    pub async fn wrap(&self, raw: &[u8]) -> Result<String> {
        match self {
            Self::Static { key } => {
                let (nonce, ciphertext) = FieldCipher::new(key).encrypt(raw)?;
                let engine = base64::engine::general_purpose::STANDARD;
                Ok(format!(
                    "{STATIC_WRAP_PREFIX}{}:{}",
                    engine.encode(nonce),
                    engine.encode(ciphertext)
                ))
            }
            Self::Transit {
                address,
                key_name,
                auth,
            } => {
                let plaintext = base64::engine::general_purpose::STANDARD.encode(raw);
                let answer = Self::transit_call(
                    address,
                    key_name,
                    auth,
                    "encrypt",
                    json!({ "plaintext": plaintext }),
                )
                .await?;
                answer
                    .get("ciphertext")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow!("transit seal provider returned no ciphertext"))
            }
        }
    }

    /// Unwrap a root key produced by [`SealProvider::wrap`].
    pub async fn unwrap(&self, wrapped: &str) -> Result<Vec<u8>> {
        match self {
            Self::Static { key } => {
                let body = wrapped.strip_prefix(STATIC_WRAP_PREFIX).ok_or_else(|| {
                    anyhow!("the wrapped root was not sealed by a static provider")
                })?;
                let (nonce, ciphertext) = body
                    .split_once(':')
                    .ok_or_else(|| anyhow!("the wrapped root is malformed"))?;
                let engine = base64::engine::general_purpose::STANDARD;
                let nonce = engine
                    .decode(nonce)
                    .map_err(|_| anyhow!("the wrapped root is malformed"))?;
                let ciphertext = engine
                    .decode(ciphertext)
                    .map_err(|_| anyhow!("the wrapped root is malformed"))?;
                FieldCipher::new(key)
                    .decrypt(&nonce, &ciphertext)
                    .map_err(|_| anyhow!("the static seal key does not open the wrapped root"))
            }
            Self::Transit {
                address,
                key_name,
                auth,
            } => {
                let answer = Self::transit_call(
                    address,
                    key_name,
                    auth,
                    "decrypt",
                    json!({ "ciphertext": wrapped }),
                )
                .await?;
                let plaintext = answer
                    .get("plaintext")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("transit seal provider returned no plaintext"))?;
                base64::engine::general_purpose::STANDARD
                    .decode(plaintext)
                    .map_err(|_| anyhow!("transit seal provider returned invalid base64"))
            }
        }
    }
}

/// Seal provider status (no key material).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealProviderStatus {
    /// The configured provider, or `None` when unsealing needs key shares.
    pub provider: Option<SealProviderConfig>,
    /// Shares that unseal the vault without the provider (recovery shares
    /// when a provider is configured).
    pub recovery_shares: u8,
    pub recovery_threshold: u8,
    pub seal: SealStatus,
}

fn provider_config(conn: &Connection) -> Result<Option<SealProviderConfig>> {
    meta_get(conn, META_PROVIDER_CONFIG)?
        .map(|text| serde_json::from_str(&text).context("reading seal provider settings"))
        .transpose()
}

/// Rekey progress (shares held in memory only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekeyStatus {
    pub started: bool,
    pub nonce: Option<String>,
    /// Current shares required to authorize the rekey.
    pub required: u8,
    pub progress: u8,
    pub new_shares: u8,
    pub new_threshold: u8,
    pub started_at: Option<i64>,
}

/// The outcome of one rekey update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekeyUpdate {
    pub complete: bool,
    pub status: RekeyStatus,
    /// The new key shares, returned exactly once when the rekey completes.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shares: Vec<String>,
}

struct RekeyProgress {
    nonce: String,
    new_shares: u8,
    new_threshold: u8,
    started_at: i64,
    submitted: Vec<Share>,
}

/// Rekey progress per keyring (keyed by the keyring's address, since one
/// process may hold several stores in tests).
fn rekeys() -> &'static Mutex<HashMap<usize, RekeyProgress>> {
    static REKEYS: OnceLock<Mutex<HashMap<usize, RekeyProgress>>> = OnceLock::new();
    REKEYS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn keyring_key(keyring: &Arc<Keyring>) -> usize {
    Arc::as_ptr(keyring) as usize
}

fn rekey_status(keyring: &Keyring, progress: Option<&RekeyProgress>) -> RekeyStatus {
    let seal = keyring.status();
    match progress {
        Some(progress) => RekeyStatus {
            started: true,
            nonce: Some(progress.nonce.clone()),
            required: seal.threshold,
            progress: progress.submitted.len() as u8,
            new_shares: progress.new_shares,
            new_threshold: progress.new_threshold,
            started_at: Some(progress.started_at),
        },
        None => RekeyStatus {
            started: false,
            nonce: None,
            required: seal.threshold,
            progress: 0,
            new_shares: 0,
            new_threshold: 0,
            started_at: None,
        },
    }
}

fn validate_split(shares: u8, threshold: u8) -> Result<()> {
    if threshold < 2 || shares < threshold {
        return Err(VaultError::Invalid(
            "threshold must be at least 2 and no greater than the share count".into(),
        )
        .into());
    }
    Ok(())
}

impl PluginSecretStore {
    // ── Seal providers ────────────────────────────────────────────────────

    /// Current seal provider and recovery-share settings.
    pub async fn seal_provider_status(&self) -> Result<SealProviderStatus> {
        let provider = {
            let conn = self.conn.lock().await;
            provider_config(&conn)?
        };
        let seal = self.keyring.status();
        Ok(SealProviderStatus {
            provider,
            recovery_shares: seal.shares,
            recovery_threshold: seal.threshold,
            seal,
        })
    }

    /// Configure (or replace) the auto-unseal provider. A new root key is
    /// generated, wrapped by the provider (verified by unwrapping it again),
    /// and split into recovery shares, which are returned exactly once. An
    /// `auto` vault moves to the provider seal; a `shamir` vault keeps its
    /// mode and its old shares stop working.
    pub async fn seal_provider_configure(
        &self,
        config: &SealProviderConfig,
        recovery_shares: u8,
        recovery_threshold: u8,
        actor: &AuditActor,
    ) -> Result<Vec<String>> {
        if self.keyring.is_sealed() {
            return Err(VaultError::Sealed.into());
        }
        validate_split(recovery_shares, recovery_threshold)?;
        let provider = SealProvider::resolve(config)
            .map_err(|error| VaultError::Invalid(error.to_string()))?;
        let root = random_bytes(32);
        let wrapped = provider.wrap(&root).await?;
        if provider.unwrap(&wrapped).await? != root {
            bail!("the seal provider did not return the wrapped root intact");
        }
        let persisted = serde_json::to_string(&provider.persisted(config))?;
        let source = if self.keyring.status().mode == SealMode::Auto {
            // Shamir-wrapped DEKs cannot open legacy version-0 rows; move
            // every row onto a data key first, as `init-shamir` does.
            if self.keyring.active_version() == super::keyring::LEGACY_KEY_VERSION {
                let conn = self.conn.lock().await;
                self.keyring.rotate(&conn)?;
            }
            self.rewrap_all(actor).await?;
            RootSource::Master
        } else {
            RootSource::Loaded
        };
        let conn = self.conn.lock().await;
        let shares = self.keyring.replace_root(
            &conn,
            source,
            &root,
            recovery_shares,
            recovery_threshold,
            &[
                (META_PROVIDER_CONFIG, &persisted),
                (META_PROVIDER_WRAPPED, &wrapped),
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "sys.seal_provider.configure", "ok").details(json!({
                "provider": config.kind(),
                "recoveryShares": recovery_shares,
                "recoveryThreshold": recovery_threshold,
            })),
        );
        Ok(shares)
    }

    /// Remove the auto-unseal provider. The vault stays in `shamir` mode and
    /// the recovery shares become its unseal shares.
    pub async fn seal_provider_remove(&self, actor: &AuditActor) -> Result<()> {
        if self.keyring.is_sealed() {
            return Err(VaultError::Sealed.into());
        }
        let conn = self.conn.lock().await;
        if provider_config(&conn)?.is_none() {
            return Err(VaultError::NotFound("no seal provider is configured".into()).into());
        }
        conn.execute(
            "DELETE FROM vault_meta WHERE key IN (?1, ?2)",
            rusqlite::params![META_PROVIDER_CONFIG, META_PROVIDER_WRAPPED],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "sys.seal_provider.remove", "ok"),
        );
        Ok(())
    }

    /// Unseal from the configured provider.
    pub async fn seal_provider_unseal(&self, actor: &AuditActor) -> Result<SealStatus> {
        let (config, wrapped) = {
            let conn = self.conn.lock().await;
            (
                provider_config(&conn)?,
                meta_get(&conn, META_PROVIDER_WRAPPED)?,
            )
        };
        let (Some(config), Some(wrapped)) = (config, wrapped) else {
            return Err(VaultError::NotFound("no seal provider is configured".into()).into());
        };
        if !self.keyring.is_sealed() {
            return Ok(self.keyring.status());
        }
        let result = async {
            let provider = SealProvider::resolve(&config)?;
            let root = provider.unwrap(&wrapped).await?;
            let conn = self.conn.lock().await;
            self.keyring.unseal_with_root(&conn, &root)
        }
        .await;
        let outcome = if result.is_ok() { "ok" } else { "error" };
        self.audit(
            &AuditEntry::new(actor, "sys.seal_provider.unseal", outcome)
                .details(json!({ "provider": config.kind() })),
        )
        .await;
        result
    }

    // ── Rekey ─────────────────────────────────────────────────────────────

    /// Current rekey progress.
    pub fn rekey_status(&self) -> RekeyStatus {
        let mut map = rekeys().lock().unwrap_or_else(|poison| poison.into_inner());
        let key = keyring_key(&self.keyring);
        if map
            .get(&key)
            .is_some_and(|progress| now_millis() - progress.started_at > REKEY_TTL_MILLIS)
        {
            map.remove(&key);
        }
        rekey_status(&self.keyring, map.get(&key))
    }

    /// Start a rekey to `new_shares`/`new_threshold`. Returns the nonce every
    /// update must echo.
    pub async fn rekey_init(
        &self,
        new_shares: u8,
        new_threshold: u8,
        actor: &AuditActor,
    ) -> Result<RekeyStatus> {
        if self.keyring.status().mode != SealMode::Shamir {
            return Err(VaultError::Invalid(
                "rekey needs key shares; switch to shamir or a seal provider first".into(),
            )
            .into());
        }
        validate_split(new_shares, new_threshold)?;
        let status = {
            let mut map = rekeys().lock().unwrap_or_else(|poison| poison.into_inner());
            let key = keyring_key(&self.keyring);
            if let Some(existing) = map.get(&key) {
                if now_millis() - existing.started_at <= REKEY_TTL_MILLIS {
                    return Err(VaultError::Conflict(
                        "a rekey is already in progress; cancel it first".into(),
                    )
                    .into());
                }
            }
            map.insert(
                key,
                RekeyProgress {
                    nonce: random_token("rkn_"),
                    new_shares,
                    new_threshold,
                    started_at: now_millis(),
                    submitted: Vec::new(),
                },
            );
            rekey_status(&self.keyring, map.get(&key))
        };
        self.audit(
            &AuditEntry::new(actor, "sys.rekey.init", "ok").details(json!({
                "newShares": new_shares,
                "newThreshold": new_threshold,
            })),
        )
        .await;
        Ok(status)
    }

    /// Cancel the rekey in progress, discarding submitted shares.
    pub async fn rekey_cancel(&self, actor: &AuditActor) -> Result<RekeyStatus> {
        let removed = rekeys()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&keyring_key(&self.keyring))
            .is_some();
        if !removed {
            return Err(VaultError::NotFound("no rekey is in progress".into()).into());
        }
        self.audit(&AuditEntry::new(actor, "sys.rekey.cancel", "ok"))
            .await;
        Ok(self.rekey_status())
    }

    /// Submit one current key share. Once the current threshold is reached the
    /// root key is replaced and the new shares are returned exactly once. A
    /// wrong quorum resets progress (the rekey stays started).
    pub async fn rekey_update(
        &self,
        nonce: &str,
        encoded_share: &str,
        actor: &AuditActor,
    ) -> Result<RekeyUpdate> {
        let share =
            Share::decode(encoded_share).map_err(|error| VaultError::Invalid(error.to_string()))?;
        let required = self.keyring.status().threshold;
        let key = keyring_key(&self.keyring);
        let ready = {
            let mut map = rekeys().lock().unwrap_or_else(|poison| poison.into_inner());
            let Some(progress) = map.get_mut(&key) else {
                return Err(VaultError::NotFound("no rekey is in progress".into()).into());
            };
            if now_millis() - progress.started_at > REKEY_TTL_MILLIS {
                map.remove(&key);
                return Err(VaultError::NotFound("the rekey expired; start again".into()).into());
            }
            if progress.nonce != nonce {
                return Err(VaultError::Invalid("the rekey nonce does not match".into()).into());
            }
            if progress
                .submitted
                .iter()
                .any(|existing| existing.x == share.x)
            {
                return Err(
                    VaultError::Invalid("this key share was already submitted".into()).into(),
                );
            }
            progress.submitted.push(share);
            if progress.submitted.len() < required as usize {
                let status = rekey_status(&self.keyring, Some(progress));
                return Ok(RekeyUpdate {
                    complete: false,
                    status,
                    shares: Vec::new(),
                });
            }
            (
                std::mem::take(&mut progress.submitted),
                progress.new_shares,
                progress.new_threshold,
            )
        };
        let (submitted, new_shares, new_threshold) = ready;
        let result = self
            .rekey_complete(&submitted, new_shares, new_threshold)
            .await;
        match result {
            Ok(shares) => {
                rekeys()
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remove(&key);
                self.audit(
                    &AuditEntry::new(actor, "sys.rekey.complete", "ok").details(json!({
                        "newShares": new_shares,
                        "newThreshold": new_threshold,
                    })),
                )
                .await;
                Ok(RekeyUpdate {
                    complete: true,
                    status: self.rekey_status(),
                    shares,
                })
            }
            Err(error) => {
                self.audit(
                    &AuditEntry::new(actor, "sys.rekey.update", "denied")
                        .details(json!({ "reason": error.to_string() })),
                )
                .await;
                Err(VaultError::Denied(format!("{error}; rekey progress was reset")).into())
            }
        }
    }

    async fn rekey_complete(
        &self,
        submitted: &[Share],
        new_shares: u8,
        new_threshold: u8,
    ) -> Result<Vec<String>> {
        let old_root = shamir::combine(submitted)?;
        let new_root = random_bytes(32);
        let config = {
            let conn = self.conn.lock().await;
            provider_config(&conn)?
        };
        // With a provider, wrap the new root before touching the keyring so
        // the wrapped copy is replaced in the same transaction.
        let wrapped = match &config {
            Some(config) => Some(SealProvider::resolve(config)?.wrap(&new_root).await?),
            None => None,
        };
        let conn = self.conn.lock().await;
        let mut extra: Vec<(&str, &str)> = Vec::new();
        if let Some(wrapped) = &wrapped {
            extra.push((META_PROVIDER_WRAPPED, wrapped));
        }
        self.keyring.replace_root(
            &conn,
            RootSource::Combined(&old_root),
            &new_root,
            new_shares,
            new_threshold,
            &extra,
        )
    }
}

/// At boot, unseal a provider-sealed vault in the background, retrying with
/// backoff while the provider is unreachable. A vault without a provider, or
/// one already unsealed, is left alone.
pub fn spawn_auto_unseal(store: &'static PluginSecretStore) {
    tokio::spawn(async move {
        let configured = {
            let conn = store.conn.lock().await;
            provider_config(&conn).ok().flatten().is_some()
        };
        if !configured {
            return;
        }
        let mut delay = Duration::from_secs(2);
        loop {
            if !store.keyring.is_sealed() {
                return;
            }
            match store.seal_provider_unseal(&AuditActor::system()).await {
                Ok(_) => {
                    tracing::info!("vault auto-unsealed from its seal provider");
                    return;
                }
                Err(error) => {
                    tracing::warn!("vault auto-unseal failed; retrying in {delay:?}: {error:#}");
                }
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(300));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    thread_local! {
        /// Per-thread provider env. Once set, every provider variable is read
        /// from it (absent means unset), never from the process environment.
        static ENV: RefCell<Option<HashMap<String, String>>> = const { RefCell::new(None) };
    }

    pub(super) fn env_override(name: &str) -> Option<Option<String>> {
        ENV.with(|env| env.borrow().as_ref().map(|vars| vars.get(name).cloned()))
    }

    fn set_env(vars: &[(&str, &str)]) {
        ENV.with(|env| {
            *env.borrow_mut() = Some(
                vars.iter()
                    .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                    .collect(),
            );
        });
    }

    fn transit(address: &str) -> SealProviderConfig {
        SealProviderConfig::Transit {
            address: address.into(),
            key_name: "seal".into(),
        }
    }

    #[test]
    fn transit_credentials_go_only_to_the_pinned_address() {
        set_env(&[(ENV_TRANSIT_TOKEN, "rvt_x")]);
        let error = SealProvider::resolve(&transit("https://vault-root.example.com"))
            .err()
            .unwrap();
        assert!(
            error.to_string().contains(ENV_TRANSIT_ADDRESS),
            "fails closed"
        );

        set_env(&[
            (ENV_TRANSIT_ADDRESS, "https://vault-root.example.com/"),
            (ENV_TRANSIT_TOKEN, "rvt_x"),
        ]);
        assert!(SealProvider::resolve(&transit("https://attacker.example")).is_err());
        assert!(SealProvider::resolve(&transit("https://vault-root.example.com.evil.io")).is_err());
        let Ok(SealProvider::Transit { address, .. }) =
            SealProvider::resolve(&transit("https://vault-root.example.com"))
        else {
            panic!("the pinned address resolves");
        };
        assert_eq!(address, "https://vault-root.example.com");

        set_env(&[
            (ENV_TRANSIT_ADDRESS, "https://vault-root.example.com"),
            (ENV_TRANSIT_ROLE_ID, "role"),
        ]);
        assert!(
            SealProvider::resolve(&transit("https://vault-root.example.com")).is_err(),
            "half an AppRole pair"
        );
    }

    /// A fake transit node: AppRole login mints `rvt_fresh`; transit ops
    /// accept only that token.
    async fn fake_transit_node() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::post;
        use axum::Json;
        use std::sync::atomic::{AtomicUsize, Ordering};

        fn authorized(headers: &HeaderMap) -> bool {
            headers
                .get("x-ryu-vault-token")
                .is_some_and(|value| value == "rvt_fresh")
        }
        let logins = Arc::new(AtomicUsize::new(0));
        let counter = logins.clone();
        let app = axum::Router::new()
            .route(
                "/api/vault/auth/approle/login",
                post(move |Json(body): Json<Value>| {
                    let counter = counter.clone();
                    async move {
                        if body == json!({ "roleId": "role-1", "secretId": "sid-1" }) {
                            counter.fetch_add(1, Ordering::SeqCst);
                            Ok(Json(json!({ "token": { "token": "rvt_fresh" } })))
                        } else {
                            Err(StatusCode::FORBIDDEN)
                        }
                    }
                }),
            )
            .route(
                "/api/vault/agent/transit/encrypt/seal",
                post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                    if !authorized(&headers) {
                        return Err(StatusCode::FORBIDDEN);
                    }
                    let plaintext = body["plaintext"].as_str().unwrap_or_default();
                    Ok(Json(json!({ "ciphertext": format!("ct:{plaintext}") })))
                }),
            )
            .route(
                "/api/vault/agent/transit/decrypt/seal",
                post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                    if !authorized(&headers) {
                        return Err(StatusCode::FORBIDDEN);
                    }
                    let ciphertext = body["ciphertext"].as_str().unwrap_or_default();
                    let plaintext = ciphertext.strip_prefix("ct:").unwrap_or_default();
                    Ok(Json(json!({ "plaintext": plaintext })))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (address, logins)
    }

    #[tokio::test]
    async fn transit_provider_logs_in_on_every_use() {
        let (address, logins) = fake_transit_node().await;
        set_env(&[
            (ENV_TRANSIT_ADDRESS, &address),
            (ENV_TRANSIT_ROLE_ID, "role-1"),
            (ENV_TRANSIT_SECRET_ID, "sid-1"),
        ]);
        let provider = SealProvider::resolve(&transit(&address)).unwrap();
        let wrapped = provider.wrap(b"root").await.unwrap();
        assert_eq!(provider.unwrap(&wrapped).await.unwrap(), b"root");
        assert_eq!(logins.load(std::sync::atomic::Ordering::SeqCst), 2);

        // A fixed token that the node no longer accepts (expired) fails.
        set_env(&[
            (ENV_TRANSIT_ADDRESS, &address),
            (ENV_TRANSIT_TOKEN, "rvt_expired"),
        ]);
        let stale = SealProvider::resolve(&transit(&address)).unwrap();
        let error = stale.wrap(b"root").await.unwrap_err().to_string();
        assert!(error.contains("403"), "{error}");
    }

    #[tokio::test]
    async fn configuring_a_provider_from_auto_mode_keeps_every_row() {
        set_env(&[(ENV_STATIC_KEY, &"42".repeat(32))]);
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        store
            .set("com.example", "API_KEY", "auto-row")
            .await
            .unwrap();
        let shares = store
            .seal_provider_configure(
                &SealProviderConfig::Static {
                    key_fingerprint: None,
                },
                3,
                2,
                &actor,
            )
            .await
            .unwrap();
        assert_eq!(shares.len(), 3);
        assert_eq!(store.keyring.status().mode, SealMode::Shamir);
        store
            .set("com.example", "LATER", "provider-row")
            .await
            .unwrap();

        store.keyring.seal();
        store.seal_provider_unseal(&actor).await.unwrap();
        assert!(!store.keyring.is_sealed());
        assert_eq!(
            store
                .get("com.example", "API_KEY")
                .await
                .unwrap()
                .as_deref(),
            Some("auto-row")
        );
        assert_eq!(
            store.get("com.example", "LATER").await.unwrap().as_deref(),
            Some("provider-row")
        );

        // A different static key is refused instead of unsealing garbage.
        set_env(&[(ENV_STATIC_KEY, &"43".repeat(32))]);
        store.keyring.seal();
        assert!(store.seal_provider_unseal(&actor).await.is_err());
        assert!(store.keyring.is_sealed());
    }

    #[tokio::test]
    async fn configuring_a_provider_from_shamir_mode_retires_old_shares() {
        set_env(&[(ENV_STATIC_KEY, &"24".repeat(32))]);
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        store.set("com.example", "API_KEY", "value").await.unwrap();
        let old = {
            let conn = store.conn.lock().await;
            store.keyring.init_shamir(&conn, 3, 2).unwrap()
        };
        let recovery = store
            .seal_provider_configure(
                &SealProviderConfig::Static {
                    key_fingerprint: None,
                },
                3,
                2,
                &actor,
            )
            .await
            .unwrap();

        store.keyring.seal();
        {
            let conn = store.conn.lock().await;
            store.keyring.submit_share(&conn, &old[0]).unwrap();
            assert!(store.keyring.submit_share(&conn, &old[1]).is_err());
            assert!(store.keyring.is_sealed(), "old shares no longer unseal");
        }
        store.keyring.seal();
        {
            let conn = store.conn.lock().await;
            store.keyring.submit_share(&conn, &recovery[0]).unwrap();
            assert!(
                !store
                    .keyring
                    .submit_share(&conn, &recovery[2])
                    .unwrap()
                    .sealed
            );
        }
        store.keyring.seal();
        store.seal_provider_unseal(&actor).await.unwrap();
        assert_eq!(
            store
                .get("com.example", "API_KEY")
                .await
                .unwrap()
                .as_deref(),
            Some("value")
        );
    }

    fn static_provider() -> SealProvider {
        SealProvider::Static { key: [7u8; 32] }
    }

    #[tokio::test]
    async fn static_provider_round_trips_and_rejects_other_keys() {
        let provider = static_provider();
        let wrapped = provider.wrap(b"root-key-bytes").await.unwrap();
        assert!(wrapped.starts_with(STATIC_WRAP_PREFIX));
        assert_eq!(provider.unwrap(&wrapped).await.unwrap(), b"root-key-bytes");
        let other = SealProvider::Static { key: [8u8; 32] };
        assert!(other.unwrap(&wrapped).await.is_err());
        assert!(provider.unwrap("garbage").await.is_err());
    }

    #[test]
    fn static_keys_decode_from_hex_or_base64() {
        let hex_key = "11".repeat(32);
        assert_eq!(decode_static_key(&hex_key).unwrap(), [0x11; 32]);
        let b64 = base64::engine::general_purpose::STANDARD.encode([0x22u8; 32]);
        assert_eq!(decode_static_key(&b64).unwrap(), [0x22; 32]);
        assert!(decode_static_key("short").is_err());
        assert!(decode_static_key(&"11".repeat(31)).is_err());
    }

    #[test]
    fn transit_settings_require_https_and_a_key_name() {
        let ok = SealProviderConfig::Transit {
            address: "https://vault.example.com".into(),
            key_name: "seal".into(),
        };
        assert!(ok.validate().is_ok());
        let plain = SealProviderConfig::Transit {
            address: "http://vault.example.com".into(),
            key_name: "seal".into(),
        };
        assert!(plain.validate().is_err());
        let creds = SealProviderConfig::Transit {
            address: "https://user:pw@vault.example.com".into(),
            key_name: "seal".into(),
        };
        assert!(creds.validate().is_err());
        let loopback = SealProviderConfig::Transit {
            address: "http://127.0.0.1:7980".into(),
            key_name: "seal".into(),
        };
        assert!(loopback.validate().is_ok());
    }

    /// Configure a provider directly through the keyring with a known static
    /// key (the env-backed resolver is exercised separately).
    async fn provider_sealed_store() -> (PluginSecretStore, Vec<String>, String) {
        let store = PluginSecretStore::in_memory().unwrap();
        let provider = static_provider();
        let root = random_bytes(32);
        let wrapped = provider.wrap(&root).await.unwrap();
        let config = serde_json::to_string(&provider.persisted(&SealProviderConfig::Static {
            key_fingerprint: None,
        }))
        .unwrap();
        let conn = store.conn.lock().await;
        let shares = store
            .keyring
            .replace_root(
                &conn,
                RootSource::Master,
                &root,
                3,
                2,
                &[
                    (META_PROVIDER_CONFIG, &config),
                    (META_PROVIDER_WRAPPED, &wrapped),
                ],
            )
            .unwrap();
        drop(conn);
        (store, shares, wrapped)
    }

    #[tokio::test]
    async fn provider_wrapped_root_unseals_and_recovery_shares_still_work() {
        let (store, shares, wrapped) = provider_sealed_store().await;
        let (version, nonce, ct) = store.keyring.encrypt(b"guarded").unwrap();
        store.keyring.seal();

        // Auto-unseal path: the provider unwraps the root.
        let root = static_provider().unwrap(&wrapped).await.unwrap();
        {
            let conn = store.conn.lock().await;
            store.keyring.unseal_with_root(&conn, &root).unwrap();
        }
        assert_eq!(
            store.keyring.decrypt(version, &nonce, &ct).unwrap(),
            b"guarded"
        );

        // Recovery path: the shares unseal without the provider.
        store.keyring.seal();
        {
            let conn = store.conn.lock().await;
            store.keyring.submit_share(&conn, &shares[0]).unwrap();
            let status = store.keyring.submit_share(&conn, &shares[2]).unwrap();
            assert!(!status.sealed);
        }
        let status = store.seal_provider_status().await.unwrap();
        assert_eq!(status.provider.unwrap().kind(), "static");
        assert_eq!((status.recovery_shares, status.recovery_threshold), (3, 2));

        // A wrong root never unseals.
        store.keyring.seal();
        let conn = store.conn.lock().await;
        assert!(store.keyring.unseal_with_root(&conn, &[1u8; 32]).is_err());
        assert!(store.keyring.is_sealed());
    }

    #[tokio::test]
    async fn removing_the_provider_keeps_shamir_shares() {
        let (store, shares, _) = provider_sealed_store().await;
        let actor = AuditActor::system();
        store.seal_provider_remove(&actor).await.unwrap();
        assert!(store
            .seal_provider_status()
            .await
            .unwrap()
            .provider
            .is_none());
        assert!(store.seal_provider_unseal(&actor).await.is_err());
        store.keyring.seal();
        let conn = store.conn.lock().await;
        store.keyring.submit_share(&conn, &shares[1]).unwrap();
        assert!(
            !store
                .keyring
                .submit_share(&conn, &shares[0])
                .unwrap()
                .sealed
        );
    }

    #[tokio::test]
    async fn rekey_needs_a_quorum_and_replaces_the_shares() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        let (version, nonce, ct) = store.keyring.encrypt(b"value").unwrap();
        let old = {
            let conn = store.conn.lock().await;
            store.keyring.init_shamir(&conn, 3, 2).unwrap()
        };
        let started = store.rekey_init(5, 3, &actor).await.unwrap();
        assert!(started.started);
        assert_eq!(started.required, 2);
        assert!(
            store.rekey_init(5, 3, &actor).await.is_err(),
            "one rekey at a time"
        );
        let nonce_value = started.nonce.unwrap();

        assert!(store.rekey_update("wrong", &old[0], &actor).await.is_err());
        let first = store
            .rekey_update(&nonce_value, &old[0], &actor)
            .await
            .unwrap();
        assert!(!first.complete);
        assert_eq!(first.status.progress, 1);
        assert!(store
            .rekey_update(&nonce_value, &old[0], &actor)
            .await
            .is_err());
        let done = store
            .rekey_update(&nonce_value, &old[1], &actor)
            .await
            .unwrap();
        assert!(done.complete);
        assert_eq!(done.shares.len(), 5);
        assert!(!store.rekey_status().started);
        assert_eq!(store.keyring.status().threshold, 3);
        assert_eq!(
            store.keyring.decrypt(version, &nonce, &ct).unwrap(),
            b"value"
        );

        // Old shares no longer unseal; three new shares do.
        store.keyring.seal();
        {
            let conn = store.conn.lock().await;
            // The new threshold is three, so all three old shares combine.
            store.keyring.submit_share(&conn, &old[0]).unwrap();
            store.keyring.submit_share(&conn, &old[1]).unwrap();
            assert!(store.keyring.submit_share(&conn, &old[2]).is_err());
            assert!(store.keyring.is_sealed());
        }
        store.keyring.seal();
        let conn = store.conn.lock().await;
        for share in &done.shares[2..] {
            store.keyring.submit_share(&conn, share).unwrap();
        }
        assert!(!store.keyring.is_sealed());
        assert_eq!(
            store.keyring.decrypt(version, &nonce, &ct).unwrap(),
            b"value"
        );
    }

    #[tokio::test]
    async fn a_foreign_quorum_resets_rekey_progress_without_changes() {
        let store = PluginSecretStore::in_memory().unwrap();
        let other = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        {
            let conn = store.conn.lock().await;
            store.keyring.init_shamir(&conn, 3, 2).unwrap();
        }
        let foreign = {
            let conn = other.conn.lock().await;
            other.keyring.init_shamir(&conn, 3, 2).unwrap()
        };
        let started = store.rekey_init(3, 2, &actor).await.unwrap();
        let nonce = started.nonce.unwrap();
        store
            .rekey_update(&nonce, &foreign[0], &actor)
            .await
            .unwrap();
        assert!(store
            .rekey_update(&nonce, &foreign[1], &actor)
            .await
            .is_err());
        let status = store.rekey_status();
        assert!(status.started);
        assert_eq!(status.progress, 0);
        store.rekey_cancel(&actor).await.unwrap();
        assert!(store.rekey_cancel(&actor).await.is_err());
    }

    #[tokio::test]
    async fn rekey_requires_shamir_mode() {
        let store = PluginSecretStore::in_memory().unwrap();
        assert!(store.rekey_init(3, 2, &AuditActor::system()).await.is_err());
    }
}
