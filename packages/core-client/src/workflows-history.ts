// packages/core-client/src/workflows-history.ts
//
// Run history and fork (time travel), split out of workflows.ts, which
// re-exports it. The run id was already encoded here before the split.

import { z } from "zod";
import type { AppResponseValue } from "./app-request-json.ts";
import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";
import {
	errorFromResponse,
	type NodeRunState,
	nativeWorkflowArray,
	nativeWorkflowJson,
	nodeState,
	postJson,
	type RunStatus,
	runEnvelope,
	runStatusSchema,
	stringMap,
	toRun,
	type WorkflowRun,
} from "./workflows-types.ts";

// ── Run history and fork (time travel) ─────────────────────────────────────

const checkpointEventSchema = z.enum([
	"run_started",
	"forked",
	"node_completed",
	"node_failed",
	"node_suspended",
	"node_parked",
	"run_completed",
	"run_failed",
]);

/** Why Core recorded a run checkpoint. */
export type WorkflowCheckpointEvent = z.output<typeof checkpointEventSchema>;

/** One recorded checkpoint of a run: what happened, plus a full snapshot of the
 * run's state, node statuses, and outputs at that moment. */
export interface WorkflowRunCheckpoint {
	/** Pass to {@link forkRun} to replay the run from this point. */
	checkpointId: string;
	createdAt: string;
	event: WorkflowCheckpointEvent;
	/** How many times the node had run (repeat/while iterations); 0 for a
	 * run-level event. */
	iteration: number;
	nodeId: string | null;
	nodes: Record<string, NodeRunState>;
	output: Record<string, string>;
	runId: string;
	/** 0-based position in the run's history. */
	sequence: number;
	state: Record<string, string>;
	status: RunStatus;
}

const wireCheckpoint = nativeWorkflowJson(
	z.object({
		checkpoint_id: z.string(),
		sequence: z.number(),
		run_id: z.string(),
		event: checkpointEventSchema,
		node_id: z.string().nullish(),
		iteration: z.number(),
		status: runStatusSchema,
		created_at: z.string(),
		state: stringMap.optional(),
		nodes: nativeWorkflowJson(z.record(z.string(), nodeState)).optional(),
		output: stringMap.optional(),
	})
);
const historyEnvelope = nativeWorkflowJson(
	z.object({
		checkpoints: nativeWorkflowArray(wireCheckpoint).optional(),
	})
);

function toCheckpoint(
	c: z.output<typeof wireCheckpoint>
): WorkflowRunCheckpoint {
	return {
		checkpointId: c.checkpoint_id,
		sequence: c.sequence,
		runId: c.run_id,
		event: c.event,
		nodeId: c.node_id ?? null,
		iteration: c.iteration,
		status: c.status,
		createdAt: c.created_at,
		state: c.state ?? {},
		nodes: c.nodes ?? {},
		output: c.output ?? {},
	};
}

/** List every recorded checkpoint of a run, oldest first
 * (`GET /workflows/runs/:runId/history`). A run that predates run history
 * returns an empty list. */
export async function listRunHistory(
	target: ApiTarget,
	runId: string,
	signal?: AbortSignal
): Promise<WorkflowRunCheckpoint[]> {
	const path = `/workflows/runs/${encodeURIComponent(runId)}/history`;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		headers: makeHeaders(target.token, target.userJwt),
		signal,
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	const json = historyEnvelope.parse(await resp.json());
	return (json.checkpoints ?? []).map(toCheckpoint);
}

export interface ForkRunOptions {
	/** Values merged into the checkpoint's state map before the fork resumes.
	 * Strings are stored verbatim; other JSON values as JSON text. Core rejects
	 * engine-owned keys (`__workflow_*`, `__repeat_*`, ...). */
	statePatch?: Record<string, AppResponseValue>;
}

interface ForkRunBody {
	checkpoint_id: string;
	state_patch?: ForkRunOptions["statePatch"];
}

/** Fork a run from one of its checkpoints into a new run that resumes from that
 * point (`POST /workflows/runs/:runId/fork`). Nodes completed at the checkpoint
 * are reused; the rest run again under the fork's own run id. Resolves with the
 * fork once it settles; its `forkedFrom` names the parent and checkpoint. */
export async function forkRun(
	target: ApiTarget,
	runId: string,
	checkpointId: string,
	options: ForkRunOptions = {}
): Promise<WorkflowRun> {
	const body: ForkRunBody = { checkpoint_id: checkpointId };
	if (options.statePatch) {
		body.state_patch = options.statePatch;
	}
	const json = await postJson(
		target,
		`/workflows/runs/${encodeURIComponent(runId)}/fork`,
		body,
		runEnvelope
	);
	return toRun(json.run);
}
