import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceEvent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { type ReactNode, useCallback, useId, useState } from "react";
import { agentById, compactAge } from "./interface-renderer.ts";
import { TIME_TEXT, WholeRowList } from "./mission-control-alerts-list.tsx";
import { useNow } from "./mission-control-hooks.ts";
import { countdown, countdownTicks, runWhen } from "./mission-control-model.ts";
import { Lamp, MissionPanel } from "./mission-control-parts.tsx";

function ownerName(
	agentId: string | null,
	snapshot: InterfaceSnapshot
): string {
	return agentById(snapshot, agentId)?.name ?? "Workflow";
}

/** Time column, then what ran and who: shared by upcoming and recent rows. */
const RUN_ROW =
	"grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-3 rounded-md px-2 py-1.5";

function RunText({ detail, title }: { detail: string; title: string }) {
	return (
		<span className="flex min-w-0 flex-col gap-0.5">
			<span className="truncate font-medium text-[13px] text-foreground leading-5">
				{title}
			</span>
			<span className="truncate text-muted-foreground text-xs leading-4">
				{detail}
			</span>
		</span>
	);
}

function runTitle(event: InterfaceEvent): string {
	return event.title.trim() || "Scheduled run";
}

/** The next run's countdown: the one row that ticks every second. */
function LiveCountdown({ start }: { start: string }) {
	const now = useNow(1000);
	return <>{countdown(start, now)}</>;
}

function UpcomingRow({
	event,
	first,
	now,
	snapshot,
}: {
	event: InterfaceEvent;
	first: boolean;
	now: number;
	snapshot: InterfaceSnapshot;
}) {
	const repeat = event.count && event.count > 1 ? `×${event.count}/day` : null;
	const ticking = first && countdownTicks(event.start, now);
	return (
		<li
			className={RUN_ROW}
			data-event-id={event.id}
			data-next={first ? "true" : undefined}
			data-row="item"
		>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span
					className={cn(
						"text-[13px] tabular-nums leading-5",
						first ? "font-medium text-foreground" : "text-muted-foreground"
					)}
				>
					{ticking ? (
						<LiveCountdown start={event.start} />
					) : (
						countdown(event.start, now)
					)}
				</span>
				<span className={cn("truncate leading-4", TIME_TEXT)}>
					{runWhen(event.start, now)}
				</span>
			</span>
			<RunText
				detail={[
					event.label || "One-off run",
					repeat,
					ownerName(event.agentId, snapshot),
				]
					.filter(Boolean)
					.join(" · ")}
				title={runTitle(event)}
			/>
		</li>
	);
}

function RecentRow({
	event,
	now,
	snapshot,
}: {
	event: InterfaceEvent;
	now: number;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const failed = event.outcome === "failure";
	const at = event.end ?? event.start;
	const age = compactAge(at, now);
	return (
		<li
			className={RUN_ROW}
			data-event-id={event.id}
			data-outcome={event.outcome}
			data-row="item"
		>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span
					className={cn(
						"flex items-center gap-2 text-[13px] leading-5",
						failed ? "text-status-destructive" : "text-foreground"
					)}
				>
					<Lamp state={failed ? "failure" : "success"} />
					{failed ? "Failed" : "Succeeded"}
				</span>
				<span className={cn("truncate leading-4", TIME_TEXT)}>
					{age === "now" ? "just now" : tl("{age} ago", { age })}
				</span>
			</span>
			<RunText
				detail={[
					event.label || "Scheduled run",
					ownerName(event.agentId, snapshot),
				].join(" · ")}
				title={runTitle(event)}
			/>
		</li>
	);
}

function RunsEmpty({ children }: { children: ReactNode }) {
	return (
		<div className="m-auto flex flex-col items-center gap-1 px-6 py-8 text-center">
			<p className="font-medium text-[13px] text-foreground">
				Nothing scheduled
			</p>
			<p className="text-muted-foreground text-xs">{children}</p>
		</div>
	);
}

type RunsTab = "recent" | "upcoming";
const RUNS_TABS: readonly RunsTab[] = ["upcoming", "recent"];

/**
 * Grafana-style panel tabs in the title strip: a roving-tabindex tablist that
 * follows the arrow keys.
 */
function RunsTabs({
	counts,
	idFor,
	onSelect,
	selected,
}: {
	counts: Record<RunsTab, number>;
	idFor: (tab: RunsTab, part: "panel" | "tab") => string;
	onSelect: (tab: RunsTab) => void;
	selected: RunsTab;
}) {
	const focusTab = (tab: RunsTab) => {
		onSelect(tab);
		document.getElementById(idFor(tab, "tab"))?.focus();
	};
	return (
		<span
			aria-label="Scheduled runs"
			className="-mr-1.5 flex items-center"
			role="tablist"
		>
			{RUNS_TABS.map((tab) => {
				const active = tab === selected;
				return (
					<button
						aria-controls={idFor(tab, "panel")}
						aria-selected={active}
						className={cn(
							"flex h-6 items-center gap-1.5 rounded-md px-1.5 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
							active
								? "bg-muted text-foreground"
								: "text-muted-foreground hover:text-foreground"
						)}
						id={idFor(tab, "tab")}
						key={tab}
						onClick={() => onSelect(tab)}
						onKeyDown={(event) => {
							if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
								event.preventDefault();
								focusTab(tab === "upcoming" ? "recent" : "upcoming");
							}
						}}
						role="tab"
						tabIndex={active ? 0 : -1}
						type="button"
					>
						{tab === "upcoming" ? "Upcoming" : "Recent"}
						<span className="text-muted-foreground tabular-nums">
							{counts[tab]}
						</span>
					</button>
				);
			})}
		</span>
	);
}

