use super::*;

// ── Fake Core ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub(super) enum Scenario {
    /// Text, reasoning, and a full tool call, then `[DONE]`.
    TextAndTool,
    /// One text delta, then the stream stays open until the test ends.
    Hang,
    /// A tool-approval pause; the reply text depends on the decision.
    Permission,
    /// A tool-approval pause raised by one of Core's own gates: no
    /// `toolCallId`, a gate id as `kind`, and the title under `fields`.
    CoreGatePermission,
    /// A tool call whose progress arrives as Core's `{status, output}` wrapper
    /// before the final result.
    ToolProgress,
    /// A blocking Question card; the stream resumes once it is answered.
    Question,
    /// The same card, but Core no longer waits on it when the answer arrives
    /// (`resolved: false`).
    StaleQuestion,
    /// An agent's own question tool that Core reshaped into a Question card
    /// (no answer waiter), re-sent once when its arguments fill in.
    AgentQuestion,
}

#[derive(Default)]
pub(super) struct Recorded {
    pub(super) chat_bodies: Vec<Value>,
    pub(super) cancels: Vec<String>,
    pub(super) permissions: Vec<Value>,
    pub(super) questions: Vec<Value>,
}

#[derive(Clone)]
pub(super) struct FakeCore {
    scenario: Scenario,
    pub(super) recorded: Arc<Mutex<Recorded>>,
    permission_answered: Arc<Notify>,
    question_answered: Arc<Notify>,
}

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(&format!("Bearer {TOKEN}"))
}

fn sse(frame: Value) -> Bytes {
    Bytes::from(format!("data: {frame}\n\n"))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn agents(headers: HeaderMap) -> Response {
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some("Bearer policy-limited")
    {
        // A valid credential whose role lacks the permission: Core says why.
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: agent.view" })),
        )
            .into_response();
    }
    if !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({ "agents": [
        { "id": "ryu", "name": "Ryu", "enabled": true },
        { "id": "coder", "name": "Coder", "description": "Writes code" }
    ]}))
    .into_response()
}

async fn conversation(Path(id): Path<String>) -> Response {
    if id != "known-conversation" {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
    }
    Json(json!({
        "id": id,
        "agent_id": "coder",
        "messages": [
            { "id": "m1", "role": "user", "content": "earlier question" },
            { "id": "m2", "role": "assistant", "content": "earlier answer" }
        ]
    }))
    .into_response()
}

