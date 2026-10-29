//! Coverage probes for the `POST /v1/providers/call` guard
//! (`pipeline::provider_call_guard`).
//!
//! Each probe places a harmless marker in one input shape and drives the real
//! router against a capturing stand-in for Treg and Composio that records
//! every request it receives: method, raw and percent-decoded URI, headers and
//! body. A blocked probe must answer 403 `policy_violation`, leave the stand-in
//! with zero requests (catalog price lookups included) and write one audit
//! row. Every blocked shape is paired with a benign control that dispatches.
//!
//! Markers: the AWS documentation example key, the published test card number
//! and a test-only `RYU_TEST_LEXICON` custom pattern. Nothing here is real
//! attack text.
//!
//! The suite authenticates with a statically configured trusted-forwarder key,
//! so it never touches the process-wide Core proof key the sibling tests
//! serialize on.

use std::sync::{Arc, Mutex};

use axum::{
    body::Bytes,
    extract::State as MockState,
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::IntoResponse,
    Json, Router,
};
use serde_json::{json, Value};

use crate::{
    audit::{AuditLogger, AuditRecord, EventType},
    composio::{ComposioClient, ComposioTenantScope},
    config::{
        ApiKeyConfig, ApiKeyOperation, AuditConfig, CustomPattern, CustomPatternKind,
        FirewallPolicy, GatewayConfig,
    },
    evals::EvalsRunner,
    policy::ResolveCache,
    state::{AppState, SharedState},
};

/// The canonical AWS documentation access-key id.
const SECRET: &str = "AKIAIOSFODNN7EXAMPLE";
/// A test-only custom pattern, registered as a prompt-injection kind so a
/// secrets-only zone would not catch it.
const LEXICON: &str = "RYU_TEST_LEXICON";
/// The published Visa test card number.
const TEST_CARD: &str = "4111 1111 1111 1111";

/// The trusted-forwarder credential and the org it belongs to.
const CORE_KEY: &str = "sk-probe-core";
const ORG: &str = "org-probe";

