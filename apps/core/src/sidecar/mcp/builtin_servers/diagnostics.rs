//! Built-in `diagnostics` tools: Ryu reads its own state before it answers a
//! complaint or drafts a bug report.
//!
//! Two read-only tools, both without arguments:
//!
//! - `diagnostics.snapshot` - Core, the Gateway, the local engine, background
//!   services, Safe Mode, the Gateway and app audits, background processes,
//!   and the state of the chat the call came from.
//! - `diagnostics.recent_errors` - the steps of that chat that ended with a
//!   fault, newest first.
//!
//! The report is composed from routes Core already documents and serves to
//! the desktop, read over the same loopback the self-API uses ([`probe`]). On
//! an org-bound node that loopback acts as the person in the chat, so every
//! route applies that person's role and conversation access, and [`access`]
//! decides whether node status is read at all.
//!
//! What keeps a result safe to send to a model provider:
//!
//! - only `GET` is sent, so nothing here changes the node;
//! - the tools take no arguments and read only the host conversation, so a
//!   model cannot point them at another chat;
//! - only named fields are read out of an answer ([`node_checks`],
//!   [`conversation`]); a command line, a working folder, a captured input or
//!   a header never reaches a result;
//! - no credential store, vault value or log file is read;
//! - every text is redacted and then cut ([`redaction`]), and the finished
//!   result passes [`redaction::redact_value`] once more.

mod access;
mod conversation;
mod node_checks;
mod probe;
mod redaction;
mod report;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::sidecar::mcp::RegistryTool;

pub(crate) use access::{narrow_for_restricted_agent, shared_node_scope, Scope, SharedNodeCaller};
pub(crate) use probe::Loopback;

use node_checks::Audit;
use report::Report;

/// The server segment of every diagnostics tool id.
pub const SERVER_NAME: &str = "diagnostics";
/// Node status plus the state of the host conversation.
pub const SNAPSHOT_TOOL_ID: &str = "diagnostics.snapshot";
/// The host conversation's steps that ended with a fault.
pub const RECENT_ERRORS_TOOL_ID: &str = "diagnostics.recent_errors";

const VERSION_ROUTE: &str = "/api/version";
const STATUS_ROUTE: &str = "/api/system/status";
const SAFE_MODE_ROUTE: &str = "/api/safe-mode";
const GATEWAY_AUDIT_ROUTE: &str = "/api/gateway/doctor";
const APPS_AUDIT_ROUTE: &str = "/api/plugins/doctor";
const PROCESSES_ROUTE: &str = "/api/background/processes";
const RUNS_ROUTE: &str = "/api/runs";

fn no_arguments_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
}

fn read_only_annotations() -> Value {
    json!({
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
    })
}

/// The diagnostics tools exposed through the unified catalog.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: SNAPSHOT_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "snapshot".to_owned(),
            description: Some(
                "Look into a problem with Ryu itself. Call this first when something in Ryu \
                 fails, hangs or is missing, or when the person says Ryu is broken, before you \
                 answer or draft a bug report. Read-only and takes no arguments. Returns checks \
                 for Core, the Gateway, the local engine, background services, Safe Mode, the \
                 Gateway and app audits and background processes, plus the state of this chat's \
                 own runs. Each check has a status (fail, warn, skip, info, pass), one line of \
                 detail and, for a problem, a fix line. `notChecked` lists what was not looked \
                 at. Credentials, email addresses and home folders are removed from every text. \
                 On a shared node, node status is read only for the node owner or a member who \
                 manages nodes, in a private chat; everyone else gets this chat only. Tell the \
                 person in plain words what was checked, the likely cause and a workaround."
                    .to_owned(),
            ),
            input_schema: Some(no_arguments_schema()),
            annotations: Some(read_only_annotations()),
            ..Default::default()
        },
        RegistryTool {
            id: RECENT_ERRORS_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "recent_errors".to_owned(),
            description: Some(
                "List the steps of this chat that ended with a fault (failed tool calls and \
                 model calls), newest first, each with the name of the tool or model and the \
                 message it reported. Read-only and takes no arguments; it reads only the chat \
                 it is called from. Credentials, email addresses and home folders are removed \
                 from every message. Use it after diagnostics.snapshot reports faults in this \
                 chat, or when the person says a step failed."
                    .to_owned(),
            ),
            input_schema: Some(no_arguments_schema()),
            annotations: Some(read_only_annotations()),
            ..Default::default()
        },
    ]
}

