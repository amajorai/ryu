import { activeLocale } from "@ryu/i18n/core";
import { formatByteSize } from "@ryu/i18n/format-intl";
import type {
	CellOpts,
	CellPosition,
	Direction,
	FileCellData,
	RowHeightValue,
} from "@ryu/ui/types/data-grid.ts";
import type { Column } from "@tanstack/react-table";
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

const cellTextSchema = z.string();
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

export function formatFileSize(bytes: number): string {
	const count = bytes > 0 && Number.isFinite(bytes) ? bytes : 0;
	return formatByteSize(count, activeLocale(), {
		fractionDigits: 1,
		maxUnit: "gigabyte",
		trimZeros: true,
	});
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

export {
	formatDateForDisplay,
	formatDateToString,
	parseLocalDate,
	parsePastedDate,
} from "./data-grid-date.ts";
export {
	getScrollDirection,
	scrollCellIntoView,
} from "./data-grid-scroll.ts";
export { parseTsv } from "./data-grid-tsv.ts";
