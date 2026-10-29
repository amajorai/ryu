use super::*;

// ── File-backed model swap (AC3: no recompile to change the chat model) ──

#[test]
fn registry_file_overrides_default_chat_model_in_route() {
    // AC3: load a ProviderRegistry pointing at a temp registry.json with a
    // custom model, assert that default_agent_route returns that model so
    // swapping the default chat model only requires editing the file.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("registry.json");
    std::fs::write(
        &path,
        r#"{"default_llm_base_url":"https://api.custom-provider.example","default_llm_model":"my-custom-chat-model"}"#,
    )
    .unwrap();
    let reg = ProviderRegistry::from_file(&path);
    let route = default_agent_route(&reg);
    match route {
        AgentRoute::OpenAiCompat {
            base_url,
            model,
            via_gateway,
            ..
        } => {
            // The route must carry exactly what the file specified — no inline literal.
            assert_eq!(
                base_url, "https://api.custom-provider.example",
                "base_url must come from registry.json, not the inline literal"
            );
            assert_eq!(
                model, "my-custom-chat-model",
                "model must come from registry.json, not the inline literal"
            );
            assert!(via_gateway, "default route must always forward via gateway");
        }
        _ => panic!("expected OpenAiCompat route"),
    }
}

#[test]
fn ryu_is_not_routed_as_generic_default_llm() {
    let _pi_guard = crate::pi_config::lock_pi_config_test_env();
    // ryu must branch before the generic default_agent_route() so it never
    // falls through to the plain-LLM OpenAI-compat path.
    let route =
        agent_route(Some("ryu"), None, None, &acp_reg(), &provider_reg()).expect("ryu route");
    assert!(
        matches!(route, AgentRoute::Acp { .. }),
        "ryu must resolve to an ACP route, not the generic OpenAI-compat default"
    );
}

#[test]
fn unknown_agent_id_has_no_route() {
    assert!(agent_route(
        Some("nope-not-real"),
        Some("nope-not-real"),
        None,
        &acp_reg(),
        &provider_reg()
    )
    .is_none());
}

