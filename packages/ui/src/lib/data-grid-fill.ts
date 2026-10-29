import { z } from "zod";
// Spreadsheet-style helpers for the data grid: fill-handle extension, AutoFill
// series (numbers, dates, "Item 1" text, weekday/month names), Ctrl+Arrow
// data-edge jumps, and selection aggregates. Framework-free so they stay unit
// tested; the hook owns reading cell values and writing updates.

import { formatDateForDisplay } from "@ryu/ui/lib/data-grid.ts";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CellOpts } from "@ryu/ui/types/data-grid.ts";

export type FillDirection = "down" | "up" | "right" | "left";

/** An inclusive rectangle in (visual row index, navigable column index) space. */
export interface GridRect {
	maxCol: number;
	maxRow: number;
	minCol: number;
	minRow: number;
}

export interface FillExtension {
	count: number;
	direction: FillDirection;
}

/**
 * Resolve where a fill-handle drag from `source` to the pointer cell extends.
 * Like Excel, the fill follows the dominant axis only; a pointer inside the
 * source rectangle yields no fill.
 */
export function getFillExtension(
	source: GridRect,
	target: { row: number; col: number }
): FillExtension | null {
	const below = target.row - source.maxRow;
	const above = source.minRow - target.row;
	const right = target.col - source.maxCol;
	const left = source.minCol - target.col;
	const vertical = Math.max(below, above, 0);
	const horizontal = Math.max(right, left, 0);

	if (vertical === 0 && horizontal === 0) {
		return null;
	}
	if (vertical >= horizontal) {
		return below > 0
			? { direction: "down", count: below }
			: { direction: "up", count: above };
	}
	return right > 0
		? { direction: "right", count: right }
		: { direction: "left", count: left };
}

/** The rectangle covered by `source` plus its fill extension. */
export function getFilledRect(
	source: GridRect,
	extension: FillExtension
): GridRect {
	switch (extension.direction) {
		case "down":
			return { ...source, maxRow: source.maxRow + extension.count };
		case "up":
			return { ...source, minRow: source.minRow - extension.count };
		case "right":
			return { ...source, maxCol: source.maxCol + extension.count };
		default:
			return { ...source, minCol: source.minCol - extension.count };
	}
}

/** Treat null, blank strings, empty lists, and unchecked boxes as empty. */
export function isCellValueEmpty<CellValue>(value: CellValue): boolean {
	if (value === null || value === undefined || value === false) {
		return true;
	}
	if (isNativeText(value)) {
		return value === "";
	}
	if (Array.isArray(value)) {
		return value.length === 0;
	}
	return false;
}

export function isSameCellValue<LeftValue, RightValue>(
	a: LeftValue,
	b: RightValue
): boolean {
	if (Object.is(a, b)) {
		return true;
	}
	if (a instanceof Date && b instanceof Date) {
		return a.getTime() === b.getTime();
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return false;
}

/**
 * Excel's Ctrl+Arrow target along one axis. From a filled cell whose neighbour
 * is filled, stop at the end of that run; otherwise jump to the next filled
 * cell, or the boundary when none remains.
 */
export function findDataEdge(params: {
	isFilled: (index: number) => boolean;
	length: number;
	start: number;
	step: 1 | -1;
}): number {
	const { isFilled, length, start, step } = params;
	const inRange = (index: number) => index >= 0 && index < length;
	let index = start + step;

	if (!inRange(index)) {
		return start;
	}

	if (isFilled(start) && isFilled(index)) {
		while (inRange(index + step) && isFilled(index + step)) {
			index += step;
		}
		return index;
	}

	while (!isFilled(index) && inRange(index + step)) {
		index += step;
	}
	return index;
}

const SERIES_VARIANTS = new Set<CellOpts["variant"] | undefined>([
	undefined,
	"short-text",
	"long-text",
	"number",
	"date",
]);

const ISO_DAY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const TRAILING_INTEGER_REGEX = /^(.*?)(\d+)$/;
const MS_PER_DAY = 86_400_000;

const NAME_LISTS: readonly (readonly string[])[] = [
	["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
	[
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
		"sunday",
	],
	[
		"jan",
		"feb",
		"mar",
		"apr",
		"may",
		"jun",
		"jul",
		"aug",
		"sep",
		"oct",
		"nov",
		"dec",
	],
	[
		"january",
		"february",
		"march",
		"april",
		"may",
		"june",
		"july",
		"august",
		"september",
		"october",
		"november",
		"december",
	],
];

function roundSeriesNumber(value: number): number {
	return Math.round(value * 1e10) / 1e10;
}

/** Least-squares line through (0, v0)…(n-1, vn-1), extrapolated to x. */
function linearTrend(values: number[]): (x: number) => number {
	const n = values.length;
	const meanX = (n - 1) / 2;
	const meanY = values.reduce((sum, v) => sum + v, 0) / n;
	let numerator = 0;
	let denominator = 0;
	for (const [x, y] of values.entries()) {
		numerator += (x - meanX) * (y - meanY);
		denominator += (x - meanX) ** 2;
	}
	const slope = denominator === 0 ? 0 : numerator / denominator;
	return (x) => meanY + slope * (x - meanX);
}

function cloneCellValue<Input>(value: Input) {
	if (Array.isArray(value)) {
		return value.map((item) =>
			item && isNativeObjectLike(item) ? { ...item } : item
		);
	}
	if (value instanceof Date) {
		return new Date(value.getTime());
	}
	return value;
}

/** Repeat `source` cyclically for `count` cells (Ctrl+D / Ctrl+R semantics). */
export function repeatPattern<Input>(source: Input[], count: number) {
	return Array.from({ length: count }, (_, i) =>
		cloneCellValue(source[i % source.length])
	);
}

const gridDateInputSchema = z.unknown().transform((value) => {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime())
			? null
			: Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) /
					MS_PER_DAY;
	}
	if (!isNativeText(value)) {
		return null;
	}
	const match = ISO_DAY_REGEX.exec(value);
	if (!match) {
		return null;
	}
	const [year, month, day] = [match[1], match[2], match[3]].map(Number);
	if (!(year && month && day)) {
		return null;
	}
	const time = Date.UTC(year, month - 1, day);
	const check = new Date(time);
	if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
		return null;
	}
	return time / MS_PER_DAY;
});

