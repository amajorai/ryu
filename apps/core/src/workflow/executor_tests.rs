use super::*;
use crate::workflow::test_support as ts;
#[test]
fn nested_workflows_complete_at_depth_limit_on_an_ordinary_worker_stack() {
    // Match Rust/Tokio's ordinary worker stack rather than enlarging it to
    // accommodate the executor. No gateway or global runtime is mocked.
    std::thread::Builder::new()
        .name("workflow-depth-proof".into())
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    fn definition(id: String, child: Option<String>, invalid: bool) -> Workflow {
                        let mut nodes = vec![ts::node(
                            "input",
                            NodeKind::Input {
                                key: Some("input".into()),
                            },
                        )];
                        if let Some(workflow_id) = child {
                            nodes.push(ts::node("child", NodeKind::SubWorkflow { workflow_id }));
                        }
                        nodes.push(ts::node(
                            "append",
                            NodeKind::Transform {
                                op: if invalid {
                                    "invalid-transform"
                                } else {
                                    "template"
                                }
                                .into(),
                                template: Some("{{input}}x".into()),
                            },
                        ));
                        nodes.push(ts::node(
                            "output",
                            NodeKind::Output {
                                key: Some("result".into()),
                            },
                        ));
                        let edges = nodes
                            .windows(2)
                            .map(|pair| ts::edge(pair[0].id.clone(), pair[1].id.clone()))
                            .collect();
                        ts::workflow(id, "Nested stack regression", nodes, edges)
                    }
                    for (depth, invalid, loop_body, expected_error) in [
                        (MAX_SUBWORKFLOW_DEPTH, false, false, None),
                        (
                            MAX_SUBWORKFLOW_DEPTH + 1,
                            false,
                            false,
                            Some("nesting exceeded max depth"),
                        ),
                        (1, true, false, Some("unknown transform op")),
                        (1, true, true, Some("unknown transform op")),
                    ] {
                        let namespace = uuid::Uuid::new_v4().simple().to_string();
                        let mut child = None;
                        let mut definitions = Vec::new();
                        for level in (0..=depth).rev() {
                            let mut workflow = definition(
                                format!("stack-{namespace}-{level}"),
                                child,
                                invalid && level == depth,
                            );
                            if loop_body && level == 0 {
                                let NodeKind::SubWorkflow { workflow_id } = &workflow.nodes[1].kind
                                else {
                                    unreachable!()
                                };
                                workflow.nodes[1].kind = NodeKind::While {
                                    expr: "input nonempty".into(),
                                    body_workflow_id: Some(workflow_id.clone()),
                                    max_iterations: Some(2),
                                };
                            }
                            store::save_workflow(&workflow).unwrap();
                            child = Some(workflow.id.clone());
                            definitions.push(workflow);
                        }
                        let workflow = definitions.last().unwrap();
                        let run_id = format!("stack-run-{namespace}");
                        let input = HashMap::from([("input".into(), "seed".into())]);
                        let result = run_workflow(workflow, input.clone(), run_id.clone()).await;
                        let saved = store::load_run(&run_id).unwrap();
                        assert_eq!(saved.input, input);
                        if let Some(expected_error) = expected_error {
                            assert!(result.unwrap_err().contains(expected_error));
                            assert_eq!(saved.status, RunStatus::Failed);
                            assert!(saved.error.as_deref().unwrap().contains(expected_error));
                            assert!(saved.output.is_empty());
                            assert_eq!(saved.nodes["child"].status, NodeStatus::Failed);
                            assert!(
                                !saved.nodes.contains_key("append"),
                                "a child failure must stop before the parent transform"
                            );
                            assert!(!saved.nodes.contains_key("output"));
                            if invalid {
                                let child_run_id = if loop_body {
                                    format!("{run_id}-child-iter-0")
                                } else {
                                    format!("{run_id}-sub-child")
                                };
                                let child = store::load_run(&child_run_id).unwrap();
                                assert_eq!(child.status, RunStatus::Failed);
                                assert_eq!(child.nodes["append"].status, NodeStatus::Failed);
                                assert!(child.output.is_empty());
                                // A child that ran and failed ends the loop with
                                // nothing left to resume, so its counter and carry
                                // are dropped (only a suspension keeps them).
                                assert!(saved.state.get("__while_child").is_none());
                                assert!(saved.state.get("__while_carry_child").is_none());
                            }
                        } else {
                            assert_eq!(result.unwrap().status, RunStatus::Completed);
                            assert_eq!(
                                saved.output["result"],
                                format!("seed{}", "x".repeat(depth + 1))
                            );
                            let mut child_run_id = run_id.clone();
                            for level in 0..=depth {
                                let nested = store::load_run(&child_run_id).unwrap();
                                assert_eq!(nested.status, RunStatus::Completed);
                                assert_eq!(
                                    nested.workflow_id,
                                    format!("stack-{namespace}-{level}")
                                );
                                assert_eq!(
                                    nested.output["result"],
                                    format!("seed{}", "x".repeat(depth - level + 1))
                                );
                                child_run_id.push_str("-sub-child");
                            }
                        }
                        for workflow in definitions {
                            store::delete_workflow(&workflow.id).unwrap();
                        }
                    }
                });
        })
        .unwrap()
        .join()
        .unwrap();
}

#[tokio::test]
async fn nested_human_input_suspends_parent_until_child_gate_completes() {
    for plugin_boundary in [false, true] {
        let namespace = uuid::Uuid::new_v4().simple().to_string();
        let child_id = format!("gate-child-{namespace}");
        let child:Workflow=serde_json::from_value(serde_json::json!({
            "id":child_id,"name":"Nested approval child",
            "nodes":[{"id":"input","type":"input","key":"input"},{"id":"approval","type":"awakeable"},{"id":"output","type":"output","key":"result"}],
            "edges":[{"from":"input","to":"approval"},{"from":"approval","to":"output"}]
        })).unwrap();
        store::save_workflow(&child).unwrap();
        let plugins_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir();
        std::fs::create_dir_all(&plugins_dir).unwrap();
        let plugin_fixture = tempfile::tempdir_in(&plugins_dir).unwrap();
        let plugin_id = format!("@fixture/nested-gate-{namespace}");
        let nested_kind = if plugin_boundary {
            std::fs::write(plugin_fixture.path().join("manifest.json"),serde_json::to_vec(&serde_json::json!({
                "id":plugin_id,"name":"Nested gate fixture","version":"1.0.0",
                "runnables":[{"id":"nested","name":"Nested workflow","kind":"workflow","config":{"entry":child_id}}]
            })).unwrap()).unwrap();
            serde_json::json!({"id":"nested","type":"plugin","plugin_id":plugin_id,"runnable_id":"nested","args":{}})
        } else {
            serde_json::json!({"id":"nested","type":"sub_workflow","workflow_id":child_id})
        };
        let parent:Workflow=serde_json::from_value(serde_json::json!({
            "id":format!("gate-parent-{namespace}"),"name":"Nested approval parent",
            "nodes":[{"id":"input","type":"input","key":"input"},nested_kind,
                {"id":"after-child","type":"set_state","key":"after-child","value":"only-after-approval"},
                {"id":"output","type":"output","key":"result"}],
            "edges":[{"from":"input","to":"nested"},{"from":"nested","to":"after-child"},{"from":"after-child","to":"output"}]
        })).unwrap();
        store::save_workflow(&parent).unwrap();
        let run_id = format!("gate-run-{namespace}");
        let input = HashMap::from([("input".into(), format!("caller-input-{namespace}"))]);
        let suspended = run_workflow(&parent, input.clone(), run_id.clone())
            .await
            .expect("nested input suspends instead of prematurely completing");
        assert_eq!(suspended.status, RunStatus::AwaitingInput);
        let child_run_id = if plugin_boundary {
            format!("{run_id}-plugin-nested")
        } else {
            format!("{run_id}-sub-nested")
        };
        let persisted = store::load_run(&run_id).unwrap();
        assert_eq!(persisted.workflow_id, parent.id);
        assert_eq!(persisted.status, RunStatus::AwaitingInput);
        assert!(persisted.error.is_none());
        assert_eq!(persisted.awaiting_node.as_deref(), Some("nested"));
        assert_eq!(persisted.nodes["nested"].status, NodeStatus::Running);
        assert_eq!(persisted.state.get(AWAITING_CHILD_KEY), Some(&child_run_id));
        assert!(persisted.output.is_empty());
        assert!(!persisted.state.contains_key("after-child"));
        assert!(!persisted.nodes.contains_key("after-child"));
        assert!(!persisted.nodes.contains_key("output"));
        let child_run = store::load_run(&child_run_id).unwrap();
        assert_eq!(child_run.workflow_id, child.id);
        assert_eq!(child_run.input, input);
        assert_eq!(child_run.status, RunStatus::AwaitingInput);
        assert_eq!(child_run.awaiting_node.as_deref(), Some("approval"));
        assert_eq!(child_run.nodes["approval"].status, NodeStatus::Running);
        assert!(child_run.nodes["approval"].output.is_none());
        assert!(!child_run.nodes.contains_key("output"));
        assert_eq!(child_run.state.get(PARENT_RUN_KEY), Some(&run_id));
        // A legitimate leaf approval advances its linked parent, while the
        // pre-approval assertions above prohibit fictional parent success.
        resume_run(&child_run_id, "approved-input".into())
            .await
            .expect("approve the retained child gate");
        let completed_child = store::load_run(&child_run_id).unwrap();
        assert_eq!(completed_child.status, RunStatus::Completed);
        let completed_parent = store::load_run(&run_id).unwrap();
        assert_eq!(completed_parent.status, RunStatus::Completed);
        assert_eq!(
            completed_parent
                .state
                .get("after-child")
                .map(String::as_str),
            Some("only-after-approval")
        );
        assert_eq!(
            completed_parent.nodes["nested"].status,
            NodeStatus::Completed
        );
        assert_eq!(
            completed_parent.output.get("result").map(String::as_str),
            Some("approved-input")
        );
        assert!(!completed_parent.state.contains_key(AWAITING_CHILD_KEY));
        assert!(resume_run(&child_run_id, "duplicate-input".into())
            .await
            .unwrap_err()
            .contains("not awaiting input"));
        store::delete_workflow(&parent.id).unwrap();
        store::delete_workflow(&child.id).unwrap();
    }
}

#[test]
fn transforms_apply() {
    assert_eq!(apply_transform("uppercase", None, "hi").unwrap(), "HI");
    assert_eq!(apply_transform("lowercase", None, "HI").unwrap(), "hi");
    assert_eq!(apply_transform("trim", None, "  x ").unwrap(), "x");
    assert_eq!(
        apply_transform("template", Some("<{{input}}>"), "y").unwrap(),
        "<y>"
    );
    assert!(apply_transform("nope", None, "x").is_err());
}

// ── Retry / timeout / idempotency / durable timers ───────────────────────
// (best-of Temporal RetryPolicy + StartToClose timeout, Restate idempotency
// keys + durable timers)

use crate::workflow::RetryPolicy;

/// Fast retry policy for tests: tiny intervals so the loop spends its budget
/// in milliseconds.
fn fast_policy(max_attempts: u32) -> RetryPolicy {
    RetryPolicy {
        max_attempts,
        initial_interval_ms: 1,
        backoff_coefficient: 2.0,
        max_interval_ms: 10,
        jitter_fraction: 0.0,
        non_retryable_errors: Vec::new(),
    }
}

fn empty_input() -> HashMap<String, String> {
    HashMap::new()
}

#[test]
fn decide_retry_budget_and_non_retryable() {
    // Budget spent (attempt == max) → Fail; budget left → Retry.
    assert!(matches!(
        decide_retry(&fast_policy(3), 3, 3, "boom"),
        RetryDecision::Fail
    ));
    assert!(matches!(
        decide_retry(&fast_policy(3), 1, 3, "boom"),
        RetryDecision::Retry(_)
    ));
    // Non-retryable substring (case-insensitive) fails fast regardless of budget.
    let mut p = fast_policy(5);
    p.non_retryable_errors = vec!["FORBIDDEN".into()];
    assert!(matches!(
        decide_retry(&p, 1, 5, "HTTP 403 Forbidden"),
        RetryDecision::Fail
    ));
    assert!(matches!(
        decide_retry(&p, 1, 5, "connection reset"),
        RetryDecision::Retry(_)
    ));
}

#[test]
fn backoff_is_exponential_and_capped() {
    let p = RetryPolicy {
        max_attempts: 10,
        initial_interval_ms: 100,
        backoff_coefficient: 2.0,
        max_interval_ms: 500,
        jitter_fraction: 0.0,
        non_retryable_errors: Vec::new(),
    };
    assert_eq!(next_backoff_ms(&p, 1), 100); // 100 * 2^0
    assert_eq!(next_backoff_ms(&p, 2), 200); // 100 * 2^1
    assert_eq!(next_backoff_ms(&p, 3), 400); // 100 * 2^2
    assert_eq!(next_backoff_ms(&p, 4), 500); // 800 capped to 500
}

#[test]
fn jitter_noop_when_off_or_out_of_range_else_in_band() {
    let mut p = fast_policy(3);
    p.jitter_fraction = 0.0;
    assert_eq!(apply_jitter(100, &p), 100);
    p.jitter_fraction = 1.5; // out of [0,1]
    assert_eq!(apply_jitter(100, &p), 100);
    p.jitter_fraction = 0.5; // ±50% band
    let j = apply_jitter(100, &p);
    assert!((50..=150).contains(&j), "jitter {j} out of ±50% band");
}

#[test]
fn idempotency_key_is_stable_and_unique() {
    assert_eq!(idempotency_key("r1", "n1"), "r1:n1");
    assert_ne!(idempotency_key("r1", "n1"), idempotency_key("r2", "n1"));
    assert_ne!(idempotency_key("r1", "n1"), idempotency_key("r1", "n2"));
}

