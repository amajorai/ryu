import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BoardView } from "../../src/components/spaces/views/BoardView.tsx";
import { GalleryView } from "../../src/components/spaces/views/GalleryView.tsx";
import { ListView } from "../../src/components/spaces/views/ListView.tsx";
import { ViewBar } from "../../src/components/spaces/views/ViewBar.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import { fetchDocument, updateDocument } from "../../src/lib/api/spaces.ts";
import {
	type DatabaseDoc,
	type DbColumn,
	type DbView,
	type DbViewKind,
	newViewId,
	parseDatabaseDoc,
} from "../../src/lib/realtime/yjs-database.ts";
import { parseProofJsonRecord } from "../fixture-json.ts";
import "../../src/index.css";

interface ViewBarProofWindow extends Window {
	__viewBarProof: {
		failNextSave: () => void;
		snapshot: () => {
			activeViewId: string;
			calls: CapturedCall[];
			database: DatabaseDoc;
			persisted: PersistedDocument;
			saveError: string | null;
			saveStatus: string;
		};
	};
}
declare const window: ViewBarProofWindow;

const SPACE_ID = "view-bar-proof-space";
const DOCUMENT_ID = "view-bar-proof-database";
const STORAGE_KEY = "ryu:view-bar-proof:document";
const FIXED_TIME = 1_790_006_400_000;
const TARGET: ApiTarget = {
	token: null,
	url: window.location.origin,
	userJwt: null,
};

const INITIAL_COLUMNS: DbColumn[] = [
	{ cell: { variant: "short-text" }, id: "name", label: "Name" },
	{
		cell: {
			options: [
				{ color: "gray", label: "Planned", value: "planned" },
				{ color: "blue", label: "In progress", value: "in-progress" },
				{ color: "green", label: "Done", value: "done" },
			],
			variant: "select",
		},
		id: "status",
		label: "Status",
	},
	{
		cell: {
			options: [
				{ color: "purple", label: "Design", value: "design" },
				{ color: "blue", label: "Release", value: "release" },
				{ color: "red", label: "Urgent", value: "urgent" },
			],
			variant: "multi-select",
		},
		id: "tags",
		label: "Tags",
	},
];

const INITIAL_DATABASE: DatabaseDoc = {
	columns: INITIAL_COLUMNS,
	rows: [
		{ name: "Atlas", status: "in-progress", tags: ["design"] },
		{ name: "Beacon", status: "done", tags: ["release", "urgent"] },
	],
	views: [
		{ id: "view_table", kind: "table", name: "All records" },
		{
			groupByColumnId: "status",
			id: "view_board",
			kind: "board",
			name: "By status",
		},
	],
};

interface PersistedDocument {
	source: string;
	title: string;
}

interface CapturedCall {
	body: unknown;
	method: string;
	path: string;
}

function databaseSource(database: DatabaseDoc): string {
	return JSON.stringify({
		columns: database.columns,
		rows: database.rows.map(({ __id, ...row }) => row),
		views: database.views ?? [],
	} satisfies DatabaseDoc);
}

function initialPersistedDocument(): PersistedDocument {
	return { source: JSON.stringify(INITIAL_DATABASE), title: "Product roadmap" };
}

function readPersistedDocument(): PersistedDocument {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (isNativeText(parsed.title) && isNativeText(parsed.source)) {
				return { source: parsed.source, title: parsed.title };
			}
		}
	} catch {
		// An isolated proof always recovers to the known database document.
	}
	return initialPersistedDocument();
}

