import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import {
	type HologramView,
	type HoloThread,
	PANEL_ROW_LIMIT,
} from "./hologram-model.ts";
import {
	EventRow,
	HoloPanel,
	HUD_INTERACTIVE,
	HUD_LABEL,
	PanelEmpty,
	PanelSubhead,
	Readout,
	StatusMark,
	ThreadRow,
} from "./hologram-parts.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";

interface ListProps {
	activeThreadId: string | null;
	now: number;
	onOpen: (threadId: string) => void;
}

function ThreadList({
	activeThreadId,
	empty,
	items,
	now,
	onOpen,
	variant,
}: ListProps & {
	empty: string;
	items: HoloThread[];
	variant?: "live" | "status";
}) {
	const tl = useLiteralMessages();
	if (items.length === 0) {
		return <PanelEmpty>{empty}</PanelEmpty>;
	}
	const shown = items.slice(0, PANEL_ROW_LIMIT);
	const more = items.length - shown.length;
	return (
		<>
			<ul className="flex flex-col">
				{shown.map((item) => (
					<ThreadRow
						active={item.id === activeThreadId}
						item={item}
						key={item.id}
						now={now}
						onOpen={onOpen}
						variant={variant}
					/>
				))}
			</ul>
			{more > 0 ? (
				<PanelEmpty>{tl("+{more} more", { more })}</PanelEmpty>
			) : null}
		</>
	);
}

/** Threads that need the user: failed runs first, then replies to read. */
export function PriorityPanel({
	className,
	items,
	...list
}: ListProps & { className?: string; items: HoloThread[] }) {
	return (
		<HoloPanel
			className={className}
			count={items.length}
			id="priority"
			label="Priority"
		>
			<ThreadList
				{...list}
				empty="Nothing needs you right now."
				items={items}
			/>
		</HoloPanel>
	);
}

/** One agent's threads, opened from the radial menu's "Show threads". */
export function AgentThreadsPanel({
	agentName,
	className,
	items,
	onClose,
	...list
}: ListProps & {
	agentName: string;
	className?: string;
	items: HoloThread[];
	onClose: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<HoloPanel
			action={
				<button
					aria-label={tl("Close {agentName}'s threads", { agentName })}
					className={cn(
						"-mr-1.5 flex size-6 items-center justify-center rounded-sm text-(--holo-dim) hover:text-(--holo-text)",
						HUD_INTERACTIVE
					)}
					onClick={onClose}
					type="button"
				>
					<X aria-hidden="true" className="size-3.5" />
				</button>
			}
			className={className}
			count={items.length}
			id="agent-threads"
			label={tl("{agentName} · Threads", { agentName })}
		>
			<ThreadList
				{...list}
				empty={tl("{agentName} has no threads yet.", { agentName })}
				items={items}
			/>
		</HoloPanel>
	);
}

/** Live runs, each with its newest line. */
export function OperationsPanel({
	className,
	items,
	...list
}: ListProps & { className?: string; items: HoloThread[] }) {
	return (
		<HoloPanel
			className={className}
			count={items.length}
			id="operations"
			label="Active operations"
		>
			<ThreadList
				{...list}
				empty="No runs in progress."
				items={items}
				variant="live"
			/>
		</HoloPanel>
	);
}

/** Runs that already happened, kept short under the upcoming ones. */
const RECENT_LIMIT = 4;

/** Upcoming scheduled runs from the host's routines, then the latest results. */
export function SchedulePanel({
	className,
	now,
	snapshot,
	view,
}: {
	className?: string;
	now: number;
	snapshot: InterfaceSnapshot;
	view: HologramView;
}) {
	const upcoming = view.schedule.slice(0, PANEL_ROW_LIMIT);
	const recent = view.recent.slice(0, RECENT_LIMIT);
	const nameOf = (agentId: string | null) =>
		agentById(snapshot, agentId)?.name ?? null;
	return (
		<HoloPanel
			className={className}
			count={view.schedule.length}
			id="schedule"
			label="Schedule"
		>
			{upcoming.length === 0 && recent.length === 0 ? (
				<PanelEmpty>No scheduled runs.</PanelEmpty>
			) : (
				<>
					<PanelSubhead>Next</PanelSubhead>
					{upcoming.length === 0 ? (
						<PanelEmpty>Nothing scheduled.</PanelEmpty>
					) : (
						<ul aria-label="Upcoming runs" className="flex flex-col">
							{upcoming.map((event) => (
								<EventRow
									agentName={nameOf(event.agentId)}
									event={event}
									key={event.id}
									now={now}
								/>
							))}
						</ul>
					)}
					{recent.length > 0 ? (
						<>
							<PanelSubhead>Recent</PanelSubhead>
							<ul aria-label="Recent runs" className="flex flex-col">
								{recent.map((event) => (
									<EventRow
										agentName={nameOf(event.agentId)}
										event={event}
										key={event.id}
										now={now}
									/>
								))}
							</ul>
						</>
					) : null}
				</>
			)}
		</HoloPanel>
	);
}

