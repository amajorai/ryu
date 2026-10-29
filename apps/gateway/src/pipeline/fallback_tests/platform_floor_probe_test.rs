//! Coverage probe for the platform floor (spec 02.3) on the fleet.
//!
//! Every probe gateway switches its node firewall off (no patterns, nothing
//! locked) and installs a tenant overlay, org and agent, that switches it off
//! again, so the only layer that can screen a request is the platform floor.
//! The floor carries the test-only `RYU_TEST_LEXICON` pattern and turns on
//! outbound and secret scanning. Its second test-only pattern,
//! `RYU_TEST_SECRET` of kind `secret`, is the outbound marker: outbound
//! scanning reads secret and PII kinds, and the AWS example key is redacted
//! on every custody, so neither the lexicon nor that key can show what the
//! floor adds on the way out.
//!
//! Each Fleet case has a SelfHosted twin built from the same config, floor
//! store and body. The twin must dispatch the marker (or hand it back), which
//! proves a Fleet refusal is the floor's doing and not the harness's. Every
//! probe group collects all of its misses before it fails, so one run reports
//! every one.
use super::*;
use crate::config::FirewallOverlay;
use crate::platform_floor::{FloorStore, PlatformFloor};
use std::sync::atomic::AtomicUsize as Counter;

/// The agent the tenant's loosening agent overlay is keyed by. It is also the
/// agent in the `/v1/agents/...` route below.
const PROBE_AGENT: &str = "agent-floor";
/// A test-only secret-kind pattern, used as the outbound marker.
const SECRET_MARKER: &str = "RYU_TEST_SECRET";
/// Models whose capture answer carries a marker.
const LEAKY_SECRET: &str = "leaky-secret";
const LEAKY_LEXICON: &str = "leaky-lexicon";

// ── floor, node and tenant ───────────────────────────────────────────────────

/// A floor document as the control plane sends it.
fn floor_document(version: u64) -> Value {
    json!({
        "version": version,
        "contentHash": format!("probe-{version}"),
        "issuedAt": "2026-10-23T09:00:00.000Z",
        "overlay": {
            "enabled": true,
            "scan_inbound": true,
            "scan_outbound": true,
            "redact_secrets": true,
            "policy": "block",
            "custom_patterns": [
                { "name": "ryu_test_lexicon", "regex": MARKER, "kind": "prompt_injection" },
                { "name": "ryu_test_secret", "regex": SECRET_MARKER, "kind": "secret" }
            ]
        },
        "allowedProviders": [],
        "allowedModels": []
    })
}

fn lexicon_floor(version: u64) -> Arc<PlatformFloor> {
    PlatformFloor::from_wire(Some(&floor_document(version)), false).expect("the probe floor parses")
}

/// The node base sets nothing the floor sets.
fn loosen_node(config: &mut GatewayConfig) {
    config.firewall = FirewallConfig {
        enabled: false,
        scan_inbound: false,
        scan_outbound: false,
        redact_pii: false,
        redact_secrets: false,
        policy: FirewallPolicy::WarnAndContinue,
        custom_patterns: Vec::new(),
        locked_fields: Vec::new(),
        ..FirewallConfig::default()
    };
}

/// The same dials as the floor, on the node instead. Used as the reference
/// for outbound cases: a leak the reference also shows is not the floor's.
fn node_like_the_floor(config: &mut GatewayConfig) {
    config.firewall = FirewallConfig {
        enabled: true,
        scan_inbound: true,
        scan_outbound: true,
        redact_pii: false,
        redact_secrets: true,
        policy: FirewallPolicy::Block,
        custom_patterns: vec![
            lexicon(),
            CustomPattern {
                name: "ryu_test_secret".into(),
                regex: SECRET_MARKER.into(),
                kind: CustomPatternKind::Secret,
            },
        ],
        locked_fields: Vec::new(),
        ..FirewallConfig::default()
    };
}

fn loosening_overlay() -> FirewallOverlay {
    FirewallOverlay {
        enabled: Some(false),
        scan_inbound: Some(false),
        scan_outbound: Some(false),
        redact_pii: Some(false),
        redact_secrets: Some(false),
        policy: Some(FirewallPolicy::WarnAndContinue),
        ..FirewallOverlay::default()
    }
}

/// The tenant's own policy switches the firewall off at org and agent scope.
fn loosen_tenant(state: &AppState) {
    let mut policy = state.policy.write().unwrap();
    policy.firewall = Some(loosening_overlay());
    policy.agent_overlays = HashMap::from([(PROBE_AGENT.to_owned(), loosening_overlay())]);
}

fn leaky_answers() -> HashMap<String, String> {
    HashMap::from([
        (
            LEAKY_SECRET.to_owned(),
            format!("the key is {SECRET_MARKER} today"),
        ),
        (LEAKY_LEXICON.to_owned(), marked("the answer is")),
    ])
}

