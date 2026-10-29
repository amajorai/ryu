use super::*;

#[test]
fn route_provider_reach_classifies_every_engine() {
    use crate::agent_access::ProviderReach;
    let switches = |claude, codex, agent| RouteSwitches {
        claude,
        codex,
        agent,
    };
    let registry = |id| LaunchedEngine::Registry {
        id,
        acp: true,
        gateway_bypass: false,
    };
    for claude in [true, false] {
        assert_eq!(
            route_provider_reach(registry("acp:claude"), switches(claude, false, true)),
            ProviderReach::Vendor("anthropic"),
            "Claude Code uses the user's own Anthropic sign-in, passthrough or not"
        );
    }
    // Codex: subscription passthrough, per-agent Gateway, both off.
    assert_eq!(
        route_provider_reach(registry("acp:codex"), switches(false, true, false)),
        ProviderReach::Vendor("openai")
    );
    assert_eq!(
        route_provider_reach(registry("acp:codex"), switches(false, false, true)),
        ProviderReach::Gateway
    );
    assert_eq!(
        route_provider_reach(registry("acp:codex"), switches(false, false, false)),
        ProviderReach::Gateway
    );
    for agent in [true, false] {
        assert_eq!(
            route_provider_reach(registry("acp:gemini"), switches(true, true, agent)),
            ProviderReach::Vendor("genai")
        );
        assert_eq!(
            route_provider_reach(registry("acp:kiro"), switches(true, true, agent)),
            ProviderReach::Vendor("kiro")
        );
        assert_eq!(
            route_provider_reach(registry("acp:pi"), switches(true, true, agent)),
            ProviderReach::SelfCalled { routable: false }
        );
        assert_eq!(
            route_provider_reach(
                LaunchedEngine::Registry {
                    id: "openclaw",
                    acp: true,
                    gateway_bypass: true,
                },
                switches(true, true, agent)
            ),
            ProviderReach::SelfCalled { routable: false }
        );
        assert_eq!(
            route_provider_reach(LaunchedEngine::SdkApp, switches(true, true, agent)),
            ProviderReach::SelfCalled { routable: false }
        );
        assert_eq!(
            route_provider_reach(
                LaunchedEngine::Registry {
                    id: "zeroclaw",
                    acp: false,
                    gateway_bypass: false,
                },
                switches(true, true, agent)
            ),
            ProviderReach::Gateway
        );
        // A BYO command is classified by what it runs, not by its switch.
        assert_eq!(
            route_provider_reach(
                LaunchedEngine::AcpExec("npx -y @agentclientprotocol/claude-agent-acp"),
                switches(true, true, agent)
            ),
            ProviderReach::Vendor("anthropic")
        );
        assert_eq!(
            route_provider_reach(
                LaunchedEngine::AcpExec("npx -y @zed-industries/codex-acp"),
                switches(true, true, agent)
            ),
            ProviderReach::Vendor("openai")
        );
        for gemini in [
            "gemini --experimental-acp",
            "/usr/local/bin/gemini --experimental-acp",
            "npx -y @google/gemini-cli --experimental-acp",
            "node /opt/node_modules/@google/gemini-cli/dist/index.js --experimental-acp",
            "node /usr/local/bin/gemini --experimental-acp",
        ] {
            assert_eq!(
                route_provider_reach(LaunchedEngine::AcpExec(gemini), switches(true, true, agent)),
                ProviderReach::Vendor("genai"),
                "{gemini}"
            );
        }
        for kiro in ["kiro-cli acp", "/opt/agents/kiro-cli acp"] {
            assert_eq!(
                route_provider_reach(LaunchedEngine::AcpExec(kiro), switches(true, true, agent)),
                ProviderReach::Vendor("kiro"),
                "{kiro}"
            );
        }
    }
    // Generic entries and other BYO commands follow the agent's routing.
    assert_eq!(
        route_provider_reach(registry("acp:generic"), switches(true, true, true)),
        ProviderReach::Gateway
    );
    assert_eq!(
        route_provider_reach(registry("acp:generic"), switches(true, true, false)),
        ProviderReach::SelfCalled { routable: true }
    );
    assert_eq!(
        route_provider_reach(
            LaunchedEngine::AcpExec("goose acp"),
            switches(true, true, true)
        ),
        ProviderReach::Gateway
    );
    assert_eq!(
        route_provider_reach(
            LaunchedEngine::AcpExec("goose acp"),
            switches(true, true, false)
        ),
        ProviderReach::SelfCalled { routable: true }
    );
}

