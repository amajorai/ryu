//! Provider wiring: the `ProviderRegistry` + config-driven registration + key
//! custody. The concrete provider implementations, the `Provider` trait, the
//! shared provider HTTP helpers, the quota sink, and the video-job value types
//! live in the `ryu-gw-providers` crate (decomposition W6). This module keeps
//! only the "wiring" â€” the registry that reads `ProvidersConfig`, holds the
//! provider keys, and constructs each built-in â€” so a new provider is a drop-in
//! (register a new id) with no enum/struct edit. Re-exported here so existing
//! `crate::providers::{Provider, ProviderRegistry}` paths are byte-unchanged.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::config::{
    ProvidersConfig, ANTHROPIC_CREDITS_PROVIDER_ID, BEDROCK_PROVIDER_ID, CLOUDFLARE_PROVIDER_ID,
    OPENAI_CREDITS_PROVIDER_ID, VERTEX_PROVIDER_ID,
};
use crate::quota::ProviderQuotas;

mod runtime;
pub(crate) use runtime::ProviderInputs;
pub use runtime::{BoundRoute, BoundWebRoute, ProviderEpoch, ProviderRuntime, ProviderSnapshot};

pub use ryu_gw_providers::{
    AnthropicProvider, AssemblyAiProvider, BatchProvider, BflProvider, CohereProvider,
    CoreProvider, DeepgramProvider, ElevenLabsProvider, FalProvider, GenAiProvider,
    GoogleTtsAccount, GoogleTtsProvider, InworldProvider, LocalProvider, MiniMaxProvider,
    ModalProvider, OpenAiProvider, OpenRouterOptions, OpenRouterProvider, PollyAccount,
    PollyProvider, Provider, QwenProvider, RecraftProvider, ReplicateProvider, RunwayProvider,
    StabilityProvider, TopazProvider,
};

/// A provider re-exposed under a registry id that differs from its own
/// [`Provider::name`].
///
/// Needed because one impl can back two registry slots: the classify tier speaks
/// the same OpenAI-compatible dialect as the resident local engine and so reuses
/// [`LocalProvider`], whose `name()` is the hardcoded `"local"`. Registering that
/// instance by name would *replace* the chat engine outright â€” and even keyed
/// correctly, the pipeline attributes metrics, admission slots and circuit-breaker
/// state by `provider.name()` (`pipeline/mod.rs`), so a bare alias would book a
/// classify-sidecar failure against `local` and trip the breaker on the user's
/// chat model. Overriding `name()` keeps the two tiers isolated end to end.
///
/// Every other trait method forwards verbatim, including the ones with default
/// bodies: those defaults are phrased in terms of `self.name()`, so forwarding
/// (rather than inheriting) keeps the inner provider's real capabilities and its
/// own error wording intact.
struct AliasedProvider {
    id: &'static str,
    inner: Arc<dyn Provider>,
}

impl Provider for AliasedProvider {
    fn configure_account_policies(&self, policies: &[ryu_gw_providers::ProviderAccountPolicy]) {
        self.inner.configure_account_policies(policies);
    }

    fn configure_account_strategy(&self, strategy: ryu_gw_providers::AccountSelectionStrategy) {
        self.inner.configure_account_strategy(strategy);
    }

    fn configure_fill_first_drain_percent(&self, percent: u8) {
        self.inner.configure_fill_first_drain_percent(percent);
    }

    fn name(&self) -> &'static str {
        self.id
    }

    fn has_rotating_accounts(&self) -> bool {
        self.inner.has_rotating_accounts()
    }

    fn discover_models<'a>(
        &'a self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Option<Vec<serde_json::Value>>> + Send + 'a>,
    > {
        self.inner.discover_models()
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.complete(model, body)
    }

    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
        session: Option<&'a str>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.complete_for_session(model, body, session)
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.complete_stream(model, body)
    }

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
        session: Option<&'a str>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.complete_stream_for_session(model, body, session)
    }

    fn embed<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.embed(model, body)
    }

    fn rerank<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.rerank(model, body)
    }

    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.generate_image(model, body)
    }

    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.synthesize_speech(model, body)
    }

    fn transcribe_audio<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.transcribe_audio(model, body)
    }

    fn submit_video_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        ryu_gw_providers::AcceptedVideo,
                        ryu_gw_providers::ProviderError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        self.inner.submit_video_bound(model, body)
    }

    fn submit_media_job_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
        kind: ryu_gw_providers::MediaJobKind,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        ryu_gw_providers::AcceptedMediaJob,
                        ryu_gw_providers::ProviderError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        // Forward explicitly: the trait default would answer audio with a
        // refusal on behalf of this wrapper instead of asking the provider.
        self.inner.submit_media_job_bound(model, body, kind)
    }
}

/// Dynamic, id-keyed provider registry.
///
/// Dispatch is by stable string id (not a closed enum): every provider
/// registers itself under its own [`Provider::name`] and lookups go through the
/// map, so a new provider â€” including an out-of-process / plugin provider â€” can
/// be added by registering a new id without touching any closed enum. This is
/// the gateway-side analogue of Core's `RunnableRegistry`.
///
/// The `order` vector preserves deterministic registration/iteration order
/// (`available_providers`, and thus the model-discovery merge precedence in
/// `/v1/models`, are order-sensitive). Construction of a provider that lacks its
/// key is skipped entirely, so its id is simply absent from the map â€” exactly
/// the old `Option::None` behavior.
pub struct ProviderRegistry {
    account_ids: HashMap<String, Vec<String>>,
    account_policies: ryu_gw_credentials::ProviderAccountPolicies,
    providers: HashMap<String, Arc<dyn Provider>>,
    batch_providers: HashMap<String, Arc<dyn BatchProvider>>,
    order: Vec<String>,
    /// Verified routing-region metadata. Unknown/plugin providers intentionally
    /// have no entry so an effective allowed-regions policy fails closed.
    regions: HashMap<String, String>,
    activation_errors: HashMap<String, String>,
    /// The custody this registry was built for. A config reload rebuilds the
    /// registry with the same custody, which never changes inside a process.
    custody: crate::custody::GatewayCustody,
}

impl ProviderRegistry {
    #[cfg(test)]
    pub(crate) fn clone_for_test(&self) -> Self {
        Self {
            account_ids: self.account_ids.clone(),
            account_policies: self.account_policies.clone(),
            providers: self.providers.clone(),
            batch_providers: self.batch_providers.clone(),
            order: self.order.clone(),
            regions: self.regions.clone(),
            activation_errors: self.activation_errors.clone(),
            custody: self.custody,
        }
    }

    pub fn new(config: &ProvidersConfig, quota: Arc<ProviderQuotas>) -> Self {
        Self::build(config, None, quota)
    }

    pub fn new_with_egress(
        config: &ProvidersConfig,
        egress: &crate::egress::EgressPools,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self::build(config, Some(egress), quota)
    }

    /// Without an explicit custody a registry is built as self-hosted, so
    /// every fleet-only slot (the Vercel lane) stays off.
    fn build(
        config: &ProvidersConfig,
        egress: Option<&crate::egress::EgressPools>,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self::build_with_environment(
            config,
            egress,
            quota,
            &sdk_environment(),
            crate::custody::GatewayCustody::SelfHosted,
        )
    }

