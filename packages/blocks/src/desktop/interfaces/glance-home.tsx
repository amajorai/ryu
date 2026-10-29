import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { type ReactNode, useMemo, useState } from "react";
import {
	buildGlanceAgents,
	GLANCE_AGENT_STATE_LABELS,
	GLANCE_NEEDS_YOU_LABEL,
	type GlanceDistance,
	glanceClock,
	glanceListWindow,
	glanceRunWhen,
	glanceThreadTitle,
	glanceUpcoming,
	glanceWaitingOnAgent,
	glanceWaitingOnYou,
	glanceWorking,
} from "./glance-model.ts";
import {
	GLANCE_INK_SECONDARY,
	GlanceAvatar,
	GlanceMark,
	glanceThreadState,
} from "./glance-parts.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";

/** Apple's widget families on a four-column grid: 1x1, 2x1, 2x2. */
type WidgetSize = "large" | "medium" | "small";

const SPAN: Record<WidgetSize, string> = {
	large: "col-span-2 row-span-2",
	medium: "col-span-2",
	small: "col-span-1",
};

/** Widget type, in display-relative units with legible floors. */
const W = {
	big: "text-[clamp(1.75rem,7.6cqw,3.5rem)] leading-none tracking-[-0.03em]",
	label: "text-[clamp(0.8125rem,2.5cqw,1.125rem)] leading-tight",
	row: "text-[clamp(0.8125rem,2.4cqw,1.0625rem)] leading-snug",
	sub: "text-[clamp(0.75rem,2.1cqw,0.9375rem)] leading-snug",
} as const;

const ROW_BUTTON =
	"-mx-[1.6cqw] flex w-[calc(100%+3.2cqw)] min-w-0 rounded-[1.8cqw] px-[1.6cqw] text-left outline-none transition-colors corner-squircle hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.08]";

function Widget({
	accessory,
	children,
	className,
	label,
	size,
	title,
}: {
	/** Top-right count, set on the title's baseline. */
	accessory?: ReactNode;
	children: ReactNode;
	className?: string;
	label: string;
	size: WidgetSize;
	title?: string;
}) {
	return (
		<section
			aria-label={label}
			className={cn(
				"corner-squircle flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[4.4cqw] bg-muted p-[3.4cqw]",
				"@max-[32rem]:gap-3 gap-[1.6cqw] @max-[32rem]:rounded-3xl @max-[32rem]:p-4",
				size === "small" && "@max-[32rem]:min-h-36",
				SPAN[size],
				className
			)}
			data-widget={label}
			data-widget-size={size}
		>
			{title ? (
				<header className="flex items-baseline justify-between gap-[2cqw]">
					<h3 className={cn("font-semibold text-foreground", W.label)}>
						{title}
					</h3>
					{accessory}
				</header>
			) : null}
			{children}
		</section>
	);
}

function Quiet({ children }: { children: ReactNode }) {
	return <p className={cn(GLANCE_INK_SECONDARY, W.row)}>{children}</p>;
}

function names(snapshot: InterfaceSnapshot, thread: InterfaceThread): string {
	const list = thread.agentIds
		.map((id) => agentById(snapshot, id)?.name)
		.filter((name): name is string => Boolean(name));
	return list.length > 0 ? list.join(", ") : "No agent";
}

/** A header count: the title's size, quiet ink, aligned figures. */
function HeaderCount({ children }: { children: ReactNode }) {
	return (
		<span
			className={cn(
				"shrink-0 font-medium tabular-nums",
				GLANCE_INK_SECONDARY,
				W.label
			)}
		>
			{children}
		</span>
	);
}

export interface GlanceHomeProps {
	distance: GlanceDistance;
	loading: boolean;
	now: number;
	onOpenThread: (threadId: string) => void;
	onStartWithAgent: (agentId: string) => void;
	snapshot: InterfaceSnapshot;
}

/**
 * Rows the "Needs you" widget holds before folding the rest into "N more":
 * one-line rows fill a large widget at six, two-line Near rows at four.
 */
const NEEDS_YOU_CAPACITY: Record<GlanceDistance, number> = {
	far: 6,
	near: 4,
};

