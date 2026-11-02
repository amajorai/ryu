import { translate as tr } from "@ryu/i18n/lite";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { BOARD_STATUS_EMPTY } from "./board-status.tsx";
import { ActivityChart } from "./dashboard-activity.tsx";
import { AgentList, ThreadList, UpcomingList } from "./dashboard-lists.tsx";
import {
	type DashboardView,
	DEFAULT_LAYOUT,
	type WidgetId,
	widgetSpec,
} from "./dashboard-model.ts";
import { StatValue } from "./dashboard-stat.tsx";
import { widgetSpanClass } from "./dashboard-widget.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";

/**
 * The grid: 12 columns of 84px rows. Dense flow lets number tiles fill the
 * holes beside a taller panel instead of leaving them empty.
 */
export const GRID =
	"grid grid-flow-row-dense auto-rows-[84px] grid-cols-12 gap-3";

export interface WidgetContent {
	body: ReactNode;
	meta?: ReactNode;
}

export interface WidgetContext {
	activeThreadId: string | null;
	now: number;
	onOpen: (threadId: string) => void;
	onStart: (agentId: string) => void;
	snapshot: InterfaceRendererProps<unknown>["snapshot"];
	view: DashboardView;
}

function threadsWord(count: number): string {
	return tr("{count, plural, one {thread} other {threads}}", { count });
}

/** Each tile: one figure and the noun it counts. */
function statContent(id: WidgetId, view: DashboardView): WidgetContent {
	const { stats } = view;
	const tiles: Record<string, { context: string; value: number }> = {
		"stat-agents": {
			context: tr("of {count, plural, one {# agent} other {# agents}}", {
				count: stats.agents,
			}),
			value: stats.agentsWorking,
		},
		"stat-attention": {
			context:
				stats.failedRuns > 0
					? tr(
							"{threads, plural, one {# thread} other {# threads}}, {runs, plural, one {# run} other {# runs}}",
							{ runs: stats.failedRuns, threads: stats.attention }
						)
					: threadsWord(stats.attention),
			value: stats.attention + stats.failedRuns,
		},
		"stat-scheduled": {
			context: view.upcoming ? tr("scheduled runs") : tr("no schedules"),
			value: stats.scheduled24h,
		},
		"stat-updated": {
			context: tr("of {count, plural, one {# thread} other {# threads}}", {
				count: stats.threads,
			}),
			value: stats.updated24h,
		},
		"stat-working": {
			context: threadsWord(stats.working),
			value: stats.working,
		},
		"stat-your-turn": {
			context: threadsWord(stats.yourTurn),
			value: stats.yourTurn,
		},
	};
	const tile = tiles[id] ?? { context: "", value: 0 };
	return { body: <StatValue context={tile.context} value={tile.value} /> };
}

function threadWidget(
	context: WidgetContext,
	id: "attention" | "pinned" | "recent" | "working" | "your-turn"
): WidgetContent {
	const { activeThreadId, now, onOpen, snapshot, view } = context;
	const lists = {
		attention: {
			empty: BOARD_STATUS_EMPTY.attention,
			threads: view.byStatus.attention,
			variant: "attention",
		},
		pinned: {
			empty: "Pin a thread to keep it here.",
			threads: view.pinned,
			variant: "mixed",
		},
		recent: {
			empty: "No threads yet.",
			threads: view.recent,
			variant: "mixed",
		},
		working: {
			empty: BOARD_STATUS_EMPTY.working,
			threads: view.byStatus.working,
			variant: "working",
		},
		"your-turn": {
			empty: BOARD_STATUS_EMPTY["your-turn"],
			threads: view.byStatus["your-turn"],
			variant: "your-turn",
		},
	} as const;
	const list = lists[id];
	const runs = id === "attention" ? view.failedRuns : [];
	const count = list.threads.length + runs.length;
	return {
		body: (
			<ThreadList
				activeThreadId={activeThreadId}
				empty={list.empty}
				label={widgetSpec(id).title}
				now={now}
				onOpen={onOpen}
				runs={runs}
				snapshot={snapshot}
				threads={list.threads}
				variant={list.variant}
			/>
		),
		meta: count > 0 ? count : undefined,
	};
}

export function widgetContent(
	id: WidgetId,
	context: WidgetContext
): WidgetContent {
	const { activeThreadId, now, onOpen, onStart, snapshot, view } = context;
	switch (id) {
		case "attention":
		case "pinned":
		case "recent":
		case "working":
		case "your-turn":
			return threadWidget(context, id);
		case "agents":
			return {
				body: (
					<AgentList
						activeThreadId={activeThreadId}
						now={now}
						onOpen={onOpen}
						onStart={onStart}
						rows={view.agents}
					/>
				),
				meta:
					view.stats.agents > 0
						? tr("{working} of {total} working", {
								total: view.stats.agents,
								working: view.stats.agentsWorking,
							})
						: undefined,
			};
		case "activity":
			return {
				body: (
					<ActivityChart
						activity={view.activity}
						onOpen={onOpen}
						snapshot={snapshot}
					/>
				),
				meta: tr(
					"{count, plural, one {# thread} other {# threads}} · last 24h",
					{ count: view.activity.total }
				),
			};
		case "upcoming":
			return {
				body: (
					<UpcomingList events={view.upcoming} now={now} snapshot={snapshot} />
				),
				meta:
					view.upcoming && view.upcoming.length > 0
						? view.upcoming.length
						: undefined,
			};
		default:
			return statContent(id, view);
	}
}

export function LoadingGrid() {
	return (
		<div aria-hidden="true" className={GRID}>
			{DEFAULT_LAYOUT.map((item) => (
				<Skeleton
					className={cn(widgetSpanClass(item), "rounded-lg")}
					key={item.id}
					radius="row"
				/>
			))}
		</div>
	);
}
