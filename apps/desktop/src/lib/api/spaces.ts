import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import {
	type ResourceVisibility,
	toResourceVisibility,
} from "@/src/lib/resource-visibility.ts";
import { type ApiTarget, request } from "./client.ts";
import {
	listDocumentsResponseCodec,
	listSpacesResponseCodec,
	responseCodec1,
	responseCodec2,
	responseCodec3,
	responseCodec4,
	responseCodec5,
	responseCodec6,
	responseCodec7,
} from "./spaces-response-codecs.ts";
import {
	type RetrievalMode,
	type Space,
	type SpaceDocument,
	type SpaceFileIndex,
	type SpaceLexicalHit,
	toDocumentKind,
	toFileIndexState,
	toRetrievalMode,
} from "./spaces-types.ts";
import type {
	CreateSpaceWireRequest,
	DocumentWire,
	FileIndexWire,
	SpaceLexicalHitWire,
	SpaceVisibilityWireRequest,
	SpaceWire,
} from "./spaces-wire-types.ts";

// apps/desktop/src/lib/api/spaces.ts
//
// Typed client for Core's Spaces / RAG endpoints (`/api/spaces`). A Space is a
// named document collection backed by a sqlite-vec vector store; documents are
// ingested (chunked + embedded) and searched by whichever retrieval algorithm the
// Space is set to — vector KNN or entity-graph traversal — after which hits are
// link-expanded and neurally reranked — see {@link searchSpace}, which carries
// the detail and the caveats. This header named only the vector branch for one
// round after that function's own doc was corrected, which is why the test file
// pins both. Consumed by the spaces page through the `useSpaces` hook. Wire
// shapes mirror the Core handlers in
// `apps/core/src/server/{mod,spaces}.rs` (snake_case on the wire).

export {
	createDatabase,
	createDocumentVersion,
	createPage,
	createWhiteboard,
	type DocumentVersionMeta,
	type DocumentWriteReceipt,
	deleteDocument,
	fetchDocument,
	getDocumentVersion,
	ingestDocument,
	listDocumentVersions,
	restoreDocumentVersion,
	type SpaceDocumentContent,
	updateDocument,
} from "./spaces-documents.ts";
export {
	fetchSpaceFileBlob,
	replaceSpaceFileBlob,
	type UploadedSpaceFile,
	uploadSpaceFile,
} from "./spaces-file-upload.ts";
export {
	type DocGraph,
	type DocGraphEdge,
	type DocGraphNode,
	fetchBacklinks,
	fetchDocumentLinks,
	fetchGlobalGraph,
	fetchSpaceGraph,
	type SpaceDocLink,
} from "./spaces-links.ts";
export {
	describeRetrievalModeChange,
	type RetrievalModeProgress,
	type SetRetrievalModeOptions,
	setSpaceRetrievalMode,
} from "./spaces-retrieval-mode.ts";
export {
	type EmbeddingModel,
	fetchEmbeddingModel,
	fetchReindexStatus,
	querySpaceDatabase,
	type ReindexStatus,
	searchSpace,
	setEmbeddingModel,
	triggerReindex,
} from "./spaces-search.ts";
export {
	type DocumentKind,
	FILE_DOCUMENT_KIND,
	isFileDocument,
	NOT_CONTENT_SEARCHABLE_STATES,
	type RetrievalMode,
	type Space,
	type SpaceDatabaseQueryResult,
	type SpaceDatabaseQuerySchemaColumn,
	type SpaceDatabaseQueryValue,
	type SpaceDocument,
	type SpaceFileIndex,
	type SpaceFileIndexState,
	type SpaceLexicalHit,
	type SpaceMatch,
	toFileIndexState,
	toRetrievalMode,
} from "./spaces-types.ts";
export {
	formatBytes,
	NODE_UPLOAD_MAX_BYTES,
	SPACE_UPLOAD_MAX_BYTES,
} from "./spaces-upload-limits.ts";

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
		system: s.system ?? false,
		teamId: s.team_id ?? null,
		visibility: toResourceVisibility(s.visibility),
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
		kind: toDocumentKind(d.kind),
		rawKind: d.kind ?? "",
		mime: d.mime ?? null,
		byteSize: d.byte_size ?? null,
		// Read defensively at every hop. Core sends `index` on file rows and omits it
		// everywhere else (see `DocumentWire`), and an older node sends it nowhere, so
		// every branch here must survive `undefined` without throwing and without
		// inventing a state.
		...withFileIndex(toFileIndex(d.index)),
		icon: d.icon ?? null,
	};
}

