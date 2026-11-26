// packages/core-client/src/spaces.ts
//
// Typed client for Core's Spaces / RAG endpoints (`/api/spaces`). A Space is a
// named document collection backed by a sqlite-vec vector store; documents are
// ingested (chunked + embedded) and searched by whichever retrieval algorithm
// the Space is set to — vector KNN or entity-graph traversal — after which hits
// are link-expanded and neurally reranked. See {@link searchSpace}. Wire shapes
// mirror the Core handlers in `apps/core/src/server/{mod,spaces}.rs`
// (snake_case on the wire).
//
// Every space and document id goes into its path through encodePathId: these
// are Core's own routes (not a mount), where an encoded slash stays inside its
// segment, and the dot segments are refused. The wire model is in
// spaces-types.ts; documents and pages are in spaces-documents.ts, and the
// reindex, embedding model and search calls in spaces-search.ts. All of them
// are re-exported here.

import {
	type AppResponseValue,
	appResponseValueSchema,
} from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";
import { encodePathId } from "./path-id.ts";
import {
	invalidResponse,
	parseRetrievalMode,
	type RetrievalMode,
	type RetrievalModeCancellation,
	type RetrievalModeChange,
	type RetrievalModeJob,
	type RetrievalModeStatus,
	type RetrievalModeStatusBase,
	requireBoolean,
	requireCount,
	requireRecord,
	requireString,
	type Space,
	spaceDeletedResponse,
	spaceRows,
	spaceString,
	toSpace,
} from "./spaces-types.ts";

export type { SpaceDocumentContent } from "./spaces-documents.ts";
export {
	createPage,
	deleteDocument,
	fetchDocument,
	fetchDocuments,
	ingestDocument,
	setDocumentIcon,
	updateDocument,
} from "./spaces-documents.ts";
export type { EmbeddingModel, ReindexStatus } from "./spaces-search.ts";
export {
	fetchEmbeddingModel,
	fetchReindexStatus,
	searchSpace,
	setEmbeddingModel,
	triggerReindex,
} from "./spaces-search.ts";
export type {
	RetrievalMode,
	RetrievalModeCancellation,
	RetrievalModeChange,
	RetrievalModeJob,
	RetrievalModeStatus,
	Space,
	SpaceDocument,
	SpaceMatch,
} from "./spaces-types.ts";
export { spaceRowFields, spaceSearchResponse } from "./spaces-types.ts";

function parseNullableMode(
	value: AppResponseValue,
	endpoint: string
): RetrievalMode | null {
	if (value === null) {
		return null;
	}
	return parseRetrievalMode(value, endpoint);
}

function parseRetrievalModeChange(
	value: AppResponseValue,
	endpoint: string
): RetrievalModeChange {
	const record = requireRecord(value, endpoint);
	return {
		previous: parseRetrievalMode(record.previous, endpoint),
		mode: parseRetrievalMode(record.mode, endpoint),
		changed: requireBoolean(record, "changed", endpoint),
		graphRebuilt: requireBoolean(record, "graph_rebuilt", endpoint),
		chunksScanned: requireCount(record, "chunks_scanned", endpoint),
		graphNodes: requireCount(record, "graph_nodes", endpoint),
		graphEdges: requireCount(record, "graph_edges", endpoint),
	};
}

function parseRetrievalModeJob(value: AppResponseValue): RetrievalModeJob {
	const endpoint = "retrieval-mode job";
	const record = requireRecord(value, endpoint);
	if (record.success !== true) {
		throw invalidResponse(endpoint);
	}
	return {
		jobId: requireString(record, "job_id", endpoint),
		spaceId: requireString(record, "space_id", endpoint),
		retrievalMode: parseRetrievalMode(record.retrieval_mode, endpoint),
		statusPath: requireString(record, "status", endpoint),
		cancelPath: requireString(record, "cancel", endpoint),
	};
}

function parseRetrievalModeStatus(
	value: AppResponseValue
): RetrievalModeStatus {
	const endpoint = "retrieval-mode status";
	const record = requireRecord(value, endpoint);
	const base: RetrievalModeStatusBase = {
		jobId: requireString(record, "job_id", endpoint),
		spaceId: requireString(record, "space_id", endpoint),
		requestedMode: parseRetrievalMode(record.requested_mode, endpoint),
		previousMode: parseNullableMode(record.previous_mode, endpoint),
		totalChunks: requireCount(record, "total_chunks", endpoint),
		processedChunks: requireCount(record, "processed_chunks", endpoint),
		graphNodes: requireCount(record, "graph_nodes", endpoint),
		graphEdges: requireCount(record, "graph_edges", endpoint),
	};
	if (base.processedChunks > base.totalChunks) {
		throw invalidResponse(endpoint);
	}
	const state = record.state;
	if (state === "running" || state === "cancelling") {
		if (record.change !== null || record.error !== null) {
			throw invalidResponse(endpoint);
		}
		return { ...base, state, change: null, error: null };
	}
	if (state === "completed") {
		if (record.error !== null || base.previousMode === null) {
			throw invalidResponse(endpoint);
		}
		const change = parseRetrievalModeChange(record.change, endpoint);
		if (
			base.processedChunks !== base.totalChunks ||
			change.previous !== base.previousMode ||
			change.mode !== base.requestedMode ||
			change.changed !== (change.previous !== change.mode) ||
			change.graphRebuilt !== (change.mode === "graph") ||
			change.chunksScanned !== base.processedChunks ||
			change.graphNodes !== base.graphNodes ||
			change.graphEdges !== base.graphEdges
		) {
			throw invalidResponse(endpoint);
		}
		return {
			...base,
			state,
			change,
			error: null,
		};
	}
	if (state === "cancelled") {
		if (record.change !== null || record.error !== null) {
			throw invalidResponse(endpoint);
		}
		return {
			...base,
			state,
			change: null,
			error: null,
		};
	}
	if (state === "failed") {
		if (
			record.change !== null ||
			!spaceString.safeParse(record.error).success ||
			spaceString.parse(record.error).trim() === ""
		) {
			throw invalidResponse(endpoint);
		}
		return {
			...base,
			state,
			change: null,
			error: spaceString.parse(record.error),
		};
	}
	throw invalidResponse(endpoint);
}

