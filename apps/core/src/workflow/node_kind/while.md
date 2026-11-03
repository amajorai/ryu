A guarded loop / branch gate. Evaluates `expr` (the same tiny grammar as
[`NodeKind::Condition`], with `{{...}}` tokens resolved first).

# Two forms

**1. Real bounded loop (`body_workflow_id` set).** The node re-executes the
named body workflow as long as `expr` holds, up to
[`executor::MAX_WHILE_ITERATIONS`]. Iteration is implemented as recursion
(each iteration runs as its own [`store::WorkflowRun`] via the same path as
[`NodeKind::SubWorkflow`]), so the outer DAG never gains a cycle and DAG
validation is untouched. The **carry** is the loop variable: it is seeded
with the node's incoming value, the condition is evaluated against the carry
(use the `input` keyword, e.g. `input < 10`), and each iteration's body
output replaces the carry. On exit the node produces the final carry as a
plain data value (a looped `While` is a data node, not a brancher — its
single forward edge should be unlabelled). The iteration counter persists to
the run `state` (keyed `state["__while_<id>"]`) and is checkpointed to disk
after every iteration, so a loop survives a Core restart and resumes from
the persisted iteration.

**At-least-once, not exactly-once:** a side-effecting body node
(Tool/Webhook/GhostAction/Prompt) interrupted mid-call re-runs on resume.
An `Awakeable` or acknowledgement gate inside a body suspends the enclosing
run. A decision resumes the same iteration without advancing its carry
prematurely, and then continues enclosing workflows from their checkpoints.

**2. One-shot branch gate (`body_workflow_id` absent — back-compat).** With
no body the node behaves as a `Condition`-style gate: it evaluates `expr`
once and activates only the matching `true`/`false` outgoing edges. The
per-node counter + [`executor::MAX_WHILE_ITERATIONS`] cap still apply but,
under the single-visit traversal, the gate is reached at most once.

The on-canvas back-edge loop (author draws body→`While` directly on the
graph) is deferred — v1 ships the explicit `body_workflow_id` form where the
loop body is authored as a separate sub-workflow.
