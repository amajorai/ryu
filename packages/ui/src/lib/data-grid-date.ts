// Date cell parsing and display for the data grid. Split from `data-grid.ts`,
// which re-exports these.

import { activeLocale } from "@ryu/i18n/lite";
import { z } from "zod";
import { getDisplayLocale } from "./timezone.ts";

const cellTextSchema = z.string();
const localDateInputSchema = z.union([z.instanceof(Date), cellTextSchema]);

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
		// A malformed host locale token: the UI's own language instead.
		return date.toLocaleDateString(activeLocale());
	}
}
