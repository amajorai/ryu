/**
 * Ryu copy — the `copy_paste` tool for the flagship, managed "ryu" (Pi) agent.
 *
 * WHY THIS EXISTS
 * ---------------
 * Pi's built-in file tools are `read`, `write` and `edit`. All three make the
 * model the transport for every byte it moves: relocating a function, splitting
 * a file, or reordering a list means reading the block and then RETYPING it into
 * an `edit`/`write` call. That costs output tokens proportional to the block,
 * and — the part that matters for small local models — it is lossy. A model
 * that retypes a 300-line table, a lockfile fragment, or a block of credentials
 * occasionally drops a row, "fixes" a typo that was data, or normalizes
 * whitespace that was significant. Cloud models hide the cost; local models
 * show the damage.
 *
 * `copy_paste` makes the move a pointer operation instead: the model names the
 * span (a line range or an exact snippet) and the destination, and the bytes
 * travel from disk to disk without passing through the model's output at all.
 * The result reports where the block landed and quotes only its first and last
 * line, so the model can verify the paste without the block re-entering its
 * context either.
 *
 * SHAPE
 * -----
 * One tool, not a stateful clipboard. A clipboard (`copy` now, `paste` later)
 * would need per-session state that Pi's extension runtime does not scope for
 * us, and a stale clip pasted three turns later is exactly the silent
 * corruption this tool exists to prevent. Every call reads the source fresh,
 * so the span is always what is on disk now.
 *
 *   - Source: `path` plus either `start_line`/`end_line` (1-based, inclusive)
 *     or `text` (an exact snippet that must occur exactly once).
 *   - Destination: `to_path` (defaults to `path`) plus either `to_line`
 *     (insert before that line), or `to_anchor` with `position`
 *     (`before` / `after` / `replace`), or neither (append at the end).
 *   - `move: true` removes the span from the source after the paste lands
 *     (cut-and-paste). Across files the destination is written FIRST, so a
 *     failed write can never lose the block.
 *
 * WHY NOTHING HERE NEEDS CORE
 * ---------------------------
 * The tool is gated by `ryu-plan.ts` (withheld in plan mode; sensitive targets
 * such as `.env` or `.git/` raise the same confirm `edit`/`write` do), renders
 * as an ordinary tool row, and touches nothing but the files it names. It
 * registers no slash command — `pi.registerCommand` deadlocks an ACP turn.
 */

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Prefix on every stderr line so Core's `acp_subprocess` log is greppable. */
const LOG_PREFIX = "[ryu-copy]";

/**
 * Largest file the tool will read or rewrite. Generous for source and data
 * files, and small enough that a mistaken path to a database dump or a build
 * artifact fails fast instead of pulling hundreds of megabytes into memory.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** A UTF-8 byte-order mark as the strict decoder keeps it. */
const BOM = "\uFEFF";

/** How much of the first/last pasted line the result quotes back. */
const PREVIEW_CHARS = 120;

/** The anchor placements `position` accepts. */
const POSITIONS = ["before", "after", "replace"] as const;
type Position = (typeof POSITIONS)[number];

interface CopyPasteParams {
	end_line?: number;
	move?: boolean;
	path: string;
	position?: string;
	start_line?: number;
	text?: string;
	to_anchor?: string;
	to_line?: number;
	to_path?: string;
}

/** A half-open `[from, to)` character span of a file. */
interface Span {
	from: number;
	to: number;
}

/** One replacement applied to a file's text. */
interface TextEdit extends Span {
	insert: string;
}

/** Where the clip goes in the destination text. */
interface Placement extends Span {
	/** Human description of the placement, for the result. */
	label: string;
	/** Text placed before the clip (a newline when appending to an unterminated file). */
	prefix: string;
	/** Text placed after the clip (a newline so a line clip stays on its own lines). */
	suffix: string;
}

function log(message: string): void {
	process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

/** Resolve a model-supplied path against the session cwd, expanding `~`. */
function resolvePath(raw: string, cwd: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new Error("copy_paste: a path is empty.");
	}
	if (trimmed === "~") {
		return os.homedir();
	}
	if (trimmed.startsWith("~/")) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return path.resolve(cwd, trimmed);
}

/** A path as the result should show it: relative to the cwd when inside it. */
function displayPath(absolute: string, cwd: string): string {
	const relative = path.relative(cwd, absolute);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
		? relative
		: absolute;
}

