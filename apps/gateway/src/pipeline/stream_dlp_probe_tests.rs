//! Coverage probes for tenant-resolved streaming outbound DLP (spec P0-5).
//!
//! `stream_dlp_scope_tests` pins the org overlay over one content frame. These
//! probes put the decisive rule in every other scope the resolver merges
//! (agent, team, request overlay, global policy snapshot) and place a harmless
//! marker in the frame shapes a provider can emit: split deltas, mid-token
//! byte splits, long benign padding, nested stringified tool arguments, extra
//! choices, `message` and `reasoning_content` carriers, error frames, envelope
//! fields and model-controlled object keys. Both stream DLP paths are covered:
//! the test card under a tenant `Block` takes the incremental path, and the
//! `RYU_TEST_LEXICON` tenant custom pattern takes the buffered one.
//!
//! "Blocked" here means the exact block-by-policy notice (not the "could not be
//! scanned" refusals), no marker text in the client stream, one upstream call
//! per attempt, and one `firewall` audit row. Every blocked case has a negative
//! control (same shape, no tenant rule: the marker reaches the client, so the
//! shape really streams) and a benign control (same rule, no marker: no notice
//! and no firewall row).
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

use super::{
    node_routing::NodeRoutingPrefs, run_stream, test_support::plain_request_context, RequestContext,
};
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

/// The published Visa test card number (built-in PII, incremental path).
const TEST_CARD: &str = "4111 1111 1111 1111";
/// The test-only lexicon marker, matched by a tenant custom pattern (buffered path).
const LEXICON: &str = "RYU_TEST_LEXICON";
const BLOCK_NOTICE: &str = "[Ryu firewall] Response blocked by policy";
const ORG: &str = "org-stream-dlp-probe";

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;

/// Streams `chunks` as separate body chunks (so a line or token can be split at
/// any byte), or fails the stream open when `chunks` is `None`.
struct ChunkedStream {
    name: &'static str,
    chunks: Option<Vec<String>>,
    calls: Arc<AtomicUsize>,
}

impl Provider for ChunkedStream {
    fn name(&self) -> &'static str {
        self.name
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
        let chunks = self.chunks.clone();
        let name = self.name;
        Box::pin(async move {
            let Some(chunks) = chunks else {
                return Err(ryu_gw_providers::ProviderError::Provider(format!(
                    "{name} stream open failed"
                )));
            };
            let stream = futures_util::stream::iter(
                chunks
                    .into_iter()
                    .map(|chunk| Ok::<_, std::io::Error>(bytes::Bytes::from(chunk))),
            );
            Ok(Body::from_stream(stream))
        })
    }
}

