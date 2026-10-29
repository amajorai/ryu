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

import { z } from "zod";
import {
	type AppResponseValue,
	appJsonValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";

/** Native decoded JSON retains references and future fields after checking the
 * published fields. Core remains the owner of DAG authoring validation. */
function nativeWorkflowJson<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
function nativeWorkflowArray<S extends z.ZodType>(item: S) {
	return nativeWorkflowJson(z.array(item));
}
const wireNode = nativeWorkflowJson(
	z.object({ id: z.string(), type: z.string() }).catchall(appJsonValueSchema)
);
const wireEdge = nativeWorkflowJson(
	z.object({ from: z.string(), to: z.string(), branch: z.string().nullish() })
);
const wireTrigger = nativeWorkflowJson(
	z.discriminatedUnion("type", [
		z.object({ type: z.literal("manual") }),
		z.object({
			type: z.literal("schedule"),
			cron: z.string().nullish(),
			every: z.string().nullish(),
			require_approval: z.boolean().optional(),
		}),
		z.object({ type: z.literal("webhook"), secret: z.string().nullish() }),
		z.object({
			type: z.literal("composio"),
			toolkit: z.string(),
			trigger_slug: z.string(),
			connected_account_id: z.string().nullish(),
		}),
		z.object({ type: z.literal("event"), event: z.string() }),
	])
);
const wireWorkflow = nativeWorkflowJson(
	z.object({
		id: z.string(),
		name: z.string(),
		description: z.string().nullish(),
		nodes: nativeWorkflowArray(wireNode).optional(),
		edges: nativeWorkflowArray(wireEdge).optional(),
		triggers: nativeWorkflowArray(wireTrigger).optional(),
		created_at: z.string().nullish(),
		updated_at: z.string().nullish(),
	})
);
const stringMap = nativeWorkflowJson(z.record(z.string(), z.string()));
const nodeState = nativeWorkflowJson(
	z.object({
		status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
		output: z.string().nullish(),
		error: z.string().nullish(),
		attempts: z.number().optional(),
		wake_at: z.string().nullish(),
	})
);
const runStatusSchema = z.enum([
	"running",
	"completed",
	"failed",
	"awaiting_input",
	"waiting",
]);
const wireRun = nativeWorkflowJson(
	z.object({
		run_id: z.string(),
		workflow_id: z.string(),
		status: runStatusSchema,
		resume_at: z.string().nullish(),
		wait_reason: z.string().nullish(),
		dryRun: z.boolean().nullish(),
		dry_run: z.boolean().nullish(),
		input: stringMap.optional(),
		output: stringMap.optional(),
		nodes: nativeWorkflowJson(z.record(z.string(), nodeState)).optional(),
		state: stringMap.optional(),
		error: z.string().nullish(),
		awaiting_node: z.string().nullish(),
		forked_from: nativeWorkflowJson(
			z.object({ run_id: z.string(), checkpoint_id: z.string() })
		).nullish(),
		created_at: z.string(),
		updated_at: z.string(),
	})
);
const templateFields = {
	id: z.string(),
	name: z.string(),
	description: z.string().nullish(),
	category: z.string().nullish(),
	pattern: z.string(),
	icon: z.string().nullish(),
	node_count: z.number().nullish(),
	tags: nativeWorkflowArray(z.string()).nullish(),
	source_url: z.string().nullish(),
};
const wireTemplate = nativeWorkflowJson(z.object(templateFields));
const wireTemplateDetail = nativeWorkflowJson(
	z.object({
		...templateFields,
		nodes: nativeWorkflowArray(wireNode).optional(),
		edges: nativeWorkflowArray(wireEdge).optional(),
	})
);
const versionFields = {
	id: z.string(),
	workflow_id: z.string(),
	name: z.string(),
	label: z.string().nullish(),
	created_at: z.number(),
};
const wireVersionMeta = nativeWorkflowJson(z.object(versionFields));
const wireVersion = nativeWorkflowJson(
	z.object({ ...versionFields, workflow: wireWorkflow.optional() })
);
const workflowEnvelope = nativeWorkflowJson(
	z.object({ workflow: wireWorkflow, success: z.boolean().optional() })
);
const runEnvelope = nativeWorkflowJson(
	z.object({ run: wireRun, success: z.boolean().optional() })
);
const workflowsEnvelope = nativeWorkflowJson(
	z.object({ workflows: nativeWorkflowArray(wireWorkflow).optional() })
);

type WorkflowNativeJsonInput = Parameters<typeof JSON.stringify>[0];

/** A single node in a workflow definition. `type` selects the node kind and
 * carries its config (Core flattens the kind onto the node). We keep the config
 * open since the JSON editor is the create surface for DA8. */
export interface WorkflowNode {
	id: string;
	type: string;
	[key: string]: AppResponseValue;
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
	| {
			type: "schedule";
			cron?: string | null;
			every?: string | null;
			require_approval?: boolean;
	  }
	| { type: "webhook"; secret?: string | null }
	| {
			type: "composio";
			toolkit: string;
			trigger_slug: string;
			connected_account_id?: string | null;
	  }
	/** Run when an app event fires — an event an installed app declared in its
	 *  manifest `contributes.hook_events`, named fully-qualified as
	 *  `<owning plugin id>#<event name>`. */
	| { type: "event"; event: string };

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
	nodes?: WorkflowNode[];
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
 * continued via {@link resumeWorkflow}. `waiting` means the run hit a provider
 * rate, usage, or session limit and Core resumes it at `resumeAt`. */
export type RunStatus = z.output<typeof runStatusSchema>;

/** Where a forked run came from (see {@link forkRun}). */
export interface WorkflowRunLineage {
	/** The history checkpoint of the parent the fork resumed from. */
	checkpointId: string;
	/** The run the fork was taken from. */
	runId: string;
}

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
	/** True when this is a transient read-only dry-run projection. */
	dryRun: boolean;
	error?: string | null;
	/** Set when this run was forked from another run's checkpoint. */
	forkedFrom?: WorkflowRunLineage;
	input: Record<string, string>;
	nodes: Record<string, NodeRunState>;
	output: Record<string, string>;
	/** When a `waiting` run is woken (RFC3339, UTC). */
	resumeAt?: string | null;
	runId: string;
	status: RunStatus;
	updatedAt: string;
	/** The limit error that parked a `waiting` run. */
	waitReason?: string | null;
	workflowId: string;
}

interface WorkflowRunWire {
	awaiting_node?: string | null;
	created_at: string;
	dry_run?: boolean | null;
	dryRun?: boolean | null;
	error?: string | null;
	forked_from?: { checkpoint_id: string; run_id: string } | null;
	input?: Record<string, string>;
	nodes?: Record<string, NodeRunState>;
	output?: Record<string, string>;
	resume_at?: string | null;
	run_id: string;
	status: RunStatus;
	updated_at: string;
	wait_reason?: string | null;
	workflow_id: string;
}

function toRun(r: WorkflowRunWire): WorkflowRun {
	const run: WorkflowRun = {
		runId: r.run_id,
		workflowId: r.workflow_id,
		status: r.status,
		dryRun: r.dryRun ?? r.dry_run ?? false,
		input: r.input ?? {},
		output: r.output ?? {},
		nodes: r.nodes ?? {},
		error: r.error ?? null,
		awaitingNode: r.awaiting_node ?? null,
		// Only limit-parked runs carry these; omit them otherwise so existing
		// run projections keep their exact shape.
		...(r.resume_at ? { resumeAt: r.resume_at } : {}),
		...(r.wait_reason ? { waitReason: r.wait_reason } : {}),
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
	if (r.forked_from) {
		run.forkedFrom = {
			runId: r.forked_from.run_id,
			checkpointId: r.forked_from.checkpoint_id,
		};
	}
	return run;
}

export interface RunWorkflowOptions {
	/** Evaluate without durable state or effectful node execution. */
	dryRun?: boolean;
	/**
	 * Run id to create (or resume) instead of a generated one. A caller that
	 * mints the id can poll {@link getWorkflowRun} while the run call is still
	 * in flight. Ignored for dry runs.
	 */
	runId?: string;
}

interface WorkflowRunBody {
	dryRun?: RunWorkflowOptions["dryRun"];
	input: Parameters<typeof runWorkflow>[2];
	runId?: RunWorkflowOptions["runId"];
}

/** Read the Core error message out of a non-2xx JSON body, falling back to the
 * status code. Core shapes failures as `{ success: false, error: "..." }`, so a
 * cycle / unknown-node DAG validation error reaches the UI verbatim. */
async function errorFromResponse(resp: Response, path: string): Promise<Error> {
	try {
		const text = await resp.text();
		const body = text
			? nativeWorkflowJson(
					z.object({ error: z.string().optional() })
				).safeParse(JSON.parse(text))
			: null;
		if (body?.success && body.data.error && body.data.error.length > 0) {
			return new Error(body.data.error);
		}
	} catch {
		// Non-JSON body — fall through to the status-based message.
	}
	return new Error(`${path} failed: ${resp.status}`);
}

async function postJson<S extends z.ZodType>(
	target: ApiTarget,
	path: string,
	body: WorkflowNativeJsonInput,
	schema: S
): Promise<z.output<S>> {
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	const text = await resp.text();
	return schema.parse(text ? JSON.parse(text) : undefined);
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
	const resp = await fetchForTarget(target)(
		apiUrl(target, `/workflows/${id}`),
		{
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw await errorFromResponse(resp, `/workflows/${id}`);
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
	const resp = await fetchForTarget(target)(
		apiUrl(target, `/workflows/${id}`),
		{
			method: "DELETE",
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw await errorFromResponse(resp, `/workflows/${id}`);
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
		`/workflows/${id}/run`,
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
	const resp = await fetchForTarget(target)(
		apiUrl(target, `/workflows/runs/${runId}`),
		{
			headers: makeHeaders(target.token, target.userJwt),
			signal,
		}
	);
	if (!resp.ok) {
		throw await errorFromResponse(resp, `/workflows/runs/${runId}`);
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
		`/workflows/runs/${runId}/resume`,
		{ payload },
		runEnvelope
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

function toTemplateCategory(
	value: string | null | undefined
): WorkflowTemplateCategory {
	const category = z
		.enum(["research", "orchestration", "quality", "automation"])
		.safeParse(value);
	return category.success ? category.data : "orchestration";
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
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/workflows/catalog"),
		{
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw await errorFromResponse(resp, "/api/workflows/catalog");
	}
	const json = nativeWorkflowJson(
		z.object({ templates: nativeWorkflowArray(wireTemplate).optional() })
	).parse(await resp.json());
	return (json.templates ?? []).map(toTemplateMeta);
}

/** Fetch one template's detail incl. the primary workflow's preview graph. */
export async function fetchWorkflowTemplate(
	target: ApiTarget,
	id: string
): Promise<WorkflowTemplateDetail> {
	const path = `/api/workflows/catalog/${id}`;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
	}
	const json = nativeWorkflowJson(
		z.object({ template: wireTemplateDetail })
	).parse(await resp.json());
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
	const json = await postJson(
		target,
		"/api/workflows/catalog/install",
		{ template_id: templateId },
		nativeWorkflowJson(
			z.object({ workflow_id: z.string(), success: z.boolean().optional() })
		)
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
	const resp = await fetchForTarget(target)(
		apiUrl(target, `/workflows/${id}/versions`),
		{
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw await errorFromResponse(resp, `/workflows/${id}/versions`);
	}
	const json = nativeWorkflowJson(
		z.object({ versions: nativeWorkflowArray(wireVersionMeta).optional() })
	).parse(await resp.json());
	return (json.versions ?? []).map(toWorkflowVersionMeta);
}

/** Fetch one version's captured definition as the raw wire object (snake_case),
 * suitable for JSON-stringifying to diff against a canvas definition. */
export async function getWorkflowVersionDefinition(
	target: ApiTarget,
	id: string,
	versionId: string
): Promise<Record<string, AppResponseValue>> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, `/workflows/${id}/versions/${versionId}`),
		{ headers: makeHeaders(target.token, target.userJwt) }
	);
	if (!resp.ok) {
		throw await errorFromResponse(
			resp,
			`/workflows/${id}/versions/${versionId}`
		);
	}
	const json = nativeWorkflowJson(
		z.object({ version: wireVersion.optional() })
	).parse(await resp.json());
	return json.version?.workflow ?? {};
}

/** Snapshot the workflow's current definition as a new version. */
export async function createWorkflowVersion(
	target: ApiTarget,
	id: string,
	label?: string,
	expectedRevision?: string
): Promise<void> {
	interface WorkflowVersionBody {
		expectedRevision?: Parameters<typeof createWorkflowVersion>[3];
		label?: Parameters<typeof createWorkflowVersion>[2];
	}
	const body: WorkflowVersionBody = {};
	if (label) {
		body.label = label;
	}
	if (expectedRevision !== undefined) {
		body.expectedRevision = expectedRevision;
	}
	await postJson(
		target,
		`/workflows/${id}/versions`,
		body,
		appResponseValueSchema
	);
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
		`/workflows/${id}/versions/${versionId}/restore`,
		{},
		workflowEnvelope
	);
	return toWorkflow(json.workflow);
}

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

// Shared Core-owned decoding and projection for direct-fetch host adapters.
export {
	errorFromResponse as readWorkflowErrorFromResponse,
	runEnvelope as workflowRunResponseSchema,
	toRun as projectWorkflowRunWire,
	toWorkflow as projectWorkflowWire,
	workflowEnvelope as workflowResponseSchema,
	workflowsEnvelope as workflowsResponseSchema,
};
