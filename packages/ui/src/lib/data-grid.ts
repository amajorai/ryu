import type {
	CellOpts,
	CellPosition,
	Direction,
	FileCellData,
	RowHeightValue,
} from "@ryu/ui/types/data-grid.ts";
import type { Column, Table } from "@tanstack/react-table";
import {
	BaselineIcon,
	CalendarIcon,
	CheckSquareIcon,
	File,
	FileArchive,
	FileAudio,
	FileIcon,
	FileImage,
	FileSpreadsheet,
	FileText,
	FileVideo,
	HashIcon,
	LinkIcon,
	ListChecksIcon,
	ListIcon,
	Presentation,
	SigmaIcon,
	TextInitialIcon,
} from "lucide-react";
import type * as React from "react";
import { z } from "zod";

import { getDisplayLocale } from "./timezone.ts";

const cellTextSchema = z.string();
const localDateInputSchema = z.union([z.instanceof(Date), cellTextSchema]);
const popoverElementSchema = z.custom<Element>(
	(value) => value instanceof Element
);
const fileCellSchema = z.object({
	id: z.string(),
	name: z.string(),
	size: z.union([
		z.number(),
		z.nan(),
		z.literal(Number.POSITIVE_INFINITY),
		z.literal(Number.NEGATIVE_INFINITY),
	]),
	type: z.string(),
	url: z.string().optional(),
}) satisfies z.ZodType<FileCellData>;

type CellRenderSource<TProps extends object> =
	| ((props: TProps) => React.ReactNode)
	| string
	| undefined;
function isCellText<TProps extends object>(
	source: CellRenderSource<TProps>
): source is string {
	return cellTextSchema.safeParse(source).success;
}

/** Native TanStack column methods read by the pinning and border helpers. */
export type GridColumnMetrics<TData> = Pick<
	Column<TData>,
	| "getIsPinned"
	| "getIsFirstColumn"
	| "getIsLastColumn"
	| "getStart"
	| "getAfter"
	| "getSize"
>;

/** Persisted tag colors may include future keys; unresolved keys retain the neutral fallback. */
interface SelectOptionPalette {
	[color: string]: string;
}

const TRAILING_CR_REGEX = /\r$/;
export function flexRender<TProps extends object>(
	Comp: CellRenderSource<TProps>,
	props: TProps
): React.ReactNode {
	if (isCellText(Comp)) {
		return Comp;
	}
	return Comp?.(props);
}

export function getIsFileCellData(
	item: Parameters<typeof fileCellSchema.safeParse>[0]
): item is FileCellData {
	return fileCellSchema.safeParse(item).success;
}

export function matchSelectOption(
	value: string,
	options: { value: string; label: string }[]
): string | undefined {
	return options.find(
		(o) =>
			o.value === value ||
			o.value.toLowerCase() === value.toLowerCase() ||
			o.label.toLowerCase() === value.toLowerCase()
	)?.value;
}

export function getCellKey(rowIndex: number, columnId: string) {
	return `${rowIndex}:${columnId}`;
}

export function parseCellKey(cellKey: string): Required<CellPosition> {
	const parts = cellKey.split(":");
	const rowIndexStr = parts[0];
	const columnId = parts[1];
	if (rowIndexStr && columnId) {
		const rowIndex = Number.parseInt(rowIndexStr, 10);
		if (!Number.isNaN(rowIndex)) {
			return { rowIndex, columnId };
		}
	}
	return { rowIndex: 0, columnId: "" };
}

export function getRowHeightValue(rowHeight: RowHeightValue): number {
	const rowHeightMap = {
		short: 36,
		medium: 56,
		tall: 76,
		"extra-tall": 96,
	} satisfies Record<RowHeightValue, number>;

	return rowHeightMap[rowHeight];
}

export function getLineCount(rowHeight: RowHeightValue): number {
	const lineCountMap = {
		short: 1,
		medium: 2,
		tall: 3,
		"extra-tall": 4,
	} satisfies Record<RowHeightValue, number>;

	return lineCountMap[rowHeight];
}

