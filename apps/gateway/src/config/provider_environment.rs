//! Captured provider inputs shared by startup and exact-revision publication.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fmt;

mod credit_pools;
mod imports;
mod media;
mod variables;

use imports::restore_closed_imports;
use variables::{NATIVE_KEY_VARIABLES, PROVIDER_VARIABLES};

#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct ProviderEnvironment {
    values: BTreeMap<String, String>,
}

impl fmt::Debug for ProviderEnvironment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderEnvironment")
            .field("variable_count", &self.values.len())
            .finish_non_exhaustive()
    }
}

impl ProviderEnvironment {
    pub(crate) fn capture(egress: &EgressConfig) -> Self {
        let mut names: Vec<String> = PROVIDER_VARIABLES
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        names.push(ENV_CLASSIFY_MODEL_ID.to_owned());
        names.extend(
            ryu_gw_credentials::SDK_PROVIDERS
                .iter()
                .filter_map(|d| d.default_env)
                .map(str::to_owned),
        );
        for (id, _) in ryu_gw_credentials::DIRECT_COMPATIBLE_PROVIDERS {
            let prefix = id.to_ascii_uppercase();
            names.extend([
                format!("{prefix}_API_KEY"),
                format!("{prefix}_API_KEYS"),
                format!("{prefix}_BASE_URL"),
            ]);
        }
        for pool in egress.pools.values() {
            for endpoint in &pool.endpoints {
                names.extend(
                    [&endpoint.username_env, &endpoint.password_env]
                        .into_iter()
                        .flatten()
                        .cloned(),
                );
            }
        }
        Self {
            values: names
                .into_iter()
                .filter_map(|name| std::env::var(&name).ok().map(|value| (name, value)))
                .collect(),
        }
    }
    pub(crate) fn values(&self) -> &BTreeMap<String, String> {
        &self.values
    }
    pub(crate) fn identity(&self) -> [u8; 32] {
        let mut hash = Sha256::new();
        for (name, value) in &self.values {
            hash.update(name.len().to_be_bytes());
            hash.update(name.as_bytes());
            hash.update(value.len().to_be_bytes());
            hash.update(value.as_bytes());
        }
        hash.finalize().into()
    }
    pub(super) fn var(&self, name: impl AsRef<str>) -> Result<String, std::env::VarError> {
        self.values
            .get(name.as_ref())
            .cloned()
            .ok_or(std::env::VarError::NotPresent)
    }
    fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }
    fn keys(&self, name: &str) -> Vec<String> {
        self.get(name)
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|key| !key.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }
    pub(crate) fn apply(&self, config: &mut GatewayConfig) -> Result<(), String> {
        let authored = config.providers.clone();
        // OpenAI
        if let Ok(key) = self.var("OPENAI_API_KEY") {
            let base_url = self
                .var("OPENAI_BASE_URL")
                .unwrap_or_else(|_| openai_base_url());
            config.providers.openai = Some(OpenAiProviderConfig {
                api_key: key,
                api_keys: self.keys("OPENAI_API_KEYS"),
                base_url,
            });
        }

        for (id, default_url) in ryu_gw_credentials::DIRECT_COMPATIBLE_PROVIDERS {
            let prefix = id.to_ascii_uppercase();
            let key_var = format!("{prefix}_API_KEY");
            let Some(key) = self
                .var(&key_var)
                .ok()
                .filter(|value| !value.trim().is_empty())
            else {
                continue;
            };
            let base_url = self
                .var(format!("{prefix}_BASE_URL"))
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| (*default_url).to_owned());
            config.providers.compatible.insert(
                (*id).to_owned(),
                CompatibleProviderConfig {
                    api_key: key,
                    api_keys: self.keys(&format!("{prefix}_API_KEYS")),
                    base_url,
                },
            );
        }
        self.apply_media_providers(config);

        // Anthropic
        if let Ok(key) = self.var("ANTHROPIC_API_KEY") {
            let base_url = self
                .var("ANTHROPIC_BASE_URL")
                .unwrap_or_else(|_| anthropic_base_url());
            config.providers.anthropic = Some(AnthropicProviderConfig {
                api_key: key,
                api_keys: self.keys("ANTHROPIC_API_KEYS"),
                base_url,
            });
        }

        // Local LLM
        if let Ok(url) = self.var("LOCAL_LLM_URL") {
            let model_routes = self
                .var("RYU_LOCAL_MODEL_ROUTES")
                .map(|raw| parse_local_model_routes(&raw))
                .unwrap_or_default();
            config.providers.local = Some(LocalProviderConfig {
                base_url: url,
                model_routes,
            });
        }

        // Classify-tier LLM. Core publishes `RYU_CLASSIFY_LLM_URL` into the gateway
        // spawn env pointing at its lazy llama.cpp classify sidecar (profile-offset
        // [`DEFAULT_CLASSIFY_PORT`]) — unconditionally, so on a Core-spawned gateway
        // this slot is always `Some`. Absent (a STANDALONE gateway) ⇒ the slot stays
        // `None` and the `classify` provider is never registered, which the
        // inspector/judge handle by failing open — see
        // [`crate::providers::ProviderRegistry::new`].
        //
        // THE ENV WINS over the file here, exactly like `local`/`LOCAL_LLM_URL` above.
        // A previous round inverted this (file-wins) so that a `[providers.classify]
        // base_url` in `gateway.toml` would stop being inert on a Core-spawned node.
        // That is a real improvement in isolation and it is deliberately given up,
        // because the precedence is not a local decision — it is half of a
        // cross-process contract, and file-wins made the other half unsatisfiable:
        //
        //   Core lazily starts a ~300-400 MB `llamacpp-classify` sidecar whenever a
        //   config push selects the classify tier (`apps/core/src/sidecar/gateway.rs`
        //   ::`maybe_start_classify_tier`). Read, not assumed: its only locality check
        //   is `url_targets_this_machine(gateway_url())` — "is the gateway on this
        //   box" — and there is nothing else it *could* check under file-wins, because
        //   the deciding value then lives in a file in the gateway's own config
        //   directory, which Core neither reads nor is notified about. So on a node
        //   whose operator pointed `[providers.classify]` at an external small model,
        //   every selecting push started a local sidecar nothing ever dialed. Idle-stop
        //   is off unless `RYU_SIDECAR_IDLE`, so that RAM stayed resident for the life
        //   of the process.
        //
        // Under env-wins the URL the gateway will dial for `classify` on a Core-spawned
        // node is EXACTLY the value Core published, i.e. `classify_gateway_url()` — a
        // fact Core can evaluate from its own process with no file access and no new
        // channel. That is what lets the lazy start be gated on the classify *target's*
        // locality (it now is), which removes the wasted-RAM class instead of trading
        // it for an inert setting.
        //
        // Consequence, stated plainly rather than left implicit: `[providers.classify]`
        // is the **standalone-gateway** setting. On a gateway Core spawned it is
        // overwritten on every load and therefore has no effect; repointing the tier
        // there takes `RYU_CLASSIFY_LLM_URL` (plus `RYU_LOCAL_CLASSIFIER_MODEL_ID` for
        // the id) in *Core's* environment. This matches `local`/`LOCAL_LLM_URL`, the
        // established precedent for a Core-published provider URL, so there is one rule
        // for both slots instead of two.
        //
        // A blank env value reads as "not published" (Core never sends one, but a shell
        // could): the file table — or `None` — survives, so the tier fails open rather
        // than registering an unusable "" URL.
        //
        // The slot the env fills is DERIVED and is stripped again before anything is
        // written ([`GatewayConfig::without_derived_values`]). It must be: every
        // provider slot serializes back out on `save()`, and Core's URL is a computed,
        // profile-scoped loopback address — persisting it would record a value that is
        // wrong on the next profile/port change and that goes live the moment Core is
        // not the spawner. The operator's own table is CAPTURED here
        // ([`Self::file_classify_provider`]) so the strip restores it instead of
        // deleting it from their file.
        if let Some(url) = self
            .var("RYU_CLASSIFY_LLM_URL")
            .ok()
            .filter(|url| !url.trim().is_empty())
        {
            config.file_classify_provider = config.providers.classify.take();
            config.providers.classify = Some(ClassifyProviderConfig { base_url: url });
            config.env_injected_classify_provider = true;
        }
        // …and make the classifier id ROUTABLE, not just readable. The built-in
        // `"gemma-3-270m"` prefix cannot follow a registry override (it is a
        // compile-time table), and `route`'s two user-`model_map` steps run BEFORE
        // it — so both an overridden id and a stray user `gemma` prefix mapping
        // would send the guardrail classifier somewhere other than the classify
        // tier. Seeding an exact entry fixes both at once because exact-match is
        // step 1. The seeded key is remembered so the row can be stripped again from
        // everything that leaves the process — it is derived, not operator config.
        // See [`seed_classify_route`] and [`GatewayConfig::without_derived_values`].
        config.seeded_classify_model = seed_classify_route(
            &mut config.routing,
            &resolve_classify_model_id(self.get(ENV_CLASSIFY_MODEL_ID)),
        );

        // LiteLLM proxy. The key activates the slot; the endpoint defaults to the
        // proxy's documented local address and is otherwise operator-set.
        if let Some(key) = self
            .var("LITELLM_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
        {
            let base_url = self
                .var("LITELLM_BASE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| authored.litellm.as_ref().map(|c| c.base_url.clone()))
                .unwrap_or_else(litellm_base_url);
            config.providers.litellm = Some(LiteLlmProviderConfig {
                api_key: key,
                api_keys: self.keys("LITELLM_API_KEYS"),
                base_url,
            });
        }

        // OpenRouter
        if let Ok(key) = self.var("OPENROUTER_API_KEY") {
            let base_url = self
                .var("OPENROUTER_BASE_URL")
                .unwrap_or_else(|_| openrouter_base_url());
            // Routing and attribution settings come from gateway.toml
            // `[providers.openrouter]`; an env-supplied key only fills the
            // credential. `OPENROUTER_DATA_COLLECTION` is still honoured as an
            // explicit override because the managed privacy default keys off it.
            let authored_openrouter = authored.openrouter.as_ref();
            let data_collection = self
                .var("OPENROUTER_DATA_COLLECTION")
                .ok()
                .or_else(|| authored_openrouter.map(|c| c.data_collection.clone()))
                .unwrap_or_else(openrouter_data_collection);
            config.providers.openrouter = Some(OpenRouterProviderConfig {
                api_key: key,
                api_keys: self.keys("OPENROUTER_API_KEYS"),
                base_url,
                site_url: authored_openrouter
                    .map_or_else(openrouter_site_url, |c| c.site_url.clone()),
                site_name: authored_openrouter
                    .map_or_else(openrouter_site_name, |c| c.site_name.clone()),
                data_collection,
                zdr: authored_openrouter.is_some_and(|c| c.zdr),
                sort: authored_openrouter
                    .map(|c| c.sort.clone())
                    .unwrap_or_default(),
                response_healing: authored_openrouter.is_some_and(|c| c.response_healing),
                usage_accounting: authored_openrouter.is_none_or(|c| c.usage_accounting),
                org_api_keys: std::collections::HashMap::new(),
            });
        }

        // Replicate (cloud image/video). Key presence alone activates the
        // provider — mirrors the OpenRouter block. base_url overridable for
        // proxies / self-host.
        if let Ok(key) = self.var("REPLICATE_API_KEY") {
            if !key.trim().is_empty() {
                let base_url = self
                    .var("REPLICATE_BASE_URL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(replicate_base_url);
                config.providers.replicate = Some(ReplicateProviderConfig {
                    api_key: key,
                    api_keys: self.keys("REPLICATE_API_KEYS"),
                    base_url,
                    poll_interval_ms: default_media_poll_interval_ms(),
                    poll_timeout_secs: default_media_poll_timeout_secs(),
                });
            }
        }

        // Fal (cloud image/video/audio). Key presence alone activates it.
        if let Ok(key) = self.var("FAL_API_KEY") {
            if !key.trim().is_empty() {
                let base_url = self
                    .var("FAL_BASE_URL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(fal_base_url);
                config.providers.fal = Some(FalProviderConfig {
                    api_keys: self.keys("FAL_API_KEYS"),
                    api_key: key,
                    base_url,
                    poll_interval_ms: default_media_poll_interval_ms(),
                    poll_timeout_secs: default_media_poll_timeout_secs(),
                });
            }
        }

        // Core sidecar manager
        if let Ok(url) = self.var("CORE_URL") {
            let token = self.var("CORE_TOKEN").ok();
            config.providers.core = Some(CoreProviderConfig {
                base_url: url,
                token,
            });
        }

        // Modal serverless GPU (opt-in). A Ryu Cloud GPU node sets both vars to
        // its deployed Modal inference app; absent either, the provider stays
        // off (nothing hardcoded, no default URL).
        if let (Ok(base_url), Ok(api_key)) = (self.var("MODAL_BASE_URL"), self.var("MODAL_API_KEY"))
        {
            if !base_url.trim().is_empty() && !api_key.trim().is_empty() {
                config.providers.modal = Some(ModalProviderConfig {
                    api_key,
                    api_keys: self.keys("MODAL_API_KEYS"),
                    base_url,
                });
            }
        }

        self.apply_credit_pool_providers(config);

        restore_closed_imports(&mut config.providers, &authored)?;
        Ok(())
    }

    pub(crate) fn native_sources(&self, config: &ProvidersConfig) -> HashMap<String, &'static str> {
        let mut sources = HashMap::new();
        for (id, variables) in NATIVE_KEY_VARIABLES {
            if config.environment_imports.get(*id) != Some(&false)
                && variables
                    .iter()
                    .any(|variable| self.get(variable).is_some())
            {
                sources.insert((*id).to_owned(), "environment");
            }
        }
        for (id, _) in ryu_gw_credentials::DIRECT_COMPATIBLE_PROVIDERS {
            if config.environment_imports.get(*id) != Some(&false)
                && self
                    .get(&format!("{}_API_KEY", id.to_ascii_uppercase()))
                    .is_some()
            {
                sources.insert((*id).to_owned(), "environment");
            }
        }
        sources
    }
    pub(crate) fn from_values(values: BTreeMap<String, String>) -> Self {
        Self { values }
    }
}
