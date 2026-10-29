use super::*;

use crate::server::subscription_costs::SubscriptionCostAttribution;

impl AcpTurnState {
    /// Fold a usage frame into the running totals and re-emit the `acp-usage` stats.
    pub(crate) fn on_usage(
        &mut self,
        em: &AcpEmitter,
        refs: AcpTurnRefs<'_>,
        history_turn: &crate::usage_history::live::TurnHistory,
        cost_attribution: &Option<SubscriptionCostAttribution>,
        mut u: Value,
    ) {
        let AcpTurnRefs {
            conversation_id,
            agent_id,
            ..
        } = refs;
        // The managed Pi reports its token and cache counts out of
        // band (pi-acp forwards only occupancy); fold them into the
        // turn-end frame before anything reads it.
        if u.get("done").and_then(Value::as_bool) == Some(true) {
            if let Some(conversation) = conversation_id.as_deref() {
                acp::merge_reported_usage(conversation, &agent_id, &mut u);
            }
        }
        // Merge whatever this frame carries into the running accumulator,
        // then re-emit the FULL stats object under the stable `acp-usage`
        // id so the AI SDK reconciles it in place (a live meter). The
        // final frame (`done: true`) carries Core-computed wall-clock
        // duration + tokens/sec, so the desktop UI works even when the
        // agent reported no token usage at all.
        // A live `usage_update` frame (`done: false`) carries the
        // agent's true context occupancy. The turn-end frame's `used`
        // is only a cumulative-token fallback for agents that send no
        // live frames, so it must not overwrite a live reading — it
        // pushed the context ring to session-cumulative totals (and
        // past 100%).
        let turn_end_frame = u.get("done").and_then(Value::as_bool) == Some(true);
        if let Some(v) = u.get("used").and_then(Value::as_u64) {
            if !(turn_end_frame && self.usage_used.is_some()) {
                self.usage_used = Some(v);
            }
        }
        if let Some(v) = u.get("total").and_then(Value::as_u64) {
            self.usage_total = Some(v);
        }
        if let Some(v) = u.get("promptTokens").and_then(Value::as_u64) {
            self.usage_prompt = Some(v);
        }
        if let Some(v) = u.get("completionTokens").and_then(Value::as_u64) {
            self.usage_completion = Some(v);
        }
        if let Some(v) = u.get("totalTokens").and_then(Value::as_u64) {
            self.usage_total_tokens = Some(v);
        }
        if let Some(v) = u.get("thoughtTokens").and_then(Value::as_u64) {
            self.usage_thought = Some(v);
        }
        if let Some(v) = u.get("cachedReadTokens").and_then(Value::as_u64) {
            self.usage_cached_read = Some(v);
        }
        if let Some(v) = u.get("cachedWriteTokens").and_then(Value::as_u64) {
            self.usage_cached_write = Some(v);
        }
        if let Some(v) = u.get("sessionTotalTokens").and_then(Value::as_u64) {
            self.usage_session_total = Some(v);
        }
        if let Some(model) = u.get("model").and_then(Value::as_str) {
            self.usage_model = Some(model.to_owned());
        }
        if let (Some(amount), Some(currency)) = (
            u.get("sessionCostAmount").and_then(Value::as_f64),
            u.get("sessionCostCurrency").and_then(Value::as_str),
        ) {
            self.usage_cost = Some((amount, currency.to_owned()));
        }
        let done = u.get("done").and_then(Value::as_bool).unwrap_or(false);
        if done {
            history_turn.record(&u);
            if let Some(conversation_id) = conversation_id.as_deref() {
                prompt_cache_warmth::observe_turn(
                    conversation_id,
                    &agent_id,
                    history_turn.provider_id(),
                    history_turn.model_id(),
                    self.usage_cached_read,
                    self.usage_cached_write,
                );
            }
            if let Some(attribution) = cost_attribution.as_ref() {
                if let Err(error) = attribution.store.record_completed_turn(
                    attribution,
                    chrono::Utc::now(),
                    self.usage_prompt,
                    self.usage_completion,
                ) {
                    tracing::warn!(error = %error, "subscription cost turn could not be recorded");
                }
            }
        }
        let duration_ms = self.turn_start.elapsed().as_millis() as u64;
        let round2 = |x: f64| (x * 100.0).round() / 100.0;
        // `None`, not 0.0, when the agent reported no output tokens —
        // most ACP agents populate none of `PromptResponse.usage`
        // (`unstable_end_turn_token_usage`), and
        // a hard zero rendered as a literal "0 tok/s" in the transcript
        // footer. An absent counter must stay absent all the way to the
        // UI so the segment can be suppressed instead of lying.
        // Speed is over generating time only: from the first visible
        // output, minus the time spent running tools and waiting on
        // permission prompts (`duration_ms` stays the whole turn).
        let generating_ms = self
            .tool_pauses
            .active_between(
                self.first_response_at.unwrap_or(self.turn_start),
                std::time::Instant::now(),
            )
            .as_millis() as u64;
        let tokens_per_second = match self.usage_completion {
            Some(c) if c > 0 && generating_ms > 0 => {
                Some(round2(c as f64 / (generating_ms as f64 / 1000.0)))
            }
            _ => None,
        };
        let mut stats = serde_json::Map::new();
        history_turn.annotate(&mut stats);
        stats.insert("done".into(), serde_json::json!(done));
        stats.insert("id".into(), serde_json::json!("acp-usage"));
        if let Some(v) = self.usage_used {
            stats.insert("used".into(), serde_json::json!(v));
        } else if let Some(v) = self.usage_total_tokens {
            stats.insert("used".into(), serde_json::json!(v));
        } else if let (Some(p), Some(c)) = (self.usage_prompt, self.usage_completion) {
            if let Some(total) = acp::total_usage_tokens(p, c) {
                stats.insert("used".into(), serde_json::json!(total));
            }
        }
        if let Some(v) = self.usage_total {
            stats.insert("total".into(), serde_json::json!(v));
        }
        if let Some(v) = self.usage_prompt {
            stats.insert("promptTokens".into(), serde_json::json!(v));
        }
        if let Some(v) = self.usage_completion {
            stats.insert("completionTokens".into(), serde_json::json!(v));
        }
        if let Some(v) = self.usage_total_tokens {
            stats.insert("totalTokens".into(), serde_json::json!(v));
        }
        if let Some(v) = self.usage_thought {
            stats.insert("thoughtTokens".into(), serde_json::json!(v));
        }
        if let Some(v) = self.usage_cached_read {
            stats.insert("cachedReadTokens".into(), serde_json::json!(v));
            stats.insert("cacheReadTokens".into(), serde_json::json!(v));
        }
        if let Some(v) = self.usage_cached_write {
            stats.insert("cachedWriteTokens".into(), serde_json::json!(v));
            stats.insert("cacheWriteTokens".into(), serde_json::json!(v));
        }
        if let Some(v) = derive_cache_miss_tokens(
            self.usage_prompt,
            self.usage_cached_read,
            self.usage_cached_write,
        ) {
            stats.insert("cacheMissTokens".into(), serde_json::json!(v));
        }
        if let Some(v) = self.usage_session_total {
            stats.insert("sessionTotalTokens".into(), serde_json::json!(v));
        }
        if let Some(model) = self.usage_model.as_deref() {
            stats.insert("model".into(), serde_json::json!(model));
        }
        if let Some((amount, ref currency)) = self.usage_cost {
            stats.insert("sessionCostAmount".into(), serde_json::json!(amount));
            stats.insert("sessionCostCurrency".into(), serde_json::json!(currency));
        }
        if let Some(v) = tokens_per_second {
            stats.insert("tokensPerSecond".into(), serde_json::json!(v));
        }
        for key in [
            "context_window",
            "contextWindow",
            "current_usage",
            "currentUsage",
            "cost",
            "costAmount",
            "costCurrency",
            "currency",
        ] {
            if let Some(value) = u.get(key) {
                stats.insert(key.to_owned(), value.clone());
            }
        }
        if let Ok(elapsed) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            stats.insert(
                "observedAt".into(),
                serde_json::json!(elapsed.as_millis() as u64),
            );
        }
        // Time to the agent's first visible output (text OR reasoning).
        // Absent when the turn produced neither, so the UI omits the row
        // rather than claiming 0 ms.
        if let Some(t) = self.first_response_at {
            stats.insert(
                "ttftMs".into(),
                serde_json::json!(t.duration_since(self.turn_start).as_millis() as u64),
            );
        }
        stats.insert("durationMs".into(), serde_json::json!(duration_ms));
        stats.insert("done".into(), serde_json::json!(done));
        let stats = Value::Object(stats);
        // Seal only the turn-end frame: live frames reconcile in place
        // on the wire, but each `acc.data` call appends a part. A turn
        // with no output gets no row just to hold its counters.
        if done && !(self.reply.is_empty() && self.acc.is_empty()) {
            self.acc.data("acp-usage", &stats);
        }
        em.emit(ui_data("acp-usage", &stats));
        // Same numbers, second consumer: the workspace context panel
        // derives its opaque `agent_baseline` row by subtracting what
        // Core injected from what the agent says the prompt cost.
        // `used` (the agent's own window occupancy) is the better input
        // than `promptTokens` here — an ACP agent reports occupancy for
        // the whole session, not one request.
    }
}
