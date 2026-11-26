//! The two tools end to end, against an ephemeral stand-in for Core.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::{
    extract::State,
    http::{StatusCode, Uri},
    response::IntoResponse,
    Json, Router,
};
use serde_json::json;

use super::*;

const CHAT: &str = "conv-1";

/// What the stand-in answers per path, and which paths were asked.
#[derive(Clone, Default)]
struct StandIn {
    answers: Arc<BTreeMap<&'static str, (u16, Value)>>,
    asked: Arc<Mutex<Vec<String>>>,
}

async fn answer(State(stand_in): State<StandIn>, uri: Uri) -> axum::response::Response {
    let path = uri.path().to_owned();
    stand_in.asked.lock().unwrap().push(path.clone());
    match stand_in.answers.get(path.as_str()) {
        Some((status, body)) => {
            (StatusCode::from_u16(*status).unwrap(), Json(body.clone())).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Serve `answers` on a free loopback port. Returns the base URL and the list
/// of paths asked so far.
async fn serve(answers: BTreeMap<&'static str, (u16, Value)>) -> (String, Arc<Mutex<Vec<String>>>) {
    let stand_in = StandIn {
        answers: Arc::new(answers),
        asked: Arc::default(),
    };
    let asked = stand_in.asked.clone();
    let app = Router::new().fallback(answer).with_state(stand_in);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), asked)
}

/// A made-up credential with a provider token shape, built at run time so no
/// literal in this file has that shape.
fn fake_provider_token() -> String {
    format!("sk-{}", "fake0123".repeat(4))
}

fn fake_node_credential() -> String {
    format!("ryu-node-{}", "fake4567".repeat(4))
}

/// A healthy node whose answers are laced with things that must not travel.
fn node_answers() -> BTreeMap<&'static str, (u16, Value)> {
    let token = fake_provider_token();
    let mut answers = BTreeMap::new();
    answers.insert(
        "/api/version",
        (
            200,
            json!({
                "ryu_version": "0.9.0",
                "platform": "windows-x86_64",
                "components": [{ "name": "gateway", "version": "0.9.0" }],
            }),
        ),
    );
    answers.insert(
        "/api/system/status",
        (
            200,
            json!({
                "gateway": { "reachable": false },
                "engine": { "active": "llamacpp", "running": true },
                "sidecars": [
                    { "name": "gateway", "running": false, "lazy": false,
                      "failure_reason": format!(
                          "spawn failed in C:\\Users\\fakeperson\\ryu for fake.person@example.com \
                           with api_key={token}"
                      ) },
                    { "name": "search", "running": true, "lazy": false },
                ],
            }),
        ),
    );
    answers.insert("/api/safe-mode", (200, json!({ "enabled": false })));
    answers.insert(
        "/api/gateway/doctor",
        (
            200,
            json!({ "findings": [{
                "checkId": "provider.key",
                "severity": "warning",
                "summary": "A provider has no key",
                "detail": format!("The request header was Authorization: Bearer {token}"),
                "recommendedAction": "Add the key in Settings.",
            }] }),
        ),
    );
    answers.insert("/api/plugins/doctor", (200, json!({ "findings": [] })));
    answers.insert(
        "/api/background/processes",
        (
            200,
            json!({ "processes": [{
                "label": "dev server",
                "kind": "shell",
                "running": false,
                "exit_code": 1,
                "command": format!("deploy --token {token}"),
                "cwd": "C:\\Users\\fakeperson\\private-project",
                "pid": 4242,
            }] }),
        ),
    );
    answers.insert(
        "/api/runs",
        (
            200,
            json!({ "runs": [
                { "id": "conv-other", "title": "fake title of another chat",
                  "agent_id": "agent-other", "run_status": "running" },
                { "id": CHAT, "title": "fake title of this chat",
                  "cwd": "C:\\Users\\fakeperson\\work",
                  "agent_id": "agent-1", "run_status": "failed" },
            ] }),
        ),
    );
    answers.insert(
        "/api/runs/conv-1/trace",
        (
            200,
            json!({ "spans": [
                { "kind": "model_call", "name": "fake-model", "status": "ok",
                  "started_at": 100, "error": null },
                { "kind": "tool_call", "name": "web.search", "status": "error",
                  "started_at": 200,
                  "error": format!("401 from provider, sent password=hunter2fake and {token}"),
                  "input": { "query": "fake captured input that must not travel" } },
                { "kind": "tool_call", "name": "notify.send", "status": "error",
                  "started_at": 300, "error": "the channel is not connected" },
            ] }),
        ),
    );
    answers
}

fn loopback<'a>(http: &'a reqwest::Client, base: &str, acting_user: Option<&str>) -> Loopback<'a> {
    Loopback {
        http,
        base: base.to_owned(),
        node_token: Some(fake_node_credential()),
        acting_user: acting_user.map(str::to_owned),
    }
}

fn asked_paths(asked: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    let mut paths = asked.lock().unwrap().clone();
    paths.sort();
    paths
}

fn check<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["id"] == id)
        .unwrap_or_else(|| panic!("no check {id} in {report}"))
}

