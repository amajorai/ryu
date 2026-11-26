// apps/desktop/src/lib/api/workflows.ts
//
// Typed client for Core's DAG workflow engine (`/workflows*`). A workflow is a
// directed acyclic graph of typed nodes plus edges; Core validates the DAG on
// create and rejects cycles / unknown-node edges / duplicate ids with a
// descriptive error. The desktop Workflows view (DA8) drives these endpoints to
// list, create, delete, and run workflows and to read back run status/output.
//
// Note: unlike the agent endpoints these live under `/workflows`, NOT `/api/*`
// (see apps/core/src/server/mod.rs). We also bypass the shared `request` helper
// for create/run because Core returns its validation/run error in the JSON body
// (`{ success: false, error }`), and we want to surface that exact message —
// the generic helper throws only the status code.

//
// Every workflow, run, version and template id goes into its path through
// encodePathId: these are Core's own routes (not a mount), where an encoded
// slash stays inside its segment, and the dot segments are refused. The wire
// model and helpers are in workflows-types.ts; the template catalog, version
// history and run history requests are in their own files and re-exported here.

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";
import { encodePathId } from "./path-id.ts";
import {
	errorFromResponse,
	postJson,
	type RunWorkflowOptions,
	runEnvelope,
	toRun,
	toWorkflow,
	type Workflow,
	type WorkflowNativeJsonInput,
	type WorkflowRun,
	workflowEnvelope,
	workflowsEnvelope,
} from "./workflows-types.ts";

export type {
	ForkRunOptions,
	WorkflowCheckpointEvent,
	WorkflowRunCheckpoint,
} from "./workflows-history.ts";
export { forkRun, listRunHistory } from "./workflows-history.ts";
export type {
	WorkflowTemplateCategory,
	WorkflowTemplateDetail,
	WorkflowTemplateMeta,
} from "./workflows-templates.ts";
export {
	fetchWorkflowTemplate,
	fetchWorkflowTemplates,
	installWorkflowTemplate,
} from "./workflows-templates.ts";
export type {
	NodeRunState,
	NodeStatus,
	RunStatus,
	RunWorkflowOptions,
	Workflow,
	WorkflowEdge,
	WorkflowNode,
	WorkflowRun,
	WorkflowRunLineage,
	WorkflowTrigger,
} from "./workflows-types.ts";
// Shared Core-owned decoding and projection for direct-fetch host adapters.
export {
	errorFromResponse as readWorkflowErrorFromResponse,
	runEnvelope as workflowRunResponseSchema,
	toRun as projectWorkflowRunWire,
	toWorkflow as projectWorkflowWire,
	workflowEnvelope as workflowResponseSchema,
	workflowsEnvelope as workflowsResponseSchema,
} from "./workflows-types.ts";
export type { WorkflowVersionMeta } from "./workflows-versions.ts";
export {
	createWorkflowVersion,
	getWorkflowVersionDefinition,
	listWorkflowVersions,
	restoreWorkflowVersion,
} from "./workflows-versions.ts";

interface WorkflowRunBody {
	dryRun?: RunWorkflowOptions["dryRun"];
	input: Parameters<typeof runWorkflow>[2];
	runId?: RunWorkflowOptions["runId"];
}

export async function fetchWorkflows(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<Workflow[]> {
	const resp = await fetchForTarget(target)(apiUrl(target, "/workflows"), {
		headers: makeHeaders(target.token, target.userJwt),
		signal,
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, "/workflows");
	}
	const json = workflowsEnvelope.parse(await resp.json());
	return (json.workflows ?? []).map(toWorkflow);
}

/** Fetch a single workflow definition by id (e.g. to re-hydrate the canvas after
 * the natural-language builder mutates it). */
export async function fetchWorkflow(
	target: ApiTarget,
	id: string
): Promise<Workflow> {
	const path = `/workflows/${encodePathId(id)}`;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	const json = workflowEnvelope.parse(await resp.json());
	return toWorkflow(json.workflow);
}

/** Create (or overwrite, when `id` is set) a workflow. Core validates the DAG
 * first and returns a 400 with the validation error when it is invalid. */
export async function createWorkflow(
	target: ApiTarget,
	definition: WorkflowNativeJsonInput
): Promise<Workflow> {
	const json = await postJson(
		target,
		"/workflows",
		definition,
		workflowEnvelope
	);
	return toWorkflow(json.workflow);
}

export async function deleteWorkflow(
	target: ApiTarget,
	id: string
): Promise<void> {
	const path = `/workflows/${encodePathId(id)}`;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method: "DELETE",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
}

/** Run a workflow end-to-end with an initial input map and return the run. Set
 * `dryRun` to receive a transient read-only projection instead of creating run
 * history or invoking effectful nodes. */
export async function runWorkflow(
	target: ApiTarget,
	id: string,
	input: Record<string, string>,
	options: RunWorkflowOptions = {}
): Promise<WorkflowRun> {
	const body: WorkflowRunBody = { input };
	if (options.dryRun) {
		body.dryRun = true;
	} else if (options.runId) {
		body.runId = options.runId;
	}
	const json = await postJson(
		target,
		`/workflows/${encodePathId(id)}/run`,
		body,
		runEnvelope
	);
	return toRun(json.run);
}

/** Fetch the current state of a run (e.g. to poll a suspended run). */
export async function getWorkflowRun(
	target: ApiTarget,
	runId: string,
	signal?: AbortSignal
): Promise<WorkflowRun> {
	const path = `/workflows/runs/${encodePathId(runId)}`;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		headers: makeHeaders(target.token, target.userJwt),
		signal,
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	const json = runEnvelope.parse(await resp.json());
	return toRun(json.run);
}

/** Resume a run suspended at an Awakeable (human-in-the-loop) gate. The `payload`
 * becomes the gate's output and flows to downstream nodes. Returns the run's
 * state after re-execution (may itself be `awaiting_input` if it hits another
 * gate). */
export async function resumeWorkflow(
	target: ApiTarget,
	runId: string,
	payload: string
): Promise<WorkflowRun> {
	const json = await postJson(
		target,
		`/workflows/runs/${encodePathId(runId)}/resume`,
		{ payload },
		runEnvelope
	);
	return toRun(json.run);
}
