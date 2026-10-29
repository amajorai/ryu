import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	findLiveArtifactAction,
	liveArtifactActionChoices,
	type NativeArtifactActionObservation,
} from "@/src/lib/live-artifact-actions.ts";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import { NativeToolApprovalActions } from "@/src/lib/native-artifact-action-abi.ts";
import type {
	NativeArtifactEditorPathOperation,
	NativeArtifactFollowUpOperation,
} from "@/src/lib/native-artifact-io-abi.ts";
import styles from "./artifact-renderer.module.css";
// apps/desktop/src/components/chat/ArtifactRenderer.tsx
//
// Draws an artifact (see lib/artifacts.ts) in a full-size surface — the right
// dock's artifact tab and the window-tab artifact page. HTML/SVG/mermaid render
// inside a STRICT sandboxed iframe; code/file show a read-only view; space
// renders as markdown; database renders as a table. Also renders approval-style
// artifact actions with the app's own ToolApproval primitive (the same component
// the permission prompts use).
//
// `ArtifactContentView` is the shared body — the inline chat card
// (InlineArtifact.tsx) mounts it at a smaller fixed height.
//
// SECURITY POSTURE — modelled on PluginHostPanel / ExtensionHost (do not weaken):
//   - The frame is `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so it
//     runs at a NULL origin: no parent DOM, no cookies/storage, no Tauri IPC.
//   - A per-document CSP (`connect-src 'none'`, `default-src 'none'`) blocks all
//     network egress, so a poisoned artifact cannot beacon/exfiltrate or pull a
//     remote payload. Only inline script/style and data: media run.
//   - Rendering is fully guarded: a bad artifact shows an inline error, never
//     throws into the chat tree (the iframe isolates HTML/SVG faults; mermaid
//     compilation is try/caught).

import {
	AlertCircleIcon,
	BrowserIcon,
	DatabaseIcon,
	File01Icon,
	Flowchart01Icon,
	FolderOpenIcon,
	Image02Icon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { agentUiStateLimitProblem } from "@ryu/blocks/desktop/agent-elements/agent-ui/state-limits.ts";
import { useArtifactHost } from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	ARTIFACT_SIZE_MESSAGE,
	ARTIFACT_STATE_MAX_BYTES,
	ARTIFACT_STATE_MAX_DEPTH,
	ARTIFACT_STATE_MESSAGE,
	type ArtifactSavedState,
	type ArtifactTheme,
	artifactSrcDoc,
} from "@/src/lib/artifact-srcdoc.ts";
import { type ArtifactKind, parseTabularContent } from "@/src/lib/artifacts.ts";
import { useArtifactTheme } from "@/src/lib/use-artifact-theme.ts";

/** Native Promise rejection owner preserves arbitrary thrown values and the
 * existing instanceof Error fallback; it adds no renderer admission policy. */
type MermaidRenderRejection = Parameters<
	NonNullable<Parameters<ReturnType<typeof compileMermaid>["catch"]>[0]>
>[0];

const MERMAID_ID_UNSAFE_RE = /[^a-zA-Z0-9_-]/g;

/** Compile mermaid DSL → SVG string. Imported lazily so mermaid (large) stays
 *  off the main bundle and only loads when an artifact needs it. */
async function compileMermaid(
	id: string,
	code: string,
	appDark: boolean | undefined
): Promise<string> {
	const mermaidModule = await import("mermaid");
	const mermaid = mermaidModule.default;
	// Follow the app's selected theme (it can differ from the OS); fall back to
	// the OS preference only when no app theme is known.
	const dark =
		appDark ??
		(globalThis.window !== undefined &&
			isNativeFunction(window.matchMedia) &&
			window.matchMedia("(prefers-color-scheme: dark)").matches);
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "strict",
		theme: dark ? "dark" : "default",
	});
	const safeId = `artifact-mermaid-${id.replace(MERMAID_ID_UNSAFE_RE, "")}`;
	const { svg } = await mermaid.render(safeId, code);
	return svg;
}

export const KIND_ICON = {
	html: BrowserIcon,
	svg: Image02Icon,
	mermaid: Flowchart01Icon,
	code: SourceCodeIcon,
	file: File01Icon,
	space: FolderOpenIcon,
	database: DatabaseIcon,
} satisfies Record<ArtifactKind, IconSvgElement>;

export const KIND_LABEL = {
	html: "Page",
	svg: "SVG",
	mermaid: "Diagram",
	code: "Code",
	file: "File",
	space: "Space",
	database: "Database",
} satisfies Record<ArtifactKind, string>;

/** Artifact kinds drawn in a sandboxed frame that reports its content height. */
export const FRAMED_ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set([
	"html",
	"svg",
	"mermaid",
]);