#[test]
fn tool_args_inject_key_and_input_without_clobber() {
    use serde_json::json;
    let a = build_tool_args(&json!({"x": 1}), "hi", "r:n");
    assert_eq!(a["x"], json!(1));
    assert_eq!(a["input"], json!("hi"));
    assert_eq!(a["__ryu_idempotency_key"], json!("r:n"));
    // A pre-existing key is preserved (cooperating author may set one).
    let b = build_tool_args(&json!({"__ryu_idempotency_key": "keep"}), "hi", "r:n");
    assert_eq!(b["__ryu_idempotency_key"], json!("keep"));
    // Null and scalar args are wrapped into an object.
    let c = build_tool_args(&json!(null), "x", "k");
    assert_eq!(c["input"], json!("x"));
    let d = build_tool_args(&json!("scalar"), "x", "k");
    assert_eq!(d["args"], json!("scalar"));
    assert_eq!(d["__ryu_idempotency_key"], json!("k"));
}

#[test]
fn retry_policy_serde_defaults_and_partial() {
    // Bare `{}` → defaults (max_attempts 1 = run once, coefficient 2.0).
    let p: RetryPolicy = serde_json::from_str("{}").unwrap();
    assert_eq!(p.max_attempts, 1);
    assert_eq!(p.backoff_coefficient, 2.0);
    // Partial JSON → unspecified fields fall back to defaults.
    let p2: RetryPolicy = serde_json::from_str(r#"{"max_attempts":5}"#).unwrap();
    assert_eq!(p2.max_attempts, 5);
    assert_eq!(p2.initial_interval_ms, 100);
}

#[test]
fn node_and_run_state_back_compat_serde() {
    use crate::workflow::WorkflowNode;
    // Old node JSON (no retry/timeout) still deserializes.
    let n: WorkflowNode = serde_json::from_str(r#"{"id":"a","type":"input"}"#).unwrap();
    assert!(n.retry.is_none());
    assert!(n.timeout_ms.is_none());
    // Old run-state JSON (no attempts/wake_at) → safe defaults.
    let s: store::NodeRunState = serde_json::from_str(r#"{"status":"completed"}"#).unwrap();
    assert_eq!(s.attempts, 0);
    assert!(s.wake_at.is_none());

    let old_run: WorkflowRun = serde_json::from_value(serde_json::json!({
        "run_id": "r1",
        "workflow_id": "w1",
        "status": "completed",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z"
    }))
    .expect("old run JSON remains readable");
    assert!(!old_run.dry_run);

    let mut preview = WorkflowRun::new("preview".into(), "w1".into(), HashMap::new());
    preview.dry_run = true;
    let preview_json = serde_json::to_value(&preview).expect("preview run serializes");
    assert_eq!(preview_json["dryRun"], serde_json::json!(true));
    assert!(preview_json.get("dry_run").is_none());
    assert!(store::save_run(&preview).is_err());
}

#[tokio::test]
async fn direct_resume_cannot_bypass_notify_user_gate() {
    use crate::workflow::{AckMode, NotifyTargetSpec, WorkflowEdge};

    let workflow = ts::workflow(
        format!("notify-resume-{}", uuid::Uuid::new_v4().simple()),
        "notify resume guard",
        vec![ts::node(
            "approval",
            NodeKind::NotifyUser {
                target: NotifyTargetSpec::Members {
                    user_ids: vec!["user-1".into()],
                },
                title: "Review".into(),
                body: "Please approve".into(),
                ack_mode: AckMode::First,
                ack_timeout_ms: None,
            },
        )],
        Vec::<WorkflowEdge>::new(),
    );
    store::save_workflow(&workflow).expect("workflow should persist");

    let run_id = format!("notify-run-{}", uuid::Uuid::new_v4().simple());
    let mut run = WorkflowRun::new(run_id.clone(), workflow.id.clone(), empty_input());
    run.status = RunStatus::AwaitingInput;
    run.awaiting_node = Some("approval".into());
    store::save_run(&run).expect("suspended run should persist");

    let error = resume_run(&run_id, "bypass".into())
        .await
        .expect_err("a notification gate must require a recipient ack");
    assert!(error.contains("member acknowledgements"));
    let persisted = store::load_run(&run_id).expect("run should remain persisted");
    assert_eq!(persisted.status, RunStatus::AwaitingInput);
    assert_eq!(persisted.awaiting_node.as_deref(), Some("approval"));
}

/// A perpetually-failing node with a 3-attempt policy spends its whole
/// budget, records `attempts == 3`, then fails the run.
#[tokio::test]
async fn retry_exhausts_budget_then_fails() {
    use crate::workflow::{NodeKind, WorkflowNode};
    let wf = ts::workflow(
        format!("retry-{}", uuid::Uuid::new_v4().simple()),
        "r",
        vec![
            ts::node("in", NodeKind::Input { key: None }),
            WorkflowNode {
                id: "t".into(),
                retry: Some(fast_policy(3)),
                timeout_ms: None,
                repeat: None,
                // Always errors (no/empty MCP registry, or unknown tool).
                kind: NodeKind::Tool {
                    name: "nope.nope".into(),
                    args: serde_json::json!({}),
                },
            },
            ts::node("out", NodeKind::Output { key: None }),
        ],
        vec![ts::edge("in", "t"), ts::edge("t", "out")],
    );
    let run_id = format!("rr-{}", uuid::Uuid::new_v4().simple());
    let res = run_workflow(&wf, empty_input(), run_id.clone()).await;
    assert!(res.is_err(), "perpetually-failing node must fail the run");
    let run = store::load_run(&run_id).expect("run persisted");
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(
        run.nodes.get("t").map(|s| s.attempts),
        Some(3),
        "should spend the full 3-attempt budget"
    );
}

/// With no policy a failing node runs exactly once (back-compat behaviour).
#[tokio::test]
async fn no_policy_runs_once() {
    use crate::workflow::NodeKind;
    let wf = ts::workflow(
        format!("once-{}", uuid::Uuid::new_v4().simple()),
        "o",
        vec![
            ts::node("in", NodeKind::Input { key: None }),
            ts::node(
                "t",
                NodeKind::Tool {
                    name: "nope.nope".into(),
                    args: serde_json::json!({}),
                },
            ),
        ],
        vec![ts::edge("in", "t")],
    );
    let run_id = format!("or-{}", uuid::Uuid::new_v4().simple());
    let _ = run_workflow(&wf, empty_input(), run_id.clone()).await;
    let run = store::load_run(&run_id).expect("run persisted");
    assert_eq!(run.nodes.get("t").map(|s| s.attempts), Some(1));
}

/// A run whose checkpoint cannot be persisted must fail rather than
/// continue: on a later crash/resume it would reload stale state and re-run
/// already-completed side-effecting nodes. Fault injection: a run id
/// containing `.` is outside `store`'s id charset, so every `save_run`
/// returns `Err` — the very first checkpoint (marking the first node
/// Running) must abort the run.
#[tokio::test]
async fn checkpoint_save_failure_fails_the_run() {
    use crate::workflow::NodeKind;
    let wf = ts::workflow(
        format!("ckpt-{}", uuid::Uuid::new_v4().simple()),
        "c",
        vec![ts::node("in", NodeKind::Input { key: None })],
        Vec::new(),
    );
    let res = run_workflow(&wf, empty_input(), "bad.run.id".into()).await;
    let err = res.expect_err("run must fail when its checkpoint cannot be saved");
    assert!(
        err.contains("failed to persist checkpoint"),
        "unexpected error: {err}"
    );
}

/// A per-node timeout cancels a slow attempt and fails fast (Temporal
/// StartToClose): a 20ms timeout on a 2s delay must not wait the full delay.
#[tokio::test]
async fn per_node_timeout_fails_fast() {
    use crate::workflow::{NodeKind, WorkflowNode};
    let wf = ts::workflow(
        format!("to-{}", uuid::Uuid::new_v4().simple()),
        "t",
        vec![
            ts::node("in", NodeKind::Input { key: None }),
            WorkflowNode {
                timeout_ms: Some(20),
                ..ts::node("d", NodeKind::Delay { ms: 2000 })
            },
        ],
        vec![ts::edge("in", "d")],
    );
    let run_id = format!("tor-{}", uuid::Uuid::new_v4().simple());
    let start = tokio::time::Instant::now();
    let res = run_workflow(&wf, empty_input(), run_id.clone()).await;
    let err = res.expect_err("must fail on timeout");
    assert!(
        err.contains("timed out"),
        "expected a timeout error, got: {err}"
    );
    assert!(
        start.elapsed() < std::time::Duration::from_millis(1500),
        "must fail fast, not wait the full 2s delay"
    );
    let run = store::load_run(&run_id).expect("run persisted");
    assert_eq!(run.status, RunStatus::Failed);
}

/// Durable timer: a run pre-seeded with a `Delay` whose `wake_at` is already
/// in the past resumes and completes immediately — it does NOT re-sleep the
/// full (here 60s) duration. This is the crash-recovery guarantee.
#[tokio::test]
async fn durable_delay_resumes_with_remaining_time() {
    use crate::workflow::NodeKind;
    let wf_id = format!("dd-{}", uuid::Uuid::new_v4().simple());
    let wf = ts::workflow(
        wf_id.clone(),
        "d",
        vec![
            ts::node("in", NodeKind::Input { key: None }),
            ts::node("d", NodeKind::Delay { ms: 60_000 }),
            ts::node("out", NodeKind::Output { key: None }),
        ],
        vec![ts::edge("in", "d"), ts::edge("d", "out")],
    );
    // Pre-seed: the Delay node is Running with a wake_at 5s in the PAST.
    let run_id = format!("ddr-{}", uuid::Uuid::new_v4().simple());
    let mut pre = store::WorkflowRun::new(run_id.clone(), wf_id.clone(), empty_input());
    pre.nodes.insert(
        "d".into(),
        store::NodeRunState {
            status: NodeStatus::Running,
            output: None,
            error: None,
            attempts: 1,
            wake_at: Some((chrono::Utc::now() - chrono::Duration::seconds(5)).to_rfc3339()),
        },
    );
    store::save_run(&pre).expect("pre-seed save ok");

    let start = tokio::time::Instant::now();
    let run = run_workflow(&wf, empty_input(), run_id)
        .await
        .expect("resume ok");
    assert_eq!(run.status, RunStatus::Completed);
    assert!(
        start.elapsed() < std::time::Duration::from_secs(2),
        "wake_at was in the past → must not re-sleep the full delay"
    );
}

/// An `Awakeable` gate carrying a retry policy must still suspend (not be
/// retried as a failure). The gate runs once and the run awaits input.
#[tokio::test]
async fn awakeable_with_retry_policy_suspends_not_retries() {
    use crate::workflow::{NodeKind, WorkflowNode};
    let wf = ts::workflow(
        format!("aw-{}", uuid::Uuid::new_v4().simple()),
        "a",
        vec![
            ts::node("in", NodeKind::Input { key: None }),
            WorkflowNode {
                retry: Some(fast_policy(5)),
                ..ts::node("gate", NodeKind::Awakeable { prompt: None })
            },
            ts::node("out", NodeKind::Output { key: None }),
        ],
        vec![ts::edge("in", "gate"), ts::edge("gate", "out")],
    );
    let run_id = format!("awr-{}", uuid::Uuid::new_v4().simple());
    let run = run_workflow(&wf, empty_input(), run_id)
        .await
        .expect("suspends ok");
    assert_eq!(run.status, RunStatus::AwaitingInput);
    assert_eq!(run.awaiting_node.as_deref(), Some("gate"));
    assert_eq!(
        run.nodes.get("gate").map(|s| s.attempts),
        Some(1),
        "the gate must run once and suspend, never retry"
    );
}

/// A `Delay` stamps and persists its `wake_at` on the FIRST run (not only on
/// resume), and the instant survives into the Completed node state.
#[tokio::test]
async fn durable_delay_stamps_wake_at_on_first_run() {
    use crate::workflow::NodeKind;
    let before = chrono::Utc::now();
    let wf = ts::workflow(
        format!("ws-{}", uuid::Uuid::new_v4().simple()),
        "s",
        vec![
            ts::node("in", NodeKind::Input { key: None }),
            ts::node("d", NodeKind::Delay { ms: 50 }),
        ],
        vec![ts::edge("in", "d")],
    );
    let run_id = format!("wsr-{}", uuid::Uuid::new_v4().simple());
    run_workflow(&wf, empty_input(), run_id.clone())
        .await
        .expect("ok");
    let run = store::load_run(&run_id).expect("run persisted");
    let wake_at = run
        .nodes
        .get("d")
        .and_then(|s| s.wake_at.clone())
        .expect("wake_at must be stamped on first run");
    let parsed = chrono::DateTime::parse_from_rfc3339(&wake_at)
        .expect("wake_at must be RFC3339")
        .with_timezone(&chrono::Utc);
    // ~50ms in the future of `before`, with generous slack for CI.
    assert!(
        parsed >= before && parsed <= before + chrono::Duration::seconds(2),
        "wake_at {parsed} should be ~now+50ms (ms, not seconds)"
    );
}

/// Timeout composes with retry: a per-node timeout produces a *retryable*
/// error, so the retry loop re-runs the node and spends its whole budget. A
/// `Delay{ms:10_000}` with a 30ms timeout can NEVER finish inside an attempt
/// (no delay-vs-timeout race: the timeout always wins), so it deterministically
/// times out every attempt and exhausts a 3-attempt budget.
#[tokio::test]
async fn timeout_is_retryable_and_exhausts_budget() {
    use crate::workflow::{NodeKind, RetryPolicy, WorkflowNode};
    let wf = ts::workflow(
        format!("trx-{}", uuid::Uuid::new_v4().simple()),
        "trx",
        vec![
            ts::node("in", NodeKind::Input { key: None }),
            WorkflowNode {
                retry: Some(RetryPolicy {
                    max_attempts: 3,
                    initial_interval_ms: 1,
                    backoff_coefficient: 1.0,
                    max_interval_ms: 5,
                    jitter_fraction: 0.0,
                    non_retryable_errors: Vec::new(),
                }),
                timeout_ms: Some(30),
                ..ts::node("d", NodeKind::Delay { ms: 10_000 })
            },
        ],
        vec![ts::edge("in", "d")],
    );
    let run_id = format!("trxr-{}", uuid::Uuid::new_v4().simple());
    let res = run_workflow(&wf, empty_input(), run_id.clone()).await;
    let err = res.expect_err("every attempt times out → run fails");
    assert!(
        err.contains("timed out"),
        "expected a timeout error, got: {err}"
    );
    let run = store::load_run(&run_id).expect("run persisted");
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(
        run.nodes.get("d").map(|s| s.attempts),
        Some(3),
        "a timeout must be retried until the budget is spent"
    );
}

/// The success-after-failure arm: a node that already has a prior failed
/// attempt recorded (as after a crash+restart) completes on its next attempt,
/// and the attempt counter accumulates across the resume rather than resetting.
/// Deterministic — a `Transform` always succeeds, so there is no timing race.
#[tokio::test]
async fn node_succeeds_on_retry_accumulating_attempts() {
    use crate::workflow::{NodeKind, RetryPolicy, WorkflowNode};
    let wf_id = format!("sr-{}", uuid::Uuid::new_v4().simple());
    let wf = ts::workflow(
        wf_id.clone(),
        "sr",
        vec![
            ts::node(
                "in",
                NodeKind::Input {
                    key: Some("text".into()),
                },
            ),
            WorkflowNode {
                retry: Some(RetryPolicy {
                    max_attempts: 5,
                    ..Default::default()
                }),
                ..ts::node(
                    "up",
                    NodeKind::Transform {
                        op: "uppercase".into(),
                        template: None,
                    },
                )
            },
            ts::node(
                "out",
                NodeKind::Output {
                    key: Some("result".into()),
                },
            ),
        ],
        vec![ts::edge("in", "up"), ts::edge("up", "out")],
    );
    // Pre-seed: the Transform node has 2 prior (failed) attempts and is not
    // yet Completed — as if two attempts failed before a restart.
    let run_id = format!("srr-{}", uuid::Uuid::new_v4().simple());
    let mut input = HashMap::new();
    input.insert("text".to_string(), "hello".to_string());
    let mut pre = store::WorkflowRun::new(run_id.clone(), wf_id.clone(), input.clone());
    pre.nodes.insert(
        "up".into(),
        store::NodeRunState {
            status: NodeStatus::Running,
            output: None,
            error: Some("prior failure".into()),
            attempts: 2,
            wake_at: None,
        },
    );
    store::save_run(&pre).expect("pre-seed save ok");

    let run = run_workflow(&wf, input, run_id).await.expect("succeeds");
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output.get("result").map(String::as_str), Some("HELLO"));
    // Prior 2 attempts + this successful 3rd = 3 total (budget accumulates).
    assert_eq!(run.nodes.get("up").map(|s| s.attempts), Some(3));
}

/// A non-retryable error matched at run level fails immediately (attempts==1)
/// even with a generous budget — the error string flows to `decide_retry`.
#[tokio::test]
async fn non_retryable_short_circuits_at_run_level() {
    use crate::workflow::{NodeKind, RetryPolicy, WorkflowNode};
    let wf = ts::workflow(
        format!("nr-{}", uuid::Uuid::new_v4().simple()),
        "nr",
        vec![
            ts::node("in", NodeKind::Input { key: None }),
            WorkflowNode {
                retry: Some(RetryPolicy {
                    max_attempts: 5,
                    initial_interval_ms: 1,
                    backoff_coefficient: 2.0,
                    max_interval_ms: 10,
                    jitter_fraction: 0.0,
                    // The Tool node's error always begins with "tool node:".
                    non_retryable_errors: vec!["tool node:".into()],
                }),
                ..ts::node(
                    "t",
                    NodeKind::Tool {
                        name: "nope.nope".into(),
                        args: serde_json::json!({}),
                    },
                )
            },
        ],
        vec![ts::edge("in", "t")],
    );
    let run_id = format!("nrr-{}", uuid::Uuid::new_v4().simple());
    let res = run_workflow(&wf, empty_input(), run_id.clone()).await;
    assert!(res.is_err());
    let run = store::load_run(&run_id).expect("run persisted");
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(
        run.nodes.get("t").map(|s| s.attempts),
        Some(1),
        "non-retryable error must fail on the first attempt"
    );
}

#[test]
fn header_safe_key_keeps_token_chars_and_replaces_others() {
    assert_eq!(header_safe_key("run-1:node_2"), "run-1:node_2");
    assert_eq!(header_safe_key("a b\nc"), "a-b-c");
    assert_eq!(header_safe_key("ok.id-9"), "ok.id-9");
}

#[test]
fn ghost_action_maps_common_steps() {
    use serde_json::json;

    // click → ghost_click with query + app + dom locators.
    let (tool, call) = ghost_action_call(
        "click",
        &json!({ "query": "Compose", "app": "Gmail", "dom_id": "c1" }),
        &json!({}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(tool, "ghost.ghost_click");
    assert_eq!(call["query"], json!("Compose"));
    assert_eq!(call["app"], json!("Gmail"));
    assert_eq!(call["dom_id"], json!("c1"));

    // type → ghost_type with `into` (not `query`) and `text`.
    let (tool, call) = ghost_action_call(
        "type",
        &json!({ "query": "Recipient" }),
        &json!({ "text": "a@b.com" }),
    )
    .unwrap()
    .unwrap();
    assert_eq!(tool, "ghost.ghost_type");
    assert_eq!(call["into"], json!("Recipient"));
    assert_eq!(call["text"], json!("a@b.com"));

    // hotkey → split keys on '+'.
    let (tool, call) = ghost_action_call("hotkey", &json!({}), &json!({ "keys": "ctrl + c" }))
        .unwrap()
        .unwrap();
    assert_eq!(tool, "ghost.ghost_hotkey");
    assert_eq!(call["keys"], json!(["ctrl", "c"]));

    // scroll → direction + numeric amount default.
    let (tool, call) = ghost_action_call("scroll", &json!({}), &json!({ "direction": "up" }))
        .unwrap()
        .unwrap();
    assert_eq!(tool, "ghost.ghost_scroll");
    assert_eq!(call["direction"], json!("up"));
    assert_eq!(call["amount"], json!(3));

    // focus → app from target, no duplicate app injection.
    let (tool, call) = ghost_action_call("focus", &json!({ "app": "Calculator" }), &json!({}))
        .unwrap()
        .unwrap();
    assert_eq!(tool, "ghost.ghost_focus");
    assert_eq!(call["app"], json!("Calculator"));

    // wait → no tool (pure sleep).
    assert!(
        ghost_action_call("wait", &json!({}), &json!({ "seconds": 2 }))
            .unwrap()
            .is_none()
    );

    // unknown → error.
    assert!(ghost_action_call("teleport", &json!({}), &json!({})).is_err());
}

#[test]
fn conditions_evaluate() {
    assert!(eval_condition("input == \"yes\"", "yes"));
    assert!(!eval_condition("input == \"yes\"", "no"));
    assert!(eval_condition("input != \"yes\"", "no"));
    assert!(eval_condition("input contains \"ell\"", "hello"));
    assert!(eval_condition("input starts_with \"he\"", "hello"));
    assert!(!eval_condition("input starts_with \"lo\"", "hello"));
    assert!(eval_condition("input ends_with \"lo\"", "hello"));
    assert!(!eval_condition("input ends_with \"he\"", "hello"));
    assert!(eval_condition("input nonempty", "x"));
    assert!(eval_condition("input empty", ""));
}

/// `in → step → out` where `step` is a `template` transform carrying `repeat`.
fn repeat_workflow(template: &str, repeat: crate::workflow::RepeatPolicy) -> Workflow {
    use crate::workflow::WorkflowNode;

    let node = |id: &str, kind: NodeKind, repeat| WorkflowNode {
        repeat,
        ..ts::node(id, kind)
    };
    ts::workflow(
        format!("test-repeat-{}", uuid::Uuid::new_v4().simple()),
        "repeat",
        vec![
            node(
                "in",
                NodeKind::Input {
                    key: Some("text".into()),
                },
                None,
            ),
            node(
                "step",
                NodeKind::Transform {
                    op: "template".into(),
                    template: Some(template.into()),
                },
                Some(repeat),
            ),
            node(
                "out",
                NodeKind::Output {
                    key: Some("result".into()),
                },
                None,
            ),
        ],
        vec![ts::edge("in", "step"), ts::edge("step", "out")],
    )
}

async fn run_repeat(workflow: &Workflow, text: &str) -> WorkflowRun {
    let input = HashMap::from([("text".to_string(), text.to_string())]);
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    run_workflow(workflow, input, run_id).await.expect("run ok")
}

#[test]
fn repeat_cap_defaults_and_clamps() {
    use crate::workflow::RepeatPolicy;

    // A bare policy is inert: one iteration.
    assert_eq!(RepeatPolicy::default().effective_max_iterations(), 1);
    let until = RepeatPolicy {
        until: Some("input == done".into()),
        ..RepeatPolicy::default()
    };
    // An exit condition without a count gets the engine cap.
    assert_eq!(until.effective_max_iterations(), MAX_REPEAT_ITERATIONS);
    let huge = RepeatPolicy {
        max_iterations: Some(MAX_REPEAT_ITERATIONS + 1),
        ..RepeatPolicy::default()
    };
    assert_eq!(huge.effective_max_iterations(), MAX_REPEAT_ITERATIONS);
    // A blank condition is not an exit condition.
    let blank = RepeatPolicy {
        while_expr: Some("  ".into()),
        ..RepeatPolicy::default()
    };
    assert_eq!(blank.effective_max_iterations(), 1);
}

#[test]
fn repeat_decision_honours_every_exit() {
    use crate::workflow::RepeatPolicy;

    let policy = RepeatPolicy {
        max_iterations: Some(3),
        stop_when_unchanged: true,
        ..RepeatPolicy::default()
    };
    assert!(decide_repeat(&policy, 1, false, true, false));
    assert!(!decide_repeat(&policy, 3, false, true, false), "cap");
    assert!(!decide_repeat(&policy, 1, true, true, false), "until");
    assert!(!decide_repeat(&policy, 1, false, false, false), "while");
    assert!(!decide_repeat(&policy, 1, false, true, true), "unchanged");
}

#[test]
fn repeat_policy_wire_format() {
    use crate::workflow::{RepeatCollect, RepeatPolicy};

    let policy: RepeatPolicy = serde_json::from_value(serde_json::json!({
        "max_iterations": 4,
        "while": "input < 10",
        "collect": "all"
    }))
    .unwrap();
    assert_eq!(policy.max_iterations, Some(4));
    assert_eq!(policy.while_condition(), Some("input < 10"));
    assert_eq!(policy.collect, RepeatCollect::All);
    // Unset fields keep their defaults: output feeds the next iteration.
    assert!(policy.feed_output);
    let wire = serde_json::to_value(&policy).unwrap();
    assert_eq!(wire["while"], "input < 10");
    assert!(wire.get("until").is_none());
}

#[test]
fn repeat_is_rejected_on_gates_and_branchers() {
    use crate::workflow::{RepeatPolicy, WorkflowGraph};

    for kind in [
        NodeKind::Condition {
            expr: "input empty".into(),
        },
        NodeKind::Awakeable { prompt: None },
        NodeKind::While {
            expr: "input empty".into(),
            body_workflow_id: None,
            max_iterations: None,
        },
    ] {
        let mut workflow = repeat_workflow("{{input}}", RepeatPolicy::default());
        workflow.nodes[1].kind = kind;
        let error = WorkflowGraph::build(&workflow).unwrap_err().to_string();
        assert!(error.contains("node 'step' cannot repeat"), "{error}");
    }
}

#[tokio::test]
async fn repeat_feeds_output_back_for_a_fixed_count() {
    use crate::workflow::RepeatPolicy;

    let workflow = repeat_workflow(
        "{{input}}{{loop.iteration}}",
        RepeatPolicy {
            max_iterations: Some(3),
            ..RepeatPolicy::default()
        },
    );
    let run = run_repeat(&workflow, "n").await;
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output.get("result").map(String::as_str), Some("n123"));
    assert_eq!(run.nodes["step"].status, NodeStatus::Completed);
    // Only the iteration count is kept; transient progress and loop tokens go.
    assert_eq!(
        run.state.get("__repeat_count_step").map(String::as_str),
        Some("3")
    );
    assert!(!run.state.contains_key("__repeat_carry_step"));
    assert!(!run.state.keys().any(|k| k.starts_with(LOOP_STATE_PREFIX)));
}

#[tokio::test]
async fn repeat_stops_when_until_holds() {
    use crate::workflow::RepeatPolicy;

    let workflow = repeat_workflow(
        "{{input}}x",
        RepeatPolicy {
            until: Some("input == \"xxxx\"".into()),
            ..RepeatPolicy::default()
        },
    );
    let run = run_repeat(&workflow, "").await;
    assert_eq!(run.output.get("result").map(String::as_str), Some("xxxx"));
    assert_eq!(
        run.state.get("__repeat_count_step").map(String::as_str),
        Some("4")
    );
}

#[tokio::test]
async fn repeat_while_reads_the_latest_output() {
    use crate::workflow::RepeatPolicy;

    // Count up from the input while the output stays below 5.
    let workflow = repeat_workflow(
        "{{loop.iteration}}",
        RepeatPolicy {
            while_expr: Some("input < 5".into()),
            ..RepeatPolicy::default()
        },
    );
    let run = run_repeat(&workflow, "0").await;
    assert_eq!(run.output.get("result").map(String::as_str), Some("5"));
}

#[tokio::test]
async fn repeat_collects_samples_from_the_original_input() {
    use crate::workflow::{RepeatCollect, RepeatPolicy};

    let workflow = repeat_workflow(
        "{{input}}-{{loop.iteration}}-{{loop.previous}}",
        RepeatPolicy {
            max_iterations: Some(3),
            feed_output: false,
            collect: RepeatCollect::All,
            ..RepeatPolicy::default()
        },
    );
    let run = run_repeat(&workflow, "a").await;
    let samples: Vec<String> =
        serde_json::from_str(run.output.get("result").expect("result")).unwrap();
    assert_eq!(samples, ["a-1-", "a-2-a-1-", "a-3-a-2-a-1-"]);
}

#[tokio::test]
async fn repeat_stops_once_output_converges() {
    use crate::workflow::RepeatPolicy;

    let mut workflow = repeat_workflow(
        "",
        RepeatPolicy {
            stop_when_unchanged: true,
            ..RepeatPolicy::default()
        },
    );
    workflow.nodes[1].kind = NodeKind::Transform {
        op: "trim".into(),
        template: None,
    };
    let run = run_repeat(&workflow, "  padded  ").await;
    assert_eq!(run.output.get("result").map(String::as_str), Some("padded"));
    // Iteration 2 reproduced iteration 1's output, so the loop stopped there.
    assert_eq!(
        run.state.get("__repeat_count_step").map(String::as_str),
        Some("2")
    );
}

#[tokio::test]
async fn repeat_resumes_from_the_checkpointed_iteration() {
    use crate::workflow::RepeatPolicy;

    let workflow = repeat_workflow(
        "{{input}}{{loop.iteration}}",
        RepeatPolicy {
            max_iterations: Some(4),
            ..RepeatPolicy::default()
        },
    );
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let input = HashMap::from([("text".to_string(), "n".to_string())]);
    // Simulate a Core restart after two finished iterations.
    let mut crashed = WorkflowRun::new(run_id.clone(), workflow.id.clone(), input.clone());
    mark(
        &mut crashed,
        "in",
        NodeStatus::Completed,
        Some("n".into()),
        None,
    );
    mark(&mut crashed, "step", NodeStatus::Running, None, None);
    for (field, value) in [("count", "2"), ("carry", "n12"), ("last", "n12")] {
        crashed
            .state
            .insert(repeat_state_key(field, "step"), value.to_string());
    }
    store::save_run(&crashed).unwrap();

    let run = run_workflow(&workflow, input, run_id)
        .await
        .expect("resume");
    assert_eq!(run.output.get("result").map(String::as_str), Some("n1234"));
}

/// The pause between passes is a durable timer: a run resumed during the
/// pause sleeps only until the persisted `wake_at`, not the full interval
/// and not zero.
#[tokio::test]
async fn repeat_resume_honours_the_remaining_interval() {
    use crate::workflow::RepeatPolicy;

    let workflow = repeat_workflow(
        "{{input}}{{loop.iteration}}",
        RepeatPolicy {
            max_iterations: Some(3),
            interval_ms: 10_000,
            ..RepeatPolicy::default()
        },
    );
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let input = HashMap::from([("text".to_string(), "n".to_string())]);
    // Simulate a Core restart 200 ms before the pause after pass 2 ends.
    let mut crashed = WorkflowRun::new(run_id.clone(), workflow.id.clone(), input.clone());
    mark(
        &mut crashed,
        "in",
        NodeStatus::Completed,
        Some("n".into()),
        None,
    );
    mark(&mut crashed, "step", NodeStatus::Running, None, None);
    let wake_at = chrono::Utc::now() + chrono::Duration::milliseconds(200);
    for (field, value) in [
        ("count", "2".to_string()),
        ("carry", "n12".to_string()),
        ("last", "n12".to_string()),
        ("wake_at", wake_at.to_rfc3339()),
    ] {
        crashed.state.insert(repeat_state_key(field, "step"), value);
    }
    store::save_run(&crashed).unwrap();

    let started = std::time::Instant::now();
    let run = run_workflow(&workflow, input, run_id)
        .await
        .expect("resume");
    let elapsed = started.elapsed();
    assert_eq!(run.output.get("result").map(String::as_str), Some("n123"));
    assert!(
        elapsed >= std::time::Duration::from_millis(150),
        "resume skipped the remaining pause: {elapsed:?}"
    );
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "resume restarted the full interval: {elapsed:?}"
    );
    assert!(!run.state.contains_key("__repeat_wake_at_step"));
}

#[test]
fn repeat_interval_above_the_cap_is_rejected() {
    use crate::workflow::{RepeatPolicy, WorkflowGraph};

    let at_cap = repeat_workflow(
        "{{input}}",
        RepeatPolicy {
            interval_ms: MAX_REPEAT_INTERVAL_MS,
            ..RepeatPolicy::default()
        },
    );
    assert!(WorkflowGraph::build(&at_cap).is_ok());
    let over_cap = repeat_workflow(
        "{{input}}",
        RepeatPolicy {
            interval_ms: MAX_REPEAT_INTERVAL_MS + 1,
            ..RepeatPolicy::default()
        },
    );
    let error = WorkflowGraph::build(&over_cap).unwrap_err().to_string();
    assert!(error.contains("interval_ms exceeds"), "{error}");
}

#[test]
fn repeat_iterations_get_distinct_effect_ids() {
    let mut run = WorkflowRun::new("r".into(), "w".into(), HashMap::new());
    assert_eq!(iteration_scoped_id(&run, "call"), "call");
    run.state
        .insert(repeat_state_key("count", "call"), "2".to_string());
    assert_eq!(iteration_scoped_id(&run, "call"), "call__repeat2");
    assert_ne!(
        idempotency_key("r", &iteration_scoped_id(&run, "call")),
        idempotency_key("r", "call")
    );
}

#[test]
fn while_cap_clamps_to_hard_max() {
    // An explicit override below the ceiling is honoured.
    assert_eq!(effective_while_cap(Some(5)), 5);
    // Above the ceiling is clamped down (never raised past the safety cap).
    assert_eq!(
        effective_while_cap(Some(MAX_WHILE_ITERATIONS + 50)),
        MAX_WHILE_ITERATIONS
    );
    // Unset / zero fall back to the engine default.
    assert_eq!(effective_while_cap(None), MAX_WHILE_ITERATIONS);
    assert_eq!(effective_while_cap(Some(0)), MAX_WHILE_ITERATIONS);
    // The capped decision stops at the lowered bound.
    assert_eq!(decide_while_capped(4, true, 5), (true, 5));
    assert_eq!(decide_while_capped(5, true, 5), (false, 5));
}

#[test]
fn conditions_evaluate_numeric() {
    // Strict less-than / greater-than.
    assert!(eval_condition("input < 10", "3"));
    assert!(!eval_condition("input < 10", "10"));
    assert!(eval_condition("input > 5", "6"));
    assert!(!eval_condition("input > 5", "5"));
    // Inclusive variants — must not be mis-parsed as `< =` / `> =`.
    assert!(eval_condition("input <= 10", "10"));
    assert!(!eval_condition("input <= 10", "11"));
    assert!(eval_condition("input >= 5", "5"));
    assert!(!eval_condition("input >= 5", "4"));
    // Floats and whitespace are tolerated.
    assert!(eval_condition("input < 2.5", "2.49"));
    assert!(eval_condition("input <= 3 ", " 3 "));
    // Non-numeric operands are false (never panic / never truthy).
    assert!(!eval_condition("input < 10", "abc"));
    assert!(!eval_condition("input > x", "5"));
}

#[tokio::test]
async fn runs_linear_transform_workflow() {
    let wf = ts::linear_workflow(format!("test-lin-{}", uuid::Uuid::new_v4().simple()));

    let mut input = HashMap::new();
    input.insert("text".to_string(), "hello".to_string());
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let run = run_workflow(&wf, input, run_id).await.expect("run ok");
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output.get("result").map(String::as_str), Some("HELLO"));
}

#[tokio::test]
async fn dry_run_evaluates_pure_nodes_and_never_writes_run_state() {
    use crate::workflow::NodeKind;

    let workflow_id = format!("dry-pure-{}", uuid::Uuid::new_v4().simple());
    let workflow = ts::workflow(
        workflow_id.clone(),
        "dry run pure",
        vec![
            ts::node(
                "in",
                NodeKind::Input {
                    key: Some("text".into()),
                },
            ),
            ts::node(
                "up",
                NodeKind::Transform {
                    op: "uppercase".into(),
                    template: None,
                },
            ),
            ts::node(
                "out",
                NodeKind::Output {
                    key: Some("result".into()),
                },
            ),
        ],
        vec![ts::edge("in", "up"), ts::edge("up", "out")],
    );
    let run_id = format!("dry-run-{}", uuid::Uuid::new_v4().simple());
    let mut input = HashMap::new();
    input.insert("text".into(), "hello".into());

    // A pre-existing durable record must not be resumed or overwritten by
    // the transient dry-run projection.
    let mut persisted = WorkflowRun::new(run_id.clone(), workflow_id, input.clone());
    persisted.output.insert("old".into(), "sentinel".into());
    store::save_run(&persisted).expect("seed durable run");

    let run = dry_run_workflow(&workflow, input, run_id.clone())
        .await
        .expect("dry run succeeds");
    assert!(run.dry_run);
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output.get("result").map(String::as_str), Some("HELLO"));
    assert_eq!(
        run.nodes.get("up").map(|state| state.status),
        Some(NodeStatus::Completed)
    );

    let from_disk = store::load_run(&run_id).expect("seeded run remains on disk");
    assert!(!from_disk.dry_run);
    assert_eq!(
        from_disk.output.get("old").map(String::as_str),
        Some("sentinel")
    );
}