/// A probe gateway on `custody` holding `floor`, with capture providers as
/// the default and the spare. `register` may add providers before the state
/// is shared.
fn probe_with(
    custody: GatewayCustody,
    floor: Option<Arc<PlatformFloor>>,
    configure: impl FnOnce(&mut GatewayConfig),
    register: impl FnOnce(&mut AppState, &Upstream),
) -> Floor {
    let mut config = floor_config(FLOOR);
    config.routing.fallback_chain = vec![ProviderId::from(FLOOR), ProviderId::from(SPARE)];
    loosen_node(&mut config);
    configure(&mut config);
    let (mut state, audit) = floor_state(custody, config);
    state.platform_floor = match floor {
        Some(floor) => FloorStore::with(floor),
        None => FloorStore::default(),
    };
    loosen_tenant(&state);
    let upstream = Upstream::default();
    let models = Arc::new(Mutex::new(Vec::new()));
    for name in [FLOOR, SPARE] {
        state
            .provider_runtime
            .register_for_test(Arc::new(CaptureProvider {
                name,
                upstream: upstream.clone(),
                models: Arc::clone(&models),
                answers: leaky_answers(),
            }) as Arc<dyn Provider>);
    }
    register(&mut state, &upstream);
    Floor {
        state: Arc::new(state),
        upstream,
        models,
        audit,
    }
}

fn probe(custody: GatewayCustody) -> Floor {
    probe_with(custody, Some(lexicon_floor(2)), |_| {}, |_, _| {})
}

// ── outcomes ─────────────────────────────────────────────────────────────────

/// Every miss one probe group found.
#[derive(Default)]
struct Gaps(Vec<String>);

impl Gaps {
    fn note(&mut self, miss: Option<String>) {
        if let Some(miss) = miss {
            self.0.push(miss);
        }
    }

    fn assert_none(&self) {
        assert!(self.0.is_empty(), "\n{}", self.0.join("\n"));
    }
}

fn short(body: &Value) -> String {
    body.to_string().chars().take(300).collect()
}

fn leaks(text: &str) -> bool {
    text.contains(MARKER) || text.contains(FAKE_AWS_KEY) || text.contains(SECRET_MARKER)
}

async fn post_as(
    floor: &Floor,
    bearer: &str,
    uri: &str,
    headers: &[(&str, String)],
    body: &Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .extension(loopback());
    if !bearer.is_empty() {
        request = request.header("authorization", format!("Bearer {bearer}"));
    }
    for (name, value) in headers {
        request = request.header(*name, value.as_str());
    }
    read(
        floor
            .app()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap(),
    )
    .await
}

/// A floor refusal: 403 `policy_violation`, no new upstream call and no marker
/// in any body captured since `before`.
fn refused(
    what: &str,
    (status, body): &(StatusCode, Value),
    upstream: &Upstream,
    before: usize,
) -> Option<String> {
    let mut problems = Vec::new();
    if *status != StatusCode::FORBIDDEN || body["error"]["type"] != "policy_violation" {
        problems.push(format!("answered {status} {}", short(body)));
    }
    let calls = upstream.count();
    if calls != before {
        problems.push(format!("{} new upstream call(s)", calls - before));
    }
    if upstream.all().iter().skip(before).any(|seen| leaks(seen)) {
        problems.push("the marker reached an upstream".to_owned());
    }
    (!problems.is_empty()).then(|| format!("{what}: {}", problems.join("; ")))
}

/// A dispatch: a success status and at least one new upstream call.
fn served(
    what: &str,
    (status, body): &(StatusCode, Value),
    upstream: &Upstream,
    before: usize,
) -> Option<String> {
    if status.is_success() && upstream.count() > before {
        return None;
    }
    Some(format!(
        "{what}: expected a dispatch, got {status} with {} new upstream call(s): {}",
        upstream.count() - before,
        short(body)
    ))
}

/// The SelfHosted twin must carry the marker upstream, or the Fleet case
/// proves nothing about the floor.
fn twin_carried(
    what: &str,
    outcome: &(StatusCode, Value),
    upstream: &Upstream,
    before: usize,
) -> Option<String> {
    if let Some(miss) = served(what, outcome, upstream, before) {
        return Some(format!("VACUOUS twin {miss}"));
    }
    if !upstream.all().iter().skip(before).any(|seen| leaks(seen)) {
        return Some(format!(
            "VACUOUS twin {what}: the marker never reached upstream"
        ));
    }
    None
}

/// A missing-floor refusal: 503 `screening_unavailable` with no new upstream
/// call.
fn unavailable(
    what: &str,
    (status, body): &(StatusCode, Value),
    upstream: &Upstream,
    before: usize,
) -> Option<String> {
    let mut problems = Vec::new();
    if *status != StatusCode::SERVICE_UNAVAILABLE
        || body["error"]["code"] != "screening_unavailable"
    {
        problems.push(format!("answered {status} {}", short(body)));
    }
    if upstream.count() != before {
        problems.push(format!(
            "{} new upstream call(s)",
            upstream.count() - before
        ));
    }
    (!problems.is_empty()).then(|| format!("{what}: {}", problems.join("; ")))
}

// ── inbound: every dialect, buffered and streamed ───────────────────────────

type BodyFor = Box<dyn Fn(&str) -> Value>;

