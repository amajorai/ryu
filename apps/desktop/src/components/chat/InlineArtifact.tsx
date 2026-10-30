import layout from "./chat-layout.module.css";
// apps/desktop/src/components/chat/InlineArtifact.tsx
//
// The desktop's injected Renderer for the blocks artifact host: a compact
// artifact card that the agent's `artifact.render` / `artifact.create` tool
// renders INLINE in the chat. Shows a live preview (same ArtifactContentView as
// the dock tab) and two affordances — "Open" (right dock artifact tab) and
// "Open in tab" (a workspace window tab) — so a user can keep one artifact on
// screen while the conversation moves on. No limit on how many render at once:
// each one is an independent card, and each Open call mints its own dock tab.
//
// A created artifact (`url` set, no inline content) is lazily fetched through
// the host's node target; until it resolves the preview shows a placeholder.
//
// Pages, SVGs and diagrams render at their natural height (reported by the
// sandboxed frame), so a chart, dashboard or UI mock reads as part of the
// answer rather than a thumbnail. Very tall content is capped and scrolls
// inside the frame; other kinds keep a compact fixed-height preview.
//
// An HTML page can keep state with `ryu.state.set(obj)`; it is saved with the
// conversation and handed back through `ryu.state.get()` when the chat reopens.

import {
	type NativeArtifactObservation,
	useArtifactHost,
} from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ButtonGroup,
	ButtonGroupSeparator,
} from "@ryu/ui/components/button-group.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import {
	ArtifactContentView,
	ArtifactHeader,
	FRAMED_ARTIFACT_KINDS,
} from "@/src/components/chat/ArtifactRenderer.tsx";
import { useArtifactPageState } from "@/src/hooks/useArtifactPageState.ts";
import { artifactFromSdkObservation } from "@/src/lib/live-artifacts.ts";

/** Height before the frame has reported its content size. */
const INITIAL_FRAME_HEIGHT = 240;
const MIN_FRAME_HEIGHT = 96;
/** Taller content scrolls inside the frame; the full view is one click away. */
const MAX_FRAME_HEIGHT = 960;

interface InlineArtifactGeometryStyle extends CSSProperties {
	"--inline-artifact-height"?: string;
}

function clampFrameHeight(height: number): number {
	return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, height));
}

export function InlineArtifact({
	artifact: payload,
	id,
}: {
	artifact: NativeArtifactObservation;
	id: string;
}) {
	const host = useArtifactHost();
	const [fetchedContent, setFetchedContent] = useState<string | null>(null);
	const [fetching, setFetching] = useState(false);
	const [frameHeight, setFrameHeight] = useState(INITIAL_FRAME_HEIGHT);

	// A created artifact carries a blob URL but no inline content: fetch it once
	// through the host so the preview renders rather than sitting empty.
	useEffect(() => {
		if (!payload.url || payload.content) {
			setFetchedContent(null);
			return;
		}
		let cancelled = false;
		setFetching(true);
		host?.fetchContent(payload, id).then((content) => {
			if (!cancelled) {
				setFetchedContent(content);
				setFetching(false);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [host, id, payload.url, payload.content]);

	const artifact = useMemo(
		() =>
			artifactFromSdkObservation(
				{ ...payload, content: payload.content ?? fetchedContent ?? "" },
				id,
				"tool"
			),
		[id, payload, fetchedContent]
	);

	const pageState = useArtifactPageState(id, artifact.title);
	const framed = FRAMED_ARTIFACT_KINDS.has(artifact.kind);
	const geometry: InlineArtifactGeometryStyle | undefined = framed
		? { "--inline-artifact-height": `${clampFrameHeight(frameHeight)}px` }
		: undefined;

	return (
		<div className="flex flex-col overflow-hidden rounded-xl border border-border bg-background">
			<ArtifactHeader artifact={artifact} compact />
			<div
				className={cn(
					"min-h-0 overflow-hidden",
					framed
						? cn(
								layout.artifactFrame,
								"h-(--inline-artifact-height) duration-150"
							)
						: "h-40"
				)}
				data-testid="inline-artifact-body"
				style={geometry}
			>
				{fetching && !fetchedContent ? (
					<div className="flex h-full animate-skeleton items-center justify-center bg-sidebar text-muted-foreground text-xs">
						Loading artifact…
					</div>
				) : (
					<ArtifactContentView
						artifact={artifact}
						onContentHeight={framed ? setFrameHeight : undefined}
						onState={pageState.onState}
						savedState={pageState.savedState}
					/>
				)}
			</div>
			<div className="flex h-10 shrink-0 items-center justify-end border-border border-t px-2">
				<ButtonGroup aria-label="Artifact actions">
					<Button
						onClick={() => host?.openInPanel(payload, id)}
						size="sm"
						variant="ghost-muted"
					>
						Open
					</Button>
					<ButtonGroupSeparator />
					<Button
						onClick={() => host?.openInTab(payload, id)}
						size="sm"
						variant="ghost-muted"
					>
						Open in tab
					</Button>
				</ButtonGroup>
			</div>
		</div>
	);
}
