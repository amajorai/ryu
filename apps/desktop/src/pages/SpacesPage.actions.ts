import { useCallback } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";
import {
	downloadSpacePackage,
	exportSpacePackage,
	importSpacePackage,
} from "@/src/lib/api/space-portable.ts";
import { WHITEBOARD_PLUGIN_ID } from "@/src/lib/whiteboard/app.ts";
import type { useSpacesPageData } from "./SpacesPage.data.ts";
import { docSegment } from "./SpacesPage.routes.ts";

type SpacesPageActionsInput = Pick<
	ReturnType<typeof useSpacesPageData>,
	| "createDatabase"
	| "createPage"
	| "documents"
	| "loadDocuments"
	| "node"
	| "openTab"
	| "reload"
	| "retrievalModeAbort"
	| "search"
	| "searchQuery"
	| "selected"
	| "setDocsError"
	| "setPortableBusy"
	| "setPortableError"
	| "setPortableNotice"
	| "setSearchBusy"
	| "setSearchError"
	| "setSearchResults"
	| "setSelectedId"
>;

/** Search, retrieval-mode, document-creation, and package import/export handlers. */
export function useSpacesPageActions({
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
}: SpacesPageActionsInput) {
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
	return {
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
	};
}
