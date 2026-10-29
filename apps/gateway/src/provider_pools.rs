//! Validated, session-aware direct-provider chat pool registry.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ryu_gw_router::pool::{MemberSignals, PoolMember, PoolRequest, ProviderPool};

use crate::config::{
    PoolExecutionConfig, PoolJudgeConfig, ProviderId, ProviderPoolStrategy, RoutingConfig,
};

const ALIAS_PREFIX: &str = "pool:";
const MAX_COOLDOWN_WAIT_MS: u64 = 30_000;

#[derive(Clone)]
pub struct SelectedPoolRoute {
    pub pool_name: String,
    pub member_index: usize,
    pub provider: ProviderId,
    pub model: String,
    /// Eligible routes after the selected member, in priority order. Preserve
    /// this request-local plan: calling the selector again would advance round
    /// robin and could change the fallback order mid-turn.
    pub fallback_candidates: Vec<PoolCandidateRoute>,
    /// Multi-leg modes retain the authored concrete plan until Gateway admission.
    pub execution: Option<SelectedPoolExecution>,
}

#[derive(Clone)]
pub struct SelectedPoolExecution {
    pub strategy: ProviderPoolStrategy,
    pub limits: PoolExecutionConfig,
    pub judge: Option<PoolJudgeConfig>,
    pub targets: Vec<PoolCandidateRoute>,
}

#[derive(Clone)]
pub struct PoolCandidateRoute {
    pub member_index: usize,
    pub provider: ProviderId,
    pub model: String,
}

#[derive(Clone)]
pub struct ProviderPools {
    pools: HashMap<String, Arc<ProviderPool>>,
    wait_limits: HashMap<String, Duration>,
    execution: HashMap<
        String,
        (
            ProviderPoolStrategy,
            PoolExecutionConfig,
            Option<PoolJudgeConfig>,
        ),
    >,
    auto_weights: HashMap<String, ryu_gw_router::pool::AutoScoringWeights>,
    relay: Arc<
        Mutex<HashMap<(String, String), (Instant, crate::pipeline::pool_execution::ContextRelay)>>,
    >,
}

