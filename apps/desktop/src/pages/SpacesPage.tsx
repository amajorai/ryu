// apps/desktop/src/pages/SpacesPage.tsx
//
// Thin container for the desktop Spaces (RAG) page. Loads spaces via
// `useSpacesContext()`, owns the selected-space ingest/search/document state, and
// renders the shared presentational `SpacesView` (`@ryu/blocks/desktop/spaces`) —
// the same view the storyboard renders with mock data.

import {
	type SpacesDetailProps,
	SpacesView,
} from "@ryu/blocks/desktop/spaces.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppDisabledNotice } from "@/src/components/AppDisabledNotice.tsx";
import { BackupSettings } from "@/src/components/settings/BackupSettings.tsx";
import { SpaceImportsPanel } from "@/src/components/spaces/SpaceImportsPanel.tsx";
import { SpaceUploadPanel } from "@/src/components/spaces/SpaceUploadPanel.tsx";
import { SpaceWallpaperCover } from "@/src/components/spaces/SpaceWallpaperCover.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";
import {
	downloadSpacePackage,
	exportSpacePackage,
	importSpacePackage,
} from "@/src/lib/api/space-portable.ts";
import {
	describeRetrievalModeChange,
	type RetrievalMode,
	type RetrievalModeProgress,
	type SpaceDocument,
	type SpaceMatch,
} from "@/src/lib/api/spaces.ts";
import { WHITEBOARD_PLUGIN_ID } from "@/src/lib/whiteboard/app.ts";

/** URL segment for a document editor route, by kind: page → doc, database → db,
 * whiteboard → wb (matches the route patterns in `Layout.tsx`). */
function docSegment(kind: "page" | "database" | "whiteboard"): string {
	if (kind === "database") {
		return "db";
	}
	if (kind === "whiteboard") {
		return "wb";
	}
	return "doc";
}

