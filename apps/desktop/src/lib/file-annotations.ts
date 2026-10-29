// Line-anchored notes on a workspace file, and the chat text they become.
//
// The side-panel file viewer lets the user select a line range, write a note on
// it, and send every note to the chat composer — the file counterpart of the
// browser sidecar's visual annotations. Everything here is pure so the excerpt
// and Markdown shape the agent receives can be tested without a renderer.

/** One saved note, anchored to an inclusive 1-based line range. */
export interface FileAnnotationNote {
	comment: string;
	endLine: number;
	/** The selected source text, captured when the note was saved. */
	excerpt: string;
	id: string;
	startLine: number;
}

export interface FileLineRange {
	endLine: number;
	startLine: number;
}

/**
 * Larger files stay openable externally; rendering and tokenizing megabytes in
 * a narrow dock adds nothing to an annotation workflow.
 */
export const FILE_VIEWER_MAX_CHARS = 2_000_000;

export type DecodedViewerText =
	| { kind: "text"; text: string }
	| { kind: "binary" }
	| { kind: "too-large" };

/**
 * Decodes the base64 body of the size-bounded `read_project_file_binary`
 * command. Invalid UTF-8 or NUL bytes mean the file is not text worth quoting.
 */
export function decodeViewerText(base64: string): DecodedViewerText {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	if (bytes.includes(0)) {
		return { kind: "binary" };
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { kind: "binary" };
	}
	return text.length > FILE_VIEWER_MAX_CHARS
		? { kind: "too-large" }
		: { kind: "text", text };
}

/** Long selections are trimmed so one note cannot flood the composer. */
export const FILE_ANNOTATION_MAX_EXCERPT_LINES = 120;

/**
 * Normalizes a viewer selection (drag direction is either way) into an ordered
 * range clamped to the file, or `null` when nothing usable is selected.
 */
export function normalizeLineRange(
	range: { end: number; start: number } | null | undefined,
	lineCount: number
): FileLineRange | null {
	if (!range || lineCount < 1) {
		return null;
	}
	const low = Math.min(range.start, range.end);
	const high = Math.max(range.start, range.end);
	if (!(Number.isFinite(low) && Number.isFinite(high)) || high < 1) {
		return null;
	}
	const endLine = Math.min(lineCount, Math.trunc(high));
	return {
		startLine: Math.min(endLine, Math.max(1, Math.trunc(low))),
		endLine,
	};
}

/**
 * Line count as the viewer numbers it: a trailing newline shows (and can be
 * selected) as a final empty line, so it counts.
 */
export function countLines(contents: string): number {
	return contents.length === 0 ? 0 : contents.split("\n").length;
}

/** The text of an inclusive range, trimmed to the excerpt cap. */
export function excerptLines(contents: string, range: FileLineRange): string {
	const lines = contents.split("\n");
	const selected = lines.slice(range.startLine - 1, range.endLine);
	if (selected.length <= FILE_ANNOTATION_MAX_EXCERPT_LINES) {
		return selected.join("\n");
	}
	const omitted = selected.length - FILE_ANNOTATION_MAX_EXCERPT_LINES;
	return `${selected.slice(0, FILE_ANNOTATION_MAX_EXCERPT_LINES).join("\n")}\n… ${omitted} more line${omitted === 1 ? "" : "s"}`;
}

export function formatLineLabel(range: FileLineRange): string {
	return range.startLine === range.endLine
		? `line ${range.startLine}`
		: `lines ${range.startLine}–${range.endLine}`;
}

/** A fence one backtick longer than any run inside `text`, so it cannot close early. */
function fenceFor(text: string): string {
	let longest = 0;
	for (const match of text.matchAll(/`+/g)) {
		longest = Math.max(longest, match[0].length);
	}
	return "`".repeat(Math.max(3, longest + 1));
}

/** Markdown info string from the extension; unknown/dotfiles render untagged. */
function fenceLanguage(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) {
		return "";
	}
	const extension = name.slice(dot + 1).toLowerCase();
	return /^[a-z0-9+#-]{1,16}$/.test(extension) ? extension : "";
}

function quoteBlock(path: string, excerpt: string): string {
	const fence = fenceFor(excerpt);
	return `${fence}${fenceLanguage(path)}\n${excerpt}\n${fence}`;
}

/**
 * The composer text for a set of notes on one file: each note quotes its exact
 * lines, then the user's comment, ordered by position in the file.
 */
export function formatFileAnnotationsForChat(
	path: string,
	notes: readonly FileAnnotationNote[]
): string {
	const ordered = [...notes].sort(
		(left, right) =>
			left.startLine - right.startLine || left.endLine - right.endLine
	);
	const sections = ordered.map((note, index) => {
		const heading = `${ordered.length > 1 ? `${index + 1}. ` : ""}\`${path}\` ${formatLineLabel(note)}:`;
		const comment = note.comment.trim();
		return [heading, quoteBlock(path, note.excerpt), comment]
			.filter(Boolean)
			.join("\n");
	});
	const intro =
		ordered.length > 1
			? `Notes on \`${path}\` (${ordered.length} selections):\n\n`
			: "";
	return `${intro}${sections.join("\n\n")}`;
}

/** Inserts quoted file context into the focused chat composer (see CouncilInputBar). */
export const CHAT_COMPOSER_INSERT_EVENT = "ryu:chat-composer-insert";

export interface ChatComposerInsertDetail {
	text: string;
}

/**
 * Offers `text` to the active chat composer. Returns `true` when a composer
 * accepted it (it cancels the event), so callers can fall back otherwise.
 */
export function requestChatComposerInsert(text: string): boolean {
	const event = new CustomEvent<ChatComposerInsertDetail>(
		CHAT_COMPOSER_INSERT_EVENT,
		{ cancelable: true, detail: { text } }
	);
	return !globalThis.dispatchEvent(event);
}

/** Appends a quoted block to an existing draft, separated by a blank line. */
export function appendToComposerValue(value: string, text: string): string {
	const draft = value.trimEnd();
	return draft ? `${draft}\n\n${text}\n\n` : `${text}\n\n`;
}