export function getColumnBorderVisibility<TData>(params: {
	column: GridColumnMetrics<TData>;
	nextColumn?: GridColumnMetrics<TData>;
	isLastColumn: boolean;
}) {
	const { column, nextColumn, isLastColumn } = params;

	const isPinned = column.getIsPinned();
	const isFirstRightPinnedColumn =
		isPinned === "right" && column.getIsFirstColumn("right");
	const isLastRightPinnedColumn =
		isPinned === "right" && column.getIsLastColumn("right");

	const nextIsPinned = nextColumn?.getIsPinned();
	const isBeforeRightPinned =
		nextIsPinned === "right" && nextColumn?.getIsFirstColumn("right");

	const showEndBorder =
		!isBeforeRightPinned && (isLastColumn || !isLastRightPinnedColumn);

	const showStartBorder = isFirstRightPinnedColumn;

	return {
		showEndBorder,
		showStartBorder,
	};
}

/** Dynamic pin geometry is consumed by the data-grid's shared CSS. */
export interface ColumnPinningStyle extends React.CSSProperties {
	"--data-grid-pin-left"?: string;
	"--data-grid-pin-opacity": number;
	"--data-grid-pin-position": "sticky" | "relative";
	"--data-grid-pin-right"?: string;
	"--data-grid-pin-shadow"?: string;
	"--data-grid-pin-width": string;
	"--data-grid-pin-z-index"?: number;
}

export function getColumnPinningStyle<TData>(params: {
	column: GridColumnMetrics<TData>;
	withBorder?: boolean;
	dir?: Direction;
}): ColumnPinningStyle {
	const { column, dir = "ltr", withBorder = false } = params;

	const isPinned = column.getIsPinned();
	const isLastLeftPinnedColumn =
		isPinned === "left" && column.getIsLastColumn("left");
	const isFirstRightPinnedColumn =
		isPinned === "right" && column.getIsFirstColumn("right");

	const isRtl = dir === "rtl";

	const leftPosition =
		isPinned === "left" ? `${column.getStart("left")}px` : undefined;
	const rightPosition =
		isPinned === "right" ? `${column.getAfter("right")}px` : undefined;
	const boxShadow = getPinnedColumnBoxShadow({
		isFirstRightPinnedColumn,
		isLastLeftPinnedColumn,
		isRtl,
		withBorder,
	});

	const style: ColumnPinningStyle = {
		"--data-grid-pin-shadow": boxShadow,
		"--data-grid-pin-left": isRtl ? rightPosition : leftPosition,
		"--data-grid-pin-right": isRtl ? leftPosition : rightPosition,
		"--data-grid-pin-opacity": isPinned ? 0.97 : 1,
		"--data-grid-pin-position": isPinned ? "sticky" : "relative",
		"--data-grid-pin-width": `${column.getSize()}px`,
		"--data-grid-pin-z-index": isPinned ? 1 : undefined,
	};
	return style;
}

function getPinnedColumnBoxShadow({
	isFirstRightPinnedColumn,
	isLastLeftPinnedColumn,
	isRtl,
	withBorder,
}: {
	isFirstRightPinnedColumn: boolean;
	isLastLeftPinnedColumn: boolean;
	isRtl: boolean;
	withBorder: boolean;
}): string | undefined {
	if (!withBorder) {
		return;
	}
	if (isLastLeftPinnedColumn) {
		return isRtl
			? "4px 0 4px -4px var(--border) inset"
			: "-4px 0 4px -4px var(--border) inset";
	}
	if (isFirstRightPinnedColumn) {
		return isRtl
			? "-4px 0 4px -4px var(--border) inset"
			: "4px 0 4px -4px var(--border) inset";
	}
	return;
}

export function getScrollDirection(
	direction: string
): "left" | "right" | "home" | "end" | undefined {
	if (
		direction === "left" ||
		direction === "right" ||
		direction === "home" ||
		direction === "end"
	) {
		return direction;
	}
	if (direction === "pageleft" || direction === "ctrl+left") {
		return "left";
	}
	if (direction === "pageright" || direction === "ctrl+right") {
		return "right";
	}
	return undefined;
}