/** `stat` that answers `undefined` for a missing path instead of throwing. */
async function statIfExists(
	file: string
): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
	return await stat(file).catch((err: NodeJS.ErrnoException) => {
		if (err.code === "ENOENT") {
			return undefined;
		}
		throw err;
	});
}

/** The canonical location of `file`, resolving a missing file through its parent. */
async function canonicalPath(file: string, exists: boolean): Promise<string> {
	if (exists) {
		return await realpath(file);
	}
	const parent = await realpath(path.dirname(file)).catch(() =>
		path.dirname(file)
	);
	return path.join(parent, path.basename(file));
}

/**
 * Whether two resolved paths name the same file on disk. Comparing path
 * strings is not enough: a symlink or hardlink alias, or a different letter
 * case on a case-insensitive file system, names the same inode under another
 * string, and treating that as a cross-file move would write the block to the
 * destination and then overwrite the same file with the block removed.
 */
async function isSameFile(a: string, b: string): Promise<boolean> {
	if (a === b) {
		return true;
	}
	const [infoA, infoB] = await Promise.all([statIfExists(a), statIfExists(b)]);
	if (infoA && infoB) {
		return infoA.dev === infoB.dev && infoA.ino === infoB.ino;
	}
	if (!(infoA || infoB)) {
		return false;
	}
	const [realA, realB] = await Promise.all([
		canonicalPath(a, infoA !== undefined),
		canonicalPath(b, infoB !== undefined),
	]);
	return realA === realB;
}

/**
 * Decodes UTF-8 strictly. `ignoreBOM` keeps a leading U+FEFF in the string so
 * writing the text back reproduces the file's bytes exactly.
 */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Read a text file, or `undefined` when it does not exist. */
async function readTextFile(file: string): Promise<string | undefined> {
	const info = await statIfExists(file);
	if (!info) {
		return undefined;
	}
	if (!info.isFile()) {
		throw new Error(`copy_paste: ${file} is not a regular file.`);
	}
	if (info.size > MAX_FILE_BYTES) {
		throw new Error(
			`copy_paste: ${file} is ${info.size} bytes; the limit is ${MAX_FILE_BYTES}.`
		);
	}
	// Strict decoding: a lenient read would turn every invalid byte into U+FFFD
	// and the rewrite would silently re-encode the whole file.
	let body: string;
	try {
		body = strictUtf8.decode(await readFile(file));
	} catch {
		throw new Error(
			`copy_paste: ${file} is not valid UTF-8 text; only UTF-8 files are supported.`
		);
	}
	if (body.includes("\0")) {
		throw new Error(
			`copy_paste: ${file} looks binary (it contains NUL bytes); only text files are supported.`
		);
	}
	return body;
}

/** Character offset at which each line starts. A trailing newline opens no new line. */
function lineStarts(body: string): number[] {
	if (body === "") {
		return [];
	}
	const starts = [0];
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "\n" && i + 1 < body.length) {
			starts.push(i + 1);
		}
	}
	return starts;
}

function countNewlines(body: string): number {
	let count = 0;
	for (const char of body) {
		if (char === "\n") {
			count++;
		}
	}
	return count;
}

/** The newline style a file already uses, so an added terminator matches it. */
function eolOf(body: string): string {
	return body.includes("\r\n") ? "\r\n" : "\n";
}

/** `offset`, moved past a leading byte-order mark when it points at one. */
function afterBom(body: string, offset: number): number {
	return offset === 0 && body.startsWith(BOM) ? BOM.length : offset;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 1;
}

/** The offset of the only occurrence of `needle`, or a thrown explanation. */
function uniqueOffset(body: string, needle: string, what: string): number {
	if (!needle) {
		throw new Error(`copy_paste: \`${what}\` is empty.`);
	}
	const first = body.indexOf(needle);
	if (first === -1) {
		throw new Error(
			`copy_paste: \`${what}\` was not found. It must match the file exactly, including whitespace.`
		);
	}
	// `first + 1`, not `first + needle.length`: overlapping matches are still
	// ambiguous ("aa" in "aaa").
	if (body.indexOf(needle, first + 1) !== -1) {
		throw new Error(
			`copy_paste: \`${what}\` occurs more than once. Include more surrounding text so it is unique, or use line numbers.`
		);
	}
	return first;
}

