import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceEvent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useId,
	useRef,
	useState,
} from "react";
import { agentById, compactAge } from "./interface-renderer.ts";
import { MORE_ROW_PX, useNow, useWholeRows } from "./mission-control-hooks.ts";
import {
	countdown,
	countdownTicks,
	type MissionAlert,
	runWhen,
} from "./mission-control-model.ts";
import { Lamp, MissionPanel, SUBTLE_LABEL } from "./mission-control-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * On a wide wall a list fills the height its row was given by the station
 * board and scrolls inside it, sized to whole rows over a "more" row.
 */
const WALL_FRAME =
	"flex min-h-0 flex-1 flex-col @min-[860px]/wall:absolute @min-[860px]/wall:inset-0";

/** Ages and times: one treatment across the wall. */
export const TIME_TEXT = "text-muted-foreground text-xs tabular-nums";

/**
 * A list that never cuts a row: it stops at the last whole row that fits and
 * offers the rest through a "more" row that pages it, then returns to the top.
 */
function WholeRowList({
	children,
	className,
	contentKey,
	listRef,
}: {
	children: ReactNode;
	className?: string;
	contentKey: string;
	listRef?: RefObject<HTMLDivElement | null>;
}) {
	const reduceMotion = useReducedMotion();
	const [frameRef, measureRef, rows] = useWholeRows(contentKey);
	const ownRef = useRef<HTMLDivElement | null>(null);
	const setList = useCallback(
		(node: HTMLDivElement | null) => {
			measureRef(node);
			ownRef.current = node;
			if (listRef) {
				listRef.current = node;
			}
		},
		[measureRef, listRef]
	);
	const page = () => {
		const list = ownRef.current;
		if (!list) {
			return;
		}
		const behavior = reduceMotion ? "auto" : "smooth";
		if (rows.hiddenBelow === 0) {
			list.scrollTo({ behavior, top: 0 });
			return;
		}
		const visibleTo = list.scrollTop + list.clientHeight;
		const next = [...list.querySelectorAll<HTMLElement>("[data-row]")].find(
			(mark) => mark.offsetTop + mark.offsetHeight > visibleTo + 1
		);
		list.scrollTo({ behavior, top: next?.offsetTop ?? list.scrollHeight });
	};
	const clipped = rows.height !== null;
	return (
		<div className={WALL_FRAME} ref={frameRef}>
			<div
				className={cn(
					"relative min-h-0 overflow-y-auto overscroll-contain px-1 [scrollbar-width:thin]",
					className
				)}
				ref={setList}
				style={clipped ? { height: rows.height ?? undefined } : undefined}
			>
				{children}
			</div>
			{clipped ? (
				<button
					className="mx-1 flex shrink-0 items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					onClick={page}
					style={{ height: MORE_ROW_PX }}
					type="button"
				>
					<ChevronDown
						aria-hidden="true"
						className={cn("size-3.5", rows.hiddenBelow === 0 && "rotate-180")}
					/>
					{rows.hiddenBelow === 0 ? "Back to top" : `${rows.hiddenBelow} more`}
				</button>
			) : null}
		</div>
	);
}

/**
 * Lamp, the alert text, then its age. On a panel wide enough the title and
 * its detail share one line, Grafana alert-list style; on a narrow one the
 * detail drops below the title. The row action sits over the age and swaps in
 * on hover or focus, so ages stay flush with the panel's right edge.
 */
const ALERT_ROW =
	"grid w-full min-w-0 grid-cols-[0.625rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-2 py-1.5 text-left";

/**
 * The age gives way to the row action at once: no crossfade, so a focus ring
 * never circles half-faded text. Opacity (not visibility) keeps the action
 * reachable by keyboard.
 */
const ROW_AGE =
	"group-focus-within/alert:opacity-0 group-hover/alert:opacity-0";
const ROW_ACTION =
	"opacity-0 focus-visible:opacity-100 group-focus-within/alert:opacity-100 group-hover/alert:opacity-100";

function ageText(iso: string, now: number): string {
	return compactAge(iso, now) || "—";
}

/** A hairline sub-header inside a panel: label, count, rule. */
function SubHeader({
	count,
	id,
	label,
}: {
	count?: number;
	id: string;
	label: string;
}) {
	return (
		<h3
			className={cn("flex items-center gap-2 px-2 pt-3 pb-1", SUBTLE_LABEL)}
			data-row="header"
			id={id}
		>
			<span>{label}</span>
			{count === undefined ? null : (
				<span className="text-foreground tabular-nums">{count}</span>
			)}
			<span aria-hidden="true" className="h-px flex-1 bg-border" />
		</h3>
	);
}

/** "Scheduled run failed · Every Monday" → the outcome, then the context. */
function splitDetail(detail: string): [string, string | null] {
	const at = detail.indexOf(" · ");
	return at === -1
		? [detail, null]
		: [detail.slice(0, at), detail.slice(at + 3)];
}

