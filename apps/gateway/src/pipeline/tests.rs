use super::*;

use crate::config::FirewallConfig;

use crate::firewall::FirewallScanner;

use axum::{routing::post, Router};

mod support;
use support::*;
mod part1;
mod part2;
mod part3;
mod part4;
mod part5;
mod part6;
mod part7;
mod part8;
mod part9;

struct ScriptedVideoOrigin(std::sync::atomic::AtomicUsize);

impl ryu_gw_providers::VideoPollOrigin for ScriptedVideoOrigin {
    fn poll(&self) -> ryu_gw_providers::VideoPollFuture<'_> {
        let attempt = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if attempt == 0 {
                return Err(ryu_gw_providers::VideoPollError::CredentialRejected);
            }
            Ok(ryu_gw_providers::VideoJob {
                provider_ref: "private-origin-ref".into(),
                status: crate::jobs::JobStatus::Succeeded,
                output: Some(json!({"data":[{"url":"https://example.test/video.mp4"}]})),
                error: None,
            })
        })
    }
}

// ── prompt cache: request override + usage readback ──────────────────────

#[test]
fn request_override_is_honoured_when_the_node_allows_it() {
    let mut ctx = signal_ctx(None, false, false);
    ctx.prompt_cache_mode = Some(ryu_gw_providers::PromptCacheMode::Explicit);
    ctx.prompt_cache_ttl = Some("1h".into());

    let cfg = crate::config::PromptCacheConfig::default();
    assert!(cfg.allow_request_override, "override is on by default");
    let (mode, ttl) = resolve_prompt_cache_override(&cfg, &ctx);
    assert_eq!(mode, Some(ryu_gw_providers::PromptCacheMode::Explicit));
    assert_eq!(ttl.as_deref(), Some("1h"));
}

// ─── Anthropic betas (private `ryu_anthropic_beta` field) ────────────────

/// A minimal chat body carrying the private betas field, as `api::chat`
/// leaves it after folding in the caller's `anthropic-beta` header.
fn body_with_betas() -> Value {
    let mut body = json!({ "model": "m" });
    body[ANTHROPIC_BETA_FIELD] = json!("code-execution-2025-05-22");
    body
}

// ─── Cloud sampler extensions (private `ryu_sampling` field) ─────────────

#[test]
fn sampling_extensions_follow_each_fallback_attempt_provider() {
    let mut body = json!({
        "model": "m",
        "messages": [],
        SAMPLING_EXTENSIONS_FIELD: { "top_k": 20, "min_p": 0.05, "repeat_penalty": 1.1 }
    });
    let mut extensions = SamplingExtensions::take(&mut body);
    assert!(body.get(SAMPLING_EXTENSIONS_FIELD).is_none());

    extensions.apply_for(&mut body, "openrouter");
    assert_eq!(body["top_k"], json!(20));
    assert_eq!(body["min_p"], json!(0.05));
    assert_eq!(body["repetition_penalty"], json!(1.1));

    // Fallback onto Anthropic keeps only its native sampler.
    extensions.apply_for(&mut body, "anthropic");
    assert_eq!(body["top_k"], json!(20));
    assert!(body.get("min_p").is_none());
    assert!(body.get("repetition_penalty").is_none());

    // Gemini through the genai SDK provider takes only top_k.
    extensions.apply_for(&mut body, "genai");
    assert_eq!(body["top_k"], json!(20));
    assert!(body.get("min_p").is_none());

    // A strict OpenAI endpoint (or an unknown provider) gets none.
    for provider in ["openai", "genai-groq", "some-future-provider"] {
        extensions.apply_for(&mut body, provider);
        assert_eq!(body, json!({ "model": "m", "messages": [] }), "{provider}");
    }
}

// ─── Tool-policy profile resolution (#473 profiles) ──────────────────────

use crate::config::{ToolProfile, ToolsConfig};

/// A `RequestContext` with an `x-ryu-tools` CSV and a selected profile name.
fn profile_ctx(tool_actions: Option<&str>, profile: Option<&str>) -> RequestContext {
    let mut ctx = signal_ctx(tool_actions, tool_actions.is_some(), false);
    ctx.tool_profile = profile.map(str::to_string);
    ctx
}

