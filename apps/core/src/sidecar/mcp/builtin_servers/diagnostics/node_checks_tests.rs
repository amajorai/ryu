//! One test group per node check: version, status, Safe Mode, the two audits
//! and background processes.

use serde_json::json;

use super::super::access::Scope;
use super::*;

const AT: &str = "2026-11-18T15:00:00Z";

fn new_report() -> Report {
    Report::new(Scope::Node)
}

fn ok(body: serde_json::Value) -> Probe {
    Probe::Answered(body)
}

fn status_of(report: &Report, id: &str) -> Status {
    report
        .check(id)
        .unwrap_or_else(|| panic!("no check '{id}'"))
        .status
}

// ── A route that did not answer ──────────────────────────────────────────────

#[test]
fn a_route_that_did_not_answer_becomes_a_skip_check_with_the_reason() {
    for (probe, expected) in [
        (Probe::Refused(403), "HTTP 403"),
        (Probe::Refused(401), "HTTP 401"),
        (Probe::Refused(404), "HTTP 404"),
        (Probe::Refused(502), "HTTP 502"),
        (Probe::Refused(418), "HTTP 418"),
        (Probe::Unreachable("it timed out"), "it timed out"),
    ] {
        let mut report = new_report();
        assert!(answered(&mut report, "x.check", "X", &probe).is_none());
        let check = report.check("x.check").unwrap();
        assert_eq!(check.status, Status::Skip);
        assert!(check.detail.contains(expected), "{}", check.detail);
        assert!(check.detail.starts_with("Not read"), "{}", check.detail);
    }
    let mut report = new_report();
    let probe = ok(json!({ "a": 1 }));
    assert_eq!(
        answered(&mut report, "x.check", "X", &probe),
        Some(&json!({ "a": 1 }))
    );
    assert!(report.checks().is_empty());
}

// ── Version ──────────────────────────────────────────────────────────────────

fn version_body(core: &str, gateway: &str) -> serde_json::Value {
    json!({
        "ryu_version": core,
        "platform": "windows-x86_64",
        "components": [
            { "name": "core", "version": core },
            { "name": "gateway", "version": gateway },
        ],
        "features": [],
    })
}

#[test]
fn version_reports_the_build_and_the_platform_as_facts() {
    let mut report = new_report();
    version(&mut report, &ok(version_body("0.5.0", "0.5.0")));
    let check = report.check("core.version").unwrap();
    assert_eq!(check.status, Status::Info);
    assert_eq!(check.detail, "Ryu 0.5.0 on windows-x86_64.");
    let out = report.finish(AT);
    assert_eq!(out["version"], json!("0.5.0"));
    assert_eq!(
        out["machine"],
        json!([
            ["Ryu version", "0.5.0"],
            ["Platform", "windows-x86_64"],
            ["Gateway version", "0.5.0"],
        ])
    );
}

#[test]
fn version_warns_when_the_gateway_is_an_old_copy() {
    let mut report = new_report();
    version(&mut report, &ok(version_body("0.5.0", "0.4.9")));
    let check = report.check("core.version").unwrap();
    assert_eq!(check.status, Status::Warn);
    assert!(check.detail.contains("0.5.0") && check.detail.contains("0.4.9"));
    assert!(check.fix.is_some());
    assert_eq!(check.unit, Some("apps/gateway"));
}

#[test]
fn version_is_skipped_when_the_route_did_not_answer() {
    let mut report = new_report();
    version(&mut report, &Probe::Unreachable("the connection failed"));
    assert_eq!(status_of(&report, "core.version"), Status::Skip);
    assert_eq!(report.finish(AT)["machine"], json!([]));
}

// ── System status ────────────────────────────────────────────────────────────

fn status_body(gateway_reachable: bool) -> serde_json::Value {
    json!({
        "core": { "reachable": true },
        "engine": { "active": "llamacpp", "running": true, "available": ["llamacpp"] },
        "sidecars": [
            { "name": "gateway", "running": gateway_reachable, "lazy": false },
            { "name": "voice", "running": false, "lazy": true },
        ],
        "gateway": { "reachable": gateway_reachable },
        "mesh": {},
    })
}

