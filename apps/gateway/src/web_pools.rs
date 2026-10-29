//! Service-only pool selection. Internal selectors never become chat models.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use ryu_gw_credentials::web::{web_provider_by_id, WebOperation, WebProviderKind};
use ryu_gw_router::pool::{PoolMember, ProviderPool};

use crate::config::{ProviderPoolStrategy, RoutingConfig};
use crate::web_config::{operation_name, WebBinding};

#[derive(Debug, Clone)]
pub struct WebPoolRoute {
    pub provider: WebProviderKind,
    pub pool_name: Option<String>,
    pub member_index: Option<usize>,
}

#[derive(Clone, Default)]
pub struct WebServicePools {
    pools: BTreeMap<String, Arc<ProviderPool>>,
    operations: BTreeMap<String, WebOperation>,
}

impl WebServicePools {
    pub fn new(routing: &RoutingConfig) -> Result<Self, String> {
        if routing.web_pools.len() > 128 {
            return Err("At most 128 web service pools are supported".to_owned());
        }
        let mut pools = BTreeMap::new();
        let mut operations = BTreeMap::new();
        for (name, config) in &routing.web_pools {
            if name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return Err("Invalid web pool name".to_owned());
            }
            let mut members = Vec::new();
            for member in &config.members {
                if !member
                    .provider
                    .descriptor()
                    .operations
                    .contains(&config.operation)
                {
                    return Err("Web pool member does not support its operation".to_owned());
                }
                members.push(PoolMember {
                    provider: member.provider.descriptor().provider_id.to_owned(),
                    model: operation_name(config.operation).to_owned(),
                    priority: member.priority,
                    weight: member.weight,
                    enabled: member.enabled,
                    last_resort: false,
                });
            }
            if matches!(
                config.strategy,
                ProviderPoolStrategy::Fusion
                    | ProviderPoolStrategy::Pipeline
                    | ProviderPoolStrategy::ContextRelay
                    | ProviderPoolStrategy::ContextOptimized
                    | ProviderPoolStrategy::CacheOptimized
            ) {
                return Err(
                    "Conversation/execution strategies are only available for chat pools"
                        .to_owned(),
                );
            }
            let strategy = config.strategy;
            pools.insert(
                name.clone(),
                Arc::new(ProviderPool::new(members, strategy)?),
            );
            operations.insert(name.clone(), config.operation);
        }
        let result = Self { pools, operations };
        for operation in [WebOperation::Search, WebOperation::Fetch] {
            if let Some(binding) = routing.web.binding(operation) {
                result.validate_binding(binding, operation)?;
            }
        }
        Ok(result)
    }

    pub fn validate_binding(
        &self,
        binding: &WebBinding,
        operation: WebOperation,
    ) -> Result<(), String> {
        match binding {
            WebBinding::Provider { provider }
                if provider.descriptor().operations.contains(&operation) =>
            {
                Ok(())
            }
            WebBinding::Pool { name } if self.operations.get(name) == Some(&operation) => Ok(()),
            _ => Err("Web binding does not support the requested operation".to_owned()),
        }
    }

    pub(crate) fn new_reusing(
        routing: &RoutingConfig,
        previous_routing: &RoutingConfig,
        previous: &Self,
        unchanged: &HashSet<String>,
    ) -> Result<Self, String> {
        let mut next = Self::new(routing)?;
        for (name, config) in &routing.web_pools {
            let Some(before) = previous_routing.web_pools.get(name) else {
                continue;
            };
            if serde_json::to_value(config).map_err(|_| "Web pool serialization failed")?
                != serde_json::to_value(before).map_err(|_| "Web pool serialization failed")?
            {
                continue;
            }
            if config
                .members
                .iter()
                .all(|member| unchanged.contains(member.provider.descriptor().provider_id))
            {
                if let Some(pool) = previous.pools.get(name) {
                    next.pools.insert(name.clone(), Arc::clone(pool));
                }
            }
        }
        Ok(next)
    }

    pub fn candidates(
        &self,
        binding: &WebBinding,
        operation: WebOperation,
        session: Option<&str>,
        available: impl Fn(WebProviderKind) -> bool,
    ) -> Result<Vec<WebPoolRoute>, String> {
        self.validate_binding(binding, operation)?;
        match binding {
            WebBinding::Provider { provider } => Ok(if available(*provider) {
                vec![WebPoolRoute {
                    provider: *provider,
                    pool_name: None,
                    member_index: None,
                }]
            } else {
                Vec::new()
            }),
            WebBinding::Pool { name } => {
                let pool = self
                    .pools
                    .get(name)
                    .ok_or("Web service pool is not configured")?;
                Ok(pool
                    .candidates(session, |member| {
                        web_provider_by_id(&member.provider)
                            .is_some_and(|descriptor| available(descriptor.kind))
                    })
                    .into_iter()
                    .filter_map(|index| {
                        let provider = web_provider_by_id(&pool.member(index)?.provider)?.kind;
                        Some(WebPoolRoute {
                            provider,
                            pool_name: Some(name.clone()),
                            member_index: Some(index),
                        })
                    })
                    .collect())
            }
        }
    }

    pub fn record_success(&self, route: &WebPoolRoute, session: Option<&str>) {
        if let (Some(name), Some(index)) = (&route.pool_name, route.member_index) {
            if let Some(pool) = self.pools.get(name) {
                pool.record_success(session, index);
            }
        }
    }
    pub fn record_rate_limit(&self, route: &WebPoolRoute, retry_after: Option<u64>) {
        if let (Some(name), Some(index)) = (&route.pool_name, route.member_index) {
            if let Some(pool) = self.pools.get(name) {
                pool.record_rate_limit(index, retry_after);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_config::{WebPoolConfig, WebPoolMemberConfig};
    fn routing() -> RoutingConfig {
        let mut routing = RoutingConfig::default();
        routing.web_pools.insert(
            "search".into(),
            WebPoolConfig {
                operation: WebOperation::Search,
                strategy: ProviderPoolStrategy::RoundRobin,
                members: vec![
                    WebPoolMemberConfig {
                        provider: WebProviderKind::Tavily,
                        priority: 0,
                        weight: 1,
                        enabled: true,
                    },
                    WebPoolMemberConfig {
                        provider: WebProviderKind::Brave,
                        priority: 0,
                        weight: 1,
                        enabled: true,
                    },
                ],
            },
        );
        routing.web.search = Some(WebBinding::Pool {
            name: "search".into(),
        });
        routing
    }
    #[test]
    fn operations_are_separate_and_request_eligibility_filters_without_chat_aliases() {
        let routing = routing();
        let pools = WebServicePools::new(&routing).unwrap();
        let binding = routing.web.search.as_ref().unwrap();
        assert!(pools
            .candidates(binding, WebOperation::Fetch, None, |_| true)
            .is_err());
        let routes = pools
            .candidates(binding, WebOperation::Search, None, |kind| {
                kind == WebProviderKind::Brave
            })
            .unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].provider, WebProviderKind::Brave);
        let mut wrong = routing.clone();
        wrong.web_pools.get_mut("search").unwrap().members[0].provider = WebProviderKind::Firecrawl;
        assert!(WebServicePools::new(&wrong).is_err());
    }
    #[test]
    fn unchanged_service_pool_retains_affinity_changed_member_feedback_is_isolated() {
        let routing = routing();
        let original = WebServicePools::new(&routing).unwrap();
        let reused = WebServicePools::new_reusing(
            &routing,
            &routing,
            &original,
            &HashSet::from(["tavily".into(), "brave".into()]),
        )
        .unwrap();
        assert!(Arc::ptr_eq(
            &original.pools["search"],
            &reused.pools["search"]
        ));
        let changed = WebServicePools::new_reusing(
            &routing,
            &routing,
            &original,
            &HashSet::from(["brave".into()]),
        )
        .unwrap();
        assert!(!Arc::ptr_eq(
            &original.pools["search"],
            &changed.pools["search"]
        ));
        let binding = routing.web.search.as_ref().unwrap();
        let routes = original
            .candidates(
                binding,
                WebOperation::Search,
                Some("tenant:client:search"),
                |_| true,
            )
            .unwrap();
        original.record_rate_limit(&routes[0], Some(3600));
        assert_eq!(
            changed
                .candidates(binding, WebOperation::Search, None, |_| true)
                .unwrap()
                .len(),
            2
        );
    }
}
