use super::*;

/// Whether an enabled inbound stage redacts under Sanitize: the regex firewall,
/// the LLM inspector, or an inline input evaluator. See the prompt-prefix
/// stabilization pass at the end of [`pre_process`].
pub(super) fn sanitize_posture_configured(state: &AppState, scanner: &FirewallScanner) -> bool {
    let config = scanner.config();
    let stage_enabled = |stage| state.stage_order.stages().contains(&stage);
    if config.enabled && config.scan_inbound && *scanner.policy() == FirewallPolicy::Sanitize {
        return true;
    }
    if stage_enabled(PipelineStage::Inspector)
        && config.inspector.enabled
        && config.inspector.action == FirewallPolicy::Sanitize
    {
        return true;
    }
    if !stage_enabled(PipelineStage::InlineInput) || !config.evaluators.iter().any(|b| b.enabled) {
        return false;
    }
    let registry = EvaluatorRegistry::from_config(&state.config);
    config
        .evaluators
        .iter()
        .filter(|binding| binding.enabled)
        .any(|binding| {
            registry.get(&binding.id).is_some_and(|ev| {
                ev.capabilities.inline
                    && ev.target == EvaluatorTarget::Input
                    && inline_action_for(binding, ev) == FirewallPolicy::Sanitize
            })
        })
}

/// Merge two optional policy alerts, keeping the higher-tier one. On a tie the
/// FIRST argument wins, so callers pass the firewall alert first to make it beat
/// a same-tier budget alert deterministically (one response, one header).
pub(super) fn merge_alert(a: Option<PolicyAlert>, b: Option<PolicyAlert>) -> Option<PolicyAlert> {
    match (a, b) {
        (Some(a), Some(b)) => {
            if b.alert_tier > a.alert_tier {
                Some(b)
            } else {
                Some(a)
            }
        }
        (Some(a), None) => Some(a),
        (None, b) => b,
    }
}

// ─── Unified-evaluator inline guardrails (P3) ────────────────────────────────
//
// Bridge the resolved per-agent policy's enabled `EvaluatorBinding`s into the
// live pipeline as real guardrails. Input-target detectors (code_injection,
// prompt_injection) run inbound in `pre_process`; Output-target detectors
// (pii_leakage, toxicity, bias) run on the response (non-stream `run` +
// `apply_outbound_firewall_stream`). Deterministic detectors run via the
// `FirewallScanner`; LLM-judge detectors reuse the fail-open `InspectorClient`
// with the evaluator's rubric. All of this REUSES the existing firewall
// block/sanitize/warn machinery — no new enforcement path.

/// The inline action for a binding: the binding's `inline_action` wins; otherwise
/// the catalog evaluator's default `inline.action`; otherwise warn-and-continue.
pub(super) fn inline_action_for(
    binding: &crate::evaluators::EvaluatorBinding,
    ev: &Evaluator,
) -> FirewallPolicy {
    binding
        .inline_action
        .clone()
        .or_else(|| ev.inline.as_ref().map(|c| c.action.clone()))
        .unwrap_or(FirewallPolicy::WarnAndContinue)
}

/// The result of evaluating one inline binding. Distinguishes a legitimate
/// `(flagged, reason)` verdict — which flows through the binding's action map
/// ([`inline_outcome`]) — from a fail-closed short-circuit that must BLOCK the
/// turn regardless of the configured action. The latter is the wasm-policy
/// fail-direction control (threat model item F): a security plugin that
/// traps/OOMs/times-out must never be silently skipped (old `None`) nor merely
/// warned (if bound to `Warn`); it blocks.
pub(super) enum InlineFlag {
    Denied(GatewayError),
    /// The impl is not enforceable this phase, or this binding is skipped — an
    /// honest, logged no-op (formerly `None`).
    Skip,
    /// The evaluator ran: `(flagged, reason)` feeds the normal action map.
    Ran {
        flagged: bool,
        reason: String,
    },
    /// A security policy failed closed (trap / OOM / timeout / invalid output with
    /// `fail_open = false`): block the turn directly, bypassing the action map.
    ForceBlock {
        reason: String,
    },
}

