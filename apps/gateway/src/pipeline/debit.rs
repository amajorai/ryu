use super::*;

/// The `POST /api/credits/debit` request body. Pulled out of
/// [`debit_wallet_for_request`] so the wire contract with the control plane is
/// assertable without a live endpoint — this is the one place the gateway tells
/// the ledger which donated allowance a spend came out of, and a silently
/// dropped or misnamed `pool` key books frontier tokens against the free pool.
///
/// Both optional fields are ADDITIVE: absent means absent, not `null`, so a
/// control plane that ignores them (or predates them) sees a byte-identical
/// legacy body.
/// What a debit was FOR, alongside how much it was.
///
/// A struct rather than seven more positional parameters: `debit_wallet_for_request`
/// already takes seven, and the fields here are all `Option` of two or three
/// types, so positional args would be trivially transposable at six call sites
/// with no compiler error to catch it — `provider` and `model` are both
/// `Option<String>`.
///
/// Every field is optional and every absent field is OMITTED from the wire body,
/// never sent as `null`. A control plane that predates these keys sees a
/// byte-identical legacy body, which is the same additive contract `alertTier`
/// and `pool` already follow.
///
/// PURELY DESCRIPTIVE. Nothing downstream branches on any of it — these become
/// receipt lines on a ledger row so a customer can be told what a charge was for.
/// That is exactly why a missing value is fine and a wrong one is not worth a
/// failed debit for work already served.
#[derive(Debug, Clone, Default)]
pub(super) struct DebitAttribution {
    /// Wall-clock milliseconds the billed work took.
    pub(super) duration_ms: Option<u64>,
    pub(super) input_tokens: Option<u64>,
    /// Model or resource id that produced the charge.
    pub(super) model: Option<String>,
    pub(super) output_tokens: Option<u64>,
    /// Gateway provider route that billed the work. NOT the credit pool: the
    /// pool is which donated allowance pays. For OpenRouter, its selected
    /// underlying provider is recorded separately below.
    pub(super) provider: Option<String>,
    /// Provider selected inside OpenRouter when this Gateway provider proxied
    /// the request. Kept separate from `provider`, which remains OpenRouter.
    pub(super) upstream_provider: Option<String>,
    /// Human-facing label for what the spend was for.
    pub(super) task_label: Option<String>,
    /// Whether the amount was priced from the configured media fallback rather
    /// than provider-reported compute time.
    pub(super) estimated: Option<bool>,
    /// The user whose action incurred the charge, when the request carried one.
    pub(super) user_id: Option<String>,
    /// The caller's builder tags (`x-ryu-tags`, Treg parity C6). Sent only
    /// when non-empty, so an untagged debit keeps the legacy body.
    pub(super) tags: Vec<String>,
}

/// Keep the existing human-facing label for a fallback charge. The explicit
/// `estimated` field is the durable machine-readable marker; provider timing
/// remains in `durationMs` when measured.
pub(super) fn media_task_label(modality: &Modality, estimated: bool) -> String {
    let label = modality.as_str();
    if estimated {
        format!("{label} (estimated cost)")
    } else {
        label.to_string()
    }
}

// Mint once per accepted generation, then retain this reference for debit retries.
// Audit correlation may be app-controlled and cannot identify a charged execution.
pub(super) fn media_debit_reference(modality: &Modality) -> String {
    format!("{}:{}", Uuid::new_v4(), modality.as_str())
}

