//! Per-node policies and fan-out shapes: [`RetryPolicy`], [`RepeatPolicy`],
//! [`ParallelBranch`], the notify/channel enums, and the static validation
//! [`WorkflowGraph::build`] runs for `repeat` and fan-out nodes.

use super::*;

/// One branch of a [`NodeKind::Parallel`] node.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParallelBranch {
    /// Branch id: the key of this branch's result in the node output.
    pub id: String,
    /// The workflow this branch runs.
    pub workflow_id: String,
    /// Optional input template for this branch. Absent = the node input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
}

/// The channel transport a [`NodeKind::ChannelSend`] node delivers through.
/// Slack and Discord both post to their respective incoming-webhook URLs (Core
/// sends a `text`+`content` body that fits either), so they share the webhook
/// path; Telegram is a direct Bot API `sendMessage`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelPlatform {
    Telegram,
    Slack,
    Discord,
    /// Any generic HTTP JSON webhook.
    Webhook,
}

/// Who a [`NodeKind::NotifyUser`] node pings. Resolved to member user ids against
/// the node's bound organization via the control plane.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotifyTargetSpec {
    /// Every member of the node's bound organization.
    Org,
    /// Every member of a specific team within the org.
    Team { team_id: String },
    /// A hand-picked set of member user ids. Managed nodes verify every id against
    /// the bound organization when the workflow reaches the node.
    Members { user_ids: Vec<String> },
}

/// The acknowledgement policy of a [`NodeKind::NotifyUser`] HITL gate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AckMode {
    /// Fire-and-forget: deliver and continue immediately (no gate).
    #[default]
    None,
    /// Resume as soon as any one targeted member acknowledges.
    First,
    /// Resume only once every targeted member acknowledges.
    All,
    /// Resume once at least `n` members acknowledge.
    Quorum { n: u32 },
    /// Resume once at least the configured percentage of members acknowledge.
    /// The effective threshold is rounded up and always requires at least one
    /// acknowledgement.
    Percentage { percent: u32 },
}

/// A Temporal-style retry policy for a single node. Optional and opt-in: a node
/// with no policy runs exactly once (the historical behaviour). When present, a
/// retryable error re-runs the node up to `max_attempts` times with exponential
/// backoff between attempts.
///
/// The attempt counter persists in [`store::NodeRunState::attempts`], so the
/// budget is *total* across a Core restart, not per-process. The budget is **per
/// unique node per run**: a `While` loop body is a separate sub-run each
/// iteration, so each iteration spends its own independent budget. An
/// `Awakeable` suspend is never a retryable error. Per the Core-vs-Gateway rule
/// this is **Core**: it decides *what runs* (whether to re-run a step), not policy.
///
/// Defaults (mirroring Temporal's `RetryPolicy`): `backoff_coefficient = 2.0`,
/// `initial_interval_ms = 100`, `max_interval_ms = 60_000`. `max_attempts`
/// defaults to 1 so a bare `"retry": {}` is inert until a caller raises it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RetryPolicy {
    /// Maximum total execution attempts (retries = `max_attempts - 1`). Clamped
    /// to at least 1 at run time. Default 1 (run once, no retries).
    pub max_attempts: u32,
    /// Backoff before the first retry, in milliseconds. Default 100.
    pub initial_interval_ms: u64,
    /// Multiplicative backoff growth per retry. Default 2.0 (exponential):
    /// `interval(n) = min(initial * coefficient^(n-1), max_interval)`.
    pub backoff_coefficient: f64,
    /// Ceiling on the computed backoff interval, in milliseconds. Default 60_000.
    pub max_interval_ms: u64,
    /// Optional bounded jitter as a fraction of the computed backoff, in
    /// `[0.0, 1.0]`. The actual sleep is scattered by `±(jitter_fraction * r)`
    /// to avoid retry storms. Default 0.0 (no jitter); out-of-range = ignored.
    #[serde(default)]
    pub jitter_fraction: f64,
    /// Error substrings (case-insensitive) that must NOT be retried — a fast
    /// fail for known-unrecoverable errors. Substring match, not regex. Default
    /// empty (every error is retryable until the budget is spent).
    #[serde(default)]
    pub non_retryable_errors: Vec<String>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 1,
            initial_interval_ms: 100,
            backoff_coefficient: 2.0,
            max_interval_ms: 60_000,
            jitter_fraction: 0.0,
            non_retryable_errors: Vec::new(),
        }
    }
}