function parseRetrievalModeCancellation(
	value: AppResponseValue
): RetrievalModeCancellation {
	const endpoint = "retrieval-mode cancellation";
	const record = requireRecord(value, endpoint);
	return { cancelled: requireBoolean(record, "cancelled", endpoint) };
}

/** List all Spaces, most-recently-updated first. */
export async function fetchSpaces(target: ApiTarget): Promise<Space[]> {
	const json = requireRecord(
		await request(target, "/api/spaces", {}, appResponseValueSchema),
		"spaces list"
	);
	if (!Array.isArray(json.spaces)) {
		throw invalidResponse("spaces list");
	}
	return spaceRows.parse(json.spaces).map(toSpace);
}

interface CreateSpaceBody {
	description: Parameters<typeof createSpace>[2];
	name: Parameters<typeof createSpace>[1];
	retrieval_mode?: Parameters<typeof createSpace>[3];
}

/** Create a new Space and return its id. */
export async function createSpace(
	target: ApiTarget,
	name: string,
	description: string | null,
	retrievalMode?: RetrievalMode
): Promise<string> {
	const body: CreateSpaceBody = { name, description };
	if (retrievalMode !== undefined) {
		body.retrieval_mode = retrievalMode;
	}
	const json = requireRecord(
		await request(
			target,
			"/api/spaces",
			{
				method: "POST",
				body,
			},
			appResponseValueSchema
		),
		"create-space"
	);
	return requireString(json, "id", "create-space");
}

/** Start a retrieval-mode rebuild. Core accepts this operation with HTTP 202. */
export async function startSpaceRetrievalModeChange(
	target: ApiTarget,
	id: string,
	mode: RetrievalMode
): Promise<RetrievalModeJob> {
	const json = await request(
		target,
		`/api/spaces/${encodeURIComponent(id)}/retrieval-mode`,
		{ method: "POST", body: { retrieval_mode: mode } },
		appResponseValueSchema
	);
	const job = parseRetrievalModeJob(json);
	if (job.spaceId !== id || job.retrievalMode !== mode) {
		throw invalidResponse("retrieval-mode job");
	}
	return {
		...job,
		statusPath: `/api/spaces/${encodePathId(id)}/retrieval-mode/status?job_id=${encodeURIComponent(job.jobId)}`,
		cancelPath: `/api/spaces/${encodePathId(id)}/retrieval-mode/cancel`,
	};
}

/** Read the latest progress or terminal outcome for a mode-change job. */
export async function fetchSpaceRetrievalModeStatus(
	target: ApiTarget,
	id: string,
	jobId: string
): Promise<RetrievalModeStatus> {
	const json = await request(
		target,
		`/api/spaces/${encodeURIComponent(id)}/retrieval-mode/status?job_id=${encodeURIComponent(jobId)}`,
		{},
		appResponseValueSchema
	);
	const status = parseRetrievalModeStatus(json);
	if (status.spaceId !== id || status.jobId !== jobId) {
		throw invalidResponse("retrieval-mode status");
	}
	return status;
}

/** Request cooperative cancellation of a mode-change job. */
export async function cancelSpaceRetrievalModeChange(
	target: ApiTarget,
	id: string,
	jobId: string
): Promise<RetrievalModeCancellation> {
	const json = await request(
		target,
		`/api/spaces/${encodeURIComponent(id)}/retrieval-mode/cancel`,
		{ method: "POST", body: { job_id: jobId } },
		appResponseValueSchema
	);
	return parseRetrievalModeCancellation(json);
}

/** Delete a Space and everything in it. Returns whether a row was removed. */
export async function deleteSpace(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const json = await request(
		target,
		`/api/spaces/${encodePathId(id)}`,
		{
			method: "DELETE",
		},
		spaceDeletedResponse
	);
	return json?.removed ?? false;
}

/** Set or clear a Space glyph (`POST /api/spaces/:id/icon`). */
export async function setSpaceIcon(
	target: ApiTarget,
	id: string,
	icon: unknown | null
): Promise<void> {
	await request(
		target,
		`/api/spaces/${encodePathId(id)}/icon`,
		{
			method: "POST",
			body: { icon },
		},
		appResponseValueSchema
	);
}
