//! Governed, nonrecursive inference for routing. Algorithms never receive raw providers or keys.
use super::inference_governance::{
    self as governance, CompletionReceipt, InferenceClient, InputShape,
};
use super::*;
use crate::providers::{LocalProvider, Provider};
pub(super) use governance::authorize_model;
use sha2::Digest;
use std::sync::OnceLock;

fn pool_leg_slots() -> &'static Arc<tokio::sync::Semaphore> {
    static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(128)))
}

#[cfg(test)]
pub(super) fn pool_leg_slots_for_test() -> Arc<tokio::sync::Semaphore> {
    Arc::clone(pool_leg_slots())
}

pub(super) fn scope(state: &AppState, ctx: &RequestContext) -> String {
    let policy = ctx
        .resolved_policy
        .clone()
        .unwrap_or_else(|| state.policy_snapshot());
    let scanner = state.resolved_scanner(ctx);
    let material = format!(
        "{}:{:?}:{:?}:{:?}:{:?}:{:?}",
        ctx.api_key,
        ctx.org_id,
        ctx.agent_id,
        ctx.user_id,
        policy,
        scanner.config()
    );
    format!("{:x}", Sha256::digest(material.as_bytes()))
}

pub(super) fn validate_config(
    config: &crate::config::SmartRoutingConfig,
) -> Result<(), GatewayError> {
    if config.rules.len() > 16
        || config
            .rules
            .iter()
            .any(|rule| rule.description.len() > 4096 || rule.model.len() > 256)
        || config.escalation_recent_message_window > 32
        || config.escalation_message_chars > 8192
        || !config.pool().within_limits()
    {
        return Err(GatewayError::BadRequest(
            "routing override exceeds routing limits".into(),
        ));
    }
    Ok(())
}

pub(super) struct GovernedInference {
    state: Arc<AppState>,
    parent: RequestContext,
    purpose: &'static str,
    pool_name: Option<String>,
}
impl GovernedInference {
    pub(super) fn new(
        state: Arc<AppState>,
        mut parent: RequestContext,
        purpose: &'static str,
    ) -> Self {
        super::capture_provider_snapshot(&state, &mut parent);
        Self {
            state,
            parent,
            purpose,
            pool_name: None,
        }
    }

    pub(super) fn for_pool(
        state: Arc<AppState>,
        parent: RequestContext,
        pool_name: String,
    ) -> Self {
        let mut client = Self::new(state, parent, "provider-pool-leg");
        client.pool_name = Some(pool_name);
        client
    }

    /// Whether this sub-call sends the tenant's own text to the provider: the
    /// inspector the user turn, smart routing the last user message or the
    /// recent transcript, the semantic cache the prompt it embeds. A provider
    /// safety refusal of that text is the same refusal the main request would
    /// get, so it is settled against the parent request instead of being read
    /// as "no answer" and failing open into the main dispatch.
    fn carries_tenant_text(&self) -> bool {
        matches!(
            self.purpose,
            "inspector" | "smart-routing" | "semantic-cache"
        )
    }

    async fn dispatch(
        &self,
        model: &str,
        mut body: Value,
        embedding: bool,
        timeout_ms: u64,
    ) -> Result<Option<Value>, GatewayError> {
        let mut ctx = self.parent.clone();
        ctx.request_id = Uuid::new_v4().to_string();
        ctx.feature = Some(self.purpose.into());
        let start = Instant::now();
        let result = self
            .dispatch_inner(&ctx, model, &mut body, embedding, timeout_ms, start, None)
            .await;
        if let Err(error) = &result {
            audit_failure(&self.state, &ctx, model, error, start);
        }
        result
    }

    /// A concrete, nonrecursive execution leg keeps provider/model identity and
    /// account affinity from the captured request generation. `leg` is its
    /// position in the pool plan.
    pub(super) async fn complete_target(
        &self,
        leg: usize,
        target: &super::pool_execution::PoolTarget,
        body: Value,
        timeout_ms: u64,
    ) -> Result<Option<Value>, GatewayError> {
        // A panel quorum or client cancellation stops delivery, not the bounded
        // accepted-work settlement. This owned task holds reservations/load
        // until its provider resolves or its dispatch timeout is recorded.
        let client = Self {
            state: Arc::clone(&self.state),
            parent: self.parent.clone(),
            purpose: self.purpose,
            pool_name: self.pool_name.clone(),
        };
        let target = target.clone();
        let slot = Arc::clone(pool_leg_slots())
            .try_acquire_owned()
            .map_err(|_| GatewayError::Overloaded("Pool execution capacity reached".into()))?;
        // Keep the caller's span and route across the owned task: the leg's provider call
        // opens its own model-call span (and outbound `traceparent` scope)
        // inside the task, in `dispatch_inner`, so it stays in the request's
        // trace.
        tokio::spawn(tracing::Instrument::in_current_span(
            crate::traffic::carry_route(async move {
                let _slot = slot;
                client
                    .complete_target_inner(leg, &target, body, timeout_ms)
                    .await
            }),
        ))
        .await
        .map_err(|_| {
            GatewayError::ProviderDeliveryUncertain(
                "Pool dispatch task ended before settlement".into(),
            )
        })?
    }

