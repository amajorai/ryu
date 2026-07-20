import { useCallback, useEffect, useState } from "react";
import { type ApiTarget, AppDisabledError } from "@/src/lib/api/client.ts";
import {
	createDatabase as apiCreateDatabase,
	createPage as apiCreatePage,
	createSpace as apiCreateSpace,
	createWhiteboard as apiCreateWhiteboard,
	deleteDocument as apiDeleteDocument,
	deleteSpace as apiDeleteSpace,
	ingestDocument as apiIngestDocument,
	searchSpace as apiSearchSpace,
	updateDocument as apiUpdateDocument,
	fetchDocument,
	fetchDocuments,
	fetchSpaces,
	type Space,
	type SpaceDocument,
	type SpaceDocumentContent,
	type SpaceMatch,
} from "@/src/lib/api/spaces.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import { useEntityCap } from "@/src/lib/gating/useEntityCap.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseSpacesResult {
	/** Set when Core refused the spaces routes because the Spaces App is disabled
	 *  (`503 app_disabled`). Carries the id to enable + the message. */
	appDisabled: { app: string; message: string } | null;
	create: (name: string, description: string | null) => Promise<void>;
	/** Create a new blank database (data grid); returns its document id. */
	createDatabase: (spaceId: string, title: string) => Promise<string>;
	/**
	 * Create a new blank markdown page; returns its document id. Pass `parentId`
	 * (a database id) to create a hidden database "row page".
	 */
	createPage: (
		spaceId: string,
		title: string,
		parentId?: string
	) => Promise<string>;
	/** Create a new blank whiteboard (Excalidraw); returns its document id. */
	createWhiteboard: (spaceId: string, title: string) => Promise<string>;
	error: string | null;
	/** Load a single page's full markdown source for editing. */
	getDocument: (
		spaceId: string,
		documentId: string
	) => Promise<SpaceDocumentContent>;
	ingest: (
		spaceId: string,
		title: string,
		content: string
	) => Promise<SpaceDocument[]>;
	listDocuments: (spaceId: string) => Promise<SpaceDocument[]>;
	loading: boolean;
	reload: () => Promise<void>;
	remove: (id: string) => Promise<void>;
	/** Delete a single page. */
	removeDocument: (spaceId: string, documentId: string) => Promise<boolean>;
	/** Persist a page's markdown (Core re-embeds on save). Callers debounce. */
	saveDocument: (
		spaceId: string,
		documentId: string,
		title: string,
		source: string
	) => Promise<void>;
	search: (spaceId: string, query: string) => Promise<SpaceMatch[]>;
	spaces: Space[];
}

/// Loads Spaces from the active Core node and exposes create/delete plus the
/// per-space document and search operations. Mutations keep the in-memory list
/// in sync so the UI reflects changes (e.g. document counts) without a manual
/// reload.
export function useSpaces(): UseSpacesResult {
	const activeNode = useActiveNode();
	const { url } = activeNode;
	const token = activeNode.token ?? null;

	const { guard } = useEntityCap();

	const [spaces, setSpaces] = useState<Space[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [appDisabled, setAppDisabled] = useState<{
		app: string;
		message: string;
	} | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		setAppDisabled(null);
		const target: ApiTarget = { url, token };
		try {
			setSpaces(await fetchSpaces(target));
		} catch (e) {
			// A disabled-app 503 is not a load failure — it has its own actionable
			// surface (the Enable prompt), so route it there instead of `error`.
			if (e instanceof AppDisabledError) {
				setAppDisabled({ app: e.app, message: e.message });
			} else {
				setError(e instanceof Error ? e.message : "Failed to load spaces");
			}
		} finally {
			setLoading(false);
		}
	}, [url, token]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	const create = useCallback(
		async (name: string, description: string | null) => {
			// Managed-path numeric cap (free tier). Blocks + opens the upgrade modal
			// when at the limit; a no-op off the managed path (self-host uncapped).
			if (!guard("maxSpaces", spaces.length)) {
				return;
			}
			await apiCreateSpace({ url, token }, name, description);
			await reload();
		},
		[url, token, reload, guard, spaces.length]
	);

	const remove = useCallback(
		async (id: string) => {
			await apiDeleteSpace({ url, token }, id);
			setSpaces((prev) => prev.filter((s) => s.id !== id));
		},
		[url, token]
	);

	const listDocuments = useCallback(
		(spaceId: string) => fetchDocuments({ url, token }, spaceId),
		[url, token]
	);

	const ingest = useCallback(
		async (spaceId: string, title: string, content: string) => {
			await apiIngestDocument({ url, token }, spaceId, title, content);
			// Refresh the list so the space's document count stays accurate.
			await reload();
			return fetchDocuments({ url, token }, spaceId);
		},
		[url, token, reload]
	);

	const search = useCallback(
		(spaceId: string, query: string) =>
			apiSearchSpace({ url, token }, spaceId, query),
		[url, token]
	);

	const createPage = useCallback(
		async (spaceId: string, title: string, parentId?: string) => {
			const id = await apiCreatePage({ url, token }, spaceId, title, parentId);
			// A parented "row page" is hidden from listings, so no reload is needed.
			if (!parentId) {
				await reload();
			}
			return id;
		},
		[url, token, reload]
	);

	const createDatabase = useCallback(
		async (spaceId: string, title: string) => {
			const id = await apiCreateDatabase({ url, token }, spaceId, title);
			await reload();
			return id;
		},
		[url, token, reload]
	);

	const createWhiteboard = useCallback(
		async (spaceId: string, title: string) => {
			const id = await apiCreateWhiteboard({ url, token }, spaceId, title);
			await reload();
			return id;
		},
		[url, token, reload]
	);

	const getDocument = useCallback(
		(spaceId: string, documentId: string) =>
			fetchDocument({ url, token }, spaceId, documentId),
		[url, token]
	);

	const saveDocument = useCallback(
		(spaceId: string, documentId: string, title: string, source: string) =>
			apiUpdateDocument({ url, token }, spaceId, documentId, title, source),
		[url, token]
	);

	const removeDocument = useCallback(
		async (spaceId: string, documentId: string) => {
			const removed = await apiDeleteDocument(
				{ url, token },
				spaceId,
				documentId
			);
			await reload();
			return removed;
		},
		[url, token, reload]
	);

	return {
		appDisabled,
		spaces,
		loading,
		error,
		reload,
		create,
		remove,
		listDocuments,
		ingest,
		search,
		createPage,
		createDatabase,
		createWhiteboard,
		getDocument,
		saveDocument,
		removeDocument,
	};
}
