// apps/desktop/src/lib/api/spaces.ts
//
// Typed client for Core's Spaces / RAG endpoints (`/api/spaces`). A Space is a
// named document collection backed by a sqlite-vec vector store; documents are
// ingested (chunked + embedded) and searched via KNN. Consumed by the spaces
// page through the `useSpaces` hook. Wire shapes mirror the Core handlers in
// `apps/core/src/server/{mod,spaces}.rs` (snake_case on the wire).

import { type ApiTarget, request } from "./client.ts";

/** A named document collection. `documentCount` is computed by Core. */
export interface Space {
	/** Unix milliseconds. */
	createdAt: number;
	description: string | null;
	documentCount: number;
	id: string;
	name: string;
	/** Unix milliseconds. */
	updatedAt: number;
}

/** Whether a document is a markdown page, a data-grid database, or an
 * Excalidraw whiteboard (its `source` is an Excalidraw scene JSON). */
export type DocumentKind = "page" | "database" | "whiteboard";

/** A document inside a Space, with its chunk count. */
export interface SpaceDocument {
	chunkCount: number;
	/** Unix milliseconds. */
	createdAt: number;
	id: string;
	/** `'page'` (markdown) or `'database'` (data grid). */
	kind: DocumentKind;
	/** The RAW kind discriminator (`kind` above coerces unknown kinds to `'page'`).
	 *  App-owned documents carry `app:<pluginId>` here so the list can route them to
	 *  their owning Companion app. Empty string when the wire omits it. */
	rawKind: string;
	spaceId: string;
	title: string;
}

/** A single ranked chunk returned from a Space search. */
export interface SpaceMatch {
	chunkId: string;
	content: string;
	/** Squared L2 distance from the query vector (smaller is closer). */
	distance: number;
	documentId: string;
}

interface SpaceWire {
	created_at: number;
	description?: string | null;
	document_count: number;
	id: string;
	name: string;
	updated_at: number;
}

interface DocumentWire {
	chunk_count: number;
	created_at: number;
	id: string;
	kind?: string;
	space_id: string;
	title: string;
}

interface MatchWire {
	chunk_id: string;
	content: string;
	distance: number;
	document_id: string;
}

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

function toDocumentKind(kind?: string): DocumentKind {
	if (kind === "database") {
		return "database";
	}
	if (kind === "whiteboard") {
		return "whiteboard";
	}
	return "page";
}