/** Receives the framed document's natural content height in CSS pixels. */
export type ArtifactContentHeightHandler = (height: number) => void;

/** Receives a page's `ryu.state.set(...)` snapshot for saving. */
export type ArtifactStateHandler = (state: ArtifactSavedState) => void;

// The frame's size reporter and state API (artifact-srcdoc.ts) post only these
// shapes. Any other message, or one from a different window, is ignored.
const artifactSizeMessageSchema = z.object({
	type: z.literal(ARTIFACT_SIZE_MESSAGE),
	height: z.number().finite().nonnegative(),
});
// Cheap envelope check before the full parse, which is deferred to the frame.
const messageTypeSchema = z.object({ type: z.string() });
/** Heights beyond this are clamped; the inline card caps far below it anyway. */
const MAX_REPORTED_HEIGHT = 20_000;
const artifactStateMessageSchema = z.object({
	type: z.literal(ARTIFACT_STATE_MESSAGE),
	state: z
		.record(z.string(), z.unknown())
		// The frame's `set` already refuses oversize state; the page's own script
		// could post directly, so measure the same way Core will.
		.refine(
			(state) =>
				agentUiStateLimitProblem(state, {
					maxBytes: ARTIFACT_STATE_MAX_BYTES,
					maxDepth: ARTIFACT_STATE_MAX_DEPTH,
				}) === null
		),
});

function ArtifactFrame({
	doc,
	title,
	onContentHeight,
	onState,
}: {
	doc: string;
	title: string;
	onContentHeight?: ArtifactContentHeightHandler;
	onState?: ArtifactStateHandler;
}) {
	const frameRef = useRef<HTMLIFrameElement>(null);

	useEffect(() => {
		if (!(onContentHeight || onState)) {
			return;
		}
		// The page's own script shares the frame with the injected helpers, so it
		// can post these messages in a tight loop. Keep only the latest of each
		// kind and handle them at most once per animation frame; a height that
		// moved by less than 2px is ignored, so alternating values can't keep the
		// card re-rendering.
		let pendingSize: unknown;
		let pendingState: unknown;
		let frame: number | null = null;
		let lastHeight = -1;
		const flush = () => {
			frame = null;
			const size = artifactSizeMessageSchema.safeParse(pendingSize);
			pendingSize = undefined;
			if (size.success && Math.abs(size.data.height - lastHeight) >= 2) {
				lastHeight = size.data.height;
				onContentHeight?.(Math.min(size.data.height, MAX_REPORTED_HEIGHT));
			}
			const state = artifactStateMessageSchema.safeParse(pendingState);
			pendingState = undefined;
			if (state.success) {
				onState?.(state.data.state);
			}
		};
		const onMessage = (event: MessageEvent) => {
			if (
				!frameRef.current ||
				event.source !== frameRef.current.contentWindow
			) {
				return;
			}
			const type = messageTypeSchema.safeParse(event.data).data?.type;
			if (type === ARTIFACT_SIZE_MESSAGE) {
				pendingSize = event.data;
			} else if (type === ARTIFACT_STATE_MESSAGE) {
				pendingState = event.data;
			} else {
				return;
			}
			frame ??= requestAnimationFrame(flush);
		};
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
			if (frame !== null) {
				cancelAnimationFrame(frame);
			}
		};
	}, [onContentHeight, onState]);

	return (
		<iframe
			// allow-scripts WITHOUT allow-same-origin → null origin, no Tauri IPC,
			// no parent DOM. The doc's CSP blocks all network egress.
			className="h-full w-full border-0 bg-background"
			ref={frameRef}
			referrerPolicy="no-referrer"
			sandbox="allow-scripts"
			srcDoc={doc}
			title={title}
		/>
	);
}

function ArtifactError({ message }: { message: string }) {
	return (
		<div className="flex h-full items-center justify-center p-6">
			<div className="flex max-w-sm items-start gap-2 text-status-destructive text-xs">
				<HugeiconsIcon
					aria-hidden
					className="mt-0.5 size-4 shrink-0"
					icon={AlertCircleIcon}
				/>
				<span className="whitespace-pre-wrap break-words">{message}</span>
			</div>
		</div>
	);
}

/** Read-only code/file view (the artifact body for `code`/`file` kinds). */
function CodeView({ artifact }: { artifact: ArtifactView }) {
	return (
		<div className="h-full overflow-auto bg-sidebar">
			<pre
				className={cn(
					"type-image-viewer-caption p-3 font-mono text-foreground",
					styles.codeText
				)}
			>
				<code>{artifact.content}</code>
			</pre>
		</div>
	);
}