export function scrollCellIntoView<TData>(params: {
	container: HTMLDivElement;
	targetCell: HTMLDivElement;
	tableRef: React.RefObject<Table<TData> | null>;
	viewportOffset: number;
	direction?: "left" | "right" | "home" | "end";
	isRtl: boolean;
}): void {
	const { container, targetCell, tableRef, direction, viewportOffset, isRtl } =
		params;

	const containerRect = container.getBoundingClientRect();
	const cellRect = targetCell.getBoundingClientRect();

	const hasNegativeScroll = container.scrollLeft < 0;
	const isActuallyRtl = isRtl || hasNegativeScroll;

	const currentTable = tableRef.current;
	const leftPinnedColumns = currentTable?.getLeftVisibleLeafColumns() ?? [];
	const rightPinnedColumns = currentTable?.getRightVisibleLeafColumns() ?? [];

	const leftPinnedWidth = leftPinnedColumns.reduce(
		(sum, c) => sum + c.getSize(),
		0
	);
	const rightPinnedWidth = rightPinnedColumns.reduce(
		(sum, c) => sum + c.getSize(),
		0
	);

	const viewportLeft = isActuallyRtl
		? containerRect.left + rightPinnedWidth + viewportOffset
		: containerRect.left + leftPinnedWidth + viewportOffset;
	const viewportRight = isActuallyRtl
		? containerRect.right - leftPinnedWidth - viewportOffset
		: containerRect.right - rightPinnedWidth - viewportOffset;

	const isFullyVisible =
		cellRect.left >= viewportLeft && cellRect.right <= viewportRight;

	if (isFullyVisible) {
		return;
	}

	const isClippedLeft = cellRect.left < viewportLeft;
	const isClippedRight = cellRect.right > viewportRight;

	let scrollDelta = 0;

	if (direction) {
		const shouldScrollRight = isActuallyRtl
			? direction === "right" || direction === "home"
			: direction === "right" || direction === "end";

		if (shouldScrollRight) {
			scrollDelta = cellRect.right - viewportRight;
		} else {
			scrollDelta = -(viewportLeft - cellRect.left);
		}
	} else if (isClippedRight) {
		scrollDelta = cellRect.right - viewportRight;
	} else if (isClippedLeft) {
		scrollDelta = -(viewportLeft - cellRect.left);
	}

	container.scrollLeft += scrollDelta;
}

function countTabs(s: string): number {
	let n = 0;
	for (const char of s) {
		if (char === "\t") {
			n++;
		}
	}
	return n;
}

function shouldKeepTsvRow(row: string[]): boolean {
	return row.length > 1 || row.some((field) => field.length > 0);
}

function pushTsvRow(rows: string[][], row: string[]): void {
	if (shouldKeepTsvRow(row)) {
		rows.push(row);
	}
}

function isQuotedTsvLineBreak(
	char: string | undefined,
	nextChar: string | undefined
): boolean {
	return char === "\n" || (char === "\r" && nextChar === "\n");
}

function parseQuotedTsv(text: string): string[][] {
	const rows: string[][] = [];
	let currentRow: string[] = [];
	let currentField = "";
	let inQuotes = false;
	let i = 0;

	while (i < text.length) {
		const char = text[i];
		const nextChar = text[i + 1];

		if (inQuotes && char === '"' && nextChar === '"') {
			currentField += '"';
			i += 2;
			continue;
		}
		if (inQuotes && char === '"') {
			inQuotes = false;
			i++;
			continue;
		}
		if (inQuotes) {
			currentField += char;
			i++;
			continue;
		}
		if (char === '"' && currentField === "") {
			inQuotes = true;
			i++;
			continue;
		}
		if (char === "\t") {
			currentRow.push(currentField);
			currentField = "";
			i++;
			continue;
		}
		if (isQuotedTsvLineBreak(char, nextChar)) {
			currentRow.push(currentField);
			pushTsvRow(rows, currentRow);
			currentRow = [];
			currentField = "";
			i += char === "\r" ? 2 : 1;
			continue;
		}

		currentField += char;
		i++;
	}

	currentRow.push(currentField);
	pushTsvRow(rows, currentRow);
	return rows;
}

