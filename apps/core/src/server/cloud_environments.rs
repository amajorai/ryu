//! Node-local cloud templates and personal vault. Secrets are sealed at rest;
//! read projections never contain values. Unsupported egress policies fail closed.
#[path = "cloud_environments/github.rs"]
mod github;
#[path = "cloud_environments/org_github.rs"]
mod org_github;
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
fn reserved(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.starts_with("RYU_")
        || upper.starts_with("CODEX_")
        || upper.starts_with("LD_")
        || upper.starts_with("DYLD_")
        || matches!(
            upper.as_str(),
            "PATH"
                | "HOME"
                | "USERPROFILE"
                | "SHELL"
                | "COMSPEC"
                | "NODE_OPTIONS"
                | "BUN_OPTIONS"
                | "HTTP_PROXY"
                | "HTTPS_PROXY"
                | "ALL_PROXY"
                | "NO_PROXY"
        )
}
fn valid_key(key: &str) -> bool {
    key.len() <= 128
        && !reserved(key)
        && key
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
fn import_authorized(auth: &ResolvedAuthorization) -> Result<(), ApiError> {
    if !matches!(
        auth.context.principal,
        crate::authorization::Principal::Owner
    ) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "cloud_environment_import_forbidden",
            "Only the node owner can import variables from this node's shell environment.",
        ));
    }
    Ok(())
}
fn importable_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    valid_key(key)
        && !upper.starts_with("AWS_")
        && !upper.starts_with("AZURE_")
        && !upper.starts_with("GOOGLE_")
        && !upper.contains("DATABASE")
        && !upper.starts_with("MONGO")
        && !upper.starts_with("REDIS")
        && !upper.starts_with("OPENCODE_")
        && !upper.starts_with("GITHUB_")
}
/// Hosts a restricted Box allowlist must contain for this runtime.
fn box_required_hosts(executor: &str) -> Vec<&'static str> {
    use ryu_sandbox::box_session::{ManagedProvider, BOX_BASE_HOSTS};
    let mut hosts: Vec<&'static str> = BOX_BASE_HOSTS.to_vec();
    if let Some(provider) = ManagedProvider::from_executor(executor) {
        hosts.extend(provider.required_hosts());
    }
    hosts
}
fn host_allowed(allowed: &[String], host: &str) -> bool {
    allowed.iter().any(|entry| {
        entry == host
            || entry
                .strip_prefix("*.")
                .is_some_and(|suffix| host.ends_with(&format!(".{suffix}")))
    })
}
/// Hosts from [`box_required_hosts`] the expanded allowlist is missing. Empty
/// when internet is disabled or unrestricted.
fn missing_box_hosts(internet: &Internet, executor: &str) -> Vec<&'static str> {
    use ryu_sandbox::governed::EgressPolicy;
    let EgressPolicy::AllowedHosts(allowed) = governed_spec(internet, vec![]).egress else {
        return vec![];
    };
    box_required_hosts(executor)
        .into_iter()
        .filter(|host| !host_allowed(&allowed, host))
        .collect()
}
/// Box's per-command env limit (`MAX_BOX_ENV_ENTRIES` in apps/box).
const MAX_BOX_ENV_ENTRIES: usize = 64;
/// Names the Box service reserves beyond Core's own `reserved` list. Box
/// compares them case-sensitively.
fn box_reserved_key(key: &str) -> bool {
    matches!(key, "HOSTNAME" | "PWD" | "USER")
        || key.starts_with("DOCKER_")
        || key.starts_with("RYU_BOX_")
}
/// Stable key of the Fresh cloud box rollout flag. Must equal
/// `CLOUD_TASKS_BOX_BACKEND_FLAG` in `packages/auth/src/lib/feature-flags.ts`,
/// where the flag is marked `coreClaim` so it rides the signed JWT.
pub(super) const BOX_BACKEND_FLAG: &str = "cloud_tasks.box_backend";

/// Who is asking for the box backend, as far as the rollout gate is concerned.
#[derive(Debug, PartialEq, Eq)]
enum BoxFeatureSubject<'a> {
    /// The node owner over the node credential with no cloud identity at all.
    LocalOwner,
    /// Any request that carries, or claims, a cloud user identity: a verified
    /// caller, or a user principal. `token` is the request's already verified
    /// user JWT when one exists.
    Cloud { token: Option<&'a str> },
}

fn box_feature_subject(auth: &ResolvedAuthorization) -> BoxFeatureSubject<'_> {
    use crate::authorization::Principal;
    if auth.caller.is_none() && matches!(auth.context.principal, Principal::Owner) {
        BoxFeatureSubject::LocalOwner
    } else {
        BoxFeatureSubject::Cloud {
            token: auth.verified_user_jwt.as_deref(),
        }
    }
}

fn box_feature_unavailable() -> ApiError {
    error(
        StatusCode::FORBIDDEN,
        "cloud_environment_feature_unavailable",
        "The Fresh cloud box backend is not enabled for this account yet.",
    )
}

fn box_feature_wrong_org() -> ApiError {
    error(
        StatusCode::FORBIDDEN,
        "cloud_environment_feature_unavailable",
        "The Fresh cloud box backend was evaluated for a different organization. Switch to this node's organization and try again.",
    )
}

/// Authoritative Core gate for the `cloud_tasks.box_backend` rollout flag.
///
/// - Verified cloud caller (or any user principal): the flag must be in the
///   signed `ryu_flags` claim of the request's verified user JWT. No token, a
///   token that no longer verifies, or a claim without the key is 403
///   `cloud_environment_feature_unavailable` — fail closed. The claim is
///   evaluated by the control plane when the token is minted, so a flip (or a
///   kill switch) reaches Core within one token lifetime (Better Auth's JWT
///   default is 15 minutes); Core never calls the control plane here.
/// - Org context: the claim is evaluated for one organization (the session's
///   active org at mint, carried as `ryu_flags_org`), so org-role and
///   plan-targeted rules can be on in it. Cloud environments are stored per
///   user and record no org of their own; on an org-bound node they run under
///   the node's org, so a claim evaluated for a DIFFERENT org is refused (same
///   403 code). A claim with no org context (the user belongs to no org, or a
///   token minted before the org claim) carries only user-scoped evaluation and
///   is used as-is, as is any claim on a personal (unbound) node.
/// - Local owner with no cloud identity (node credential, no user JWT): there
///   is no per-user flag to read, so this gate does not apply. The node's Box
///   service configuration remains the gate (`session_box::box_configured()`:
///   the env credential or the installed control-plane source, at prepare,
///   launch and prompt; 503 `cloud_environment_backend_unavailable`).
pub(super) async fn require_box_backend_feature(
    auth: &ResolvedAuthorization,
) -> Result<(), ApiError> {
    let flags = match box_feature_subject(auth) {
        BoxFeatureSubject::LocalOwner => return Ok(()),
        BoxFeatureSubject::Cloud { token: None } => None,
        BoxFeatureSubject::Cloud { token: Some(token) } => {
            crate::identity_verify::verified_feature_flags(token).await
        }
    };
    box_backend_flag_decision(flags.as_ref(), gate_node_org().as_deref())
}

#[cfg(test)]
tokio::task_local! {
    /// Test-only node org for the box gate. Route tests scope a request with it
    /// to run as an org-bound node without registering one process-wide, which
    /// would change every concurrently running test that reads the binding.
    pub(super) static TEST_NODE_ORG: Option<String>;
}

/// The org this node is bound to, as the box gate sees it.
fn gate_node_org() -> Option<String> {
    #[cfg(test)]
    if let Ok(org) = TEST_NODE_ORG.try_with(Clone::clone) {
        return org;
    }
    super::node_org_id()
}

/// The pure half of [`require_box_backend_feature`]: `flags` is the verified
/// claim (or `None` when nothing verified) and `node_org` this node's bound
/// org, if any.
fn box_backend_flag_decision(
    flags: Option<&crate::identity_verify::VerifiedFeatureFlags>,
    node_org: Option<&str>,
) -> Result<(), ApiError> {
    let Some(flags) = flags.filter(|flags| flags.keys.contains(BOX_BACKEND_FLAG)) else {
        return Err(box_feature_unavailable());
    };
    match (node_org, flags.org.as_deref()) {
        (Some(node_org), Some(claim_org)) if node_org != claim_org => Err(box_feature_wrong_org()),
        _ => Ok(()),
    }
}

/// True when a save selects the box backend for an environment that did not
/// already have it. Only these saves need the rollout flag: an environment the
/// user saved while the flag was on stays editable (it still cannot start
/// without the flag, because prepare, launch and prompt check again).
fn newly_selects_box(previous: &Snapshot, incoming: &Snapshot) -> bool {
    incoming.environments.iter().any(|environment| {
        environment.runtime.backend == "box"
            && !previous
                .environments
                .iter()
                .any(|old| old.id == environment.id && old.runtime.backend == "box")
    })
}

