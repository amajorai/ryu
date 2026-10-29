use super::*;

/// The private body field carrying the caller's `anthropic-beta` opt-ins as one
/// comma-separated string, from the chat-completions intake to the Anthropic
/// provider. Same convention as `ryu_smart_route` above.
///
/// Named once, here, because two modules must agree on the string: `api::chat`
/// WRITES it from the request header and [`strip_anthropic_beta_for`] REMOVES it
/// before any other provider sees it. A literal in each place could drift, and
/// the failure mode of drift is a 400 from a strict OpenAI endpoint.
pub(crate) const ANTHROPIC_BETA_FIELD: &str = "ryu_anthropic_beta";

/// Whether `provider` speaks the Anthropic Messages dialect, and is therefore an
/// intended reader of [`ANTHROPIC_BETA_FIELD`] — and, either way, one that builds
/// its own whitelist payload rather than forwarding the body verbatim.
///
/// `bedrock` is neither a typo nor optional: it is `AnthropicProvider` re-exposed
/// under its own registry id (see [`crate::providers::ProviderRegistry::new`]), so
/// `Provider::name` reports `"bedrock"` while the wire format is still Anthropic
/// Messages. Anchored to the shared const so renaming that id cannot silently
/// start stripping the betas off the Bedrock path.
pub(super) fn speaks_anthropic_dialect(provider: &str) -> bool {
    // `AnthropicProvider::name()` is the hardcoded "anthropic" (no id const for
    // the built-in slots); `bedrock` and the Ryu credit pool are the same
    // `AnthropicProvider` registered under their own ids.
    provider == "anthropic"
        || provider == crate::config::BEDROCK_PROVIDER_ID
        || provider == crate::config::ANTHROPIC_CREDITS_PROVIDER_ID
}

/// Strip [`ANTHROPIC_BETA_FIELD`] from the outgoing body unless `provider` is the
/// one that reads it.
///
/// Allowlist direction on purpose: every non-Anthropic provider clones the request
/// body VERBATIM into its payload (`openai.rs`, `openrouter.rs`, `local.rs`, …)
/// and an unknown top-level field 400s a strict OpenAI endpoint, so a provider id
/// nobody has thought about yet is safe by default.
///
/// Called per fallback ATTEMPT, not hoisted next to [`apply_prompt_cache`]:
/// `AnthropicProvider` takes the body by reference and builds its own whitelist
/// payload, so the field is still in *ours* after an Anthropic attempt — a
/// fallback onto `openai` for attempt 2 has to re-decide. Do not lift it out of
/// the loop.
pub(super) fn strip_anthropic_beta_for(body: &mut Value, provider: &str) {
    if speaks_anthropic_dialect(provider) {
        return;
    }
    if let Some(obj) = body.as_object_mut() {
        obj.remove(ANTHROPIC_BETA_FIELD);
    }
}

/// Remove every `cache_control` breakpoint from the outgoing body unless the
/// attempt's provider or model reads the Anthropic breakpoint dialect.
///
/// `/v1/messages` carries the caller's breakpoints through translation (root,
/// system and message blocks, tools) so Anthropic keeps its cached prefix. A
/// strict OpenAI endpoint rejects the root field with a 400, and block-level
/// markers are unknown egress there, so a fallback (or a non-Claude model behind
/// the Anthropic-format endpoint) must not forward them. The breakpoint-dialect
/// providers keep them: the Anthropic-dialect providers, OpenRouter, and any
/// provider serving a model whose published cache dialect is `cache_control`
/// (Qwen, DeepSeek-v3.2). The OpenAI providers are strict whatever the model.
///
/// Per ATTEMPT, like [`strip_anthropic_beta_for`]: the prompt-cache stage runs
/// again for each fallback attempt's model, which re-adds markers for a
/// provider that wants them.
pub(super) fn strip_cache_control_for(body: &mut Value, provider: &str, model: &str) {
    fn strip_blocks(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.remove("cache_control");
                for child in map.values_mut() {
                    strip_blocks(child);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(strip_blocks),
            _ => {}
        }
    }

    if speaks_anthropic_dialect(provider) || provider == "openrouter" {
        return;
    }
    let strict_openai =
        provider == "openai" || provider == crate::config::OPENAI_CREDITS_PROVIDER_ID;
    if !strict_openai
        && ryu_gw_providers::PromptCacheDialect::for_model(model)
            == ryu_gw_providers::PromptCacheDialect::Anthropic
    {
        return;
    }
    let Some(obj) = body.as_object_mut() else {
        return;
    };
    obj.remove("cache_control");
    for key in ["messages", "tools"] {
        if let Some(child) = obj.get_mut(key) {
            strip_blocks(child);
        }
    }
}

