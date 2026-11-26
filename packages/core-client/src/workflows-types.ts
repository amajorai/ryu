// packages/core-client/src/workflows-types.ts
//
// Wire schemas, public types and the shared request helpers of the workflows
// client (`workflows.ts`), split out of it to keep every part under the hook
// limits. `workflows.ts` re-exports the public names; the template, version
// and history requests live in workflows-templates.ts, workflows-versions.ts
// and workflows-history.ts.

import { z } from "zod";
import {
	type AppResponseValue,
	appJsonValueSchema,
} from "./app-request-json.ts";

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";

/** Native decoded JSON retains references and future fields after checking the
 * published fields. Core remains the owner of DAG authoring validation. */
export function nativeWorkflowJson<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export function nativeWorkflowArray<S extends z.ZodType>(item: S) {
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
export const stringMap = nativeWorkflowJson(z.record(z.string(), z.string()));
export const nodeState = nativeWorkflowJson(
	z.object({
		status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
		output: z.string().nullish(),
		error: z.string().nullish(),
		attempts: z.number().optional(),
		wake_at: z.string().nullish(),
	})
);
export const runStatusSchema = z.enum([
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
export const wireTemplate = nativeWorkflowJson(z.object(templateFields));
export const wireTemplateDetail = nativeWorkflowJson(
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
export const wireVersionMeta = nativeWorkflowJson(z.object(versionFields));
export const wireVersion = nativeWorkflowJson(
	z.object({ ...versionFields, workflow: wireWorkflow.optional() })
);
export const workflowEnvelope = nativeWorkflowJson(
	z.object({ workflow: wireWorkflow, success: z.boolean().optional() })
);
export const runEnvelope = nativeWorkflowJson(
	z.object({ run: wireRun, success: z.boolean().optional() })
);
export const workflowsEnvelope = nativeWorkflowJson(
	z.object({ workflows: nativeWorkflowArray(wireWorkflow).optional() })
);

export type WorkflowNativeJsonInput = Parameters<typeof JSON.stringify>[0];

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

export function toWorkflow(w: WorkflowWire): Workflow {
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

export function toRun(r: WorkflowRunWire): WorkflowRun {
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

/** Read the Core error message out of a non-2xx JSON body, falling back to the
 * status code. Core shapes failures as `{ success: false, error: "..." }`, so a
 * cycle / unknown-node DAG validation error reaches the UI verbatim. */
export async function errorFromResponse(
	resp: Response,
	path: string
): Promise<Error> {
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

export async function postJson<S extends z.ZodType>(
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
