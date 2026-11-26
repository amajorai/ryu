// packages/core-client/src/spaces-types.ts
//
// Wire schemas, public types, projections and response checks of the Spaces
// client (`spaces.ts`), split out of it to keep every part under the hook
// limits. `spaces.ts` re-exports the public names.

import { z } from "zod";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "./app-request-json.ts";

export const spaceString = z.string();
export const spaceNumber = z.number();
export const spaceBoolean = z.boolean();
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
export const spaceRows = z.array(spaceRowFields);

export const spaceJsonObject = z.record(
	z.string(),
	appResponseValueSchema.nonoptional()
);

// Parse the native fields and retain forward-compatible metadata. Optional legacy
// fields continue to use the existing defaults in the public projections.
export const spaceDocumentFields = z.looseObject({
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
export const spaceDocumentsResponse = z.looseObject({
	space_id: spaceString.optional(),
	documents: z.array(spaceDocumentFields).nullish(),
});
export const spaceDocumentContentResponse = z.looseObject({
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
export const spaceDeletedResponse = z
	.object({ success: spaceBoolean.optional(), removed: spaceBoolean.nullish() })
	.nullish();
export const spaceIngestResponse = z.looseObject({ document_id: spaceString });
export const spacePageResponse = z.looseObject({ id: spaceString });
export const spaceReindexResponse = z.looseObject({
	current_model: spaceString,
	current_dims: spaceNumber,
	total_chunks: spaceNumber,
	pending_chunks: spaceNumber,
	running: spaceBoolean,
	errored: spaceString.nullish(),
});
// The current native publisher has model_id and dims. base_url is retained
// only when supplied by an older/custom response; no URL is synthesized.
export const spaceEmbeddingResponse = z.looseObject({
	model_id: spaceString,
	dims: spaceNumber,
	base_url: spaceString.optional(),
});
export const spaceMatchFields = z.looseObject({
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

export interface SpaceWire {
	created_at: number;
	description?: string | null;
	document_count?: number;
	icon?: unknown | null;
	id: string;
	name: string;
	retrieval_mode?: string;
	updated_at: number;
}

export type DocumentWire = z.output<typeof spaceDocumentFields>;

export type MatchWire = z.output<typeof spaceMatchFields>;

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

export interface RetrievalModeStatusBase {
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

export function toSpace(s: SpaceWire): Space {
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

export function toDocument(d: DocumentWire): SpaceDocument {
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

export function toMatch(m: MatchWire): SpaceMatch {
	return {
		chunkId: m.chunk_id,
		documentId: m.document_id,
		content: m.content,
		distance: m.distance,
	};
}

export function isRecord(
	value: AppResponseValue
): value is z.output<typeof spaceJsonObject> {
	return spaceJsonObject.safeParse(value).success;
}

export function invalidResponse(endpoint: string): Error {
	return new Error(`Core returned an invalid ${endpoint} response`);
}

export function requireRecord(
	value: AppResponseValue,
	endpoint: string
): Record<string, AppResponseValue> {
	if (!isRecord(value)) {
		throw invalidResponse(endpoint);
	}
	return value;
}

export function requireString(
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

export function requireCount(
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

export function requireBoolean(
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

export function parseRetrievalMode(
	value: AppResponseValue,
	endpoint: string
): RetrievalMode {
	if (value === "graph" || value === "vector") {
		return value;
	}
	throw invalidResponse(endpoint);
}

export function toRetrievalMode(value: AppResponseValue): RetrievalMode {
	if (value === undefined) {
		return "vector";
	}
	return parseRetrievalMode(value, "space");
}
