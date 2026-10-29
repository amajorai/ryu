import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceEvent,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { CalendarClock } from "lucide-react";
import { useState } from "react";
import { plural, untilLabel } from "./card-table-model.ts";
import { ChipPile } from "./card-table-pieces.tsx";
import { ThreadRow } from "./card-table-rows.tsx";

/** The dealer's pills in the middle of the felt share one surface. */
const DEALER_PILL =
	"flex h-9 items-center whitespace-nowrap rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) text-(--gk-ink) font-semibold text-[13px] shadow-(--gk-lip)";

/**
 * The dealer button, with the act layer: a white puck marked D and the
 * next scheduled deal ("Next deal tomorrow 09:00"; on a phone just
 * "tomorrow 09:00" by the puck, with "Next deal" kept for screen readers).
 * Hidden when nothing is scheduled; never invented.
 */
export function DealerButton({
	compact,
	text,
}: {
	compact: boolean;
	text: string | null;
}) {
	if (!text) {
		return null;
	}
	return (
		<p
			className={cn(
				DEALER_PILL,
				"gap-1.5 ps-1",
				compact ? "max-w-44 pe-2.5" : "max-w-72 pe-3"
			)}
			data-dealer=""
		>
			<span
				aria-hidden="true"
				className="grid size-6 shrink-0 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk) font-black text-[11px] leading-none"
			>
				D
			</span>
			<span className={cn("truncate", compact && "text-[12px]")}>
				<span className={compact ? "sr-only" : undefined}>Next deal </span>
				{text}
			</span>
		</p>
	);
}

/**
 * The middle of the felt: the pot (every live run, as a chip pile and a count
 * that opens the list) and the dealer's line naming the next scheduled run.
 */
export function TablePot({
	activeThreadId,
	actNext,
	compact,
	pile = true,
	next,
	now,
	onOpen,
	pileSize,
	running,
	snapshot,
	word = "running",
}: {
	activeThreadId: string | null;
	/**
	 * With the act layer: when the next deal is ("tomorrow 09:00", by the
	 * act clock), for the dealer button, in place of the next run's title
	 * and its countdown; null when nothing is scheduled.
	 */
	actNext?: string | null;
	/** The card room's felt already holds the chips: no pile over it. */
	pile?: boolean;
	/** Narrow tables drop the dealer's line. */
	compact: boolean;
	/** The pile's chip size, smaller on a narrow felt so it keeps clear of the seats' chips. */
	pileSize: number;
	next: InterfaceEvent | undefined;
	now: number;
	onOpen: (threadId: string) => void;
	running: InterfaceThread[];
	snapshot: InterfaceSnapshot;
	/** What the pot's threads are doing ("working" with the act layer). */
	word?: string;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const count = running.length;
	// The open thread is a live run: the pot is in play.
	const inPlay = running.some((thread) => thread.id === activeThreadId);
	let label = "Pot: nothing running";
	if (count > 0) {
		const values = { threads: plural(count, "thread"), word };
		label = inPlay
			? tl("Pot: {threads} {word}, one open. Show them", values)
			: tl("Pot: {threads} {word}. Show them", values);
	}
	return (
		<div className="flex flex-col items-center gap-2">
			{pile ? (
				<ChipPile ids={running.map((thread) => thread.id)} size={pileSize} />
			) : null}
			<Popover onOpenChange={setOpen} open={open}>
				<PopoverTrigger
					disabled={count === 0}
					render={
						<button
							aria-current={inPlay ? "true" : undefined}
							aria-label={label}
							className={cn(
								DEALER_PILL,
								"h-9 px-4 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/40 enabled:hover:bg-background aria-expanded:border-ring",
								inPlay && "border-primary ring-2 ring-primary/30",
								count === 0 && "cursor-default"
							)}
							type="button"
						/>
					}
				>
					<span className="flex items-baseline gap-2">
						<span className="text-muted-foreground">Pot</span>
						<strong className="font-heading font-semibold text-xl tabular-nums leading-none tracking-tight">
							{count}
						</strong>
						{/* A phone's room keeps the pot narrow, clear of the far seats' plates. */}
						{compact && actNext !== undefined ? null : (
							<span className="text-muted-foreground">{word}</span>
						)}
					</span>
				</PopoverTrigger>
				<PopoverContent
					appearance="composer-menu"
					className="w-80 gap-2 bg-popover"
					corners="rounded"
					sideOffset={8}
					spacing="inset"
				>
					<PopoverHeader className="px-2 pt-1">
						<PopoverTitle className="font-semibold text-sm">
							In the pot
						</PopoverTitle>
						<PopoverDescription className="text-xs">
							Runs live right now, newest first.
						</PopoverDescription>
					</PopoverHeader>
					<ul aria-label="Running threads" className="flex flex-col">
						{running.map((thread) => (
							<ThreadRow
								active={thread.id === activeThreadId}
								key={thread.id}
								now={now}
								onOpen={(threadId) => {
									setOpen(false);
									onOpen(threadId);
								}}
								showAgent
								snapshot={snapshot}
								thread={thread}
							/>
						))}
					</ul>
				</PopoverContent>
			</Popover>
			{actNext === undefined ? null : (
				<DealerButton compact={compact} text={actNext} />
			)}
			{next && !compact && actNext === undefined ? (
				<p className={cn(DEALER_PILL, "max-w-72 gap-1.5 px-3")}>
					<CalendarClock
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
					<span className="truncate">
						<span className="text-muted-foreground">Next deal</span>{" "}
						{next.title}{" "}
						<span className="text-muted-foreground tabular-nums">
							{untilLabel(next.start, now)}
						</span>
					</span>
				</p>
			) : null}
		</div>
	);
}