#[test]
fn launch_check_reports_the_launch_paths_own_refusals() {
    use crate::agent_access::AgentAccountPolicy;
    use crate::agents::AgentIdentityMode::{Individual, Managed, Mixed};
    let _guard = crate::agent_routing::TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    crate::agent_routing::set_from_json("{}");
    crate::claude_config::set_enabled("true");
    crate::codex_config::set_enabled("false");
    let registry = acp_reg();
    let check = |id: Option<&str>,
                 engine: &str,
                 policy: &AgentAccountPolicy,
                 support: Result<(), String>| {
        agent_launch_check(id, engine, policy, &registry, support)
    };
    let individual = AgentAccountPolicy::from_parts(Individual, None);
    let unrestricted = AgentAccountPolicy::from_parts(Managed, None);
    let both = AgentAccountPolicy::from_parts(Mixed, None);
    let no_sandbox = || Err("no sandbox here".to_owned());

    // Its own identity on Claude Code: refused with the text the route
    // refuses it with, saved or not.
    for id in [Some("agent-a"), None] {
        let claude = check(id, "acp:claude", &individual, Ok(()));
        assert!(!claude.launchable);
        assert_eq!(claude.code.as_deref(), Some(LAUNCH_REFUSED_PROVIDER_ACCESS));
        assert_eq!(
            claude.reason,
            limited_route_refusal("agent-a", "acp:claude", &registry, Some(&[]))
        );
        assert!(claude
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("Anthropic")));
        assert_eq!(claude.vendor_provider.as_deref(), Some("anthropic"));
        assert!(claude.sandbox_supported);
        assert!(!claude.runs_on_managed_pi);
    }
    assert!(limited_route("agent-a", "acp:claude", Some(&[])).is_none());

    // Acting as the user without a limit, Claude Code starts and is still
    // reported as calling Anthropic itself, sandbox or not.
    for support in [Ok(()), no_sandbox()] {
        let legacy = check(Some("agent-a"), "acp:claude", &unrestricted, support);
        assert!(legacy.launchable && legacy.reason.is_none() && legacy.code.is_none());
        assert_eq!(legacy.vendor_provider.as_deref(), Some("anthropic"));
    }

    // Codex names OpenAI only while it is on its subscription passthrough.
    assert_eq!(
        check(Some("agent-a"), "acp:codex", &unrestricted, Ok(())).vendor_provider,
        None
    );
    crate::codex_config::set_enabled("true");
    assert_eq!(
        check(Some("agent-a"), "acp:codex", &unrestricted, Ok(()))
            .vendor_provider
            .as_deref(),
        Some("openai")
    );
    crate::codex_config::set_enabled("false");

    // A Gateway-routed engine spawned for a confined agent needs the
    // sandbox: Both with no limit starts it only where one exists.
    let goose = "acp-exec:goose acp";
    let sandboxed = check(Some("agent-a"), goose, &both, Ok(()));
    assert!(sandboxed.launchable && sandboxed.sandbox_supported);
    assert_eq!(sandboxed.vendor_provider, None);
    let unsandboxed = check(Some("agent-a"), goose, &both, no_sandbox());
    assert!(!unsandboxed.launchable);
    assert!(!unsandboxed.sandbox_supported);
    assert_eq!(unsandboxed.code.as_deref(), Some(LAUNCH_REFUSED_SANDBOX));
    assert_eq!(
        unsandboxed.reason,
        Some(
            acp::account_sandbox_failure(
                "no sandbox here",
                crate::agent_access::AccountConfinement::CoreState
            )
            .message
        )
    );
    // An unconfined agent never needs it.
    assert!(check(Some("agent-a"), goose, &unrestricted, no_sandbox()).launchable);
    // The default agent spawns nothing.
    assert!(check(Some("default"), "default", &individual, no_sandbox()).launchable);
}

