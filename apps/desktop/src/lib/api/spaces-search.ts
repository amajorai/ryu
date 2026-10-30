import { spaceDatabaseQueryResultSchema } from "@ryu/app-host/rpc";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import { type ApiTarget, request } from "./client.ts";
import { encodePathId } from "./path-id.ts";
import {
	embeddingModelWireResponseCodec,
	reindexStatusWireResponseCodec,
	responseCodec18,
	responseCodec19,
	responseCodec20,
} from "./spaces-response-codecs.ts";
import type {
	SpaceDatabaseQueryResult,
	SpaceDatabaseQueryValue,
	SpaceMatch,
} from "./spaces-types.ts";
import {
	databaseQueryColumnSchema,
	databaseQueryEnvelopeSchema,
} from "./spaces-wire-contracts.ts";
import type {
	EmbeddingModelWireRequest,
	MatchWire,
	SpaceSearchWireRequest,
} from "./spaces-wire-types.ts";

// apps/desktop/src/lib/api/spaces-search.ts
//
// Space search, database queries, and the embedding model / reindex controls. Split out of `spaces.ts`, which re-exports
// everything public here so its import path stays stable.

function toMatch(m: MatchWire): SpaceMatch {
	return {
		chunkId: m.chunk_id,
		documentId: m.document_id,
		content: m.content,
		distance: m.distance,
	};
}

/** Reindex progress reported by Core. */
export interface ReindexStatus {
	currentDims: number;
	currentModel: string;
	pendingChunks: number;
	running: boolean;
	totalChunks: number;
}

interface ReindexStatusWire {
	current_dims: number;
	current_model: string;
	pending_chunks: number;
	running: boolean;
	total_chunks: number;
}

/** Get the current embedding-reindex status (how many chunks are stale). */
export async function fetchReindexStatus(
	target: ApiTarget
): Promise<ReindexStatus> {
	const json = await request<ReindexStatusWire>(
		target,
		"/api/embeddings/reindex/status",
		undefined,
		reindexStatusWireResponseCodec
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
		responseCodec18
	);
}

/** The embedding model Spaces currently uses. */
export interface EmbeddingModel {
	/** Not published by Core's native `GET /api/embeddings/model` today. */
	baseUrl?: string;
	dims: number;
	modelId: string;
}

// Core's native publisher (`EmbeddingModelInfo`) sends only model_id and dims;
// base_url stays optional so a publisher that adds it is still read.
interface EmbeddingModelWire {
	base_url?: string;
	dims: number;
	model_id: string;
}

/** Read the active embedding model. */
export async function fetchEmbeddingModel(
	target: ApiTarget
): Promise<EmbeddingModel> {
	const json = await request<EmbeddingModelWire>(
		target,
		"/api/embeddings/model",
		undefined,
		embeddingModelWireResponseCodec
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
	const body: EmbeddingModelWireRequest = { model_id: modelId };
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
		responseCodec19
	);
}

/**
 * Search a single Space, returning ranked chunk matches.
 *
 * This is the one call whose algorithm {@link Space.retrievalMode} selects: Core's
 * `search_ext` reads the column and branches to `vector_search` (nearest-neighbour
 * over the `vec0` index) or `graph_search` (entity match + BFS traversal), then
 * reranks. Calling this "a KNN search" — as this comment did — was simply wrong for
 * every graph Space, and it was the only doc a reader had for where the mode takes
 * effect.
 *
 * The metric is named "nearest-neighbour", not "cosine", on purpose: the Rust
 * comments say cosine KNN, but the table is declared `vec0(rowid INTEGER PRIMARY
 * KEY, embedding float[N])` with no `distance_metric=`, and nothing in the crate
 * normalizes the vectors. Rather than copy a metric name none of us has seen
 * assigned, this says only what the code shows — smaller is closer.
 *
 * **The graph branch is a *bounded* traversal, and the bounds are lossy.** Do not
 * describe it to a user as "follows the connections", full stop. `graph_search`
 * walks at most 3 hops and caps each hop's frontier at `MAX_FRONTIER_ENTITIES`
 * (512), because edges are co-occurrence — every pair of entities in a chunk is
 * joined — so an unbounded hop-2 frontier is most of the Space. The cap is not
 * merely a speed guard: Core's own doc states that a chunk whose only path runs
 * through a truncated frontier entity **stops being reachable**. It also stops as
 * soon as `limit` chunks are collected, so results depend on traversal order.
 *
 * Practical consequence for anything built on this: graph results are not a
 * superset of vector results and are not exhaustive. A caller must not present an
 * empty graph result as "this space contains nothing about X".
 */
export async function searchSpace(
	target: ApiTarget,
	spaceId: string,
	query: string,
	limit?: number
): Promise<SpaceMatch[]> {
	const body: SpaceSearchWireRequest = { query };
	if (limit !== undefined) {
		body.limit = limit;
	}
	const json = await request<{ matches?: MatchWire[] }>(
		target,
		`/api/spaces/${encodePathId(spaceId)}/search`,
		{ method: "POST", body },
		responseCodec20
	);
	return (json.matches ?? []).map(toMatch);
}

/** Run one read-only SQL query against the selected Space database document. */
export async function querySpaceDatabase(
	target: ApiTarget,
	spaceId: string,
	databaseId: string,
	query: string,
	parameters: SpaceDatabaseQueryValue[] = []
): Promise<SpaceDatabaseQueryResult> {
	const result = await request<unknown>(
		target,
		`/api/spaces/${encodeURIComponent(spaceId)}/databases/${encodeURIComponent(databaseId)}/query`,
		{ method: "POST", body: { query, parameters } },
		gatewayJsonValueSchema
	);
	const parsed = databaseQueryEnvelopeSchema.safeParse(result);
	if (!parsed.success) {
		throw new Error("Core returned an invalid database query response");
	}
	const schema = parsed.data.schema.map((candidate) => {
		const column = databaseQueryColumnSchema.safeParse(candidate);
		if (!column.success) {
			throw new Error("Core returned an invalid database query schema");
		}
		return column.data;
	});
	const validated = spaceDatabaseQueryResultSchema.safeParse(result);
	if (!validated.success) {
		throw new Error("Core returned an invalid database query response");
	}
	return {
		columns: validated.data.columns.slice(),
		rows: validated.data.rows.map((row) => row.slice()),
		schema,
		truncated: validated.data.truncated,
	};
}