function toDayNumber<Input>(value: Input) {
	return gridDateInputSchema.parse(value);
}

function fromDayNumber(dayNumber: number, asDate: boolean): string | Date {
	const date = new Date(dayNumber * MS_PER_DAY);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const day = date.getUTCDate();
	if (asDate) {
		return new Date(year, month, day);
	}
	return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addMonths(dayNumber: number, months: number): number {
	const date = new Date(dayNumber * MS_PER_DAY);
	const targetMonth = date.getUTCMonth() + months;
	const firstOfTarget = Date.UTC(date.getUTCFullYear(), targetMonth, 1);
	const lastDay = new Date(
		Date.UTC(date.getUTCFullYear(), targetMonth + 1, 0)
	).getUTCDate();
	return firstOfTarget / MS_PER_DAY + Math.min(date.getUTCDate(), lastDay) - 1;
}

function dateSeries(
	source: unknown[],
	count: number,
	singleStep: number
): unknown[] | null {
	const days = source.map(toDayNumber);
	if (days.some((day) => day === null)) {
		return null;
	}
	const dayNumbers = days.filter((day): day is number => day !== null);
	const asDate = source[0] instanceof Date;
	const last = dayNumbers.at(-1) ?? 0;

	if (dayNumbers.length === 1) {
		return Array.from({ length: count }, (_, i) =>
			fromDayNumber(last + singleStep * (i + 1), asDate)
		);
	}

	// Same day-of-month with a constant month gap → step by months.
	const parts = dayNumbers.map((day) => new Date(day * MS_PER_DAY));
	const monthIndex = parts.map(
		(d) => d.getUTCFullYear() * 12 + d.getUTCMonth()
	);
	const sameDay = parts.every((d) => d.getUTCDate() === parts[0]?.getUTCDate());
	const monthGaps = monthIndex.slice(1).map((m, i) => m - (monthIndex[i] ?? 0));
	const monthStep = monthGaps[0] ?? 0;
	if (sameDay && monthStep !== 0 && monthGaps.every((g) => g === monthStep)) {
		return Array.from({ length: count }, (_, i) =>
			fromDayNumber(addMonths(last, monthStep * (i + 1)), asDate)
		);
	}

	const trend = linearTrend(dayNumbers);
	const n = dayNumbers.length;
	return Array.from({ length: count }, (_, i) =>
		fromDayNumber(Math.round(trend(n + i)), asDate)
	);
}

function matchCase(template: string, word: string): string {
	if (template === template.toUpperCase() && template.length > 1) {
		return word.toUpperCase();
	}
	const first = template[0];
	if (first && first === first.toUpperCase()) {
		return word[0]?.toUpperCase() + word.slice(1);
	}
	return word;
}

function nameSeries(
	source: string[],
	count: number,
	singleStep: number
): string[] | null {
	for (const list of NAME_LISTS) {
		const indices = source.map((value) => list.indexOf(value.toLowerCase()));
		if (indices.some((index) => index === -1)) {
			continue;
		}
		const gaps = indices
			.slice(1)
			.map(
				(index, i) => (index - (indices[i] ?? 0) + list.length) % list.length
			);
		const step =
			source.length === 1 ? singleStep + list.length : (gaps[0] ?? 1);
		if (!gaps.every((gap) => gap === step)) {
			return null;
		}
		const last = indices.at(-1) ?? 0;
		const template = source.at(-1) ?? "";
		return Array.from({ length: count }, (_, i) => {
			const word = list[(last + step * (i + 1)) % list.length] ?? "";
			return matchCase(template, word);
		});
	}
	return null;
}

function trailingIntegerSeries(
	source: string[],
	count: number,
	singleStep: number
): string[] | null {
	const matches = source.map((value) => TRAILING_INTEGER_REGEX.exec(value));
	const prefix = matches[0]?.[1];
	if (
		prefix === undefined ||
		matches.some((match) => !match || match[1] !== prefix)
	) {
		return null;
	}
	// A lone bare number copies, matching Excel; "Item 1" increments.
	if (prefix === "" && source.length === 1) {
		return null;
	}
	const digits = matches.map((match) => match?.[2] ?? "0");
	const width = digits[0]?.startsWith("0") ? (digits[0]?.length ?? 0) : 0;
	const numbers = digits.map(Number);
	const n = numbers.length;
	const trend =
		n === 1
			? (x: number) => (numbers[0] ?? 0) + singleStep * x
			: linearTrend(numbers);
	return Array.from({ length: count }, (_, i) => {
		const next = Math.abs(Math.round(trend(n === 1 ? i + 1 : n + i)));
		return `${prefix}${String(next).padStart(width, "0")}`;
	});
}

/**
 * Continue `source` (ordered toward the fill direction) for `count` cells.
 * Numbers and dates extend their linear trend, text with a trailing number
 * increments, weekday/month names advance, and everything else repeats. A
 * single value steps backward when filling up or left (`reverse`).
 */
export function buildFillSeries(
	source: unknown[],
	count: number,
	cellOpts?: CellOpts,
	reverse = false
): unknown[] {
	const singleStep = reverse ? -1 : 1;
	if (count <= 0 || source.length === 0) {
		return [];
	}
	const variant = cellOpts?.variant;
	if (!SERIES_VARIANTS.has(variant)) {
		return repeatPattern(source, count);
	}

	if (
		source.every((value) => isNativeNumber(value) && Number.isFinite(value))
	) {
		if (source.length === 1) {
			return repeatPattern(source, count);
		}
		const numbers = source.filter((v): v is number => isNativeNumber(v));
		const trend = linearTrend(numbers);
		return Array.from({ length: count }, (_, i) =>
			roundSeriesNumber(trend(numbers.length + i))
		);
	}

	const dates = dateSeries(source, count, singleStep);
	if (dates) {
		return dates;
	}

	if (source.every((value) => isNativeText(value) && value !== "")) {
		const strings = source.filter((v): v is string => isNativeText(v));
		const series =
			nameSeries(strings, count, singleStep) ??
			trailingIntegerSeries(strings, count, singleStep);
		if (series) {
			return series;
		}
	}

	return repeatPattern(source, count);
}

export interface SelectionSummary {
	average: number | null;
	count: number;
	max: number | null;
	min: number | null;
	numericCount: number;
	sum: number | null;
}

/** Excel status-bar aggregates: Count of non-empty cells, numeric Sum/Avg/Min/Max. */
export function summarizeValues(values: Iterable<unknown>): SelectionSummary {
	let count = 0;
	let numericCount = 0;
	let sum = 0;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;

	for (const value of values) {
		if (isCellValueEmpty(value)) {
			continue;
		}
		count++;
		if (isNativeNumber(value) && Number.isFinite(value)) {
			numericCount++;
			sum += value;
			min = Math.min(min, value);
			max = Math.max(max, value);
		}
	}

	if (numericCount === 0) {
		return {
			count,
			numericCount,
			sum: null,
			average: null,
			min: null,
			max: null,
		};
	}
	return {
		count,
		numericCount,
		sum: roundSeriesNumber(sum),
		average: roundSeriesNumber(sum / numericCount),
		min,
		max,
	};
}

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
		return { text: value.toLocaleDateString(), chips: 0 };
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
