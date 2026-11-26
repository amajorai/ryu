//! The report shape and its redaction of every text.

use serde_json::json;

use super::*;

const AT: &str = "2026-11-18T15:00:00Z";

#[test]
fn an_empty_report_has_every_field_of_the_troubleshooter_shape() {
    let report = Report::new(Scope::Node).finish(AT);
    assert_eq!(report["surface"], json!("core"));
    assert_eq!(report["generatedAt"], json!(AT));
    assert_eq!(report["scope"], json!("node"));
    assert_eq!(report["description"], json!(""));
    assert_eq!(report["version"], json!(""));
    assert_eq!(report["checks"], json!([]));
    assert_eq!(report["machine"], json!([]));
    assert_eq!(report["logExcerpt"], json!([]));
    assert_eq!(report["similarIssues"], json!([]));
    assert_eq!(report["notChecked"], json!([]));
    assert_eq!(
        report["summary"],
        json!({ "fail": 0, "warn": 0, "skip": 0, "info": 0, "pass": 0 })
    );
    assert!(report["guide"].as_str().unwrap().contains("data"));
}

#[test]
fn problems_come_first_and_the_summary_counts_each_status() {
    let mut report = Report::new(Scope::Conversation);
    report.push(Check::new("a.pass", Status::Pass, "A", "fine"));
    report.push(Check::new("b.info", Status::Info, "B", "note"));
    report.push(Check::new("c.warn", Status::Warn, "C", "careful"));
    report.push(Check::new("d.fail", Status::Fail, "D", "broken"));
    report.push(Check::new("e.skip", Status::Skip, "E", "not read"));
    report.push(Check::new("f.fail", Status::Fail, "F", "broken too"));
    assert_eq!(report.checks().len(), 6);
    assert_eq!(report.check("c.warn").unwrap().status, Status::Warn);
    assert!(report.check("nope").is_none());

    let report = report.finish(AT);
    let ids: Vec<&str> = report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|check| check["id"].as_str().unwrap())
        .collect();
    // Failures, then warnings, then the rest; equal statuses keep their order.
    assert_eq!(
        ids,
        ["d.fail", "f.fail", "c.warn", "e.skip", "b.info", "a.pass"]
    );
    assert_eq!(
        report["summary"],
        json!({ "fail": 2, "warn": 1, "skip": 1, "info": 1, "pass": 1 })
    );
    assert_eq!(report["scope"], json!("conversation"));
}

#[test]
fn a_fix_line_is_shown_only_while_the_check_is_a_problem() {
    let mut report = Report::new(Scope::Node);
    report.push(
        Check::new("x.fail", Status::Fail, "X", "down")
            .fix("Restart it.")
            .search("x down")
            .unit("apps/gateway"),
    );
    report.push(
        Check::new("y.pass", Status::Pass, "Y", "up")
            .fix("Restart it.")
            .search("y down")
            .unit("apps/core"),
    );
    let report = report.finish(AT);
    let failing = &report["checks"][0];
    assert_eq!(failing["status"], json!("fail"));
    assert_eq!(failing["fix"], json!("Restart it."));
    assert_eq!(failing["searchTerms"], json!("x down"));
    assert_eq!(failing["unit"], json!("apps/gateway"));
    let passing = &report["checks"][1];
    assert_eq!(passing["status"], json!("pass"));
    assert!(passing.get("fix").is_none());
    assert!(passing.get("searchTerms").is_none());
    assert!(passing.get("unit").is_none());
}

#[test]
fn every_text_of_a_check_is_redacted_and_cut() {
    let mut report = Report::new(Scope::Node);
    let long = "word ".repeat(200);
    report.push(
        Check::new(
            "leaky",
            Status::Fail,
            "Call for someone@example.com failed",
            format!("Authorization: Bearer fake-credential-0000000000 was refused. {long}"),
        )
        .fix("Open /home/fakeuser/.ryu/config and retry with --token fake-flag-value"),
    );
    let report = report.finish(AT);
    let check = &report["checks"][0];
    let title = check["title"].as_str().unwrap();
    let detail = check["detail"].as_str().unwrap();
    let fix = check["fix"].as_str().unwrap();
    assert!(!title.contains("someone@example.com"), "{title}");
    assert!(!detail.contains("fake-credential-0000000000"), "{detail}");
    assert!(!fix.contains("fakeuser"), "{fix}");
    assert!(!fix.contains("fake-flag-value"), "{fix}");
    // 300 characters and the mark that says the line was cut.
    assert_eq!(detail.chars().count(), LINE_CHARS + 1, "{detail}");
    assert!(detail.ends_with('…'));
}

#[test]
fn facts_reasons_and_sections_are_carried() {
    let mut report = Report::new(Scope::Node);
    report.set_version(" 0.5.0 ");
    report.fact("Ryu version", "0.5.0");
    report.fact("Platform", "  ");
    report.fact("Data folder", "C:\\Users\\fakeuser\\.ryu");
    report.not_checked("logs", "Log lines are not read.");
    report.attach("faults", json!([{ "name": "web.search" }]));
    let report = report.finish(AT);
    assert_eq!(report["version"], json!("0.5.0"));
    // The empty fact is dropped, and a home folder never leaves as a fact.
    assert_eq!(
        report["machine"],
        json!([["Ryu version", "0.5.0"], ["Data folder", "~\\.ryu"]])
    );
    assert_eq!(
        report["notChecked"],
        json!([{ "id": "logs", "reason": "Log lines are not read." }])
    );
    assert_eq!(report["faults"], json!([{ "name": "web.search" }]));
}