#[test]
fn a_healthy_node_passes_core_gateway_and_engine() {
    let mut report = new_report();
    system_status(&mut report, &ok(status_body(true)));
    assert_eq!(status_of(&report, "core.reachable"), Status::Pass);
    assert_eq!(status_of(&report, "gateway.reachable"), Status::Pass);
    assert_eq!(status_of(&report, "engine.local"), Status::Pass);
    let services = report.check("services.running").unwrap();
    assert_eq!(services.status, Status::Info);
    assert!(services.detail.starts_with("1 of 2"), "{}", services.detail);
    assert!(report.check("services.failed").is_none());
}

#[test]
fn a_stopped_gateway_is_a_failed_check_with_a_fix_line() {
    let mut report = new_report();
    system_status(&mut report, &ok(status_body(false)));
    let gateway = report.check("gateway.reachable").unwrap();
    assert_eq!(gateway.status, Status::Fail);
    assert_eq!(gateway.unit, Some("apps/gateway"));
    assert!(gateway.fix.as_deref().unwrap().contains("start it again"));
    // The stopped, non-lazy service is named; the lazy one is not.
    let services = report.check("services.running").unwrap();
    assert!(
        services.detail.contains("Stopped: gateway."),
        "{}",
        services.detail
    );
    assert!(!services.detail.contains("voice"), "{}", services.detail);

    let out = report.finish(AT);
    let first = &out["checks"][0];
    assert_eq!(first["id"], json!("gateway.reachable"));
    assert_eq!(first["status"], json!("fail"));
    assert!(first["fix"].as_str().unwrap().len() > 20);
    assert_eq!(out["summary"]["fail"], json!(1));
}

#[test]
fn a_status_answer_without_the_gateway_field_is_skipped_not_passed() {
    let mut report = new_report();
    system_status(&mut report, &ok(json!({ "core": { "reachable": true } })));
    assert_eq!(status_of(&report, "gateway.reachable"), Status::Skip);
    assert!(report.check("engine.local").is_none());
    assert!(report.check("services.running").is_none());
}

#[test]
fn the_local_engine_is_information_unless_it_runs() {
    let mut none = new_report();
    system_status(
        &mut none,
        &ok(
            json!({ "engine": { "active": null, "running": false }, "gateway": { "reachable": true } }),
        ),
    );
    let check = none.check("engine.local").unwrap();
    assert_eq!(check.status, Status::Info);
    assert!(check.detail.contains("No local model engine"));

    let mut stopped = new_report();
    system_status(
        &mut stopped,
        &ok(
            json!({ "engine": { "active": "mlx", "running": false }, "gateway": { "reachable": true } }),
        ),
    );
    let check = stopped.check("engine.local").unwrap();
    assert_eq!(check.status, Status::Info);
    assert!(check.detail.contains("mlx") && check.detail.contains("not running"));
}

#[test]
fn a_service_that_could_not_start_is_a_warning_with_its_redacted_reason() {
    let mut report = new_report();
    let names: Vec<serde_json::Value> = (0..12)
        .map(|index| json!({ "name": format!("svc{index}"), "running": false, "lazy": false }))
        .collect();
    let mut sidecars = vec![json!({
        "name": "notes",
        "running": false,
        "lazy": false,
        "failure_reason": "port 8003 is in use (token=fake-secret-value-123 in /home/fakeuser/app)",
    })];
    sidecars.extend(names);
    system_status(
        &mut report,
        &ok(json!({ "sidecars": sidecars, "gateway": { "reachable": true } })),
    );
    let failed = report.check("services.failed").unwrap();
    assert_eq!(failed.status, Status::Warn);
    assert!(
        failed.detail.contains("notes (port 8003 is in use"),
        "{}",
        failed.detail
    );
    assert!(
        !failed.detail.contains("fake-secret-value-123"),
        "{}",
        failed.detail
    );
    assert!(!failed.detail.contains("fakeuser"), "{}", failed.detail);
    assert!(failed.fix.is_some());
    // Twelve stopped services: eight are named, the rest are counted.
    let running = report.check("services.running").unwrap();
    assert!(
        running.detail.contains("svc7 and 4 more"),
        "{}",
        running.detail
    );
    assert!(!running.detail.contains("svc8"), "{}", running.detail);
    assert!(!running.detail.contains("notes"), "{}", running.detail);
}

