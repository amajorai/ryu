use super::*;

#[test]
fn agent_route_proof_requires_core_secret_and_binds_bearer_and_agent() {
    type AgentRouteMac = Hmac<Sha256>;

    let bearer = "rgw_test-bearer";
    let core_key = "gwcore_separate_trusted_signer_for_tests";
    let proof = ryu_gw_credentials::sign_agent_route_proof(core_key, bearer, "agent-7").unwrap();

    assert!(verify_agent_route_proof(
        Some("Bearer rgw_test-bearer"),
        "agent-7",
        &proof,
        Some(core_key)
    ));
    assert!(!verify_agent_route_proof(
        Some("Bearer rgw_test-bearer"),
        "agent-8",
        &proof,
        Some(core_key)
    ));
    assert!(!verify_agent_route_proof(
        Some("Bearer rgw_other-bearer"),
        "agent-7",
        &proof,
        Some(core_key)
    ));

    let mut attacker_mac = AgentRouteMac::new_from_slice(bearer.as_bytes()).unwrap();
    attacker_mac.update(b"ryu-agent-route-v2\0");
    attacker_mac.update(ryu_gw_credentials::fingerprint(bearer).as_bytes());
    attacker_mac.update(b"victim-agent");
    let forged = hex::encode(attacker_mac.finalize().into_bytes());
    assert!(!verify_agent_route_proof(
        Some("Bearer rgw_test-bearer"),
        "victim-agent",
        &forged,
        Some(core_key)
    ));
    assert!(!verify_agent_route_proof(
        Some("Bearer rgw_test-bearer"),
        "agent-7",
        &proof,
        None
    ));
}

#[test]
fn a_per_org_proof_key_only_proves_its_own_organization() {
    let bearer = "Bearer rgw_test-bearer";
    let master = "gwproof_master_for_tests_000000";
    let own = ryu_gw_credentials::derive_org_core_proof_key(master, "org-a").unwrap();
    let other = ryu_gw_credentials::derive_org_core_proof_key(master, "org-b").unwrap();
    let proof =
        ryu_gw_credentials::sign_agent_route_proof(&own, "rgw_test-bearer", "agent-7").unwrap();
    assert_eq!(
        resolved_dynamic_agent_id(Some(bearer), Some("agent-7"), Some(&proof), &[own]).unwrap(),
        Some("agent-7".to_owned())
    );
    assert!(matches!(
        resolved_dynamic_agent_id(Some(bearer), Some("agent-7"), Some(&proof), &[other]),
        Err(GatewayError::Unauthorized(_))
    ));
}

#[test]
fn dynamic_agent_alias_requires_a_valid_core_proof() {
    let bearer = "Bearer rgw_test-bearer";
    let core_key = "gwcore_separate_trusted_signer_for_tests";
    let core_keys = [core_key.to_owned()];
    let proof =
        ryu_gw_credentials::sign_agent_route_proof(core_key, "rgw_test-bearer", "agent-7").unwrap();

    assert!(matches!(
        resolved_dynamic_agent_id(Some(bearer), Some("agent-7"), None, &core_keys),
        Err(GatewayError::Unauthorized(_))
    ));
    assert!(matches!(
        resolved_dynamic_agent_id(
            Some(bearer),
            Some("agent-7"),
            Some("invalid-proof"),
            &core_keys
        ),
        Err(GatewayError::Unauthorized(_))
    ));
    assert_eq!(
        resolved_dynamic_agent_id(Some(bearer), Some("agent-7"), Some(&proof), &core_keys).unwrap(),
        Some("agent-7".to_owned())
    );
    assert_eq!(
        resolved_dynamic_agent_id(Some(bearer), None, None, &core_keys).unwrap(),
        None
    );
}

