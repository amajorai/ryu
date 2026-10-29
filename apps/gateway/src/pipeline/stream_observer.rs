use super::*;

/// State threaded through the stream observer unfold loop.
pub(super) struct StreamObserverState {
    pub(super) inner: axum::body::BodyDataStream,
    pub(super) state: Arc<AppState>,
    pub(super) ctx: RequestContext,
    pub(super) provider_name: String,
    pub(super) model: String,
    pub(super) prompt_cache_outcome: ryu_gw_providers::PromptCacheOutcome,
    /// Fallback estimate used when the provider emits no usage frame.
    pub(super) estimated_input_tokens: u64,
    pub(super) start: Instant,
    pub(super) accumulated: String,
    pub(super) done: bool,
    /// Managed policy-alert tier (item 4) carried to the stream-end debit so the
    /// control plane can email owners. `None` unless a budget cap with tier >=
    /// Warn matched this (streaming) request.
    pub(super) budget_alert_tier: Option<AlertTier>,
    /// The credit claim taken at admission. It moves into the debit task and is
    /// released only after that debit resolves, so a concurrent request cannot
    /// spend the same headroom in the gap between the last byte and the debit.
    pub(super) credit_reservation: Option<CreditReservation>,
    /// The provider rounds of a buffered tool loop. When set, they are what
    /// this stream bills: the body is only synthesized from the last round,
    /// so its usage frame would leave the earlier rounds out.
    pub(super) tool_rounds: Option<tool_rounds::ToolRoundTotals>,
    /// Why the stream ended early, for the audit row of a settlement that is
    /// not a mid-stream disconnect (a hang-up before the first byte, a tool
    /// loop that failed after paid rounds).
    pub(super) interruption: Option<&'static str>,
    /// OTel GenAI model-call span, ended at stream end (or marked
    /// `stream_disconnected` if the stream is dropped first).
    pub(super) model_span: Option<crate::telemetry::gen_ai_span::ModelCallSpan>,
    /// Latest (inbound-DLP-processed) user prompt, kept only while online
    /// evals run so the stream end can offer the exchange for scoring.
    pub(super) online_prompt: Option<String>,
}

/// The token counts a stream settles with.
pub(super) struct StreamUsage {
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    /// True when either count came from an estimate rather than the
    /// provider's usage frame.
    pub(super) estimated: bool,
    /// Prompt-cache reads and writes inside `input_tokens` (a tool loop's:
    /// every round's, summed), priced at their own rates.
    pub(super) cache: Option<provider_usage::ProviderCacheUsage>,
}