/// CONTRACT C runtime rules, enforced on save and again at prepare.
///
/// Rollout gating: `runtime.backend == "box"` is behind the
/// `cloud_tasks.box_backend` rollout flag (default on for everyone since
/// 2026-10-20, fail closed, with a kill switch). The desktop hides it when off; Core enforces it for verified
/// cloud callers in [`require_box_backend_feature`] on save (when a save newly
/// selects box) and at prepare, launch and prompt, reading the signed
/// `ryu_flags` JWT claim. This function stays flag-free so it remains a pure
/// shape check. A local-owner call with no cloud identity has no flag source;
/// for it the hard gate is Box availability at prepare/launch/prompt time:
/// `box_backend::detect()` is `Available` only when the node's Box service
/// token is configured, otherwise those routes return 503
/// `cloud_environment_backend_unavailable`.
fn runtime_issue(environment: &Environment, vault: &[VaultEntry]) -> Option<ApiError> {
    let runtime = &environment.runtime;
    if !matches!(runtime.backend.as_str(), "auto" | "box")
        || !RUNTIME_EXECUTORS.contains(&runtime.executor.as_str())
        || !(5..=240).contains(&runtime.lifetime_minutes)
    {
        return Some(error(
            StatusCode::BAD_REQUEST,
            "cloud_environment_invalid",
            "Invalid environment runtime: backend must be auto or box, executor a supported agent, and lifetimeMinutes between 5 and 240.",
        ));
    }
    let unavailable = |message: String| {
        Some(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloud_environment_policy_unavailable",
            &message,
        ))
    };
    let is_box = runtime.backend == "box";
    if runtime.executor != "ryu" && !is_box {
        return unavailable(
            "Managed agents run only in a fresh cloud box. Select the Fresh cloud box backend."
                .into(),
        );
    }
    if runtime.executor != "ryu" && !environment.internet.enabled {
        return unavailable(
            "Managed agents need internet access to reach their model provider.".into(),
        );
    }
    if !is_box {
        return None;
    }
    if environment.tailscale_vault_key.is_some() {
        return unavailable("A fresh cloud box cannot join a VPN. Remove the Tailscale key or use the default backend.".into());
    }
    if environment.vault_keys.iter().any(|key| {
        vault
            .iter()
            .any(|entry| &entry.key == key && entry.kind == "networkSecret")
    }) {
        return unavailable("A fresh cloud box cannot substitute network secrets. Bind them as ordinary variables or use the default backend.".into());
    }
    let box_reserved: Vec<&str> = environment
        .vault_keys
        .iter()
        .map(String::as_str)
        .filter(|key| box_reserved_key(key))
        .collect();
    if !box_reserved.is_empty() {
        return unavailable(format!(
            "A fresh cloud box reserves these variable names: {}. Rename them or use the default backend.",
            box_reserved.join(", ")
        ));
    }
    if environment.vault_keys.len() > MAX_BOX_ENV_ENTRIES {
        return unavailable(format!(
            "A fresh cloud box accepts at most {MAX_BOX_ENV_ENTRIES} variables. Unselect some or use the default backend."
        ));
    }
    let missing = missing_box_hosts(&environment.internet, &runtime.executor);
    if !missing.is_empty() {
        return unavailable(format!(
            "A fresh cloud box with restricted internet must allow these domains: {}.",
            missing.join(", ")
        ));
    }
    None
}
/// The saved runtime for an owner's environment, if the environment exists.
pub(super) fn runtime_for(owner: &str, environment_id: &str) -> Option<Runtime> {
    let _lock = STORE_LOCK.lock().ok()?;
    load()
        .ok()?
        .owners
        .remove(owner)?
        .environments
        .into_iter()
        .find(|environment| environment.id == environment_id)
        .map(|environment| environment.runtime)
}
fn validate(state: &Snapshot) -> Result<(), ApiError> {
    let invalid = || {
        error(
            StatusCode::BAD_REQUEST,
            "cloud_environment_invalid",
            "Invalid environment settings or vault entries.",
        )
    };
    if state.schema_version != 1
        || state.revision >= 9_007_199_254_740_991
        || state.environments.len() > 100
        || state.vault.len() > 100
    {
        return Err(invalid());
    }
    let mut ids = BTreeSet::new();
    for environment in &state.environments {
        if environment.id.is_empty()
            || environment.id.len() > 128
            || !ids.insert(environment.id.clone())
            || environment.name.trim().is_empty()
            || environment.name.len() > 120
            || environment.install_script.len() > 65536
            || environment.start_instructions.len() > 65536
            || environment.repositories.len() > 20
            || environment.vault_keys.len() > 100
            || !matches!(environment.privacy.as_str(), "private" | "shared")
            || !matches!(
                environment.internet.domain_policy.as_str(),
                "all" | "packageManagers" | "custom"
            )
        {
            return Err(invalid());
        }
        for repository in &environment.repositories {
            let repo = repository
                .strip_prefix("https://github.com/")
                .unwrap_or(repository)
                .trim_end_matches(".git");
            if !valid_repository(repo) {
                return Err(invalid());
            }
        }
        if environment.internet.allowed_domains.len() > 100
            || environment
                .internet
                .allowed_domains
                .iter()
                .any(|d| !valid_domain(d))
        {
            return Err(invalid());
        }
    }
    let mut entries = BTreeSet::new();
    let mut keys = BTreeSet::new();
    for entry in &state.vault {
        if entry.id.is_empty()
            || entry.id.len() > 128
            || !entries.insert(entry.id.clone())
            || !keys.insert(entry.key.clone())
            || !valid_key(&entry.key)
            || !matches!(entry.kind.as_str(), "variable" | "networkSecret")
            || entry.value.as_ref().is_some_and(|v| v.len() > 65536)
            || entry.environment_ids.len() > 100
            || entry.environment_ids.iter().any(|id| !ids.contains(id))
            || entry.domains.len() > 100
            || entry.domains.iter().any(|d| !valid_domain(d))
        {
            return Err(invalid());
        }
    }
    for environment in &state.environments {
        if environment.vault_keys.iter().any(|key| !keys.contains(key))
            || environment.vault_keys.iter().any(|key| {
                state
                    .environments
                    .iter()
                    .any(|other| other.tailscale_vault_key.as_ref() == Some(key))
            })
            || environment
                .tailscale_vault_key
                .as_ref()
                .is_some_and(|key| !keys.contains(key))
        {
            return Err(invalid());
        }
        if let Some(issue) = runtime_issue(environment, &state.vault) {
            return Err(issue);
        }
    }
    Ok(())
}
fn valid_repository(repo: &str) -> bool {
    repo.len() <= 1024
        && repo.split('/').count() == 2
        && repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._/".contains(&byte))
        && repo
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
fn valid_domain(domain: &str) -> bool {
    let host = domain.strip_prefix("*.").unwrap_or(domain);
    if host.is_empty() || host.len() > 253 || host.contains('*') {
        return false;
    }
    if host.bytes().all(|c| c.is_ascii_digit() || c == b'.') {
        return !domain.starts_with("*.") && host.parse::<std::net::Ipv4Addr>().is_ok();
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    })
}
fn update(owner: &str, mut incoming: Snapshot, box_allowed: bool) -> Result<Snapshot, ApiError> {
    for environment in &mut incoming.environments {
        for domain in &mut environment.internet.allowed_domains {
            domain.make_ascii_lowercase();
        }
    }
    for entry in &mut incoming.vault {
        for domain in &mut entry.domains {
            domain.make_ascii_lowercase();
        }
    }
    validate(&incoming)?;
    let _lock = STORE_LOCK.lock().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_store_unavailable",
            "The environment store is unavailable.",
        )
    })?;
    let mut store = load()?;
    if store
        .owners
        .iter()
        .filter(|(identity, _)| identity.as_str() != owner)
        .any(|(_, state)| {
            state
                .environments
                .iter()
                .any(|old| incoming.environments.iter().any(|new| new.id == old.id))
        })
    {
        return Err(error(
            StatusCode::CONFLICT,
            "cloud_environment_id_conflict",
            "An environment ID is already in use. Create a new environment.",
        ));
    }
    let previous = store.owners.get(owner).cloned().unwrap_or_default();
    if !box_allowed && newly_selects_box(&previous, &incoming) {
        return Err(box_feature_unavailable());
    }
    if incoming.revision != previous.revision {
        return Err(error(
            StatusCode::CONFLICT,
            "cloud_environment_revision_conflict",
            "Settings changed. Reload before saving.",
        ));
    }
    crate::crypto_host::install();
    let cipher = ryu_crypto::global_cipher().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_vault_unavailable",
            "The encrypted vault is unavailable.",
        )
    })?;
    let vpn_keys: BTreeSet<_> = previous
        .environments
        .iter()
        .chain(&incoming.environments)
        .filter_map(|environment| environment.tailscale_vault_key.as_deref())
        .collect();
    let mut known_vpn_values = Vec::new();
    for entry in &previous.vault {
        if vpn_keys.contains(entry.key.as_str()) || entry.key.starts_with("CLOUD_VPN_") {
            if let Some(value) = &entry.value {
                known_vpn_values.push(cipher.open(value).map_err(|_| {
                    error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "cloud_environment_vault_unavailable",
                        "A saved VPN credential could not be opened.",
                    )
                })?);
            }
        }
    }
    for entry in &incoming.vault {
        if vpn_keys.contains(entry.key.as_str()) || entry.key.starts_with("CLOUD_VPN_") {
            if let Some(value) = &entry.value {
                known_vpn_values.push(value.clone());
            }
        }
    }
    let mut protected_network_values = Vec::new();
    for old in &previous.vault {
        if old.kind != "networkSecret" {
            continue;
        }
        let explicitly_visible = incoming.vault.iter().any(|entry| {
            entry.id == old.id
                && entry.key == old.key
                && entry.kind == "variable"
                && entry.value.is_some()
        });
        if explicitly_visible {
            continue;
        }
        if let Some(value) = &old.value {
            protected_network_values.push(cipher.open(value).map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cloud_environment_vault_unavailable",
                    "A saved network secret could not be opened.",
                )
            })?);
        }
    }
    for entry in &incoming.vault {
        if entry.kind == "networkSecret" {
            if let Some(value) = &entry.value {
                protected_network_values.push(value.clone());
            }
        }
    }
    if incoming.environments.iter().any(|environment| {
        known_vpn_values
            .iter()
            .chain(&protected_network_values)
            .any(|value| {
                !value.is_empty()
                    && (environment.install_script.contains(value)
                        || environment.start_instructions.contains(value))
            })
    }) {
        return Err(error(StatusCode::BAD_REQUEST, "cloud_environment_vpn_key_exposed", "Protected credentials must stay in the personal vault and must not appear in scripts or instructions."));
    }
    for entry in &incoming.vault {
        if !incoming
            .environments
            .iter()
            .any(|environment| environment.vault_keys.contains(&entry.key))
        {
            continue;
        }
        let value = match &entry.value {
            Some(value) => Some(value.clone()),
            None => previous
                .vault
                .iter()
                .find(|old| old.id == entry.id && old.key == entry.key && old.kind == entry.kind)
                .and_then(|old| old.value.as_ref())
                .map(|value| cipher.open(value))
                .transpose()
                .map_err(|_| {
                    error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "cloud_environment_vault_unavailable",
                        "A saved value could not be opened.",
                    )
                })?,
        };
        if value.as_ref().is_some_and(|value| {
            known_vpn_values
                .iter()
                .any(|vpn| !vpn.is_empty() && value.contains(vpn))
                || entry.kind == "variable"
                    && protected_network_values
                        .iter()
                        .any(|secret| !secret.is_empty() && value.contains(secret))
        }) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "cloud_environment_vpn_key_exposed",
                "Task variables must not contain protected network credentials or VPN credentials.",
            ));
        }
    }
    for entry in &mut incoming.vault {
        entry.value = match entry.value.take() {
            Some(value) => Some(cipher.seal(&value).map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cloud_environment_vault_unavailable",
                    "The value could not be sealed.",
                )
            })?),
            None => previous
                .vault
                .iter()
                .find(|old| old.id == entry.id && old.key == entry.key && old.kind == entry.kind)
                .and_then(|old| old.value.clone()),
        };
        entry.has_value = entry.value.is_some();
    }
    incoming.revision = previous.revision.checked_add(1).ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "cloud_environment_revision_conflict",
            "The revision limit was reached.",
        )
    })?;
    store.owners.insert(owner.into(), incoming.clone());
    save(&store)?;
    Ok(projection(incoming))
}
#[utoipa::path(get, path="/api/cloud-environments", tag="Cloud environments", security(("bearerAuth"=[])), description="Read the verified user's node-local environment templates and redacted personal vault. Values are never returned. Maximum 100 environments and 100 vault entries. Shared templates are listed separately.", responses((status=200, body=Snapshot),(status=403, description="Personal user identity required"),(status=503, description="Store unavailable or unsupported schema")))]
async fn read(
    Extension(auth): Extension<ResolvedAuthorization>,
) -> Result<Json<Snapshot>, ApiError> {
    let owner = owner(&auth)?;
    let _lock = STORE_LOCK.lock().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_store_unavailable",
            "The environment store is unavailable.",
        )
    })?;
    Ok(Json(projection(
        load()?.owners.remove(&owner).unwrap_or_default(),
    )))
}
#[utoipa::path(put, path="/api/cloud-environments", tag="Cloud environments", security(("bearerAuth"=[])), request_body=Snapshot, description="Atomically replace this user's templates and vault metadata. schemaVersion must be 1; revision must equal the current revision. Omitted value preserves the sealed value for the same id/key/kind; removing an entry deletes its value. Values are write-only and sealed at rest. Maximum request 1 MiB, 100 templates/entries, 20 repositories per template, 64 KiB script/instructions/value. GatewayRoute and verified personal identity required; request retries must reload revision after 409. Optional runtime selects backend auto or box (a fresh disposable Ryu Box per conversation), executor ryu, claude-code, codex, opencode or cursor, and lifetimeMinutes 5-240 (honored only for box); omitted runtime reads as auto/ryu/30. Managed executors require the box backend and internet access; box rejects a Tailscale key and bound network secrets, and a restricted box allowlist must include archive.ubuntu.com, security.ubuntu.com and the agent's provider hosts (422 cloud_environment_policy_unavailable). This route does not start scripts or test VPN credentials.", responses((status=200,body=Snapshot),(status=400,description="Invalid schema, limits, keys, domains or references"),(status=403,description="Identity denied; cloud_environment_feature_unavailable: the save newly selects the box backend for a signed-in account without the Fresh cloud box rollout"),(status=409,description="Revision or stable ID conflict"),(status=422,description="Runtime rules not satisfied"),(status=503,description="Store or encrypted vault unavailable")))]
async fn put(
    Extension(auth): Extension<ResolvedAuthorization>,
    Json(state): Json<Snapshot>,
) -> Result<Json<Snapshot>, ApiError> {
    let owner = owner(&auth)?;
    let box_allowed = require_box_backend_feature(&auth).await.is_ok();
    Ok(Json(update(&owner, state, box_allowed)?))
}
#[utoipa::path(get, path="/api/cloud-environments/import", tag="Cloud environments", security(("bearerAuth"=[])), description="Node-owner only. Enumerate at most 1000 eligible names from the selected Core node shell, never values. Platform and infrastructure variables are excluded. This is not the client computer environment.", responses((status=200,body=Value),(status=403,description="Node owner required")))]
async fn import_names(
    Extension(auth): Extension<ResolvedAuthorization>,
) -> Result<Json<Value>, ApiError> {
    import_authorized(&auth)?;
    let names: BTreeSet<_> = std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| importable_key(key))
        .take(1000)
        .collect();
    Ok(Json(json!({"names":names})))
}
#[derive(Deserialize, utoipa::ToSchema)]
#[schema(as = CloudEnvironmentImport)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    keys: Vec<String>,
    kind: String,
    environment_ids: Vec<String>,
    domains: Vec<String>,
    revision: u64,
}
#[utoipa::path(post, operation_id="import_cloud_environment_variables", path="/api/cloud-environments/import", tag="Cloud environments", security(("bearerAuth"=[])), request_body=Import, description="Node-owner only. Import 1–100 explicitly selected eligible shell variables into the owner's sealed personal vault. revision conflict fails atomically; no values returned. Each selected key must be present and non-reserved. Existing keys are updated. Optional environmentIds bind to owned templates and domains bind network secrets.", responses((status=200,body=Snapshot),(status=400,description="Invalid selection or missing variable"),(status=403,description="Node owner required"),(status=409,description="Revision conflict"),(status=503,description="Store or vault unavailable")))]
async fn import(
    Extension(auth): Extension<ResolvedAuthorization>,
    Json(request): Json<Import>,
) -> Result<Json<Snapshot>, ApiError> {
    import_authorized(&auth)?;
    let identity = owner(&auth)?;
    if request.keys.is_empty()
        || request.keys.len() > 100
        || request.keys.iter().any(|k| !importable_key(k))
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "cloud_environment_invalid",
            "Select between 1 and 100 non-reserved variables.",
        ));
    }
    let mut state = {
        let _lock = STORE_LOCK.lock().map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cloud_environment_store_unavailable",
                "The environment store is unavailable.",
            )
        })?;
        load()?.owners.remove(&identity).unwrap_or_default()
    };
    state.revision = request.revision;
    for entry in &mut state.vault {
        entry.value = None;
    }
    for key in request.keys {
        let value = std::env::var(&key).map_err(|_| {
            error(
                StatusCode::BAD_REQUEST,
                "cloud_environment_import_unavailable",
                "A selected variable is unavailable.",
            )
        })?;
        if let Some(entry) = state.vault.iter_mut().find(|e| e.key == key) {
            entry.value = Some(value);
            entry.kind = request.kind.clone();
            entry.environment_ids = request.environment_ids.clone();
            entry.domains = request.domains.clone();
        } else {
            state.vault.push(VaultEntry {
                id: uuid::Uuid::new_v4().to_string(),
                key,
                value: Some(value),
                kind: request.kind.clone(),
                environment_ids: request.environment_ids.clone(),
                domains: request.domains.clone(),
                has_value: true,
            });
        }
    }
    let box_allowed = require_box_backend_feature(&auth).await.is_ok();
    Ok(Json(update(&identity, state, box_allowed)?))
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn governed_spec(
    internet: &Internet,
    credentials: Vec<ryu_sandbox::governed::ProxyCredential>,
) -> ryu_sandbox::governed::GovernedWorkspaceSpec {
    use ryu_sandbox::governed::{EgressPolicy, GovernedWorkspaceSpec};
    let credentials = if internet.enabled {
        credentials
    } else {
        vec![]
    };
    let egress = if !internet.enabled {
        EgressPolicy::Denied
    } else if internet.domain_policy == "all" {
        EgressPolicy::Unrestricted
    } else {
        let mut hosts: BTreeSet<String> = internet.allowed_domains.iter().cloned().collect();
        if internet.domain_policy == "packageManagers" {
            hosts.extend(
                [
                    "registry.npmjs.org",
                    "registry.yarnpkg.com",
                    "pypi.org",
                    "files.pythonhosted.org",
                    "github.com",
                    "api.github.com",
                    "raw.githubusercontent.com",
                    "objects.githubusercontent.com",
                    "release-assets.githubusercontent.com",
                    "crates.io",
                    "index.crates.io",
                    "static.crates.io",
                    "proxy.golang.org",
                    "sum.golang.org",
                    "rubygems.org",
                    "registry.npmjs.org",
                    "repo.maven.apache.org",
                    "repo1.maven.org",
                    "dl-cdn.alpinelinux.org",
                    "deb.debian.org",
                    "security.debian.org",
                ]
                .into_iter()
                .map(str::to_owned),
            );
        }
        for credential in &credentials {
            hosts.extend(credential.hosts.iter().cloned());
        }
        EgressPolicy::AllowedHosts(hosts.into_iter().collect())
    };
    GovernedWorkspaceSpec {
        egress,
        credentials,
    }
}
pub(super) async fn approve_network_policy(
    spec: &ryu_sandbox::governed::GovernedWorkspaceSpec,
    vpn: bool,
) -> Result<(), ApiError> {
    use ryu_sandbox::governed::EgressPolicy;
    let mut grants: Vec<String> = match &spec.egress {
        EgressPolicy::Denied => return Ok(()),
        EgressPolicy::Unrestricted => vec!["network:egress:unrestricted".into()],
        EgressPolicy::AllowedHosts(hosts) => hosts
            .iter()
            .map(|host| format!("tool:http-egress:{host}"))
            .collect(),
    };
    if vpn {
        // Trusted enrollment/relay traffic is distinct from workload egress.
        // The reserved network namespace requires explicit operator approval.
        grants.push("network:vpn:tailscale".into());
    }
    if grants.is_empty() {
        return Ok(());
    }
    let deny = || {
        error(
            StatusCode::FORBIDDEN,
            "cloud_environment_network_denied",
            "Gateway must approve this environment's outbound network grants before setup can run.",
        )
    };
    let mut request = crate::sidecar::gateway::gateway_http_client()
        .post(format!(
            "{}/v1/grants/validate",
            crate::sidecar::gateway::gateway_url().trim_end_matches('/')
        ))
        .timeout(std::time::Duration::from_secs(5))
        .json(&json!({"app_id":"com.ryu.cloud-environments","grants":grants}));
    if let Some(token) = crate::sidecar::gateway::gateway_core_token() {
        request = request.bearer_auth(token);
    }
    let mut response = request.send().await.map_err(|_| deny())?;
    if !response.status().is_success() {
        return Err(deny());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| deny())? {
        if bytes.len() + chunk.len() > 65536 {
            return Err(deny());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| deny())?;
    let approved: BTreeSet<String> =
        serde_json::from_value::<Vec<String>>(body["approved"].clone())
            .map_err(|_| deny())?
            .into_iter()
            .collect();
    if body["all_approved"] != true
        || body["denied"] != json!([])
        || approved != grants.iter().cloned().collect::<BTreeSet<_>>()
    {
        return Err(deny());
    }
    Ok(())
}

pub(super) async fn approve_setup_budget(backend: &str) -> Result<(), ApiError> {
    let deny = || {
        error(
            StatusCode::FORBIDDEN,
            "cloud_environment_budget_denied",
            "Gateway must explicitly approve the setup execution budget.",
        )
    };
    let mut request = crate::sidecar::gateway::gateway_http_client()
        .post(format!(
            "{}/v1/exec/budget/check",
            crate::sidecar::gateway::gateway_url().trim_end_matches('/')
        ))
        .timeout(std::time::Duration::from_secs(5))
        .json(&json!({"backend":backend,"command":"cloud-environment-setup"}));
    if let Some(token) = crate::sidecar::gateway::gateway_core_token() {
        request = request.bearer_auth(token);
    }
    let mut response = request.send().await.map_err(|_| deny())?;
    if !response.status().is_success() {
        return Err(deny());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| deny())? {
        if bytes.len() + chunk.len() > 65536 {
            return Err(deny());
        }
        bytes.extend_from_slice(&chunk);
    }
    let verdict: Value = serde_json::from_slice(&bytes).map_err(|_| deny())?;
    if verdict["allowed"] != true {
        return Err(deny());
    }
    Ok(())
}
/// Which provider a prepared environment's cloud task runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TaskBackend {
    Docker,
    Governed,
    Vpn,
    Box,
}
impl TaskBackend {
    /// The wire label used by the cloud task status and binding projections.
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Governed => "opensandbox",
            Self::Vpn => "vpn",
            Self::Box => "box",
        }
    }
}
pub(super) struct PreparedEnvironment {
    pub owner: String,
    pub environment_id: String,
    pub environment_name: String,
    pub revision: u64,
    pub start_instructions: String,
    pub working_directory: String,
    pub repository_directories: Vec<String>,
    pub script: String,
    pub task_preamble: String,
    pub secrets: Vec<String>,
    pub task_redactions: Vec<String>,
    pub governed_spec: ryu_sandbox::governed::GovernedWorkspaceSpec,
    pub vpn_backend: Option<ryu_sandbox::governed_vpn::GovernedVpnDocker>,
    pub vpn_key: Option<String>,
    pub governed: bool,
    pub network: bool,
    pub backend_label: &'static str,
    pub backend: TaskBackend,
    pub executor: String,
    pub lifetime_seconds: u64,
    /// Box arm only: per-command env. Values never enter a script.
    pub box_env: Vec<(String, String)>,
    pub box_network: Option<ryu_sandbox::box_session::BoxNetwork>,
    /// Box arm only: the GitHub credential Core uses for a clean-room push.
    pub git_push_token: Option<String>,
    /// First repository as `owner/repo`.
    pub primary_repository: Option<String>,
    /// Names in `box_env` that carry the GitHub credential.
    pub git_env_keys: Vec<String>,
}

