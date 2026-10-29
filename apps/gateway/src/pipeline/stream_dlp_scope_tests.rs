//! Streaming outbound DLP reads the tenant-resolved firewall (spec P0-5).
//!
//! Each case runs `run_stream` against a scripted provider and puts the
//! decisive rule only in the org overlay the control plane resolves for the
//! request (`ctx.resolved_policy`), never in the node base. A stream that the
//! node base alone would let through must still be blocked or sanitized, so a
//! regression to the node-base scanner fails here. Output DLP runs after the
//! upstream answered, so "blocked" means: exactly one provider call (no retry or
//! fallback), the block notice in place of the matched text, and a firewall
//! audit row for the request. Every blocked case has a benign control that
//! streams through.
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use axum::body::Body;
use serde_json::{json, Value};

use super::{run_stream, test_support::plain_request_context, RequestContext};
use crate::{
    audit::{AuditEntry, AuditLogger, AuditQuery},
    config::{
        AuditConfig, CustomPattern, CustomPatternKind, FirewallConfig, FirewallOverlay,
        FirewallPolicy, GatewayConfig, ProviderId, RoutingConfig,
    },
    evals::EvalsRunner,
    policy::EffectivePolicy,
    providers::Provider,
    state::AppState,
};

/// The canonical AWS documentation example access-key id.
const SECRET: &str = "AKIAIOSFODNN7EXAMPLE";
/// The test-only lexicon marker, matched by a tenant custom pattern.
const LEXICON: &str = "RYU_TEST_LEXICON";
/// The published Visa test card number.
const TEST_CARD: &str = "4111 1111 1111 1111";
const BENIGN: &str = "the weather report is sunny";
const BLOCK_NOTICE: &str = "[Ryu firewall] Response blocked";
const ORG: &str = "org-stream-dlp";

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;

/// Streams one content frame carrying `text`, counting every dispatch.
struct ScriptedStream {
    text: String,
    calls: Arc<AtomicUsize>,
}

impl Provider for ScriptedStream {
    fn name(&self) -> &'static str {
        "primary"
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(ryu_gw_providers::ProviderError::Provider("n/a".into())) })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let frame = json!({ "choices": [{ "index": 0, "delta": { "content": self.text } }] });
        let sse = format!("data: {frame}\n\ndata: [DONE]\n\n");
        Box::pin(async move { Ok(Body::from(sse)) })
    }
}

