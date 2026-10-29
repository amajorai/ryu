// packages/core-client/src/spaces.ts
//
// Typed client for Core's Spaces / RAG endpoints (`/api/spaces`). A Space is a
// named document collection backed by a sqlite-vec vector store; documents are
// ingested (chunked + embedded) and searched by whichever retrieval algorithm
// the Space is set to — vector KNN or entity-graph traversal — after which hits
// are link-expanded and neurally reranked. See {@link searchSpace}. Wire shapes
// mirror the Core handlers in `apps/core/src/server/{mod,spaces}.rs`
// (snake_case on the wire).

import { z } from "zod";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

const spaceString = z.string();
const spaceNumber = z.number();
const spaceBoolean = z.boolean();
export const spaceRowFields = z.looseObject({
	created_at: spaceNumber,
	description: spaceString.nullable().optional(),
	// Preserve the legacy missing-count response: the UI intentionally omits its badge.
	document_count: spaceNumber.optional(),
	icon: appResponseValueSchema.optional(),
	id: spaceString,
	name: spaceString,
	retrieval_mode: spaceString.optional(),
	updated_at: spaceNumber,
	system: spaceBoolean.optional(),
	visibility: spaceString.optional(),
	team_id: spaceString.nullable().optional(),
});
const spaceRows = z.array(spaceRowFields);

const spaceJsonObject = z.record(
	z.string(),
	appResponseValueSchema.nonoptional()
);

// Parse the native fields and retain forward-compatible metadata. Optional legacy
// fields continue to use the existing defaults in the public projections.
const spaceDocumentFields = z.looseObject({
	id: spaceString,
	space_id: spaceString,
	title: spaceString,
	created_at: spaceNumber,
	updated_at: spaceNumber.optional(),
	chunk_count: spaceNumber,
	kind: spaceString.optional(),
	parent_id: spaceString.nullish(),
	mime: spaceString.nullish(),
	byte_size: spaceNumber.nullish(),
	icon: appResponseValueSchema.optional(),
	index: appResponseValueSchema.optional(),
});
const spaceDocumentsResponse = z.looseObject({
	space_id: spaceString.optional(),
	documents: z.array(spaceDocumentFields).nullish(),
});
const spaceDocumentContentResponse = z.looseObject({
	id: spaceString,
	space_id: spaceString,
	title: spaceString,
	source: spaceString,
	created_at: spaceNumber,
	updated_at: spaceNumber,
	revision: spaceNumber.optional(),
	chunk_count: spaceNumber,
	kind: spaceString.optional(),
	parent_id: spaceString.nullish(),
	icon: appResponseValueSchema.optional(),
});
const spaceDeletedResponse = z
	.object({ success: spaceBoolean.optional(), removed: spaceBoolean.nullish() })
	.nullish();
const spaceIngestResponse = z.looseObject({ document_id: spaceString });
const spacePageResponse = z.looseObject({ id: spaceString });
const spaceReindexResponse = z.looseObject({
	current_model: spaceString,
	current_dims: spaceNumber,
	total_chunks: spaceNumber,
	pending_chunks: spaceNumber,
	running: spaceBoolean,
	errored: spaceString.nullish(),
});
// The current native publisher has model_id and dims. base_url is retained
// only when supplied by an older/custom response; no URL is synthesized.
const spaceEmbeddingResponse = z.looseObject({
	model_id: spaceString,
	dims: spaceNumber,
	base_url: spaceString.optional(),
});
const spaceMatchFields = z.looseObject({
	chunk_id: spaceString,
	document_id: spaceString,
	content: spaceString,
	distance: spaceNumber.nullable(),
});
export const spaceSearchResponse = z.looseObject({
	space_id: spaceString.optional(),
	matches: z.array(spaceMatchFields).nullish(),
});

/** The retrieval algorithm Core uses for a Space. */
export type RetrievalMode = "graph" | "vector";

/** A named document collection. `documentCount` is computed by Core. */
export interface Space {
	/** Unix milliseconds. */
	createdAt: number;
	description: string | null;
	documentCount: number | undefined;
	/** Notion-style glyph JSON (GlyphValue), when set. */
	icon: unknown | null;
	id: string;
	name: string;
	retrievalMode: RetrievalMode;
	/** Unix milliseconds. */
	updatedAt: number;
}

/** A document inside a Space, with its chunk count. */
export interface SpaceDocument {
	chunkCount: number;
	/** Unix milliseconds. */
	createdAt: number;
	/** Notion-style glyph JSON (GlyphValue), when set. */
	icon: unknown | null;
	id: string;
	spaceId: string;
	title: string;
	/** Unix milliseconds. */
	updatedAt: number;
}

