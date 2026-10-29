use super::*;

/// Record a cache-served response in the audit log. Cache hits incur no provider
/// token usage, so token counts are recorded as zero.
pub(super) fn audit_cache_hit(
    state: &AppState,
    ctx: &RequestContext,
    provider_used: &'static str,
    model: &str,
    response: &Value,
    start: Instant,
) {
    let input_tokens = response["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
    let output_tokens = response["usage"]["completion_tokens"].as_u64().unwrap_or(0);
    state.log_audit(AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        team_ids: ctx.audit_team_ids(),
        key_id: ctx.key_id(),
        project_id: ctx.project_id.clone(),
        provider: provider_used.to_string(),
        model: model.to_string(),
        input_tokens,
        output_tokens,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: true,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: start.elapsed().as_millis() as u64,
        eval_score: None,
        error: None,
        skill_ids: ctx.skill_ids.clone(),
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: ctx.feature.clone(),
        purpose: ctx.purpose.clone(),
        managed_inference: ctx.managed_inference,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}

/// Audit a request a protocol handler refused before handing it to the
/// pipeline, with the same row and error counter a `pre_process` refusal gets.
pub(crate) fn audit_refused(
    state: &AppState,
    ctx: &RequestContext,
    model: &str,
    err: &GatewayError,
) {
    state.metrics.inc_errors();
    audit_failure(state, ctx, model, err, Instant::now());
}

/// Record a failed request in the audit log. The error message is run through
/// the outbound firewall (U20 DLP) so any sensitive data it carries is redacted
/// before being persisted.
pub(super) fn audit_failure(
    state: &AppState,
    ctx: &RequestContext,
    model: &str,
    err: &GatewayError,
    start: Instant,
) {
    let source = match err {
        GatewayError::ProviderError(_)
        | GatewayError::ProviderRejected { .. }
        | GatewayError::ProviderTransport(_)
        | GatewayError::ProviderDeliveryUncertain(_)
        | GatewayError::ProviderPaymentRequired { .. }
        | GatewayError::AllProvidersUnavailable(_) => "upstream provider request failed".to_owned(),
        _ => err.to_string(),
    };
    let redacted_error = state.with_firewall(|fw| {
        let sanitized = fw.sanitize(&source);
        fw.redact_outbound(&sanitized).0
    });
    let record = AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        team_ids: ctx.audit_team_ids(),
        key_id: ctx.key_id(),
        project_id: ctx.project_id.clone(),
        provider: "none".to_string(),
        model: model.to_string(),
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: start.elapsed().as_millis() as u64,
        eval_score: None,
        error: Some(redacted_error),
        skill_ids: ctx.skill_ids.clone(),
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: ctx.feature.clone(),
        purpose: ctx.purpose.clone(),
        managed_inference: ctx.managed_inference,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    };
    state.log_audit_with(record, crate::traffic::TrafficOutcome::failure(err));
}

/// Emit an audit record when the LLM inspector blocks an inbound request,
/// mirroring the regex firewall's audit shape (provider tag `"inspector"`).
pub(super) fn audit_inspector_block(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
    verdict: &crate::firewall::inspector::InspectorVerdict,
) {
    let traffic_verdict = verdict.categories.iter().fold(
        crate::traffic::TrafficVerdict::new(
            crate::traffic::DecidedBy::Inspector,
            crate::traffic::VerdictAction::Block,
        ),
        |traffic_verdict, category| traffic_verdict.with_detector(category),
    );
    let record = AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        team_ids: ctx.audit_team_ids(),
        key_id: ctx.key_id(),
        project_id: ctx.project_id.clone(),
        provider: "inspector".to_string(),
        model: body["model"].as_str().unwrap_or("unknown").to_string(),
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
        error: Some(format!(
            "inspector blocked: {} [{}]",
            verdict.reason,
            verdict.categories.join(",")
        )),
        skill_ids: ctx.skill_ids.clone(),
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: ctx.feature.clone(),
        purpose: ctx.purpose.clone(),
        managed_inference: ctx.managed_inference,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: Some("inspector".to_string()),
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    };
    state.log_audit_with(
        record,
        crate::traffic::TrafficOutcome::verdict(traffic_verdict),
    );
}

/// Emit an audit record when streaming outbound DLP ends a response under the
/// resolved `Block` policy (provider tag `"firewall"`). The stream itself was
/// already accepted, so this row is the only durable trace of the block; the
/// observer's usage row for the same request still records what was generated.
pub(super) fn audit_stream_dlp_block(
    state: &AppState,
    ctx: &RequestContext,
    pattern: &str,
    kind: &str,
) {
    let decided_by = crate::traffic::firewall_layer(pattern, &state.firewall_layers(ctx));
    // A floor decision names the detection kind only, never its pattern.
    let detector = if decided_by == crate::traffic::DecidedBy::PlatformFloor {
        kind
    } else {
        pattern
    };
    let verdict =
        crate::traffic::TrafficVerdict::new(decided_by, crate::traffic::VerdictAction::Block)
            .with_detector(detector);
    let record = AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        team_ids: ctx.audit_team_ids(),
        key_id: ctx.key_id(),
        project_id: ctx.project_id.clone(),
        provider: "firewall".to_string(),
        model: ctx.agent_id.as_deref().unwrap_or("unknown").to_string(),
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
        error: Some(format!("outbound stream blocked: {pattern} ({kind})")),
        skill_ids: ctx.skill_ids.clone(),
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: ctx.feature.clone(),
        purpose: ctx.purpose.clone(),
        managed_inference: ctx.managed_inference,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: Some("firewall".to_string()),
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    };
    state.log_audit_with(record, crate::traffic::TrafficOutcome::verdict(verdict));
}

// ─── Streaming pipeline ───────────────────────────────────────────────────────