function tsvColumnCount(lines: string[], fallbackColumnCount: number): number {
	let maxTabCount = 0;
	for (const line of lines) {
		const n = countTabs(line);
		if (n > maxTabCount) {
			maxTabCount = n;
		}
	}
	return maxTabCount > 0 ? maxTabCount + 1 : fallbackColumnCount;
}

function parsePlainTsv(text: string, fallbackColumnCount: number): string[][] {
	const lines = text
		.split("\n")
		.map((line) => line.replace(TRAILING_CR_REGEX, ""));
	const columnCount = tsvColumnCount(lines, fallbackColumnCount);
	if (columnCount <= 0) {
		return [];
	}

	const expectedTabCount = columnCount - 1;
	const rows: string[][] = [];
	let buf = "";
	let bufTabCount = 0;

	for (const line of lines) {
		const tc = countTabs(line);

		if (tc === expectedTabCount) {
			if (buf && bufTabCount === expectedTabCount) {
				rows.push(buf.split("\t"));
			}
			buf = "";
			bufTabCount = 0;
			rows.push(line.split("\t"));
		} else {
			buf = buf ? `${buf}\n${line}` : line;
			bufTabCount += tc;
			if (bufTabCount === expectedTabCount) {
				rows.push(buf.split("\t"));
				buf = "";
				bufTabCount = 0;
			}
		}
	}

	if (buf && bufTabCount === expectedTabCount) {
		rows.push(buf.split("\t"));
	}

	return rows.length > 0
		? rows
		: lines.filter((l) => l.length > 0).map((l) => l.split("\t"));
}

export function parseTsv(
	text: string,
	fallbackColumnCount: number
): string[][] {
	if (text.startsWith('"') || text.includes('\t"')) {
		return parseQuotedTsv(text);
	}
	return parsePlainTsv(text, fallbackColumnCount);
}

export function getIsInPopover(
	element: Parameters<typeof popoverElementSchema.safeParse>[0]
): boolean {
	const parsed = popoverElementSchema.safeParse(element);
	if (!parsed.success) {
		return false;
	}

	return (
		parsed.data.closest("[data-grid-cell-editor]") !== null ||
		parsed.data.closest("[data-grid-popover]") !== null ||
		parsed.data.closest("[data-slot='dropdown-menu-content']") !== null ||
		parsed.data.closest("[data-slot='popover-content']") !== null
	);
}

export function getColumnVariant(variant?: CellOpts["variant"]): {
	icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
	label: string;
} | null {
	switch (variant) {
		case "short-text":
			return { label: "Short text", icon: BaselineIcon };
		case "long-text":
			return { label: "Long text", icon: TextInitialIcon };
		case "number":
			return { label: "Number", icon: HashIcon };
		case "url":
			return { label: "URL", icon: LinkIcon };
		case "checkbox":
			return { label: "Checkbox", icon: CheckSquareIcon };
		case "select":
			return { label: "Select", icon: ListIcon };
		case "multi-select":
			return { label: "Multi-select", icon: ListChecksIcon };
		case "date":
			return { label: "Date", icon: CalendarIcon };
		case "file":
			return { label: "File", icon: FileIcon };
		case "formula":
			return { label: "Formula", icon: SigmaIcon };
		default:
			return null;
	}
}

/**
 * Notion-style tag palette for select / multi-select options. Keyed by a stable
 * color name persisted on `CellSelectOption.color`; each maps to a badge class
 * string (light + dark). `getOptionColorClass` falls back to a neutral tag.
 */
export const SELECT_OPTION_COLORS: SelectOptionPalette = {
	gray: "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-200",
	brown: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
	orange:
		"bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200",
	yellow:
		"bg-yellow-100 text-yellow-800 dark:bg-yellow-500/20 dark:text-yellow-200",
	green: "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-200",
	blue: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
	purple:
		"bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-200",
	pink: "bg-pink-100 text-pink-800 dark:bg-pink-500/20 dark:text-pink-200",
	red: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
};

/** Ordered color keys for a picker. */
export const SELECT_OPTION_COLOR_KEYS = Object.keys(SELECT_OPTION_COLORS);

/** Resolve a tag color key to its badge class, or "" when unset/unknown. */
export function getOptionColorClass(color?: string): string {
	if (!color) {
		return "";
	}
	return SELECT_OPTION_COLORS[color] ?? "";
}