/** The three document fields a {@link SpaceFileIndex} populates, so the list reader
 *  and the per-document fetch cannot fill them differently. */
export function withFileIndex(
	index: SpaceFileIndex
): Pick<SpaceDocument, "indexMessage" | "indexState" | "indexWarnings"> {
	return {
		indexState: index.state,
		indexMessage: index.message,
		indexWarnings: index.warnings,
	};
}

/** List all Spaces, most-recently-updated first. */
export async function fetchSpaces(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<Space[]> {
	const json = await request<{ spaces?: SpaceWire[] }>(
		target,
		"/api/spaces",
		{
			signal,
		},
		listSpacesResponseCodec
	);
	return (json.spaces ?? []).map(toSpace);
}

/** What Core actually created, including the mode it resolved. */
export interface CreatedSpace {
	id: string;
	/**
	 * The mode the new Space was stamped with — echoed by Core, NOT assumed here.
	 * When `retrievalMode` was omitted at the call site this is the node-wide
	 * `rag_strategy` default, which an operator can set to `"graph"`. Reading it
	 * back is the only way a caller learns that without a follow-up GET.
	 */
	retrievalMode: RetrievalMode;
}

/**
 * Create a new Space.
 *
 * `retrievalMode` is **optional on purpose**. Core resolves an omitted field
 * through the node-wide `rag_strategy` (`RYU_RAG_STRATEGY` / `registry.json`),
 * which then falls through to `"vector"`. Always sending a value — even the value
 * the UI happens to be showing — would make that operator setting unreachable from
 * the desktop, i.e. a setting that cannot take effect. So callers pass a mode only
 * when the user actually picked one, and read {@link CreatedSpace.retrievalMode}
 * to learn what they got.
 */
export async function createSpace(
	target: ApiTarget,
	name: string,
	description: string | null,
	retrievalMode?: RetrievalMode,
	visibility?: ResourceVisibility
): Promise<CreatedSpace> {
	const body: CreateSpaceWireRequest = { name, description };
	if (retrievalMode !== undefined) {
		body.retrieval_mode = retrievalMode;
	}
	if (visibility !== undefined) {
		body.visibility = visibility;
	}
	const json = await request<{ id: string; retrieval_mode?: string }>(
		target,
		"/api/spaces",
		{ method: "POST", body },
		responseCodec1
	);
	return { id: json.id, retrievalMode: toRetrievalMode(json.retrieval_mode) };
}

/** Change a Space's sharing scope without touching its pages or retrieval index. */
export async function setSpaceVisibility(
	target: ApiTarget,
	id: string,
	visibility: ResourceVisibility,
	teamId?: string | null
): Promise<void> {
	const body: SpaceVisibilityWireRequest = { visibility };
	if (visibility === "team" && teamId) {
		body.team_id = teamId;
	}
	await request(
		target,
		`/api/spaces/${encodeURIComponent(id)}/visibility`,
		{
			method: "POST",
			body,
		},
		responseCodec2
	);
}

/** Rename a user-created Space without touching its documents or retrieval index. */
export async function renameSpace(
	target: ApiTarget,
	id: string,
	name: string
): Promise<void> {
	await request(
		target,
		`/api/spaces/${id}/name`,
		{
			method: "POST",
			body: { name },
		},
		responseCodec3
	);
}

/**
 * What a {@link setSpaceRetrievalMode} call actually did — the client mirror of
 * Core's `RetrievalModeChange`.
 *
 * Every field exists so the UI can *state the consequence*. A mode switch is not a
 * metadata edit: Core rebuilds the Space's entity graph from the chunks already on
 * disk (switching to graph) or drops it (switching to vector), inside the same
 * transaction as the column write. `chunksScanned` / `graphNodes` / `graphEdges`
 * are what that rebuild covered.
 *
 * That rebuild is **not** fast. Measured on-disk in `crates/core/spaces/src/lib.rs`
 * (`build_graph_for_chunks`, which carries the table and the reproduction command):
 * a 1,566-chunk Space writes ~5.1M edge rows and takes 46–87 s, and the per-chunk
 * cost *rises* with size. The call also holds the single SQLite connection for the
 * whole transaction, so every other Space is blocked meanwhile. Anything rendering
 * this type should treat the call as slow, not instant.
 */
export interface RetrievalModeChange {
	/** False when the Space was already in `mode`. Re-asserting **`"graph"`** on a
	 *  graph Space still rebuilds the graph — see `graphRebuilt` — because a full
	 *  rebuild is the *only* repair path for a Space whose graph was dropped or
	 *  never built; there is no incremental top-up. (Re-asserting `"vector"` on a
	 *  vector Space rebuilds nothing: `graphRebuilt` is false and there is no graph
	 *  to repair. The repair story is graph-only.)
	 *
	 *  So `changed: false` does NOT mean "nothing happened". It costs exactly what a
	 *  first build costs. This previously read "the cheap repair path", mirroring a
	 *  Rust doc that has since been corrected against real measurements.
	 *
	 *  **That repair is API-only — this desktop cannot produce `changed: false`.**
	 *  `handleRetrievalModeChange` in `src/pages/SpacesPage.tsx` returns early when
	 *  `selected.retrievalMode === mode`, so every call the UI makes is a real
	 *  switch. The guard is deliberate and stays: a rebuild is an expensive
	 *  background job, and a picker whose current value re-fires that is a second
	 *  graph rebuild one stray click away. An operator repairs a graph by POSTing
	 *  `/api/spaces/:id/retrieval-mode` directly. Read
	 *  the fields below as documenting the endpoint, not a state this UI reaches. */
	changed: boolean;
	/** Chunks the rebuild walked. `0` when switching to vector, and also `0` for an
	 *  empty Space — which is a correct outcome, not a failure. */
	chunksScanned: number;
	graphEdges: number;
	graphNodes: number;
	/** True whenever the new mode is `"graph"`; false when switching to vector,
	 *  which *drops* the now-unmaintained graph instead. */
	graphRebuilt: boolean;
	mode: RetrievalMode;
	/** Core's own plain-language summary of what was and was not touched. */
	note: string;
	previous: RetrievalMode;
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
		},
		responseCodec4
	);
	return json?.removed ?? false;
}