#[test]
fn launch_check_runs_limited_agents_on_ryus_engine_without_a_sandbox() {
    use crate::agent_access::AgentAccountPolicy;
    use crate::agents::AgentIdentityMode::{Individual, Managed};
    // Pi config lock (taken by `with_temp_dir`) before the gateway env lock,
    // the order `flagship_routing` uses; the reverse deadlocks in parallel.
    crate::pi_config::tests::with_temp_dir(|| {
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        let registry = acp_reg();
        let individual = AgentAccountPolicy::from_parts(Individual, None);
        let limited =
            AgentAccountPolicy::from_parts(Managed, Some(&["provider:openai".to_owned()]));
        assert!(crate::pi_config::is_gateway_routing());
        for policy in [&individual, &limited] {
            for id in [Some("agent-a"), None] {
                for support in [Ok(()), Err("no sandbox here".to_owned())] {
                    let supported = support.is_ok();
                    let ryu = agent_launch_check(id, "acp:pi", policy, &registry, support);
                    assert!(ryu.launchable, "{ryu:?}");
                    assert!(ryu.runs_on_managed_pi);
                    assert_eq!(ryu.sandbox_supported, supported);
                    assert_eq!(ryu.vendor_provider, None);
                }
            }
        }
        // The flagship and the built-in bots run there too, but are not
        // reported as moved onto it.
        let flagship = agent_launch_check(Some("ryu"), "acp:pi", &individual, &registry, Ok(()));
        assert!(flagship.launchable && !flagship.runs_on_managed_pi);

        // With Ryu's Pi calling its provider directly, the limited agent is
        // refused, as its route is; an unrestricted one keeps its own Pi.
        let settings = crate::pi_config::config_dir().join("settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(&settings, r#"{"x-ryu-routing":"direct"}"#).unwrap();
        assert!(!crate::pi_config::is_gateway_routing());
        let refused = agent_launch_check(Some("agent-a"), "acp:pi", &individual, &registry, Ok(()));
        assert!(!refused.launchable);
        assert_eq!(
            refused.code.as_deref(),
            Some(LAUNCH_REFUSED_MANAGED_PI_DIRECT)
        );
        assert!(refused
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("directly")));
        let unrestricted = AgentAccountPolicy::from_parts(Managed, None);
        let own_pi =
            agent_launch_check(Some("agent-a"), "acp:pi", &unrestricted, &registry, Ok(()));
        assert!(own_pi.launchable && !own_pi.runs_on_managed_pi);
    });
}