/// `(label, uri, body)` for every inbound case, both stream modes where the
/// dialect has one.
fn inbound_cases() -> Vec<(String, String, BodyFor)> {
    let mut cases: Vec<(String, String, BodyFor)> = Vec::new();
    for stream in [false, true] {
        for uri in [
            CHAT.to_owned(),
            "/v1/cursor/chat/completions".to_owned(),
            format!("/v1/agents/{PROBE_AGENT}/chat/completions"),
        ] {
            cases.push((
                format!("{uri} stream={stream}"),
                uri,
                Box::new(move |text| {
                    json!({ "model": "fixture-model", "stream": stream,
                        "messages": [{ "role": "user", "content": text }] })
                }),
            ));
        }
        cases.push((
            format!("chat image parts stream={stream}"),
            CHAT.to_owned(),
            Box::new(move |text| {
                json!({ "model": "fixture-model", "stream": stream, "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": text },
                        { "type": "image_url", "image_url": { "url": "https://x.invalid/a.png" } }
                    ]
                }] })
            }),
        ));
        cases.push((
            format!("/v1/responses stream={stream}"),
            "/v1/responses".to_owned(),
            Box::new(
                move |text| json!({ "model": "fixture-model", "stream": stream, "input": text }),
            ),
        ));
        cases.push((
            format!("/v1/messages stream={stream}"),
            "/v1/messages".to_owned(),
            Box::new(move |text| {
                json!({ "model": "fixture-model", "max_tokens": 16, "stream": stream,
                    "messages": [{ "role": "user", "content": text }] })
            }),
        ));
    }
    for uri in [
        "/v1beta/models/fixture-model:generateContent",
        "/v1beta/models/fixture-model:streamGenerateContent?alt=sse",
    ] {
        cases.push((
            uri.to_owned(),
            uri.to_owned(),
            Box::new(
                |text| json!({ "contents": [{ "role": "user", "parts": [{ "text": text }] }] }),
            ),
        ));
    }
    cases.push((
        "/v1/embeddings".to_owned(),
        "/v1/embeddings".to_owned(),
        Box::new(|text| json!({ "model": "fixture-embed", "input": ["ok", text] })),
    ));
    cases.push((
        "/v1/rerank".to_owned(),
        "/v1/rerank".to_owned(),
        Box::new(
            |text| json!({ "model": "fixture-rerank", "query": text, "documents": ["a", "b"] }),
        ),
    ));
    cases.push((
        "/v1/images/generations".to_owned(),
        IMAGES.to_owned(),
        Box::new(|text| json!({ "model": "fixture-image", "prompt": text })),
    ));
    cases.push((
        "/v1/audio/speech".to_owned(),
        SPEECH.to_owned(),
        Box::new(|text| json!({ "model": "fixture-tts", "input": text, "voice": "alloy" })),
    ));
    cases
}

#[tokio::test]
async fn probe_the_floor_refuses_the_marker_on_every_dialect_buffered_and_streamed() {
    let fleet = probe(GatewayCustody::Fleet);
    let twin = probe(GatewayCustody::SelfHosted);
    let mut gaps = Gaps::default();
    for (label, uri, body) in inbound_cases() {
        let before = fleet.upstream.count();
        let outcome = post_as(&fleet, TENANT, &uri, &[], &body(&marked("hello"))).await;
        gaps.note(refused(&label, &outcome, &fleet.upstream, before));

        let before = fleet.upstream.count();
        let outcome = post_as(&fleet, TENANT, &uri, &[], &body("hello there")).await;
        gaps.note(served(
            &format!("{label} benign"),
            &outcome,
            &fleet.upstream,
            before,
        ));

        let before = twin.upstream.count();
        let outcome = post_as(&twin, TENANT, &uri, &[], &body(&marked("hello"))).await;
        gaps.note(twin_carried(&label, &outcome, &twin.upstream, before));
    }

    // Transcription is multipart.
    let before = fleet.upstream.count();
    let outcome = post_transcription(&fleet, &marked("names")).await;
    gaps.note(refused("transcription", &outcome, &fleet.upstream, before));
    let before = twin.upstream.count();
    let outcome = post_transcription(&twin, &marked("names")).await;
    gaps.note(twin_carried(
        "transcription",
        &outcome,
        &twin.upstream,
        before,
    ));
    gaps.assert_none();
}

// ── inbound: eval replays and web search ─────────────────────────────────────

#[tokio::test]
async fn probe_the_floor_binds_eval_replays_and_web_search() {
    let mut gaps = Gaps::default();
    let run = |prompt: String| json!({ "model": "fixture-model", "dataset": [{ "prompt": prompt, "expected": "ok" }] });
    let fleet = probe(GatewayCustody::Fleet);
    let twin = probe(GatewayCustody::SelfHosted);
    let before = fleet.upstream.count();
    let (status, body) = post_as(&fleet, TENANT, "/v1/evals/run", &[], &run(marked("say"))).await;
    if fleet.upstream.count() != before || body["cases"][0]["policy_pass"] != false {
        gaps.note(Some(format!(
            "eval replay: {status} with {} upstream call(s): {}",
            fleet.upstream.count() - before,
            short(&body)
        )));
    }
    let before = twin.upstream.count();
    let (status, body) = post_as(&twin, TENANT, "/v1/evals/run", &[], &run(marked("say"))).await;
    if twin.upstream.count() == before {
        gaps.note(Some(format!(
            "VACUOUS twin eval replay: {status} {}",
            short(&body)
        )));
    }

    for custody in [GatewayCustody::Fleet, GatewayCustody::SelfHosted] {
        let web = probe_with(
            custody,
            Some(lexicon_floor(2)),
            |config| {
                web_fixture::configure(config);
                let mut web_key = api_key(WEB_KEY, "web", false);
                web_key.org_id = None;
                config.auth.api_keys.push(web_key);
            },
            |state, upstream| {
                state
                    .provider_runtime
                    .register_for_test(Arc::new(web_fixture::WebCapture {
                        upstream: upstream.clone(),
                    }));
            },
        );
        let before = web.upstream.count();
        let outcome = post_as(
            &web,
            WEB_KEY,
            "/v1/web/search",
            &[],
            &json!({ "query": marked("find") }),
        )
        .await;
        if custody.is_fleet() {
            gaps.note(refused("web search", &outcome, &web.upstream, before));
        } else {
            gaps.note(twin_carried("web search", &outcome, &web.upstream, before));
        }
    }
    gaps.assert_none();
}

