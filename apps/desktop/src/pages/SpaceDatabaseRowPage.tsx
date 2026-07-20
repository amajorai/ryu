import { LibraryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Checkbox } from "@ryu/ui/components/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";
import { getOptionColorClass } from "@ryu/ui/lib/data-grid";
import { cn } from "@ryu/ui/lib/utils";
import type { CellSelectOption } from "@ryu/ui/types/data-grid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import {
	useCurrentTabId,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type DatabaseSnapshot,
	useDatabaseCollab,
} from "@/src/lib/realtime/use-database-collab.ts";
import {
	applyCellEdits,
	type DatabaseDoc,
	type DbColumn,
	type DbRow,
	parseDatabaseDoc,
	setRowPageId,
} from "@/src/lib/realtime/yjs-database.ts";

const SAVE_DEBOUNCE_MS = 800;

/** Drop the reserved collaborative `__id` before serializing to JSON. */
function stripRowIds(rows: DbRow[]): DbRow[] {
	return rows.map(({ __id, ...rest }) => rest);
}

/** Colored option pills for a select / multi-select property. */
function OptionPills({
	options,
	selected,
	onToggle,
	readOnly,
}: {
	options: CellSelectOption[];
	selected: Set<string>;
	onToggle: (value: string) => void;
	readOnly: boolean;
}) {
	return (
		<div className="flex flex-wrap gap-1">
			{options.map((option) => {
				const isSelected = selected.has(option.value);
				return (
					<button
						className={cn(
							"rounded-full px-2 py-0.5 text-xs",
							isSelected
								? getOptionColorClass(option.color) || "bg-secondary"
								: "border text-muted-foreground hover:bg-accent"
						)}
						disabled={readOnly}
						key={option.value}
						onClick={() => onToggle(option.value)}
						type="button"
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

/** One editable property field, dispatched by the column's cell type. */
function PropertyField({
	column,
	value,
	readOnly,
	onChange,
}: {
	column: DbColumn;
	value: unknown;
	readOnly: boolean;
	onChange: (value: unknown) => void;
}) {
	const { cell } = column;
	if (cell.variant === "checkbox") {
		return (
			<Checkbox
				checked={value === true}
				disabled={readOnly}
				onCheckedChange={(checked) => onChange(checked === true)}
			/>
		);
	}
	if (cell.variant === "long-text") {
		return (
			<Textarea
				className="min-h-16"
				disabled={readOnly}
				onChange={(e) => onChange(e.target.value)}
				value={typeof value === "string" ? value : ""}
			/>
		);
	}
	if (cell.variant === "number") {
		return (
			<Input
				disabled={readOnly}
				onChange={(e) =>
					onChange(e.target.value === "" ? null : Number(e.target.value))
				}
				type="number"
				value={typeof value === "number" ? String(value) : ""}
			/>
		);
	}
	if (cell.variant === "date") {
		return (
			<Input
				disabled={readOnly}
				onChange={(e) => onChange(e.target.value || null)}
				type="date"
				value={typeof value === "string" ? value.slice(0, 10) : ""}
			/>
		);
	}
	if (cell.variant === "select") {
		const current = typeof value === "string" ? value : null;
		return (
			<OptionPills
				onToggle={(v) => onChange(current === v ? null : v)}
				options={cell.options}
				readOnly={readOnly}
				selected={new Set(current ? [current] : [])}
			/>
		);
	}
	if (cell.variant === "multi-select") {
		const current = Array.isArray(value) ? (value as string[]) : [];
		return (
			<OptionPills
				onToggle={(v) =>
					onChange(
						current.includes(v)
							? current.filter((x) => x !== v)
							: [...current, v]
					)
				}
				options={cell.options}
				readOnly={readOnly}
				selected={new Set(current)}
			/>
		);
	}
	// short-text / url / fallback
	return (
		<Input
			disabled={readOnly}
			onChange={(e) => onChange(e.target.value)}
			type={cell.variant === "url" ? "url" : "text"}
			value={typeof value === "string" ? value : ""}
		/>
	);
}

/**
 * A Notion-style database "row page": the row's columns rendered as an editable
 * properties panel (synced live through the database's CRDT room, exactly like
 * the grid) plus its own markdown body — a real child `kind:"page"` document
 * created on first open and embedded/searchable like any page. The first column
 * is the row's title.
 */
export default function SpaceDatabaseRowPage({
	spaceId,
	databaseId,
	rowId,
}: {
	spaceId: string;
	databaseId: string;
	rowId: string;
}) {
	const { getDocument, saveDocument, createPage } = useSpacesContext();
	const { updateTabTitle } = useTabsContext();
	const tabId = useCurrentTabId();
	const node = useActiveNode();

	const [dbLoaded, setDbLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [columns, setColumns] = useState<DbColumn[]>([]);
	const [row, setRow] = useState<DbRow | null>(null);

	const dbTitleRef = useRef("");
	const columnsRef = useRef<DbColumn[]>([]);
	const rowsRef = useRef<DbRow[]>([]);
	const dbTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Body (child page document) state.
	const [bodyDocId, setBodyDocId] = useState<string | null>(null);
	const [bodyInitial, setBodyInitial] = useState<string | null>(null);
	const bodyMarkdownRef = useRef("");
	const bodyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const bodyInitRef = useRef(false);

	// Load the database document (columns + rows) and find our row.
	useEffect(() => {
		let cancelled = false;
		getDocument(spaceId, databaseId)
			.then((doc) => {
				if (cancelled) {
					return;
				}
				const parsed = parseDatabaseDoc(doc.source);
				dbTitleRef.current = doc.title;
				columnsRef.current = parsed.columns;
				rowsRef.current = parsed.rows;
				setColumns(parsed.columns);
				setRow(parsed.rows.find((r) => r.__id === rowId) ?? null);
				setDbLoaded(true);
			})
			.catch((e) => {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : "Failed to load row");
				}
			});
		return () => {
			cancelled = true;
		};
	}, [getDocument, spaceId, databaseId, rowId]);

	const onSnapshot = useCallback(
		(snapshot: DatabaseSnapshot) => {
			columnsRef.current = snapshot.columns;
			rowsRef.current = snapshot.rows;
			setColumns(snapshot.columns);
			setRow(snapshot.rows.find((r) => r.__id === rowId) ?? null);
		},
		[rowId]
	);

	const getSeed = useCallback(
		(): DatabaseDoc => ({
			columns: columnsRef.current,
			rows: stripRowIds(rowsRef.current),
		}),
		[]
	);

	const { access, getCollabDoc } = useDatabaseCollab({
		roomId: databaseId,
		ready: dbLoaded,
		url: node.url,
		token: node.token ?? null,
		getSeed,
		onSnapshot,
	});
	const readOnly = access === "read";

	const scheduleDbSave = useCallback(() => {
		if (dbTimerRef.current) {
			clearTimeout(dbTimerRef.current);
		}
		dbTimerRef.current = setTimeout(() => {
			const source = JSON.stringify({
				columns: columnsRef.current,
				rows: stripRowIds(rowsRef.current),
			} satisfies DatabaseDoc);
			saveDocument(spaceId, databaseId, dbTitleRef.current, source).catch(
				() => {
					// Non-fatal: the embed engine may be down; local state is intact.
				}
			);
		}, SAVE_DEBOUNCE_MS);
	}, [saveDocument, spaceId, databaseId]);

	// Write one cell — live through the CRDT when collaborative, else local + save.
	const setCell = useCallback(
		(columnId: string, value: unknown) => {
			if (readOnly) {
				return;
			}
			const doc = getCollabDoc();
			if (doc) {
				applyCellEdits(doc, [{ rowId, columnId, value }]);
				return;
			}
			const nextRows = rowsRef.current.map((r) =>
				r.__id === rowId ? { ...r, [columnId]: value } : r
			);
			rowsRef.current = nextRows;
			setRow(nextRows.find((r) => r.__id === rowId) ?? null);
			scheduleDbSave();
		},
		[readOnly, getCollabDoc, rowId, scheduleDbSave]
	);

	const titleColumnId = columns[0]?.id;
	const titleValue =
		titleColumnId && row ? String(row[titleColumnId] ?? "") : "";

	// Resolve (or lazily create) the row's body page document, exactly once. Keyed
	// on [dbLoaded, rowId] (not `row`) and reading from refs, so a CRDT snapshot
	// arriving mid-creation can't cancel the in-flight create/fetch.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run-once; reads refs + stable fns.
	useEffect(() => {
		if (!dbLoaded || bodyInitRef.current) {
			return;
		}
		const target = rowsRef.current.find((r) => r.__id === rowId);
		if (!target) {
			return;
		}
		bodyInitRef.current = true;
		let cancelled = false;
		(async () => {
			try {
				let pageId =
					typeof target.__page === "string" && target.__page
						? target.__page
						: null;
				if (!pageId) {
					const nameColumnId = columnsRef.current[0]?.id;
					const name = nameColumnId ? String(target[nameColumnId] ?? "") : "";
					pageId = await createPage(spaceId, name || "Untitled", databaseId);
					const doc = getCollabDoc();
					if (doc) {
						setRowPageId(doc, rowId, pageId);
					} else {
						const nextRows = rowsRef.current.map((r) =>
							r.__id === rowId ? { ...r, __page: pageId ?? undefined } : r
						);
						rowsRef.current = nextRows;
						scheduleDbSave();
					}
				}
				const bodyDoc = await getDocument(spaceId, pageId);
				if (cancelled) {
					return;
				}
				bodyMarkdownRef.current = bodyDoc.source;
				setBodyDocId(pageId);
				setBodyInitial(bodyDoc.source);
			} catch {
				// Leave the body unmounted; properties still work.
				bodyInitRef.current = false;
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [dbLoaded, rowId]);

	const scheduleBodySave = useCallback(() => {
		if (bodyTimerRef.current) {
			clearTimeout(bodyTimerRef.current);
		}
		bodyTimerRef.current = setTimeout(() => {
			if (bodyDocId) {
				saveDocument(
					spaceId,
					bodyDocId,
					titleValue || "Untitled",
					bodyMarkdownRef.current
				).catch(() => {
					// Non-fatal (embed engine may be down).
				});
			}
		}, SAVE_DEBOUNCE_MS);
	}, [saveDocument, spaceId, bodyDocId, titleValue]);

	const onBodyChange = useCallback(
		(markdown: string) => {
			bodyMarkdownRef.current = markdown;
			scheduleBodySave();
		},
		[scheduleBodySave]
	);

	// Flush pending saves on unmount.
	useEffect(
		() => () => {
			if (dbTimerRef.current) {
				clearTimeout(dbTimerRef.current);
			}
			if (bodyTimerRef.current) {
				clearTimeout(bodyTimerRef.current);
			}
		},
		[]
	);

	const propertyColumns = useMemo(() => columns.slice(1), [columns]);

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LibraryIcon} />
					</EmptyMedia>
					<EmptyTitle>Could not open row</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	if (!dbLoaded) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (!row) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LibraryIcon} />
					</EmptyMedia>
					<EmptyTitle>Row not found</EmptyTitle>
					<EmptyDescription>This row may have been deleted.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-auto px-8 py-6">
				{/* Title = the first column (the row's "Name"). */}
				<Input
					aria-label="Row title"
					className="h-auto border-none bg-transparent px-0 font-semibold text-2xl shadow-none focus-visible:ring-0"
					disabled={readOnly || !titleColumnId}
					onChange={(e) => {
						if (titleColumnId) {
							setCell(titleColumnId, e.target.value);
						}
						if (tabId) {
							updateTabTitle(tabId, e.target.value || "Untitled");
						}
					}}
					placeholder="Untitled"
					value={titleValue}
				/>

				{propertyColumns.length > 0 && (
					<div className="mt-4 flex flex-col gap-2 border-b pb-4">
						{propertyColumns.map((column) => (
							<div className="flex items-start gap-3" key={column.id}>
								<span className="w-32 shrink-0 pt-1.5 text-muted-foreground text-sm">
									{column.label}
								</span>
								<div className="min-w-0 flex-1">
									<PropertyField
										column={column}
										onChange={(value) => setCell(column.id, value)}
										readOnly={readOnly}
										value={row[column.id]}
									/>
								</div>
							</div>
						))}
					</div>
				)}

				<div className="mt-4 min-h-0 flex-1">
					{bodyDocId && bodyInitial !== null ? (
						<MarkdownEditor
							initialMarkdown={bodyInitial}
							key={bodyDocId}
							onChangeMarkdown={onBodyChange}
						/>
					) : (
						<div className="flex items-center gap-2 text-muted-foreground text-sm">
							<Spinner className="size-4" /> Preparing page…
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