/// What a repeated step emits once its [`RepeatPolicy`] loop ends.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RepeatCollect {
    /// The final iteration's output (default).
    #[default]
    Last,
    /// A JSON array of every iteration's output, in order.
    All,
}

/// Re-run a single step on its own output: a fixed number of times, while or
/// until a condition holds against the latest output, or until the output stops
/// changing. Optional and opt-in like [`RetryPolicy`]: a node without one runs
/// once, and a bare `"repeat": {}` is inert (one iteration).
///
/// Each iteration is a complete node execution, so `retry` and `timeout_ms`
/// apply per iteration (the retry budget resets when an iteration succeeds). The
/// loop never adds a graph cycle: the outer DAG sees one node that produces one
/// value. Progress (iterations done, the carried value, collected outputs) is
/// checkpointed after every iteration, so a run resumes mid-loop after a Core
/// restart. Side-effecting steps get a distinct idempotency key per iteration.
///
/// Inside the step, `{{loop.iteration}}` (1-based), `{{loop.previous}}` (the
/// prior iteration's output, empty on the first), and `{{loop.original}}` (the
/// value the step first received) are available as template tokens.
///
/// Exit conditions are checked after every iteration, in order: the iteration
/// cap, `until` holding, `while` failing, then `stop_when_unchanged`. Conditions
/// use the same grammar as [`NodeKind::Condition`], where the `input` keyword is
/// the iteration's output (e.g. `input contains "DONE"`, `input >= 10`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RepeatPolicy {
    /// Maximum iterations. Absent = 1 when no exit condition is set, otherwise
    /// the engine cap [`executor::MAX_REPEAT_ITERATIONS`]. Always clamped to that
    /// cap so a step can never loop without bound.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u64>,
    /// Stop as soon as this condition holds against the latest output.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    /// Keep going only while this condition holds against the latest output.
    #[serde(rename = "while", skip_serializing_if = "Option::is_none")]
    pub while_expr: Option<String>,
    /// Feed each iteration's output in as the next iteration's input (default
    /// true). When false every iteration receives the step's original input,
    /// which suits polling (`until`) and sampling (`collect: all`).
    pub feed_output: bool,
    /// Stop once an iteration returns exactly the previous iteration's output.
    pub stop_when_unchanged: bool,
    /// What the step emits when the loop ends: the last output or all of them.
    pub collect: RepeatCollect,
    /// Pause between iterations, in milliseconds (default 0). Useful for polling.
    /// Durable across a Core restart and capped at
    /// [`executor::MAX_REPEAT_INTERVAL_MS`]; a larger value fails validation.
    pub interval_ms: u64,
}

impl Default for RepeatPolicy {
    fn default() -> Self {
        Self {
            max_iterations: None,
            until: None,
            while_expr: None,
            feed_output: true,
            stop_when_unchanged: false,
            collect: RepeatCollect::Last,
            interval_ms: 0,
        }
    }
}

fn non_blank(value: Option<&String>) -> Option<&str> {
    value.map(|v| v.trim()).filter(|v| !v.is_empty())
}

impl RepeatPolicy {
    /// The `until` expression, when one is set.
    pub fn until_expr(&self) -> Option<&str> {
        non_blank(self.until.as_ref())
    }

    /// The `while` expression, when one is set.
    pub fn while_condition(&self) -> Option<&str> {
        non_blank(self.while_expr.as_ref())
    }

    /// Whether anything other than the iteration cap can end the loop.
    pub fn has_exit_condition(&self) -> bool {
        self.until_expr().is_some() || self.while_condition().is_some() || self.stop_when_unchanged
    }

    /// The effective iteration cap: `max_iterations` clamped to
    /// [`executor::MAX_REPEAT_ITERATIONS`]. When unset (or zero) a policy with an
    /// exit condition gets the engine cap and one without runs once.
    pub fn effective_max_iterations(&self) -> u64 {
        match self.max_iterations {
            Some(n) if n > 0 => n.min(executor::MAX_REPEAT_ITERATIONS),
            _ if self.has_exit_condition() => executor::MAX_REPEAT_ITERATIONS,
            _ => 1,
        }
    }
}

