//! End-to-end tests for concurrent DAG execution, the `ForEach` / `Parallel`
//! fan-out nodes, and run history / fork (time travel).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::json;

use super::executor::{fork_run, resume_run, run_workflow};
use super::history::{self, CheckpointEvent};
use super::store::{self, NodeStatus, RunStatus, WorkflowRun};
use super::{GraphError, Workflow, WorkflowGraph};

fn unique(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4().simple())
}

fn workflow(value: serde_json::Value) -> Workflow {
    serde_json::from_value(value).expect("workflow json")
}

fn input(text: &str) -> HashMap<String, String> {
    HashMap::from([("text".to_owned(), text.to_owned())])
}

/// in → a (delay) ┐
///    → b (delay) ┴→ join → out
fn diamond(id: &str, delay_ms: u64, max_concurrency: Option<u32>) -> Workflow {
    workflow(json!({
        "id": id,
        "name": "diamond",
        "max_concurrency": max_concurrency,
        "nodes": [
            { "id": "in", "type": "input", "key": "text" },
            { "id": "a", "type": "delay", "ms": delay_ms },
            { "id": "b", "type": "delay", "ms": delay_ms },
            { "id": "join", "type": "transform", "op": "template",
              "template": "{{nodes.a}}+{{nodes.b}}" },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "a" },
            { "from": "in", "to": "b" },
            { "from": "a", "to": "join" },
            { "from": "b", "to": "join" },
            { "from": "join", "to": "out" }
        ]
    }))
}

#[tokio::test]
async fn independent_branches_run_concurrently_and_join_waits_for_both() {
    let wf = diamond(&unique("wfconc"), 400, None);
    let run_id = unique("runconc");
    let started = Instant::now();
    let run = run_workflow(&wf, input("x"), run_id.clone())
        .await
        .expect("run ok");
    let elapsed = started.elapsed();
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output["result"], "x+x");
    assert!(
        elapsed < Duration::from_millis(750),
        "two 400ms branches ran concurrently, took {elapsed:?}"
    );

    // Both branches stamped durable timers from their private copies; the
    // persisted checkpoint holds both (neither overwrote the other).
    let persisted = store::load_run(&run_id).unwrap();
    for id in ["a", "b"] {
        let node = &persisted.nodes[id];
        assert_eq!(node.status, NodeStatus::Completed);
        assert!(node.wake_at.is_some(), "{id} kept its durable timer stamp");
        assert_eq!(node.attempts, 1);
    }
}

#[tokio::test]
async fn max_concurrency_one_restores_sequential_execution() {
    let wf = diamond(&unique("wfseq"), 250, Some(1));
    let started = Instant::now();
    let run = run_workflow(&wf, input("y"), unique("runseq"))
        .await
        .expect("run ok");
    assert_eq!(run.output["result"], "y+y");
    assert!(
        started.elapsed() >= Duration::from_millis(500),
        "max_concurrency 1 runs one node at a time"
    );
}