const SEGMENT_TONE: Record<ThreadStatus, string> = {
	attention: "bg-(--holo-alert)",
	quiet: "bg-(--holo-faint)/50",
	waiting: "bg-(--holo-dim)/70",
	working: "bg-(--holo-ink)",
	"your-turn": "bg-(--holo-turn)",
};

/**
 * Totals, then every thread split by status: a bar and a legend that also
 * decodes the status ring around the core.
 */
export function SystemPanel({
	className,
	now,
	view,
}: {
	className?: string;
	now: number;
	view: HologramView;
}) {
	const tl = useLiteralMessages();
	const { totals } = view;
	const total = Math.max(1, totals.threads);
	const age = view.lastUpdate
		? compactAge(new Date(view.lastUpdate).toISOString(), now)
		: "";
	return (
		<HoloPanel className={className} id="system" label="System">
			<div className="@container/sys">
				<div className="flex @min-[480px]/sys:grid @min-[480px]/sys:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] @min-[480px]/sys:grid-rows-[auto_1fr] flex-col gap-4 @min-[480px]/sys:gap-x-8 px-4 pt-2 pb-3">
					<dl className="@min-[480px]/sys:col-start-1 @min-[480px]/sys:row-start-1 grid grid-cols-3 gap-x-3">
						<Readout label="Agents" value={totals.agents} />
						<Readout label="Working" tone="ink" value={totals.workingAgents} />
						<Readout label="Runs 24h" value={totals.upcoming24h} />
					</dl>
					<div className="@min-[480px]/sys:col-start-2 @min-[480px]/sys:row-span-2 @min-[480px]/sys:row-start-1 flex flex-col gap-2">
						<p
							className={cn(
								HUD_LABEL,
								"flex justify-between text-(--holo-dim)"
							)}
						>
							<span>Threads</span>
							<span className="text-(--holo-text) tabular-nums">
								{String(totals.threads).padStart(2, "0")}
							</span>
						</p>
						<div
							aria-hidden="true"
							className="flex h-1 w-full gap-px bg-(--holo-line)/40"
						>
							{view.distribution.map((entry) =>
								entry.count > 0 ? (
									<span
										className={SEGMENT_TONE[entry.status]}
										key={entry.status}
										style={{ flexGrow: entry.count / total }}
									/>
								) : null
							)}
						</div>
						<dl
							aria-label="Threads by status"
							className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1"
						>
							{view.distribution.map((entry) => (
								<div className="flex h-5 items-center gap-2" key={entry.status}>
									<StatusMark status={entry.status} />
									<dt className="min-w-0 flex-1 truncate text-(--holo-dim) text-[13px]">
										{THREAD_STATUS_LABELS[entry.status]}
									</dt>
									<dd
										className={cn(
											"font-mono text-[12px] tabular-nums",
											entry.count === 0
												? "text-(--holo-dim)"
												: "text-(--holo-text)"
										)}
									>
										{String(entry.count).padStart(2, "0")}
									</dd>
								</div>
							))}
						</dl>
					</div>
					<p
						className={cn(
							HUD_LABEL,
							"@min-[480px]/sys:col-start-1 @min-[480px]/sys:row-start-2 flex justify-between @min-[480px]/sys:self-end text-(--holo-dim)"
						)}
					>
						<span>Last signal</span>
						<span className="tabular-nums">
							{age
								? age === "now"
									? "Just now"
									: tl("{age} ago", { age })
								: "None"}
						</span>
					</p>
				</div>
			</div>
		</HoloPanel>
	);
}