struct Harness {
    state: Arc<AppState>,
    calls: Arc<AtomicUsize>,
    dir: std::path::PathBuf,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn harness(firewall: FirewallConfig, upstream_text: &str) -> Harness {
    let dir = std::env::temp_dir().join(format!(
        "ryu-stream-dlp-scope-{}",
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
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall,
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
        },
        audit: audit_config,
        ..GatewayConfig::default()
    };
    let evals = EvalsRunner::new(config.evals.clone());
    let mut state = AppState::new_for_test(config, audit, evals);
    let calls = Arc::new(AtomicUsize::new(0));
    state
        .provider_runtime
        .register_for_test(Arc::new(ScriptedStream {
            text: upstream_text.to_owned(),
            calls: Arc::clone(&calls),
        }) as Arc<dyn Provider>);
    Harness {
        state: Arc::new(state),
        calls,
        dir,
    }
}

/// A node base with outbound scanning off: on its own it never blocks output.
fn node_base_outbound_off() -> FirewallConfig {
    FirewallConfig {
        enabled: true,
        scan_inbound: false,
        scan_outbound: false,
        policy: FirewallPolicy::WarnAndContinue,
        ..FirewallConfig::default()
    }
}

/// A node base that blocks outbound built-in matches but has no custom patterns.
fn node_base_block() -> FirewallConfig {
    FirewallConfig {
        enabled: true,
        scan_inbound: false,
        scan_outbound: true,
        policy: FirewallPolicy::Block,
        ..FirewallConfig::default()
    }
}

/// A request for `ORG` whose control-plane policy carries `overlay`.
fn tenant_ctx(request_id: &str, overlay: Option<FirewallOverlay>) -> RequestContext {
    let mut ctx = plain_request_context();
    ctx.request_id = request_id.to_owned();
    ctx.org_id = Some(ORG.to_owned());
    ctx.resolved_policy = Some(EffectivePolicy {
        firewall: overlay,
        ..EffectivePolicy::default()
    });
    ctx
}

fn tenant_block_overlay() -> FirewallOverlay {
    FirewallOverlay {
        scan_outbound: Some(true),
        policy: Some(FirewallPolicy::Block),
        ..FirewallOverlay::default()
    }
}

fn tenant_lexicon_overlay() -> FirewallOverlay {
    FirewallOverlay {
        custom_patterns: vec![CustomPattern {
            name: "ryu_test_lexicon".into(),
            regex: LEXICON.into(),
            kind: CustomPatternKind::Secret,
        }],
        ..FirewallOverlay::default()
    }
}

fn ping_body() -> Value {
    json!({ "model": "anything", "messages": [{ "role": "user", "content": "ping" }] })
}

async fn stream_text(harness: &Harness, ctx: RequestContext) -> String {
    let out = run_stream(Arc::clone(&harness.state), ctx, ping_body())
        .await
        .expect("the stream is served");
    let bytes = axum::body::to_bytes(out.body, usize::MAX)
        .await
        .expect("drain the sse body");
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Audit rows for `request_id`, polled because the logger writes off-thread.
async fn audit_rows(harness: &Harness, request_id: &str, want: usize) -> Vec<AuditEntry> {
    let mut rows = Vec::new();
    for _ in 0..200 {
        rows = harness
            .state
            .audit
            .query(&AuditQuery::default())
            .expect("query audit")
            .into_iter()
            .filter(|row| row.request_id == request_id)
            .collect();
        if rows.len() >= want {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    rows
}

async fn assert_firewall_audit_row(harness: &Harness, request_id: &str) {
    let rows = audit_rows(harness, request_id, 2).await;
    let blocks: Vec<_> = rows
        .iter()
        .filter(|row| row.provider == "firewall")
        .collect();
    assert_eq!(
        blocks.len(),
        1,
        "exactly one firewall audit row for the blocked stream: {rows:?}"
    );
    assert_eq!(blocks[0].org_id.as_deref(), Some(ORG));
    let error = blocks[0].error.as_deref().unwrap_or_default();
    assert!(
        error.contains("outbound stream blocked"),
        "the row records the stream block: {error}"
    );
}

async fn assert_no_firewall_audit_row(harness: &Harness, request_id: &str) {
    let rows = audit_rows(harness, request_id, 1).await;
    assert!(
        rows.iter().all(|row| row.provider != "firewall"),
        "a clean stream writes no firewall row: {rows:?}"
    );
}

/// The org turns outbound Block on over a node base that leaves output alone.
/// Built-in patterns with no evaluator take the incremental path, so this pins
/// the scanner `stream_dlp` scans each chunk with.
#[tokio::test]
async fn tenant_outbound_block_governs_the_incremental_stream() {
    let leak = harness(node_base_outbound_off(), &format!("the key is {SECRET} ok"));
    let text = stream_text(
        &leak,
        tenant_ctx("req-tenant-block", Some(tenant_block_overlay())),
    )
    .await;
    assert!(
        text.contains(BLOCK_NOTICE),
        "tenant Block must end the stream: {text}"
    );
    assert!(!text.contains(SECRET), "the key never streams: {text}");
    assert_eq!(leak.calls.load(Ordering::SeqCst), 1, "no retry or fallback");
    assert_firewall_audit_row(&leak, "req-tenant-block").await;

    let benign = harness(node_base_outbound_off(), BENIGN);
    let text = stream_text(
        &benign,
        tenant_ctx("req-tenant-block-control", Some(tenant_block_overlay())),
    )
    .await;
    assert!(
        text.contains(BENIGN),
        "benign output streams through: {text}"
    );
    assert!(
        !text.contains("[Ryu firewall]"),
        "no notice on clean output: {text}"
    );
    assert_eq!(benign.calls.load(Ordering::SeqCst), 1);
    assert_no_firewall_audit_row(&benign, "req-tenant-block-control").await;
}

/// A tenant custom pattern reaches the stream. Custom patterns force the
/// buffered path, so this pins both the path decision and the buffered scanner.
#[tokio::test]
async fn tenant_custom_pattern_governs_the_stream() {
    let leak = harness(node_base_block(), &format!("marker {LEXICON} here"));
    let text = stream_text(
        &leak,
        tenant_ctx("req-tenant-lexicon", Some(tenant_lexicon_overlay())),
    )
    .await;
    assert!(
        text.contains(BLOCK_NOTICE),
        "the tenant pattern must block the stream: {text}"
    );
    assert!(!text.contains(LEXICON), "the marker never streams: {text}");
    assert_eq!(leak.calls.load(Ordering::SeqCst), 1, "no retry or fallback");
    assert_firewall_audit_row(&leak, "req-tenant-lexicon").await;

    // Another tenant without the pattern is unaffected by this org's rule.
    let other = harness(node_base_block(), &format!("marker {LEXICON} here"));
    let text = stream_text(&other, tenant_ctx("req-other-tenant", None)).await;
    assert!(
        text.contains(LEXICON),
        "the rule is scoped to its org: {text}"
    );
    assert!(!text.contains("[Ryu firewall]"), "{text}");

    let benign = harness(node_base_block(), BENIGN);
    let text = stream_text(
        &benign,
        tenant_ctx("req-tenant-lexicon-control", Some(tenant_lexicon_overlay())),
    )
    .await;
    assert!(
        text.contains(BENIGN),
        "benign output streams through: {text}"
    );
    assert!(
        !text.contains("[Ryu firewall]"),
        "no notice on clean output: {text}"
    );
    assert_eq!(benign.calls.load(Ordering::SeqCst), 1);
    assert_no_firewall_audit_row(&benign, "req-tenant-lexicon-control").await;
}

/// The tenant's Sanitize policy, not the node's warn-only one, decides what a
/// PII match in the stream becomes.
#[tokio::test]
async fn tenant_sanitize_policy_governs_the_stream() {
    let base = FirewallConfig {
        scan_outbound: true,
        ..node_base_outbound_off()
    };
    let overlay = FirewallOverlay {
        policy: Some(FirewallPolicy::Sanitize),
        ..FirewallOverlay::default()
    };
    let leak = harness(base.clone(), &format!("card {TEST_CARD} on file"));
    let text = stream_text(&leak, tenant_ctx("req-tenant-sanitize", Some(overlay))).await;
    assert!(
        !text.contains(TEST_CARD),
        "tenant Sanitize redacts the card: {text}"
    );
    assert!(
        text.contains("on file"),
        "the rest of the reply streams: {text}"
    );
    assert!(
        !text.contains(BLOCK_NOTICE),
        "Sanitize never blocks: {text}"
    );
    assert_eq!(leak.calls.load(Ordering::SeqCst), 1);

    // Control: the node's own warn-only policy lets the same card through.
    let node_only = harness(base, &format!("card {TEST_CARD} on file"));
    let text = stream_text(&node_only, tenant_ctx("req-node-warn", None)).await;
    assert!(
        text.contains(TEST_CARD),
        "warn-only passes the card through: {text}"
    );
}