struct Harness {
    state: Arc<AppState>,
    calls: Vec<Arc<AtomicUsize>>,
    dir: std::path::PathBuf,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Harness {
    fn calls(&self, index: usize) -> usize {
        self.calls[index].load(Ordering::SeqCst)
    }
}

/// One provider per entry, in fallback order; `None` fails the stream open.
fn harness_with(
    firewall: FirewallConfig,
    providers: Vec<(&'static str, Option<Vec<String>>)>,
    tweak: impl FnOnce(&mut GatewayConfig),
) -> Harness {
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "ryu-stream-dlp-probe-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    let audit_config = AuditConfig {
        enabled: true,
        db_path: dir.join("audit.db").to_str().unwrap().to_string(),
    };
    let audit = AuditLogger::new(&audit_config).expect("audit logger");
    let chain: Vec<ProviderId> = providers
        .iter()
        .map(|(name, _)| ProviderId::from(*name))
        .collect();
    let mut config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: chain[0].clone(),
            fallback_chain: chain,
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
    tweak(&mut config);
    let evals = EvalsRunner::new(config.evals.clone());
    let mut state = AppState::new_for_test(config, audit, evals);
    let mut calls = Vec::new();
    for (name, chunks) in providers {
        let counter = Arc::new(AtomicUsize::new(0));
        state
            .provider_runtime
            .register_for_test(Arc::new(ChunkedStream {
                name,
                chunks,
                calls: Arc::clone(&counter),
            }) as Arc<dyn Provider>);
        calls.push(counter);
    }
    Harness {
        state: Arc::new(state),
        calls,
        dir,
    }
}

fn harness(firewall: FirewallConfig, chunks: Vec<String>) -> Harness {
    harness_with(firewall, vec![("primary", Some(chunks))], |_| {})
}

/// Outbound scanning off and warn-only: the node alone never touches output.
fn node_base_outbound_off() -> FirewallConfig {
    FirewallConfig {
        enabled: true,
        scan_inbound: false,
        scan_outbound: false,
        policy: FirewallPolicy::WarnAndContinue,
        ..FirewallConfig::default()
    }
}

/// Outbound Block with the built-in patterns only (no custom patterns).
fn node_base_block() -> FirewallConfig {
    FirewallConfig {
        enabled: true,
        scan_inbound: false,
        scan_outbound: true,
        policy: FirewallPolicy::Block,
        ..FirewallConfig::default()
    }
}

fn block_overlay() -> FirewallOverlay {
    FirewallOverlay {
        scan_outbound: Some(true),
        policy: Some(FirewallPolicy::Block),
        ..FirewallOverlay::default()
    }
}

fn lexicon_overlay() -> FirewallOverlay {
    FirewallOverlay {
        custom_patterns: vec![CustomPattern {
            name: "ryu_test_lexicon".into(),
            regex: LEXICON.into(),
            kind: CustomPatternKind::Secret,
        }],
        ..FirewallOverlay::default()
    }
}

fn ctx_with(request_id: &str, policy: Option<EffectivePolicy>) -> RequestContext {
    let mut ctx = plain_request_context();
    ctx.request_id = request_id.to_owned();
    ctx.org_id = Some(ORG.to_owned());
    ctx.resolved_policy = policy;
    ctx
}

fn org_ctx(request_id: &str, overlay: Option<FirewallOverlay>) -> RequestContext {
    ctx_with(
        request_id,
        Some(EffectivePolicy {
            firewall: overlay,
            ..EffectivePolicy::default()
        }),
    )
}

fn ping_body() -> Value {
    json!({ "model": "anything", "messages": [{ "role": "user", "content": "ping" }] })
}

fn sse(frame: &Value) -> String {
    format!("data: {frame}\n\n")
}

fn delta(content: &str) -> Value {
    json!({ "id": "c", "object": "chat.completion.chunk",
            "choices": [{ "index": 0, "delta": { "content": content } }] })
}

const DONE: &str = "data: [DONE]\n\n";

/// The marker split in two at a byte that is not a whitespace boundary.
fn halves(marker: &str) -> (&str, &str) {
    marker.split_at(marker.len() / 2 - 1)
}

fn tool_frame(arguments: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{
        "index": 0, "id": "call_1", "type": "function",
        "function": { "name": "lookup", "arguments": arguments }
    }] } }] })
}