function jsonResponse<FixturePayload>(
	value: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function readBody(value: BodyInit | null | undefined) {
	if (!isNativeText(value)) {
		return null;
	}
	try {
		return parseProofJsonRecord(value);
	} catch {
		return null;
	}
}

const calls: CapturedCall[] = [];
let failNextSave = false;
const originalFetch = globalThis.fetch.bind(globalThis);
window.__viewBarProof = {
	failNextSave: () => {
		failNextSave = true;
	},
	snapshot: () => ({
		activeViewId: "",
		calls: [...calls],
		database: parseDatabaseDoc(readPersistedDocument().source),
		persisted: readPersistedDocument(),
		saveError: null,
		saveStatus: "Loading database…",
	}),
};

window.fetch = async (input, init) => {
	const url = new URL(
		input instanceof Request ? input.url : String(input),
		window.location.origin
	);
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	const documentPath = `/api/spaces/${SPACE_ID}/documents/${DOCUMENT_ID}`;
	if (url.pathname !== documentPath) {
		return originalFetch(input, init);
	}

	const body = readBody(init?.body);
	calls.push({ body, method, path: url.pathname });
	if (method === "GET") {
		const document = readPersistedDocument();
		return jsonResponse({
			chunk_count: 0,
			created_at: FIXED_TIME,
			id: DOCUMENT_ID,
			kind: "database",
			source: document.source,
			space_id: SPACE_ID,
			title: document.title,
			updated_at: FIXED_TIME,
		});
	}
	if (method === "PUT") {
		if (failNextSave) {
			failNextSave = false;
			return jsonResponse({ error: "view_fixture_write_failed" }, 503);
		}
		const update = body ?? {};
		if (!(isNativeText(update.title) && isNativeText(update.source))) {
			return jsonResponse({ error: "Expected title and source." }, 400);
		}
		const persisted = { title: update.title, source: update.source };
		localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
		return jsonResponse({
			result: {
				changed: true,
				duplicate: false,
				revision: calls.filter((call) => call.method === "PUT").length,
				updated_at: FIXED_TIME,
				version_id: "view-bar-proof-version",
			},
		});
	}
	return jsonResponse({ error: "Method not allowed." }, 405);
};

function withLocalRowIds(database: DatabaseDoc): DatabaseDoc {
	return {
		...database,
		rows: database.rows.map((row, index) => ({
			...row,
			__id: isNativeText(row.__id) ? row.__id : `row-${index + 1}`,
		})),
		views:
			database.views && database.views.length > 0
				? database.views
				: [{ id: "view_table", kind: "table", name: "Table" }],
	};
}

function defaultViewName(kind: DbViewKind): string {
	switch (kind) {
		case "board":
			return "Board";
		case "gallery":
			return "Gallery";
		case "list":
			return "List";
		default:
			return "Table";
	}
}

function ViewBarProof() {
	const [database, setDatabase] = useState<DatabaseDoc | null>(null);
	const [title, setTitle] = useState("Product roadmap");
	const [activeViewId, setActiveViewId] = useState("");
	const [saveStatus, setSaveStatus] = useState("Loading database…");
	const [saveError, setSaveError] = useState<string | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const databaseRef = useRef<DatabaseDoc>(INITIAL_DATABASE);
	const titleRef = useRef(title);
	const readOnly =
		new URLSearchParams(window.location.search).get("readOnly") === "true";
	const noSelect =
		new URLSearchParams(window.location.search).get("noSelect") === "true";
	const columns = noSelect
		? INITIAL_COLUMNS.filter((column) => column.cell.variant === "short-text")
		: INITIAL_COLUMNS;

	const flush = useCallback(async () => {
		const source = databaseSource(databaseRef.current);
		setSaveStatus("Saving…");
		try {
			await updateDocument(
				TARGET,
				SPACE_ID,
				DOCUMENT_ID,
				titleRef.current,
				source
			);
			setSaveStatus("Saved");
			setSaveError(null);
		} catch (error) {
			setSaveStatus("Saved on this device");
			setSaveError(
				error instanceof Error ? error.message : "Could not save this database."
			);
		}
	}, []);

	const scheduleSave = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}
		setSaveStatus("Saving…");
		setSaveError(null);
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			void flush();
		}, 800);
	}, [flush]);

	useEffect(() => {
		let cancelled = false;
		void fetchDocument(TARGET, SPACE_ID, DOCUMENT_ID)
			.then((document) => {
				if (cancelled) {
					return;
				}
				const next = withLocalRowIds(parseDatabaseDoc(document.source));
				databaseRef.current = next;
				setDatabase(next);
				setTitle(document.title);
				titleRef.current = document.title;
				setActiveViewId(next.views?.[0]?.id ?? "");
				setSaveStatus("Saved");
			})
			.catch((error) => {
				if (!cancelled) {
					setSaveError(
						error instanceof Error
							? error.message
							: "Could not load this database."
					);
					setSaveStatus("Could not load database");
				}
			});
		return () => {
			cancelled = true;
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		};
	}, []);

	window.__viewBarProof.snapshot = () => ({
		activeViewId,
		calls: [...calls],
		database: databaseRef.current,
		persisted: readPersistedDocument(),
		saveError,
		saveStatus,
	});

	const applyDatabase = (next: DatabaseDoc) => {
		databaseRef.current = next;
		setDatabase(next);
		scheduleSave();
	};
	const addView = (kind: DbViewKind) => {
		if (readOnly) {
			return;
		}
		const view = { id: newViewId(), kind, name: defaultViewName(kind) };
		const current = databaseRef.current;
		applyDatabase({
			...current,
			views: [...(current.views ?? []), view],
		});
		setActiveViewId(view.id);
	};
	const updateView = (
		viewId: string,
		patch: {
			name?: string;
			kind?: DbViewKind;
			groupByColumnId?: string | null;
		}
	) => {
		if (readOnly) {
			return;
		}
		const current = databaseRef.current;
		const views = (current.views ?? []).map((view) => {
			if (view.id !== viewId) {
				return view;
			}
			const next: DbView = { ...view };
			if (patch.name !== undefined) {
				next.name = patch.name;
			}
			if (patch.kind !== undefined) {
				next.kind = patch.kind;
			}
			if (patch.groupByColumnId !== undefined) {
				if (patch.groupByColumnId) {
					next.groupByColumnId = patch.groupByColumnId;
				} else {
					next.groupByColumnId = undefined;
				}
			}
			return next;
		});
		applyDatabase({ ...current, views });
	};
	const removeView = (viewId: string) => {
		if (readOnly || (databaseRef.current.views?.length ?? 0) <= 1) {
			return;
		}
		const remaining = (databaseRef.current.views ?? []).filter(
			(view) => view.id !== viewId
		);
		applyDatabase({ ...databaseRef.current, views: remaining });
		setActiveViewId((current) =>
			current === viewId ? (remaining[0]?.id ?? "") : current
		);
	};

	const views = database?.views ?? [];
	const activeView = views.find((view) => view.id === activeViewId) ?? views[0];
	if (!(database && activeView)) {
		return (
			<main className="min-h-screen bg-background p-8 text-foreground">
				<p data-testid="save-status">{saveStatus}</p>
				{saveError ? <p role="alert">{saveError}</p> : null}
			</main>
		);
	}

	return (
		<main className="flex min-h-screen flex-col bg-background text-foreground">
			<header className="flex items-center justify-between border-b px-4 py-3">
				<div>
					<h1 className="font-semibold text-lg">Database view controls</h1>
					<p className="text-muted-foreground text-xs">{title}</p>
				</div>
				<p data-testid="save-status" role="status">
					{saveStatus}
				</p>
			</header>
			<ViewBar
				activeViewId={activeView.id}
				columns={columns}
				onAddView={addView}
				onRemoveView={removeView}
				onSelect={setActiveViewId}
				onUpdateView={updateView}
				readOnly={readOnly}
				views={views}
			/>
			{saveError ? (
				<p className="px-4 py-2 text-destructive text-sm" role="alert">
					{saveError}
				</p>
			) : null}
			<section
				aria-label="Database view content"
				className="min-h-0 flex-1 overflow-hidden"
			>
				<div className="flex items-center gap-2 border-b px-4 py-2">
					<h2 className="font-medium text-sm" data-testid="active-view-heading">
						{activeView.name}
					</h2>
					<span className="text-muted-foreground text-xs">
						{activeView.kind}
					</span>
				</div>
				{activeView.kind === "board" ? (
					<BoardView
						columns={columns}
						createRow={() => undefined}
						groupByColumnId={activeView.groupByColumnId}
						onOpenRow={() => undefined}
						readOnly={readOnly}
						rows={database.rows}
						setCell={() => undefined}
					/>
				) : activeView.kind === "gallery" ? (
					<GalleryView
						columns={columns}
						createRow={() => undefined}
						onOpenRow={() => undefined}
						readOnly={readOnly}
						rows={database.rows}
					/>
				) : activeView.kind === "list" ? (
					<ListView
						columns={columns}
						createRow={() => undefined}
						onOpenRow={() => undefined}
						readOnly={readOnly}
						rows={database.rows}
					/>
				) : (
					<div className="p-4 text-muted-foreground text-sm">
						Table view · {database.rows.length} records
					</div>
				)}
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("ViewBar proof root not found");
}
createRoot(root).render(<ViewBarProof />);
