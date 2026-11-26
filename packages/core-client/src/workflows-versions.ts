// packages/core-client/src/workflows-versions.ts
//
// Server-backed version history of a workflow (`/workflows/:id/versions`),
// split out of workflows.ts, which re-exports it. The workflow id and the
// version id go into the path through encodePathId (Core's own routes).

import { z } from "zod";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "./app-request-json.ts";
import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";
import { encodePathId } from "./path-id.ts";
import {
	errorFromResponse,
	nativeWorkflowArray,
	nativeWorkflowJson,
	postJson,
	toWorkflow,
	type Workflow,
	wireVersion,
	wireVersionMeta,
	workflowEnvelope,
} from "./workflows-types.ts";

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
	const path = `/workflows/${encodePathId(id)}/versions`;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
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
	const path = `/workflows/${encodePathId(id)}/versions/${encodePathId(versionId)}`;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw await errorFromResponse(resp, path);
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
		`/workflows/${encodePathId(id)}/versions`,
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
		`/workflows/${encodePathId(id)}/versions/${encodePathId(versionId)}/restore`,
		{},
		workflowEnvelope
	);
	return toWorkflow(json.workflow);
}