/// Evaluate ONE enabled inline binding against `text`. Returns [`InlineFlag`]:
/// `Ran` when it produced a verdict; `Skip` for an empty rubric or unmatched
/// built-in text detector. Unsupported Code/Builtin modes return a clear error;
/// `ForceBlock` when a
/// fail-closed wasm policy must short-circuit to a block. Fail-open on the judge is
/// handled inside [`InspectorClient::inspect_rubric`].
pub(super) async fn flag_inline_binding(
    ev: &Evaluator,
    scanner: &FirewallScanner,
    text: &str,
    state: &Arc<AppState>,
    ctx: &RequestContext,
) -> InlineFlag {
    match &ev.impl_ {
        EvaluatorImpl::Regex { .. } | EvaluatorImpl::Heuristic => {
            let Some(kind) = inline_detection_kind(&ev.id) else {
                // A user-authored regex evaluator runs its own patterns.
                return match &ev.impl_ {
                    EvaluatorImpl::Regex { patterns } => {
                        match crate::evaluators::exec::custom_regex_match(patterns, text) {
                            Some(pattern) => InlineFlag::Ran {
                                flagged: true,
                                reason: format!("{}:/{pattern}/", ev.id),
                            },
                            None => InlineFlag::Ran {
                                flagged: false,
                                reason: String::new(),
                            },
                        }
                    }
                    _ => InlineFlag::Skip,
                };
            };
            match scanner.scan_kind(text, kind) {
                Some(m) => InlineFlag::Ran {
                    flagged: true,
                    reason: format!("{}:{}", m.kind.as_str(), m.pattern_name),
                },
                None => InlineFlag::Ran {
                    flagged: false,
                    reason: String::new(),
                },
            }
        }
        EvaluatorImpl::LlmJudge { rubric } => {
            if rubric.trim().is_empty() {
                debug!(evaluator = %ev.id, "inline evaluator: empty rubric — no-op");
                return InlineFlag::Skip;
            }
            let ins = &scanner.config().inspector;
            let timeout = if ins.timeout_ms == 0 {
                1500
            } else {
                ins.timeout_ms
            };
            let inference = auxiliary::GovernedInference::new(
                Arc::clone(state),
                ctx.clone(),
                "inline-evaluator",
            );
            let verdict = match InspectorClient::inspect_rubric(
                text, rubric, &ins.model, timeout, &inference,
            )
            .await
            {
                Ok(verdict) => verdict,
                Err(error) => return InlineFlag::Denied(error),
            };
            // Deterministic floor: when the judge did NOT answer (no provider /
            // timeout / unparseable — the common local-only deploy), consult the
            // lexical seed so obvious slurs/threats/blanket-generalizations are still
            // caught instead of silently passing under an "enforced" detector. The
            // seed runs on the FULL untruncated `text`, also covering the judge's
            // 4000-char head-only truncation on the fail-open path. When the judge
            // DID answer we trust its context (the `backstop_flag` seam discards the
            // seed), avoiding the condemned/quoted-stereotype and casual-profanity
            // false positives a bare seed would hard-flag.
            let (seed_hit, seed_reason) = if verdict.available {
                (false, String::new())
            } else {
                match llm_judge_backstop_kind(&ev.id).and_then(|k| scanner.scan_kind(text, k)) {
                    Some(m) => (
                        true,
                        format!("seed-backstop {}:{}", m.kind.as_str(), m.pattern_name),
                    ),
                    None => (false, String::new()),
                }
            };
            let flagged = backstop_flag(verdict.available, verdict.flagged, seed_hit);
            let reason = if seed_hit {
                seed_reason
            } else {
                verdict.reason
            };
            InlineFlag::Ran { flagged, reason }
        }
        EvaluatorImpl::Code { .. } => InlineFlag::Denied(GatewayError::BadRequest(format!(
            "evaluator '{}' is unavailable inline: sandboxed code execution is unavailable",
            ev.id
        ))),
        EvaluatorImpl::Builtin { detector } => {
            match crate::evaluators::exec::run_builtin_detector(detector, text, Some(scanner)) {
                Ok(Some(reason)) => InlineFlag::Ran {
                    flagged: true,
                    reason,
                },
                Ok(None) => InlineFlag::Ran {
                    flagged: false,
                    reason: String::new(),
                },
                Err(reason) => InlineFlag::Denied(GatewayError::BadRequest(format!(
                    "evaluator '{}' is unavailable inline: {reason}",
                    ev.id
                ))),
            }
        }
        EvaluatorImpl::Wasm {
            module_base64,
            fail_open,
        } => flag_wasm_binding(ev, module_base64, *fail_open, text, state).await,
    }
}

