//! Saved-template validation: reserved keys, domains, repositories and runtime rules.

use super::policy::governed_spec;
use super::*;

pub(super) fn reserved(key: &str) -> bool {
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
pub(super) fn valid_key(key: &str) -> bool {
    key.len() <= 128
        && !reserved(key)
        && key
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
pub(super) fn import_authorized(auth: &ResolvedAuthorization) -> Result<(), ApiError> {
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
pub(super) fn importable_key(key: &str) -> bool {
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
pub(super) fn box_required_hosts(executor: &str) -> Vec<&'static str> {
    use ryu_sandbox::box_session::{ManagedProvider, BOX_BASE_HOSTS};
    let mut hosts: Vec<&'static str> = BOX_BASE_HOSTS.to_vec();
    if let Some(provider) = ManagedProvider::from_executor(executor) {
        hosts.extend(provider.required_hosts());
    }
    hosts
}
pub(super) fn host_allowed(allowed: &[String], host: &str) -> bool {
    allowed.iter().any(|entry| {
        entry == host
            || entry
                .strip_prefix("*.")
                .is_some_and(|suffix| host.ends_with(&format!(".{suffix}")))
    })
}
/// Hosts from [`box_required_hosts`] the expanded allowlist is missing. Empty
/// when internet is disabled or unrestricted.
pub(super) fn missing_box_hosts(internet: &Internet, executor: &str) -> Vec<&'static str> {
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
pub(super) const MAX_BOX_ENV_ENTRIES: usize = 64;
/// Names the Box service reserves beyond Core's own `reserved` list. Box
/// compares them case-sensitively.
pub(super) fn box_reserved_key(key: &str) -> bool {
    matches!(key, "HOSTNAME" | "PWD" | "USER")
        || key.starts_with("DOCKER_")
        || key.starts_with("RYU_BOX_")
}
/// Stable key of the Fresh cloud box rollout flag. Must equal
/// `CLOUD_TASKS_BOX_BACKEND_FLAG` in `packages/auth/src/lib/feature-flags.ts`,
/// where the flag is marked `coreClaim` so it rides the signed JWT.

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
pub(super) fn runtime_issue(environment: &Environment, vault: &[VaultEntry]) -> Option<ApiError> {
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
    if let Some(message) = super::box_secrets::box_secret_issue(environment, vault) {
        return unavailable(message);
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
pub(in crate::server) fn runtime_for(owner: &str, environment_id: &str) -> Option<Runtime> {
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
pub(super) fn validate(state: &Snapshot) -> Result<(), ApiError> {
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
pub(super) fn valid_repository(repo: &str) -> bool {
    repo.len() <= 1024
        && repo.split('/').count() == 2
        && repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._/".contains(&byte))
        && repo
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
pub(super) fn valid_domain(domain: &str) -> bool {
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