#[tokio::test]
async fn concurrent_state_writes_and_condition_skips_merge_deterministically() {
    // Branch L writes `left` after a pause; branch R writes `right` first, then
    // pauses. A condition prunes its false branch, which must be skipped (and
    // propagate) while the other branches run.
    let wf = workflow(json!({
        "id": unique("wfmerge"),
        "name": "merge",
        "nodes": [
            { "id": "in", "type": "input", "key": "text" },
            { "id": "l_wait", "type": "delay", "ms": 150 },
            { "id": "l_set", "type": "set_state", "key": "left", "value": "L-{{input}}" },
            { "id": "r_set", "type": "set_state", "key": "right", "value": "R-{{input}}" },
            { "id": "r_wait", "type": "delay", "ms": 300 },
            { "id": "cond", "type": "condition", "expr": "input == \"go\"" },
            { "id": "yes", "type": "transform", "op": "uppercase" },
            { "id": "no", "type": "transform", "op": "lowercase" },
            { "id": "no_after", "type": "note", "text": "pruned" },
            { "id": "join", "type": "transform", "op": "template",
              "template": "{{state.left}}|{{state.right}}|{{nodes.yes}}" },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "l_wait" },
            { "from": "l_wait", "to": "l_set" },
            { "from": "in", "to": "r_set" },
            { "from": "r_set", "to": "r_wait" },
            { "from": "in", "to": "cond" },
            { "from": "cond", "to": "yes", "branch": "true" },
            { "from": "cond", "to": "no", "branch": "false" },
            { "from": "no", "to": "no_after" },
            { "from": "l_set", "to": "join" },
            { "from": "r_wait", "to": "join" },
            { "from": "yes", "to": "join" },
            { "from": "no_after", "to": "join" },
            { "from": "join", "to": "out" }
        ]
    }));
    let run_id = unique("runmerge");
    let run = run_workflow(&wf, input("go"), run_id.clone())
        .await
        .expect("run ok");
    // `yes` uppercases the condition's own "true" output.
    assert_eq!(run.output["result"], "L-go|R-go|TRUE");
    let persisted = store::load_run(&run_id).unwrap();
    assert_eq!(persisted.state["left"], "L-go");
    assert_eq!(persisted.state["right"], "R-go");
    assert_eq!(persisted.nodes["no"].status, NodeStatus::Skipped);
    assert_eq!(persisted.nodes["no_after"].status, NodeStatus::Skipped);
    assert_eq!(persisted.nodes["join"].status, NodeStatus::Completed);
}

#[tokio::test]
async fn a_failing_branch_lets_in_flight_siblings_finish_then_fails_the_run() {
    let wf = workflow(json!({
        "id": unique("wffail"),
        "name": "fail",
        "nodes": [
            { "id": "in", "type": "input", "key": "text" },
            { "id": "bad", "type": "transform", "op": "no_such_op" },
            { "id": "slow", "type": "delay", "ms": 200 },
            { "id": "after_slow", "type": "set_state", "key": "late", "value": "x" }
        ],
        "edges": [
            { "from": "in", "to": "bad" },
            { "from": "in", "to": "slow" },
            { "from": "slow", "to": "after_slow" }
        ]
    }));
    let run_id = unique("runfail");
    let error = run_workflow(&wf, input("x"), run_id.clone())
        .await
        .expect_err("the run fails");
    assert!(error.contains("no_such_op"), "{error}");
    let persisted = store::load_run(&run_id).unwrap();
    assert_eq!(persisted.status, RunStatus::Failed);
    assert_eq!(persisted.nodes["bad"].status, NodeStatus::Failed);
    // The sibling already in flight completed and was checkpointed...
    assert_eq!(persisted.nodes["slow"].status, NodeStatus::Completed);
    // ...but nothing new started after the failure.
    assert!(!persisted.nodes.contains_key("after_slow"));
}

fn save(value: serde_json::Value) -> Workflow {
    let wf = workflow(value);
    store::save_workflow(&wf).expect("save workflow");
    wf
}

fn uppercase_body(id: &str) -> Workflow {
    save(json!({
        "id": id,
        "name": "body",
        "nodes": [
            { "id": "in", "type": "input", "key": "input" },
            { "id": "up", "type": "transform", "op": "uppercase" },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "up" },
            { "from": "up", "to": "out" }
        ]
    }))
}

