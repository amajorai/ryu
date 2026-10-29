// apps/desktop/src/components/clips/ClipComposerControls.tsx
//
// The composer-side entry point for Ryu Clips. Composes the RecordingControls
// (record bar) and the ClipsList (picker), and on either a fresh stop or a pick
// turns the clip into a chat attachment: it fetches the agent-context manifest,
// pulls a capped set of key-moment frames as image parts, builds a markdown
// context summary, and hands both to `onAttach` (wired to the composer's
// `attachClip`). It also hosts the "Attach recent activity" ambient-context
// entry, which rides the same `onAttach` sink but is fully ephemeral.

import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComposerSendFile } from "@/src/components/assistant/useComposerSlot.tsx";
import { AttachRecentActivityControl } from "@/src/components/clips/AttachRecentActivityControl.tsx";
import { AttachVideoControl } from "@/src/components/clips/AttachVideoControl.tsx";
import { ClipsList } from "@/src/components/clips/ClipsList.tsx";
import { RecordingControls } from "@/src/components/clips/RecordingControls.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type ClipCapture,
	type ClipContext,
	fetchClipFrameDataUrl,
	getClipContext,
} from "@/src/lib/api/clips.ts";
import { publishMediaSource } from "@/src/lib/media-pip.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** Cap on how many key frames we attach. 24 gives real multi-frame "watch"
 * fidelity (claude-video "balanced" style) instead of 4 stills, while keeping
 * the turn bounded even though ingest extracts 50-100 frames. Core's image-part
 * injection loops over every frame, so raising this is a desktop-only change. */
const MAX_FRAMES = 24;

/** The Clips app id — the composer controls only appear when it's enabled. */
const CLIPS_PLUGIN_ID = "@ryu/clips";

/** Pick up to {@link MAX_FRAMES} moments: prefer the recommended (diagnostic)
 * moments, else fall back to evenly-spaced samples across the clip. */
function pickMoments(ctx: ClipContext): number[] {
	if (ctx.recommendedMoments.length > 0) {
		return ctx.recommendedMoments.slice(0, MAX_FRAMES).map((m) => m.atMs);
	}
	if (ctx.durationMs > 0) {
		const moments: number[] = [];
		for (let i = 1; i <= MAX_FRAMES; i++) {
			moments.push(Math.round((ctx.durationMs * i) / (MAX_FRAMES + 1)));
		}
		return moments;
	}
	return [];
}

/** Human list of the inputs a clip captured. */
function describeSources(capture: ClipCapture): string {
	const on: string[] = [];
	if (capture.screen) {
		on.push("screen");
	}
	if (capture.mic) {
		on.push("mic");
	}
	if (capture.systemAudio) {
		on.push("systemAudio");
	}
	return on.length > 0 ? on.join("/") : "none";
}

/** Build the markdown context summary the agent reads alongside the frames. */
function buildSummary(ctx: ClipContext, frameCount: number): string {
	const lines: string[] = [
		`[Ryu Clip: ${ctx.title || "Untitled clip"}] duration ${ctx.durationMs}ms, captured ${ctx.createdAt}.`,
		`Sources: ${describeSources(ctx.capture)}; tab ${ctx.capture.tab?.url ?? "none"}.`,
	];
	if (ctx.recommendedMoments.length > 0) {
		lines.push(`Diagnostics (${ctx.recommendedMoments.length}):`);
		for (const moment of ctx.recommendedMoments) {
			lines.push(`- ${moment.atMs}ms: ${moment.reason}`);
		}
	} else {
		lines.push("Diagnostics (0): none captured.");
	}
	lines.push(
		frameCount > 0
			? `${frameCount} frames attached for the moments above.`
			: "No frames were available; this recording is attached as context without images."
	);
	return lines.join("\n");
}

export interface ClipComposerControlsProps {
	className?: string;
	/** Deliver the built summary text + frame image parts to the composer. */
	onAttach: (text: string, frames: ComposerSendFile[]) => void;
}

