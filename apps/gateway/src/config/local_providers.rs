//! Local engines, the classify tier and built-in provider ids.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LocalProviderConfig {
    #[serde(default = "local_base_url")]
    pub base_url: String,
    /// Requested model name → name the local engine actually serves. Core
    /// publishes these in `RYU_LOCAL_MODEL_ROUTES` when it bakes per-model launch
    /// settings into a derived Ollama model. Derived runtime state, never read
    /// from or written to `gateway.toml`.
    #[serde(skip)]
    pub model_routes: HashMap<String, String>,
}

/// Parse `RYU_LOCAL_MODEL_ROUTES` (a JSON object of string → string). Malformed
/// input yields no routes, so a bad value degrades to serving the base model.
pub fn parse_local_model_routes(raw: &str) -> HashMap<String, String> {
    serde_json::from_str::<HashMap<String, String>>(raw)
        .map(|routes| {
            routes
                .into_iter()
                .filter(|(from, to)| !from.trim().is_empty() && !to.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn local_base_url() -> String {
    "http://127.0.0.1:11434/v1".to_string()
}

/// Loopback port the classify-tier llama.cpp server listens on, kept in lockstep
/// with Core's `llamacpp::classify::CLASSIFY_PORT_BASE` (chat 8080, embed 8081,
/// rerank 8082, classify 8083).
pub const DEFAULT_CLASSIFY_PORT: u16 = 8083;

/// Loopback port the embed tier listens on — the second slot in the same port map
/// as [`DEFAULT_CLASSIFY_PORT`].
pub const DEFAULT_EMBED_PORT: u16 = 8081;

/// Where to embed text when no `[providers.openai]` is configured.
///
/// The embedding-backed paths — smart routing's `Embedding` strategy and the
/// semantic cache — were written to take a bare `(base_url, api_key)` OpenAI
/// endpoint, so with no OpenAI provider they logged "no embedder configured" and
/// gave up. On a Core-spawned gateway that is wrong twice over: an embed sidecar
/// IS running on loopback, speaking the same OpenAI-compatible `/embeddings`
/// shape, and it is the embedder the model default (`nomic-embed-text-v1.5`)
/// names. So the absence of a cloud key made a local-first feature silently inert.
///
/// `RYU_EMBED_LLM_URL` overrides, mirroring `RYU_CLASSIFY_LLM_URL` for the
/// classify tier; the port is profile-aware for the same reason
/// [`classify_base_url`] is, so a dev gateway reaches `:9081`, not the release
/// sidecar on `:8081`.
pub fn local_embed_base_url() -> String {
    std::env::var("RYU_EMBED_LLM_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            format!(
                "http://127.0.0.1:{}/v1",
                crate::profile::port(DEFAULT_EMBED_PORT)
            )
        })
}

/// The classify tier's connection config — the same single-field shape as
/// [`LocalProviderConfig`], kept as a distinct type purely so it carries its own
/// `base_url` default: reusing `LocalProviderConfig` would make a bare
/// `[providers.classify]` table in `gateway.toml` silently default to Ollama's
/// `:11434` (the chat engine) instead of the classifier.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ClassifyProviderConfig {
    /// The **standalone-gateway** setting for the classify tier. Core's injected
    /// `RYU_CLASSIFY_LLM_URL` wins it (same rule as `local`/`LOCAL_LLM_URL`), and Core
    /// publishes that variable on EVERY gateway spawn — so on a Core-spawned gateway
    /// this field is overwritten at load and has no effect. Repointing the tier on
    /// such a node is done from Core's environment instead. The env overlay in
    /// [`GatewayConfig::load`] carries the full reasoning, including why the
    /// alternative (file-wins) could not be made safe across the two processes.
    ///
    /// The env-overwritten slot is never persisted, and the operator's own table is
    /// restored before anything is written
    /// ([`GatewayConfig::strip_env_injected_classify_provider`]).
    #[serde(default = "classify_base_url")]
    pub base_url: String,
}

/// Profile-aware so a standalone dev gateway (`RYU_PROFILE=dev`) reaches the dev
/// classifier on `:9083` rather than the release one on `:8083` — the same
/// reasoning as [`default_bind`]. This default is what a bare
/// `[providers.classify]` table resolves to, and the standalone gateway is the one
/// that reaches it: a Core-spawned gateway is handed an already-offset
/// `RYU_CLASSIFY_LLM_URL`, which overwrites the slot at load.
pub(super) fn classify_base_url() -> String {
    format!(
        "http://127.0.0.1:{}/v1",
        crate::profile::port(DEFAULT_CLASSIFY_PORT)
    )
}

/// Make the resolved classify-tier model id route to the `classify` provider by
/// seeding an **exact** `routing.model_map` entry for it.
///
/// Why this is needed at all, given the `"gemma-3-270m"` built-in prefix: the
/// prefix table is a compile-time constant, so it cannot follow a registry
/// override (`RYU_LOCAL_CLASSIFIER_MODEL_ID` → [`ENV_CLASSIFY_MODEL_ID`]). Without
/// this seed, an operator who coherently swapped BOTH the registry id and
/// `inspector.model` got: no exact hit, no prefix hit, fall through to
/// `default_provider` — i.e. the classifier id shipped to OpenAI/Anthropic, a 400,
/// and an inspector failing open in silence, while Core still started the sidecar
/// nobody then called.
///
/// It also hardens the DEFAULT id, which is why the seed is unconditional rather
/// than override-only: `RoutingTables::route` evaluates the user `model_map`
/// (exact, then longest prefix) BEFORE the built-in table, so a pre-existing user
/// mapping like `gemma` → `openrouter` silently sent the guardrail classifier to a
/// paid hosted provider. An exact entry wins step 1, ahead of that prefix scan.
///
/// `or_insert` semantics: an operator's **explicit exact** entry for the classify
/// id is deliberate and still wins.
///
/// The seeded row is DERIVED, not configuration, so it must never be served or
/// saved. The inserted key is RETURNED (`None` when nothing was inserted) for
/// [`GatewayConfig::seeded_classify_model`] to record, and removed again by
/// [`GatewayConfig::strip_seeded_classify_route`] on both of those paths.
/// (The ideal fix seeds at route-resolution time so the config is never touched at
/// all, but the `RoutingConfig` → `ryu_gw_router::RoutingTables` lowering lives in
/// `router/mod.rs::ModelRouter::new`, outside this change's file scope.)
///
/// That makes routing correctness depend on the seed being re-applied on every
/// `load()`, upstream of every router. Verified, not assumed: `main.rs:85` builds
/// the process config with [`GatewayConfig::load`] and hands it to
/// `AppState::new` (`main.rs:143`), whose `state.rs:275`
/// `RouterRegistry::new(config.routing.clone())` is the only production
/// `ModelRouter` construction — the other `RouterRegistry::new` call sites in
/// `state.rs` are `#[cfg(test)]` constructors. A `PUT /v1/config` cannot break this
/// either: `model_map` is a restart-only startup snapshot, so the running router
/// keeps the seeded tables until the next boot re-seeds them. (One pre-existing gap
/// is unchanged: if `load()` *errors*, `main` falls back to
/// `GatewayConfig::default()`, which has no seed — and no operator config either.)
pub(super) fn seed_classify_route(routing: &mut RoutingConfig, model_id: &str) -> Option<String> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return None;
    }
    let mut inserted = false;
    routing
        .model_map
        .entry(model_id.to_owned())
        .or_insert_with(|| {
            inserted = true;
            ModelMapping {
                provider: ProviderId::from(CLASSIFY_PROVIDER_ID),
                provider_model: None,
            }
        });
    // Only OUR insert is reported. A row that was already there — an operator's entry,
    // or an alias a pre-fix gateway persisted — stays unmarked and is therefore never
    // stripped from the file or the view.
    inserted.then(|| model_id.to_owned())
}

