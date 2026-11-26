//! Tests of the Challenges tools: schemas, validation, error mapping and the client.

use crate::sidecar::mcp::challenges_tool::client::{challenges_root, ChallengesApi};
use crate::sidecar::mcp::challenges_tool::input::{ListInput, ListStatus, SubmitInput};
use crate::sidecar::mcp::challenges_tool::responses::{api_error, detail_projection};

use super::*;
use std::sync::{Arc, Mutex};

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::IntoResponse,
    Router,
};
use tokio::net::TcpListener;

fn valid_submit() -> Value {
    json!({
        "slug": "agent-build-week",
        "projectName": "Tide",
        "projectUrl": "https://github.com/example/tide",
        "pitch": "A local-first tide planner built entirely by my Ryu agent.",
        "allowPublicDisplay": true
    })
}

#[test]
fn lists_three_tools_with_strict_bounded_schemas() {
    let tools = tools();
    let ids: Vec<&str> = tools.iter().map(|tool| tool.id.as_str()).collect();
    assert_eq!(ids, vec![LIST_TOOL_ID, GET_TOOL_ID, SUBMIT_TOOL_ID]);
    for tool in &tools {
        assert_eq!(tool.server, SERVER_NAME);
        let schema = tool.input_schema.as_ref().unwrap();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false, "{}", tool.id);
        for (name, property) in schema["properties"].as_object().unwrap() {
            if property["type"] == "string" && property.get("enum").is_none() {
                assert!(
                    property.get("maxLength").is_some(),
                    "{}.{name} needs a maxLength",
                    tool.id
                );
            }
        }
    }
    let submit = tools[2].input_schema.as_ref().unwrap();
    assert_eq!(
        submit["required"],
        json!([
            "slug",
            "projectName",
            "projectUrl",
            "pitch",
            "allowPublicDisplay"
        ])
    );
    // The schema never lets the model choose the identity it submits as.
    for field in ["userId", "email", "displayName", "token"] {
        assert!(submit["properties"].get(field).is_none());
    }
}

#[test]
fn reads_are_read_only_and_submit_is_a_non_destructive_write() {
    let tools = tools();
    for tool in &tools[..2] {
        assert_eq!(tool.annotations.as_ref().unwrap()["readOnlyHint"], true);
    }
    let submit = tools[2].annotations.as_ref().unwrap();
    assert_eq!(submit["readOnlyHint"], false);
    assert_eq!(submit["destructiveHint"], false);
    assert!(!crate::agent_execution::classify_tool_with_metadata(
        SUBMIT_TOOL_ID,
        Some(submit),
        None
    )
    .is_read_only());
}

#[test]
fn submit_rejects_non_http_urls_and_bad_lengths() {
    for url in [
        "ftp://example.com/x",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,hi",
        "not a url",
        "mailto:me@example.com",
    ] {
        let mut args = valid_submit();
        args["projectUrl"] = json!(url);
        let error = SubmitInput::parse(&args).unwrap_err().to_string();
        assert!(error.contains("projectUrl"), "{url}: {error}");
    }
    let mut short_pitch = valid_submit();
    short_pitch["pitch"] = json!("too short");
    assert!(SubmitInput::parse(&short_pitch).is_err());
    let mut long_name = valid_submit();
    long_name["projectName"] = json!("x".repeat(MAX_PROJECT_NAME_CHARS + 1));
    assert!(SubmitInput::parse(&long_name).is_err());
    let mut extra = valid_submit();
    extra["userId"] = json!("someone-else");
    assert!(SubmitInput::parse(&extra).is_err());
    let mut missing = valid_submit();
    missing
        .as_object_mut()
        .unwrap()
        .remove("allowPublicDisplay");
    assert!(SubmitInput::parse(&missing).is_err());
    let mut bad_slug = valid_submit();
    bad_slug["slug"] = json!("../admin");
    assert!(SubmitInput::parse(&bad_slug).is_err());

    let parsed = SubmitInput::parse(&valid_submit()).unwrap();
    assert_eq!(parsed.project_url, "https://github.com/example/tide");
    assert!(parsed.team_name.is_none());
}

#[test]
fn list_rejects_unknown_arguments() {
    assert!(ListInput::parse(&json!({ "limit": 5 })).is_err());
    assert!(ListInput::parse(&json!({ "status": "closed" })).is_err());
    assert_eq!(
        ListInput::parse(&json!({})).unwrap().status,
        ListStatus::Open
    );
}