#[tokio::test]
async fn dry_run_skips_effectful_nodes_without_calling_them() {
    use crate::workflow::{NodeKind, WorkflowNode};

    let workflow_id = format!("dry-skip-{}", uuid::Uuid::new_v4().simple());
    let workflow = ts::workflow(
        workflow_id,
        "dry run skip",
        vec![
            ts::node("in", NodeKind::Input { key: None }),
            WorkflowNode {
                id: "send".into(),
                retry: None,
                timeout_ms: None,
                repeat: None,
                // This URL is intentionally invalid. A live run would
                // attempt validation and fail; a dry run must skip it.
                kind: NodeKind::Webhook {
                    url: "not-a-url".into(),
                    method: "POST".into(),
                },
            },
            ts::node("out", NodeKind::Output { key: None }),
        ],
        vec![ts::edge("in", "send"), ts::edge("send", "out")],
    );
    let run_id = format!("dry-skip-run-{}", uuid::Uuid::new_v4().simple());
    let run = dry_run_workflow(&workflow, empty_input(), run_id.clone())
        .await
        .expect("dry run succeeds without calling webhook");

    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(
        run.nodes.get("send").map(|state| state.status),
        Some(NodeStatus::Skipped)
    );
    assert!(run
        .nodes
        .get("send")
        .and_then(|state| state.error.as_deref())
        .is_some_and(|error| error.contains("webhook delivery")));
    assert_eq!(
        run.nodes.get("out").map(|state| state.status),
        Some(NodeStatus::Skipped)
    );
    assert!(
        store::load_run(&run_id).is_err(),
        "dry run must not create history"
    );
}