/// A limited agent's provider access is only enforced through the Gateway
/// Core manages, so a node with an operator-run Gateway refuses it before the
/// first turn, as the turn path does.
#[test]
fn launch_check_refuses_limited_agents_when_the_gateway_is_not_managed() {
    use crate::agent_access::AgentAccountPolicy;
    use crate::agents::AgentIdentityMode::{Individual, Managed};
    // Pi config lock (taken by `with_temp_dir`) before the gateway env lock,
    // the order `flagship_routing` uses; the reverse deadlocks in parallel.
    crate::pi_config::tests::with_temp_dir(|| {
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        let previous = std::env::var("RYU_GATEWAY_MANAGED").ok();
        let registry = acp_reg();
        let individual = AgentAccountPolicy::from_parts(Individual, None);
        let limited =
            AgentAccountPolicy::from_parts(Managed, Some(&["provider:openai".to_owned()]));
        let unrestricted = AgentAccountPolicy::from_parts(Managed, None);
        std::env::set_var("RYU_GATEWAY_MANAGED", "0");
        for policy in [&individual, &limited] {
            let refused = agent_launch_check(Some("agent-a"), "acp:pi", policy, &registry, Ok(()));
            assert!(!refused.launchable, "{refused:?}");
            assert_eq!(
                refused.code.as_deref(),
                Some(LAUNCH_REFUSED_UNMANAGED_GATEWAY)
            );
            assert_eq!(refused.reason.as_deref(), Some(UNMANAGED_GATEWAY_REFUSAL));
        }
        // An unrestricted agent never needs the managed Gateway.
        assert!(
            agent_launch_check(Some("agent-a"), "acp:pi", &unrestricted, &registry, Ok(()))
                .launchable
        );
        std::env::set_var("RYU_GATEWAY_MANAGED", "1");
        assert!(
            agent_launch_check(Some("agent-a"), "acp:pi", &limited, &registry, Ok(())).launchable
        );
        match previous {
            Some(value) => std::env::set_var("RYU_GATEWAY_MANAGED", value),
            None => std::env::remove_var("RYU_GATEWAY_MANAGED"),
        }
    });
}

/// The launch check reports which model a limited agent on Ryu's engine
/// starts on, and warns when that is the local model and it is missing.
#[test]
fn launch_check_warns_when_a_limited_agent_has_no_usable_model() {
    use crate::agent_access::AgentAccountPolicy;
    use crate::agents::AgentIdentityMode::{Individual, Managed};
    use crate::pi_config::LimitedModelSource;
    // Pi config lock (taken by `with_temp_dir`) before the gateway env lock,
    // the order `flagship_routing` uses; the reverse deadlocks in parallel.
    crate::pi_config::tests::with_temp_dir(|| {
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        let registry = acp_reg();
        let settings = crate::pi_config::config_dir().join("settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        let individual = AgentAccountPolicy::from_parts(Individual, None);
        let limited =
            AgentAccountPolicy::from_parts(Managed, Some(&["provider:openai".to_owned()]));
        let check = |policy: &AgentAccountPolicy| {
            agent_launch_check(Some("agent-a"), "acp:pi", policy, &registry, Ok(()))
        };

        // A BYOK default its identity may not use: the local model.
        std::fs::write(&settings, r#"{"defaultModel":"claude-sonnet-4-5"}"#).unwrap();
        let own = check(&individual);
        assert_eq!(own.limited_model_source, Some(LimitedModelSource::Local));
        let warned = own.clone().with_model_warning(false);
        assert_eq!(
            warned.model_warning.as_deref(),
            Some(NO_USABLE_MODEL_WARNING_OWN_IDENTITY)
        );
        assert!(warned.launchable, "the warning does not refuse the launch");
        assert_eq!(own.with_model_warning(true).model_warning, None);
        assert_eq!(
            check(&limited)
                .with_model_warning(false)
                .model_warning
                .as_deref(),
            Some(NO_USABLE_MODEL_WARNING)
        );

        // A Ryu-credit default needs no local model.
        std::fs::write(&settings, r#"{"defaultModel":"ryu-code/standard"}"#).unwrap();
        let credit = check(&individual);
        assert_eq!(
            credit.limited_model_source,
            Some(LimitedModelSource::RyuCredits)
        );
        assert_eq!(credit.with_model_warning(false).model_warning, None);

        // An unrestricted agent keeps its own Pi and model: nothing to say.
        let unrestricted = AgentAccountPolicy::from_parts(Managed, None);
        let own_pi = check(&unrestricted).with_model_warning(false);
        assert_eq!(own_pi.limited_model_source, None);
        assert_eq!(own_pi.model_warning, None);
    });
}