/** Resolve the source selection to a span and a description of it. */
function selectSpan(
	body: string,
	params: CopyPasteParams
): { label: string; span: Span } {
	const byLines =
		params.start_line !== undefined || params.end_line !== undefined;
	const byText = params.text !== undefined;
	if (byLines === byText) {
		throw new Error(
			"copy_paste: select the source with either `start_line`/`end_line` or `text`, not both and not neither."
		);
	}
	if (byText) {
		const text = params.text ?? "";
		const from = uniqueOffset(body, text, "text");
		return {
			label: "the matched text",
			span: { from, to: from + text.length },
		};
	}
	const startLine = params.start_line ?? params.end_line;
	const endLine = params.end_line ?? params.start_line;
	if (!(isPositiveInteger(startLine) && isPositiveInteger(endLine))) {
		throw new Error(
			"copy_paste: `start_line` and `end_line` must be whole numbers ≥ 1."
		);
	}
	if (endLine < startLine) {
		throw new Error(
			`copy_paste: \`end_line\` (${endLine}) is before \`start_line\` (${startLine}).`
		);
	}
	const starts = lineStarts(body);
	if (endLine > starts.length) {
		throw new Error(
			`copy_paste: the source has ${starts.length} line(s); line ${endLine} does not exist.`
		);
	}
	// A byte-order mark belongs to the file, not to line 1: keep it out of the
	// clip so it never lands as an invisible character mid-destination.
	const from = afterBom(body, starts[startLine - 1] ?? 0);
	const to = endLine < starts.length ? (starts[endLine] ?? 0) : body.length;
	const label =
		startLine === endLine
			? `line ${startLine}`
			: `lines ${startLine}-${endLine}`;
	return { label, span: { from, to } };
}

function parsePosition(raw: string | undefined): Position {
	const value = raw ?? "after";
	const match = POSITIONS.find((p) => p === value);
	if (!match) {
		throw new Error(
			`copy_paste: \`position\` must be one of ${POSITIONS.join(", ")}; got "${value}".`
		);
	}
	return match;
}

/** A line-shaped insertion at `offset`: the clip lands on whole lines of its own. */
function linePlacement(
	dest: string,
	offset: number,
	clip: string,
	label: string
): Placement {
	const eol = eolOf(dest);
	const atUnterminatedEnd =
		offset === dest.length && dest !== "" && !dest.endsWith("\n");
	return {
		from: offset,
		to: offset,
		label,
		prefix: atUnterminatedEnd ? eol : "",
		suffix: clip.endsWith("\n") ? "" : eol,
	};
}

/** Resolve where the clip goes in `dest`. */
function placeClip(
	dest: string,
	clip: string,
	params: CopyPasteParams
): Placement {
	if (params.to_line !== undefined && params.to_anchor !== undefined) {
		throw new Error(
			"copy_paste: give the destination as `to_line` or `to_anchor`, not both."
		);
	}
	if (params.to_anchor !== undefined) {
		const position = parsePosition(params.position);
		const at = uniqueOffset(dest, params.to_anchor, "to_anchor");
		const end = at + params.to_anchor.length;
		const span =
			position === "before"
				? { from: at, to: at }
				: position === "after"
					? { from: end, to: end }
					: { from: at, to: end };
		const label =
			position === "replace"
				? "in place of the anchor"
				: `${position} the anchor`;
		return { ...span, label, prefix: "", suffix: "" };
	}
	if (params.position !== undefined) {
		throw new Error("copy_paste: `position` only applies with `to_anchor`.");
	}
	const starts = lineStarts(dest);
	if (params.to_line === undefined) {
		return linePlacement(dest, dest.length, clip, "at the end");
	}
	if (!isPositiveInteger(params.to_line)) {
		throw new Error("copy_paste: `to_line` must be a whole number ≥ 1.");
	}
	if (params.to_line > starts.length + 1) {
		throw new Error(
			`copy_paste: the destination has ${starts.length} line(s); \`to_line\` may be at most ${starts.length + 1} (append).`
		);
	}
	const offset =
		params.to_line <= starts.length
			? (starts[params.to_line - 1] ?? 0)
			: dest.length;
	return linePlacement(
		dest,
		afterBom(dest, offset),
		clip,
		`before line ${params.to_line}`
	);
}