/// AC1 + AC3 + AC4: Awakeable suspend → disk-persist → resume → completion.
///
/// This test covers the full HITL loop without Restate:
///
/// 1. Run a workflow with an `Awakeable` gate mid-DAG.
/// 2. The run suspends at the gate: status = `AwaitingInput`, `awaiting_node`
///    is set, and the state is persisted to disk.
/// 3. Simulate a Core restart by **only** using `run_id` (no in-memory state
///    carryover). Load the run from disk, flip the gate to Completed with a
///    payload, persist, and call `run_workflow` again.
/// 4. The executor skips the now-Completed gate and upstream nodes; it
///    executes only the downstream Output node, producing the payload.
#[tokio::test]
async fn awakeable_suspend_restart_resume_completes() {
    use crate::workflow::store::{NodeRunState, NodeStatus, RunStatus};
    use crate::workflow::NodeKind;

    // Workflow: Input → Awakeable gate → Output
    let wf_id = format!("awk-wf-{}", uuid::Uuid::new_v4().simple());
    let wf = ts::workflow(
        wf_id.clone(),
        "awk-test",
        vec![
            ts::node(
                "in",
                NodeKind::Input {
                    key: Some("initial".into()),
                },
            ),
            ts::node(
                "gate",
                NodeKind::Awakeable {
                    prompt: Some("Approve?".into()),
                },
            ),
            ts::node(
                "out",
                NodeKind::Output {
                    key: Some("result".into()),
                },
            ),
        ],
        vec![ts::edge("in", "gate"), ts::edge("gate", "out")],
    );

    // Step 1: Initial run — hits the Awakeable gate and suspends.
    let run_id = format!("run-awk-{}", uuid::Uuid::new_v4().simple());
    let mut input = HashMap::new();
    input.insert("initial".to_string(), "hello".to_string());

    let suspended = run_workflow(&wf, input.clone(), run_id.clone())
        .await
        .expect("suspend should return Ok (not Err)");

    // AC1: status must reflect paused/awaiting-input.
    assert_eq!(
        suspended.status,
        RunStatus::AwaitingInput,
        "run must be AwaitingInput after hitting Awakeable gate"
    );
    assert_eq!(
        suspended.awaiting_node.as_deref(),
        Some("gate"),
        "awaiting_node must identify the gate"
    );

    // AC3: verify the run survives a "restart" by reading purely from disk.
    let from_disk = store::load_run(&run_id).expect("run must be persisted to disk");
    assert_eq!(
        from_disk.status,
        RunStatus::AwaitingInput,
        "disk state must be AwaitingInput"
    );
    assert_eq!(from_disk.awaiting_node.as_deref(), Some("gate"));

    // Step 2: Simulate resume (what the resume endpoint does).
    // Flip the gate to Completed with a payload, persist.
    let mut resuming = from_disk.clone();
    resuming.nodes.insert(
        "gate".to_string(),
        NodeRunState {
            status: NodeStatus::Completed,
            output: Some("approved".to_string()),
            error: None,
            attempts: 0,
            wake_at: None,
        },
    );
    resuming.status = RunStatus::Running;
    resuming.awaiting_node = None;
    store::save_run(&resuming).expect("save resumed run ok");

    // AC4: re-invoke with same run_id; executor loads from disk and continues.
    let completed = run_workflow(&wf, input, run_id.clone())
        .await
        .expect("resume run ok");

    assert_eq!(
        completed.status,
        RunStatus::Completed,
        "run must complete after resume"
    );
    // The Output node receives the gate's payload ("approved").
    assert_eq!(
        completed.output.get("result").map(String::as_str),
        Some("approved"),
        "output must be the resume payload"
    );
    // The gate node must still be Completed (not re-executed).
    assert_eq!(
        completed.nodes.get("gate").map(|s| s.status),
        Some(NodeStatus::Completed),
        "gate node must be Completed after resume"
    );
}

