//! Request-local routing observations from the captured provider generation.
use super::*;
use ryu_gw_router::pool::{MemberSignals, PoolRequest};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn request_facts(body: &Value) -> PoolRequest {
    let input_tokens =
        inference_governance::input_token_estimate(body, inference_governance::InputShape::Chat);
    let output_tokens = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
        .and_then(Value::as_u64);
    // Only the reusable prefix is keyed, never the raw prompt or a credential.
    let prefix = body
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .take_while(|message| {
                    matches!(message["role"].as_str(), Some("system" | "developer"))
                })
                .collect::<Vec<_>>()
        });
    let cache_prefix = prefix
        .filter(|messages| !messages.is_empty())
        .and_then(|messages| serde_json::to_vec(&messages).ok())
        .map(|bytes| {
            use sha2::Digest;
            format!("{:x}", Sha256::digest(bytes))
        });
    PoolRequest {
        now_ms: now_ms(),
        signal_max_age_ms: 300_000,
        input_tokens: Some(input_tokens),
        output_tokens,
        cache_prefix,
        ..Default::default()
    }
}

pub(super) fn scoped_request_facts(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
) -> PoolRequest {
    let mut facts = request_facts(body);
    if let Some(prefix) = facts.cache_prefix.take() {
        facts.cache_prefix = Some(format!("{}:{}", auxiliary::scope(state, ctx), prefix));
    }
    facts
}

