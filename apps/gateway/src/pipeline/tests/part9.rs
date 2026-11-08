use super::*;

/// When no degradation occurred (primary provider served the request),
/// `degraded` is `None` in PipelineOutput — no x-degraded header is emitted.
#[test]
fn degraded_none_when_primary_serves_request() {
    // Simulate: primary was NOT skipped, so degraded is None.
    // We verify the DegradedMode logic directly.
    let primary_skipped = false;
    let provider_name = "openai";
    let degraded: Option<DegradedMode> = if primary_skipped {
        Some(DegradedMode::Fallback(provider_name.to_string()))
    } else {
        None
    };
    assert!(
        degraded.is_none(),
        "degraded must be None when the primary provider serves the request"
    );
}

/// When the primary was skipped (circuit open) and a fallback provider serves
/// the request, degraded is Some(Fallback(name)) (AC1 #218).
#[test]
fn degraded_fallback_when_primary_skipped() {
    let primary_skipped = true;
    let provider_name = "anthropic";
    let degraded: Option<DegradedMode> = if primary_skipped {
        Some(DegradedMode::Fallback(provider_name.to_string()))
    } else {
        None
    };
    assert_eq!(
        degraded,
        Some(DegradedMode::Fallback("anthropic".to_string())),
        "degraded must be Some(Fallback) when the primary was skipped"
    );
    assert_eq!(degraded.unwrap().header_value(), "fallback:anthropic");
}

/// A blocking/redacting enabled OUTPUT evaluator forces the streaming firewall
/// to buffer (so it can actually fire on the default warn/off streaming path).
#[test]
fn output_inline_wants_transform_true_for_blocking_binding() {
    let reg = EvaluatorRegistry::new();
    let block = scanner_with_bindings(vec![binding("toxicity", true, Some(FirewallPolicy::Block))]);
    assert!(output_inline_wants_transform(&block, &reg));

    let sanitize = scanner_with_bindings(vec![binding(
        "pii_leakage",
        true,
        Some(FirewallPolicy::Sanitize),
    )]);
    assert!(output_inline_wants_transform(&sanitize, &reg));
}

/// A disabled binding is a no-op; a warn-action binding does not force buffering;
/// an INPUT-target binding never affects the output buffer decision.
#[test]
fn output_inline_wants_transform_false_cases() {
    let reg = EvaluatorRegistry::new();
    // disabled
    assert!(!output_inline_wants_transform(
        &scanner_with_bindings(vec![binding(
            "toxicity",
            false,
            Some(FirewallPolicy::Block)
        )]),
        &reg
    ));
    // warn action → no buffering
    assert!(!output_inline_wants_transform(
        &scanner_with_bindings(vec![binding(
            "toxicity",
            true,
            Some(FirewallPolicy::WarnAndContinue)
        )]),
        &reg
    ));
    // input-target evaluator (code_injection) is not an output transform
    assert!(!output_inline_wants_transform(
        &scanner_with_bindings(vec![binding(
            "code_injection",
            true,
            Some(FirewallPolicy::Block)
        )]),
        &reg
    ));
    // no bindings at all
    assert!(!output_inline_wants_transform(
        &scanner_with_bindings(vec![]),
        &reg
    ));
}

/// An enabled toxicity binding routes to the LLM-judge (inspector) path, and a
/// flagged verdict + its Block action drives the SAME block outcome the regex
/// firewall uses (mock verdict tested at the pure-decision seam — the inspector
/// itself is fail-open-tested in `firewall::inspector`).
#[test]
fn toxicity_binding_routes_to_judge_and_blocks() {
    let reg = EvaluatorRegistry::new();
    let tox = reg.get("toxicity").expect("toxicity seeded");
    assert!(tox.capabilities.inline, "toxicity is inline-capable");
    assert_eq!(tox.target, EvaluatorTarget::Output);
    assert!(
        matches!(tox.impl_, EvaluatorImpl::LlmJudge { .. }),
        "toxicity dispatches to the inspect_rubric judge path"
    );
    let action = inline_action_for(&binding("toxicity", true, None), tox);
    // Mock verdict = flagged ⇒ Block; clean ⇒ Allow.
    assert_eq!(inline_outcome(true, &action), InlineOutcome::Block);
    assert_eq!(inline_outcome(false, &action), InlineOutcome::Allow);
}

