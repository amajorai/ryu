import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { useMemo } from "react";
import {
	type GlanceHomeProps,
	glanceClockWidgetType,
	HeaderCount,
	Quiet,
	SmallFace,
	SPAN,
	W,
	Widget,
	type WidgetSize,
} from "./glance-home-chrome.tsx";
import { NeedsYouWidget, WorkingWidget } from "./glance-home-lists.tsx";
import {
	buildGlanceAgents,
	GLANCE_AGENT_STATE_LABELS,
	glanceClock,
	glanceRunWhen,
	glanceThreadTitle,
	glanceUpcoming,
	glanceWaitingOnAgent,
} from "./glance-model.ts";
import {
	GLANCE_INK_SECONDARY,
	GlanceAvatar,
	GlanceMark,
} from "./glance-parts.tsx";
import { agentById } from "./interface-renderer.ts";

export {
	type GlanceHomeProps,
	glanceClockWidgetType,
} from "./glance-home-chrome.tsx";

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
	const tl = useLiteralMessages();
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
					aria-label={tl("{count} waiting on agents. Open {title}", {
						count: String(waiting.length),
						title: glanceThreadTitle(first),
					})}
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
	const tl = useLiteralMessages();
	const tiles = useMemo(() => buildGlanceAgents(snapshot), [snapshot]);
	const working = tiles.filter((tile) => tile.state === "working").length;
	const shown = tiles.slice(0, 6);
	return (
		<Widget
			accessory={
				<HeaderCount>
					{tl("{working} of {total} working", {
						total: String(tiles.length),
						working: String(working),
					})}
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
