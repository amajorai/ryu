import { agentUiStateLimitProblem } from "@ryu/blocks/desktop/agent-elements/agent-ui/state-limits.ts";
import { useEffect, useRef } from "react";
import { z } from "zod";
import {
	ARTIFACT_SIZE_MESSAGE,
	ARTIFACT_STATE_MAX_BYTES,
	ARTIFACT_STATE_MAX_DEPTH,
	ARTIFACT_STATE_MESSAGE,
	type ArtifactSavedState,
} from "@/src/lib/artifact-srcdoc.ts";

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

export function ArtifactFrame({
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
