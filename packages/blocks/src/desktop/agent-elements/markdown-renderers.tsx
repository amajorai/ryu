"use client";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	isNativeBoolean,
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils";
import {
	type AnchorHTMLAttributes,
	createContext,
	type ImgHTMLAttributes,
	isValidElement,
	type ReactNode,
	type TableHTMLAttributes,
	useContext,
} from "react";
import {
	CodeBlock,
	CodeBlockCopyButton,
	CodeBlockDownloadButton,
	type Components,
	type ControlsConfig,
	type CustomRendererProps,
	StreamdownContext,
	type StreamdownProps,
	useIsCodeFenceIncomplete,
} from "streamdown";
import {
	staticCodeHighlighter,
	streamingCodeHighlighter,
} from "./code-highlighter.ts";
import { FileTypeIcon } from "./file-type-icon.tsx";
import { InlineImagePreview } from "./image-preview.tsx";
import { type Citation, CitationMarkLink } from "./inline-citation.tsx";
import { LinkPreview, type LinkPreviewResolvers } from "./link-preview.tsx";
import { decodeMentionHref } from "./linkify-mentions.ts";
import {
	decodeMentionLabel,
	type FileReference,
	type MarkdownTone,
	safeMarkdownDestination,
} from "./markdown-content.ts";
import { MermaidBlock } from "./markdown-mermaid.tsx";
import { ExpandableMarkdownTable } from "./markdown-table.tsx";
import { MentionToken } from "./mention-token.tsx";
import type { MentionItem } from "./types.ts";

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

// Per-render data the element overrides need. It travels through context, not
// through closures in `components`, so the `components` map and every entry in it
// keep one identity for the life of the app. Streamdown's Block memo compares each
// component by reference: a fresh closure per render re-rendered every finished
// block of a reply on every streamed token. Context still reaches the links and
// tables that read it when this data changes, even inside memoized blocks.
export interface MarkdownRenderContextValue {
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

export const MarkdownRenderContext = createContext<MarkdownRenderContextValue>({
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
	const tl = useLiteralMessages();
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
					aria-label={tl("Open {kind} {label}", {
						kind: item.kind,
						label: item.label,
					})}
					className="inline-flex max-w-full cursor-pointer rounded-lg p-0 font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
					data-mention-id={item.id}
					data-mention-kind={item.kind}
					onClick={(event) => {
						event.preventDefault();
						onOpenMention(item);
					}}
					title={tl("Open {label}", { label: item.label })}
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
				className="inline-flex items-center rounded-lg px-0.5 text-primary underline-offset-2 hover:underline"
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
					className="inline-flex items-center rounded-lg px-0.5 text-primary underline-offset-2 hover:underline"
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
					"rounded-lg bg-muted px-1.5 py-0.5 font-mono text-sm",
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

export const MARKDOWN_COMPONENTS: Components = {
	code: MarkdownCode,
	h1: ({ children, ...props }) => (
		<h1
			className="mt-3 mb-1.5 text-balance font-semibold text-lg tracking-tight"
			{...props}
		>
			{children}
		</h1>
	),
	h2: ({ children, ...props }) => (
		<h2
			className="text-(length:--text-comfortable) mt-3 mb-1.5 text-balance font-semibold leading-(--text-comfortable--line-height)"
			{...props}
		>
			{children}
		</h2>
	),
	h3: ({ children, ...props }) => (
		<h3 className="mt-2 mb-1 text-balance font-semibold text-sm" {...props}>
			{children}
		</h3>
	),
	h4: ({ children, ...props }) => (
		<h4 className="mt-2 mb-1 text-balance font-medium text-sm" {...props}>
			{children}
		</h4>
	),
	p: ({ children, ...props }) => (
		<p
			className="text-pretty text-foreground text-sm leading-relaxed"
			{...props}
		>
			{children}
		</p>
	),
	ul: ({ children, ...props }) => (
		<ul
			className="mb-2 list-outside list-disc space-y-0.5 pl-4 text-foreground text-sm"
			{...props}
		>
			{children}
		</ul>
	),
	ol: ({ children, ...props }) => (
		<ol
			className="mb-2 list-outside list-decimal space-y-0.5 pl-5 text-foreground text-sm"
			{...props}
		>
			{children}
		</ol>
	),
	li: ({ children, ...props }) => (
		<li className="pl-0.5 text-foreground text-sm" {...props}>
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
			className="mb-2 border-border border-l-2 pl-3 text-muted-foreground text-sm italic"
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
		<td className="border-border border-t px-3 py-2 text-foreground" {...props}>
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
export const STATIC_PLUGINS: NonNullable<StreamdownProps["plugins"]> = {
	code: staticCodeHighlighter,
	renderers: MARKDOWN_RENDERERS,
};
export const STREAMING_PLUGINS: NonNullable<StreamdownProps["plugins"]> = {
	code: streamingCodeHighlighter,
	renderers: MARKDOWN_RENDERERS,
};
