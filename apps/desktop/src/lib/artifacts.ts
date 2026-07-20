// apps/desktop/src/lib/artifacts.ts
//
// Detection of "rendered / canvas artifacts" in an assistant message's text.
//
// LobeChat-style: an agent frequently replies with a fenced ```html / ```svg /
// ```mermaid block (or a large standalone code block) that is far more useful
// rendered than read as raw markdown. This util scans the message stream's text
// parts for those blocks and returns a stable, deterministic Artifact[] the
// Cowork panel lists and the ArtifactRenderer draws in a sandboxed frame.
//
// This is DISTINCT from the worktree "Artifacts" concept in CoworkContextPanel
// (files the agent created on disk this run). These are ephemeral, in-message,
// renderable payloads — never touched by git.
//
// Everything here is pure + defensive: unknown/loose shapes, no throws, and ids
// derived from `messageId + fenced-block index` (never Math.random) so the same
// message always yields the same artifact ids across re-renders.

export type ArtifactKind = "html" | "svg" | "mermaid" | "code";

export interface Artifact {
	/** The raw block body (HTML/SVG source, mermaid DSL, or code). */
	content: string;
	/** Stable id: `<messageId>-artifact-<blockIndex>`. */
	id: string;
	kind: ArtifactKind;
	/** The fenced language token, when the kind is `code` (e.g. "python"). */
	language?: string;
	/** The message this artifact was extracted from. */
	sourceMessageId: string;
	/** A short human label for the list row + panel tab. */
	title: string;
}

/** Loose view of a stream message — we only read `id`, `role`, and text parts. */
interface ArtifactSourceMessage {
	id?: string;
	parts?: Array<{ type?: string; text?: unknown } | null | undefined>;
	role?: string;
}

// A fenced block: an opening ``` with an optional language token, then the body
// up to the next ```. Non-greedy body so consecutive blocks don't merge. Hoisted
// (never built in a loop) and `lastIndex` reset before each scan.
const FENCE_RE = /```([A-Za-z0-9_+#-]*)[ \t]*\r?\n([\s\S]*?)```/g;
const SVG_TAG_RE = /<svg[\s>]/i;
const HTML_DOC_RE = /^\s*(<!doctype html|<html[\s>])/i;
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const HEADING_RE = /^#{1,3}\s+(.+?)\s*#*$/m;
const WHITESPACE_RE = /\s+/g;
const TRAILING_WS_RE = /\s+$/;

// A `code` block only becomes an artifact when it is substantial — otherwise
// every one-line snippet would clutter the panel. HTML/SVG/mermaid are always
// artifacts (their whole value is being rendered), regardless of size.
const LARGE_CODE_MIN_LINES = 16;
const LARGE_CODE_MIN_CHARS = 800;

// Fenced languages that are prose/data, not "canvas" code worth a big viewer.
const NON_CODE_LANGS = new Set([
	"",
	"text",
	"txt",
	"plaintext",
	"markdown",
	"md",
	"mdx",
	"log",
	"diff",
	"patch",
]);

const MAX_TITLE_LEN = 48;

function clampTitle(value: string): string {
	const trimmed = value.replace(WHITESPACE_RE, " ").trim();
	if (trimmed.length <= MAX_TITLE_LEN) {
		return trimmed;
	}
	return `${trimmed.slice(0, MAX_TITLE_LEN - 1)}…`;
}

/** Concatenate a message's text parts into one scannable string. */
function messageText(message: ArtifactSourceMessage): string {
	const parts = message.parts;
	if (!Array.isArray(parts)) {
		return "";
	}
	const chunks: string[] = [];
	for (const part of parts) {
		if (part && part.type === "text" && typeof part.text === "string") {
			chunks.push(part.text);
		}
	}
	return chunks.join("\n\n");
}

