// The recording-state detail pill: a live microphone waveform shown while
// push-to-talk voice capture is active. The Wave is the shared loading-ui
// component (`@ryu/ui`), driven by the rolling amplitude `levels` from the
// capture hook so it flows across the timeline as you speak (silence reads as a
// flat line, speech as hills). Press the shortcut again to stop + transcribe.
// On a failure (mic denied, engine not running, empty/failed transcription) the
// pill shows a brief error instead of silently folding away.
//
// When an `agentName` is supplied it also surfaces which agent will take the
// dictated task, with a `⇥` hint that Tab (Shift+Tab) rotates it while recording.

import { VoiceGlow } from "@ryu/ui/components/voice-glow.tsx";

export interface RecordingPillProps {
	/** Name of the agent that will handle the task (routed voice agent). */
	agentName?: string | null;
	/** Whether Tab actually cycles agents (>1 installed) — shows the hint. */
	canCycle?: boolean;
	/** Transient error message; when set, replaces the waveform. */
	error?: string | null;
	/** Live amplitude history (0..1), oldest-to-newest, from the capture hook. */
	levels?: number[];
	/**
	 * Let a long agent name wrap instead of truncating. Only safe on a surface
	 * whose height tracks its content (the desktop island pill measures this and
	 * grows); fixed-height hosts keep the single-line default.
	 */
	wrap?: boolean;
}

const DEMO_LEVELS = [
	0.3, 0.6, 0.9, 0.5, 0.8, 0.4, 0.7, 0.9, 0.6, 0.4, 0.8, 0.5, 0.9, 0.6, 0.3,
	0.7,
];

export function RecordingPill({
	agentName = null,
	canCycle = false,
	error = null,
	levels,
	wrap = false,
}: RecordingPillProps) {
	if (error) {
		return (
			<div className="flex w-full items-center justify-center px-2 text-center">
				<span className="text-status-destructive text-xs">{error}</span>
			</div>
		);
	}
	return (
		<VoiceGlow className="w-full" levels={levels ?? DEMO_LEVELS} type="pill">
			<div className="flex h-10 w-full items-center justify-center gap-2 rounded-full px-3 text-popover-foreground">
				<span className="size-2 shrink-0 rounded-full bg-destructive motion-safe:animate-pulse" />
				{agentName ? (
					<span className="flex min-w-0 items-center gap-1 text-xs">
						<span
							className={`font-medium text-popover-foreground ${wrap ? "break-words" : "truncate"}`}
						>
							{agentName}
						</span>
						{canCycle ? (
							<kbd className="type-compact shrink-0 rounded bg-muted px-1 py-0.5 text-muted-foreground">
								⇥
							</kbd>
						) : null}
					</span>
				) : (
					<span className="text-muted-foreground text-xs">Listening…</span>
				)}
			</div>
		</VoiceGlow>
	);
}