impl StreamObserverState {
    /// An observer for a stream that has not opened yet. [`observe_stream`]
    /// gives it the body; dropped without one, it settles the dispatched
    /// prompt (see [`StreamOpening`]).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(
        state: Arc<AppState>,
        ctx: RequestContext,
        provider_name: String,
        model: String,
        prompt_cache_outcome: ryu_gw_providers::PromptCacheOutcome,
        estimated_input_tokens: u64,
        start: Instant,
        budget_alert_tier: Option<AlertTier>,
        credit_reservation: Option<CreditReservation>,
    ) -> Self {
        Self {
            inner: Body::empty().into_data_stream(),
            state,
            ctx,
            provider_name,
            model,
            prompt_cache_outcome,
            estimated_input_tokens,
            start,
            accumulated: String::new(),
            done: false,
            budget_alert_tier,
            credit_reservation,
            tool_rounds: None,
            interruption: None,
            model_span: None,
            online_prompt: None,
        }
    }

    /// Keep the prompt for online evals (no-op when they are not running).
    pub(super) fn with_online_prompt(mut self, body: &Value) -> Self {
        if self.state.online_evals.is_running() {
            self.online_prompt = Some(crate::online_evals::latest_user_text(body));
        }
        self
    }

    /// Read the provider's usage frame, estimating whatever it did not report:
    /// the prompt from the request body, the output from the generated text.
    /// A tool loop's stream bills its provider rounds instead.
    pub(super) fn usage(&self) -> StreamUsage {
        if let Some(rounds) = self.tool_rounds {
            return StreamUsage {
                input_tokens: rounds.input_tokens,
                output_tokens: rounds.output_tokens,
                estimated: rounds.estimated,
                cache: rounds.cache_usage(),
            };
        }
        let (raw_input, raw_output) = sse_parse_usage(&self.accumulated);
        let input_tokens = if raw_input > 0 {
            raw_input
        } else {
            self.estimated_input_tokens
        };
        let output_tokens = if raw_output > 0 {
            raw_output
        } else {
            sse_estimate_output_tokens(&self.accumulated)
        };
        StreamUsage {
            input_tokens,
            output_tokens,
            estimated: (raw_input == 0 && input_tokens > 0)
                || (raw_output == 0 && output_tokens > 0),
            cache: sse_parse_cache_usage(&self.accumulated),
        }
    }

    /// Settle the per-minute token limits with what this stream used.
    /// Admission took the prompt estimate; the rest is carried as debt. A tool
    /// loop's earlier rounds are recorded within one window instead (see
    /// [`record_earlier_round_tokens`]): billing counts every round, but only
    /// the last one is judged against the limit, as before rounds were metered.
    pub(super) fn settle_token_limits(&self, total_tokens: u64) {
        let earlier = self
            .tool_rounds
            .map_or(0, |rounds| rounds.earlier_round_tokens());
        let settled = total_tokens
            .saturating_sub(earlier)
            .saturating_sub(self.estimated_input_tokens);
        self.state.rate_limiter.record_tokens_for_key(
            &self.ctx.api_key,
            settled,
            self.ctx.key_config.as_ref(),
        );
        crate::org_limits::settle_tokens(&self.state, &self.ctx, settled);
        record_earlier_round_tokens(&self.state, &self.ctx, earlier);
    }

    /// The provider-reported cost (USD) of what this stream bills.
    pub(super) fn reported_cost(&self) -> Option<f64> {
        match self.tool_rounds {
            Some(rounds) => rounds.reported_cost_usd(),
            None => sse_parse_cost(&self.accumulated),
        }
    }

    /// Charge this stream exactly once, on whichever exit runs first: the end
    /// of the upstream body or the observer being dropped (a client hang-up, a
    /// DLP refusal, a pool byte/deadline cut-off). Provider spend happened in
    /// every one of those cases.
    ///
    /// Local budget counters are advanced here. The wallet debit runs on a
    /// spawned task, never inline: an inline await at stream end is cancelled
    /// when the client disconnects during it, and a `Drop` cannot await at
    /// all. The debit is idempotent on `refId = request_id`. The credit claim
    /// moves into that task and is released after the debit resolves.
    pub(super) fn settle_billing(
        &mut self,
        usage: &StreamUsage,
        reported_cost: Option<f64>,
        latency_ms: u64,
    ) {
        let cache = usage.cache;
        let budget_cost_micro_usd = charged_budget_cost_micro_usd(
            &self.state,
            Some(self.provider_name.as_str()),
            reported_cost,
            usage.input_tokens,
            usage.output_tokens,
            &self.model,
            cache,
        );
        record_charged_budget(&self.state, &self.ctx, budget_cost_micro_usd);

        let reservation = self.credit_reservation.take();
        let Some(org_id) = self.ctx.org_id.clone().filter(|org| !org.is_empty()) else {
            return;
        };
        if !self.state.config.credits.is_active() {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            // No runtime to deliver the debit on. Same rule as
            // `settle_completion`: never let the next managed request spend
            // past an undelivered charge.
            self.state
                .wallet
                .set_org_accounting_unavailable(&org_id, true);
            return;
        };
        let cost = response_cost_micro_usd(
            &self.state,
            Some(self.provider_name.as_str()),
            reported_cost,
            usage.input_tokens,
            usage.output_tokens,
            &self.model,
            cache,
        );
        let fail_closed_sticky =
            self.state.config.credits.fail_closed && self.ctx.managed_inference;
        let attribution = DebitAttribution {
            provider: Some(self.provider_name.clone()),
            upstream_provider: provider_usage::sse_parse_openrouter_provider(&self.accumulated),
            model: Some(self.model.clone()),
            input_tokens: Some(usage.input_tokens),
            output_tokens: Some(usage.output_tokens),
            // Time to stream end (or to the hang-up): the work actually billed.
            duration_ms: Some(latency_ms),
            user_id: self.ctx.user_id.clone(),
            task_label: None,
            // Same meaning as `settle_completion`: anything not priced from the
            // provider's own report is an estimate on the statement.
            estimated: Some(usage.estimated || reported_cost.is_none()),
            tags: crate::org_limits::tags_for(&self.ctx),
        };
        let state = Arc::clone(&self.state);
        let ref_id = self.ctx.request_id.clone();
        let budget_alert_tier = self.budget_alert_tier;
        // The same authoritative attribution as the non-streaming path: the
        // provider that actually served the bytes picks the credit pool.
        let pool = crate::credit_pools::pool_for_gateway_provider(&self.provider_name);
        handle.spawn(async move {
            debit_wallet_for_request(
                state,
                org_id,
                ref_id,
                CreditDebitReason::GatewayUsage,
                cost,
                fail_closed_sticky,
                budget_alert_tier,
                pool,
                attribution,
            )
            .await;
            drop(reservation);
        });
    }
}