    pub(crate) fn build_with_environment(
        config: &ProvidersConfig,
        egress: Option<&crate::egress::EgressPools>,
        quota: Arc<ProviderQuotas>,
        environment: &std::collections::BTreeMap<String, String>,
        custody: crate::custody::GatewayCustody,
    ) -> Self {
        let client = build_client();
        let mut registry = Self {
            account_ids: HashMap::new(),
            account_policies: config.account_policies.clone(),
            providers: HashMap::new(),
            batch_providers: HashMap::new(),
            order: Vec::new(),
            regions: provider_regions(config),
            activation_errors: HashMap::new(),
            custody,
        };

        // Register built-ins in the same deterministic order as before so
        // `available_providers()` iteration (and the /v1/models discovery merge
        // that depends on it) is byte-for-byte identical. A provider whose config
        // is absent is not constructed, so its id never enters the map.
        if let Some(c) = config.openai.as_ref() {
            registry.register(Arc::new(OpenAiProvider::new_with_egress(
                client.clone(),
                egress.and_then(|pool| pool.assigned("openai")),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )));
        }

        if let Some(c) = config.anthropic.as_ref() {
            registry.register(Arc::new(AnthropicProvider::new_with_egress(
                client.clone(),
                egress.and_then(|pool| pool.assigned("anthropic")),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )));
        }

        if let Some(c) = config.local.as_ref() {
            registry.register(Arc::new(
                LocalProvider::new(client.clone(), c.base_url.clone())
                    .with_model_routes(c.model_routes.clone()),
            ));
        }

        if let Some(c) = config.openrouter.as_ref() {
            let options = OpenRouterOptions {
                data_collection: (!c.data_collection.is_empty()).then(|| c.data_collection.clone()),
                zdr: c.zdr.then_some(true),
                sort: (!c.sort.is_empty()).then(|| c.sort.clone()),
                response_healing: c.response_healing,
                usage_accounting: c.usage_accounting,
            };
            let provider = Arc::new(OpenRouterProvider::new_with_egress(
                client.clone(),
                egress.and_then(|pool| pool.assigned("openrouter")),
                c.all_keys(),
                c.base_url.clone(),
                c.site_url.clone(),
                c.site_name.clone(),
                options,
                Arc::clone(&quota),
            ));
            registry.register_batch_provider("openrouter", provider.clone());
            registry.register(provider);
        }

        if let Some(c) = config.litellm.as_ref() {
            // A LiteLLM proxy speaks the OpenAI dialect and holds its own upstream
            // credentials, so the OpenAI adapter under the `litellm` id is the
            // whole integration. Routing to it is the routing layer's job
            // (`backends.router = "litellm"`) or an explicit `model_map` entry.
            registry.register_as(
                "litellm",
                Arc::new(OpenAiProvider::new_named_with_egress(
                    "litellm",
                    client.clone(),
                    egress.and_then(|pool| pool.assigned("litellm")),
                    c.all_keys(),
                    c.base_url.clone(),
                    Arc::clone(&quota),
                )),
            );
        }

        if let Some(c) = config.core.as_ref() {
            registry.register(Arc::new(CoreProvider::new(
                client.clone(),
                c.base_url.clone(),
                c.token.clone(),
            )));
            // OAuth remains sealed in Core. Gateway holds only its existing local relay token.
            match CoreProvider::kiro_proxy(
                client.clone(),
                format!("{}/api/pi-config/kiro/v1", c.base_url.trim_end_matches('/')),
                c.token.clone(),
            ) {
                Ok(provider) => registry.register(Arc::new(provider)),
                Err(_) => {
                    registry.activation_errors.insert(
                        "kiro".to_owned(),
                        "Kiro requires an authenticated local Core relay".to_owned(),
                    );
                }
            }
        }

        if let Some(c) = config
            .modal
            .as_ref()
            .filter(|config| !config.all_keys().is_empty())
        {
            registry.register(Arc::new(ModalProvider::new_with_egress(
                client.clone(),
                egress.and_then(|pool| pool.assigned("modal")),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )));
        }

        if let Some(c) = config.genai.as_ref() {
            for descriptor in ryu_gw_credentials::SDK_PROVIDERS {
                let Some(account) = c.accounts.get(descriptor.kind) else {
                    continue;
                };
                let resolved = match c.resolve_keys(descriptor.kind, &environment) {
                    Ok(keys) => keys,
                    Err(_) => {
                        registry.activation_errors.insert(
                            descriptor.provider_id.to_owned(),
                            "Invalid SDK account configuration".to_owned(),
                        );
                        continue;
                    }
                };
                if let Some(diagnostic) = account.activation_diagnostic(descriptor.kind) {
                    registry
                        .activation_errors
                        .insert(descriptor.provider_id.to_owned(), diagnostic);
                    continue;
                }
                let keys: Vec<_> = resolved.into_iter().map(|entry| entry.key).collect();
                if keys.is_empty()
                    && descriptor.auth_kind != ryu_gw_credentials::SdkAuthKind::NoAuth
                {
                    continue;
                }
                match GenAiProvider::new_for_kind(
                    descriptor,
                    keys.clone(),
                    account.context.clone(),
                    client.clone(),
                    egress.and_then(|pool| pool.assigned(descriptor.provider_id)),
                    Arc::clone(&quota),
                ) {
                    Ok(provider) => {
                        registry.account_ids.insert(
                            descriptor.account_scope.to_owned(),
                            keys.iter()
                                .map(|key| {
                                    ryu_gw_credentials::provider_account_id(
                                        descriptor.account_scope,
                                        key,
                                    )
                                })
                                .collect(),
                        );
                        registry.register(Arc::new(provider));
                    }
                    Err(_) => {
                        registry.activation_errors.insert(
                            descriptor.provider_id.to_owned(),
                            "SDK provider activation failed".to_owned(),
                        );
                    }
                }
            }
        }

        if let Some(config) = config.cohere.as_ref() {
            registry.register(Arc::new(CohereProvider::new_with_egress(
                client.clone(),
                egress.and_then(|pool| pool.assigned("cohere")),
                config.all_keys(),
                config.base_url.clone(),
                Arc::clone(&quota),
            )));
        }

        if let Some(config) = config.deepgram.as_ref() {
            registry.register(Arc::new(DeepgramProvider::new_with_egress(
                client.clone(),
                egress.and_then(|pool| pool.assigned("deepgram")),
                config.all_keys(),
                config.base_url.clone(),
                Arc::clone(&quota),
            )));
        }

        if let Some(config) = config.assemblyai.as_ref() {
            registry.register(Arc::new(AssemblyAiProvider::new_with_egress(
                client.clone(),
                egress.and_then(|pool| pool.assigned("assemblyai")),
                config.all_keys(),
                config.base_url.clone(),
                config.poll_interval_ms,
                config.poll_timeout_secs,
                Arc::clone(&quota),
            )));
        }

        if let Some(config) = config.elevenlabs.as_ref() {
            registry.register(Arc::new(ElevenLabsProvider::new_with_egress(
                client.clone(),
                egress.and_then(|pool| pool.assigned("elevenlabs")),
                config.all_keys(),
                config.base_url.clone(),
                Arc::clone(&quota),
            )));
        }

        if let Some(config) = config.inworld.as_ref() {
            registry.register(Arc::new(InworldProvider::new_with_egress(
                client.clone(),
                egress.and_then(|pool| pool.assigned("inworld")),
                config.all_keys(),
                config.base_url.clone(),
                Arc::clone(&quota),
            )));
        }

        if let Some(c) = config.replicate.as_ref() {
            registry.register(Arc::new(ReplicateProvider::new_with_accounts(
                client.clone(),
                egress.and_then(|pool| pool.assigned("replicate")),
                c.all_keys(),
                c.base_url.clone(),
                c.poll_interval_ms,
                c.poll_timeout_secs,
            )));
        }

        if let Some(c) = config.bfl.as_ref() {
            registry.register(Arc::new(BflProvider::new(
                client.clone(),
                egress.and_then(|pool| pool.assigned("bfl")),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
                c.poll_interval_ms,
                c.poll_timeout_secs,
            )));
        }
        if let Some(c) = config.stability.as_ref() {
            registry.register(Arc::new(StabilityProvider::new(
                client.clone(),
                egress.and_then(|pool| pool.assigned("stability")),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )));
        }
        if let Some(c) = config.runway.as_ref() {
            registry.register(Arc::new(RunwayProvider::new(
                client.clone(),
                egress.and_then(|pool| pool.assigned("runway")),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )));
        }
        if let Some(c) = config.topaz.as_ref() {
            registry.register(Arc::new(TopazProvider::new(
                client.clone(),
                egress.and_then(|pool| pool.assigned("topaz")),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )));
        }
        if let Some(c) = config.minimax.as_ref() {
            registry.register(Arc::new(MiniMaxProvider::new(
                client.clone(),
                egress.and_then(|pool| pool.assigned("minimax")),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )));
        }
        if let Some(c) = config.recraft.as_ref() {
            registry.register(Arc::new(RecraftProvider::new(
                client.clone(),
                egress.and_then(|pool| pool.assigned("recraft")),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )));
        }
        if let Some(c) = config.fal.as_ref() {
            registry.register(Arc::new(FalProvider::new_with_accounts(
                client.clone(),
                egress.and_then(|pool| pool.assigned("fal")),
                c.all_keys(),
                c.base_url.clone(),
                c.poll_interval_ms,
                c.poll_timeout_secs,
            )));
        }

        // The classify tier, registered LAST on purpose: `available_providers()`
        // order drives the `/v1/models` discovery merge precedence, so appending
        // leaves every existing provider's precedence byte-identical. It speaks
        // the same OpenAI-compatible dialect as `local`, so it reuses
        // [`LocalProvider`] â€” aliased to the `"classify"` id so the two tiers
        // never share metrics, admission slots or circuit-breaker state (see
        // [`AliasedProvider`]).
        //
        // GRACEFUL DEGRADE, but read the shape carefully â€” an earlier version of
        // this comment claimed "on most nodes there is no `RYU_CLASSIFY_LLM_URL`",
        // which is backwards and misled three units:
        //
        // * The sidecar PROCESS is lazy (absent from Core's `startup_order`), but
        //   Core publishes `RYU_CLASSIFY_LLM_URL` UNCONDITIONALLY in
        //   `gateway_spawn_env` â€” it deliberately does not gate the URL on the
        //   sidecar being installed or running. So on every Core-spawned gateway
        //   this slot is `Some` and `classify` IS registered.
        // * `get("classify") == None` therefore means "standalone gateway with no
        //   published URL" â€” only there does `firewall/inspector.rs` take the
        //   absent-provider branch and `warn!` naming the provider + model.
        // * On a real node a COLD tier is `Some(slot)` + connection refused, so it
        //   surfaces as `provider.complete` â†’ `ProviderError`, NOT as an absent
        //   provider. That arm used to log the same "provider call failed" line an
        //   upstream 500 does; `firewall/inspector.rs::provider_failure_message` now
        //   branches on this id and says the local tier is not running instead. The
        //   branch lives there because that is where the routed decision is known â€”
        //   keep the two in sync through `config::CLASSIFY_PROVIDER_ID`, never a
        //   second `"classify"` literal.
        //
        // Either way the guardrail fails open, which is the deliberate posture for
        // something that must never hard-fail a turn. Do not "fix" the absent slot
        // into a startup error.
        if let Some(c) = config.classify.as_ref() {
            registry.register_as(
                crate::config::CLASSIFY_PROVIDER_ID,
                Arc::new(LocalProvider::new(client.clone(), c.base_url.clone())),
            );
        }

        // The SEGREGATED credit-pool supplies (see [`crate::credit_pools`]).
        // Registered AFTER `classify` for the same reason `classify` is last:
        // `available_providers()` order drives the /v1/models discovery-merge
        // precedence, so appending leaves every existing provider's precedence
        // byte-identical. Both are absent-when-unconfigured like every other
        // built-in â€” an untagged deploy simply lacks the id.
        //
        // KNOWN, DELIBERATE ALIAS DEFECT: `AliasedProvider` overrides `name()`
        // for the pipeline's keying (metrics, admission slots, circuit breaker),
        // but the quota sink is written from a literal INSIDE each impl
        // (`openai.rs` records `"openai"`, `anthropic.rs` records `"anthropic"`).
        // So an aliased Cloudflare 429 books against `openai` and an aliased
        // Bedrock 429 against `anthropic` in `/metrics.provider_quota`. Nothing
        // routes on that snapshot today, so this is observability, not
        // correctness â€” but "which pool is rate-limited" is exactly the signal a
        // segregated-pool operator will eventually want, and closing it means
        // threading a label parameter through `ryu-gw-providers`.
        if let Some(c) = config.cloudflare.as_ref() {
            // Cloudflare Workers AI exposes an OpenAI-compatible surface at
            // `{account}/ai/v1/chat/completions` with bearer auth â€” byte-for-byte
            // what `OpenAiProvider` already sends, so it needs no impl.
            registry.register_as(
                CLOUDFLARE_PROVIDER_ID,
                Arc::new(OpenAiProvider::new_named_with_egress(
                    CLOUDFLARE_PROVIDER_ID,
                    client.clone(),
                    egress.and_then(|pool| pool.assigned(CLOUDFLARE_PROVIDER_ID)),
                    c.all_keys(),
                    c.base_url.clone(),
                    Arc::clone(&quota),
                )),
            );
        }

        if let Some(c) = config.bedrock.as_ref() {
            // Bedrock rides ANTHROPIC MESSAGES, not the OpenAI dialect, and this
            // is not a style preference: Bedrock does serve
            // `/v1/chat/completions`, but its per-model compatibility matrix
            // marks Chat Completions unsupported for EVERY Claude model (that
            // surface exists for `openai.gpt-oss-*`). Claude there is
            // Invoke/Converse/Messages only. `AnthropicProvider` already sends
            // `{base}/v1/messages` with `anthropic-version: 2023-06-01` and the
            // model id in the body, which is exactly Bedrock's Messages contract.
            // Do NOT "simplify" both pools onto one OpenAI-compatible alias.
            registry.register_as(
                BEDROCK_PROVIDER_ID,
                Arc::new(AnthropicProvider::new_named_with_egress(
                    BEDROCK_PROVIDER_ID,
                    client.clone(),
                    egress.and_then(|pool| pool.assigned(BEDROCK_PROVIDER_ID)),
                    c.all_keys(),
                    c.base_url.clone(),
                    Arc::clone(&quota),
                )),
            );
        }

        if let Some(c) = config.vertex.as_ref() {
            // Vertex AI serves an OpenAI-compatible Chat Completions surface at
            // `{project/location endpoint}/openapi/chat/completions` with bearer
            // auth, so â€” unlike Bedrock â€” it genuinely needs no impl of its own.
            // The base URL stops at `/endpoints/openapi`; `OpenAiProvider`
            // appends `/chat/completions`.
            registry.register_as(
                VERTEX_PROVIDER_ID,
                Arc::new(OpenAiProvider::new_named_with_egress(
                    VERTEX_PROVIDER_ID,
                    client.clone(),
                    egress.and_then(|pool| pool.assigned(VERTEX_PROVIDER_ID)),
                    c.all_keys(),
                    c.base_url.clone(),
                    Arc::clone(&quota),
                )),
            );
        }

        if let Some(c) = config.openai_credits.as_ref() {
            // Same impl and the same endpoint as the `openai` slot above â€” the
            // ONLY thing that differs is whose key it holds, and that is precisely
            // why it must be its own registry id. `AliasedProvider` is what keeps
            // them apart. The named adapter also keeps account quota/error
            // attribution separate from the BYOK OpenAI slot.
            registry.register_as(
                OPENAI_CREDITS_PROVIDER_ID,
                Arc::new(OpenAiProvider::new_named_with_egress(
                    OPENAI_CREDITS_PROVIDER_ID,
                    client.clone(),
                    egress.and_then(|pool| pool.assigned(OPENAI_CREDITS_PROVIDER_ID)),
                    c.all_keys(),
                    c.base_url.clone(),
                    Arc::clone(&quota),
                )),
            );
        }

        if let Some(c) = config.anthropic_credits.as_ref() {
            // Ryu's own Anthropic account: same impl and endpoint as the BYOK
            // `anthropic` slot, registered under its own id so the debit site can
            // attribute its spend to the `anthropic-credits` pool.
            registry.register_as(
                ANTHROPIC_CREDITS_PROVIDER_ID,
                Arc::new(AnthropicProvider::new_named_with_egress(
                    ANTHROPIC_CREDITS_PROVIDER_ID,
                    client.clone(),
                    egress.and_then(|pool| pool.assigned(ANTHROPIC_CREDITS_PROVIDER_ID)),
                    c.all_keys(),
                    c.base_url.clone(),
                    Arc::clone(&quota),
                )),
            );
        }

        for (id, _) in ryu_gw_credentials::DIRECT_COMPATIBLE_PROVIDERS {
            if let Some(config) = config.compatible.get(*id) {
                if *id == "qwen" {
                    registry.register(Arc::new(QwenProvider::new(
                        client.clone(),
                        egress.and_then(|pool| pool.assigned("qwen")),
                        config.all_keys(),
                        config.base_url.clone(),
                        Arc::clone(&quota),
                    )));
                    continue;
                }
                registry.register_as(
                    id,
                    Arc::new(OpenAiProvider::new_named_with_egress(
                        id,
                        client.clone(),
                        egress.and_then(|pool| pool.assigned(id)),
                        config.all_keys(),
                        config.base_url.clone(),
                        Arc::clone(&quota),
                    )),
                );
            }
        }

        if config
            .edge_tts
            .as_ref()
            .is_some_and(|settings| settings.anonymous_consumer_opt_in)
        {
            match ryu_gw_providers::EdgeTtsProvider::new(
                true,
                egress.and_then(|pools| pools.assigned("edge-tts")),
                Arc::clone(&quota),
            ) {
                Ok(provider) => registry.register(Arc::new(provider)),
                Err(_) => {
                    registry.activation_errors.insert(
                        "edge-tts".to_owned(),
                        "Edge consumer TTS activation failed".to_owned(),
                    );
                }
            }
        }

        if config
            .google_translate_tts
            .as_ref()
            .is_some_and(|settings| settings.anonymous_consumer_opt_in)
        {
            match ryu_gw_providers::GoogleTranslateTtsProvider::new(
                true,
                client.clone(),
                egress.and_then(|pools| pools.assigned("google-translate-tts")),
            ) {
                Ok(provider) => registry.register(Arc::new(provider)),
                Err(_) => {
                    registry.activation_errors.insert(
                        "google-translate-tts".to_owned(),
                        "Google Translate consumer TTS activation failed".to_owned(),
                    );
                }
            }
        }

        if let Some(settings) = config.google_tts.as_ref() {
            let accounts = settings
                .accounts
                .iter()
                .map(|row| {
                    GoogleTtsAccount::supplied_oauth(
                        row.access_token.clone(),
                        row.quota_project.clone(),
                        row.expires_at_unix_secs,
                    )
                })
                .collect::<Result<Vec<_>, _>>();
            let result = accounts.and_then(|accounts| {
                let ids = accounts
                    .iter()
                    .map(|row| row.account_id().to_owned())
                    .collect::<Vec<_>>();
                let policies = ids
                    .iter()
                    .map(|id| {
                        config
                            .account_policies
                            .get("google-tts")
                            .and_then(|rows| rows.get(id))
                            .cloned()
                            .unwrap_or_default()
                    })
                    .collect::<Vec<_>>();
                GoogleTtsProvider::new(
                    accounts,
                    &policies,
                    egress.and_then(|pools| pools.assigned("google-tts")),
                    Arc::clone(&quota),
                )
                .map(|provider| (provider, ids))
            });
            match result {
                Ok((provider, ids)) => {
                    registry.account_ids.insert("google-tts".to_owned(), ids);
                    registry.register(Arc::new(provider));
                }
                Err(_) => {
                    registry.activation_errors.insert(
                        "google-tts".to_owned(),
                        "Google TTS account activation failed".to_owned(),
                    );
                }
            }
        }
        if let Some(settings) = config.polly.as_ref() {
            let accounts = settings
                .accounts
                .iter()
                .map(|row| {
                    PollyAccount::explicit(
                        row.access_key_id.clone(),
                        row.secret_access_key.clone(),
                        row.session_token.clone(),
                        row.expires_at_unix_secs,
                    )
                })
                .collect::<Result<Vec<_>, _>>();
            let result = accounts.and_then(|accounts| {
                let ids = accounts
                    .iter()
                    .map(|row| row.account_id(&settings.region))
                    .collect::<Result<Vec<_>, _>>()?;
                let policies = ids
                    .iter()
                    .map(|id| {
                        config
                            .account_policies
                            .get("polly")
                            .and_then(|rows| rows.get(id))
                            .cloned()
                            .unwrap_or_default()
                    })
                    .collect::<Vec<_>>();
                PollyProvider::new(
                    settings.region.clone(),
                    accounts,
                    &policies,
                    egress.and_then(|pools| pools.assigned("polly")),
                    Arc::clone(&quota),
                )
                .map(|provider| (provider, ids))
            });
            match result {
                Ok((provider, ids)) => {
                    registry.account_ids.insert("polly".to_owned(), ids);
                    registry.register(Arc::new(provider));
                }
                Err(_) => {
                    registry.activation_errors.insert(
                        "polly".to_owned(),
                        "Polly account activation failed".to_owned(),
                    );
                }
            }
        }

        for (kind, connection) in &config.web {
            let id = kind.descriptor().provider_id;
            let account_ids = connection
                .accounts()
                .iter()
                .map(|row| row.account_id(*kind))
                .collect::<Result<Vec<_>, _>>();
            let Ok(account_ids) = account_ids else {
                registry.activation_errors.insert(
                    id.to_owned(),
                    "Invalid web account configuration".to_owned(),
                );
                continue;
            };
            let policies = account_ids
                .iter()
                .map(|account| {
                    config
                        .account_policies
                        .get(id)
                        .and_then(|policies| policies.get(account))
                        .cloned()
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>();
            match ryu_gw_providers::web::WebServiceProvider::new(
                *kind,
                connection,
                &policies,
                egress.and_then(|pools| pools.assigned(id)),
                Arc::clone(&quota),
            ) {
                Ok(provider) => {
                    registry.account_ids.insert(id.to_owned(), account_ids);
                    registry.register(Arc::new(provider));
                }
                Err(_) => {
                    registry
                        .activation_errors
                        .insert(id.to_owned(), "Web provider activation failed".to_owned());
                }
            }
        }

        // The Vercel AI Gateway lane spends Ryu's Vercel credit on every attempt
        // (credential origin `ryu_fallback`), so it is registered only under a
        // recorded written resale permission (spec 08.2, 08.4) and only on a
        // hosted fleet replica, the one custody that replaces every caller
        // identifier with Ryu's subject. Otherwise the id stays out of the
        // registry and the reason is kept as its activation error. Appended
        // last so no existing precedence moves.
        if let Some(c) = config.vercel.as_ref() {
            register_vercel_lane(&mut registry, c, custody, &client, egress, &quota);
        }

        for (id, provider) in &registry.providers {
            let descriptor = ryu_gw_credentials::sdk_provider_by_id(id);
            let account_provider =
                descriptor.map_or(id.as_str(), |descriptor| descriptor.account_scope);
            let policies = if descriptor.is_some() {
                registry
                    .account_ids
                    .get(account_provider)
                    .into_iter()
                    .flatten()
                    .map(|id| {
                        config
                            .account_policies
                            .get(account_provider)
                            .and_then(|policies| policies.get(id))
                            .cloned()
                            .unwrap_or_default()
                    })
                    .collect()
            } else {
                config.policies_for(account_provider)
            };
            if !policies.is_empty() {
                provider.configure_account_policies(&policies);
                registry
                    .account_ids
                    .entry(account_provider.to_owned())
                    .or_insert_with(|| {
                        config
                            .account_keys(account_provider)
                            .iter()
                            .map(|key| {
                                ryu_gw_credentials::provider_account_id(account_provider, key)
                            })
                            .collect()
                    });
            }
            if let Some(strategy) = config.account_strategies.get(account_provider) {
                provider.configure_account_strategy(*strategy);
            }
            if let Some(percent) = config.account_drain_thresholds.get(account_provider) {
                provider.configure_fill_first_drain_percent(*percent);
            }
        }
        registry
    }

    pub fn account_policy_snapshot(&self) -> ryu_gw_credentials::ProviderAccountPolicies {
        self.account_policies.clone()
    }

    pub fn validate_account_policy_updates(
        &self,
        updates: &ryu_gw_credentials::ProviderAccountPolicies,
    ) -> Result<ryu_gw_credentials::ProviderAccountPolicies, String> {
        let count: usize = updates.values().map(HashMap::len).sum();
        if count == 0 || count > 128 {
            return Err("update between 1 and 128 provider accounts per request".to_owned());
        }
        let mut normalized = HashMap::new();
        for (provider, policies) in updates {
            let ids = self
                .account_ids
                .get(provider)
                .ok_or("provider has no active account configuration")?;
            let mut entries = HashMap::new();
            for (id, policy) in policies {
                if !ids.contains(id) {
                    return Err("account no longer exists; refresh the account list".to_owned());
                }
                entries.insert(id.clone(), policy.normalized()?);
            }
            normalized.insert(provider.clone(), entries);
        }
        Ok(normalized)
    }

    /// Register a provider under its own [`Provider::name`] id. Re-registering an
    /// existing id replaces the provider in place while preserving its position
    /// in the iteration order. This is the open extension point for provider
    /// plugins.
    pub fn register(&mut self, provider: Arc<dyn Provider>) {
        let id = provider.name();
        self.insert(id.to_string(), provider);
    }

    /// Register a provider under an **explicit** id instead of its own
    /// [`Provider::name`], for the case where one impl backs two slots (the
    /// classify tier reusing [`LocalProvider`]). The provider is wrapped so its
    /// `name()` reports `id` too â€” see [`AliasedProvider`] for why reporting the
    /// inner name would cross-contaminate the two tiers' metrics and breaker
    /// state. Replacement/order semantics match [`Self::register`].
    pub fn register_as(&mut self, id: &'static str, provider: Arc<dyn Provider>) {
        self.insert(
            id.to_string(),
            Arc::new(AliasedProvider {
                id,
                inner: provider,
            }),
        );
    }

    /// Shared insert: append the id on first registration (preserving iteration
    /// order), then replace in place.
    fn insert(&mut self, id: String, provider: Arc<dyn Provider>) {
        if !self.providers.contains_key(&id) {
            self.order.push(id.clone());
        }
        self.providers.insert(id, provider);
    }

    /// Resolve a provider by its stable string id (e.g. `"openai"`). Returns
    /// `None` for an id with no registered/constructable provider â€” the same
    /// "provider absent/unavailable" signal the old closed match produced.
    pub fn get(&self, id: &str) -> Option<&dyn Provider> {
        self.providers.get(id).map(|p| p.as_ref())
    }

    /// Resolve a provider's optional asynchronous batch capability.
    pub fn batch_provider(&self, id: &str) -> Option<&dyn BatchProvider> {
        self.batch_providers
            .get(id)
            .map(|provider| provider.as_ref())
    }

    /// Retain a batch capability from the captured provider generation through await.
    pub fn batch_provider_owned(&self, id: &str) -> Option<Arc<dyn BatchProvider>> {
        self.batch_providers.get(id).map(Arc::clone)
    }

    /// Register a separate capability without expanding the normal inference
    /// contract for providers that do not support batches.
    fn register_batch_provider(&mut self, id: &'static str, provider: Arc<dyn BatchProvider>) {
        self.batch_providers.insert(id.to_owned(), provider);
    }

    /// Owned resolution from a captured immutable snapshot.
    pub fn get_owned(&self, id: &str) -> Option<Arc<dyn Provider>> {
        self.providers.get(id).map(Arc::clone)
    }

    /// The ids of all registered providers, in deterministic registration order.
    pub fn available_providers(&self) -> Vec<String> {
        self.order.clone()
    }

    /// Bind aggregate SDK routes before governance; native owners are unchanged.
    pub fn canonicalize_sdk_route(&self, provider_id: &str, model: &str) -> Option<&'static str> {
        let owner = ryu_gw_providers::sdk_descriptor_for_model(model)?;
        if provider_id != "genai" && provider_id != owner.provider_id {
            return None;
        }
        self.providers
            .contains_key(owner.provider_id)
            .then_some(owner.provider_id)
    }

    pub fn activation_error(&self, provider_id: &str) -> Option<&str> {
        self.activation_errors.get(provider_id).map(String::as_str)
    }

    /// The custody this registry was built for. A reload reuses it.
    pub(crate) fn custody(&self) -> crate::custody::GatewayCustody {
        self.custody
    }

    /// How many accounts each account scope holds, for scopes that back at
    /// least one registered provider. Counts only: the account ids derive from
    /// key material and never leave the registry.
    pub(crate) fn account_counts(&self) -> std::collections::BTreeMap<String, usize> {
        self.account_ids
            .iter()
            .filter(|(scope, _)| {
                self.providers.keys().any(|id| {
                    ryu_gw_credentials::sdk_provider_by_id(id)
                        .map_or(id.as_str(), |descriptor| descriptor.account_scope)
                        == scope.as_str()
                })
            })
            .map(|(scope, ids)| (scope.clone(), ids.len()))
            .collect()
    }

    /// Return the verified region for a provider route. Global and local are
    /// explicit labels for providers whose endpoint is not geography-specific;
    /// Bedrock and Vertex require a region-bearing endpoint. A new provider id
    /// without metadata is deliberately unknown.
    pub fn region_for(&self, id: &str) -> Option<String> {
        if matches!(id, "edge-tts" | "google-translate-tts")
            || ryu_gw_credentials::web::web_provider_by_id(id).is_some()
        {
            return None;
        }
        if ryu_gw_credentials::sdk_provider_by_id(id).is_some() {
            return self.regions.get(id).cloned();
        }
        if id == "qwen" {
            return self.regions.get(id).cloned();
        }
        if ryu_gw_credentials::direct_compatible_provider_url(id).is_some() {
            return Some("global".to_owned());
        }
        self.regions.get(id).cloned().or_else(|| match id {
            "openai" | "anthropic" | "openrouter" | "modal" | "genai" | "cohere" | "deepgram"
            | "assemblyai" | "elevenlabs" | "inworld" | "replicate" | "fal" | "cloudflare"
            | "openai-credits" | "anthropic-credits" | "google-tts" => Some("global".to_string()),
            "local" | "classify" | "core" => Some("local".to_string()),
            _ => None,
        })
    }
}

fn provider_regions(config: &ProvidersConfig) -> HashMap<String, String> {
    let mut regions = HashMap::new();
    if let Some(polly) = config.polly.as_ref() {
        regions.insert("polly".to_owned(), polly.region.clone());
    }
    if let Some(config) = config.genai.as_ref() {
        for descriptor in ryu_gw_credentials::SDK_PROVIDERS {
            let Some(account) = config.accounts.get(descriptor.kind) else {
                continue;
            };
            let region = match &account.context {
                ryu_gw_credentials::SdkEndpointConfig::Default => Some("global".to_owned()),
                ryu_gw_credentials::SdkEndpointConfig::Vertex { location, .. } => {
                    Some(location.clone())
                }
                ryu_gw_credentials::SdkEndpointConfig::BedrockApi { region } => {
                    Some(region.clone())
                }
                ryu_gw_credentials::SdkEndpointConfig::Ollama { base_url } => {
                    reqwest::Url::parse(base_url)
                        .ok()
                        .filter(|url| {
                            url.host_str().is_some_and(|host| {
                                matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
                            })
                        })
                        .map(|_| "local".to_owned())
                }
            };
            if let Some(region) = region {
                regions.insert(descriptor.provider_id.to_owned(), region);
            }
        }
    }
    if let Some(provider) = config.compatible.get("qwen") {
        if let Some(region) = region_from_qwen_url(&provider.base_url) {
            regions.insert("qwen".to_owned(), region.to_owned());
        }
    }
    if let Some(provider) = &config.bedrock {
        if let Some(region) = region_from_bedrock_url(&provider.base_url) {
            regions.insert(BEDROCK_PROVIDER_ID.to_string(), region);
        }
    }
    if let Some(provider) = &config.vertex {
        if let Some(region) = region_from_vertex_url(&provider.base_url) {
            regions.insert(VERTEX_PROVIDER_ID.to_string(), region);
        }
    }
    regions
}

/// Read only explicitly declared SDK import variables; never expose their material.
pub(crate) fn sdk_environment() -> std::collections::BTreeMap<String, String> {
    ryu_gw_credentials::SDK_PROVIDERS
        .iter()
        .filter_map(|descriptor| descriptor.default_env)
        .filter_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| (name.to_owned(), value))
        })
        .collect()
}

