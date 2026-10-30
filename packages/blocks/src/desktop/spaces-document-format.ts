import type { SpaceDocumentRow } from "./spaces-types.ts";

/** A page preview is only meaningful for the first-party Markdown page kind. */
export function isMarkdownPage(doc: SpaceDocumentRow): boolean {
	return doc.kind === "page" && (!doc.rawKind || doc.rawKind === "page");
}

export function formatDocumentDate(timestamp: number | undefined): string {
	if (!timestamp) {
		return "—";
	}
	const date = new Date(timestamp);
	if (Number.isNaN(date.valueOf())) {
		return "—";
	}
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	}).format(date);
}

export function formatDocumentSize(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || bytes <= 0) {
		return "—";
	}
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded =
		value >= 10 || Number.isInteger(value) ? Math.round(value) : value;
	return `${Number(rounded.toFixed(1))} ${units[unit]}`;
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