/**
 * Scheduled runs: what is coming up, soonest first with a T-minus, and in a
 * second tab, how the most recent runs finished.
 */
export function UpcomingPanel({
	events,
	now,
	recent = [],
	snapshot,
}: {
	events: InterfaceEvent[];
	now: number;
	recent?: InterfaceEvent[];
	snapshot: InterfaceSnapshot;
}) {
	const groupId = useId();
	const [tab, setTab] = useState<RunsTab>("upcoming");
	const idFor = useCallback(
		(which: RunsTab, part: "panel" | "tab") => `${groupId}-${which}-${part}`,
		[groupId]
	);
	if (events.length === 0 && recent.length === 0) {
		return (
			<MissionPanel title="Scheduled runs" titleId="mission-upcoming-title">
				<RunsEmpty>Routines you set up appear here.</RunsEmpty>
			</MissionPanel>
		);
	}
	return (
		<MissionPanel
			actions={
				<RunsTabs
					counts={{ recent: recent.length, upcoming: events.length }}
					idFor={idFor}
					onSelect={setTab}
					selected={tab}
				/>
			}
			title="Scheduled runs"
			titleId="mission-upcoming-title"
		>
			<WholeRowList
				className="pt-1"
				contentKey={`${tab}:${events.length}:${recent.length}`}
			>
				<div
					aria-labelledby={idFor("upcoming", "tab")}
					hidden={tab !== "upcoming"}
					id={idFor("upcoming", "panel")}
					role="tabpanel"
				>
					{events.length > 0 ? (
						<ol aria-label="Next up" className="flex flex-col">
							{events.map((event, index) => (
								<UpcomingRow
									event={event}
									first={index === 0}
									key={event.id}
									now={now}
									snapshot={snapshot}
								/>
							))}
						</ol>
					) : (
						<p className="px-2 py-2 text-muted-foreground text-xs">
							Nothing scheduled. Routines you set up appear here.
						</p>
					)}
				</div>
				<div
					aria-labelledby={idFor("recent", "tab")}
					hidden={tab !== "recent"}
					id={idFor("recent", "panel")}
					role="tabpanel"
				>
					{recent.length > 0 ? (
						<ol aria-label="Recent runs" className="flex flex-col">
							{recent.map((event) => (
								<RecentRow
									event={event}
									key={event.id}
									now={now}
									snapshot={snapshot}
								/>
							))}
						</ol>
					) : (
						<p className="px-2 py-2 text-muted-foreground text-xs">
							No runs have finished yet.
						</p>
					)}
				</div>
			</WholeRowList>
		</MissionPanel>
	);
}
