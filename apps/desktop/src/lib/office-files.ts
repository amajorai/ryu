export type WorkspaceFileKind =
	| "document"
	| "pdf"
	| "slides"
	| "spreadsheet"
	| "unsupported";

const MIME_KIND = new Map<string, WorkspaceFileKind>([
	["application/pdf", "pdf"],
	["application/vnd.ms-excel.sheet.macroenabled.12", "spreadsheet"],
	["application/vnd.ms-powerpoint.presentation.macroenabled.12", "slides"],
	[
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"slides",
	],
	[
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"spreadsheet",
	],
	[
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"document",
	],
]);

const EXTENSION_KIND = new Map<string, WorkspaceFileKind>([
	["docx", "document"],
	["pdf", "pdf"],
	["pptm", "slides"],
	["pptx", "slides"],
	["xlsm", "spreadsheet"],
	["xlsx", "spreadsheet"],
]);

export function workspaceFileKind(
	title: string,
	mime: string | null | undefined
): WorkspaceFileKind {
	const baseMime = mime?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	const byMime = MIME_KIND.get(baseMime);
	if (byMime) {
		return byMime;
	}
	const extension = title.trim().toLowerCase().split(".").pop() ?? "";
	return EXTENSION_KIND.get(extension) ?? "unsupported";
}

export function workspaceFileLabel(kind: WorkspaceFileKind): string {
	switch (kind) {
		case "document":
			return "Word document";
		case "pdf":
			return "PDF";
		case "slides":
			return "Slide deck";
		case "spreadsheet":
			return "Spreadsheet";
		default:
			return "File";
	}
}

/** One-based spreadsheet column label (`1 → A`, `27 → AA`). */
export function spreadsheetColumnLabel(column: number): string {
	let value = Math.max(1, Math.trunc(column));
	let label = "";
	while (value > 0) {
		value -= 1;
		label = String.fromCharCode(65 + (value % 26)) + label;
		value = Math.floor(value / 26);
	}
	return label;
}

export type ParsedSpreadsheetInput =
	| { kind: "blank" }
	| { formula: string; kind: "formula" }
	| { kind: "value"; value: boolean | number | string };

export function parseSpreadsheetInput(input: string): ParsedSpreadsheetInput {
	if (input === "") {
		return { kind: "blank" };
	}
	if (input.startsWith("=") && input.length > 1) {
		return { formula: input.slice(1), kind: "formula" };
	}
	const normalized = input.trim().toLowerCase();
	if (normalized === "true") {
		return { kind: "value", value: true };
	}
	if (normalized === "false") {
		return { kind: "value", value: false };
	}
	if (input.trim() !== "" && Number.isFinite(Number(input))) {
		return { kind: "value", value: Number(input) };
	}
	return { kind: "value", value: input };
}
