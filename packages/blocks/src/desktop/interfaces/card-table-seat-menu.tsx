import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import {
	plural,
	type SeatInfo,
	type SeatTone,
	seatTone,
} from "./card-table-model.ts";
import { SeatAvatar } from "./card-table-pieces.tsx";
import { ThreadRow } from "./card-table-rows.tsx";

export type SeatMenuSide = "bottom" | "left" | "right" | "top";
export type SeatMenuAlign = "center" | "end" | "start";

/** Threads listed in a seat's menu before "and n more". */
const MENU_THREADS = 5;

export interface SeatActions {
	activeThreadId: string | null;
	now: number;
	onDeal: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}

/** What a seat says about itself, for its accessible name and its status line. */
export function seatSummary(seat: SeatInfo): string {
	const parts = [plural(seat.threads.length, "thread")];
	if (seat.running.length > 0) {
		parts.push(`${seat.running.length} running`);
	}
	const forYou = seat.attention + seat.yourTurn;
	if (forYou > 0) {
		parts.push(`${forYou} waiting on you`);
	}
	return parts.join(", ");
}

/**
 * The working part of a seat's menu: the agent's threads (most urgent first)
 * and "Deal a thread", which starts a new thread with this agent through the
 * port. `onDone` closes the menu around it.
 */
export function SeatMenuBody({
	actions,
	onDone,
	seat,
}: {
	actions: SeatActions;
	onDone: () => void;
	seat: SeatInfo;
}) {
	const tl = useLiteralMessages();
	const { agent } = seat;
	const shown = seat.threads.slice(0, MENU_THREADS);
	const more = seat.threads.length - shown.length;
	return (
		<>
			{shown.length > 0 ? (
				<ul
					aria-label={tl("{name}'s threads", { name: agent.name })}
					className="flex flex-col"
				>
					{shown.map((thread) => (
						<ThreadRow
							active={thread.id === actions.activeThreadId}
							key={thread.id}
							now={actions.now}
							onOpen={(threadId) => {
								onDone();
								actions.onOpen(threadId);
							}}
							snapshot={actions.snapshot}
							thread={thread}
						/>
					))}
				</ul>
			) : (
				<p className="px-2 text-muted-foreground text-sm">
					{tl("No threads with {name} yet.", { name: agent.name })}
				</p>
			)}
			{more > 0 ? (
				<p className="px-2 text-muted-foreground text-xs">
					{tl(
						"And {count, plural, one {{shown} more thread} other {{shown} more threads}}",
						{ count: more, shown: String(more) }
					)}
				</p>
			) : null}
			<Button
				className="w-full"
				onClick={() => {
					onDone();
					actions.onDeal(agent.id);
				}}
				size="sm"
				type="button"
			>
				<Plus aria-hidden="true" data-icon="inline-start" />
				Deal a thread
			</Button>
		</>
	);
}

/**
 * A seat's menu: who the agent is, the threads it is in (most urgent first),
 * and "Deal a thread", which opens a new thread with this agent through the
 * port. The trigger is passed in so seats and rail rows share the same menu.
 */
export function SeatMenu({
	actions,
	actSentence,
	actTone,
	align = "center",
	seat,
	side = "bottom",
	tooltip,
	trigger,
	triggerContent,
}: {
	actions: SeatActions;
	/** With the act layer: the act sentence, the menu's description. */
	actSentence?: string | null;
	/** With the act layer: the ring from the act (and no lap from `updatedAt`). */
	actTone?: SeatTone;
	align?: SeatMenuAlign;
	seat: SeatInfo;
	side?: SeatMenuSide;
	/** A hover hint on the trigger; hidden while the menu is open. */
	tooltip?: string;
	trigger: ReactElement;
	triggerContent: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const { agent } = seat;
	const popover = (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={tooltip ? <TooltipTrigger render={trigger} /> : trigger}
			>
				{triggerContent}
			</PopoverTrigger>
			<PopoverContent
				align={align}
				appearance="composer-menu"
				className="w-80 gap-3 bg-popover"
				corners="rounded"
				side={side}
				sideOffset={8}
				spacing="inset"
			>
				<PopoverHeader className="flex-row items-center gap-3 px-2 pt-2">
					<SeatAvatar
						agent={agent}
						since={actTone ? undefined : seat.running[0]?.updatedAt}
						size={36}
						tone={actTone ?? seatTone(seat)}
					/>
					<div className="flex min-w-0 flex-col gap-0.5">
						<PopoverTitle className="truncate font-semibold text-sm">
							{agent.name}
						</PopoverTitle>
						<PopoverDescription
							className={cn(
								"text-xs",
								actSentence ? "line-clamp-4" : "line-clamp-2"
							)}
						>
							{actSentence || agent.description || seatSummary(seat)}
						</PopoverDescription>
					</div>
				</PopoverHeader>
				<SeatMenuBody
					actions={actions}
					onDone={() => setOpen(false)}
					seat={seat}
				/>
			</PopoverContent>
		</Popover>
	);
	if (!tooltip) {
		return popover;
	}
	return (
		<Tooltip disabled={open}>
			{popover}
			<TooltipContent side={side === "top" ? "bottom" : "top"}>
				{tooltip}
			</TooltipContent>
		</Tooltip>
	);
}
