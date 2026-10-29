//! Coverage probe for the Phase 0 floor bypass suite (spec P0-10).
//!
//! The suite proves each screened route refuses the test marker in its
//! natural field. These probes place the same harmless markers (the test-only
//! `RYU_TEST_LEXICON` pattern and the AWS documentation example key) in the
//! input shapes a route accepts but the suite does not exercise: deeper
//! nesting, arrays of objects, stringified JSON, unusual accepted fields,
//! object keys the provider reads, headers, query strings and path segments,
//! streaming dialects, fallback chains, judge calls and long benign padding
//! before the marker.
//!
//! Each probe group collects every miss before it fails, so one run reports
//! all of them. "Blocked" means what the suite means (403 `policy_violation`,
//! no new upstream call, no marker in any captured body or dispatched model,
//! one new failure audit row). Every blocked shape has a benign twin that
//! dispatches, which proves the shape is accepted at all. Probes on headers
//! and query strings only require that the marker never reaches an upstream,
//! since dropping the value is as safe as refusing it.
//!
//! Places that are secrets-only by design (`tools`, `functions`,
//! `tool_choice`, whitespace-free control tokens such as `model` or `user`)
//! are probed with the example key, never with the lexicon pattern.
use super::*;

/// Benign filler: plain words, never matched by any pattern.
fn padding(bytes: usize) -> String {
    "lorem ipsum dolor ".repeat(bytes / 18 + 1)
}

fn leaks(text: &str) -> bool {
    text.contains(MARKER) || text.contains(FAKE_AWS_KEY)
}

/// Whether a body `upstream` captured after its first `calls` carries a
/// marker. Earlier captures are ignored, so one leak never taints the next
/// probe in the same group.
fn upstream_leaked_since(upstream: &Upstream, calls: usize) -> bool {
    upstream.all().iter().skip(calls).any(|seen| leaks(seen))
}

/// The capture counts before one request.
#[derive(Clone, Copy)]
struct Seen {
    calls: usize,
    models: usize,
}

fn seen(floor: &Floor) -> Seen {
    Seen {
        calls: floor.upstream.count(),
        models: floor.models().len(),
    }
}

/// Whether a body or dispatched model captured since `before` carries a
/// marker.
fn floor_leaked_since(floor: &Floor, before: Seen) -> bool {
    upstream_leaked_since(&floor.upstream, before.calls)
        || floor
            .models()
            .iter()
            .skip(before.models)
            .any(|model| leaks(model))
}

async fn send_with(
    app: &Router,
    uri: &str,
    headers: &[(&str, &str)],
    body: &Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {TENANT}"))
        .extension(loopback());
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    read(
        app.clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap(),
    )
    .await
}

/// Every miss one probe group found.
#[derive(Default)]
struct Misses(Vec<String>);

impl Misses {
    fn note(&mut self, miss: Option<String>) {
        if let Some(miss) = miss {
            self.0.push(miss);
        }
    }

    fn assert_none(&self) {
        assert!(self.0.is_empty(), "\n{}", self.0.join("\n"));
    }
}

/// The blocked contract, as a miss description instead of a panic.
async fn blocked_miss(
    what: &str,
    (status, body): (StatusCode, Value),
    upstream: &Upstream,
    leaked: bool,
    audit: &FloorAudit,
    mark: Mark,
) -> Option<String> {
    let mut problems = Vec::new();
    if status != StatusCode::FORBIDDEN
        || body["error"]["type"] != "policy_violation"
        || body["error"]["code"] != "policy_violation"
    {
        problems.push(format!("answered {status} {}", truncated(&body)));
    }
    if upstream.count() != mark.calls {
        problems.push(format!(
            "{} new upstream call(s)",
            upstream.count() - mark.calls
        ));
    }
    if leaked {
        problems.push("the marker reached an upstream".to_owned());
    }
    let failures = failures_reach(audit, mark.failures + 1).await;
    if failures != mark.failures + 1 {
        problems.push(format!(
            "{} new failure audit row(s)",
            failures - mark.failures
        ));
    }
    (!problems.is_empty()).then(|| format!("BLOCK MISS {what}: {}", problems.join("; ")))
}

fn dispatch_miss(
    what: &str,
    (status, body): (StatusCode, Value),
    upstream: &Upstream,
    mark: Mark,
) -> Option<String> {
    if status.is_success() && upstream.count() > mark.calls {
        return None;
    }
    Some(format!(
        "CONTROL MISS {what}: {status} with {} new upstream call(s): {}",
        upstream.count() - mark.calls,
        truncated(&body)
    ))
}

fn truncated(body: &Value) -> String {
    body.to_string().chars().take(300).collect()
}

impl Floor {
    async fn probe_blocked(
        &self,
        what: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: &Value,
    ) -> Option<String> {
        let mark = self.mark();
        let before = seen(self);
        let outcome = send_with(&self.app(), uri, headers, body).await;
        blocked_miss(
            what,
            outcome,
            &self.upstream,
            floor_leaked_since(self, before),
            &self.audit,
            mark,
        )
        .await
    }

