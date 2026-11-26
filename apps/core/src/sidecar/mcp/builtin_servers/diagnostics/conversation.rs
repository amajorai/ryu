//! The host conversation's own runs: its state and the steps that ended with
//! a fault.
//!
//! The source is the run trace (`GET /api/runs/{id}/trace`), whose spans say
//! what ran: each tool call and model call with its status and, when it
//! failed, its message. The route applies the caller's conversation access, so
//! a person who cannot read the conversation gets nothing here either.
//!
//! Only a span's kind, name, status, start time and fault message are read. A
//! captured input or output (present under a capturing content policy) is
//! never copied into a result.

use serde_json::{json, Value};

use super::node_checks::{answered, items, text};
use super::probe::{is_single_segment, Probe};
use super::redaction::clean;
use super::report::{Check, Report, Status, LINE_CHARS};

/// Most fault lines one result carries, newest first.
const LISTED_FAULTS: usize = 10;
/// The span field that holds a failed step's message.
const FAULT_FIELD: &str = "error";

const CHECK_ID: &str = "conversation.runs";
const CHECK_TITLE: &str = "This chat";

/// The trace route of one conversation, or `None` when its id cannot stand as
/// a single path segment.
pub(super) fn trace_path(conversation_id: &str) -> Option<String> {
    let id = conversation_id.trim();
    if is_single_segment(id) {
        Some(format!("/api/runs/{id}/trace"))
    } else {
        None
    }
}

fn is_fault(span: &Value) -> bool {
    text(span, "status") == "error" || !text(span, FAULT_FIELD).trim().is_empty()
}

fn started_at(span: &Value) -> i64 {
    span.get("started_at").and_then(Value::as_i64).unwrap_or(0)
}

/// The steps that ended with a fault, newest first, each message redacted and
/// then cut to one line.
pub(super) fn fault_lines(spans: &[Value]) -> Vec<Value> {
    let mut faults: Vec<&Value> = spans.iter().filter(|span| is_fault(span)).collect();
    faults.sort_by_key(|span| std::cmp::Reverse(started_at(span)));
    faults
        .into_iter()
        .take(LISTED_FAULTS)
        .map(|span| {
            let recorded = text(span, FAULT_FIELD).trim();
            let message = if recorded.is_empty() {
                "This step ended with a fault and recorded no message.".to_owned()
            } else {
                clean(recorded, LINE_CHARS)
            };
            json!({
                "kind": clean(text(span, "kind"), 40),
                "name": clean(text(span, "name"), 120),
                "message": message,
                "startedAt": started_at(span),
            })
        })
        .collect()
}

/// The model of the newest model call in the trace.
fn latest_model(spans: &[Value]) -> &str {
    spans
        .iter()
        .filter(|span| text(span, "kind").contains("model"))
        .max_by_key(|span| started_at(span))
        .map(|span| text(span, "name"))
        .unwrap_or("")
}

/// This conversation's entry in `GET /api/runs`, when that route answered and
/// lists it. Only its run state and agent are read, never its title or folder.
fn run_entry<'a>(runs: &'a Probe, conversation_id: &str) -> Option<&'a Value> {
    let Probe::Answered(body) = runs else {
        return None;
    };
    items(body, "runs")
        .iter()
        .find(|run| text(run, "id") == conversation_id)
}

/// The conversation part of `diagnostics.snapshot` - one check and a
/// `conversation` section with the run state, the agent, the model and the
/// step counts.
pub(super) fn summarize(report: &mut Report, conversation_id: &str, runs: &Probe, trace: &Probe) {
    let Some(body) = answered(report, CHECK_ID, CHECK_TITLE, trace) else {
        return;
    };
    let spans = items(body, "spans");
    let faults = spans.iter().filter(|span| is_fault(span)).count();
    let run = run_entry(runs, conversation_id.trim());
    let run_status = run.map(|run| text(run, "run_status")).unwrap_or("");
    let agent = run.map(|run| text(run, "agent_id")).unwrap_or("");
    report.attach(
        "conversation",
        json!({
            "runStatus": clean(run_status, 40),
            "agentId": clean(agent, 120),
            "model": clean(latest_model(spans), 120),
            "steps": spans.len(),
            "faults": faults,
        }),
    );
    let state = if run_status.trim().is_empty() {
        String::new()
    } else {
        format!(" Its last run is marked {}.", run_status.trim())
    };
    let check = if faults > 0 {
        Check::new(
            CHECK_ID,
            Status::Warn,
            CHECK_TITLE,
            format!(
                "{faults} of {} recorded steps in this chat ended with a fault.{state}",
                spans.len()
            ),
        )
        .fix(
            "Call diagnostics.recent_errors to read the fault messages, then say which step \
             failed and why.",
        )
    } else if spans.is_empty() {
        Check::new(
            CHECK_ID,
            Status::Info,
            CHECK_TITLE,
            format!("No steps are recorded for this chat yet.{state}"),
        )
    } else {
        Check::new(
            CHECK_ID,
            Status::Pass,
            CHECK_TITLE,
            format!(
                "None of the {} recorded steps in this chat ended with a fault.{state}",
                spans.len()
            ),
        )
    };
    report.push(check);
}

/// The body of `diagnostics.recent_errors` - a `faults` list, newest first, and
/// one check that says how many there are.
pub(super) fn list_faults(report: &mut Report, trace: &Probe) {
    let Some(body) = answered(report, CHECK_ID, CHECK_TITLE, trace) else {
        return;
    };
    let spans = items(body, "spans");
    let lines = fault_lines(spans);
    let total = spans.iter().filter(|span| is_fault(span)).count();
    let shown = lines.len();
    report.attach("faults", Value::Array(lines));
    let check = if total == 0 {
        Check::new(
            CHECK_ID,
            Status::Pass,
            CHECK_TITLE,
            format!(
                "None of the {} recorded steps in this chat ended with a fault.",
                spans.len()
            ),
        )
    } else {
        Check::new(
            CHECK_ID,
            Status::Warn,
            CHECK_TITLE,
            format!(
                "{total} of {} recorded steps in this chat ended with a fault. The newest \
                 {shown} are listed under faults.",
                spans.len()
            ),
        )
        .fix(
            "Read the newest fault first. Its name is the tool or model that failed and its \
             message is what that step reported.",
        )
    };
    report.push(check);
}

#[cfg(test)]
#[path = "conversation_tests.rs"]
mod tests;
