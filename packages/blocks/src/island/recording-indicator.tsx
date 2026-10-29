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
			<span className="type-caption flex items-center gap-1.5 text-status-destructive">
				<span className="size-2 animate-pulse rounded-full bg-destructive" />
				Recording
			</span>
		);
	}
	if (paused) {
		return (
			<span className="type-caption flex items-center gap-1.5 text-status-warning">
				<span className="size-2 rounded-full bg-warning" />
				Paused
			</span>
		);
	}
	return (
		<span className="type-caption flex items-center gap-1.5 text-muted-foreground">
			<span className="size-2 rounded-full bg-muted-foreground" />
			Idle
		</span>
	);
}
