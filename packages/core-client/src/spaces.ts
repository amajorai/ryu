// apps/desktop/src/lib/api/spaces.ts
//
// Typed client for Core's Spaces / RAG endpoints (`/api/spaces`). A Space is a
// named document collection backed by a sqlite-vec vector store; documents are
// ingested (chunked + embedded) and searched via KNN. Consumed by the spaces
// page through the `useSpaces` hook. Wire shapes mirror the Core handlers in
// `apps/core/src/server/{mod,spaces}.rs` (snake_case on the wire).

import { type ApiTarget, request } from './client'

/** A named document collection. `documentCount` is computed by Core. */
export interface Space {
  id: string
  name: string
  description: string | null
  /** Unix milliseconds. */
  createdAt: number
  /** Unix milliseconds. */
  updatedAt: number
  documentCount: number
}

/** A document inside a Space, with its chunk count. */
export interface SpaceDocument {
  id: string
  spaceId: string
  title: string
  /** Unix milliseconds. */
  createdAt: number
  chunkCount: number
}

/** A single ranked chunk returned from a Space search. */
export interface SpaceMatch {
  chunkId: string
  documentId: string
  content: string
  /** Squared L2 distance from the query vector (smaller is closer). */
  distance: number
}

interface SpaceWire {
  id: string
  name: string
  description?: string | null
  created_at: number
  updated_at: number
  document_count: number
}

interface DocumentWire {
  id: string
  space_id: string
  title: string
  created_at: number
  chunk_count: number
}

interface MatchWire {
  chunk_id: string
  document_id: string
  content: string
  distance: number
}

function toSpace(s: SpaceWire): Space {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    documentCount: s.document_count,
  }
}

function toDocument(d: DocumentWire): SpaceDocument {
  return {
    id: d.id,
    spaceId: d.space_id,
    title: d.title,
    createdAt: d.created_at,
    chunkCount: d.chunk_count,
  }
}

function toMatch(m: MatchWire): SpaceMatch {
  return {
    chunkId: m.chunk_id,
    documentId: m.document_id,
    content: m.content,
    distance: m.distance,
  }
}

/** List all Spaces, most-recently-updated first. */
export async function fetchSpaces(target: ApiTarget): Promise<Space[]> {
  const json = await request<{ spaces?: SpaceWire[] }>(target, '/api/spaces')
  return (json.spaces ?? []).map(toSpace)
}

/** Create a new Space and return its id. */
export async function createSpace(
  target: ApiTarget,
  name: string,
  description: string | null
): Promise<string> {
  const json = await request<{ id: string }>(target, '/api/spaces', {
    method: 'POST',
    body: { name, description },
  })
  return json.id
}

/** Delete a Space and everything in it. Returns whether a row was removed. */
export async function deleteSpace(
  target: ApiTarget,
  id: string
): Promise<boolean> {
  const json = await request<{ removed?: boolean }>(target, `/api/spaces/${id}`, {
    method: 'DELETE',
  })
  return json?.removed ?? false
}

/** List the documents in a Space. */
export async function fetchDocuments(
  target: ApiTarget,
  spaceId: string
): Promise<SpaceDocument[]> {
  const json = await request<{ documents?: DocumentWire[] }>(
    target,
    `/api/spaces/${spaceId}/documents`
  )
  return (json.documents ?? []).map(toDocument)
}

/** Ingest a document into a Space. Returns the new document id. */
export async function ingestDocument(
  target: ApiTarget,
  spaceId: string,
  title: string,
  content: string
): Promise<string> {
  const json = await request<{ document_id: string }>(
    target,
    `/api/spaces/${spaceId}/documents`,
    {
      method: 'POST',
      body: { title, content },
    }
  )
  return json.document_id
}

/** Full editable content of a document (Notion-like page). */
export interface SpaceDocumentContent {
  id: string
  spaceId: string
  title: string
  /** Canonical markdown source of the page. */
  source: string
  /** Unix milliseconds. */
  createdAt: number
  /** Unix milliseconds. */
  updatedAt: number
  chunkCount: number
}

