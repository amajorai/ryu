// packages/core-client/src/space-retrieval.ts
//
// Typed client for Core's advanced Space retrieval: per-Space chunking
// strategies (`/api/spaces/:id/chunking`) and the full search options of
// `POST /api/spaces/:id/search` — hybrid BM25 + vector fusion, metadata
// filters, parent-document (small-to-big) expansion, and multi-query / HyDE
// query expansion. Wire shapes mirror `apps/core/src/server/mod.rs`
// (snake_case on the wire); `searchSpace` in `spaces.ts` remains the plain call.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

/** A Space chunking strategy. Same JSON as `ChunkingStrategy` in `@ryuhq/sdk/rag`. */
export type SpaceChunkingStrategy =
	| { strategy: "default" }
	| {
			strategy: "recursive";
			chunk_size?: number;
			chunk_overlap?: number;
			separators?: string[];
	  }
	| {
			strategy: "markdown";
			chunk_size?: number;
			chunk_overlap?: number;
			include_header_path?: boolean;
	  }
	| { strategy: "token"; chunk_size?: number; chunk_overlap?: number }
	| {
			strategy: "semantic";
			breakpoint_percentile?: number;
			buffer_size?: number;
			max_chunk_size?: number;
	  };

/**
 * A metadata filter in Core's filter language (`$eq`, `$ne`, `$in`, `$nin`,
 * `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$and`, `$or`, `$not`). Validate it
 * locally with `validateFilter` from `@ryuhq/sdk/rag`; Core answers 400 to an
 * invalid one.
 */
export type RetrievalFilter = Record<string, unknown>;

/** Small-to-big expansion of each hit. */
export type ParentExpansion =
	| { mode: "window"; window?: number }
	| { mode: "document"; max_chars?: number };

/** Query expansion knobs shared by both retrieval routes. */
export interface QueryExpansionInput {
	/** Model for the rewrite calls (else the `retrieval-expansion-model` preference). */
	expansionModel?: string;
	/** Also search with a hypothetical answer passage (HyDE). */
	hyde?: boolean;
	/** Number of alternative phrasings to search with (0–5). */
	multiQuery?: number;
}

export interface SpaceSearchInput extends QueryExpansionInput {
	/** Metadata predicate every hit must satisfy. */
	filter?: RetrievalFilter;
	/** Fuse BM25 keyword and native rankings; `alpha` (0–1, default 0.5) weights the semantic side. */
	hybrid?: boolean | { alpha?: number };
	/** Max hits (1–50, default 5). */
	limit?: number;
	/** Override wiki link expansion. */
	linkExpansion?: boolean;
	/** Widen each hit to neighbouring chunks or its whole document. */
	parent?: ParentExpansion;
	query: string;
	/** Re-score candidates with the reranker (default true). */
	rerank?: boolean;
}

/** One hit of an advanced Space search. */
export interface SpaceSearchHit {
	chunkId: string;
	content: string;
	/** Placeholder for keyword, graph, and link hits; rank by array order, not this. */
	distance: number | null;
	documentId: string;
	/** Splitter metadata (`index`, `token_count`, `header_path`) and `ordinal`. */
	metadata: Record<string, unknown> | null;
	/** The widened context when `parent` was requested. */
	parentContent: string | null;
	/** Fusion score (higher is better) for hybrid or multi-query results. */
	score: number | null;
}

/** The result of an advanced search, including what query expansion did. */
export interface SpaceSearchResult {
	/** The HyDE passage that was searched, when requested and produced. */
	hypotheticalDocument: string | null;
	matches: SpaceSearchHit[];
	/** The original query followed by its rewrites, when multi-query ran. */
	queries: string[] | null;
	/** Why an expansion was skipped (it fails open to the original query). */
	warning: string | null;
}

const hitWire = z.looseObject({
	chunk_id: z.string(),
	document_id: z.string(),
	content: z.string(),
	distance: z.number().nullable(),
	score: z.number().nullish(),
	metadata: z.record(z.string(), appResponseValueSchema).nullish(),
	parent_content: z.string().nullish(),
});
const searchWire = z.looseObject({
	matches: z.array(hitWire).nullish(),
	queries: z.array(z.string()).nullish(),
	hypothetical_document: z.string().nullish(),
	warning: z.string().nullish(),
});
const chunkingWire = z.looseObject({
	space_id: z.string(),
	chunking: z.looseObject({ strategy: z.string() }),
});

/** Snake-case wire fields for the expansion knobs. */
export function expansionWire(
	input: QueryExpansionInput
): Record<string, string | number | boolean> {
	const body: Record<string, string | number | boolean> = {};
	if (input.multiQuery !== undefined) {
		body.multi_query = input.multiQuery;
	}
	if (input.hyde !== undefined) {
		body.hyde = input.hyde;
	}
	if (input.expansionModel !== undefined) {
		body.expansion_model = input.expansionModel;
	}
	return body;
}

/** The wire value for a `hybrid` input (`true` → default alpha). */
export function hybridWire(
	hybrid: SpaceSearchInput["hybrid"]
): { alpha?: number } | undefined {
	if (hybrid === undefined || hybrid === false) {
		return;
	}
	return hybrid === true ? {} : hybrid;
}

/**
 * Search a Space with hybrid fusion, metadata filters, parent expansion, and
 * query expansion. Hits come back best-first; when `hybrid` or query expansion
 * is used, `score` carries the fusion score.
 */
export async function searchSpaceWith(
	target: ApiTarget,
	spaceId: string,
	input: SpaceSearchInput
): Promise<SpaceSearchResult> {
	const json = await request(
		target,
		`/api/spaces/${encodeURIComponent(spaceId)}/search`,
		{
			method: "POST",
			body: {
				query: input.query,
				limit: input.limit,
				link_expansion: input.linkExpansion,
				hybrid: hybridWire(input.hybrid),
				filter: input.filter,
				parent: input.parent,
				rerank: input.rerank,
				...expansionWire(input),
			},
		},
		searchWire
	);
	return {
		matches: (json.matches ?? []).map((hit) => ({
			chunkId: hit.chunk_id,
			documentId: hit.document_id,
			content: hit.content,
			distance: hit.distance,
			score: hit.score ?? null,
			metadata: hit.metadata ?? null,
			parentContent: hit.parent_content ?? null,
		})),
		queries: json.queries ?? null,
		hypotheticalDocument: json.hypothetical_document ?? null,
		warning: json.warning ?? null,
	};
}

/** Read a Space's chunking strategy (`{ strategy: "default" }` when unset). */
export async function fetchSpaceChunking(
	target: ApiTarget,
	spaceId: string
): Promise<SpaceChunkingStrategy> {
	const json = await request(
		target,
		`/api/spaces/${encodeURIComponent(spaceId)}/chunking`,
		{},
		chunkingWire
	);
	return json.chunking as SpaceChunkingStrategy;
}

/**
 * Set the strategy used for documents ingested or edited from now on, or pass
 * `null` to restore the default splitter. Existing chunks are not re-cut until
 * their document changes.
 */
export async function setSpaceChunking(
	target: ApiTarget,
	spaceId: string,
	strategy: SpaceChunkingStrategy | null
): Promise<SpaceChunkingStrategy> {
	const json = await request(
		target,
		`/api/spaces/${encodeURIComponent(spaceId)}/chunking`,
		{ method: "PUT", body: { chunking: strategy } },
		chunkingWire
	);
	return json.chunking as SpaceChunkingStrategy;
}