// ─── Multimodal pipeline integration tests ────────────────────────────────

#[tokio::test]
async fn unavailable_inline_bindings_reject_text_and_media_before_routing() {
    for id in ["code_evaluator", "explicit_content"] {
        let state = Arc::new(AppState::new_for_test_default());
        let binding = crate::evaluators::EvaluatorBinding {
            id: id.into(),
            enabled: true,
            inline_action: None,
            offline: None,
            locked: false,
        };
        state.update_firewall_config(FirewallConfig {
            evaluators: vec![binding],
            ..FirewallConfig::default()
        });
        let ctx = test_support::plain_request_context();
        let mut body =
            json!({"model": "test-model", "messages": [{"role": "user", "content": "hi"}]});
        let result = pre_process(&state, &ctx, &mut body).await;
        assert!(
            matches!(result, Err(GatewayError::BadRequest(reason)) if reason.contains("unavailable inline"))
        );
        let result = run_multimodal(
            state.clone(),
            ctx,
            json!({"model": "test-image", "prompt": "a cat"}),
            Modality::Image,
        )
        .await;
        assert!(
            matches!(result, Err(GatewayError::BadRequest(reason)) if reason.contains("unavailable inline"))
        );
    }
}

// ─── Per-attribute slot routing tests (M3 / #164) ────────────────────────

/// Core forwards a carded agent's image slot as `x-ryu-slot-image-provider`
/// and `x-ryu-slot-image-model`. The gateway must route the image call to
/// the slot's provider even when the static modality_map says something else.
/// This is the primary AC for issue #164: same agent, different providers per
/// modality, with the slot override winning over the map entry.
#[test]
fn per_agent_slot_override_wins_over_modality_map() {
    use crate::config::{ModalityMapping, ProviderKind, RoutingConfig};
    use std::collections::HashMap;

    // Static modality_map says image → OpenAi, dall-e-3.
    let mut modality_map = HashMap::new();
    modality_map.insert(
        Modality::Image,
        ModalityMapping {
            provider: ProviderKind::OpenAi.into(),
            model: Some("dall-e-3".to_string()),
        },
    );

    let router = crate::router::ModelRouter::new(RoutingConfig {
        modality_map,
        ..RoutingConfig::default()
    });

    // The carded agent's image slot pins Local / "my-local-image-model".
    let slot_provider: ProviderId = ProviderKind::Local.into();
    let slot_model = "my-local-image-model";

    let decision = router.route_modality_with_slot(
        &Modality::Image,
        "dall-e-3",
        Some(&slot_provider),
        Some(slot_model),
    );

    assert_eq!(
        decision.provider,
        ProviderKind::Local,
        "slot provider must win over the static modality_map entry (AC2 #164)"
    );
    assert_eq!(
        decision.model, "my-local-image-model",
        "slot model must be forwarded to the provider (AC2 #164)"
    );
}

// ─── Streaming token-usage tap tests (#179) ───────────────────────────────

#[test]
fn upstream_identity_is_a_hashed_subject_on_the_fleet_and_absent_elsewhere() {
    let keys = crate::identity::IdentityKeys::for_test(&[7; 32], Some((1, &[9; 32])));
    let mut ctx = crate::pipeline::test_support::plain_request_context();
    ctx.org_id = Some("org_a".to_owned());
    ctx.user_id = Some("user-7".to_owned());
    ctx.agent_id = Some("agent-7".to_owned());
    crate::identity::attach(&keys, &mut ctx);
    let identity = ctx.identity.clone().unwrap();
    // An unverified forwarded user id on a non-forwarder context is
    // ignored: the org is the actor.
    assert_eq!(identity.actor.kind, crate::identity::SubjectKind::Org);
    let subject = identity.upstream_subject.clone().unwrap();
    assert!(subject.starts_with("ryu.1."), "{subject}");

    let mut fleet = AppState::new_for_test_default();
    fleet.custody = crate::custody::GatewayCustody::Fleet;
    let mut openrouter = json!({ "model": "openrouter/model", "user": "raw-tenant-id" });
    stamp_upstream_identity(
        &fleet,
        &ctx,
        &mut openrouter,
        "openrouter",
        crate::identity::UpstreamSurface::Chat,
    );
    assert_eq!(openrouter["user"], json!(subject));
    let wire = openrouter.to_string();
    assert!(!wire.contains("ryu-agent:") && !wire.contains("ryu-user:"));
    assert!(!wire.contains("agent-7") && !wire.contains("user-7"));
    assert!(!wire.contains("raw-tenant-id"));

    let self_hosted = AppState::new_for_test_default();
    let mut body = json!({ "model": "openrouter/model", "user": "operator-own-id" });
    stamp_upstream_identity(
        &self_hosted,
        &ctx,
        &mut body,
        "openrouter",
        crate::identity::UpstreamSurface::Chat,
    );
    assert_eq!(
        body,
        json!({ "model": "openrouter/model", "user": "operator-own-id" })
    );
}