/// One request the provider stand-in received.
#[derive(Debug, Clone)]
struct Captured {
    method: String,
    uri: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Captured {
    fn is_catalog(&self) -> bool {
        self.uri.starts_with("/catalog/")
    }

    /// Whether `marker` reached the provider in any form it reads: the method,
    /// the URI as sent or as the provider decodes it, a header or the body.
    fn carries(&self, marker: &str) -> bool {
        self.method.contains(marker)
            || self.uri.contains(marker)
            || percent_decode(&self.uri).contains(marker)
            || self
                .headers
                .iter()
                .any(|(name, value)| name.contains(marker) || value.contains(marker))
            || self.body.contains(marker)
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escape = bytes.get(index + 1..index + 3).and_then(|digits| {
            std::str::from_utf8(digits)
                .ok()
                .and_then(|digits| u8::from_str_radix(digits, 16).ok())
        });
        match (bytes[index], escape) {
            (b'%', Some(byte)) => {
                out.push(byte);
                index += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                index += 1;
            }
            (byte, _) => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The auth configuration the Composio stand-in records for every account.
const PROBE_AUTH_CONFIG: &str = "ac_probe";

type Log = Arc<Mutex<Vec<Captured>>>;

/// The Treg and Composio stand-in: records every request, then answers with
/// the smallest body each client accepts. Every Treg catalog id is priced, so
/// the price lookup is upstream I/O a blocked probe must not reach either.
async fn capture(
    MockState(log): MockState<Log>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    let path = uri.path().to_owned();
    log.lock().unwrap().push(Captured {
        method: method.to_string(),
        uri: uri.to_string(),
        headers: headers
            .iter()
            .map(|(name, value)| {
                (
                    name.to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect(),
        body: String::from_utf8_lossy(&body).into_owned(),
    });
    let last_segment = || percent_decode(path.rsplit('/').next().unwrap_or_default());
    if path.starts_with("/catalog/endpoints/") {
        return Json(json!({ "endpoint": {
            "id": last_segment(),
            "method": "POST",
            "cost": { "usd": 0.002, "unit": "call", "currency": "USD" }
        } }))
        .into_response();
    }
    if path.starts_with("/api/v3.1/connected_accounts/") {
        let owner = ComposioTenantScope::new(ORG).unwrap().default_user_id();
        return Json(json!({
            "id": last_segment(),
            "user_id": owner,
            "auth_config_id": PROBE_AUTH_CONFIG,
        }))
        .into_response();
    }
    if path.starts_with("/api/v3.1/auth_configs/") {
        return Json(json!({ "id": last_segment(), "is_composio_managed": false })).into_response();
    }
    if path.starts_with("/api/v3.1/tools/execute/") {
        return Json(json!({ "data": { "executed": true }, "log_id": "log_probe_1" }))
            .into_response();
    }
    if path.starts_with("/api/v3.1/logs/tool_execution/") {
        // The billing log records the caller entity (and, for a pinned
        // account, that account and its auth configuration) the execution
        // named; the Gateway verifies it before it prices the receipt.
        let execution = log
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|seen| seen.uri.starts_with("/api/v3.1/tools/execute/"))
            .and_then(|seen| serde_json::from_str::<Value>(&seen.body).ok())
            .unwrap_or(Value::Null);
        let account = execution.get("connected_account_id").cloned();
        return Json(json!({
            "id": last_segment(),
            "metadata": {
                "user_id": execution["user_id"],
                "auth_config_id": account.as_ref().map(|_| PROBE_AUTH_CONFIG),
                "connected_account_id": account,
            },
        }))
        .into_response();
    }
    let mut response = Json(json!({ "data": { "id": "post-1" } })).into_response();
    response
        .headers_mut()
        .insert("x-treg-call-id", HeaderValue::from_static("treg-probe-1"));
    response
        .headers_mut()
        .insert("x-treg-cost-micro", HeaderValue::from_static("2000"));
    response
}

async fn debit(Json(_body): Json<Value>) -> Json<Value> {
    Json(json!({ "balanceMicroUsd": 900_000, "wentNonPositive": false }))
}

async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{address}"), task)
}

/// An audit backend that keeps every row in memory.
#[derive(Default)]
struct RecordingAudit {
    rows: Mutex<Vec<AuditRecord>>,
}

impl RecordingAudit {
    fn exec_rows(&self) -> Vec<AuditRecord> {
        self.rows
            .lock()
            .unwrap()
            .iter()
            .filter(|row| row.event_type == EventType::ExecCall)
            .cloned()
            .collect()
    }
}

impl crate::audit::AuditBackend for RecordingAudit {
    fn log(&self, record: AuditRecord) {
        self.rows.lock().unwrap().push(record);
    }
    fn is_enabled(&self) -> bool {
        true
    }
    fn token_usage(&self, _api_key: &str) -> u64 {
        0
    }
    fn add_tokens(&self, _api_key: &str, _n: u64) {}
    fn query(
        &self,
        _query: &crate::audit::AuditQuery,
    ) -> anyhow::Result<Vec<crate::audit::AuditEntry>> {
        Ok(Vec::new())
    }
    fn summary(&self) -> anyhow::Result<crate::audit::AuditSummary> {
        Ok(crate::audit::AuditSummary::default())
    }
    fn usage_rollup(
        &self,
        _query: &crate::audit::AuditUsageQuery,
    ) -> anyhow::Result<Vec<crate::audit::AuditUsageEvent>> {
        Ok(Vec::new())
    }
}

struct Probe {
    state: SharedState,
    upstream: Log,
    audit: Arc<RecordingAudit>,
    servers: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Probe {
    fn drop(&mut self) {
        for server in &self.servers {
            server.abort();
        }
    }
}

fn core_key() -> ApiKeyConfig {
    ApiKeyConfig {
        key: CORE_KEY.to_owned(),
        name: "core".to_owned(),
        org_id: Some(ORG.to_owned()),
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder: true,
        allowed_operations: vec![ApiKeyOperation::Inference],
    }
}

async fn probe_with(configure: impl FnOnce(&mut GatewayConfig)) -> Probe {
    let upstream: Log = Arc::default();
    let (provider_url, provider_server) = serve(
        Router::new()
            .fallback(capture)
            .with_state(Arc::clone(&upstream)),
    )
    .await;
    let (control_url, control_server) =
        serve(Router::new().route("/api/credits/debit", axum::routing::post(debit))).await;

    let mut config = GatewayConfig::default();
    config.auth.require_auth = true;
    config.auth.api_keys = vec![core_key()];
    config.rate_limit.max_burst_per_second = 100_000;
    config.treg.enabled = true;
    config.treg.base_url = provider_url.clone();
    config.treg.token = Some("treg-fleet-token".to_owned());
    config.composio.enabled = true;
    config.composio.api_key = Some("composio-project-test-key".to_owned());
    config.credits.enabled = true;
    config.credits.base_url = control_url.clone();
    config.credits.internal_secret = Some("internal-test-secret".to_owned());
    config.firewall.custom_patterns = vec![CustomPattern {
        name: "ryu_test_lexicon".to_owned(),
        regex: LEXICON.to_owned(),
        kind: CustomPatternKind::PromptInjection,
    }];
    configure(&mut config);
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    state.treg = crate::treg::TregClient::from_config(&state.config.treg, reqwest::Client::new());
    state.composio = Some(ComposioClient::for_test(
        state.config.composio.clone(),
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        format!("{provider_url}/api/v3.1"),
    ));
    state.resolve_cache = Some(ResolveCache::for_test(control_url, reqwest::Client::new()));
    let recording = Arc::new(RecordingAudit::default());
    state.audit.register(
        crate::audit::AuditRegistry::BUILTIN,
        Arc::clone(&recording) as Arc<dyn crate::audit::AuditBackend>,
    );
    Probe {
        state: Arc::new(state),
        upstream,
        audit: recording,
        servers: vec![provider_server, control_server],
    }
}

async fn probe() -> Probe {
    probe_with(|_| {}).await
}

/// A Treg call as Core's relay sends it.
fn treg(query: Value, body: Value) -> Value {
    json!({
        "provider": "treg",
        "toolId": "x.post.create",
        "operation": "execute",
        "method": "POST",
        "query": query,
        "body": body,
        "requestId": "req-probe-1",
        "callerId": "@ryu/probe",
    })
}

impl Probe {
    async fn post_with(&self, request: &Value, extra: &[(&str, &str)]) -> (StatusCode, Value) {
        use tower::ServiceExt;
        let mut builder = axum::http::Request::builder()
            .method(Method::POST)
            .uri("/v1/providers/call")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {CORE_KEY}"));
        for (name, value) in extra {
            builder = builder.header(*name, *value);
        }
        let response = crate::api::router(Arc::clone(&self.state))
            .oneshot(
                builder
                    .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                        [127, 0, 0, 1],
                        40_001,
                    ))))
                    .body(axum::body::Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn post(&self, request: &Value) -> (StatusCode, Value) {
        self.post_with(request, &[]).await
    }

    fn take_upstream(&self) -> Vec<Captured> {
        std::mem::take(&mut *self.upstream.lock().unwrap())
    }

    /// Assert `request` is refused as a policy violation before any provider
    /// I/O, with one audit row that does not echo `marker`.
    async fn assert_blocked(&self, what: &str, request: Value, marker: &str) {
        self.take_upstream();
        let rows_before = self.audit.exec_rows().len();
        let (status, response) = self.post(&request).await;
        let upstream = self.take_upstream();
        let leaked: Vec<&Captured> = upstream
            .iter()
            .filter(|seen| seen.carries(marker))
            .collect();
        assert!(
            leaked.is_empty(),
            "GAP {what}: the marker reached the provider ({status}): {leaked:#?}"
        );
        assert_eq!(status, StatusCode::FORBIDDEN, "{what}: {response}");
        assert_eq!(response["error"]["type"], "policy_violation", "{what}");
        assert!(
            upstream.is_empty(),
            "{what}: a blocked call made provider I/O: {upstream:#?}"
        );
        let rows = self.audit.exec_rows();
        assert_eq!(
            rows.len(),
            rows_before + 1,
            "{what}: one audit row: {rows:#?}"
        );
        let row = rows.last().unwrap();
        assert_eq!(row.exit_code, Some(-1), "{what}");
        assert_eq!(row.org_id.as_deref(), Some(ORG), "{what}");
        let reason = row.error.as_deref().unwrap_or_default();
        assert!(!reason.is_empty(), "{what}: the refusal is named");
        assert!(
            !reason.contains(marker),
            "{what}: the audit row echoes the payload: {reason}"
        );
    }

    /// Assert `request` dispatches and the provider served it.
    async fn assert_dispatches(&self, what: &str, request: Value) -> Vec<Captured> {
        self.take_upstream();
        let (status, response) = self.post(&request).await;
        assert_eq!(status, StatusCode::OK, "{what}: {response}");
        let upstream = self.take_upstream();
        assert!(
            upstream.iter().any(|seen| !seen.is_catalog()),
            "{what}: the benign call reaches the provider: {upstream:#?}"
        );
        upstream
    }
}

/// `depth` levels of `{ "level": ... }` around `leaf`.
fn nest(depth: usize, leaf: Value) -> Value {
    (0..depth).fold(leaf, |inner, _| json!({ "level": inner }))
}

/// `leaf` stringified `levels` times, each level wrapped in an object.
fn stringify(levels: usize, leaf: &str) -> String {
    let mut text = json!({ "value": leaf }).to_string();
    for _ in 1..levels {
        text = json!({ "value": text }).to_string();
    }
    text
}

// ── Controls: shapes the guard is expected to cover ──────────────────────────

#[tokio::test]
async fn every_marker_fires_on_a_plain_body_leaf() {
    let probe = probe().await;
    for marker in [SECRET, LEXICON] {
        probe
            .assert_blocked(
                "a plain text leaf",
                treg(json!([]), json!({ "text": marker })),
                marker,
            )
            .await;
    }
    probe
        .assert_blocked(
            "a test card",
            treg(
                json!([]),
                json!({ "text": format!("card {TEST_CARD} exp 12/30") }),
            ),
            TEST_CARD,
        )
        .await;
    probe
        .assert_dispatches("benign text", treg(json!([]), json!({ "text": "hello" })))
        .await;
}

#[tokio::test]
async fn deep_nesting_and_arrays_of_objects_are_screened() {
    let probe = probe().await;
    probe
        .assert_blocked(
            "a leaf 100 objects deep",
            treg(json!([]), nest(100, json!(SECRET))),
            SECRET,
        )
        .await;
    probe
        .assert_blocked(
            "arrays of objects",
            treg(
                json!([]),
                json!({ "items": [{ "a": 1 }, { "b": [{ "c": [null, true, { "d": LEXICON }] }] }] }),
            ),
            LEXICON,
        )
        .await;
    probe
        .assert_blocked(
            "an array of arrays",
            treg(json!([]), json!([[["x"], [[SECRET]]]])),
            SECRET,
        )
        .await;
    probe
        .assert_dispatches(
            "benign deep nesting",
            treg(json!([]), nest(100, json!("hello"))),
        )
        .await;
}

#[tokio::test]
async fn stringified_json_and_escaped_spellings_are_screened() {
    let probe = probe().await;
    // `R` is `R`, so no raw string spells the marker.
    let escaped_lexicon = format!("\\u0052{}", &LEXICON[1..]);
    for levels in 1..=3 {
        probe
            .assert_blocked(
                &format!("stringified JSON, {levels} levels, unicode-escaped"),
                treg(
                    json!([]),
                    json!({ "args": stringify(levels, &escaped_lexicon) }),
                ),
                LEXICON,
            )
            .await;
    }
    probe
        .assert_blocked(
            "a literal escape outside JSON",
            treg(
                json!([]),
                json!({ "note": format!("see \\u0041{}", &SECRET[1..]) }),
            ),
            SECRET,
        )
        .await;
    probe
        .assert_blocked(
            "a zero-width split",
            treg(
                json!([]),
                json!({ "note": format!("{}\u{200b}{}", &SECRET[..4], &SECRET[4..]) }),
            ),
            &SECRET[4..],
        )
        .await;
    probe
        .assert_dispatches(
            "benign stringified JSON",
            treg(json!([]), json!({ "args": stringify(3, "hello") })),
        )
        .await;
}

#[tokio::test]
async fn chat_root_key_names_inside_the_body_are_fully_screened() {
    let probe = probe().await;
    // Under the chat root-key rules a whitespace-free control token or a
    // definition key reads secrets-only, which the lexicon would pass.
    for key in [
        "model",
        "provider",
        "user",
        "metadata",
        "tools",
        "functions",
        "tool_choice",
        "stream",
        "prompt_cache_key",
        "response_format",
        "safety_identifier",
        "messages",
        "input",
        "prompt",
    ] {
        let mut body = serde_json::Map::new();
        body.insert(key.to_owned(), json!(LEXICON));
        probe
            .assert_blocked(
                &format!("a body `{key}` key"),
                treg(json!([]), Value::Object(body)),
                LEXICON,
            )
            .await;
    }
    probe
        .assert_dispatches(
            "benign control keys",
            treg(
                json!([]),
                json!({ "model": "x", "user": "member-1", "stream": "no" }),
            ),
        )
        .await;
}

#[tokio::test]
async fn query_keys_values_and_body_shapes_are_screened() {
    let probe = probe().await;
    probe
        .assert_blocked(
            "a query key",
            treg(json!([[SECRET, "1"]]), Value::Null),
            SECRET,
        )
        .await;
    probe
        .assert_blocked(
            "a query value",
            treg(json!([["q", LEXICON]]), Value::Null),
            LEXICON,
        )
        .await;
    probe
        .assert_blocked(
            "a stringified query value",
            treg(
                json!([["filter", stringify(1, &format!("\\u0041{}", &SECRET[1..]))]]),
                Value::Null,
            ),
            SECRET,
        )
        .await;
    let mut get = treg(json!([["q", SECRET]]), Value::Null);
    get["method"] = json!("GET");
    probe.assert_blocked("a GET query", get, SECRET).await;
    probe
        .assert_blocked(
            "a bare string body",
            treg(json!([]), json!(LEXICON)),
            LEXICON,
        )
        .await;
    let mut tool = treg(json!([]), json!({}));
    tool["toolId"] = json!(format!("x.post.{SECRET}"));
    probe.assert_blocked("the action slug", tool, SECRET).await;
    let mut benign_get = treg(json!([["lang", "en"], ["q", "hello world"]]), Value::Null);
    benign_get["method"] = json!("GET");
    probe.assert_dispatches("benign query", benign_get).await;
}

#[tokio::test]
async fn long_benign_padding_never_pushes_the_marker_out_of_the_screen() {
    let probe = probe().await;
    let padding = "lorem ipsum ".repeat(1 << 16);
    probe
        .assert_blocked(
            "one leaf, 768 KiB of padding first",
            treg(json!([]), json!({ "text": format!("{padding}{SECRET}") })),
            SECRET,
        )
        .await;
    let mut leaves: Vec<Value> = (0..20_000)
        .map(|n| json!({ "n": format!("item {n}") }))
        .collect();
    leaves.push(json!({ "n": LEXICON }));
    probe
        .assert_blocked(
            "20000 benign leaves first",
            treg(json!([]), json!({ "items": leaves })),
            LEXICON,
        )
        .await;
    probe
        .assert_dispatches(
            "benign padding",
            treg(json!([]), json!({ "text": padding })),
        )
        .await;
}

#[tokio::test]
async fn sanitize_refuses_instead_of_forwarding_and_retries_are_rescreened() {
    let probe = probe_with(|config| config.firewall.policy = FirewallPolicy::Sanitize).await;
    probe
        .assert_blocked(
            "a secret under Sanitize",
            treg(json!([]), json!({ "text": SECRET })),
            SECRET,
        )
        .await;
    let mut first = treg(json!([]), json!({ "text": "hello" }));
    first["idempotencyKey"] = json!("retry-1");
    probe
        .assert_dispatches("the first attempt", first.clone())
        .await;
    let mut retry = first;
    retry["body"] = json!({ "text": SECRET });
    probe
        .assert_blocked("a retry under the same key", retry, SECRET)
        .await;
}

#[tokio::test]
async fn non_media_url_keys_are_screened() {
    let probe = probe().await;
    for key in ["webhook_url", "callback_url", "link"] {
        let mut body = serde_json::Map::new();
        body.insert(
            key.to_owned(),
            json!(format!("https://example.test/hook?k={SECRET}")),
        );
        probe
            .assert_blocked(
                &format!("a URL under `{key}`"),
                treg(json!([]), Value::Object(body)),
                SECRET,
            )
            .await;
    }
    probe
        .assert_dispatches(
            "a benign URL",
            treg(
                json!([]),
                json!({ "webhook_url": "https://example.test/hook" }),
            ),
        )
        .await;
}

// ── Probes for shapes the guard may miss ─────────────────────────────────────

#[tokio::test]
async fn a_base64_data_uri_prefix_hides_a_literal_marker() {
    let probe = probe().await;
    probe
        .assert_blocked(
            "a plain-text data URI",
            treg(
                json!([]),
                json!({ "text": format!("data:text/plain,{SECRET}") }),
            ),
            SECRET,
        )
        .await;
    for marker in [SECRET, LEXICON] {
        probe
            .assert_blocked(
                "a `;base64` data URI whose payload is the literal marker",
                treg(
                    json!([]),
                    json!({ "text": format!("data:text/plain;base64,{marker}") }),
                ),
                marker,
            )
            .await;
    }
}

#[tokio::test]
async fn a_url_under_a_media_key_hides_a_literal_marker() {
    let probe = probe().await;
    probe
        .assert_blocked(
            "a caption under a media key",
            treg(
                json!([]),
                json!({ "image": { "caption": format!("a {LEXICON} b") } }),
            ),
            LEXICON,
        )
        .await;
    for (what, body) in [
        (
            "`url`",
            json!({ "url": format!("https://example.test/?k={SECRET}") }),
        ),
        (
            "a nested `image.src`",
            json!({ "post": { "image": { "src": format!("https://example.test/{SECRET}") } } }),
        ),
        (
            "`video_url`",
            json!({ "video_url": format!("https://example.test/{LEXICON}") }),
        ),
        (
            "`file`",
            json!({ "file": format!("ftp://example.test/{SECRET}") }),
        ),
    ] {
        let marker = if body.to_string().contains(LEXICON) {
            LEXICON
        } else {
            SECRET
        };
        probe
            .assert_blocked(
                &format!("a URL under {what}"),
                treg(json!([]), body),
                marker,
            )
            .await;
    }
}

#[tokio::test]
async fn a_long_base64_run_under_a_media_key_hides_a_literal_marker() {
    let probe = probe().await;
    let run = format!("{}-{SECRET}", "A".repeat(600));
    probe
        .assert_blocked(
            "a base64-alphabet run under `file`",
            treg(json!([]), json!({ "file": run })),
            SECRET,
        )
        .await;
}

#[tokio::test]
async fn object_keys_are_never_screened() {
    let probe = probe().await;
    let mut inner = serde_json::Map::new();
    inner.insert(SECRET.to_owned(), json!(true));
    probe
        .assert_blocked(
            "a body object key",
            treg(json!([]), json!({ "labels": Value::Object(inner) })),
            SECRET,
        )
        .await;
    let mut root = serde_json::Map::new();
    root.insert(format!("note {LEXICON}"), json!(1));
    probe
        .assert_blocked(
            "a root body key",
            treg(json!([]), Value::Object(root)),
            LEXICON,
        )
        .await;
    let mut keyed = serde_json::Map::new();
    keyed.insert(SECRET.to_owned(), json!(1));
    let embedded = Value::Object(keyed).to_string();
    probe
        .assert_blocked(
            "a key inside stringified JSON",
            treg(json!([]), json!({ "args": format!("{embedded} ") })),
            SECRET,
        )
        .await;
}

#[tokio::test]
async fn a_percent_encoded_action_slug_reaches_the_provider_decoded() {
    let probe = probe().await;
    let encoded = format!("%{:02X}{}", SECRET.as_bytes()[0], &SECRET[1..]);
    let mut path = treg(json!([]), json!({ "text": "hello" }));
    path["toolId"] = json!(format!("x.post.{encoded}"));
    probe
        .assert_blocked("a percent-encoded slug", path, SECRET)
        .await;
    let mut query = treg(json!([]), json!({ "text": "hello" }));
    query["toolId"] = json!(format!("x.post.create?note={encoded}"));
    probe
        .assert_blocked("a query string smuggled in the slug", query, SECRET)
        .await;
}

#[tokio::test]
async fn the_http_method_reaches_the_provider_unscreened() {
    let probe = probe().await;
    let mut request = treg(json!([]), json!({ "text": "hello" }));
    request["method"] = json!(SECRET);
    probe
        .assert_blocked("an extension method token", request, SECRET)
        .await;
}

#[tokio::test]
async fn a_trusted_forwarder_org_id_reaches_the_treg_meta_header() {
    let probe = probe().await;
    let mut own = treg(json!([]), json!({ "text": "hello" }));
    own["orgId"] = json!(ORG);
    probe
        .assert_dispatches("the forwarder's own org", own)
        .await;
    let mut request = treg(json!([]), json!({ "text": "hello" }));
    request["orgId"] = json!(SECRET);
    let (status, response) = probe.post(&request).await;
    let upstream = probe.take_upstream();
    let leaked: Vec<&Captured> = upstream
        .iter()
        .filter(|seen| seen.carries(SECRET))
        .collect();
    assert!(
        leaked.is_empty(),
        "GAP the body orgId reached the provider ({status}, {response}): {leaked:#?}"
    );
}

#[tokio::test]
async fn a_trusted_forwarder_selects_another_org_only_with_a_core_proof() {
    let probe = probe().await;
    let mut own = treg(json!([]), json!({ "text": "hello" }));
    own["orgId"] = json!(ORG);
    probe
        .assert_dispatches("the forwarder's own org", own)
        .await;
    let mut other = treg(json!([]), json!({ "text": "hello" }));
    other["orgId"] = json!("org-other");
    let (status, response) = probe.post(&other).await;
    let upstream = probe.take_upstream();
    assert!(
        !status.is_success() && upstream.iter().all(Captured::is_catalog),
        "GAP a forwarder billed another org with no Core proof for it ({status}, {response}): {upstream:#?}"
    );
}

#[tokio::test]
async fn a_composio_account_id_reaches_composio_unscreened() {
    let probe = probe().await;
    let request = |account: &str| {
        json!({
            "provider": "composio",
            "toolId": "GMAIL_FETCH_EMAILS",
            "operation": "execute",
            "accountId": account,
            "method": "POST",
            "body": { "arguments": { "query": "is:unread" } },
            "requestId": "req-probe-composio",
        })
    };
    probe
        .assert_dispatches("a benign account id", request("ca-benign"))
        .await;
    probe
        .assert_blocked("an account id", request(&format!("ca-{SECRET}")), SECRET)
        .await;
}

/// The benign controls for the strict action-argument walk: keys, URLs, media
/// uploads, base64 runs, every allowed method and a plain slug still dispatch.
#[tokio::test]
async fn benign_keys_urls_media_methods_and_slugs_dispatch() {
    use base64::Engine as _;
    let probe = probe().await;
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend((0..=255u8).cycle().take(2048));
    let image = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    for (what, body) in [
        (
            "a benign nested object key",
            json!({ "labels": { "topic": true } }),
        ),
        (
            "a benign URL under `url`",
            json!({ "url": "https://example.test/a.png?sig=abc123" }),
        ),
        (
            "a benign nested `image.src`",
            json!({ "post": { "image": { "src": "https://example.test/a.png?sig=abc123" } } }),
        ),
        ("a binary image data URI", json!({ "image": image })),
        ("a long base64 run", json!({ "file": "A".repeat(600) })),
    ] {
        probe.assert_dispatches(what, treg(json!([]), body)).await;
    }
    for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "post"] {
        let mut request = treg(json!([]), json!({ "text": "hello" }));
        request["method"] = json!(method);
        let upstream = probe.assert_dispatches(method, request).await;
        let call = upstream.iter().find(|seen| !seen.is_catalog()).unwrap();
        assert_eq!(call.method, method.to_ascii_uppercase(), "{method}");
    }
    probe
        .assert_dispatches("a plain slug", treg(json!([]), json!({ "text": "hello" })))
        .await;
}

#[tokio::test]
async fn a_validation_refusal_still_leaves_an_audit_row() {
    let probe = probe().await;
    let (status, response) = probe
        .post_with(
            &treg(json!([]), json!({ "text": "hello" })),
            &[(super::MAX_COST_HEADER, "not-a-number")],
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
    assert!(probe.take_upstream().is_empty());
    let rows = probe.audit.exec_rows();
    assert_eq!(
        rows.len(),
        1,
        "GAP a refused provider call left no audit row: {rows:#?}"
    );
}