// ── outbound: dialects, streaming and cache hits ─────────────────────────────

/// `(label, uri, body)` for every outbound case. The prompt is benign; the
/// marker is in the capture provider's answer for `model`.
fn outbound_cases(model: &'static str) -> Vec<(String, String, Value)> {
    let mut cases = Vec::new();
    for stream in [false, true] {
        cases.push((
            format!("chat stream={stream}"),
            CHAT.to_owned(),
            json!({ "model": model, "stream": stream,
                "messages": [{ "role": "user", "content": "hello" }] }),
        ));
        cases.push((
            format!("/v1/responses stream={stream}"),
            "/v1/responses".to_owned(),
            json!({ "model": model, "stream": stream, "input": "hello" }),
        ));
        cases.push((
            format!("/v1/messages stream={stream}"),
            "/v1/messages".to_owned(),
            json!({ "model": model, "max_tokens": 16, "stream": stream,
                "messages": [{ "role": "user", "content": "hello" }] }),
        ));
    }
    for verb in ["generateContent", "streamGenerateContent?alt=sse"] {
        cases.push((
            format!("/v1beta {verb}"),
            format!("/v1beta/models/{model}:{verb}"),
            json!({ "contents": [{ "role": "user", "parts": [{ "text": "hello" }] }] }),
        ));
    }
    cases
}

#[tokio::test]
async fn probe_the_floor_screens_outbound_answers_on_every_dialect() {
    let fleet = probe(GatewayCustody::Fleet);
    let twin = probe(GatewayCustody::SelfHosted);
    // The same dials on the node with a floor that sets nothing: a leak this
    // reference also shows is a scanner limit, not a floor gap.
    let reference = probe_with(
        GatewayCustody::Fleet,
        Some(PlatformFloor::setting_nothing()),
        node_like_the_floor,
        |_, _| {},
    );
    let mut gaps = Gaps::default();
    for model in [LEAKY_SECRET, LEAKY_LEXICON] {
        for (label, uri, body) in outbound_cases(model) {
            let label = format!("{model} {label}");
            let (status, twin_body) = post_as(&twin, TENANT, &uri, &[], &body).await;
            if !leaks(&twin_body.to_string()) {
                gaps.note(Some(format!(
                    "VACUOUS twin {label}: {status} never returned the marker: {}",
                    short(&twin_body)
                )));
                continue;
            }
            let (status, fleet_body) = post_as(&fleet, TENANT, &uri, &[], &body).await;
            let (_, reference_body) = post_as(&reference, TENANT, &uri, &[], &body).await;
            let reference_leaks = leaks(&reference_body.to_string());
            if model == LEAKY_SECRET && reference_leaks {
                gaps.note(Some(format!(
                    "VACUOUS reference {label}: the node-config reference leaks the secret marker"
                )));
            }
            // A leak the node-config reference shares is a scanner limit (the
            // lexicon is an inbound-only kind), not a floor gap.
            if leaks(&fleet_body.to_string()) && !reference_leaks {
                gaps.note(Some(format!(
                    "{label}: the fleet returned the marker ({status}) while the same dials on                      the node screen it: {}",
                    short(&fleet_body)
                )));
            }
        }
    }
    gaps.assert_none();
}

#[tokio::test]
async fn probe_a_cached_answer_is_screened_by_a_floor_that_arrives_later() {
    let mut gaps = Gaps::default();
    for model in [LEAKY_SECRET] {
        // The cache fills under a floor that sets nothing.
        let fleet = probe_with(
            GatewayCustody::Fleet,
            Some(PlatformFloor::setting_nothing()),
            |config| config.cache.enabled = true,
            |_, _| {},
        );
        let body = json!({ "model": model, "messages": [{ "role": "user", "content": "hello" }] });
        let (status, first) = post_as(&fleet, TENANT, CHAT, &[], &body).await;
        if !status.is_success() || !leaks(&first.to_string()) {
            gaps.note(Some(format!(
                "VACUOUS cache fill {model}: {status} {}",
                short(&first)
            )));
            continue;
        }
        let filled = fleet.upstream.count();

        // A newer floor arrives, as a resolve would deliver it.
        assert!(fleet.state.platform_floor.observe(Some(&lexicon_floor(2))));
        fleet.state.resolver.invalidate_cache();

        let (status, second) = post_as(&fleet, TENANT, CHAT, &[], &body).await;
        let hit = fleet.upstream.count() == filled;
        if leaks(&second.to_string()) {
            gaps.note(Some(format!(
                "cache {model}: the floor did not screen the {} answer ({status}): {}",
                if hit { "cached" } else { "fresh" },
                short(&second)
            )));
        }
        if !hit {
            gaps.note(Some(format!(
                "VACUOUS cache {model}: the repeat was not a cache hit ({status})"
            )));
        }

        // The marked prompt is refused before any cache lookup.
        let before = fleet.upstream.count();
        let outcome = post_as(
            &fleet,
            TENANT,
            CHAT,
            &[],
            &json!({ "model": model, "messages": [{ "role": "user", "content": marked("hello") }] }),
        )
        .await;
        gaps.note(refused(
            &format!("cache {model} marked"),
            &outcome,
            &fleet.upstream,
            before,
        ));
    }
    gaps.assert_none();
}