/** A single ranked chunk returned from a Space search. */
export interface SpaceMatch {
	chunkId: string;
	content: string;
	/**
	 * **Do not rank on this field, and do not read magnitudes off it.** It used to
	 * be documented as "squared L2 distance from the query vector", which is only
	 * ever true of one of the three ways a chunk can end up in this array:
	 *
	 * - a vector-mode KNN hit carries its real `vec0` distance (smaller is closer);
	 * - a graph-mode traversal hit is assigned the constant `0.0`;
	 * - a chunk pulled in by `[[page]]`-link expansion (which runs in **both**
	 *   modes) is assigned the constant `1.0`.
	 *
	 * The last two are placeholders, not measurements. On top of that Core's bge
	 * reranker re-orders the survivors **without rewriting `distance`**, so array
	 * order — not this number — is the ranking. Sorting by `distance` un-does the
	 * rerank; averaging or thresholding it mixes a metric with two constants.
	 * Native JSON serialization emits null for a non-finite Rust distance.
	 */
	distance: number | null;
	documentId: string;
}

interface SpaceWire {
	created_at: number;
	description?: string | null;
	document_count?: number;
	icon?: unknown | null;
	id: string;
	name: string;
	retrieval_mode?: string;
	updated_at: number;
}

type DocumentWire = z.output<typeof spaceDocumentFields>;

type MatchWire = z.output<typeof spaceMatchFields>;

export interface RetrievalModeChange {
	changed: boolean;
	chunksScanned: number;
	graphEdges: number;
	graphNodes: number;
	graphRebuilt: boolean;
	mode: RetrievalMode;
	previous: RetrievalMode;
}

export interface RetrievalModeJob {
	cancelPath: string;
	jobId: string;
	retrievalMode: RetrievalMode;
	spaceId: string;
	statusPath: string;
}

interface RetrievalModeStatusBase {
	graphEdges: number;
	graphNodes: number;
	jobId: string;
	previousMode: RetrievalMode | null;
	processedChunks: number;
	requestedMode: RetrievalMode;
	spaceId: string;
	totalChunks: number;
}

export type RetrievalModeStatus =
	| (RetrievalModeStatusBase & {
			change: null;
			error: null;
			state: "cancelling" | "running";
	  })
	| (RetrievalModeStatusBase & {
			change: RetrievalModeChange;
			error: null;
			state: "completed";
	  })
	| (RetrievalModeStatusBase & {
			change: null;
			error: string | null;
			state: "cancelled";
	  })
	| (RetrievalModeStatusBase & {
			change: null;
			error: string;
			state: "failed";
	  });

export interface RetrievalModeCancellation {
	cancelled: boolean;
}

function toSpace(s: SpaceWire): Space {
	return {
		id: s.id,
		name: s.name,
		description: s.description ?? null,
		createdAt: s.created_at,
		updatedAt: s.updated_at,
		documentCount: s.document_count,
		icon: s.icon ?? null,
		retrievalMode: toRetrievalMode(s.retrieval_mode),
	};
}

function toDocument(d: DocumentWire): SpaceDocument {
	return {
		id: d.id,
		spaceId: d.space_id,
		title: d.title,
		createdAt: d.created_at,
		updatedAt: d.updated_at ?? d.created_at,
		chunkCount: d.chunk_count,
		icon: d.icon ?? null,
	};
}

function toMatch(m: MatchWire): SpaceMatch {
	return {
		chunkId: m.chunk_id,
		documentId: m.document_id,
		content: m.content,
		distance: m.distance,
	};
}

function isRecord(
	value: AppResponseValue
): value is z.output<typeof spaceJsonObject> {
	return spaceJsonObject.safeParse(value).success;
}

function invalidResponse(endpoint: string): Error {
	return new Error(`Core returned an invalid ${endpoint} response`);
}

function requireRecord(
	value: AppResponseValue,
	endpoint: string
): Record<string, AppResponseValue> {
	if (!isRecord(value)) {
		throw invalidResponse(endpoint);
	}
	return value;
}

function requireString(
	record: Record<string, AppResponseValue>,
	key: string,
	endpoint: string
): string {
	const value = record[key];
	const parsed = spaceString.safeParse(value);
	if (!parsed.success || parsed.data.trim() === "") {
		throw invalidResponse(endpoint);
	}
	return parsed.data;
}

function requireCount(
	record: Record<string, AppResponseValue>,
	key: string,
	endpoint: string
): number {
	const value = record[key];
	const parsed = spaceNumber.safeParse(value);
	if (
		!(parsed.success && Number.isSafeInteger(parsed.data)) ||
		parsed.data < 0
	) {
		throw invalidResponse(endpoint);
	}
	return parsed.data;
}