// ── Companion DLP egress guard tests (M7 / #199) ─────────────────────────

/// AC1: companion_sanitize_messages redacts PII from string-content messages.
#[test]
fn companion_sanitize_messages_redacts_pii_in_string_content() {
    use crate::config::FirewallConfig;
    use crate::firewall::FirewallScanner;

    let scanner = FirewallScanner::new(FirewallConfig {
        enabled: false,
        redact_pii: false,
        redact_secrets: false,
        ..FirewallConfig::default()
    });

    let mut messages = serde_json::json!([
        {"role": "user", "content": "My email is user@example.com and key sk-abcdefghijklmnopqrstu"},
        {"role": "system", "content": "Safe system prompt"}
    ]);

    scanner.companion_sanitize_messages(&mut messages);

    let user_content = messages[0]["content"].as_str().unwrap();
    assert!(
        !user_content.contains("user@example.com"),
        "companion sanitize must redact PII email: {user_content}"
    );
    assert!(
        !user_content.contains("sk-abcdefghijklmnopqrstu"),
        "companion sanitize must redact secrets: {user_content}"
    );
    // Safe system prompt should not be altered (no PII).
    assert_eq!(
        messages[1]["content"].as_str().unwrap(),
        "Safe system prompt",
        "clean content must pass through unchanged"
    );
}

// ── Degraded-mode signal tests (#218) ─────────────────────────────────────

/// DegradedMode::Fallback header_value encodes the provider name so the
/// client can identify which fallback served the request (AC1 #218).
#[test]
fn degraded_mode_fallback_header_value_encodes_provider() {
    let mode = DegradedMode::Fallback("anthropic".to_string());
    assert_eq!(
        mode.header_value(),
        "fallback:anthropic",
        "x-degraded header must be 'fallback:<provider>' for the Fallback variant"
    );
}

// ── Unified-evaluator inline bridge gating (P3) ───────────────────────────

use crate::evaluators::EvaluatorBinding;

fn scanner_with_bindings(bindings: Vec<EvaluatorBinding>) -> FirewallScanner {
    FirewallScanner::new(FirewallConfig {
        evaluators: bindings,
        ..FirewallConfig::default()
    })
}

// ── WASM policy tier: end-to-end pipeline enforcement (gateway plugin plane) ──
//
// Proves the full vertical slice: a manifest declares a `Wasm` policy evaluator
// → the pipeline loads it sandboxed → `apply_inline_input_evaluators` calls it →
// the verdict is enforced via the SAME Block/Sanitize/Warn machinery → a
// misbehaving module FAILS CLOSED (blocks) even when the binding action is Warn
// (threat-model item F: a trap must never be a silent bypass).

/// Always-DENY guest (decision byte 1, reason "denied").
const E2E_DENY_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (data (i32.const 2100) "\01denied")
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (i64.const 0x0000_0834_0000_0007)))
    "#;

/// Always-ALLOW guest (decision byte 0).
const E2E_ALLOW_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (data (i32.const 2048) "\00")
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (i64.const 0x0000_0800_0000_0001)))
    "#;

/// Infinite-loop guest — trapped by fuel/epoch, must fail closed.
const E2E_LOOP_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (loop $l (br $l)) (i64.const 0)))
    "#;

fn wasm_b64(wat: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(wat::parse_str(wat).expect("wat compiles"))
}
