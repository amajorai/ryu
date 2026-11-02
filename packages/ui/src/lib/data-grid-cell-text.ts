// Cell text for the data grid: what a cell shows (to size a column), TSV
// clipboard serialization, and the column filter keys. Split from
// `data-grid-fill.ts`, which re-exports everything here.

import { formatDateForDisplay } from "@ryu/ui/lib/data-grid.ts";
import { isCellValueEmpty } from "@ryu/ui/lib/data-grid-fill.ts";
import {
	isNativeBoolean,
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { getDisplayLocale } from "@ryu/ui/lib/timezone.ts";
import type { CellOpts } from "@ryu/ui/types/data-grid.ts";

export interface CellDisplayText {
	/** Number of tag chips the value renders as (each adds horizontal padding). */
	chips: number;
	text: string;
}

function optionLabel<CellValue>(
	value: CellValue,
	cellOpts: CellOpts | undefined
): string {
	const text = String(value ?? "");
	if (cellOpts?.variant !== "select" && cellOpts?.variant !== "multi-select") {
		return text;
	}
	return (
		cellOpts.options.find((option) => option.value === text)?.label ?? text
	);
}

/** The text a cell shows, used to size a column to its contents. */
export function getCellDisplayText<CellValue>(
	value: CellValue,
	cellOpts?: CellOpts
): CellDisplayText {
	if (isCellValueEmpty(value) || cellOpts?.variant === "checkbox") {
		return { text: "", chips: 0 };
	}
	if (Array.isArray(value)) {
		const labels = value.map((item) =>
			item && isNativeObjectLike(item) && "name" in item
				? String(item.name)
				: optionLabel(item, cellOpts)
		);
		return { text: labels.join(""), chips: labels.length };
	}
	if (value instanceof Date) {
		return { text: value.toLocaleDateString(getDisplayLocale()), chips: 0 };
	}
	if (cellOpts?.variant === "date" && isNativeText(value)) {
		return { text: formatDateForDisplay(value), chips: 0 };
	}
	if (cellOpts?.variant === "select") {
		return { text: optionLabel(value, cellOpts), chips: 1 };
	}
	const lines = String(value).split("\n");
	const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
	return { text: longest, chips: 0 };
}

/** Swap rows and columns (Paste transposed); ragged rows pad with "". */
export function transposeMatrix(rows: string[][]): string[][] {
	const width = Math.max(0, ...rows.map((row) => row.length));
	return Array.from({ length: width }, (_, col) =>
		rows.map((row) => row[col] ?? "")
	);
}

const TSV_SPECIAL_REGEX = /[\t\n\r"]/;

/**
 * Serialize cells as TSV that `parseTsv` reads back. When any field holds a
 * tab, newline, or quote, every field is quoted, since the parser only takes
 * its quoted path when the text starts with a quote.
 */
export function serializeTsv(rows: string[][]): string {
	const needsQuotes = rows.some((row) =>
		row.some((field) => TSV_SPECIAL_REGEX.test(field))
	);
	const encode = (field: string) =>
		needsQuotes ? `"${field.replaceAll('"', '""')}"` : field;
	return rows.map((row) => row.map(encode).join("\t")).join("\n");
}

/** The keys a cell contributes to a column value filter (one per tag for lists). */
export function getFilterKeys<CellValue>(value: CellValue): string[] {
	if (isNativeBoolean(value)) {
		return [String(value)];
	}
	if (isCellValueEmpty(value)) {
		return [""];
	}
	if (Array.isArray(value)) {
		return value.map((item) =>
			item && isNativeObjectLike(item) && "name" in item
				? String(item.name)
				: String(item)
		);
	}
	if (value instanceof Date) {
		return [value.toISOString().slice(0, 10)];
	}
	return [String(value)];
}

/** Whether a cell passes a value filter (`selected` keys; absent means no filter). */
export function matchesFilterKeys<CellValue, SelectedKeys>(
	value: CellValue,
	selected: SelectedKeys
): boolean {
	if (!Array.isArray(selected)) {
		return true;
	}
	return getFilterKeys(value).some((key) => selected.includes(key));
}

export interface FilterOption {
	count: number;
	key: string;
	label: string;
}

/** Distinct filter values of a column with counts, blanks last (Excel's AutoFilter list). */
export function collectFilterOptions(
	values: Iterable<unknown>,
	cellOpts?: CellOpts
): FilterOption[] {
	const counts = new Map<string, number>();
	for (const value of values) {
		for (const key of new Set(getFilterKeys(value))) {
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	const labelFor = (key: string) => {
		if (key === "") {
			return "(Blanks)";
		}
		if (cellOpts?.variant === "checkbox") {
			return key === "true" ? "Checked" : "Unchecked";
		}
		return getCellDisplayText(key, cellOpts).text || key;
	};
	const numeric = cellOpts?.variant === "number";
	return [...counts.entries()]
		.map(([key, count]) => ({ key, count, label: labelFor(key) }))
		.sort((a, b) => {
			if (a.key === "" || b.key === "") {
				return a.key === "" ? 1 : -1;
			}
			return numeric
				? Number(a.key) - Number(b.key)
				: a.label.localeCompare(b.label, undefined, { numeric: true });
		});
}
