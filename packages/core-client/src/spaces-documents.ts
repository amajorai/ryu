// packages/core-client/src/spaces-documents.ts
//
// Documents and pages of a Space, split out of spaces.ts, which re-exports
// them. The space id and the document id go into the path through
// encodePathId (Core's own routes, not a mount).

import type { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";
import { encodePathId } from "./path-id.ts";
import {
	type SpaceDocument,
	spaceDeletedResponse,
	spaceDocumentContentResponse,
	spaceDocumentsResponse,
	spaceIngestResponse,
	spacePageResponse,
	toDocument,
} from "./spaces-types.ts";

/** Set or clear a document glyph without re-embedding. */
export async function setDocumentIcon(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	icon: unknown | null
): Promise<void> {
	await request(
		target,
		`/api/spaces/${encodePathId(spaceId)}/documents/${encodePathId(documentId)}/icon`,
		{
			method: "POST",
			body: { icon },
		},
		appResponseValueSchema
	);
}

/** List the documents in a Space. */
export async function fetchDocuments(
	target: ApiTarget,
	spaceId: string
): Promise<SpaceDocument[]> {
	const json = await request(
		target,
		`/api/spaces/${encodePathId(spaceId)}/documents`,
		{},
		spaceDocumentsResponse
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
	const json = await request(
		target,
		`/api/spaces/${encodePathId(spaceId)}/documents`,
		{
			method: "POST",
			body: { title, content },
		},
		spaceIngestResponse
	);
	return json.document_id;
}

/** Full editable content of a document (Notion-like page). */
export interface SpaceDocumentContent {
	chunkCount: number;
	/** Unix milliseconds. */
	createdAt: number;
	/** Notion-style glyph JSON (GlyphValue), when set. */
	icon: unknown | null;
	id: string;
	/** Canonical markdown source of the page. */
	source: string;
	spaceId: string;
	title: string;
	/** Unix milliseconds. */
	updatedAt: number;
}

type DocumentContentWire = z.output<typeof spaceDocumentContentResponse>;

function toDocumentContent(d: DocumentContentWire): SpaceDocumentContent {
	return {
		id: d.id,
		spaceId: d.space_id,
		title: d.title,
		source: d.source,
		createdAt: d.created_at,
		updatedAt: d.updated_at,
		chunkCount: d.chunk_count,
		icon: d.icon ?? null,
	};
}

/** Create a new blank markdown page in a Space. Returns the new document id. */
export async function createPage(
	target: ApiTarget,
	spaceId: string,
	title: string
): Promise<string> {
	const json = await request(
		target,
		`/api/spaces/${encodePathId(spaceId)}/pages`,
		{ method: "POST", body: { title } },
		spacePageResponse
	);
	return json.id;
}

/** Fetch a single document's full markdown source for editing. */
export async function fetchDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<SpaceDocumentContent> {
	const json = await request(
		target,
		`/api/spaces/${encodePathId(spaceId)}/documents/${encodePathId(documentId)}`,
		{},
		spaceDocumentContentResponse
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
	await request(
		target,
		`/api/spaces/${encodePathId(spaceId)}/documents/${encodePathId(documentId)}`,
		{
			method: "PUT",
			body: { title, source },
		},
		appResponseValueSchema
	);
}

/** Delete a single document (page) and its chunks/vectors. */
export async function deleteDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<boolean> {
	const json = await request(
		target,
		`/api/spaces/${encodePathId(spaceId)}/documents/${encodePathId(documentId)}`,
		{ method: "DELETE" },
		spaceDeletedResponse
	);
	return json?.removed ?? false;
}
