import type { ReactNode } from "react";
import type { SpaceFileIndexState } from "./spaces-index-state.ts";
import type { SpaceRetrievalMode } from "./spaces-retrieval.tsx";

/** A space row as the view needs it. */
export interface SpaceRow {
	description?: string | null;
	documentCount: number;
	id: string;
	name: string;
	/** Optional: surfaces that do not know a Space's mode (the storyboard's mock
	 *  data) omit it, and the detail's Retrieval card then does not render at all
	 *  rather than assert a default it has not been told. */
	retrievalMode?: SpaceRetrievalMode;
}

export interface SpaceDocumentRow {
	byteSize?: number | null;
	chunkCount: number;
	id: string;
	/**
	 * Why this file's text is not searchable, when the state is `failed`. Rendered as
	 * a second line on the row, because a retry the user cannot diagnose is a retry
	 * they will make twice. Core guarantees this is never the document's contents.
	 */
	indexMessage?: string | null;
	/**
	 * What happened to this document's **contents**.
	 *
	 * `undefined` is the important value and the default: it means *this surface has
	 * not been told*, and it renders exactly as the list always did — the chunk
	 * count, no searchability claim either way. That is the standing answer for a
	 * page, database, whiteboard or app document, which is chunked from its own
	 * source on every save: `GET /api/spaces/:id/documents` attaches the extraction
	 * record to `kind = 'file'` rows and deliberately omits it everywhere else, so
	 * those rows arrive here undefined and stay silent. The storyboard's mock rows
	 * omit it for the same reason — nothing has told them either.
	 *
	 * A real FILE row is told: the state arrives on the list response itself (see
	 * `DocumentWire` in `apps/desktop/src/lib/api/spaces.ts`), so the badges render
	 * from the same request that renders the filenames rather than from a per-row
	 * follow-up.
	 *
	 * Silence is the right default rather than a stub, because the alternative is a
	 * guess. There is no client-side derivation of this: "it is a file, therefore its
	 * contents are not searchable" was true only until Core started extracting, and
	 * is now wrong for every `.txt`/`.md`/`.csv` — those go through Core's in-process
	 * floor and are `indexed` before the upload response is written.
	 *
	 * A state rather than a boolean because the three not-searchable states carry
	 * three different user actions; see {@link FILE_INDEX_NOTES}.
	 */
	indexState?: SpaceFileIndexState;
	/**
	 * Non-fatal notes from a parse that DID work — a lossy decode, a missing OCR
	 * tool, a truncated result. Rendered on `indexed` rows, which is the only place
	 * they can appear: a degraded parse whose result is searchable but incomplete is
	 * otherwise indistinguishable from a clean one.
	 */
	indexWarnings?: string[];
	/** `"page"` (markdown), `"database"` (data grid), or `"whiteboard"`
	 * (Excalidraw scene). Defaults to a page. */
	kind?: "page" | "database" | "whiteboard";
	mime?: string | null;
	preview?: string;
	previewLoading?: boolean;
	rawKind?: string;
	title: string;
	updatedAt?: number;
}

export interface SpaceMatchRow {
	chunkId: string;
	content: string;
}

export interface SpacesDetailProps {
	backupPanel?: ReactNode;
	/** Node-scoped Marketplace cover controls owned by the desktop host. */
	bannerSlot?: ReactNode;
	documents: SpaceDocumentRow[];
	documentsError?: string | null;
	/** Desktop-owned import workflow. Shared renderers omit it and keep one Content view. */
	importPanel?: ReactNode;
	/** Omit (together with `space.retrievalMode`) to hide the Retrieval card. */
	onCancelRetrievalMode?: () => void;
	/** Portable Markdown package controls owned by the desktop container. */
	onExportPackage?: () => void;
	onImportPackage?: (file: File) => void;
	onNewDatabase?: () => void;
	onNewPage?: () => void;
	onNewWhiteboard?: () => void;
	onOpenDoc?: (docId: string, title: string) => void;
	onRetrievalModeChange?: (mode: SpaceRetrievalMode) => void;
	onSearchQueryChange?: (value: string) => void;
	onSearchSubmit?: () => void;
	portableBusy?: boolean;
	portableError?: string | null;
	portableNotice?: string | null;
	/** True while Core's background rebuild is running. The picker stays disabled
	 *  while polling so a second click cannot queue another full rebuild. */
	retrievalModeBusy?: boolean;
	retrievalModeError?: string | null;
	/** What the last switch actually did (entity/connection counts), so the result
	 *  is reported rather than assumed. */
	retrievalModeNotice?: string | null;
	retrievalModeProgress?: {
		processedChunks: number;
		totalChunks: number;
	} | null;
	searchBusy?: boolean;
	searchError?: string | null;
	// Search
	searchQuery: string;
	searchResults?: SpaceMatchRow[] | null;
	space: SpaceRow;
	/** Desktop-owned file upload flow. The host wires this to the node's extraction path. */
	uploadPanel?: ReactNode;
}

export interface SpacesViewProps {
	/** Detail props for the selected space (driven by the container). */
	detail?: SpacesDetailProps | null;
	error?: string | null;
	loading?: boolean;
	onCreateSpace?: () => void;
	onRetry?: () => void;
	onSelectSpace?: (id: string) => void;
	selectedId?: string | null;
	spaces: SpaceRow[];
}
