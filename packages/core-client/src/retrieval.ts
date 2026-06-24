// apps/desktop/src/lib/api/retrieval.ts
//
// Typed client for Core's retrieval surface (`/api/retrieval/{search,index}`).
// Retrieval merges short/long-term memory (U11) with Space document chunks (U17)
// behind a single similarity search, so the Desktop Memory view (DA6) can browse
// what Core can ground an answer on. Built on the shared node-aware `request`
// helper so bearer auth + base URL come from the active node, never hardcoded.

import { type ApiTarget, request } from './client'

/** Where a retrieved chunk originated. Mirrors Core's `ChunkSource` (snake_case). */
export type ChunkSource = 'memory' | 'space'

/** A retrieved chunk paired with its relevance score (higher is more relevant). */
export interface ScoredChunk {
  id: string
  source: ChunkSource
  /** Space identifier when `source === 'space'`; `null` for memory. */
  spaceId: string | null
  content: string
  score: number
}

export interface RetrievalSearchInput {
  query: string
  /** Max chunks to return after ranking. Core defaults to 5 when omitted. */
  topK?: number
  /**
   * Which Spaces to search. `undefined` searches all Spaces; an empty array
   * searches no Spaces (memory only).
   */
  spaceIds?: string[]
  /** Whether to include memory in the search (defaults to true on Core). */
  includeMemory?: boolean
  /** Drop chunks scoring below this threshold (0 keeps everything). */
  minScore?: number
}

interface RawScoredChunk {
  id: string
  source: ChunkSource
  space_id?: string | null
  content: string
  score: number
}

/**
 * Search across memory + Spaces, returning scored chunks ranked by relevance.
 * Throws (via {@link request}) when Core is unreachable so callers can degrade.
 */
export async function searchRetrieval(
  target: ApiTarget,
  input: RetrievalSearchInput
): Promise<ScoredChunk[]> {
  const json = await request<{ chunks?: RawScoredChunk[] }>(
    target,
    '/api/retrieval/search',
    {
      method: 'POST',
      body: {
        query: input.query,
        top_k: input.topK,
        space_ids: input.spaceIds,
        include_memory: input.includeMemory,
        min_score: input.minScore,
      },
    }
  )
  return (json.chunks ?? []).map((c) => ({
    id: c.id,
    source: c.source,
    spaceId: c.space_id ?? null,
    content: c.content,
    score: c.score,
  }))
}

export interface IndexChunkInput {
  /** Stable identifier; re-indexing the same id replaces the prior chunk. */
  id: string
  content: string
  /** Defaults to "memory"; pass "space" with a `spaceId` to attach to a Space. */
  source?: ChunkSource
  spaceId?: string
}

/**
 * Index a single chunk into memory (or a Space) so future searches can recall it.
 * Resolves to the indexed id on success.
 */
export async function indexChunk(
  target: ApiTarget,
  input: IndexChunkInput
): Promise<string> {
  const json = await request<{ success?: boolean; id?: string }>(
    target,
    '/api/retrieval/index',
    {
      method: 'POST',
      body: {
        id: input.id,
        content: input.content,
        source: input.source ?? 'memory',
        space_id: input.spaceId,
      },
    }
  )
  return json.id ?? input.id
}

/** A knowledge Space, used to scope retrieval search. Mirrors Core's `Space`. */
export interface SpaceSummary {
  id: string
  name: string
}

/** List Spaces (id + name) so the Memory view can offer them as search scopes. */
export async function listSpaceSummaries(
  target: ApiTarget
): Promise<SpaceSummary[]> {
  const json = await request<{ spaces?: { id: string; name: string }[] }>(
    target,
    '/api/spaces'
  )
  return (json.spaces ?? []).map((s) => ({ id: s.id, name: s.name }))
}