#[tokio::test]
async fn for_each_maps_items_in_order_with_bounded_concurrency() {
    let body = uppercase_body(&unique("wfbody"));
    let wf = save(json!({
        "id": unique("wfeach"),
        "name": "each",
        "nodes": [
            { "id": "in", "type": "input", "key": "text" },
            { "id": "list", "type": "set_state", "key": "items", "value": "{{input}}" },
            { "id": "each", "type": "for_each", "body_workflow_id": body.id,
              "items": "{{state.items}}", "max_concurrency": 2 },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "list" },
            { "from": "list", "to": "each" },
            { "from": "each", "to": "out" }
        ]
    }));
    let run_id = unique("runeach");
    let run = run_workflow(&wf, input(r#"["a","b",{"k":1},"d","e"]"#), run_id.clone())
        .await
        .expect("run ok");
    assert_eq!(run.status, RunStatus::Completed);
    let result: serde_json::Value = serde_json::from_str(&run.output["result"]).unwrap();
    // A JSON object result stays structured; strings stay strings.
    assert_eq!(result, json!(["A", "B", { "K": 1 }, "D", "E"]));
    // Progress is dropped once the node completes; child runs are durable.
    assert!(!run.state.keys().any(|k| k.starts_with("__fanout_")));
    let child = store::load_run(&format!("{run_id}-each-item-2")).unwrap();
    assert_eq!(child.status, RunStatus::Completed);
    assert_eq!(child.input["index"], "2");
}

#[tokio::test]
async fn for_each_rejects_non_array_items() {
    let body = uppercase_body(&unique("wfbodyna"));
    let wf = save(json!({
        "id": unique("wfeachna"),
        "name": "each",
        "nodes": [
            { "id": "in", "type": "input", "key": "text" },
            { "id": "each", "type": "for_each", "body_workflow_id": body.id }
        ],
        "edges": [ { "from": "in", "to": "each" } ]
    }));
    let error = run_workflow(&wf, input("not json"), unique("runna"))
        .await
        .expect_err("a non-array fails the node");
    assert!(error.contains("must be a JSON array"), "{error}");
}

#[tokio::test]
async fn for_each_resume_skips_items_finished_before_the_restart() {
    let body = uppercase_body(&unique("wfbodyres"));
    let wf = save(json!({
        "id": unique("wfeachres"),
        "name": "each",
        "nodes": [
            { "id": "in", "type": "input", "key": "text" },
            { "id": "each", "type": "for_each", "body_workflow_id": body.id },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "each" },
            { "from": "each", "to": "out" }
        ]
    }));
    // A run that crashed mid-`each`: item 0 had finished (its result is in the
    // checkpointed progress), items 1 and 2 had not.
    let run_id = unique("runeachres");
    let mut crashed = WorkflowRun::new(run_id.clone(), wf.id.clone(), input(r#"["a","b","c"]"#));
    crashed.nodes.insert(
        "in".into(),
        store::NodeRunState {
            status: NodeStatus::Completed,
            output: Some(r#"["a","b","c"]"#.into()),
            error: None,
            attempts: 1,
            wake_at: None,
        },
    );
    crashed.nodes.insert(
        "each".into(),
        store::NodeRunState {
            status: NodeStatus::Running,
            output: None,
            error: None,
            attempts: 1,
            wake_at: None,
        },
    );
    crashed.state.insert(
        "__fanout_each".into(),
        json!({ "0": "FROM-CHECKPOINT" }).to_string(),
    );
    store::save_run(&crashed).unwrap();

    let run = run_workflow(&wf, crashed.input.clone(), run_id.clone())
        .await
        .expect("resumed run ok");
    let result: serde_json::Value = serde_json::from_str(&run.output["result"]).unwrap();
    assert_eq!(result, json!(["FROM-CHECKPOINT", "B", "C"]));
    // Item 0 never ran again: no child run was created for it.
    assert!(store::load_run(&format!("{run_id}-each-item-0")).is_err());
    assert!(store::load_run(&format!("{run_id}-each-item-1")).is_ok());
}

#[tokio::test]
async fn for_each_items_with_gates_suspend_and_resume_one_item_at_a_time() {
    let body = save(json!({
        "id": unique("wfgatebody"),
        "name": "gate body",
        "nodes": [
            { "id": "in", "type": "input", "key": "input" },
            { "id": "gate", "type": "awakeable", "prompt": "approve item" },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "gate" },
            { "from": "gate", "to": "out" }
        ]
    }));
    let wf = save(json!({
        "id": unique("wfgateeach"),
        "name": "gate each",
        "nodes": [
            { "id": "in", "type": "input", "key": "text" },
            { "id": "each", "type": "for_each", "body_workflow_id": body.id },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "each" },
            { "from": "each", "to": "out" }
        ]
    }));
    let run_id = unique("rungateeach");
    let mut run = run_workflow(&wf, input(r#"["a","b","c"]"#), run_id.clone())
        .await
        .expect("run suspends");
    let mut approvals = Vec::new();
    for round in 0..3 {
        assert_eq!(run.status, RunStatus::AwaitingInput, "round {round}");
        assert_eq!(run.awaiting_node.as_deref(), Some("each"));
        let payload = format!("approved-{round}");
        approvals.push(payload.clone());
        run = resume_run(&run_id, payload).await.expect("resume ok");
    }
    assert_eq!(run.status, RunStatus::Completed);
    let result: Vec<String> = serde_json::from_str(&run.output["result"]).unwrap();
    let mut sorted = result.clone();
    sorted.sort();
    assert_eq!(sorted, approvals, "every item carries exactly one approval");
}

#[tokio::test]
async fn parallel_joins_branch_results_by_id() {
    let up = uppercase_body(&unique("wfparup"));
    let down = save(json!({
        "id": unique("wfpardown"),
        "name": "down",
        "nodes": [
            { "id": "in", "type": "input", "key": "input" },
            { "id": "t", "type": "transform", "op": "template",
              "template": "{\"len\":\"{{input}}\"}" },
            { "id": "out", "type": "output" }
        ],
        "edges": [
            { "from": "in", "to": "t" },
            { "from": "t", "to": "out" }
        ]
    }));
    let wf = save(json!({
        "id": unique("wfpar"),
        "name": "parallel",
        "nodes": [
            { "id": "in", "type": "input", "key": "text" },
            { "id": "fan", "type": "parallel", "branches": [
                { "id": "upper", "workflow_id": up.id },
                { "id": "json", "workflow_id": down.id, "input": "[{{input}}]" }
            ] },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "fan" },
            { "from": "fan", "to": "out" }
        ]
    }));
    let run = run_workflow(&wf, input("hi"), unique("runpar"))
        .await
        .expect("run ok");
    let result: serde_json::Value = serde_json::from_str(&run.output["result"]).unwrap();
    assert_eq!(result, json!({ "upper": "HI", "json": { "len": "[hi]" } }));
}

#[test]
fn fan_out_nodes_are_validated_when_the_graph_is_built() {
    let build = |node: serde_json::Value| {
        WorkflowGraph::build(&workflow(json!({
            "id": "wf_self", "name": "v", "nodes": [node]
        })))
    };
    assert!(matches!(
        build(json!({ "id": "p", "type": "parallel", "branches": [] })),
        Err(GraphError::InvalidNode(..))
    ));
    assert!(matches!(
        build(json!({ "id": "p", "type": "parallel", "branches": [
            { "id": "a", "workflow_id": "x" }, { "id": "a", "workflow_id": "y" }
        ] })),
        Err(GraphError::InvalidNode(..))
    ));
    assert!(matches!(
        build(json!({ "id": "p", "type": "parallel", "branches": [
            { "id": "a/b", "workflow_id": "x" }
        ] })),
        Err(GraphError::InvalidNode(..))
    ));
    assert!(matches!(
        build(json!({ "id": "e", "type": "for_each", "body_workflow_id": "" })),
        Err(GraphError::InvalidNode(..))
    ));
    assert!(matches!(
        build(json!({ "id": "e", "type": "for_each", "body_workflow_id": "wf_self" })),
        Err(GraphError::InvalidNode(..))
    ));
    assert!(build(
        json!({ "id": "e", "type": "for_each", "body_workflow_id": "other",
        "items": "{{state.list}}", "max_concurrency": 3 })
    )
    .is_ok());
}

#[test]
fn new_node_kinds_round_trip_their_wire_format() {
    let wire = json!({
        "id": "wf_wire", "name": "wire", "max_concurrency": 2,
        "nodes": [
            { "id": "e", "type": "for_each", "body_workflow_id": "b", "items": "{{input}}" },
            { "id": "p", "type": "parallel",
              "branches": [ { "id": "x", "workflow_id": "w" } ], "max_concurrency": 8 }
        ]
    });
    let parsed = workflow(wire.clone());
    assert_eq!(parsed.max_concurrency, Some(2));
    let back = serde_json::to_value(&parsed).unwrap();
    assert_eq!(back["nodes"], wire["nodes"]);
    assert_eq!(back["max_concurrency"], 2);
    let absent =
        serde_json::to_value(workflow(json!({ "id": "w", "name": "n", "nodes": [] }))).unwrap();
    assert!(
        absent.get("max_concurrency").is_none(),
        "absent stays absent"
    );
}

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
