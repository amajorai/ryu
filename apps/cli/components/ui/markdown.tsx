// @ts-nocheck - vendored termcn component, see scripts/vendor-termcn.ts
/* @jsxImportSource @opentui/react */
import React from "react";

import { Code } from "@/components/ui/code";
import { useTheme } from "@/components/ui/theme-provider";

export interface MarkdownProps {
	children: string;
	width?: number;
}

interface InlineSegment {
	text: string;
	bold?: boolean;
	italic?: boolean;
	code?: boolean;
	link?: boolean;
	url?: string;
}

export type MarkdownBlock =
	| { type: "text"; lines: string[] }
	| { type: "code"; language?: string; code: string };

/** Split Markdown into fenced code blocks without losing an unfinished stream. */
export const parseMarkdownBlocks = (value: string): MarkdownBlock[] => {
	const lines = value.split("\n");
	const blocks: MarkdownBlock[] = [];
	let textLines: string[] = [];
	let codeLines: string[] = [];
	let language: string | undefined;
	let inCode = false;

	const flushText = () => {
		if (textLines.length > 0) {
			blocks.push({ type: "text", lines: textLines });
			textLines = [];
		}
	};

	const flushCode = () => {
		const code = codeLines.join("\n");
		if (language) {
			blocks.push({ type: "code", language, code });
		} else {
			blocks.push({ type: "code", code });
		}
		codeLines = [];
		language = undefined;
	};

	for (const line of lines) {
		const fence = line.match(/^ {0,3}```([^`]*)$/);
		if (!inCode && fence) {
			flushText();
			language = fence[1]?.trim() || undefined;
			inCode = true;
			continue;
		}
		if (inCode && /^ {0,3}```\s*$/.test(line)) {
			flushCode();
			inCode = false;
			continue;
		}
		if (inCode) {
			codeLines.push(line);
		} else {
			textLines.push(line);
		}
	}

	if (inCode) {
		flushCode();
	} else {
		flushText();
	}
	return blocks;
};

const parseInline = (line: string): InlineSegment[] => {
	const segments: InlineSegment[] = [];
	const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((.+?)\))/g;
	let last = 0;
	let match = re.exec(line);

	while (match !== null) {
		if (match.index > last) {
			segments.push({ text: line.slice(last, match.index) });
		}

		const [full] = match;
		if (full.startsWith("**")) {
			segments.push({ bold: true, text: match[2] });
		} else if (full.startsWith("*")) {
			segments.push({ italic: true, text: match[3] });
		} else if (full.startsWith("`")) {
			segments.push({ code: true, text: match[4] });
		} else if (full.startsWith("[")) {
			segments.push({ link: true, text: match[5], url: match[6] });
		}

		last = match.index + full.length;
		match = re.exec(line);
	}

	if (last < line.length) {
		segments.push({ text: line.slice(last) });
	}

	return segments;
};

const InlineLine = ({ segments }: { segments: InlineSegment[] }) => {
	const theme = useTheme();

	return (
		<box>
			{segments.map((seg, i) => {
				if (seg.code) {
					return (
						<text key={i} fg={theme.colors.accent}>
							{seg.text}
						</text>
					);
				}
				if (seg.link) {
					return (
						<box key={i}>
							<text fg={theme.colors.info} underline={true}>
								{seg.text}
							</text>
							<text fg="#666">{` (${seg.url})`}</text>
						</box>
					);
				}
				let content: React.ReactNode = seg.text;
				if (seg.bold && seg.italic) {
					content = (
						<b>
							<i>{seg.text}</i>
						</b>
					);
				} else if (seg.bold) {
					content = <b>{seg.text}</b>;
				} else if (seg.italic) {
					content = <i>{seg.text}</i>;
				}
				return <text key={i}>{content}</text>;
			})}
		</box>
	);
};

