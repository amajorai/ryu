import { toast } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTabTitleSync } from "@/src/components/layout/tab-rename.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import {
	useCurrentTabId,
	useTabSelector,
} from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { SpaceDatabaseQueryResult } from "@/src/lib/api/spaces.ts";
import {
	type DatabaseSnapshot,
	useDatabaseCollab,
} from "@/src/lib/realtime/use-database-collab.ts";
import {
	type DatabaseDoc,
	type DbColumn,
	type DbRow,
	type DbView,
	defaultView,
	newRowId,
	parseDatabaseDoc,
} from "@/src/lib/realtime/yjs-database.ts";
import {
	type ColumnEditorState,
	SAVE_DEBOUNCE_MS,
	type SaveState,
	stripRowIds,
} from "./SpaceDatabaseEditorPage.model.ts";

interface SpaceDatabaseDocumentInput {
	databaseId: string;
	spaceId: string;
}

/** Database loading, collaboration, debounced autosave, and tab title sync. */
export function useSpaceDatabaseDocument({
	databaseId,
	spaceId,
}: SpaceDatabaseDocumentInput) {
	const { getDocument, saveDocument } = useSpacesContext();
	const updateTabTitle = useTabSelector((state) => state.updateTabTitle);
	const openTab = useTabSelector((state) => state.openTab);
	const tabId = useCurrentTabId();
	const node = useActiveNode();
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [columns, setColumns] = useState<DbColumn[]>([]);
	const [rows, setRows] = useState<DbRow[]>([]);
	const [views, setViews] = useState<DbView[]>([]);
	const [activeViewId, setActiveViewId] = useState<string>("");
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const [columnEditor, setColumnEditor] = useState<ColumnEditorState>(null);
	const [queryOpen, setQueryOpen] = useState(false);
	const [queryText, setQueryText] = useState("SELECT * FROM data LIMIT 100");
	const [queryResult, setQueryResult] =
		useState<SpaceDatabaseQueryResult | null>(null);
	const [queryError, setQueryError] = useState<string | null>(null);
	const [queryRunning, setQueryRunning] = useState(false);
	// Bumped by the load-error Retry button to re-run the initial fetch.
	const [reloadNonce, setReloadNonce] = useState(0);
	// Latest unsaved values, read inside the debounced flush / grid callbacks
	// without re-arming effects or rebuilding callbacks.
	const titleRef = useRef("");
	const columnsRef = useRef<DbColumn[]>([]);
	const rowsRef = useRef<DbRow[]>([]);
	const viewsRef = useRef<DbView[]>([]);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		let cancelled = false;
		getDocument(spaceId, databaseId)
			.then((doc) => {
				if (cancelled) {
					return;
				}
				const parsed = parseDatabaseDoc(doc.source);
				// Give every row a stable in-memory `__id` (stripped again on save) so
				// the card views and `setCell` can address a row by id in BOTH the
				// collaborative and local paths, not just the collaborative snapshot.
				const seededRows = parsed.rows.map((row) => ({
					...row,
					__id: isNativeText(row.__id) ? row.__id : newRowId(),
				}));
				const seededViews =
					parsed.views && parsed.views.length > 0
						? parsed.views
						: [defaultView()];
				setTitle(doc.title);
				setColumns(parsed.columns);
				setRows(seededRows);
				setViews(seededViews);
				setActiveViewId(seededViews[0]?.id ?? "");
				titleRef.current = doc.title;
				columnsRef.current = parsed.columns;
				rowsRef.current = seededRows;
				viewsRef.current = seededViews;
				setLoaded(true);
			})
			.catch(() => {
				if (!cancelled) {
					setError(
						"We couldn't open this database. Check your connection and try again."
					);
				}
			});
		return () => {
			cancelled = true;
		};
		// `reloadNonce` is load-bearing: the "Try again" button only bumps it, so
		// without it the retry can never clear the error screen. Mirror of the same
		// restore in SpaceDocEditorPage — the two must move together.
	}, [getDocument, spaceId, databaseId, reloadNonce]);
	// Adopt a snapshot (first sync + every CRDT change) into refs + render state.
	const onSnapshot = useCallback((snapshot: DatabaseSnapshot) => {
		columnsRef.current = snapshot.columns;
		rowsRef.current = snapshot.rows;
		viewsRef.current = snapshot.views;
		setColumns(snapshot.columns);
		setRows(snapshot.rows);
		setViews(snapshot.views);
		// Keep the selection valid if the active view was deleted remotely.
		setActiveViewId((current) =>
			snapshot.views.some((view) => view.id === current)
				? current
				: (snapshot.views[0]?.id ?? "")
		);
	}, []);
	// Seed for a first-into-an-empty-room client: the loaded JSON (refs hold the
	// latest, capturing any edits made before the room synced).
	const getSeed = useCallback(
		(): DatabaseDoc => ({
			columns: columnsRef.current,
			rows: stripRowIds(rowsRef.current),
			views: viewsRef.current,
		}),
		[]
	);
	const {
		access,
		collaborative,
		getCollabDoc,
		status: collabStatus,
	} = useDatabaseCollab({
		roomId: databaseId,
		ready: loaded,
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
		getSeed,
		onSnapshot,
		onReset: () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			setLoaded(false);
			setReloadNonce((value) => value + 1);
		},
	});
	// A read-only collaborator's edits are dropped server-side (Core's write-ACL),
	// so the grid must refuse them locally too — otherwise an edit would appear to
	// apply, broadcast, get dropped, and vanish on reload (silent data loss).
	const readOnly = access === "read";
	const flush = useCallback(async () => {
		setSaveState("saving");
		// The source is derived from the current refs; in collaborative mode those
		// hold the live CRDT snapshot, so the PUT is a consistent checkpoint rather
		// than a partial/racey write.
		const source = JSON.stringify({
			columns: columnsRef.current,
			rows: collaborative ? stripRowIds(rowsRef.current) : rowsRef.current,
			views: viewsRef.current,
		} satisfies DatabaseDoc);
		try {
			await saveDocument(spaceId, databaseId, titleRef.current, source);
			setSaveState("saved");
			return true;
		} catch {
			setSaveState("error");
			toast.error(
				"Saved on this device. Some search features may be unavailable right now."
			);
			return false;
		}
	}, [collaborative, saveDocument, spaceId, databaseId]);
	const scheduleSave = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}
		setSaveState("saving");
		timerRef.current = setTimeout(() => {
			flush().catch(() => {
				// `flush` already surfaces failures via a toast; nothing to add here.
			});
		}, SAVE_DEBOUNCE_MS);
	}, [flush]);
	// A strip double-click rename only rewrites `tab.title`; converge this
	// editor's own title (and persist it through the normal save path) so the
	// page header and the server document follow the strip.
	useTabTitleSync({
		ready: loaded,
		scheduleSave,
		setTitle,
		tabId,
		titleRef,
	});
	// Flush a pending save when the tab unmounts so in-flight edits are not lost.
	useEffect(
		() => () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				flush().catch(() => {
					// Same as above — surfaced inside `flush`.
				});
			}
		},
		[flush]
	);
	return {
		activeViewId,
		collabStatus,
		collaborative,
		columnEditor,
		columns,
		columnsRef,
		error,
		flush,
		getCollabDoc,
		loaded,
		node,
		openTab,
		queryError,
		queryOpen,
		queryResult,
		queryRunning,
		queryText,
		readOnly,
		rows,
		rowsRef,
		saveState,
		scheduleSave,
		setActiveViewId,
		setColumnEditor,
		setColumns,
		setError,
		setQueryError,
		setQueryOpen,
		setQueryResult,
		setQueryRunning,
		setQueryText,
		setReloadNonce,
		setRows,
		setTitle,
		setViews,
		tabId,
		title,
		titleRef,
		updateTabTitle,
		views,
		viewsRef,
	};
}