/// Run an untrusted WASM policy plugin over `text` and translate its verdict into
/// an [`InlineFlag`]. The whole point of this arm is the fail-direction contract:
///   * guest `allow`  → `Ran { flagged: false }` (proceed);
///   * guest `deny`   → `Ran { flagged: true, reason }` (flows through the binding's
///     action map, so an operator may bind a deny-capable policy as Block / Sanitize
///     / Warn);
///   * sandbox `Fail` (trap / fuel / epoch / OOM / invalid output / bad module /
///     host unavailable) → if `fail_open` then `Ran { flagged: false }` (declared,
///     logged) else `ForceBlock` (default CLOSED — never a silent allow).
pub(super) async fn flag_wasm_binding(
    ev: &Evaluator,
    module_base64: &str,
    fail_open: bool,
    text: &str,
    state: &AppState,
) -> InlineFlag {
    use base64::Engine as _;

    // Fail (fail-closed unless the plugin declared open) helper.
    let fail = |reason: String| -> InlineFlag {
        if fail_open {
            warn!(evaluator = %ev.id, %reason, "wasm policy failed OPEN (declared) — allowing");
            InlineFlag::Ran {
                flagged: false,
                reason: String::new(),
            }
        } else {
            warn!(evaluator = %ev.id, %reason, "wasm policy failed CLOSED — blocking");
            InlineFlag::ForceBlock {
                reason: format!("wasm policy '{}' failed closed: {reason}", ev.id),
            }
        }
    };

    // Cap the base64 payload before decoding (bounds the decode work itself).
    if module_base64.len() > crate::wasm_policy::MAX_MODULE_B64_LEN {
        return fail("module payload too large".to_string());
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(module_base64.as_bytes()) {
        Ok(b) => b,
        Err(e) => return fail(format!("invalid base64 module: {e}")),
    };
    let Some(host) = state.wasm_host() else {
        return fail("wasm policy host unavailable".to_string());
    };
    match host.evaluate(&bytes, text).await {
        crate::wasm_policy::WasmVerdict::Allow => InlineFlag::Ran {
            flagged: false,
            reason: String::new(),
        },
        crate::wasm_policy::WasmVerdict::Deny { reason } => InlineFlag::Ran {
            flagged: true,
            reason,
        },
        crate::wasm_policy::WasmVerdict::Fail { reason } => fail(reason),
    }
}

/// Audit an inline-evaluator enforcement event (block/sanitize). Mirrors
/// [`audit_inspector_block`] so evaluator guardrails are as observable as the
/// inspector's, using the same audit fields.
pub(super) fn audit_inline_evaluator(
    state: &AppState,
    ctx: &RequestContext,
    model: &str,
    evaluator_id: &str,
    enforcement: &str,
    reason: &str,
) {
    let action = match enforcement {
        "blocked" => crate::traffic::VerdictAction::Block,
        "sanitized" => crate::traffic::VerdictAction::Sanitize,
        _ => crate::traffic::VerdictAction::Warn,
    };
    let verdict = crate::traffic::TrafficVerdict::new(crate::traffic::DecidedBy::Evaluator, action)
        .with_evaluator(evaluator_id);
    let record = AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        team_ids: ctx.audit_team_ids(),
        key_id: ctx.key_id(),
        project_id: ctx.project_id.clone(),
        provider: "evaluator".to_string(),
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
        latency_ms: 0,
        eval_score: None,
        error: Some(format!(
            "inline evaluator '{evaluator_id}' {enforcement}: {reason}"
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
        backend: Some("inline-evaluator".to_string()),
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    };
    state.log_audit_with(record, crate::traffic::TrafficOutcome::verdict(verdict));
}
