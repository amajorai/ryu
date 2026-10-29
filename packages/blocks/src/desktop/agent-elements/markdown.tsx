"use client";
import { useMediaQuery } from "@ryu/ui/hooks/use-mobile.ts";
import {
	isNativeBoolean,
	isNativeFunction,
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils";
import {
	CodeBlock,
	CodeBlockCopyButton,
	CodeBlockDownloadButton,
	type Components,
	type ControlsConfig,
	type CustomRendererProps,
	extractTableDataFromElement,
	Streamdown,
	StreamdownContext,
	type StreamdownProps,
	tableDataToCSV,
	tableDataToMarkdown,
	tableDataToTSV,
	useIsCodeFenceIncomplete,
} from "streamdown";
import styles from "./markdown.module.css";
import "streamdown/styles.css";
import { ExpandIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { safeNavigationUrl } from "@ryu/ui/lib/safe-url.ts";
import {
	type AnchorHTMLAttributes,
	createContext,
	type ImgHTMLAttributes,
	isValidElement,
	type ReactNode,
	type Ref,
	type TableHTMLAttributes,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import {
	staticCodeHighlighter,
	streamingCodeHighlighter,
} from "./code-highlighter.ts";
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

function safeMarkdownDestination(value: string): string | null {
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

/** Hosts with local-only replies can disable network-active response images. */
export const MarkdownResponseImages = createContext(true);

function MarkdownImage({
	alt,
	className,
	node: _node,
	src,
	...props
}: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
	const allowResponseImages = useContext(MarkdownResponseImages);
	if (!allowResponseImages) {
		return (
			<span className="text-muted-foreground text-sm">
				{alt || "Image omitted"}
			</span>
		);
	}
	if (!(isNativeText(src) && src)) {
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
				globalThis.window !== undefined &&
				isNativeFunction(window.matchMedia) &&
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

		renderDiagram().catch((reason) => {
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

	// The lightbox only shows media URLs the shared policy admits, and that
	// policy refuses `data:image/svg+xml`. Hand it a browser-created object URL
	// for the sanitized SVG instead, revoked when the diagram changes or unmounts.
	const [diagramUrl, setDiagramUrl] = useState<string | null>(null);
	useEffect(() => {
		if (!svg) {
			setDiagramUrl(null);
			return;
		}
		const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
		setDiagramUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [svg]);

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
				<p className="px-1 text-status-destructive text-xs">{error}</p>
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
						appearance="markdown-diagram-expand"
						aria-label="Expand diagram"
						className="size-7"
						data-testid="mermaid-expand"
						onClick={() => setLightboxOpen(true)}
						size="icon"
						title="Expand diagram"
						type="button"
						variant="ghost-muted"
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
			styles.table,
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
				<div className="scroll-fade-x overflow-x-auto rounded-(--radius)">
					{table(undefined, tableRef)}
				</div>
				<div className="pointer-events-none absolute top-1 right-1 z-10 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/an-md-table:opacity-100">
					<div className="pointer-events-auto">
						{copyMenu("markdown-table-copy")}
					</div>
					<Button
						appearance="markdown-table-expand"
						aria-label="Expand table"
						className="pointer-events-auto size-7"
						data-testid="markdown-table-expand"
						onClick={() => setOpen(true)}
						size="icon-xs"
						title="Expand table"
						variant="ghost-muted"
					>
						<HugeiconsIcon icon={ExpandIcon} size={14} />
					</Button>
				</div>
			</div>
			<Dialog onOpenChange={setOpen} open={open}>
				<DialogContent
					render={(props) => (
						<div
							{...props}
							className={cn(
								props.className,
								"flex max-h-[min(90vh,60rem)] max-w-[min(95vw,90rem)] flex-col gap-3"
							)}
						/>
					)}
				>
					<div
						className="flex flex-row items-start justify-between gap-4"
						data-slot="dialog-header"
					>
						<div className="min-w-0">
							<DialogTitle>Expanded markdown table</DialogTitle>
							<DialogDescription>
								Scroll horizontally or vertically to inspect the full table.
							</DialogDescription>
						</div>
						{copyMenu("markdown-table-dialog-copy")}
					</div>
					<div className="min-h-0 overflow-auto rounded-(--radius) border border-border/60">
						{table("min-w-[72rem]", undefined, "default")}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

// Per-render data the element overrides need. It travels through context, not
// through closures in `components`, so the `components` map and every entry in it
// keep one identity for the life of the app. Streamdown's Block memo compares each
// component by reference: a fresh closure per render re-rendered every finished
// block of a reply on every streamed token. Context still reaches the links and
// tables that read it when this data changes, even inside memoized blocks.
interface MarkdownRenderContextValue {
	citations?: Citation[];
	fileReferences?: FileReference[];
	mentionItems?: MentionItem[];
	onOpenFile?: (path: string) => void;
	onOpenLink?: (url: string) => void;
	onOpenMention?: (item: MentionItem) => void;
	previewResolvers?: LinkPreviewResolvers;
	tone: MarkdownTone;
	wideBlocks: boolean;
}

const MarkdownRenderContext = createContext<MarkdownRenderContextValue>({
	tone: "default",
	wideBlocks: false,
});

type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };

function MarkdownLink({ href, children, ...props }: AnchorProps) {
	const {
		citations,
		fileReferences,
		mentionItems,
		onOpenFile,
		onOpenLink,
		onOpenMention,
		previewResolvers,
	} = useContext(MarkdownRenderContext);
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
		const mentionContent = <MentionToken item={item}>{children}</MentionToken>;
		if (item && item.kind !== "user" && onOpenMention) {
			return (
				<button
					aria-label={`Open ${item.kind} ${item.label}`}
					className="inline-flex max-w-full cursor-pointer rounded p-0 font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
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
		const ref = Number.isFinite(index) ? fileReferences?.[index] : undefined;
		if (!ref) {
			return <span>{children}</span>;
		}
		return (
			<button
				className="inline-flex items-center rounded px-0.5 text-primary underline-offset-2 hover:underline"
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
					className="inline-flex items-center rounded px-0.5 text-primary underline-offset-2 hover:underline"
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
	const destination = safeMarkdownDestination(mentionedWebsite ?? href);
	if (!destination) {
		return <span>{children}</span>;
	}
	const isExternal = /^(?:https?:|mailto:)/i.test(destination);
	const link = (
		<a
			{...props}
			className="text-primary underline-offset-2 hover:underline"
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
}

function MarkdownTable(
	props: TableHTMLAttributes<HTMLTableElement> & {
		children?: ReactNode;
		node?: unknown;
	}
) {
	const { tone, wideBlocks } = useContext(MarkdownRenderContext);
	return <ExpandableMarkdownTable {...props} tone={tone} wide={wideBlocks} />;
}

function MarkdownMermaidRenderer(props: CustomRendererProps) {
	const { wideBlocks } = useContext(MarkdownRenderContext);
	return <MermaidBlock {...props} wideBlocks={wideBlocks} />;
}

// The declared Streamdown code slot is a boolean or its complete options object.
// The existing code ?? true normalization removes nil before this observation.
type NativeCodeControls = NonNullable<Exclude<ControlsConfig, boolean>["code"]>;
function isCodeControlsObject(
	value: NativeCodeControls
): value is Exclude<NativeCodeControls, boolean> {
	return isNativeObjectLike(value);
}

// Streamdown's highlighted body retains late callbacks across code changes.
// A source-keyed standard CodeBlock gives each request its own mounted lifetime,
// while retaining Streamdown's header, actions, themes and raw-source fallback.
function MarkdownCodeRenderer({
	code,
	language,
	isIncomplete,
	meta,
}: CustomRendererProps) {
	const { controls, lineNumbers, shikiTheme } = useContext(StreamdownContext);
	const codeControls = isNativeBoolean(controls)
		? controls
		: (controls.code ?? true);
	const enabled = codeControls !== false;
	const copy = isCodeControlsObject(codeControls)
		? codeControls.copy !== false
		: enabled;
	const download = isCodeControlsObject(codeControls)
		? codeControls.download !== false
		: enabled;
	const start = meta?.match(/startLine=(\d+)/)?.[1];
	const startLine = start ? Number.parseInt(start, 10) : undefined;
	return (
		<CodeBlock
			code={code}
			isIncomplete={isIncomplete}
			key={JSON.stringify([code, language, shikiTheme])}
			language={language}
			lineNumbers={
				lineNumbers !== false && !/\bnoLineNumbers\b/.test(meta ?? "")
			}
			startLine={startLine && startLine >= 1 ? startLine : undefined}
		>
			{enabled && (
				<>
					{download && (
						<CodeBlockDownloadButton code={code} language={language} />
					)}
					{copy && <CodeBlockCopyButton />}
				</>
			)}
		</CodeBlock>
	);
}

const MarkdownCode: NonNullable<Components["code"]> = ({
	node,
	className,
	children,
	...props
}) => {
	const isIncomplete = useIsCodeFenceIncomplete();
	if (!("data-block" in props)) {
		return (
			<code
				className={cn(
					"rounded bg-muted px-1.5 py-0.5 font-mono text-sm",
					className
				)}
				data-streamdown="inline-code"
				{...props}
			>
				{children}
			</code>
		);
	}
	const language = className?.match(/language-([^\s]+)/)?.[1] ?? "text";
	const value = isValidElement<{ children?: ReactNode }>(children)
		? children.props.children
		: children;
	const code = isNativeText(value) ? value : "";
	const rawMeta = node?.properties?.metastring;
	const meta = isNativeText(rawMeta) ? rawMeta : undefined;
	if (language === "mermaid" || language === "mmd") {
		return (
			<MarkdownMermaidRenderer
				code={code}
				isIncomplete={isIncomplete}
				language={language}
				meta={meta}
			/>
		);
	}
	return (
		<MarkdownCodeRenderer
			code={code}
			isIncomplete={isIncomplete}
			language={language}
			meta={meta}
		/>
	);
};

const MARKDOWN_COMPONENTS: Components = {
	code: MarkdownCode,
	h1: ({ children, ...props }) => (
		<h1 className="mt-3 mb-1.5 font-medium text-base" {...props}>
			{children}
		</h1>
	),
	h2: ({ children, ...props }) => (
		<h2 className="mt-3 mb-1.5 font-medium text-base" {...props}>
			{children}
		</h2>
	),
	h3: ({ children, ...props }) => (
		<h3 className="mt-2 mb-1 font-medium text-sm" {...props}>
			{children}
		</h3>
	),
	h4: ({ children, ...props }) => (
		<h4 className="mt-2 mb-1 font-medium text-sm" {...props}>
			{children}
		</h4>
	),
	p: ({ children, ...props }) => (
		<p className="text-foreground/80 text-sm leading-relaxed" {...props}>
			{children}
		</p>
	),
	ul: ({ children, ...props }) => (
		<ul
			className="mb-2 list-outside list-disc space-y-0.5 pl-4 text-foreground/80 text-sm"
			{...props}
		>
			{children}
		</ul>
	),
	ol: ({ children, ...props }) => (
		<ol
			className="mb-2 list-outside list-decimal space-y-0.5 pl-5 text-foreground/80 text-sm"
			{...props}
		>
			{children}
		</ol>
	),
	li: ({ children, ...props }) => (
		<li className="pl-0.5 text-foreground/80 text-sm" {...props}>
			{children}
		</li>
	),
	strong: ({ children, ...props }) => (
		<strong className="font-medium text-foreground" {...props}>
			{children}
		</strong>
	),
	a: MarkdownLink,
	blockquote: ({ children, ...props }) => (
		<blockquote
			className="mb-2 border-border border-l-2 pl-3 text-foreground/70 text-sm italic"
			{...props}
		>
			{children}
		</blockquote>
	),
	hr: ({ ...props }) => <hr className="my-4 border-border" {...props} />,
	table: MarkdownTable,
	img: MarkdownImage,
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

const MARKDOWN_RENDERERS = [
	{ component: MarkdownMermaidRenderer, language: ["mermaid", "mmd"] },
];

// Streamdown's root memo compares `plugins` by reference, so each variant is one
// module-level object. Growing blocks resume tokenization from checkpoints;
// finished replies use the exact highlighter.
const STATIC_PLUGINS: NonNullable<StreamdownProps["plugins"]> = {
	code: staticCodeHighlighter,
	renderers: MARKDOWN_RENDERERS,
};
const STREAMING_PLUGINS: NonNullable<StreamdownProps["plugins"]> = {
	code: streamingCodeHighlighter,
	renderers: MARKDOWN_RENDERERS,
};

export function Markdown({
	mentionItems,
	citations,
	content,
	className,
	fileReferences,
	isAnimating = false,
	isStreaming = false,
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
	const { expandCodeBlocks, streamAnimation, animationsEnabled } =
		useChatDisplayPrefs();
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const animateText =
		streamAnimation &&
		animationsEnabled &&
		!reducedMotion &&
		(isAnimating || isStreaming);
	const safeContent = useMemo(
		() =>
			normalizeCodeFenceLanguages(
				fixNumberedListBreaks(
					linkifyCitationMarkers(
						linkifyAtMentions(
							enrichInlineFileReferences(
								formatMentionContent(content, mentionItems),
								fileReferences
							)
						),
						citations
					)
				)
			),
		[citations, content, fileReferences, mentionItems]
	);
	const renderContext = useMemo<MarkdownRenderContextValue>(
		() => ({
			citations,
			fileReferences,
			mentionItems,
			onOpenFile,
			onOpenLink,
			onOpenMention,
			previewResolvers,
			tone,
			wideBlocks,
		}),
		[
			citations,
			fileReferences,
			mentionItems,
			onOpenFile,
			onOpenLink,
			onOpenMention,
			previewResolvers,
			tone,
			wideBlocks,
		]
	);

	return (
		<div
			className={cn(
				styles.markdown,
				"wrap-break-word overflow-hidden",
				"[&_li>p]:mb-0 [&_li>p]:inline",
				className
			)}
			data-code-detail={expandCodeBlocks ? "full" : "capped"}
			data-ryu-i18n="off"
		>
			<MarkdownRenderContext.Provider value={renderContext}>
				<Streamdown
					animated={animateText ? STREAM_ANIMATION : false}
					components={MARKDOWN_COMPONENTS}
					isAnimating={animateText}
					plugins={isStreaming ? STREAMING_PLUGINS : STATIC_PLUGINS}
				>
					{safeContent}
				</Streamdown>
			</MarkdownRenderContext.Provider>
		</div>
	);
}
