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

import {
	type RpcJsonResponse,
	rpcJsonResponseSchema,
	type WorkflowNodeRecord,
	workflowDefinitionInputSchema,
} from "@ryu/app-host/rpc";
import type {
	NodeRunState,
	WorkflowEdge,
	WorkflowTemplateMeta,
	WorkflowTrigger,
	WorkflowVersionMeta,
} from "@ryuhq/core-client/workflows.ts";
import type { z } from "zod";
import { type ApiTarget, authenticatedFetch } from "./client.ts";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";
import { encodePathId } from "./path-id.ts";
import {
	workflowEnvelopeSchema,
	workflowErrorSchema,
	workflowInstallPreviewSchema,
	workflowInstallResultSchema,
	workflowListEnvelopeSchema,
	workflowRunEnvelopeSchema,
	workflowTemplateEnvelopeSchema,
	workflowTemplateListEnvelopeSchema,
	workflowVersionDefinitionEnvelopeSchema,
	workflowVersionListEnvelopeSchema,
} from "./workflow-wire-contracts.ts";

export type {
	NodeRunState,
	NodeStatus,
	WorkflowEdge,
	WorkflowTemplateCategory,
	WorkflowTemplateMeta,
	WorkflowTrigger,
	WorkflowVersionMeta,
} from "@ryuhq/core-client/workflows.ts";

/** A single node in a workflow definition. `type` selects the node kind and
 * carries its config (Core flattens the kind onto the node). We keep the config
 * open since the JSON editor is the create surface for DA8. */
export type WorkflowNode = WorkflowNodeRecord;

/** A persisted workflow definition as returned by Core. */
export interface Workflow {
	/** Whether this workflow can be driven from a chat composer — it has a root
	 *  `Input` node, so a typed message is consumed as the run's initial input.
	 *  Server-computed (`GET /workflows` stamps it); `false` for definitions
	 *  that were never fetched from the list (e.g. freshly created). */
	chatInput: boolean;
	createdAt?: string | null;
	description?: string | null;
	edges: WorkflowEdge[];
	id: string;
	name: string;
	nodes: WorkflowNode[];
	triggers: WorkflowTrigger[];
	updatedAt?: string | null;
}

/** Overall run status (mirrors Core's `RunStatus`). `awaiting_input` means the
 * run is suspended at a durable Awakeable (human-in-the-loop) gate and can be
 * continued via {@link resumeWorkflow}. `waiting` means a provider rate, usage,
 * or session limit parked it; Core resumes it on its own at `resumeAt`. */
export type RunStatus =
	| "running"
	| "completed"
	| "failed"
	| "awaiting_input"
	| "waiting";

/** A workflow run record returned by Core's executor / run store. */
export interface WorkflowRun {
	/** The gate node id this run is suspended on (set when status is
	 * `awaiting_input`); identifies which Awakeable to resume. */
	awaitingNode?: string | null;
	createdAt: string;
	/** True when this is a transient read-only dry-run projection. */
	dryRun: boolean;
	error?: string | null;
	input: Record<string, string>;
	nodes: Record<string, NodeRunState>;
	output: Record<string, string>;
	/** When a `waiting` run resumes (RFC3339). */
	resumeAt?: string | null;
	runId: string;
	status: RunStatus;
	updatedAt: string;
	/** The limit error that parked a `waiting` run. */
	waitReason?: string | null;
	workflowId: string;
}

export interface RunWorkflowOptions {
	/** Evaluate without durable state or effectful node execution. */
	dryRun?: boolean;
}

/** Read the Core error message out of a non-2xx JSON body, falling back to the
 * status code. Core shapes failures as `{ success: false, error: "..." }`, so a
 * cycle / unknown-node DAG validation error reaches the UI verbatim. */