// ── fallback after a failed primary ──────────────────────────────────────────

/// A primary that always fails, so every dispatch falls back to the spare.
struct FailingPrimary {
    calls: Arc<Counter>,
}

impl Provider for FailingPrimary {
    fn name(&self) -> &'static str {
        FLOOR
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(ProviderError::Provider("primary down".into())) })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(ProviderError::Provider("primary down".into())) })
    }
}

#[tokio::test]
async fn probe_the_floor_holds_on_the_fallback_attempt() {
    let mut gaps = Gaps::default();
    let mut floors = Vec::new();
    for custody in [GatewayCustody::Fleet, GatewayCustody::SelfHosted] {
        let primary = Arc::new(Counter::new(0));
        let calls = Arc::clone(&primary);
        let floor = probe_with(
            custody,
            Some(lexicon_floor(2)),
            |_| {},
            move |state, _| {
                state
                    .provider_runtime
                    .register_for_test(Arc::new(FailingPrimary { calls }) as Arc<dyn Provider>);
            },
        );
        floors.push((custody, floor, primary));
    }
    for stream in [false, true] {
        for (custody, floor, primary) in &floors {
            let label = format!("{custody:?} fallback stream={stream}");
            let primary_before = primary.load(Ordering::SeqCst);
            let before = floor.upstream.count();
            let marked_body = json!({ "model": "fixture-model", "stream": stream,
                "messages": [{ "role": "user", "content": marked("hello") }] });
            let outcome = post_as(floor, TENANT, CHAT, &[], &marked_body).await;
            if custody.is_fleet() {
                gaps.note(refused(&label, &outcome, &floor.upstream, before));
                if primary.load(Ordering::SeqCst) != primary_before {
                    gaps.note(Some(format!("{label}: the primary was attempted")));
                }
            } else {
                gaps.note(twin_carried(&label, &outcome, &floor.upstream, before));
            }

            // A benign prompt the spare answers with a marker.
            let primary_before = primary.load(Ordering::SeqCst);
            let before = floor.upstream.count();
            let leaky = json!({ "model": LEAKY_SECRET, "stream": stream,
                "messages": [{ "role": "user", "content": "hello" }] });
            let (status, body) = post_as(floor, TENANT, CHAT, &[], &leaky).await;
            let reached_spare = floor.upstream.count() > before;
            if custody.is_fleet() && leaks(&body.to_string()) {
                gaps.note(Some(format!(
                    "{label}: the spare's answer reached the client ({status}): {}",
                    short(&body)
                )));
            }
            if !custody.is_fleet() && (!reached_spare || !leaks(&body.to_string())) {
                gaps.note(Some(format!(
                    "VACUOUS twin {label} answer: {status} {}",
                    short(&body)
                )));
            }
            if primary.load(Ordering::SeqCst) == primary_before {
                gaps.note(Some(format!(
                    "VACUOUS {label} answer: the failing primary was never attempted ({status})"
                )));
            }
            if custody.is_fleet() && !reached_spare {
                gaps.note(Some(format!(
                    "VACUOUS {label} answer: the spare was never reached ({status})"
                )));
            }
        }
    }
    gaps.assert_none();
}

// ── tool loops ───────────────────────────────────────────────────────────────

/// [`run_loop`] on `custody` with the node off, the tenant off and the probe
/// floor held. Returns the outcome, the provider rounds and the tool runs.
async fn run_floor_loop(
    custody: GatewayCustody,
    kind: Loop,
    output: Value,
) -> ((StatusCode, Value), Upstream, usize, usize) {
    let executions = Arc::new(Counter::new(0));
    let counted = Arc::clone(&executions);
    let (core_url, core) = serve(
        Router::new()
            .route(
                "/api/mcp/tools/call",
                post(move || {
                    let counted = Arc::clone(&counted);
                    let output = output.clone();
                    async move {
                        counted.fetch_add(1, Ordering::SeqCst);
                        Json(json!({ "ok": true, "output": output }))
                    }
                }),
            )
            .fallback(|| async { Json(json!({})) }),
    )
    .await;
    let mut config = floor_config(FLOOR);
    config.routing.fallback_chain = vec![ProviderId::from(SPARE)];
    loosen_node(&mut config);
    if kind == Loop::Composio {
        config.composio.enabled = true;
        config.composio.api_key = Some("composio-test-key".to_owned());
        config.composio.actions = vec![COMPOSIO_ACTION.to_owned()];
    }
    let (mut state, _audit) = floor_state(custody, config);
    state.platform_floor = FloorStore::with(lexicon_floor(2));
    loosen_tenant(&state);
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    state.tools = Some(crate::tools::ToolSearchClient::new(
        &CoreProviderConfig {
            base_url: core_url,
            token: None,
        },
        http.clone(),
    ));
    if kind == Loop::Composio {
        state.composio = Some(crate::composio::ComposioClient::for_test(
            state.config.composio.clone(),
            http,
            "http://127.0.0.1:9/unused".to_owned(),
        ));
    }
    let tool = match kind {
        Loop::Unified => crate::tools::catalog_client::model_tool_name(UNIFIED_TOOL),
        Loop::Composio => COMPOSIO_ACTION.to_owned(),
    };
    let upstream = Upstream::default();
    let rounds = Arc::new(Counter::new(0));
    for name in [FLOOR, SPARE] {
        state
            .provider_runtime
            .register_for_test(Arc::new(LoopProvider {
                name,
                tool: tool.clone(),
                upstream: upstream.clone(),
                rounds: Arc::clone(&rounds),
            }));
    }
    let app = crate::api::router(Arc::new(state));
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(CHAT)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {TENANT}"))
        .extension(loopback());
    if kind == Loop::Unified {
        request = request.header("x-ryu-tools", UNIFIED_TOOL);
    }
    let body = chat(json!([{ "role": "user", "content": "look up the latest message" }]));
    let outcome = read(
        app.oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap(),
    )
    .await;
    core.abort();
    let runs = executions.load(Ordering::SeqCst);
    let rounds = rounds.load(Ordering::SeqCst);
    (outcome, upstream, rounds, runs)
}

