/**
 * The truth this figure draws: one run of a Ryu workflow in Core's DAG executor.
 *
 * Every name, rule and number the figure shows comes from here, and each one is traced
 * to the source. Re-verified against the working tree on 2026-10-22:
 *
 * - Nodes run one at a time in dependency order; a `Condition` activates only its
 *   matching branch and any node left with no active incoming edge is `Skipped`:
 *   apps/core/src/workflow/executor.rs:1-11, the single-queue loop at :815, the
 *   branch pruning at :1039-1061 and the skip at :1148-1160.
 * - After every node the run state is persisted so the run is resumable
 *   (executor.rs:11; the checkpoint after each node at :1063). The write is
 *   atomic: temp file, fsync, rename (crates/core/durable/src/lib.rs:113-155).
 * - Node and run states: apps/core/src/workflow/store.rs:69-96
 *   (Pending, Running, Completed, Failed, Skipped; Running, Completed, Failed,
 *   AwaitingInput, Waiting).
 * - Node kinds named here (Input, Prompt, Condition, Tool, Webhook, Awakeable, Output):
 *   apps/core/src/workflow/mod.rs:55-115 and :309. An `Awakeable` is the approval gate.
 * - Retry is opt-in per node. Its defaults: 100 ms before the first retry, doubling,
 *   capped at 60 s; `max_attempts` defaults to 1 (no retry): mod.rs:504-555. The
 *   backoff is `min(initial * 2^(attempt-1), cap)`: executor.rs:1406-1418. An attempt
 *   is counted before it runs, so a crash mid-call still spends it: executor.rs:904-918;
 *   the count persists across a restart (mod.rs:509-510).
 * - An approval gate suspends the run as `AwaitingInput` and files an approval request;
 *   approving resumes it downstream: executor.rs:927-951 and :545-553.
 * - After a Core restart every run still `Running` is resumed from its last checkpoint,
 *   skipping completed nodes (executor.rs:850-855), at most twice per run; the third
 *   interruption fails it: apps/core/src/workflow/auto_resume.rs:1-31, :47 and
 *   :141-161. A run that is `AwaitingInput` is left waiting (auto_resume.rs:159).
 *
 * The run itself is a simulation of this mechanism: the graph is an example and the
 * motion is slowed and not to scale. The figure draws only the order of nodes, the
 * skipped branch, the wait at the approval gate and the checkpoint after each node; the
 * retry and restart rules above are the context its hidden description leans on.
 */

export interface WorkflowNode {
	/** One plain sentence, for the figure's spoken value text. */
	does: string;
	id: string;
	/** The node kind as Core names it. */
	kind: string;
	/** The node's short name, spoken with its state. */
	name: string;
}

export const NODES: readonly WorkflowNode[] = [
	{
		id: "input",
		kind: "Input",
		name: "input",
		does: "Reads the run's input.",
	},
	{
		id: "prompt",
		kind: "Prompt",
		name: "prompt",
		does: "Asks a model.",
	},
	{
		id: "condition",
		kind: "Condition",
		name: "condition",
		does: "Picks one branch; the other branch is skipped.",
	},
	{
		id: "tool",
		kind: "Tool",
		name: "tool",
		does: "Calls a tool. It has a retry policy, so a failed attempt is retried after a backoff.",
	},
	{
		id: "webhook",
		kind: "Webhook",
		name: "webhook",
		does: "On the branch the condition did not take, so it is skipped.",
	},
	{
		id: "approval",
		kind: "Awakeable",
		name: "approval",
		does: "An approval gate: the run waits here, awaiting input, until someone approves.",
	},
	{
		id: "output",
		kind: "Output",
		name: "output",
		does: "Returns the run's result.",
	},
];

export const NODE_COUNT = NODES.length;

export const INPUT = 0;
export const PROMPT = 1;
export const CONDITION = 2;
export const TOOL = 3;
export const WEBHOOK = 4;
export const APPROVAL = 5;
export const OUTPUT = 6;

/** The nodes the run executes, in order; the condition takes the tool branch. */
export const PATH: readonly number[] = [
	INPUT,
	PROMPT,
	CONDITION,
	TOOL,
	APPROVAL,
	OUTPUT,
];

export const nodeAt = (index: number): WorkflowNode =>
	NODES[Math.min(NODE_COUNT - 1, Math.max(0, index))] ?? {
		id: "",
		kind: "",
		name: "",
		does: "",
	};
