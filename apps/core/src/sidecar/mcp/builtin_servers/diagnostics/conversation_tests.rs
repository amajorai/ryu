//! The conversation checks: run state, step counts and fault lines.

use serde_json::json;

use super::super::access::Scope;
use super::*;

const AT: &str = "2026-11-18T15:00:00Z";

fn span(kind: &str, name: &str, started_at: i64, fault: Option<&str>) -> serde_json::Value {
    let status = if fault.is_some() { "error" } else { "ok" };
    let ended_at = started_at + 5;
    json!({
        "id": "row-1",
        "conversation_id": "conv-1",
        "kind": kind,
        "name": name,
        "args_hash": "0000000000000000000000000000000000000000000000000000000000000000",
        "started_at": started_at,
        "ended_at": ended_at,
        "error": fault,
        "status": status,
        "input": { "query": "fake captured input that must not travel" },
        "output": { "text": "fake captured output that must not travel" },
    })
}

fn trace(spans: Vec<serde_json::Value>) -> Probe {
    Probe::Answered(json!({ "spans": spans }))
}

fn runs(status: &str) -> Probe {
    Probe::Answered(json!({ "runs": [
        {
            "id": "conv-other",
            "title": "fake title of another chat",
            "agent_id": "agent-other",
            "run_status": "running",
        },
        {
            "id": "conv-1",
            "title": "fake title of this chat",
            "agent_id": "agent-1",
            "folder_path": "/home/fakeuser/project",
            "run_status": status,
        },
    ] }))
}

#[test]
fn only_a_plain_conversation_id_gets_a_trace_path() {
    assert_eq!(
        trace_path(" conv-1 "),
        Some("/api/runs/conv-1/trace".to_owned())
    );
    assert_eq!(trace_path("../version"), None);
    assert_eq!(trace_path("a/b"), None);
    assert_eq!(trace_path(""), None);
}

#[test]
fn a_failed_tool_call_appears_as_a_fault_line() {
    let lines = fault_lines(&[
        span("model_call", "fake-model-1", 10, None),
        span("tool_call", "web.search", 20, Some("upstream answered 503")),
        span("tool_call", "files.read", 30, None),
    ]);
    assert_eq!(
        lines,
        vec![json!({
            "kind": "tool_call",
            "name": "web.search",
            "message": "upstream answered 503",
            "startedAt": 20,
        })]
    );
}

#[test]
fn fault_lines_are_newest_first_capped_and_never_carry_captured_content() {
    let spans: Vec<serde_json::Value> = (0..14)
        .map(|index| span("tool_call", &format!("tool{index}"), index, Some("failed")))
        .collect();
    let lines = fault_lines(&spans);
    assert_eq!(lines.len(), 10);
    assert_eq!(lines[0]["name"], json!("tool13"));
    assert_eq!(lines[9]["name"], json!("tool4"));
    let text = serde_json::Value::Array(lines).to_string();
    assert!(!text.contains("captured"), "{text}");
    assert!(!text.contains("conv-1"), "{text}");
    assert!(!text.contains("0000000000"), "{text}");
}

#[test]
fn a_fault_message_is_redacted_before_it_is_cut() {
    let padding = "x ".repeat(140);
    let message = format!(
        "{padding}request to https://fakeuser:fake-url-password@example.com failed with \
         Authorization: Bearer fake-credential-0000000000 for someone@example.com"
    );
    let lines = fault_lines(&[span("tool_call", "http.get", 1, Some(message.as_str()))]);
    let shown = lines[0]["message"].as_str().unwrap();
    for hidden in [
        "fake-url-password",
        "fake-credential-0000000000",
        "someone@example.com",
    ] {
        assert!(!shown.contains(hidden), "{hidden} leaked: {shown}");
    }
    // Cut after redaction: 300 characters and the mark.
    assert_eq!(shown.chars().count(), 301, "{shown}");
}

#[test]
fn a_fault_without_a_message_still_gets_a_line() {
    let mut silent = span("tool_call", "shell.run", 5, None);
    silent["status"] = json!("error");
    let lines = fault_lines(&[silent]);
    assert_eq!(lines.len(), 1);
    assert!(lines[0]["message"]
        .as_str()
        .unwrap()
        .contains("recorded no message"));
}

