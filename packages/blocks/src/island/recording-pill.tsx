// The recording-state detail pill, shown while push-to-talk voice capture is
// active: a static red dot, the agent that will take the task, and a small
// monochrome level meter driven by the rolling amplitude `levels` from the
// capture hook (silence reads as flat bars). No edge glow and no pulse. Press
// the shortcut again to stop + transcribe.
// On a failure (mic denied, engine not running, empty/failed transcription) the
// pill shows a brief error instead of silently folding away.
//
// When an `agentName` is supplied it also surfaces which agent will take the
// dictated task, with a `⇥` hint that Tab (Shift+Tab) rotates it while recording.

import { Kbd } from "@ryu/ui/components/kbd.tsx";

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
const METER_BARS = 4;
/** Bar heights as a fraction of the meter, so silence still shows a stub. */
const METER_FLOOR = 0.2;

/** The newest levels as a few quiet bars (oldest first). */
function LevelMeter({ levels }: { levels: readonly number[] }) {
	const recent = levels.slice(-METER_BARS);
	const bars = Array.from(
		{ length: METER_BARS },
		(_, index) => recent[index - (METER_BARS - recent.length)] ?? 0
	);
	return (
		<span aria-hidden className="flex h-3 shrink-0 items-center gap-0.5">
			{bars.map((level, index) => (
				<span
					className="w-0.5 rounded-full bg-muted-foreground transition-[height] duration-(--duration-fast)"
					// Bars are positional (newest on the right) and never reorder.
					key={index}
					style={{
						height: `${Math.round(
							(METER_FLOOR +
								Math.min(1, Math.max(0, level)) * (1 - METER_FLOOR)) *
								100
						)}%`,
					}}
				/>
			))}
		</span>
	);
}

export function RecordingPill({
	agentName = null,
	canCycle = false,
	error = null,
	levels,
	wrap = false,
}: RecordingPillProps) {
	if (error) {
		return (
			<div
				className="flex w-full items-center justify-center px-2 text-center"
				role="alert"
			>
				<span className="text-sm text-status-destructive">{error}</span>
			</div>
		);
	}
	return (
		<div className="flex h-10 w-full items-center justify-center gap-2 text-popover-foreground">
			<span className="size-2 shrink-0 rounded-full bg-destructive" />
			{agentName ? (
				<span className="flex min-w-0 items-center gap-1.5 text-xs">
					<span
						className={`font-medium text-popover-foreground ${wrap ? "break-words" : "truncate"}`}
					>
						{agentName}
					</span>
					{canCycle ? <Kbd className="shrink-0">⇥</Kbd> : null}
				</span>
			) : (
				<span className="text-muted-foreground text-xs">Listening…</span>
			)}
			<LevelMeter levels={levels ?? DEMO_LEVELS} />
		</div>
	);
}