#[test]
fn detail_never_forwards_a_credit_pool_id() {
    let challenge = json!({
        "slug": "agent-build-week",
        "title": "Agent build week",
        "submissionChannel": "ryu_agent",
        "prizeTiers": [
            {"place":1,"label":"First place","kind":"credits","points":0,
             "amountMicroUsd":50_000_000,"description":"$50 in Ryu Frontier credits",
             "pool":"bedrock"},
            {"place":2,"label":"Second place","kind":"credits","points":0,
             "amountMicroUsd":12_500_000,"description":null,"pool":"anthropic-credits"},
            {"place":3,"label":"Third place","kind":"merch","points":0,
             "amountMicroUsd":null,"description":"Ryu hoodie","pool":null}
        ]
    });
    let detail = detail_projection(&challenge);
    let text = detail.to_string();
    for slot in ["bedrock", "anthropic-credits", "\"pool\""] {
        assert!(!text.contains(slot), "leaked {slot}: {text}");
    }
    let tiers = detail["prizeTiers"].as_array().unwrap();
    assert_eq!(tiers[0]["description"], "$50 in Ryu Frontier credits");
    assert_eq!(tiers[1]["description"], "$12.50 in Ryu credits");
    assert_eq!(tiers[2]["description"], "Ryu hoodie");
    assert_eq!(tiers[0]["place"], 1);
    assert_eq!(detail["agentOnly"], true);
}

#[test]
fn challenges_root_does_not_double_the_api_mount() {
    assert_eq!(
        challenges_root("https://ryu.example/"),
        "https://ryu.example/api/challenges"
    );
    assert_eq!(
        challenges_root("https://ryu.example/api"),
        "https://ryu.example/api/challenges"
    );
}

#[test]
fn error_mapping_surfaces_server_reasons() {
    let forbidden = api_error(
        403,
        r#"{"error":"This challenge accepts submissions only from your Ryu agent."}"#,
        Some("x"),
    );
    assert_eq!(
        forbidden.to_string(),
        "This challenge accepts submissions only from your Ryu agent."
    );
    assert_eq!(
        api_error(403, "plain text reason", Some("x")).to_string(),
        "plain text reason"
    );
    assert!(api_error(401, "", Some("x"))
        .to_string()
        .contains("Sign in to Ryu"));
    assert!(
        api_error(404, r#"{"error":"Challenge not found"}"#, Some("nope"))
            .to_string()
            .contains("Unknown challenge 'nope'")
    );
    assert!(api_error(
        409,
        r#"{"error":"Registration is closed for this event."}"#,
        None
    )
    .to_string()
    .contains("Registration is closed"));
}

#[tokio::test]
async fn submit_without_a_session_asks_the_user_to_sign_in() {
    let api = ChallengesApi::new("http://127.0.0.1:9", None).unwrap();
    let error = dispatch_with(&api, "submit", valid_submit())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Sign in to Ryu"));
}

#[derive(Debug, Clone)]
struct Recorded {
    method: Method,
    path: String,
    query: Option<String>,
    authorization: Option<String>,
    body: Value,
}

type Log = Arc<Mutex<Vec<Recorded>>>;

async fn record(
    State((log, entry_status)): State<(Log, StatusCode)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    log.lock().unwrap().push(Recorded {
        method: method.clone(),
        path: uri.path().to_owned(),
        query: uri.query().map(str::to_owned),
        authorization: headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    });
    let path = uri.path();
    if path == "/api/challenges/missing" || path.starts_with("/api/challenges/missing/") {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error":"Challenge not found"})),
        )
            .into_response();
    }
    match (method.as_str(), path) {
        ("GET", "/api/challenges") => axum::Json(json!({
            "challenges": [
                {"slug":"agent-build-week","title":"Agent build week","status":"live","endsAt":"2026-11-01T00:00:00.000Z","submissionChannel":"ryu_agent","brief":"long"},
                {"slug":"old","title":"Old","status":"closed","submissionChannel":"any"}
            ],
            "total": 2
        }))
        .into_response(),
        ("GET", "/api/challenges/mine") => axum::Json(json!({
            "entries": [{"challenge":{"slug":"agent-build-week"},"entry":{"status":"registered","email":"private@example.com"}}]
        }))
        .into_response(),
        ("GET", "/api/challenges/agent-build-week") => axum::Json(json!({
            "challenge": {"slug":"agent-build-week","title":"Agent build week","brief":"Build it","rules":["Be kind"],"prizeSummary":"Credits","status":"live","submissionChannel":"ryu_agent"}
        }))
        .into_response(),
        ("POST", "/api/challenges/agent-build-week/join") => {
            (StatusCode::CREATED, axum::Json(json!({"entry":{"status":"registered"}})))
                .into_response()
        }
        ("PUT", "/api/challenges/agent-build-week/entry") => (
            entry_status,
            axum::Json(if entry_status.is_success() {
                json!({"entry":{"status":"submitted","projectName":"Tide","email":"private@example.com"}})
            } else {
                json!({"error":"This challenge accepts submissions only from your Ryu agent. Ask your agent in Ryu Desktop, the CLI, or MCP to submit the project for you."})
            }),
        )
            .into_response(),
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

async fn mock_server(entry_status: StatusCode) -> (String, Log, tokio::task::JoinHandle<()>) {
    let log: Log = Arc::default();
    let app = Router::new()
        .fallback(record)
        .with_state((Arc::clone(&log), entry_status));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}"), log, server)
}

#[tokio::test]
async fn submit_joins_then_puts_the_entry_with_the_session_bearer() {
    let (base, log, server) = mock_server(StatusCode::OK).await;
    let api = ChallengesApi::new(&base, Some("session-token".into())).unwrap();
    let mut args = valid_submit();
    args["teamName"] = json!("  Tide crew  ");
    let result = dispatch_with(&api, "submit", args).await.unwrap();
    server.abort();

    assert_eq!(result["submitted"], true);
    assert_eq!(result["joinedNow"], true);
    assert_eq!(result["entry"]["status"], "submitted");
    assert!(
        result["entry"].get("email").is_none(),
        "private entry fields are not projected"
    );

    let calls = log.lock().unwrap().clone();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].method, Method::POST);
    assert_eq!(calls[0].path, "/api/challenges/agent-build-week/join");
    assert_eq!(
        calls[0].authorization.as_deref(),
        Some("Bearer session-token")
    );
    assert_eq!(calls[1].method, Method::PUT);
    assert_eq!(calls[1].path, "/api/challenges/agent-build-week/entry");
    assert_eq!(
        calls[1].authorization.as_deref(),
        Some("Bearer session-token")
    );
    assert_eq!(
        calls[1].body,
        json!({
            "projectName": "Tide",
            "projectUrl": "https://github.com/example/tide",
            "pitch": "A local-first tide planner built entirely by my Ryu agent.",
            "allowPublicDisplay": true,
            "teamName": "Tide crew"
        })
    );
}

