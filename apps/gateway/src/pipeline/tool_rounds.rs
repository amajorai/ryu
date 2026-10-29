//! Provider rounds of a buffered tool loop, metered one by one.
//!
//! A tool loop calls the provider several times for one request: a round
//! answers with tool calls, the tools run, and the next round reads their
//! results. Every round is provider spend, but the loop returns only the last
//! round. Billing that response alone left every earlier round unbilled, and a
//! client that hung up mid-loop left all of them unbilled.
//!
//! [`MeteredRounds`] wraps the provider the loop calls and records each answered
//! round in a [`ToolRoundLedger`]. The request is then settled from the
//! ledger's [`ToolRoundTotals`] on every exit: the final response, a failed
//! round, or a client that goes away before the first byte.

use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::body::Body;
use ryu_gw_providers::{Provider, ProviderError};
use serde_json::{json, Value};

/// What the answered provider rounds of one tool loop used, summed.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(super) struct ToolRoundTotals {
    /// Rounds the provider answered.
    pub rounds: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// True when a count came from an estimate rather than the provider's
    /// usage block.
    pub estimated: bool,
    /// Sum of the provider-reported `usage.cost` (USD) over the rounds.
    reported_cost_usd: f64,
    /// A round reported no cost, so `reported_cost_usd` is not the whole bill.
    cost_unreported: bool,
    /// Input plus output tokens of the last answered round.
    last_round_tokens: u64,
    /// Prompt-cache reads and writes summed over the answered rounds that
    /// reported them (inside `input_tokens`); `None` when no round did.
    cache: Option<super::provider_usage::ProviderCacheUsage>,
}

impl ToolRoundTotals {
    /// The provider-reported cost of every round, or `None` when any round
    /// reported none. The caller then prices all rounds from their token
    /// counts and marks the charge estimated.
    pub fn reported_cost_usd(&self) -> Option<f64> {
        (self.rounds > 0 && !self.cost_unreported).then_some(self.reported_cost_usd)
    }

    /// Every answered round's prompt-cache reads and writes, summed, so a
    /// token-priced loop bills each round's cached prompt at the cache rate
    /// (as OpenRouter's per-round `usage.cost` does), not only the last one.
    pub fn cache_usage(&self) -> Option<super::provider_usage::ProviderCacheUsage> {
        self.cache
    }

    /// Tokens of every round but the last answered one.
    ///
    /// Billing counts all rounds, but the per-minute token limits judge only
    /// the last round, as they did before rounds were metered: the earlier
    /// rounds are recorded for accounting and never turn into a 429 (see
    /// `record_earlier_round_tokens` in the pipeline).
    pub fn earlier_round_tokens(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_sub(self.last_round_tokens)
    }

    /// Add one answered round. A count the provider did not report is
    /// estimated: the input from the round's request body (`prompt_estimate`),
    /// the output from the text and tool calls it generated.
    fn add_answer(&mut self, response: &Value, prompt_estimate: u64) {
        let usage = &response["usage"];
        let input = usage["prompt_tokens"]
            .as_u64()
            .or_else(|| usage["input_tokens"].as_u64())
            .filter(|tokens| *tokens > 0);
        let output = usage["completion_tokens"]
            .as_u64()
            .or_else(|| usage["output_tokens"].as_u64());
        let estimated_output =
            || super::provider_usage::sse_estimate_output_tokens(&format!("data: {response}\n\n"));
        self.estimated |= input.is_none() || output.is_none();
        let (input, output) = (
            input.unwrap_or(prompt_estimate),
            output.unwrap_or_else(estimated_output),
        );
        self.rounds = self.rounds.saturating_add(1);
        self.input_tokens = self.input_tokens.saturating_add(input);
        self.output_tokens = self.output_tokens.saturating_add(output);
        self.last_round_tokens = input.saturating_add(output);
        if let Some(cache) = super::provider_usage::provider_cache_usage(response) {
            self.cache = Some(self.cache.unwrap_or_default().plus(cache));
        }
        match super::provider_usage::response_reported_cost_usd(response) {
            Some(cost) => self.reported_cost_usd += cost,
            None => self.cost_unreported = true,
        }
    }