#[test]
fn while_decides_continue_until_cap() {
    // A holding condition continues and increments the counter...
    assert_eq!(decide_while(0, true), (true, 1));
    assert_eq!(decide_while(5, true), (true, 6));
    // ...right up to the iteration just below the cap.
    assert_eq!(
        decide_while(MAX_WHILE_ITERATIONS - 1, true),
        (true, MAX_WHILE_ITERATIONS)
    );
    // At the cap the gate is forced to exit even though the condition holds.
    assert_eq!(
        decide_while(MAX_WHILE_ITERATIONS, true),
        (false, MAX_WHILE_ITERATIONS)
    );
}

#[test]
fn while_exits_and_resets_when_condition_fails() {
    // A failing condition exits and resets the counter so a later re-entry
    // starts fresh.
    assert_eq!(decide_while(0, false), (false, 0));
    assert_eq!(decide_while(42, false), (false, 0));
}

/// A `While` gate whose condition is already false takes the exit (`false`)
/// branch immediately, so only the exit subgraph runs to Output.
#[tokio::test]
async fn while_exits_immediately_when_condition_false() {
    use crate::workflow::{NodeKind, WorkflowEdge};

    let wf = ts::workflow(
        format!("test-while-{}", uuid::Uuid::new_v4().simple()),
        "while",
        vec![
            ts::node(
                "in",
                NodeKind::Input {
                    key: Some("v".into()),
                },
            ),
            ts::node(
                "loop",
                NodeKind::While {
                    // Input is "done", so `nonempty`... use an exact-match so the
                    // gate is false: continue only while input == "go".
                    expr: "input == \"go\"".into(),
                    body_workflow_id: None,
                    max_iterations: None,
                },
            ),
            ts::node(
                "body",
                NodeKind::Transform {
                    op: "template".into(),
                    template: Some("BODY".into()),
                },
            ),
            ts::node(
                "after",
                NodeKind::Transform {
                    op: "template".into(),
                    template: Some("AFTER".into()),
                },
            ),
            ts::node(
                "outBody",
                NodeKind::Output {
                    key: Some("b".into()),
                },
            ),
            ts::node(
                "outAfter",
                NodeKind::Output {
                    key: Some("a".into()),
                },
            ),
        ],
        vec![
            ts::edge("in", "loop"),
            WorkflowEdge {
                branch: Some("true".into()),
                ..ts::edge("loop", "body")
            },
            WorkflowEdge {
                branch: Some("false".into()),
                ..ts::edge("loop", "after")
            },
            ts::edge("body", "outBody"),
            ts::edge("after", "outAfter"),
        ],
    );

    let mut input = HashMap::new();
    input.insert("v".to_string(), "done".to_string());
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let run = run_workflow(&wf, input, run_id).await.expect("run ok");
    assert_eq!(run.status, RunStatus::Completed);
    // Exit branch ran...
    assert_eq!(run.output.get("a").map(String::as_str), Some("AFTER"));
    // ...and the continue branch was pruned (skipped, no output).
    assert_eq!(run.output.get("b"), None);
    assert_eq!(
        run.nodes.get("body").map(|s| s.status),
        Some(NodeStatus::Skipped)
    );
}

/// A real bounded `While` loop (`body_workflow_id` set) re-runs its body
/// sub-workflow N>1 times and terminates when the condition flips.
///
/// Body workflow: `input → Transform(template "{{input}}x") → output` — it
/// appends one `x` to the carry per iteration. Parent: `input → While(loop) →
/// output`, continuing while `input != "xxx"`. Seeded with "" the carry grows
/// "" → "x" → "xx" → "xxx" over three iterations, then exits.
#[tokio::test]
async fn while_loop_increments_state_until_exit() {
    use crate::workflow::store;
    use crate::workflow::{NodeKind, WorkflowEdge};

    // Persist the loop body workflow so `run_while_loop` can load it.
    let body_id = format!("whilebody{}", uuid::Uuid::new_v4().simple());
    let body = ts::workflow(
        body_id.clone(),
        "body",
        vec![
            ts::node(
                "bin",
                NodeKind::Input {
                    key: Some("input".into()),
                },
            ),
            ts::node(
                "append",
                NodeKind::Transform {
                    op: "template".into(),
                    template: Some("{{input}}x".into()),
                },
            ),
            ts::node(
                "bout",
                NodeKind::Output {
                    key: Some("r".into()),
                },
            ),
        ],
        vec![ts::edge("bin", "append"), ts::edge("append", "bout")],
    );
    store::save_workflow(&body).expect("save body workflow");

    // Parent: Input → While(loop) → Output.
    let wf = ts::workflow(
        format!("whileparent{}", uuid::Uuid::new_v4().simple()),
        "while-loop",
        vec![
            ts::node(
                "in",
                NodeKind::Input {
                    key: Some("seed".into()),
                },
            ),
            ts::node(
                "loop",
                NodeKind::While {
                    expr: "input != \"xxx\"".into(),
                    body_workflow_id: Some(body_id.clone()),
                    max_iterations: None,
                },
            ),
            ts::node(
                "out",
                NodeKind::Output {
                    key: Some("result".into()),
                },
            ),
        ],
        vec![
            ts::edge("in", "loop"),
            // Unlabelled forward edge: a looped While is a data node, not a
            // brancher, so its output flows straight through.
            WorkflowEdge {
                from: "loop".into(),
                to: "out".into(),
                branch: None,
            },
        ],
    );

    let mut input = HashMap::new();
    input.insert("seed".to_string(), String::new());
    let run_id = format!("run{}", uuid::Uuid::new_v4().simple());
    let run = run_workflow(&wf, input, run_id).await.expect("run ok");

    assert_eq!(run.status, RunStatus::Completed);
    // The loop ran three times (carry "" → "x" → "xx" → "xxx").
    assert_eq!(
        run.state.get("__while_loop").map(String::as_str),
        Some("3"),
        "loop must have iterated three times"
    );
    // The carry / node output is the terminal value.
    assert_eq!(
        run.state.get("__while_carry_loop").map(String::as_str),
        Some("xxx")
    );
    assert_eq!(run.output.get("result").map(String::as_str), Some("xxx"));
}

#[test]
fn nested_node_attempt_future_does_not_embed_large_dispatch_state() {
    let node = ts::node("gate", NodeKind::Awakeable { prompt: None });
    let mut run = WorkflowRun::new("future-size".into(), "workflow".into(), HashMap::new());
    let attempt = run_node_attempt(&node, "", &mut run, 0, ExecutionMode::Live);
    let bytes = std::mem::size_of_val(&attempt);
    assert!(
        bytes < 64 * 1024,
        "nested attempts must not embed large dispatch futures ({bytes} bytes)"
    );
}

#[test]
fn nested_dispatch_futures_do_not_embed_heavy_branches() {
    let node = ts::node("gate", NodeKind::Awakeable { prompt: None });
    let mut run = WorkflowRun::new("future-size".into(), "workflow".into(), HashMap::new());
    let dispatch = execute_node(&node, "", &mut run, 0, ExecutionMode::Live);
    let bytes = std::mem::size_of_val(&dispatch);
    assert!(
        bytes < 64 * 1024,
        "node dispatcher embeds heavyweight work ({bytes} bytes)"
    );
    drop(dispatch);
    let args = serde_json::json!({});
    let plugin = run_plugin(
        "missing",
        "missing",
        &args,
        "",
        "key",
        &mut run,
        "gate",
        "gate",
        0,
        ExecutionMode::Live,
    );
    let bytes = std::mem::size_of_val(&plugin);
    assert!(
        bytes < 64 * 1024,
        "plugin dispatcher embeds heavyweight work ({bytes} bytes)"
    );
}

#[tokio::test]
async fn while_gate_at_maximum_supported_nesting_resumes_on_default_stack() {
    let mut body = linear_gate_workflow(
        format!("depthleaf{}", uuid::Uuid::new_v4().simple()),
        NodeKind::Awakeable { prompt: None },
    );
    store::save_workflow(&body).unwrap();
    for _ in 1..MAX_SUBWORKFLOW_DEPTH {
        body = linear_gate_workflow(
            format!("depthbody{}", uuid::Uuid::new_v4().simple()),
            NodeKind::SubWorkflow {
                workflow_id: body.id,
            },
        );
        store::save_workflow(&body).unwrap();
    }
    let parent = linear_gate_workflow(
        format!("depthparent{}", uuid::Uuid::new_v4().simple()),
        NodeKind::While {
            expr: "input != \"done\"".into(),
            body_workflow_id: Some(body.id),
            max_iterations: Some(1),
        },
    );
    store::save_workflow(&parent).unwrap();
    let run_id = format!("depth-run-{}", uuid::Uuid::new_v4().simple());
    let mut leaf = run_workflow(
        &parent,
        HashMap::from([("input".into(), "seed".into())]),
        run_id.clone(),
    )
    .await
    .unwrap();
    assert_eq!(leaf.status, RunStatus::AwaitingInput);
    let mut depth = 0;
    while let Some(child) = leaf.state.get(AWAITING_CHILD_KEY) {
        leaf = store::load_run(child).unwrap();
        depth += 1;
    }
    assert_eq!(depth, MAX_SUBWORKFLOW_DEPTH);
    let resumed = resume_run(&leaf.run_id, "done".into()).await.unwrap();
    assert_eq!(resumed.run_id, leaf.run_id);
    let parent = store::load_run(&run_id).unwrap();
    assert_eq!(parent.status, RunStatus::Completed);
    assert_eq!(
        parent.state.get("__while_step").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        parent.output.get("result").map(String::as_str),
        Some("done")
    );
}

fn linear_gate_workflow(id: String, middle: NodeKind) -> Workflow {
    ts::workflow(
        id,
        "nested-approval-test",
        vec![
            ts::node(
                "in",
                NodeKind::Input {
                    key: Some("input".into()),
                },
            ),
            ts::node("step", middle),
            ts::node(
                "out",
                NodeKind::Output {
                    key: Some("result".into()),
                },
            ),
        ],
        vec![ts::edge("in", "step"), ts::edge("step", "out")],
    )
}

fn saved_gate_loop(nested: bool) -> (Workflow, String) {
    let body_id = format!("gatebody{}", uuid::Uuid::new_v4().simple());
    let leaf = linear_gate_workflow(body_id, NodeKind::Awakeable { prompt: None });
    store::save_workflow(&leaf).expect("save leaf");
    let body = if nested {
        let body = linear_gate_workflow(
            format!("nestedbody{}", uuid::Uuid::new_v4().simple()),
            NodeKind::SubWorkflow {
                workflow_id: leaf.id,
            },
        );
        store::save_workflow(&body).expect("save nested body");
        body
    } else {
        leaf
    };
    let parent = linear_gate_workflow(
        format!("gateparent{}", uuid::Uuid::new_v4().simple()),
        NodeKind::While {
            expr: "input != \"done\"".into(),
            body_workflow_id: Some(body.id),
            max_iterations: Some(3),
        },
    );
    store::save_workflow(&parent).expect("save parent");
    (
        parent,
        format!("gate-run-{}", uuid::Uuid::new_v4().simple()),
    )
}

#[tokio::test]
async fn while_child_gate_restart_resume_preserves_carry_and_completed_nodes() {
    let (workflow, run_id) = saved_gate_loop(false);
    let input = HashMap::from([("input".to_string(), "seed".to_string())]);
    let paused = run_workflow(&workflow, input.clone(), run_id.clone())
        .await
        .expect("pause");
    assert_eq!(paused.status, RunStatus::AwaitingInput);
    assert_eq!(paused.awaiting_node.as_deref(), Some("step"));
    assert_eq!(
        paused.state.get("__while_step").map(String::as_str),
        Some("0")
    );
    assert_eq!(
        paused.state.get("__while_carry_step").map(String::as_str),
        Some("seed")
    );
    let child_id = paused.state[AWAITING_CHILD_KEY].clone();
    // Re-enter from disk with no in-memory execution state: pending gate
    // remains pending, and the same child/upstream nodes are reused.
    let paused = run_workflow(&workflow, input, run_id.clone())
        .await
        .expect("restart");
    assert_eq!(paused.status, RunStatus::AwaitingInput);
    assert_eq!(paused.state[AWAITING_CHILD_KEY], child_id);
    let child = store::load_run(&child_id).expect("load child");
    assert_eq!(child.nodes["in"].attempts, 1);
    assert_eq!(child.nodes["step"].attempts, 1);
    // Resuming the enclosing run forwards to the actual gate, then starts
    // iteration one without falsely completing the While node.
    let paused = resume_run(&run_id, "next".to_string())
        .await
        .expect("approve first iteration");
    assert_eq!(paused.run_id, run_id);
    assert_eq!(paused.status, RunStatus::AwaitingInput);
    assert_eq!(paused.nodes["step"].status, NodeStatus::Running);
    assert_eq!(
        paused.state.get("__while_step").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        paused.state.get("__while_carry_step").map(String::as_str),
        Some("next")
    );
    let next_child = paused.state[AWAITING_CHILD_KEY].clone();
    assert_ne!(next_child, child_id);
    assert_eq!(
        store::load_run(&next_child)
            .expect("second iteration")
            .input["input"],
        "next"
    );
    // Inbox decisions reference the child run; they still complete root.
    let child = resume_run(&next_child, "done".to_string())
        .await
        .expect("approve child");
    assert_eq!(child.run_id, next_child);
    assert_eq!(child.status, RunStatus::Completed);
    let completed = store::load_run(&run_id).expect("completed enclosing run");
    assert_eq!(completed.run_id, run_id);
    assert_eq!(completed.status, RunStatus::Completed);
    assert_eq!(completed.output["result"], "done");
    assert_eq!(completed.state["__while_step"], "2");
    assert!(!completed.state.contains_key(AWAITING_CHILD_KEY));
    assert_eq!(completed.nodes["in"].attempts, 1);
    assert_eq!(
        store::load_run(&child_id).expect("first child").nodes["in"].attempts,
        1
    );
}

