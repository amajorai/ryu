import type { CSSProperties } from "react";
import "./spreadsheet-editor.css";
import { cellValueAsString, setFormula } from "@office-kit/xlsx/cell";
import {
	fromArrayBuffer,
	loadWorkbook,
	workbookToBytes,
} from "@office-kit/xlsx/io";
import type { Workbook } from "@office-kit/xlsx/workbook";
import {
	getCell,
	getMaxCol,
	getMaxRow,
	setCell,
	type Worksheet,
} from "@office-kit/xlsx/worksheet";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import {
	parseSpreadsheetInput,
	spreadsheetColumnLabel,
} from "@/src/lib/office-files.ts";
import type { FileEditorHandle } from "./DocxEditor.tsx";

const ROW_HEIGHT = 32;
const EXTRA_ROWS = 24;
const EXTRA_COLUMNS = 8;
const MAX_RENDER_ROWS = 10_000;
const MAX_RENDER_COLUMNS = 100;
const OVERSCAN_ROWS = 8;

interface SpreadsheetEditorProps {
	bytes: ArrayBuffer;
	mime: string;
	onDirty: () => void;
	onLoadError: (message: string) => void;
}

function cellText(worksheet: Worksheet, row: number, column: number): string {
	const cell = getCell(worksheet, row, column);
	if (!cell) {
		return "";
	}
	const formula = z
		.object({ kind: z.literal("formula"), formula: z.string() })
		.safeParse(cell.value);
	if (formula.success) {
		return `=${formula.data.formula}`;
	}
	return cellValueAsString(cell.value);
}

export const SpreadsheetEditor = forwardRef<
	FileEditorHandle,
	SpreadsheetEditorProps