/// Both tools read the chat they are called from and nothing else, so any
/// argument is refused instead of being silently ignored: a model that passes
/// another chat's id must not believe it read that chat.
fn refuse_arguments(tool: &str, arguments: &Value) -> Result<()> {
    let empty = match arguments {
        Value::Null => true,
        Value::Object(fields) => fields.is_empty(),
        _ => false,
    };
    if empty {
        Ok(())
    } else {
        Err(anyhow!(
            "diagnostics.{tool} takes no arguments. It always reads the chat it is called from."
        ))
    }
}

/// Run one `diagnostics` tool.
///
/// `scope` is decided by the dispatch arm from the caller's principal, and
/// `host_conversation_id` is the chat the call came from. Neither comes from
/// the model.
pub(crate) async fn dispatch(
    tool: &str,
    arguments: Value,
    loopback: &Loopback<'_>,
    scope: Scope,
    host_conversation_id: Option<&str>,
) -> Result<Value> {
    let chat = host_conversation_id
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let report = match tool {
        "snapshot" => {
            refuse_arguments(tool, &arguments)?;
            snapshot(loopback, scope, chat).await
        }
        "recent_errors" => {
            refuse_arguments(tool, &arguments)?;
            recent_errors(loopback, chat).await
        }
        other => return Err(anyhow!("unknown diagnostics tool '{other}'")),
    };
    let generated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    Ok(redaction::redact_value(&report.finish(&generated_at)))
}

fn no_chat(report: &mut Report) {
    report.not_checked(
        "conversation",
        "This call did not come from a chat that can be read, so no runs or faults are listed.",
    );
}

async fn snapshot(loopback: &Loopback<'_>, scope: Scope, chat: Option<&str>) -> Report {
    let mut report = Report::new(scope);
    match scope {
        Scope::Node => {
            let (version, status, safe_mode, gateway_audit, apps_audit, processes) = tokio::join!(
                loopback.get(VERSION_ROUTE),
                loopback.get(STATUS_ROUTE),
                loopback.get(SAFE_MODE_ROUTE),
                loopback.get(GATEWAY_AUDIT_ROUTE),
                loopback.get(APPS_AUDIT_ROUTE),
                loopback.get(PROCESSES_ROUTE),
            );
            node_checks::version(&mut report, &version);
            node_checks::system_status(&mut report, &status);
            node_checks::safe_mode(&mut report, &safe_mode);
            node_checks::audit(&mut report, Audit::Gateway, &gateway_audit);
            node_checks::audit(&mut report, Audit::Apps, &apps_audit);
            node_checks::background_processes(&mut report, &processes);
            report.not_checked(
                "updates",
                "Whether a newer Ryu release exists. That check asks a server outside this \
                 device, and this tool reads this device only.",
            );
            report.not_checked(
                "logs",
                "Log files on this device. Running `ryu troubleshoot` in a terminal reads them \
                 and checks the installed files.",
            );
        }
        Scope::Conversation => {
            let version = loopback.get(VERSION_ROUTE).await;
            node_checks::version(&mut report, &version);
            report.not_checked(
                "node",
                "Node status, the audits and background processes. On a shared node they are \
                 read only for the node owner or a member who manages nodes, in a private chat, \
                 and never for an agent with restricted account access.",
            );
        }
    }
    report.not_checked(
        "credentials",
        "Saved keys, sign-ins and vault values. This tool never reads them.",
    );
    match chat.and_then(|id| conversation::trace_path(id).map(|path| (id, path))) {
        Some((id, path)) => {
            let (runs, trace) = tokio::join!(loopback.get(RUNS_ROUTE), loopback.get(&path));
            conversation::summarize(&mut report, id, &runs, &trace);
        }
        None => no_chat(&mut report),
    }
    report
}

async fn recent_errors(loopback: &Loopback<'_>, chat: Option<&str>) -> Report {
    let mut report = Report::new(Scope::Conversation);
    match chat.and_then(conversation::trace_path) {
        Some(path) => {
            let trace = loopback.get(&path).await;
            conversation::list_faults(&mut report, &trace);
        }
        None => no_chat(&mut report),
    }
    report
}

#[cfg(test)]
#[path = "diagnostics/tests.rs"]
mod tests;