fn region_from_qwen_url(base_url: &str) -> Option<&'static str> {
    let url = reqwest::Url::parse(base_url).ok()?;
    let host = url.host_str()?;
    for (region, legacy) in [
        ("ap-southeast-1", "dashscope-intl.aliyuncs.com"),
        ("cn-beijing", "dashscope.aliyuncs.com"),
        ("us-east-1", "dashscope-us.aliyuncs.com"),
        ("cn-hongkong", "cn-hongkong.dashscope.aliyuncs.com"),
    ] {
        if host == legacy || host.ends_with(&format!(".{region}.maas.aliyuncs.com")) {
            return Some(region);
        }
    }
    None
}

fn region_from_bedrock_url(base_url: &str) -> Option<String> {
    let host = reqwest::Url::parse(base_url)
        .ok()?
        .host_str()?
        .to_ascii_lowercase();
    let region = host
        .strip_prefix("bedrock-mantle.")?
        .strip_suffix(".api.aws")?;
    (!region.is_empty()).then(|| region.to_string())
}

fn region_from_vertex_url(base_url: &str) -> Option<String> {
    let host = reqwest::Url::parse(base_url)
        .ok()?
        .host_str()?
        .to_ascii_lowercase();
    let region = host.strip_suffix("-aiplatform.googleapis.com")?;
    (!region.is_empty()).then(|| region.to_string())
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Register the Vercel lane when its key and written resale permission are
/// both present and this Gateway holds fleet custody. Off the fleet a caller's
/// `safety_identifier` reaches the adapter unstripped, so the adapter's
/// subject check alone could be met by the caller; the lane is therefore
/// never built there. A refusal is recorded as the activation error.
fn register_vercel_lane(
    registry: &mut ProviderRegistry,
    config: &crate::config::VercelProviderConfig,
    custody: crate::custody::GatewayCustody,
    client: &reqwest::Client,
    egress: Option<&crate::egress::EgressPools>,
    quota: &Arc<ProviderQuotas>,
) {
    use ryu_gw_providers::vercel::{
        LaneRefusal, ResalePermission, VercelProvider, VERCEL_PROVIDER_ID,
    };
    let keys = config.all_keys();
    if keys.is_empty() {
        return;
    }
    let decision =
        ResalePermission::parse(config.resale_permission.as_deref()).and_then(|permission| {
            if custody.is_fleet() {
                Ok(permission)
            } else {
                Err(LaneRefusal::NotFleet)
            }
        });
    match decision {
        Ok(permission) => {
            tracing::info!(
                provider = VERCEL_PROVIDER_ID,
                reference = permission.reference(),
                "Vercel AI Gateway lane registered under a written resale permission"
            );
            registry.register(Arc::new(VercelProvider::new_with_egress(
                &permission,
                client.clone(),
                egress.and_then(|pool| pool.assigned(VERCEL_PROVIDER_ID)),
                keys,
                config.base_url.clone(),
                config.messages_base_url.clone(),
                Arc::clone(quota),
            )));
        }
        Err(refusal) => {
            tracing::warn!(
                provider = VERCEL_PROVIDER_ID,
                %refusal,
                "Vercel AI Gateway lane not registered"
            );
            registry
                .activation_errors
                .insert(VERCEL_PROVIDER_ID.to_owned(), refusal.to_string());
        }
    }
}

/// The 300 s total bounds non-streaming calls; streamed completions lift it per
/// request (`ryu_gw_providers::streaming_request`), so the read timeout is what
/// fails a stalled stream. A short connect timeout classifies an unreachable
/// upstream as a connection failure (safe to fall back), not uncertain delivery.
fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(ryu_gw_providers::STREAM_READ_TIMEOUT)
        .timeout(Duration::from_secs(300))
        .build()
        .expect("failed to build HTTP client")
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn edge_tts_requires_explicit_opt_in_and_has_no_credentials_or_region() {
        for opt_in in [None, Some(false), Some(true)] {
            let config = ProvidersConfig {
                edge_tts: opt_in.map(|anonymous_consumer_opt_in| crate::config::EdgeTtsConfig {
                    anonymous_consumer_opt_in,
                }),
                ..Default::default()
            };
            let registry = ProviderRegistry::new(&config, quota());
            assert_eq!(registry.get("edge-tts").is_some(), opt_in == Some(true));
            assert!(registry.region_for("edge-tts").is_none());
            assert!(!registry.account_ids.contains_key("edge-tts"));
            if let Some(provider) = registry.get("edge-tts") {
                assert!(provider
                    .complete("edge-tts", &serde_json::json!({}))
                    .await
                    .is_err());
            }
        }
        assert!(serde_json::from_value::<crate::config::EdgeTtsConfig>(
            serde_json::json!({"api_key":"fake"})
        )
        .is_err());
    }

    #[tokio::test]
    async fn google_translate_tts_requires_explicit_opt_in_and_keeps_cloud_separate() {
        for opt_in in [None, Some(false), Some(true)] {
            let config = ProvidersConfig {
                google_translate_tts: opt_in.map(|anonymous_consumer_opt_in| {
                    crate::config::GoogleTranslateTtsConfig {
                        anonymous_consumer_opt_in,
                    }
                }),
                ..Default::default()
            };
            let registry = ProviderRegistry::new(&config, Arc::new(ProviderQuotas::new()));
            assert_eq!(
                registry.get("google-translate-tts").is_some(),
                opt_in == Some(true)
            );
            assert!(registry.get("google-tts").is_none());
            assert!(registry.region_for("google-translate-tts").is_none());
            assert!(!registry.account_ids.contains_key("google-translate-tts"));
            if let Some(provider) = registry.get("google-translate-tts") {
                assert!(provider
                    .complete("google-translate-tts", &serde_json::json!({}))
                    .await
                    .is_err());
                assert_eq!(
                    provider.discover_models().await.unwrap()[0]["id"],
                    "google-translate-tts"
                );
            }
        }
        assert!(
            serde_json::from_value::<crate::config::GoogleTranslateTtsConfig>(
                serde_json::json!({"anonymous_consumer_opt_in":true,"api_key":"not-supported"})
            )
            .is_err()
        );
    }

    #[test]
    fn direct_google_and_polly_speech_accounts_register_without_exposing_credentials() {
        let config = ProvidersConfig {
            google_tts: Some(crate::config::GoogleTtsProviderConfig {
                accounts: vec![
                    crate::config::GoogleTtsAccountConfig {
                        access_token: "ya29.first-token".to_owned(),
                        quota_project: "ryu-demo-123".to_owned(),
                        expires_at_unix_secs: None,
                    },
                    crate::config::GoogleTtsAccountConfig {
                        access_token: "ya29.second-token".to_owned(),
                        quota_project: "ryu-demo-123".to_owned(),
                        expires_at_unix_secs: None,
                    },
                ],
            }),
            polly: Some(crate::config::PollyProviderConfig {
                region: "us-east-1".to_owned(),
                accounts: vec![crate::config::PollyAccountConfig {
                    access_key_id: "ABCDEFGHIJKLMNOPQRST".to_owned(),
                    secret_access_key: "abcdefghijklmnopqrstuvwxyz0123456789ABCD".to_owned(),
                    session_token: None,
                    expires_at_unix_secs: None,
                }],
            }),
            ..Default::default()
        };
        let debug = format!("{config:?}");
        for secret in [
            "ya29.first-token",
            "ya29.second-token",
            "ABCDEFGHIJKLMNOPQRST",
            "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
        ] {
            assert!(!debug.contains(secret));
        }
        let registry = ProviderRegistry::new(&config, quota());
        assert!(registry.get("google-tts").is_some());
        assert!(registry.get("polly").is_some());
        assert_eq!(registry.account_ids["google-tts"].len(), 2);
        assert_eq!(registry.account_ids["polly"].len(), 1);
        assert_eq!(registry.region_for("google-tts").as_deref(), Some("global"));
        assert_eq!(registry.region_for("polly").as_deref(), Some("us-east-1"));
        assert!(registry.activation_error("google-tts").is_none());
        assert!(registry.activation_error("polly").is_none());
    }
    use super::*;
    use crate::config::{
        AnthropicProviderConfig, AssemblyAiProviderConfig, CohereProviderConfig,
        CompatibleProviderConfig, DeepgramProviderConfig, ElevenLabsProviderConfig,
        InworldProviderConfig, LocalProviderConfig, OpenAiProviderConfig, ProvidersConfig,
    };
    use serde_json::Value;
    use std::pin::Pin;

    fn quota() -> Arc<ProviderQuotas> {
        Arc::new(ProviderQuotas::new())
    }

    /// A no-op provider used to exercise registry mechanics (register / replace /
    /// order) without any network.
    struct StubProvider(&'static str);
    impl Provider for StubProvider {
        fn name(&self) -> &'static str {
            self.0
        }
        fn complete<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move { Err(ryu_gw_providers::ProviderError::Provider("stub".into())) })
        }
        fn complete_stream<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move { Err(ryu_gw_providers::ProviderError::Provider("stub".into())) })
        }

        fn embed<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async { Ok(serde_json::json!({ "data": [] })) })
        }
    }

    #[tokio::test]
    async fn aliased_provider_keeps_embedding_capability() {
        let mut registry = ProviderRegistry::new(&ProvidersConfig::default(), quota());
        registry.register_as("embed-alias", Arc::new(StubProvider("stub")));
        let provider = registry.get("embed-alias").expect("alias registered");
        let result = provider
            .embed("test", &serde_json::json!({ "input": "hello" }))
            .await;
        assert_eq!(
            result.expect("inner embedding forwarded"),
            serde_json::json!({ "data": [] })
        );
    }

    #[tokio::test]
    async fn named_account_policies_control_real_upstream_dispatch_after_config_roundtrip() {
        use axum::{http::HeaderMap, routing::post, Json, Router};
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let upstream_capture = captured.clone();
        let app = Router::new().route("/v1/chat/completions", post(move |headers: HeaderMap| {
            let captured = upstream_capture.clone();
            async move {
                captured.lock().unwrap().push(headers["authorization"].to_str().unwrap().to_owned());
                Json(serde_json::json!({"choices":[{"message":{"role":"assistant","content":"proof"}}]}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut config: ProvidersConfig = serde_json::from_value(serde_json::json!({"modal":{"api_key":"disabled", "api_keys":["backup", "preferred"], "base_url":base}})).unwrap();
        let policies = HashMap::from([
            (
                ryu_gw_credentials::provider_account_id("modal", "disabled"),
                ryu_gw_providers::ProviderAccountPolicy {
                    enabled: false,
                    ..Default::default()
                },
            ),
            (
                ryu_gw_credentials::provider_account_id("modal", "backup"),
                ryu_gw_providers::ProviderAccountPolicy {
                    priority: 10,
                    ..Default::default()
                },
            ),
        ]);
        config.account_policies.insert("modal".to_owned(), policies);
        let restored: ProvidersConfig = toml::from_str(&toml::to_string(&config).unwrap()).unwrap();
        let registry = ProviderRegistry::new(&restored, quota());
        let provider = registry.get("modal").unwrap();
        assert!(provider.has_rotating_accounts());
        provider
            .complete_for_session(
                "test",
                &serde_json::json!({"messages":[]}),
                Some("same-session"),
            )
            .await
            .unwrap();
        provider
            .complete_for_session(
                "test",
                &serde_json::json!({"messages":[]}),
                Some("same-session"),
            )
            .await
            .unwrap();
        assert_eq!(
            *captured.lock().unwrap(),
            vec!["Bearer preferred", "Bearer preferred"]
        );
        let mut disabled = restored;
        for key in disabled.account_keys("modal") {
            disabled.account_policies.get_mut("modal").unwrap().insert(
                ryu_gw_credentials::provider_account_id("modal", &key),
                ryu_gw_providers::ProviderAccountPolicy {
                    enabled: false,
                    ..Default::default()
                },
            );
        }
        let registry = ProviderRegistry::new(&disabled, quota());
        assert!(registry
            .get("modal")
            .unwrap()
            .complete("test", &serde_json::json!({"messages":[]}))
            .await
            .is_err());
        assert_eq!(captured.lock().unwrap().len(), 2);
        server.abort();
    }

    #[tokio::test]
    async fn quota_first_strategy_survives_config_roundtrip_and_ranks_known_domains() {
        use axum::{http::HeaderMap, routing::post, Json, Router};
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let upstream_capture = captured.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |headers: HeaderMap| {
                let captured = upstream_capture.clone();
                async move {
                    let key = headers["authorization"].to_str().unwrap();
                    captured.lock().unwrap().push(key.to_owned());
                    let (organization, remaining) = if key == "Bearer key-a" {
                        ("org-a", "20")
                    } else {
                        ("org-b", "90")
                    };
                    (
                        [
                            ("openai-organization", organization),
                            ("x-ratelimit-remaining-requests", remaining),
                            ("x-ratelimit-limit-requests", "100"),
                        ],
                        Json(serde_json::json!({"choices":[]})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "openai": {"api_key":"key-a", "api_keys":["key-b"], "base_url":base},
            "accountStrategies": {"openai":"quota_first"}
        }))
        .unwrap();
        let restored: ProvidersConfig = toml::from_str(&toml::to_string(&config).unwrap()).unwrap();
        assert_eq!(
            restored.account_strategies["openai"],
            ryu_gw_providers::AccountSelectionStrategy::QuotaFirst
        );
        let registry = ProviderRegistry::new(&restored, quota());
        let provider = registry.get("openai").unwrap();
        let body = serde_json::json!({"messages":[]});
        for session in ["first", "second", "third"] {
            provider
                .complete_for_session("test", &body, Some(session))
                .await
                .unwrap();
        }
        assert_eq!(
            *captured.lock().unwrap(),
            vec!["Bearer key-a", "Bearer key-b", "Bearer key-b"]
        );
        server.abort();
    }

    #[test]
    fn empty_config_registers_no_providers() {
        let reg = ProviderRegistry::new(&ProvidersConfig::default(), quota());
        assert!(reg.available_providers().is_empty());
        assert!(reg.get("openai").is_none());
    }

    #[test]
    fn sdk_routes_coexist_and_resolve_legacy_owner_before_governance() {
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "openai":{"api_key":"native"},
            "openai_credits":{"api_key":"donated"},
            "genai":{"accounts":{"openai":{"api_key":"sdk"},"groq":{"api_key":"groq"},"gemini":{"api_key":"gemini"}}}
        })).unwrap();
        let registry = ProviderRegistry::new(&config, quota());
        for id in [
            "openai",
            "openai-credits",
            "genai-openai",
            "genai-groq",
            "genai",
        ] {
            assert_eq!(registry.get(id).unwrap().name(), id);
        }
        assert_eq!(
            registry.canonicalize_sdk_route("genai", "groq::llama-3.3-70b-versatile"),
            Some("genai-groq")
        );
        assert_eq!(
            registry.canonicalize_sdk_route("genai", "gemini-2.5-pro"),
            Some("genai")
        );
        assert_eq!(
            registry.canonicalize_sdk_route("genai-openai", "groq::llama-3.3-70b-versatile"),
            None
        );
        assert_eq!(
            registry.canonicalize_sdk_route("genai", "xai::grok-3"),
            None
        );
        let sdk_id = ryu_gw_credentials::provider_account_id("genai-groq", "groq");
        assert!(registry
            .validate_account_policy_updates(&HashMap::from([(
                "genai-groq".to_owned(),
                HashMap::from([(
                    sdk_id,
                    ryu_gw_credentials::ProviderAccountPolicy {
                        name: "SDK account".to_owned(),
                        ..Default::default()
                    }
                )])
            )]))
            .is_ok());
    }

    #[test]
    fn sdk_endpoint_regions_are_context_bound_and_remote_ollama_is_unknown() {
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({"genai":{"accounts":{
            "vertex":{"api_key":"token","context":{"kind":"vertex","project":"project","location":"europe-west4"}},
            "bedrock_api":{"api_key":"token","context":{"kind":"bedrock_api","region":"eu-west-1"}},
            "ollama":{"context":{"kind":"ollama","base_url":"https://remote.example/v1"}}
        }}})).unwrap();
        let registry = ProviderRegistry::new(&config, quota());
        assert_eq!(
            registry.region_for("genai-vertex").as_deref(),
            Some("europe-west4")
        );
        assert_eq!(
            registry.region_for("genai-bedrock-api").as_deref(),
            Some("eu-west-1")
        );
        assert_eq!(registry.region_for("genai-ollama"), None);
        assert!(registry.get("genai-ollama").is_some());
    }

    #[test]
    fn huggingface_registers_as_a_direct_chat_provider_with_named_accounts() {
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "compatible":{"huggingface":{
                "api_key":"hf-primary", "api_keys":["hf-second"],
                "base_url":"https://router.huggingface.co/v1"
            }},
            "account_policies":{"huggingface":{
                (ryu_gw_credentials::provider_account_id("huggingface", "hf-primary")):{
                    "name":"Personal", "enabled":true, "priority":2
                },
                (ryu_gw_credentials::provider_account_id("huggingface", "hf-second")):{
                    "name":"Work", "enabled":true, "priority":1
                }
            }}
        }))
        .unwrap();
        let restored: ProvidersConfig = toml::from_str(&toml::to_string(&config).unwrap()).unwrap();
        assert_eq!(restored.account_keys("huggingface").len(), 2);
        let registry = ProviderRegistry::new(&restored, quota());
        assert_eq!(registry.get("huggingface").unwrap().name(), "huggingface");
        assert_eq!(
            registry.region_for("huggingface").as_deref(),
            Some("global")
        );
    }

    #[test]
    fn direct_compatible_embedding_provider_registers_under_its_own_id() {
        let mut config = ProvidersConfig::default();
        config.compatible.insert(
            "voyage".to_owned(),
            CompatibleProviderConfig {
                api_key: "test-key".to_owned(),
                api_keys: Vec::new(),
                base_url: "https://api.voyageai.com/v1".to_owned(),
            },
        );
        let registry = ProviderRegistry::new(&config, quota());
        assert_eq!(
            registry.get("voyage").map(|provider| provider.name()),
            Some("voyage")
        );
        assert_eq!(registry.region_for("voyage").as_deref(), Some("global"));
    }

    #[test]
    fn named_compatible_vendors_register_distinct_accounts_and_provider_ids() {
        for id in [
            "chutes",
            "hyperbolic",
            "siliconflow",
            "venice",
            "featherless",
        ] {
            let base = ryu_gw_credentials::direct_compatible_provider_url(id).unwrap();
            let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
                "compatible":{(id):{"api_key":"fixture-primary", "api_keys":["fixture-work"], "base_url":base}},
                "account_policies":{(id):{
                    (ryu_gw_credentials::provider_account_id(id,"fixture-primary")):{"name":"Personal","enabled":true,"priority":2},
                    (ryu_gw_credentials::provider_account_id(id,"fixture-work")):{"name":"Work","enabled":true,"priority":1}
                }}
            })).unwrap();
            let restored: ProvidersConfig =
                toml::from_str(&toml::to_string(&config).unwrap()).unwrap();
            assert_eq!(restored.account_keys(id).len(), 2);
            let registry = ProviderRegistry::new(&restored, quota());
            assert_eq!(registry.get(id).unwrap().name(), id);
            assert_eq!(registry.region_for(id).as_deref(), Some("global"));
            assert!(registry.get("openai").is_none());
        }
    }

    #[test]
    fn cohere_registers_as_a_native_embedding_provider() {
        let config = ProvidersConfig {
            cohere: Some(CohereProviderConfig {
                api_key: "test-key".to_owned(),
                api_keys: Vec::new(),
                base_url: "https://api.cohere.com".to_owned(),
            }),
            ..ProvidersConfig::default()
        };
        let registry = ProviderRegistry::new(&config, quota());
        assert_eq!(
            registry.get("cohere").map(|provider| provider.name()),
            Some("cohere")
        );
    }

    #[test]
    fn qwen_registers_its_native_stt_adapter_and_region() {
        let mut config = ProvidersConfig::default();
        config.compatible.insert(
            "qwen".to_owned(),
            CompatibleProviderConfig {
                api_key: "first".to_owned(),
                api_keys: vec!["second".to_owned()],
                base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1".to_owned(),
            },
        );
        let registry = ProviderRegistry::new(&config, quota());
        assert_eq!(registry.get("qwen").unwrap().name(), "qwen");
        assert!(registry.get("qwen").unwrap().has_rotating_accounts());
        assert_eq!(
            registry.region_for("qwen").as_deref(),
            Some("ap-southeast-1")
        );
        assert_eq!(
            region_from_qwen_url(
                "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
            ),
            Some("cn-beijing")
        );
        assert_eq!(region_from_qwen_url("https://custom.example/v1"), None);
    }

    #[test]
    fn direct_speech_providers_register_under_distinct_ids() {
        let config = ProvidersConfig {
            deepgram: Some(DeepgramProviderConfig {
                api_key: "test-deepgram".to_owned(),
                api_keys: Vec::new(),
                base_url: "https://api.deepgram.com".to_owned(),
            }),
            assemblyai: Some(AssemblyAiProviderConfig {
                api_key: "test-assemblyai".to_owned(),
                api_keys: Vec::new(),
                base_url: "https://api.assemblyai.com".to_owned(),
                poll_interval_ms: 1500,
                poll_timeout_secs: 180,
            }),
            elevenlabs: Some(ElevenLabsProviderConfig {
                api_key: "test-elevenlabs".to_owned(),
                api_keys: Vec::new(),
                base_url: "https://api.elevenlabs.io".to_owned(),
            }),
            inworld: Some(InworldProviderConfig {
                api_key: "inworld-primary".to_owned(),
                api_keys: vec!["inworld-extra".to_owned()],
                base_url: "https://api.inworld.ai".to_owned(),
            }),
            ..ProvidersConfig::default()
        };
        let registry = ProviderRegistry::new(&config, quota());
        assert_eq!(
            registry.get("deepgram").map(|provider| provider.name()),
            Some("deepgram")
        );
        assert_eq!(
            registry.get("elevenlabs").map(|provider| provider.name()),
            Some("elevenlabs")
        );
        assert_eq!(
            registry.get("assemblyai").map(|provider| provider.name()),
            Some("assemblyai")
        );
        assert_eq!(registry.region_for("assemblyai").as_deref(), Some("global"));
        let inworld = registry.get("inworld").unwrap();
        assert_eq!(inworld.name(), "inworld");
        assert!(inworld.has_rotating_accounts());
        assert_eq!(registry.region_for("inworld").as_deref(), Some("global"));
    }

    #[test]
    fn gemini_accounts_mark_genai_as_rotating_for_response_cache_bypass() {
        let config = ProvidersConfig {
            genai: Some(serde_json::from_value(serde_json::json!({"accounts":{"gemini":{"api_key":"first","api_keys":["second"]}}})).unwrap()),
            ..ProvidersConfig::default()
        };
        let registry = ProviderRegistry::new(&config, quota());
        assert!(registry.get("genai").unwrap().has_rotating_accounts());
    }

    #[test]
    fn modal_endpoint_stays_disabled_until_it_has_an_account() {
        let mut config = ProvidersConfig {
            modal: Some(crate::config::ModalProviderConfig {
                api_key: String::new(),
                api_keys: Vec::new(),
                base_url: "https://deployment.modal.run/v1".to_owned(),
            }),
            ..Default::default()
        };
        assert!(ProviderRegistry::new(&config, quota())
            .get("modal")
            .is_none());
        let modal = config.modal.as_mut().unwrap();
        modal.api_keys = vec!["first".to_owned(), "second".to_owned()];
        let registry = ProviderRegistry::new(&config, quota());
        let modal = registry.get("modal").unwrap();
        assert_eq!(modal.name(), "modal");
        assert!(modal.has_rotating_accounts());
    }

    #[test]
    fn providers_register_in_deterministic_order_and_skip_absent() {
        // openai + anthropic present, everything else absent.
        let config = ProvidersConfig {
            openai: Some(OpenAiProviderConfig {
                api_key: "sk-openai".to_string(),
                api_keys: vec![],
                base_url: "https://api.openai.com/v1".to_string(),
            }),
            anthropic: Some(AnthropicProviderConfig {
                api_key: "sk-anthropic".to_string(),
                api_keys: vec![],
                base_url: "https://api.anthropic.com".to_string(),
            }),
            ..ProvidersConfig::default()
        };
        let reg = ProviderRegistry::new(&config, quota());
        // Registration order is openai-before-anthropic (matches `new`).
        assert_eq!(reg.available_providers(), vec!["openai", "anthropic"]);
        assert!(reg.get("openai").is_some());
        assert!(reg.get("anthropic").is_some());
        // A provider whose config is absent never enters the map.
        assert!(reg.get("local").is_none());
        assert!(reg.get("unknown").is_none());
    }

    #[test]
    fn get_resolves_provider_by_stable_id() {
        let config = ProvidersConfig {
            local: Some(LocalProviderConfig {
                base_url: "http://127.0.0.1:1234".to_string(),
                model_routes: std::collections::HashMap::new(),
            }),
            ..ProvidersConfig::default()
        };
        let reg = ProviderRegistry::new(&config, quota());
        assert_eq!(reg.get("local").map(Provider::name), Some("local"));
    }

    #[test]
    fn every_configured_builtin_registers_in_deterministic_order() {
        // A config with EVERY built-in present exercises each registration branch
        // and pins the deterministic order the /v1/models discovery merge relies on.
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "openai": { "api_key": "sk-o" },
            "anthropic": { "api_key": "sk-a" },
            "local": { "base_url": "http://127.0.0.1:1234" },
            "openrouter": { "api_key": "sk-or" },
            "core": { "base_url": "http://127.0.0.1:7979", "token": "t" },
            "modal": { "api_key": "sk-m", "base_url": "https://modal.example" },
            "genai": { "keys": { "gemini": "sk-g" } },
            "replicate": { "api_key": "sk-r" },
            "fal": { "api_key": "sk-f" },
            "classify": { "base_url": "http://127.0.0.1:8083/v1" },
            "cloudflare": { "api_key": "cf", "base_url": "https://cf.example/ai/v1" },
            "bedrock": { "api_key": "aws", "base_url": "https://bedrock.example/anthropic" },
            "vertex": { "api_key": "gcp", "base_url": "https://vertex.example/endpoints/openapi" },
            "openai_credits": { "api_key": "sk-donated" }
        }))
        .expect("full providers config parses");
        let reg = ProviderRegistry::new(&config, quota());
        // `classify` and the credit-pool slots are appended LAST: the /v1/models
        // discovery merge is order-sensitive, so a new provider must never be
        // inserted mid-list.
        assert_eq!(
            reg.available_providers(),
            vec![
                "openai",
                "anthropic",
                "local",
                "openrouter",
                "core",
                "kiro",
                "modal",
                "genai",
                "replicate",
                "fal",
                "classify",
                "cloudflare",
                "bedrock",
                "vertex",
                "openai-credits",
            ]
        );
    }

    #[test]
    fn credit_pool_providers_report_their_own_ids_not_the_aliased_impl() {
        // All four reuse an existing impl (`OpenAiProvider` / `AnthropicProvider`),
        // whose `name()` is a hardcoded literal. If the alias leaked, `cloudflare`
        // would REPLACE `openai` in the map and every debit would be attributed to
        // the wrong pool â€” the exact money bug the pool split exists to prevent.
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "openai": { "api_key": "sk-o" },
            "anthropic": { "api_key": "sk-a" },
            "cloudflare": { "api_key": "cf", "base_url": "https://cf.example/ai/v1" },
            "bedrock": { "api_key": "aws", "base_url": "https://bedrock.example/anthropic" },
            "vertex": { "api_key": "gcp", "base_url": "https://vertex.example/endpoints/openapi" },
            "openai_credits": { "api_key": "sk-donated" }
        }))
        .expect("providers config parses");
        let reg = ProviderRegistry::new(&config, quota());
        assert_eq!(
            reg.get("cloudflare").map(Provider::name),
            Some("cloudflare")
        );
        assert_eq!(reg.get("bedrock").map(Provider::name), Some("bedrock"));
        assert_eq!(reg.get("vertex").map(Provider::name), Some("vertex"));
        assert_eq!(reg.get("openai").map(Provider::name), Some("openai"));
        assert_eq!(reg.get("anthropic").map(Provider::name), Some("anthropic"));
    }

    #[test]
    fn donated_openai_is_a_separate_slot_from_the_byok_openai() {
        // The sharpest alias case: same impl, same endpoint, different KEY. Both
        // ids must exist side by side and each hold its own key, because
        // `credit_pools` tags one and not the other. A single slot would make
        // BYOK traffic debit the donated grant.
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "openai": { "api_key": "sk-byok" },
            "openai_credits": { "api_key": "sk-donated" }
        }))
        .expect("providers config parses");
        let reg = ProviderRegistry::new(&config, quota());
        assert_eq!(reg.get("openai").map(Provider::name), Some("openai"));
        assert_eq!(
            reg.get("openai-credits").map(Provider::name),
            Some("openai-credits")
        );
        assert_eq!(reg.available_providers(), vec!["openai", "openai-credits"]);
    }

    #[test]
    fn donated_openai_does_not_stand_in_for_an_unconfigured_byok_slot() {
        // â€¦nor the reverse. Only the id that was configured registers; a donated
        // allowance must never silently serve pass-through callers who have no key
        // of their own, since that spends donor credit on untagged traffic.
        let donated_only: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "openai_credits": { "api_key": "sk-donated" }
        }))
        .expect("providers config parses");
        let reg = ProviderRegistry::new(&donated_only, quota());
        assert!(reg.get("openai").is_none());
        assert!(reg.get("openai-credits").is_some());

        let byok_only: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "openai": { "api_key": "sk-byok" }
        }))
        .expect("providers config parses");
        let reg = ProviderRegistry::new(&byok_only, quota());
        assert!(reg.get("openai").is_some());
        assert!(reg.get("openai-credits").is_none());
    }

    #[test]
    fn credit_pool_providers_are_absent_when_unconfigured() {
        // An untagged deploy simply lacks the ids â€” no boot failure, no default
        // endpoint (the account/region/project-scoped base URLs have no sane
        // hardcoded value, and the donated OpenAI slot is gated on its own key).
        let reg = ProviderRegistry::new(&ProvidersConfig::default(), quota());
        assert!(reg.get("cloudflare").is_none());
        assert!(reg.get("bedrock").is_none());
        assert!(reg.get("vertex").is_none());
        assert!(reg.get("openai-credits").is_none());
    }

    fn fleet_registry(config: &ProvidersConfig) -> ProviderRegistry {
        ProviderRegistry::build_with_environment(
            config,
            None,
            quota(),
            &std::collections::BTreeMap::new(),
            crate::custody::GatewayCustody::Fleet,
        )
    }

    #[test]
    fn vercel_lane_registers_only_under_a_written_resale_permission() {
        // Off by default: no slot, no error.
        let reg = fleet_registry(&ProvidersConfig::default());
        assert!(reg.get("vercel").is_none());
        assert!(reg.activation_error("vercel").is_none());

        let lane = |permission: serde_json::Value, key: &str| -> ProvidersConfig {
            serde_json::from_value(serde_json::json!({
                "vercel": { "api_key": key, "resale_permission": permission }
            }))
            .expect("vercel lane config parses")
        };
        for refused in [
            serde_json::Value::Null,
            serde_json::json!("unreviewed"),
            serde_json::json!("forbidden"),
            serde_json::json!("approved:"),
            serde_json::json!("approved:   "),
        ] {
            let config = lane(refused.clone(), "vercel-fixture-key");
            let reg = fleet_registry(&config);
            assert!(reg.get("vercel").is_none(), "{refused}");
            assert!(
                !reg.available_providers().iter().any(|id| id == "vercel"),
                "{refused}"
            );
            let error = reg.activation_error("vercel").expect("refusal is recorded");
            assert!(error.contains("lane is off"), "{refused}: {error}");
        }

        // An approval without a key builds nothing and records nothing.
        let reg = fleet_registry(&lane(
            serde_json::json!("approved:VERCEL-RESALE-FIXTURE-1"),
            "  ",
        ));
        assert!(reg.get("vercel").is_none());
        assert!(reg.activation_error("vercel").is_none());

        let approved = lane(
            serde_json::json!("approved:VERCEL-RESALE-FIXTURE-1"),
            "vercel-fixture-key",
        );
        let reg = fleet_registry(&approved);
        assert_eq!(reg.get("vercel").map(|p| p.name()), Some("vercel"));
        assert!(reg.activation_error("vercel").is_none());
        assert_eq!(reg.custody(), crate::custody::GatewayCustody::Fleet);
    }

    #[test]
    fn vercel_lane_never_registers_off_the_fleet_even_when_approved() {
        // Off the fleet a caller's `safety_identifier` reaches the adapter
        // unstripped, so the approved lane must not exist there at all.
        let approved: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "vercel": {
                "api_key": "vercel-fixture-key",
                "resale_permission": "approved:VERCEL-RESALE-FIXTURE-1"
            }
        }))
        .expect("vercel lane config parses");
        for custody in [
            crate::custody::GatewayCustody::SelfHosted,
            crate::custody::GatewayCustody::ManagedNode,
        ] {
            let reg = ProviderRegistry::build_with_environment(
                &approved,
                None,
                quota(),
                &std::collections::BTreeMap::new(),
                custody,
            );
            assert!(reg.get("vercel").is_none(), "{custody:?}");
            assert!(
                !reg.available_providers().iter().any(|id| id == "vercel"),
                "{custody:?}"
            );
            let error = reg.activation_error("vercel").expect("refusal is recorded");
            assert!(error.contains("lane is off"), "{custody:?}: {error}");
            assert!(error.contains("fleet"), "{custody:?}: {error}");
        }
        // The plain constructors build as self-hosted, so they fail closed too.
        let reg = ProviderRegistry::new(&approved, quota());
        assert!(reg.get("vercel").is_none());
        assert_eq!(reg.custody(), crate::custody::GatewayCustody::SelfHosted);
    }

    #[test]
    fn classify_registers_as_its_own_provider_distinct_from_local() {
        // Both tiers configured at DIFFERENT urls: the classify slot must not
        // replace `local` (they share the `LocalProvider` impl, whose `name()` is
        // the hardcoded "local"), and each must report its own id so the
        // pipeline's metrics / admission / circuit-breaker keys stay separate.
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "local": { "base_url": "http://127.0.0.1:11434/v1" },
            "classify": { "base_url": "http://127.0.0.1:8083/v1" }
        }))
        .expect("local + classify config parses");
        let reg = ProviderRegistry::new(&config, quota());
        assert_eq!(reg.get("local").map(Provider::name), Some("local"));
        assert_eq!(reg.get("classify").map(Provider::name), Some("classify"));
        assert_eq!(reg.available_providers(), vec!["local", "classify"]);
    }

    #[test]
    fn classify_absent_degrades_gracefully_to_no_provider() {
        // A STANDALONE gateway's state (NOT "the lazy sidecar's normal state" â€” Core
        // publishes RYU_CLASSIFY_LLM_URL unconditionally, so a Core-spawned gateway
        // always has the slot): no URL â‡’ no slot â‡’ no provider. `get` returns None
        // and the inspector fails open with a warn naming the provider â€” the
        // intended posture, not an error, so it is pinned here.
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "local": { "base_url": "http://127.0.0.1:11434/v1" }
        }))
        .expect("local-only config parses");
        let reg = ProviderRegistry::new(&config, quota());
        assert!(reg.get("classify").is_none());
    }

    #[test]
    fn regional_provider_metadata_is_required_for_region_policy() {
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "bedrock": {
                "api_key": "aws",
                "base_url": "https://bedrock-mantle.eu-west-1.api.aws/anthropic"
            },
            "vertex": {
                "api_key": "gcp",
                "base_url": "https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/endpoints/openapi"
            },
            "openai": { "api_key": "sk-openai" }
        }))
        .expect("regional provider config parses");
        let reg = ProviderRegistry::new(&config, quota());

        assert_eq!(reg.region_for("bedrock").as_deref(), Some("eu-west-1"));
        assert_eq!(reg.region_for("vertex").as_deref(), Some("europe-west4"));
        assert_eq!(reg.region_for("openai").as_deref(), Some("global"));
        assert_eq!(reg.region_for("unregistered-plugin"), None);
    }

    #[test]
    fn register_as_overrides_the_inner_providers_name() {
        // The isolation guarantee `register_as` exists for: the pipeline keys
        // metrics/admission/circuit-breaker off `provider.name()`, so the alias
        // must win over the wrapped provider's own hardcoded name.
        let mut reg = ProviderRegistry::new(&ProvidersConfig::default(), quota());
        reg.register_as("aliased", Arc::new(StubProvider("inner")));
        assert_eq!(reg.get("aliased").map(Provider::name), Some("aliased"));
        assert!(reg.get("inner").is_none());
        assert_eq!(reg.available_providers(), vec!["aliased"]);
    }

    #[test]
    fn register_appends_new_id_and_replaces_existing_in_place() {
        let mut reg = ProviderRegistry::new(&ProvidersConfig::default(), quota());
        reg.register(Arc::new(StubProvider("alpha")));
        reg.register(Arc::new(StubProvider("beta")));
        assert_eq!(reg.available_providers(), vec!["alpha", "beta"]);

        // Re-registering an existing id replaces the provider WITHOUT changing its
        // position in the iteration order (the open extension point for plugins).
        reg.register(Arc::new(StubProvider("alpha")));
        assert_eq!(
            reg.available_providers(),
            vec!["alpha", "beta"],
            "re-registering must not duplicate or reorder"
        );
    }
}