    async fn probe_dispatches(
        &self,
        what: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: &Value,
    ) -> Option<String> {
        let mark = self.mark();
        let outcome = send_with(&self.app(), uri, headers, body).await;
        dispatch_miss(what, outcome, &self.upstream, mark)
    }

    /// One shape: the marked body is blocked and its benign twin dispatches.
    async fn pair(
        &self,
        misses: &mut Misses,
        what: &str,
        uri: &str,
        marked_body: &Value,
        benign_body: &Value,
    ) {
        misses.note(self.probe_blocked(what, uri, &[], marked_body).await);
        misses.note(
            self.probe_dispatches(&format!("{what} control"), uri, &[], benign_body)
                .await,
        );
    }
}

fn user_chat(content: Value) -> Value {
    chat(json!([{ "role": "user", "content": content }]))
}

/// `body` with `field` set to `value` at the top level.
fn with(mut body: Value, field: &str, value: Value) -> Value {
    body[field] = value;
    body
}

fn schema_with_property(name: &str) -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "answer",
            "schema": {
                "type": "object",
                "properties": { name: { "type": "string" } }
            }
        }
    })
}

fn tool_with_property(name: &str, description: &str) -> Value {
    json!([{
        "type": "function",
        "function": {
            "name": "lookup",
            "description": description,
            "parameters": {
                "type": "object",
                "properties": { name: { "type": "string" } }
            }
        }
    }])
}

/// Stringify `value` `depth` times.
fn stringified(value: Value, depth: usize) -> Value {
    (0..depth).fold(value, |inner, _| Value::String(inner.to_string()))
}

// ── chat shapes ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_chat_shapes_refuse_the_marker() {
    let floor = Floor::new(|_| {});
    let mut misses = Misses::default();
    let base = || user_chat(json!("hello"));
    let shapes: Vec<(&str, Box<dyn Fn(&str) -> Value>)> = vec![
        (
            "second text part of an array of parts",
            Box::new(|text| {
                user_chat(json!([
                    { "type": "text", "text": "hello" },
                    { "type": "text", "text": text }
                ]))
            }),
        ),
        (
            "message name",
            Box::new(|text| {
                chat(
                    json!([{ "role": "user", "name": text.replace(' ', "_"), "content": "hello" }]),
                )
            }),
        ),
        (
            "assistant reasoning_content",
            Box::new(|text| {
                chat(json!([
                    { "role": "user", "content": "hello" },
                    { "role": "assistant", "content": "hi", "reasoning_content": text },
                    { "role": "user", "content": "again" }
                ]))
            }),
        ),
        (
            "assistant refusal",
            Box::new(|text| {
                chat(json!([
                    { "role": "user", "content": "hello" },
                    { "role": "assistant", "content": null, "refusal": text },
                    { "role": "user", "content": "again" }
                ]))
            }),
        ),
        (
            "legacy function_call arguments",
            Box::new(|text| {
                chat(json!([
                    { "role": "user", "content": "look it up" },
                    { "role": "assistant", "content": null, "function_call": {
                        "name": "lookup", "arguments": json!({ "note": text }).to_string()
                    }},
                    { "role": "function", "name": "lookup", "content": "done" }
                ]))
            }),
        ),
        (
            "tool message content as an array of parts",
            Box::new(|text| {
                chat(json!([
                    { "role": "user", "content": "look it up" },
                    { "role": "assistant", "content": null, "tool_calls": [{
                        "id": "call_1", "type": "function",
                        "function": { "name": "lookup", "arguments": "{}" }
                    }]},
                    { "role": "tool", "tool_call_id": "call_1", "content": [
                        { "type": "text", "text": "first" },
                        { "type": "text", "text": text }
                    ]}
                ]))
            }),
        ),
        (
            "tool call arguments stringified three times",
            Box::new(|text| {
                assistant_tool_call(
                    stringified(json!({ "outer": { "inner": [text] } }), 3)
                        .as_str()
                        .unwrap(),
                )
            }),
        ),
        (
            "tool call arguments with a unicode-escaped marker",
            Box::new(|text| {
                assistant_tool_call(&format!(
                    "{{\"note\":\"{}\"}}",
                    text.replacen('R', "\\u0052", 1)
                ))
            }),
        ),
        (
            "unknown top-level object, five levels deep",
            Box::new(move |text| {
                with(
                    base(),
                    "extra",
                    json!({ "a": [{ "b": { "c": [{ "d": [text] }] } }] }),
                )
            }),
        ),
        (
            "metadata object value",
            Box::new(move |text| with(base(), "metadata", json!({ "note": text }))),
        ),
        (
            "response_format schema description",
            Box::new(move |text| {
                with(
                    base(),
                    "response_format",
                    json!({
                        "type": "json_schema",
                        "json_schema": { "name": "answer", "schema": {
                            "type": "object", "description": text
                        }}
                    }),
                )
            }),
        ),
        (
            "stop sequences",
            Box::new(move |text| with(base(), "stop", json!(["END", text]))),
        ),
        (
            "prediction content as an array of parts",
            Box::new(move |text| {
                with(
                    base(),
                    "prediction",
                    json!({ "type": "content", "content": [{ "type": "text", "text": text }] }),
                )
            }),
        ),
        (
            "file part filename",
            Box::new(|text| {
                user_chat(json!([
                    { "type": "text", "text": "read this" },
                    { "type": "file", "file": {
                        "filename": format!("{}.pdf", text.replace(' ', "_")),
                        "file_data": "data:application/pdf;base64,JVBERi0xLjQ="
                    }}
                ]))
            }),
        ),
        (
            "user content after 1.5 MB of benign padding",
            Box::new(|text| user_chat(json!(format!("{}{text}", padding(1_500_000))))),
        ),
        (
            "metadata value after 1.5 MB of benign padding",
            Box::new(move |text| {
                with(
                    base(),
                    "metadata",
                    json!({ "note": format!("{}{text}", padding(1_500_000)) }),
                )
            }),
        ),
    ];
    for (what, body) in &shapes {
        for stream in [false, true] {
            let what = format!("{what} stream={stream}");
            floor
                .pair(
                    &mut misses,
                    &what,
                    CHAT,
                    &with(body(&marked("hello")), "stream", json!(stream)),
                    &with(body("hello there"), "stream", json!(stream)),
                )
                .await;
        }
    }
    misses.assert_none();
}

