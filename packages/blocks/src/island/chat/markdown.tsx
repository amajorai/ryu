// A deliberately tiny markdown renderer for assistant replies. The island is a
// companion surface, not the full desktop app, so we avoid pulling in a heavy
// markdown dependency. This covers the constructs an agent reply commonly uses:
// fenced code blocks, inline code, bold, italics, and line breaks. Anything else
// renders as plain text, which is safe (no raw HTML is ever injected).

// biome-ignore lint/correctness/noUnresolvedImports: Fragment is a valid React export; biome's resolver misreports it
import { Fragment, type ReactNode } from "react";

const BOLD = /\*\*([^*]+)\*\*/g;
const ITALIC = /(?<![*])\*([^*]+)\*(?![*])/g;
const INLINE_CODE = /`([^`]+)`/g;

interface Segment {
	kind: "bold" | "code" | "italic" | "text";
	value: string;
}

// Split a single line of text into styled inline segments. Order matters:
// inline code is extracted first so markers inside code spans are left literal.
function tokenizeInline(line: string): Segment[] {
	const segments: Segment[] = [];
	let cursor = 0;
	INLINE_CODE.lastIndex = 0;

	for (
		let match = INLINE_CODE.exec(line);
		match !== null;
		match = INLINE_CODE.exec(line)
	) {
		if (match.index > cursor) {
			segments.push(...tokenizeEmphasis(line.slice(cursor, match.index)));
		}
		segments.push({ kind: "code", value: match[1] });
		cursor = match.index + match[0].length;
	}
	if (cursor < line.length) {
		segments.push(...tokenizeEmphasis(line.slice(cursor)));
	}
	return segments;
}

// Resolve bold then italic markers in a code-free text fragment.
function tokenizeEmphasis(text: string): Segment[] {
	const segments: Segment[] = [];
	let cursor = 0;
	BOLD.lastIndex = 0;

	for (let match = BOLD.exec(text); match !== null; match = BOLD.exec(text)) {
		if (match.index > cursor) {
			segments.push(...tokenizeItalic(text.slice(cursor, match.index)));
		}
		segments.push({ kind: "bold", value: match[1] });
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) {
		segments.push(...tokenizeItalic(text.slice(cursor)));
	}
	return segments;
}

function tokenizeItalic(text: string): Segment[] {
	const segments: Segment[] = [];
	let cursor = 0;
	ITALIC.lastIndex = 0;

	for (
		let match = ITALIC.exec(text);
		match !== null;
		match = ITALIC.exec(text)
	) {
		if (match.index > cursor) {
			segments.push({ kind: "text", value: text.slice(cursor, match.index) });
		}
		segments.push({ kind: "italic", value: match[1] });
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) {
		segments.push({ kind: "text", value: text.slice(cursor) });
	}
	return segments;
}

function renderSegment(segment: Segment, key: number): ReactNode {
	if (segment.kind === "code") {
		return (
			<code
				className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.8em]"
				key={key}
			>
				{segment.value}
			</code>
		);
	}
	if (segment.kind === "bold") {
		return (
			<strong className="font-semibold" key={key}>
				{segment.value}
			</strong>
		);
	}
	if (segment.kind === "italic") {
		return <em key={key}>{segment.value}</em>;
	}
	return <Fragment key={key}>{segment.value}</Fragment>;
}

function renderInline(line: string): ReactNode[] {
	return tokenizeInline(line).map((segment, index) =>
		renderSegment(segment, index)
	);
}

// Render fenced code blocks (```) as preformatted blocks and everything else as
// paragraphs of inline-styled text. Blank lines separate paragraphs.
function renderBlocks(text: string): ReactNode[] {
	const blocks: ReactNode[] = [];
	const lines = text.split("\n");
	let inFence = false;
	let fenceLines: string[] = [];
	let paragraph: string[] = [];
	let blockKey = 0;

	const flushParagraph = (): void => {
		if (paragraph.length === 0) {
			return;
		}
		const text_ = paragraph.join("\n");
		blocks.push(
			<p
				className="whitespace-pre-wrap leading-relaxed"
				key={`p-${blockKey++}`}
			>
				{text_.split("\n").map((row, rowIndex) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
					<Fragment key={rowIndex}>
						{rowIndex > 0 ? <br /> : null}
						{renderInline(row)}
					</Fragment>
				))}
			</p>
		);
		paragraph = [];
	};

	for (const line of lines) {
		if (line.trim().startsWith("```")) {
			if (inFence) {
				blocks.push(
					<pre
						className="overflow-x-auto rounded-lg bg-black/40 p-2 font-mono text-[0.78rem] text-neutral-200"
						key={`code-${blockKey++}`}
					>
						<code>{fenceLines.join("\n")}</code>
					</pre>
				);
				fenceLines = [];
				inFence = false;
			} else {
				flushParagraph();
				inFence = true;
			}
			continue;
		}
		if (inFence) {
			fenceLines.push(line);
			continue;
		}
		if (line.trim() === "") {
			flushParagraph();
			continue;
		}
		paragraph.push(line);
	}

	if (inFence && fenceLines.length > 0) {
		blocks.push(
			<pre
				className="overflow-x-auto rounded-lg bg-black/40 p-2 font-mono text-[0.78rem] text-neutral-200"
				key={`code-${blockKey++}`}
			>
				<code>{fenceLines.join("\n")}</code>
			</pre>
		);
	}
	flushParagraph();
	return blocks;
}

/** Render a minimal subset of markdown without any external dependency. */
export function Markdown({ text }: { text: string }) {
	return <div className="flex flex-col gap-2">{renderBlocks(text)}</div>;
}
