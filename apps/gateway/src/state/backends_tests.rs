use super::{apply_stage_backends, select_stage_backend, AppState};
use crate::cache::{CacheBackend, CacheRegistry};
use crate::config::{GatewayConfig, StageBackendsConfig};
use serde_json::{json, Value};
use std::sync::Arc;

/// A cache backend that answers every `get` with a fixed sentinel â€” proof the
/// config-selected backend actually becomes active (not just registered).
struct StubCache;
impl CacheBackend for StubCache {
    fn get(&self, _key: &str) -> Option<Value> {
        Some(json!({ "stub": true }))
    }
    fn insert(&self, _key: String, _response: Value) {}
    fn evict_expired(&self) {}
}

/// The default config (all `"builtin"`) builds successfully and every inverted
/// stage is left on its built-in backend â€” the field is read and applied, not
/// ignored.
#[test]
fn default_config_selects_builtin_for_every_stage() {
    let mut config = GatewayConfig::default();
    config.audit.enabled = false;
    let state = AppState::new(config).expect("default stage backends must build");
    assert_eq!(state.cache.active_id(), CacheRegistry::BUILTIN);
    assert_eq!(state.budget.active_id().as_str(), "builtin");
    // W6c: the four newly-inverted stages are read + applied to their built-in.
    assert_eq!(state.firewall.active_id().as_str(), "builtin");
    assert_eq!(
        state
            .provider_runtime
            .snapshot()
            .router
            .active_id()
            .as_str(),
        "builtin"
    );
    assert_eq!(state.smart_router.active_id().as_str(), "builtin");
    assert_eq!(state.passthrough.active_id().as_str(), "builtin");
}

#[test]
fn audit_storage_open_failure_refuses_state_creation() {
    let path = std::env::temp_dir().join(format!("ryu-audit-init-dir-{}", std::process::id()));
    std::fs::create_dir_all(&path).expect("create test directory");
    let mut config = GatewayConfig::default();
    config.audit.enabled = true;
    config.audit.db_path = path.to_string_lossy().into_owned();

    let error = match AppState::new(config) {
        Err(error) => error,
        Ok(_) => panic!("audit directory must not become disabled audit"),
    };
    assert!(error.contains("audit initialization failed"), "{error}");

    std::fs::remove_dir(&path).expect("remove test directory");
}

/// A config that names a backend NOT registered in a stage's registry refuses
/// the whole build (fail-closed), and the error names the stage + the
/// registered ids so a typo is diagnosable.
#[test]
fn unknown_stage_backend_refuses_build() {
    let mut config = GatewayConfig::default();
    config.audit.enabled = false;
    config.backends.cache = "ghost".to_string();
    // `AppState` is not `Debug`, so match rather than `expect_err`.
    let err = match AppState::new(config) {
        Err(e) => e,
        Ok(_) => panic!("unknown backend must refuse startup"),
    };
    assert!(err.contains("cache"), "error names the stage: {err}");
    assert!(err.contains("ghost"), "error names the bad id: {err}");
    assert!(err.contains("builtin"), "error lists registered ids: {err}");
}

/// The config value drives `set_active` to a *registered non-builtin* backend:
/// register a stub under `"stub"`, name it in the config, and the applied
/// registry dispatches to the stub.
#[test]
fn config_selects_a_registered_backend() {
    let mut cache = CacheRegistry::new(crate::config::CacheConfig::default());
    cache.register("stub", Arc::new(StubCache) as Arc<dyn CacheBackend>);
    let budget = crate::budget::BudgetRegistry::new(crate::config::BudgetConfig::default());
    let mut semantic_cache = crate::semantic_cache::SemanticCacheRegistry::disabled();
    let mut audit = crate::audit::AuditRegistry::from_logger(Default::default());
    let mut evals = crate::evals::EvalsRegistry::new(crate::config::EvalsConfig::default());
    let mut circuit_breaker =
        crate::circuit_breaker::CircuitBreakerRegistry::new(Default::default());
    let mut rate_limiter = crate::rate_limit::RateLimiterRegistry::new(Default::default());
    let firewall = crate::firewall::FirewallRegistry::new(crate::config::FirewallConfig::default());
    let router = crate::router::RouterRegistry::new(crate::config::RoutingConfig::default());
    let smart_router = crate::router::smart::SmartRouterRegistry::new(
        crate::config::SmartRoutingConfig::default(),
    );
    let passthrough = crate::passthrough::PassthroughRegistry::new();

    let mut cfg = StageBackendsConfig::default();
    cfg.cache = "stub".to_string();
    apply_stage_backends(
        &cfg,
        &budget,
        &mut cache,
        &mut semantic_cache,
        &mut audit,
        &mut evals,
        &mut circuit_breaker,
        &mut rate_limiter,
        &firewall,
        &router,
        &smart_router,
        &passthrough,
    )
    .expect("a registered id must be accepted");

    assert_eq!(cache.active_id(), "stub");
    assert_eq!(cache.get("any-key"), Some(json!({ "stub": true })));
}