#[tokio::test]
async fn while_nested_subworkflow_gate_approval_advances_all_ancestors() {
    let (workflow, run_id) = saved_gate_loop(true);
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause");
    let body = store::load_run(&paused.state[AWAITING_CHILD_KEY]).expect("body");
    assert_eq!(body.status, RunStatus::AwaitingInput);
    let leaf_id = body.state[AWAITING_CHILD_KEY].clone();
    let leaf = resume_run(&leaf_id, "done".to_string())
        .await
        .expect("leaf approval");
    assert_eq!(leaf.run_id, leaf_id);
    let completed = store::load_run(&run_id).expect("completed root");
    assert_eq!(completed.run_id, run_id);
    assert_eq!(completed.output["result"], "done");
    assert_eq!(
        store::load_run(&body.run_id)
            .expect("completed body")
            .status,
        RunStatus::Completed
    );
}

#[tokio::test]
async fn while_plugin_workflow_gate_suspends_and_resumes_ancestors() {
    use crate::plugin_manifest::PluginManifestLoader;
    let (mut workflow, run_id) = saved_gate_loop(false);
    let leaf_id = match &workflow.nodes[1].kind {
        NodeKind::While {
            body_workflow_id: Some(id),
            ..
        } => id.clone(),
        _ => panic!("expected loop"),
    };
    let plugin_id = format!("com.test.workflow-gate-{}", uuid::Uuid::new_v4().simple());
    let plugin_dir = PluginManifestLoader::plugins_dir().join(&plugin_id);
    assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
    assert!(plugin_dir.starts_with(std::env::temp_dir()) || plugin_dir.starts_with("/private/tmp"));
    std::fs::create_dir_all(&plugin_dir).expect("temporary installed plugin");
    let manifest = serde_json::json!({
        "id": plugin_id, "name": "Workflow approval test", "version": "0.1.0",
        "runnables": [{ "id": "review", "kind": "workflow", "name": "Review", "config": { "entry": leaf_id } }],
    });
    std::fs::write(
        plugin_dir.join("manifest.json"),
        serde_json::to_vec(&manifest).expect("serialize plugin"),
    )
    .expect("install temporary manifest");
    let body = linear_gate_workflow(
        format!("pluginbody{}", uuid::Uuid::new_v4().simple()),
        NodeKind::Plugin {
            plugin_id,
            runnable_id: "review".into(),
            args: serde_json::json!({}),
        },
    );
    store::save_workflow(&body).expect("save plugin body");
    if let NodeKind::While {
        body_workflow_id, ..
    } = &mut workflow.nodes[1].kind
    {
        *body_workflow_id = Some(body.id);
    }
    store::save_workflow(&workflow).expect("save parent");
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause at plugin's child gate");
    assert_eq!(paused.status, RunStatus::AwaitingInput);
    let body_run = store::load_run(&paused.state[AWAITING_CHILD_KEY]).expect("plugin body run");
    assert_eq!(body_run.status, RunStatus::AwaitingInput);
    let leaf_run = body_run.state[AWAITING_CHILD_KEY].clone();
    let leaf = resume_run(&leaf_run, "done".into())
        .await
        .expect("approve plugin's child");
    assert_eq!(leaf.run_id, leaf_run);
    let completed = store::load_run(&run_id).expect("completed plugin root");
    assert_eq!(completed.run_id, run_id);
    assert_eq!(completed.output["result"], "done");
    assert_eq!(completed.state["__while_step"], "1");
    std::fs::remove_dir_all(plugin_dir).expect("remove temporary plugin");
}

#[tokio::test]
async fn while_child_rejection_fails_parent_and_is_idempotent() {
    let (workflow, run_id) = saved_gate_loop(true);
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause");
    let body = store::load_run(&paused.state[AWAITING_CHILD_KEY]).expect("body");
    let leaf_id = body.state[AWAITING_CHILD_KEY].clone();
    fail_run(&leaf_id, "approval rejected")
        .await
        .expect("reject leaf");
    let failed = store::load_run(&run_id).expect("failed root");
    assert_eq!(failed.status, RunStatus::Failed);
    assert!(failed
        .error
        .as_deref()
        .is_some_and(|error| error.contains("approval rejected")));
    assert_eq!(failed.state["__while_step"], "0");
    assert!(!failed.is_completed("out"));
    fail_run(&leaf_id, "duplicate rejection")
        .await
        .expect("duplicate safe");
    assert!(resume_run(&run_id, "done".into()).await.is_err());
}

/// `fail_run` raises `core#run.failed` for the run it failed, and the failure
/// write is unaffected by reporting (no fan-out installed, no subscriber).
#[tokio::test]
async fn fail_run_raises_run_failed_without_affecting_the_failure() {
    let (workflow, run_id) = saved_gate_loop(true);
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause");
    let body = store::load_run(&paused.state[AWAITING_CHILD_KEY]).expect("body");
    let leaf_id = body.state[AWAITING_CHILD_KEY].clone();
    fail_run(&leaf_id, "approval rejected")
        .await
        .expect("a failed run is never failed further by reporting");
    assert_eq!(
        store::load_run(&leaf_id).expect("leaf").status,
        RunStatus::Failed
    );
    let emitted = crate::sidecar::event_subscribers::test_capture::emitted_for(&leaf_id);
    assert_eq!(emitted.len(), 1, "{emitted:?}");
    assert_eq!(
        emitted[0]["kind"],
        ryu_healing_contracts::SOURCE_KIND_WORKFLOW
    );
    assert_eq!(emitted[0]["failure"], "approval rejected");
}

#[tokio::test]
async fn while_child_rejection_does_not_need_executable_parent_definition() {
    let (workflow, run_id) = saved_gate_loop(false);
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause");
    let child_id = paused.state[AWAITING_CHILD_KEY].clone();
    let definition = crate::paths::state_path("workflows").join(format!("{}.json", workflow.id));
    std::fs::remove_file(definition).expect("remove parent definition while awaiting approval");
    fail_run(&child_id, "rejected")
        .await
        .expect("denial still propagates");
    let failed = store::load_run(&run_id).expect("failed parent");
    assert_eq!(failed.status, RunStatus::Failed);
    assert_eq!(failed.nodes["step"].status, NodeStatus::Failed);
    assert_eq!(failed.state["__while_step"], "0");
}

/// An approval can arrive while the parent is still executing, before its
/// settle checkpoint writes the link to the gated child. Propagation must wait
/// for that checkpoint rather than read a link-less parent and give up.
#[tokio::test]
async fn an_approval_during_parent_execution_waits_for_the_settle_checkpoint() {
    let parent_id = format!("parent{}", uuid::Uuid::new_v4().simple());
    let child_id = format!("child{}", uuid::Uuid::new_v4().simple());
    let mut parent = WorkflowRun::new(parent_id.clone(), "wf_parent".into(), HashMap::new());
    parent.status = RunStatus::Running;
    store::save_run(&parent).expect("parent mid-execution");
    let mut child = WorkflowRun::new(child_id.clone(), "wf_child".into(), HashMap::new());
    child.status = RunStatus::Completed;
    child
        .state
        .insert(PARENT_RUN_KEY.to_owned(), parent_id.clone());
    store::save_run(&child).expect("approved child");

    // The parent is executing: it holds its execution lock.
    let executing = execution_lock(&parent_id).expect("lock").lock_owned().await;
    let propagation = tokio::spawn(continue_parent_runs(child));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        !propagation.is_finished(),
        "propagation must wait for the parent to settle"
    );

    // The settle checkpoint links the child (and, here, ends the parent so no
    // workflow definition is needed to continue it).
    parent.state.insert(AWAITING_CHILD_KEY.to_owned(), child_id);
    parent.status = RunStatus::Completed;
    store::save_run(&parent).expect("settle checkpoint");
    drop(executing);

    let reached = propagation
        .await
        .expect("propagation task")
        .expect("propagates");
    assert_eq!(
        reached.run_id, parent_id,
        "the parent was found linked and handled, not skipped"
    );
}

#[tokio::test]
async fn while_completed_child_checkpoint_is_folded_once_after_restart() {
    let (workflow, run_id) = saved_gate_loop(false);
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause");
    let child_id = paused.state[AWAITING_CHILD_KEY].clone();
    let mut child = store::load_run(&child_id).expect("child checkpoint");
    // Crash after the child's gate/output checkpoint but before the parent
    // has folded that iteration: recovery must not recreate an approval.
    let gate = child.nodes.get_mut("step").expect("gate");
    gate.status = NodeStatus::Completed;
    gate.output = Some("done".into());
    child.status = RunStatus::Running;
    child.awaiting_node = None;
    store::save_run(&child).expect("gate completion checkpoint");
    let child_workflow = store::load_workflow(&child.workflow_id).expect("child definition");
    run_workflow(&child_workflow, child.input, child_id.clone())
        .await
        .expect("complete child only");
    let completed = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("recover parent");
    assert_eq!(completed.status, RunStatus::Completed);
    assert_eq!(completed.state["__while_step"], "1");
    assert_eq!(completed.output["result"], "done");
    let replay = run_workflow(&workflow, HashMap::new(), run_id)
        .await
        .expect("replay checkpoint");
    assert_eq!(replay.state["__while_step"], "1");
    assert_eq!(
        store::load_run(&child_id).expect("child").nodes["step"].attempts,
        1
    );
}

#[tokio::test]
async fn while_nested_child_completed_checkpoint_advances_after_restart() {
    let (workflow, run_id) = saved_gate_loop(true);
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause");
    let body = store::load_run(&paused.state[AWAITING_CHILD_KEY]).expect("body");
    let mut leaf = store::load_run(&body.state[AWAITING_CHILD_KEY]).expect("leaf");
    let gate = leaf.nodes.get_mut("step").expect("gate");
    gate.status = NodeStatus::Completed;
    gate.output = Some("done".into());
    leaf.status = RunStatus::Running;
    leaf.awaiting_node = None;
    store::save_run(&leaf).expect("gate completion");
    let definition = store::load_workflow(&leaf.workflow_id).expect("leaf definition");
    run_workflow(&definition, leaf.input, leaf.run_id)
        .await
        .expect("complete leaf without ancestors");
    let recovered = run_workflow(&workflow, HashMap::new(), run_id)
        .await
        .expect("restart root only");
    assert_eq!(recovered.status, RunStatus::Completed);
    assert_eq!(recovered.state["__while_step"], "1");
    assert_eq!(recovered.output["result"], "done");
    assert_eq!(
        store::load_run(&body.run_id)
            .expect("recovered body")
            .status,
        RunStatus::Completed
    );
}

#[tokio::test]
async fn while_legacy_child_checkpoint_is_adopted_without_replaying_gate() {
    let (workflow, run_id) = saved_gate_loop(false);
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause");
    let child_id = paused.state[AWAITING_CHILD_KEY].clone();
    let mut child = store::load_run(&child_id).expect("child");
    child.state.remove(PARENT_RUN_KEY);
    store::save_run(&child).expect("legacy child without parent metadata");
    let mut parent = store::load_run(&run_id).expect("parent");
    parent.state.remove(AWAITING_CHILD_KEY);
    store::save_run(&parent).expect("legacy parent without child metadata");
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("adopt legacy checkpoint");
    assert_eq!(paused.status, RunStatus::AwaitingInput);
    assert_eq!(paused.state[AWAITING_CHILD_KEY], child_id);
    let child = store::load_run(&child_id).expect("adopted child");
    assert_eq!(child.state[PARENT_RUN_KEY], run_id);
    assert_eq!(child.nodes["step"].attempts, 1);
    let completed = resume_run(&run_id, "done".into())
        .await
        .expect("resume adopted child");
    assert_eq!(completed.status, RunStatus::Completed);
    assert_eq!(completed.output["result"], "done");
}

#[tokio::test]
async fn while_child_duplicate_approvals_do_not_replace_decision() {
    let (workflow, run_id) = saved_gate_loop(false);
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause");
    let child_id = paused.state[AWAITING_CHILD_KEY].clone();
    let (first, second) = tokio::join!(
        resume_run(&child_id, "done".to_string()),
        resume_run(&child_id, "done".to_string()),
    );
    assert_ne!(
        first.is_ok(),
        second.is_ok(),
        "only one decision is accepted"
    );
    let child = store::load_run(&child_id).expect("child");
    assert_eq!(child.nodes["step"].attempts, 1);
    assert_eq!(child.nodes["step"].output.as_deref(), Some("done"));
    assert_eq!(
        store::load_run(&run_id).expect("root").state["__while_step"],
        "1"
    );
}

#[tokio::test]
async fn while_corrupt_child_checkpoint_fails_without_recreating_execution() {
    let (workflow, run_id) = saved_gate_loop(false);
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause");
    let child_id = paused.state[AWAITING_CHILD_KEY].clone();
    let checkpoint = crate::paths::state_path("workflow-runs").join(format!("{child_id}.json"));
    std::fs::write(&checkpoint, "{invalid").expect("simulate damaged child checkpoint");
    let error = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect_err("refuse lost checkpoint");
    assert!(error.contains("failed to load child checkpoint"));
    assert_eq!(
        std::fs::read_to_string(checkpoint).expect("unchanged corrupt checkpoint"),
        "{invalid"
    );
    assert_eq!(
        store::load_run(&run_id).expect("parent").status,
        RunStatus::Failed
    );
}

#[tokio::test]
async fn while_missing_pending_child_checkpoint_is_not_recreated() {
    let (workflow, run_id) = saved_gate_loop(false);
    let paused = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect("pause");
    let child_id = paused.state[AWAITING_CHILD_KEY].clone();
    let checkpoint = crate::paths::state_path("workflow-runs").join(format!("{child_id}.json"));
    std::fs::remove_file(&checkpoint).expect("simulate lost child checkpoint");
    let error = run_workflow(&workflow, HashMap::new(), run_id.clone())
        .await
        .expect_err("refuse to repeat lost child");
    assert!(error.contains("pending child checkpoint is missing"));
    assert!(!checkpoint.exists());
    let failed = store::load_run(&run_id).expect("failed parent");
    assert_eq!(failed.status, RunStatus::Failed);
    assert_eq!(failed.state["__while_step"], "0");
}

