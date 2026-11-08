use super::*;

/// The inspector and inline-evaluator branches of the prefix-stabilizing
/// redaction: each configured Sanitize stage redacts every request, not only
/// the ones it flags, and only while its pipeline stage is present.
#[tokio::test]
async fn sanitize_posture_covers_the_inspector_and_inline_evaluator_branches() {
    use crate::config::{FirewallPolicy, InspectorConfig};
    let redacted = |body: &serde_json::Value| !body.to_string().contains("jane@example.com");
    let untouched = |body: &serde_json::Value| *body == pii_in_prefix_body();
    let ctx = plain_ctx();

    // Inspector under Sanitize, with the firewall itself only warning.
    let mut inspector = warn_only_firewall();
    inspector.inspector.enabled = true;
    let state = sanitize_posture_state(inspector.clone(), &[]);
    let mut body = pii_in_prefix_body();
    super::super::pre_process(&state, &ctx, &mut body)
        .await
        .expect("an unflagged turn is served");
    assert!(redacted(&body), "inspector Sanitize redacts: {body}");

    // Control: inspector disabled.
    let state = sanitize_posture_state(warn_only_firewall(), &[]);
    let mut body = pii_in_prefix_body();
    super::super::pre_process(&state, &ctx, &mut body)
        .await
        .unwrap();
    assert!(untouched(&body), "no Sanitize posture: {body}");

    // Control: inspector Sanitize but the stage is not in the pipeline.
    let state = sanitize_posture_state(inspector.clone(), &[PipelineStage::Inspector]);
    let mut body = pii_in_prefix_body();
    super::super::pre_process(&state, &ctx, &mut body)
        .await
        .unwrap();
    assert!(untouched(&body), "Inspector stage absent: {body}");

    // Control: inspector enabled but its action is not Sanitize.
    let mut warn_inspector = inspector.clone();
    warn_inspector.inspector = InspectorConfig {
        action: FirewallPolicy::WarnAndContinue,
        ..warn_inspector.inspector
    };
    let state = sanitize_posture_state(warn_inspector, &[]);
    let mut body = pii_in_prefix_body();
    super::super::pre_process(&state, &ctx, &mut body)
        .await
        .unwrap();
    assert!(untouched(&body), "inspector action is not Sanitize: {body}");

    // Inline input evaluator resolving to Sanitize.
    let mut inline = warn_only_firewall();
    inline.evaluators = vec![sanitize_input_binding(true)];
    let state = sanitize_posture_state(inline.clone(), &[]);
    let mut body = pii_in_prefix_body();
    super::super::pre_process(&state, &ctx, &mut body)
        .await
        .expect("an unflagged turn is served");
    assert!(redacted(&body), "inline Sanitize redacts: {body}");

    // Control: the binding is disabled.
    let mut disabled = warn_only_firewall();
    disabled.evaluators = vec![sanitize_input_binding(false)];
    let state = sanitize_posture_state(disabled, &[]);
    let mut body = pii_in_prefix_body();
    super::super::pre_process(&state, &ctx, &mut body)
        .await
        .unwrap();
    assert!(untouched(&body), "disabled binding: {body}");

    // Control: the InlineInput stage is not in the pipeline.
    let state = sanitize_posture_state(inline.clone(), &[PipelineStage::InlineInput]);
    let mut body = pii_in_prefix_body();
    super::super::pre_process(&state, &ctx, &mut body)
        .await
        .unwrap();
    assert!(untouched(&body), "InlineInput stage absent: {body}");

    // Control: the binding keeps the catalog's own Block action.
    let mut blocking = warn_only_firewall();
    let mut binding = sanitize_input_binding(true);
    binding.inline_action = None;
    blocking.evaluators = vec![binding];
    let state = sanitize_posture_state(blocking, &[]);
    let mut body = pii_in_prefix_body();
    super::super::pre_process(&state, &ctx, &mut body)
        .await
        .unwrap();
    assert!(untouched(&body), "a Block-action binding: {body}");
}

/// Without a Sanitize posture nothing is rewritten: an unflagged definition
/// egresses exactly as the client sent it.
#[tokio::test]
async fn inbound_block_policy_leaves_unflagged_definitions_untouched() {
    use crate::config::{AlertTier, FirewallPolicy};
    let (state, _) = firewall_state(FirewallPolicy::Block, AlertTier::Silent);
    let mut body = json!({
        "model": "anything",
        "messages": [{ "role": "user", "content": "hi" }],
        "tools": [{ "type": "function", "function": {
            "name": "notify",
            "description": "Send mail, e.g. to jane@example.com",
            "parameters": { "type": "object" }
        } }]
    });
    let original = body["tools"].clone();
    super::super::pre_process(&state, &plain_ctx(), &mut body)
        .await
        .expect("allowed");
    assert_eq!(body["tools"], original);
}