/** Map a fenced (lang, body) to a renderable kind, or null when it isn't one. */
function classifyBlock(lang: string, body: string): ArtifactKind | null {
	const normalized = lang.toLowerCase();
	if (normalized === "mermaid" || normalized === "mmd") {
		return "mermaid";
	}
	if (normalized === "svg") {
		return "svg";
	}
	if (normalized === "xml" && SVG_TAG_RE.test(body)) {
		return "svg";
	}
	if (normalized === "html" || normalized === "htm") {
		return "html";
	}
	if (normalized === "" && HTML_DOC_RE.test(body)) {
		return "html";
	}
	if (normalized === "" && SVG_TAG_RE.test(body)) {
		return "svg";
	}
	// A substantial code block becomes a viewable artifact.
	const isLarge =
		body.length >= LARGE_CODE_MIN_CHARS ||
		body.split("\n").length >= LARGE_CODE_MIN_LINES;
	if (isLarge && !NON_CODE_LANGS.has(normalized)) {
		return "code";
	}
	return null;
}

function htmlTitle(body: string): string {
	const titleMatch = TITLE_TAG_RE.exec(body);
	if (titleMatch?.[1]) {
		return clampTitle(titleMatch[1]);
	}
	const headingMatch = HEADING_RE.exec(body);
	if (headingMatch?.[1]) {
		return clampTitle(headingMatch[1]);
	}
	return "Web page";
}

function mermaidTitle(body: string): string {
	const firstLine = body.trim().split("\n")[0]?.trim() ?? "";
	const keyword = firstLine.split(WHITESPACE_RE)[0]?.toLowerCase() ?? "";
	if (keyword.startsWith("sequence")) {
		return "Sequence diagram";
	}
	if (keyword.startsWith("class")) {
		return "Class diagram";
	}
	if (keyword.startsWith("state")) {
		return "State diagram";
	}
	if (keyword.startsWith("gantt")) {
		return "Gantt chart";
	}
	if (keyword.startsWith("pie")) {
		return "Pie chart";
	}
	if (keyword.startsWith("erdiagram") || keyword.startsWith("er")) {
		return "ER diagram";
	}
	return "Diagram";
}

function codeTitle(lang: string): string {
	if (!lang) {
		return "Code";
	}
	const pretty = lang.charAt(0).toUpperCase() + lang.slice(1);
	return `${pretty} snippet`;
}

function titleFor(kind: ArtifactKind, lang: string, body: string): string {
	if (kind === "html") {
		return htmlTitle(body);
	}
	if (kind === "svg") {
		return "Vector image";
	}
	if (kind === "mermaid") {
		return mermaidTitle(body);
	}
	return codeTitle(lang.toLowerCase());
}

/** Extract every renderable artifact from one message's text (in order). */
function artifactsFromMessage(
	message: ArtifactSourceMessage,
	fallbackId: string
): Artifact[] {
	const text = messageText(message);
	if (!text.includes("```")) {
		return [];
	}
	const sourceMessageId =
		typeof message.id === "string" && message.id ? message.id : fallbackId;
	const found: Artifact[] = [];
	let blockIndex = 0;
	for (const match of text.matchAll(FENCE_RE)) {
		const lang = match[1] ?? "";
		const body = match[2] ?? "";
		const kind = body.trim() ? classifyBlock(lang, body) : null;
		if (kind) {
			found.push({
				id: `${sourceMessageId}-artifact-${blockIndex}`,
				kind,
				title: titleFor(kind, lang, body),
				content: body.replace(TRAILING_WS_RE, ""),
				language: kind === "code" ? lang.toLowerCase() || undefined : undefined,
				sourceMessageId,
			});
		}
		blockIndex += 1;
	}
	return found;
}

/**
 * Scan the whole conversation for rendered/canvas artifacts. Only assistant (or
 * unlabelled) messages are considered — a user pasting HTML is input, not an
 * artifact to render. Returns them in stream order; ids are stable per message.
 */
export function extractArtifacts(
	messages: readonly ArtifactSourceMessage[]
): Artifact[] {
	const all: Artifact[] = [];
	for (const [i, message] of messages.entries()) {
		if (!message || message.role === "user") {
			continue;
		}
		const fromMessage = artifactsFromMessage(message, `msg-${i}`);
		for (const artifact of fromMessage) {
			all.push(artifact);
		}
	}
	return all;
}