/// Registry id of the classify provider. Must match the id
/// `ProviderRegistry::register_as` aliases the classify tier under, and the
/// `("gemma-3-270m", "classify")` row in `ryu_gw_router::builtin_prefixes`.
///
/// `pub(crate)` for `firewall::inspector`, which compares a routed decision's
/// provider against it to tell "the local classify tier is not running" apart from
/// "the upstream returned an error" — one id, so those two cannot drift.
pub(crate) const CLASSIFY_PROVIDER_ID: &str = "classify";

/// Registry ids of the segregated credit-pool supplies. Named constants rather
/// than repeated literals because THREE places must agree on each string or money
/// lands in the wrong donor account: the `register_as` id in
/// [`crate::providers::ProviderRegistry::new`], the pool table in
/// [`crate::credit_pools`], and `CREDIT_POOLS[*].gatewayProviders` over in
/// `packages/auth/src/lib/credit-pools.ts`. Only the last one is out of the
/// compiler's reach; these consts remove the other two failure modes.
///
/// They are also the strings `apps/desktop/src/lib/provider-brand.tsx` matches on
/// to render the vendor marks, so renaming one is a UI change too.
pub(crate) const CLOUDFLARE_PROVIDER_ID: &str = "cloudflare";
pub(crate) const BEDROCK_PROVIDER_ID: &str = "bedrock";
pub(crate) const VERTEX_PROVIDER_ID: &str = "vertex";

/// Registry id of the DONATED OpenAI supply — note the suffix, and do not "tidy"
/// it to `"openai"`.
///
/// Every other pool got to name itself after its vendor because no BYOK slot
/// claimed that id first. OpenAI is the exception: `"openai"` is already the
/// pass-through slot serving callers' own keys, and it must stay UNTAGGED so its
/// spend keeps falling through to subscription/top-up. Collapsing the two ids
/// would make `pool_for_gateway_provider("openai")` return a pool, and from then
/// on every BYOK request would silently debit the donated grant.
pub(crate) const OPENAI_CREDITS_PROVIDER_ID: &str = "openai-credits";

/// Registry id of Ryu's own first-party Anthropic supply. Suffixed for the same
/// reason as [`OPENAI_CREDITS_PROVIDER_ID`]: `"anthropic"` is the untagged BYOK
/// slot and must never draw a pool-restricted grant.
pub(crate) const ANTHROPIC_CREDITS_PROVIDER_ID: &str = "anthropic-credits";
