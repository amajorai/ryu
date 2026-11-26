// packages/core-client/src/spaces-search.ts
//
// Embedding reindex, the embedding model and Space search, split out of
// spaces.ts, which re-exports them. The space id goes into the search path
// through encodePathId (Core's own route, not a mount).

import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";
import { encodePathId } from "./path-id.ts";
import {
	type SpaceMatch,
	spaceEmbeddingResponse,
	spaceReindexResponse,
	spaceSearchResponse,
	toMatch,
} from "./spaces-types.ts";

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
		`/api/spaces/${encodePathId(spaceId)}/search`,
		{ method: "POST", body },
		spaceSearchResponse
	);
	return (json.matches ?? []).map(toMatch);
}