/// Object keys the provider reads as model input, and the secrets-only
/// places, probed with the key each zone screens.
#[tokio::test]
async fn probe_chat_model_visible_keys_and_secret_zones() {
    let floor = Floor::new(|_| {});
    let mut misses = Misses::default();
    let base = || user_chat(json!("hello"));
    floor
        .pair(
            &mut misses,
            "response_format schema property name (lexicon)",
            CHAT,
            &with(base(), "response_format", schema_with_property(MARKER)),
            &with(base(), "response_format", schema_with_property("answer")),
        )
        .await;
    floor
        .pair(
            &mut misses,
            "response_format schema property name (example key)",
            CHAT,
            &with(
                base(),
                "response_format",
                schema_with_property(FAKE_AWS_KEY),
            ),
            &with(base(), "response_format", schema_with_property("answer")),
        )
        .await;
    floor
        .pair(
            &mut misses,
            "tool parameter property name (example key)",
            CHAT,
            &with(base(), "tools", tool_with_property(FAKE_AWS_KEY, "Look up")),
            &with(base(), "tools", tool_with_property("query", "Look up")),
        )
        .await;
    floor
        .pair(
            &mut misses,
            "tool description (example key)",
            CHAT,
            &with(
                base(),
                "tools",
                tool_with_property("query", &format!("Look up with {FAKE_AWS_KEY}")),
            ),
            &with(base(), "tools", tool_with_property("query", "Look up")),
        )
        .await;
    floor
        .pair(
            &mut misses,
            "user control token (example key)",
            CHAT,
            &with(base(), "user", json!(FAKE_AWS_KEY)),
            &with(base(), "user", json!("user-1234")),
        )
        .await;
    floor
        .pair(
            &mut misses,
            "model control token (example key)",
            CHAT,
            &with(base(), "model", json!(FAKE_AWS_KEY)),
            &with(base(), "model", json!("fixture-model")),
        )
        .await;
    misses.assert_none();
}

// ── headers, query strings and path segments ─────────────────────────────────

/// A slot model header replaces the dispatched model after the body screen,
/// so it must never carry the example key upstream. The slot provider header
/// is sent too, since the slot route applies only with both.
#[tokio::test]
async fn probe_slot_model_headers_never_carry_a_secret_upstream() {
    let mut misses = Misses::default();
    let cases = [
        ("x-ryu-slot-chat", CHAT, user_chat(json!("hello"))),
        (
            "x-ryu-slot-image",
            IMAGES,
            json!({ "model": "fixture-image", "prompt": "a cat" }),
        ),
        (
            "x-ryu-slot-tts",
            SPEECH,
            json!({ "model": "fixture-tts", "input": "Hello", "voice": "alloy" }),
        ),
    ];
    for (prefix, uri, body) in &cases {
        let floor = Floor::new(|_| {});
        let provider = format!("{prefix}-provider");
        let model = format!("{prefix}-model");
        let before = seen(&floor);
        let (status, response) = send_with(
            &floor.app(),
            uri,
            &[(provider.as_str(), FLOOR), (model.as_str(), FAKE_AWS_KEY)],
            body,
        )
        .await;
        if floor_leaked_since(&floor, before) {
            misses.0.push(format!(
                "LEAK {model}: the example key reached the upstream ({status}); models {:?}: {}",
                floor.models(),
                truncated(&response)
            ));
        }
        let mark = floor.mark();
        let outcome = send_with(
            &floor.app(),
            uri,
            &[(provider.as_str(), FLOOR), (model.as_str(), "fixture-slot")],
            body,
        )
        .await;
        misses.note(dispatch_miss(
            &format!("{model} control"),
            outcome,
            &floor.upstream,
            mark,
        ));
        if !floor.models().iter().any(|model| model == "fixture-slot") {
            misses.0.push(format!(
                "VACUOUS {model}: the slot model never reached dispatch; models {:?}",
                floor.models()
            ));
        }
    }
    misses.assert_none();
}

