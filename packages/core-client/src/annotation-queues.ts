// Typed client for Core's human annotation queues (`/api/annotation-queues/*`).
//
// A queue belongs to one agent and carries a reviewer rubric, an optional closed
// label set and a score range. Items reference a run (conversation), one
// assistant message in a run, or an external trace with its captured
// input/output. Reviewers claim the next item, submit a score/labels/comment,
// and reviewed items export into a Prompt Studio suite as regression cases.
// Field names are snake_case to match Core's serde shapes exactly.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

export const annotationItemStatusSchema = z.enum([
	"pending",
	"in_progress",
	"completed",
	"skipped",
]);
export type AnnotationItemStatus = z.output<typeof annotationItemStatusSchema>;

export const annotationSourceKindSchema = z.enum(["run", "message", "trace"]);
export type AnnotationSourceKind = z.output<typeof annotationSourceKindSchema>;

export const annotationQueueSchema = z.object({
	agent_id: z.string(),
	created_at: z.number(),
	created_by: z.string().nullable(),
	description: z.string().nullable(),
	id: z.string(),
	labels: z.array(z.string()),
	name: z.string(),
	rubric: z.string(),
	score_max: z.number(),
	score_min: z.number(),
	updated_at: z.number(),
});
export type AnnotationQueue = z.output<typeof annotationQueueSchema>;

export const annotationQueueCountsSchema = z.object({
	completed: z.number(),
	in_progress: z.number(),
	pending: z.number(),
	skipped: z.number(),
	total: z.number(),
});
export type AnnotationQueueCounts = z.output<
	typeof annotationQueueCountsSchema
>;

export const annotationQueueSummarySchema = annotationQueueSchema.extend({
	counts: annotationQueueCountsSchema,
});
export type AnnotationQueueSummary = z.output<
	typeof annotationQueueSummarySchema
>;

export const annotationItemSchema = z.object({
	assignee: z.string().nullable(),
	comment: z.string().nullable(),
	completed_at: z.number().nullable(),
	created_at: z.number(),
	id: z.string(),
	input: z.string(),
	labels: z.array(z.string()),
	message_id: z.string().nullable(),
	metadata: z.record(z.string(), z.unknown()),
	output: z.string(),
	queue_id: z.string(),
	reviewed_by: z.string().nullable(),
	run_id: z.string().nullable(),
	score: z.number().nullable(),
	source_kind: annotationSourceKindSchema,
	status: annotationItemStatusSchema,
	trace_id: z.string().nullable(),
	updated_at: z.number(),
});
export type AnnotationItem = z.output<typeof annotationItemSchema>;

const queuesEnvelope = z.object({
	queues: z.array(annotationQueueSummarySchema),
});
const queueEnvelope = z.object({ queue: annotationQueueSchema });
const queueSummaryEnvelope = z.object({ queue: annotationQueueSummarySchema });
const itemsEnvelope = z.object({ items: z.array(annotationItemSchema) });
const itemEnvelope = z.object({ item: annotationItemSchema });
const nextItemEnvelope = z.object({ item: annotationItemSchema.nullable() });
const addItemsEnvelope = z.object({
	added: z.array(annotationItemSchema),
	skipped: z.number(),
});
const successEnvelope = z.object({ success: z.boolean() });
const exportEnvelope = z.object({
	added: z.number(),
	skipped: z.number(),
	suite_id: z.string(),
	version: z
		.object({
			created_at: z.number(),
			id: z.string(),
			label: z.string().nullable(),
			suite_id: z.string(),
		})
		.nullable(),
});
export type AnnotationExportResult = z.output<typeof exportEnvelope>;

/** Fields accepted when creating or updating a queue. */
export interface AnnotationQueueInput {
	description?: string | null;
	labels?: string[];
	name?: string;
	rubric?: string;
	score_max?: number;
	score_min?: number;
}

/**
 * One item to add: a run (optionally narrowed to one assistant message by
 * `message_id`), or an external trace with `trace_id`, `input` and `output`.
 */
export interface AnnotationItemInput {
	assignee?: string;
	input?: string;
	message_id?: string;
	metadata?: Record<string, unknown>;
	output?: string;
	run_id?: string;
	trace_id?: string;
}

export interface AnnotationSubmission {
	comment?: string;
	labels?: string[];
	score?: number;
	/** `completed` (default) or `skipped`. */
	status?: "completed" | "skipped";
}

export interface AnnotationItemFilter {
	assignee?: string;
	limit?: number;
	offset?: number;
	status?: AnnotationItemStatus;
}

export interface AnnotationExportInput {
	/** Only items carrying at least one of these labels. */
	labels?: string[];
	/** Only items whose human score is at least this value. */
	min_score?: number;
	suite_id: string;
}

