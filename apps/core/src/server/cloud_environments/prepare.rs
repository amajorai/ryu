//! Resolve a published environment into everything a setup check or task needs.

use super::box_flag::require_box_backend_feature;
use super::box_secrets::{box_network_secret, BoxNetworkPlan};
use super::policy::{approve_network_policy, approve_setup_budget, governed_spec};
use super::script::{
    box_network, build_task_script, github_basic_credential, is_github_token_key,
    network_secret_push_credential, repository_name, GitPushCredential, PreparedEnvironment,
    ScriptPlan, TaskBackend,
};
use super::validation::runtime_issue;
use super::*;

pub(in crate::server) async fn prepare_environment(
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
    if is_box && !crate::server::session_box::box_configured().await {
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
    let mut box_secrets = vec![];
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
    let mut git_push_token = org_github_token.clone().map(GitPushCredential::plain);
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
        // A fresh cloud box substitutes network secrets in its own egress
        // proxy; plain Docker has nothing that could.
        if entry.kind == "networkSecret"
            && !is_box
            && !governed
            && !vpn
            && environment.internet.enabled
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
            if environment.internet.enabled && is_box {
                box_secrets.push(box_network_secret(&placeholder, &entry.domains, &value));
                // The clean-room push sends the placeholder; the Box egress
                // proxy swaps it for the token only on its way to github.com.
                if git_push_token.is_none() {
                    git_push_token =
                        network_secret_push_credential(key, &entry.domains, &value, &placeholder);
                }
            }
            if environment.internet.enabled {
                proxy_credentials.push(ryu_sandbox::governed::ProxyCredential {
                    name: entry.id.clone(),
                    value: value.clone(),
                    placeholder,
                    hosts: entry.domains.clone(),
                });
            }
        } else {
            if git_push_token.is_none() && is_github_token_key(key) {
                git_push_token = Some(GitPushCredential::plain(value.clone()));
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
    let git_push_token = git_push_token.filter(|token| is_box && !token.api_token.is_empty());
    if let Some(token) = &git_push_token {
        task_redactions.push(token.api_token.clone());
        task_redactions.push(github_basic_credential(&token.api_token));
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
    let box_network = is_box.then(|| BoxNetworkPlan {
        network: box_network(&environment.internet),
        secrets: box_secrets,
    });
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
