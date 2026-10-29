use super::*;

pub(crate) fn sse_response(body: Body) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .body(body)
        .unwrap();
    let h = response.headers_mut();
    h.insert(
        "content-type",
        HeaderValue::from_static("text/event-stream"),
    );
    h.insert("cache-control", HeaderValue::from_static("no-cache"));
    h.insert(
        "x-vercel-ai-ui-message-stream",
        HeaderValue::from_static("v1"),
    );
    h.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    response
}

// ── Agent routing ──────────────────────────────────────────────────────────────

/// The `model` to send to a local engine. An explicit route model wins;
/// otherwise ask the provider what it serves (vLLM/SGLang/MLX launch model,
/// apfel's Apple FM id, the active Ollama selection). The engine name is only a
/// last resort for engines that ignore the field (single-model llama.cpp).
pub(crate) async fn resolve_local_engine_model(engine: &str, model: Option<String>) -> String {
    if let Some(model) = model.filter(|model| !model.trim().is_empty()) {
        return model;
    }
    crate::sidecar::providers::served_chat_model(engine)
        .await
        .unwrap_or_else(|| engine.to_owned())
}

pub(crate) enum AgentRoute {
    OpenAiCompat {
        base_url: String,
        model: String,
        api_key: Option<String>,
        /// When true, Core forwards this call to the local ryu-gateway instead
        /// of hitting `base_url` directly. The gateway owns provider creds and
        /// forwards to the engine (U18 data-plane wiring). When false, the
        /// route targets a specific provider directly (registry-configured
        /// OpenAI-compat agents that already encode their own endpoint).
        via_gateway: bool,
    },
    Acp {
        spawn_cmd: String,
    },
    /// A trusted remote A2A v1 peer. The peer id resolves to an encrypted
    /// credential and a discovered Agent Card at call time.
    A2a {
        peer_id: String,
    },
    /// Bound to a local inference engine that must be made resident (swapped to)
    /// before the request can stream. `model` is threaded into the payload;
    /// `None` means the route left it unset and the engine's served model is
    /// resolved after activation (see `providers::served_chat_model`).
    LocalEngine {
        engine: String,
        base_url: String,
        model: Option<String>,
    },
    /// An SDK app managed by Core (`sdk:<package>` prefix). The app exposes an
    /// OpenAI-compatible loopback endpoint; Core calls it directly (`via_gateway:
    /// false`). The app's own model calls are governed by gateway env-injection
    /// (see `sdk::sdk_app_spawn_parts`). Model calls made inside the SDK process
    /// flow through the gateway — policy at the subprocess boundary, not the
    /// Core hop.
    SdkApp {
        base_url: String,
        model: String,
    },
}

pub(crate) fn public_agent_route_supported(
    route: &AgentRoute,
    policy: Option<&PublicAgentRunPolicy>,
) -> bool {
    let Some(policy) = policy else {
        return true;
    };
    if policy.has_tool_capabilities() {
        return matches!(
            route,
            AgentRoute::OpenAiCompat {
                via_gateway: true,
                ..
            }
        );
    }
    matches!(
        route,
        AgentRoute::OpenAiCompat { .. } | AgentRoute::LocalEngine { .. }
    )
}

/// Whether a read-only app run ([`ChatStreamRequest::read_only_tools`]) may use
/// `route`. Only Core-governed routes qualify: their tool loop (if any) is fed
/// from the Core-restricted allowlist. ACP, A2A and SDK-app routes execute their
/// own tools, which Core cannot narrow to read-only, so they are refused.
pub(crate) fn read_only_route_supported(route: &AgentRoute) -> bool {
    matches!(
        route,
        AgentRoute::OpenAiCompat { .. } | AgentRoute::LocalEngine { .. }
    )
}

/// `agent_id` values that select a built-in default agent (plain-LLM or Ryu flagship).
///
/// `None`, `""`, and `"default"` pick the plain-LLM fallback (`default_agent_route`).
/// `"ryu"` selects the flagship "Ryu" agent: Pi bound as the engine, every call
/// forced through the Gateway (`ryu_agent_route`). Both share the same ACL path
/// so clients that haven't selected an agent get chat without needing to know
/// which underlying agent is running.
pub(crate) fn is_default_agent(agent_id: Option<&str>) -> bool {
    matches!(agent_id, None | Some("") | Some("default") | Some("ryu"))
}
pub(crate) fn cloud_agent_supported(agent_id: Option<&str>) -> bool {
    is_default_agent(agent_id)
}

/// One immutable SDK selection shared by dispatch, history and cost tracking.
pub(crate) struct SdkTurnSelection {
    pub(crate) account: crate::pi_config::session_accounts::SessionAccount,
    pub(crate) model: Option<String>,
}

impl SdkTurnSelection {
    pub(crate) fn from_config(
        account: crate::pi_config::session_accounts::SessionAccount,
        config: &crate::pi_config::PiConfigView,
    ) -> Self {
        Self {
            account,
            model: Self::configured_model(config),
        }
    }

    fn configured_model(config: &crate::pi_config::PiConfigView) -> Option<String> {
        config.model.as_deref().and_then(|model| {
            let model = model.trim();
            (!model.is_empty()).then(|| model.to_owned())
        })
    }

    pub(crate) fn pin_request_model(&self, req: &mut ChatStreamRequest) {
        let model = self
            .model
            .as_ref()
            .map(|model| format!("{}/{model}", self.account.provider_id));
        req.acp_model = model.clone();
        if let Some(config) = req.acp_config.as_mut() {
            if config.contains_key("model") {
                match model {
                    Some(model) => {
                        config.insert("model".to_owned(), model);
                    }
                    None => {
                        config.remove("model");
                    }
                }
            }
        }
    }
}