// ── Safe Mode ────────────────────────────────────────────────────────────────

#[test]
fn safe_mode_off_passes() {
    let mut report = new_report();
    safe_mode(
        &mut report,
        &ok(json!({ "enabled": false, "source": "off" })),
    );
    assert_eq!(status_of(&report, "safe_mode"), Status::Pass);
}

#[test]
fn safe_mode_on_warns_with_what_it_holds_back() {
    let mut report = new_report();
    safe_mode(
        &mut report,
        &ok(json!({
            "enabled": true,
            "source": "preference",
            "user_clearable": true,
            "suppressed": { "plugins": 34, "kernel_plugins": 3, "skills": 12, "mcp_servers": 5 },
        })),
    );
    let check = report.check("safe_mode").unwrap();
    assert_eq!(check.status, Status::Warn);
    assert!(
        check
            .detail
            .contains("34 apps, 12 skills and 5 MCP servers"),
        "{}",
        check.detail
    );
    assert!(check.fix.as_deref().unwrap().contains("Settings"));
}

#[test]
fn safe_mode_forced_at_start_points_at_the_start_option_not_settings() {
    let mut report = new_report();
    safe_mode(
        &mut report,
        &ok(json!({ "enabled": true, "source": "env", "user_clearable": false })),
    );
    let check = report.check("safe_mode").unwrap();
    assert_eq!(check.status, Status::Warn);
    assert!(check.detail.contains("0 apps"), "{}", check.detail);
    let fix = check.fix.as_deref().unwrap();
    assert!(fix.contains("forced") && !fix.contains("Settings"), "{fix}");
}

// ── The two audits ───────────────────────────────────────────────────────────

fn finding(check_id: &str, severity: &str) -> serde_json::Value {
    json!({
        "checkId": check_id,
        "category": "security",
        "severity": severity,
        "summary": format!("Summary of {check_id}"),
        "detail": format!("Detail of {check_id}"),
        "recommendedAction": format!("Action for {check_id}"),
        "canAutoFix": false,
    })
}

#[test]
fn an_audit_without_warnings_passes() {
    let mut report = new_report();
    audit(
        &mut report,
        Audit::Gateway,
        &ok(json!({ "findings": [finding("a.note", "info")] })),
    );
    let check = report.check("gateway.doctor").unwrap();
    assert_eq!(check.status, Status::Pass);
    assert!(check.detail.contains("1 notes"), "{}", check.detail);
}

#[test]
fn audit_findings_become_checks_with_the_audits_own_fix_line() {
    let mut report = new_report();
    audit(
        &mut report,
        Audit::Gateway,
        &ok(json!({ "findings": [
            finding("a.note", "info"),
            finding("b.warn", "warning"),
            finding("c.err", "error"),
        ] })),
    );
    // Errors are listed before warnings.
    let ids: Vec<&str> = report.checks().iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["gateway.doctor.c.err", "gateway.doctor.b.warn"]);
    let failed = report.check("gateway.doctor.c.err").unwrap();
    assert_eq!(failed.status, Status::Fail);
    assert_eq!(failed.title, "Summary of c.err");
    assert_eq!(failed.detail, "Detail of c.err");
    assert_eq!(failed.fix.as_deref(), Some("Action for c.err"));
    assert_eq!(failed.unit, Some("apps/gateway"));
    assert_eq!(status_of(&report, "gateway.doctor.b.warn"), Status::Warn);
}

