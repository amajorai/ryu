//! Node-tier hazard screener endpoints (managed guardrails screener addendum,
//! build step G6).
//!
//! A self-hosted node can run its own content screener. It is the node's own
//! policy, screened at node tier: Ryu's platform floor binds only the hosted
//! fleet and never a self-hosted or bring-your-own-key node. This module
//! decides which screener endpoints Core publishes to the Gateway it spawns,
//! the same way the classify tier is published (`sidecar::gateway`).
//!
//! **Off by default.** Nothing is published and nothing is started until the
//! operator sets [`ENV_NODE_SCREENER`]. Even then the Gateway screens nothing
//! until its own `[screening]` section sets `node_classifiers = true` and a
//! backend table names these variables through `base_url_env`, `model_env`
//! and `weights_sha256_env`.
//!
//! Two kinds, both behind the Gateway's one `ScreenerBackend` trait:
//!
//! - **`decision`, the default kind.** A local closed-choice decision model on
//!   the TypeSafe `systemone` wire (Kev, Ollaya, or any compatible server). Core
//!   ships no systemone server of its own and does not spawn one: Kev and Ollaya
//!   are operator-run, and Laya is a plugin whose sidecar is reached only
//!   through Core's authenticated ext-proxy, never keyless loopback. So Core
//!   reserves a loopback port ([`DECISION_SCREENER_PORT_BASE`]) for the
//!   operator to bind their server to, points the default URL at it, and
//!   publishes the model id and the weights hash the operator supplies. The
//!   Gateway refuses a local decision backend without a pinned hash.
//! - **`guard`.** A guard model served by Core's opt-in `llamacpp-guard`
//!   sidecar (`providers::llamacpp::guard`), started here when the kind is
//!   enabled, or an external engine the operator names.
//!
//! A remote decision API (Jev) is never configured here. It is a separate,
//! explicit `decision_remote` table in the Gateway's own configuration.

use std::sync::Arc;

use crate::sidecar::providers::llamacpp::guard::{guard_base_url, GUARD_SIDECAR_NAME};

/// The operator's opt-in, read from Core's environment. A comma-separated
/// list of kinds: `decision`, `guard`, or `on` (the default kind, `decision`).
/// Unset, empty, `off`, `0` or `false` turns the node screener off.
pub const ENV_NODE_SCREENER: &str = "RYU_NODE_SCREENER";

/// Published to the Gateway: the decision model's full systemone URL.
/// Also read from Core's environment as the operator's override.
pub const ENV_SCREENER_DECISION_URL: &str = "RYU_SCREENER_DECISION_URL";
/// Published to the Gateway: the decision model id. Override in Core's env.
pub const ENV_SCREENER_DECISION_MODEL: &str = "RYU_SCREENER_DECISION_MODEL";
/// Published to the Gateway: the decision model's weights sha256. Supplied by
/// the operator in Core's env; Core has no way to know it.
pub const ENV_SCREENER_DECISION_SHA256: &str = "RYU_SCREENER_DECISION_SHA256";
/// Published to the Gateway: the guard engine's OpenAI-compatible base URL.
/// Set in Core's env, it names an external engine and Core starts no sidecar.
pub const ENV_SCREENER_GUARD_URL: &str = "RYU_SCREENER_GUARD_URL";
/// Published to the Gateway: the guard model id.
pub const ENV_SCREENER_GUARD_MODEL: &str = "RYU_SCREENER_GUARD_MODEL";
/// Published to the Gateway: the guard model's weights sha256.
pub const ENV_SCREENER_GUARD_SHA256: &str = "RYU_SCREENER_GUARD_SHA256";

/// Canonical (release) loopback port reserved for the node's systemone
/// decision server. Profile-aware like every Core port (dev 9099). Reserved in
/// the plugin manifest port check so no manifest sidecar can take it.
pub const DECISION_SCREENER_PORT_BASE: u16 = 8099;

/// The decision model id published when the operator names none. Ollaya's
/// default alias for the Laya model.
pub const DEFAULT_DECISION_SCREENER_MODEL: &str = "laya";

/// Profile-aware decision screener port.
pub fn decision_screener_port() -> u16 {
    crate::profile::port(DECISION_SCREENER_PORT_BASE)
}

/// The default systemone URL on the reserved port.
pub fn default_decision_screener_url() -> String {
    format!("http://127.0.0.1:{}/v1/systemone", decision_screener_port())
}