    /// Add rounds the provider was still working on when settlement could
    /// wait no longer: their prompts, estimated, and no reported cost.
    fn add_unanswered(&mut self, rounds: u32, prompt_tokens: u64) {
        if rounds == 0 {
            return;
        }
        self.rounds = self.rounds.saturating_add(rounds);
        self.input_tokens = self.input_tokens.saturating_add(prompt_tokens);
        self.estimated = true;
        self.cost_unreported = true;
    }

    /// The `final_response` a non-streaming settlement bills from: its usage
    /// counts, cache details and cost replaced by these totals. Routing
    /// metadata stays that of the final round. The client still receives the
    /// final round's own usage.
    pub fn billing_view(&self, final_response: &Value) -> Value {
        let mut usage = match final_response.get("usage") {
            Some(Value::Object(usage)) => usage.clone(),
            _ => serde_json::Map::new(),
        };
        for key in ["input_tokens", "output_tokens"] {
            usage.remove(key);
        }
        if let Some(cache) = self.cache {
            // The summed legs replace every vocabulary the final round may
            // have used, so a reader cannot fall back to that round's alone.
            for key in [
                "input_tokens_details",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
                "cache_creation",
                "cached_tokens",
                "cache_write_tokens",
            ] {
                usage.remove(key);
            }
            let mut details = json!({
                "cached_tokens": cache.read_tokens,
                "cache_write_tokens": cache.write_tokens,
            });
            if cache.write_1h_tokens > 0 {
                details["cache_write_1h_tokens"] = json!(cache.write_1h_tokens);
            }
            usage.insert("prompt_tokens_details".into(), details);
        }
        usage.insert("prompt_tokens".into(), json!(self.input_tokens));
        usage.insert("completion_tokens".into(), json!(self.output_tokens));
        usage.insert(
            "total_tokens".into(),
            json!(self.input_tokens.saturating_add(self.output_tokens)),
        );
        match self.reported_cost_usd() {
            Some(cost) => usage.insert("cost".into(), json!(cost)),
            None => usage.remove("cost"),
        };
        let mut view = json!({ "usage": usage });
        if let Some(metadata) = final_response.get("openrouter_metadata") {
            view["openrouter_metadata"] = metadata.clone();
        }
        view
    }
}

#[derive(Default)]
struct LedgerState {
    totals: ToolRoundTotals,
    /// Rounds dispatched and not yet answered or failed.
    in_flight_rounds: u32,
    /// Prompt estimates of those rounds.
    in_flight_prompt_tokens: u64,
}

/// The rounds one tool loop has paid for so far.
#[derive(Default)]
pub(super) struct ToolRoundLedger {
    state: Mutex<LedgerState>,
    /// Woken whenever a round ends.
    round_ended: tokio::sync::Notify,
}

impl ToolRoundLedger {
    fn lock(&self) -> std::sync::MutexGuard<'_, LedgerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The answered rounds so far.
    pub fn totals(&self) -> ToolRoundTotals {
        self.lock().totals
    }

    /// Rounds dispatched and not yet answered or failed.
    pub fn rounds_in_flight(&self) -> u32 {
        self.lock().in_flight_rounds
    }

    /// The answered rounds once no round is still running, waiting at most
    /// `wait`. A round still running at the deadline is added as its prompt
    /// estimate, so the settlement that waits is never longer than `wait` and
    /// never bills less than the prompt the provider was sent.
    pub async fn settled(&self, wait: Duration) -> ToolRoundTotals {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let round_ended = self.round_ended.notified();
            tokio::pin!(round_ended);
            // Register before reading, so a round ending in between still wakes us.
            round_ended.as_mut().enable();
            {
                let state = self.lock();
                if state.in_flight_rounds == 0 {
                    return state.totals;
                }
            }
            if tokio::time::timeout_at(deadline, round_ended)
                .await
                .is_err()
            {
                let state = self.lock();
                let mut totals = state.totals;
                totals.add_unanswered(state.in_flight_rounds, state.in_flight_prompt_tokens);
                return totals;
            }
        }
    }
}

