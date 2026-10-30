import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { type ApiTarget, request } from "./client.ts";
import {
	documentContentWireResponseCodec,
	documentVersionWireResponseCodec,
	responseCodec8,
	responseCodec9,
	responseCodec10,
	responseCodec11,
	responseCodec13,
	responseCodec14,
	responseCodec15,
	responseCodec16,
	responseCodec17,
} from "./spaces-response-codecs.ts";
import { type DocumentKind, toDocumentKind } from "./spaces-types.ts";
import type { DocumentUpdateWireRequest } from "./spaces-wire-types.ts";

// apps/desktop/src/lib/api/spaces-documents.ts
//
// Document pages, databases and whiteboards: create, read, save, delete, versions. Split out of `spaces.ts`, which re-exports
// everything public here so its import path stays stable.

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
		},
		responseCodec8
	);
	return json.document_id;
}

/** Full editable content of a document (Notion-like page). */
export interface SpaceDocumentContent {
	chunkCount: number;
	/** Unix milliseconds. */
	createdAt: number;
	/** Notion-style glyph; null = kind default. */
	icon: GlyphValue;
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
	icon?: GlyphValue;
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
		icon: d.icon ?? null,
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
		{ method: "POST", body: { title, parent_id: parentId } },
		responseCodec9
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
		{ method: "POST", body: { title } },
		responseCodec10
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
		{ method: "POST", body: { title } },
		responseCodec11
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
		`/api/spaces/${spaceId}/documents/${documentId}`,
		undefined,
		documentContentWireResponseCodec
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
	source: string,
	guard?: { expectedRevision: number; operationId: string }
): Promise<DocumentWriteReceipt> {
	const body: DocumentUpdateWireRequest = { title, source };
	if (guard) {
		body.expected_revision = guard.expectedRevision;
		body.operation_id = guard.operationId;
	}
	const json = await request<{ result?: DocumentWriteReceiptWire }>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}`,
		{
			method: "PUT",
			body,
		},
		responseCodec13
	);
	return toDocumentWriteReceipt(json.result);
}

interface DocumentWriteReceiptWire {
	changed?: boolean;
	duplicate?: boolean;
	revision?: number;
	updated_at?: number;
	version_id?: string | null;
}

export interface DocumentWriteReceipt {
	changed: boolean;
	duplicate: boolean;
	revision: number;
	updatedAt: number;
	versionId: string | null;
}

function toDocumentWriteReceipt(
	value: DocumentWriteReceiptWire | undefined
): DocumentWriteReceipt {
	return {
		changed: value?.changed ?? false,
		duplicate: value?.duplicate ?? false,
		revision: value?.revision ?? 0,
		updatedAt: value?.updated_at ?? 0,
		versionId: value?.version_id ?? null,
	};
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
		{ method: "DELETE" },
		responseCodec14
	);
	return json?.removed ?? false;
}

// ── Document version history (server-backed) ────────────────────────────────

/** Metadata for one saved version of a document. */
export interface DocumentVersionMeta {
	captureType: string;
	/** Unix milliseconds. */
	createdAt: number;
	createdBy: string | null;
	documentId: string;
	granularity: string;
	id: string;
	kind: DocumentKind;
	label: string | null;
	revision: number;
	title: string;
	updatedAt: number;
}

interface DocumentVersionMetaWire {
	capture_type?: string;
	created_at: number;
	created_by?: string | null;
	document_id: string;
	granularity?: string;
	id: string;
	kind: DocumentKind;
	label?: string | null;
	revision?: number;
	title: string;
	updated_at?: number;
}

interface DocumentVersionWire extends DocumentVersionMetaWire {
	source: string;
}

function toDocumentVersionMeta(
	w: DocumentVersionMetaWire
): DocumentVersionMeta {
	return {
		captureType: w.capture_type ?? "manual",
		createdAt: w.created_at,
		createdBy: w.created_by ?? null,
		documentId: w.document_id,
		granularity: w.granularity ?? "exact",
		id: w.id,
		kind: w.kind,
		label: w.label ?? null,
		revision: w.revision ?? 0,
		title: w.title,
		updatedAt: w.updated_at ?? w.created_at,
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
		`/api/spaces/${spaceId}/documents/${documentId}/versions`,
		undefined,
		responseCodec15
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
		`/api/spaces/${spaceId}/documents/${documentId}/versions/${versionId}`,
		undefined,
		documentVersionWireResponseCodec
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
		{ method: "POST", body: label ? { label } : {} },
		responseCodec16
	);
}

/** Restore a version as the document's current content (undoable server-side). */
export async function restoreDocumentVersion(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	versionId: string,
	guard?: { expectedRevision: number; operationId: string }
): Promise<DocumentWriteReceipt> {
	const json = await request<{ result?: DocumentWriteReceiptWire }>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/versions/${versionId}/restore`,
		{
			method: "POST",
			body: guard
				? {
						expected_revision: guard.expectedRevision,
						operation_id: guard.operationId,
					}
				: undefined,
		},
		responseCodec17
	);
	return toDocumentWriteReceipt(json.result);
}