/// Under `Block`, a secret or injection placed outside `messages[].content`
/// (tool-call arguments, a tool definition, predicted output) is still scanned
/// and the request never reaches the provider.
#[tokio::test]
async fn inbound_firewall_block_scans_tool_arguments_definitions_and_prediction() {
    use crate::config::{AlertTier, FirewallPolicy};
    let smuggled = [
        json!({
            "model": "anything",
            "messages": [
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1", "type": "function",
                    "function": { "name": "f", "arguments": "{\"k\":\"AKIAIOSFODNN7EXAMPLE\"}" }
                }] },
                { "role": "tool", "tool_call_id": "call_1", "content": "done" }
            ]
        }),
        json!({
            "model": "anything",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{ "type": "function", "function": {
                "name": "f",
                "description": "Deploy with key AKIAIOSFODNN7EXAMPLE",
                "parameters": { "type": "object" }
            } }]
        }),
        json!({
            "model": "anything",
            "messages": [{ "role": "user", "content": "hi" }],
            "prediction": { "type": "content", "content": "key sk-abcdefghijklmnopqrstu" }
        }),
    ];
    for body in smuggled {
        let (state, calls) = firewall_state(FirewallPolicy::Block, AlertTier::Silent);
        let err = match run(Arc::clone(&state), plain_ctx(), body.clone()).await {
            Err(err) => err,
            Ok(_) => panic!("smuggled content must be blocked: {body}"),
        };
        assert!(
            matches!(err, GatewayError::FirewallBlocked(..)),
            "expected FirewallBlocked for {body}, got {err:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0, "{body}");
    }
}

/// Tool definitions are developer-authored schemas: ordinary wording that the
/// prompt-injection patterns match, and example contact data the PII patterns
/// match, must not refuse every request from the agent under the default
/// Block posture. A secret in a definition is still caught (see the smuggling
/// test above).
#[tokio::test]
async fn inbound_firewall_does_not_block_injection_phrasing_in_tool_definitions() {
    use crate::config::{AlertTier, FirewallPolicy};
    let body = json!({
        "model": "anything",
        "messages": [{ "role": "user", "content": "list the lint failures" }],
        "tools": [
            { "type": "function", "function": {
                "name": "grep",
                "description": "Search files for a pattern",
                "parameters": { "type": "object", "properties": {
                    "ignore_case": {
                        "type": "boolean",
                        "description": "Whether to ignore case when matching rules"
                    }
                } }
            } },
            { "type": "function", "function": {
                "name": "Bash",
                "description": "Set dangerouslyDisableSandbox to override sandbox mode and run commands"
            } },
            { "type": "function", "function": {
                "name": "send_mail",
                "description": "Send an email, e.g. to jane@example.com or +1 415 555 0100"
            } }
        ]
    });
    assert!(
        extract_definition_text(&body).contains("ignore case when matching rules"),
        "the definition text still reaches the DLP screen"
    );
    let (state, calls) = firewall_state(FirewallPolicy::Block, AlertTier::Silent);
    run(Arc::clone(&state), plain_ctx(), body)
        .await
        .expect("schema wording is not a prompt injection");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// Locked guardrails read tool definitions for secrets and PII only: locked
/// prompt- and code-injection guardrails would otherwise refuse every turn
/// of an agent whose schemas use ordinary imperative or shell wording, while
/// a secret in a definition is still refused with the local firewall off.
#[tokio::test]
async fn locked_guardrails_screen_tool_definitions_for_secrets_and_pii_only() {
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (primary, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);
    let mut ctx = plain_ctx();
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        locked_guardrails: vec![
            "prompt_injection".to_owned(),
            "code_injection".to_owned(),
            "secrets".to_owned(),
        ],
        ..crate::policy::EffectivePolicy::default()
    });
    let with_definition = |description: &str| {
        json!({
            "model": "anything",
            "messages": [{ "role": "user", "content": "commit the fix" }],
            "tools": [{ "type": "function", "function": {
                "name": "Bash",
                "description": description,
                "parameters": { "type": "object" }
            } }]
        })
    };

    run(
        Arc::clone(&state),
        ctx.clone(),
        with_definition(
            "Use dangerouslyDisableSandbox to override sandbox mode and run commands. \
             Commit with git commit -m \"$(cat <<'EOF' ... EOF)\"",
        ),
    )
    .await
    .expect("agent-authored schema wording is not a locked-guardrail violation");
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let err = match run(
        Arc::clone(&state),
        ctx,
        with_definition("Deploy with key AKIAIOSFODNN7EXAMPLE"),
    )
    .await
    {
        Err(err) => err,
        Ok(_) => panic!("a secret in a tool definition must violate the locked guardrail"),
    };
    assert!(
        matches!(err, GatewayError::PolicyViolation(_)),
        "expected a locked-guardrail refusal, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the provider was not called"
    );
}

/// A `WarnAndContinue` inbound policy at a `Warn` alert tier serves the turn and
/// stamps a firewall policy alert on the response (observable, non-blocking).
#[tokio::test]
async fn inbound_firewall_warn_stamps_alert_and_serves() {
    use crate::config::{AlertTier, FirewallPolicy};
    let (state, calls) = firewall_state(FirewallPolicy::WarnAndContinue, AlertTier::Warn);
    let out = run(Arc::clone(&state), plain_ctx(), secret_body())
        .await
        .expect("warn-and-continue never blocks");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        out.policy_alert.is_some(),
        "a warn-tier firewall match must stamp a policy alert on the response"
    );
}
