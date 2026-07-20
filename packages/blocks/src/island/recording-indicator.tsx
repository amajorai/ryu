// A small live-recording indicator. Visible only when context capture is
// consented AND Shadow is actively capturing without a pause. A pulsing red dot
// communicates "you are being recorded" at a glance.

export function RecordingIndicator({
	recording,
	paused,
}: {
	paused: boolean;
	recording: boolean;
}) {
	if (recording) {
		return (
			<span className="flex items-center gap-1.5 text-[11px] text-red-300">
				<span className="size-2 animate-pulse rounded-full bg-red-500" />
				Recording
			</span>
		);
	}
	if (paused) {
		return (
			<span className="flex items-center gap-1.5 text-[11px] text-amber-300">
				<span className="size-2 rounded-full bg-amber-400" />
				Paused
			</span>
		);
	}
	return (
		<span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
			<span className="size-2 rounded-full bg-neutral-600" />
			Idle
		</span>
	);
}
