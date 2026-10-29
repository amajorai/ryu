import type { CSSProperties } from "react";
import "./FocusSummary.css";
// apps/desktop/src/components/review/FocusSummary.tsx
//
// Shared focus-vs-distraction summary derived from Shadow's FocusStats. Used by
// both the Timeline work-journal pane and the Weekly Review page so the headline
// metric reads identically everywhere.

import { useLiteralMessages } from "@ryu/i18n/react";
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
	const tl = useLiteralMessages();
	const focusedLabel = tl("Focused {duration}", {
		duration: formatMinutesLabel(focus.focus_minutes),
	});
	const distractedLabel = tl("Distracted {duration}", {
		duration: formatMinutesLabel(focus.distraction_minutes),
	});
	const ratioPct = Math.round(focus.focus_ratio * 100);
	const total = Math.max(1, focus.total_minutes);
	const focusPct = (focus.focus_minutes / total) * 100;
	const distractionPct = (focus.distraction_minutes / total) * 100;

	const focusWidthVariables1: CSSProperties & {
		"--focus-segment-width": string;
	} = { "--focus-segment-width": `${focusPct}%` };
	const focusWidthVariables2: CSSProperties & {
		"--focus-segment-width": string;
	} = { "--focus-segment-width": `${distractionPct}%` };
	return (
		<div className={`min-w-0 rounded-lg bg-muted/30 p-3 ${className ?? ""}`}>
			<div className="mb-2 flex items-baseline justify-between gap-2">
				<span className="font-medium text-xs">{title}</span>
				<span className="font-mono text-lg tabular-nums leading-none">
					{ratioPct}
					<span className="text-muted-foreground text-xs">%</span>
				</span>
			</div>
			<div className="flex h-2 overflow-hidden rounded-full bg-muted">
				<div
					className="h-full bg-primary"
					data-focus-segment=""
					style={focusWidthVariables1}
					title={focusedLabel}
				/>
				<div
					className="h-full bg-warning"
					data-focus-segment=""
					style={focusWidthVariables2}
					title={distractedLabel}
				/>
			</div>
			<div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
				<span>
					<span className="inline-block size-2 translate-y-px rounded-full bg-primary" />{" "}
					{focusedLabel}
				</span>
				<span>
					<span className="inline-block size-2 translate-y-px rounded-full bg-warning" />{" "}
					{distractedLabel}
				</span>
				{focus.longest_focus_streak_minutes > 0 && (
					<span>
						{tl("Longest streak {duration}", {
							duration: formatMinutesLabel(focus.longest_focus_streak_minutes),
						})}
					</span>
				)}
			</div>
		</div>
	);
}