/// Every frame shape probed, each carrying `marker` (or a benign stand-in).
fn shapes(marker: &str) -> Vec<(&'static str, Vec<String>)> {
    let (head, tail) = halves(marker);
    let mut out: Vec<(&'static str, Vec<String>)> = Vec::new();

    out.push((
        "single_delta",
        vec![sse(&delta(&format!("value {marker} end"))), DONE.into()],
    ));
    out.push((
        "split_across_deltas",
        vec![
            sse(&delta(&format!("value {head}"))),
            sse(&delta(&format!("{tail} end"))),
            DONE.into(),
        ],
    ));
    // One frame cut mid-line and mid-marker across three body chunks.
    let whole = sse(&delta(&format!("value {marker} end")));
    let cut_a = whole.find(head).unwrap() + head.len() / 2;
    let cut_b = whole.find(tail).unwrap() + 1;
    out.push((
        "split_mid_token_bytes",
        vec![
            whole[..cut_a].to_owned(),
            whole[cut_a..cut_b].to_owned(),
            whole[cut_b..].to_owned(),
            DONE.into(),
        ],
    ));
    let crlf = format!(
        "data: {}\r\n\r\ndata: {}\r\n\r\ndata: [DONE]\r\n\r\n",
        delta(&format!("value {head}")),
        delta(&format!("{tail} end"))
    );
    out.push(("crlf_split", vec![crlf]));
    // The reply ends with the split marker: the match is only complete at end
    // of stream, so it is decided in `finish`.
    out.push((
        "split_marker_at_stream_end",
        vec![
            sse(&delta(&format!("value {head}"))),
            sse(&delta(tail)),
            DONE.into(),
        ],
    ));
    // ~24KB of whitespace-separated padding over many frames before the marker.
    let mut padded = Vec::new();
    for index in 0..2_000 {
        padded.push(sse(&delta(&format!("pad{index:05} "))));
    }
    padded.push(sse(&delta(&format!("{head}"))));
    padded.push(sse(&delta(&format!("{tail} end"))));
    padded.push(DONE.into());
    out.push(("long_padding_then_split", padded));
    // One huge single-string frame with the marker at the very end.
    let mut big = "filler ".repeat(40_000);
    big.push_str(marker);
    out.push(("long_single_string", vec![sse(&delta(&big)), DONE.into()]));

    let nested = json!({ "a": { "b": [ { "c": "x" }, { "c": format!("v {marker}") } ] } });
    out.push((
        "tool_args_nested_stringified_json",
        vec![sse(&tool_frame(&nested.to_string())), DONE.into()],
    ));
    out.push((
        "tool_args_split_across_frames",
        vec![
            sse(&tool_frame(&format!("{{\"q\":\"{head}"))),
            sse(&tool_frame(&format!("{tail}\"}}"))),
            DONE.into(),
        ],
    ));
    out.push((
        "double_stringified_json",
        vec![
            sse(&delta(
                &json!({ "inner": json!({ "v": marker }).to_string() }).to_string(),
            )),
            DONE.into(),
        ],
    ));
    out.push((
        "second_choice",
        vec![
            sse(&json!({ "choices": [
                { "index": 0, "delta": { "content": "first" } },
                { "index": 1, "delta": { "content": format!("value {marker}") } }
            ] })),
            DONE.into(),
        ],
    ));
    out.push((
        "second_choice_split",
        vec![
            sse(&json!({ "choices": [{ "index": 1, "delta": { "content": format!("v {head}") } }] })),
            sse(&json!({ "choices": [{ "index": 0, "delta": { "content": "interleaved " } }] })),
            sse(&json!({ "choices": [{ "index": 1, "delta": { "content": format!("{tail} e") } }] })),
            DONE.into(),
        ],
    ));
    out.push((
        "message_carrier",
        vec![
            sse(&json!({ "choices": [{ "index": 0, "message": { "role": "assistant", "content": format!("value {marker}") } }] })),
            DONE.into(),
        ],
    ));
    out.push((
        "reasoning_content",
        vec![
            sse(&json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": format!("think {marker}") } }] })),
            DONE.into(),
        ],
    ));
    out.push((
        "reasoning_split",
        vec![
            sse(&json!({ "choices": [{ "index": 0, "delta": { "reasoning": format!("t {head}") } }] })),
            sse(&json!({ "choices": [{ "index": 0, "delta": { "reasoning": format!("{tail} e") } }] })),
            DONE.into(),
        ],
    ));
    out.push((
        "legacy_text_choice_split",
        vec![
            sse(&json!({ "choices": [{ "index": 0, "text": format!("v {head}") }] })),
            sse(&json!({ "choices": [{ "index": 0, "text": format!("{tail} e") }] })),
            DONE.into(),
        ],
    ));
    out.push((
        "content_parts_array",
        vec![
            sse(&json!({ "choices": [{ "index": 0, "delta": { "content": [
                { "type": "text", "text": "a" },
                { "type": "text", "text": format!("b {marker}") }
            ] } }] })),
            DONE.into(),
        ],
    ));
    out.push((
        "error_frame",
        vec![
            sse(&delta("partial ")),
            sse(&json!({ "error": { "message": format!("upstream said {marker}"), "code": 500 } })),
            DONE.into(),
        ],
    ));
    out.push((
        "envelope_id_field",
        vec![
            sse(&json!({ "id": format!("chunk {marker}"), "choices": [{ "index": 0, "delta": { "content": "x" } }] })),
            DONE.into(),
        ],
    ));
    out.push((
        "envelope_model_field",
        vec![
            sse(&json!({ "model": format!("m {marker}"), "choices": [{ "index": 0, "delta": { "content": "x" } }] })),
            DONE.into(),
        ],
    ));
    out.push((
        "tool_function_name",
        vec![
            sse(
                &json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{
                "index": 0, "id": "call_1", "type": "function",
                "function": { "name": format!("fn {marker}"), "arguments": "{}" }
            }] } }] }),
            ),
            DONE.into(),
        ],
    ));
    out.push((
        "unusual_delta_field",
        vec![
            sse(&json!({ "choices": [{ "index": 0, "delta": { "x_vendor_extra": { "deep": [ { "note": format!("n {marker}") } ] } } }] })),
            DONE.into(),
        ],
    ));
    out.push((
        "logprobs_tokens_split",
        vec![
            sse(&json!({ "choices": [{ "index": 0, "delta": { "content": "a" },
                "logprobs": { "content": [ { "token": format!("{head}"), "logprob": -0.1 } ] } }] })),
            sse(&json!({ "choices": [{ "index": 0, "delta": { "content": "b" },
                "logprobs": { "content": [ { "token": format!("{tail}"), "logprob": -0.1 } ] } }] })),
            DONE.into(),
        ],
    ));
    // Realistic logprobs: each token mirrors the content delta it scores.
    out.push((
        "logprobs_mirror_content",
        vec![
            sse(&json!({ "choices": [{ "index": 0, "delta": { "content": format!("v {head}") },
                "logprobs": { "content": [ { "token": format!("v {head}"), "logprob": -0.1 } ] } }] })),
            sse(&json!({ "choices": [{ "index": 0, "delta": { "content": format!("{tail} e") },
                "logprobs": { "content": [ { "token": format!("{tail} e"), "logprob": -0.1 } ] } }] })),
            DONE.into(),
        ],
    ));
    // Some providers stream structured tool arguments as an object, so a
    // model-generated key reaches the frame as a JSON object key.
    let mut object_args = serde_json::Map::new();
    object_args.insert(format!("k {marker}"), json!(1));
    out.push((
        "object_arguments_key",
        vec![
            sse(
                &json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{
                "index": 0, "id": "call_1", "type": "function",
                "function": { "name": "lookup", "arguments": Value::Object(object_args) }
            }] } }] }),
            ),
            DONE.into(),
        ],
    ));
    out
}

