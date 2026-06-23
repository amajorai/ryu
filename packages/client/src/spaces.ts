// packages/client/src/spaces.ts
//
// SpacesAPI: typed client for Core's Spaces / RAG endpoints (/api/spaces).
// A Space is a named document collection backed by sqlite-vec; documents are
// ingested (chunked + embedded) and searched via KNN.

import { request } from "./request";
import type { RyuClientOptions, Space, SpaceMatch } from "./types";

// ---------------------------------------------------------------------------
// Wire shapes (snake_case from Core)
// ---------------------------------------------------------------------------

interface SpaceWire {
	created_at: number;
	description?: string | null;
	document_count: number;
	id: string;
	name: string;
	updated_at: number;
}

interface MatchWire {
	chunk_id: string;
	content: string;
	distance: number;
	document_id: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toSpace(s: SpaceWire): Space {
	return {
		id: s.id,
		name: s.name,
		description: s.description ?? null,
		createdAt: s.created_at,
		updatedAt: s.updated_at,
		documentCount: s.document_count,
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

// ---------------------------------------------------------------------------
// API class
// ---------------------------------------------------------------------------

export class SpacesAPI {
	private readonly options: RyuClientOptions;

	constructor(options: RyuClientOptions) {
		this.options = options;
	}

	/** List all Spaces, most-recently-updated first. */
	async list(): Promise<Space[]> {
		const data = await request<{ spaces?: SpaceWire[] }>(
			this.options,
			"/api/spaces"
		);
		return (data.spaces ?? []).map(toSpace);
	}

	/**
	 * Run a KNN similarity search within a Space, returning ranked chunk matches.
	 *
	 * @param id - Space id to search
	 * @param query - Natural language query string
	 * @param limit - Maximum number of chunks to return (default: Core decides)
	 */
	async search(
		id: string,
		query: string,
		limit?: number
	): Promise<SpaceMatch[]> {
		const body: Record<string, unknown> = { query };
		if (limit !== undefined) {
			body.limit = limit;
		}
		const data = await request<{ matches?: MatchWire[] }>(
			this.options,
			`/api/spaces/${id}/search`,
			{
				method: "POST",
				body: JSON.stringify(body),
			}
		);
		return (data.matches ?? []).map(toMatch);
	}
}
