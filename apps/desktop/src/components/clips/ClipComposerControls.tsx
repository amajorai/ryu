// apps/desktop/src/components/clips/ClipComposerControls.tsx
//
// The composer-side entry point for Ryu Clips. Composes the RecordingControls
// (record bar) and the ClipsList (picker), and on either a fresh stop or a pick
// turns the clip into a chat attachment: it fetches the agent-context manifest,
// pulls a capped set of key-moment frames as image parts, builds a markdown
// context summary, and hands both to `onAttach` (wired to the composer's
// `attachClip`). It also hosts the "Attach recent activity" ambient-context
// entry, which rides the same `onAttach` sink but is fully ephemeral.

import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useMemo } from "react";
import type { ComposerSendFile } from "@/src/components/assistant/useComposerSlot.tsx";
import { ProLockedBadge } from "@/src/components/billing/ProLockedBadge.tsx";
import { AttachRecentActivityControl } from "@/src/components/clips/AttachRecentActivityControl.tsx";
import { AttachVideoControl } from "@/src/components/clips/AttachVideoControl.tsx";
import { ClipsList } from "@/src/components/clips/ClipsList.tsx";
import { RecordingControls } from "@/src/components/clips/RecordingControls.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type ClipCapture,
	type ClipContext,
	fetchClipFrameDataUrl,
	getClipContext,
} from "@/src/lib/api/clips.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** Cap on how many key frames we attach. 24 gives real multi-frame "watch"
 * fidelity (claude-video "balanced" style) instead of 4 stills, while keeping
 * the turn bounded even though ingest extracts 50-100 frames. Core's image-part
 * injection loops over every frame, so raising this is a desktop-only change. */
const MAX_FRAMES = 24;

/** The Clips app id — the composer controls only appear when it's enabled. */
const CLIPS_PLUGIN_ID = "com.ryu.clips";

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
function buildSummary(ctx: ClipContext): string {
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
	lines.push("Attached frames correspond to the moments above.");
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
	const { canUse } = useEntitlementContext();
	const { apps } = useApps();
	const node = useNodeStore((s) => s.getActiveNode());
	const target = useMemo(() => toTarget(node), [node]);

	const attachContext = useCallback(
		async (ctx: ClipContext) => {
			const moments = pickMoments(ctx);
			const frames: ComposerSendFile[] = [];
			for (const atMs of moments) {
				try {
					const url = await fetchClipFrameDataUrl(target, ctx.id, atMs);
					frames.push({
						type: "file",
						filename: `clip-frame-${atMs}.jpg`,
						mediaType: "image/jpeg",
						url,
					});
				} catch {
					// A single missing frame should not block the whole attachment.
				}
			}
			onAttach(buildSummary(ctx), frames);
		},
		[onAttach, target]
	);

	const handleClipReady = useCallback(
		(ctx: ClipContext) => {
			attachContext(ctx);
		},
		[attachContext]
	);

	const handlePick = useCallback(
		(clipId: string) => {
			getClipContext(target, clipId)
				.then((ctx) => attachContext(ctx))
				.catch(() => undefined);
		},
		[attachContext, target]
	);

	// Clips is an APP: only surface its composer controls (record/attach + the Pro
	// badge) when `com.ryu.clips` is installed AND enabled, so a default-off Clips
	// leaves the composer clean — the app owns its own presence in the shell rather
	// than the composer hardcoding it. Hidden while the app list is still loading.
	if (!apps.some((a) => a.id === CLIPS_PLUGIN_ID && a.enabled)) {
		return null;
	}

	// Band-2 gate (free-tier plan): Ryu Clips (agent video recording/ingest) is a
	// Pro feature. Show a locked upsell badge in place of the controls rather than
	// hiding the affordance.
	if (!canUse("clips")) {
		return (
			<div className={cn("flex items-center gap-1", className)}>
				<ProLockedBadge feature="Clips" />
			</div>
		);
	}

	return (
		<div className={cn("flex items-center gap-1", className)}>
			<RecordingControls onClipReady={handleClipReady} />
			<ClipsList onPick={handlePick} />
			<AttachVideoControl onIngested={attachContext} />
			<AttachRecentActivityControl onAttach={onAttach} />
		</div>
	);
}
