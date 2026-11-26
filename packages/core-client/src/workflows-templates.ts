// packages/core-client/src/workflows-templates.ts
//
// The workflow template catalog (`/api/workflows/catalog`), split out of
// workflows.ts, which re-exports it. A template id goes into its path through
// encodePathId (Core's own route, not a mount).

import { z } from "zod";
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
	type WorkflowEdge,
	type WorkflowNode,
	wireTemplate,
	wireTemplateDetail,
} from "./workflows-types.ts";

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
	const path = `/api/workflows/catalog/${encodePathId(id)}`;
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