fn repository_name(repository: &str) -> &str {
    repository
        .strip_prefix("https://github.com/")
        .unwrap_or(repository)
        .trim_end_matches(".git")
}

/// Inputs to [`build_task_script`]; every value is already resolved.
struct ScriptPlan<'a> {
    root: &'a str,
    /// Box arm: `exports` become per-command env instead of `export` lines.
    is_box: bool,
    /// `(name, value)` in order: the org token first, then vault bindings.
    /// For governed runtimes a network secret's value is its placeholder.
    exports: Vec<(String, String)>,
    repositories: &'a [String],
    install_script: &'a str,
    internet_enabled: bool,
    github_token_key: Option<&'a str>,
}
struct ScriptParts {
    script: String,
    task_preamble: String,
    box_env: Vec<(String, String)>,
    repository_directories: Vec<String>,
    working_directory: String,
}
/// Assemble the setup script, task preamble and directories. Pure, so the
/// Box arm's guarantee that no value enters a script is unit-testable.
fn build_task_script(plan: ScriptPlan<'_>) -> ScriptParts {
    let root = plan.root;
    let mut script = format!("set -eu\nmkdir -p {root}\ncd {root}\n");
    let mut box_env = vec![];
    for (key, value) in plan.exports {
        if plan.is_box {
            box_env.push((key, value));
        } else {
            script.push_str(&format!("export {key}={}\n", quote(&value)));
        }
    }
    let mut task_preamble = script.clone();
    for repository in plan.repositories {
        if repository == plan.repositories.first().unwrap_or(repository) {
            script.push_str("if ! command -v git >/dev/null 2>&1; then if command -v apk >/dev/null 2>&1; then apk add --no-cache git; else printf '%s\\n' 'The configured sandbox image must provide git.' >&2; exit 127; fi; fi\nexport GIT_TERMINAL_PROMPT=0\n");
        }
        let repo = repository_name(repository);
        let git = plan.github_token_key.map_or_else(
            || "git".into(),
            |key| {
                format!(
                    "git -c \"http.https://github.com/.extraHeader=Authorization: Bearer ${key}\""
                )
            },
        );
        script.push_str(&format!(
            "mkdir -p -- {}\n{git} clone -- {} {}\n",
            quote(repo.split('/').next().unwrap_or("owner")),
            quote(&format!("https://github.com/{repo}.git")),
            quote(repo)
        ));
    }
    if let Some(repository) = plan.repositories.first() {
        let repo = repository_name(repository);
        script.push_str(&format!("cd {}\n", quote(repo)));
        task_preamble.push_str(&format!("cd {}\n", quote(repo)));
    }
    let requires_bash = plan
        .install_script
        .lines()
        .next()
        .is_some_and(|line| line.starts_with("#!") && line.contains("bash"))
        || plan.install_script.contains("pipefail");
    if requires_bash {
        if plan.internet_enabled {
            script.push_str("if ! command -v bash >/dev/null 2>&1; then if command -v apk >/dev/null 2>&1; then apk add --no-cache bash; else printf '%s\\n' 'The configured sandbox image must provide bash.' >&2; exit 127; fi; fi\n");
        }
        script.push_str(&format!("bash -c {}\n", quote(plan.install_script)));
    } else {
        script.push_str(&format!("sh -c {}\n", quote(plan.install_script)));
    }
    let repository_directories: Vec<String> = plan
        .repositories
        .iter()
        .map(|repository| format!("{root}/{}", repository_name(repository)))
        .collect();
    let working_directory = repository_directories
        .first()
        .cloned()
        .unwrap_or_else(|| root.to_owned());
    ScriptParts {
        script,
        task_preamble,
        box_env,
        repository_directories,
        working_directory,
    }
}