/// One dispatched round. Ends exactly once: answered, failed, or dropped with
/// its caller (a cancelled round counts as failed, and is not billed here).
struct RoundInFlight {
    ledger: Arc<ToolRoundLedger>,
    prompt_estimate: u64,
    ended: bool,
}

impl RoundInFlight {
    fn begin(ledger: Arc<ToolRoundLedger>, prompt_estimate: u64) -> Self {
        {
            let mut state = ledger.lock();
            state.in_flight_rounds = state.in_flight_rounds.saturating_add(1);
            state.in_flight_prompt_tokens = state
                .in_flight_prompt_tokens
                .saturating_add(prompt_estimate);
        }
        Self {
            ledger,
            prompt_estimate,
            ended: false,
        }
    }

    fn end(mut self, answer: Option<&Value>) {
        self.finish(answer);
    }

    fn finish(&mut self, answer: Option<&Value>) {
        if std::mem::replace(&mut self.ended, true) {
            return;
        }
        {
            let mut state = self.ledger.lock();
            if let Some(response) = answer {
                state.totals.add_answer(response, self.prompt_estimate);
            }
            state.in_flight_rounds = state.in_flight_rounds.saturating_sub(1);
            state.in_flight_prompt_tokens = state
                .in_flight_prompt_tokens
                .saturating_sub(self.prompt_estimate);
        }
        self.ledger.round_ended.notify_waiters();
    }
}

impl Drop for RoundInFlight {
    fn drop(&mut self) {
        self.finish(None);
    }
}

type ProviderFuture<'a, T> =
    Pin<Box<dyn std::future::Future<Output = Result<T, ProviderError>> + Send + 'a>>;

/// The provider a tool loop calls, recording each answered round in a ledger.
///
/// Only the completion methods a tool loop uses are metered and forwarded;
/// the wrapper is never registered as a provider or used outside a loop.
pub(super) struct MeteredRounds {
    inner: Arc<dyn Provider>,
    ledger: Arc<ToolRoundLedger>,
    /// Run each round on its own task. The provider bills a buffered call it
    /// has accepted even when the caller stops waiting, so a metered request
    /// lets the round finish and records it; the loop itself still stops, and
    /// no further tool runs. An unmetered call keeps cancel-on-drop, which
    /// frees a local engine for the next caller.
    detach: bool,
}

impl MeteredRounds {
    pub fn new(inner: Arc<dyn Provider>, ledger: Arc<ToolRoundLedger>, detach: bool) -> Self {
        Self {
            inner,
            ledger,
            detach,
        }
    }
}