#[test]
fn an_app_finding_names_the_app_and_long_lists_are_cut() {
    let mut report = new_report();
    let mut findings: Vec<serde_json::Value> = (0..7)
        .map(|index| finding(&format!("manifest.rule{index}"), "warning"))
        .collect();
    findings[0]["pluginId"] = json!("@ryu/notes");
    audit(
        &mut report,
        Audit::Apps,
        &ok(json!({ "findings": findings })),
    );
    let first = report.check("apps.doctor.manifest.rule0").unwrap();
    assert_eq!(first.title, "@ryu/notes: Summary of manifest.rule0");
    assert_eq!(first.unit, Some("apps/core"));
    // Five findings are listed, two are counted.
    assert!(report.check("apps.doctor.manifest.rule4").is_some());
    assert!(report.check("apps.doctor.manifest.rule5").is_none());
    let rest = report.check("apps.doctor").unwrap();
    assert_eq!(rest.status, Status::Info);
    assert!(
        rest.detail.starts_with("2 more findings"),
        "{}",
        rest.detail
    );
}

#[test]
fn an_audit_that_was_refused_is_skipped() {
    let mut report = new_report();
    audit(&mut report, Audit::Gateway, &Probe::Refused(403));
    assert_eq!(status_of(&report, "gateway.doctor"), Status::Skip);
    let mut report = new_report();
    audit(&mut report, Audit::Apps, &Probe::Refused(502));
    assert_eq!(status_of(&report, "apps.doctor"), Status::Skip);
}

// ── Background processes ─────────────────────────────────────────────────────

fn process(label: &str, running: bool, exit_code: Option<i64>) -> serde_json::Value {
    json!({
        "process_id": "p-1",
        "producer": "pi",
        "kind": "shell",
        "label": label,
        "command": "deploy --password fake-command-line-password",
        "cwd": "/home/fakeuser/private-project",
        "pid": 4242,
        "started_at": 1,
        "running": running,
        "exit_code": exit_code,
    })
}

#[test]
fn background_processes_never_carry_the_command_or_the_folder() {
    let mut report = new_report();
    background_processes(
        &mut report,
        &ok(json!({ "processes": [
            process("dev server", true, None),
            process("build", false, Some(0)),
        ] })),
    );
    let check = report.check("background.processes").unwrap();
    assert_eq!(check.status, Status::Info);
    assert_eq!(
        check.detail,
        "2 known: 1 running, 0 ended with a failure code."
    );
    let out = report.finish(AT);
    assert_eq!(
        out["backgroundProcesses"],
        json!([
            { "label": "dev server", "kind": "shell", "running": true, "exitCode": null },
            { "label": "build", "kind": "shell", "running": false, "exitCode": 0 },
        ])
    );
    let text = out.to_string();
    for hidden in [
        "fake-command-line-password",
        "private-project",
        "fakeuser",
        "4242",
        "p-1",
    ] {
        assert!(!text.contains(hidden), "{hidden} leaked: {text}");
    }
}

#[test]
fn a_process_that_ended_with_a_failure_code_is_a_warning() {
    let mut report = new_report();
    background_processes(
        &mut report,
        &ok(json!({ "processes": [process("migrate", false, Some(2))] })),
    );
    let check = report.check("background.processes").unwrap();
    assert_eq!(check.status, Status::Warn);
    assert!(check.detail.contains("1 ended with a failure code"));
    assert!(check.fix.is_some());
}

#[test]
fn no_background_processes_is_information_and_attaches_nothing() {
    let mut report = new_report();
    background_processes(&mut report, &ok(json!({ "processes": [] })));
    assert_eq!(status_of(&report, "background.processes"), Status::Info);
    assert!(report.finish(AT).get("backgroundProcesses").is_none());
}

#[test]
fn only_the_first_eight_processes_are_listed() {
    let mut report = new_report();
    let many: Vec<serde_json::Value> = (0..11)
        .map(|index| process(&format!("job {index}"), true, None))
        .collect();
    background_processes(&mut report, &ok(json!({ "processes": many })));
    let out = report.finish(AT);
    assert_eq!(out["backgroundProcesses"].as_array().unwrap().len(), 8);
    assert!(out["checks"][0]["detail"]
        .as_str()
        .unwrap()
        .starts_with("11 known: 11 running"));
}