impl Drop for StreamObserverState {
    fn drop(&mut self) {
        if let Some(mut span) = self.model_span.take() {
            span.record_error("stream_disconnected");
            gen_ai_telemetry::finish_stream(span, &self.accumulated);
        }
        if self.done {
            return;
        }
        self.done = true;
        let usage = self.usage();
        let (input_tokens, output_tokens) = (usage.input_tokens, usage.output_tokens);
        let latency_ms = self.start.elapsed().as_millis() as u64;
        let total_tokens = input_tokens.saturating_add(output_tokens);
        self.state.audit.add_tokens(&self.ctx.api_key, total_tokens);
        self.state.metrics.add_tokens(input_tokens, output_tokens);
        self.settle_token_limits(total_tokens);
        let reported_cost = self.reported_cost();
        self.settle_billing(&usage, reported_cost, latency_ms);
        let error = if self.accumulated.len() >= 8 * 1024 * 1024 {
            "response stream exceeded the 8 MiB scan limit"
        } else {
            self.interruption
                .unwrap_or("stream disconnected before completion; usage estimated")
        };
        let cache_read_reported = sse_parse_cached_tokens_reported(&self.accumulated);
        let cache_write_reported = sse_parse_cache_write_tokens_reported(&self.accumulated);
        if let Some(tokens) = cache_read_reported.filter(|tokens| *tokens > 0) {
            self.state.metrics.add_cached_tokens(tokens);
        }
        if let Some(tokens) = cache_write_reported.filter(|tokens| *tokens > 0) {
            self.state.metrics.add_cache_write_tokens(tokens);
        }
        self.state.log_audit(AuditRecord {
            request_id: self.ctx.request_id.clone(),
            api_key: self.ctx.api_key.clone(),
            user_name: self.ctx.user_name.clone(),
            org_id: self.ctx.org_id.clone(),
            team_id: self.ctx.team_id.clone(),
            team_ids: self.ctx.audit_team_ids(),
            key_id: self.ctx.key_id(),
            project_id: None,
            provider: self.provider_name.clone(),
            model: self.model.clone(),
            input_tokens,
            output_tokens,
            // The same legs the debit priced, so the usage reporter's rollup
            // re-prices this row as the wallet was charged.
            cache_read_tokens: usage.cache.map(|cache| cache.read_tokens),
            cache_write_tokens: usage.cache.map(|cache| cache.write_tokens),
            cache_hit: false,
            prompt_cache_outcome: Some(self.prompt_cache_outcome.as_str().to_owned()),
            prompt_cache_read_tokens: cache_read_reported,
            prompt_cache_write_tokens: cache_write_reported,
            cache_write_1h_tokens: usage.cache.map(|cache| cache.write_1h_tokens),
            latency_ms,
            eval_score: None,
            error: Some(error.to_owned()),
            skill_ids: self.ctx.skill_ids.clone(),
            session_id: self.ctx.session_id.clone(),
            user_id: self.ctx.user_id.clone(),
            agent_id: self.ctx.agent_id.clone(),
            feature: self.ctx.feature.clone(),
            purpose: self.ctx.purpose.clone(),
            managed_inference: self.ctx.managed_inference,
            provider_cost_micro_usd: reported_cost.and_then(cost_usd_to_micro),
            event_type: crate::audit::EventType::ModelCall,
            backend: None,
            command: None,
            duration_ms: None,
            exit_code: None,
            widget_instance_id: None,
        });
    }
}
