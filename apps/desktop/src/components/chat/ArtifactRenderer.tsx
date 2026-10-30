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

import { useArtifactHost } from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { useEffect, useMemo, useState } from "react";
import { ArtifactHeader } from "@/src/components/panels/artifact-renderer/artifact-header.tsx";
import {
	type ArtifactSavedState,
	artifactSrcDoc,
} from "@/src/lib/artifact-srcdoc.ts";
import type { ArtifactKind } from "@/src/lib/artifacts.ts";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import { useArtifactTheme } from "@/src/lib/use-artifact-theme.ts";
import {
	type ArtifactContentHeightHandler,
	ArtifactFrame,
	type ArtifactStateHandler,
} from "./ArtifactRenderer-frame.tsx";
import {
	ArtifactError,
	CodeView,
	DatabaseView,
	FilePlaceholder,
	MermaidBody,
} from "./ArtifactRenderer-views.tsx";
import styles from "./artifact-renderer.module.css";

export {
	ArtifactHeader,
	KIND_ICON,
	KIND_LABEL,
} from "@/src/components/panels/artifact-renderer/artifact-header.tsx";
export type {
	ArtifactContentHeightHandler,
	ArtifactStateHandler,
} from "./ArtifactRenderer-frame.tsx";

/** Artifact kinds drawn in a sandboxed frame that reports its content height. */
export const FRAMED_ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set([
	"html",
	"svg",
	"mermaid",
]);

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
