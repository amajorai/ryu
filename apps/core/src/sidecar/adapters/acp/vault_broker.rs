use super::*;

use crate::vault::broker::runtime::RuntimeLaunch;

/// Proxy variables that mean traffic must leave through another proxy. The
/// broker dials upstream directly, so a run behind one is left unbrokered.
const UPSTREAM_PROXY_ENV: [&str; 6] = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
];

/// Whether an upstream proxy is configured, in Core's own environment (which
/// the agent inherits) or the agent's declared one.
pub(super) fn upstream_proxy_configured(
    stdio: &McpServerStdio,
    core_env: impl Fn(&str) -> Option<String>,
) -> bool {
    let declared = super::super::acp_direct_spawn::declared_environment(stdio);
    UPSTREAM_PROXY_ENV.iter().any(|name| {
        core_env(name).is_some_and(|value| !value.trim().is_empty())
            || declared
                .iter()
                .any(|(declared, value)| declared == name && !value.trim().is_empty())
    })
}

/// The label kind of a runtime: Ryu's Pi, Claude Code, or another ACP agent.
pub(super) fn runtime_kind(is_managed_pi: bool, is_claude_code: bool) -> &'static str {
    if is_managed_pi {
        "pi"
    } else if is_claude_code {
        "claude-code"
    } else {
        "acp"
    }
}

/// Whether the agent's model traffic goes to a loopback endpoint, which the
/// broker's `NO_PROXY` exempts: Core's inference proxy, or a loopback Gateway.
fn model_via_loopback(stdio: &McpServerStdio) -> bool {
    stdio_targets_inference_proxy(stdio)
        || (stdio_targets_local_gateway(stdio)
            && loopback_port(&crate::sidecar::gateway::configured_gateway_url()).is_some())
}

/// What the broker needs to know about an ACP agent about to spawn.
pub(super) fn runtime_launch(
    stdio: &McpServerStdio,
    is_managed_pi: bool,
    is_claude_code: bool,
    trusted: bool,
    account: crate::agent_access::AccountConfinement,
    core_env: impl Fn(&str) -> Option<String>,
) -> RuntimeLaunch {
    RuntimeLaunch {
        kind: runtime_kind(is_managed_pi, is_claude_code),
        trusted_workspace: trusted,
        account_confined: account.is_confined(),
        model_via_loopback: model_via_loopback(stdio),
        upstream_proxy: upstream_proxy_configured(stdio, core_env),
    }
}

/// Layer the broker's proxy environment over the agent's, so the project
/// environment cannot redirect or exempt the brokered traffic. Every case
/// variant of a broker variable is dropped first and each spelling the broker
/// sets is kept exactly (`curl` reads only `http_proxy`, others only the
/// upper-case form).
pub(super) fn apply_broker_env(
    env: &mut Vec<agent_client_protocol::schema::v1::EnvVariable>,
    broker_env: &BTreeMap<String, String>,
) {
    env.retain(|entry| {
        !broker_env
            .keys()
            .any(|name| name.eq_ignore_ascii_case(&entry.name))
    });
    env.extend(broker_env.iter().map(|(name, value)| {
        agent_client_protocol::schema::v1::EnvVariable::new(name.clone(), value.clone())
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::EnvVariable;

    fn stdio(env: &[(&str, &str)]) -> McpServerStdio {
        McpServerStdio::new("agent", "agent-acp").env(
            env.iter()
                .map(|(name, value)| EnvVariable::new(*name, *value))
                .collect(),
        )
    }

    #[test]
    fn an_upstream_proxy_in_core_or_the_agent_env_is_detected() {
        let none = |_: &str| None;
        assert!(!upstream_proxy_configured(&stdio(&[]), none));
        assert!(upstream_proxy_configured(
            &stdio(&[("HTTPS_PROXY", "http://corp:3128")]),
            none
        ));
        assert!(!upstream_proxy_configured(
            &stdio(&[("HTTPS_PROXY", " ")]),
            none
        ));
        assert!(upstream_proxy_configured(&stdio(&[]), |name| {
            (name == "all_proxy").then(|| "socks5://corp:1080".to_owned())
        }));
    }

    #[test]
    fn runtime_kinds_and_confinement_reach_the_launch() {
        assert_eq!(runtime_kind(true, false), "pi");
        assert_eq!(runtime_kind(false, true), "claude-code");
        assert_eq!(runtime_kind(false, false), "acp");
        let launch = runtime_launch(
            &stdio(&[]),
            false,
            true,
            false,
            crate::agent_access::AccountConfinement::None,
            |_| None,
        );
        assert_eq!(launch.kind, "claude-code");
        assert!(!launch.trusted_workspace);
        assert!(!launch.account_confined);
        // Signs in to its provider directly: not loopback.
        assert!(!launch.model_via_loopback);
        assert!(!launch.upstream_proxy);
    }

    #[test]
    fn broker_env_overrides_the_agent_proxy_settings() {
        let mut env = vec![
            EnvVariable::new("Https_Proxy", "http://elsewhere:1"),
            EnvVariable::new("NO_PROXY", "*"),
            EnvVariable::new("KEEP", "me"),
        ];
        let broker_env: BTreeMap<String, String> = [
            ("HTTPS_PROXY", "http://rvb:rvb_x@127.0.0.1:9"),
            ("https_proxy", "http://rvb:rvb_x@127.0.0.1:9"),
            ("NO_PROXY", "localhost,127.0.0.1,::1"),
            ("NODE_USE_ENV_PROXY", "1"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
        apply_broker_env(&mut env, &broker_env);
        let value = |name: &str| {
            env.iter()
                .filter(|entry| entry.name.eq_ignore_ascii_case(name))
                .map(|entry| entry.value.clone())
                .collect::<Vec<_>>()
        };
        // Both exact spellings, and the agent's own variant is gone.
        assert_eq!(
            value("https_proxy"),
            vec!["http://rvb:rvb_x@127.0.0.1:9"; 2]
        );
        assert!(env.iter().any(|entry| entry.name == "https_proxy"));
        assert!(env.iter().all(|entry| entry.name != "Https_Proxy"));
        assert_eq!(value("no_proxy"), vec!["localhost,127.0.0.1,::1"]);
        assert_eq!(value("NODE_USE_ENV_PROXY"), vec!["1"]);
        assert_eq!(value("KEEP"), vec!["me"]);
    }
}