/// Caller headers and query strings either stay out of the upstream request
/// or are refused.
#[tokio::test]
async fn probe_caller_headers_and_query_strings_never_reach_upstream() {
    let floor = Floor::new(|_| {});
    let mut misses = Misses::default();
    let spaced = marked("note");
    let headers: [(&str, &str); 7] = [
        ("x-ryu-session-id", FAKE_AWS_KEY),
        ("x-ryu-user-id", FAKE_AWS_KEY),
        ("x-ryu-agent-id", FAKE_AWS_KEY),
        ("x-ryu-feature", FAKE_AWS_KEY),
        ("x-ryu-skill-ids", FAKE_AWS_KEY),
        ("x-ryu-tool-profile", FAKE_AWS_KEY),
        ("x-ryu-capability-hints", spaced.as_str()),
    ];
    for header in headers {
        let before = seen(&floor);
        let outcome = send_with(&floor.app(), CHAT, &[header], &user_chat(json!("hello"))).await;
        if floor_leaked_since(&floor, before) {
            misses.0.push(format!(
                "LEAK header {}: reached the upstream ({})",
                header.0, outcome.0
            ));
        }
    }
    for uri in [
        format!("{CHAT}?note={MARKER}&key={FAKE_AWS_KEY}"),
        format!("/v1/messages?note={MARKER}"),
        format!("/v1beta/models/fixture-model:generateContent?alt=json&note={MARKER}"),
    ] {
        let body = if uri.starts_with("/v1beta") {
            json!({ "contents": [{ "role": "user", "parts": [{ "text": "hello" }] }] })
        } else {
            json!({ "model": "fixture-model", "max_tokens": 16,
                "messages": [{ "role": "user", "content": "hello" }] })
        };
        let before = seen(&floor);
        let outcome = send_with(&floor.app(), &uri, &[], &body).await;
        if floor_leaked_since(&floor, before) {
            misses.0.push(format!(
                "LEAK query {uri}: reached the upstream ({})",
                outcome.0
            ));
        }
    }
    let mark = floor.mark();
    let before = seen(&floor);
    let outcome = send_with(
        &floor.app(),
        "/v1beta/models/AKIAIOSFODNN7EXAMPLE:generateContent",
        &[],
        &json!({ "contents": [{ "role": "user", "parts": [{ "text": "hello" }] }] }),
    )
    .await;
    if floor_leaked_since(&floor, before) {
        misses.0.push(format!(
            "LEAK gemini path model: the example key reached dispatch ({}); models {:?}",
            outcome.0,
            floor.models()
        ));
    } else if outcome.0.is_success() || floor.upstream.count() != mark.calls {
        misses.0.push(format!(
            "gemini path model: dispatched without the key? {} {}",
            outcome.0,
            truncated(&outcome.1)
        ));
    }
    misses.assert_none();
}

// ── dialect shapes, buffered and streamed ────────────────────────────────────

