import { Add01Icon, LibraryIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { DataGrid } from "@ryu/ui/components/data-grid/data-grid.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Input } from "@ryu/ui/components/input.tsx";

import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";

import { z } from "zod";

import { ColumnEditor } from "@/src/components/spaces/ColumnEditor.tsx";
import { BoardView } from "@/src/components/spaces/views/BoardView.tsx";
import { GalleryView } from "@/src/components/spaces/views/GalleryView.tsx";
import { ListView } from "@/src/components/spaces/views/ListView.tsx";
import { ViewBar } from "@/src/components/spaces/views/ViewBar.tsx";

import { toTarget } from "@/src/lib/api/client.ts";
import { querySpaceDatabase } from "@/src/lib/api/spaces.ts";
import { useSpaceDatabaseDocument } from "./SpaceDatabaseEditorPage.document.ts";
import {
	DEFAULT_GRID_HEIGHT,
	SAVE_LABEL,
} from "./SpaceDatabaseEditorPage.model.ts";
import { useSpaceDatabaseRowsAndColumns } from "./SpaceDatabaseEditorPage.rows.ts";
import { useSpaceDatabaseViews } from "./SpaceDatabaseEditorPage.views.tsx";

/**
 * A Notion-style database editor backed by a CRDT. The grid is modelled as Yjs
 * shared types over a {@link useDatabaseCollab} room (a `kind:"document"` realtime
 * room keyed by the database id), so two clients editing the same database
 * converge: edits to different cells merge, same-cell is last-writer-wins, and
 * concurrent row appends order deterministically (see `yjs-database.ts`).
 *
 * Persistence split:
 *  - NON-collaborative (no/unreachable node): the grid keeps its original
 *    behaviour — local state + a debounced full-JSON `PUT` that re-embeds in Core.
 *  - COLLABORATIVE (room synced): cell/row/column edits route to the Yjs doc (Core
 *    persists the CRDT and rebroadcasts). The per-edit full-JSON PUT is DISABLED —
 *    Core owns materializing the source back for the embed/RAG readers. Only a
 *    title change still flushes (with a source snapshot derived from the live Yjs
 *    doc, so it never fights the CRDT).
 */
export default function SpaceDatabaseEditorPage({
	spaceId,
	databaseId,
}: {
	spaceId: string;
	databaseId: string;
}) {
	const tl = useLiteralMessages();
	const {
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
	} = useSpaceDatabaseDocument({ databaseId, spaceId });
	const {
		addColumn,
		onColumnEdit,
		onDataChange,
		onRowAdd,
		onRowsAdd,
		onRowsDelete,
		onRowsInsert,
		openRow,
		updateColumn,
	} = useSpaceDatabaseRowsAndColumns({
		collaborative,
		columnsRef,
		databaseId,
		flush,
		getCollabDoc,
		openTab,
		readOnly,
		rowsRef,
		scheduleSave,
		setColumnEditor,
		setColumns,
		setRows,
		spaceId,
	});
	const {
		addView,
		createRow,
		displayRows,
		grid,
		handleTitleChange,
		removeView,
		setCell,
		updateView,
	} = useSpaceDatabaseViews({
		columns,
		columnsRef,
		getCollabDoc,
		onColumnEdit,
		onDataChange,
		onRowAdd,
		onRowsAdd,
		onRowsDelete,
		onRowsInsert,
		openRow,
		readOnly,
		rows,
		rowsRef,
		scheduleSave,
		setActiveViewId,
		setRows,
		setTitle,
		setViews,
		tabId,
		titleRef,
		updateTabTitle,
		viewsRef,
	});

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LibraryIcon} />
					</EmptyMedia>
					<EmptyTitle>Could not open database</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				<Button
					onClick={() => {
						setError(null);
						setReloadNonce((n) => n + 1);
					}}
					size="sm"
					variant="ghost"
				>
					Try again
				</Button>
			</Empty>
		);
	}

	if (!loaded) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	let statusLabel = SAVE_LABEL[saveState];
	if (collaborative) {
		// "Live" must mean the socket is actually up. The room stays collaborative
		// across a drop on purpose (edits keep accumulating in the Y.Doc and upload
		// on reconnect), so the connection state — not `collaborative` — decides
		// what the user is told. Saying "Live" while offline is what made a dead
		// grid look healthy.
		if (collabStatus === "reconnecting" || collabStatus === "connecting") {
			statusLabel = "Reconnecting…";
		} else if (collabStatus === "denied") {
			statusLabel = "Disconnected";
		} else {
			statusLabel = readOnly ? "Live · read-only" : "Live";
		}
	}

	const activeView = views.find((view) => view.id === activeViewId) ?? views[0];
	const activeKind = activeView?.kind ?? "table";
	const runQuery = async () => {
		setQueryRunning(true);
		setQueryError(null);
		setQueryResult(null);
		try {
			setQueryResult(
				await querySpaceDatabase(toTarget(node), spaceId, databaseId, queryText)
			);
		} catch (cause) {
			setQueryError(
				cause instanceof Error ? cause.message : "The query could not run"
			);
		} finally {
			setQueryRunning(false);
		}
	};
	const formatQueryValue = <TValue,>(value: TValue): string => {
		if (value === null) {
			return "NULL";
		}
		const primitive = z
			.union([z.string(), z.number(), z.boolean(), z.undefined()])
			.safeParse(value);
		return primitive.success
			? String(primitive.data)
			: (JSON.stringify(value) ?? "");
	};

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Input
					aria-label="Database title"
					disabled={readOnly}
					onChange={(e) => handleTitleChange(e.target.value)}
					placeholder="Untitled"
					purpose="space-title"
					value={title}
				/>
				<span className="shrink-0 text-muted-foreground text-xs">
					{statusLabel}
				</span>
				<Button
					className="ml-auto"
					onClick={() => {
						setQueryError(null);
						setQueryOpen(true);
					}}
					size="sm"
					variant="outline"
				>
					SQL query
				</Button>
				{activeKind === "table" && (
					<Button
						disabled={readOnly}
						onClick={() => setColumnEditor({ mode: "create" })}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
						Add column
					</Button>
				)}
			</div>
			<ViewBar
				activeViewId={activeView?.id ?? ""}
				columns={columns}
				onAddView={addView}
				onRemoveView={removeView}
				onSelect={setActiveViewId}
				onUpdateView={updateView}
				readOnly={readOnly}
				views={views}
			/>
			<div className="min-h-0 flex-1 overflow-hidden">
				{activeKind === "table" && (
					<div className="h-full overflow-auto p-4">
						<DataGrid {...grid} height={DEFAULT_GRID_HEIGHT} />
					</div>
				)}
				{activeKind === "board" && (
					<BoardView
						columns={columns}
						createRow={createRow}
						groupByColumnId={activeView?.groupByColumnId}
						onOpenRow={openRow}
						readOnly={readOnly}
						rows={displayRows}
						setCell={setCell}
					/>
				)}
				{activeKind === "gallery" && (
					<GalleryView
						columns={columns}
						createRow={createRow}
						onOpenRow={openRow}
						readOnly={readOnly}
						rows={displayRows}
					/>
				)}
				{activeKind === "list" && (
					<ListView
						columns={columns}
						createRow={createRow}
						onOpenRow={openRow}
						readOnly={readOnly}
						rows={displayRows}
					/>
				)}
			</div>
			<Dialog onOpenChange={setQueryOpen} open={queryOpen}>
				<DialogContent className="max-w-4xl">
					<DialogHeader>
						<DialogTitle>Query database</DialogTitle>
						<DialogDescription>
							Run read-only SQL against this database. Use the table name{" "}
							<code>data</code>; results stop at 500 rows or 1 MB.
						</DialogDescription>
					</DialogHeader>
					<label className="grid gap-2 text-sm" htmlFor="space-database-query">
						SQL
						<Textarea
							className="min-h-36"
							id="space-database-query"
							maxLength={8000}
							onChange={(event) => setQueryText(event.target.value)}
							spellCheck={false}
							typography="small"
							value={queryText}
							variant="code"
						/>
					</label>
					{queryResult?.schema.length ? (
						<div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
							{queryResult.schema.map((column) => (
								<span key={column.id}>
									{column.label}: <code>{column.name}</code>
								</span>
							))}
						</div>
					) : null}
					{queryError ? (
						<p className="text-sm text-status-destructive" role="alert">
							{queryError}
						</p>
					) : null}
					{queryResult ? (
						<div className="grid gap-2">
							<p className="text-muted-foreground text-xs" role="status">
								{queryResult.truncated
									? tl("{count} rows · result was limited", {
											count: String(queryResult.rows.length),
										})
									: tl("{count} rows", {
											count: String(queryResult.rows.length),
										})}
							</p>
							<div className="max-h-72 overflow-auto rounded-xl border border-border">
								<table className="w-full text-left text-sm">
									<thead className="sticky top-0 bg-muted">
										<tr>
											{queryResult.columns.map((column, index) => (
												<th
													className="px-3 py-2 font-medium"
													key={`${column}-${index}`}
												>
													{column}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{queryResult.rows.map((row, rowIndex) => (
											<tr className="border-t" key={rowIndex}>
												{queryResult.columns.map((column, columnIndex) => (
													<td
														className="max-w-80 break-words px-3 py-2 align-top"
														key={`${column}-${columnIndex}`}
													>
														{formatQueryValue(row[columnIndex] ?? null)}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					) : null}
					<DialogFooter>
						<Button
							disabled={queryRunning || !queryText.trim()}
							onClick={() => void runQuery()}
							variant="mono"
						>
							<HugeiconsIcon className="size-3.5" icon={PlayIcon} />
							{queryRunning ? "Running…" : "Run query"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setColumnEditor(null);
					}
				}}
				open={columnEditor !== null}
			>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>
							{columnEditor?.mode === "edit" ? "Edit property" : "New property"}
						</DialogTitle>
					</DialogHeader>
					{columnEditor !== null && (
						<ColumnEditor
							columns={columns.filter(
								(column) =>
									columnEditor.mode !== "edit" ||
									column.id !== columnEditor.columnId
							)}
							initial={
								columnEditor.mode === "edit" ? columnEditor.initial : undefined
							}
							onCancel={() => setColumnEditor(null)}
							onSubmit={(label, cell) => {
								if (columnEditor.mode === "edit") {
									updateColumn(columnEditor.columnId, label, cell);
								} else {
									addColumn(label, cell);
								}
							}}
							submitLabel={
								columnEditor.mode === "edit" ? "Save" : "Add property"
							}
						/>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