/// The disabled-stage edge (semantic_cache when off): an empty registry accepts
/// only the default `"builtin"` no-op; any other id is refused.
#[test]
fn disabled_stage_accepts_only_default_builtin() {
    assert!(select_stage_backend("semantic_cache", "builtin", vec![], |_| false).is_ok());
    let err = select_stage_backend("semantic_cache", "redis", vec![], |_| false)
        .expect_err("non-default id on a disabled stage must be refused");
    assert!(
        err.contains("semantic_cache") && err.contains("redis"),
        "{err}"
    );
}

/// A Redis URL registers the `"redis"` exact backend (and the semantic one
/// only when that stage is enabled) so `[backends]` can select it; without a
/// URL selecting `"redis"` fails closed. Client construction is lazy, so no
/// server is contacted here.
#[test]
fn redis_url_registers_selectable_cache_backends() {
    use super::build_redis_caches;
    use crate::semantic_cache::{SemanticCache, SemanticCacheRegistry};

    let mut config = crate::config::GatewayConfig::default();
    let mut cache = CacheRegistry::new(config.cache.clone());
    let mut semantic = SemanticCacheRegistry::disabled();
    let embedding = build_redis_caches(
        &config,
        Some("redis://127.0.0.1:1/0"),
        &mut cache,
        &mut semantic,
    )
    .expect("valid redis settings");
    assert!(embedding.is_none(), "embedding cache is off by default");
    assert_eq!(cache.available(), vec!["builtin", "redis"]);
    assert!(semantic.available().is_empty());
    assert!(cache.set_active("redis"));

    config.semantic_cache.enabled = true;
    let mut cache = CacheRegistry::new(config.cache.clone());
    let mut semantic = SemanticCacheRegistry::from_cache(SemanticCache::new(
        config.semantic_cache.clone(),
        60,
        10,
    ));
    build_redis_caches(
        &config,
        Some("redis://cache:6379"),
        &mut cache,
        &mut semantic,
    )
    .expect("valid redis settings");
    assert_eq!(semantic.available(), vec!["builtin", "redis"]);

    let mut cache = CacheRegistry::new(config.cache.clone());
    let mut semantic = SemanticCacheRegistry::disabled();
    build_redis_caches(&config, None, &mut cache, &mut semantic).expect("no redis");
    let err = select_stage_backend("cache", "redis", cache.available(), |id| {
        cache.set_active(id)
    })
    .expect_err("redis is not registered without a URL");
    assert!(err.contains("builtin"), "{err}");
}

/// `[embedding_cache]` builds the memory store without Redis and refuses the
/// Redis store when no URL is configured.
#[test]
fn embedding_cache_is_built_from_config() {
    use super::build_redis_caches;
    use crate::semantic_cache::SemanticCacheRegistry;

    let mut config = crate::config::GatewayConfig::default();
    config.embedding_cache.enabled = true;
    let mut cache = CacheRegistry::new(config.cache.clone());
    let mut semantic = SemanticCacheRegistry::disabled();
    let built = build_redis_caches(&config, None, &mut cache, &mut semantic)
        .expect("memory store needs no redis");
    assert_eq!(built.expect("enabled").stats().backend, "memory");

    config.embedding_cache.backend = "redis".to_owned();
    let err = build_redis_caches(&config, None, &mut cache, &mut semantic)
        .err()
        .expect("redis store without a URL is refused");
    assert!(err.contains(ryu_gw_cache::REDIS_URL_ENV), "{err}");

    config.redis_cache.key_prefix = "bad prefix".to_owned();
    assert!(build_redis_caches(&config, Some("redis://x"), &mut cache, &mut semantic).is_err());
}
