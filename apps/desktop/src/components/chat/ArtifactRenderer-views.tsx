import { AlertCircleIcon, File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useMemo, useState } from "react";
import {
	type ArtifactTheme,
	artifactSrcDoc,
} from "@/src/lib/artifact-srcdoc.ts";
import { parseTabularContent } from "@/src/lib/artifacts.ts";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import {
	type ArtifactContentHeightHandler,
	ArtifactFrame,
} from "./ArtifactRenderer-frame.tsx";
import styles from "./artifact-renderer.module.css";

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

export function ArtifactError({ message }: { message: string }) {
	return (
		<div className="flex h-full items-center justify-center p-6">
			<div className="flex max-w-sm items-start gap-2 text-muted-foreground text-xs">
				<HugeiconsIcon
					aria-hidden
					className="mt-0.5 size-4 shrink-0 text-status-destructive"
					icon={AlertCircleIcon}
				/>
				<span className="whitespace-pre-wrap break-words">{message}</span>
			</div>
		</div>
	);
}

/** Read-only code/file view (the artifact body for `code`/`file` kinds). */
export function CodeView({ artifact }: { artifact: ArtifactView }) {
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
export function FilePlaceholder({ artifact }: { artifact: ArtifactView }) {
	const tl = useLiteralMessages();
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 bg-sidebar p-6">
			<HugeiconsIcon
				aria-hidden
				className="size-5 text-muted-foreground"
				icon={File01Icon}
			/>
			<span className="max-w-xs text-center text-muted-foreground text-xs">
				{tl("{title} — open it in the side panel or as a tab to view it.", {
					title: artifact.title || "File",
				})}
			</span>
		</div>
	);
}

/** A `database` artifact rendered as a table; falls back to the code view when
 *  the content isn't tabular. */
export function DatabaseView({ artifact }: { artifact: ArtifactView }) {
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
				<div className="overflow-x-auto rounded-xl border border-border">
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

export function MermaidBody({
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
