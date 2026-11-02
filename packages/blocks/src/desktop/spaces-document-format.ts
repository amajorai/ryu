import { activeLocale, dateFormatter } from "@ryu/i18n/core";
import { formatByteSize } from "@ryu/i18n/format-intl";
import type { SpaceDocumentRow } from "./spaces-types.ts";

/** A page preview is only meaningful for the first-party Markdown page kind. */
export function isMarkdownPage(doc: SpaceDocumentRow): boolean {
	return doc.kind === "page" && (!doc.rawKind || doc.rawKind === "page");
}

export function formatDocumentDate(
	timestamp: number | undefined,
	locale: string = activeLocale()
): string {
	if (!timestamp) {
		return "—";
	}
	const date = new Date(timestamp);
	if (Number.isNaN(date.valueOf())) {
		return "—";
	}
	return dateFormatter(locale, {
		day: "numeric",
		month: "short",
		year: "numeric",
	}).format(date);
}

export function formatDocumentSize(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || bytes <= 0) {
		return "—";
	}
	return formatByteSize(bytes, activeLocale(), {
		fractionDigits: (value) => (value >= 10 || Number.isInteger(value) ? 0 : 1),
		maxUnit: "gigabyte",
		trimZeros: true,
	});
}

export function documentTypeLabel(doc: SpaceDocumentRow): string {
	if (doc.rawKind === "file") {
		const subtype = doc.mime?.split("/").at(-1);
		return subtype ? subtype.toUpperCase() : "File";
	}
	if (doc.rawKind?.startsWith("app:")) {
		return "App document";
	}
	if (doc.kind === "database") {
		return "Database";
	}
	if (doc.kind === "whiteboard") {
		return "Whiteboard";
	}
	return "Markdown";
}

export function previewLines(source: string | undefined): string[] {
	const lines = (source ?? "")
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim())
		.slice(0, 8);
	return lines.length > 0 ? lines : ["A blank page ready for your first note."];
}