pub(super) fn member_facts(
    state: &AppState,
    ctx: &RequestContext,
    request: &PoolRequest,
) -> HashMap<(String, String), MemberSignals> {
    let snapshot = provider_snapshot(state, ctx);
    let mut facts = HashMap::new();
    for pool in snapshot.routing.provider_pools.values() {
        for member in &pool.members {
            let Ok(provider) = canonical_sdk_provider(state, ctx, &member.provider, &member.model)
            else {
                continue;
            };
            let observation = snapshot.quota.observation(provider.as_str());
            let observed_at_ms = observation
                .as_ref()
                .map(|row| row.observed_at.saturating_mul(1000));
            let reset_in_ms = observation
                .as_ref()
                .and_then(|row| row.reset_at)
                .map(|seconds| seconds.saturating_mul(1000))
                .filter(|deadline| *deadline > request.now_ms)
                .map(|deadline| deadline - request.now_ms);
            // A zero reading hard-excludes the member, so it only counts until the
            // provider-reported reset. A 429 without one is left to the pool's own
            // retry-after cooldown. A rotating provider's reading is one key's view;
            // its account pool already tracks per-key exhaustion.
            let rotating = snapshot
                .providers
                .get(provider.as_str())
                .is_some_and(|provider| provider.has_rotating_accounts());
            let remaining_fraction = observation
                .as_ref()
                .and_then(|row| row.remaining.zip(row.limit))
                .filter(|(remaining, limit)| *limit > 0 && remaining <= limit)
                .map(|(remaining, limit)| remaining as f64 / limit as f64)
                .filter(|fraction| *fraction > 0.0 || (reset_in_ms.is_some() && !rotating));
            let reset_window_ms = observation
                .as_ref()
                .and_then(|row| row.window_seconds)
                .map(|seconds| seconds.saturating_mul(1000));
            // Price ranking uses only an authored per-model price, never the flat unknown-model fallback.
            let known_price = state
                .config
                .control_plane
                .model_pricing
                .iter()
                .filter(|(model, _)| member.model.starts_with(model.as_str()))
                .max_by_key(|(model, _)| model.len())
                .map(|(_, price)| price);
            let estimated_cost_micro_usd = known_price.and_then(|price| {
                request
                    .input_tokens
                    .zip(request.output_tokens)
                    .map(|(input, output)| {
                        (input.saturating_mul(price.input_per_1k_micro_usd) / 1000).saturating_add(
                            output.saturating_mul(price.output_per_1k_micro_usd) / 1000,
                        )
                    })
            });
            facts.insert(
                (member.provider.as_str().to_owned(), member.model.clone()),
                MemberSignals {
                    observed_at_ms,
                    estimated_cost_micro_usd,
                    remaining_fraction,
                    reset_in_ms,
                    reset_window_ms,
                    quota_windows: remaining_fraction
                        .map(|remaining_fraction| {
                            vec![ryu_gw_router::pool::QuotaWindowSignal {
                                remaining_fraction,
                                reset_in_ms,
                                window_ms: reset_window_ms,
                            }]
                        })
                        .unwrap_or_default(),
                    context_tokens: member.context_tokens,
                    ..Default::default()
                },
            );
        }
    }
    facts
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool_state(openai_keys: Vec<String>) -> AppState {
        let mut config = crate::config::GatewayConfig::default();
        config.providers.openai = Some(crate::config::OpenAiProviderConfig {
            api_key: "openai-test-key".to_owned(),
            api_keys: openai_keys,
            base_url: "http://127.0.0.1:9/v1".to_owned(),
        });
        config.routing.provider_pools.insert(
            "solo".to_owned(),
            crate::config::ProviderPoolConfig {
                strategy: crate::config::ProviderPoolStrategy::RoundRobin,
                sticky_limit: 1,
                wait_for_cooldown_ms: 0,
                members: vec![crate::config::ProviderPoolMemberConfig {
                    provider: ProviderId::from("openai"),
                    model: "gpt-4o-mini".to_owned(),
                    priority: 0,
                    weight: 1,
                    enabled: true,
                    last_resort: false,
                    context_tokens: None,
                }],
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        AppState::new_for_test(config, audit, evals)
    }

    fn remaining(state: &AppState) -> Option<f64> {
        let ctx = test_support::plain_request_context();
        let request = PoolRequest {
            now_ms: now_ms(),
            signal_max_age_ms: 300_000,
            ..Default::default()
        };
        member_facts(state, &ctx, &request)
            .remove(&("openai".to_owned(), "gpt-4o-mini".to_owned()))
            .expect("pool member facts")
            .remaining_fraction
    }

    fn seen_limit(state: &AppState) {
        let ctx = test_support::plain_request_context();
        provider_snapshot(state, &ctx).quota.record_success(
            "openai",
            &ryu_gw_providers::RateLimitInfo {
                remaining: Some(40),
                limit: Some(100),
                reset_at: None,
                retry_after: None,
            },
        );
    }

    #[test]
    fn zero_reading_without_a_reset_deadline_does_not_hide_the_member() {
        let state = pool_state(Vec::new());
        seen_limit(&state);
        assert_eq!(remaining(&state), Some(0.4));
        // A 429 with only retry-after: the pool cooldown governs, not a 5-minute
        // facts-based exclusion.
        let ctx = test_support::plain_request_context();
        provider_snapshot(&state, &ctx)
            .quota
            .record_rate_limited("openai", Some(2), None);
        assert_eq!(remaining(&state), None);
    }

    #[test]
    fn zero_reading_excludes_only_until_the_reported_reset() {
        let state = pool_state(Vec::new());
        seen_limit(&state);
        let ctx = test_support::plain_request_context();
        let reset_at = now_ms() / 1000 + 60;
        provider_snapshot(&state, &ctx).quota.record_rate_limited(
            "openai",
            Some(2),
            Some(reset_at),
        );
        assert_eq!(remaining(&state), Some(0.0));
        provider_snapshot(&state, &ctx).quota.record_rate_limited(
            "openai",
            Some(2),
            Some(now_ms() / 1000 - 1),
        );
        assert_eq!(remaining(&state), None);
    }

    #[test]
    fn one_exhausted_key_does_not_hide_a_rotating_provider() {
        let state = pool_state(vec!["openai-second-key".to_owned()]);
        seen_limit(&state);
        let ctx = test_support::plain_request_context();
        provider_snapshot(&state, &ctx).quota.record_rate_limited(
            "openai",
            Some(2),
            Some(now_ms() / 1000 + 60),
        );
        assert_eq!(remaining(&state), None);
    }
}