    async fn complete_target_inner(
        &self,
        leg: usize,
        target: &super::pool_execution::PoolTarget,
        mut body: Value,
        timeout_ms: u64,
    ) -> Result<Option<Value>, GatewayError> {
        let mut ctx = self.parent.clone();
        ctx.request_id = Uuid::new_v4().to_string();
        ctx.feature = Some(self.purpose.into());
        let start = Instant::now();
        let route = self.pool_name.as_ref().and_then(|name| {
            super::provider_snapshot(&self.state, &ctx)
                .provider_pools
                .target_route(name, &target.provider, &target.model)
        });
        let _load = route.as_ref().and_then(|route| {
            super::provider_snapshot(&self.state, &ctx)
                .provider_pools
                .acquire(route)
        });
        let facts = super::pool_signals::scoped_request_facts(&self.state, &ctx, &body);
        let result = self
            .dispatch_inner(
                &ctx,
                &target.model,
                &mut body,
                false,
                timeout_ms,
                start,
                Some(target),
            )
            .await;
        // A pool leg carries the tenant's own body, so a provider safety
        // refusal of it is an upstream signal like any direct attempt's. It
        // is settled against the parent request, the one the caller sees and
        // the live feed shows, with the leg's position as its attempt so two
        // refusing legs stay two events. Sub-calls through `dispatch` that
        // carry the tenant's text settle in `dispatch_inner` instead.
        let result = result.map_err(|error| {
            super::upstream_signals::settle(&self.state, &self.parent, leg, error)
        });
        if let Some(route) = route {
            let pools = &super::provider_snapshot(&self.state, &ctx).provider_pools;
            match &result {
                Ok(Some(_)) => pools.record_success_facts(
                    &route,
                    super::account_affinity(&ctx, &body).as_deref(),
                    &facts,
                    start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                ),
                Err(GatewayError::ProviderRateLimited { retry_after, .. }) => {
                    pools.record_rate_limit(&route, *retry_after)
                }
                Err(error) if super::penalizes_provider_circuit(error) => {
                    pools.record_failure(&route)
                }
                _ => {}
            }
        }
        result
    }

