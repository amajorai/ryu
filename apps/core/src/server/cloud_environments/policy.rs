//! Gateway approvals for a setup's network policy and execution budget.

use super::*;

pub(super) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub(super) fn governed_spec(
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
pub(in crate::server) async fn approve_network_policy(
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

pub(in crate::server) async fn approve_setup_budget(backend: &str) -> Result<(), ApiError> {
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