#[tokio::test]
async fn while_engine_link_namespace_cannot_be_overwritten_by_set_state() {
    let workflow = linear_gate_workflow(
        format!("reservedstate{}", uuid::Uuid::new_v4().simple()),
        NodeKind::SetState {
            key: PARENT_RUN_KEY.into(),
            value: "another-run".into(),
        },
    );
    let error = run_workflow(
        &workflow,
        HashMap::new(),
        format!("reserved-run-{}", uuid::Uuid::new_v4().simple()),
    )
    .await
    .expect_err("reject reserved state");
    assert!(error.contains("reserved"));
}

#[tokio::test]
async fn while_parent_resume_cannot_bypass_notify_ack_policy() {
    let notify = linear_gate_workflow(
        format!("notifybody{}", uuid::Uuid::new_v4().simple()),
        NodeKind::NotifyUser {
            target: super::super::NotifyTargetSpec::Org,
            title: "Review".into(),
            body: "Approve".into(),
            ack_mode: super::super::AckMode::All,
            ack_timeout_ms: None,
        },
    );
    // Supply a persisted pending child without delivering notifications or
    // requiring live member configuration. The resume authorization guard
    // must inspect this leaf's definition, not its enclosing While node.
    store::save_workflow(&notify).expect("save notify body");
    let parent = linear_gate_workflow(
        format!("notifyparent{}", uuid::Uuid::new_v4().simple()),
        NodeKind::While {
            expr: "input nonempty".into(),
            body_workflow_id: Some(notify.id.clone()),
            max_iterations: Some(1),
        },
    );
    store::save_workflow(&parent).expect("save parent");
    let mut root = WorkflowRun::new(
        format!("notify-run-{}", uuid::Uuid::new_v4().simple()),
        parent.id,
        HashMap::new(),
    );
    let mut child = WorkflowRun::new(
        format!("{}-step-iter-0", root.run_id),
        notify.id,
        HashMap::new(),
    );
    root.status = RunStatus::AwaitingInput;
    root.awaiting_node = Some("step".into());
    root.state
        .insert(AWAITING_CHILD_KEY.into(), child.run_id.clone());
    child.status = RunStatus::AwaitingInput;
    child.awaiting_node = Some("step".into());
    child
        .state
        .insert(PARENT_RUN_KEY.into(), root.run_id.clone());
    store::save_run(&root).expect("save root");
    store::save_run(&child).expect("save child");
    let error = resume_run(&root.run_id, "done".into())
        .await
        .expect_err("cannot bypass ack");
    assert!(error.contains("acknowledge a notification"));
    assert_eq!(
        store::load_run(&child.run_id).expect("still paused").status,
        RunStatus::AwaitingInput
    );
}

/// A looped `While` whose `body_workflow_id` is the parent workflow itself is
/// rejected (would recurse infinitely).
#[tokio::test]
async fn while_loop_rejects_self_reference() {
    use crate::workflow::NodeKind;

    let wf_id = format!("whileself{}", uuid::Uuid::new_v4().simple());
    let wf = ts::workflow(
        wf_id.clone(),
        "self",
        vec![
            ts::node(
                "in",
                NodeKind::Input {
                    key: Some("seed".into()),
                },
            ),
            ts::node(
                "loop",
                NodeKind::While {
                    expr: "input nonempty".into(),
                    body_workflow_id: Some(wf_id.clone()),
                    max_iterations: None,
                },
            ),
            ts::node(
                "out",
                NodeKind::Output {
                    key: Some("result".into()),
                },
            ),
        ],
        vec![ts::edge("in", "loop"), ts::edge("loop", "out")],
    );

    let mut input = HashMap::new();
    input.insert("seed".to_string(), "go".to_string());
    let run_id = format!("run{}", uuid::Uuid::new_v4().simple());
    // A node error propagates as `Err` from `run_workflow` (only the Awakeable
    // suspend sentinel yields `Ok`), so the self-reference guard surfaces here.
    let err = run_workflow(&wf, input, run_id)
        .await
        .expect_err("self-reference must fail the run");
    assert!(
        err.contains("recurse"),
        "expected self-reference error, got: {err}"
    );
}

/// A `Note` node forwards its input untouched and contributes no run output.
#[tokio::test]
async fn note_passes_through_without_output() {
    use crate::workflow::NodeKind;

    let wf = ts::workflow(
        format!("test-note-{}", uuid::Uuid::new_v4().simple()),
        "note",
        vec![
            ts::node(
                "in",
                NodeKind::Input {
                    key: Some("v".into()),
                },
            ),
            ts::node(
                "doc",
                NodeKind::Note {
                    text: "explains the next step".into(),
                },
            ),
            ts::node(
                "out",
                NodeKind::Output {
                    key: Some("r".into()),
                },
            ),
        ],
        vec![ts::edge("in", "doc"), ts::edge("doc", "out")],
    );

    let mut input = HashMap::new();
    input.insert("v".to_string(), "hello".to_string());
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let run = run_workflow(&wf, input, run_id).await.expect("run ok");
    assert_eq!(run.status, RunStatus::Completed);
    // The Note forwarded the input unchanged to Output.
    assert_eq!(run.output.get("r").map(String::as_str), Some("hello"));
}

#[tokio::test]
async fn condition_prunes_branch() {
    use crate::workflow::{NodeKind, WorkflowEdge};

    let wf = ts::workflow(
        format!("test-cond-{}", uuid::Uuid::new_v4().simple()),
        "cond",
        vec![
            ts::node(
                "in",
                NodeKind::Input {
                    key: Some("v".into()),
                },
            ),
            ts::node(
                "c",
                NodeKind::Condition {
                    expr: "input == \"yes\"".into(),
                },
            ),
            ts::node(
                "yes",
                NodeKind::Transform {
                    op: "template".into(),
                    template: Some("YESPATH".into()),
                },
            ),
            ts::node(
                "no",
                NodeKind::Transform {
                    op: "template".into(),
                    template: Some("NOPATH".into()),
                },
            ),
            ts::node(
                "outYes",
                NodeKind::Output {
                    key: Some("y".into()),
                },
            ),
            ts::node(
                "outNo",
                NodeKind::Output {
                    key: Some("n".into()),
                },
            ),
        ],
        vec![
            ts::edge("in", "c"),
            WorkflowEdge {
                branch: Some("true".into()),
                ..ts::edge("c", "yes")
            },
            WorkflowEdge {
                branch: Some("false".into()),
                ..ts::edge("c", "no")
            },
            ts::edge("yes", "outYes"),
            ts::edge("no", "outNo"),
        ],
    );

    let mut input = HashMap::new();
    input.insert("v".to_string(), "yes".to_string());
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let run = run_workflow(&wf, input, run_id).await.expect("run ok");
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output.get("y").map(String::as_str), Some("YESPATH"));
    // The false branch must have been pruned (skipped), not produce output.
    assert_eq!(run.output.get("n"), None);
    assert_eq!(
        run.nodes.get("no").map(|s| s.status),
        Some(NodeStatus::Skipped)
    );
}

#[tokio::test]
async fn condition_branches_reconverge_on_one_output() {
    // A diamond: both Condition branches feed the SAME Output node. The
    // pruned branch must propagate its skip through the join so the Output
    // still fires with the taken branch's value (regression for the join
    // dead-end that stalled routing / classify-and-act / adversarial
    // templates).
    use crate::workflow::{NodeKind, WorkflowEdge};

    let node = |id: &str, kind: NodeKind| ts::node(id, kind);
    let edge = |from: &str, to: &str, branch: Option<&str>| WorkflowEdge {
        branch: branch.map(str::to_string),
        ..ts::edge(from, to)
    };

    let build = || {
        ts::workflow(
            format!("test-diamond-{}", uuid::Uuid::new_v4().simple()),
            "diamond",
            vec![
                node(
                    "in",
                    NodeKind::Input {
                        key: Some("v".into()),
                    },
                ),
                node(
                    "c",
                    NodeKind::Condition {
                        expr: "input == \"yes\"".into(),
                    },
                ),
                node(
                    "yes",
                    NodeKind::Transform {
                        op: "template".into(),
                        template: Some("YESPATH".into()),
                    },
                ),
                node(
                    "no",
                    NodeKind::Transform {
                        op: "template".into(),
                        template: Some("NOPATH".into()),
                    },
                ),
                node(
                    "out",
                    NodeKind::Output {
                        key: Some("r".into()),
                    },
                ),
            ],
            vec![
                edge("in", "c", None),
                edge("c", "yes", Some("true")),
                edge("c", "no", Some("false")),
                edge("yes", "out", None),
                edge("no", "out", None),
            ],
        )
    };

    // Taken branch = true.
    let mut input = HashMap::new();
    input.insert("v".to_string(), "yes".to_string());
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let run = run_workflow(&build(), input, run_id).await.expect("run ok");
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output.get("r").map(String::as_str), Some("YESPATH"));
    assert_eq!(
        run.nodes.get("no").map(|s| s.status),
        Some(NodeStatus::Skipped)
    );

    // Taken branch = false: the join must still fire with the other value.
    let mut input = HashMap::new();
    input.insert("v".to_string(), "no".to_string());
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let run = run_workflow(&build(), input, run_id).await.expect("run ok");
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output.get("r").map(String::as_str), Some("NOPATH"));
    assert_eq!(
        run.nodes.get("yes").map(|s| s.status),
        Some(NodeStatus::Skipped)
    );
}

// ── Agent / Skill / Mcp / Plugin node kinds (Runnable node support) ────────

#[test]
fn new_node_kinds_round_trip_wire_format() {
    use serde_json::json;

    // The desktop canvas flattens `NodeKind` onto `WorkflowNode` via
    // `#[serde(flatten)]` with a snake_case `type` tag — lock that shape so a
    // saved workflow keeps loading and the palette/config stay in sync.
    for (value, expected_type) in [
        (
            json!({ "type": "agent", "agent_id": "researcher", "task": "Summarise {{input}}" }),
            "agent",
        ),
        (
            json!({ "type": "skill", "skill": "pdf", "agent_id": null, "task": "{{input}}" }),
            "skill",
        ),
        (
            json!({ "type": "mcp", "server": "spider", "tool": "crawl", "args": { "url": "x" } }),
            "mcp",
        ),
        (
            json!({ "type": "plugin", "plugin_id": "com.example.app", "runnable_id": "r1", "args": {} }),
            "plugin",
        ),
    ] {
        let kind: NodeKind =
            serde_json::from_value(value.clone()).expect("deserialize new node kind");
        let back = serde_json::to_value(&kind).expect("serialize new node kind");
        assert_eq!(
            back.get("type").and_then(|v| v.as_str()),
            Some(expected_type),
            "type tag must round-trip for {expected_type}"
        );
    }
}

#[test]
fn agent_and_skill_default_task_to_input() {
    use serde_json::json;

    // `task` is optional; when absent the executor falls back to `{{input}}`.
    let agent: NodeKind =
        serde_json::from_value(json!({ "type": "agent", "agent_id": "a" })).unwrap();
    match agent {
        NodeKind::Agent { agent_id, task } => {
            assert_eq!(agent_id, "a");
            assert_eq!(task, None);
        }
        other => panic!("expected Agent, got {other:?}"),
    }

    let skill: NodeKind = serde_json::from_value(json!({ "type": "skill", "skill": "s" })).unwrap();
    match skill {
        NodeKind::Skill {
            skill,
            agent_id,
            task,
        } => {
            assert_eq!(skill, "s");
            assert_eq!(agent_id, None);
            assert_eq!(task, None);
        }
        other => panic!("expected Skill, got {other:?}"),
    }
}

// ── Code node (Lean / Bend / BAML) ──────────────────────────────────────────

#[test]
fn code_node_wire_format_defaults_and_round_trips() {
    use ryu_code_runner::{CodeLanguage, CodeMode};
    use serde_json::json;

    let minimal: NodeKind = serde_json::from_value(
        json!({ "type": "code", "language": "lean", "source": "def main : IO Unit := pure ()" }),
    )
    .unwrap();
    match &minimal {
        NodeKind::Code {
            language,
            mode,
            input,
            function,
            args,
            model,
            ..
        } => {
            assert_eq!(*language, CodeLanguage::Lean);
            assert_eq!(*mode, CodeMode::Run);
            assert_eq!(*input, None);
            assert_eq!(*function, None);
            assert!(args.is_null());
            assert_eq!(*model, None);
        }
        other => panic!("expected Code, got {other:?}"),
    }
    // Absent optional fields stay absent on save.
    assert_eq!(
        serde_json::to_value(&minimal).unwrap(),
        json!({ "type": "code", "language": "lean", "mode": "run", "source": "def main : IO Unit := pure ()" })
    );

    let baml = json!({
        "type": "code", "language": "baml", "mode": "run",
        "source": "function F(text: string) -> string {\n  client Ryu\n  prompt #\"{{ text }}\"#\n}",
        "function": "F", "args": { "text": "{{input}}" }, "model": "gpt-4o-mini"
    });
    let kind: NodeKind = serde_json::from_value(baml.clone()).unwrap();
    assert_eq!(serde_json::to_value(&kind).unwrap(), baml);

    assert!(serde_json::from_value::<NodeKind>(
        json!({ "type": "code", "language": "python", "source": "print(1)" })
    )
    .is_err());
}

#[tokio::test]
async fn dry_run_skips_code_nodes() {
    let node = ts::node(
        "prove",
        NodeKind::Code {
            language: ryu_code_runner::CodeLanguage::Bend,
            mode: ryu_code_runner::CodeMode::Check,
            source: "import Base".into(),
            input: None,
            function: None,
            args: serde_json::Value::Null,
            model: None,
        },
    );
    let reason = dry_run_skip_reason(&node)
        .await
        .expect("code nodes are skipped");
    assert!(reason.contains("code steps"));
}