/// Serve and drain one stream on its own task, so a panic while the body is
/// polled is reported as a probe failure instead of aborting the whole probe.
async fn try_stream_text(harness: &Harness, ctx: RequestContext) -> Result<String, String> {
    let state = Arc::clone(&harness.state);
    let task = tokio::spawn(async move {
        let out = run_stream(state, ctx, ping_body())
            .await
            .expect("the stream is served");
        let bytes = axum::body::to_bytes(out.body, usize::MAX)
            .await
            .expect("drain the sse body");
        String::from_utf8_lossy(&bytes).into_owned()
    });
    task.await.map_err(|error| {
        let detail = error
            .try_into_panic()
            .ok()
            .and_then(|panic| {
                panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_owned()))
            })
            .unwrap_or_default();
        format!("stream task panicked: {detail}")
    })
}

async fn stream_text(harness: &Harness, ctx: RequestContext) -> String {
    try_stream_text(harness, ctx).await.expect("stream task")
}

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

async fn firewall_rows(harness: &Harness, request_id: &str, want: usize) -> usize {
    audit_rows(harness, request_id, want)
        .await
        .iter()
        .filter(|row| row.provider == "firewall")
        .count()
}

/// Decoded text the client would read: every JSON string value of every frame
/// plus every object key, so a marker hidden in a key also counts as leaked.
fn client_strings(raw: &str) -> String {
    fn walk(value: &Value, out: &mut String) {
        match value {
            Value::String(text) => {
                out.push_str(text);
                out.push('\u{1}');
            }
            Value::Array(values) => values.iter().for_each(|v| walk(v, out)),
            Value::Object(map) => {
                for (key, value) in map {
                    out.push_str(key);
                    out.push('\u{1}');
                    walk(value, out);
                }
            }
            _ => {}
        }
    }
    let mut out = String::new();
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        match serde_json::from_str::<Value>(data) {
            Ok(value) => walk(&value, &mut out),
            Err(_) => out.push_str(data),
        }
    }
    out
}

/// Whether any piece of `marker` reached the client (both halves checked, so a
/// partial release before the block also counts).
fn leaked(raw: &str, marker: &str) -> bool {
    let (head, tail) = halves(marker);
    let decoded = client_strings(raw);
    decoded.contains(head.trim()) || decoded.contains(tail.trim()) || raw.contains(marker)
}

/// Whether the whole marker reached the client, possibly split across frames.
fn delivered(raw: &str, marker: &str) -> bool {
    let (head, tail) = halves(marker);
    let decoded = client_strings(raw);
    decoded.contains(head.trim()) && decoded.contains(tail.trim())
}