#[test]
fn dynamic_credentials_bind_caller_to_their_team_and_owner() {
    let user = |id: &str, teams: &[&str]| crate::policy::VerifiedUser {
        user_id: id.to_owned(),
        team_ids: teams.iter().map(|team| (*team).to_owned()).collect(),
    };
    let caller = |user_id: Option<&str>, bound: Option<&str>, teams: &[&str]| DynamicCaller {
        user_id: user_id.map(str::to_owned),
        bound_user_id: bound.map(str::to_owned),
        team_ids: teams.iter().map(|team| (*team).to_owned()).collect(),
    };
    let owner_teams = vec!["t-own".to_owned()];

    // Org-wide credential: JWT-only attribution is unchanged.
    assert_eq!(
        bind_dynamic_caller(None, None, None, None),
        caller(None, None, &[])
    );
    assert_eq!(
        bind_dynamic_caller(None, None, None, Some(user("u1", &["t1"]))),
        caller(Some("u1"), None, &["t1"])
    );

    // Personal node, no JWT: the owner's member and team caps apply, but
    // the node token alone carries no user identity (no personal
    // resources, user cache tenant, or stored responses).
    assert_eq!(
        bind_dynamic_caller(Some("owner"), Some(&owner_teams), None, None),
        caller(None, Some("owner"), &["t-own"])
    );
    // The owner's own verified JWT adds the identity and its teams.
    assert_eq!(
        bind_dynamic_caller(
            Some("owner"),
            Some(&owner_teams),
            None,
            Some(user("owner", &["t-own", "t1"]))
        ),
        caller(Some("owner"), Some("owner"), &["t-own", "t1"])
    );
    // Another signed-in account's JWT is ignored, never a 401, and never
    // its identity or teams; the owner's caps still apply.
    assert_eq!(
        bind_dynamic_caller(
            Some("owner"),
            Some(&owner_teams),
            None,
            Some(user("intruder", &["t-intruder"]))
        ),
        caller(None, Some("owner"), &["t-own"])
    );
    // A legacy plane without owner teams falls back to the owner's JWT.
    assert_eq!(
        bind_dynamic_caller(Some("owner"), None, None, Some(user("owner", &["t1"]))),
        caller(Some("owner"), Some("owner"), &["t1"])
    );
    assert_eq!(
        bind_dynamic_caller(Some("owner"), None, None, Some(user("intruder", &["t1"]))),
        caller(None, Some("owner"), &[])
    );

    // Team node: the bound team is always a scope, and first.
    assert_eq!(
        bind_dynamic_caller(None, None, Some("team-a"), None),
        caller(None, None, &["team-a"])
    );
    assert_eq!(
        bind_dynamic_caller(
            None,
            None,
            Some("team-a"),
            Some(user("u1", &["team-b", "team-a"]))
        ),
        caller(Some("u1"), None, &["team-a", "team-b"])
    );
    // A verified caller outside the team (an org admin operating the
    // node) or one whose token lists no teams keeps their identity, and
    // their member cap, on top of the team's cap.
    assert_eq!(
        bind_dynamic_caller(None, None, Some("team-a"), Some(user("admin", &["team-b"]))),
        caller(Some("admin"), None, &["team-a", "team-b"])
    );
    assert_eq!(
        bind_dynamic_caller(None, None, Some("team-a"), Some(user("member", &[]))),
        caller(Some("member"), None, &["team-a"])
    );
}

#[test]
fn core_proof_header_is_distinct_from_the_inference_bearer() {
    let core_proof = "gwproof_core_only_secret";
    let inference_bearer = "rgw_org_scoped_inference_secret";
    assert!(core_proof_header_matches(core_proof, core_proof));
    assert!(!core_proof_header_matches(inference_bearer, core_proof));
}