/// Which screener kinds the operator enabled on this node.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NodeScreenerKinds {
    pub decision: bool,
    pub guard: bool,
}

impl NodeScreenerKinds {
    pub fn is_off(self) -> bool {
        !self.decision && !self.guard
    }
}

/// Parse [`ENV_NODE_SCREENER`]. Unknown tokens are ignored with a warning, so
/// a typo never turns on a kind the operator did not name.
pub fn parse_kinds(raw: Option<&str>) -> NodeScreenerKinds {
    let mut kinds = NodeScreenerKinds::default();
    let Some(raw) = raw else {
        return kinds;
    };
    for token in raw
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        match token.to_ascii_lowercase().as_str() {
            "off" | "0" | "false" | "no" | "none" => {}
            "on" | "1" | "true" | "yes" | "default" | "decision" | "decision_local" => {
                kinds.decision = true;
            }
            "guard" | "guard_model" => kinds.guard = true,
            other => tracing::warn!(
                value = other,
                "{ENV_NODE_SCREENER}: unknown screener kind ignored (use decision or guard)"
            ),
        }
    }
    kinds
}

fn non_empty(lookup: &dyn Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    lookup(key)
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// A weights hash the Gateway will pin: ASCII hex, at least 8 characters.
/// Anything else is dropped with a warning rather than published.
fn pinned_hash(raw: Option<String>, key: &str) -> Option<String> {
    let raw = raw?;
    if raw.len() >= 8 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(raw.to_ascii_lowercase());
    }
    tracing::warn!("{key} is not a hex sha256; not published");
    None
}

/// The guard model Core's own sidecar serves: (id, sha256).
pub type GuardModel = (String, String);

/// The screener variables for the Gateway spawn env. Pure over `lookup` (Core's
/// environment) and the guard model the local sidecar would serve, so default
/// off and every published value are testable without touching the process.
pub fn screener_env_from(
    lookup: &dyn Fn(&str) -> Option<String>,
    local_guard: &dyn Fn() -> GuardModel,
) -> Vec<(String, String)> {
    let kinds = parse_kinds(lookup(ENV_NODE_SCREENER).as_deref());
    let mut env = Vec::new();
    if kinds.decision {
        let url = non_empty(lookup, ENV_SCREENER_DECISION_URL)
            .unwrap_or_else(default_decision_screener_url);
        let model = non_empty(lookup, ENV_SCREENER_DECISION_MODEL)
            .unwrap_or_else(|| DEFAULT_DECISION_SCREENER_MODEL.to_owned());
        env.push((ENV_SCREENER_DECISION_URL.to_owned(), url));
        env.push((ENV_SCREENER_DECISION_MODEL.to_owned(), model));
        match pinned_hash(
            non_empty(lookup, ENV_SCREENER_DECISION_SHA256),
            ENV_SCREENER_DECISION_SHA256,
        ) {
            Some(sha) => env.push((ENV_SCREENER_DECISION_SHA256.to_owned(), sha)),
            None => tracing::warn!(
                "node screener: the decision model has no weights hash \
                 ({ENV_SCREENER_DECISION_SHA256}); the Gateway will not build it"
            ),
        }
    }
    if kinds.guard {
        match non_empty(lookup, ENV_SCREENER_GUARD_URL) {
            // An external engine: publish only what the operator named, never
            // the local sidecar's id or hash for weights Core does not serve.
            Some(url) => match non_empty(lookup, ENV_SCREENER_GUARD_MODEL) {
                Some(model) => {
                    env.push((ENV_SCREENER_GUARD_URL.to_owned(), url));
                    env.push((ENV_SCREENER_GUARD_MODEL.to_owned(), model));
                    if let Some(sha) = pinned_hash(
                        non_empty(lookup, ENV_SCREENER_GUARD_SHA256),
                        ENV_SCREENER_GUARD_SHA256,
                    ) {
                        env.push((ENV_SCREENER_GUARD_SHA256.to_owned(), sha));
                    }
                }
                None => tracing::warn!(
                    "node screener: {ENV_SCREENER_GUARD_URL} names an external guard engine \
                     without {ENV_SCREENER_GUARD_MODEL}; the guard kind is not published"
                ),
            },
            // Core's own `llamacpp-guard` sidecar: the id and hash of the
            // weights it serves, from the same registry entry it reads.
            None => {
                let (model, sha) = local_guard();
                env.push((ENV_SCREENER_GUARD_URL.to_owned(), guard_base_url()));
                env.push((ENV_SCREENER_GUARD_MODEL.to_owned(), model));
                if let Some(sha) = pinned_hash(Some(sha), ENV_SCREENER_GUARD_SHA256) {
                    env.push((ENV_SCREENER_GUARD_SHA256.to_owned(), sha));
                }
            }
        }
    }
    env
}

