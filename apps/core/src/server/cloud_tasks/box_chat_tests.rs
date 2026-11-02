use super::super::{FinishSummary, PullRequestRef};
use super::{finish_event, run_event};
use crate::server::subscription_cloud::chat_event::CLOUD_TASK_PART;
use serde_json::Value;

fn summary(files: u64) -> FinishSummary {
    FinishSummary {
        branch: Some("ryu/abc".into()),
        head_sha: None,
        pushed: true,
        push_error: None,
        compare_url: None,
        pull_request: None,
        pull_request_error: None,
        teardown: "destroyed".into(),
        files,
        insertions: 1200,
        deletions: 4,
    }
}

fn data(parts: &Value) -> &Value {
    assert_eq!(parts[1]["type"], CLOUD_TASK_PART);
    &parts[1]["data"]
}

#[test]
fn finish_counts_one_file_and_two_files() {
    assert_eq!(
        finish_event(&summary(1)).text(),
        "Pushed branch `ryu/abc` (1 file changed, +1,200 -4).\n\nThe cloud box was destroyed."
    );
    assert_eq!(
        finish_event(&summary(2)).text(),
        "Pushed branch `ryu/abc` (2 files changed, +1,200 -4).\n\nThe cloud box was destroyed."
    );
}

#[test]
fn finish_part_carries_facts_and_message_sources() {
    let mut finish = summary(2);
    finish.pull_request = Some(PullRequestRef {
        url: "https://github.com/acme/app/pull/7".into(),
        number: 7,
    });
    finish.teardown = "kept".into();
    let event = finish_event(&finish);
    let parts = event.parts();
    assert_eq!(parts[0]["type"], "text");
    assert_eq!(parts[0]["text"], event.text());
    let data = data(&parts);
    assert_eq!(data["kind"], "finish");
    assert_eq!(data["branch"], "ryu/abc");
    assert_eq!(data["files"], 2);
    assert_eq!(data["prNumber"], 7);
    assert_eq!(data["prUrl"], "https://github.com/acme/app/pull/7");
    assert_eq!(data["teardown"], "kept");
    assert!(data.get("pushError").is_none(), "null facts are left out");
    let messages = data["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[0]["message"],
        "Pushed branch {branch} ({files} files changed, +{insertions} -{deletions})."
    );
    assert_eq!(messages[0]["args"]["branch"], "`ryu/abc`");
    assert_eq!(messages[0]["args"]["files"]["number"], 2.0);
    assert_eq!(
        messages[1]["message"],
        "Opened pull request #{number}: {url}"
    );
    assert_eq!(messages[1]["args"]["number"], "7");
    assert_eq!(
        messages[2]["message"],
        "The cloud box is still running until it expires or is stopped."
    );
}

#[test]
fn finish_reports_a_failed_push_and_a_compare_link() {
    let mut finish = summary(1);
    finish.pushed = false;
    finish.push_error = Some("auth".into());
    finish.compare_url = Some("https://github.com/acme/app/compare/main...ryu/abc".into());
    finish.teardown = "kept".into();
    assert_eq!(
        finish_event(&finish).text(),
        "Committed the changes (1 file changed, +1,200 -4), but pushing `ryu/abc` failed (auth). \
The cloud box was kept so no work is lost.\n\n\
Open a pull request: https://github.com/acme/app/compare/main...ryu/abc\n\n\
The cloud box is still running until it expires or is stopped."
    );
    finish.push_error = None;
    finish.branch = None;
    assert!(finish_event(&finish)
        .text()
        .starts_with("Finished the cloud task (1 file changed, +1,200 -4)."));
}

#[test]
fn run_part_keeps_the_agent_summary_verbatim() {
    let event = run_event(Some("  Done  "), Some(2), None);
    let parts = event.parts();
    let data = data(&parts);
    assert_eq!(data["kind"], "run");
    assert_eq!(data["lead"], "Done");
    assert_eq!(data["exitCode"], 2);
    assert_eq!(data["messages"][0]["message"], "Exit code {code}.");
    assert_eq!(data["messages"][0]["args"]["code"], "2");
    let empty = run_event(None, None, Some("timeout"));
    assert_eq!(
        empty.text(),
        "The agent finished without output.\n\nThe run ended early (timeout)."
    );
    assert!(empty.parts()[1]["data"].get("lead").is_none());
}