const queuePath = (queueId: string) =>
	`/api/annotation-queues/${encodeURIComponent(queueId)}`;
const itemPath = (queueId: string, itemId: string) =>
	`${queuePath(queueId)}/items/${encodeURIComponent(itemId)}`;

/** List an agent's annotation queues with per-status item counts. */
export async function listAnnotationQueues(
	target: ApiTarget,
	agentId: string
): Promise<AnnotationQueueSummary[]> {
	const response = await request(
		target,
		`/api/annotation-queues?agent_id=${encodeURIComponent(agentId)}`,
		{},
		queuesEnvelope
	);
	return response.queues;
}

export async function createAnnotationQueue(
	target: ApiTarget,
	agentId: string,
	input: AnnotationQueueInput
): Promise<AnnotationQueue> {
	const response = await request(
		target,
		"/api/annotation-queues",
		{ method: "POST", body: { agent_id: agentId, ...input } },
		queueEnvelope
	);
	return response.queue;
}

export async function getAnnotationQueue(
	target: ApiTarget,
	queueId: string
): Promise<AnnotationQueueSummary> {
	const response = await request(
		target,
		queuePath(queueId),
		{},
		queueSummaryEnvelope
	);
	return response.queue;
}

export async function updateAnnotationQueue(
	target: ApiTarget,
	queueId: string,
	input: AnnotationQueueInput
): Promise<AnnotationQueue> {
	const response = await request(
		target,
		queuePath(queueId),
		{ method: "PUT", body: input },
		queueEnvelope
	);
	return response.queue;
}

export async function deleteAnnotationQueue(
	target: ApiTarget,
	queueId: string
): Promise<boolean> {
	const response = await request(
		target,
		queuePath(queueId),
		{ method: "DELETE" },
		successEnvelope
	);
	return response.success;
}

export async function listAnnotationItems(
	target: ApiTarget,
	queueId: string,
	filter: AnnotationItemFilter = {}
): Promise<AnnotationItem[]> {
	const params = new URLSearchParams();
	if (filter.status) {
		params.set("status", filter.status);
	}
	if (filter.assignee) {
		params.set("assignee", filter.assignee);
	}
	if (filter.limit !== undefined) {
		params.set("limit", String(filter.limit));
	}
	if (filter.offset !== undefined) {
		params.set("offset", String(filter.offset));
	}
	const query = params.toString();
	const response = await request(
		target,
		`${queuePath(queueId)}/items${query ? `?${query}` : ""}`,
		{},
		itemsEnvelope
	);
	return response.items;
}

/** Add runs, messages or traces. Already-queued sources are skipped. */
export function addAnnotationItems(
	target: ApiTarget,
	queueId: string,
	items: AnnotationItemInput[]
): Promise<{ added: AnnotationItem[]; skipped: number }> {
	return request(
		target,
		`${queuePath(queueId)}/items`,
		{ method: "POST", body: { items } },
		addItemsEnvelope
	);
}

/** Claim the next item for the caller; `null` when the queue is drained. */
export async function nextAnnotationItem(
	target: ApiTarget,
	queueId: string
): Promise<AnnotationItem | null> {
	const response = await request(
		target,
		`${queuePath(queueId)}/next`,
		{ method: "POST" },
		nextItemEnvelope
	);
	return response.item;
}

export async function submitAnnotation(
	target: ApiTarget,
	queueId: string,
	itemId: string,
	submission: AnnotationSubmission
): Promise<AnnotationItem> {
	const response = await request(
		target,
		`${itemPath(queueId, itemId)}/submit`,
		{ method: "POST", body: submission },
		itemEnvelope
	);
	return response.item;
}

/** Assign an item to a reviewer, or release it with `null`. */
export async function assignAnnotationItem(
	target: ApiTarget,
	queueId: string,
	itemId: string,
	assignee: string | null
): Promise<AnnotationItem> {
	const response = await request(
		target,
		itemPath(queueId, itemId),
		{ method: "PATCH", body: { assignee } },
		itemEnvelope
	);
	return response.item;
}

export async function deleteAnnotationItem(
	target: ApiTarget,
	queueId: string,
	itemId: string
): Promise<boolean> {
	const response = await request(
		target,
		itemPath(queueId, itemId),
		{ method: "DELETE" },
		successEnvelope
	);
	return response.success;
}

/** Export completed items into a Prompt Studio suite of the same agent. */
export function exportAnnotationQueue(
	target: ApiTarget,
	queueId: string,
	input: AnnotationExportInput
): Promise<AnnotationExportResult> {
	return request(
		target,
		`${queuePath(queueId)}/export`,
		{ method: "POST", body: input },
		exportEnvelope
	);
}
