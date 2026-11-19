// Layout for `ryu-cli secrets help`: usages and flags stay verbatim, and each
// description is one translated sentence wrapped at the description column,
// so a translation of any length keeps the two-column layout.

/** `[usage, description]` at indent 2, or `[usage, description, indent]`. */
export type HelpRow = readonly [string, string, number?];
/** A translated paragraph, wrapped at `indent` (default 2). */
export interface HelpProse {
	indent?: number;
	prose: string;
}
/** A verbatim line (headings arrive already translated), a row, or prose. */
export type HelpEntry = string | HelpRow | HelpProse;

const DESCRIPTION_COLUMN = 44;
const WIDTH = 104;

/** Greedy word wrap; a word longer than `width` keeps its own line. */
export function wrapWords(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/u).filter(Boolean)) {
		if (line && line.length + 1 + word.length > width) {
			lines.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) {
		lines.push(line);
	}
	return lines;
}

function renderRow([usage, description, indent = 2]: HelpRow): string[] {
	const prefix = `${" ".repeat(indent)}${usage}`;
	const pad = " ".repeat(DESCRIPTION_COLUMN);
	const wrapped = wrapWords(description, WIDTH - DESCRIPTION_COLUMN);
	if (prefix.length + 2 > DESCRIPTION_COLUMN) {
		return [prefix, ...wrapped.map((line) => `${pad}${line}`)];
	}
	const [first = "", ...rest] = wrapped;
	return [
		`${prefix.padEnd(DESCRIPTION_COLUMN)}${first}`,
		...rest.map((line) => `${pad}${line}`),
	];
}

/** Render help entries to lines. */
export function renderHelpEntries(entries: readonly HelpEntry[]): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		if (typeof entry === "string") {
			lines.push(entry);
		} else if ("prose" in entry) {
			const indent = entry.indent ?? 2;
			for (const line of wrapWords(entry.prose, WIDTH - indent)) {
				lines.push(`${" ".repeat(indent)}${line}`);
			}
		} else {
			lines.push(...renderRow(entry));
		}
	}
	return lines;
}