/// The Box network policy for an environment's internet settings.
fn box_network(internet: &Internet) -> ryu_sandbox::box_session::BoxNetwork {
    use ryu_sandbox::{box_session::BoxNetwork, governed::EgressPolicy};
    match governed_spec(internet, vec![]).egress {
        EgressPolicy::Denied => BoxNetwork::None,
        EgressPolicy::Unrestricted => BoxNetwork::Egress,
        EgressPolicy::AllowedHosts(hosts) => BoxNetwork::Allowlist(hosts),
    }
}

/// The HTTP Basic credential git sends for a GitHub token.
pub(super) fn github_basic_credential(token: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"))
}

pub(super) async fn prepare_environment(
    auth: &ResolvedAuthorization,
    id: &str,
) -> Result<PreparedEnvironment, ApiError> {
    let id = id.to_owned();
    let identity = owner(auth)?;
    let state = {
        let _lock = STORE_LOCK.lock().map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cloud_environment_store_unavailable",
                "The environment store is unavailable.",
            )
        })?;
        load()?.owners.remove(&identity).unwrap_or_default()
    };
    let environment = state
        .environments
        .iter()
        .find(|e| e.id == id && e.published)
        .cloned()
        .ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                "cloud_environment_not_found",
                "Publish the environment before running setup.",
            )
        })?;
    if let Some(issue) = runtime_issue(&environment, &state.vault) {
        return Err(issue);
    }
    let is_box = environment.runtime.backend == "box";
    // Rollout gate first (403 for a verified cloud caller without the signed
    // flag), then the node gate: a node without a Box token refuses with 503
    // regardless of who is calling. See `require_box_backend_feature`.
    if is_box {
        require_box_backend_feature(auth).await?;
    }
    // The node's Box credential: env, or the control-plane source a managed
    // node installs (it has no `RYU_SANDBOX_BOX_TOKEN`).
    if is_box && !super::session_box::box_configured().await {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_backend_unavailable",
            "Ryu Box is not configured on this node, so a fresh cloud box cannot start. Setup was not started.",
        ));
    }
    let governed = !is_box
        && matches!(
            ryu_sandbox::configured_backend(),
            ryu_sandbox::SandboxBackend::Opensandbox
        );
    let vpn = environment.tailscale_vault_key.is_some();
    if !is_box
        && (vpn && !environment.internet.enabled
            || environment.internet.enabled
                && environment.internet.domain_policy != "all"
                && !governed
                && !vpn)
    {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloud_environment_policy_unavailable",
            "Domain policies require OpenSandbox or the isolated VPN runtime. VPN requires enabled internet access. Setup was not started.",
        ));
    }
    crate::crypto_host::install();
    let cipher = ryu_crypto::global_cipher().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_vault_unavailable",
            "The encrypted vault is unavailable.",
        )
    })?;
    let vpn_key = environment.tailscale_vault_key.as_ref().map(|key| {
        let entry = state.vault.iter().find(|entry| &entry.key == key
            && (entry.environment_ids.is_empty() || entry.environment_ids.contains(&id)))
            .ok_or_else(|| error(StatusCode::UNPROCESSABLE_ENTITY, "cloud_environment_vault_scope", "The VPN credential is not available to this environment."))?;
        if environment.vault_keys.contains(key) {
            return Err(error(StatusCode::UNPROCESSABLE_ENTITY, "cloud_environment_vpn_key_exposed", "The VPN credential must not also be exposed as a task variable or network secret."));
        }
        let sealed = entry.value.as_ref().ok_or_else(|| error(StatusCode::UNPROCESSABLE_ENTITY, "cloud_environment_value_missing", "The VPN credential has no saved value."))?;
        let value = cipher.open(sealed).map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "cloud_environment_vault_unavailable", "The saved VPN credential could not be opened."))?;
        if value.is_empty() || environment.install_script.contains(&value) || environment.start_instructions.contains(&value) {
            return Err(error(StatusCode::UNPROCESSABLE_ENTITY, "cloud_environment_vpn_key_exposed", "The VPN credential must not appear in task scripts or instructions."));
        }
        Ok(value)
    }).transpose()?;
    let mut exports: Vec<(String, String)> = vec![];
    let mut secrets = vec![];
    let mut task_redactions = vec![];
    let mut proxy_credentials = vec![];
    // Prefer an organization GitHub App installation token scoped to exactly
    // these repositories when the node is org-bound and the caller's team or
    // project holds a grant. It replaces the owner's GITHUB_TOKEN/GH_TOKEN for
    // this run; without a grant the per-owner PAT path below is unchanged.
    let org_github_token = if environment.internet.enabled && !environment.repositories.is_empty() {
        org_github::token_for(
            auth,
            &org_github::repository_names(&environment.repositories),
        )
        .await
    } else {
        None
    };
    if let Some(value) = &org_github_token {
        if governed || vpn {
            let placeholder = format!("__RYU_SECRET_{}__", uuid::Uuid::new_v4().simple());
            exports.push(("GITHUB_TOKEN".into(), placeholder.clone()));
            proxy_credentials.push(ryu_sandbox::governed::ProxyCredential {
                name: "org-github-installation".into(),
                value: value.clone(),
                placeholder,
                hosts: vec!["github.com".into(), "api.github.com".into()],
            });
        } else {
            exports.push(("GITHUB_TOKEN".into(), value.clone()));
        }
        task_redactions.push(value.clone());
        secrets.push(value.clone());
    }
    let mut git_push_token = org_github_token.clone();
    for key in &environment.vault_keys {
        if org_github_token.is_some() && (key == "GITHUB_TOKEN" || key == "GH_TOKEN") {
            continue;
        }
        if state
            .environments
            .iter()
            .any(|other| other.tailscale_vault_key.as_ref() == Some(key))
        {
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cloud_environment_vpn_key_exposed",
                "The VPN credential must not be exposed as a task variable or network secret.",
            ));
        }
        let entry = state
            .vault
            .iter()
            .find(|e| {
                &e.key == key && (e.environment_ids.is_empty() || e.environment_ids.contains(&id))
            })
            .ok_or_else(|| {
                error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "cloud_environment_vault_scope",
                    "A requested variable is not available to this environment.",
                )
            })?;
        if entry.kind == "networkSecret"
            && (is_box || !governed && !vpn && environment.internet.enabled)
        {
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cloud_environment_policy_unavailable",
                "This node cannot replace network-secret placeholders in outbound requests. Setup was not started.",
            ));
        }
        let sealed = entry.value.as_ref().ok_or_else(|| {
            error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cloud_environment_value_missing",
                "A requested variable has no saved value.",
            )
        })?;
        let value = cipher.open(sealed).map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cloud_environment_vault_unavailable",
                "A saved value could not be opened.",
            )
        })?;
        if vpn_key.as_ref().is_some_and(|key| value.contains(key)) {
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cloud_environment_vpn_key_exposed",
                "A task variable or network secret must not contain the VPN credential.",
            ));
        }
        if entry.kind == "networkSecret" {
            task_redactions.push(value.clone());
            if entry.domains.is_empty() {
                return Err(error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "cloud_environment_secret_domains_required",
                    "Select at least one HTTPS domain for each network secret.",
                ));
            }
            let placeholder = format!("__RYU_SECRET_{}__", uuid::Uuid::new_v4().simple());
            exports.push((entry.key.clone(), placeholder.clone()));
            if environment.internet.enabled {
                proxy_credentials.push(ryu_sandbox::governed::ProxyCredential {
                    name: entry.id.clone(),
                    value: value.clone(),
                    placeholder,
                    hosts: entry.domains.clone(),
                });
            }
        } else {
            if git_push_token.is_none() && (key == "GITHUB_TOKEN" || key == "GH_TOKEN") {
                git_push_token = Some(value.clone());
            }
            // A Box hands variables to the agent as plain env, so every value
            // is scrubbed from output tails, summaries, messages and patches.
            if is_box {
                task_redactions.push(value.clone());
            }
            exports.push((entry.key.clone(), value.clone()));
        }
        secrets.push(value);
    }
    let github_token_key = if org_github_token.is_some() {
        Some("GITHUB_TOKEN")
    } else {
        ["GITHUB_TOKEN", "GH_TOKEN"].into_iter().find(|key| {
            environment.vault_keys.iter().any(|bound| bound == key)
                && state.vault.iter().any(|entry| {
                    entry.key == *key
                        && (entry.environment_ids.is_empty() || entry.environment_ids.contains(&id))
                        && (entry.kind == "variable"
                            || entry.domains.iter().any(|domain| domain == "github.com"))
                })
        })
    };
    if !environment.repositories.is_empty() && !environment.internet.enabled {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloud_environment_policy_unavailable",
            "Repository checkout requires internet access. Setup was not started.",
        ));
    }
    let root = if is_box {
        ryu_sandbox::box_session::BOX_WORKSPACE_ROOT
    } else {
        "/tmp/ryu-workspace"
    };
    let parts = build_task_script(ScriptPlan {
        root,
        is_box,
        exports,
        repositories: &environment.repositories,
        install_script: &environment.install_script,
        internet_enabled: environment.internet.enabled,
        github_token_key,
    });
    let git_env_keys: Vec<String> = if is_box {
        parts
            .box_env
            .iter()
            .map(|(key, _)| key.clone())
            .filter(|key| key == "GITHUB_TOKEN" || key == "GH_TOKEN")
            .collect()
    } else {
        vec![]
    };
    let git_push_token = git_push_token.filter(|token| is_box && !token.is_empty());
    if let Some(token) = &git_push_token {
        task_redactions.push(token.clone());
        task_redactions.push(github_basic_credential(token));
    }
    let network = environment.internet.enabled;
    let governed_spec = governed_spec(&environment.internet, proxy_credentials);
    governed_spec.credential_vault().map_err(|_| {
        error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloud_environment_policy_invalid",
            "Credential domain scopes overlap or are invalid.",
        )
    })?;
    let box_network = is_box.then(|| box_network(&environment.internet));
    approve_network_policy(&governed_spec, vpn && !is_box).await?;
    let vpn_backend = if vpn {
        Some(vpn_runtime().map_err(|_| error(StatusCode::UNPROCESSABLE_ENTITY, "cloud_environment_policy_unavailable", "The isolated VPN runtime must be configured with preloaded workload, egress, and Tailscale images. Setup was not started."))?)
    } else {
        None
    };
    if let Some(key) = &vpn_key {
        secrets.push(key.clone());
        task_redactions.push(key.clone());
    }
    let backend = if is_box {
        TaskBackend::Box
    } else if vpn {
        TaskBackend::Vpn
    } else if governed {
        TaskBackend::Governed
    } else {
        TaskBackend::Docker
    };
    let backend_label = match backend {
        TaskBackend::Box => "box",
        TaskBackend::Governed => "opensandbox",
        TaskBackend::Docker | TaskBackend::Vpn => "docker",
    };
    approve_setup_budget(backend_label).await?;
    let (executor, lifetime_seconds) = if is_box {
        (
            environment.runtime.executor.clone(),
            u64::from(environment.runtime.lifetime_minutes) * 60,
        )
    } else {
        ("ryu".to_owned(), 1800)
    };
    Ok(PreparedEnvironment {
        owner: identity,
        environment_id: id,
        environment_name: environment.name,
        revision: state.revision,
        start_instructions: environment.start_instructions,
        working_directory: parts.working_directory,
        repository_directories: parts.repository_directories,
        script: parts.script,
        task_preamble: parts.task_preamble,
        secrets,
        task_redactions,
        governed_spec,
        vpn_backend,
        vpn_key,
        governed,
        network,
        backend_label,
        backend,
        executor,
        lifetime_seconds,
        box_env: parts.box_env,
        box_network,
        git_push_token,
        primary_repository: environment
            .repositories
            .first()
            .map(|repository| repository_name(repository).to_owned()),
        git_env_keys,
    })
}