/// Nothing a route answered that could identify a person or open an account
/// may be anywhere in a result.
fn assert_nothing_private(report: &Value) {
    let text = report.to_string();
    for private in [
        fake_provider_token(),
        fake_node_credential(),
        "hunter2fake".to_owned(),
        "fake.person@example.com".to_owned(),
        "fakeperson".to_owned(),
        "private-project".to_owned(),
        "deploy --".to_owned(),
        "4242".to_owned(),
        "fake title".to_owned(),
        "fake captured input".to_owned(),
        "agent-other".to_owned(),
    ] {
        assert!(!text.contains(&private), "`{private}` leaked into {text}");
    }
}

#[test]
fn both_tools_are_read_only_and_take_no_arguments() {
    let tools = tools();
    let ids: Vec<&str> = tools.iter().map(|tool| tool.id.as_str()).collect();
    assert_eq!(ids, [SNAPSHOT_TOOL_ID, RECENT_ERRORS_TOOL_ID]);
    for tool in &tools {
        assert_eq!(tool.server, SERVER_NAME);
        assert_eq!(tool.id, format!("{SERVER_NAME}.{}", tool.name));
        let annotations = tool.annotations.as_ref().unwrap();
        assert_eq!(annotations["readOnlyHint"], true);
        assert_eq!(annotations["destructiveHint"], false);
        let schema = tool.input_schema.as_ref().unwrap();
        assert_eq!(schema["properties"], json!({}));
        assert_eq!(schema["additionalProperties"], false);
        assert!(tool.description.as_deref().is_some_and(|d| !d.is_empty()));
    }
}

#[tokio::test]
async fn a_node_snapshot_reports_the_stopped_gateway_and_leaks_nothing_private() {
    let (base, asked) = serve(node_answers()).await;
    let http = reqwest::Client::new();
    let report = dispatch(
        "snapshot",
        json!({}),
        &loopback(&http, &base, None),
        Scope::Node,
        Some(CHAT),
    )
    .await
    .unwrap();

    assert_eq!(report["surface"], "core");
    assert_eq!(report["scope"], "node");
    assert_eq!(report["version"], "0.9.0");
    let gateway = check(&report, "gateway.reachable");
    assert_eq!(gateway["status"], "fail");
    assert!(gateway["fix"].as_str().is_some_and(|fix| !fix.is_empty()));
    // Problems come first.
    assert_eq!(report["checks"][0]["status"], "fail");
    assert_eq!(check(&report, "services.failed")["status"], "warn");
    assert_eq!(
        check(&report, "gateway.doctor.provider.key")["status"],
        "warn"
    );
    assert_eq!(check(&report, "apps.doctor")["status"], "pass");
    assert_eq!(check(&report, "background.processes")["status"], "warn");
    assert_eq!(check(&report, "conversation.runs")["status"], "warn");
    assert_eq!(report["conversation"]["runStatus"], "failed");
    assert_eq!(report["conversation"]["agentId"], "agent-1");
    assert_eq!(report["conversation"]["faults"], 2);
    assert_eq!(report["backgroundProcesses"][0]["label"], "dev server");
    assert_eq!(report["backgroundProcesses"][0]["exitCode"], 1);
    let skipped: Vec<&str> = report["notChecked"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["id"].as_str())
        .collect();
    assert_eq!(skipped, ["updates", "logs", "credentials"]);
    assert_nothing_private(&report);

    assert_eq!(
        asked_paths(&asked),
        [
            "/api/background/processes",
            "/api/gateway/doctor",
            "/api/plugins/doctor",
            "/api/runs",
            "/api/runs/conv-1/trace",
            "/api/safe-mode",
            "/api/system/status",
            "/api/version",
        ]
    );
}

#[tokio::test]
async fn a_conversation_snapshot_never_asks_for_node_status() {
    let (base, asked) = serve(node_answers()).await;
    let http = reqwest::Client::new();
    let report = dispatch(
        "snapshot",
        Value::Null,
        &loopback(&http, &base, Some("user-1")),
        Scope::Conversation,
        Some(CHAT),
    )
    .await
    .unwrap();

    assert_eq!(report["scope"], "conversation");
    assert_eq!(
        asked_paths(&asked),
        ["/api/runs", "/api/runs/conv-1/trace", "/api/version"]
    );
    assert!(report.get("backgroundProcesses").is_none());
    let ids: Vec<&str> = report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|check| check["id"].as_str())
        .collect();
    assert_eq!(ids, ["conversation.runs", "core.version"]);
    assert!(report["notChecked"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["id"] == "node"));
    assert_nothing_private(&report);
}