#[tokio::test]
async fn probe_dialect_shapes_refuse_the_marker() {
    let floor = Floor::new(|_| {});
    let mut misses = Misses::default();
    const RESPONSES: &str = "/v1/responses";
    const MESSAGES: &str = "/v1/messages";
    let gemini = |stream: bool| {
        if stream {
            "/v1beta/models/fixture-model:streamGenerateContent?alt=sse"
        } else {
            "/v1beta/models/fixture-model:generateContent"
        }
    };
    type Shape = Box<dyn Fn(&str) -> Value>;
    let responses: Vec<(&str, Shape)> = vec![
        (
            "responses instructions",
            Box::new(
                |text| json!({ "model": "fixture-model", "instructions": text, "input": "hello" }),
            ),
        ),
        (
            "responses message item input_text",
            Box::new(|text| {
                json!({ "model": "fixture-model", "input": [{
                    "type": "message", "role": "user",
                    "content": [
                        { "type": "input_text", "text": "hello" },
                        { "type": "input_text", "text": text }
                    ]
                }]})
            }),
        ),
        (
            "responses function_call arguments and output",
            Box::new(|text| {
                json!({ "model": "fixture-model", "input": [
                    { "type": "message", "role": "user", "content": "look it up" },
                    { "type": "function_call", "call_id": "call_1", "name": "lookup",
                      "arguments": json!({ "q": "latest" }).to_string() },
                    { "type": "function_call_output", "call_id": "call_1",
                      "output": json!({ "result": { "items": [text] } }).to_string() }
                ]})
            }),
        ),
    ];
    let messages: Vec<(&str, Shape)> = vec![
        (
            "messages system block array",
            Box::new(|text| {
                json!({ "model": "fixture-model", "max_tokens": 16,
                    "system": [{ "type": "text", "text": "be brief" }, { "type": "text", "text": text }],
                    "messages": [{ "role": "user", "content": "hello" }] })
            }),
        ),
        (
            "messages tool_result nested content",
            Box::new(|text| {
                json!({ "model": "fixture-model", "max_tokens": 16, "messages": [
                    { "role": "user", "content": "look it up" },
                    { "role": "assistant", "content": [{ "type": "tool_use", "id": "tu_1",
                        "name": "lookup", "input": { "q": "latest" } }] },
                    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "tu_1",
                        "content": [{ "type": "text", "text": "first" }, { "type": "text", "text": text }] }] }
                ]})
            }),
        ),
        (
            "messages tool_use input nested object",
            Box::new(|text| {
                json!({ "model": "fixture-model", "max_tokens": 16, "messages": [
                    { "role": "user", "content": "look it up" },
                    { "role": "assistant", "content": [{ "type": "tool_use", "id": "tu_1",
                        "name": "lookup", "input": { "filters": [{ "note": text }] } }] },
                    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "tu_1",
                        "content": "done" }] }
                ]})
            }),
        ),
    ];
    let geminis: Vec<(&str, Shape)> = vec![
        (
            "gemini systemInstruction parts",
            Box::new(|text| {
                json!({ "systemInstruction": { "parts": [{ "text": "be brief" }, { "text": text }] },
                    "contents": [{ "role": "user", "parts": [{ "text": "hello" }] }] })
            }),
        ),
        (
            "gemini functionResponse nested response",
            Box::new(|text| {
                json!({ "contents": [
                    { "role": "user", "parts": [{ "text": "look it up" }] },
                    { "role": "model", "parts": [{ "functionCall": { "name": "lookup", "args": { "q": "latest" } } }] },
                    { "role": "user", "parts": [{ "functionResponse": { "name": "lookup",
                        "response": { "result": { "items": [{ "title": text }] } } } }] }
                ]})
            }),
        ),
        (
            "gemini functionCall nested args",
            Box::new(|text| {
                json!({ "contents": [
                    { "role": "user", "parts": [{ "text": "look it up" }] },
                    { "role": "model", "parts": [{ "functionCall": { "name": "lookup",
                        "args": { "filters": [{ "note": text }] } } }] },
                    { "role": "user", "parts": [{ "functionResponse": { "name": "lookup",
                        "response": { "result": "done" } } }] }
                ]})
            }),
        ),
    ];
    for stream in [false, true] {
        for (what, body) in &responses {
            floor
                .pair(
                    &mut misses,
                    &format!("{what} stream={stream}"),
                    RESPONSES,
                    &with(body(&marked("hello")), "stream", json!(stream)),
                    &with(body("hello there"), "stream", json!(stream)),
                )
                .await;
        }
        for (what, body) in &messages {
            floor
                .pair(
                    &mut misses,
                    &format!("{what} stream={stream}"),
                    MESSAGES,
                    &with(body(&marked("hello")), "stream", json!(stream)),
                    &with(body("hello there"), "stream", json!(stream)),
                )
                .await;
        }
        // The Gemini translation drops function parts it does not map, so a
        // dispatch that carries no marker is as safe as a refusal there.
        for (what, body) in &geminis {
            let what = format!("{what} stream={stream}");
            let before = seen(&floor);
            let (status, response) =
                send_with(&floor.app(), gemini(stream), &[], &body(&marked("hello"))).await;
            if floor_leaked_since(&floor, before) {
                misses.0.push(format!(
                    "LEAK {what}: the marker reached the upstream ({status})"
                ));
            } else if status != StatusCode::FORBIDDEN && !status.is_success() {
                misses.0.push(format!(
                    "BLOCK MISS {what}: {status} {}",
                    truncated(&response)
                ));
            }
            misses.note(
                floor
                    .probe_dispatches(
                        &format!("{what} control"),
                        gemini(stream),
                        &[],
                        &body("hello there"),
                    )
                    .await,
            );
        }
    }
    floor
        .pair(
            &mut misses,
            "rerank third document",
            "/v1/rerank",
            &json!({ "model": "fixture-rerank", "query": "q",
                "documents": ["a", "b", marked("c")] }),
            &json!({ "model": "fixture-rerank", "query": "q",
                "documents": ["a", "b", "c"] }),
        )
        .await;
    floor
        .pair(
            &mut misses,
            "embedding input after 15 KB of benign padding",
            "/v1/embeddings",
            &json!({ "model": "fixture-embed",
                "input": ["ok", format!("{}{}", padding(15_000), marked("x"))] }),
            &json!({ "model": "fixture-embed",
                "input": ["ok", format!("{}x", padding(15_000))] }),
        )
        .await;
    misses.assert_none();
}

// ── fallback chains ──────────────────────────────────────────────────────────