#[test]
fn the_snapshot_section_reads_only_this_chats_state() {
    let mut report = Report::new(Scope::Node);
    summarize(
        &mut report,
        "conv-1",
        &runs("failed"),
        &trace(vec![
            span("model_call", "fake-model-1", 10, None),
            span("tool_call", "web.search", 20, Some("upstream answered 503")),
            span("model_call", "fake-model-2", 30, None),
        ]),
    );
    let check = report.check("conversation.runs").unwrap();
    assert_eq!(check.status, Status::Warn);
    assert_eq!(
        check.detail,
        "1 of 3 recorded steps in this chat ended with a fault. Its last run is marked failed."
    );
    assert!(check
        .fix
        .as_deref()
        .unwrap()
        .contains("diagnostics.recent_errors"));
    let out = report.finish(AT);
    assert_eq!(
        out["conversation"],
        json!({
            "runStatus": "failed",
            "agentId": "agent-1",
            "model": "fake-model-2",
            "steps": 3,
            "faults": 1,
        })
    );
    let text = out.to_string();
    for hidden in [
        "fake title",
        "agent-other",
        "conv-other",
        "fakeuser",
        "captured",
    ] {
        assert!(!text.contains(hidden), "{hidden} leaked: {text}");
    }
}

#[test]
fn a_clean_chat_passes_and_an_empty_one_is_information() {
    let mut clean_chat = Report::new(Scope::Conversation);
    summarize(
        &mut clean_chat,
        "conv-1",
        &Probe::Refused(403),
        &trace(vec![span("tool_call", "files.read", 1, None)]),
    );
    let check = clean_chat.check("conversation.runs").unwrap();
    assert_eq!(check.status, Status::Pass);
    assert_eq!(
        check.detail,
        "None of the 1 recorded steps in this chat ended with a fault."
    );
    // The runs route was refused, so the run state and the agent stay empty.
    assert_eq!(
        clean_chat.finish(AT)["conversation"]["runStatus"],
        json!("")
    );

    let mut empty = Report::new(Scope::Conversation);
    summarize(&mut empty, "conv-1", &runs("completed"), &trace(vec![]));
    let check = empty.check("conversation.runs").unwrap();
    assert_eq!(check.status, Status::Info);
    assert!(check.detail.starts_with("No steps are recorded"));
}

#[test]
fn a_caller_who_cannot_read_the_conversation_gets_nothing() {
    let mut report = Report::new(Scope::Conversation);
    summarize(&mut report, "conv-1", &runs("failed"), &Probe::Refused(404));
    let check = report.check("conversation.runs").unwrap();
    assert_eq!(check.status, Status::Skip);
    let out = report.finish(AT);
    assert!(out.get("conversation").is_none());
    assert!(!out.to_string().contains("agent-1"));

    let mut report = Report::new(Scope::Conversation);
    list_faults(&mut report, &Probe::Refused(403));
    assert_eq!(
        report.check("conversation.runs").unwrap().status,
        Status::Skip
    );
    assert!(report.finish(AT).get("faults").is_none());
}

#[test]
fn recent_errors_lists_the_faults_and_counts_them() {
    let mut report = Report::new(Scope::Conversation);
    list_faults(
        &mut report,
        &trace(vec![
            span("tool_call", "web.search", 20, Some("upstream answered 503")),
            span("tool_call", "files.read", 30, None),
        ]),
    );
    let check = report.check("conversation.runs").unwrap();
    assert_eq!(check.status, Status::Warn);
    assert!(check.detail.starts_with("1 of 2 recorded steps"));
    let out = report.finish(AT);
    assert_eq!(out["faults"].as_array().unwrap().len(), 1);
    assert_eq!(out["faults"][0]["name"], json!("web.search"));

    let mut clean_chat = Report::new(Scope::Conversation);
    list_faults(
        &mut clean_chat,
        &trace(vec![span("tool_call", "files.read", 30, None)]),
    );
    assert_eq!(
        clean_chat.check("conversation.runs").unwrap().status,
        Status::Pass
    );
    assert_eq!(clean_chat.finish(AT)["faults"], json!([]));
}