impl ProviderPools {
    pub fn new(routing: &RoutingConfig) -> Result<Self, String> {
        if routing.provider_pools.len() > 128 {
            return Err("Gateway supports at most 128 named provider pools".to_owned());
        }
        if routing.default_provider.as_str().starts_with(ALIAS_PREFIX) {
            return Err(
                "chat pools must be selected through a model mapping or chat slot".to_owned(),
            );
        }
        if routing
            .fallback_chain
            .iter()
            .any(|provider| provider.as_str().starts_with(ALIAS_PREFIX))
            || routing
                .modality_map
                .values()
                .any(|mapping| mapping.provider.as_str().starts_with(ALIAS_PREFIX))
        {
            return Err("pool aliases are only valid as chat model routes".to_owned());
        }
        let mut pools = HashMap::new();
        let mut wait_limits = HashMap::new();
        let mut execution = HashMap::new();
        let mut auto_weights = HashMap::new();
        for (name, config) in &routing.provider_pools {
            validate_execution(name, config)?;
            if let Some(weights) = &config.auto_weights {
                auto_weights.insert(name.clone(), weights.clone());
            }
            execution.insert(
                name.clone(),
                (
                    config.strategy,
                    config.execution.clone(),
                    config.judge.clone(),
                ),
            );
            if config.wait_for_cooldown_ms > MAX_COOLDOWN_WAIT_MS {
                return Err(format!(
                    "pool {name} cooldown wait must be at most {MAX_COOLDOWN_WAIT_MS} ms"
                ));
            }
            wait_limits.insert(
                name.clone(),
                Duration::from_millis(config.wait_for_cooldown_ms),
            );
            if config.sticky_limit != 1
                && !matches!(config.strategy, ProviderPoolStrategy::RoundRobin)
            {
                return Err(format!(
                    "pool {name} sticky_limit only applies to round_robin"
                ));
            }
            if name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return Err(format!("invalid provider pool name: {name}"));
            }
            let mut members = Vec::with_capacity(config.members.len());
            for member in &config.members {
                if member
                    .context_tokens
                    .is_some_and(|tokens| tokens == 0 || tokens > 2_000_000)
                {
                    return Err(format!(
                        "pool {name} context capacity must be between 1 and 2000000 tokens"
                    ));
                }
                let id = member.provider.as_str();
                if id.starts_with(ALIAS_PREFIX) {
                    return Err(format!("pool {name} cannot contain another pool: {id}"));
                }
                if is_service_only_provider(id) {
                    return Err(format!(
                        "pool {name} includes a provider without chat: {id}"
                    ));
                }
                members.push(PoolMember {
                    provider: id.to_owned(),
                    model: member.model.clone(),
                    priority: member.priority,
                    weight: member.weight,
                    enabled: member.enabled,
                    last_resort: member.last_resort,
                });
            }
            let strategy = config.strategy;
            pools.insert(
                name.clone(),
                Arc::new(ProviderPool::new_with_sticky_limit(
                    members,
                    strategy,
                    config.sticky_limit,
                )?),
            );
        }
        for id in routing
            .model_map
            .values()
            .map(|mapping| &mapping.provider)
            .chain(routing.eval_routing.candidates.iter())
        {
            if let Some(name) = id.as_str().strip_prefix(ALIAS_PREFIX) {
                if !pools.contains_key(name) {
                    return Err(format!("route references an unknown provider pool: {name}"));
                }
            }
        }
        if routing.model_map.values().any(|mapping| {
            mapping.provider.as_str().starts_with(ALIAS_PREFIX) && mapping.provider_model.is_some()
        }) {
            return Err(
                "pool model mappings use member models and cannot rewrite the alias".to_owned(),
            );
        }
        Ok(Self {
            pools,
            wait_limits,
            execution,
            auto_weights,
            relay: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Retain affinity/health only when every executable member still agrees.
    /// Changed entries get a private pool; late old feedback cannot affect it.
    pub(crate) fn new_reusing(
        routing: &RoutingConfig,
        previous_routing: &RoutingConfig,
        previous: &Self,
        unchanged_providers: &HashSet<String>,
    ) -> Result<Self, String> {
        let mut next = Self::new(routing)?;
        for (name, config) in &routing.provider_pools {
            let Some(old_config) = previous_routing.provider_pools.get(name) else {
                continue;
            };
            if serde_json::to_value(config).map_err(|_| "provider pool serialization failed")?
                != serde_json::to_value(old_config)
                    .map_err(|_| "provider pool serialization failed")?
            {
                continue;
            }
            let members_unchanged = config.members.iter().all(|member| {
                let id = member.provider.as_str();
                if ryu_gw_credentials::sdk_provider_by_id(id).is_some() {
                    let Some(owner) = ryu_gw_providers::sdk_descriptor_for_model(&member.model)
                    else {
                        return false;
                    };
                    (id == "genai" || id == owner.provider_id)
                        && unchanged_providers.contains(owner.provider_id)
                } else {
                    unchanged_providers.contains(id)
                }
            });
            if members_unchanged {
                if let Some(pool) = previous.pools.get(name) {
                    next.pools.insert(name.clone(), Arc::clone(pool));
                }
            }
        }
        Ok(next)
    }

    pub fn select(
        &self,
        alias: &str,
        session: Option<&str>,
        available: impl Fn(&str, &str) -> bool,
    ) -> Result<Option<SelectedPoolRoute>, String> {
        self.select_with_facts(alias, session, &PoolRequest::default(), available, |_| {
            MemberSignals::default()
        })
    }

    pub fn select_with_facts(
        &self,
        alias: &str,
        session: Option<&str>,
        request: &PoolRequest,
        available: impl Fn(&str, &str) -> bool,
        signals: impl Fn(&PoolMember) -> MemberSignals,
    ) -> Result<Option<SelectedPoolRoute>, String> {
        let Some(name) = alias.strip_prefix(ALIAS_PREFIX) else {
            return Ok(None);
        };
        let pool = self
            .pools
            .get(name)
            .ok_or_else(|| format!("unknown provider pool: {name}"))?;
        if let Some((strategy, limits, judge)) =
            self.execution.get(name).filter(|(strategy, _, _)| {
                matches!(
                    strategy,
                    ProviderPoolStrategy::Fusion | ProviderPoolStrategy::Pipeline
                )
            })
        {
            let targets = self.execution_targets(alias, &available)?;
            let first = targets
                .first()
                .ok_or_else(|| format!("no available execution target in pool: {name}"))?;
            let (provider, model) = if matches!(strategy, ProviderPoolStrategy::Fusion) {
                let judge = judge.as_ref().ok_or("Fusion judge missing")?;
                if !available(judge.provider.as_str(), &judge.model) {
                    return Err("Fusion judge is unavailable or denied".to_owned());
                }
                (judge.provider.clone(), judge.model.clone())
            } else {
                (first.provider.clone(), first.model.clone())
            };
            return Ok(Some(SelectedPoolRoute {
                pool_name: name.to_owned(),
                member_index: first.member_index,
                provider,
                model,
                fallback_candidates: Vec::new(),
                execution: Some(SelectedPoolExecution {
                    strategy: *strategy,
                    limits: limits.clone(),
                    judge: judge.clone(),
                    targets,
                }),
            }));
        }
        let mut candidates = pool
            .candidates_with_facts(
                session,
                &PoolRequest {
                    auto_weights: self.auto_weights.get(name).cloned(),
                    ..request.clone()
                },
                |member| available(&member.provider, &member.model),
                signals,
            )
            .map_err(|error| format!("pool selection requires a valid execution plan: {error:?}"))?
            .into_iter()
            .map(|index| {
                let member = pool.member(index).expect("candidate index belongs to pool");
                PoolCandidateRoute {
                    member_index: index,
                    provider: ProviderId::from(member.provider.as_str()),
                    model: member.model.clone(),
                }
            });
        let selected = candidates
            .next()
            .ok_or_else(|| format!("no available provider in pool: {name}"))?;
        Ok(Some(SelectedPoolRoute {
            pool_name: name.to_owned(),
            member_index: selected.member_index,
            provider: selected.provider,
            model: selected.model,
            fallback_candidates: candidates.collect(),
            execution: None,
        }))
    }

    /// Wait only for a known cooldown and never beyond the authored limit.
    /// Dropping this future cancels the wait, including the request timeout.
    pub async fn select_wait(
        &self,
        alias: &str,
        session: Option<&str>,
        available: impl Fn(&str, &str) -> bool,
    ) -> Result<Option<SelectedPoolRoute>, String> {
        self.select_wait_with_facts(alias, session, &PoolRequest::default(), available, |_| {
            MemberSignals::default()
        })
        .await
    }

    pub async fn select_wait_with_facts(
        &self,
        alias: &str,
        session: Option<&str>,
        request: &PoolRequest,
        available: impl Fn(&str, &str) -> bool,
        signals: impl Fn(&PoolMember) -> MemberSignals,
    ) -> Result<Option<SelectedPoolRoute>, String> {
        let Some(name) = alias.strip_prefix(ALIAS_PREFIX) else {
            return Ok(None);
        };
        let pool = self
            .pools
            .get(name)
            .ok_or_else(|| format!("unknown provider pool: {name}"))?;
        let limit = self.wait_limits.get(name).copied().unwrap_or_default();
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let mut current = request.clone();
            current.now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or_default();
            let selected = self.select_with_facts(alias, session, &current, &available, &signals);
            if selected.is_ok() {
                return selected;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let Some(delay) =
                pool.next_cooldown_delay(|member| available(&member.provider, &member.model))
            else {
                return selected;
            };
            if remaining.is_zero() {
                return selected;
            }
            tokio::time::sleep(delay.min(remaining)).await;
            if tokio::time::Instant::now() >= deadline {
                return selected;
            }
        }
    }

    pub fn record_success(&self, route: &SelectedPoolRoute, session: Option<&str>) {
        if let Some(pool) = self.pools.get(&route.pool_name) {
            pool.record_success(session, route.member_index);
        }
    }

    pub fn record_success_facts(
        &self,
        route: &SelectedPoolRoute,
        session: Option<&str>,
        request: &PoolRequest,
        latency_ms: u64,
    ) {
        if let Some(pool) = self.pools.get(&route.pool_name) {
            pool.record_success_with_facts(session, route.member_index, request, Some(latency_ms));
        }
    }

    pub fn relay_messages(
        &self,
        route: &SelectedPoolRoute,
        scope_session: &str,
    ) -> Vec<serde_json::Value> {
        if !self
            .execution
            .get(&route.pool_name)
            .is_some_and(|(strategy, _, _)| matches!(strategy, ProviderPoolStrategy::ContextRelay))
        {
            return Vec::new();
        }
        let mut values = self.relay.lock().expect("context relay mutex");
        values.retain(|_, (used, _)| {
            used.elapsed() < crate::pipeline::pool_execution::RELAY_IDLE_TTL
        });
        values
            .get_mut(&(route.pool_name.clone(), scope_session.to_owned()))
            .map(|(used, relay)| {
                *used = Instant::now();
                relay.handoff_messages(&crate::pipeline::pool_execution::PoolTarget {
                    provider: route.provider.as_str().to_owned(),
                    model: route.model.clone(),
                })
            })
            .unwrap_or_default()
    }

    pub fn record_relay(
        &self,
        route: &SelectedPoolRoute,
        scope_session: &str,
        response: &serde_json::Value,
        latest_user: &str,
    ) {
        if !self
            .execution
            .get(&route.pool_name)
            .is_some_and(|(strategy, _, _)| matches!(strategy, ProviderPoolStrategy::ContextRelay))
        {
            return;
        }
        let mut values = self.relay.lock().expect("context relay mutex");
        values.retain(|_, (used, _)| {
            used.elapsed() < crate::pipeline::pool_execution::RELAY_IDLE_TTL
        });
        let key = (route.pool_name.clone(), scope_session.to_owned());
        if values.len() >= crate::pipeline::pool_execution::MAX_RELAY_ENTRIES
            && !values.contains_key(&key)
        {
            if let Some(oldest) = values
                .iter()
                .min_by_key(|(_, (used, _))| *used)
                .map(|(key, _)| key.clone())
            {
                values.remove(&oldest);
            }
        }
        let entry = values
            .entry(key)
            .or_insert_with(|| (Instant::now(), Default::default()));
        if entry
            .1
            .record(
                &crate::pipeline::pool_execution::PoolTarget {
                    provider: route.provider.as_str().to_owned(),
                    model: route.model.clone(),
                },
                response,
                latest_user,
            )
            .is_ok()
        {
            entry.0 = Instant::now();
        }
    }

    pub fn acquire(&self, route: &SelectedPoolRoute) -> Option<ryu_gw_router::pool::PoolLease> {
        self.pools
            .get(&route.pool_name)?
            .acquire(route.member_index)
    }

    pub fn target_route(
        &self,
        name: &str,
        provider: &str,
        model: &str,
    ) -> Option<SelectedPoolRoute> {
        let pool = self.pools.get(name)?;
        let member_index = (0..32).find(|index| {
            pool.member(*index)
                .is_some_and(|member| member.provider == provider && member.model == model)
        })?;
        Some(SelectedPoolRoute {
            pool_name: name.to_owned(),
            member_index,
            provider: ProviderId::from(provider),
            model: model.to_owned(),
            fallback_candidates: Vec::new(),
            execution: None,
        })
    }

    pub fn execution_config(
        &self,
        alias: &str,
    ) -> Option<&(
        ProviderPoolStrategy,
        PoolExecutionConfig,
        Option<PoolJudgeConfig>,
    )> {
        self.execution.get(alias.strip_prefix(ALIAS_PREFIX)?)
    }

    pub fn execution_targets(
        &self,
        alias: &str,
        available: impl Fn(&str, &str) -> bool,
    ) -> Result<Vec<PoolCandidateRoute>, String> {
        let name = alias
            .strip_prefix(ALIAS_PREFIX)
            .ok_or("Not a provider pool")?;
        let pool = self.pools.get(name).ok_or("Unknown provider pool")?;
        Ok(pool
            .eligible_members(|member| available(&member.provider, &member.model))
            .into_iter()
            .filter_map(|index| {
                pool.member(index).map(|member| PoolCandidateRoute {
                    member_index: index,
                    provider: ProviderId::from(member.provider.as_str()),
                    model: member.model.clone(),
                })
            })
            .collect())
    }

    pub fn record_rate_limit(&self, route: &SelectedPoolRoute, retry_after: Option<u64>) {
        if let Some(pool) = self.pools.get(&route.pool_name) {
            pool.record_rate_limit(route.member_index, retry_after);
        }
    }

    pub fn record_failure(&self, route: &SelectedPoolRoute) {
        if let Some(pool) = self.pools.get(&route.pool_name) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or_default();
            pool.record_failure(route.member_index, now);
        }
    }
}

fn validate_execution(
    name: &str,
    config: &crate::config::ProviderPoolConfig,
) -> Result<(), String> {
    if let Some(weights) = &config.auto_weights {
        let json = serde_json::to_value(weights)
            .map_err(|_| format!("pool {name} Auto weights are invalid"))?;
        let values = json.as_object().ok_or("Auto weights must be an object")?;
        if values.values().any(|value| {
            value
                .as_f64()
                .is_none_or(|weight| !weight.is_finite() || weight < 0.0 || weight > 1000.0)
        }) || values
            .values()
            .filter_map(serde_json::Value::as_f64)
            .sum::<f64>()
            <= 0.0
        {
            return Err(format!(
                "pool {name} Auto weights must be finite nonnegative values with a positive total"
            ));
        }
    }
    let bounds = &config.execution;
    if !(1..=30_000).contains(&bounds.leg_timeout_ms)
        || !(1..=120_000).contains(&bounds.total_timeout_ms)
        || bounds.total_timeout_ms < bounds.leg_timeout_ms
        || !(1..=262_144).contains(&bounds.max_output_bytes)
        || !(1..=8).contains(&bounds.quorum)
        || bounds.grace_ms > 5_000
    {
        return Err(format!(
            "pool {name} execution limits exceed supported bounds"
        ));
    }
    if matches!(
        config.strategy,
        ProviderPoolStrategy::Fusion | ProviderPoolStrategy::Pipeline
    ) && config
        .members
        .iter()
        .filter(|member| member.enabled)
        .count()
        > 8
    {
        return Err(format!(
            "pool {name} execution supports at most 8 enabled targets"
        ));
    }
    if matches!(config.strategy, ProviderPoolStrategy::Fusion) && config.judge.is_none() {
        return Err(format!("pool {name} fusion requires a concrete judge"));
    }
    if let Some(judge) = &config.judge {
        if !matches!(config.strategy, ProviderPoolStrategy::Fusion)
            || judge.provider.as_str().starts_with(ALIAS_PREFIX)
            || is_service_only_provider(judge.provider.as_str())
            || judge.model.trim().is_empty()
            || judge.model.len() > 256
            || judge.model.trim() != judge.model
            || judge.model.chars().any(char::is_control)
        {
            return Err(format!(
                "pool {name} judge is not a valid concrete chat target"
            ));
        }
    }
    Ok(())
}

fn is_service_only_provider(id: &str) -> bool {
    if ryu_gw_credentials::web::web_provider_by_id(id).is_some() {
        return true;
    }
    matches!(
        id,
        "voyage"
            | "jina"
            | "cohere"
            | "deepgram"
            | "assemblyai"
            | "elevenlabs"
            | "inworld"
            | "edge-tts"
            | "google-tts"
            | "polly"
            | "fal"
            | "replicate"
            | "bfl"
            | "stability"
            | "recraft"
            | "minimax"
            | "runway"
            | "topaz"
            | "classify"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ProviderPoolConfig, ProviderPoolMemberConfig};

    #[test]
    fn execution_bounds_and_concrete_judge_are_validated_before_publication() {
        let mut config = ProviderPoolConfig {
            strategy: ProviderPoolStrategy::Fusion,
            sticky_limit: 1,
            wait_for_cooldown_ms: 0,
            execution: Default::default(),
            judge: None,
            auto_weights: None,
            members: vec![member("openai", "one")],
        };
        assert!(validate_execution("test", &config).is_err());
        config.judge = Some(PoolJudgeConfig {
            provider: ProviderId::from("openai"),
            model: "judge".into(),
        });
        assert!(validate_execution("test", &config).is_ok());
        config.execution.leg_timeout_ms = 30_001;
        assert!(validate_execution("test", &config).is_err());
        config.execution = Default::default();
        config.execution.max_output_bytes = 262_145;
        assert!(validate_execution("test", &config).is_err());
        config.execution = Default::default();
        config.judge.as_mut().unwrap().provider = ProviderId::from("pool:nested");
        assert!(validate_execution("test", &config).is_err());
    }

    #[test]
    fn unknown_context_is_preserved_and_invalid_capacity_is_rejected() {
        let mut routing = RoutingConfig::default();
        let mut config = ProviderPoolConfig {
            strategy: ProviderPoolStrategy::ContextOptimized,
            sticky_limit: 1,
            wait_for_cooldown_ms: 0,
            execution: Default::default(),
            judge: None,
            auto_weights: None,
            members: vec![member("openai", "one")],
        };
        routing
            .provider_pools
            .insert("context".into(), config.clone());
        assert!(ProviderPools::new(&routing).is_ok());
        config.members[0].context_tokens = Some(0);
        routing
            .provider_pools
            .insert("context".into(), config.clone());
        assert!(ProviderPools::new(&routing).is_err());
        config.members[0].context_tokens = Some(2_000_001);
        routing.provider_pools.insert("context".into(), config);
        assert!(ProviderPools::new(&routing).is_err());
    }

    #[test]
    fn relay_handoff_is_authenticated_scope_and_generation_local() {
        let mut routing = RoutingConfig::default();
        routing.provider_pools.insert(
            "relay".into(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::ContextRelay,
                sticky_limit: 1,
                wait_for_cooldown_ms: 0,
                execution: Default::default(),
                judge: None,
                auto_weights: None,
                members: vec![member("openai", "one"), member("anthropic", "two")],
            },
        );
        let pools = ProviderPools::new(&routing).unwrap();
        let first = pools
            .select("pool:relay", Some("session"), |_, _| true)
            .unwrap()
            .unwrap();
        pools.record_relay(
            &first,
            "owner-a:session",
            &serde_json::json!({"choices":[{"message":{"content":"successful answer"}}]}),
            "original request",
        );
        pools.record_rate_limit(&first, Some(60));
        let second = pools
            .select("pool:relay", Some("session"), |_, _| true)
            .unwrap()
            .unwrap();
        assert!(pools.relay_messages(&second, "owner-b:session").is_empty());
        let handoff = pools.relay_messages(&second, "owner-a:session");
        assert_eq!(handoff.len(), 1);
        assert_eq!(handoff[0]["role"], "user");
        assert!(handoff[0]["content"]
            .as_str()
            .unwrap()
            .contains("successful answer"));
        let replacement = ProviderPools::new(&routing).unwrap();
        assert!(replacement
            .relay_messages(&second, "owner-a:session")
            .is_empty());
    }

    fn cooling_pool(wait_ms: u64) -> ProviderPools {
        let mut routing = RoutingConfig::default();
        routing.provider_pools.insert(
            "cooling".to_owned(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::RoundRobin,
                sticky_limit: 1,
                wait_for_cooldown_ms: wait_ms,
                members: vec![member("openai", "gpt-4o-mini")],
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        ProviderPools::new(&routing).unwrap()
    }

    #[tokio::test]
    async fn cooldown_wait_recovers_and_preserves_the_returned_session_route() {
        let pools = cooling_pool(5_000);
        let first = pools
            .select("pool:cooling", Some("warm"), |_, _| true)
            .unwrap()
            .unwrap();
        pools.record_rate_limit(&first, Some(1));
        let route = pools
            .select_wait("pool:cooling", Some("next"), |_, _| true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(route.model, "gpt-4o-mini");
        assert_eq!(route.member_index, first.member_index);
        assert_eq!(
            pools
                .select_wait("pool:cooling", Some("next"), |_, _| true)
                .await
                .unwrap()
                .unwrap()
                .member_index,
            route.member_index
        );
    }

    #[tokio::test]
    async fn cooldown_wait_is_bounded_and_request_deadline_cancels_it() {
        let pools = cooling_pool(30);
        let first = pools
            .select("pool:cooling", None, |_, _| true)
            .unwrap()
            .unwrap();
        pools.record_rate_limit(&first, Some(1));
        let started = tokio::time::Instant::now();
        assert!(pools
            .select_wait("pool:cooling", None, |_, _| true)
            .await
            .is_err());
        assert!(started.elapsed() >= Duration::from_millis(30));

        let pools = cooling_pool(5_000);
        let first = pools
            .select("pool:cooling", None, |_, _| true)
            .unwrap()
            .unwrap();
        pools.record_rate_limit(&first, Some(1));
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            pools.select_wait("pool:cooling", Some("cancelled"), |_, _| true)
        )
        .await
        .is_err());
        assert!(pools
            .select("pool:cooling", Some("cancelled"), |_, _| true)
            .is_err());
    }

    #[tokio::test]
    async fn cooldown_wait_does_not_wait_for_policy_denied_or_missing_members() {
        let pools = cooling_pool(5_000);
        let first = pools
            .select("pool:cooling", None, |_, _| true)
            .unwrap()
            .unwrap();
        pools.record_rate_limit(&first, Some(1));
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            pools.select_wait("pool:cooling", None, |_, _| false),
        )
        .await;
        assert!(result.unwrap().is_err());
        assert!(cooling_pool(0)
            .select_wait("pool:cooling", None, |_, _| false)
            .await
            .is_err());
    }

    #[test]
    fn cooldown_wait_config_is_bounded_and_round_trips() {
        let pools = cooling_pool(30_000);
        assert_eq!(pools.wait_limits["cooling"], Duration::from_secs(30));
        let mut routing = RoutingConfig::default();
        routing.provider_pools.insert(
            "cooling".to_owned(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::Priority,
                sticky_limit: 1,
                wait_for_cooldown_ms: 30_001,
                members: vec![member("openai", "gpt-4o-mini")],
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        assert!(ProviderPools::new(&routing).is_err());
        routing
            .provider_pools
            .get_mut("cooling")
            .unwrap()
            .wait_for_cooldown_ms = 900;
        let decoded: RoutingConfig = toml::from_str(&toml::to_string(&routing).unwrap()).unwrap();
        assert_eq!(decoded.provider_pools["cooling"].wait_for_cooldown_ms, 900);
    }

    fn member(provider: &str, model: &str) -> ProviderPoolMemberConfig {
        ProviderPoolMemberConfig {
            provider: ProviderId::from(provider),
            model: model.to_owned(),
            priority: 0,
            weight: 1,
            enabled: true,
            last_resort: false,
            context_tokens: None,
        }
    }

    #[test]
    fn reuse_preserves_unchanged_pool_affinity_and_isolates_changed_sdk_member() {
        let mut routing = RoutingConfig::default();
        for (name, provider, model) in [
            ("native", "openai", "gpt-4o-mini"),
            ("sdk", "genai", "groq::llama-3.3-70b-versatile"),
        ] {
            routing.provider_pools.insert(
                name.to_owned(),
                ProviderPoolConfig {
                    strategy: ProviderPoolStrategy::RoundRobin,
                    sticky_limit: 1,
                    wait_for_cooldown_ms: 0,
                    members: vec![member(provider, model)],
                    execution: Default::default(),
                    judge: None,
                    auto_weights: None,
                },
            );
        }
        let original = ProviderPools::new(&routing).unwrap();
        let unchanged = HashSet::from(["openai".to_owned(), "genai-groq".to_owned()]);
        let reused = ProviderPools::new_reusing(&routing, &routing, &original, &unchanged).unwrap();
        assert!(Arc::ptr_eq(
            &original.pools["native"],
            &reused.pools["native"]
        ));
        assert!(Arc::ptr_eq(&original.pools["sdk"], &reused.pools["sdk"]));
        let changed = ProviderPools::new_reusing(
            &routing,
            &routing,
            &original,
            &HashSet::from(["openai".to_owned()]),
        )
        .unwrap();
        assert!(Arc::ptr_eq(
            &original.pools["native"],
            &changed.pools["native"]
        ));
        assert!(!Arc::ptr_eq(&original.pools["sdk"], &changed.pools["sdk"]));
        let old_route = original
            .select("pool:sdk", None, |_, _| true)
            .unwrap()
            .unwrap();
        original.record_rate_limit(&old_route, Some(3600));
        assert!(original.select("pool:sdk", None, |_, _| true).is_err());
        assert!(changed
            .select("pool:sdk", None, |_, _| true)
            .unwrap()
            .is_some());
    }

    #[test]
    fn alias_selects_actual_provider_and_model_with_session_affinity() {
        let mut routing = RoutingConfig::default();
        routing.provider_pools.insert(
            "free".to_owned(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::RoundRobin,
                sticky_limit: 1,
                wait_for_cooldown_ms: 0,
                members: vec![
                    member("openai", "gpt-4o-mini"),
                    member("anthropic", "claude-haiku-4-5"),
                ],
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        let pools = ProviderPools::new(&routing).unwrap();
        let first = pools
            .select("pool:free", Some("tenant:one"), |_, _| true)
            .unwrap()
            .unwrap();
        assert_eq!(first.provider.as_str(), "openai");
        assert_eq!(first.model, "gpt-4o-mini");
        assert_eq!(first.fallback_candidates.len(), 1);
        assert_eq!(first.fallback_candidates[0].provider.as_str(), "anthropic");
        assert_eq!(first.fallback_candidates[0].model, "claude-haiku-4-5");
        let second = pools
            .select("pool:free", Some("tenant:two"), |_, _| true)
            .unwrap()
            .unwrap();
        assert_eq!(second.provider.as_str(), "anthropic");
        assert_eq!(second.model, "claude-haiku-4-5");
        assert_eq!(second.fallback_candidates[0].provider.as_str(), "openai");
        assert_eq!(
            pools
                .select("pool:free", Some("tenant:one"), |_, _| true)
                .unwrap()
                .unwrap()
                .provider
                .as_str(),
            "openai"
        );
        pools.record_rate_limit(&first, Some(30));
        assert_eq!(
            pools
                .select("pool:free", Some("tenant:one"), |_, _| true)
                .unwrap()
                .unwrap()
                .provider
                .as_str(),
            "anthropic"
        );
        assert!(pools.select("openai", None, |_, _| true).unwrap().is_none());
    }

    #[test]
    fn last_resort_config_round_trips_and_enters_fallback_after_regular_members() {
        let mut routing = RoutingConfig::default();
        let mut emergency = member("anthropic", "claude-haiku-4-5");
        emergency.last_resort = true;
        routing.provider_pools.insert(
            "emergency".to_owned(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::Priority,
                sticky_limit: 1,
                wait_for_cooldown_ms: 0,
                members: vec![emergency, member("openai", "gpt-4o-mini")],
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        let encoded = toml::to_string(&routing).unwrap();
        let decoded: RoutingConfig = toml::from_str(&encoded).unwrap();
        assert!(decoded.provider_pools["emergency"].members[0].last_resort);
        let pools = ProviderPools::new(&decoded).unwrap();
        let route = pools
            .select("pool:emergency", Some("new"), |_, _| true)
            .unwrap()
            .unwrap();
        assert_eq!(route.provider.as_str(), "openai");
        assert_eq!(route.fallback_candidates[0].provider.as_str(), "anthropic");
    }

    #[test]
    fn round_robin_batch_is_loaded_from_config_and_rejects_other_strategies() {
        let mut routing = RoutingConfig::default();
        routing.provider_pools.insert(
            "batched".to_owned(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::RoundRobin,
                sticky_limit: 2,
                wait_for_cooldown_ms: 0,
                members: vec![
                    member("openai", "gpt-4o-mini"),
                    member("anthropic", "claude-haiku-4-5"),
                ],
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        let encoded = toml::to_string(&routing).unwrap();
        let decoded: RoutingConfig = toml::from_str(&encoded).unwrap();
        let pools = ProviderPools::new(&decoded).unwrap();
        let first = pools
            .select("pool:batched", Some("a"), |_, _| true)
            .unwrap()
            .unwrap();
        let second = pools
            .select("pool:batched", Some("b"), |_, _| true)
            .unwrap()
            .unwrap();
        let third = pools
            .select("pool:batched", Some("c"), |_, _| true)
            .unwrap()
            .unwrap();
        assert_eq!(first.provider.as_str(), "openai");
        assert_eq!(second.provider.as_str(), "openai");
        assert_eq!(third.provider.as_str(), "anthropic");
        assert_eq!(
            pools
                .select("pool:batched", Some("a"), |_, _| true)
                .unwrap()
                .unwrap()
                .provider
                .as_str(),
            "openai"
        );
        routing.provider_pools.get_mut("batched").unwrap().strategy =
            ProviderPoolStrategy::Priority;
        assert!(ProviderPools::new(&routing).is_err());
    }

    #[test]
    fn fallback_plan_preserves_each_members_model_and_priority_order() {
        let mut routing = RoutingConfig::default();
        let mut low_priority = member("qwen", "qwen-plus");
        low_priority.priority = 1;
        routing.provider_pools.insert(
            "chat".to_owned(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::RoundRobin,
                sticky_limit: 1,
                wait_for_cooldown_ms: 0,
                members: vec![
                    member("openai", "gpt-4o-mini"),
                    member("anthropic", "claude-haiku-4-5"),
                    low_priority,
                ],
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        let pools = ProviderPools::new(&routing).unwrap();
        let route = pools
            .select("pool:chat", None, |_, _| true)
            .unwrap()
            .unwrap();
        assert_eq!(route.provider.as_str(), "openai");
        assert_eq!(route.model, "gpt-4o-mini");
        assert_eq!(
            route
                .fallback_candidates
                .iter()
                .map(|candidate| (candidate.provider.as_str(), candidate.model.as_str()))
                .collect::<Vec<_>>(),
            vec![("anthropic", "claude-haiku-4-5"), ("qwen", "qwen-plus")]
        );

        let next = pools
            .select("pool:chat", None, |_, _| true)
            .unwrap()
            .unwrap();
        assert_eq!(next.provider.as_str(), "anthropic");
        assert_eq!(next.fallback_candidates[0].provider.as_str(), "openai");
        assert_eq!(next.fallback_candidates[1].provider.as_str(), "qwen");
    }

    #[test]
    fn pool_alias_in_generic_fallback_fails_configuration() {
        let mut routing = RoutingConfig::default();
        routing.fallback_chain.push(ProviderId::from("pool:free"));
        assert!(ProviderPools::new(&routing).is_err());
    }

    #[test]
    fn unknown_default_pool_fails_at_startup() {
        let mut routing = RoutingConfig::default();
        routing.default_provider = ProviderId::from("pool:missing");
        assert!(ProviderPools::new(&routing).is_err());
    }

    #[test]
    fn pool_mapping_rejects_an_ignored_model_rewrite() {
        let mut routing = RoutingConfig::default();
        routing.provider_pools.insert(
            "chat".to_owned(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::Priority,
                sticky_limit: 1,
                wait_for_cooldown_ms: 0,
                members: vec![member("openai", "gpt-4o-mini")],
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        routing.model_map.insert(
            "alias".to_owned(),
            crate::config::ModelMapping {
                provider: ProviderId::from("pool:chat"),
                provider_model: Some("wrong-model".to_owned()),
            },
        );
        assert!(ProviderPools::new(&routing).is_err());
    }

    #[test]
    fn documented_toml_shape_builds_a_live_pool() {
        let routing: RoutingConfig = toml::from_str(
            r#"
            [model_map."balanced-chat"]
            provider = "pool:balanced"

            [provider_pools.balanced]
            strategy = "weighted_round_robin"

            [[provider_pools.balanced.members]]
            provider = "openai"
            model = "gpt-4o-mini"
            priority = 0
            weight = 2
            enabled = true

            [[provider_pools.balanced.members]]
            provider = "anthropic"
            model = "claude-haiku-4-5"
            priority = 0
            weight = 1
            enabled = true
            "#,
        )
        .unwrap();
        let pools = ProviderPools::new(&routing).unwrap();
        assert_eq!(
            pools
                .select("pool:balanced", None, |_, _| true)
                .unwrap()
                .unwrap()
                .provider
                .as_str(),
            "openai"
        );
    }

    #[test]
    fn an_unconfigured_member_does_not_block_other_gateway_routes() {
        let mut routing = RoutingConfig::default();
        routing.provider_pools.insert(
            "chat".to_owned(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::RoundRobin,
                sticky_limit: 1,
                wait_for_cooldown_ms: 0,
                members: vec![
                    member("temporarily-unconfigured", "future-model"),
                    member("openai", "gpt-4o-mini"),
                ],
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        let pools = ProviderPools::new(&routing).unwrap();
        assert_eq!(
            pools
                .select("pool:chat", None, |id, _| id == "openai")
                .unwrap()
                .unwrap()
                .provider
                .as_str(),
            "openai"
        );
        assert!(pools.select("pool:chat", None, |_, _| false).is_err());
    }

    #[test]
    fn rejects_an_unbounded_number_of_pools() {
        let mut routing = RoutingConfig::default();
        for index in 0..129 {
            routing.provider_pools.insert(
                format!("pool-{index}"),
                ProviderPoolConfig {
                    strategy: ProviderPoolStrategy::Priority,
                    sticky_limit: 1,
                    wait_for_cooldown_ms: 0,
                    members: vec![member("openai", "gpt-4o-mini")],
                    execution: Default::default(),
                    judge: None,
                    auto_weights: None,
                },
            );
        }
        assert!(ProviderPools::new(&routing).is_err());
    }

    #[test]
    fn rejects_service_only_members_but_keeps_multimodal_chat_providers() {
        for provider in [
            "voyage",
            "jina",
            "cohere",
            "deepgram",
            "assemblyai",
            "elevenlabs",
            "inworld",
            "edge-tts",
            "google-tts",
            "polly",
            "fal",
            "replicate",
            "bfl",
            "stability",
            "recraft",
            "minimax",
            "runway",
            "classify",
        ] {
            let mut routing = RoutingConfig::default();
            routing.provider_pools.insert(
                "chat".to_owned(),
                ProviderPoolConfig {
                    strategy: ProviderPoolStrategy::Priority,
                    sticky_limit: 1,
                    wait_for_cooldown_ms: 0,
                    members: vec![member(provider, "example-model")],
                    execution: Default::default(),
                    judge: None,
                    auto_weights: None,
                },
            );
            assert!(ProviderPools::new(&routing).is_err(), "{provider}");
        }

        for descriptor in ryu_gw_credentials::web::WEB_PROVIDERS {
            let mut routing = RoutingConfig::default();
            routing.provider_pools.insert(
                "chat".to_owned(),
                ProviderPoolConfig {
                    strategy: ProviderPoolStrategy::Priority,
                    sticky_limit: 1,
                    wait_for_cooldown_ms: 0,
                    members: vec![member(descriptor.provider_id, "example-model")],
                    execution: Default::default(),
                    judge: None,
                    auto_weights: None,
                },
            );
            assert!(
                ProviderPools::new(&routing).is_err(),
                "{}",
                descriptor.provider_id
            );
        }

        for provider in ["openai", "qwen"] {
            let mut routing = RoutingConfig::default();
            routing.provider_pools.insert(
                "chat".to_owned(),
                ProviderPoolConfig {
                    strategy: ProviderPoolStrategy::Priority,
                    sticky_limit: 1,
                    wait_for_cooldown_ms: 0,
                    members: vec![member(provider, "example-model")],
                    execution: Default::default(),
                    judge: None,
                    auto_weights: None,
                },
            );
            assert!(ProviderPools::new(&routing).is_ok(), "{provider}");
        }
    }
}