function AlertBody({
	action,
	alert,
	agentName,
	now,
}: {
	action: ReactNode;
	agentName: string | null;
	alert: MissionAlert;
	now: number;
}) {
	const warning = alert.severity === "warning";
	let detail: ReactNode;
	if (warning) {
		const [outcome, context] = splitDetail(alert.detail);
		const rest = [context, agentName].filter(Boolean).join(" · ");
		detail = (
			<>
				<span className="text-status-destructive">{outcome}</span>
				{rest ? ` · ${rest}` : ""}
			</>
		);
	} else {
		// Waiting on you: who, then the last thing they said.
		detail = [agentName, alert.detail].filter(Boolean).join(" · ");
	}
	return (
		<>
			<span className="flex h-5 items-center justify-center">
				<Lamp state={warning ? "failure" : "your-turn"} />
			</span>
			<span className="flex min-w-0 @min-[420px]/alerts:flex-row flex-col @min-[420px]/alerts:items-baseline @min-[420px]/alerts:gap-3 gap-0.5">
				<span className="@min-[420px]/alerts:max-w-[55%] shrink-0 truncate font-medium text-[13px] text-foreground leading-5">
					{alert.title}
				</span>
				<span className="min-w-0 truncate text-muted-foreground text-xs leading-4">
					{detail}
				</span>
			</span>
			<span className="relative flex h-5 items-center justify-end">
				<span className={cn(TIME_TEXT, action ? ROW_AGE : undefined)}>
					{ageText(alert.at, now)}
				</span>
				{action ? (
					<span className="absolute inset-y-0 right-0 flex items-center">
						{action}
					</span>
				) : null}
			</span>
		</>
	);
}

function AlertRow({
	activeThreadId,
	alert,
	flash,
	now,
	onMessage,
	onOpen,
	snapshot,
}: {
	activeThreadId: string | null;
	alert: MissionAlert;
	flash: boolean;
	now: number;
	onMessage: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const agent = agentById(snapshot, alert.agentId);
	const threadId = alert.threadId;
	let action: ReactNode = null;
	if (threadId) {
		action = (
			<span
				aria-hidden="true"
				className={cn(
					"flex size-5 items-center justify-center text-muted-foreground",
					ROW_ACTION
				)}
			>
				<ChevronRight className="size-3.5" />
			</span>
		);
	} else if (agent) {
		action = (
			<Button
				aria-label={`Follow up with ${agent.name} on ${alert.title}`}
				className={cn("text-muted-foreground", ROW_ACTION)}
				onClick={() => onMessage(agent.id)}
				size="icon-xs"
				title={`New thread with ${agent.name}`}
				type="button"
				variant="ghost"
			>
				<MessageSquarePlus aria-hidden="true" />
			</Button>
		);
	}
	const body = (
		<AlertBody
			action={action}
			agentName={agent?.name ?? null}
			alert={alert}
			now={now}
		/>
	);
	return (
		<li
			className={cn(
				"group/alert min-w-0 rounded-md",
				flash && "bg-muted ring-2 ring-ring ring-inset"
			)}
			data-alert={alert.id}
			data-flash={flash ? "true" : undefined}
			data-row="item"
			data-severity={alert.severity}
		>
			{threadId ? (
				<button
					aria-current={threadId === activeThreadId ? "true" : undefined}
					aria-label={`Open ${alert.title}: ${alert.detail}`}
					className={cn(
						ALERT_ROW,
						"outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=true]:bg-muted"
					)}
					onClick={() => onOpen(threadId)}
					type="button"
				>
					{body}
				</button>
			) : (
				<div className={cn(ALERT_ROW, "transition-colors hover:bg-muted")}>
					{body}
				</div>
			)}
		</li>
	);
}

/**
 * Failures first (failed or interrupted threads and failed scheduled runs),
 * then everything waiting on you. The list scrolls in place with a fade when
 * it outgrows the panel. Threads open in place; a failed run offers a fresh
 * thread with its agent. `flash` marks the first failure after the banner's
 * "Review alerts" jumps here, until focus moves on.
 */
export function AlertsPanel({
	activeThreadId,
	alerts,
	flash = false,
	listRef,
	now,
	onMessage,
	onOpen,
	snapshot,
}: {
	activeThreadId: string | null;
	alerts: MissionAlert[];
	flash?: boolean;
	listRef: RefObject<HTMLDivElement | null>;
	now: number;
	onMessage: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const groupId = useId();
	const warnings = alerts.filter((alert) => alert.severity === "warning");
	const advisories = alerts.filter((alert) => alert.severity === "advisory");
	const failuresId = `${groupId}-failures`;
	const advisoriesId = `${groupId}-advisories`;
	const row = (alert: MissionAlert, index: number) => (
		<AlertRow
			activeThreadId={activeThreadId}
			alert={alert}
			flash={flash && alert.severity === "warning" && index === 0}
			key={alert.id}
			now={now}
			onMessage={onMessage}
			onOpen={onOpen}
			snapshot={snapshot}
		/>
	);
	return (
		<MissionPanel title="Alerts" titleId="mission-alerts-title">
			{alerts.length === 0 ? (
				<div className="m-auto flex flex-col items-center gap-1 px-6 py-8 text-center">
					<p className="font-medium text-[13px] text-foreground">No alerts</p>
					<p className="text-muted-foreground text-xs">
						No failed runs or replies waiting.
					</p>
				</div>
			) : (
				<WholeRowList
					className="@container/alerts"
					contentKey={alerts.map((alert) => alert.id).join("|")}
					listRef={listRef}
				>
					{warnings.length > 0 ? (
						<section aria-labelledby={failuresId}>
							<SubHeader
								count={warnings.length}
								id={failuresId}
								label="Failures"
							/>
							<ul className="flex flex-col">{warnings.map(row)}</ul>
						</section>
					) : null}
					{advisories.length > 0 ? (
						<section aria-labelledby={advisoriesId}>
							<SubHeader
								count={advisories.length}
								id={advisoriesId}
								label="Waiting on you"
							/>
							<ul className="flex flex-col">{advisories.map(row)}</ul>
						</section>
					) : null}
				</WholeRowList>
			)}
		</MissionPanel>
	);
}

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
					{age === "now" ? "just now" : `${age} ago`}
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