#[utoipa::path(post, path="/api/cloud-environments/{id}/launch", tag="Cloud environments", security(("bearerAuth"=[])), params(("id"=String,Path,description="Published personally owned environment ID")), description="Run a disposable setup check on the selected node. Requires GatewayRoute, ToolsExec, personal identity, explicit fail-closed Gateway execution-budget approval and explicit Gateway outbound grant approval. Disabled internet needs no outbound grant; unrestricted needs network:egress:unrestricted; restricted domains need tool:http-egress:host approval for every expanded host. Provider platform overlays do not substitute for Gateway approval. The configured OpenSandbox provider supports explicit all/package-manager/custom/disabled egress and HTTPS network-secret substitution; readiness requires status=ok, dns+nft packet enforcement, exact policy rules and acknowledged sanitized vault scope metadata before workload upload. Secrets travel to the authenticated sidecar vault over HTTPS or literal loopback HTTP; workload environment receives placeholders. GH_TOKEN or GITHUB_TOKEN scoped to github.com supplies Git clone authorization. Repositories use separate owner/repository directories; install scripts run in the first repository root or an empty workspace when no repository is selected. Without OpenSandbox, rootless Docker supports disabled or unrestricted internet with task-visible ordinary variables. Per-environment Tailscale VPN uses an explicitly configured isolated rootless Docker runtime with preloaded versioned workload, egress and Tailscale images. Gateway must additionally approve network:vpn:tailscale for trusted enrollment and relay traffic. The saved reusable auth key must be scoped to this environment and cannot also be a task variable, a network-secret binding, or appear in scripts/instructions. VPN helpers enroll with memory-only state and userspace networking; workload runs unprivileged behind exact packet-enforced egress with public CA delivery. Saving the key does not test connectivity; setup checks enroll and run. Expired credential-free resource leases are recovered at startup and periodically. Internet-disabled VPN fails closed. Scripts run with a 120-second execution timeout and cleanup follows completion/failure/disconnection. Output redacts saved values and is bounded to 65536 characters per stream. startInstructions are returned for the next task; no durable cloud task workspace is created. Each invocation is a new setup check; callers must not automatically retry.", responses((status=200,body=Value,description="completed or failed status with exitCode/stdout/stderr/startInstructions"),(status=403,description="Execution authority, Gateway network grants or budget denied; cloud_environment_feature_unavailable: a box environment for a signed-in account without the Fresh cloud box rollout"),(status=404,description="Owned published template missing"),(status=422,description="Policy unavailable, missing value, domains or scope mismatch"),(status=503,description="Provider, packet enforcement, vault or cleanup unavailable")))]
async fn launch(
    State(_state): State<ServerState>,
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let prepared = prepare_environment(&auth, &id).await?;
    let PreparedEnvironment {
        script,
        secrets,
        governed_spec,
        vpn_backend,
        vpn_key,
        governed,
        network,
        backend_label,
        start_instructions,
        backend,
        box_env,
        box_network,
        ..
    } = prepared;
    let audit_user_id = auth
        .caller
        .as_ref()
        .map(|caller| caller.user_id.clone())
        .or_else(|| match &auth.context.principal {
            crate::authorization::Principal::User { subject_id } => Some(subject_id.clone()),
            _ => None,
        });
    // The detached operation always removes its container after a timeout or a
    // disconnected HTTP client; a dropped docker-run client does not do that.
    let output = tokio::spawn(async move {
        let started = std::time::Instant::now();
        let result = async {
            if backend == TaskBackend::Box {
                return super::cloud_tasks::run_box_setup_check(
                    &script,
                    &box_env,
                    box_network.unwrap_or(ryu_sandbox::box_session::BoxNetwork::None),
                )
                .await;
            }
            if let (Some(backend), Some(key)) = (vpn_backend, vpn_key) {
                return backend.run_setup(&governed_spec, &key, &script, 120).await;
            }
            if governed {
                let backend = ryu_sandbox::opensandbox::OpenSandboxSandbox::governed();
                let workspace = backend.create(&governed_spec).await?;
                let result = backend.execute_script(&workspace, &script, 120).await;
                backend.destroy(&workspace).await?;
                return result;
            }
            let backend = ryu_sandbox::docker::DockerSandbox::new();
            let workspace = backend
                .create_workspace(SandboxCapabilities {
                    network,
                    ..SandboxCapabilities::default()
                })
                .await?;
            let result = backend
                .exec_in_workspace(
                    &workspace,
                    ExecSpec {
                        env: Vec::new(),
                        command: "sh".into(),
                        args: vec!["-s".into()],
                        stdin: Some(script.into_bytes()),
                        timeout_secs: Some(120),
                        capabilities: SandboxCapabilities {
                            network,
                            ..SandboxCapabilities::default()
                        },
                    },
                )
                .await;
            backend.destroy_workspace(&workspace).await?;
            result
        }
        .await;
        use crate::sidecar::gateway::{report_exec_audit_with_attribution, ExecAuditAttribution};
        report_exec_audit_with_attribution(
            backend_label,
            "cloud-environment-setup",
            started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            result.as_ref().map_or(-1, |output| output.exit_code),
            None,
            result.as_ref().err().map(|_| "Setup runtime failed".into()),
            ExecAuditAttribution {
                user_id: audit_user_id,
                feature: Some("cloud-environment-setup".into()),
                ..Default::default()
            },
        )
        .await;
        result
    })
    .await
    .map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_runtime_unavailable",
            "The setup operation failed.",
        )
    })?
    .map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_runtime_unavailable",
                "Setup failed, timed out, or could not clean up. Check the configured sandbox provider.",
        )
    })?;
    let redact = |bytes: Vec<u8>| {
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        for value in &secrets {
            if !value.is_empty() {
                text = text.replace(value, "[redacted]");
            }
        }
        text.chars().take(65536).collect::<String>()
    };
    Ok(Json(
        json!({"environmentId":id,"status":if output.exit_code == 0 {"completed"} else {"failed"},"exitCode":output.exit_code,"stdout":redact(output.stdout),"stderr":redact(output.stderr),"startInstructions":start_instructions}),
    ))
}
pub fn routes() -> Router<ServerState> {
    Router::new()
        .merge(github::routes())
        .route(
            "/api/cloud-environments/task-binding/:conversation_id",
            get(task_binding),
        )
        .route("/api/cloud-environments/shared", get(shared))
        .route(
            "/api/cloud-environments/shared/:id/import",
            axum::routing::post(import_shared),
        )
        .route("/api/cloud-environments", get(read).put(put))
        .route(
            "/api/cloud-environments/import",
            get(import_names).post(import),
        )
        .route(
            "/api/cloud-environments/:id/launch",
            axum::routing::post(launch),
        )
        .layer(axum::extract::DefaultBodyLimit::max(1_048_576))
}
#[utoipa::path(get,path="/api/cloud-environments/task-binding/{conversation_id}",operation_id="get_cloud_task_binding",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation whose cloud binding is being hydrated")),description="Read the caller's server-owned cloud conversation binding before reopening a chat. Requires current personal identity and GatewayRoute; execution permission is not required to inspect or stop a task. Returns cloudEnvironmentId, state, backend (docker, opensandbox, vpn or box) and executor (ryu, claude-code, codex, opencode or cursor) as nullable strings. A marker belonging to a different owner is denied. Interrupted or stopped bindings remain cloud bindings and must never reopen as local execution.",responses((status=200,body=Value),(status=403,description="Caller or task owner denied"),(status=503,description="Lifecycle store unavailable")))]
async fn task_binding(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    super::cloud_tasks::binding_metadata(&auth, &conversation_id)
        .await
        .map(Json)
}

