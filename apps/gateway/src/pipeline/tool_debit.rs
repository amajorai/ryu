use super::*;

/// Best-effort per-request debit for billable (Composio) tool calls (#496).
/// Composio charges per action execution, so on the managed plan each executed
/// `composio.*` tool call costs the org `cost_per_tool_call_micro_usd`. This
/// fires ONE debit for the whole request (`count × per-call cost`, at cost via
/// `debit_amount`) under `reason="composio"` and a distinct
/// `refId="{request_id}:composio"` so it is not deduped against the token debit.
/// The local budget counter is updated even when the wallet is inactive or the
/// node has no org id; the wallet debit is separately a no-op in those cases.
/// Spawned by the caller so it never adds client latency.
pub(super) fn spawn_tool_call_debit(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    raw_cost_micro_usd: u64,
) {
    if raw_cost_micro_usd == 0 {
        return;
    }
    spawn_external_tool_debit_for_ids(
        state,
        &ctx.owner_binding,
        ctx.user_id.as_deref(),
        ctx.agent_id.as_deref(),
        ctx.session_id.as_deref(),
        ctx.org_id.as_deref(),
        &ctx.request_id,
        ctx.managed_inference,
        "composio",
        None,
        Some(raw_cost_micro_usd),
        None,
        false,
        Some("Composio tool usage, provider receipt and applicable add-ons"),
        1,
        crate::org_limits::subject_for(ctx).as_ref(),
    );
}

/// Best-effort tool charge entry point for Core's ACP/MCP bridge. The bridge
/// executes the action in Core, while the Gateway owns the per-agent counter
/// and optional wallet debit. `raw_cost` is deliberately passed to the wallet
/// helper: that helper applies platform markup exactly once. The local budget
/// counter receives the marked-up amount so its cap matches the wallet.
pub(crate) fn spawn_tool_call_debit_for_ids(
    state: &Arc<AppState>,
    owner_binding: &str,
    user_id: Option<&str>,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    org_id: Option<&str>,
    request_id: &str,
    managed_inference: bool,
    billable_tool_calls: u64,
) {
    spawn_external_tool_debit_for_ids(
        state,
        owner_binding,
        user_id,
        agent_id,
        session_id,
        org_id,
        request_id,
        managed_inference,
        "composio",
        None,
        None,
        None,
        false,
        None,
        billable_tool_calls,
        None,
    );
}

/// Best-effort provider-neutral external-tool charge entry point. A provider may
/// report its raw transaction cost (Treg), while Composio keeps the existing
/// configured per-call fallback when no raw amount is available.
pub(crate) fn spawn_external_tool_debit_for_ids(
    state: &Arc<AppState>,
    owner_binding: &str,
    user_id: Option<&str>,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    org_id: Option<&str>,
    request_id: &str,
    managed_inference: bool,
    provider: &str,
    tool_id: Option<&str>,
    raw_cost_micro_usd: Option<u64>,
    transaction_id: Option<&str>,
    estimated: bool,
    task_label: Option<&str>,
    billable_tool_calls: u64,
    org_limit_subject: Option<&crate::org_limits::OrgLimitSubject>,
) {
    if billable_tool_calls == 0 {
        return;
    }
    let provider = provider.trim();
    if external_tool_debit_reason(provider).is_none() {
        warn!(
            provider,
            "credits: ignoring unsupported external tool provider"
        );
        return;
    }
    let raw_cost = raw_cost_micro_usd.unwrap_or_else(|| {
        if provider == "composio" {
            state
                .config
                .credits
                .tool_call_cost_micro_usd(billable_tool_calls)
        } else {
            0
        }
    });
    let default_label = format!(
        "{billable_tool_calls} {provider} tool {}",
        if billable_tool_calls == 1 {
            "call"
        } else {
            "calls"
        }
    );
    spawn_managed_tool_debit(
        state,
        ManagedToolDebit {
            owner_binding,
            user_id,
            agent_id,
            session_id,
            org_id,
            managed_inference,
            provider,
            tool_id,
            raw_cost_micro_usd: raw_cost,
            ref_id: external_tool_ref_id(provider, transaction_id, request_id),
            estimated,
            task_label: Some(
                task_label
                    .filter(|value| !value.trim().is_empty())
                    .map_or(default_label, str::to_owned),
            ),
            org_limit_subject,
            reservation: None,
        },
    );
}

/// The ledger reason for an external tool provider, or `None` for a provider
/// the control plane's closed reason enum does not know.
pub(crate) fn external_tool_debit_reason(provider: &str) -> Option<CreditDebitReason> {
    match provider.trim() {
        "composio" => Some(CreditDebitReason::Composio),
        "treg" => Some(CreditDebitReason::Treg),
        _ => None,
    }
}

/// The legacy ledger reference for an external tool charge: the provider's
/// transaction id when it reported one (a Composio receipt is settled under
/// exactly this reference, so it must not change), else the request id.
pub(crate) fn external_tool_ref_id(
    provider: &str,
    transaction_id: Option<&str>,
    request_id: &str,
) -> String {
    transaction_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("{provider}:{value}"))
        .unwrap_or_else(|| format!("{request_id}:{provider}"))
}

