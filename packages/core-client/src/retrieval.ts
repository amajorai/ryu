// apps/desktop/src/lib/api/retrieval.ts
//
// Typed client for Core's retrieval surface (`/api/retrieval/{search,index}`).
// Retrieval merges short/long-term memory (U11) with Space document chunks (U17)
// behind a single similarity search, so the Desktop Memory view (DA6) can browse
// what Core can ground an answer on. Built on the shared node-aware `request`
// helper so bearer auth + base URL come from the active node, never hardcoded.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";
import {
	expansionWire,
	hybridWire,
	type QueryExpansionInput,
	type RetrievalFilter,
} from "./space-retrieval.ts";
import { spaceRowFields } from "./spaces.ts";

/** Where a retrieved chunk originated. Mirrors Core's `ChunkSource` (snake_case). */
export type ChunkSource = "memory" | "space";

/** A retrieved chunk paired with its relevance score (higher is more relevant). */
export interface ScoredChunk {
	content: string;
	id: string;
	score: number;
	source: ChunkSource;
	/** Space identifier when `source === 'space'`; `null` for memory. */
	spaceId: string | null;
}

export interface RetrievalSearchInput extends QueryExpansionInput {
	/** Optional exact agent scope for agent-level memory facts. */
	agentId?: string;
	/**
	 * Metadata predicate every chunk must satisfy. Matched against a chunk's
	 * indexed `metadata` plus `source`, `space_id`, `scope`, `agent_id`, and
	 * `importance`; inside delegated Spaces, against the chunk's document fields.
	 */
	filter?: RetrievalFilter;
	/** Hybrid BM25 + vector fusion inside the Spaces searched. */
	hybrid?: boolean | { alpha?: number };
	/** Whether to include memory in the search (defaults to true on Core). */
	includeMemory?: boolean;
	/** Drop chunks scoring below this threshold (0 keeps everything). */
	minScore?: number;
	query: string;
	/**
	 * Which Spaces to search. `undefined` searches all Spaces; an empty array
	 * searches no Spaces (memory only).
	 */
	spaceIds?: string[];
	/** Max chunks to return after ranking. Core defaults to 5 when omitted. */
	topK?: number;
}

function retrievalResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
// Full native ScoredChunk; Core's embeddings/reranker admission refuses non-finite
// scores, while memory graph/rank fusion produce bounded finite scores.
export const retrievalChunkResponseSchema = retrievalResponse(
	z.object({
		content: z.string(),
		id: z.string(),
		score: z.number(),
		source: z.enum(["memory", "space"]),
		space_id: z.string().nullish(),
	})
);
const retrievalSearchResponseSchema = retrievalResponse(
	z.object({
		chunks: z.array(retrievalChunkResponseSchema).nullish(),
		queries: z.array(z.string()).nullish(),
		hypothetical_document: z.string().nullish(),
		warning: z.string().nullish(),
	})
);

/** A retrieval search result plus what query expansion did. */
export interface RetrievalSearchResult {
	chunks: ScoredChunk[];
	/** The HyDE passage that was searched, when requested and produced. */
	hypotheticalDocument: string | null;
	/** The original query followed by its rewrites, when multi-query ran. */
	queries: string[] | null;
	/** Why an expansion was skipped (it fails open to the original query). */
	warning: string | null;
}
const retrievalIndexResponseSchema = retrievalResponse(
	z.object({ success: z.boolean().optional(), id: z.string().optional() })
);
// The /spaces publisher returns the full native Space, not just summary fields.
// Preserve documented older omissions of additive retrieval/sharing metadata.
export const retrievalSpaceResponseSchema = retrievalResponse(spaceRowFields);
const retrievalSpacesResponseSchema = retrievalResponse(
	z.object({ spaces: z.array(retrievalSpaceResponseSchema).nullish() })
);

/**
 * Search across memory + Spaces, returning scored chunks ranked by relevance.
 * Throws (via {@link request}) when Core is unreachable so callers can degrade.
 */
export async function searchRetrieval(
	target: ApiTarget,
	input: RetrievalSearchInput
): Promise<ScoredChunk[]> {
	return (await searchRetrievalDetailed(target, input)).chunks;
}

/**
 * {@link searchRetrieval} that also reports the expansion queries, the HyDE
 * passage, and any expansion warning.
 */
export async function searchRetrievalDetailed(
	target: ApiTarget,
	input: RetrievalSearchInput
): Promise<RetrievalSearchResult> {
	const json = await request(
		target,
		"/api/retrieval/search",
		{
			method: "POST",
			body: {
				query: input.query,
				agent_id: input.agentId,
				top_k: input.topK,
				space_ids: input.spaceIds,
				include_memory: input.includeMemory,
				min_score: input.minScore,
				filter: input.filter,
				hybrid: hybridWire(input.hybrid),
				...expansionWire(input),
			},
		},
		retrievalSearchResponseSchema
	);
	return {
		chunks: (json.chunks ?? []).map((c) => ({
			id: c.id,
			source: c.source,
			spaceId: c.space_id ?? null,
			content: c.content,
			score: c.score,
		})),
		queries: json.queries ?? null,
		hypotheticalDocument: json.hypothetical_document ?? null,
		warning: json.warning ?? null,
	};
}

export interface IndexChunkInput {
	content: string;
	/** Stable identifier; re-indexing the same id replaces the prior chunk or memory. */
	id: string;
	/**
	 * Filterable JSON object (Space chunks only, at most 16 KiB serialized) that a
	 * search `filter` can match. Re-indexing without it clears it.
	 */
	metadata?: Record<string, unknown>;
	/** Defaults to encrypted durable memory; pass "space" with a `spaceId` to attach to a Space. */
	source?: ChunkSource;
	spaceId?: string;
}

/**
 * Index a single chunk into encrypted memory (or a Space) so future searches can
 * recall it. Reusing the same id is an idempotent replacement. Use the dedicated
 * Memory API when explicit classification metadata is needed.
 */
export async function indexChunk(
	target: ApiTarget,
	input: IndexChunkInput
): Promise<string> {
	const json = await request(
		target,
		"/api/retrieval/index",
		{
			method: "POST",
			body: {
				id: input.id,
				content: input.content,
				source: input.source ?? "memory",
				space_id: input.spaceId,
				metadata: input.metadata,
			},
		},
		retrievalIndexResponseSchema
	);
	return json.id ?? input.id;
}

/** A knowledge Space, used to scope retrieval search. Mirrors Core's `Space`. */
export interface SpaceSummary {
	id: string;
	name: string;
}

/** List Spaces (id + name) so the Memory view can offer them as search scopes. */
export async function listSpaceSummaries(
	target: ApiTarget
): Promise<SpaceSummary[]> {
	const json = await request(
		target,
		"/api/spaces",
		{},
		retrievalSpacesResponseSchema
	);
	return (json.spaces ?? []).map((s) => ({ id: s.id, name: s.name }));
}