/// Reject a `repeat` policy on node kinds where re-running the step cannot work:
/// gates that suspend for a human (their resume completes the node directly),
/// branchers whose output is a `true`/`false` label, and `While`, which is
/// already a loop.
pub(super) fn validate_repeat(node: &WorkflowNode) -> Result<(), GraphError> {
    if node.repeat.is_none() {
        return Ok(());
    }
    let reason = match &node.kind {
        NodeKind::Awakeable { .. } => "awakeable gates suspend for a human",
        NodeKind::NotifyUser { ack_mode, .. } if *ack_mode != AckMode::None => {
            "acknowledgement gates suspend for a human"
        }
        NodeKind::Condition { .. } => "condition nodes branch instead of producing a value",
        NodeKind::While { .. } => "while nodes are already loops",
        _ if node
            .repeat
            .as_ref()
            .is_some_and(|p| p.interval_ms > executor::MAX_REPEAT_INTERVAL_MS) =>
        {
            "interval_ms exceeds the 1 hour (3600000 ms) cap"
        }
        _ => return Ok(()),
    };
    Err(GraphError::InvalidRepeat(node.id.clone(), reason))
}

/// Whether `id` is usable inside a derived child run id (`[A-Za-z0-9_-]+`).
fn is_child_id_segment(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Validate the static shape of a `ForEach` / `Parallel` fan-out node.
pub(super) fn validate_fanout(node: &WorkflowNode, workflow_id: &str) -> Result<(), GraphError> {
    let invalid = |reason: String| Err(GraphError::InvalidNode(node.id.clone(), reason));
    match &node.kind {
        NodeKind::ForEach {
            body_workflow_id, ..
        } => {
            if body_workflow_id.trim().is_empty() {
                return invalid("for_each needs a body_workflow_id".to_owned());
            }
            if !workflow_id.is_empty() && body_workflow_id == workflow_id {
                return invalid("for_each body is the workflow itself".to_owned());
            }
            Ok(())
        }
        NodeKind::Parallel { branches, .. } => {
            if branches.is_empty() {
                return invalid("parallel needs at least one branch".to_owned());
            }
            if branches.len() > executor::MAX_FANOUT_ITEMS {
                return invalid(format!(
                    "parallel has more than {} branches",
                    executor::MAX_FANOUT_ITEMS
                ));
            }
            let mut seen = HashSet::new();
            for branch in branches {
                if !is_child_id_segment(&branch.id) {
                    return invalid(format!(
                        "branch id '{}' must match [A-Za-z0-9_-]+ (1..=64 chars)",
                        branch.id
                    ));
                }
                if !seen.insert(branch.id.as_str()) {
                    return invalid(format!("duplicate branch id '{}'", branch.id));
                }
                if branch.workflow_id.trim().is_empty() {
                    return invalid(format!("branch '{}' needs a workflow_id", branch.id));
                }
                if !workflow_id.is_empty() && branch.workflow_id == workflow_id {
                    return invalid(format!("branch '{}' runs the workflow itself", branch.id));
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::test_support::node;

    #[test]
    fn a_bare_repeat_runs_once_and_an_exit_condition_gets_the_engine_cap() {
        assert_eq!(RepeatPolicy::default().effective_max_iterations(), 1);
        let until = RepeatPolicy {
            until: Some("input contains \"DONE\"".into()),
            ..RepeatPolicy::default()
        };
        assert_eq!(
            until.effective_max_iterations(),
            executor::MAX_REPEAT_ITERATIONS
        );
        let capped = RepeatPolicy {
            max_iterations: Some(u64::MAX),
            ..RepeatPolicy::default()
        };
        assert_eq!(
            capped.effective_max_iterations(),
            executor::MAX_REPEAT_ITERATIONS
        );
    }

    #[test]
    fn repeat_is_refused_on_a_brancher_and_fanout_shapes_are_checked() {
        let mut condition = node(
            "c",
            NodeKind::Condition {
                expr: "input == \"yes\"".into(),
            },
        );
        condition.repeat = Some(RepeatPolicy::default());
        assert!(matches!(
            validate_repeat(&condition),
            Err(GraphError::InvalidRepeat(id, _)) if id == "c"
        ));
        let empty = node(
            "p",
            NodeKind::Parallel {
                branches: Vec::new(),
                max_concurrency: None,
            },
        );
        assert!(matches!(
            validate_fanout(&empty, "wf"),
            Err(GraphError::InvalidNode(id, _)) if id == "p"
        ));
        let self_body = node(
            "f",
            NodeKind::ForEach {
                body_workflow_id: "wf".into(),
                items: None,
                max_concurrency: None,
            },
        );
        assert!(validate_fanout(&self_body, "wf").is_err());
        assert!(validate_fanout(&self_body, "other").is_ok());
    }
}
