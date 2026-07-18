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

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

/** A single node in a workflow definition. `type` selects the node kind and
 * carries its config (Core flattens the kind onto the node). We keep the config
 * open since the JSON editor is the create surface for DA8. */
export interface WorkflowNode {
	id: string;
	type: string;
	[key: string]: unknown;
}

/** A directed edge between two node ids, optionally gated on a branch label. */
export interface WorkflowEdge {
	branch?: string | null;
	from: string;
	to: string;
}

/** How a workflow is fired. Mirrors Core's `WorkflowTrigger` (serde tag="type",
 * snake_case). The wire shape is the tagged union directly. */
export type WorkflowTrigger =
	| { type: "manual" }
	| { type: "schedule"; cron?: string | null; every?: string | null }
	| { type: "webhook"; secret?: string | null }
	| {
			type: "composio";
			toolkit: string;
			trigger_slug: string;
			connected_account_id?: string | null;
	  };

/** A persisted workflow definition as returned by Core. */
export interface Workflow {
	createdAt?: string | null;
	description?: string | null;
	edges: WorkflowEdge[];
	id: string;
	name: string;
	nodes: WorkflowNode[];
	triggers: WorkflowTrigger[];
	updatedAt?: string | null;
}

interface WorkflowWire {
	created_at?: string | null;
	description?: string | null;
	edges?: WorkflowEdge[];
	id: string;
	name: string;
	nodes: WorkflowNode[];
	triggers?: WorkflowTrigger[];
	updated_at?: string | null;
}

function toWorkflow(w: WorkflowWire): Workflow {
	return {
		id: w.id,
		name: w.name,
		description: w.description ?? null,
		nodes: w.nodes ?? [],
		edges: w.edges ?? [],
		triggers: w.triggers ?? [],
		createdAt: w.created_at ?? null,
		updatedAt: w.updated_at ?? null,
	};
}

/** Per-node status within a run (mirrors Core's `NodeStatus`). */
export type NodeStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "skipped";

/** Overall run status (mirrors Core's `RunStatus`). `awaiting_input` means the
 * run is suspended at a durable Awakeable (human-in-the-loop) gate and can be
 * continued via {@link resumeWorkflow}. */
export type RunStatus = "running" | "completed" | "failed" | "awaiting_input";

/** Persisted state of a single node within a run. */
export interface NodeRunState {
	error?: string | null;
	output?: string | null;
	status: NodeStatus;
}

/** A workflow run record returned by Core's executor / run store. */
export interface WorkflowRun {
	/** The gate node id this run is suspended on (set when status is
	 * `awaiting_input`); identifies which Awakeable to resume. */
	awaitingNode?: string | null;
	createdAt: string;
	error?: string | null;
	input: Record<string, string>;
	nodes: Record<string, NodeRunState>;
	output: Record<string, string>;
	runId: string;
	status: RunStatus;
	updatedAt: string;
	workflowId: string;
}

interface WorkflowRunWire {
	awaiting_node?: string | null;
	created_at: string;
	error?: string | null;
	input?: Record<string, string>;
	nodes?: Record<string, NodeRunState>;
	output?: Record<string, string>;
	run_id: string;
	status: RunStatus;
	updated_at: string;
	workflow_id: string;
}

