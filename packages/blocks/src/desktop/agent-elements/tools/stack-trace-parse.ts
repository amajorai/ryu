// Pure stack-trace parsing — no UI imports, so it is unit-testable in isolation.
// The StackTrace component (stack-trace.tsx) renders what this produces.

// A stack-trace frame line: "    at fn (file:line:col)" or "    at file:line:col".
const FRAME_RE = /^\s*at\s+(.*)$/;
// Trailing "(location)" group in a frame, e.g. "fn (file:line:col)".
const PAREN_LOCATION_RE = /^(.*?)\s*\(([^()]+)\)\s*$/;
// A "file:line:col" location tail.
const LOCATION_RE = /^(.*):(\d+):(\d+)$/;
// Gate: at least one `at …` frame line.
const HAS_FRAME_RE = /\n\s*at\s+\S/;

export interface StackFrame {
	col?: number;
	file: string;
	fn: string;
	internal: boolean;
	line?: number;
	raw: string;
}

export interface ParsedStackTrace {
	errorMessage: string;
	errorType: string;
	frames: StackFrame[];
}

function parseFrameLocation(location: string): {
	file: string;
	line?: number;
	col?: number;
} {
	const match = LOCATION_RE.exec(location.trim());
	if (!match) {
		return { file: location.trim() };
	}
	return {
		file: match[1] ?? location,
		line: Number(match[2]),
		col: Number(match[3]),
	};
}

function isInternalFile(file: string): boolean {
	return file.includes("node_modules") || file.startsWith("node:");
}

function parseFrame(inner: string): StackFrame {
	const parenMatch = PAREN_LOCATION_RE.exec(inner);
	const fn = parenMatch ? (parenMatch[1] ?? "").trim() : "";
	const location = parenMatch ? (parenMatch[2] ?? "") : inner;
	const { file, line, col } = parseFrameLocation(location);
	return {
		raw: inner,
		fn,
		file,
		line,
		col,
		internal: isInternalFile(file),
	};
}

/**
 * Parse a raw JS/Node stack-trace string into its error header and frames. The
 * header is every line up to the first `at …` frame; the first `": "` in it
 * splits the error type from its message.
 */
export function parseStackTrace(trace: string): ParsedStackTrace {
	const lines = trace.replace(/\r\n/g, "\n").split("\n");
	const headerLines: string[] = [];
	const frames: StackFrame[] = [];
	let inFrames = false;
	for (const line of lines) {
		const frameMatch = FRAME_RE.exec(line);
		if (frameMatch) {
			inFrames = true;
			frames.push(parseFrame(frameMatch[1] ?? ""));
			continue;
		}
		if (!inFrames && line.trim()) {
			headerLines.push(line.trim());
		}
	}
	const header = headerLines.join(" ").trim();
	const colonIndex = header.indexOf(": ");
	const errorType = colonIndex > 0 ? header.slice(0, colonIndex) : "";
	const errorMessage = colonIndex > 0 ? header.slice(colonIndex + 2) : header;
	return { errorType, errorMessage, frames };
}

/**
 * Heuristic gate before rendering a StackTrace: the text must contain at least
 * one `at …` frame line so plain error strings (a single `Error: nope`) never
 * masquerade as a full trace.
 */
export function looksLikeStackTrace(text: unknown): text is string {
	return typeof text === "string" && HAS_FRAME_RE.test(text);
}
