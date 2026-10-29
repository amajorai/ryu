//! Native CLI accounts own isolated vendor homes. The sealed vault stores their
//! identity and lifecycle, never an opaque label masquerading as authorization.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;

use super::accounts::AccountVault;

pub const SCOPE: &str = "native:kiro";
pub const KIND: &str = "native_cli";

/// Resolve only an actual configured native CLI executable. Generic ACP labels
/// and shell wrappers cannot opt into this custody boundary by substring match.
pub fn for_spawn(spawn_cmd: &str) -> Result<Option<NativeAccounts>> {
    use crate::sidecar::adapters::acp_spawn::AcpSpawn;
    use std::str::FromStr;
    let agent =
        AcpSpawn::from_str(spawn_cmd).map_err(|error| anyhow!("ACP spawn parse: {error}"))?;
    let agent_client_protocol::schema::v1::McpServer::Stdio(stdio) = agent.into_server() else {
        return Ok(None);
    };
    let name = stdio
        .command
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !name.eq_ignore_ascii_case("kiro-cli.exe") && !name.eq_ignore_ascii_case("kiro-cli") {
        return Ok(None);
    }
    if !stdio.command.is_absolute() {
        bail!("Native Kiro custody requires an absolute configured CLI executable");
    }
    static MANAGER: std::sync::OnceLock<Mutex<Option<NativeAccounts>>> = std::sync::OnceLock::new();
    let mut manager = MANAGER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| anyhow!("Native account manager unavailable"))?;
    if let Some(existing) = manager.as_ref() {
        if existing.cli != stdio.command {
            bail!("Native Kiro executable changed; restart Core to reconnect custody");
        }
        return Ok(Some(existing.clone()));
    }
    let vault = super::accounts::global()
        .ok_or_else(|| anyhow!("Account vault not initialized"))?
        .clone();
    let created = NativeAccounts::new(vault, &crate::paths::secrets_dir(), &stdio.command)?;
    *manager = Some(created.clone());
    Ok(Some(created))
}

/// ACP's transport inherits its parent environment. Empty inherited vendor auth
/// variables before overlaying the captured home to prevent global AWS/Kiro auth
/// from overriding profile-owned authorization.
pub fn isolated_env(mut profile: HashMap<String, String>) -> HashMap<String, String> {
    for (key, _) in std::env::vars() {
        if is_vendor_auth_env(&key) && !profile.contains_key(&key) {
            profile.insert(key, String::new());
        }
    }
    profile
}

pub fn is_vendor_auth_env(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.starts_with("AWS_") || key.starts_with("KIRO_") || key.starts_with("Q_")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Pending,
    Connected,
    Disconnected,
}

/// Identity comes from the CLI's successful `whoami --format json`, not from
/// ACP authenticate completion. The identity parser fails closed on unknown shapes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIdentity {
    pub subject: String,
    pub issuer: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration {
    version: u32,
    custody_namespace: String,
    identity_epoch: String,
    credential_revision: u64,
    state: ConnectionState,
    identity: Option<NativeIdentity>,
}

/// Safe picker shape: excludes the sealed record and vendor credential content.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAccountInfo {
    pub account_id: String,
    pub label: String,
    pub active: bool,
    pub state: ConnectionState,
    pub verified: bool,
    pub kind: String,
}

/// Immutable affinity captured before dispatch. Epoch changes invalidate resume;
/// credential rotation changes process reuse without changing account identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAffinity {
    pub account_id: String,
    pub custody_namespace: String,
    pub identity_epoch: String,
    pub credential_revision: u64,
}

impl NativeAffinity {
    pub fn resume_matches(&self, other: &Self) -> bool {
        self.account_id == other.account_id
            && self.custody_namespace == other.custody_namespace
            && self.identity_epoch == other.identity_epoch
    }
    pub fn process_identity(&self) -> String {
        format!(
            "kiro:{}:{}:{}:{}",
            self.account_id, self.custody_namespace, self.identity_epoch, self.credential_revision
        )
    }
}

#[derive(Clone)]
pub struct NativeLaunch {
    pub affinity: NativeAffinity,
    pub env: HashMap<String, String>,
}

/// Retained by the login route until the child exits. Its expected sealed value
/// prevents late completion from attaching to a disconnected or removed account.
pub struct NativeLoginAttempt {
    account_id: String,
    expected: Value,
    registration: Registration,
    env: HashMap<String, String>,
    _operation: tokio::sync::OwnedMutexGuard<()>,
}

/// One manager per Core owns lifecycle serialization. Async child processes do
/// not hold this lock. Their completion uses an optimistic sealed-record compare.
#[derive(Clone)]
pub struct NativeAccounts {
    vault: AccountVault,
    root: PathBuf,
    cli: PathBuf,
    mutation: Arc<Mutex<()>>,
    operations: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

mod custody_fs;
mod identity;
mod lifecycle;
mod registry;

pub use identity::parse_identity;

#[cfg(test)]
mod tests;