export function getEmptyCellValue(variant: CellOpts["variant"] | undefined) {
	if (variant === "multi-select" || variant === "file") {
		return [];
	}
	if (variant === "number" || variant === "date" || variant === "select") {
		return null;
	}
	if (variant === "checkbox") {
		return false;
	}
	return "";
}

export function getUrlHref(urlString: string): string {
	if (!urlString || urlString.trim() === "") {
		return "";
	}

	const trimmed = urlString.trim();
	const hasControlCharacter = Array.from(trimmed).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 || codePoint === 0x7f;
	});
	if (hasControlCharacter || trimmed.includes("\\")) {
		return "";
	}
	if (
		(trimmed.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(trimmed)) &&
		!/^https?:\/\//iu.test(trimmed)
	) {
		return "";
	}

	const candidate = /^https?:\/\//iu.test(trimmed)
		? trimmed
		: `http://${trimmed}`;
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return "";
		}
	} catch {
		return "";
	}
	return candidate;
}

export function parseLocalDate(
	dateStr: Parameters<typeof localDateInputSchema.safeParse>[0]
): Date | null {
	const parsed = localDateInputSchema.safeParse(dateStr);
	if (!parsed.success) {
		return null;
	}
	if (parsed.data instanceof Date) {
		return parsed.data;
	}
	const [year, month, day] = parsed.data.split("-").map(Number);
	if (!(year && month && day)) {
		return null;
	}
	const date = new Date(year, month - 1, day);
	// Verify date wasn't auto-corrected (e.g. Feb 30 -> Mar 1)
	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day
	) {
		return null;
	}
	return date;
}

export function formatDateToString(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:$|T)/;

/**
 * Normalize pasted text to the local `YYYY-MM-DD` string a date column stores.
 * `new Date("2024-03-05")` is UTC midnight (the previous day west of UTC), so
 * date-only and ISO-timestamp input keep the calendar day as written; other
 * formats fall back to `Date` parsing read in local time.
 */
export function parsePastedDate(text: string): string | null {
	const trimmed = text.trim();
	const isoDate = ISO_DATE_PREFIX.exec(trimmed)?.[1];
	const local = parseLocalDate(isoDate ?? trimmed);
	if (local) {
		return formatDateToString(local);
	}
	if (isoDate) {
		return null;
	}
	const date = new Date(trimmed);
	return Number.isNaN(date.getTime()) ? null : formatDateToString(date);
}

export function formatDateForDisplay(
	dateStr: Parameters<typeof parseLocalDate>[0]
): string {
	if (!dateStr) {
		return "";
	}
	const date = parseLocalDate(dateStr);
	if (!date) {
		const parsed = cellTextSchema.safeParse(dateStr);
		return parsed.success ? parsed.data : "";
	}
	try {
		return date.toLocaleDateString(getDisplayLocale());
	} catch {
		return date.toLocaleDateString();
	}
}

export function formatFileSize(bytes: number): string {
	if (bytes <= 0 || !Number.isFinite(bytes)) {
		return "0 B";
	}
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.min(
		sizes.length - 1,
		Math.floor(Math.log(bytes) / Math.log(k))
	);
	return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

export function getFileIcon(
	type: string
): React.ComponentType<React.SVGProps<SVGSVGElement>> {
	if (type.startsWith("image/")) {
		return FileImage;
	}
	if (type.startsWith("video/")) {
		return FileVideo;
	}
	if (type.startsWith("audio/")) {
		return FileAudio;
	}
	if (type.includes("pdf")) {
		return FileText;
	}
	if (type.includes("zip") || type.includes("rar")) {
		return FileArchive;
	}
	if (
		type.includes("word") ||
		type.includes("document") ||
		type.includes("doc")
	) {
		return FileText;
	}
	if (
		type.includes("sheet") ||
		type.includes("excel") ||
		type.includes("xls")
	) {
		return FileSpreadsheet;
	}
	if (
		type.includes("presentation") ||
		type.includes("powerpoint") ||
		type.includes("ppt")
	) {
		return Presentation;
	}
	return File;
}
