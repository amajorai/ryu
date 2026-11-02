use serde_json::json;

use super::harness_test::{ctx, store};
use super::*;
use crate::store::Experience;
use crate::test_support::MockHost;

#[tokio::test]
async fn cycle_execute_caps_inline_dataset_under_the_control_body_limit() {
    // Six conversations of ~1 MiB each: ~6 MiB of samples would be rejected
    // (413) by the finetune app's 4 MiB control body limit.
    let big = "x".repeat(1024 * 1024);
    let mut host = MockHost::new()
        .enabled()
        .with_pref(LEARNING_MIN_REWARD_PREF, "0.5")
        .with_pref(LEARNING_BASE_MODEL_PREF, "orig-base");
    for i in 0..6 {
        let id = format!("c{i}");
        host = host
            .with_conversation(&id, 10 + i, 2)
            .with_messages(&id, &[("user", "q"), ("assistant", big.as_str())]);
    }
    host.prm_reply = Some("0.95".to_string());
    host.finetune = Some(json!({ "job_id": "job-big" }));
    let dispatched = host.dispatched.clone();
    let c = ctx(host, store("cycle-exec-big"));
    let plan = run_cycle(&c, true).await.unwrap();
    assert!(plan.dispatched, "{plan:?}");
    let body = dispatched.lock().unwrap().clone().expect("dispatched body");
    let body_len = serde_json::to_vec(&body).unwrap().len();
    assert!(
        body_len < 4 * 1024 * 1024,
        "dispatched body {body_len} bytes"
    );
    let sent = body["dataset"]["samples"].as_array().unwrap().len();
    assert!(sent > 0 && sent < 6, "sent {sent}");
    assert_eq!(plan.sample_count, sent);
    assert!(
        plan.note.contains(&format!("{sent} of 6 samples")),
        "{}",
        plan.note
    );
}

#[test]
fn inline_budget_keeps_the_leading_highest_reward_rows() {
    let row = |text: &str, reward: f64| Experience {
        id: format!("e-{reward}"),
        conversation_id: "c".into(),
        agent_id: None,
        user_text: "q".into(),
        assistant_text: text.into(),
        outcome: "completed".into(),
        reward: Some(reward),
        base_model: None,
        skill_generation: 0,
        excluded: false,
        created_at: String::new(),
    };
    let rows = vec![
        row("best", 0.9),
        row(&"y".repeat(500), 0.8),
        row("small", 0.7),
    ];
    let kept = inline_samples_within_budget(&rows, 200);
    // Stops at the first row that does not fit (no reordering past it).
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["messages"][1]["content"], "best");
    assert!(inline_samples_within_budget(&rows, 10).is_empty());
    assert_eq!(inline_samples_within_budget(&rows, usize::MAX).len(), 3);
}

#[tokio::test]
async fn cycle_execute_remote_without_url_is_a_hard_error() {
    let mut host = MockHost::new()
        .enabled()
        .with_pref(LEARNING_MIN_REWARD_PREF, "0.5")
        .with_pref(LEARNING_BASE_MODEL_PREF, "orig-base")
        .with_pref("learning.train-target", "remote")
        .with_conversation("c1", 10, 2)
        .with_messages("c1", &[("user", "q"), ("assistant", "a")]);
    host.prm_reply = Some("0.95".to_string());
    host.finetune = Some(json!({ "job_id": "job-x" }));
    let c = ctx(host, store("cycle-remote-misconfig"));
    let plan = run_cycle(&c, true).await.unwrap();
    assert!(!plan.dispatched);
    assert!(plan
        .error
        .as_deref()
        .unwrap()
        .contains("remote-url is unset"));
}

#[tokio::test]
async fn cycle_execute_remote_inlines_samples_and_dispatches() {
    let mut host = MockHost::new()
        .enabled()
        .with_pref(LEARNING_MIN_REWARD_PREF, "0.5")
        .with_pref(LEARNING_BASE_MODEL_PREF, "orig-base")
        .with_pref("learning.train-target", "remote")
        .with_pref("learning.remote-url", "https://gpu.example")
        .with_pref("learning.remote-token", "tok-secret")
        .with_conversation("c1", 10, 2)
        .with_messages("c1", &[("user", "q"), ("assistant", "a")]);
    host.prm_reply = Some("0.95".to_string());
    host.finetune = Some(json!({ "job_id": "job-remote" }));
    let c = ctx(host, store("cycle-remote-ok"));
    let plan = run_cycle(&c, true).await.unwrap();
    assert!(plan.dispatched);
    assert_eq!(plan.job_id.as_deref(), Some("job-remote"));
}