impl Provider for MeteredRounds {
    fn name(&self) -> &'static str {
        self.inner.name()
    }

    fn has_rotating_accounts(&self) -> bool {
        self.inner.has_rotating_accounts()
    }

    fn complete<'a>(&'a self, model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.complete_for_session(model, body, None)
    }

    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> ProviderFuture<'a, Value> {
        let prompt_estimate = super::estimate_prompt_tokens(body);
        if !self.detach {
            return Box::pin(async move {
                let round = RoundInFlight::begin(Arc::clone(&self.ledger), prompt_estimate);
                let result = self.inner.complete_for_session(model, body, session).await;
                round.end(result.as_ref().ok());
                result
            });
        }
        let inner = Arc::clone(&self.inner);
        let ledger = Arc::clone(&self.ledger);
        let (model, body, session) = (model.to_owned(), body.clone(), session.map(str::to_owned));
        Box::pin(async move {
            use tracing::Instrument;
            let round = RoundInFlight::begin(ledger, prompt_estimate);
            // The round's provider request keeps the caller's trace context: a
            // task-local scope does not follow `tokio::spawn` on its own.
            let task = tokio::spawn(ryu_gw_providers::trace_context::carry(
                async move {
                    let result = inner
                        .complete_for_session(&model, &body, session.as_deref())
                        .await;
                    round.end(result.as_ref().ok());
                    result
                }
                .in_current_span(),
            ));
            match task.await {
                Ok(result) => result,
                Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
                Err(error) => Err(ProviderError::DeliveryUncertain(format!(
                    "tool-loop round was cancelled: {error}"
                ))),
            }
        })
    }

    fn complete_stream<'a>(&'a self, model: &'a str, body: &'a Value) -> ProviderFuture<'a, Body> {
        self.inner.complete_stream(model, body)
    }

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> ProviderFuture<'a, Body> {
        self.inner.complete_stream_for_session(model, body, session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(input: u64, output: u64, cost: Option<f64>) -> Value {
        let mut usage = json!({ "prompt_tokens": input, "completion_tokens": output });
        if let Some(cost) = cost {
            usage["cost"] = json!(cost);
        }
        json!({ "choices": [{ "message": { "content": "ok" } }], "usage": usage })
    }

    #[test]
    fn rounds_sum_tokens_and_reported_cost() {
        let mut totals = ToolRoundTotals::default();
        totals.add_answer(&answer(100, 10, Some(0.001)), 7);
        totals.add_answer(&answer(150, 20, Some(0.002)), 7);
        assert_eq!(totals.rounds, 2);
        assert_eq!(totals.input_tokens, 250);
        assert_eq!(totals.output_tokens, 30);
        assert!(!totals.estimated);
        let cost = totals.reported_cost_usd().unwrap();
        assert!((cost - 0.003).abs() < 1e-12, "{cost}");
        // The rate limits judge the last round (170); the first is accounting.
        assert_eq!(totals.earlier_round_tokens(), 110);
    }

    #[test]
    fn one_unpriced_round_prices_every_round_from_tokens() {
        let mut totals = ToolRoundTotals::default();
        totals.add_answer(&answer(100, 10, Some(0.001)), 7);
        totals.add_answer(&answer(150, 20, None), 7);
        assert_eq!(totals.reported_cost_usd(), None);
        assert_eq!(totals.input_tokens, 250);
    }

    #[test]
    fn a_round_without_usage_is_estimated_not_free() {
        let mut totals = ToolRoundTotals::default();
        // 12 generated characters, no usage block.
        totals.add_answer(
            &json!({ "choices": [{ "message": { "content": "abcdefghijkl" } }] }),
            40,
        );
        assert_eq!(totals.input_tokens, 40);
        assert_eq!(totals.output_tokens, 3);
        assert!(totals.estimated);
        assert_eq!(totals.reported_cost_usd(), None);
    }

    #[test]
    fn billing_view_carries_the_totals_and_keeps_final_round_details() {
        let mut totals = ToolRoundTotals::default();
        totals.add_answer(&answer(100, 10, Some(0.001)), 0);
        let mut last = answer(150, 20, Some(0.002));
        last["usage"]["prompt_tokens_details"] = json!({ "cached_tokens": 64 });
        totals.add_answer(&last, 0);
        let view = totals.billing_view(&last);
        assert_eq!(view["usage"]["prompt_tokens"], 250);
        assert_eq!(view["usage"]["completion_tokens"], 30);
        assert_eq!(view["usage"]["total_tokens"], 280);
        assert!((view["usage"]["cost"].as_f64().unwrap() - 0.003).abs() < 1e-12);
        assert_eq!(view["usage"]["prompt_tokens_details"]["cached_tokens"], 64);

        let mut unpriced = totals;
        unpriced.add_answer(&answer(1, 1, None), 0);
        assert!(unpriced.billing_view(&last)["usage"].get("cost").is_none());
    }

    #[test]
    fn every_rounds_cache_legs_are_summed_for_billing() {
        // Five rounds each read a 50k cached prefix (51k prompt): all 250k
        // cached tokens are billed at the cache rate, not only the last 50k.
        let mut totals = ToolRoundTotals::default();
        let round = |native: bool| {
            let mut answer = answer(51_000, 100, None);
            if native {
                answer["usage"]["cache_read_input_tokens"] = json!(50_000);
                answer["usage"]["cache_creation_input_tokens"] = json!(0);
            } else {
                answer["usage"]["prompt_tokens_details"] =
                    json!({ "cached_tokens": 50_000, "cache_write_tokens": 0 });
            }
            answer
        };
        for index in 0..5 {
            totals.add_answer(&round(index % 2 == 0), 0);
        }
        let mut writer = answer(1_000, 0, None);
        writer["usage"]["prompt_tokens_details"] = json!({
            "cached_tokens": 0, "cache_write_tokens": 1_000, "cache_write_1h_tokens": 400
        });
        totals.add_answer(&writer, 0);
        let expected = crate::pipeline::provider_usage::ProviderCacheUsage {
            read_tokens: 250_000,
            write_tokens: 1_000,
            write_1h_tokens: 400,
        };
        assert_eq!(totals.cache_usage(), Some(expected));
        // The billing view carries the sums, whatever vocabulary the final
        // round used, so settlement reads them back unchanged.
        let last = round(true);
        let view = totals.billing_view(&last);
        assert_eq!(view["usage"]["prompt_tokens"], 256_000);
        assert_eq!(
            crate::pipeline::provider_usage::provider_cache_usage(&view),
            Some(expected)
        );
        // A loop whose rounds reported no cache keeps its view cache-free.
        let mut plain = ToolRoundTotals::default();
        plain.add_answer(&answer(10, 1, None), 0);
        assert_eq!(plain.cache_usage(), None);
        assert!(plain.billing_view(&answer(10, 1, None))["usage"]
            .get("prompt_tokens_details")
            .is_none());
    }

    #[tokio::test]
    async fn settlement_waits_for_a_running_round_and_bounds_the_wait() {
        let ledger = Arc::new(ToolRoundLedger::default());
        RoundInFlight::begin(Arc::clone(&ledger), 5).end(Some(&answer(10, 2, Some(0.001))));
        let running = RoundInFlight::begin(Arc::clone(&ledger), 30);
        let waiter = {
            let ledger = Arc::clone(&ledger);
            tokio::spawn(async move { ledger.settled(Duration::from_secs(5)).await })
        };
        tokio::task::yield_now().await;
        running.end(Some(&answer(40, 8, Some(0.002))));
        let totals = waiter.await.unwrap();
        assert_eq!(
            (totals.rounds, totals.input_tokens, totals.output_tokens),
            (2, 50, 10)
        );
        assert!(!totals.estimated);

        // A round that never answers is billed as its prompt once the wait ends.
        let _stuck = RoundInFlight::begin(Arc::clone(&ledger), 30);
        let totals = ledger.settled(Duration::from_millis(20)).await;
        assert_eq!(
            (totals.rounds, totals.input_tokens, totals.output_tokens),
            (3, 80, 10)
        );
        assert!(totals.estimated);
        assert_eq!(totals.reported_cost_usd(), None);
    }

    #[test]
    fn a_failed_or_cancelled_round_is_not_counted() {
        let ledger = Arc::new(ToolRoundLedger::default());
        RoundInFlight::begin(Arc::clone(&ledger), 30).end(None);
        drop(RoundInFlight::begin(Arc::clone(&ledger), 30));
        assert_eq!(ledger.totals(), ToolRoundTotals::default());
        assert_eq!(ledger.lock().in_flight_rounds, 0);
        assert_eq!(ledger.lock().in_flight_prompt_tokens, 0);
    }
}
