//! Node-local cloud templates and personal vault. Secrets are sealed at rest;
//! read projections never contain values. Unsupported egress policies fail closed.
#[path = "cloud_environments/box_flag.rs"]
mod box_flag;
#[path = "cloud_environments/box_secrets.rs"]
mod box_secrets;
#[path = "cloud_environments/github.rs"]
mod github;
#[path = "cloud_environments/handlers.rs"]
mod handlers;
#[path = "cloud_environments/launch.rs"]
mod launch;
#[path = "cloud_environments/org_github.rs"]
mod org_github;
#[path = "cloud_environments/policy.rs"]
mod policy;
#[path = "cloud_environments/prepare.rs"]
mod prepare;
#[path = "cloud_environments/script.rs"]
mod script;
#[path = "cloud_environments/shared.rs"]
mod shared;
#[path = "cloud_environments/store_update.rs"]
mod store_update;
#[path = "cloud_environments/validation.rs"]
mod validation;
use super::{ResolvedAuthorization, ServerState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Extension, Json, Router,
};
use ryu_sandbox::{ExecSpec, Sandbox, SandboxCapabilities};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
};

static STORE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn vpn_runtime() -> anyhow::Result<ryu_sandbox::governed_vpn::GovernedVpnDocker> {
    let image = |name| {
        std::env::var(name)
            .map_err(|_| anyhow::anyhow!("VPN runtime image configuration is missing"))
    };
    ryu_sandbox::governed_vpn::GovernedVpnDocker::new(
        std::env::var_os("RYU_SANDBOX_DOCKER_BINARY").unwrap_or_else(|| "docker".into()),
        image("RYU_SANDBOX_VPN_WORKLOAD_IMAGE")?,
        image("RYU_SANDBOX_VPN_EGRESS_IMAGE")?,
        image("RYU_SANDBOX_VPN_TAILSCALE_IMAGE")?,
        crate::paths::state_path("cloud-vpn-leases"),
    )
}

pub(super) fn start_vpn_recovery() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    STARTED.call_once(|| {
        handle.spawn(async {
            let mut timer = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                timer.tick().await;
                if !crate::paths::state_path("cloud-vpn-leases").exists() { continue; }
                match vpn_runtime() {
                    Ok(runtime) => {
                        if runtime.recover_expired().await.is_err() {
                            tracing::warn!("Cloud environment VPN lease recovery failed; leases remain for retry");
                        }
                    }
                    Err(_) => tracing::warn!("Cloud environment VPN lease recovery needs configured runtime images"),
                }
            }
        });
    });
}

#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[schema(as = CloudEnvironmentInternet)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Internet {
    enabled: bool,
    domain_policy: String,
    allowed_domains: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[schema(as = CloudEnvironment)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Environment {
    id: String,
    name: String,
    repositories: Vec<String>,
    install_script: String,
    start_instructions: String,
    internet: Internet,
    privacy: String,
    vault_keys: Vec<String>,
    tailscale_vault_key: Option<String>,
    published: bool,
    #[serde(default)]
    runtime: Runtime,
}
/// Where and how a conversation's cloud task runs. Older documents omit it and
/// read as the default (`auto` backend, Ryu executor, 30 minutes).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[schema(as = CloudEnvironmentRuntime)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Runtime {
    /// `auto` keeps the node's configured sandbox; `box` gives each conversation
    /// a fresh disposable Ryu Box.
    pub backend: String,
    /// `ryu`, `claude-code`, `codex`, `opencode` or `cursor`.
    pub executor: String,
    /// Session length, 5 to 240 minutes. Honored only for the `box` backend.
    pub lifetime_minutes: u32,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            backend: "auto".into(),
            executor: "ryu".into(),
            lifetime_minutes: 30,
        }
    }
}
const RUNTIME_EXECUTORS: [&str; 5] = ["ryu", "claude-code", "codex", "opencode", "cursor"];
#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[schema(as = CloudVaultEntry)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultEntry {
    id: String,
    key: String,
    kind: String,
    environment_ids: Vec<String>,
    domains: Vec<String>,
    #[serde(default)]
    has_value: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(write_only)]
    value: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[schema(as = CloudEnvironmentState)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    schema_version: u32,
    revision: u64,
    environments: Vec<Environment>,
    vault: Vec<VaultEntry>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            environments: vec![],
            vault: vec![],
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Store {
    schema_version: u32,
    owners: BTreeMap<String, Snapshot>,
}
pub(super) type ApiError = (StatusCode, Json<Value>);
fn error(status: StatusCode, code: &str, message: &str) -> ApiError {
    (
        status,
        Json(
            json!({"error":{"code":code,"message":message},"requestId":uuid::Uuid::new_v4().to_string()}),
        ),
    )
}
pub(super) fn owner(auth: &ResolvedAuthorization) -> Result<String, ApiError> {
    use crate::authorization::Principal;
    match &auth.context.principal {
        Principal::Owner => Ok(auth.caller.as_ref().map_or_else(
            || "node-owner".into(),
            |caller| format!("user:{}", caller.user_id),
        )),
        Principal::User { subject_id }
            if auth
                .caller
                .as_ref()
                .is_none_or(|caller| caller.user_id == *subject_id) =>
        {
            Ok(format!("user:{subject_id}"))
        }
        // Paired clients do not carry the verified account identity needed for
        // personal cloud vault ownership.
        _ => Err(error(
            StatusCode::FORBIDDEN,
            "cloud_environment_forbidden",
            "A personal user identity is required.",
        )),
    }
}
fn load() -> Result<Store, ApiError> {
    let path = crate::paths::state_path("cloud-environments.json");
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Store>(&bytes)
            .and_then(|store| {
                if store.schema_version != 1 {
                    return Err(serde::de::Error::custom("unsupported schema"));
                }
                Ok(store)
            })
            .map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cloud_environment_store_unavailable",
                    "The environment store cannot be read.",
                )
            }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store {
            schema_version: 1,
            ..Store::default()
        }),
        Err(_) => Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_store_unavailable",
            "The environment store is unavailable.",
        )),
    }
}
fn save(store: &Store) -> Result<(), ApiError> {
    let directory = crate::paths::state_dir();
    let path = directory.join("cloud-environments.json");
    let temp = directory.join(format!(".cloud-environments-{}.tmp", uuid::Uuid::new_v4()));
    let write = || -> anyhow::Result<()> {
        use std::io::Write;
        std::fs::create_dir_all(&directory)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec(store)?)?;
        file.sync_all()?;
        std::fs::rename(&temp, &path)?;
        Ok(())
    };
    if write().is_err() {
        let _ = std::fs::remove_file(temp);
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_store_unavailable",
            "The environment store could not be saved.",
        ));
    }
    Ok(())
}
fn projection(mut state: Snapshot) -> Snapshot {
    for entry in &mut state.vault {
        entry.has_value = entry.value.is_some();
        entry.value = None;
    }
    state
}

#[cfg(test)]
pub(in crate::server) use self::box_flag::TEST_NODE_ORG;
use self::{box_flag::*, policy::*, script::*, shared::*, store_update::*, validation::*};
pub(in crate::server) use self::{
    box_flag::{require_box_backend_feature, BOX_BACKEND_FLAG},
    box_secrets::BoxNetworkPlan,
    policy::{approve_network_policy, approve_setup_budget},
    prepare::prepare_environment,
    script::{github_basic_credential, GitPushCredential, PreparedEnvironment, TaskBackend},
    shared::{openapi, routes},
    validation::runtime_for,
};

#[cfg(test)]
#[path = "cloud_environments/tests.rs"]
pub(super) mod tests;