async function errorFromResponse(resp: Response, path: string): Promise<Error> {
	try {
		const text = await resp.text();
		const body = workflowErrorSchema.safeParse(text ? JSON.parse(text) : null);
		if (body.success && body.data.error) {
			return new Error(body.data.error);
		}
	} catch {
		// Non-JSON body — fall through to the status-based message.
	}
	return new Error(`${path} failed: ${resp.status}`);
}

async function postJson(
	target: ApiTarget,
	path: string,
	body: GatewayJsonValue | RunWorkflowRequest | CreateWorkflowVersionRequest
): Promise<RpcJsonResponse> {
	const resp = await authenticatedFetch(target, path, {
		method: "POST",
		body: JSON.stringify(gatewayJsonValueSchema.parse(body)),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	const text = await resp.text();
	return rpcJsonResponseSchema.parse(text ? JSON.parse(text) : undefined);
}

export async function fetchWorkflows(target: ApiTarget): Promise<Workflow[]> {
	const resp = await authenticatedFetch(target, "/workflows");
	if (!resp.ok) {
		throw await errorFromResponse(resp, "/workflows");
	}
	return workflowListEnvelopeSchema.parse(await resp.json()).workflows;
}

/** Fetch a single workflow definition by id (e.g. to re-hydrate the canvas after
 * the natural-language builder mutates it). */
export async function fetchWorkflow(
	target: ApiTarget,
	id: string
): Promise<Workflow> {
	const path = `/workflows/${encodePathId(id)}`;
	const resp = await authenticatedFetch(target, path);
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	return workflowEnvelopeSchema.parse(await resp.json()).workflow;
}

/** Create (or overwrite, when `id` is set) a workflow. Core validates the DAG
 * first and returns a 400 with the validation error when it is invalid. */
export async function createWorkflow(
	target: ApiTarget,
	definition: Parameters<typeof workflowDefinitionInputSchema.parse>[0]
): Promise<Workflow> {
	const json = await postJson(
		target,
		"/workflows",
		workflowDefinitionInputSchema.parse(definition)
	);
	return workflowEnvelopeSchema.parse(json).workflow;
}

export async function deleteWorkflow(
	target: ApiTarget,
	id: string
): Promise<void> {
	const path = `/workflows/${encodePathId(id)}`;
	const resp = await authenticatedFetch(target, path, {
		method: "DELETE",
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
	const body: RunWorkflowRequest = { input };
	if (options.dryRun) {
		body.dryRun = true;
	}
	const json = await postJson(
		target,
		`/workflows/${encodePathId(id)}/run`,
		body
	);
	return workflowRunEnvelopeSchema.parse(json).run;
}

/** Fetch the current state of a run (e.g. to poll a suspended run). */
export async function getWorkflowRun(
	target: ApiTarget,
	runId: string
): Promise<WorkflowRun> {
	const path = `/workflows/runs/${encodePathId(runId)}`;
	const resp = await authenticatedFetch(target, path);
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	return workflowRunEnvelopeSchema.parse(await resp.json()).run;
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
		{ payload }
	);
	return workflowRunEnvelopeSchema.parse(json).run;
}

// ---------------------------------------------------------------------------
// Workflow-template catalog (`/api/workflows/catalog*`)
//
// The Store's "Workflow Templates" section browses a Core-curated catalog of
// ready-made workflows keyed by the agent-design PATTERN each demonstrates
// (evaluator-optimizer, routing, orchestrator-workers, the autoresearch
// git-ledger loop, …). A template is one primary Workflow plus zero-or-more
// body workflows (durable `while` nodes need a separate body); Core mints fresh
// ids on install and returns the primary. These endpoints live under `/api/*`
// (unlike the `/workflows` CRUD above) to match the catalog namespace.
// ---------------------------------------------------------------------------

/** Full template detail: the meta plus the primary workflow's preview graph. */
export interface WorkflowTemplateDetail extends WorkflowTemplateMeta {
	edges: WorkflowEdge[];
	nodes: WorkflowNode[];
}

/** Browse the workflow-template catalog (`GET /api/workflows/catalog`). */
export async function fetchWorkflowTemplates(
	target: ApiTarget
): Promise<WorkflowTemplateMeta[]> {
	const resp = await authenticatedFetch(target, "/api/workflows/catalog");
	if (!resp.ok) {
		throw await errorFromResponse(resp, "/api/workflows/catalog");
	}
	return workflowTemplateListEnvelopeSchema.parse(await resp.json()).templates;
}

/** Fetch one template's detail incl. the primary workflow's preview graph. */
export async function fetchWorkflowTemplate(
	target: ApiTarget,
	id: string
): Promise<WorkflowTemplateDetail> {
	const path = `/api/workflows/catalog/${encodePathId(id)}`;
	const resp = await authenticatedFetch(target, path);
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	return workflowTemplateEnvelopeSchema.parse(await resp.json()).template;
}

/** Install a template: Core mints fresh workflow ids (primary + any `while`
 * bodies, patching the references), persists all, and returns the primary id. */
export async function installWorkflowTemplate(
	target: ApiTarget,
	templateId: string
): Promise<string> {
	const json = await postJson(target, "/api/workflows/catalog/install", {
		template_id: templateId,
	});
	return workflowInstallResultSchema.parse(json).workflow_id;
}

export type WorkflowTemplateInstallPreview = z.output<
	typeof workflowInstallPreviewSchema
>;

export function previewWorkflowTemplateInstall(
	target: ApiTarget,
	templateId: string
): Promise<WorkflowTemplateInstallPreview> {
	return postJson(target, "/api/workflows/catalog/install", {
		dryRun: true,
		template_id: templateId,
	}).then(workflowInstallPreviewSchema.parse);
}

// ── Version history (server-backed) ─────────────────────────────────────────

/** List a workflow's saved versions, newest first (metadata only). */
export async function listWorkflowVersions(
	target: ApiTarget,
	id: string
): Promise<WorkflowVersionMeta[]> {
	const path = `/workflows/${encodePathId(id)}/versions`;
	const resp = await authenticatedFetch(target, path);
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	return workflowVersionListEnvelopeSchema.parse(await resp.json()).versions;
}

/** Fetch one version's captured definition as the raw wire object (snake_case),
 * suitable for JSON-stringifying to diff against a canvas definition. */
export async function getWorkflowVersionDefinition(
	target: ApiTarget,
	id: string,
	versionId: string
): Promise<z.output<typeof workflowDefinitionInputSchema>> {
	const path = `/workflows/${encodePathId(id)}/versions/${encodePathId(versionId)}`;
	const resp = await authenticatedFetch(target, path);
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	return (
		workflowVersionDefinitionEnvelopeSchema.parse(await resp.json()).version
			?.workflow ?? {}
	);
}

/** Snapshot the workflow's current definition as a new version. */
export async function createWorkflowVersion(
	target: ApiTarget,
	id: string,
	label?: string,
	expectedRevision?: string
): Promise<void> {
	const body: CreateWorkflowVersionRequest = {};
	if (label) {
		body.label = label;
	}
	if (expectedRevision !== undefined) {
		body.expectedRevision = expectedRevision;
	}
	await postJson(target, `/workflows/${encodePathId(id)}/versions`, body);
}

/** Restore a version as the workflow's current definition (undoable server-side).
 * Returns the restored definition so the caller can re-hydrate the canvas. */
export async function restoreWorkflowVersion(
	target: ApiTarget,
	id: string,
	versionId: string
): Promise<Workflow> {
	const json = await postJson(
		target,
		`/workflows/${encodePathId(id)}/versions/${encodePathId(versionId)}/restore`,
		{}
	);
	return workflowEnvelopeSchema.parse(json).workflow;
}

interface RunWorkflowRequest {
	dryRun?: boolean;
	input: Record<string, string>;
}
interface CreateWorkflowVersionRequest {
	expectedRevision?: string;
	label?: string;
}