pub(super) fn debit_request_body(
    org_id: &str,
    amount_micro_usd: u64,
    reason: CreditDebitReason,
    ref_id: &str,
    budget_alert_tier: Option<AlertTier>,
    pool: Option<&str>,
    attribution: &DebitAttribution,
) -> Value {
    let mut body = json!({
        "orgId": org_id,
        "amountMicroUsd": amount_micro_usd,
        "reason": reason.as_str(),
        "refId": ref_id,
    });
    let Some(obj) = body.as_object_mut() else {
        return body;
    };
    // Only stamp `alertTier` when a budget cap actually asked for an alert, so
    // existing debit consumers see the legacy body otherwise. Reuses the
    // `AlertTier` serde (lowercase) as the wire value.
    if let Some(tier) = budget_alert_tier {
        if let Ok(value) = serde_json::to_value(tier) {
            obj.insert("alertTier".to_string(), value);
        }
    }
    // An untagged provider omits `pool` entirely, and the control-plane debit
    // then takes its pre-pool path: no grant is reachable and the spend falls
    // through to the subscription and top-up buckets. Only a tagged provider can
    // reach pool-restricted grant money, and only its OWN pool's.
    if let Some(pool) = pool {
        obj.insert("pool".to_string(), Value::String(pool.to_string()));
    }
    // Attribution. Each key is inserted only when present, so an unattributed
    // debit is byte-identical to the legacy body.
    let mut put_str = |key: &str, value: &Option<String>| {
        if let Some(v) = value {
            let trimmed = v.trim();
            // A blank is not information. Sending `""` would land an
            // empty-string model on the row, which renders as a present but
            // nameless value — worse than an honest absence.
            if !trimmed.is_empty() {
                obj.insert(key.to_string(), Value::String(trimmed.to_string()));
            }
        }
    };
    put_str("provider", &attribution.provider);
    put_str("upstreamProvider", &attribution.upstream_provider);
    // The ledger is user-visible: a managed tier's work is recorded under its
    // Ryu alias, never the supplier's id (the amount is already priced).
    let display_model = attribution.model.as_deref().map(|model| {
        attribution.provider.as_deref().map_or_else(
            || model.to_owned(),
            |provider| model_alias::display_model(provider, model).into_owned(),
        )
    });
    put_str("model", &display_model);
    put_str("userId", &attribution.user_id);
    put_str("taskLabel", &attribution.task_label);
    if let Some(estimated) = attribution.estimated {
        obj.insert("estimated".to_string(), Value::Bool(estimated));
    }
    if !attribution.tags.is_empty() {
        obj.insert("tags".to_string(), json!(attribution.tags));
    }
    for (key, value) in [
        ("inputTokens", attribution.input_tokens),
        ("outputTokens", attribution.output_tokens),
        ("durationMs", attribution.duration_ms),
    ] {
        if let Some(v) = value {
            obj.insert(key.to_string(), Value::Number(v.into()));
        }
    }
    body
}

