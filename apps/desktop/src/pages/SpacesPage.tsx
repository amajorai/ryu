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

import { AppDisabledNotice } from "@/src/components/AppDisabledNotice.tsx";
import { BackupSettings } from "@/src/components/settings/BackupSettings.tsx";
import { SpaceImportsPanel } from "@/src/components/spaces/SpaceImportsPanel.tsx";
import { SpaceUploadPanel } from "@/src/components/spaces/SpaceUploadPanel.tsx";
import { SpaceWallpaperCover } from "@/src/components/spaces/SpaceWallpaperCover.tsx";

import { toTarget } from "@/src/lib/api/client.ts";

import {
	describeRetrievalModeChange,
	type RetrievalMode,
} from "@/src/lib/api/spaces.ts";
import { useSpacesPageActions } from "./SpacesPage.actions.ts";
import { useSpacesPageData } from "./SpacesPage.data.ts";

export default function SpacesPage({
	initialSpaceId,
}: {
	/** When set (e.g. opening a specific Space from the Library), select this
	 * space on mount instead of defaulting to the first one. */
	initialSpaceId?: string;
}) {
	const {
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
	} = useSpacesPageData({ initialSpaceId });
	const {
		cancelRetrievalModeChange,
		handleExportPackage,
		handleImportCompleted,
		handleImportPackage,
		handleNewDatabase,
		handleNewPage,
		handleNewWhiteboard,
		handleSearch,
		openCreated,
		openDoc,
	} = useSpacesPageActions({
		createDatabase,
		createPage,
		documents,
		loadDocuments,
		node,
		openTab,
		reload,
		retrievalModeAbort,
		search,
		searchQuery,
		selected,
		setDocsError,
		setPortableBusy,
		setPortableError,
		setPortableNotice,
		setSearchBusy,
		setSearchError,
		setSearchResults,
		setSelectedId,
	});

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