export function ClipComposerControls({
	className,
	onAttach,
}: ClipComposerControlsProps) {
	const { apps } = useApps();
	const node = useNodeStore((s) => s.getActiveNode());
	const target = useMemo(() => toTarget(node), [node]);

	type AttachmentRequest = { context: ClipContext } | { clipId: string };
	const scope = JSON.stringify([target.url, target.token, target.userJwt]);
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const mounted = useRef(true);
	const pending = useRef<symbol | null>(null);
	const pendingClip = useRef<string | null>(null);
	const queuedRequests = useRef<AttachmentRequest[]>([]);
	const [isAttaching, setAttaching] = useState(false);
	const [failedRequest, setFailedRequest] = useState<AttachmentRequest | null>(
		null
	);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	useEffect(() => {
		pending.current = null;
		pendingClip.current = null;
		queuedRequests.current = [];
		setAttaching(false);
		setFailedRequest(null);
		setAttachmentError(null);
	}, [scope]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			pending.current = null;
			queuedRequests.current = [];
		};
	}, []);
	const runAttachment = useCallback(
		async function attach(request: AttachmentRequest): Promise<void> {
			if (currentScope.current !== scope) {
				return;
			}
			const clipId = "context" in request ? request.context.id : request.clipId;
			if (pending.current) {
				if (
					pendingClip.current !== clipId &&
					!queuedRequests.current.some(
						(queued) =>
							("context" in queued ? queued.context.id : queued.clipId) ===
							clipId
					)
				) {
					queuedRequests.current.push(request);
				}
				return;
			}
			const operation = Symbol("attach recording");
			pending.current = operation;
			pendingClip.current = clipId;
			let attached = false;
			const isCurrent = () =>
				mounted.current &&
				currentScope.current === scope &&
				pending.current === operation;
			setAttaching(true);
			setAttachmentError(null);
			setFailedRequest(null);
			try {
				const ctx =
					"context" in request
						? request.context
						: await getClipContext(target, request.clipId);
				if (!isCurrent()) {
					return;
				}
				// Poster and individual missing frames remain optional; never forward node credentials.
				const poster = await fetchClipFrameDataUrl(target, ctx.id, 0).catch(
					() => null
				);
				if (!isCurrent()) {
					return;
				}
				if (poster) {
					publishMediaSource({
						id: `clip:${ctx.id}`,
						imageUrl: poster,
						kind: "recording",
						posterUrl: poster,
						title: ctx.title || "Evidence recording",
					});
				}
				const frames: ComposerSendFile[] = [];
				for (const atMs of pickMoments(ctx)) {
					try {
						const url = await fetchClipFrameDataUrl(target, ctx.id, atMs);
						if (!isCurrent()) {
							return;
						}
						frames.push({
							type: "file",
							filename: `clip-frame-${atMs}.jpg`,
							mediaType: "image/jpeg",
							url,
						});
					} catch {
						/* A missing frame must not discard otherwise useful context. */
					}
				}
				if (!isCurrent()) {
					return;
				}
				onAttach(buildSummary(ctx, frames.length), frames);
				attached = true;
			} catch (error) {
				if (isCurrent()) {
					setFailedRequest(request);
					setAttachmentError(
						error instanceof Error
							? error.message
							: "Failed to attach recording"
					);
				}
			} finally {
				if (isCurrent()) {
					pending.current = null;
					pendingClip.current = null;
					setAttaching(false);
					const next = attached ? queuedRequests.current.shift() : undefined;
					if (next) {
						void attach(next);
					}
				}
			}
		},
		[onAttach, scope, target]
	);
	const attachContext = useCallback(
		(context: ClipContext) => runAttachment({ context }),
		[runAttachment]
	);
	const handleClipReady = useCallback(
		(context: ClipContext) => {
			void attachContext(context);
		},
		[attachContext]
	);
	const handlePick = useCallback(
		(clipId: string) => {
			void runAttachment({ clipId });
		},
		[runAttachment]
	);

	// Clips is an APP: only surface its composer controls when `@ryu/clips` is
	// installed AND enabled, so an install-on-demand Clips leaves the composer clean
	// — the app owns its own presence in the shell rather than the composer
	// hardcoding it. Hidden while the app list is still loading.
	if (!apps.some((a) => a.id === CLIPS_PLUGIN_ID && a.enabled)) {
		return null;
	}

	return (
		<div className={cn("flex items-center gap-1", className)}>
			<RecordingControls onClipReady={handleClipReady} />
			<ClipsList onPick={handlePick} />
			<AttachVideoControl onIngested={attachContext} />
			<AttachRecentActivityControl onAttach={onAttach} />
			{isAttaching && (
				<span className="text-muted-foreground text-xs" role="status">
					Preparing recording…
				</span>
			)}
			{attachmentError && (
				<span
					className="text-status-destructive text-xs"
					role="alert"
					title={attachmentError}
				>
					Could not attach recording.
				</span>
			)}
			{failedRequest && (
				<Button
					onClick={() => {
						void runAttachment(failedRequest);
					}}
					size="sm"
					type="button"
					variant="ghost"
				>
					Retry attachment
				</Button>
			)}
		</div>
	);
}
