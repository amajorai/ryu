import { safeNavigationUrl } from "@ryu/ui/lib/safe-url.ts";
import type { Citation } from "./inline-citation.tsx";
import type { LinkPreviewResolvers } from "./link-preview.tsx";
import type { MentionItem } from "./types.ts";

export function safeMarkdownDestination(value: string): string | null {
	const navigation = safeNavigationUrl(value);
	if (navigation) {
		return navigation;
	}
	try {
		const parsed = new URL(value);
		return parsed.protocol === "mailto:" && parsed.pathname
			? parsed.href
			: null;
	} catch {
		return null;
	}
}

export function fixNumberedListBreaks(text: string): string {
	return text.replace(/^(\d+)\.\s*\n+\s*\n*/gm, "$1. ");
}

const CODE_FENCE_LANGS = new Set([
	"bash",
	"diff",
	"html",
	"js",
	"json",
	"jsx",
	"md",
	"markdown",
	"mermaid",
	"mmd",
	"sh",
	"shell",
	"text",
	"ts",
	"tsx",
	"yml",
	"yaml",
]);
const CODE_FENCE_SPLIT_RE = /(```[\s\S]*?```)/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const LEADING_DOT_SLASH_RE = /^\.?\//;
export type MarkdownTone = "default" | "primary";

export function normalizeCodeFenceLanguages(text: string): string {
	return text.replace(/```([^\n]*)/g, (_match, langRaw) => {
		const lang = String(langRaw || "")
			.trim()
			.toLowerCase();
		if (!lang) {
			return "```";
		}
		const normalized = lang.split(/\s+/)[0] ?? "";
		return CODE_FENCE_LANGS.has(normalized) ? `\`\`\`${normalized}` : "```text";
	});
}

export interface MarkdownProps {
	/** Web-tool citations for this turn; bare `[n]` markers become inline chips. */
	citations?: Citation[];
	className?: string;
	content: string;
	fileReferences?: FileReference[];
	/**
	 * Newly streamed text can animate in word-by-word. An explicit request
	 * and actively streaming content both obey the resolved display preference.
	 * Completed history stays static; global and OS motion preferences win.
	 */
	isAnimating?: boolean;
	/**
	 * True while this content is still arriving. Independent of `isAnimating`
	 * (motion can be off mid-stream): it lets code highlighting resume from the
	 * finished lines of the block that is still growing. Default: false.
	 */
	isStreaming?: boolean;
	mentionItems?: MentionItem[];
	onOpenFile?: (path: string) => void;
	onOpenLink?: (url: string) => void;
	onOpenMention?: (item: MentionItem) => void;
	previewResolvers?: LinkPreviewResolvers;
	textContrast?: "normal" | "high";
	/** Match Markdown blocks to the surface carrying them. */
	tone?: MarkdownTone;
	/** Let dense tables and diagrams use a little more horizontal room. */
	wideBlocks?: boolean;
}

export interface FileReference {
	label: string;
	path: string;
}

function normalizePathToken(value: string): string {
	return value.replaceAll("\\", "/").replace(LEADING_DOT_SLASH_RE, "");
}

function findFileReference(
	value: string,
	fileReferences: FileReference[] | undefined
): FileReference | null {
	if (!fileReferences?.length) {
		return null;
	}
	const normalized = normalizePathToken(value);
	return (
		fileReferences.find((ref) => {
			const refPath = normalizePathToken(ref.path);
			const refLabel = normalizePathToken(ref.label);
			return (
				normalized === refPath ||
				normalized === refLabel ||
				refPath.endsWith(`/${normalized}`)
			);
		}) ?? null
	);
}

function escapeMarkdownLinkText(value: string): string {
	return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

export function enrichInlineFileReferences(
	text: string,
	fileReferences: FileReference[] | undefined
): string {
	if (!fileReferences?.length) {
		return text;
	}
	return text
		.split(CODE_FENCE_SPLIT_RE)
		.map((segment) => {
			if (segment.startsWith("```")) {
				return segment;
			}
			return segment.replace(INLINE_CODE_RE, (match, rawLabel: string) => {
				const ref = findFileReference(rawLabel, fileReferences);
				if (!ref) {
					return match;
				}
				const index = fileReferences.indexOf(ref);
				return `[\`${escapeMarkdownLinkText(rawLabel)}\`](#ryu-file-${index})`;
			});
		})
		.join("");
}

export function decodeMentionLabel(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