function requireBoolean(
	record: Record<string, AppResponseValue>,
	key: string,
	endpoint: string
): boolean {
	const value = record[key];
	const parsed = spaceBoolean.safeParse(value);
	if (!parsed.success) {
		throw invalidResponse(endpoint);
	}
	return parsed.data;
}

function parseRetrievalMode(
	value: AppResponseValue,
	endpoint: string
): RetrievalMode {
	if (value === "graph" || value === "vector") {
		return value;
	}
	throw invalidResponse(endpoint);
}

function toRetrievalMode(value: AppResponseValue): RetrievalMode {
	if (value === undefined) {
		return "vector";
	}
	return parseRetrievalMode(value, "space");
}

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
interface EmbeddingModelBody {
	base_url?: Parameters<typeof setEmbeddingModel>[2];
	dims?: Parameters<typeof setEmbeddingModel>[3];
	model_id: Parameters<typeof setEmbeddingModel>[1];
	provider?: Parameters<typeof setEmbeddingModel>[4];
}
interface SearchSpaceBody {
	limit?: Parameters<typeof searchSpace>[3];
	query: Parameters<typeof searchSpace>[2];
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
	const encodedId = encodeURIComponent(id);
	if (job.spaceId !== id || job.retrievalMode !== mode) {
		throw invalidResponse("retrieval-mode job");
	}
	return {
		...job,
		statusPath: `/api/spaces/${encodedId}/retrieval-mode/status?job_id=${encodeURIComponent(job.jobId)}`,
		cancelPath: `/api/spaces/${encodedId}/retrieval-mode/cancel`,
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
		`/api/spaces/${id}`,
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
		`/api/spaces/${id}/icon`,
		{
			method: "POST",
			body: { icon },
		},
		appResponseValueSchema
	);
}

/** Set or clear a document glyph without re-embedding. */
export async function setDocumentIcon(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	icon: unknown | null
): Promise<void> {
	await request(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/icon`,
		{
			method: "POST",
			body: { icon },
		},
		appResponseValueSchema
	);
}

/** List the documents in a Space. */
export async function fetchDocuments(
	target: ApiTarget,
	spaceId: string
): Promise<SpaceDocument[]> {
	const json = await request(
		target,
		`/api/spaces/${spaceId}/documents`,
		{},
		spaceDocumentsResponse
	);
	return (json.documents ?? []).map(toDocument);
}

/** Ingest a document into a Space. Returns the new document id. */
export async function ingestDocument(
	target: ApiTarget,
	spaceId: string,
	title: string,
	content: string
): Promise<string> {
	const json = await request(
		target,
		`/api/spaces/${spaceId}/documents`,
		{
			method: "POST",
			body: { title, content },
		},
		spaceIngestResponse
	);
	return json.document_id;
}

/** Full editable content of a document (Notion-like page). */
export interface SpaceDocumentContent {
	chunkCount: number;
	/** Unix milliseconds. */
	createdAt: number;
	/** Notion-style glyph JSON (GlyphValue), when set. */
	icon: unknown | null;
	id: string;
	/** Canonical markdown source of the page. */
	source: string;
	spaceId: string;
	title: string;
	/** Unix milliseconds. */
	updatedAt: number;
}

type DocumentContentWire = z.output<typeof spaceDocumentContentResponse>;

function toDocumentContent(d: DocumentContentWire): SpaceDocumentContent {
	return {
		id: d.id,
		spaceId: d.space_id,
		title: d.title,
		source: d.source,
		createdAt: d.created_at,
		updatedAt: d.updated_at,
		chunkCount: d.chunk_count,
		icon: d.icon ?? null,
	};
}

/** Create a new blank markdown page in a Space. Returns the new document id. */
export async function createPage(
	target: ApiTarget,
	spaceId: string,
	title: string
): Promise<string> {
	const json = await request(
		target,
		`/api/spaces/${spaceId}/pages`,
		{ method: "POST", body: { title } },
		spacePageResponse
	);
	return json.id;
}

/** Fetch a single document's full markdown source for editing. */
export async function fetchDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<SpaceDocumentContent> {
	const json = await request(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}`,
		{},
		spaceDocumentContentResponse
	);
	return toDocumentContent(json);
}

/**
 * Save a document's markdown source. Core re-chunks + re-embeds on save, so this
 * is the persistence + index trigger. Callers should debounce.
 */