/// A primary that fails and a capturing spare: a marked body reaches neither,
/// and a benign one fails over to the spare.
#[tokio::test]
async fn probe_fallback_chain_never_carries_the_marker() {
    let mut config = floor_config(FLOOR);
    config.routing.fallback_chain = vec![ProviderId::from(FLOOR), ProviderId::from(SPARE)];
    let (mut state, audit) = floor_state(GatewayCustody::Fleet, config);
    let (primary, primary_calls) = StubProvider::new(FLOOR, Mode::Fail);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let upstream = Upstream::default();
    let models = Arc::new(Mutex::new(Vec::new()));
    state
        .provider_runtime
        .register_for_test(Arc::new(CaptureProvider {
            name: SPARE,
            upstream: upstream.clone(),
            models: Arc::clone(&models),
            answers: HashMap::new(),
        }) as Arc<dyn Provider>);
    let floor = Floor {
        state: Arc::new(state),
        upstream,
        models,
        audit,
    };
    let mut misses = Misses::default();
    let shapes = [
        user_chat(json!(marked("hello"))),
        with(
            user_chat(json!("hello")),
            "models",
            json!(["fixture-model", "fixture-spare"]),
        ),
    ];
    let marked_models = with(
        user_chat(json!(marked("hello"))),
        "models",
        json!(["fixture-model", "fixture-spare"]),
    );
    for (what, body) in [
        ("fallback chain", &shapes[0]),
        ("request-level models list", &marked_models),
    ] {
        let before = primary_calls.load(Ordering::SeqCst);
        misses.note(floor.probe_blocked(what, CHAT, &[], body).await);
        if primary_calls.load(Ordering::SeqCst) != before {
            misses
                .0
                .push(format!("BLOCK MISS {what}: the failing primary was called"));
        }
    }
    let before = primary_calls.load(Ordering::SeqCst);
    misses.note(
        floor
            .probe_dispatches("fallback control", CHAT, &[], &shapes[1])
            .await,
    );
    if primary_calls.load(Ordering::SeqCst) == before {
        misses
            .0
            .push("VACUOUS fallback control: the primary never ran".to_owned());
    }
    misses.assert_none();
}

// ── media, speech and transcription ──────────────────────────────────────────

#[tokio::test]
async fn probe_media_vendor_nested_shapes_refuse_the_marker() {
    let mut misses = Misses::default();
    for (kind, model) in [
        (Vendor::Replicate, "owner/name"),
        (Vendor::Fal, "fal-ai/flux"),
    ] {
        let floor = MediaFloor::new(kind).await;
        let shapes: Vec<(&str, Box<dyn Fn(&str) -> Value>)> = vec![
            (
                "input array of objects",
                Box::new(move |text| {
                    json!({ "model": model, "input": {
                        "prompt": "a cat", "regions": [{ "box": [0, 0, 1, 1], "caption": text }]
                    }})
                }),
            ),
            (
                "input five levels deep",
                Box::new(move |text| {
                    json!({ "model": model, "input": {
                        "prompt": "a cat", "a": { "b": [{ "c": { "d": [text] } }] }
                    }})
                }),
            ),
            (
                "input stringified JSON",
                Box::new(move |text| {
                    json!({ "model": model, "input": {
                        "prompt": "a cat", "config": json!({ "style": { "note": text } }).to_string()
                    }})
                }),
            ),
            (
                "input prompt after 100 KB of benign padding",
                Box::new(move |text| {
                    json!({ "model": model, "input": {
                        "prompt": format!("{}{text}", padding(100_000))
                    }})
                }),
            ),
            (
                "top-level unknown field",
                Box::new(
                    move |text| json!({ "model": model, "prompt": "a cat", "style_notes": [text] }),
                ),
            ),
        ];
        for (what, body) in &shapes {
            let what = format!("{model} {what}");
            let mark = floor.mark();
            let outcome = send(
                &floor.app,
                Method::POST,
                IMAGES,
                Some(TENANT),
                &body(&marked("x")),
            )
            .await;
            misses.note(
                blocked_miss(
                    &what,
                    outcome,
                    &floor.vendor.upstream,
                    upstream_leaked_since(&floor.vendor.upstream, mark.calls),
                    &floor.audit,
                    mark,
                )
                .await,
            );
            let mark = floor.mark();
            let outcome = send(&floor.app, Method::POST, IMAGES, Some(TENANT), &body("x")).await;
            misses.note(dispatch_miss(
                &format!("{what} control"),
                outcome,
                &floor.vendor.upstream,
                mark,
            ));
        }
    }
    misses.assert_none();
}

#[tokio::test]
async fn probe_speech_shapes_refuse_the_marker() {
    let floor = Floor::new(|_| {});
    let mut misses = Misses::default();
    let base = |input: String| json!({ "model": "fixture-tts", "input": input, "voice": "alloy" });
    floor
        .pair(
            &mut misses,
            "speech input after 3 KB of benign padding",
            SPEECH,
            &base(format!("{}{}", padding(3_000), marked("x"))),
            &base(format!("{}x", padding(3_000))),
        )
        .await;
    floor
        .pair(
            &mut misses,
            "speech voice object",
            SPEECH,
            &with(
                base("Hello".into()),
                "voice",
                json!({ "id": "alloy", "note": marked("x") }),
            ),
            &with(
                base("Hello".into()),
                "voice",
                json!({ "id": "alloy", "note": "calm" }),
            ),
        )
        .await;
    floor
        .pair(
            &mut misses,
            "speech unknown nested field",
            SPEECH,
            &with(
                base("Hello".into()),
                "extra",
                json!({ "style": [{ "cue": marked("x") }] }),
            ),
            &with(
                base("Hello".into()),
                "extra",
                json!({ "style": [{ "cue": "calm" }] }),
            ),
        )
        .await;
    misses.assert_none();
}

