//! Stage-backend selection and the stores built beside the audit database.

use super::*;

/// The Gateway component key's content cipher for one store, or why it is
/// unavailable. Tests get the fixed test key the config fixtures use.
pub(super) fn gateway_content_cipher(store: &str) -> Result<ryu_crypto::ContentCipher, String> {
    #[cfg(test)]
    crate::config::test_config_path::ensure_test_seal_key();
    ryu_crypto::component_cipher_for_process(ryu_crypto::components::GATEWAY)
        .map(|component| component.content_cipher(store))
        .map_err(|error| error.to_string())
}

/// Spend counters stored as `spend.db` beside the audit database, or in
/// memory when auditing is disabled (no durable store exists to sit beside).
pub(super) fn spend_store_beside(
    audit_db_path: Option<&str>,
) -> Result<Arc<dyn crate::budget::SpendStore>, String> {
    let Some(audit_db_path) = audit_db_path else {
        return Ok(Arc::new(crate::budget::MemorySpendStore::new()));
    };
    let path = std::path::Path::new(audit_db_path).with_file_name(crate::budget::SPEND_STORE);
    // Subject ids are stored as blind tokens under the Gateway component key;
    // without that key (or under another one) the store opens unhealthy and
    // metered requests are refused rather than counted from zero.
    let seal = gateway_spend_seal();
    Ok(Arc::new(crate::budget::SqliteSpendStore::open(
        &path, seal,
    )?))
}

/// The Gateway component key's seal for `spend.db` subjects.
pub(super) fn gateway_spend_seal() -> Result<crate::budget::SpendSeal, String> {
    #[cfg(test)]
    crate::config::test_config_path::ensure_test_seal_key();
    let component = ryu_crypto::component_cipher_for_process(ryu_crypto::components::GATEWAY)
        .map_err(|error| error.to_string())?;
    Ok(crate::budget::SpendSeal::new(
        component.content_cipher(crate::budget::SPEND_STORE),
        component.blind_index(crate::budget::SPEND_STORE, crate::budget::SUBJECT_FIELD),
    ))
}

/// Apply one inverted stage's config-selected active backend, failing closed
/// when the id is not registered (W6a). An empty `available` set is an
/// intentionally-disabled stage (semantic_cache when off): a default `"builtin"`
/// request is a no-op, any other id is an error. Otherwise `apply(id)` runs the
/// registry's `set_active`, and a `false` return (unknown id) becomes a
/// startup-refusing error that lists the registered ids so a typo is diagnosable.
pub(super) fn select_stage_backend(
    stage: &str,
    requested: &str,
    available: Vec<String>,
    apply: impl FnOnce(&str) -> bool,
) -> Result<(), String> {
    if available.is_empty() {
        if requested == crate::config::default_stage_backend() {
            return Ok(());
        }
        return Err(format!(
            "gateway stage '{stage}': backend '{requested}' is not registered \
             (stage is disabled; no backends available)"
        ));
    }
    if apply(requested) {
        Ok(())
    } else {
        Err(format!(
            "gateway stage '{stage}': unknown backend '{requested}'; \
             registered backends: [{}]",
            available.join(", ")
        ))
    }
}