function toDocument(d: DocumentWire): SpaceDocument {
	return {
		id: d.id,
		spaceId: d.space_id,
		title: d.title,
		createdAt: d.created_at,
		chunkCount: d.chunk_count,
		kind: toDocumentKind(d.kind),
		rawKind: d.kind ?? "",
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

/** List all Spaces, most-recently-updated first. */
export async function fetchSpaces(target: ApiTarget): Promise<Space[]> {
	const json = await request<{ spaces?: SpaceWire[] }>(target, "/api/spaces");
	return (json.spaces ?? []).map(toSpace);
}

/** Create a new Space and return its id. */
export async function createSpace(
	target: ApiTarget,
	name: string,
	description: string | null
): Promise<string> {
	const json = await request<{ id: string }>(target, "/api/spaces", {
		method: "POST",
		body: { name, description },
	});
	return json.id;
}

/** Delete a Space and everything in it. Returns whether a row was removed. */
export async function deleteSpace(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const json = await request<{ removed?: boolean }>(
		target,
		`/api/spaces/${id}`,
		{
			method: "DELETE",
		}
	);
	return json?.removed ?? false;
}

/** List the documents in a Space. */
export async function fetchDocuments(
	target: ApiTarget,
	spaceId: string
): Promise<SpaceDocument[]> {
	const json = await request<{ documents?: DocumentWire[] }>(
		target,
		`/api/spaces/${spaceId}/documents`
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
	const json = await request<{ document_id: string }>(
		target,
		`/api/spaces/${spaceId}/documents`,
		{
			method: "POST",
			body: { title, content },
		}
	);
	return json.document_id;
}

/** Full editable content of a document (Notion-like page). */
export interface SpaceDocumentContent {
	chunkCount: number;
	/** Unix milliseconds. */
	createdAt: number;
	id: string;
	/** `'page'` (markdown) or `'database'` (data grid; `source` is grid JSON). */
	kind: DocumentKind;
	/** Canonical markdown source of the page. */
	source: string;
	spaceId: string;
	title: string;
	/** Unix milliseconds. */
	updatedAt: number;
}

interface DocumentContentWire {
	chunk_count: number;
	created_at: number;
	id: string;
	kind?: string;
	source: string;
	space_id: string;
	title: string;
	updated_at: number;
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
		kind: toDocumentKind(d.kind),
	};
}

/**
 * Create a new blank markdown page in a Space. Returns the new document id.
 * Pass `parentId` (a database document id) to create a hidden "row page" — the
 * body of a database row, which embeds like a page but is excluded from the
 * Space's top-level document list.
 */
export async function createPage(
	target: ApiTarget,
	spaceId: string,
	title: string,
	parentId?: string
): Promise<string> {
	const json = await request<{ id: string }>(
		target,
		`/api/spaces/${spaceId}/pages`,
		{ method: "POST", body: { title, parent_id: parentId } }
	);
	return json.id;
}

/**
 * Create a new blank database (data grid) in a Space. Returns the new document
 * id. The grid editor saves its `{columns, rows}` JSON via {@link updateDocument}.
 */
export async function createDatabase(
	target: ApiTarget,
	spaceId: string,
	title: string
): Promise<string> {
	const json = await request<{ id: string }>(
		target,
		`/api/spaces/${spaceId}/databases`,
		{ method: "POST", body: { title } }
	);
	return json.id;
}

/**
 * Create a new blank whiteboard (Excalidraw) in a Space. Returns the new
 * document id. The board editor saves its Excalidraw scene JSON via
 * {@link updateDocument}; Core embeds the flattened element text for search.
 */
export async function createWhiteboard(
	target: ApiTarget,
	spaceId: string,
	title: string
): Promise<string> {
	const json = await request<{ id: string }>(
		target,
		`/api/spaces/${spaceId}/whiteboards`,
		{ method: "POST", body: { title } }
	);
	return json.id;
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
	await request(target, `/api/spaces/${spaceId}/documents/${documentId}`, {
		method: "PUT",
		body: { title, source },
	});
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
		{ method: "DELETE" }
	);
	return json?.removed ?? false;
}

// ── Document version history (server-backed) ────────────────────────────────

/** Metadata for one saved version of a document. */
export interface DocumentVersionMeta {
	/** Unix milliseconds. */
	createdAt: number;
	documentId: string;
	id: string;
	kind: DocumentKind;
	label: string | null;
	title: string;
}

interface DocumentVersionMetaWire {
	created_at: number;
	document_id: string;
	id: string;
	kind: DocumentKind;
	label?: string | null;
	title: string;
}

interface DocumentVersionWire extends DocumentVersionMetaWire {
	source: string;
}

function toDocumentVersionMeta(
	w: DocumentVersionMetaWire
): DocumentVersionMeta {
	return {
		createdAt: w.created_at,
		documentId: w.document_id,
		id: w.id,
		kind: w.kind,
		label: w.label ?? null,
		title: w.title,
	};
}

/** List a document's saved versions, newest first (metadata only). */
export async function listDocumentVersions(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<DocumentVersionMeta[]> {
	const json = await request<DocumentVersionMetaWire[]>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/versions`
	);
	return (json ?? []).map(toDocumentVersionMeta);
}

/** Fetch one version's captured markdown source. */
export async function getDocumentVersion(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	versionId: string
): Promise<string> {
	const json = await request<DocumentVersionWire>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/versions/${versionId}`
	);
	return json.source;
}

/** Snapshot the document's current content as a new version. */
export async function createDocumentVersion(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	label?: string
): Promise<void> {
	await request(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/versions`,
		{ method: "POST", body: label ? { label } : {} }
	);
}

/** Restore a version as the document's current content (undoable server-side). */
export async function restoreDocumentVersion(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	versionId: string
): Promise<void> {
	await request(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/versions/${versionId}/restore`,
		{ method: "POST" }
	);
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
		"/api/embeddings/reindex/status"
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
	await request(target, "/api/embeddings/reindex", { method: "POST" });
}

/** The embedding model Spaces currently uses. */
export interface EmbeddingModel {
	baseUrl: string;
	dims: number;
	modelId: string;
}

interface EmbeddingModelWire {
	base_url: string;
	dims: number;
	model_id: string;
}

/** Read the active embedding model. */
export async function fetchEmbeddingModel(
	target: ApiTarget
): Promise<EmbeddingModel> {
	const json = await request<EmbeddingModelWire>(
		target,
		"/api/embeddings/model"
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
	dims?: number
): Promise<void> {
	const body: Record<string, unknown> = { model_id: modelId };
	if (baseUrl !== undefined) {
		body.base_url = baseUrl;
	}
	if (dims !== undefined) {
		body.dims = dims;
	}
	await request(target, "/api/embeddings/model", { method: "POST", body });
}

/** Run a KNN similarity search within a Space, returning ranked chunk matches. */
export async function searchSpace(
	target: ApiTarget,
	spaceId: string,
	query: string,
	limit?: number
): Promise<SpaceMatch[]> {
	const body: Record<string, unknown> = { query };
	if (limit !== undefined) {
		body.limit = limit;
	}
	const json = await request<{ matches?: MatchWire[] }>(
		target,
		`/api/spaces/${spaceId}/search`,
		{ method: "POST", body }
	);
	return (json.matches ?? []).map(toMatch);
}

// ── Wiki page-links: backlinks + graph ──────────────────────────────────────────

/** A wiki/mention link between two documents. */
export interface SpaceDocLink {
	/** `null` when the target page does not exist yet (a pending link). */
	dstDocId: string | null;
	dstTitle: string;
	/** `'wiki'` (`[[Title]]`) or `'mention'` (`@Title`). */
	kind: string;
	/** Populated for backlinks: a context snippet around the link. */
	snippet?: string;
	srcDocId: string;
	/** Populated for backlinks: the linking document's title. */
	srcTitle?: string;
}

interface DocLinkWire {
	dst_doc_id: string | null;
	dst_title: string;
	kind: string;
	snippet?: string;
	src_doc_id: string;
	src_title?: string;
}

function toDocLink(l: DocLinkWire): SpaceDocLink {
	return {
		srcDocId: l.src_doc_id,
		dstDocId: l.dst_doc_id,
		dstTitle: l.dst_title,
		kind: l.kind,
		srcTitle: l.src_title,
		snippet: l.snippet,
	};
}

/** A node in the document-link graph (a document, or a pending link target). */
export interface DocGraphNode {
	id: string;
	/** `'page'`, `'database'`, or `'pending'`. */
	kind: string;
	pending: boolean;
	spaceId: string;
	title: string;
}

/** An edge in the document-link graph. */
export interface DocGraphEdge {
	dst: string;
	/** `'wiki'`, `'mention'`, or `'parent'`. */
	kind: string;
	src: string;
}

/** The document-link graph (per-space or global). */
export interface DocGraph {
	edges: DocGraphEdge[];
	nodes: DocGraphNode[];
}

interface DocGraphWire {
	edges: DocGraphEdge[];
	nodes: {
		id: string;
		kind: string;
		pending: boolean;
		space_id: string;
		title: string;
	}[];
}

function toDocGraph(g: DocGraphWire): DocGraph {
	return {
		nodes: g.nodes.map((n) => ({
			id: n.id,
			title: n.title,
			kind: n.kind,
			spaceId: n.space_id,
			pending: n.pending,
		})),
		edges: g.edges,
	};
}

/** Documents that link to `documentId` (Obsidian/Notion "linked references"). */
export async function fetchBacklinks(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<SpaceDocLink[]> {
	const json = await request<{ backlinks?: DocLinkWire[] }>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/backlinks`
	);
	return (json.backlinks ?? []).map(toDocLink);
}

/** Outgoing links from `documentId` (resolved refs + pending titles). */
export async function fetchDocumentLinks(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<SpaceDocLink[]> {
	const json = await request<{ links?: DocLinkWire[] }>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/links`
	);
	return (json.links ?? []).map(toDocLink);
}

/** The document-link graph for one Space. */
export async function fetchSpaceGraph(
	target: ApiTarget,
	spaceId: string
): Promise<DocGraph> {
	const json = await request<DocGraphWire>(
		target,
		`/api/spaces/${spaceId}/graph`
	);
	return toDocGraph(json);
}

/** The global document-link graph across every Space. */
export async function fetchGlobalGraph(target: ApiTarget): Promise<DocGraph> {
	const json = await request<DocGraphWire>(target, "/api/graph");
	return toDocGraph(json);
}