export default function SpacesPage({
	initialSpaceId,
}: {
	/** When set (e.g. opening a specific Space from the Library), select this
	 * space on mount instead of defaulting to the first one. */
	initialSpaceId?: string;
}) {
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

	const handleSearch = async () => {
		if (!(selected && searchQuery.trim())) {
			return;
		}
		setSearchBusy(true);
		setSearchError(null);
		try {
			setSearchResults(await search(selected.id, searchQuery.trim()));
		} catch (err) {
			console.error("Space search failed", err);
			setSearchError("Search didn't work just now. Please try again.");
		} finally {
			setSearchBusy(false);
		}
	};

	const handleRetrievalModeChange = async (mode: RetrievalMode) => {
		// Guard on `retrievalModeBusy` as well as disabling the control: the rebuild
		// is an expensive background job, so a second call would queue another full
		// rebuild of the same space.
		if (!selected || retrievalModeBusy || selected.retrievalMode === mode) {
			return;
		}
		setRetrievalModeBusy(true);
		setRetrievalModeError(null);
		setRetrievalModeNotice(null);
		setRetrievalModeProgress(null);
		const controller = new AbortController();
		retrievalModeAbort.current = controller;
		try {
			setRetrievalModeNotice(
				describeRetrievalModeChange(
					await setRetrievalMode(selected.id, mode, {
						onProgress: setRetrievalModeProgress,
						signal: controller.signal,
					})
				)
			);
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				setRetrievalModeNotice(
					"The retrieval rebuild was cancelled. The space is unchanged."
				);
			} else {
				console.error("Failed to change retrieval mode", err);
				// The POST is accepted before polling begins. A lost/expired status can
				// therefore happen after Core committed the new mode, so refresh instead
				// of claiming the Space is unchanged.
				try {
					await reload();
				} catch (reloadError) {
					console.error(
						"Failed to refresh spaces after an indeterminate retrieval-mode change",
						reloadError
					);
				}
				setRetrievalModeError(
					"We couldn't confirm how the retrieval rebuild finished. Check the current mode, then try again if needed."
				);
			}
		} finally {
			retrievalModeAbort.current = null;
			setRetrievalModeBusy(false);
		}
	};

	const cancelRetrievalModeChange = () => {
		retrievalModeAbort.current?.abort();
	};

	// Open a document by its kind: databases use the data-grid editor route, pages
	// the markdown editor route. Falls back to the doc list to resolve the kind.
	const openDoc = (docId: string, docTitle: string) => {
		if (!selected) {
			return;
		}
		const doc = documents.find((d) => d.id === docId);
		// A Ryu-App-owned document (kind `app:<pluginId>`) opens in its owning app,
		// which needs the plugin id in the route: /spaces/:id/app/:pluginId/:docId.
		const rawKind = doc?.rawKind ?? "";
		if (rawKind.startsWith("app:")) {
			const pluginId = rawKind.slice("app:".length);
			openTab(`/spaces/${selected.id}/app/${pluginId}/${docId}`, {
				title: docTitle || "Untitled",
			});
			return;
		}
		if (rawKind === "file") {
			openTab(`/spaces/${selected.id}/file/${docId}`, {
				title: docTitle || "Untitled file",
			});
			return;
		}
		const kind = doc?.kind ?? "page";
		openTab(`/spaces/${selected.id}/${docSegment(kind)}/${docId}`, {
			title: docTitle || "Untitled",
		});
	};

	// Open a freshly created document by kind (its row may not be in `documents`
	// yet, so route explicitly rather than via `openDoc`'s lookup).
	const openCreated = (
		docId: string,
		kind: "page" | "database" | "whiteboard",
		docTitle: string
	) => {
		if (!selected) {
			return;
		}
		openTab(`/spaces/${selected.id}/${docSegment(kind)}/${docId}`, {
			title: docTitle || "Untitled",
		});
	};

	const handleNewPage = async () => {
		if (!selected) {
			return;
		}
		try {
			const id = await createPage(selected.id, "Untitled");
			await loadDocuments(selected.id);
			openCreated(id, "page", "Untitled");
		} catch (e) {
			console.error("Failed to create page", e);
			setDocsError("We couldn't create a new page. Please try again.");
		}
	};

	const handleNewDatabase = async () => {
		if (!selected) {
			return;
		}
		try {
			const id = await createDatabase(selected.id, "Untitled");
			await loadDocuments(selected.id);
			openCreated(id, "database", "Untitled");
		} catch (e) {
			console.error("Failed to create database", e);
			setDocsError("We couldn't create a new database. Please try again.");
		}
	};

	const handleNewWhiteboard = async () => {
		if (!selected) {
			return;
		}
		try {
			// The whiteboard is a Ryu App: create an app-owned Space document
			// (kind `app:@ryu/whiteboard`) through the app's `spaces:docs`
			// capability, then open it in the app's Companion. This REPLACES the
			// built-in `create_whiteboard` — one implementation, still a first-class
			// Space document (persisted, search-embedded, backlinked, versioned).
			// SAFETY: Core maps this exact spaces.createDoc method to spaces_create_doc; app_create_doc returns Rust Result<String>, the successful bridge serializes that ID into result, and pluginHostInvoke unwraps it after rejecting error responses.
			const docId = (await pluginHostInvoke(
				toTarget(node),
				WHITEBOARD_PLUGIN_ID,
				"spaces.createDoc",
				{ space_id: selected.id, title: "Untitled" }
			)) as string;
			await loadDocuments(selected.id);
			openTab(`/spaces/${selected.id}/app/${WHITEBOARD_PLUGIN_ID}/${docId}`, {
				title: "Untitled",
			});
		} catch (e) {
			console.error("Failed to create whiteboard", e);
			setDocsError("We couldn't create a new whiteboard. Please try again.");
		}
	};

	const handleImportCompleted = useCallback(() => {
		if (selected) {
			loadDocuments(selected.id).catch(() => undefined);
		}
	}, [loadDocuments, selected]);

	const handleExportPackage = useCallback(async () => {
		if (!selected) {
			return;
		}
		setPortableBusy(true);
		setPortableError(null);
		setPortableNotice(null);
		try {
			const exported = await exportSpacePackage(toTarget(node), selected.id);
			downloadSpacePackage(exported);
			setPortableNotice(
				"Exported " +
					exported.package.files.length +
					" source files. Embeddings were not included."
			);
		} catch (error) {
			setPortableError(
				error instanceof Error
					? error.message
					: "The Space package could not be exported."
			);
		} finally {
			setPortableBusy(false);
		}
	}, [node, selected]);

	const handleImportPackage = useCallback(
		async (file: File) => {
			setPortableBusy(true);
			setPortableError(null);
			setPortableNotice(null);
			try {
				const imported = await importSpacePackage(
					toTarget(node),
					new Uint8Array(await file.arrayBuffer())
				);
				await reload();
				setSelectedId(imported.spaceId);
				setPortableNotice(
					"Imported " +
						imported.pageCount +
						" pages and " +
						imported.databaseCount +
						" databases. Embeddings were not included; run the manual embedding re-index when you want RAG."
				);
			} catch (error) {
				setPortableError(
					error instanceof Error
						? error.message
						: "The Space package could not be imported."
				);
			} finally {
				setPortableBusy(false);
			}
		},
		[node, reload]
	);

	const detail: SpacesDetailProps | null = selected
		? {
				bannerSlot: (
					<SpaceWallpaperCover
						key={`${node.url}:${selected.id}`}
						spaceId={selected.id}
						target={nodeTarget}
					/>
				),
				backupPanel: (
					<BackupSettings
						key={`${node.url}:${selected.id}`}
						spaceId={selected.id}
						target={toTarget(node)}
					/>
				),
				space: {
					id: selected.id,
					name: selected.name,
					description: selected.description,
					documentCount: selected.documentCount,
					// The Retrieval card renders off THIS mapping, not the list one
					// below. Dropping it here hides the control silently.
					retrievalMode: selected.retrievalMode,
				},
				uploadPanel: (
					<SpaceUploadPanel
						onUploadComplete={() => {
							loadDocuments(selected.id).catch(() => undefined);
						}}
						spaceId={selected.id}
					/>
				),
				documents: documents.map((d) => ({
					byteSize: d.byteSize,
					id: d.id,
					title: d.title,
					chunkCount: d.chunkCount,
					kind: d.kind,
					mime: d.mime,
					preview: previewSources.get(d.id),
					previewLoading: previewLoadingIds.has(d.id),
					rawKind: d.rawKind,
					updatedAt: d.updatedAt,
					// Passed straight through, never derived. `d.kind` could not answer
					// this anyway (`toDocumentKind` coerces the wire's `'file'` to
					// `'page'`), but the deeper reason is that "is this file's text
					// searchable" is a fact about the `document.parse` capability that only
					// Core holds. `null` becomes `undefined` here, which the view reads as
					// "say nothing" and renders as the plain chunk count — the right
					// answer for a non-file row (Core omits `index` for pages, databases,
					// whiteboards and app documents) and for an older node.
					indexState: d.indexState ?? undefined,
					indexMessage: d.indexMessage,
					indexWarnings: d.indexWarnings,
				})),
				documentsError: docsError,
				importPanel: (
					<SpaceImportsPanel
						onImportCompleted={handleImportCompleted}
						onManageConnections={() => openTab("/store/connections")}
						onOpenDocument={(document) =>
							openCreated(document.id, document.kind, document.title)
						}
						spaceId={selected.id}
						target={toTarget(node)}
					/>
				),
				onExportPackage: () => {
					handleExportPackage().catch(() => undefined);
				},
				onImportPackage: (file) => {
					handleImportPackage(file).catch(() => undefined);
				},
				portableBusy,
				portableError,
				portableNotice,
				onNewPage: () => {
					handleNewPage().catch(() => undefined);
				},
				onNewDatabase: () => {
					handleNewDatabase().catch(() => undefined);
				},
				onNewWhiteboard: () => {
					handleNewWhiteboard().catch(() => undefined);
				},
				onOpenDoc: openDoc,
				onRetrievalModeChange: (mode) => {
					handleRetrievalModeChange(mode).catch(() => undefined);
				},
				onCancelRetrievalMode: cancelRetrievalModeChange,
				retrievalModeBusy,
				retrievalModeError,
				retrievalModeNotice,
				retrievalModeProgress,
				searchQuery,
				searchBusy,
				searchError,
				searchResults: searchResults
					? searchResults.map((m) => ({
							chunkId: m.chunkId,
							content: m.content,
						}))
					: null,
				onSearchQueryChange: setSearchQuery,
				onSearchSubmit: () => {
					handleSearch().catch(() => undefined);
				},
			}
		: null;

	// The Spaces App is turned off — Core 503s every /api/spaces route. Offer a
	// one-click Enable. Placed after all hooks so the early return never changes
	// hook order. `useSpaces` also auto-recovers on the global refresh `toggle`
	// fires, but an explicit reload keeps the transition immediate.
	if (appDisabled) {
		return (
			<AppDisabledNotice
				app={appDisabled.app}
				message={appDisabled.message}
				onEnabled={() => {
					reload().catch(() => undefined);
				}}
			/>
		);
	}

	return (
		<SpacesView
			detail={detail}
			error={error}
			loading={loading}
			onCreateSpace={() => openTab("/library/space", { title: "Spaces" })}
			onRetry={() => {
				reload().catch(() => undefined);
			}}
			onSelectSpace={setSelectedId}
			selectedId={selectedId}
			spaces={visibleSpaces.map((s) => ({
				id: s.id,
				name: s.name,
				description: s.description,
				documentCount: s.documentCount,
				retrievalMode: s.retrievalMode,
			}))}
		/>
	);
}
