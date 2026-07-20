"use client";

import { cn } from "@ryu/ui/lib/utils";
import { createCodePlugin } from "@streamdown/code";
import { type Components, Streamdown } from "streamdown";
import "streamdown/styles.css";

// Fixed streaming-animation treatment (Streamdown's animate plugin). Word-by-word
// blur-in is the softest of the built-ins; the toggle lives upstream (settings),
// so the config here is a constant, not a lock.
const STREAM_ANIMATION = {
	animation: "blurIn",
	duration: 200,
	sep: "word",
} as const;

function fixNumberedListBreaks(text: string): string {
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

function normalizeCodeFenceLanguages(text: string): string {
	return text.replace(/```([^\n]*)/g, (_match, langRaw) => {
		const lang = String(langRaw || "")
			.trim()
			.toLowerCase();
		if (!lang) {
			return "```";
		}
		const normalized = lang.split(/\s+/)[0];
		return CODE_FENCE_LANGS.has(normalized) ? `\`\`\`${normalized}` : "```text";
	});
}

export interface MarkdownProps {
	className?: string;
	content: string;
	fileReferences?: FileReference[];
	/**
	 * When true, newly streamed text animates in (word-by-word blur-in). Callers
	 * pass the already-resolved value: only the actively streaming last assistant
	 * turn with animations enabled should set this. Omitted/false ⇒ static render
	 * (past messages, other surfaces, motion disabled). Default: false.
	 */
	isAnimating?: boolean;
	onOpenFile?: (path: string) => void;
	textContrast?: "normal" | "high";
}

export interface FileReference {
	label: string;
	path: string;
}

const code = createCodePlugin({
	themes: ["github-light", "github-dark"],
});

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

function enrichInlineFileReferences(
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

export function Markdown({
	content,
	className,
	fileReferences,
	isAnimating = false,
	onOpenFile,
}: MarkdownProps) {
	const safeContent = normalizeCodeFenceLanguages(
		fixNumberedListBreaks(enrichInlineFileReferences(content, fileReferences))
	);
	const components: Components = {
		h1: ({ children, ...props }) => (
			<h1 className="an-md-h1 mt-3 mb-1.5 font-semibold text-base" {...props}>
				{children}
			</h1>
		),
		h2: ({ children, ...props }) => (
			<h2 className="an-md-h2 mt-3 mb-1.5 font-semibold text-base" {...props}>
				{children}
			</h2>
		),
		h3: ({ children, ...props }) => (
			<h3 className="an-md-h3 mt-2 mb-1 font-semibold text-sm" {...props}>
				{children}
			</h3>
		),
		h4: ({ children, ...props }) => (
			<h4 className="an-md-h4 mt-2 mb-1 font-medium text-sm" {...props}>
				{children}
			</h4>
		),
		p: ({ children, ...props }) => (
			<p
				className="an-md-p text-foreground/80 text-sm leading-relaxed"
				{...props}
			>
				{children}
			</p>
		),
		ul: ({ children, ...props }) => (
			<ul
				className="an-md-ul mb-2 list-outside list-disc space-y-0.5 pl-4 text-foreground/80 text-sm"
				{...props}
			>
				{children}
			</ul>
		),
		ol: ({ children, ...props }) => (
			<ol
				className="an-md-ol mb-2 list-outside list-decimal space-y-0.5 pl-5 text-foreground/80 text-sm"
				{...props}
			>
				{children}
			</ol>
		),
		li: ({ children, ...props }) => (
			<li className="an-md-li pl-0.5 text-foreground/80 text-sm" {...props}>
				{children}
			</li>
		),
		strong: ({ children, ...props }) => (
			<strong className="font-medium text-foreground" {...props}>
				{children}
			</strong>
		),
		a: ({ href, children, ...props }) => {
			if (!href) {
				return <span>{children}</span>;
			}
			if (href.startsWith("#ryu-file-")) {
				const index = Number(href.replace("#ryu-file-", ""));
				const ref = Number.isFinite(index)
					? fileReferences?.[index]
					: undefined;
				if (!ref) {
					return <span>{children}</span>;
				}
				return (
					<button
						className="an-md-file-link inline-flex items-center rounded px-0.5 text-primary underline-offset-2 hover:underline"
						onClick={(event) => {
							event.preventDefault();
							onOpenFile?.(ref.path);
						}}
						title={ref.path}
						type="button"
					>
						{children}
					</button>
				);
			}
			const isExternal = href.startsWith("http") || href.startsWith("mailto:");
			return (
				<a
					{...props}
					className="an-md-link text-primary underline-offset-2 hover:underline"
					href={href}
					rel={isExternal ? "noopener noreferrer" : undefined}
					target={isExternal ? "_blank" : undefined}
				>
					{children}
				</a>
			);
		},
		blockquote: ({ children, ...props }) => (
			<blockquote
				className="an-md-blockquote mb-2 border-border border-l-2 pl-3 text-foreground/70 text-sm italic"
				{...props}
			>
				{children}
			</blockquote>
		),
		hr: ({ ...props }) => (
			<hr className="an-md-hr my-4 border-border" {...props} />
		),
		table: ({ children, ...props }) => (
			<div className="my-3 overflow-x-auto rounded-[var(--radius)]">
				<table
					className="an-md-table w-full text-sm [&>thead>tr>th]:bg-muted [&>thead]:bg-muted"
					{...props}
				>
					{children}
				</table>
			</div>
		),
		th: ({ children, ...props }) => (
			<th className="bg-muted px-3 py-2 text-left font-medium" {...props}>
				{children}
			</th>
		),
		td: ({ children, ...props }) => (
			<td
				className="border-border border-t px-3 py-2 text-foreground/80"
				{...props}
			>
				{children}
			</td>
		),
	};

	return (
		<div
			className={cn(
				"an-markdown",
				"wrap-break-word overflow-hidden",
				"[&_li>p]:mb-0 [&_li>p]:inline",
				className
			)}
		>
			<Streamdown
				animated={isAnimating ? STREAM_ANIMATION : false}
				components={components}
				isAnimating={isAnimating}
				plugins={{ code }}
			>
				{safeContent}
			</Streamdown>
		</div>
	);
}
