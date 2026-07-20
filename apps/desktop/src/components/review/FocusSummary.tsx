// apps/desktop/src/components/review/FocusSummary.tsx
//
// Shared focus-vs-distraction summary derived from Shadow's FocusStats. Used by
// both the Timeline work-journal pane and the Weekly Review page so the headline
// metric reads identically everywhere.

import type { FocusStats } from "@/src/lib/api/shadow.ts";

function formatMinutesLabel(minutes: number): string {
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** A thin stacked focus/distraction bar with the focus ratio as a headline. */
export function FocusSummary(props: {
	className?: string;
	focus: FocusStats;
	title?: string;
}) {
	const { className, focus, title = "Focus" } = props;
	const ratioPct = Math.round(focus.focus_ratio * 100);
	const total = Math.max(1, focus.total_minutes);
	const focusPct = (focus.focus_minutes / total) * 100;
	const distractionPct = (focus.distraction_minutes / total) * 100;

	return (
		<div className={`min-w-0 rounded-lg bg-muted/30 p-3 ${className ?? ""}`}>
			<div className="mb-2 flex items-baseline justify-between gap-2">
				<span className="font-semibold text-xs">{title}</span>
				<span className="font-mono text-lg tabular-nums leading-none">
					{ratioPct}
					<span className="text-muted-foreground text-xs">%</span>
				</span>
			</div>
			<div className="flex h-2 overflow-hidden rounded-full bg-muted">
				<div
					className="h-full bg-primary"
					style={{ width: `${focusPct}%` }}
					title={`Focused ${formatMinutesLabel(focus.focus_minutes)}`}
				/>
				<div
					className="h-full bg-warning"
					style={{ width: `${distractionPct}%` }}
					title={`Distracted ${formatMinutesLabel(focus.distraction_minutes)}`}
				/>
			</div>
			<div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
				<span>
					<span className="inline-block size-2 translate-y-px rounded-full bg-primary" />{" "}
					Focused {formatMinutesLabel(focus.focus_minutes)}
				</span>
				<span>
					<span className="inline-block size-2 translate-y-px rounded-full bg-warning" />{" "}
					Distracted {formatMinutesLabel(focus.distraction_minutes)}
				</span>
				{focus.longest_focus_streak_minutes > 0 && (
					<span>
						Longest streak{" "}
						{formatMinutesLabel(focus.longest_focus_streak_minutes)}
					</span>
				)}
			</div>
		</div>
	);
}
