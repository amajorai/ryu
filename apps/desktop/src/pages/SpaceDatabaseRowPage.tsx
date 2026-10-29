import { LibraryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { jsonResponseValueSchema } from "@ryu/app-host/json-values";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { getOptionColorClass } from "@ryu/ui/lib/data-grid.ts";
import {
	computeFormulaColumns,
	isFormulaError,
} from "@ryu/ui/lib/data-grid-formula.ts";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CellSelectOption } from "@ryu/ui/types/data-grid.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import {
	useCurrentTabId,
	useTabSelector,
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
	type DbView,
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
						aria-pressed={isSelected}
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
	onChange: (
		value: Parameters<typeof applyCellEdits>[1][number]["value"]
	) => void;
}) {
	const { cell } = column;
	if (cell.variant === "formula") {
		return (
			<span
				className={cn(
					"block pt-1.5 text-sm",
					isFormulaError(value) && "text-destructive"
				)}
			>
				{isNativeBoolean(value)
					? String(value).toUpperCase()
					: String(value ?? "")}
			</span>
		);
	}
	if (cell.variant === "checkbox") {
		return (
			<Checkbox
				aria-label={column.label}
				checked={value === true}
				disabled={readOnly}
				onCheckedChange={(checked) => onChange(checked === true)}
			/>
		);
	}
	if (cell.variant === "long-text") {
		return (
			<Textarea
				aria-label={column.label}
				className="min-h-16"
				disabled={readOnly}
				onChange={(e) => onChange(e.target.value)}
				value={isNativeText(value) ? value : ""}
			/>
		);
	}
	if (cell.variant === "number") {
		return (
			<Input
				aria-label={column.label}
				disabled={readOnly}
				onChange={(e) =>
					onChange(e.target.value === "" ? null : Number(e.target.value))
				}
				type="number"
				value={isNativeNumber(value) ? String(value) : ""}
			/>
		);
	}
	if (cell.variant === "date") {
		return (
			<Input
				aria-label={column.label}
				disabled={readOnly}
				onChange={(e) => onChange(e.target.value || null)}
				type="date"
				value={isNativeText(value) ? value.slice(0, 10) : ""}
			/>
		);
	}
	if (cell.variant === "select") {
		const current = isNativeText(value) ? value : null;
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
		const current = z.array(z.string()).catch([]).parse(value);
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
			aria-label={column.label}
			disabled={readOnly}
			onChange={(e) => onChange(e.target.value)}
			type={cell.variant === "url" ? "url" : "text"}
			value={isNativeText(value) ? value : ""}
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
	const openTab = useTabSelector((state) => state.openTab);
	const updateTabTitle = useTabSelector((state) => state.updateTabTitle);
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
	const viewsRef = useRef<DbView[] | undefined>(undefined);
	const [dbSaveError, setDbSaveError] = useState<string | null>(null);
	const [savingDb, setSavingDb] = useState(false);

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
				viewsRef.current = parsed.views;
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
			viewsRef.current = snapshot.views;
			setColumns(snapshot.columns);
			setRow(snapshot.rows.find((r) => r.__id === rowId) ?? null);
		},
		[rowId]
	);

	const getSeed = useCallback(
		(): DatabaseDoc => ({
			columns: columnsRef.current,
			rows: stripRowIds(rowsRef.current),
			views: viewsRef.current,
		}),
		[]
	);

	const { access, getCollabDoc } = useDatabaseCollab({
		roomId: databaseId,
		ready: dbLoaded,
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
		getSeed,
		onSnapshot,
	});
	const readOnly = access === "read";

	const flushDb = useCallback(async () => {
		if (readOnly) {
			return;
		}
		if (dbTimerRef.current) {
			clearTimeout(dbTimerRef.current);
			dbTimerRef.current = null;
		}
		setSavingDb(true);
		const source = JSON.stringify({
			columns: columnsRef.current,
			rows: rowsRef.current,
			views: viewsRef.current,
		} satisfies DatabaseDoc);
		try {
			await saveDocument(spaceId, databaseId, dbTitleRef.current, source);
			setDbSaveError(null);
		} catch {
			setDbSaveError("Couldn't save row changes. Your edits are still here.");
		} finally {
			setSavingDb(false);
		}
	}, [readOnly, saveDocument, spaceId, databaseId]);

	const scheduleDbSave = useCallback(() => {
		if (dbTimerRef.current) {
			clearTimeout(dbTimerRef.current);
		}
		dbTimerRef.current = setTimeout(() => void flushDb(), SAVE_DEBOUNCE_MS);
	}, [flushDb]);

	// Write one cell — live through the CRDT when collaborative, else local + save.
	const setCell = useCallback(
		(
			columnId: string,
			value: Parameters<typeof applyCellEdits>[1][number]["value"]
		) => {
			const target = columns.find((column) => column.id === columnId);
			if (readOnly || target?.cell.variant === "formula") {
				return;
			}
			const doc = getCollabDoc();
			if (doc) {
				applyCellEdits(doc, [{ rowId, columnId, value }]);
				return;
			}
			const parsedValue = jsonResponseValueSchema.parse(value);
			const nextRows = rowsRef.current.map((r) =>
				r.__id === rowId ? { ...r, [columnId]: parsedValue } : r
			);
			rowsRef.current = nextRows;
			setRow(nextRows.find((r) => r.__id === rowId) ?? null);
			scheduleDbSave();
		},
		[readOnly, getCollabDoc, rowId, scheduleDbSave, columns]
	);

	// Formula columns are computed for display; storage keeps only the inputs.
	const displayRow = useMemo(
		() => (row ? (computeFormulaColumns([row], columns)[0] ?? row) : null),
		[row, columns]
	);

	const titleColumnId = columns[0]?.id;
	// A formula first property is computed, so the title shows it read-only.
	const titleIsFormula = columns[0]?.cell.variant === "formula";
	const titleValue =
		titleColumnId && displayRow ? String(displayRow[titleColumnId] ?? "") : "";

	// Resolve (or lazily create) the row's body page document, exactly once. Keyed
	// on [dbLoaded, rowId] (not `row`) and reading from refs, so a CRDT snapshot
	// arriving mid-creation can't cancel the in-flight create/fetch.
	// run-once; reads refs + stable fns.
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
					isNativeText(target.__page) && target.__page ? target.__page : null;
				if (!pageId) {
					if (readOnly) {
						return;
					}
					const nameColumnId = columnsRef.current[0]?.id;
					const named =
						computeFormulaColumns([target], columnsRef.current)[0] ?? target;
					const name = nameColumnId ? String(named[nameColumnId] ?? "") : "";
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
			if (readOnly) {
				return;
			}
			bodyMarkdownRef.current = markdown;
			scheduleBodySave();
		},
		[readOnly, scheduleBodySave]
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
				<EmptyContent>
					<Button
						onClick={() =>
							openTab(`/spaces/${spaceId}/db/${databaseId}`, {
								title: "Database",
							})
						}
						size="sm"
						variant="ghost"
					>
						Back to database
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	if (!dbLoaded) {
		return <SkeletonRows rows={6} spacing="library" />;
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
				<EmptyContent>
					<Button
						onClick={() =>
							openTab(`/spaces/${spaceId}/db/${databaseId}`, {
								title: "Database",
							})
						}
						size="sm"
						variant="ghost"
					>
						Back to database
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-auto px-8 py-6">
				{dbSaveError && (
					<div
						className="mb-3 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
						role="alert"
					>
						<span>{dbSaveError}</span>
						<Button
							disabled={savingDb || readOnly}
							onClick={() => void flushDb()}
							size="sm"
							variant="outline"
						>
							Retry save
						</Button>
					</div>
				)}
				{/* Title = the first column (the row's "Name"). */}
				<Input
					aria-label="Row title"
					disabled={readOnly || !titleColumnId || titleIsFormula}
					onChange={(e) => {
						if (titleColumnId) {
							setCell(titleColumnId, e.target.value);
						}
						if (tabId) {
							updateTabTitle(tabId, e.target.value || "Untitled");
						}
					}}
					placeholder="Untitled"
					purpose="space-row-title"
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
										value={displayRow?.[column.id]}
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
							readOnly={readOnly}
							toolbar="two-row"
						/>
					) : readOnly ? (
						<p className="text-muted-foreground text-sm">
							This row has no page yet.
						</p>
					) : (
						<SkeletonRows label="Preparing page…" spacing="comfortable" />
					)}
				</div>
			</div>
		</div>
	);
}