interface DocumentContentWire {
  id: string
  space_id: string
  title: string
  source: string
  created_at: number
  updated_at: number
  chunk_count: number
}

function toDocumentContent(d: DocumentContentWire): SpaceDocumentContent {
  return {
    id: d.id,
    spaceId: d.space_id,
    title: d.title,
    source: d.source,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    chunkCount: d.chunk_count,
  }
}

/** Create a new blank markdown page in a Space. Returns the new document id. */
export async function createPage(
  target: ApiTarget,
  spaceId: string,
  title: string
): Promise<string> {
  const json = await request<{ id: string }>(
    target,
    `/api/spaces/${spaceId}/pages`,
    { method: 'POST', body: { title } }
  )
  return json.id
}

/** Fetch a single document's full markdown source for editing. */
export async function fetchDocument(
  target: ApiTarget,
  spaceId: string,
  documentId: string
): Promise<SpaceDocumentContent> {
  const json = await request<DocumentContentWire>(
    target,
    `/api/spaces/${spaceId}/documents/${documentId}`
  )
  return toDocumentContent(json)
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
  await request(target, `/api/spaces/${spaceId}/documents/${documentId}`, {
    method: 'PUT',
    body: { title, source },
  })
}

/** Delete a single document (page) and its chunks/vectors. */
export async function deleteDocument(
  target: ApiTarget,
  spaceId: string,
  documentId: string
): Promise<boolean> {
  const json = await request<{ removed?: boolean }>(
    target,
    `/api/spaces/${spaceId}/documents/${documentId}`,
    { method: 'DELETE' }
  )
  return json?.removed ?? false
}

/** Reindex progress reported by Core. */
export interface ReindexStatus {
  currentModel: string
  currentDims: number
  totalChunks: number
  pendingChunks: number
  running: boolean
}

interface ReindexStatusWire {
  current_model: string
  current_dims: number
  total_chunks: number
  pending_chunks: number
  running: boolean
}

/** Get the current embedding-reindex status (how many chunks are stale). */
export async function fetchReindexStatus(
  target: ApiTarget
): Promise<ReindexStatus> {
  const json = await request<ReindexStatusWire>(
    target,
    '/api/embeddings/reindex/status'
  )
  return {
    currentModel: json.current_model,
    currentDims: json.current_dims,
    totalChunks: json.total_chunks,
    pendingChunks: json.pending_chunks,
    running: json.running,
  }
}

/** Kick off a background reindex of all stale chunks. Returns immediately. */
export async function triggerReindex(target: ApiTarget): Promise<void> {
  await request(target, '/api/embeddings/reindex', { method: 'POST' })
}

/** The embedding model Spaces currently uses. */
export interface EmbeddingModel {
  modelId: string
  baseUrl: string
  dims: number
}

interface EmbeddingModelWire {
  model_id: string
  base_url: string
  dims: number
}

/** Read the active embedding model. */
export async function fetchEmbeddingModel(
  target: ApiTarget
): Promise<EmbeddingModel> {
  const json = await request<EmbeddingModelWire>(
    target,
    '/api/embeddings/model'
  )
  return { modelId: json.model_id, baseUrl: json.base_url, dims: json.dims }
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
  dims?: number
): Promise<void> {
  const body: Record<string, unknown> = { model_id: modelId }
  if (baseUrl !== undefined) {
    body.base_url = baseUrl
  }
  if (dims !== undefined) {
    body.dims = dims
  }
  await request(target, '/api/embeddings/model', { method: 'POST', body })
}

/** Run a KNN similarity search within a Space, returning ranked chunk matches. */
export async function searchSpace(
  target: ApiTarget,
  spaceId: string,
  query: string,
  limit?: number
): Promise<SpaceMatch[]> {
  const body: Record<string, unknown> = { query }
  if (limit !== undefined) {
    body.limit = limit
  }
  const json = await request<{ matches?: MatchWire[] }>(
    target,
    `/api/spaces/${spaceId}/search`,
    { method: 'POST', body }
  )
  return (json.matches ?? []).map(toMatch)
}
