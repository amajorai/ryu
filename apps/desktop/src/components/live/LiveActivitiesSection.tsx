import type { CSSProperties } from "react";
import "./LiveActivitiesSection.css";
// apps/desktop/src/components/live/LiveActivitiesSection.tsx
//
// The sidebar's "Live" section — a pinned, self-hiding block of live-activity
// cards (agent working, downloads, approvals, recording, contributed). Rendered
// in the docked sidebar just above the announcements block, so ongoing work is
// visible without opening a tab. Mirrors the `AnnouncementsSection` precedent:
// accent-coloured compact cards, hidden entirely when nothing is live.

import type { LiveActivity } from "@ryu/app-host/live-activity";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useLiveActivities } from "@/src/store/useLiveActivityStore.ts";

/** Status → tone colour, matching the island's status-dot language. */
const STATUS_TONE = {
	running: "var(--primary)",
	waiting: "var(--warning)",
	review: "var(--warning)",
	done: "var(--success)",
	error: "var(--destructive)",
} satisfies Record<LiveActivity["status"], string>;

/** A compact row: glyph tile + title/detail + optional progress bar. */
function LiveActivityRow({
	activity,
	onOpen,
}: {
	activity: LiveActivity;
	onOpen: (a: LiveActivity) => void;
}) {
	const tone = STATUS_TONE[activity.status] ?? "var(--primary)";
	const clickable = Boolean(activity.action);
	const activityTintVariables2: CSSProperties & {
		"--live-activity-tint": string;
	} = { "--live-activity-tint": tone };
	const activityProgressVariables3: CSSProperties & {
		"--live-activity-tint": string;
		"--live-activity-progress": string;
	} = {
		"--live-activity-tint": tone,
		"--live-activity-progress": `${Math.round((activity.progress ?? 0) * 100)}%`,
	};
	const row = (
		<div className="flex min-w-0 flex-1 items-start gap-2">
			<span
				aria-hidden
				className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground"
			>
				<Icon className="size-4" icon={activity.icon ?? "activity-03"} />
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span
						className="truncate font-medium text-foreground text-xs"
						title={activity.title}
					>
						{activity.title}
					</span>
					<span
						aria-hidden
						className="size-1.5 shrink-0 rounded-full"
						data-live-activity-tint=""
						style={activityTintVariables2}
					/>
				</div>
				{activity.detail && (
					<p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs leading-snug">
						{activity.detail}
					</p>
				)}
				{activity.progress !== undefined && (
					<div
						aria-hidden
						className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
					>
						<div
							className="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
							data-live-activity-progress=""
							data-live-activity-tint=""
							style={activityProgressVariables3}
						/>
					</div>
				)}
			</div>
		</div>
	);
	if (!clickable) {
		return (
			<div className="group/act relative flex gap-2.5 rounded-lg border border-border border-l-2 bg-muted/40 p-2.5">
				{row}
			</div>
		);
	}
	const activityTintVariables4: CSSProperties & {
		"--live-activity-tint": string;
	} = { "--live-activity-tint": tone };
	return (
		<button
			className="group/act relative flex w-full gap-2.5 rounded-lg border border-border border-l-2 bg-muted/40 p-2.5 text-left transition-colors hover:bg-muted/70"
			data-live-activity-border=""
			onClick={() => onOpen(activity)}
			style={activityTintVariables4}
			type="button"
		>
			{row}
			<Icon
				className="mt-0.5 size-3 shrink-0"
				icon="arrow-up-right-01"
				tone="muted"
			/>
		</button>
	);
}

/** Pinned "Live" block for the sidebar. Self-hides when nothing is live. */
export function LiveActivitiesSection() {
	const activities = useLiveActivities();
	const openTab = useTabSelector((state) => state.openTab);

	if (activities.length === 0) {
		return null;
	}

	const onOpen = (activity: LiveActivity) => {
		if (activity.action?.kind === "route") {
			openTab(activity.action.path, { title: activity.title });
		}
	};

	return (
		<div className="flex flex-col gap-1.5 px-2 pb-1">
			<div className="flex items-center gap-2 px-1">
				<span className="text-detail text-muted-foreground">Live</span>
				<div className="flex-1" />
				<span aria-hidden className="size-1.5 rounded-full bg-primary" />
			</div>
			<div className="scroll-fade flex max-h-[38vh] flex-col gap-1.5 overflow-y-auto">
				{activities.map((activity) => (
					<LiveActivityRow
						activity={activity}
						key={activity.id}
						onOpen={onOpen}
					/>
				))}
			</div>
		</div>
	);
}
