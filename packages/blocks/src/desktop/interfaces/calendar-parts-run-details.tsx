import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { Bot, CalendarDays, MessageSquarePlus, X } from "lucide-react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import {
	compactTime,
	longDay,
	RUN_OUTCOME_LABELS,
	type RunItem,
	type RunOutcome,
	runDuration,
	runOutcome,
} from "./calendar-model.ts";
import { ITEM_RADIUS_CLASS } from "./calendar-parts-classes.ts";
import { agentById } from "./interface-renderer.ts";

export function aggregateCount(item: RunItem): number {
	const { count } = item.event;
	return count && count > 1 ? count : 0;
}

function DetailRow({
	children,
	icon,
}: {
	children: ReactNode;
	icon: ReactNode;
}) {
	return (
		<div className="flex min-w-0 items-start gap-3 text-sm">
			<span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
				{icon}
			</span>
			<div className="flex min-w-0 flex-1 flex-col">{children}</div>
		</div>
	);
}

/** The run's colour, calendar style: a filled square in its outcome's tone. */
const OUTCOME_SWATCH: Record<RunOutcome, string> = {
	failure: "bg-destructive",
	ran: "bg-muted-foreground/60",
	scheduled: "bg-muted-foreground/60",
	success: "bg-success",
};

const OUTCOME_TEXT: Record<RunOutcome, string> = {
	failure: "text-status-destructive",
	ran: "",
	scheduled: "",
	success: "text-status-success",
};

/**
 * What a run popover says, laid out like a calendar event: the routine with
 * its schedule and outcome, when it ran or will, the agent it targets, and a
 * way to message that agent.
 */
export function RunDetails({
	item,
	onClose,
	onMessage,
	snapshot,
}: {
	item: RunItem;
	onClose?: () => void;
	onMessage: (agentId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const { event } = item;
	const agent = agentById(snapshot, event.agentId);
	const outcome = runOutcome(event);
	const count = aggregateCount(item);
	const duration = runDuration(item);
	const tl = useLiteralMessages();
	let detail = compactTime(item.start);
	if (count > 0) {
		detail = `${count} ${event.kind === "upcoming" ? "runs scheduled" : "runs"}`;
	} else if (duration) {
		detail = `${detail} · took ${duration}`;
	}
	return (
		<div className="flex flex-col gap-4" data-testid="calendar-run-details">
			<div className="flex items-start gap-3">
				<span className="flex h-6 w-5 shrink-0 items-center justify-center">
					<span
						aria-hidden="true"
						className={cn("size-3", ITEM_RADIUS_CLASS, OUTCOME_SWATCH[outcome])}
					/>
				</span>
				<div className="flex min-w-0 flex-1 flex-col">
					<h3 className="font-heading font-semibold text-base text-foreground leading-6">
						{event.title}
					</h3>
					<p className="truncate text-muted-foreground text-sm">
						{event.label ?? "One-off run"} ·{" "}
						<span className={OUTCOME_TEXT[outcome]}>
							{RUN_OUTCOME_LABELS[outcome]}
						</span>
					</p>
				</div>
				{onClose ? (
					<Button
						aria-label="Close run details"
						className="-me-1.5"
						onClick={onClose}
						size="icon-xs"
						type="button"
						variant="ghost-muted"
					>
						<X aria-hidden="true" />
					</Button>
				) : null}
			</div>
			<div className="flex flex-col gap-3">
				<DetailRow icon={<CalendarDays aria-hidden="true" />}>
					<span className="truncate text-foreground leading-5">
						{longDay(item.start)}
					</span>
					<span className="truncate text-muted-foreground text-xs tabular-nums">
						{detail}
					</span>
				</DetailRow>
				<DetailRow
					icon={
						agent ? (
							<BoardAvatar agent={agent} name={agent.name} size={20} />
						) : (
							<Bot aria-hidden="true" />
						)
					}
				>
					{agent ? (
						<>
							<span className="truncate text-foreground leading-5">
								{agent.name}
							</span>
							<span className="truncate text-muted-foreground text-xs">
								{agent.status === "working" ? "Working now" : agent.description}
							</span>
						</>
					) : (
						<span className="text-muted-foreground leading-5">
							No agent: a workflow run
						</span>
					)}
				</DetailRow>
			</div>
			{agent ? (
				<Button
					className="self-start"
					onClick={() => onMessage(agent.id)}
					size="sm"
					type="button"
				>
					<MessageSquarePlus aria-hidden="true" data-icon="inline-start" />
					{tl("Message {name}", { name: agent.name })}
				</Button>
			) : null}
		</div>
	);
}
