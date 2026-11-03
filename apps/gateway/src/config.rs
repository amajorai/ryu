use serde::{Deserialize, Serialize};
use std::collections::HashMap;

mod provider_environment;
pub(crate) use provider_environment::ProviderEnvironment;
mod screening;
pub use screening::{ScreeningBackendConfig, ScreeningBackendKind, ScreeningConfig};

pub use crate::security_contact::PublicContactConfig;

// The budget config value-types moved to the extracted `ryu-gw-budget` stage
// crate; `AlertTier` (a cross-stage type used by firewall too) moved to
// `ryu-gw-contracts`. Re-exported here so every `crate::config::{AlertTier,
// Budget*, ExecBudget*}` path — and `GatewayConfig`'s `budgets` / `exec_budget`
// fields below — stay byte-unchanged.
pub use ryu_gw_budget::{BudgetAction, BudgetConfig, ExecBudgetAction, ExecBudgetConfig};
// `BudgetRule` / `SessionBudgetConfig` have no production caller today (config
// deserializes the whole `BudgetConfig`); they are re-exported to keep the
// stable `crate::config::{BudgetRule,SessionBudgetConfig}` path and are
// referenced by the config tests via `super::`. Kept for API-path stability.
#[allow(unused_imports)]
pub use ryu_gw_budget::{BudgetChargeInclusion, BudgetRule, SessionBudgetConfig};
pub use ryu_gw_contracts::AlertTier;

// The evals config value-type moved to the extracted `ryu-gw-evals` stage crate.
// Re-exported here so every `crate::config::EvalsConfig` path — and
// `GatewayConfig`'s `evals` field below — stays byte-unchanged.
pub use ryu_gw_evals::EvalsConfig;

// The audit config value-type moved to the extracted `ryu-gw-audit` stage crate.
// Re-exported here so every `crate::config::AuditConfig` path — and
// `GatewayConfig`'s `audit` field below — stays byte-unchanged.
pub use ryu_gw_audit::AuditConfig;

// The cache config value-types moved to the extracted `ryu-gw-cache` stage crate
// (co-located with the `Cache` / `SemanticCache` backends they configure).
// Re-exported here so every `crate::config::{CacheConfig, SemanticCacheConfig}`
// path — and `GatewayConfig`'s `cache` / `semantic_cache` fields below — stays
// byte-unchanged.
pub use ryu_gw_cache::{CacheConfig, EmbeddingCacheConfig, RedisCacheConfig, SemanticCacheConfig};

// The config is split by responsibility; every item stays reachable at its
// `crate::config::` path through these re-exports.
mod auth;
mod channel_platforms;
mod channels;
mod channels_env;
mod config_file;
mod control_plane;
mod credits;
mod credits_billing;
mod egress;
mod env_vars;
mod firewall;
mod gateway;
mod hosted_providers;
mod inspector;
mod integrations;
mod load;
mod load_channels;
mod load_runtime;
mod local_providers;
mod phone_calls;
mod prompt_cache;
mod provider_id;
mod provider_llm;
mod provider_media;
mod providers;
mod routing;
mod routing_rules;
mod sandbox;
mod services;
mod smart_routing;
mod stage_backends;
mod tools;
mod vault_keys;
mod vault_keys_cloud;
mod vault_replace;

pub use auth::*;
pub use channel_platforms::*;
pub use channels::*;
use channels_env::*;
pub use control_plane::*;
pub use credits::*;
pub use egress::*;
use env_vars::*;
pub use firewall::*;
pub use gateway::*;
pub use hosted_providers::*;
pub use inspector::*;
pub use integrations::*;
use load_channels::*;
use load_runtime::*;
pub use local_providers::*;
pub use phone_calls::*;
pub use prompt_cache::*;
pub use provider_id::*;
pub use provider_llm::*;
pub use provider_media::*;
pub use providers::*;
pub use routing::*;
pub use routing_rules::*;
pub use sandbox::*;
pub use services::*;
pub use smart_routing::*;
pub use stage_backends::*;
pub use tools::*;