// ─── Cloud sampler extensions (the private `ryu_sampling` body field) ────────

/// Private body field carrying non-standard samplers (`top_k`, `min_p`,
/// `repeat_penalty`) from Core to the gateway. Same convention as
/// `ryu_smart_route` and [`ANTHROPIC_BETA_FIELD`]; the Core-side writer is
/// `ryu_engines::GATEWAY_SAMPLING_FIELD`.
pub(crate) const SAMPLING_EXTENSIONS_FIELD: &str = "ryu_sampling";

/// The extensions `provider` accepts, as `(canonical, wire)` key pairs.
/// Allowlist direction, like the beta strip: an unknown provider gets none, so a
/// strict OpenAI-compatible endpoint never sees a sampler it would reject.
pub(super) fn sampling_extension_keys(provider: &str) -> &'static [(&'static str, &'static str)] {
    if speaks_anthropic_dialect(provider) {
        return &[("top_k", "top_k")];
    }
    match provider {
        // SDK providers whose genai adapter maps `top_k` onto the native API
        // (Gemini `topK`, Cohere `k`, Anthropic / Vertex `top_k`).
        "genai" | "genai-anthropic" | "genai-cohere" | "genai-vertex" => &[("top_k", "top_k")],
        "openrouter" => &[
            ("top_k", "top_k"),
            ("min_p", "min_p"),
            ("repeat_penalty", "repetition_penalty"),
        ],
        // llama.cpp-class servers behind the local provider read these verbatim.
        "local" => &[
            ("top_k", "top_k"),
            ("min_p", "min_p"),
            ("repeat_penalty", "repeat_penalty"),
        ],
        _ => &[],
    }
}

/// The request's sampler extensions, removed from the body once at intake and
/// re-applied per provider attempt. The body is shared across fallback
/// attempts, so each attempt first removes what the previous one inserted.
#[derive(Default)]
pub(super) struct SamplingExtensions {
    pub(super) values: serde_json::Map<String, Value>,
    pub(super) applied: Vec<&'static str>,
}

impl SamplingExtensions {
    pub(super) fn take(body: &mut Value) -> Self {
        let values = body
            .as_object_mut()
            .and_then(|object| object.remove(SAMPLING_EXTENSIONS_FIELD))
            .and_then(|value| match value {
                Value::Object(values) => Some(values),
                _ => None,
            })
            .unwrap_or_default();
        Self {
            values,
            applied: Vec::new(),
        }
    }

    pub(super) fn apply_for(&mut self, body: &mut Value, provider: &str) {
        let Some(object) = body.as_object_mut() else {
            return;
        };
        for key in self.applied.drain(..) {
            object.remove(key);
        }
        for (canonical, wire) in sampling_extension_keys(provider) {
            if let Some(value) = self.values.get(*canonical) {
                object.insert((*wire).to_owned(), value.clone());
                self.applied.push(wire);
            }
        }
    }
}

/// Stamp Ryu's upstream identity for one provider attempt (see
/// [`crate::identity::stamp_upstream_identity`]). Per attempt, because the
/// body is shared across fallback attempts and each provider reads its own
/// field.
pub(super) fn stamp_upstream_identity(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    provider: &str,
    surface: crate::identity::UpstreamSurface,
) -> crate::identity::StampOutcome {
    crate::identity::stamp_upstream_identity(
        body,
        provider,
        surface,
        state.custody,
        ctx.identity.as_deref(),
    )
}

/// Add node-saved OpenRouter defaults for one provider attempt, retaining the
/// original `provider` field so a later Gateway fallback cannot inherit them.
pub(super) fn apply_node_openrouter_preferences(
    state: &AppState,
    ctx: &RequestContext,
    provider_name: &str,
    body: &mut Value,
    include_model_fallbacks: bool,
) -> (Option<Value>, Option<Value>) {
    if provider_name == "litellm" {
        strip_litellm_routing_overrides(body);
        return (None, None);
    }
    if provider_name != "openrouter" {
        return (None, None);
    }
    let original_provider = body.get("provider").cloned();
    let original_models = body.get("models").cloned();
    node_routing::apply_openrouter_preferences(
        ctx.openrouter_routing_enabled,
        ctx.node_routing.as_ref(),
        &state.config.node_routing,
        provider_name,
        body,
    );
    if include_model_fallbacks {
        node_routing::apply_openrouter_model_fallbacks(
            ctx.openrouter_routing_enabled,
            ctx.node_routing.as_ref(),
            &state.config.node_routing,
            provider_name,
            body,
        );
    }
    // Both explicit request models and node defaults reach the same provider sink.
    let policy = ctx
        .resolved_policy
        .clone()
        .unwrap_or_else(|| state.policy_snapshot());
    if let Some(models) = body.get_mut("models").and_then(Value::as_array_mut) {
        models.retain(|model| {
            model.as_str().is_some_and(|model| {
                (ctx.is_master_key || policy.allows_model(model))
                    && crate::enforcement::keeps_fallback_model(state, ctx, model)
            })
        });
        if models.is_empty() {
            body.as_object_mut().unwrap().remove("models");
        }
    } else if let Some(body) = body.as_object_mut() {
        body.remove("models");
    }
    (original_provider, original_models)
}

