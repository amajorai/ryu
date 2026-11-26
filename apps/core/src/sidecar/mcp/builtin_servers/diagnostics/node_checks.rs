//! Node checks: what Core's own status routes say, turned into findings.
//!
//! Each function takes the answer of one documented read route and adds
//! checks to the report. They are pure, so every verdict is tested without a
//! running node. A route that did not answer becomes a `skip` check that says
//! so, never a silent gap.
//!
//! Only named fields are read out of an answer. A field these functions do not
//! name (a command line, a working folder, a process id) never reaches the
//! report, whatever the route returns.

use serde_json::{json, Value};

use super::probe::Probe;
use super::redaction::clean;
use super::report::{Check, Report, Status};

/// Most names listed in one detail line.
const LISTED_NAMES: usize = 8;
/// Most findings of one audit that become checks of their own.
const LISTED_FINDINGS: usize = 5;
/// Most background processes listed.
const LISTED_PROCESSES: usize = 8;

pub(super) fn text<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("")
}

fn flag(value: &Value, name: &str) -> Option<bool> {
    value.get(name).and_then(Value::as_bool)
}

fn number(value: &Value, name: &str) -> u64 {
    value.get(name).and_then(Value::as_u64).unwrap_or(0)
}

pub(super) fn items<'a>(value: &'a Value, name: &str) -> &'a [Value] {
    match value.get(name).and_then(Value::as_array) {
        Some(list) => list.as_slice(),
        None => &[],
    }
}

/// `a, b and 3 more`, from at most [`LISTED_NAMES`] names.
fn listed(names: &[String]) -> String {
    let shown: Vec<&str> = names
        .iter()
        .take(LISTED_NAMES)
        .map(String::as_str)
        .collect();
    let hidden = names.len().saturating_sub(shown.len());
    if hidden == 0 {
        shown.join(", ")
    } else {
        format!("{} and {hidden} more", shown.join(", "))
    }
}

/// The body of a route that answered, or a `skip` check that says why not.
pub(super) fn answered<'a>(
    report: &mut Report,
    id: &str,
    title: &str,
    probe: &'a Probe,
) -> Option<&'a Value> {
    let reason = match probe {
        Probe::Answered(body) => return Some(body),
        Probe::Refused(status) if *status == 401 || *status == 403 => format!(
            "Not read: Core does not allow this read for the person in this chat (HTTP {status})."
        ),
        Probe::Refused(404) => {
            "Not read: Core has nothing here that this chat may read (HTTP 404).".to_owned()
        }
        Probe::Refused(status) if *status >= 500 => {
            format!("Not read: the part of Ryu behind this read did not answer (HTTP {status}).")
        }
        Probe::Refused(status) => format!("Not read: Core answered HTTP {status}."),
        Probe::Unreachable(reason) => {
            format!("Not read: Core did not answer its own request, {reason}.")
        }
    };
    report.push(Check::new(id, Status::Skip, title, reason));
    None
}

/// `GET /api/version` - the installed version, the platform, and whether the
/// Gateway runs the same build as Core.
pub(super) fn version(report: &mut Report, probe: &Probe) {
    let Some(body) = answered(report, "core.version", "Ryu version", probe) else {
        return;
    };
    let core = text(body, "ryu_version").trim();
    let platform = text(body, "platform").trim();
    let gateway = items(body, "components")
        .iter()
        .find(|component| text(component, "name") == "gateway")
        .map(|component| text(component, "version").trim())
        .unwrap_or("");
    report.set_version(core);
    report.fact("Ryu version", core);
    report.fact("Platform", platform);
    report.fact("Gateway version", gateway);
    // One release train: any difference means a stale binary. Compared as
    // text, like `crate::update::version_disagrees`.
    if !core.is_empty() && !gateway.is_empty() && core != gateway {
        report.push(
            Check::new(
                "core.version",
                Status::Warn,
                "Ryu version",
                format!(
                    "Core runs {core} but the Gateway reports {gateway}. The two ship together, \
                     so one of them is an old copy."
                ),
            )
            .fix(
                "Quit Ryu fully and start it again. If the versions still differ, install the \
                 current release again.",
            )
            .search("gateway version mismatch")
            .unit("apps/gateway"),
        );
        return;
    }
    let detail = if platform.is_empty() {
        format!("Ryu {core}.")
    } else {
        format!("Ryu {core} on {platform}.")
    };
    report.push(Check::new(
        "core.version",
        Status::Info,
        "Ryu version",
        detail,
    ));
}

/// `GET /api/system/status` - Core, the Gateway, the local engine and the
/// background services, from one merged answer.
pub(super) fn system_status(report: &mut Report, probe: &Probe) {
    let Some(body) = answered(report, "core.status", "Ryu status", probe) else {
        return;
    };
    report.push(Check::new(
        "core.reachable",
        Status::Pass,
        "Core",
        "Core is running and answered its own status request.",
    ));
    gateway(report, body);
    engine(report, body);
    services(report, body);
}