/// Register the `"redis"` exact/semantic cache backends when a Redis URL is
/// configured (`RYU_GATEWAY_REDIS_URL`), and build the `/v1/embeddings` cache.
/// Runs before [`apply_stage_backends`], so `[backends] cache = "redis"` (or
/// `semantic_cache = "redis"`) selects them and an unset URL fails closed with
/// the registered ids listed. The semantic backend registers only when the
/// semantic cache is enabled, keeping a disabled stage's registry empty.
pub(super) fn build_redis_caches(
    config: &GatewayConfig,
    redis_url: Option<&str>,
    cache: &mut CacheRegistry,
    semantic_cache: &mut SemanticCacheRegistry,
) -> Result<Option<ryu_gw_cache::EmbeddingCache>, String> {
    use ryu_gw_cache::{RedisExactCache, RedisSemanticCache, REDIS_BACKEND_ID};

    let client = redis_url
        .map(|url| config.redis_cache.client(url))
        .transpose()?;
    if let Some(client) = &client {
        cache.register(
            REDIS_BACKEND_ID,
            Arc::new(RedisExactCache::new(
                Arc::clone(client),
                &config.redis_cache,
                &config.cache,
            )),
        );
        if config.semantic_cache.enabled {
            semantic_cache.register(
                REDIS_BACKEND_ID,
                Arc::new(RedisSemanticCache::new(
                    Arc::clone(client),
                    &config.redis_cache,
                    config.semantic_cache.clone(),
                    config.cache.ttl_secs,
                    config.cache.max_entries,
                )),
            );
        }
    }
    ryu_gw_cache::EmbeddingCache::from_config(
        &config.embedding_cache,
        client
            .as_ref()
            .map(|client| (Arc::clone(client), config.redis_cache.key_prefix.as_str())),
    )
}

/// Apply the per-stage backend selection to freshly-built registries, failing
/// closed on any unknown id. Shared by [`AppState::new`] and `new_for_test` so
/// the two constructors cannot drift. Budget's registry hot-swaps through
/// `&self`; the rest take `&mut self`, so this runs during construction on owned
/// locals before they move into `AppState`.
#[allow(clippy::too_many_arguments)]
pub(super) fn apply_stage_backends(
    cfg: &crate::config::StageBackendsConfig,
    budget: &BudgetRegistry,
    cache: &mut CacheRegistry,
    semantic_cache: &mut SemanticCacheRegistry,
    audit: &mut AuditRegistry,
    evals: &mut EvalsRegistry,
    circuit_breaker: &mut CircuitBreakerRegistry,
    rate_limiter: &mut RateLimiterRegistry,
    firewall: &FirewallRegistry,
    router: &RouterRegistry,
    smart_router: &SmartRouterRegistry,
    passthrough: &PassthroughRegistry,
) -> Result<(), String> {
    let avail = budget.available();
    select_stage_backend("budget", &cfg.budget, avail, |id| budget.set_active(id))?;
    let avail = cache.available();
    select_stage_backend("cache", &cfg.cache, avail, |id| cache.set_active(id))?;
    let avail = semantic_cache.available();
    select_stage_backend("semantic_cache", &cfg.semantic_cache, avail, |id| {
        semantic_cache.set_active(id)
    })?;
    let avail = audit.available();
    select_stage_backend("audit", &cfg.audit, avail, |id| audit.set_active(id))?;
    let avail = evals.available();
    select_stage_backend("evals", &cfg.evals, avail, |id| evals.set_active(id))?;
    let avail = circuit_breaker.available();
    select_stage_backend("circuit_breaker", &cfg.circuit_breaker, avail, |id| {
        circuit_breaker.set_active(id)
    })?;
    let avail = rate_limiter.available();
    select_stage_backend("rate_limit", &cfg.rate_limit, avail, |id| {
        rate_limiter.set_active(id)
    })?;
    // W6c: the four newly-inverted stages, same fail-closed selection. These
    // registries carry their own internal RwLock, so `set_active` takes `&self`.
    let avail = firewall.available();
    select_stage_backend("firewall", &cfg.firewall, avail, |id| {
        firewall.set_active(id)
    })?;
    let avail = router.available();
    select_stage_backend("router", &cfg.router, avail, |id| router.set_active(id))?;
    let avail = smart_router.available();
    select_stage_backend("smart_router", &cfg.smart_router, avail, |id| {
        smart_router.set_active(id)
    })?;
    let avail = passthrough.available();
    select_stage_backend("passthrough", &cfg.passthrough, avail, |id| {
        passthrough.set_active(id)
    })?;
    Ok(())
}