#[tokio::test]
async fn code_step_errors_name_the_language() {
    let err = run_code_step(
        ryu_code_runner::CodeLanguage::Bend,
        ryu_code_runner::CodeMode::Run,
        "   ",
        "",
        None,
        &serde_json::Value::Null,
        None,
        std::time::Duration::from_secs(5),
    )
    .await
    .unwrap_err();
    assert_eq!(err, "code node (bend): Bend code step has no source");

    let err = run_code_step(
        ryu_code_runner::CodeLanguage::Baml,
        ryu_code_runner::CodeMode::Run,
        "function F() -> string {\n  client \"openai/gpt-4o\"\n  prompt #\"x\"#\n}",
        "",
        Some("F"),
        &serde_json::json!({}),
        None,
        std::time::Duration::from_secs(5),
    )
    .await
    .unwrap_err();
    assert!(err.starts_with("code node (baml): "), "{err}");
    assert!(err.contains("client Ryu"), "{err}");
}

#[test]
fn code_step_route_targets_the_gateway_v1_api() {
    let route = code_step_llm_route(Some("  claude-test  "));
    assert!(route.base_url.ends_with("/v1"), "{}", route.base_url);
    assert!(!route.base_url.ends_with("//v1"));
    assert_eq!(route.model, "claude-test");
    assert_eq!(code_step_llm_route(Some(" ")).model, default_llm_model());
}

/// End to end through the executor with a real Lean toolchain: the `input`
/// template is resolved, the source is passed literally (its `{{input}}` is
/// Lean string text, not a template), and stdout becomes the node output.
#[tokio::test]
async fn code_node_runs_lean_with_the_resolved_input() {
    use crate::workflow::{NodeKind, WorkflowNode};

    let lean_installed = std::env::var_os(ryu_code_runner::ENV_LEAN_BIN).is_some()
        || std::process::Command::new("lean")
            .arg("--version")
            .output()
            .is_ok()
        || std::env::var_os("HOME")
            .is_some_and(|home| std::path::Path::new(&home).join(".elan/bin/lean").is_file());
    if !lean_installed {
        eprintln!("skipping: lean is not installed");
        return;
    }
    let node = |id: &str, kind: NodeKind| WorkflowNode {
        timeout_ms: Some(120_000),
        ..ts::node(id, kind)
    };
    let wf = ts::workflow(
        format!("test-code-{}", uuid::Uuid::new_v4().simple()),
        "code",
        vec![
            node(
                "in",
                NodeKind::Input {
                    key: Some("text".into()),
                },
            ),
            node(
                "lean",
                NodeKind::Code {
                    language: ryu_code_runner::CodeLanguage::Lean,
                    mode: ryu_code_runner::CodeMode::Run,
                    source: "def main (args : List String) : IO Unit :=\n  \
                                 IO.println (\"{{input}} -> \" ++ args.headD \"\")\n"
                        .into(),
                    input: Some("<{{input}}>".into()),
                    function: None,
                    args: serde_json::Value::Null,
                    model: None,
                },
            ),
            node(
                "out",
                NodeKind::Output {
                    key: Some("result".into()),
                },
            ),
        ],
        vec![ts::edge("in", "lean"), ts::edge("lean", "out")],
    );
    let mut input = HashMap::new();
    input.insert("text".to_string(), "hello".to_string());
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let run = run_workflow(&wf, input, run_id).await.expect("run ok");
    assert_eq!(
        run.status,
        RunStatus::Completed,
        "{:?}",
        run.nodes.get("lean")
    );
    assert_eq!(
        run.output.get("result").map(String::as_str),
        Some("{{input}} -> <hello>")
    );
}

#[tokio::test]
async fn run_plugin_reports_missing_plugin() {
    // An id that is neither a built-in fixture nor an installed manifest must
    // fail with a clear "not installed" error rather than panicking.
    let mut run = WorkflowRun::new("run".into(), "workflow".into(), HashMap::new());
    let err = run_plugin(
        "com.ryu.definitely-not-installed",
        "r1",
        &serde_json::json!({}),
        "input",
        "idem",
        &mut run,
        "node",
        "node",
        0,
        ExecutionMode::Live,
    )
    .await
    .expect_err("unknown plugin must error");
    assert!(
        err.contains("not installed"),
        "error should name the missing plugin: {err}"
    );
}

#[tokio::test]
async fn run_skill_reports_missing_skill() {
    // A bogus skill id is never installed regardless of the skills dir, so the
    // node must fail clearly instead of silently producing empty output.
    let err = run_skill(
        "ryu:definitely-not-a-real-skill/v0",
        None,
        "input",
        "run",
        "node",
    )
    .await
    .expect_err("unknown skill must error");
    assert!(
        err.contains("not installed"),
        "error should name the missing skill: {err}"
    );
}

/// A record for [`compose_skill_prompt`]'s three cases, parameterised only on
/// the field the predicate reads.
fn skill_record(id: &str, instructions: &str) -> ryu_skills::SkillRecord {
    ryu_skills::SkillRecord {
        id: id.to_owned(),
        name: "Deploy Helper".to_owned(),
        description: Some("ships things".to_owned()),
        instructions: instructions.to_owned(),
        allowed_tools: Vec::new(),
        enabled: true,
        always_on: false,
    }
}

/// The regression this pins: a registered-but-body-less skill used to compose
/// `"## Skill: Deploy Helper\n\n\n<task>"` and the node reported SUCCESS, so the
/// run continued and downstream nodes consumed output produced without the
/// instructions the author picked the node for.
///
/// Both the plugin-contributed shape (`register_app_skill` writes
/// `instructions: String::new()`) and the disk shape (a front-matter-only
/// `SKILL.md`, whose body `parse_skill_md` leaves empty — whitespace-only after
/// the delimiter) land here, which is why the assertion covers both spellings of
/// "no body" rather than just the empty string.
#[test]
fn a_body_less_skill_fails_the_node_instead_of_running_an_empty_prompt() {
    for empty in ["", "   \n\n\t"] {
        let err = compose_skill_prompt(
            "app__deploy",
            Some(skill_record("app__deploy", empty)),
            "ship it",
        )
        .expect_err("a body-less skill must fail the node");
        assert!(
            err.contains("app__deploy") && err.contains("no instructions installed"),
            "the failure must name the skill and the actual cause: {err}"
        );
        // Distinguishable from the missing-skill arm on purpose: the two need
        // different fixes, and this one is IN the user's library.
        assert!(
            !err.contains("is not installed"),
            "must not be reported as a missing skill: {err}"
        );
    }
}

/// The other two arms, so the guard cannot be "fixed" by failing everything.
#[test]
fn compose_skill_prompt_runs_a_real_body_and_names_a_missing_skill() {
    let composed = compose_skill_prompt(
        "deploy",
        Some(skill_record("deploy", "Step 1. Check CI.")),
        "ship it",
    )
    .expect("a skill with a body must compose");
    // The `## Skill: <name>` framing is shared with the chat/ACP injectors —
    // a skill must read the same whether injected or driven as a node.
    assert_eq!(
        composed,
        "## Skill: Deploy Helper\nStep 1. Check CI.\n\nship it"
    );

    let err = compose_skill_prompt("nope", None, "ship it")
        .expect_err("an absent record must fail the node");
    assert!(err.contains("'nope' is not installed"), "{err}");
}

#[test]
fn branch_merge_applies_only_the_branch_delta() {
    let mut base = WorkflowRun::new("merge".into(), "wf".into(), HashMap::new());
    base.state.insert("shared".into(), "0".into());
    base.state.insert("gone".into(), "x".into());
    // Another branch already merged its own change into the canonical run.
    let mut shared = base.clone();
    shared.state.insert("other".into(), "from-b".into());
    mark(
        &mut shared,
        "b",
        NodeStatus::Completed,
        Some("B".into()),
        None,
    );

    let mut local = base.clone();
    local.state.insert("mine".into(), "from-a".into());
    local.state.remove("gone");
    mark(
        &mut local,
        "a",
        NodeStatus::Completed,
        Some("A".into()),
        None,
    );

    merge_run_delta(&mut shared, &base, &local);
    assert_eq!(shared.state["mine"], "from-a");
    assert_eq!(
        shared.state["other"], "from-b",
        "a concurrent write survives"
    );
    assert_eq!(shared.state["shared"], "0");
    assert!(!shared.state.contains_key("gone"), "removals merge too");
    assert_eq!(shared.nodes["a"].output.as_deref(), Some("A"));
    assert_eq!(shared.nodes["b"].output.as_deref(), Some("B"));

    // Idempotent: merging the same branch copy again changes nothing.
    let before = serde_json::to_value(&shared.state).unwrap();
    merge_run_delta(&mut shared, &base, &local);
    assert_eq!(serde_json::to_value(&shared.state).unwrap(), before);
}

#[test]
fn branch_scope_removes_a_key_written_by_an_earlier_checkpoint() {
    let base = WorkflowRun::new("scope".into(), "wf".into(), HashMap::new());
    let scope = BranchScope {
        run_id: base.run_id.clone(),
        base: Mutex::new(base.clone()),
        shared: Arc::new(Mutex::new(base.clone())),
    };
    let mut local = base;
    // A mid-node checkpoint persists loop progress...
    local.state.insert("__repeat_carry_step".into(), "1".into());
    {
        let mut shared = scope.shared.lock().unwrap();
        scope.merge_into(&mut shared, &local).unwrap();
        assert_eq!(shared.state["__repeat_carry_step"], "1");
    }
    // ...which the node clears before it completes.
    local.state.remove("__repeat_carry_step");
    local.state.insert("done".into(), "yes".into());
    let mut shared = scope.shared.lock().unwrap();
    scope.merge_into(&mut shared, &local).unwrap();
    assert!(!shared.state.contains_key("__repeat_carry_step"));
    assert_eq!(shared.state["done"], "yes");
}

#[test]
fn concurrency_settings_default_and_clamp() {
    assert_eq!(effective_node_concurrency(None), 4);
    assert_eq!(effective_node_concurrency(Some(0)), 1);
    assert_eq!(effective_node_concurrency(Some(1)), 1);
    assert_eq!(effective_node_concurrency(Some(500)), 16);
    assert_eq!(effective_fanout_concurrency(None), 4);
    assert_eq!(effective_fanout_concurrency(Some(0)), 1);
    assert_eq!(effective_fanout_concurrency(Some(64)), 16);
}

#[test]
fn fan_out_values_keep_structure_only_for_objects_and_arrays() {
    assert_eq!(fanout_value("plain"), serde_json::json!("plain"));
    assert_eq!(fanout_value("42"), serde_json::json!("42"));
    assert_eq!(fanout_value("[1]"), serde_json::json!([1]));
    assert_eq!(fanout_value("{\"a\":1}"), serde_json::json!({ "a": 1 }));
    let mut child = WorkflowRun::new("c".into(), "wf".into(), HashMap::new());
    child.output.insert("b".into(), "second".into());
    child.output.insert("a".into(), "first".into());
    assert_eq!(child_primary_output(&child), "first");
}

#[test]
fn set_state_cannot_write_fan_out_progress() {
    let node = ts::node(
        "s",
        NodeKind::SetState {
            key: format!("{FANOUT_STATE_PREFIX}x"),
            value: "v".into(),
        },
    );
    let mut run = WorkflowRun::new("s".into(), "wf".into(), HashMap::new());
    let error = futures_util::FutureExt::now_or_never(execute_node(
        &node,
        "",
        &mut run,
        0,
        ExecutionMode::DryRun,
    ))
    .expect("set_state is synchronous")
    .expect_err("reserved prefix");
    assert!(error.contains("reserved"), "{error}");
}

#[test]
fn fork_seed_keeps_completed_nodes_and_drops_engine_state() {
    let workflow: Workflow = serde_json::from_value(serde_json::json!({
        "id": "wf_seed", "name": "seed",
        "nodes": [
            { "id": "done", "type": "transform", "op": "identity" },
            { "id": "loop", "type": "transform", "op": "identity",
              "repeat": { "max_iterations": 3 } }
        ]
    }))
    .unwrap();
    let mut parent = WorkflowRun::new("parent".into(), "wf_seed".into(), HashMap::new());
    mark(
        &mut parent,
        "done",
        NodeStatus::Completed,
        Some("D".into()),
        None,
    );
    mark(&mut parent, "loop", NodeStatus::Running, None, None);
    parent.state.insert("user".into(), "u".into());
    parent
        .state
        .insert(repeat_state_key("count", "loop"), "2".into());
    parent
        .state
        .insert(format!("{FANOUT_STATE_PREFIX}x"), "{}".into());
    parent
        .state
        .insert(AWAITING_CHILD_KEY.into(), "child".into());
    parent.state.insert(
        super::super::notify_user::ack_state_key("loop"),
        r#"{"mode":"first","threshold":1,"required":["u1"],"acked":["u1"],"notifications":{}}"#
            .into(),
    );
    let checkpoint = super::super::history::RunCheckpoint {
        checkpoint_id: "cp-000003".into(),
        sequence: 3,
        run_id: "parent".into(),
        event: CheckpointEvent::NodeSuspended,
        node_id: Some("loop".into()),
        iteration: 2,
        status: RunStatus::AwaitingInput,
        created_at: String::new(),
        state: parent.state.clone(),
        nodes: parent.nodes.clone(),
        output: HashMap::new(),
    };
    let fork = build_fork(
        &parent,
        &checkpoint,
        &workflow,
        HashMap::from([("user".to_owned(), "patched".to_owned())]),
        "fork_1".into(),
    )
    .unwrap();
    assert_eq!(fork.run_id, "fork_1");
    assert_eq!(fork.status, RunStatus::Running);
    assert!(fork.is_completed("done"));
    assert!(
        !fork.nodes.contains_key("loop"),
        "unfinished nodes run again"
    );
    assert_eq!(fork.state["user"], "patched");
    assert_eq!(fork.state.len(), 1, "engine state is not carried over");
    assert_eq!(
        fork.forked_from.as_ref().map(|l| l.checkpoint_id.as_str()),
        Some("cp-000003")
    );
    for key in [
        "__workflow_parent_run",
        "__repeat_count_x",
        "__loop_iteration",
        "__fanout_x",
        "__while_x",
        "__notify_ack_gate",
    ] {
        assert!(build_fork(
            &parent,
            &checkpoint,
            &workflow,
            HashMap::from([(key.to_owned(), "v".to_owned())]),
            "fork_2".into(),
        )
        .is_err());
    }
}