fn local_guard_model() -> GuardModel {
    let model = crate::registry::local_guard_model();
    (model.id, model.sha256)
}

/// The screener variables for the Gateway Core is about to spawn.
pub fn screener_spawn_env() -> Vec<(String, String)> {
    screener_env_from(&|key| std::env::var(key).ok(), &local_guard_model)
}

/// Whether Core should start its own guard sidecar: the guard kind is on and
/// the operator did not point the guard at an external engine.
pub fn wants_local_guard(lookup: &dyn Fn(&str) -> Option<String>) -> bool {
    parse_kinds(lookup(ENV_NODE_SCREENER).as_deref()).guard
        && non_empty(lookup, ENV_SCREENER_GUARD_URL).is_none()
}

/// Fire-and-forget start of `llamacpp-guard` when the operator enabled the
/// guard kind. Called after Core spawns a local Gateway. The Gateway's guard
/// backend counts an unreachable engine as down, so a guard that is still
/// downloading or loading degrades the node screener; it never fails the
/// Gateway or a request on its own.
pub fn maybe_start_guard_tier(manager: Option<Arc<crate::sidecar::SidecarManager>>) {
    if !wants_local_guard(&|key| std::env::var(key).ok()) {
        return;
    }
    let Some(manager) = manager else {
        tracing::debug!("node screener: no sidecar manager registered; guard tier not started");
        return;
    };
    tokio::spawn(async move {
        if let Err(e) = manager.start_sidecar(GUARD_SIDECAR_NAME).await {
            tracing::warn!(
                sidecar = GUARD_SIDECAR_NAME,
                reason = %format!("{e:#}"),
                "node screener: guard tier failed to start; the Gateway treats it as down"
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const SHA: &str = "2E73A1411746E6DBD8A71B4D22DC66369044283F433B81ED6E4006CAB4AF9859";

    fn env_of(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        screener_env_from(&|key| map.get(key).cloned(), &|| {
            ("qwen3guard-test".to_owned(), "ab".repeat(32))
        })
    }

    fn get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn the_node_screener_is_off_by_default() {
        assert!(parse_kinds(None).is_off());
        for off in ["", "off", "0", "false", "none", " , "] {
            assert!(parse_kinds(Some(off)).is_off(), "{off:?}");
        }
        assert!(env_of(&[]).is_empty());
        // Endpoint values alone never turn it on.
        assert!(env_of(&[
            (
                ENV_SCREENER_DECISION_URL,
                "http://127.0.0.1:8009/v1/systemone"
            ),
            (ENV_SCREENER_DECISION_SHA256, SHA),
        ])
        .is_empty());
        assert!(!wants_local_guard(&|_| None));
    }

    #[test]
    fn on_selects_the_decision_model_the_default_kind() {
        for on in ["on", "1", "true", "decision", "DECISION_LOCAL"] {
            let kinds = parse_kinds(Some(on));
            assert_eq!(
                kinds,
                NodeScreenerKinds {
                    decision: true,
                    guard: false
                },
                "{on}"
            );
        }
        assert_eq!(
            parse_kinds(Some("decision, guard")),
            NodeScreenerKinds {
                decision: true,
                guard: true
            }
        );
        assert_eq!(
            parse_kinds(Some("guard typo")),
            NodeScreenerKinds {
                decision: false,
                guard: true
            }
        );
    }

    #[test]
    fn the_decision_kind_publishes_the_reserved_port_and_the_operator_hash() {
        let env = env_of(&[
            (ENV_NODE_SCREENER, "on"),
            (ENV_SCREENER_DECISION_SHA256, SHA),
        ]);
        assert_eq!(
            get(&env, ENV_SCREENER_DECISION_URL),
            Some(default_decision_screener_url().as_str())
        );
        assert!(default_decision_screener_url().starts_with("http://127.0.0.1:"));
        assert_eq!(
            decision_screener_port(),
            crate::profile::port(DECISION_SCREENER_PORT_BASE)
        );
        assert_eq!(get(&env, ENV_SCREENER_DECISION_MODEL), Some("laya"));
        assert_eq!(
            get(&env, ENV_SCREENER_DECISION_SHA256),
            Some(SHA.to_ascii_lowercase().as_str())
        );
        assert!(get(&env, ENV_SCREENER_GUARD_URL).is_none());
    }

    #[test]
    fn decision_overrides_win_and_a_bad_hash_is_not_published() {
        let env = env_of(&[
            (ENV_NODE_SCREENER, "decision"),
            (
                ENV_SCREENER_DECISION_URL,
                " http://127.0.0.1:8009/v1/systemone ",
            ),
            (ENV_SCREENER_DECISION_MODEL, "kev-latest"),
            (ENV_SCREENER_DECISION_SHA256, "not-a-hash"),
        ]);
        assert_eq!(
            get(&env, ENV_SCREENER_DECISION_URL),
            Some("http://127.0.0.1:8009/v1/systemone")
        );
        assert_eq!(get(&env, ENV_SCREENER_DECISION_MODEL), Some("kev-latest"));
        assert!(get(&env, ENV_SCREENER_DECISION_SHA256).is_none());
    }

    #[test]
    fn the_guard_kind_publishes_core_s_own_sidecar() {
        let env = env_of(&[(ENV_NODE_SCREENER, "guard")]);
        assert_eq!(
            get(&env, ENV_SCREENER_GUARD_URL),
            Some(guard_base_url().as_str())
        );
        assert_eq!(get(&env, ENV_SCREENER_GUARD_MODEL), Some("qwen3guard-test"));
        assert_eq!(
            get(&env, ENV_SCREENER_GUARD_SHA256),
            Some("ab".repeat(32).as_str())
        );
        assert!(get(&env, ENV_SCREENER_DECISION_URL).is_none());
        let lookup = |key: &str| (key == ENV_NODE_SCREENER).then(|| "guard".to_owned());
        assert!(wants_local_guard(&lookup));
    }

    #[test]
    fn an_external_guard_engine_never_borrows_the_local_hash() {
        let env = env_of(&[
            (ENV_NODE_SCREENER, "guard"),
            (ENV_SCREENER_GUARD_URL, "http://127.0.0.1:18092/v1"),
            (ENV_SCREENER_GUARD_MODEL, "llama-guard-3-1b"),
        ]);
        assert_eq!(
            get(&env, ENV_SCREENER_GUARD_URL),
            Some("http://127.0.0.1:18092/v1")
        );
        assert_eq!(
            get(&env, ENV_SCREENER_GUARD_MODEL),
            Some("llama-guard-3-1b")
        );
        assert!(get(&env, ENV_SCREENER_GUARD_SHA256).is_none());

        // Without a model id the external guard is not published at all.
        let env = env_of(&[
            (ENV_NODE_SCREENER, "guard"),
            (ENV_SCREENER_GUARD_URL, "http://127.0.0.1:18092/v1"),
        ]);
        assert!(env.is_empty());

        let lookup = |key: &str| match key {
            ENV_NODE_SCREENER => Some("guard".to_owned()),
            ENV_SCREENER_GUARD_URL => Some("http://127.0.0.1:18092/v1".to_owned()),
            _ => None,
        };
        assert!(
            !wants_local_guard(&lookup),
            "an external engine starts no sidecar"
        );
    }

    #[test]
    fn both_kinds_publish_side_by_side() {
        let env = env_of(&[
            (ENV_NODE_SCREENER, "decision,guard"),
            (ENV_SCREENER_DECISION_SHA256, SHA),
        ]);
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            [
                ENV_SCREENER_DECISION_URL,
                ENV_SCREENER_DECISION_MODEL,
                ENV_SCREENER_DECISION_SHA256,
                ENV_SCREENER_GUARD_URL,
                ENV_SCREENER_GUARD_MODEL,
                ENV_SCREENER_GUARD_SHA256,
            ]
        );
    }

    #[test]
    fn the_reserved_ports_do_not_collide() {
        assert_ne!(
            DECISION_SCREENER_PORT_BASE,
            crate::sidecar::providers::llamacpp::guard::GUARD_PORT_BASE
        );
        for other in [
            8080, 8081, 8082, 8083, 8084, 8085, 8086, 8088, 8089, 8090, 8091, 8101,
        ] {
            assert_ne!(DECISION_SCREENER_PORT_BASE, other);
        }
    }

    #[test]
    fn the_default_guard_model_feeds_the_published_hash() {
        let (id, sha) = local_guard_model();
        assert!(!id.is_empty());
        assert_eq!(
            pinned_hash(Some(sha.clone()), "test"),
            Some(sha.to_ascii_lowercase())
        );
    }
}