/** A `file` artifact whose content isn't inline (e.g. a binary or a created file
 *  that hasn't been fetched): a friendly placeholder instead of an empty code box.
 *  The header's "Open in editor" and the card's Open affordances still reach it. */
function FilePlaceholder({ artifact }: { artifact: ArtifactView }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 bg-sidebar p-6">
			<HugeiconsIcon
				aria-hidden
				className="size-8 text-muted-foreground/60"
				icon={File01Icon}
			/>
			<span className="max-w-xs text-center text-muted-foreground text-xs">
				{artifact.title || "File"} — open it in the side panel or as a tab to
				view it.
			</span>
		</div>
	);
}

/** A `database` artifact rendered as a table; falls back to the code view when
 *  the content isn't tabular. */
function DatabaseView({ artifact }: { artifact: ArtifactView }) {
	const table = useMemo(
		() => parseTabularContent(artifact.content),
		[artifact.content]
	);
	if (!table) {
		return <CodeView artifact={artifact} />;
	}
	return (
		<div className="h-full overflow-auto bg-sidebar">
			<div className="p-3">
				<div className="overflow-x-auto rounded-(--radius) border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								{table.columns.map((col) => (
									<TableHead key={col}>{col}</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{table.rows.map((row, rowIndex) => (
								<TableRow key={rowIndex}>
									{row.map((cell, cellIndex) => (
										<TableCell key={cellIndex}>{cell}</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</div>
		</div>
	);
}

function MermaidBody({
	artifact,
	theme,
	onContentHeight,
}: {
	artifact: ArtifactView;
	theme: ArtifactTheme | undefined;
	onContentHeight?: ArtifactContentHeightHandler;
}) {
	const [mermaidDoc, setMermaidDoc] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (artifact.kind !== "mermaid") {
			return;
		}
		let cancelled = false;
		setMermaidDoc(null);
		setError(null);
		compileMermaid(artifact.id, artifact.content, theme?.dark)
			.then((svg) => {
				if (!cancelled) {
					setMermaidDoc(artifactSrcDoc("svg", svg, theme));
				}
			})
			.catch((err: MermaidRenderRejection) => {
				if (!cancelled) {
					setError(
						err instanceof Error ? err.message : "Failed to render diagram"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [artifact.id, artifact.kind, artifact.content, theme]);

	if (error) {
		return <ArtifactError message={error} />;
	}
	if (!mermaidDoc) {
		return (
			<div className="flex h-full animate-skeleton items-center justify-center text-muted-foreground text-xs">
				Rendering diagram…
			</div>
		);
	}
	return (
		<ArtifactFrame
			doc={mermaidDoc}
			onContentHeight={onContentHeight}
			title={artifact.title}
		/>
	);
}

/**
 * The artifact BODY — everything below the header row. Shared by the full-size
 * `ArtifactRenderer`, the inline chat card and the window-tab page. Fills its
 * parent's height (`h-full`). Framed kinds (see `FRAMED_ARTIFACT_KINDS`) report
 * their natural content height through `onContentHeight`, which the inline card
 * uses to size itself to the content.
 */
export function ArtifactContentView({
	artifact,
	onContentHeight,
	onState,
	savedState = null,
}: {
	artifact: ArtifactView;
	onContentHeight?: ArtifactContentHeightHandler;
	/** Receives `ryu.state.set` snapshots from an HTML page, for saving. */
	onState?: ArtifactStateHandler;
	/** State handed to the page as `ryu.state.get()`. Read when the frame loads;
	 *  callers keep it stable while the page itself saves, or the frame reloads. */
	savedState?: ArtifactSavedState | null;
}) {
	const theme = useArtifactTheme();
	const syncDoc = useMemo(
		() => artifactSrcDoc(artifact.kind, artifact.content, theme, savedState),
		[artifact.kind, artifact.content, theme, savedState]
	);

	if (artifact.kind === "code") {
		return <CodeView artifact={artifact} />;
	}
	if (artifact.kind === "file") {
		return artifact.content.trim() ? (
			<CodeView artifact={artifact} />
		) : (
			<FilePlaceholder artifact={artifact} />
		);
	}
	if (artifact.kind === "database") {
		return <DatabaseView artifact={artifact} />;
	}
	if (artifact.kind === "space") {
		return (
			<div className="h-full overflow-auto bg-sidebar">
				<div className="p-4">
					<Markdown
						className={styles.markdownText}
						content={artifact.content}
						textContrast="high"
					/>
				</div>
			</div>
		);
	}
	if (artifact.kind === "mermaid") {
		return (
			<MermaidBody
				artifact={artifact}
				onContentHeight={onContentHeight}
				theme={theme}
			/>
		);
	}
	if (!syncDoc) {
		return <ArtifactError message="This artifact cannot be rendered." />;
	}
	return (
		<ArtifactFrame
			doc={syncDoc}
			onContentHeight={onContentHeight}
			onState={artifact.kind === "html" ? onState : undefined}
			title={artifact.title}
		/>
	);
}

/** Map an artifact action to a ToolApproval choice, wired to the host's
 *  follow-up so the user's pick becomes the agent's next prompt. */
/** The shared artifact header: kind glyph + title + badge, then (right-aligned)
 *  an approval-style action row and a file's "Open in editor" button. */
export function ArtifactHeader({
	artifact,
	compact,
	onOpenInEditor,
	onAction,
}: {
	artifact: ArtifactView;
	compact?: boolean;
	onOpenInEditor?: (filePath: string) => void;
	onAction?: (action: NativeArtifactActionObservation) => void;
}) {
	const { canUseNativeShell } = useAppSurface();
	// SAFETY: the unchanged actual host provider is viewed only through its raw
	// callback argument ABI. No method is read/bound here; the original optional
	// call below retains callee/label order, host receiver and native errors.
	const host = useArtifactHost() as NativeArtifactFollowUpOperation | null;
	const submit =
		onAction ??
		((action: NativeArtifactActionObservation) =>
			host?.submitFollowUp(action.label));
	const choices = liveArtifactActionChoices(artifact.actions, (text) => {
		const action = findLiveArtifactAction(artifact.actions, text);
		if (action) {
			submit(action);
		}
	});
	const defaultOpenInEditor =
		artifact.kind === "file" && artifact.filePath
			? (path: string) => {
					Promise.resolve(
						invoke("open_in_editor", { editor: "vscode", path })
					).catch(() => {
						/* the artifact stays viewable; nothing else to do */
					});
				}
			: undefined;
	// SAFETY: only the actual native editor callback argument ABI is exposed;
	// the same callback value receives the original raw SDK path. No string
	// value/DTO is asserted and downstream validation/errors stay native.
	const openInEditor = (
		canUseNativeShell ? (onOpenInEditor ?? defaultOpenInEditor) : undefined
	) as NativeArtifactEditorPathOperation | undefined;

	return (
		<div
			className={cn(
				"flex shrink-0 items-center gap-2 border-border/60 border-b px-3",
				compact ? "py-1.5" : "py-2"
			)}
		>
			<HugeiconsIcon
				aria-hidden
				className="size-4 shrink-0 text-muted-foreground"
				icon={KIND_ICON[artifact.kind]}
			/>
			<span
				className="min-w-0 flex-1 truncate font-medium text-foreground text-sm"
				title={artifact.title}
			>
				{artifact.title}
			</span>
			{artifact.kind === "file" && openInEditor && artifact.filePath ? (
				<button
					className="type-caption shrink-0 rounded-md px-2 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onClick={() => openInEditor(artifact.filePath)}
					type="button"
				>
					Open in editor
				</button>
			) : null}
			<span className="type-compact shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground uppercase tracking-wide">
				{KIND_LABEL[artifact.kind]}
			</span>
			{choices && choices.length > 0 ? (
				<NativeToolApprovalActions choices={choices} status="pending" />
			) : null}
		</div>
	);
}

export function ArtifactRenderer({ artifact }: { artifact: ArtifactView }) {
	const host = useArtifactHost();
	const [fetchedContent, setFetchedContent] = useState<string | null>(null);

	// A created artifact (`url` set, no inline content) is fetched lazily through
	// the host's node target; the window-tab page pre-resolves content on open, so
	// this only fires for e.g. a dock tab opened from the cowork panel.
	useEffect(() => {
		if (!artifact.url || artifact.content) {
			setFetchedContent(null);
			return;
		}
		let cancelled = false;
		host
			?.fetchContent(
				{
					url: artifact.url,
					mime: artifact.mime,
					title: artifact.title,
				},
				artifact.id
			)
			.then((content) => {
				if (!cancelled) {
					setFetchedContent(content);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		host,
		artifact.id,
		artifact.url,
		artifact.mime,
		artifact.title,
		artifact.content,
	]);

	const resolved: ArtifactView =
		fetchedContent === null
			? artifact
			: { ...artifact, content: fetchedContent };

	return (
		<div className="flex h-full flex-col">
			<ArtifactHeader artifact={artifact} />
			{/* Keyed on id so switching artifacts remounts the frame/compile cleanly.
			    No saved `ryu.state` here: page state belongs to the inline chat card,
			    and this full view runs a fresh copy whose changes are not saved. */}
			<div className="min-h-0 flex-1 overflow-hidden" key={artifact.id}>
				<ArtifactContentView artifact={resolved} />
			</div>
		</div>
	);
}
