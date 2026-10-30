import type { CSSProperties } from "react";
import "./LiveActivityDock.css";
// apps/desktop/src/components/live/LiveActivityDock.tsx
//
// The desktop "Dynamic Island" — a compact pill dock of live activities rendered
// on the EMPTY SHELL page (when no tabs are open). It mirrors the iOS/macOS Live
// Activities mental model: each activity is a small pill (app glyph + status
// pulse + title), and interacting with it expands it into a detail card (title,
// detail line, determinate progress bar, open-action) with a layout spring.
//
// Self-hides entirely when nothing is live, so the no-tabs launchpad stays calm
// when there is nothing to report. Rendered by `EmptyTabsState`; reads the shared
// live-activity store fed by the built-in + contributed adapters.

import type { LiveActivity } from "@ryu/app-host/live-activity";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { SPRING_MORPH } from "@ryu/ui/lib/ease.ts";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useLiveActivities } from "@/src/store/useLiveActivityStore.ts";

/** Status → pulse/tone colour, matching the island's status-dot language. */
const STATUS_TONE = {
	running: "var(--primary)",
	waiting: "var(--warning)",
	review: "var(--warning)",
	done: "var(--success)",
	error: "var(--destructive)",
} satisfies Record<LiveActivity["status"], string>;

function statusLabel(status: LiveActivity["status"]): string {
	switch (status) {
		case "running":
			return "Running";
		case "waiting":
			return "Needs input";
		case "review":
			return "In review";
		case "done":
			return "Done";
		case "error":
			return "Failed";
	}
}

/** Activate a card's action (route open; a view target would route the same). */
function useActivate() {
	const { openTab } = useTabsContext();
	return (activity: LiveActivity) => {
		if (activity.action?.kind === "route") {
			openTab(activity.action.path, { title: activity.title });
		}
	};
}

/** One expanded detail card. */
function ActivityCard({
	activity,
	onOpen,
}: {
	activity: LiveActivity;
	onOpen: (a: LiveActivity) => void;
}) {
	const tone = STATUS_TONE[activity.status] ?? "var(--primary)";
	const activityTintVariables2: CSSProperties & {
		"--live-activity-tint": string;
	} = { "--live-activity-tint": tone };
	return (
		<motion.div
			className="flex w-64 flex-col gap-2 rounded-xl border border-border bg-popover p-3 text-left text-popover-foreground shadow-lg"
			layout
			transition={SPRING_MORPH}
		>
			<div className="flex items-start gap-2">
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
						<span className="shrink-0 text-muted-foreground text-xs">
							{statusLabel(activity.status)}
						</span>
					</div>
					<p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs leading-snug">
						{activity.detail}
					</p>
				</div>
			</div>
			{activity.progress !== undefined && (
				<div aria-hidden className="h-1 overflow-hidden rounded-full bg-muted">
					<motion.div
						animate={{ width: `${Math.round(activity.progress * 100)}%` }}
						className="h-full rounded-full"
						data-live-activity-tint=""
						style={activityTintVariables2}
						transition={{ duration: 0.4, ease: "easeOut" }}
					/>
				</div>
			)}
			{activity.action && (
				<button
					className="mt-1 flex h-8 items-center justify-center gap-1 rounded-lg bg-muted font-medium text-foreground text-xs transition-colors duration-150 hover:bg-accent hover:duration-0"
					onClick={() => onOpen(activity)}
					type="button"
				>
					Open
				</button>
			)}
		</motion.div>
	);
}

/** One compact pill — the collapsed "island" state. */
function ActivityPill({
	activity,
	expanded,
	onToggle,
	onOpen,
}: {
	activity: LiveActivity;
	expanded: boolean;
	onOpen: (a: LiveActivity) => void;
	onToggle: (a: LiveActivity) => void;
}) {
	const tone = STATUS_TONE[activity.status] ?? "var(--primary)";
	const activityTintVariables3: CSSProperties & {
		"--live-activity-tint": string;
	} = { "--live-activity-tint": tone };
	return (
		<motion.button
			aria-expanded={expanded}
			className="group flex h-8 items-center gap-1.5 rounded-full border border-border bg-popover px-3 shadow-lg transition-colors duration-150 hover:bg-accent hover:duration-0"
			layout
			onClick={() => onToggle(activity)}
			type="button"
		>
			<span
				aria-hidden
				className="relative flex size-4 items-center justify-center"
			>
				<span
					className="absolute size-1.5 rounded-full"
					data-live-activity-tint=""
					style={activityTintVariables3}
				/>
			</span>
			<span
				className="max-w-28 truncate font-medium text-foreground text-xs"
				title={activity.title}
			>
				{activity.title}
			</span>
			{activity.progress !== undefined && (
				<span className="text-muted-foreground text-xs tabular-nums">
					{Math.round(activity.progress * 100)}%
				</span>
			)}
			{expanded && (
				<span
					aria-hidden
					className="ml-0.5 text-muted-foreground/70 text-xs tabular-nums"
				>
					{statusLabel(activity.status)}
				</span>
			)}
			{activity.action && (
				<span
					aria-hidden
					className="ml-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
					onClick={(e) => {
						e.stopPropagation();
						onOpen(activity);
					}}
				>
					<Icon className="size-3.5" icon="arrow-up-right-01" />
				</span>
			)}
		</motion.button>
	);
}

/**
 * The empty-shell live-activity dock. Collapsed: a row of pills (one per live
 * activity). Expanded: the clicked pill grows into its detail card beside the
 * remaining pills, Dynamic-Island-style. Self-hides when nothing is live.
 */
export function LiveActivityDock() {
	const activities = useLiveActivities();
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const reduceMotion = useReducedMotion();
	const onOpen = useActivate();

	if (activities.length === 0) {
		return null;
	}

	const toggle = (activity: LiveActivity) => {
		setExpandedId((current) => (current === activity.id ? null : activity.id));
	};

	return (
		<motion.div
			className="flex flex-wrap items-center justify-center gap-2"
			layout={!reduceMotion}
		>
			{activities.map((activity) => {
				const expanded = expandedId === activity.id;
				return expanded ? (
					<ActivityCard
						activity={activity}
						key={activity.id}
						onOpen={(a) => {
							onOpen(a);
							setExpandedId(null);
						}}
					/>
				) : (
					<ActivityPill
						activity={activity}
						expanded={false}
						key={activity.id}
						onOpen={(a) => {
							onOpen(a);
							setExpandedId(null);
						}}
						onToggle={toggle}
					/>
				);
			})}
		</motion.div>
	);
}