>(function SpreadsheetEditor({ bytes, mime, onDirty, onLoadError }, ref) {
	const [workbook, setWorkbook] = useState<Workbook | null>(null);
	const [activeSheetIndex, setActiveSheetIndex] = useState(0);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState(600);
	const [revision, setRevision] = useState(0);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		loadWorkbook(fromArrayBuffer(bytes))
			.then((loaded) => {
				if (cancelled) {
					return;
				}
				const worksheets = loaded.sheets.filter(
					(sheet) => sheet.kind === "worksheet"
				);
				if (worksheets.length === 0) {
					throw new Error("This workbook has no editable worksheets.");
				}
				const activeSheet = loaded.sheets[loaded.activeSheetIndex];
				const activeWorksheetIndex =
					activeSheet?.kind === "worksheet"
						? worksheets.indexOf(activeSheet)
						: -1;
				setWorkbook(loaded);
				setActiveSheetIndex(Math.max(0, activeWorksheetIndex));
			})
			.catch((error) => {
				if (!cancelled) {
					onLoadError(
						error instanceof Error
							? error.message
							: "This spreadsheet could not be opened."
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [bytes, onLoadError]);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			setViewportHeight(entry?.contentRect.height ?? 600);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useImperativeHandle(
		ref,
		() => ({
			exportFile: async () => {
				if (!workbook) {
					throw new Error("The spreadsheet is still loading.");
				}
				const output = await workbookToBytes(workbook);
				return new Blob([Uint8Array.from(output)], { type: mime });
			},
		}),
		[mime, workbook]
	);

	const worksheetRefs = useMemo(
		() => workbook?.sheets.filter((sheet) => sheet.kind === "worksheet") ?? [],
		[workbook]
	);
	const activeRef = worksheetRefs[activeSheetIndex] ?? worksheetRefs[0];
	const worksheet = activeRef?.kind === "worksheet" ? activeRef.sheet : null;
	const rowCount = worksheet
		? Math.min(MAX_RENDER_ROWS, Math.max(50, getMaxRow(worksheet) + EXTRA_ROWS))
		: 0;
	const columnCount = worksheet
		? Math.min(
				MAX_RENDER_COLUMNS,
				Math.max(12, getMaxCol(worksheet) + EXTRA_COLUMNS)
			)
		: 0;
	const startRow = Math.max(
		0,
		Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS
	);
	const visibleCount =
		Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
	const endRow = Math.min(rowCount, startRow + visibleCount);
	const visibleRows = Array.from(
		{ length: Math.max(0, endRow - startRow) },
		(_, index) => startRow + index + 1
	);
	const gridWidth = 52 + columnCount * 144;

	if (!(workbook && worksheet)) {
		return (
			<div className="grid min-h-0 flex-1 place-items-center text-muted-foreground text-sm">
				Opening spreadsheet…
			</div>
		);
	}

	const spreadsheetWidthVariables1: CSSProperties & {
		"--spreadsheet-grid-width": string;
	} = { "--spreadsheet-grid-width": `${gridWidth}px` };
	const spreadsheetBodyVariables2: CSSProperties & {
		"--spreadsheet-grid-height": string;
		"--spreadsheet-grid-width": string;
	} = {
		"--spreadsheet-grid-height": `${rowCount * ROW_HEIGHT}px`,
		"--spreadsheet-grid-width": `${gridWidth}px`,
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col bg-muted/20">
			<div
				className="min-h-0 flex-1 overflow-auto"
				onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
				ref={scrollRef}
			>
				<div
					className="sticky top-0 z-20 flex h-8 border-border border-b bg-muted"
					data-spreadsheet-grid-width=""
					style={spreadsheetWidthVariables1}
				>
					<div className="sticky left-0 z-30 w-[52px] shrink-0 border-border border-r bg-muted" />
					{Array.from({ length: columnCount }, (_, index) => (
						<div
							className="w-36 shrink-0 border-border border-r px-2 py-1 text-center font-medium text-muted-foreground text-xs"
							key={spreadsheetColumnLabel(index + 1)}
						>
							{spreadsheetColumnLabel(index + 1)}
						</div>
					))}
				</div>
				<div
					className="relative"
					data-spreadsheet-grid-body=""
					style={spreadsheetBodyVariables2}
				>
					{visibleRows.map((row) => {
						const spreadsheetRowVariables3: CSSProperties & {
							"--spreadsheet-row-top": string;
						} = { "--spreadsheet-row-top": `${(row - 1) * ROW_HEIGHT}px` };
						return (
							<div
								className="absolute left-0 flex h-8"
								data-spreadsheet-grid-row=""
								key={row}
								style={spreadsheetRowVariables3}
							>
								<div className="sticky left-0 z-10 w-[52px] shrink-0 border-border border-r border-b bg-muted px-2 py-2 text-right text-muted-foreground text-xs">
									{row}
								</div>
								{Array.from({ length: columnCount }, (_, columnIndex) => {
									const column = columnIndex + 1;
									const address = `${spreadsheetColumnLabel(column)}${row}`;
									return (
										<input
											aria-label={address}
											className="text-(length:--text-detail) h-8 w-36 shrink-0 border-0 border-border border-r border-b bg-background px-2 font-mono outline-none focus:relative focus:z-10 focus:ring-2 focus:ring-primary"
											defaultValue={cellText(worksheet, row, column)}
											key={`${address}:${activeSheetIndex}:${revision}`}
											onBlur={(event) => {
												const parsed = parseSpreadsheetInput(
													event.currentTarget.value
												);
												if (parsed.kind === "formula") {
													setFormula(
														setCell(worksheet, row, column),
														parsed.formula
													);
												} else {
													setCell(
														worksheet,
														row,
														column,
														parsed.kind === "blank" ? null : parsed.value
													);
												}
												setRevision((value) => value + 1);
												onDirty();
											}}
										/>
									);
								})}
							</div>
						);
					})}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-border border-t bg-background px-2 py-1.5">
				{worksheetRefs.map((sheet, index) => (
					<Button
						key={`${sheet.sheetId}:${sheet.sheet.title}`}
						onClick={() => {
							setActiveSheetIndex(index);
							setScrollTop(0);
							scrollRef.current?.scrollTo({ left: 0, top: 0 });
						}}
						size="sm"
						variant={index === activeSheetIndex ? "secondary" : "ghost"}
					>
						{sheet.sheet.title}
					</Button>
				))}
			</div>
		</div>
	);
});