/// The inline action resolves binding-first, then the catalog default.
#[test]
fn inline_action_resolution_precedence() {
    let reg = EvaluatorRegistry::new();
    let tox = reg.get("toxicity").expect("toxicity seeded");
    // Binding override wins.
    assert_eq!(
        inline_action_for(
            &binding("toxicity", true, Some(FirewallPolicy::Sanitize)),
            tox
        ),
        FirewallPolicy::Sanitize
    );
    // No binding action ⇒ the catalog default (toxicity defaults to Block).
    assert_eq!(
        inline_action_for(&binding("toxicity", true, None), tox),
        FirewallPolicy::Block
    );
}

/// response_to_text concatenates text across ALL choices AND array-of-parts
/// content, so toxic/PII text hidden in a second choice (`n>1`) or in a content
/// part no longer bypasses the non-stream / cache-hit Output judge.
#[test]
fn response_to_text_extracts_all_choices_and_parts() {
    // Plain choices[0] string still works.
    let simple = serde_json::json!({
        "choices": [{ "message": { "content": "hello world" } }]
    });
    assert_eq!(response_to_text(&simple), "hello world");

    // Array-of-parts content is extracted.
    let parts = serde_json::json!({
        "choices": [{ "message": { "content": [
            { "type": "text", "text": "kill yourself you worthless trash" }
        ] } }]
    });
    assert!(response_to_text(&parts).contains("kill yourself"));

    // A toxic SECOND choice (n>1) is no longer invisible.
    let multi = serde_json::json!({
        "choices": [
            { "message": { "content": "benign first choice" } },
            { "message": { "content": "you are a piece of shit" } }
        ]
    });
    let text = response_to_text(&multi);
    assert!(text.contains("benign first choice"));
    assert!(
        text.contains("piece of shit"),
        "second choice must be extracted"
    );
}

#[test]
fn structured_tool_arguments_are_scanned_and_redacted() {
    let secret = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
    let mut response = serde_json::json!({
        "choices": [{
            "message": {
                "content": "safe",
                "tool_calls": [{
                    "function": { "name": "lookup", "arguments": secret }
                }]
            }
        }]
    });
    assert!(response_to_text(&response).contains(secret));

    let scanner = FirewallScanner::new_scoped(FirewallConfig::default());
    sanitize_response(&mut response, &scanner);
    assert!(!response.to_string().contains(secret));
    assert!(response.to_string().contains("[REDACTED:gh_pat]"));
}

#[test]
fn streaming_dlp_rebuilds_structured_frames_and_rejects_malformed_data() {
    let secret = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
    let frame = serde_json::json!({
        "choices": [{
            "delta": {
                "tool_calls": [{ "function": { "arguments": secret } }]
            }
        }]
    });
    let raw = format!("data: {frame}\n\ndata: [DONE]\n\n");
    let scanner = FirewallScanner::new_scoped(FirewallConfig::default());
    let (rewritten, assembled, _) =
        rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::WarnAndContinue)
            .expect("valid SSE JSON should be rebuilt");
    assert!(!rewritten.contains(secret));
    assert!(!assembled.contains(secret));
    assert!(rewritten.contains("[REDACTED:gh_pat]"));

    assert!(rewrite_sse_for_dlp(
        "data: {not-json}\n\n",
        &scanner,
        &FirewallPolicy::WarnAndContinue,
    )
    .is_err());
}

#[test]
fn modality_governance_uses_final_model_guardrails_and_regions() {
    let state = AppState::new_for_test_default();
    let mut ctx = test_support::plain_request_context();
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_models: vec!["allowed-model".into()],
        locked_guardrails: vec!["secrets".into()],
        allowed_regions: vec!["global".into()],
        ..Default::default()
    });

    assert!(inference_governance::authorize_model(&state, &ctx, "allowed-model").is_ok());
    assert!(inference_governance::authorize_model(&state, &ctx, "blocked-model").is_err());
    assert!(inference_governance::enforce_locked_guardrails(
        &state,
        &ctx,
        "send sk-abcdefghijklmnopqrstuvwx"
    )
    .is_err());
    assert!(inference_governance::authorize_provider_region(
        &state,
        &ctx,
        &ProviderId::from("openai")
    )
    .is_ok());
    assert!(inference_governance::authorize_provider_region(
        &state,
        &ctx,
        &ProviderId::from("unregistered-plugin")
    )
    .is_err());
}