/// The local/Gateway registry cannot describe an explicitly configured SDK
/// session. Credential capture must succeed before this exception applies.
pub(crate) fn direct_managed_pi_configured(
    exact_direct_spawn: bool,
    config: &crate::pi_config::PiConfigView,
    captured: Option<&crate::pi_config::session_accounts::SessionAccount>,
) -> bool {
    exact_direct_spawn
        && config.routing == "direct"
        && crate::pi_config::sdk_account_routing::supported(&config.provider)
        && SdkTurnSelection::configured_model(config).is_some()
        && captured.is_some_and(|account| account.provider_id == config.provider)
}

/// Fresh-node servability guard for the flagship `ryu` default agent.
///
/// The `ryu` agent runs the managed Pi with its model egress forced through the
/// gateway's `local` provider (llama.cpp). On a fresh node with no model weights
/// and no remote provider, that provider returns 503 — but the managed Pi
/// *swallows* that error and returns a clean `EndTurn`, streaming its own
/// context/skills banner as if it were the assistant reply (input-independent
/// garbage, with no error surfaced). This predicate lets the caller short-circuit
/// BEFORE spawning Pi with an actionable error instead.
///
/// Returns `true` only when the node is *unambiguously* unable to serve a chat
/// completion for this agent. It is conservative by construction — every servable
/// configuration trips one check open, so it can never block a working node:
///   1. Only the flagship default (`ryu`) agent — every other agent brings its
///      own engine and is out of scope here.
///   2. No remote egress configured (default base_url, no default API key, no
///      file-configured providers) — any remote provider would serve.
///   3. The resident local engine is the default llama.cpp, or none — a keyless
///      engine such as `apfel` (Apple Foundation Models) serves without weights.
///   4. The local chat model weight file is absent — present ⇒ llama.cpp serves.
///
/// It deliberately does NOT fire on some exotic no-LLM configs (e.g. a remote key
/// set but the local model still selected with no weights): that is an accepted
/// false-negative in exchange for zero false-positives, and matches this defect's
/// scope (fresh node, no provider key, local engine without a model).
pub(crate) async fn ryu_default_unservable(
    manager: &SidecarManager,
    provider_reg: &ProviderRegistry,
    effective_agent_id: Option<&str>,
) -> bool {
    // 1. Flagship default agent only.
    if !is_default_agent(effective_agent_id) {
        return false;
    }
    // 2. A remote provider would serve — fail open if any is configured. Mirrors
    //    `default_agent_route`'s key resolution, plus the file-configured
    //    `providers` list (a key in `registry.json` with no env var set).
    let remote_configured = provider_reg.default_llm_base_url
        != crate::registry::DEFAULT_LLM_BASE_URL
        || std::env::var("RYU_DEFAULT_LLM_API_KEY")
            .ok()
            .is_some_and(|s| !s.is_empty())
        || std::env::var("OPENAI_API_KEY")
            .ok()
            .is_some_and(|s| !s.is_empty())
        || !provider_reg.providers.is_empty();
    if remote_configured {
        return false;
    }
    // 3. A non-llama.cpp resident local engine (e.g. `apfel`) serves without a
    //    GGUF weight file, so its presence means the node is servable.
    match manager.active_local_engine().await.as_deref() {
        None | Some("llamacpp") => {}
        Some(_) => return false,
    }
    // 4. The local chat model weight file is absent ⇒ nothing can serve.
    !crate::sidecar::providers::llamacpp::active_chat_model_present(provider_reg).await
}

/// Build the default plain-LLM route from the unified [`ProviderRegistry`].
///
/// Lets Core act as a complete standalone backend: a chat request with no
/// `agent_id` (or `agent_id=default`) streams from a configurable
/// OpenAI-compatible provider without needing an ACP agent installed.
///
/// The registry resolves base_url and model in precedence order:
///   env var > `~/.ryu/registry.json` field > built-in literal fallback
///
/// The API key is NOT stored in the registry file (config, not secrets).
/// It is read directly from env (`RYU_DEFAULT_LLM_API_KEY` / `OPENAI_API_KEY`).
pub(crate) fn default_agent_route(reg: &ProviderRegistry) -> AgentRoute {
    let base_url = reg.default_llm_base_url.clone();
    let model = reg.default_llm_model.clone();
    let api_key = std::env::var("RYU_DEFAULT_LLM_API_KEY")
        .ok()
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .filter(|s| !s.is_empty());
    AgentRoute::OpenAiCompat {
        base_url,
        model,
        api_key,
        via_gateway: true,
    }
}

/// Build the route for the flagship "Ryu" agent: Pi bound as the engine with every
/// call forced through the local ryu-gateway.
///
/// Pi is looked up in the in-code `registry` so the binding is swappable — changing
/// the Pi entry (or overriding it via the U1/U30 config registry) automatically
/// changes what Ryu uses. If the Pi entry is absent the route falls back to the
/// plain-LLM `default_agent_route()` so chat keeps working even without Pi.
///
/// "Gateway on top" is expressed exactly as `codex_acp_cmd()` does it for Codex:
/// gateway URL + token are injected as env vars into the Pi subprocess so every
/// outbound model call the Pi process makes goes through the gateway's firewall,
/// budget, and audit pipeline (U18/U28).
fn ryu_agent_route(
    acp_registry: &AcpAgentRegistry,
    provider_reg: &ProviderRegistry,
) -> Option<AgentRoute> {
    ryu_agent_route_with_user_jwt(
        "ryu",
        acp_registry,
        provider_reg,
        None,
        None,
        None,
        None,
        None,
    )
}