async fn post_multipart(
    floor: &Floor,
    fields: &[(&str, &str)],
    filename: &str,
) -> (StatusCode, Value) {
    let boundary = "probe-boundary";
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(b"RIFF0000WAVEfmt ");
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    read(
        floor
            .app()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/audio/transcriptions")
                    .header(
                        "content-type",
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .header("authorization", format!("Bearer {TENANT}"))
                    .extension(loopback())
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn probe_transcription_fields_refuse_the_marker() {
    let floor = Floor::new(|_| {});
    let mut misses = Misses::default();
    let padded_prompt = format!("{}{}", padding(3_900).get(..3_900).unwrap(), marked(""));
    let benign_prompt = padding(3_900).get(..3_900).unwrap().to_owned();
    let cases: [(&str, Vec<(&str, &str)>, &str, Vec<(&str, &str)>, &str); 3] = [
        (
            "transcription model (example key)",
            vec![("model", FAKE_AWS_KEY)],
            "a.wav",
            vec![("model", "fixture-stt")],
            "a.wav",
        ),
        (
            "transcription filename",
            vec![("model", "fixture-stt")],
            "RYU_TEST_LEXICON.wav",
            vec![("model", "fixture-stt")],
            "meeting.wav",
        ),
        (
            "transcription prompt after benign padding",
            vec![("model", "fixture-stt"), ("prompt", padded_prompt.as_str())],
            "a.wav",
            vec![("model", "fixture-stt"), ("prompt", benign_prompt.as_str())],
            "a.wav",
        ),
    ];
    for (what, marked_fields, marked_file, benign_fields, benign_file) in &cases {
        let mark = floor.mark();
        let before = seen(&floor);
        let outcome = post_multipart(&floor, marked_fields, marked_file).await;
        misses.note(
            blocked_miss(
                what,
                outcome,
                &floor.upstream,
                floor_leaked_since(&floor, before),
                &floor.audit,
                mark,
            )
            .await,
        );
        let mark = floor.mark();
        let outcome = post_multipart(&floor, benign_fields, benign_file).await;
        misses.note(dispatch_miss(
            &format!("{what} control"),
            outcome,
            &floor.upstream,
            mark,
        ));
    }
    misses.assert_none();
}

// ── evals: judge calls and template variables ────────────────────────────────

#[tokio::test]
async fn probe_eval_judge_and_vars_refuse_the_marker() {
    let floor = Floor::new(|_| {});
    let mut misses = Misses::default();
    let score = |response: String, rubric: String| {
        json!({ "model": "fixture-model", "prompt": "Say hi", "response": response,
            "assertions": [{ "kind": "llm_judge", "rubric": rubric }] })
    };
    let run_vars = |persona: String| {
        json!({ "model": "fixture-model", "system_prompt": "You are {{persona}}.",
            "dataset": [{ "prompt": "hello {{name}}", "expected": "ok",
                "vars": { "persona": persona, "name": "Ada" } }] })
    };
    let run_precomputed = |output: String| {
        json!({ "model": "fixture-model", "dataset": [{ "prompt": "Say hi",
            "provider_output": output,
            "assertions": [{ "kind": "llm_judge", "rubric": "Is it polite?" }] }] })
    };
    let cases: Vec<(&str, &str, Value, Value)> = vec![
        (
            "score response reaches the judge",
            "/v1/evals/score",
            score(marked("hi"), "Is it polite?".into()),
            score("hi".into(), "Is it polite?".into()),
        ),
        (
            "score rubric reaches the judge",
            "/v1/evals/score",
            score("hi".into(), marked("Is it polite?")),
            score("hi".into(), "Is it polite?".into()),
        ),
        (
            "run vars substituted into the system prompt",
            "/v1/evals/run",
            run_vars(marked("helpful")),
            run_vars("helpful".into()),
        ),
        (
            "run precomputed output reaches the judge",
            "/v1/evals/run",
            run_precomputed(marked("hi")),
            run_precomputed("hi".into()),
        ),
    ];
    for (what, uri, marked_body, benign_body) in &cases {
        let mark = floor.mark();
        let before = seen(&floor);
        let (status, body) = floor.post(uri, marked_body).await;
        let failures = failures_reach(&floor.audit, mark.failures + 1).await;
        let leaked = floor_leaked_since(&floor, before);
        if floor.upstream.count() != mark.calls || leaked {
            misses.0.push(format!(
                "BLOCK MISS {what}: {} new upstream call(s), leak={leaked} ({status} {})",
                floor.upstream.count() - mark.calls,
                truncated(&body)
            ));
        }
        if failures != mark.failures + 1 {
            misses.0.push(format!(
                "BLOCK MISS {what}: {} new failure audit row(s)",
                failures - mark.failures
            ));
        }
        let mark = floor.mark();
        let outcome = floor.post(uri, benign_body).await;
        misses.note(dispatch_miss(
            &format!("{what} control"),
            outcome,
            &floor.upstream,
            mark,
        ));
    }
    misses.assert_none();
}

// ── web fetch ────────────────────────────────────────────────────────────────

mod fetch_fixture {
    use super::*;
    use ryu_gw_credentials::web::WebProviderKind;
    use ryu_gw_providers::web::{FetchedPage, WebFetchOutput, WebFetchRequest, WebServiceUsage};

    /// A Tavily stand-in that records each fetched URL as written and
    /// percent-decoded.
    pub(super) struct FetchCapture {
        pub(super) upstream: Upstream,
    }

    impl Provider for FetchCapture {
        fn name(&self) -> &'static str {
            WebProviderKind::Tavily.descriptor().provider_id
        }
        fn web_descriptor(
            &self,
        ) -> Option<&'static ryu_gw_credentials::web::WebProviderDescriptor> {
            Some(WebProviderKind::Tavily.descriptor())
        }
        fn complete<'a>(&'a self, _: &'a str, _: &'a Value) -> ProviderFuture<'a, Value> {
            Box::pin(async { Err(ProviderError::Provider("not chat".into())) })
        }
        fn complete_stream<'a>(&'a self, _: &'a str, _: &'a Value) -> ProviderFuture<'a, Body> {
            Box::pin(async { Err(ProviderError::Provider("not chat".into())) })
        }
        fn web_fetch_for_session<'a>(
            &'a self,
            request: &'a WebFetchRequest,
            _: Option<&'a str>,
        ) -> ProviderFuture<'a, WebFetchOutput> {
            let url = request.url().as_str().to_owned();
            self.upstream
                .push(format!("{url} {}", percent_decoded(&url)));
            let format = request.format();
            Box::pin(async move {
                Ok(WebFetchOutput {
                    results: vec![FetchedPage {
                        url,
                        title: Some("Page".into()),
                        content: "readable".into(),
                        format,
                    }],
                    usage: WebServiceUsage {
                        requests: 1,
                        ..Default::default()
                    },
                })
            })
        }
    }

    fn percent_decoded(text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            let hex = bytes
                .get(index + 1..index + 3)
                .and_then(|digits| std::str::from_utf8(digits).ok())
                .and_then(|digits| u8::from_str_radix(digits, 16).ok());
            match (bytes[index], hex) {
                (b'%', Some(byte)) => {
                    out.push(byte);
                    index += 3;
                }
                (byte, _) => {
                    out.push(byte);
                    index += 1;
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    pub(super) fn configure(config: &mut GatewayConfig) {
        config.providers.web = serde_json::from_value(
            json!({ "tavily": { "mode": "accounts", "accounts": [{ "api_key": "fixture-web-key" }] } }),
        )
        .unwrap();
        config.routing.web.fetch = Some(crate::web_config::WebBinding::Provider {
            provider: WebProviderKind::Tavily,
        });
    }
}

/// The fetch URL is screened as written. Web screening is Phase 2 (B26), so
/// this probe does not require an audit row (the suite already pins that gap
/// for web search).
#[tokio::test]
async fn probe_web_fetch_url_refuses_the_marker() {
    let mut config = floor_config(FLOOR);
    fetch_fixture::configure(&mut config);
    let mut web_key = api_key(WEB_KEY, "web", false);
    web_key.org_id = None;
    config.auth.api_keys.push(web_key);
    let (mut state, _audit) = floor_state(GatewayCustody::Fleet, config);
    let upstream = Upstream::default();
    state
        .provider_runtime
        .register_for_test(Arc::new(fetch_fixture::FetchCapture {
            upstream: upstream.clone(),
        }));
    let app = crate::api::router(Arc::new(state));
    let mut misses = Misses::default();
    let fetch = |url: &str| json!({ "url": url });
    for (what, url) in [
        ("query", format!("https://example.com/docs?q={MARKER}")),
        ("path", format!("https://example.com/{MARKER}/docs")),
        (
            "percent-encoded query",
            "https://example.com/docs?q=%52YU_TEST_LEXICON".to_owned(),
        ),
        (
            "percent-encoded example key",
            "https://example.com/docs?k=AKIA%49OSFODNN7EXAMPLE".to_owned(),
        ),
    ] {
        let before = upstream.count();
        let (status, body) = send(
            &app,
            Method::POST,
            "/v1/web/fetch",
            Some(WEB_KEY),
            &fetch(&url),
        )
        .await;
        let leaked = upstream_leaked_since(&upstream, before);
        if status != StatusCode::FORBIDDEN || upstream.count() != before || leaked {
            misses.0.push(format!(
                "BLOCK MISS web fetch {what}: {status}, {} new upstream call(s), leak={leaked}: {}",
                upstream.count() - before,
                truncated(&body)
            ));
        }
    }
    let before = upstream.count();
    let (status, body) = send(
        &app,
        Method::POST,
        "/v1/web/fetch",
        Some(WEB_KEY),
        &fetch("https://example.com/docs?q=rust"),
    )
    .await;
    if !status.is_success() || upstream.count() == before {
        misses.0.push(format!(
            "CONTROL MISS web fetch: {status} {}",
            truncated(&body)
        ));
    }
    misses.assert_none();
}