/// Run one shape three ways (tenant rule + marker, no rule + marker, tenant
/// rule + benign) and return failures instead of panicking, so one run reports
/// every gap.
async fn probe_shape(
    label: &str,
    node: &FirewallConfig,
    rule: &dyn Fn(&str) -> RequestContext,
    no_rule: &dyn Fn(&str) -> RequestContext,
    marker: &str,
    benign: &str,
    shape: &str,
    chunks: Vec<String>,
    benign_chunks: Vec<String>,
) -> Vec<String> {
    let mut failures = Vec::new();
    let id = format!("{label}-{shape}");

    let leak = harness(node.clone(), chunks.clone());
    let text = match try_stream_text(&leak, rule(&id)).await {
        Ok(text) => text,
        Err(panic) => {
            failures.push(format!("[{id}] {panic}"));
            String::new()
        }
    };
    if !text.contains(BLOCK_NOTICE) {
        failures.push(format!(
            "[{id}] no block-by-policy notice: {}",
            truncate(&text)
        ));
    }
    if leaked(&text, marker) {
        failures.push(format!(
            "[{id}] marker reached the client: {}",
            truncate(&text)
        ));
    }
    if leak.calls(0) != 1 {
        failures.push(format!("[{id}] upstream calls = {}", leak.calls(0)));
    }
    let rows = firewall_rows(&leak, &id, 2).await;
    if rows != 1 {
        failures.push(format!("[{id}] firewall audit rows = {rows}"));
    }

    let negative = harness(node.clone(), chunks);
    let neg_id = format!("{id}-negative");
    let text = stream_text(&negative, no_rule(&neg_id)).await;
    if !delivered(&text, marker) {
        failures.push(format!(
            "[{neg_id}] control: the shape did not deliver the marker without the rule: {}",
            truncate(&text)
        ));
    }

    let clean = harness(node.clone(), benign_chunks);
    let clean_id = format!("{id}-benign");
    let text = stream_text(&clean, rule(&clean_id)).await;
    if text.contains("[Ryu firewall]") {
        failures.push(format!(
            "[{clean_id}] benign output got a notice: {}",
            truncate(&text)
        ));
    }
    if !delivered(&text, benign) {
        failures.push(format!(
            "[{clean_id}] benign text missing: {}",
            truncate(&text)
        ));
    }
    let rows = firewall_rows(&clean, &clean_id, 1).await;
    if rows != 0 {
        failures.push(format!("[{clean_id}] firewall audit rows = {rows}"));
    }
    failures
}

fn truncate(text: &str) -> String {
    if text.len() <= 600 {
        return text.to_owned();
    }
    let mut end = 600;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &text[..end])
}

async fn probe_all_shapes(
    label: &str,
    node: FirewallConfig,
    rule: &dyn Fn(&str) -> RequestContext,
    no_rule: &dyn Fn(&str) -> RequestContext,
    marker: &str,
    benign: &str,
) -> Vec<String> {
    let benign_shapes = shapes(benign);
    let mut failures = Vec::new();
    for ((shape, chunks), (_, benign_chunks)) in shapes(marker).into_iter().zip(benign_shapes) {
        failures.extend(
            probe_shape(
                label,
                &node,
                rule,
                no_rule,
                marker,
                benign,
                shape,
                chunks,
                benign_chunks,
            )
            .await,
        );
    }
    failures
}

/// Incremental path: the tenant turns outbound Block on over a node base that
/// leaves output alone; the marker is the test card.
#[tokio::test]
async fn probe_incremental_tenant_block_every_shape() {
    let failures = probe_all_shapes(
        "inc",
        node_base_outbound_off(),
        &|id| org_ctx(id, Some(block_overlay())),
        &|id| org_ctx(id, None),
        TEST_CARD,
        "plain sunny weather",
    )
    .await;
    assert!(failures.is_empty(), "gaps:\n{}", failures.join("\n"));
}

/// Buffered path: a tenant custom pattern over a node that blocks only built-ins.
#[tokio::test]
async fn probe_buffered_tenant_lexicon_every_shape() {
    let failures = probe_all_shapes(
        "buf",
        node_base_block(),
        &|id| org_ctx(id, Some(lexicon_overlay())),
        &|id| org_ctx(id, None),
        LEXICON,
        "PLAIN_SUNNY_WEATHER",
    )
    .await;
    assert!(failures.is_empty(), "gaps:\n{}", failures.join("\n"));
}

fn single_frame(marker: &str) -> Vec<String> {
    vec![sse(&delta(&format!("value {marker} end"))), DONE.into()]
}

async fn assert_blocked(harness: &Harness, ctx: RequestContext, marker: &str) {
    let id = ctx.request_id.clone();
    let text = stream_text(harness, ctx).await;
    assert!(text.contains(BLOCK_NOTICE), "[{id}] block notice: {text}");
    assert!(!leaked(&text, marker), "[{id}] marker leaked: {text}");
    assert_eq!(
        firewall_rows(harness, &id, 2).await,
        1,
        "[{id}] one firewall row"
    );
}

async fn assert_passes(harness: &Harness, ctx: RequestContext, marker: &str) {
    let id = ctx.request_id.clone();
    let text = stream_text(harness, ctx).await;
    assert!(!text.contains("[Ryu firewall]"), "[{id}] no notice: {text}");
    assert!(delivered(&text, marker), "[{id}] marker delivered: {text}");
    assert_eq!(
        firewall_rows(harness, &id, 1).await,
        0,
        "[{id}] no firewall row"
    );
}