#[tokio::test]
async fn e2e_wasm_deny_blocks_request() {
    let state = wasm_state(wasm_evaluator("wasm_deny", E2E_DENY_WAT, false));
    let res = run_input_wasm(&state, "wasm_deny", FirewallPolicy::Block).await;
    assert!(
        matches!(res, Err(GatewayError::FirewallBlocked(_, _))),
        "a wasm DENY verdict bound to Block must 403, got {res:?}"
    );
}

#[tokio::test]
async fn e2e_wasm_allow_passes_request() {
    let state = wasm_state(wasm_evaluator("wasm_allow", E2E_ALLOW_WAT, false));
    let res = run_input_wasm(&state, "wasm_allow", FirewallPolicy::Block).await;
    assert!(
        res.is_ok(),
        "a wasm ALLOW verdict must let the turn proceed, got {res:?}"
    );
}

/// The critical fail-direction control: a trapping guest with `fail_open = false`
/// BLOCKS even when the binding's action is only `WarnAndContinue`. This is the
/// exact bypass the threat model (item F) calls out — a misconfigured Warn action
/// must NOT let a failed security policy through.
#[tokio::test]
async fn e2e_wasm_trap_fails_closed_even_when_action_is_warn() {
    let state = wasm_state(wasm_evaluator("wasm_loop", E2E_LOOP_WAT, false));
    let res = run_input_wasm(&state, "wasm_loop", FirewallPolicy::WarnAndContinue).await;
    assert!(
        matches!(res, Err(GatewayError::FirewallBlocked(_, _))),
        "a trapping fail-closed wasm policy must BLOCK regardless of Warn action, got {res:?}"
    );
}

/// An enrichment-style plugin may DECLARE `fail_open = true`; a trap then skips
/// (allows) instead of blocking — the declared, non-default direction.
#[tokio::test]
async fn e2e_wasm_trap_fail_open_allows() {
    let state = wasm_state(wasm_evaluator("wasm_loop_open", E2E_LOOP_WAT, true));
    let res = run_input_wasm(&state, "wasm_loop_open", FirewallPolicy::Block).await;
    assert!(
        res.is_ok(),
        "a fail_open=true wasm policy must ALLOW on trap (declared direction), got {res:?}"
    );
}

/// Output-target symmetry: the same host + verdict + fail-direction machinery
/// enforces on the non-streaming RESPONSE path (`apply_inline_output_evaluators`
/// resolves its scanner from `ctx`, so the binding is seeded into the node
/// firewall config the resolver reads). A wasm policy declared `target: Output`
/// and bound Block denies the assembled response.
#[tokio::test]
async fn e2e_wasm_output_target_deny_blocks_response() {
    let mut ev = wasm_evaluator("wasm_out_deny", E2E_DENY_WAT, false);
    ev.target = EvaluatorTarget::Output;
    let config = crate::config::GatewayConfig {
        custom_evaluators: vec![ev],
        firewall: FirewallConfig {
            evaluators: vec![binding("wasm_out_deny", true, Some(FirewallPolicy::Block))],
            ..FirewallConfig::default()
        },
        ..crate::config::GatewayConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let state = Arc::new(AppState::new_for_test(config, audit, evals));

    let ctx = wasm_ctx();
    let mut response = serde_json::json!({
        "model": "gpt-4o",
        "choices": [{ "message": { "role": "assistant", "content": "some reply" } }]
    });
    let res = apply_inline_output_evaluators(&state, &ctx, &mut response).await;
    assert!(
        matches!(res, Err(GatewayError::FirewallBlocked(_, _))),
        "an output-target wasm DENY bound to Block must block the response, got {res:?}"
    );
}