fn gateway(report: &mut Report, body: &Value) {
    let reachable = body
        .get("gateway")
        .and_then(|gateway| flag(gateway, "reachable"));
    let check = match reachable {
        Some(true) => Check::new(
            "gateway.reachable",
            Status::Pass,
            "Gateway",
            "The Gateway is running and answers Core.",
        ),
        Some(false) => Check::new(
            "gateway.reachable",
            Status::Fail,
            "Gateway",
            "The Gateway is not answering Core. Model calls, tool permissions and budgets go \
             through it, so chats fail or hang until it is back.",
        )
        .fix(
            "Quit Ryu fully and start it again. If the Gateway stays down, run `ryu \
             troubleshoot` in a terminal: it checks the installed files and the logs on this \
             device.",
        )
        .search("gateway not reachable")
        .unit("apps/gateway"),
        None => Check::new(
            "gateway.reachable",
            Status::Skip,
            "Gateway",
            "Not read: Core's status answer did not say whether the Gateway is reachable.",
        ),
    };
    report.push(check);
}

fn engine(report: &mut Report, body: &Value) {
    let Some(engine) = body.get("engine") else {
        return;
    };
    let active = text(engine, "active").trim();
    let check = if active.is_empty() {
        Check::new(
            "engine.local",
            Status::Info,
            "Local engine",
            "No local model engine is selected. That is normal when chats use a cloud provider \
             or an agent with its own sign-in.",
        )
    } else if flag(engine, "running") == Some(true) {
        Check::new(
            "engine.local",
            Status::Pass,
            "Local engine",
            format!("The local engine {active} is selected and running."),
        )
    } else {
        // Not a verdict: an engine that starts on first use reads the same.
        Check::new(
            "engine.local",
            Status::Info,
            "Local engine",
            format!(
                "The local engine {active} is selected but not running right now. It matters \
                 only if chats with a local model are the ones that fail."
            ),
        )
    };
    report.push(check);
}

fn services(report: &mut Report, body: &Value) {
    let list = items(body, "sidecars");
    if list.is_empty() {
        return;
    }
    let failed: Vec<String> = list
        .iter()
        .filter(|service| !text(service, "failure_reason").trim().is_empty())
        .map(|service| {
            format!(
                "{} ({})",
                text(service, "name"),
                clean(text(service, "failure_reason"), 100)
            )
        })
        .collect();
    if !failed.is_empty() {
        report.push(
            Check::new(
                "services.failed",
                Status::Warn,
                "Background services",
                format!("Could not start: {}.", listed(&failed)),
            )
            .fix(
                "Quit Ryu fully and start it again. If it fails again, the reason in the detail \
                 says what blocks it, most often a port another program already uses.",
            )
            .search("sidecar failed to start")
            .unit("apps/core"),
        );
    }
    let running = list
        .iter()
        .filter(|service| flag(service, "running") == Some(true))
        .count();
    let stopped: Vec<String> = list
        .iter()
        .filter(|service| {
            flag(service, "running") != Some(true)
                && flag(service, "lazy") != Some(true)
                && text(service, "failure_reason").trim().is_empty()
        })
        .map(|service| text(service, "name").to_owned())
        .collect();
    let detail = if stopped.is_empty() {
        format!(
            "{running} of {} background services are running. The others start on first use.",
            list.len()
        )
    } else {
        format!(
            "{running} of {} background services are running. Stopped: {}. A stopped service \
             is normal when its feature is not installed or not in use.",
            list.len(),
            listed(&stopped)
        )
    };
    report.push(Check::new(
        "services.running",
        Status::Info,
        "Background services",
        detail,
    ));
}

/// `GET /api/safe-mode` - whether Safe Mode holds back apps, skills and MCP
/// servers.
pub(super) fn safe_mode(report: &mut Report, probe: &Probe) {
    let Some(body) = answered(report, "safe_mode", "Safe Mode", probe) else {
        return;
    };
    if flag(body, "enabled") != Some(true) {
        report.push(Check::new(
            "safe_mode",
            Status::Pass,
            "Safe Mode",
            "Safe Mode is off, so apps, skills and MCP servers load as usual.",
        ));
        return;
    }
    let nothing = Value::Null;
    let held = body.get("suppressed").unwrap_or(&nothing);
    let detail = format!(
        "Safe Mode is on (source: {}). It holds back {} apps, {} skills and {} MCP servers, so \
         their tools and features are missing until it is turned off.",
        text(body, "source"),
        number(held, "plugins"),
        number(held, "skills"),
        number(held, "mcp_servers"),
    );
    let fix = if flag(body, "user_clearable") == Some(false) {
        "Safe Mode was forced when Ryu started, by an environment setting or a start option. \
         Remove that and start Ryu again."
    } else {
        "Turn Safe Mode off in Settings and restart Ryu. If the problem is gone while Safe Mode \
         is on, an app, a skill or an MCP server causes it."
    };
    report.push(
        Check::new("safe_mode", Status::Warn, "Safe Mode", detail)
            .fix(fix)
            .search("safe mode"),
    );
}

