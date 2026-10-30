import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import type {
	RetrievalModeProgress,
	SpaceDocument,
	SpaceMatch,
} from "@/src/lib/api/spaces.ts";

interface SpacesPageDataInput {
	initialSpaceId: string | undefined;
}

/** Space selection, document, preview, search, and retrieval-mode state for the Spaces page. */
export function useSpacesPageData({ initialSpaceId }: SpacesPageDataInput) {
	const {
		appDisabled,
		spaces,
		loading,
		error,
		reload,
		listDocuments,
		getDocument,
		search,
		createPage,
		createDatabase,
		setRetrievalMode,
	} = useSpacesContext();
	const openTab = useTabSelector((state) => state.openTab);
	// Only the whiteboard create reaches the node directly (through the plugin host);
	// documents, previews, ingest and search all go through `useSpacesContext`, which
	// owns the target. No `nodeUrl`/`nodeToken` split is needed here.
	const node = useActiveNode();
	const nodeTarget = useMemo(
		() => toTarget(node),
		[node.url, node.token, node.userJwt]
	);
	const [selectedId, setSelectedId] = useState<string | null>(
		initialSpaceId ?? null
	);
	// Apply the requested initial space exactly once, as soon as it appears in the
	// loaded list (spaces may still be loading on mount).
	const initialApplied = useRef(false);
	// The "Meetings" system space is shown in the general Spaces list again (it is
	// its own dedicated space) in addition to the Meetings sidebar section. Canvas
	// stays hidden here because it has its own dedicated app surface.
	const visibleSpaces = spaces.filter((s) => s.name !== "Canvas");
	const selected = visibleSpaces.find((s) => s.id === selectedId) ?? null;
	// Selected-space detail state, hoisted out of the (now presentational) detail.
	const [documents, setDocuments] = useState<SpaceDocument[]>([]);
	const [docsError, setDocsError] = useState<string | null>(null);
	const [previewSources, setPreviewSources] = useState<Map<string, string>>(
		() => new Map()
	);
	const [previewLoadingIds, setPreviewLoadingIds] = useState<Set<string>>(
		() => new Set()
	);
	const previewSeq = useRef(0);
	const [portableBusy, setPortableBusy] = useState(false);
	const [portableError, setPortableError] = useState<string | null>(null);
	const [portableNotice, setPortableNotice] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SpaceMatch[] | null>(null);
	const [searchBusy, setSearchBusy] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [retrievalModeBusy, setRetrievalModeBusy] = useState(false);
	const [retrievalModeError, setRetrievalModeError] = useState<string | null>(
		null
	);
	const [retrievalModeNotice, setRetrievalModeNotice] = useState<string | null>(
		null
	);
	const [retrievalModeProgress, setRetrievalModeProgress] =
		useState<RetrievalModeProgress | null>(null);
	const retrievalModeAbort = useRef<AbortController | null>(null);
	// Select the requested space once it resolves in the loaded list.
	useEffect(() => {
		if (initialApplied.current || !initialSpaceId) {
			return;
		}
		if (visibleSpaces.some((s) => s.id === initialSpaceId)) {
			setSelectedId(initialSpaceId);
			initialApplied.current = true;
		}
	}, [initialSpaceId, visibleSpaces]);
	// Keep a valid selection as the list changes (create/delete/reload).
	useEffect(() => {
		if (visibleSpaces.length === 0) {
			setSelectedId(null);
			return;
		}
		if (!visibleSpaces.some((s) => s.id === selectedId)) {
			setSelectedId(visibleSpaces[0].id);
		}
	}, [visibleSpaces, selectedId]);
	// Bumped on every load so a list that resolves after the user has switched spaces
	// (or reloaded) is discarded instead of overwriting the current selection's rows.
	const loadSeq = useRef(0);
	// ── One request, badges included ────────────────────────────────────────────
	//
	// Whether each file's TEXT is searchable arrives on the list itself: Core joins
	// its per-document extraction record onto every `kind = 'file'` row of `GET
	// /api/spaces/:id/documents` (`space_file_index::attach_index_states`), so
	// `SpaceDocument.indexState` is populated by `fetchDocuments` and nothing else.
	//
	// This used to be a second pass — one `…/documents/:doc_id/index` request per
	// file row, batched eight at a time — because the status lived in a Core-side
	// store the list route did not read. Against the **Uploads** system space, which
	// collects every chat attachment and editor paste on the node and is nothing but
	// file rows, that was one round trip per row with no upper bound. The join
	// replaced it; re-introducing a per-row fetch here would restore the cost and
	// give the same three fields two writers.
	const loadDocuments = useCallback(
		async (spaceId: string) => {
			setDocsError(null);
			loadSeq.current += 1;
			const seq = loadSeq.current;
			let docs: SpaceDocument[];
			try {
				docs = await listDocuments(spaceId);
			} catch (e) {
				console.error("Failed to load space documents", e);
				setDocsError(
					"We couldn't load this space's documents. Please try again."
				);
				return;
			}
			if (seq !== loadSeq.current) {
				return;
			}
			setDocuments(docs);
		},
		[listDocuments]
	);
	// The home screen shows a small paper preview for the three most recent native
	// Markdown pages. Keep this read bounded: the list itself remains one request,
	// while the preview fetches are the same existing `getDocument` path used by the
	// editor and are never attempted for databases, files, boards, or app-owned docs.
	useEffect(() => {
		const pages = [...documents]
			.filter(
				(document) =>
					document.kind === "page" &&
					(document.rawKind === "" || document.rawKind === "page")
			)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 3);
		if (!selected || pages.length === 0) {
			setPreviewSources(new Map());
			setPreviewLoadingIds(new Set());
			return;
		}

		const seq = ++previewSeq.current;
		let cancelled = false;
		setPreviewSources(new Map());
		setPreviewLoadingIds(new Set(pages.map((page) => page.id)));

		const loadPreviews = async () => {
			const results = await Promise.allSettled(
				pages.map(async (page) => ({
					id: page.id,
					source: (await getDocument(selected.id, page.id)).source,
				}))
			);
			if (cancelled || seq !== previewSeq.current) {
				return;
			}
			const sources = new Map<string, string>();
			for (const result of results) {
				if (result.status === "fulfilled") {
					sources.set(result.value.id, result.value.source);
				}
			}
			setPreviewSources(sources);
			setPreviewLoadingIds(new Set());
		};
		void loadPreviews();

		return () => {
			cancelled = true;
		};
	}, [documents, getDocument, selected]);
	// Reset detail state when switching spaces, then load its documents.
	useEffect(() => {
		setDocuments([]);
		setSearchResults(null);
		setSearchQuery("");
		setSearchError(null);
		setPortableError(null);
		setPortableNotice(null);
		// The retrieval notice describes ONE space's rebuild. Carrying it across a
		// selection change would report another space's entity counts as this one's.
		setRetrievalModeError(null);
		setRetrievalModeNotice(null);
		if (selected) {
			loadDocuments(selected.id).catch(() => undefined);
		} else {
			setDocuments([]);
		}
	}, [selected, loadDocuments]);
	return {
		appDisabled,
		createDatabase,
		createPage,
		docsError,
		documents,
		error,
		loadDocuments,
		loading,
		node,
		nodeTarget,
		openTab,
		portableBusy,
		portableError,
		portableNotice,
		previewLoadingIds,
		previewSources,
		reload,
		retrievalModeAbort,
		retrievalModeBusy,
		retrievalModeError,
		retrievalModeNotice,
		retrievalModeProgress,
		search,
		searchBusy,
		searchError,
		searchQuery,
		searchResults,
		selected,
		selectedId,
		setDocsError,
		setPortableBusy,
		setPortableError,
		setPortableNotice,
		setRetrievalMode,
		setRetrievalModeBusy,
		setRetrievalModeError,
		setRetrievalModeNotice,
		setRetrievalModeProgress,
		setSearchBusy,
		setSearchError,
		setSearchQuery,
		setSearchResults,
		setSelectedId,
		visibleSpaces,
	};
}