export async function updateDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	title: string,
	source: string
): Promise<void> {
	await request(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}`,
		{
			method: "PUT",
			body: { title, source },
		},
		appResponseValueSchema
	);
}

/** Delete a single document (page) and its chunks/vectors. */
export async function deleteDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<boolean> {
	const json = await request(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}`,
		{ method: "DELETE" },
		spaceDeletedResponse
	);
	return json?.removed ?? false;
}

/** Reindex progress reported by Core. */
export interface ReindexStatus {
	currentDims: number;
	currentModel: string;
	pendingChunks: number;
	running: boolean;
	totalChunks: number;
}

/** Get the current embedding-reindex status (how many chunks are stale). */
export async function fetchReindexStatus(
	target: ApiTarget
): Promise<ReindexStatus> {
	const json = await request(
		target,
		"/api/embeddings/reindex/status",
		{},
		spaceReindexResponse
	);
	return {
		currentModel: json.current_model,
		currentDims: json.current_dims,
		totalChunks: json.total_chunks,
		pendingChunks: json.pending_chunks,
		running: json.running,
	};
}

/** Kick off a background reindex of all stale chunks. Returns immediately. */
export async function triggerReindex(target: ApiTarget): Promise<void> {
	await request(
		target,
		"/api/embeddings/reindex",
		{ method: "POST" },
		appResponseValueSchema
	);
}

/** The embedding model Spaces currently uses. */
export interface EmbeddingModel {
	baseUrl: string | undefined;
	dims: number;
	modelId: string;
}

/** Read the active embedding model. */
export async function fetchEmbeddingModel(
	target: ApiTarget
): Promise<EmbeddingModel> {
	const json = await request(
		target,
		"/api/embeddings/model",
		{},
		spaceEmbeddingResponse
	);
	return { modelId: json.model_id, baseUrl: json.base_url, dims: json.dims };
}

/**
 * Change the default embedding model. Core persists it and auto-triggers a
 * background reindex of every existing chunk (old vectors live in an
 * incomparable space and must be re-embedded).
 */
export async function setEmbeddingModel(
	target: ApiTarget,
	modelId: string,
	baseUrl?: string,
	dims?: number,
	provider?: string
): Promise<void> {
	const body: EmbeddingModelBody = { model_id: modelId };
	if (baseUrl !== undefined) {
		body.base_url = baseUrl;
	}
	if (dims !== undefined) {
		body.dims = dims;
	}
	if (provider !== undefined) {
		body.provider = provider;
	}
	await request(
		target,
		"/api/embeddings/model",
		{ method: "POST", body },
		appResponseValueSchema
	);
}

/**
 * Search a single Space, returning ranked chunk matches.
 *
 * **Not necessarily a KNN search** — as this comment used to say. Core's
 * `search_ext` (`crates/core/spaces/src/lib.rs`) reads the Space's stored
 * `retrieval_mode` and branches: `vector` runs a nearest-neighbour search over
 * the `vec0` index, `graph` runs entity-matching plus a BFS traversal of the
 * Space's co-occurrence graph. A graph Space can therefore answer a multi-hop
 * question ("who at Acme is in Paris") that no single nearest-neighbour lookup
 * answers. Anything that describes this call to a user — or to a model, via an
 * MCP tool description — must not promise vector semantics.
 *
 * **The graph branch is bounded, and the bounds are lossy.** It walks at most 3
 * hops and caps each hop's frontier at 512 entities, because the edges are
 * co-occurrence (every pair of entities in a chunk is joined), so an unbounded
 * hop-2 frontier is most of the Space. Core's own doc states that a chunk whose
 * only path runs through a truncated frontier entity stops being reachable, and
 * traversal also stops as soon as `limit` chunks are collected. Graph results
 * are therefore neither a superset of vector results nor exhaustive: never
 * present an empty result as "this Space contains nothing about X".
 *
 * **Both branches are then post-processed**, so the returned chunks are not only
 * the retrieval hits: `[[page]]`-link expansion pulls in chunks from linked
 * documents (fail-open), a tenancy filter drops documents the caller may not
 * read, and a bge cross-encoder reranker re-orders what survives. See
 * {@link SpaceMatch.distance} for what that does to the score field.
 */
export async function searchSpace(
	target: ApiTarget,
	spaceId: string,
	query: string,
	limit?: number
): Promise<SpaceMatch[]> {
	const body: SearchSpaceBody = { query };
	if (limit !== undefined) {
		body.limit = limit;
	}
	const json = await request(
		target,
		`/api/spaces/${spaceId}/search`,
		{ method: "POST", body },
		spaceSearchResponse
	);
	return (json.matches ?? []).map(toMatch);
}