/// An agent overlay (not the org one) decides the stream, on both paths.
#[tokio::test]
async fn probe_agent_overlay_governs_the_stream() {
    let agent_policy = |overlay: FirewallOverlay| EffectivePolicy {
        agent_overlays: [("agent-x".to_owned(), overlay)].into_iter().collect(),
        ..EffectivePolicy::default()
    };
    for (node, overlay, marker) in [
        (node_base_outbound_off(), block_overlay(), TEST_CARD),
        (node_base_block(), lexicon_overlay(), LEXICON),
    ] {
        let h = harness(node.clone(), single_frame(marker));
        let mut ctx = ctx_with(
            &format!("agent-x-{marker}"),
            Some(agent_policy(overlay.clone())),
        );
        ctx.agent_id = Some("agent-x".into());
        assert_blocked(&h, ctx, marker).await;
        assert_eq!(h.calls(0), 1);

        let other = harness(node.clone(), single_frame(marker));
        let mut ctx = ctx_with(&format!("agent-y-{marker}"), Some(agent_policy(overlay)));
        ctx.agent_id = Some("agent-y".into());
        assert_passes(&other, ctx, marker).await;
    }
}

/// The node's team overlay decides the stream, on both paths.
#[tokio::test]
async fn probe_team_overlay_governs_the_stream() {
    for (node, overlay, marker) in [
        (node_base_outbound_off(), block_overlay(), TEST_CARD),
        (node_base_block(), lexicon_overlay(), LEXICON),
    ] {
        let h = harness(node.clone(), single_frame(marker));
        let policy = EffectivePolicy {
            team_firewall: Some(overlay),
            ..EffectivePolicy::default()
        };
        assert_blocked(
            &h,
            ctx_with(&format!("team-{marker}"), Some(policy)),
            marker,
        )
        .await;

        let benign = harness(node, single_frame("calm"));
        let policy = EffectivePolicy {
            team_firewall: Some(if marker == LEXICON {
                lexicon_overlay()
            } else {
                block_overlay()
            }),
            ..EffectivePolicy::default()
        };
        assert_passes(
            &benign,
            ctx_with(&format!("team-benign-{marker}"), Some(policy)),
            "calm",
        )
        .await;
    }
}

/// The forwarded node-routing request overlay adds a custom pattern that the
/// stream honours; with the node lever off it is dropped whole.
#[tokio::test]
async fn probe_request_overlay_governs_the_stream() {
    let prefs = NodeRoutingPrefs {
        firewall: Some(lexicon_overlay()),
        ..NodeRoutingPrefs::default()
    };
    let h = harness_with(
        node_base_block(),
        vec![("primary", Some(single_frame(LEXICON)))],
        |config| config.node_routing.allow_request_override = true,
    );
    let mut ctx = org_ctx("req-overlay", None);
    ctx.node_routing = Some(prefs.clone());
    assert_blocked(&h, ctx, LEXICON).await;

    let locked = harness_with(
        node_base_block(),
        vec![("primary", Some(single_frame(LEXICON)))],
        |config| config.node_routing.allow_request_override = false,
    );
    let mut ctx = org_ctx("req-overlay-locked", None);
    ctx.node_routing = Some(prefs);
    assert_passes(&locked, ctx, LEXICON).await;
}

/// With no per-request resolution, the gateway's global policy snapshot still
/// reaches the stream.
#[tokio::test]
async fn probe_global_policy_snapshot_governs_the_stream() {
    for (node, overlay, marker) in [
        (node_base_outbound_off(), block_overlay(), TEST_CARD),
        (node_base_block(), lexicon_overlay(), LEXICON),
    ] {
        let h = harness(node.clone(), single_frame(marker));
        h.state.set_policy(EffectivePolicy {
            firewall: Some(overlay),
            ..EffectivePolicy::default()
        });
        assert_blocked(&h, ctx_with(&format!("global-{marker}"), None), marker).await;

        let control = harness(node, single_frame(marker));
        assert_passes(
            &control,
            ctx_with(&format!("global-none-{marker}"), None),
            marker,
        )
        .await;
    }
}