/// Request fields that make a LiteLLM proxy serve a model other than the one
/// the Gateway authorized and priced (client-side fallbacks, test-forced
/// fallbacks, per-request deployment config). Fallbacks the operator configures
/// in LiteLLM itself still apply; only caller-supplied overrides are removed,
/// because the Gateway's model allowlist and budget see the requested model only.
pub(super) const LITELLM_ROUTING_OVERRIDES: &[&str] = &[
    "fallbacks",
    "context_window_fallbacks",
    "content_policy_fallbacks",
    "mock_testing_fallbacks",
    "mock_testing_context_fallbacks",
    "mock_testing_content_policy_fallbacks",
    "user_config",
];

pub(super) fn strip_litellm_routing_overrides(body: &mut Value) {
    if let Some(body) = body.as_object_mut() {
        for field in LITELLM_ROUTING_OVERRIDES {
            body.remove(*field);
        }
    }
}

/// Restore the caller's original provider options after the OpenRouter attempt.
pub(super) fn restore_node_openrouter_preferences(
    provider_name: &str,
    body: &mut Value,
    original_provider: Option<Value>,
    original_models: Option<Value>,
) {
    if provider_name != "openrouter" {
        return;
    }
    let Some(body) = body.as_object_mut() else {
        return;
    };
    match original_provider {
        Some(provider) => {
            body.insert("provider".to_owned(), provider);
        }
        None => {
            body.remove("provider");
        }
    }
    match original_models {
        Some(models) => {
            body.insert("models".to_owned(), models);
        }
        None => {
            body.remove("models");
        }
    }
}

// ─── Pre-process (shared by run + run_stream) ─────────────────────────────────

/// Resolve the node's prompt-cache policy against this request and stamp the
/// resulting markers onto the outgoing payload.
///
/// Called immediately before provider dispatch — after routing has picked the
/// model (the marker dialect depends on it) and after any budget/firewall stage
/// that could still rewrite `messages`, so the breakpoints land on the bytes
/// that are actually sent.
///
/// The per-request headers are dropped when the node sets
/// `allow_request_override = false`, which is the whole point of that switch:
/// an operator running a fixed cost profile must be able to make config the only
/// lever. See [`ryu_gw_providers::prompt_cache`] for precedence and wire formats.
/// The per-request prompt-cache override this node is willing to honour.
///
/// Split out from [`apply_prompt_cache`] so the "operator can lock the node"
/// rule is testable without standing up an `AppState`: with
/// `allow_request_override = false` the client headers are dropped entirely and
/// config becomes the only lever.
pub(super) fn resolve_prompt_cache_override(
    cfg: &crate::config::PromptCacheConfig,
    ctx: &RequestContext,
) -> (Option<ryu_gw_providers::PromptCacheMode>, Option<String>) {
    if cfg.allow_request_override {
        (ctx.prompt_cache_mode, ctx.prompt_cache_ttl.clone())
    } else {
        (None, None)
    }
}

pub(super) fn apply_prompt_cache(
    state: &AppState,
    ctx: &RequestContext,
    model: &str,
    body: &mut Value,
) -> ryu_gw_providers::PromptCacheOutcome {
    let cfg = &state.config.prompt_cache;
    let (override_mode, override_ttl) = resolve_prompt_cache_override(cfg, ctx);
    let estimated = estimate_prompt_tokens(body);
    let outcome = cfg.options().apply(
        body,
        &ryu_gw_providers::PromptCacheRequest {
            model,
            override_mode,
            override_ttl,
            estimated_input_tokens: Some(estimated),
            session_id: ctx.session_id.as_deref(),
        },
    );
    debug!(
        request_id = %ctx.request_id,
        model,
        estimated_prompt_tokens = estimated,
        outcome = outcome.as_str(),
        "prompt cache"
    );
    outcome
}
