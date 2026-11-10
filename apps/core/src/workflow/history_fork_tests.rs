//! End-to-end tests for run history and fork (time travel).

use std::collections::HashMap;

use serde_json::json;

use super::concurrency_tests::{input, save, unique, uppercase_body};
use super::executor::{fork_run, run_workflow};
use super::history::{self, CheckpointEvent};
use super::store::{self, RunStatus, WorkflowRun};
use super::Workflow;

/// in → remember (state.k = input) → shout ("{{state.k}}!") → out
fn fork_workflow() -> Workflow {
    save(json!({
        "id": unique("wffork"),
        "name": "fork",
        "nodes": [
            { "id": "in", "type": "input", "key": "text" },
            { "id": "remember", "type": "set_state", "key": "k", "value": "{{input}}" },
            { "id": "shout", "type": "transform", "op": "template", "template": "{{state.k}}!" },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "remember" },
            { "from": "remember", "to": "shout" },
            { "from": "shout", "to": "out" }
        ]
    }))
}

#[tokio::test]
async fn history_records_every_node_checkpoint_with_state_snapshots() {
    let wf = fork_workflow();
    let run_id = unique("runhist");
    run_workflow(&wf, input("a"), run_id.clone())
        .await
        .expect("run ok");
    let checkpoints = history::list(&run_id).unwrap();
    let events: Vec<(CheckpointEvent, Option<&str>)> = checkpoints
        .iter()
        .map(|c| (c.event, c.node_id.as_deref()))
        .collect();
    assert_eq!(
        events,
        vec![
            (CheckpointEvent::RunStarted, None),
            (CheckpointEvent::NodeCompleted, Some("in")),
            (CheckpointEvent::NodeCompleted, Some("remember")),
            (CheckpointEvent::NodeCompleted, Some("shout")),
            (CheckpointEvent::NodeCompleted, Some("out")),
            (CheckpointEvent::RunCompleted, None),
        ]
    );
    for (sequence, checkpoint) in checkpoints.iter().enumerate() {
        assert_eq!(checkpoint.sequence, sequence as u64);
        assert_eq!(
            checkpoint.iteration,
            u64::from(checkpoint.node_id.is_some())
        );
    }
    assert!(!checkpoints[1].state.contains_key("k"));
    assert_eq!(checkpoints[2].state["k"], "a");
    assert_eq!(checkpoints[5].output["result"], "a!");
}

#[tokio::test]
async fn fork_replays_from_a_checkpoint_with_a_state_patch() {
    let wf = fork_workflow();
    let run_id = unique("runforkparent");
    run_workflow(&wf, input("a"), run_id.clone())
        .await
        .expect("run ok");
    let after_remember = history::list(&run_id)
        .unwrap()
        .into_iter()
        .find(|c| c.node_id.as_deref() == Some("remember"))
        .unwrap();

    let forked = fork_run(
        &run_id,
        &after_remember.checkpoint_id,
        HashMap::from([("k".to_owned(), "patched".to_owned())]),
    )
    .await
    .expect("fork ok");
    assert_ne!(forked.run_id, run_id);
    assert_eq!(forked.status, RunStatus::Completed);
    // `remember` was copied, not re-run: re-running it would have reset k to "a".
    assert_eq!(forked.output["result"], "patched!");
    let lineage = forked.forked_from.clone().expect("lineage");
    assert_eq!(lineage.run_id, run_id);
    assert_eq!(lineage.checkpoint_id, after_remember.checkpoint_id);
    let fork_history = history::list(&forked.run_id).unwrap();
    assert_eq!(fork_history[0].event, CheckpointEvent::Forked);
    assert_eq!(fork_history[0].state["k"], "patched");
    assert!(fork_history
        .iter()
        .all(|c| c.node_id.as_deref() != Some("remember")));

    // The parent is untouched.
    let parent = store::load_run(&run_id).unwrap();
    assert_eq!(parent.output["result"], "a!");
    assert!(parent.forked_from.is_none());

    // Forking without a patch replays the original result.
    let replay = fork_run(&run_id, &after_remember.checkpoint_id, HashMap::new())
        .await
        .expect("replay ok");
    assert_eq!(replay.output["result"], "a!");
}