/// Test-only isolation for the process-global `GATEWAY_CONFIG` variable.
///
/// [`GatewayConfig::config_path`] falls back to the machine's REAL
/// `<config>/ryu/gateway.toml` when the var is unset, so any test that reaches
/// `load()` / `save()` / `config_path()` — directly or through a handler like
/// `api::config::get_config` — otherwise reads (or writes!) developer state and
/// becomes host-dependent. Every such test takes this guard.
///
/// `pub(crate)` and mutex-backed on purpose: the whole crate's unit tests share one
/// process, so `api::config`'s tests and `config`'s tests would race each other over
/// this one variable if each rolled its own window. One lock, one owner at a time.
#[cfg(test)]
pub(crate) mod test_config_path {
    /// Give the test binary a fixed master key so authored writes can seal
    /// `gateway.toml` secrets (production gets its key from Core or
    /// `RYU_MASTER_KEY`). Same constant across tests, so every sealed fixture opens.
    pub(crate) fn ensure_test_seal_key() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            // base64 of [7u8; 32]
            std::env::set_var(
                "RYU_MASTER_KEY",
                "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
            );
        });
    }

    /// RAII window in which `GATEWAY_CONFIG` points at a private temp file.
    ///
    /// Restores the prior value and deletes the temp directory on drop, so a panicking
    /// test cannot leak the variable pointing at a directory that no longer exists —
    /// which would silently redirect every later test in the binary.
    pub(crate) struct ConfigPathGuard {
        dir: std::path::PathBuf,
        path: std::path::PathBuf,
        prior: Option<std::ffi::OsString>,
        /// Declared LAST so field-drop order releases the lock only after the
        /// variable is restored and the directory is gone.
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl ConfigPathGuard {
        /// Point `GATEWAY_CONFIG` at `gateway.toml` in a fresh, uniquely named temp
        /// directory. `tag` only makes the path readable while debugging; uniqueness
        /// comes from the pid plus a monotonic counter, so repeated guards in one run
        /// never collide (nor with a parallel `cargo test` of another crate).
        pub(crate) fn isolated(tag: &str) -> Self {
            static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            // A poisoned lock means an earlier guarded test panicked; the env was
            // still restored by its `Drop`, so the window is safe to re-enter.
            let lock = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            ensure_test_seal_key();
            let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("ryu-gwcfg-{tag}-{}-{seq}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp gateway config dir");
            let path = dir.join("gateway.toml");
            let prior = std::env::var_os("GATEWAY_CONFIG");
            std::env::set_var("GATEWAY_CONFIG", &path);
            Self {
                dir,
                path,
                prior,
                _lock: lock,
            }
        }

        /// The `gateway.toml` the window points at. It does not exist until something
        /// writes it, which is the "fresh node" case.
        pub(crate) fn path(&self) -> &std::path::Path {
            &self.path
        }
    }

    impl Drop for ConfigPathGuard {
        fn drop(&mut self) {
            match self.prior.take() {
                Some(prior) => std::env::set_var("GATEWAY_CONFIG", prior),
                None => std::env::remove_var("GATEWAY_CONFIG"),
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

#[cfg(test)]
#[path = "config/tests/sealed_secret_tests.rs"]
mod sealed_secret_tests;

#[cfg(test)]
#[path = "config/tests/marketplace_recommendations_config_tests.rs"]
mod marketplace_recommendations_config_tests;

#[cfg(test)]
#[path = "config/tests/computer_use_config_tests.rs"]
mod computer_use_config_tests;

#[cfg(test)]
#[path = "config/tests/local_embed_endpoint_tests.rs"]
mod local_embed_endpoint_tests;

#[cfg(test)]
#[path = "config/tests/admin_key_env_tests.rs"]
mod admin_key_env_tests;

#[cfg(test)]
#[path = "config/tests/prompt_cache_config_tests.rs"]
mod prompt_cache_config_tests;

#[cfg(test)]
#[path = "config/tests/provider_id_tests.rs"]
mod provider_id_tests;

#[cfg(test)]
#[path = "config/tests/capacity_config_tests.rs"]
mod capacity_config_tests;

#[cfg(test)]
#[path = "config/tests/local_model_routes_tests.rs"]
mod local_model_routes_tests;

#[cfg(test)]
#[path = "config/tests/alert_tier_backcompat_tests.rs"]
mod alert_tier_backcompat_tests;

#[cfg(test)]
#[path = "config/tests/pure_helper_tests.rs"]
mod pure_helper_tests;

#[cfg(test)]
#[path = "config/tests/managed_openrouter_privacy_tests.rs"]
mod managed_openrouter_privacy_tests;

#[cfg(test)]
#[path = "config/tests/reaction_learning_config_tests.rs"]
mod reaction_learning_config_tests;

#[cfg(test)]
#[path = "config/tests/channel_config_tests.rs"]
mod channel_config_tests;

#[cfg(test)]
#[path = "config/tests/toml_roundtrip_tests.rs"]
mod toml_roundtrip_tests;

#[cfg(test)]
#[path = "config/tests/classify_tier_tests.rs"]
mod classify_tier_tests;

#[cfg(test)]
#[path = "config/tests/authenticated_bootstrap_tests.rs"]
mod authenticated_bootstrap_tests;

#[cfg(test)]
#[path = "config/tests/provider_environment_tests.rs"]
mod provider_environment_tests;

#[cfg(test)]
#[path = "config/tests/assemblyai_config_tests.rs"]
mod assemblyai_config_tests;

#[cfg(test)]
#[path = "config/tests/openrouter_attribution_tests.rs"]
mod openrouter_attribution_tests;

#[cfg(test)]
#[path = "config/tests/route_pool_tests.rs"]
mod route_pool_tests;

#[cfg(test)]
#[path = "config/tests/api_key_purpose_tests.rs"]
mod api_key_purpose_tests;

#[cfg(test)]
#[path = "config/tests/phone_calls_config_tests.rs"]
mod phone_calls_config_tests;

#[cfg(test)]
#[path = "config/tests/split_paths_tests.rs"]
mod split_paths_tests;