#[tokio::test]
async fn probe_the_floor_stops_a_tool_loop_before_round_two() {
    let mut gaps = Gaps::default();
    for kind in [Loop::Unified, Loop::Composio] {
        let what = if kind == Loop::Unified {
            "unified loop"
        } else {
            "composio loop"
        };
        let output = json!({ "title": marked("result") });
        let ((status, body), upstream, rounds, runs) =
            run_floor_loop(GatewayCustody::Fleet, kind, output.clone()).await;
        if runs != 1
            || rounds != 1
            || status != StatusCode::FORBIDDEN
            || upstream.carries_a_marker()
        {
            gaps.note(Some(format!(
                "{what}: runs={runs} rounds={rounds} {status} marker_upstream={}: {}",
                upstream.carries_a_marker(),
                short(&body)
            )));
        }
        let ((status, body), upstream, rounds, _) =
            run_floor_loop(GatewayCustody::SelfHosted, kind, output).await;
        if rounds != 2 || !upstream.carries_a_marker() {
            gaps.note(Some(format!(
                "VACUOUS twin {what}: rounds={rounds} {status}: {}",
                short(&body)
            )));
        }
    }
    gaps.assert_none();
}

// ── /v1/providers/call through the trusted forwarder ─────────────────────────

async fn provider_call(custody: GatewayCustody, text: &str) -> ((StatusCode, Value), Upstream) {
    let upstream = Upstream::default();
    let (composio_url, composio) = spawn_composio(upstream.clone()).await;
    let (control_url, control) = serve(Router::new().route(
        "/api/credits/debit",
        post(|| async { Json(json!({ "balanceMicroUsd": 900_000, "wentNonPositive": false })) }),
    ))
    .await;
    let mut config = floor_config(FLOOR);
    loosen_node(&mut config);
    config.composio.enabled = true;
    config.composio.api_key = Some("composio-project-test-key".to_owned());
    config.credits.enabled = true;
    config.credits.base_url = control_url.clone();
    config.credits.internal_secret = Some("internal-test-secret".to_owned());
    let (mut state, _audit) = floor_state(custody, config);
    state.platform_floor = FloorStore::with(lexicon_floor(2));
    loosen_tenant(&state);
    state.composio = Some(crate::composio::ComposioClient::for_test(
        state.config.composio.clone(),
        vendor_client(),
        format!("{composio_url}/api/v3.1"),
    ));
    state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
        control_url,
        reqwest::Client::new(),
    ));
    let app = crate::api::router(Arc::new(state));
    let outcome = send(
        &app,
        Method::POST,
        "/v1/providers/call",
        Some(CORE_KEY),
        &json!({
            "provider": "composio",
            "toolId": "GMAIL_SEND_EMAIL",
            "operation": "execute",
            "method": "POST",
            "body": { "arguments": { "text": text } },
            "requestId": "req-floor-probe",
        }),
    )
    .await;
    composio.abort();
    control.abort();
    (outcome, upstream)
}

#[tokio::test]
async fn probe_the_floor_binds_provider_calls() {
    let mut gaps = Gaps::default();
    let (outcome, upstream) = provider_call(GatewayCustody::Fleet, &marked("hello")).await;
    gaps.note(refused("providers/call", &outcome, &upstream, 0));
    let (outcome, upstream) = provider_call(GatewayCustody::Fleet, "hello there").await;
    gaps.note(served("providers/call benign", &outcome, &upstream, 0));
    let (outcome, upstream) = provider_call(GatewayCustody::SelfHosted, &marked("hello")).await;
    gaps.note(twin_carried("providers/call", &outcome, &upstream, 0));
    gaps.assert_none();
}

// ── credentials: trusted forwarder, agent, request overlay, master key ───────

fn node_routing_header(document: &Value) -> String {
    use base64::Engine as _;
    format!(
        "v1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(document.to_string().as_bytes())
    )
}