fn shareable(mut environment: Environment) -> Environment {
    environment.vault_keys.clear();
    environment.tailscale_vault_key = None;
    environment
}
#[utoipa::path(get, path="/api/cloud-environments/shared", tag="Cloud environments", security(("bearerAuth"=[])), description="List at most 100 published shared templates owned by other users on this node. Personal vault bindings and VPN key references are removed; values never leave the owner vault.", responses((status=200,body=Value),(status=403,description="Personal user identity required"),(status=503,description="Store unavailable")))]
async fn shared(
    Extension(auth): Extension<ResolvedAuthorization>,
) -> Result<Json<Value>, ApiError> {
    let identity = owner(&auth)?;
    let _lock = STORE_LOCK.lock().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_store_unavailable",
            "The environment store is unavailable.",
        )
    })?;
    let environments: Vec<_> = load()?
        .owners
        .into_iter()
        .filter(|(id, _)| id != &identity)
        .flat_map(|(_, state)| state.environments)
        .filter(|e| e.published && e.privacy == "shared")
        .map(shareable)
        .take(100)
        .collect();
    Ok(Json(json!({"environments":environments})))
}
#[derive(Deserialize, utoipa::ToSchema)]
#[schema(as = CloudEnvironmentSharedImport)]
#[serde(deny_unknown_fields)]
struct ImportShared {
    revision: u64,
}
#[utoipa::path(post, path="/api/cloud-environments/shared/{id}/import", tag="Cloud environments", security(("bearerAuth"=[])),params(("id"=String,Path,description="Published shared source template ID")),request_body=ImportShared, description="Copy a currently published shared template into this user's personal collection with a fresh ID, private visibility and unpublished draft state. Secret/VPN bindings are removed. Requires matching personal revision; source templates cannot be edited by recipients.", responses((status=200,body=Snapshot),(status=400,description="Collection limits reached"),(status=403,description="Personal identity denied; cloud_environment_feature_unavailable: the copy uses the box backend and the signed-in account lacks the Fresh cloud box rollout"),(status=404,description="Shared template unavailable"),(status=409,description="Revision conflict"),(status=503,description="Store or vault unavailable")))]
async fn import_shared(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(id): Path<String>,
    Json(request): Json<ImportShared>,
) -> Result<Json<Snapshot>, ApiError> {
    let identity = owner(&auth)?;
    let (mut state, mut environment) = {
        let _lock = STORE_LOCK.lock().map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cloud_environment_store_unavailable",
                "The environment store is unavailable.",
            )
        })?;
        let store = load()?;
        let environment = store
            .owners
            .iter()
            .filter(|(owner, _)| *owner != &identity)
            .flat_map(|(_, s)| &s.environments)
            .find(|e| e.id == id && e.published && e.privacy == "shared")
            .cloned()
            .ok_or_else(|| {
                error(
                    StatusCode::NOT_FOUND,
                    "cloud_environment_not_found",
                    "The shared template is unavailable.",
                )
            })?;
        (
            store.owners.get(&identity).cloned().unwrap_or_default(),
            shareable(environment),
        )
    };
    environment.id = uuid::Uuid::new_v4().to_string();
    environment.privacy = "private".into();
    environment.published = false;
    state.revision = request.revision;
    for entry in &mut state.vault {
        entry.value = None;
    }
    state.environments.push(environment);
    let box_allowed = require_box_backend_feature(&auth).await.is_ok();
    Ok(Json(update(&identity, state, box_allowed)?))
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(read,put,import_names,import,shared,import_shared,launch,task_binding), components(schemas(Snapshot,Environment,Internet,Runtime,VaultEntry,Import,ImportShared)), tags((name="Cloud environments",description="Node-owned setup templates, private sealed variables and shared template copies.")))]
struct CloudEnvironmentApiDoc;
pub(crate) fn openapi() -> utoipa::openapi::OpenApi {
    use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
    use utoipa::OpenApi;
    let mut doc = CloudEnvironmentApiDoc::openapi();
    doc.merge(super::cloud_tasks::openapi());
    doc.merge(github::openapi());
    doc.components
        .get_or_insert_with(Default::default)
        .add_security_scheme(
            "bearerAuth",
            SecurityScheme::Http(HttpBuilder::new().scheme(HttpAuthScheme::Bearer).build()),
        );
    doc
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    #[test]
    fn openapi_documents_every_route_and_write_only_values() {
        let spec = serde_json::to_value(openapi()).unwrap();
        for path in [
            "/api/cloud-tasks/{conversation_id}/stop",
            "/api/cloud-tasks/{conversation_id}",
            "/api/cloud-tasks/{conversation_id}/prompt",
            "/api/cloud-tasks/{conversation_id}/diff",
            "/api/cloud-tasks/{conversation_id}/finish",
            "/api/cloud-environments",
            "/api/cloud-environments/import",
            "/api/cloud-environments/shared",
            "/api/cloud-environments/shared/{id}/import",
            "/api/cloud-environments/{id}/launch",
        ] {
            assert!(spec["paths"].get(path).is_some(), "{path}");
        }
        assert_eq!(
            spec["components"]["schemas"]["CloudVaultEntry"]["properties"]["value"]["writeOnly"],
            true
        );
        for schema in [
            "CloudEnvironmentRuntime",
            "CloudTaskStatus",
            "CloudTaskFinish",
            "CloudTaskDiff",
        ] {
            assert!(
                spec["components"]["schemas"].get(schema).is_some(),
                "{schema}"
            );
        }
    }
    #[test]
    fn wire_fixture_is_compatible() {
        let state: Snapshot = serde_json::from_str(include_str!(
            "../../../../packages/protocol/src/fixtures/cloud-environments.json"
        ))
        .unwrap();
        validate(&state).unwrap();
        // The fixture predates `runtime`; it reads as the default and is then
        // written explicitly.
        let mut expected = serde_json::from_str::<Value>(include_str!(
            "../../../../packages/protocol/src/fixtures/cloud-environments.json"
        ))
        .unwrap();
        for environment in expected["environments"].as_array_mut().unwrap() {
            environment["runtime"] =
                json!({"backend":"auto","executor":"ryu","lifetimeMinutes":30});
        }
        assert_eq!(serde_json::to_value(&state).unwrap(), expected);
    }
    fn box_environment() -> Snapshot {
        let mut state: Snapshot = serde_json::from_str(include_str!(
            "../../../../packages/protocol/src/fixtures/cloud-environments.json"
        ))
        .unwrap();
        state.vault[0].kind = "variable".into();
        state.vault[0].domains.clear();
        let environment = &mut state.environments[0];
        environment.internet.domain_policy = "all".into();
        environment.runtime = Runtime {
            backend: "box".into(),
            executor: "codex".into(),
            lifetime_minutes: 60,
        };
        state
    }
    #[test]
    fn cloud_environment_runtime_defaults_when_absent() {
        let state: Snapshot = serde_json::from_str(include_str!(
            "../../../../packages/protocol/src/fixtures/cloud-environments.json"
        ))
        .unwrap();
        assert_eq!(state.environments[0].runtime, Runtime::default());
        let state: Snapshot = serde_json::from_value(json!({
            "schemaVersion":1,"revision":0,"vault":[],
            "environments":[{"id":"e","name":"E","repositories":[],"installScript":"","startInstructions":"",
                "internet":{"enabled":true,"domainPolicy":"all","allowedDomains":[]},"privacy":"private",
                "vaultKeys":[],"tailscaleVaultKey":null,"published":true,
                "runtime":{"backend":"box","executor":"claude-code","lifetimeMinutes":120}}]
        }))
        .unwrap();
        assert_eq!(state.environments[0].runtime.executor, "claude-code");
        validate(&state).unwrap();
        assert!(serde_json::from_value::<Runtime>(
            json!({"backend":"box","executor":"ryu","lifetimeMinutes":30,"extra":1})
        )
        .is_err());
    }
    #[test]
    fn cloud_environment_runtime_rules_are_enforced_on_save() {
        let code = |state: &Snapshot| {
            validate(state)
                .err()
                .map(|(status, body)| (status, body.0["error"]["code"].clone()))
        };
        validate(&box_environment()).unwrap();

        let mut state = box_environment();
        state.environments[0].runtime.backend = "auto".into();
        assert_eq!(
            code(&state),
            Some((
                StatusCode::UNPROCESSABLE_ENTITY,
                json!("cloud_environment_policy_unavailable")
            ))
        );

        let mut state = box_environment();
        state.environments[0].internet.enabled = false;
        assert!(code(&state).is_some());

        let mut state = box_environment();
        state.environments[0].runtime.executor = "ryu".into();
        state.environments[0].vault_keys.clear();
        state.environments[0].tailscale_vault_key = Some("API_TOKEN".into());
        assert_eq!(
            code(&state),
            Some((
                StatusCode::UNPROCESSABLE_ENTITY,
                json!("cloud_environment_policy_unavailable")
            ))
        );

        let mut state = box_environment();
        state.vault[0].kind = "networkSecret".into();
        state.vault[0].domains = vec!["api.example.com".into()];
        assert!(code(&state).is_some());

        for lifetime in [4, 241] {
            let mut state = box_environment();
            state.environments[0].runtime.lifetime_minutes = lifetime;
            assert_eq!(
                code(&state),
                Some((StatusCode::BAD_REQUEST, json!("cloud_environment_invalid")))
            );
        }
        let mut state = box_environment();
        state.environments[0].runtime.executor = "unknown".into();
        assert!(code(&state).is_some());
    }
    #[test]
    fn cloud_environment_box_rejects_box_reserved_and_excess_variables() {
        let mut environment = box_environment().environments.remove(0);
        environment.vault_keys = vec!["API_KEY".into(), "USER".into(), "DOCKER_HOST".into()];
        let (status, body) = runtime_issue(&environment, &[]).unwrap();
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let message = body.0["error"]["message"].as_str().unwrap().to_owned();
        assert!(message.contains("USER, DOCKER_HOST"), "{message}");
        assert!(!message.contains("API_KEY"), "{message}");

        environment.vault_keys = (0..=MAX_BOX_ENV_ENTRIES).map(|i| format!("K{i}")).collect();
        assert!(runtime_issue(&environment, &[]).is_some());
        environment.vault_keys.pop();
        assert!(runtime_issue(&environment, &[]).is_none());

        environment.runtime.backend = "auto".into();
        environment.runtime.executor = "ryu".into();
        environment.vault_keys = vec!["USER".into()];
        assert!(runtime_issue(&environment, &[]).is_none());
    }
    #[test]
    fn cloud_environment_box_allowlist_requires_base_and_provider_hosts() {
        let mut state = box_environment();
        let internet = &mut state.environments[0].internet;
        internet.domain_policy = "custom".into();
        internet.allowed_domains = vec!["archive.ubuntu.com".into()];
        let (status, body) = validate(&state).unwrap_err();
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let message = body.0["error"]["message"].as_str().unwrap().to_owned();
        for host in [
            "security.ubuntu.com",
            "api.openai.com",
            "registry.npmjs.org",
        ] {
            assert!(message.contains(host), "{message}");
        }
        assert!(!message.contains("archive.ubuntu.com"), "{message}");
        let internet = &mut state.environments[0].internet;
        internet.domain_policy = "packageManagers".into();
        internet.allowed_domains = vec!["*.ubuntu.com".into(), "api.openai.com".into()];
        validate(&state).unwrap();
        assert_eq!(
            box_network(&state.environments[0].internet),
            ryu_sandbox::box_session::BoxNetwork::Allowlist(
                match governed_spec(&state.environments[0].internet, vec![]).egress {
                    ryu_sandbox::governed::EgressPolicy::AllowedHosts(hosts) => hosts,
                    _ => unreachable!(),
                }
            )
        );
    }
    #[test]
    fn cloud_environment_box_script_carries_no_secret_values() {
        let repositories = vec!["acme/app".to_owned()];
        let exports = vec![
            ("GITHUB_TOKEN".to_owned(), "ghp_org_token_value".to_owned()),
            ("API_KEY".to_owned(), "sk-vault-value".to_owned()),
        ];
        let parts = build_task_script(ScriptPlan {
            root: ryu_sandbox::box_session::BOX_WORKSPACE_ROOT,
            is_box: true,
            exports: exports.clone(),
            repositories: &repositories,
            install_script: "bun install",
            internet_enabled: true,
            github_token_key: Some("GITHUB_TOKEN"),
        });
        for text in [&parts.script, &parts.task_preamble] {
            assert!(!text.contains("ghp_org_token_value"));
            assert!(!text.contains("sk-vault-value"));
            assert!(!text.contains("export GITHUB_TOKEN="));
            assert!(!text.contains("export API_KEY="));
            assert!(!text.contains("/tmp/ryu-workspace"));
        }
        assert!(parts.script.contains("$GITHUB_TOKEN"));
        assert!(parts.task_preamble.ends_with("cd 'acme/app'\n"));
        assert_eq!(parts.box_env, exports);
        assert_eq!(parts.working_directory, "/workspace/acme/app");
        assert_eq!(
            parts.repository_directories,
            vec!["/workspace/acme/app".to_owned()]
        );

        // Other backends keep the exported preamble and the legacy root.
        let parts = build_task_script(ScriptPlan {
            root: "/tmp/ryu-workspace",
            is_box: false,
            exports,
            repositories: &[],
            install_script: "true",
            internet_enabled: false,
            github_token_key: None,
        });
        assert!(parts.script.starts_with("set -eu\nmkdir -p /tmp/ryu-workspace\ncd /tmp/ryu-workspace\nexport GITHUB_TOKEN='ghp_org_token_value'\n"));
        assert!(parts.box_env.is_empty());
        assert_eq!(parts.working_directory, "/tmp/ryu-workspace");
    }
    #[test]
    fn cloud_environment_basic_credential_matches_git_basic_auth() {
        assert_eq!(github_basic_credential("abc"), "eC1hY2Nlc3MtdG9rZW46YWJj");
    }
    #[test]
    fn platform_variables_and_unsafe_domains_are_rejected() {
        for key in [
            "PATH",
            "RYU_TOKEN",
            "LD_PRELOAD",
            "HTTP_PROXY",
            "NODE_OPTIONS",
            "BAD-KEY",
        ] {
            assert!(!valid_key(key));
        }
        assert!(valid_key("MY_TOKEN"));
        for domain in [
            "https://example.com",
            "user@example.com",
            "example..com",
            "*example.com",
        ] {
            assert!(!valid_domain(domain));
        }
        assert!(valid_domain("*.example.com"));
    }
    #[test]
    fn vault_projection_and_sharing_never_expose_values_or_bindings() {
        let mut state: Snapshot = serde_json::from_str(include_str!(
            "../../../../packages/protocol/src/fixtures/cloud-environments.json"
        ))
        .unwrap();
        state.vault[0].value = Some("sealed-value".into());
        let view = projection(state.clone());
        assert!(view.vault[0].has_value);
        assert!(view.vault[0].value.is_none());
        let template = shareable(state.environments.remove(0));
        assert!(template.vault_keys.is_empty());
        assert!(template.tailscale_vault_key.is_none());
    }
    #[test]
    fn shell_values_are_single_quoted() {
        assert_eq!(quote("a'b;$x\n"), "'a'\\''b;$x\n'");
    }
    #[test]
    fn vpn_credential_cannot_be_exposed_by_any_environment() {
        let mut state: Snapshot = serde_json::from_str(include_str!(
            "../../../../packages/protocol/src/fixtures/cloud-environments.json"
        ))
        .unwrap();
        state.environments[0].tailscale_vault_key = Some("API_TOKEN".into());
        assert!(validate(&state).is_err());
        state.environments[0].vault_keys.clear();
        assert!(validate(&state).is_ok());
        let mut second = state.environments[0].clone();
        second.id = "other-environment".into();
        second.tailscale_vault_key = None;
        second.vault_keys.push("API_TOKEN".into());
        state.environments.push(second);
        assert!(validate(&state).is_err());
    }

    // ── Rollout gate: `cloud_tasks.box_backend` via the signed `ryu_flags` claim ──

    const FLAG_TEST_KID: &str = "cloud-box-rollout-test-key";

    fn pkcs8_v1(seed: &[u8; 32]) -> Vec<u8> {
        let mut der = vec![
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
            0x04, 0x20,
        ];
        der.extend_from_slice(seed);
        der
    }

    /// Mint an Ed25519-signed Better Auth-shaped JWT whose public key is pinned
    /// in Core's JWKS cache, so it passes the production offline verifier.
    pub(in crate::server) async fn signed_user_jwt(
        flags: Option<serde_json::Value>,
        exp_offset: i64,
    ) -> String {
        let extra = flags.map_or_else(|| json!({}), |flags| json!({ "ryu_flags": flags }));
        signed_user_jwt_with_claims(extra, exp_offset).await
    }

    /// Sign a test user JWT whose payload is the defaults plus `extra`'s keys.
    pub(in crate::server) async fn signed_user_jwt_with_claims(
        extra: serde_json::Value,
        exp_offset: i64,
    ) -> String {
        use base64::Engine as _;
        use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header};
        let seed = [42u8; 32];
        let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
        let public_x = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(signing.verifying_key().to_bytes());
        let issuer = crate::identity_verify::install_test_verification_key(
            FLAG_TEST_KID,
            DecodingKey::from_ed_components(&public_x).expect("public key decodes"),
        )
        .await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs() as i64)
            .unwrap_or_default();
        let mut claims = json!({
            "id": "user-box",
            "sub": "user-box",
            "email": "user-box@example.com",
            "orgs": [],
            "iss": issuer,
            "aud": issuer,
            "iat": now,
            "exp": now + exp_offset,
        });
        if let serde_json::Value::Object(extra) = extra {
            for (key, value) in extra {
                claims[key] = value;
            }
        }
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(FLAG_TEST_KID.to_owned());
        jsonwebtoken::encode(
            &header,
            &claims,
            &EncodingKey::from_ed_der(&pkcs8_v1(&seed)),
        )
        .expect("token signs")
    }

    fn auth_for(
        principal: crate::authorization::Principal,
        caller: Option<crate::identity_verify::VerifiedCaller>,
        token: Option<String>,
    ) -> ResolvedAuthorization {
        use crate::authorization::*;
        ResolvedAuthorization {
            context: AuthorizationContext {
                credential: CredentialKind::ManagedUserJwt,
                principal,
                capabilities: CapabilitySet::new([Capability::GatewayRoute, Capability::ToolsExec]),
                constraints: GrantConstraints::default(),
                issued_at: 0,
                expires_at: None,
            },
            bindings: crate::authorization::RequestBindings::default(),
            caller,
            verified_user_jwt: token,
        }
    }

    /// Build the auth a request with this verified user JWT resolves to.
    pub(in crate::server) async fn cloud_auth(token: String) -> ResolvedAuthorization {
        let (claims, _) = crate::identity_verify::verify_jwt_with_expiry(&token)
            .await
            .expect("test token verifies");
        let caller = crate::identity_verify::to_caller_for_org(&claims, None);
        auth_for(
            crate::authorization::Principal::User {
                subject_id: caller.user_id.clone(),
            },
            Some(caller),
            Some(token),
        )
    }

    pub(in crate::server) fn denial_code(error: &ApiError) -> (StatusCode, String) {
        (
            error.0,
            error.1 .0["error"]["code"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        )
    }

    #[tokio::test]
    async fn box_gate_lets_a_local_owner_without_cloud_identity_through() {
        let auth = auth_for(crate::authorization::Principal::Owner, None, None);
        assert_eq!(box_feature_subject(&auth), BoxFeatureSubject::LocalOwner);
        assert!(require_box_backend_feature(&auth).await.is_ok());
    }

    #[tokio::test]
    async fn box_gate_requires_the_signed_flag_for_a_verified_cloud_caller() {
        let enabled = cloud_auth(signed_user_jwt(Some(json!([BOX_BACKEND_FLAG])), 600).await).await;
        assert!(require_box_backend_feature(&enabled).await.is_ok());

        let expected = (
            StatusCode::FORBIDDEN,
            "cloud_environment_feature_unavailable".to_owned(),
        );
        for flags in [
            None,
            Some(json!([])),
            Some(json!(["some.other_flag"])),
            Some(json!({ BOX_BACKEND_FLAG: true })),
        ] {
            let auth = cloud_auth(signed_user_jwt(flags.clone(), 600).await).await;
            let error = require_box_backend_feature(&auth)
                .await
                .expect_err("a claim without the flag fails closed");
            assert_eq!(denial_code(&error), expected, "{flags:?}");
        }
    }

    #[tokio::test]
    async fn box_gate_fails_closed_without_a_verifiable_claim() {
        let expected = (
            StatusCode::FORBIDDEN,
            "cloud_environment_feature_unavailable".to_owned(),
        );
        // A user principal with no JWT at all (e.g. a non-JWT user credential).
        let user = auth_for(
            crate::authorization::Principal::User {
                subject_id: "user-box".into(),
            },
            None,
            None,
        );
        assert_eq!(
            box_feature_subject(&user),
            BoxFeatureSubject::Cloud { token: None }
        );
        let error = require_box_backend_feature(&user).await.unwrap_err();
        assert_eq!(denial_code(&error), expected);

        // An owner principal that does carry a verified caller is a cloud caller.
        let enabled = cloud_auth(signed_user_jwt(Some(json!([BOX_BACKEND_FLAG])), 600).await).await;
        let owner_with_caller = auth_for(
            crate::authorization::Principal::Owner,
            enabled.caller.clone(),
            None,
        );
        let error = require_box_backend_feature(&owner_with_caller)
            .await
            .unwrap_err();
        assert_eq!(denial_code(&error), expected);

        // A token that no longer verifies (expired since admission) carries nothing.
        let mut expired = enabled.clone();
        expired.verified_user_jwt =
            Some(signed_user_jwt(Some(json!([BOX_BACKEND_FLAG])), -3600).await);
        let error = require_box_backend_feature(&expired).await.unwrap_err();
        assert_eq!(denial_code(&error), expected);
    }

    #[tokio::test]
    async fn box_gate_reads_the_org_the_claim_was_evaluated_for() {
        let token = signed_user_jwt_with_claims(
            json!({ "ryu_flags": [BOX_BACKEND_FLAG], "ryu_flags_org": "org-a" }),
            600,
        )
        .await;
        let flags = crate::identity_verify::verified_feature_flags(&token)
            .await
            .expect("token verifies");
        assert_eq!(flags.org.as_deref(), Some("org-a"));
        assert!(flags.keys.contains(BOX_BACKEND_FLAG));

        let legacy = signed_user_jwt(Some(json!([BOX_BACKEND_FLAG])), 600).await;
        let flags = crate::identity_verify::verified_feature_flags(&legacy)
            .await
            .expect("token verifies");
        assert_eq!(flags.org, None);
    }

    #[test]
    fn box_gate_refuses_a_claim_evaluated_for_another_org() {
        use crate::identity_verify::VerifiedFeatureFlags;
        let expected = (
            StatusCode::FORBIDDEN,
            "cloud_environment_feature_unavailable".to_owned(),
        );
        let claim = |org: Option<&str>| VerifiedFeatureFlags {
            keys: [BOX_BACKEND_FLAG.to_owned()].into_iter().collect(),
            org: org.map(str::to_owned),
        };

        // Same org, a personal node, or a claim with no org context: allowed.
        assert!(box_backend_flag_decision(Some(&claim(Some("org-a"))), Some("org-a")).is_ok());
        assert!(box_backend_flag_decision(Some(&claim(Some("org-a"))), None).is_ok());
        assert!(box_backend_flag_decision(Some(&claim(None)), Some("org-a")).is_ok());

        // Evaluated for another org than the node's: refused.
        let error = box_backend_flag_decision(Some(&claim(Some("org-b"))), Some("org-a"))
            .expect_err("a claim for another org fails closed");
        assert_eq!(denial_code(&error), expected);

        // The org never opens a flag the claim does not carry.
        let closed = VerifiedFeatureFlags {
            keys: std::collections::BTreeSet::new(),
            org: Some("org-a".into()),
        };
        let error = box_backend_flag_decision(Some(&closed), Some("org-a")).unwrap_err();
        assert_eq!(denial_code(&error), expected);
        let error = box_backend_flag_decision(None, Some("org-a")).unwrap_err();
        assert_eq!(denial_code(&error), expected);
    }

    #[test]
    fn save_gate_applies_only_when_box_is_newly_selected() {
        let boxed = box_environment();
        let mut auto = boxed.clone();
        auto.environments[0].runtime.backend = "auto".into();
        let empty = Snapshot::default();

        assert!(newly_selects_box(&empty, &boxed));
        assert!(newly_selects_box(&auto, &boxed));
        // Editing an environment that was already box keeps working.
        let mut edited = boxed.clone();
        edited.environments[0].name = "Renamed".into();
        assert!(!newly_selects_box(&boxed, &edited));
        // Leaving box, or saving non-box environments, never needs the flag.
        assert!(!newly_selects_box(&boxed, &auto));
        assert!(!newly_selects_box(&empty, &auto));
        // A copy under a fresh id is a new selection.
        let mut copied = boxed.clone();
        copied.environments[0].id = "copied-environment".into();
        assert!(newly_selects_box(&boxed, &copied));
    }
}
