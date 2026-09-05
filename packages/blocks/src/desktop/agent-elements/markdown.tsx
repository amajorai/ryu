"use client";

import { cn } from "@ryu/ui/lib/utils";
import { createCodePlugin } from "@streamdown/code";
import {
	type Components,
	type CustomRendererProps,
	extractTableDataFromElement,
	Streamdown,
	tableDataToCSV,
	tableDataToMarkdown,
	tableDataToTSV,
} from "streamdown";
import "streamdown/styles.css";
import { ExpandIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	type ImgHTMLAttributes,
	type ReactNode,
	type Ref,
	type TableHTMLAttributes,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import { CopyFormatMenu, writeClipboardPayload } from "./copy-format-menu.tsx";
import { FileTypeIcon } from "./file-type-icon.tsx";
import { ImageLightbox } from "./image-lightbox.tsx";
import { InlineImagePreview } from "./image-preview.tsx";
import { type Citation, CitationMarkLink } from "./inline-citation.tsx";
import { LinkPreview, type LinkPreviewResolvers } from "./link-preview.tsx";
import { decodeMentionHref, linkifyAtMentions } from "./linkify-mentions.ts";
import { formatMentionContent } from "./mention-format.ts";
import { MentionToken } from "./mention-token.tsx";
import type { MentionItem } from "./types.ts";
import { linkifyCitationMarkers } from "./utils/citations.ts";

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
type MarkdownTone = "default" | "primary";

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
	/** Web-tool citations for this turn; bare `[n]` markers become inline chips. */
	citations?: Citation[];
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

function decodeMentionLabel(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

const DIAGRAM_COPY_OPTIONS = [
	{ id: "mermaid", label: "Copy as Mermaid" },
	{ id: "svg", label: "Copy as SVG" },
	{ id: "png", label: "Copy as PNG" },
] as const;

function svgToPng(svg: string): Promise<Blob> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => {
			const canvas = document.createElement("canvas");
			const width = image.naturalWidth || image.width;
			const height = image.naturalHeight || image.height;
			if (!(width > 0 && height > 0)) {
				reject(new Error("Diagram has no measurable size"));
				return;
			}
			const scale = Math.min(2, window.devicePixelRatio || 1);
			canvas.width = Math.ceil(width * scale);
			canvas.height = Math.ceil(height * scale);
			const context = canvas.getContext("2d");
			if (!context) {
				reject(new Error("Could not create a diagram canvas"));
				return;
			}
			context.scale(scale, scale);
			context.drawImage(image, 0, 0, width, height);
			canvas.toBlob((blob) => {
				if (blob) {
					resolve(blob);
					return;
				}
				reject(new Error("Could not encode diagram as PNG"));
			}, "image/png");
		};
		image.onerror = () => reject(new Error("Could not load diagram SVG"));
		image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	});
}

function MarkdownImage({
	alt,
	className,
	node: _node,
	src,
	...props
}: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
	if (typeof src !== "string" || !src) {
		return null;
	}
	return (
		<InlineImagePreview alt={alt} className={className} src={src} {...props} />
	);
}