/// Post-call wallet debit (#486). Computes the marked-up debit for a metered
/// call's `costMicroUsd` and POSTs it to the control-plane `/credits/debit` for
/// the request's org, then updates the cached balance from the authoritative
/// response so the NEXT request is gated when necessary.
///
/// The already-served response cannot be unsent, but a managed debit failure is
/// never allowed to authorize more provider spend: when `fail_closed_sticky` is
/// true, transport errors, non-2xx responses, and malformed success bodies mark
/// accounting unavailable and the next managed request receives a retryable 503.
/// A zero debit (cache hits, 0-token modalities) is skipped because the endpoint
/// rejects `amountMicroUsd <= 0`.
///
/// `ref_id` makes the debit idempotent: a retried hook is a no-op. Token usage
/// passes `ref_id = request_id`; the per-request tool-call (Composio) debit passes
/// `ref_id = "{request_id}:composio"` with `reason = "composio"` so it lands as a
/// distinct ledger row instead of being deduped against the token debit (#496).
pub(super) async fn debit_wallet_for_request(
    state: Arc<AppState>,
    org_id: String,
    ref_id: String,
    // A closed enum, not a string: the control plane answers 400 to any reason
    // outside its ledger enum, and a 400 is final. What the charge was FOR
    // (embedding, smart routing, ...) goes in `attribution.task_label`.
    reason: CreditDebitReason,
    cost_micro_usd: u64,
    fail_closed_sticky: bool,
    // Managed policy-alert hook (item 4): the stamped budget-cap tier for THIS
    // request, present only when a budget rule with tier >= Warn matched. Carried
    // on the existing debit payload (the one place the gateway and control-plane
    // already touch) so `credits.ts /debit` can email managed owners. Additive:
    // `None` omits the field entirely, leaving the legacy debit body unchanged.
    budget_alert_tier: Option<AlertTier>,
    // The segregated credit pool this spend bills against, from the registry id
    // of the provider that ACTUALLY served the request (see
    // [`crate::credit_pools`]). Deliberately a required parameter rather than a
    // defaulted one: every debit site has to make the attribution decision
    // explicitly, because an accidental `None` is silent — the spend simply never
    // draws grant money and never appears in per-pool burn.
    pool: Option<&'static str>,
    // What the charge was for. `Default::default()` at a site that genuinely
    // knows nothing; never a placeholder value, because a wrong model on an
    // invoice line is worse than a blank one.
    attribution: DebitAttribution,
) {
    let credits = &state.config.credits;
    if !credits.is_active() {
        return;
    }
    let amount = credits.debit_amount_for_provider(attribution.provider.as_deref(), cost_micro_usd);
    if amount == 0 {
        return;
    }
    let Some(secret) = credits.internal_secret.as_deref() else {
        return; // is_active guarantees Some, but stay defensive.
    };

    // `/api` IS PART OF THE ROUTE, and leaving it out cost real money. The control
    // plane mounts `creditsRouter` at `/api/credits` (`packages/api/src/routers/index.ts`),
    // and `credits.base_url` defaults to `control_plane.base_url` — the bare origin,
    // because the sibling resolve call spells its own prefix out in full
    // (`{}/api/control-plane/gateway/resolve` in `policy/mod.rs`). This join did
    // not, so in production every debit POSTed to the wrong path and got a
    // plain 404. Before the hardening change, the hook failed open and managed
    // inference could run unbilled. The current default is fail-closed: the
    // next request receives `credit_accounting_unavailable` after any failed or
    // malformed debit response.
    let url = format!(
        "{}/api/credits/debit",
        credits.base_url.trim_end_matches('/')
    );
    let body = debit_request_body(
        &org_id,
        amount,
        reason,
        &ref_id,
        budget_alert_tier,
        pool,
        &attribution,
    );

    // The debit is idempotent on `refId`, so a transient failure is retried a
    // couple of times before the charge is given up on. Without this, any blip
    // between the gateway and the control plane left a served request unbilled
    // for good: the failure is audited, but nothing replays it.
    let mut resp = None;
    for (attempt, backoff_ms) in DEBIT_RETRY_BACKOFF_MS.iter().enumerate() {
        if *backoff_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(*backoff_ms)).await;
        }
        let result = state
            .http
            .post(&url)
            .header("x-ryu-internal-secret", secret)
            .timeout(std::time::Duration::from_millis(credits.timeout_ms.max(1)))
            .json(&body)
            .send()
            .await;
        let retryable = match &result {
            Ok(r) => r.status().is_server_error() || r.status().as_u16() == 429,
            Err(_) => true,
        };
        resp = Some(result);
        if !retryable || attempt + 1 == DEBIT_RETRY_BACKOFF_MS.len() {
            break;
        }
    }
    let Some(resp) = resp else {
        return;
    };

    match resp {
        Ok(r) if r.status().is_success() => {
            // Steady-state truth: `balanceMicroUsd <= 0` ⇒ empty. Self-heals the
            // flag after a top-up. `wentNonPositive` is the edge event (log only).
            match r.json::<Value>().await {
                Ok(v) => {
                    let Some(balance) = v["balanceMicroUsd"].as_i64() else {
                        warn!(
                            org_id = %org_id,
                            ref_id = %ref_id,
                            "credits: debit returned success without an integer balance"
                        );
                        audit_debit_failure(
                            &state,
                            &org_id,
                            &ref_id,
                            "credits debit response missing integer balance",
                            amount,
                        );
                        if fail_closed_sticky {
                            state.wallet.set_org_accounting_unavailable(&org_id, true);
                        }
                        return;
                    };
                    // Records the figure AND derives the empty flag from it, so
                    // Core's dollar-threshold fallback rules read the same number
                    // this gate does (`WalletState::set_org_balance`).
                    state.wallet.set_org_balance(&org_id, balance);
                    if v["wentNonPositive"].as_bool().unwrap_or(false) {
                        warn!(
                            org_id = %org_id,
                            ref_id = %ref_id,
                            "credits: org wallet emptied; next request will be gated"
                        );
                    }
                }
                Err(e) => {
                    warn!(org_id = %org_id, error = %e, "credits: debit succeeded but response unparseable");
                    audit_debit_failure(
                        &state,
                        &org_id,
                        &ref_id,
                        &format!("credits debit response unparseable: {e}"),
                        amount,
                    );
                    if fail_closed_sticky {
                        state.wallet.set_org_accounting_unavailable(&org_id, true);
                    }
                }
            }
        }
        Ok(r) => {
            // A control-plane error never blocks the (already-served) request. The
            // failed debit is recorded in the durable audit log (#486 AC) so
            // unbilled usage is observable and reconcilable later. When fail-closed
            // is on for a managed tenant (§5), also flip the org's wallet-empty flag
            // so the NEXT request is refused — the failure is made sticky, not
            // silently swallowed.
            let status = r.status();
            warn!(
                org_id = %org_id,
                status = %status,
                fail_closed = fail_closed_sticky,
                "credits: debit returned non-success"
            );
            audit_debit_failure(
                &state,
                &org_id,
                &ref_id,
                &format!("credits debit failed: control plane returned {status}"),
                amount,
            );
            if fail_closed_sticky {
                state.wallet.set_org_accounting_unavailable(&org_id, true);
            }
        }
        Err(e) => {
            warn!(
                org_id = %org_id,
                error = %e,
                fail_closed = fail_closed_sticky,
                "credits: debit transport error"
            );
            audit_debit_failure(
                &state,
                &org_id,
                &ref_id,
                &format!("credits debit failed (transport): {e}"),
                amount,
            );
            if fail_closed_sticky {
                state.wallet.set_org_accounting_unavailable(&org_id, true);
            }
        }
    }
}