async fn cancel(State(core): State<FakeCore>, Json(body): Json<Value>) -> Json<Value> {
    let id = body["conversation_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    core.recorded.lock().unwrap().cancels.push(id);
    Json(json!({ "cancelled": true }))
}

async fn permission(State(core): State<FakeCore>, Json(body): Json<Value>) -> Json<Value> {
    core.recorded.lock().unwrap().permissions.push(body);
    core.permission_answered.notify_one();
    Json(json!({ "resolved": true }))
}

async fn question(State(core): State<FakeCore>, Json(body): Json<Value>) -> Json<Value> {
    core.recorded.lock().unwrap().questions.push(body);
    core.question_answered.notify_one();
    Json(json!({ "resolved": !matches!(core.scenario, Scenario::StaleQuestion) }))
}

async fn chat_stream(
    State(core): State<FakeCore>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    core.recorded.lock().unwrap().chat_bodies.push(body);
    let (tx, rx) = mpsc::channel::<Bytes>(32);
    let scenario = core.scenario;
    tokio::spawn(async move {
        let send = |frame: Value| {
            let tx = tx.clone();
            async move {
                let _ = tx.send(sse(frame)).await;
            }
        };
        send(json!({ "type": "start" })).await;
        match scenario {
            Scenario::TextAndTool => {
                send(json!({ "type": "reasoning-delta", "id": "r", "delta": "Considering" })).await;
                send(json!({ "type": "text-delta", "id": "t", "delta": "Hello" })).await;
                send(json!({ "type": "tool-input-start", "toolCallId": "c1", "toolName": "Bash" }))
                    .await;
                send(json!({
                    "type": "tool-input-available", "toolCallId": "c1", "toolName": "Bash",
                    "input": { "command": "ls" }
                }))
                .await;
                send(json!({
                    "type": "tool-output-available", "toolCallId": "c1", "output": "file.txt"
                }))
                .await;
                send(json!({ "type": "text-delta", "id": "t2", "delta": " world" })).await;
                send(json!({ "type": "finish" })).await;
                let _ = tx.send(Bytes::from("data: [DONE]\n\n")).await;
            }
            Scenario::Hang => {
                send(json!({ "type": "text-delta", "id": "t", "delta": "partial" })).await;
                // Hold the stream open; the ACP server must not wait for it.
                tokio::time::sleep(Duration::from_secs(600)).await;
            }
            Scenario::Permission | Scenario::CoreGatePermission => {
                let tool_call = if matches!(scenario, Scenario::Permission) {
                    json!({ "toolCallId": "c7", "title": "Run rm -rf build", "kind": "execute" })
                } else {
                    json!({
                        "title": "delete the build folder",
                        "kind": "files.delete",
                        "rawInput": { "path": "build" },
                        "fields": { "title": "delete the build folder" }
                    })
                };
                send(json!({ "type": "data-ryu-permission", "data": {
                    "requestId": "perm-1",
                    "toolCall": tool_call,
                    "options": [
                        { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                        { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
                    ]
                }}))
                .await;
                core.permission_answered.notified().await;
                let decision = core
                    .recorded
                    .lock()
                    .unwrap()
                    .permissions
                    .last()
                    .and_then(|body| body["option_id"].as_str().map(str::to_owned));
                let text = if decision.as_deref() == Some("allow") {
                    "ran"
                } else {
                    "denied"
                };
                send(json!({ "type": "text-delta", "id": "t", "delta": text })).await;
                let _ = tx.send(Bytes::from("data: [DONE]\n\n")).await;
            }
            Scenario::ToolProgress => {
                send(json!({
                    "type": "tool-input-available", "toolCallId": "c1", "toolName": "Bash",
                    "input": { "command": "make" }
                }))
                .await;
                // Core's real frame for a non-final ACP `tool_call_update`.
                send(json!({
                    "type": "tool-output-available", "toolCallId": "c1",
                    "output": { "status": "in_progress", "output": null }
                }))
                .await;
                send(json!({
                    "type": "tool-output-available", "toolCallId": "c1",
                    "output": { "status": "completed", "output": "built" }
                }))
                .await;
                let _ = tx.send(Bytes::from("data: [DONE]\n\n")).await;
            }
            Scenario::AgentQuestion => {
                for _ in 0..2 {
                    send(json!({
                        "type": "tool-input-available", "toolCallId": "c9", "toolName": "Question",
                        "input": {
                            "toolCallId": "c9",
                            "questions": [{
                                "id": "q-0", "title": "Pick one", "kind": "single",
                                "options": [{ "id": "a", "label": "A" }]
                            }],
                            "totalQuestions": 1, "questionIndex": 1
                        }
                    }))
                    .await;
                }
                send(json!({
                    "type": "tool-output-available", "toolCallId": "c9",
                    "output": { "status": "completed", "output": "A" }
                }))
                .await;
                send(json!({ "type": "text-delta", "id": "t", "delta": "done" })).await;
                let _ = tx.send(Bytes::from("data: [DONE]\n\n")).await;
            }
            Scenario::Question | Scenario::StaleQuestion => {
                send(json!({
                    "type": "tool-input-available", "toolCallId": "q1", "toolName": "Question",
                    "input": {
                        "toolCallId": "q1",
                        "async": false,
                        "questions": [
                            {
                                "id": "q-0", "title": "Which database?", "kind": "single",
                                "options": [
                                    { "id": "pg", "label": "Postgres" },
                                    { "id": "sqlite", "label": "SQLite" }
                                ]
                            },
                            { "id": "q-1", "title": "Anything else?", "kind": "text", "options": [] }
                        ]
                    }
                }))
                .await;
                core.question_answered.notified().await;
                send(json!({
                    "type": "tool-output-available", "toolCallId": "q1",
                    "output": { "status": "completed", "output": { "answers": [] } }
                }))
                .await;
                send(json!({ "type": "text-delta", "id": "t", "delta": "thanks" })).await;
                let _ = tx.send(Bytes::from("data: [DONE]\n\n")).await;
            }
        }
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|bytes| (Ok::<_, std::convert::Infallible>(bytes), rx))
    });
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(stream))
        .unwrap()
}

pub(super) async fn start_core(scenario: Scenario) -> (String, FakeCore) {
    let core = FakeCore {
        scenario,
        recorded: Arc::default(),
        permission_answered: Arc::new(Notify::new()),
        question_answered: Arc::new(Notify::new()),
    };
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/agents", get(agents))
        .route("/api/conversations/:id", get(conversation))
        .route("/api/chat/stream", post(chat_stream))
        .route("/api/chat/cancel", post(cancel))
        .route("/api/chat/permission", post(permission))
        .route("/api/chat/question", post(question))
        .with_state(core.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, core)
}