/// The primary fails to open; the fallback provider's stream is scanned with the
/// same tenant scanner and the block writes exactly one firewall row.
#[tokio::test]
async fn probe_fallback_stream_is_scanned_with_the_tenant_scanner() {
    for (node, overlay, marker) in [
        (node_base_outbound_off(), block_overlay(), TEST_CARD),
        (node_base_block(), lexicon_overlay(), LEXICON),
    ] {
        let h = harness_with(
            node.clone(),
            vec![("primary", None), ("secondary", Some(single_frame(marker)))],
            |_| {},
        );
        assert_blocked(
            &h,
            org_ctx(&format!("fallback-{marker}"), Some(overlay.clone())),
            marker,
        )
        .await;
        assert_eq!(h.calls(0), 1, "primary tried once");
        assert_eq!(h.calls(1), 1, "secondary served once, no replay");

        let benign = harness_with(
            node,
            vec![("primary", None), ("secondary", Some(single_frame("calm")))],
            |_| {},
        );
        assert_passes(
            &benign,
            org_ctx(&format!("fallback-benign-{marker}"), Some(overlay)),
            "calm",
        )
        .await;
    }
}

/// One state, sequential requests from tenants with and without the rule: the
/// resolver cache and the incremental-vs-buffered choice are per request.
#[tokio::test]
async fn probe_shared_state_sequential_tenants() {
    let h = harness(node_base_block(), single_frame(LEXICON));
    assert_blocked(&h, org_ctx("seq-1", Some(lexicon_overlay())), LEXICON).await;
    assert_passes(&h, org_ctx("seq-2", None), LEXICON).await;
    assert_blocked(&h, org_ctx("seq-3", Some(lexicon_overlay())), LEXICON).await;
    // A different org id with the rule in its own resolution is also blocked.
    let mut ctx = org_ctx("seq-4", Some(lexicon_overlay()));
    ctx.org_id = Some("org-other".into());
    let id = ctx.request_id.clone();
    let text = stream_text(&h, ctx).await;
    assert!(text.contains(BLOCK_NOTICE), "[{id}] {text}");
    assert_eq!(h.calls(0), 4);
}

/// Tenant Sanitize over a warn-only node redacts the card in non-content
/// carriers too (tool arguments split across frames, a second choice).
#[tokio::test]
async fn probe_tenant_sanitize_redacts_non_content_carriers() {
    let base = FirewallConfig {
        scan_outbound: true,
        ..node_base_outbound_off()
    };
    let overlay = FirewallOverlay {
        policy: Some(FirewallPolicy::Sanitize),
        ..FirewallOverlay::default()
    };
    let mut failures = Vec::new();
    for (shape, chunks) in shapes(TEST_CARD) {
        let id = format!("sanitize-{shape}");
        let h = harness(base.clone(), chunks.clone());
        let text = match try_stream_text(&h, org_ctx(&id, Some(overlay.clone()))).await {
            Ok(text) => text,
            Err(panic) => {
                failures.push(format!("[{id}] {panic}"));
                continue;
            }
        };
        if leaked(&text, TEST_CARD) {
            failures.push(format!(
                "[{id}] card reached the client: {}",
                truncate(&text)
            ));
        }
        if text.contains(BLOCK_NOTICE) {
            failures.push(format!("[{id}] Sanitize blocked: {}", truncate(&text)));
        }
        let control = harness(base.clone(), chunks);
        let text = stream_text(&control, org_ctx(&format!("{id}-node-warn"), None)).await;
        if !delivered(&text, TEST_CARD) {
            failures.push(format!(
                "[{id}-node-warn] control did not deliver: {}",
                truncate(&text)
            ));
        }
    }
    assert!(failures.is_empty(), "gaps:\n{}", failures.join("\n"));
}

/// Answers a non-stream completion with a fixed JSON body.
struct JsonReply {
    response: Value,
}

impl Provider for JsonReply {
    fn name(&self) -> &'static str {
        "primary"
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        let response = self.response.clone();
        Box::pin(async move { Ok(response) })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        Box::pin(async { Err(ryu_gw_providers::ProviderError::Provider("n/a".into())) })
    }
}

/// Comparison baseline for the stream-only question: the same model-controlled
/// object key on the non-stream path under the same tenant custom pattern.
#[tokio::test]
async fn probe_nonstream_object_key_baseline() {
    let mut args = serde_json::Map::new();
    args.insert(format!("k {LEXICON}"), json!(1));
    let response = json!({ "id": "r", "object": "chat.completion", "choices": [{
        "index": 0, "finish_reason": "tool_calls",
        "message": { "role": "assistant", "content": null, "tool_calls": [{
            "id": "call_1", "type": "function",
            "function": { "name": "lookup", "arguments": Value::Object(args) }
        }] }
    }] });
    let dir = std::env::temp_dir().join(format!("ryu-stream-dlp-probe-ns-{}", std::process::id()));
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: dir.join("audit.db").to_str().unwrap().to_string(),
    })
    .expect("audit logger");
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: node_base_block(),
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
        },
        ..GatewayConfig::default()
    };
    let evals = EvalsRunner::new(config.evals.clone());
    let mut state = AppState::new_for_test(config, audit, evals);
    state
        .provider_runtime
        .register_for_test(Arc::new(JsonReply { response }) as Arc<dyn Provider>);
    let result = super::run(
        Arc::new(state),
        org_ctx("nonstream-key", Some(lexicon_overlay())),
        ping_body(),
    )
    .await;
    match result {
        Err(error) => assert!(
            error.to_string().contains("ryu_test_lexicon"),
            "blocked for the tenant pattern: {error}"
        ),
        Ok(output) => {
            let text = output.response.to_string();
            panic!("non-stream released the object-key marker: {text}");
        }
    }
}