/**
 * Apply non-overlapping edits; later offsets first so earlier ones stay valid.
 * At a shared offset the wider edit (a removal) goes first, so a zero-width
 * insertion there cannot shift the bytes the removal targets.
 */
function applyEdits(body: string, edits: TextEdit[]): string {
	let out = body;
	const ordered = [...edits].sort(
		(a, b) => b.from - a.from || b.to - b.from - (a.to - a.from)
	);
	for (const edit of ordered) {
		out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
	}
	return out;
}

function spansOverlap(a: Span, b: Span): boolean {
	// A zero-width insertion point touching an edge of the span is fine; one
	// strictly inside it is not.
	if (a.from === a.to) {
		return a.from > b.from && a.from < b.to;
	}
	return a.from < b.to && b.from < a.to;
}

function preview(line: string): string {
	const trimmed = line.replace(/\r$/, "");
	return trimmed.length <= PREVIEW_CHARS
		? trimmed
		: `${trimmed.slice(0, PREVIEW_CHARS - 1)}…`;
}

/** Everything the result reports, computed once from the final destination text. */
function describeLanding(
	finalDest: string,
	pasteStart: number,
	body: string
): { firstLine: string; lastLine: string; lineFrom: number; lineTo: number } {
	const lineFrom = countNewlines(finalDest.slice(0, pasteStart)) + 1;
	const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
	const lines = trimmed.split("\n");
	return {
		firstLine: preview(lines[0] ?? ""),
		lastLine: preview(lines.at(-1) ?? ""),
		lineFrom,
		lineTo: lineFrom + lines.length - 1,
	};
}