/// attach_stream_observer writes a non-zero audit row at stream end when the
/// SSE fixture contains a terminal usage frame (AC2 of issue #179).
#[tokio::test]
async fn stream_observer_writes_non_zero_audit_row_from_usage_frame() {
    use crate::audit::{AuditLogger, AuditQuery};
    use crate::config::{AuditConfig, EvalsConfig, GatewayConfig};
    use crate::evals::EvalsRunner;
    use crate::state::AppState;
    use axum::body::Body;
    use std::sync::Arc;

    // Recorded SSE fixture with a terminal usage frame (OpenAI format).
    let fixture = concat!(
        "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",",
        "\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",",
        "\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3,\"total_tokens\":13,",
        "\"prompt_tokens_details\":{\"cached_tokens\":4,\"cache_write_tokens\":2}}}\n\n",
        "data: [DONE]\n\n"
    );

    // Build a minimal AppState with audit enabled and evals enabled.
    let dir = std::env::temp_dir().join(format!(
        "ryu-stream-obs-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let db_path = dir.join("audit.db");
    let audit_config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_string(),
    };
    let audit = AuditLogger::new(&audit_config).expect("audit logger");
    let evals_config = EvalsConfig {
        enabled: true,
        max_latency_ms: 10_000,
        sample_rate: 1.0,
        stream_usage: true,
        default_model: None,
        judge_model: None,
        online: Default::default(),
    };
    let evals = EvalsRunner::new(evals_config.clone());

    let config = GatewayConfig {
        audit: audit_config.clone(),
        evals: evals_config,
        ..GatewayConfig::default()
    };

    let state = Arc::new(AppState::new_for_test(config, audit, evals));

    let ctx = RequestContext {
        org_limits: None,
        identity: None,
        standing: None,
        enforcement: None,
        host_conversation: None,
        authorized_operation: crate::config::ApiKeyOperation::Inference,
        provider_snapshot: None,
        request_id: "test-obs-req".to_string(),
        api_key: "sk-test".to_string(),
        owner_binding: ryu_gw_credentials::fingerprint("sk-test"),
        is_master_key: false,
        org_id: None,
        team_id: None,
        project_id: None,
        user_name: None,
        user_id: None,
        agent_id: None,
        agent_provider_access: None,
        key_config: None,
        skill_ids: None,
        tool_actions: None,
        tools_header_present: false,
        capability_hints: None,
        slot_provider: None,
        slot_model: None,
        own_supply_route: None,
        violation_attempt: Default::default(),
        session_id: None,
        feature: None,
        purpose: None,
        companion_source: false,
        tool_search_requested: false,
        untrusted_caller: false,
        priority: crate::concurrency::Priority::Interactive,
        tool_profile: None,
        raw_tools: false,
        managed_inference: false,
        openrouter_routing_enabled: false,
        remaining_budget_micro_usd: None,
        unrestricted_budget_micro_usd: None,
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        credit_accounting_unavailable: false,
        budget_resolved_at: None,
        resolved_policy: None,
        prompt_cache_mode: None,
        prompt_cache_ttl: None,
        node_routing: None,
    };

    let body = Body::from(fixture);
    let observed = attach_stream_observer(
        body,
        Arc::clone(&state),
        ctx,
        "openai".to_string(),
        "gpt-4o".to_string(),
        ryu_gw_providers::PromptCacheOutcome::AutomaticProvider,
        5, // estimated (should be overridden by the real frame)
        Instant::now(),
        None,
        None,
    );

    // Drain the observed body to trigger the stream end hook.
    let _ = axum::body::to_bytes(observed, usize::MAX).await.unwrap();

    // Wait for the async audit writer to persist the row.
    let query = AuditQuery::default();
    let mut rows = Vec::new();
    for _ in 0..100 {
        rows = state.audit.query(&query).expect("query");
        if !rows.is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    assert_eq!(
        rows.len(),
        1,
        "exactly one audit row must be written at stream end"
    );
    let row = &rows[0];
    assert_eq!(
        row.input_tokens, 10,
        "input_tokens must match the usage frame (non-zero)"
    );
    assert_eq!(
        row.output_tokens, 3,
        "output_tokens must match the usage frame (non-zero)"
    );
    assert_eq!(row.prompt_cache_outcome.as_deref(), Some("automatic"));
    assert_eq!(row.prompt_cache_read_tokens, Some(4));
    assert_eq!(row.prompt_cache_write_tokens, Some(2));
    assert!(
        row.eval_score.is_some(),
        "eval_score must be populated for sampled streams"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// A stream settled by `Drop` (the client hung up after the usage frame)
/// writes the cache legs its debit priced onto the audit row, so the usage
/// reporter re-prices the row as the wallet was charged.
#[tokio::test]
async fn a_dropped_stream_records_the_cache_legs_its_debit_priced() {
    use crate::audit::{AuditLogger, AuditQuery};
    use crate::config::{AuditConfig, GatewayConfig};
    use crate::evals::EvalsRunner;
    use crate::state::AppState;
    use std::sync::Arc;

    let dir = std::env::temp_dir().join(format!(
        "ryu-stream-drop-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let audit_config = AuditConfig {
        enabled: true,
        db_path: dir.join("audit.db").to_str().unwrap().to_string(),
    };
    let audit = AuditLogger::new(&audit_config).expect("audit logger");
    let config = GatewayConfig {
        audit: audit_config,
        ..GatewayConfig::default()
    };
    let evals = EvalsRunner::new(config.evals.clone());
    let state = Arc::new(AppState::new_for_test(config, audit, evals));
    let mut observer = StreamObserverState::new(
        Arc::clone(&state),
        test_support::plain_request_context(),
        "openai-credits".to_string(),
        "gpt-4o".to_string(),
        ryu_gw_providers::PromptCacheOutcome::AutomaticProvider,
        5,
        Instant::now(),
        None,
        None,
    );
    observer.accumulated = concat!(
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100000,",
        "\"completion_tokens\":10,\"prompt_tokens_details\":",
        "{\"cached_tokens\":90000,\"cache_write_tokens\":0}}}\n\n"
    )
    .to_string();
    drop(observer);

    let mut rows = Vec::new();
    for _ in 0..100 {
        rows = state.audit.query(&AuditQuery::default()).expect("query");
        if !rows.is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert!(row.error.is_some(), "the Drop path wrote this row");
    assert_eq!(row.cache_read_tokens, Some(90_000));
    assert_eq!(row.cache_write_tokens, Some(0));
    assert_eq!(row.prompt_cache_read_tokens, Some(90_000));
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC1: companion_sanitize_messages handles array-of-parts content shape.
#[test]
fn companion_sanitize_messages_redacts_pii_in_parts_content() {
    use crate::config::FirewallConfig;
    use crate::firewall::FirewallScanner;

    let scanner = FirewallScanner::new(FirewallConfig::default());

    let mut messages = serde_json::json!([
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Screen capture: SSN 123-45-6789"}
            ]
        }
    ]);

    scanner.companion_sanitize_messages(&mut messages);

    let text = messages[0]["content"][0]["text"].as_str().unwrap();
    assert!(
        !text.contains("123-45-6789"),
        "companion sanitize must redact PII in parts content: {text}"
    );
    assert!(
        text.contains("[REDACTED:"),
        "parts content must contain redaction placeholder: {text}"
    );
}

/// AC4: a non-companion request body passes through pre_process message
/// extraction unmodified (the companion branch must be strictly gated on the
/// `companion_source` flag). This is a unit-level check on the sanitization
/// helpers — the scanner used is in default (warn-and-continue) mode.
#[test]
fn non_companion_clean_text_is_byte_identical_after_extraction() {
    // extract_text_for_scanning must return the same text regardless of the
    // companion flag — it reads messages, not modifies them.
    let body = serde_json::json!({
        "model": "gpt-4o",
        "messages": [
            {"role": "user", "content": "Hello, world!"}
        ]
    });
    let extracted = extract_text_for_scanning(&body);
    assert_eq!(extracted, "Hello, world!");
}

/// DegradedMode::Fallback with an arbitrary provider name round-trips
/// correctly — the header value is always prefixed with "fallback:".
#[test]
fn degraded_mode_fallback_header_value_prefix_is_stable() {
    for provider in ["openai", "local", "openrouter", "core"] {
        let mode = DegradedMode::Fallback(provider.to_string());
        let header = mode.header_value();
        assert!(
            header.starts_with("fallback:"),
            "header value must start with 'fallback:' for all providers, got: {header}"
        );
        assert!(
            header.ends_with(provider),
            "header value must end with the provider name, got: {header}"
        );
    }
}
