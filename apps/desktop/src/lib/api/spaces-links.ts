import { type ApiTarget, request } from "./client.ts";
import {
	docGraphWireResponseCodec,
	responseCodec21,
	responseCodec22,
} from "./spaces-response-codecs.ts";

// apps/desktop/src/lib/api/spaces-links.ts
//
// Wiki page-links between documents: backlinks and the link graph. Split out of `spaces.ts`, which re-exports
// everything public here so its import path stays stable.

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
		`/api/spaces/${spaceId}/documents/${documentId}/backlinks`,
		undefined,
		responseCodec21
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
		`/api/spaces/${spaceId}/documents/${documentId}/links`,
		undefined,
		responseCodec22
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
		`/api/spaces/${spaceId}/graph`,
		undefined,
		docGraphWireResponseCodec
	);
	return toDocGraph(json);
}

/** The global document-link graph across every Space. */
export async function fetchGlobalGraph(target: ApiTarget): Promise<DocGraph> {
	const json = await request<DocGraphWire>(
		target,
		"/api/graph",
		undefined,
		docGraphWireResponseCodec
	);
	return toDocGraph(json);
}