/** The whole operation, exported for the co-located behavior test. */
async function copyPaste(params: CopyPasteParams, cwd: string) {
	if (typeof params?.path !== "string") {
		throw new Error("copy_paste: `path` is required.");
	}
	const sourcePath = resolvePath(params.path, cwd);
	const destPath =
		params.to_path === undefined
			? sourcePath
			: resolvePath(params.to_path, cwd);
	const sameFile = await isSameFile(sourcePath, destPath);
	const move = params.move === true;

	const source = await readTextFile(sourcePath);
	if (source === undefined) {
		throw new Error(`copy_paste: ${params.path} does not exist.`);
	}
	const selection = selectSpan(source, params);
	const clip = source.slice(selection.span.from, selection.span.to);
	if (!clip) {
		throw new Error("copy_paste: the selection is empty.");
	}

	const existingDest = sameFile ? source : await readTextFile(destPath);
	const created = existingDest === undefined;
	if (
		created &&
		(params.to_anchor !== undefined || (params.to_line ?? 1) > 1)
	) {
		throw new Error(
			`copy_paste: ${params.to_path} does not exist, so it has no lines or anchors to paste at. Omit the destination position to create it.`
		);
	}
	const dest = existingDest ?? "";
	// Anchors paste verbatim; a line position keeps the clip on lines of its own.
	const placement = placeClip(dest, clip, params);
	const pasted = placement.prefix + clip + placement.suffix;

	let finalDest: string;
	let finalSource: string | undefined;
	// Moving the file's last block to the end of the same file leaves it where
	// it is. Applied literally, an unterminated last line would gain a
	// terminator and leave a blank line behind.
	const noOpMove =
		sameFile &&
		move &&
		placement.from === placement.to &&
		placement.from === selection.span.to &&
		selection.span.to === dest.length;
	if (noOpMove) {
		finalDest = dest;
	} else if (sameFile && move) {
		if (spansOverlap(placement, selection.span)) {
			throw new Error(
				"copy_paste: the destination is inside the span being moved; pick a position outside it."
			);
		}
		finalDest = applyEdits(dest, [
			{ ...placement, insert: pasted },
			{ ...selection.span, insert: "" },
		]);
	} else {
		finalDest = applyEdits(dest, [{ ...placement, insert: pasted }]);
		if (move) {
			finalSource = applyEdits(source, [{ ...selection.span, insert: "" }]);
		}
	}

	// Destination first: if the source rewrite then fails, the block exists in
	// two places rather than none.
	if (created) {
		await mkdir(path.dirname(destPath), { recursive: true });
	}
	if (!noOpMove) {
		await writeFile(destPath, finalDest, "utf8");
	}
	if (finalSource !== undefined) {
		await writeFile(sourcePath, finalSource, "utf8");
	}

	const removedBefore =
		sameFile && move && selection.span.to <= placement.from
			? selection.span.to - selection.span.from
			: 0;
	const pasteStart = noOpMove
		? selection.span.from
		: placement.from - removedBefore + placement.prefix.length;
	const landing = describeLanding(finalDest, pasteStart, clip);
	const lineCount = landing.lineTo - landing.lineFrom + 1;

	const shownSource = displayPath(sourcePath, cwd);
	const shownDest = displayPath(destPath, cwd);
	const verb = move ? "Moved" : "Copied";
	const where = sameFile
		? placement.label
		: `to ${shownDest} ${placement.label}`;
	const text = [
		`${verb} ${selection.label} of ${shownSource} (${lineCount} line${lineCount === 1 ? "" : "s"}, ${clip.length} chars) ${where}${created ? " (new file)" : ""}.`,
		`It now occupies line${lineCount === 1 ? ` ${landing.lineFrom}` : `s ${landing.lineFrom}-${landing.lineTo}`} of ${shownDest}. The bytes were copied, not retyped.`,
		`First line: ${landing.firstLine}`,
		...(lineCount > 1 ? [`Last line: ${landing.lastLine}`] : []),
	].join("\n");

	return {
		content: [{ type: "text" as const, text }],
		details: {
			chars: clip.length,
			created,
			dest_line_from: landing.lineFrom,
			dest_line_to: landing.lineTo,
			dest_path: destPath,
			lines: lineCount,
			mode: move ? "move" : "copy",
			source_path: sourcePath,
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "copy_paste",
		label: "Copy & Paste",
		description: [
			"Copy or move a block of text between or within files without retyping it: the bytes go from disk to disk exactly, so nothing is mangled and no output tokens are spent on the block.",
			"Select the source in `path` with `start_line`/`end_line` (1-based, inclusive) or with `text` (an exact snippet that occurs exactly once).",
			"Paste into `to_path` (defaults to `path`) before line `to_line`, at `to_anchor` (an exact unique snippet) with `position` before/after/replace, or at the end when neither is given. A missing `to_path` is created.",
			"Set `move: true` to cut instead of copy. Files must be UTF-8 text under 8 MiB.",
		].join(" "),
		promptSnippet: "Copy or move a block of text without retyping it",
		promptGuidelines: [
			"Prefer copy_paste over edit/write whenever you would otherwise reproduce existing text verbatim: moving a function, splitting or merging files, reordering sections, or duplicating a block as a starting point. Then use edit for the small changes the copy needs.",
			"Read the source first so the line numbers or snippet are current; line numbers shift after every edit, including a copy_paste into the same file.",
			"The result quotes only the first and last pasted line. Check them, and re-read the destination if anything looks off, instead of re-pasting.",
		],
		parameters: Type.Object({
			path: Type.String({
				description:
					"File to copy from. Relative paths resolve against the session's working directory.",
			}),
			start_line: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"First line of the block (1-based). Use with end_line; omit when selecting by `text`.",
				})
			),
			end_line: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"Last line of the block, inclusive. Defaults to start_line.",
				})
			),
			text: Type.Optional(
				Type.String({
					description:
						"Exact text to copy, matched byte-for-byte; it must occur exactly once in the file. Use instead of line numbers.",
				})
			),
			to_path: Type.Optional(
				Type.String({
					description:
						"File to paste into. Defaults to `path`. Created (with parent directories) when missing.",
				})
			),
			to_line: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"Insert the block before this line of the destination (1-based). One past the last line appends.",
				})
			),
			to_anchor: Type.Optional(
				Type.String({
					description:
						"Exact text in the destination to paste relative to; it must occur exactly once. Use instead of to_line.",
				})
			),
			position: Type.Optional(
				Type.String({
					description:
						"Where to paste relative to to_anchor: `before`, `after` (default), or `replace` (the anchor is replaced by the block).",
				})
			),
			move: Type.Optional(
				Type.Boolean({
					description:
						"Remove the block from the source after pasting (cut and paste). Defaults to false.",
				})
			),
		}),
		// async so validation throws become rejections -> Pi turns them into
		// isError tool results the model can read and correct.
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				return await copyPaste(params as CopyPasteParams, ctx.cwd);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log(`copy_paste failed: ${message}`);
				throw err instanceof Error ? err : new Error(message);
			}
		},
	});
}

export { copyPaste };