#[tokio::test]
async fn probe_the_floor_binds_every_credential_and_scope() {
    let configure = |config: &mut GatewayConfig| {
        config.node_routing.allow_request_override = true;
    };
    let fleet = probe_with(
        GatewayCustody::Fleet,
        Some(lexicon_floor(2)),
        configure,
        |_, _| {},
    );
    let twin = probe_with(
        GatewayCustody::SelfHosted,
        Some(lexicon_floor(2)),
        configure,
        |_, _| {},
    );
    let loosening_request = node_routing_header(&json!({
        "firewall": { "enabled": false, "scan_inbound": false, "policy": "warn_and_continue" }
    }));
    let cases: Vec<(&str, &str, Vec<(&str, String)>)> = vec![
        ("tenant key", TENANT, vec![]),
        (
            "trusted forwarder with a loosening agent",
            CORE_KEY,
            vec![("x-ryu-agent-id", PROBE_AGENT.to_owned())],
        ),
        (
            "trusted forwarder with a loosening request overlay",
            CORE_KEY,
            vec![("x-ryu-node-routing", loosening_request.clone())],
        ),
        (
            "tenant key with a loosening request overlay",
            TENANT,
            vec![("x-ryu-node-routing", loosening_request)],
        ),
        ("master key", MASTER, vec![]),
    ];
    let mut gaps = Gaps::default();
    for stream in [false, true] {
        let body = json!({ "model": "fixture-model", "stream": stream,
            "messages": [{ "role": "user", "content": marked("hello") }] });
        for (label, bearer, headers) in &cases {
            let label = format!("{label} stream={stream}");
            let before = fleet.upstream.count();
            let outcome = post_as(&fleet, bearer, CHAT, headers, &body).await;
            gaps.note(refused(&label, &outcome, &fleet.upstream, before));
            let before = twin.upstream.count();
            let outcome = post_as(&twin, bearer, CHAT, headers, &body).await;
            gaps.note(twin_carried(&label, &outcome, &twin.upstream, before));
        }
    }
    gaps.assert_none();
}

// ── rgw_ tenants resolved from the control plane ─────────────────────────────

/// Serves every `rgw_` token one org with `managedInference: false`, a tenant
/// overlay that switches the firewall off, and the probe floor (or none).
async fn serve_control_plane(floor: Value) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/api/control-plane/gateway/resolve",
        axum::routing::get(move |headers: axum::http::HeaderMap| {
            let floor = floor.clone();
            async move {
                let token = headers
                    .get("x-gateway-key")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                if !token.starts_with("rgw_") {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                let mut body = json!({
                    "organization": { "id": "org_floor_probe" },
                    "credential": {
                        "id": format!("cred_{token}"),
                        "purpose": "gateway_relay",
                        "allowedOperations": ["gateway.inference"]
                    },
                    "managedInference": false,
                    "standing": { "state": "active", "refuses": "none" },
                    "firewall": {
                        "enabled": false,
                        "scan_inbound": false,
                        "scan_outbound": false,
                        "policy": "warn_and_continue",
                        "redact_secrets": false
                    },
                    "platformFloorUnavailable": floor.is_null()
                });
                body["agentOverlays"] = json!({});
                body["agentOverlays"][PROBE_AGENT] = json!({ "enabled": false });
                if !floor.is_null() {
                    body["platformFloor"] = floor;
                }
                Json(body).into_response()
            }
        }),
    );
    serve(app).await
}

fn rgw_gateway(custody: GatewayCustody, url: String) -> Floor {
    probe_with(
        custody,
        None,
        |_| {},
        |state, _| {
            state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
                url,
                reqwest::Client::new(),
            ));
        },
    )
}

#[tokio::test]
async fn probe_the_floor_binds_rgw_tenants_on_every_dialect_and_auth_header() {
    let (url, server) = serve_control_plane(floor_document(2)).await;
    let fleet = rgw_gateway(GatewayCustody::Fleet, url.clone());
    let twin = rgw_gateway(GatewayCustody::SelfHosted, url);
    let mut gaps = Gaps::default();
    let chat_body = |stream: bool, text: &str| {
        json!({ "model": "fixture-model", "stream": stream,
            "messages": [{ "role": "user", "content": text }] })
    };
    let messages_body = |stream: bool, text: &str| {
        json!({ "model": "fixture-model", "max_tokens": 16, "stream": stream,
            "messages": [{ "role": "user", "content": text }] })
    };
    let gemini_body =
        |text: &str| json!({ "contents": [{ "role": "user", "parts": [{ "text": text }] }] });
    let text = marked("hello");
    let mut cases: Vec<(String, &str, String, Vec<(&str, String)>, Value)> = Vec::new();
    for stream in [false, true] {
        cases.push((
            format!("rgw chat stream={stream}"),
            RGW_TOKEN,
            CHAT.to_owned(),
            vec![],
            chat_body(stream, &text),
        ));
        cases.push((
            format!("rgw messages x-api-key stream={stream}"),
            "",
            "/v1/messages".to_owned(),
            vec![("x-api-key", RGW_TOKEN.to_owned())],
            messages_body(stream, &text),
        ));
        cases.push((
            format!("rgw responses stream={stream}"),
            RGW_TOKEN,
            "/v1/responses".to_owned(),
            vec![],
            json!({ "model": "fixture-model", "stream": stream, "input": text }),
        ));
    }
    for verb in ["generateContent", "streamGenerateContent?alt=sse"] {
        cases.push((
            format!("rgw v1beta x-goog-api-key {verb}"),
            "",
            format!("/v1beta/models/fixture-model:{verb}"),
            vec![("x-goog-api-key", RGW_TOKEN.to_owned())],
            gemini_body(&text),
        ));
    }
    cases.push((
        "rgw embeddings".to_owned(),
        RGW_TOKEN,
        "/v1/embeddings".to_owned(),
        vec![],
        json!({ "model": "fixture-embed", "input": ["ok", text] }),
    ));
    for (label, bearer, uri, headers, body) in &cases {
        let before = fleet.upstream.count();
        let outcome = post_as(&fleet, bearer, uri, headers, body).await;
        gaps.note(refused(label, &outcome, &fleet.upstream, before));
        let before = twin.upstream.count();
        let outcome = post_as(&twin, bearer, uri, headers, body).await;
        gaps.note(twin_carried(label, &outcome, &twin.upstream, before));
    }
    server.abort();
    gaps.assert_none();
}