function MermaidBlock({
	code,
	isIncomplete,
	wideBlocks,
}: CustomRendererProps & { wideBlocks: boolean }) {
	const id = useId();
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [lightboxOpen, setLightboxOpen] = useState(false);
	const originRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (isIncomplete || !code.trim()) {
			setSvg(null);
			setError(null);
			return;
		}
		let cancelled = false;
		setSvg(null);
		setError(null);

		const renderDiagram = async () => {
			const mermaidModule = await import("mermaid");
			const mermaid = mermaidModule.default;
			const prefersDark =
				typeof window !== "undefined" &&
				typeof window.matchMedia === "function" &&
				window.matchMedia("(prefers-color-scheme: dark)").matches;
			mermaid.initialize({
				fontFamily: "inherit",
				securityLevel: "strict",
				startOnLoad: false,
				theme: prefersDark ? "dark" : "default",
			});
			const safeId = `ryu-chat-mermaid-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
			const rendered = await mermaid.render(
				safeId,
				code.replaceAll("\\n", "\n")
			);
			if (!cancelled) {
				setSvg(rendered.svg);
			}
		};

		renderDiagram().catch((reason: unknown) => {
			if (!cancelled) {
				setError(
					reason instanceof Error ? reason.message : "Failed to render diagram"
				);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [code, id, isIncomplete]);

	const diagramUrl = useMemo(
		() =>
			svg
				? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
				: null,
		[svg]
	);

	const handleCopy = async (format: string) => {
		if (format === "mermaid") {
			await writeClipboardPayload({ "text/plain": code }, code);
			return;
		}
		if (!svg) {
			throw new Error("Diagram is still rendering");
		}
		if (format === "svg") {
			await writeClipboardPayload(
				{ "image/svg+xml": svg, "text/plain": svg },
				svg
			);
			return;
		}
		if (format === "png") {
			await writeClipboardPayload({ "image/png": await svgToPng(svg) });
		}
	};

	const surfaceClassName = cn(
		"group/mermaid-block relative my-3 flex min-w-0 flex-col gap-1.5 rounded-xl bg-muted/30 p-2",
		wideBlocks && "-mx-4 w-[calc(100%+2rem)] max-w-[calc(100vw-2rem)]"
	);

	if (error) {
		return (
			<div className={surfaceClassName} data-streamdown="mermaid-block">
				<div className="flex items-center justify-between px-1 text-xs">
					<span className="font-mono text-muted-foreground">Mermaid</span>
					<CopyFormatMenu
						ariaLabel="Copy diagram"
						dataTestId="mermaid-copy"
						onCopy={handleCopy}
						options={DIAGRAM_COPY_OPTIONS}
					/>
				</div>
				<p className="px-1 text-destructive text-xs">{error}</p>
				<pre className="max-h-56 overflow-auto rounded-lg bg-background/70 p-3 text-xs">
					<code>{code}</code>
				</pre>
			</div>
		);
	}

	if (!svg) {
		return (
			<div className={surfaceClassName} data-streamdown="mermaid-block">
				<div className="flex items-center justify-between px-1 text-xs">
					<span className="font-mono text-muted-foreground">Mermaid</span>
					<span className="text-muted-foreground">Rendering…</span>
				</div>
				<pre className="max-h-56 overflow-auto rounded-lg bg-background/70 p-3 text-xs">
					<code>{code}</code>
				</pre>
			</div>
		);
	}

	return (
		<div className={surfaceClassName} data-streamdown="mermaid-block">
			<div className="flex items-center justify-between px-1 text-xs">
				<span className="font-mono text-muted-foreground">Mermaid</span>
				<div className="flex items-center gap-1 opacity-70 transition-opacity group-focus-within/mermaid-block:opacity-100 group-hover/mermaid-block:opacity-100">
					<CopyFormatMenu
						ariaLabel="Copy diagram"
						dataTestId="mermaid-copy"
						onCopy={handleCopy}
						options={DIAGRAM_COPY_OPTIONS}
					/>
					<Button
						aria-label="Expand diagram"
						className="size-7 rounded-md text-muted-foreground hover:text-foreground"
						data-testid="mermaid-expand"
						onClick={() => setLightboxOpen(true)}
						size="icon"
						title="Expand diagram"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon aria-hidden="true" icon={ExpandIcon} size={14} />
					</Button>
				</div>
			</div>
			<button
				aria-label="Open Mermaid diagram"
				className="flex max-h-[32rem] min-h-28 w-full cursor-zoom-in items-center justify-center overflow-auto rounded-lg bg-background/70 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onClick={(event) => {
					originRef.current = event.currentTarget;
					setLightboxOpen(true);
				}}
				ref={originRef}
				type="button"
			>
				{/* Mermaid's strict renderer sanitizes the SVG before it reaches this
				    surface. The output is still inserted as markup so labels and arrows
				    remain selectable vectors rather than a screenshot. */}
				<span
					className="flex max-w-full items-center justify-center [&>svg]:h-auto [&>svg]:max-h-[28rem] [&>svg]:max-w-full"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid strict mode sanitizes the generated SVG before display.
					dangerouslySetInnerHTML={{ __html: svg }}
				/>
			</button>
			{diagramUrl ? (
				<ImageLightbox
					images={[{ filename: "diagram.svg", id, url: diagramUrl }]}
					onClose={() => setLightboxOpen(false)}
					open={lightboxOpen}
					originRef={originRef}
				/>
			) : null}
		</div>
	);
}

function ExpandableMarkdownTable({
	children,
	className,
	tone = "default",
	wide = false,
	...props
}: TableHTMLAttributes<HTMLTableElement> & {
	children?: ReactNode;
	tone?: MarkdownTone;
	wide?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const tableRef = useRef<HTMLTableElement>(null);
	const tableClassName = (tableTone: MarkdownTone) =>
		cn(
			"an-md-table w-full min-w-max text-sm",
			tableTone === "primary"
				? "[&>tbody>tr>td]:border-primary-foreground/20 [&>tbody>tr>td]:text-primary-foreground/90 [&>thead>tr>th]:bg-primary-foreground/10 [&>thead>tr>th]:text-primary-foreground"
				: "[&>thead>tr>th]:bg-muted [&>thead]:bg-muted",
			className
		);

	const table = (
		extraClassName?: string,
		ref?: Ref<HTMLTableElement>,
		tableTone: MarkdownTone = tone
	) => (
		<table
			{...props}
			className={cn(tableClassName(tableTone), extraClassName)}
			ref={ref}
		>
			{children}
		</table>
	);

	const handleCopy = async (format: string) => {
		const element = tableRef.current;
		if (!element) {
			throw new Error("Table is not ready");
		}
		const data = extractTableDataFromElement(element);
		if (format === "png") {
			const { default: html2canvas } = await import("html2canvas-pro");
			const canvas = await html2canvas(element, {
				backgroundColor: null,
				scale: Math.min(2, window.devicePixelRatio || 1),
				useCORS: true,
			});
			const blob = await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob((next) => {
					if (next) {
						resolve(next);
						return;
					}
					reject(new Error("Could not encode table as PNG"));
				}, "image/png");
			});
			await writeClipboardPayload({ "image/png": blob });
			return;
		}

		const text =
			format === "csv"
				? tableDataToCSV(data)
				: format === "tsv"
					? tableDataToTSV(data)
					: tableDataToMarkdown(data);
		await writeClipboardPayload(
			{ "text/plain": text, "text/html": element.outerHTML },
			text
		);
	};

	const copyMenu = (testId?: string) => (
		<CopyFormatMenu
			ariaLabel="Copy table"
			dataTestId={testId}
			onCopy={handleCopy}
			options={[
				{ id: "markdown", label: "Copy as Markdown" },
				{ id: "csv", label: "Copy as CSV" },
				{ id: "tsv", label: "Copy as TSV" },
				{ id: "png", label: "Copy as PNG" },
			]}
		/>
	);

	return (
		<>
			<div
				className={cn(
					"group/an-md-table relative my-3 w-full max-w-full",
					wide && "-mx-4 w-[calc(100%+2rem)] max-w-[calc(100vw-2rem)]"
				)}
				data-streamdown="table-wrapper"
			>
				<div className="scroll-fade-x overflow-x-auto rounded-[var(--radius)]">
					{table(undefined, tableRef)}
				</div>
				<div className="pointer-events-none absolute top-1 right-1 z-10 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/an-md-table:opacity-100">
					<div className="pointer-events-auto">
						{copyMenu("markdown-table-copy")}
					</div>
					<Button
						aria-label="Expand table"
						className="pointer-events-auto size-7 bg-background/90 text-muted-foreground shadow-sm hover:text-foreground"
						data-testid="markdown-table-expand"
						onClick={() => setOpen(true)}
						size="icon-xs"
						title="Expand table"
						variant="ghost"
					>
						<HugeiconsIcon icon={ExpandIcon} size={14} />
					</Button>
				</div>
			</div>
			<Dialog onOpenChange={setOpen} open={open}>
				<DialogContent className="flex max-h-[min(90vh,60rem)] max-w-[min(95vw,90rem)] flex-col gap-3">
					<DialogHeader className="flex-row items-start justify-between gap-4">
						<div className="min-w-0">
							<DialogTitle>Expanded markdown table</DialogTitle>
							<DialogDescription>
								Scroll horizontally or vertically to inspect the full table.
							</DialogDescription>
						</div>
						{copyMenu("markdown-table-dialog-copy")}
					</DialogHeader>
					<div className="min-h-0 overflow-auto rounded-[var(--radius)] border border-border/60">
						{table("min-w-[72rem]", undefined, "default")}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

export function Markdown({
	mentionItems,
	citations,
	content,
	className,
	fileReferences,
	isAnimating = false,
	onOpenFile,
	onOpenLink,
	onOpenMention,
	previewResolvers,
	tone = "default",
	wideBlocks = false,
}: MarkdownProps) {
	// Code blocks obey the same "Tool detail" level as tool calls: at anything
	// below Detailed a long block is capped and scrolls in place. The switch is a
	// data attribute rather than a prop on the code plugin because the fenced
	// block is rendered by `@streamdown/code`, not by a component we own — the
	// cap lands in CSS against its stable `data-streamdown` parts (agent-ui.css).
	const { expandCodeBlocks } = useChatDisplayPrefs();
	const mentionContent = formatMentionContent(content, mentionItems);
	const safeContent = normalizeCodeFenceLanguages(
		fixNumberedListBreaks(
			linkifyCitationMarkers(
				linkifyAtMentions(
					enrichInlineFileReferences(mentionContent, fileReferences)
				),
				citations
			)
		)
	);
	const mermaidRenderer = useMemo(
		() =>
			function MarkdownMermaidRenderer(props: CustomRendererProps) {
				return <MermaidBlock {...props} wideBlocks={wideBlocks} />;
			},
		[wideBlocks]
	);
	const components: Components = {
		h1: ({ children, ...props }) => (
			<h1 className="an-md-h1 mt-3 mb-1.5 font-medium text-base" {...props}>
				{children}
			</h1>
		),
		h2: ({ children, ...props }) => (
			<h2 className="an-md-h2 mt-3 mb-1.5 font-medium text-base" {...props}>
				{children}
			</h2>
		),
		h3: ({ children, ...props }) => (
			<h3 className="an-md-h3 mt-2 mb-1 font-medium text-sm" {...props}>
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
			if (href.startsWith("#ryu-cite-")) {
				const n = Number(href.replace("#ryu-cite-", ""));
				const citation = Number.isFinite(n)
					? citations?.find((c) => c.number === n)
					: undefined;
				if (!citation) {
					return <span>{children}</span>;
				}
				return <CitationMarkLink citation={citation} />;
			}
			if (href.startsWith("#ryu-mention-")) {
				const mentionHref = href.slice("#ryu-mention-".length);
				// Resolve the complete kind+label token first. New mention kinds may
				// contain hyphens (for example `app-item`), while older persisted
				// messages use the original `kind-label` wire shape.
				const resolvedMention = mentionItems?.find((candidate) =>
					[candidate.label, candidate.id].some(
						(value) =>
							value !== undefined &&
							mentionHref === `${candidate.kind}-${encodeURIComponent(value)}`
					)
				);
				const separator = mentionHref.indexOf("-");
				const kind =
					resolvedMention?.kind ??
					(separator === -1 ? mentionHref : mentionHref.slice(0, separator));
				const encodedLabel = resolvedMention
					? ""
					: separator === -1
						? ""
						: mentionHref.slice(separator + 1);
				const label = encodedLabel ? decodeMentionLabel(encodedLabel) : "";
				const item =
					resolvedMention ??
					mentionItems?.find(
						(candidate) =>
							candidate.kind === kind &&
							(candidate.label === label || candidate.id === label)
					);
				const mentionContent = (
					<MentionToken item={item}>{children}</MentionToken>
				);
				if (item && item.kind !== "user" && onOpenMention) {
					return (
						<button
							aria-label={`Open ${item.kind} ${item.label}`}
							className="an-md-mention inline-flex max-w-full cursor-pointer rounded p-0 font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
							data-mention-id={item.id}
							data-mention-kind={item.kind}
							onClick={(event) => {
								event.preventDefault();
								onOpenMention(item);
							}}
							title={`Open ${item.label}`}
							type="button"
						>
							{mentionContent}
						</button>
					);
				}
				return (
					<strong
						className="inline-flex items-center gap-1 font-medium text-primary"
						data-mention-id={item?.id}
						data-mention-kind={item?.kind}
						{...props}
					>
						{mentionContent}
					</strong>
				);
			}
			if (/^#ryu-file-\d+$/.test(href)) {
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
						<FileTypeIcon className="mr-1 size-3.5" path={ref.path} />
						{children}
					</button>
				);
			}
			const mentionedFile = decodeMentionHref(href, "#ryu-file-path-");
			if (mentionedFile) {
				return (
					<LinkPreview
						resolvers={previewResolvers}
						target={{ kind: "file", value: mentionedFile }}
					>
						<button
							className="an-md-file-link inline-flex items-center rounded px-0.5 text-primary underline-offset-2 hover:underline"
							onClick={(event) => {
								event.preventDefault();
								onOpenFile?.(mentionedFile);
							}}
							title={mentionedFile}
							type="button"
						>
							<FileTypeIcon className="mr-1 size-3.5" path={mentionedFile} />
							{children}
						</button>
					</LinkPreview>
				);
			}
			const mentionedWebsite = decodeMentionHref(href, "#ryu-web-url-");
			const destination = mentionedWebsite ?? href;
			const isExternal =
				destination.startsWith("http") || destination.startsWith("mailto:");
			const link = (
				<a
					{...props}
					className="an-md-link text-primary underline-offset-2 hover:underline"
					href={destination}
					onClick={
						isExternal && onOpenLink
							? (event) => {
									event.preventDefault();
									onOpenLink(destination);
								}
							: undefined
					}
					rel={isExternal ? "noopener noreferrer" : undefined}
					target={isExternal ? "_blank" : undefined}
				>
					{children}
				</a>
			);
			return destination.startsWith("http") ? (
				<LinkPreview
					resolvers={previewResolvers}
					target={{ kind: "website", value: destination }}
				>
					{link}
				</LinkPreview>
			) : (
				link
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
		table: (props) => (
			<ExpandableMarkdownTable {...props} tone={tone} wide={wideBlocks} />
		),
		img: (props) => <MarkdownImage {...props} />,
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
			data-code-detail={expandCodeBlocks ? "full" : "capped"}
		>
			<Streamdown
				animated={isAnimating ? STREAM_ANIMATION : false}
				components={components}
				isAnimating={isAnimating}
				plugins={{
					code,
					renderers: [
						{
							component: mermaidRenderer,
							language: ["mermaid", "mmd"],
						},
					],
				}}
			>
				{safeContent}
			</Streamdown>
		</div>
	);
}