/// Which read-only audit an answer came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Audit {
    /// `GET /api/gateway/doctor`.
    Gateway,
    /// `GET /api/plugins/doctor`.
    Apps,
}

impl Audit {
    pub(super) fn id(self) -> &'static str {
        match self {
            Self::Gateway => "gateway.doctor",
            Self::Apps => "apps.doctor",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Gateway => "Gateway settings",
            Self::Apps => "Installed apps",
        }
    }

    fn unit(self) -> &'static str {
        match self {
            Self::Gateway => "apps/gateway",
            Self::Apps => "apps/core",
        }
    }
}

fn severity_status(severity: &str) -> Option<Status> {
    match severity.trim().to_ascii_lowercase().as_str() {
        "critical" | "error" | "high" => Some(Status::Fail),
        "warning" | "warn" | "medium" => Some(Status::Warn),
        _ => None,
    }
}

/// The findings of one audit. Each finding at warning level or above becomes
/// a check with the audit's own summary, detail and recommended action.
pub(super) fn audit(report: &mut Report, audit: Audit, probe: &Probe) {
    let Some(body) = answered(report, audit.id(), audit.title(), probe) else {
        return;
    };
    let findings = items(body, "findings");
    let mut problems: Vec<(Status, &Value)> = findings
        .iter()
        .filter_map(|finding| {
            severity_status(text(finding, "severity")).map(|status| (status, finding))
        })
        .collect();
    if problems.is_empty() {
        report.push(Check::new(
            audit.id(),
            Status::Pass,
            audit.title(),
            format!(
                "The audit found nothing at warning level or above ({} notes).",
                findings.len()
            ),
        ));
        return;
    }
    problems.sort_by_key(|(status, _)| status.rank());
    for (status, finding) in problems.iter().take(LISTED_FINDINGS) {
        let check_id = text(finding, "checkId").trim();
        let id = if check_id.is_empty() {
            format!("{}.finding", audit.id())
        } else {
            format!("{}.{check_id}", audit.id())
        };
        let summary = text(finding, "summary").trim();
        let app = text(finding, "pluginId").trim();
        let title = match (app.is_empty(), summary.is_empty()) {
            (_, true) => audit.title().to_owned(),
            (true, false) => summary.to_owned(),
            (false, false) => format!("{app}: {summary}"),
        };
        let mut check =
            Check::new(&id, *status, &title, text(finding, "detail")).unit(audit.unit());
        let action = text(finding, "recommendedAction").trim();
        if !action.is_empty() {
            check = check.fix(action);
        }
        report.push(check);
    }
    let hidden = problems.len().saturating_sub(LISTED_FINDINGS);
    if hidden > 0 {
        report.push(Check::new(
            audit.id(),
            Status::Info,
            audit.title(),
            format!("{hidden} more findings of this audit are not listed here."),
        ));
    }
}

fn exit_code(process: &Value) -> Option<i64> {
    process.get("exit_code").and_then(Value::as_i64)
}

/// `GET /api/background/processes` - the shell processes agents started.
///
/// Only the label, the kind, the state and the exit code are read. A command
/// line or a working folder can carry a credential or a private path, so
/// neither is ever copied into the report.
pub(super) fn background_processes(report: &mut Report, probe: &Probe) {
    let id = "background.processes";
    let title = "Background processes";
    let Some(body) = answered(report, id, title, probe) else {
        return;
    };
    let list = items(body, "processes");
    let running = list
        .iter()
        .filter(|process| flag(process, "running") == Some(true))
        .count();
    let failed = list
        .iter()
        .filter(|process| {
            flag(process, "running") != Some(true) && exit_code(process).is_some_and(|c| c != 0)
        })
        .count();
    let shown: Vec<Value> = list
        .iter()
        .take(LISTED_PROCESSES)
        .map(|process| {
            json!({
                "label": clean(text(process, "label"), 80),
                "kind": clean(text(process, "kind"), 40),
                "running": flag(process, "running") == Some(true),
                "exitCode": exit_code(process),
            })
        })
        .collect();
    if !shown.is_empty() {
        report.attach("backgroundProcesses", Value::Array(shown));
    }
    let detail = format!(
        "{} known: {running} running, {failed} ended with a failure code.",
        list.len()
    );
    let check = if failed > 0 {
        Check::new(id, Status::Warn, title, detail).fix(
            "A failure code means the command itself stopped with a problem. Ask the agent \
             that started it for its output, or start it again.",
        )
    } else {
        Check::new(id, Status::Info, title, detail)
    };
    report.push(check);
}

#[cfg(test)]
#[path = "node_checks_tests.rs"]
mod tests;