    async fn dispatch_inner(
        &self,
        ctx: &RequestContext,
        model: &str,
        body: &mut Value,
        embedding: bool,
        timeout_ms: u64,
        start: Instant,
        exact_target: Option<&super::pool_execution::PoolTarget>,
    ) -> Result<Option<Value>, GatewayError> {
        let state = &self.state;
        authorize_model(state, ctx, model)?;
        super::admit_request(state, ctx)?;
        let mut decision = exact_target.map_or_else(
            || super::provider_snapshot(&state, &ctx).router.route(model),
            |target| crate::router::RouteDecision {
                provider: crate::config::ProviderId::from(target.provider.as_str()),
                model: target.model.clone(),
            },
        );
        super::canonicalize_sdk_decision(state, ctx, &mut decision)?;
        governance::enforce_lifetime_budget(state, ctx, body, &mut decision)?;
        let shape = if embedding {
            InputShape::Embedding
        } else {
            InputShape::Chat
        };
        governance::inspect_input(state, ctx, body, shape)?;
        if embedding {
            crate::screening::admit::screen_value(
                state,
                ctx,
                body,
                crate::screening::admit::Surface::Embeddings,
            )
            .await?;
        } else {
            crate::screening::admit::screen_chat_as(
                state,
                ctx,
                body,
                crate::screening::admit::Surface::Chat,
                &decision.model,
            )
            .await?;
        }
        let estimated_input = governance::input_token_estimate(body, shape);
        // Every auxiliary dispatch consumes token admission before egress; actual excess settles as debt.
        let admitted_tokens = estimated_input.saturating_add(if embedding {
            0
        } else {
            body["max_tokens"].as_u64().unwrap_or(8)
        });
        if !state.rate_limiter.check_tokens_for_key(
            &ctx.api_key,
            admitted_tokens,
            ctx.key_config.as_ref(),
        ) || !crate::org_limits::check_tokens(state, ctx, admitted_tokens)
        {
            return Err(GatewayError::RateLimited);
        }
        let local_embedding = embedding && state.config.providers.openai.is_none();
        if embedding {
            decision.provider =
                crate::config::ProviderId::from(if local_embedding { "local" } else { "openai" });
        }
        let original_ceiling = body["max_tokens"].as_u64().unwrap_or(8);
        let BudgetOutcome {
            decision: budget,
            reservation: initial_reservation,
            ..
        } = enforce_sub_call_budget(
            state,
            ctx,
            body,
            &mut decision,
            BudgetChargeKind::Model,
            if embedding {
                OutputCeiling::Untouched
            } else {
                OutputCeiling::Clamp
            },
        )?;
        // Ladder L3 (spec 04.8.1): a routing or pool sub-call of a
        // restricted request dispatches only a listed chat model, never on
        // an own-supply vendor slot.
        if !embedding {
            crate::enforcement::authorize_route(
                state,
                ctx,
                decision.provider.as_str(),
                &decision.model,
            )?;
        }
        if exact_target.is_some_and(|target| {
            decision.model != target.model
                || super::canonical_sdk_provider(
                    state,
                    ctx,
                    &crate::config::ProviderId::from(target.provider.as_str()),
                    &target.model,
                )
                .is_ok_and(|provider| provider != decision.provider)
        }) {
            return Err(GatewayError::BudgetExceeded(None));
        }
        authorize_model(state, ctx, &decision.model)?;
        governance::authorize_provider_region(state, ctx, &decision.provider)?;
        if !embedding {
            body["max_tokens"] = json!(body["max_tokens"]
                .as_u64()
                .unwrap_or(original_ceiling)
                .min(original_ceiling));
        }
        // A budget downgrade may change providers and therefore credit pools.
        // Re-admit the final target atomically instead of retaining a claim against the old pool.
        drop(initial_reservation);
        let reservation = if ctx.is_master_key {
            None
        } else {
            maybe_reserve_credit(
                state,
                ctx,
                body,
                crate::credit_pools::pool_for_gateway_provider(decision.provider.as_str()),
            )?
        };
        let input_reservation =
            governance::reserve_input_credit(state, ctx, &decision, estimated_input)?;
        body["model"] = json!(decision.model);
        let local_provider;
        let registry_provider;
        let provider: &dyn Provider = if local_embedding {
            local_provider =
                LocalProvider::new(state.http.clone(), crate::config::local_embed_base_url());
            &local_provider
        } else {
            let Some(provider) = super::provider_snapshot(&state, &ctx)
                .providers
                .get_owned(decision.provider.as_str())
            else {
                return Ok(None);
            };
            registry_provider = provider;
            registry_provider.as_ref()
        };
        if state.circuit_breaker.is_open(&super::provider_circuit_key(
            &state,
            &ctx,
            provider.name(),
        )) {
            return Ok(None);
        }
        let mut request_body = body.clone();
        super::apply_node_openrouter_preferences(
            state,
            ctx,
            provider.name(),
            &mut request_body,
            false,
        );
        // Pool legs and routing calls reach a provider too, so they carry the
        // same upstream identity as a direct attempt.
        super::stamp_upstream_identity(
            state,
            ctx,
            &mut request_body,
            provider.name(),
            if embedding {
                crate::identity::UpstreamSurface::Embedding
            } else {
                crate::identity::UpstreamSurface::Chat
            },
        );
        let _admission = state
            .admission
            .acquire_for(provider.name(), ctx.priority, ctx.org_id.as_deref())
            .await
            .map_err(|_| GatewayError::Overloaded("Routing provider is busy".into()))?;
        state.metrics.inc_provider_request(provider.name());
        // One CLIENT model-call span per auxiliary / pool-leg provider call; a
        // timeout drops it mid-call, which records it as cancelled.
        let traced = super::gen_ai_telemetry::TracedProvider::new(state, ctx, provider);
        let call = async {
            if embedding {
                traced.embed(&decision.model, &request_body).await
            } else {
                let affinity = super::account_affinity(ctx, &request_body);
                traced
                    .complete_for_session(&decision.model, &request_body, affinity.as_deref())
                    .await
            }
        };
        let mut response = match tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms.clamp(1, 30_000)),
            call,
        )
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                let mut error = GatewayError::from(error);
                // An exact pool leg settles in `complete_target_inner`. A
                // tenant-text sub-call settles here, first, so a refusal on a
                // Ryu-held key records one event under the parent request and
                // ends it rather than failing open. Off the fleet `settle`
                // strips the signal and the sub-call fails open as before.
                if exact_target.is_none() && self.carries_tenant_text() {
                    error = super::upstream_signals::settle(
                        state,
                        &self.parent,
                        super::upstream_signals::AUXILIARY_ATTEMPT,
                        error,
                    );
                    if matches!(error, GatewayError::UpstreamSafetyRefused(_)) {
                        // `dispatch` audits the error it returns.
                        return Err(error);
                    }
                }
                if penalizes_provider_circuit(&error) {
                    state
                        .circuit_breaker
                        .record_failure(&super::provider_circuit_key(
                            &state,
                            &ctx,
                            provider.name(),
                        ));
                }
                audit_failure(state, ctx, &decision.model, &error, start);
                return if exact_target.is_some() {
                    Err(error)
                } else {
                    Ok(None)
                };
            }
            Err(_) => {
                audit_failure(
                    state,
                    ctx,
                    &decision.model,
                    &GatewayError::ProviderError("Routing provider timed out".into()),
                    start,
                );
                return if exact_target.is_some() {
                    Err(GatewayError::ProviderDeliveryUncertain(
                        "Pool execution timed out after dispatch; the leg is not replayed".into(),
                    ))
                } else {
                    Ok(None)
                };
            }
        };
        state
            .circuit_breaker
            .record_success(&super::provider_circuit_key(&state, &ctx, provider.name()));
        let mut exceeded = governance::settle_completion(
            state,
            ctx,
            &response,
            CompletionReceipt {
                provider: provider.name().into(),
                model: decision.model.clone(),
                purpose: Some(self.purpose),
                audit_provider: provider.name().into(),
                backend: Some(if embedding {
                    "auxiliary-embedding"
                } else {
                    "auxiliary-classifier"
                }),
                start,
                admitted_tokens,
                estimated_input,
                budget,
                reservations: [reservation, input_reservation]
                    .into_iter()
                    .flatten()
                    .collect(),
                zero_cost: local_embedding,
            },
        );
        if exact_target.is_some() {
            super::apply_outbound_json_dlp(state, ctx, &mut response).map_err(|error| {
                exceeded.fail(&error);
                error
            })?;
            super::apply_inline_output_evaluators(state, ctx, &mut response)
                .await
                .map_err(|error| {
                    exceeded.fail(&error);
                    error
                })?;
        }
        if exceeded.overrun {
            return Err(GatewayError::RateLimited);
        }
        Ok(Some(response))
    }
}