// ── a fleet with no floor refuses every route ────────────────────────────────

#[tokio::test]
async fn probe_a_fleet_with_no_floor_refuses_every_provider_route() {
    let configure = |config: &mut GatewayConfig| {
        web_fixture::configure(config);
        let mut web_key = api_key(WEB_KEY, "web", false);
        web_key.org_id = None;
        config.auth.api_keys.push(web_key);
    };
    let fleet = probe_with(GatewayCustody::Fleet, None, configure, |state, upstream| {
        state
            .provider_runtime
            .register_for_test(Arc::new(web_fixture::WebCapture {
                upstream: upstream.clone(),
            }));
    });
    let mut gaps = Gaps::default();
    for (label, uri, body) in inbound_cases() {
        let before = fleet.upstream.count();
        let outcome = post_as(&fleet, TENANT, &uri, &[], &body("hello there")).await;
        gaps.note(unavailable(&label, &outcome, &fleet.upstream, before));
    }
    let before = fleet.upstream.count();
    let outcome = post_transcription(&fleet, "names").await;
    gaps.note(unavailable(
        "transcription",
        &outcome,
        &fleet.upstream,
        before,
    ));
    let others: Vec<(&str, &str, Value)> = vec![
        (
            CORE_KEY,
            CHAT,
            chat(json!([{ "role": "user", "content": "hello" }])),
        ),
        (
            TENANT,
            VIDEOS,
            json!({ "model": "gen4.5", "promptText": "waves", "ratio": "1280:720", "duration": 5 }),
        ),
        (
            TENANT,
            "/v1/evals/run",
            json!({ "model": "fixture-model", "dataset": [{ "prompt": "say", "expected": "ok" }] }),
        ),
        (
            WEB_KEY,
            "/v1/web/search",
            json!({ "query": "rust release notes" }),
        ),
        (
            WEB_KEY,
            "/v1/web/fetch",
            json!({ "url": "https://example.com/article" }),
        ),
        (
            CORE_KEY,
            "/v1/providers/call",
            json!({
                "provider": "composio",
                "toolId": "GMAIL_SEND_EMAIL",
                "operation": "execute",
                "method": "POST",
                "body": { "arguments": { "text": "hello" } },
                "requestId": "req-floor-probe-missing",
            }),
        ),
    ];
    for (bearer, uri, body) in &others {
        let before = fleet.upstream.count();
        let outcome = post_as(&fleet, bearer, uri, &[], body).await;
        gaps.note(unavailable(
            &format!("{uri} as {bearer}"),
            &outcome,
            &fleet.upstream,
            before,
        ));
    }
    gaps.assert_none();
}

// ── floor evaluator bindings the gateway cannot run ──────────────────────────

/// A floor whose only change from the probe floor is one inline evaluator
/// binding `id` set to block.
fn floor_with_evaluator(id: &str) -> Value {
    let mut document = floor_document(3);
    document["overlay"]["evaluators"] =
        json!([{ "id": id, "enabled": true, "inlineAction": "block" }]);
    document
}

#[tokio::test]
async fn probe_a_floor_evaluator_the_gateway_cannot_run_is_not_applied_silently() {
    let mut gaps = Gaps::default();
    // `code_evaluator` is in the built-in catalog but unavailable inline;
    // `ryu_test_unknown_evaluator` is in no catalog at all.
    for id in ["code_evaluator", "ryu_test_unknown_evaluator"] {
        let document = floor_with_evaluator(id);
        let Some(floor) = PlatformFloor::from_wire(Some(&document), false) else {
            continue;
        };
        // The parser kept it, so the fleet applies it. A benign request then
        // shows what that floor does to traffic.
        let fleet = probe_with(GatewayCustody::Fleet, Some(floor), |_| {}, |_, _| {});
        let before = fleet.upstream.count();
        let (status, body) = post_as(
            &fleet,
            TENANT,
            CHAT,
            &[],
            &chat(json!([{ "role": "user", "content": "hello there" }])),
        )
        .await;
        gaps.note(Some(format!(
            "floor evaluator {id}: the floor was accepted whole, and a benign fleet request \
             answered {status} with {} upstream call(s): {}",
            fleet.upstream.count() - before,
            short(&body)
        )));
    }
    gaps.assert_none();
}