#[tokio::test]
async fn submit_surfaces_the_server_403_message() {
    let (base, _log, server) = mock_server(StatusCode::FORBIDDEN).await;
    let api = ChallengesApi::new(&base, Some("browser-session".into())).unwrap();
    let error = dispatch_with(&api, "submit", valid_submit())
        .await
        .unwrap_err();
    server.abort();
    assert!(error
        .to_string()
        .starts_with("This challenge accepts submissions only from your Ryu agent."));
}

#[tokio::test]
async fn unknown_slug_is_reported_as_an_unknown_challenge() {
    let (base, _log, server) = mock_server(StatusCode::OK).await;
    let api = ChallengesApi::new(&base, Some("t".into())).unwrap();
    let error = dispatch_with(&api, "get", json!({ "slug": "missing" }))
        .await
        .unwrap_err();
    server.abort();
    assert!(error.to_string().contains("Unknown challenge 'missing'"));
}

#[tokio::test]
async fn list_filters_to_open_challenges_without_sending_credentials() {
    let (base, log, server) = mock_server(StatusCode::OK).await;
    let api = ChallengesApi::new(&base, Some("t".into())).unwrap();
    let result = dispatch_with(&api, "list", json!({ "kind": "challenge" }))
        .await
        .unwrap();
    server.abort();
    assert_eq!(result["count"], 1);
    let row = &result["challenges"][0];
    assert_eq!(row["slug"], "agent-build-week");
    assert_eq!(row["agentOnly"], true);
    assert!(row.get("brief").is_none());
    let calls = log.lock().unwrap().clone();
    assert_eq!(calls[0].method, Method::GET);
    assert_eq!(calls[0].path, "/api/challenges");
    assert_eq!(calls[0].query.as_deref(), Some("limit=100&kind=challenge"));
    assert!(calls[0].authorization.is_none());
}

#[tokio::test]
async fn get_includes_the_callers_entry_status() {
    let (base, log, server) = mock_server(StatusCode::OK).await;
    let api = ChallengesApi::new(&base, Some("t".into())).unwrap();
    let result = dispatch_with(&api, "get", json!({ "slug": "agent-build-week" }))
        .await
        .unwrap();
    server.abort();
    assert_eq!(result["challenge"]["brief"], "Build it");
    assert_eq!(result["challenge"]["agentOnly"], true);
    assert_eq!(result["signedIn"], true);
    assert_eq!(result["myEntry"]["status"], "registered");
    assert!(result["myEntry"].get("email").is_none());
    let calls = log.lock().unwrap().clone();
    assert_eq!(calls[1].path, "/api/challenges/mine");
    assert_eq!(calls[1].authorization.as_deref(), Some("Bearer t"));
}

#[tokio::test]
async fn get_without_a_session_still_reads_the_public_challenge() {
    let (base, log, server) = mock_server(StatusCode::OK).await;
    let api = ChallengesApi::new(&base, None).unwrap();
    let result = dispatch_with(&api, "get", json!({ "slug": "agent-build-week" }))
        .await
        .unwrap();
    server.abort();
    assert_eq!(result["signedIn"], false);
    assert!(result["myEntry"].is_null());
    assert_eq!(log.lock().unwrap().len(), 1);
}

mod account_backend;
