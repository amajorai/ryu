// apps/desktop/src/pages/SpacesPage.tsx
//
// Thin container for the desktop Spaces (RAG) page. Loads spaces via
// `useSpacesContext()`, owns the selected-space ingest/search/document state, and
// renders the shared presentational `SpacesView` (`@ryu/blocks/desktop/spaces`) —
// the same view the storyboard renders with mock data.

import { type SpacesDetailProps, SpacesView } from "@ryu/blocks/desktop/spaces";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppDisabledNotice } from "@/src/components/AppDisabledNotice.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";
import type { SpaceDocument, SpaceMatch } from "@/src/lib/api/spaces.ts";
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
} = {}) {
	const {
		appDisabled,
		spaces,
		loading,
		error,
		reload,
		listDocuments,
		ingest,
		search,
		createPage,
		createDatabase,
	} = useSpacesContext();
	const { openTab } = useTabsContext();
	const node = useActiveNode();

	const [selectedId, setSelectedId] = useState<string | null>(
		initialSpaceId ?? null
	);
	// Apply the requested initial space exactly once, as soon as it appears in the
	// loaded list (spaces may still be loading on mount).
	const initialApplied = useRef(false);

	// The auto-created "Meetings" space is surfaced via the Meetings sidebar
	// section, so hide it from the general Spaces list (its docs are still
	// openable directly by id from a meeting's "Open notes").
	const visibleSpaces = spaces.filter(
		(s) => s.name !== "Meetings" && s.name !== "Canvas"
	);
	const selected = visibleSpaces.find((s) => s.id === selectedId) ?? null;

	// Selected-space detail state, hoisted out of the (now presentational) detail.
	const [documents, setDocuments] = useState<SpaceDocument[]>([]);
	const [docsError, setDocsError] = useState<string | null>(null);
	const [ingestTitle, setIngestTitle] = useState("");
	const [ingestContent, setIngestContent] = useState("");
	const [ingestBusy, setIngestBusy] = useState(false);
	const [ingestError, setIngestError] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SpaceMatch[] | null>(null);
	const [searchBusy, setSearchBusy] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);

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

	const loadDocuments = useCallback(
		async (spaceId: string) => {
			setDocsError(null);
			try {
				setDocuments(await listDocuments(spaceId));
			} catch (e) {
				console.error("Failed to load space documents", e);
				setDocsError(
					"We couldn't load this space's documents. Please try again."
				);
			}
		},
		[listDocuments]
	);

	// Reset detail state when switching spaces, then load its documents.
	useEffect(() => {
		setSearchResults(null);
		setSearchQuery("");
		setSearchError(null);
		setIngestTitle("");
		setIngestContent("");
		setIngestError(null);
		if (selected) {
			loadDocuments(selected.id).catch(() => undefined);
		} else {
			setDocuments([]);
		}
	}, [selected, loadDocuments]);

	const handleIngest = async () => {
		if (!(selected && ingestTitle.trim() && ingestContent.trim())) {
			return;
		}
		setIngestBusy(true);
		setIngestError(null);
		try {
			const docs = await ingest(selected.id, ingestTitle.trim(), ingestContent);
			setDocuments(docs);
			setIngestTitle("");
			setIngestContent("");
		} catch (err) {
			console.error("Failed to add space document", err);
			setIngestError("We couldn't add that document. Please try again.");
		} finally {
			setIngestBusy(false);
		}
	};

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
			// (kind `app:com.ryu.whiteboard`) through the app's `spaces:docs`
			// capability, then open it in the app's Companion. This REPLACES the
			// built-in `create_whiteboard` — one implementation, still a first-class
			// Space document (persisted, search-embedded, backlinked, versioned).
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

	const detail: SpacesDetailProps | null = selected
		? {
				space: {
					id: selected.id,
					name: selected.name,
					description: selected.description,
					documentCount: selected.documentCount,
				},
				documents: documents.map((d) => ({
					id: d.id,
					title: d.title,
					chunkCount: d.chunkCount,
					kind: d.kind,
				})),
				documentsError: docsError,
				ingestTitle,
				ingestContent,
				ingestBusy,
				ingestError,
				onIngestTitleChange: setIngestTitle,
				onIngestContentChange: setIngestContent,
				onIngestSubmit: () => {
					handleIngest().catch(() => undefined);
				},
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
			onSelectSpace={setSelectedId}
			selectedId={selectedId}
			spaces={visibleSpaces.map((s) => ({
				id: s.id,
				name: s.name,
				description: s.description,
				documentCount: s.documentCount,
			}))}
		/>
	);
}