function NeedsYouWidget({
	distance,
	now,
	onOpenThread,
	snapshot,
}: GlanceHomeProps) {
	const waiting = useMemo(() => glanceWaitingOnYou(snapshot), [snapshot]);
	const [expanded, setExpanded] = useState(false);
	const near = distance === "near";
	const list = glanceListWindow(waiting.length, NEEDS_YOU_CAPACITY[distance]);
	const shown = expanded ? waiting : waiting.slice(0, list.shown);
	return (
		<Widget
			accessory={<HeaderCount>{waiting.length}</HeaderCount>}
			label={GLANCE_NEEDS_YOU_LABEL}
			size="large"
			title={GLANCE_NEEDS_YOU_LABEL}
		>
			{shown.length === 0 ? (
				<Quiet>Nothing needs you.</Quiet>
			) : (
				<ul
					className={cn(
						"flex flex-col",
						expanded &&
							"-mx-[1.6cqw] min-h-0 flex-1 overflow-y-auto px-[1.6cqw] [scrollbar-width:none]"
					)}
				>
					{shown.map((thread) => {
						const state = glanceThreadState(thread);
						return (
							<li key={thread.id}>
								<button
									aria-label={`Open ${glanceThreadTitle(thread)}, ${GLANCE_AGENT_STATE_LABELS[state]}`}
									className={cn(
										ROW_BUTTON,
										"grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-[1.6cqw] py-[1cqw]"
									)}
									onClick={() => onOpenThread(thread.id)}
									type="button"
								>
									<GlanceMark className="-translate-y-[0.15em]" state={state} />
									<span className="flex min-w-0 flex-col">
										<span
											className={cn(
												"truncate font-medium text-foreground",
												W.row
											)}
										>
											{glanceThreadTitle(thread)}
										</span>
										{near ? (
											<span
												className={cn("truncate", GLANCE_INK_SECONDARY, W.sub)}
											>
												{names(snapshot, thread)}
												{thread.lastMessage ? ` · ${thread.lastMessage}` : ""}
											</span>
										) : null}
									</span>
									<span
										className={cn("tabular-nums", GLANCE_INK_SECONDARY, W.sub)}
									>
										{compactAge(thread.updatedAt, now)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
			{list.hidden > 0 ? (
				<button
					aria-expanded={expanded}
					className={cn(
						ROW_BUTTON,
						"mt-auto shrink-0 py-[1cqw] font-medium",
						GLANCE_INK_SECONDARY,
						W.sub
					)}
					onClick={() => setExpanded((open) => !open)}
					type="button"
				>
					{expanded ? "Show fewer" : `${list.hidden} more`}
				</button>
			) : null}
		</Widget>
	);
}

function WorkingWidget({ distance, onOpenThread, snapshot }: GlanceHomeProps) {
	const working = useMemo(() => glanceWorking(snapshot), [snapshot]);
	const near = distance === "near";
	// A medium widget holds two single-line rows, or one row with its latest line.
	const shown = working.slice(0, near ? 1 : 2);
	return (
		<Widget
			accessory={<HeaderCount>{working.length}</HeaderCount>}
			label="Working"
			size="medium"
			title="Working"
		>
			{shown.length === 0 ? (
				<Quiet>No agent is working.</Quiet>
			) : (
				<ul className="flex flex-col gap-[0.4cqw]">
					{shown.map((thread) => {
						const lead = agentById(snapshot, thread.agentIds[0]);
						return (
							<li key={thread.id}>
								<button
									aria-label={`Open ${glanceThreadTitle(thread)}`}
									className={cn(
										ROW_BUTTON,
										"gap-[1.6cqw] py-[1cqw]",
										near ? "items-start" : "items-center"
									)}
									onClick={() => onOpenThread(thread.id)}
									type="button"
								>
									{lead ? (
										<GlanceAvatar
											agent={lead}
											className="size-[clamp(1.25rem,3.4cqw,1.75rem)]"
										/>
									) : null}
									<span className="flex min-w-0 flex-1 flex-col">
										<span
											className={cn(
												"truncate font-medium text-foreground",
												W.row
											)}
										>
											{glanceThreadTitle(thread)}
										</span>
										{near ? (
											<span
												className={cn(
													"line-clamp-2",
													GLANCE_INK_SECONDARY,
													W.sub
												)}
											>
												{lead?.name ?? names(snapshot, thread)}
												{thread.lastMessage ? ` · ${thread.lastMessage}` : ""}
											</span>
										) : null}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</Widget>
	);
}

/**
 * The small widgets' figure size, in units of the figure's own width: four
 * characters ("9:41") take a larger cut than five ("12:58"), and both fit
 * with room. The clock and the count beside it share one size.
 */
export function glanceClockWidgetType(time: string): string {
	return time.length > 4 ? "text-[min(36cqi,1em)]" : "text-[min(44cqi,1em)]";
}

/**
 * Apple's small widget: a one-line title, one secondary line, and a single
 * figure set at the foot, so every small widget has the same shape.
 */
function SmallFace({
	figure,
	figureType,
	subtitle,
	title,
}: {
	figure: ReactNode;
	figureType: string;
	subtitle: ReactNode;
	title: string;
}) {
	return (
		<>
			<span className="flex min-w-0 flex-col">
				<span className={cn("truncate font-semibold text-foreground", W.label)}>
					{title}
				</span>
				<span className={cn("truncate", GLANCE_INK_SECONDARY, W.sub)}>
					{subtitle}
				</span>
			</span>
			{/* The figure sizes to the widget's own width, so "12:58" never clips. */}
			<span
				className={cn(
					"mt-auto block w-full pt-3 [container-type:inline-size]",
					W.big
				)}
			>
				<span
					className={cn(
						"block whitespace-nowrap font-semibold text-foreground tabular-nums leading-none tracking-[-0.03em]",
						figureType
					)}
				>
					{figure}
				</span>
			</span>
		</>
	);
}

function ClockWidget({ now }: { now: number }) {
	const date = new Date(now);
	const clock = glanceClock(date);
	const day = new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "short",
		weekday: "short",
	}).format(date);
	return (
		<Widget label="Clock" size="small">
			<time
				className="flex min-w-0 flex-1 flex-col"
				data-clock-time
				dateTime={date.toISOString()}
			>
				<SmallFace
					figure={
						<>
							{clock.time}
							{clock.period ? (
								<span className="sr-only"> {clock.period}</span>
							) : null}
						</>
					}
					figureType={glanceClockWidgetType(clock.time)}
					subtitle={day}
					title="Today"
				/>
			</time>
		</Widget>
	);
}

function WaitingWidget({
	distance,
	now,
	onOpenThread,
	snapshot,
}: GlanceHomeProps) {
	const waiting = useMemo(() => glanceWaitingOnAgent(snapshot), [snapshot]);
	const first = waiting[0];
	const near = distance === "near";
	let subtitle = "No threads";
	if (first) {
		subtitle =
			near || waiting.length === 1
				? glanceThreadTitle(first)
				: `${waiting.length} threads`;
	}
	const face = (
		<SmallFace
			figure={waiting.length}
			figureType={glanceClockWidgetType(glanceClock(new Date(now)).time)}
			subtitle={subtitle}
			title="Waiting"
		/>
	);
	return (
		<Widget label="Waiting on agents" size="small">
			{first ? (
				<button
					aria-label={`${waiting.length} waiting on agents. Open ${glanceThreadTitle(first)}`}
					className="-m-[3.4cqw] @max-[32rem]:-m-4 flex @max-[32rem]:w-[calc(100%+2rem)] w-[calc(100%+6.8cqw)] min-w-0 flex-1 flex-col @max-[32rem]:p-4 p-[3.4cqw] text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					onClick={() => onOpenThread(first.id)}
					title="Threads where you wrote last and the agent has not replied"
					type="button"
				>
					{face}
				</button>
			) : (
				<div className="flex min-w-0 flex-1 flex-col">{face}</div>
			)}
		</Widget>
	);
}

function UpcomingWidget({ distance, now, snapshot }: GlanceHomeProps) {
	const upcoming = useMemo(
		() => glanceUpcoming(snapshot, now),
		[snapshot, now]
	);
	const near = distance === "near";
	const shown = upcoming.slice(0, 4);
	return (
		<Widget label="Upcoming runs" size="large" title="Upcoming runs">
			{shown.length === 0 ? (
				<Quiet>No scheduled runs.</Quiet>
			) : (
				<ol className="flex flex-col gap-[0.4cqw]">
					{shown.map((event) => {
						const agent = agentById(snapshot, event.agentId);
						const who = agent?.name ?? "Workflow";
						return (
							<li className="flex min-w-0 flex-col py-[1cqw]" key={event.id}>
								<span
									className={cn("truncate font-medium text-foreground", W.row)}
								>
									{event.title}
								</span>
								<span
									className={cn(
										"truncate tabular-nums",
										GLANCE_INK_SECONDARY,
										W.sub
									)}
								>
									{glanceRunWhen(event.start, now)}
									{" · "}
									{near && event.label ? `${who}, ${event.label}` : who}
								</span>
							</li>
						);
					})}
				</ol>
			)}
		</Widget>
	);
}

function AgentsWidget({
	onOpenThread,
	onStartWithAgent,
	snapshot,
}: GlanceHomeProps) {
	const tiles = useMemo(() => buildGlanceAgents(snapshot), [snapshot]);
	const working = tiles.filter((tile) => tile.state === "working").length;
	const shown = tiles.slice(0, 6);
	return (
		<Widget
			accessory={
				<HeaderCount>
					{working} of {tiles.length} working
				</HeaderCount>
			}
			label="Agents"
			size="large"
			title="Agents"
		>
			{shown.length === 0 ? (
				<Quiet>No agents yet.</Quiet>
			) : (
				<ul className="grid grid-cols-3 gap-x-[1.6cqw] gap-y-[2.4cqw]">
					{shown.map((tile) => (
						<li className="min-w-0" key={tile.agent.id}>
							<button
								aria-label={`${tile.agent.name}, ${GLANCE_AGENT_STATE_LABELS[tile.state]}`}
								className="corner-squircle flex w-full min-w-0 flex-col items-center gap-[1cqw] rounded-[2cqw] py-[1cqw] outline-none transition-colors hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.08]"
								onClick={() =>
									tile.thread
										? onOpenThread(tile.thread.id)
										: onStartWithAgent(tile.agent.id)
								}
								type="button"
							>
								<span className="relative">
									<GlanceAvatar
										agent={tile.agent}
										className="size-[clamp(2rem,8cqw,3.75rem)]"
									/>
									<GlanceMark
										className="absolute right-0 bottom-0 size-[clamp(0.5rem,1.8cqw,0.875rem)] ring-[0.5cqw] ring-muted"
										state={tile.state}
									/>
								</span>
								<span
									className={cn(
										"max-w-full truncate font-medium text-foreground",
										W.sub
									)}
								>
									{tile.agent.name}
								</span>
								<span className="sr-only">
									{GLANCE_AGENT_STATE_LABELS[tile.state]}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</Widget>
	);
}

/** The widget grid's shape while the first snapshot loads. */
const SKELETON_WIDGETS: readonly { id: string; size: WidgetSize }[] = [
	{ id: "your-turn", size: "large" },
	{ id: "working", size: "medium" },
	{ id: "clock", size: "small" },
	{ id: "waiting", size: "small" },
	{ id: "upcoming", size: "large" },
	{ id: "agents", size: "large" },
];

/**
 * The Home Screen: Apple's widget grid (small, medium, large) over the same
 * snapshot. Four columns on the display; two stacked columns when it is small.
 */
export function GlanceHome(props: GlanceHomeProps) {
	if (props.loading) {
		return (
			<div className="grid size-full grid-cols-4 grid-rows-4 gap-[2.8cqw] p-[4.4cqw]">
				{SKELETON_WIDGETS.map((widget) => (
					<Skeleton
						className={cn(
							"corner-squircle rounded-[4.4cqw] bg-muted",
							SPAN[widget.size]
						)}
						key={widget.id}
					/>
				))}
			</div>
		);
	}
	return (
		<div className="grid size-full @max-[32rem]:h-auto @max-[32rem]:grid-cols-2 grid-cols-4 @max-[32rem]:grid-rows-none grid-rows-4 @max-[32rem]:gap-3 gap-[2.8cqw] @max-[32rem]:p-3 p-[4.4cqw]">
			<NeedsYouWidget {...props} />
			<WorkingWidget {...props} />
			<ClockWidget now={props.now} />
			<WaitingWidget {...props} />
			<UpcomingWidget {...props} />
			<AgentsWidget {...props} />
		</div>
	);
}