#[async_trait::async_trait]
impl InferenceClient for GovernedInference {
    fn scope(&self) -> String {
        scope(&self.state, &self.parent)
    }
    async fn complete(
        &self,
        model: &str,
        body: Value,
        timeout_ms: u64,
    ) -> Result<Option<Value>, GatewayError> {
        self.dispatch(model, body, false, timeout_ms).await
    }
    async fn embed(
        &self,
        model: &str,
        text: &str,
        timeout_ms: u64,
    ) -> Result<Option<Vec<f32>>, GatewayError> {
        let Some(response) = self
            .dispatch(
                model,
                json!({"model":model, "input":text}),
                true,
                timeout_ms,
            )
            .await?
        else {
            return Ok(None);
        };
        let Some(values) = response["data"][0]["embedding"]
            .as_array()
            .filter(|values| values.len() <= 8192)
        else {
            return Ok(None);
        };
        Ok(values
            .iter()
            .map(|value| value.as_f64().filter(|v| v.is_finite()).map(|v| v as f32))
            .collect())
    }
}

#[async_trait::async_trait]
impl super::pool_execution::PoolInference for GovernedInference {
    async fn complete(
        &self,
        leg: usize,
        target: &super::pool_execution::PoolTarget,
        body: Value,
        timeout_ms: u64,
    ) -> Result<Option<Value>, GatewayError> {
        self.complete_target(leg, target, body, timeout_ms).await
    }

    fn tools_active(&self) -> bool {
        matches!(
            super::select_tool_loop(
                &self.parent,
                self.state.tools.is_some(),
                self.state.composio.is_some(),
                &self.state.config.tools,
                false,
            ),
            super::ToolLoopKind::Unified | super::ToolLoopKind::Composio
        )
    }

    /// Screen a panel or stage answer before it joins the next leg's body
    /// (P0-4). A refusal is audited against the request that opened the pool.
    fn screen_appended(
        &self,
        next: &super::pool_execution::PoolTarget,
        appended: &Value,
    ) -> Result<(), GatewayError> {
        super::edit_rescan::screen_edit_audited(
            &self.state,
            &self.parent,
            super::edit_rescan::EditSite::PoolLeg,
            appended,
            &next.model,
            Instant::now(),
        )
        .map(|_| ())
    }
}

#[cfg(test)]
#[path = "auxiliary_tests.rs"]
mod tests;