#[test]
fn a2a_engine_binding_resolves_to_remote_peer_route() {
    let route = agent_route(
        Some("remote-researcher"),
        Some("a2a:peer-123"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .expect("A2A route");
    assert!(matches!(
        route,
        AgentRoute::A2a { ref peer_id } if peer_id == "peer-123"
    ));
    assert!(agent_route(
        Some("broken-remote"),
        Some("a2a:   "),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .is_none());
}

#[test]
fn registry_agent_still_routes() {
    let route = agent_route(
        Some("acp:claude"),
        Some("acp:claude"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .expect("acp route");
    assert!(matches!(route, AgentRoute::Acp { .. }));
}

#[test]
fn kiro_bypass_route_does_not_inject_gateway_credentials() {
    let _guard = crate::agent_routing::TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    crate::agent_routing::set_from_json(r#"{"acp:kiro":true}"#);
    let registry = acp_reg();
    let entry = registry.find_by_prefix("acp:kiro").unwrap();
    let acp::AgentTransport::Acp {
        spawn_cmd: expected,
    } = &entry.transport
    else {
        panic!("ACP required")
    };
    let route = agent_route(
        Some("acp:kiro"),
        Some("acp:kiro"),
        None,
        &registry,
        &provider_reg(),
    );
    crate::agent_routing::set_from_json("{}");
    let Some(AgentRoute::Acp { spawn_cmd }) = route else {
        panic!("native Kiro route required")
    };
    assert_eq!(
        &spawn_cmd, expected,
        "bypass must retain vendor command without a Gateway bearer"
    );
}

#[test]
fn acp_exec_engine_runs_arbitrary_command() {
    // BYO escape hatch: a custom agent whose engine is `acp-exec:<command>`
    // runs that literal command as an ACP subprocess, so ANY ACP-compatible
    // agent works without being enumerated in the registry (binary-only,
    // private, or future agents). The command is passed through verbatim.
    let _guard = crate::agent_routing::TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    crate::agent_routing::set_from_json(r#"{"my-custom-acp": false}"#);
    let route = agent_route(
        Some("my-custom-acp"),
        Some("acp-exec:goose acp"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .expect("acp-exec route");
    match route {
        AgentRoute::Acp { ref spawn_cmd } => assert_eq!(spawn_cmd, "goose acp"),
        _ => panic!("acp-exec engine must resolve to an ACP route"),
    }
}

#[test]
fn acp_exec_agent_routes_through_gateway_when_toggled() {
    // The core of the "point any agent at the gateway" feature: a BYO
    // `acp-exec:` agent with its generic gateway-routing toggle ON must have
    // OPENAI_BASE_URL injected into its spawn command (so its egress traverses
    // the gateway); with the toggle OFF the command stays verbatim.
    // Serialize against the agent_routing module tests — they share the same
    // process-global routing map.
    let _guard = crate::agent_routing::TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let id = "byo-openai-agent";
    // An explicit opt-out is verbatim, with no injection.
    crate::agent_routing::set_from_json(&format!(r#"{{"{id}": false}}"#));
    let off = agent_route(
        Some(id),
        Some("acp-exec:my-agent --acp"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .expect("acp-exec route");
    match off {
        AgentRoute::Acp { ref spawn_cmd } => {
            assert_eq!(spawn_cmd, "my-agent --acp");
            assert!(!spawn_cmd.contains("OPENAI_BASE_URL"));
        }
        _ => panic!("acp-exec engine must resolve to an ACP route"),
    }
    // Toggled on for this agent id: the gateway env is injected.
    crate::agent_routing::set_from_json(&format!("{{\"{id}\": true}}"));
    let on = agent_route(
        Some(id),
        Some("acp-exec:my-agent --acp"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .expect("acp-exec route");
    match on {
        AgentRoute::Acp { ref spawn_cmd } => {
            let value: serde_json::Value =
                serde_json::from_str(spawn_cmd).expect("gateway ACP command is structured JSON");
            let env = value["env"].as_array().expect("structured env array");
            let base_url = env
                .iter()
                .find(|entry| entry["name"] == "OPENAI_BASE_URL")
                .and_then(|entry| entry["value"].as_str())
                .unwrap_or_default();
            assert!(
                base_url.contains("/v1/agents/byo-openai-agent"),
                "toggled-on BYO agent must inject the scoped gateway base URL, got: {spawn_cmd}"
            );
            assert_eq!(value["command"], "my-agent");
            assert_eq!(value["args"], serde_json::json!(["--acp"]));
        }
        _ => panic!("acp-exec engine must resolve to an ACP route"),
    }
    // Reset shared state so other tests see the default (OFF).
    crate::agent_routing::set_from_json("{}");
}

#[test]
fn acp_exec_engine_empty_command_has_no_route() {
    // An empty command after the prefix must not produce a route (it would
    // spawn nothing useful); it falls through to the normal resolution.
    assert!(agent_route(
        Some("broken"),
        Some("acp-exec:   "),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .is_none());
}

#[test]
fn local_engine_binding_resolves_to_local_route_with_model() {
    // An agent bound to ollama must route to the local engine (which the
    // caller will swap to) carrying the agent's model.
    let route = agent_route(
        Some("my-agent"),
        Some("ollama"),
        Some("llama3"),
        &acp_reg(),
        &provider_reg(),
    )
    .unwrap();
    match route {
        AgentRoute::LocalEngine {
            engine,
            base_url,
            model,
        } => {
            assert_eq!(engine, "ollama");
            assert_eq!(base_url, "http://127.0.0.1:11434");
            assert_eq!(model.as_deref(), Some("llama3"));
        }
        _ => panic!("expected LocalEngine route for an ollama binding"),
    }
}

#[test]
fn lemonade_binding_preserves_model_and_openai_endpoint() {
    let route = agent_route(
        Some("test"),
        Some("lemonade"),
        Some("Qwen3-0.6B-GGUF"),
        &acp_reg(),
        &provider_reg(),
    );
    match route {
        Some(AgentRoute::LocalEngine {
            engine,
            model,
            base_url,
        }) => {
            assert_eq!(engine, "lemonade");
            assert_eq!(model.as_deref(), Some("Qwen3-0.6B-GGUF"));
            assert_eq!(base_url, "http://127.0.0.1:13305");
        }
        _ => panic!("expected Lemonade local route"),
    }
}

#[test]
fn magnitude_binding_preserves_model_and_openai_endpoint() {
    let route = agent_route(
        Some("test"),
        Some("magnitude"),
        Some("qwen3.6-35b-a3b"),
        &acp_reg(),
        &provider_reg(),
    );
    match route {
        Some(AgentRoute::LocalEngine {
            engine,
            model,
            base_url,
        }) => {
            assert_eq!(engine, "magnitude");
            assert_eq!(model.as_deref(), Some("qwen3.6-35b-a3b"));
            assert_eq!(base_url, "http://127.0.0.1:10100/inference");
        }
        _ => panic!("expected Magnitude local route"),
    }
}

#[test]
fn llama_swap_binding_preserves_model_and_openai_endpoint() {
    let route = agent_route(
        Some("test"),
        Some("llama-swap"),
        Some("Qwen3-0.6B-GGUF"),
        &acp_reg(),
        &provider_reg(),
    );
    match route {
        Some(AgentRoute::LocalEngine {
            engine,
            model,
            base_url,
        }) => {
            assert_eq!(engine, "llama-swap");
            assert_eq!(model.as_deref(), Some("Qwen3-0.6B-GGUF"));
            assert_eq!(base_url, "http://127.0.0.1:9292");
        }
        _ => panic!("expected llama-swap local route"),
    }
}

#[test]
fn freetoken_binding_preserves_model_and_openai_endpoint() {
    let route = agent_route(
        Some("test"),
        Some("freetoken"),
        Some("Qwen3-0.6B-GGUF"),
        &acp_reg(),
        &provider_reg(),
    );
    match route {
        Some(AgentRoute::LocalEngine {
            engine,
            model,
            base_url,
        }) => {
            assert_eq!(engine, "freetoken");
            assert_eq!(model.as_deref(), Some("Qwen3-0.6B-GGUF"));
            assert_eq!(base_url, "http://127.0.0.1:1919");
        }
        _ => panic!("expected freetoken local route"),
    }
}

#[test]
fn local_engine_without_model_defers_to_the_served_model() {
    let route = agent_route(
        Some("my-agent"),
        Some("vllm"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .unwrap();
    match route {
        AgentRoute::LocalEngine { engine, model, .. } => {
            assert_eq!(engine, "vllm");
            // Never the engine name: vLLM would reject `model: "vllm"`.
            assert_eq!(model, None);
        }
        _ => panic!("expected LocalEngine route"),
    }
}

#[tokio::test]
async fn unset_local_engine_model_resolves_to_what_the_engine_serves() {
    assert_eq!(
        resolve_local_engine_model("apfel", None).await,
        crate::sidecar::providers::apfel::APPLE_FM_MODEL_ID
    );
    assert_eq!(
        resolve_local_engine_model("apfel", Some("  ".to_owned())).await,
        crate::sidecar::providers::apfel::APPLE_FM_MODEL_ID
    );
    assert_eq!(
        resolve_local_engine_model("vllm", Some("org/explicit".to_owned())).await,
        "org/explicit"
    );
}

#[test]
fn cloud_binding_resolves_without_touching_local_engines() {
    // A cloud/registry OpenAI-compat agent must NOT be a LocalEngine route —
    // routing it must never trigger a local-engine swap. It must also carry
    // via_gateway:true so the call goes through the firewall/budget pipeline
    // before reaching the local engine endpoint (U28 egress closure).
    let route = agent_route(
        Some("zeroclaw"),
        Some("zeroclaw"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .unwrap();
    match route {
        AgentRoute::OpenAiCompat {
            base_url,
            via_gateway,
            ..
        } => {
            assert_eq!(base_url, "http://127.0.0.1:42617");
            assert!(
                via_gateway,
                "registry OpenAI-compat agents must route via_gateway:true"
            );
        }
        _ => panic!("expected OpenAiCompat route for a zeroclaw binding"),
    }
}

#[test]
fn registry_openai_compat_agents_all_route_via_gateway() {
    // Every OpenAI-compat registry agent (zeroclaw, openclaw, hermes) must
    // carry via_gateway:true so their egress is governed. Degraded-mode
    // fallback (gateway-down → direct base_url) is handled by route_chat_stream.
    let reg = acp_reg();
    let preg = provider_reg();
    for entry in &reg.entries {
        if let acp::AgentTransport::OpenAiCompat { .. } = &entry.transport {
            let route = agent_route(Some(&entry.id), Some(&entry.id), None, &reg, &preg)
                .unwrap_or_else(|| panic!("no route for {}", entry.id));
            assert!(
                matches!(
                    route,
                    AgentRoute::OpenAiCompat {
                        via_gateway: true,
                        ..
                    }
                ),
                "registry agent {} must have via_gateway:true",
                entry.id
            );
        }
    }
}

#[test]
fn unknown_or_unbound_engine_resolves_to_none() {
    // A non-default agent_id with neither a local engine nor a registry id → None,
    // so the caller falls back to the default agent.
    assert!(agent_route(
        Some("x"),
        Some("does-not-exist"),
        None,
        &acp_reg(),
        &provider_reg()
    )
    .is_none());
}