/// Non-stream tenant Sanitize: the message content is sanitized and the
/// `logprobs` tokens that mirror it are dropped, so no piece of the card
/// survives in them. The benign control keeps its logprobs.
#[tokio::test]
async fn probe_nonstream_sanitize_drops_mirrored_logprobs() {
    let (head, tail) = halves(TEST_CARD);
    let reply = |text: &str, tokens: [&str; 2]| {
        json!({ "id": "r", "object": "chat.completion", "choices": [{
            "index": 0, "finish_reason": "stop",
            "message": { "role": "assistant", "content": text },
            "logprobs": { "content": [
                { "token": tokens[0], "logprob": -0.1 },
                { "token": tokens[1], "logprob": -0.1 }
            ] }
        }] })
    };
    let overlay = FirewallOverlay {
        policy: Some(FirewallPolicy::Sanitize),
        ..FirewallOverlay::default()
    };
    let base = FirewallConfig {
        scan_outbound: true,
        ..node_base_outbound_off()
    };
    let cases = [
        (
            "nonstream-sanitize-card",
            reply(
                &format!("v {TEST_CARD} e"),
                [&format!("v {head}"), &format!("{tail} e")],
            ),
            true,
        ),
        (
            "nonstream-sanitize-benign",
            reply("plain sunny weather", ["plain sunny", " weather"]),
            false,
        ),
    ];
    for (id, response, has_card) in cases {
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: std::env::temp_dir()
                .join(format!("ryu-stream-dlp-probe-{id}-{}", std::process::id()))
                .join("audit.db")
                .to_str()
                .unwrap()
                .to_string(),
        })
        .expect("audit logger");
        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("primary"),
                fallback_chain: vec![ProviderId::from("primary")],
                ..RoutingConfig::default()
            },
            firewall: base.clone(),
            cache: crate::config::CacheConfig {
                enabled: false,
                ..crate::config::CacheConfig::default()
            },
            ..GatewayConfig::default()
        };
        let evals = EvalsRunner::new(config.evals.clone());
        let mut state = AppState::new_for_test(config, audit, evals);
        state
            .provider_runtime
            .register_for_test(Arc::new(JsonReply { response }) as Arc<dyn Provider>);
        let output = super::run(
            Arc::new(state),
            org_ctx(id, Some(overlay.clone())),
            ping_body(),
        )
        .await
        .expect("Sanitize serves the response");
        let text = output.response.to_string();
        let logprobs = &output.response["choices"][0]["logprobs"];
        if has_card {
            assert!(
                !leaked(&format!("data: {text}"), TEST_CARD),
                "[{id}] leaked: {text}"
            );
            assert!(logprobs.is_null(), "[{id}] logprobs kept: {text}");
        } else {
            assert!(
                text.contains("plain sunny weather"),
                "[{id}] content: {text}"
            );
            assert!(
                !logprobs.is_null(),
                "[{id}] benign logprobs dropped: {text}"
            );
        }
    }
}

/// The same realistic logprobs mirror on the buffered path: tenant Sanitize plus
/// an unrelated tenant custom pattern, which forces buffering.
#[tokio::test]
async fn probe_buffered_sanitize_logprobs_mirror() {
    let base = FirewallConfig {
        scan_outbound: true,
        ..node_base_outbound_off()
    };
    let overlay = FirewallOverlay {
        policy: Some(FirewallPolicy::Sanitize),
        ..lexicon_overlay()
    };
    let (_, chunks) = shapes(TEST_CARD)
        .into_iter()
        .find(|(name, _)| *name == "logprobs_mirror_content")
        .expect("mirror shape");
    let h = harness(base, chunks);
    let text = stream_text(&h, org_ctx("buffered-sanitize-mirror", Some(overlay))).await;
    assert!(
        !leaked(&text, TEST_CARD),
        "buffered Sanitize leaked: {text}"
    );
}