function toRun(r: WorkflowRunWire): WorkflowRun {
	return {
		runId: r.run_id,
		workflowId: r.workflow_id,
		status: r.status,
		input: r.input ?? {},
		output: r.output ?? {},
		nodes: r.nodes ?? {},
		error: r.error ?? null,
		awaitingNode: r.awaiting_node ?? null,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

/** Read the Core error message out of a non-2xx JSON body, falling back to the
 * status code. Core shapes failures as `{ success: false, error: "..." }`, so a
 * cycle / unknown-node DAG validation error reaches the UI verbatim. */
async function errorFromResponse(resp: Response, path: string): Promise<Error> {
	try {
		const text = await resp.text();
		const body = text ? (JSON.parse(text) as { error?: unknown }) : null;
		if (body && typeof body.error === "string" && body.error.length > 0) {
			return new Error(body.error);
		}
	} catch {
		// Non-JSON body — fall through to the status-based message.
	}
	return new Error(`${path} failed: ${resp.status}`);
}

async function postJson<T>(
	target: ApiTarget,
	path: string,
	body: unknown
): Promise<T> {
	const resp = await fetch(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token),
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	const text = await resp.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

export async function fetchWorkflows(target: ApiTarget): Promise<Workflow[]> {
	const resp = await fetch(apiUrl(target, "/workflows"), {
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, "/workflows");
	}
	const json = (await resp.json()) as { workflows?: WorkflowWire[] };
	return (json.workflows ?? []).map(toWorkflow);
}

/** Fetch a single workflow definition by id (e.g. to re-hydrate the canvas after
 * the natural-language builder mutates it). */
export async function fetchWorkflow(
	target: ApiTarget,
	id: string
): Promise<Workflow> {
	const resp = await fetch(apiUrl(target, `/workflows/${id}`), {
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, `/workflows/${id}`);
	}
	const json = (await resp.json()) as { workflow: WorkflowWire };
	return toWorkflow(json.workflow);
}

/** Create (or overwrite, when `id` is set) a workflow. Core validates the DAG
 * first and returns a 400 with the validation error when it is invalid. */
export async function createWorkflow(
	target: ApiTarget,
	definition: unknown
): Promise<Workflow> {
	const json = await postJson<{ workflow: WorkflowWire }>(
		target,
		"/workflows",
		definition
	);
	return toWorkflow(json.workflow);
}

export async function deleteWorkflow(
	target: ApiTarget,
	id: string
): Promise<void> {
	const resp = await fetch(apiUrl(target, `/workflows/${id}`), {
		method: "DELETE",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, `/workflows/${id}`);
	}
}

/** Run a workflow end-to-end with an initial input map and return the run. */
export async function runWorkflow(
	target: ApiTarget,
	id: string,
	input: Record<string, string>
): Promise<WorkflowRun> {
	const json = await postJson<{ run: WorkflowRunWire }>(
		target,
		`/workflows/${id}/run`,
		{ input }
	);
	return toRun(json.run);
}

/** Fetch the current state of a run (e.g. to poll a suspended run). */
export async function getWorkflowRun(
	target: ApiTarget,
	runId: string
): Promise<WorkflowRun> {
	const resp = await fetch(apiUrl(target, `/workflows/runs/${runId}`), {
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, `/workflows/runs/${runId}`);
	}
	const json = (await resp.json()) as { run: WorkflowRunWire };
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
	const json = await postJson<{ run: WorkflowRunWire }>(
		target,
		`/workflows/runs/${runId}/resume`,
		{ payload }
	);
	return toRun(json.run);
}

// ── Template catalog (mirrors apps/desktop/src/lib/api/workflows.ts) ─────────

/** The four agent-design-pattern buckets templates are grouped under. */
export type WorkflowTemplateCategory =
	| "research"
	| "orchestration"
	| "quality"
	| "automation";

const TEMPLATE_CATEGORIES: readonly string[] = [
	"research",
	"orchestration",
	"quality",
	"automation",
];

/** Summary card for a workflow template (list view). */
export interface WorkflowTemplateMeta {
	category: WorkflowTemplateCategory;
	description: string;
	/** Optional icon hint (emoji or icon id) from the catalog; may be null. */
	icon: string | null;
	id: string;
	name: string;
	/** Number of nodes in the primary workflow (a "size" hint for the card). */
	nodeCount: number;
	/** The agent-design pattern the template demonstrates (e.g. "routing"). */
	pattern: string;
	/** Provenance link (e.g. the Anthropic/Karpathy write-up), when set. */
	sourceUrl: string | null;
	tags: string[];
}

/** Full template detail: the meta plus the primary workflow's preview graph. */
export interface WorkflowTemplateDetail extends WorkflowTemplateMeta {
	edges: WorkflowEdge[];
	nodes: WorkflowNode[];
}

interface WorkflowTemplateMetaWire {
	category?: string | null;
	description?: string | null;
	icon?: string | null;
	id: string;
	name: string;
	node_count?: number | null;
	pattern: string;
	source_url?: string | null;
	tags?: string[] | null;
}

interface WorkflowTemplateDetailWire extends WorkflowTemplateMetaWire {
	edges?: WorkflowEdge[];
	nodes?: WorkflowNode[];
}

function toTemplateCategory(
	value: string | null | undefined
): WorkflowTemplateCategory {
	return value && TEMPLATE_CATEGORIES.includes(value)
		? (value as WorkflowTemplateCategory)
		: "orchestration";
}

function toTemplateMeta(w: WorkflowTemplateMetaWire): WorkflowTemplateMeta {
	return {
		id: w.id,
		name: w.name,
		description: w.description ?? "",
		category: toTemplateCategory(w.category),
		pattern: w.pattern,
		icon: w.icon ?? null,
		nodeCount: w.node_count ?? 0,
		tags: w.tags ?? [],
		sourceUrl: w.source_url ?? null,
	};
}

/** Browse the workflow-template catalog (`GET /api/workflows/catalog`). */
export async function fetchWorkflowTemplates(
	target: ApiTarget
): Promise<WorkflowTemplateMeta[]> {
	const resp = await fetch(apiUrl(target, "/api/workflows/catalog"), {
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, "/api/workflows/catalog");
	}
	const json = (await resp.json()) as {
		templates?: WorkflowTemplateMetaWire[];
	};
	return (json.templates ?? []).map(toTemplateMeta);
}

/** Fetch one template's detail incl. the primary workflow's preview graph. */
export async function fetchWorkflowTemplate(
	target: ApiTarget,
	id: string
): Promise<WorkflowTemplateDetail> {
	const path = `/api/workflows/catalog/${id}`;
	const resp = await fetch(apiUrl(target, path), {
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	const json = (await resp.json()) as { template: WorkflowTemplateDetailWire };
	const t = json.template;
	return {
		...toTemplateMeta(t),
		nodes: t.nodes ?? [],
		edges: t.edges ?? [],
	};
}

/** Install a template: Core mints fresh workflow ids (primary + any `while`
 * bodies, patching the references), persists all, and returns the primary id. */
export async function installWorkflowTemplate(
	target: ApiTarget,
	templateId: string
): Promise<string> {
	const json = await postJson<{ workflow_id: string }>(
		target,
		"/api/workflows/catalog/install",
		{ template_id: templateId }
	);
	return json.workflow_id;
}

// ── Version history (server-backed) ─────────────────────────────────────────

/** Metadata for one saved workflow version. */
export interface WorkflowVersionMeta {
	/** Unix milliseconds. */
	createdAt: number;
	id: string;
	label: string | null;
	name: string;
	workflowId: string;
}

interface WorkflowVersionMetaWire {
	created_at: number;
	id: string;
	label?: string | null;
	name: string;
	workflow_id: string;
}

function toWorkflowVersionMeta(
	w: WorkflowVersionMetaWire
): WorkflowVersionMeta {
	return {
		createdAt: w.created_at,
		id: w.id,
		label: w.label ?? null,
		name: w.name,
		workflowId: w.workflow_id,
	};
}

/** List a workflow's saved versions, newest first (metadata only). */
export async function listWorkflowVersions(
	target: ApiTarget,
	id: string
): Promise<WorkflowVersionMeta[]> {
	const resp = await fetch(apiUrl(target, `/workflows/${id}/versions`), {
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, `/workflows/${id}/versions`);
	}
	const json = (await resp.json()) as { versions?: WorkflowVersionMetaWire[] };
	return (json.versions ?? []).map(toWorkflowVersionMeta);
}

/** Fetch one version's captured definition as the raw wire object (snake_case),
 * suitable for JSON-stringifying to diff against a canvas definition. */
export async function getWorkflowVersionDefinition(
	target: ApiTarget,
	id: string,
	versionId: string
): Promise<Record<string, unknown>> {
	const resp = await fetch(
		apiUrl(target, `/workflows/${id}/versions/${versionId}`),
		{ headers: makeHeaders(target.token) }
	);
	if (!resp.ok) {
		throw await errorFromResponse(
			resp,
			`/workflows/${id}/versions/${versionId}`
		);
	}
	const json = (await resp.json()) as {
		version?: { workflow?: Record<string, unknown> };
	};
	return json.version?.workflow ?? {};
}

/** Snapshot the workflow's current definition as a new version. */
export async function createWorkflowVersion(
	target: ApiTarget,
	id: string,
	label?: string
): Promise<void> {
	await postJson(target, `/workflows/${id}/versions`, label ? { label } : {});
}

/** Restore a version as the workflow's current definition (undoable server-side).
 * Returns the restored definition so the caller can re-hydrate the canvas. */
export async function restoreWorkflowVersion(
	target: ApiTarget,
	id: string,
	versionId: string
): Promise<Workflow> {
	const json = await postJson<{ workflow: WorkflowWire }>(
		target,
		`/workflows/${id}/versions/${versionId}/restore`,
		{}
	);
	return toWorkflow(json.workflow);
}
