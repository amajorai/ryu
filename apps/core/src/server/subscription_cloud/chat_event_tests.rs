use super::super::store::RunRecord;
use super::super::CloudTaskBackend;
use super::{plan_result_event, plan_start_event, ChatEvent, CLOUD_TASK_PART};
use crate::i18n::{messages, Message};

fn record(backend: CloudTaskBackend) -> RunRecord {
    RunRecord {
        conversation_id: "c1".into(),
        owner: "owner".into(),
        backend,
        environment_id: "env".into(),
        executor: "claude-code".into(),
        account_id: None,
        external_id: None,
        url: None,
        status: "completed".into(),
        summary: None,
        last_error: None,
        output_tail: None,
        workspace: None,
        branch: None,
        created_at: 0,
        updated_at: 0,
        result_posted: false,
    }
}

#[test]
fn plan_start_names_the_branch_the_link_or_the_provider_site() {
    let mut run = record(CloudTaskBackend::AnthropicSubscriptionSdk);
    run.workspace = Some("/tmp/w".into());
    run.branch = Some("ryu/task".into());
    assert_eq!(
        plan_start_event(&run).text(),
        "Running in Claude Code on this node on your Claude plan, on branch ryu/task. \
Follow it in the task panel. This task does not use Ryu credits."
    );
    let mut cloud = record(CloudTaskBackend::AnthropicSubscriptionCli);
    cloud.url = Some("https://claude.ai/code/session_1".into());
    let event = plan_start_event(&cloud);
    assert_eq!(
        event.text(),
        "Sent to Claude Code on your Claude plan. Follow it at https://claude.ai/code/session_1. \
This task does not use Ryu credits."
    );
    let parts = event.parts();
    assert_eq!(parts[1]["type"], CLOUD_TASK_PART);
    assert_eq!(parts[1]["data"]["kind"], "planStart");
    assert_eq!(parts[1]["data"]["backend"], "anthropic-subscription-cli");
    assert_eq!(
        parts[1]["data"]["messages"][0]["args"]["planName"],
        "Claude"
    );
    cloud.url = None;
    assert!(plan_start_event(&cloud)
        .text()
        .contains("Follow it at the provider's site."));
}

#[test]
fn plan_result_maps_the_status_word_to_a_sentence() {
    let mut run = record(CloudTaskBackend::OpenaiSubscriptionCli);
    for (status, text) in [
        ("completed", "Codex · default: The task completed."),
        ("succeeded", "Codex · default: The task completed."),
        ("error", "Codex · default: The task failed."),
        ("stopped", "Codex · default: The task was stopped."),
        ("ready", "Codex · default: The task is ready."),
        ("cancelled", "Codex · default: The task finished."),
    ] {
        run.status = status.into();
        assert_eq!(plan_result_event(&run, "Codex · default").text(), text);
    }
    run.summary = Some("Fixed the bug.".into());
    let event = plan_result_event(&run, "Codex · default");
    assert_eq!(event.text(), "Codex · default: Fixed the bug.");
    let parts = event.parts();
    assert_eq!(parts[1]["data"]["lead"], "Fixed the bug.");
    assert_eq!(parts[1]["data"]["prefix"], "Codex · default");
    assert_eq!(parts[1]["data"]["messages"].as_array().unwrap().len(), 0);
}

#[test]
fn renders_the_body_in_another_locale_from_the_same_sources() {
    let event = ChatEvent::new("run").say(Message::new(messages::CLOUD_RUN_NO_OUTPUT_MESSAGE));
    assert_eq!(event.text(), "The agent finished without output.");
    // A locale without a translation falls back to English, never to nothing.
    assert!(!event.render("ja").is_empty());
}