#[tokio::test]
async fn recent_errors_lists_the_faults_newest_first_and_redacts_them() {
    let (base, asked) = serve(node_answers()).await;
    let http = reqwest::Client::new();
    let report = dispatch(
        "recent_errors",
        json!({}),
        &loopback(&http, &base, None),
        Scope::Node,
        Some(CHAT),
    )
    .await
    .unwrap();

    assert_eq!(asked_paths(&asked), ["/api/runs/conv-1/trace"]);
    // The tool reads one chat, whatever scope the caller has.
    assert_eq!(report["scope"], "conversation");
    let faults = report["faults"].as_array().unwrap();
    assert_eq!(faults.len(), 2);
    assert_eq!(faults[0]["name"], "notify.send");
    assert_eq!(faults[0]["message"], "the channel is not connected");
    assert_eq!(faults[1]["name"], "web.search");
    assert!(faults[1]["message"]
        .as_str()
        .is_some_and(|message| message.starts_with("401 from provider")));
    assert_eq!(check(&report, "conversation.runs")["status"], "warn");
    assert_nothing_private(&report);
}

#[tokio::test]
async fn a_chat_the_person_may_not_read_yields_no_runs_and_no_faults() {
    let mut answers = node_answers();
    answers.insert("/api/runs", (200, json!({ "runs": [] })));
    answers.insert("/api/runs/conv-1/trace", (404, json!({})));
    let (base, _asked) = serve(answers).await;
    let http = reqwest::Client::new();
    let caller = loopback(&http, &base, Some("user-2"));

    let snapshot = dispatch(
        "snapshot",
        json!({}),
        &caller,
        Scope::Conversation,
        Some(CHAT),
    )
    .await
    .unwrap();
    assert_eq!(check(&snapshot, "conversation.runs")["status"], "skip");
    assert!(snapshot.get("conversation").is_none());

    let errors = dispatch(
        "recent_errors",
        json!({}),
        &caller,
        Scope::Conversation,
        Some(CHAT),
    )
    .await
    .unwrap();
    assert_eq!(check(&errors, "conversation.runs")["status"], "skip");
    assert!(errors.get("faults").is_none());
}

#[tokio::test]
async fn a_route_that_refuses_becomes_a_skipped_check() {
    let mut answers = node_answers();
    answers.insert("/api/gateway/doctor", (403, json!({})));
    answers.insert("/api/system/status", (503, json!({})));
    let (base, _asked) = serve(answers).await;
    let http = reqwest::Client::new();
    let report = dispatch(
        "snapshot",
        json!({}),
        &loopback(&http, &base, None),
        Scope::Node,
        Some(CHAT),
    )
    .await
    .unwrap();
    assert_eq!(check(&report, "gateway.doctor")["status"], "skip");
    assert_eq!(check(&report, "core.status")["status"], "skip");
    assert_eq!(report["summary"]["skip"], 2);
}

#[tokio::test]
async fn without_a_readable_chat_no_trace_is_asked_for() {
    let (base, asked) = serve(node_answers()).await;
    let http = reqwest::Client::new();
    let caller = loopback(&http, &base, None);
    for chat in [
        None,
        Some(""),
        Some("  "),
        Some("../version"),
        Some("a/b"),
        Some("a?b=c"),
    ] {
        let report = dispatch("recent_errors", json!({}), &caller, Scope::Node, chat)
            .await
            .unwrap();
        assert!(report.get("faults").is_none(), "{chat:?}");
        assert_eq!(report["notChecked"][0]["id"], "conversation", "{chat:?}");
    }
    assert!(asked_paths(&asked).is_empty());

    let report = dispatch("snapshot", json!({}), &caller, Scope::Conversation, None)
        .await
        .unwrap();
    assert_eq!(asked_paths(&asked), ["/api/version"]);
    assert!(report["notChecked"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["id"] == "conversation"));
}

#[tokio::test]
async fn any_argument_is_refused_before_anything_is_read() {
    let (base, asked) = serve(node_answers()).await;
    let http = reqwest::Client::new();
    let caller = loopback(&http, &base, None);
    for (tool, arguments) in [
        ("snapshot", json!({ "conversation_id": "conv-other" })),
        ("recent_errors", json!({ "conversation_id": "conv-other" })),
        ("snapshot", json!(["conv-other"])),
        ("recent_errors", json!("conv-other")),
    ] {
        let refusal = dispatch(tool, arguments, &caller, Scope::Node, Some(CHAT))
            .await
            .expect_err("an argument must be refused");
        assert!(
            refusal.to_string().contains("takes no arguments"),
            "{refusal}"
        );
    }
    let unknown = dispatch("delete_logs", json!({}), &caller, Scope::Node, Some(CHAT))
        .await
        .expect_err("an unknown tool must be refused");
    assert!(unknown.to_string().contains("unknown diagnostics tool"));
    assert!(asked_paths(&asked).is_empty());
}

#[tokio::test]
async fn a_node_that_does_not_answer_yields_skipped_checks_not_a_failure() {
    // Bind a port and close it again, so nothing listens there.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let http = reqwest::Client::new();
    let report = dispatch(
        "snapshot",
        json!({}),
        &loopback(&http, &base, None),
        Scope::Conversation,
        Some(CHAT),
    )
    .await
    .unwrap();
    assert_eq!(check(&report, "core.version")["status"], "skip");
    assert_eq!(check(&report, "conversation.runs")["status"], "skip");
    assert!(!report.to_string().contains("127.0.0.1"));
}