// Paragraph-sized render units: a text block splits after each blank line so a
// prose-only reply still has finished units that the memo below can skip.
const toRenderBlocks = (blocks: MarkdownBlock[]): MarkdownBlock[] =>
	blocks.flatMap((block) => {
		if (block.type === "code") {
			return [block];
		}
		const units: MarkdownBlock[] = [];
		let lines: string[] = [];
		for (const line of block.lines) {
			lines.push(line);
			if (line === "") {
				units.push({ type: "text", lines });
				lines = [];
			}
		}
		if (lines.length > 0) {
			units.push({ type: "text", lines });
		}
		return units;
	});

const sameLines = (a: string[], b: string[]) =>
	a.length === b.length && a.every((line, index) => line === b[index]);

const sameBlock = (a: MarkdownBlock, b: MarkdownBlock) => {
	if (a.type === "code") {
		return b.type === "code" && a.language === b.language && a.code === b.code;
	}
	if (b.type === "code") return false;
	return sameLines(a.lines, b.lines);
};

// Finished blocks of a streaming reply parse to equal content on every token, so
// the memo skips them: each token re-renders only the block still growing
// instead of re-running inline parsing and code tokenizing for the whole reply.
const MarkdownBlockView = React.memo(
	function MarkdownBlockView({
		block,
		width,
	}: {
		block: MarkdownBlock;
		width?: number;
	}) {
		const theme = useTheme();
		if (block.type === "code") {
			return <Code language={block.language}>{block.code}</Code>;
		}

		const elements: React.ReactNode[] = [];
		let key = 0;
		for (const line of block.lines) {
			const h4 = line.match(/^####\s+(.*)/);
			const h3 = line.match(/^###\s+(.*)/);
			const h2 = line.match(/^##\s+(.*)/);
			const h1 = line.match(/^#\s+(.*)/);

			if (h1) {
				elements.push(
					<text key={key++} fg={theme.colors.primary}>
						<b>{h1[1]}</b>
					</text>,
				);
			} else if (h2) {
				elements.push(
					<text key={key++} fg={theme.colors.primary}>
						<b>{h2[1]}</b>
					</text>,
				);
			} else if (h3) {
				elements.push(
					<text key={key++} fg={theme.colors.primary}>
						<b>{h3[1]}</b>
					</text>,
				);
			} else if (h4) {
				elements.push(
					<text key={key++} fg={theme.colors.primary}>
						{h4[1]}
					</text>,
				);
			} else if (/^---+$/.test(line)) {
				elements.push(
					<text key={key++} fg={theme.colors.border}>
						{"─".repeat(width ?? 40)}
					</text>,
				);
			} else if (/^>\s/.test(line)) {
				const content = line.replace(/^>\s/, "");
				elements.push(
					<box key={key++} gap={1}>
						<text fg={theme.colors.primary}>│</text>
						<InlineLine segments={parseInline(content)} />
					</box>,
				);
			} else if (/^[-*]\s/.test(line)) {
				const content = line.replace(/^[-*]\s/, "");
				elements.push(
					<box key={key++} gap={1}>
						<text fg={theme.colors.mutedForeground}>•</text>
						<InlineLine segments={parseInline(content)} />
					</box>,
				);
			} else if (line === "") {
				elements.push(<box key={key++} />);
			} else {
				elements.push(
					<box key={key++} flexWrap="wrap">
						<InlineLine segments={parseInline(line)} />
					</box>,
				);
			}
		}
		return <>{elements}</>;
	},
	(prev, next) =>
		prev.width === next.width && sameBlock(prev.block, next.block),
);

export const Markdown = ({ children, width }: MarkdownProps) => {
	const blocks = React.useMemo(
		() => toRenderBlocks(parseMarkdownBlocks(children)),
		[children],
	);
	return (
		<box flexDirection="column">
			{blocks.map((block, index) => (
				<MarkdownBlockView block={block} key={index} width={width} />
			))}
		</box>
	);
};
