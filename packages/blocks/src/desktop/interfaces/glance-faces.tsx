import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import { ClockDigits } from "./glance-faces-clock-digits.tsx";
import {
	GLANCE_TYPE,
	type GlanceFaceProps,
} from "./glance-faces-type-scale.ts";
import {
	GLANCE_AGENT_STATE_LABELS,
	GLANCE_NEEDS_YOU_LABEL,
	glanceListWindow,
	glanceRunWhen,
	glanceThreadTitle,
	glanceUpcoming,
	glanceWaitingLine,
	glanceWaitingOnYou,
} from "./glance-model.ts";
import {
	GLANCE_INK_SECONDARY,
	GlanceMark,
	glanceThreadState,
} from "./glance-parts.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";

export { GlanceAgentsFace } from "./glance-faces-agents.tsx";
export { GlanceFlowFace } from "./glance-faces-flow.tsx";
export {
	GLANCE_TYPE,
	type GlanceFaceProps,
} from "./glance-faces-type-scale.ts";

function agentNames(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string {
	const names = thread.agentIds
		.map((id) => agentById(snapshot, id)?.name)
		.filter((name): name is string => Boolean(name));
	return names.length > 0 ? names.join(", ") : "No agent";
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function ThreadRow({
	now,
	onOpen,
	snapshot,
	thread,
}: {
	now: number;
	onOpen: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const tl = useLiteralMessages();
	const state = glanceThreadState(thread);
	const title = glanceThreadTitle(thread);
	return (
		<li>
			<button
				aria-label={tl("Open {title}, {state}", {
					state: GLANCE_AGENT_STATE_LABELS[state],
					title,
				})}
				className="group corner-squircle -mx-[2.4cqw] grid w-[calc(100%+4.8cqw)] grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-[2cqw] rounded-[2.4cqw] px-[2.4cqw] py-[1.6cqw] text-left outline-none transition-colors hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.08]"
				onClick={onOpen}
				type="button"
			>
				<GlanceMark className="-translate-y-[0.2em]" state={state} />
				<span className="flex min-w-0 flex-col gap-[0.4cqw]">
					<span
						className={cn(
							"truncate font-semibold text-foreground",
							GLANCE_TYPE.body
						)}
					>
						{title}
					</span>
					<span
						className={cn("truncate", GLANCE_INK_SECONDARY, GLANCE_TYPE.detail)}
					>
						<span className="font-medium text-foreground/80">
							{agentNames(snapshot, thread)}
						</span>
						{thread.lastMessage ? ` · ${thread.lastMessage}` : null}
					</span>
				</span>
				<span
					className={cn(
						"tabular-nums",
						GLANCE_INK_SECONDARY,
						GLANCE_TYPE.detail
					)}
				>
					{compactAge(thread.updatedAt, now)}
				</span>
			</button>
		</li>
	);
}

/** The clock face: the time, the date, and how much is waiting on you. */
export function GlanceClockFace({
	distance,
	loading,
	now,
	onOpenThread,
	onShowAll,
	snapshot,
}: GlanceFaceProps & { onShowAll: () => void }) {
	const tl = useLiteralMessages();
	const waiting = useMemo(() => glanceWaitingOnYou(snapshot), [snapshot]);
	const next = useMemo(() => glanceUpcoming(snapshot, now)[0], [snapshot, now]);
	const first = waiting[0];

	if (distance === "far") {
		return (
			<div className="flex size-full flex-col items-center justify-center gap-[4cqw] p-[7cqw] text-center">
				<ClockDigits near={false} now={now} />
				{loading ? (
					<Skeleton className="h-[4.4cqw] w-[36cqw] rounded-full" />
				) : (
					<button
						aria-label={
							first
								? tl("{waiting}. Open {title}", {
										title: glanceThreadTitle(first),
										waiting: glanceWaitingLine(waiting.length),
									})
								: glanceWaitingLine(0)
						}
						className={cn(
							"inline-flex items-center gap-[1.8cqw] rounded-full px-[2.4cqw] py-[1cqw] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
							GLANCE_TYPE.lead,
							first
								? "text-foreground hover:bg-foreground/[0.05] active:bg-foreground/[0.08]"
								: cn("cursor-default", GLANCE_INK_SECONDARY)
						)}
						disabled={!first}
						onClick={first ? () => onOpenThread(first.id) : undefined}
						type="button"
					>
						<GlanceMark
							className="size-[1.6cqw]"
							state={first ? "your-turn" : "idle"}
						/>
						{glanceWaitingLine(waiting.length)}
					</button>
				)}
			</div>
		);
	}

	const list = glanceListWindow(waiting.length, 5);
	const shown = waiting.slice(0, list.shown);
	const nextAgent = next ? agentById(snapshot, next.agentId) : undefined;
	return (
		<div className="flex size-full flex-col p-[7cqw]">
			<ClockDigits near now={now} />
			<section
				aria-label={GLANCE_NEEDS_YOU_LABEL}
				className="mt-[7cqw] flex min-h-0 flex-col gap-[1.6cqw]"
			>
				<h3
					className={cn(
						"flex items-baseline justify-between font-semibold text-foreground",
						GLANCE_TYPE.detail
					)}
				>
					{GLANCE_NEEDS_YOU_LABEL}
					<span
						className={cn("font-medium tabular-nums", GLANCE_INK_SECONDARY)}
					>
						{loading ? null : waiting.length}
					</span>
				</h3>
				{!loading && waiting.length === 0 ? (
					<p className={cn(GLANCE_INK_SECONDARY, GLANCE_TYPE.body)}>
						{glanceWaitingLine(0)}
					</p>
				) : null}
				{loading ? (
					<div className="flex flex-col gap-[3cqw] pt-[1.6cqw]">
						<Skeleton className="h-[3cqw] w-3/4 rounded-full" />
						<Skeleton className="h-[3cqw] w-2/3 rounded-full" />
						<Skeleton className="h-[3cqw] w-1/2 rounded-full" />
					</div>
				) : null}
				{!loading && shown.length > 0 ? (
					<ul className="flex flex-col">
						{shown.map((thread) => (
							<ThreadRow
								key={thread.id}
								now={now}
								onOpen={() => onOpenThread(thread.id)}
								snapshot={snapshot}
								thread={thread}
							/>
						))}
					</ul>
				) : null}
				{!loading && list.hidden > 0 ? (
					<button
						className={cn(
							"corner-squircle -mx-[2.4cqw] self-start rounded-[2.4cqw] px-[2.4cqw] py-[1cqw] font-medium outline-none transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.08]",
							GLANCE_INK_SECONDARY,
							GLANCE_TYPE.detail
						)}
						onClick={onShowAll}
						type="button"
					>
						{tl("{hidden} more on the Home Screen", {
							hidden: String(list.hidden),
						})}
					</button>
				) : null}
			</section>
			{next ? (
				<p
					className={cn(
						"mt-auto flex min-w-0 items-baseline gap-[1.6cqw] pt-[4cqw]",
						GLANCE_INK_SECONDARY,
						GLANCE_TYPE.detail
					)}
				>
					<span className="shrink-0 font-semibold">Next run</span>
					<span className="truncate">
						<span className="font-medium text-foreground">{next.title}</span>
						{nextAgent ? ` · ${nextAgent.name}` : null}
					</span>
					<span className="ml-auto shrink-0 tabular-nums">
						{glanceRunWhen(next.start, now)}
					</span>
				</p>
			) : null}
		</div>
	);
}
