use serde_json::json;

use super::harness_test::{ctx, store};
use super::*;
use crate::store::Experience;
use crate::test_support::MockHost;

#[test]
fn build_jsonl_emits_one_chat_sample_per_line() {
    let rows = vec![Experience {
        id: "a".into(),
        conversation_id: "c".into(),
        agent_id: None,
        user_text: "hi".into(),
        assistant_text: "hello".into(),
        outcome: "completed".into(),
        reward: Some(0.9),
        base_model: None,
        skill_generation: 0,
        excluded: false,
        created_at: "t".into(),
    }];
    let jsonl = build_jsonl(&rows);
    assert_eq!(jsonl.lines().count(), 1);
    let parsed: SftSample = serde_json::from_str(jsonl.lines().next().unwrap()).unwrap();
    assert_eq!(parsed.messages[0].role, "user");
    assert_eq!(parsed.messages[1].content, "hello");
}

// ---- merge handoff ---------------------------------------------------

#[tokio::test]
async fn merge_handoff_requires_an_adapter() {
    let c = ctx(MockHost::new(), store("merge-missing"));
    let err = merge_cycle_output(&c, json!({})).await.unwrap_err();
    assert!(format!("{err:#}").contains("adapter_name"));
}

#[tokio::test]
async fn merge_handoff_returns_registered_model_stem_without_switching_it() {
    let mut host = MockHost::new();
    host.merged = Some(json!({
        "stem": "learning-merged-1",
        "gguf_path": "/models/learning-merged-1.gguf"
    }));
    let c = ctx(host, store("merge-ok"));
    let out = merge_cycle_output(&c, json!({ "adapter_name": "adapter-1" }))
        .await
        .unwrap();
    assert_eq!(out["model_id"], "learning-merged-1");
    assert_eq!(out["serving"], false);
    assert_eq!(out["activate_with"], "/api/models/active");
}

#[tokio::test]
async fn merge_handoff_rejects_unusable_merge_response() {
    let mut host = MockHost::new();
    host.merged = Some(json!({ "gguf_path": "/models/unknown.gguf" }));
    let c = ctx(host, store("merge-no-stem"));
    let err = merge_cycle_output(&c, json!({ "adapter_path": "/tmp/a" }))
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("model stem"));
}

// ---- run_cycle + dispatch --------------------------------------------

#[tokio::test]
async fn cycle_noop_when_training_disabled() {
    let c = ctx(MockHost::new(), store("cycle-off"));
    let plan = run_cycle(&c, false).await.unwrap();
    assert_eq!(plan.sample_count, 0);
    assert!(!plan.dispatched);
    assert!(plan.note.contains("disabled"));
}

#[tokio::test]
async fn cycle_carries_and_validates_improvement_run_reference() {
    let c = ctx(MockHost::new(), store("cycle-improvement-link"));
    let plan = run_cycle_with_improvement(&c, false, Some("improvement-1"))
        .await
        .unwrap();
    assert_eq!(plan.improvement_run_id.as_deref(), Some("improvement-1"));

    let error = run_cycle_with_improvement(&c, false, Some("../escape"))
        .await
        .expect_err("path-like improvement ids must fail closed");
    assert!(error.to_string().contains("invalid improvement run id"));
}

#[tokio::test]
async fn cycle_dry_run_sweeps_scores_and_assembles() {
    let mut host = MockHost::new()
        .enabled()
        .with_pref(LEARNING_MIN_REWARD_PREF, "0.5")
        .with_conversation("c1", 10, 2)
        .with_messages("c1", &[("user", "q"), ("assistant", "a")]);
    host.prm_reply = Some("0.9".to_string());
    let c = ctx(host, store("cycle-dry"));
    let plan = run_cycle(&c, false).await.unwrap();
    assert_eq!(plan.swept, 1);
    assert_eq!(plan.scored, 1);
    assert_eq!(plan.sample_count, 1);
    assert!(!plan.dispatched);
    assert!(plan.error.is_none());
    assert!(plan.note.contains("dry run"));
    // The dataset is never written to disk (plaintext copy of the buffer).
    assert!(plan.dataset_path.is_none());
}

#[tokio::test]
async fn cycle_execute_without_base_model_fails_to_dispatch() {
    let mut host = MockHost::new()
        .enabled()
        .with_pref(LEARNING_MIN_REWARD_PREF, "0.5")
        .with_conversation("c1", 10, 2)
        .with_messages("c1", &[("user", "q"), ("assistant", "a")]);
    host.prm_reply = Some("0.9".to_string());
    let c = ctx(host, store("cycle-nobase"));
    let plan = run_cycle(&c, true).await.unwrap();
    assert!(!plan.dispatched);
    assert!(plan.error.as_deref().unwrap().contains("base-model"));
}

#[tokio::test]
async fn cycle_execute_local_dispatches_finetune() {
    let mut host = MockHost::new()
        .enabled()
        .with_pref(LEARNING_MIN_REWARD_PREF, "0.5")
        .with_pref(LEARNING_BASE_MODEL_PREF, "orig-base")
        .with_conversation("c1", 10, 2)
        .with_messages("c1", &[("user", "q"), ("assistant", "a")]);
    host.prm_reply = Some("0.95".to_string());
    host.finetune = Some(json!({ "job_id": "job-123" }));
    let dispatched = host.dispatched.clone();
    let c = ctx(host, store("cycle-exec"));
    let plan = run_cycle(&c, true).await.unwrap();
    assert!(plan.dispatched);
    assert_eq!(plan.job_id.as_deref(), Some("job-123"));
    assert!(plan.error.is_none());
    assert!(plan.note.contains("fine-tune dispatched"));
    // Local training gets the samples inline: no plaintext dataset file.
    let body = dispatched.lock().unwrap().clone().expect("dispatched body");
    assert_eq!(body["target"], "local");
    assert!(body["dataset"].get("path").is_none());
    assert_eq!(body["dataset"]["samples"][0]["messages"][0]["content"], "q");
    assert_eq!(body["dataset"]["samples"][0]["messages"][1]["content"], "a");
}