/** Set or clear a Space's Notion-style glyph. */
export async function setSpaceIcon(
	target: ApiTarget,
	id: string,
	icon: GlyphValue
): Promise<void> {
	await request(
		target,
		`/api/spaces/${id}/icon`,
		{
			method: "POST",
			body: { icon },
		},
		responseCodec5
	);
}

/** Set or clear a document's glyph without re-embedding the page. */
export async function setDocumentIcon(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	icon: GlyphValue
): Promise<void> {
	await request(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/icon`,
		{
			method: "POST",
			body: { icon },
		},
		responseCodec6
	);
}

/** List the documents in a Space. */
export async function fetchDocuments(
	target: ApiTarget,
	spaceId: string,
	signal?: AbortSignal
): Promise<SpaceDocument[]> {
	const json = await request<{ documents?: DocumentWire[] }>(
		target,
		`/api/spaces/${spaceId}/documents`,
		{ signal },
		listDocumentsResponseCodec
	);
	return (json.documents ?? []).map(toDocument);
}

/** Search visible Space metadata and document text with literal lexical matching. */
export async function searchSpaceDocuments(
	target: ApiTarget,
	query: string,
	limit = 8,
	signal?: AbortSignal
): Promise<SpaceLexicalHit[] | null> {
	try {
		const params = new URLSearchParams({
			limit: String(limit),
			q: query,
		});
		const json = await request<{ hits?: SpaceLexicalHitWire[] }>(
			target,
			`/api/spaces/search?${params.toString()}`,
			{ signal },
			responseCodec7
		);
		return (json.hits ?? []).map((hit) => ({
			createdAt: hit.created_at,
			documentId: hit.document_id,
			spaceId: hit.space_id,
			spaceName: hit.space_name,
			snippet: hit.snippet,
			title: hit.title,
			updatedAt: hit.updated_at || hit.created_at,
		}));
	} catch {
		return null;
	}
}

export function toFileIndex(
	w: FileIndexWire | null | undefined
): SpaceFileIndex {
	return {
		state: toFileIndexState(w?.state),
		message: w?.message ?? null,
		warnings: w?.warnings ?? [],
	};
}

// There is no `fetchDocumentIndexStatus` here any more, and its absence is the
// point. `GET /api/spaces/:id/documents/:doc_id/index` is still mounted in Core (it
// is a documented single-document read, and the create responses are not the only
// way to ask), but this client has no reason to call it: the list route joins the
// same record onto every file row, so a surface that fanned out over N files to
// render N badges was paying N HTTP round trips for something one response already
// contains. Keeping the helper alongside the joined field would leave two ways to
// fill the same three document fields, which is how they drift apart.