#[tokio::test]
async fn fork_rejects_engine_state_patches_and_unknown_checkpoints() {
    let wf = fork_workflow();
    let run_id = unique("runforkbad");
    run_workflow(&wf, input("a"), run_id.clone())
        .await
        .expect("run ok");
    let error = fork_run(
        &run_id,
        "cp-000001",
        HashMap::from([("__workflow_parent_run".to_owned(), "x".to_owned())]),
    )
    .await
    .expect_err("engine keys are refused");
    assert!(error.contains("state_patch"), "{error}");
    let error = fork_run(&run_id, "cp-999999", HashMap::new())
        .await
        .expect_err("unknown checkpoint");
    assert!(error.contains("not found"), "{error}");
    let error = fork_run(&unique("missing"), "cp-000000", HashMap::new())
        .await
        .expect_err("unknown run");
    assert!(error.contains("not found"), "{error}");
}

#[tokio::test]
async fn fork_refuses_caller_scoped_script_runs() {
    let run_id = unique("runforkscript");
    let mut run = WorkflowRun::new(
        run_id.clone(),
        format!("{}{}", store::SCRIPT_WORKFLOW_PREFIX, unique("body")),
        HashMap::new(),
    );
    run.status = RunStatus::Completed;
    store::save_run(&run).unwrap();
    history::append(&run, CheckpointEvent::RunStarted, None, 0).unwrap();
    let error = fork_run(&run_id, "cp-000000", HashMap::new())
        .await
        .expect_err("script runs stay scoped to their caller");
    assert!(error.contains("cannot be forked"), "{error}");
}

#[tokio::test]
async fn fork_from_a_failure_checkpoint_reruns_the_failed_node_with_patched_state() {
    // `each` fails while `state.raw` is not a JSON array; fork the failure
    // checkpoint with a patched value.
    let body = uppercase_body(&unique("wfforkbody"));
    let wf = save(json!({
        "id": unique("wfforkfail"),
        "name": "fork fail",
        "nodes": [
            { "id": "in", "type": "input", "key": "text" },
            { "id": "flag", "type": "set_state", "key": "raw", "value": "{{input}}" },
            { "id": "each", "type": "for_each", "body_workflow_id": body.id,
              "items": "{{state.raw}}" },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "flag" },
            { "from": "flag", "to": "each" },
            { "from": "each", "to": "out" }
        ]
    }));
    let run_id = unique("runforkfail");
    let error = run_workflow(&wf, input("nope"), run_id.clone())
        .await
        .expect_err("the parent fails");
    assert!(error.contains("JSON array"), "{error}");
    let checkpoints = history::list(&run_id).unwrap();
    let failed = checkpoints
        .iter()
        .find(|c| c.event == CheckpointEvent::NodeFailed)
        .expect("the failure is a checkpoint");
    assert_eq!(failed.node_id.as_deref(), Some("each"));
    assert_eq!(
        checkpoints.last().unwrap().event,
        CheckpointEvent::RunFailed
    );

    let forked = fork_run(
        &run_id,
        &failed.checkpoint_id,
        HashMap::from([("raw".to_owned(), r#"["x","y"]"#.to_owned())]),
    )
    .await
    .expect("the fork succeeds");
    assert_eq!(forked.status, RunStatus::Completed);
    let result: serde_json::Value = serde_json::from_str(&forked.output["result"]).unwrap();
    assert_eq!(result, json!(["X", "Y"]));
    // Its children are its own: the fork's run id scopes every child run.
    assert!(store::load_run(&format!("{}-each-item-0", forked.run_id)).is_ok());
    assert_eq!(store::load_run(&run_id).unwrap().status, RunStatus::Failed);
}