/// One external tool charge, with the ledger reference already chosen and an
/// optional pre-call reservation to hold until the debit resolves.
pub(crate) struct ManagedToolDebit<'a> {
    pub owner_binding: &'a str,
    pub user_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub org_id: Option<&'a str>,
    pub managed_inference: bool,
    pub provider: &'a str,
    pub tool_id: Option<&'a str>,
    /// Raw provider cost before markup; the debit helper applies markup once.
    pub raw_cost_micro_usd: u64,
    /// The ledger `refId`. The debit is idempotent on it.
    pub ref_id: String,
    pub estimated: bool,
    pub task_label: Option<String>,
    pub org_limit_subject: Option<&'a crate::org_limits::OrgLimitSubject>,
    /// HELD UNTIL THE DEBIT RESOLVES, so the org's headroom never shows the
    /// money as free in the gap between the call finishing and the ledger
    /// recording it. Dropped (released) when the spawned debit completes.
    pub reservation: Option<CreditReservation>,
}

/// Record and schedule one external tool charge. Returns the charged amount
/// (after markup) that the local budget counters and the wallet debit use, or
/// `None` when nothing is charged (zero cost or an unsupported provider).
pub(crate) fn spawn_managed_tool_debit(
    state: &Arc<AppState>,
    debit: ManagedToolDebit<'_>,
) -> Option<u64> {
    let provider = debit.provider.trim();
    let reason = external_tool_debit_reason(provider)?;
    if debit.raw_cost_micro_usd == 0 {
        return None;
    }
    let credits = &state.config.credits;
    let charged_cost = credits.debit_amount_for_provider(Some(provider), debit.raw_cost_micro_usd);
    record_charged_budget_for_ids(
        state,
        debit.owner_binding,
        debit.org_id,
        debit.user_id,
        debit.agent_id,
        debit.session_id,
        BudgetChargeKind::Tools,
        charged_cost,
        debit.org_limit_subject,
    );

    let Some(org_id) = debit.org_id.filter(|s| !s.is_empty()) else {
        return Some(charged_cost);
    };
    if !credits.is_active() {
        return Some(charged_cost);
    }
    let fail_closed_sticky = credits.fail_closed && debit.managed_inference;
    let reservation = debit.reservation;
    let state = Arc::clone(state);
    let org_id = org_id.to_string();
    let ref_id = debit.ref_id;
    let raw_cost = debit.raw_cost_micro_usd;
    let attribution = DebitAttribution {
        provider: Some(provider.to_string()),
        model: debit
            .tool_id
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned),
        user_id: debit.user_id.map(str::to_owned),
        task_label: debit.task_label,
        tags: debit
            .org_limit_subject
            .map(|subject| subject.tags.clone())
            .unwrap_or_default(),
        estimated: Some(debit.estimated),
        ..Default::default()
    };
    tokio::spawn(async move {
        let _reservation = reservation;
        debit_wallet_for_request(
            state,
            org_id,
            ref_id,
            reason,
            raw_cost,
            fail_closed_sticky,
            None,
            // No pool, and this is an invariant rather than a stub: an external
            // tool call is not donated inference supply. Neither the Bedrock nor
            // the Cloudflare allowance pays for it, so it must never draw
            // pool-restricted grant money — it bills the ordinary
            // subscription/top-up buckets, which is what `None` means to the
            // control-plane debit.
            None,
            // No model and no duration: this row is a COUNT of executed tool
            // calls, not a timed inference. `taskLabel` carries the count so a
            // statement can say "3 tool calls" instead of an unexplained charge.
            attribution,
        )
        .await;
    });
    Some(charged_cost)
}

/// Record a failed (fail-open) wallet debit in the durable audit log (#486 AC).
/// The control-plane debit is best-effort; when it errors we never block the
/// already-served request, but we persist the miss so unbilled usage is
/// observable and reconcilable. The error string is run through the outbound
/// firewall (DLP) before persistence, matching `audit_failure`.
/// Delays before each debit attempt: the first is immediate, then two retries.
pub(super) const DEBIT_RETRY_BACKOFF_MS: [u64; 3] = [0, 250, 1_000];

/// Record a debit that could not be applied, WITH the amount owed, so the
/// unbilled charge can actually be reconciled from the audit log.
pub(super) fn audit_debit_failure(
    state: &AppState,
    org_id: &str,
    request_id: &str,
    error: &str,
    amount_micro_usd: u64,
) {
    if !state.audit.is_enabled() {
        return;
    }
    let redacted_error = state.with_firewall(|fw| fw.sanitize(error));
    state.log_audit(AuditRecord {
        key_id: None,
        request_id: request_id.to_string(),
        api_key: String::new(),
        user_name: None,
        org_id: Some(org_id.to_string()),
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: "credits-debit".to_string(),
        model: String::new(),
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: 0,
        eval_score: None,
        error: Some(redacted_error),
        skill_ids: None,
        session_id: None,
        user_id: None,
        agent_id: None,
        feature: None,
        purpose: None,
        managed_inference: false,
        provider_cost_micro_usd: Some(amount_micro_usd),
        event_type: crate::audit::EventType::ModelCall,
        backend: Some("credits".to_string()),
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
