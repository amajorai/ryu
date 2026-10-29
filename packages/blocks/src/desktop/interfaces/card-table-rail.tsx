import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	plural,
	type SeatInfo,
	type SeatTone,
	seatTone,
} from "./card-table-model.ts";
import { SeatAvatar } from "./card-table-pieces.tsx";
import { ThreadRow } from "./card-table-rows.tsx";
import { type SeatActions, SeatMenu, seatSummary } from "./card-table-seat.tsx";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";

/** Unassigned threads listed on the rail before the list stops. */
const RAIL_THREADS = 3;

/** The rail's act layer: each off-stage agent's act, its words and status. */
export interface RailActs {
	/** Opens the ask card for an asking agent; null keeps the seat menu. */
	answer: (agentId: string) => ((opener: HTMLElement) => void) | null;
	/** `act.ariaLabel`. */
	sentence: (agentId: string) => string | null;
	/** The act's status line (`ActStatus`): the row's only status words. */
	status: (agentId: string) => ReactNode;
	/** The avatar's ring from the act (`actSeatTone`). */
	tone: (agentId: string) => SeatTone;
}

const SECTION_TITLE =
	"px-2 pt-1 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.09em]";

function RailSections({
	acts,
	actions,
	onDone,
	seats,
	unseated,
}: {
	acts?: RailActs;
	actions: SeatActions;
	/** Called after a row opens a thread, so a surrounding popover can close. */
	onDone?: () => void;
	seats: SeatInfo[];
	unseated: InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	const shownThreads = unseated.slice(0, RAIL_THREADS);
	return (
		<>
			{seats.length > 0 ? (
				<section aria-label="On the rail" className="flex flex-col gap-0.5">
					<h2 className={SECTION_TITLE}>On the rail</h2>
					<ul className="flex flex-col">
						{seats.map((seat) => {
							const id = seat.agent.id;
							const sentence = acts?.sentence(id) ?? null;
							const answer = acts?.answer(id) ?? null;
							let label = tl("{name}: {summary}. Seat menu", {
								name: seat.agent.name,
								summary: seatSummary(seat),
							});
							if (sentence) {
								label = `${sentence} ${answer ? "Answer their ask." : "Seat menu."}`;
							}
							const trigger = (
								<button
									aria-label={label}
									className="flex w-full min-w-0 items-center gap-2 rounded-xl p-1 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
									data-act-agent={sentence ? id : undefined}
									type="button"
								/>
							);
							const content = (
								<>
									<SeatAvatar
										agent={seat.agent}
										since={acts ? undefined : seat.running[0]?.updatedAt}
										size={28}
										tone={acts ? acts.tone(id) : seatTone(seat)}
									/>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate font-medium text-sm leading-5">
											{seat.agent.name}
										</span>
										{acts ? null : (
											<span className="truncate text-muted-foreground text-xs">
												{plural(seat.threads.length, "thread")}
											</span>
										)}
									</span>
								</>
							);
							return (
								<li
									className={acts ? "flex flex-col gap-1" : undefined}
									key={id}
								>
									{answer ? (
										<button
											{...trigger.props}
											onClick={(event) => answer(event.currentTarget)}
										>
											{content}
										</button>
									) : (
										<SeatMenu
											actions={actions}
											actSentence={sentence}
											actTone={acts?.tone(id)}
											seat={seat}
											side="right"
											trigger={trigger}
											triggerContent={content}
										/>
									)}
									{acts ? (
										<span className="ps-9 text-foreground">
											{acts.status(id)}
										</span>
									) : null}
								</li>
							);
						})}
					</ul>
				</section>
			) : null}
			{shownThreads.length > 0 ? (
				<section aria-label="Off the table" className="flex flex-col gap-0.5">
					<h2 className={SECTION_TITLE}>Off the table · no agent</h2>
					<ul className="flex flex-col">
						{shownThreads.map((thread) => (
							<ThreadRow
								active={thread.id === actions.activeThreadId}
								key={thread.id}
								now={actions.now}
								onOpen={(threadId) => {
									onDone?.();
									actions.onOpen(threadId);
								}}
								snapshot={actions.snapshot}
								thread={thread}
							/>
						))}
					</ul>
					{unseated.length > shownThreads.length ? (
						<p className="px-2 pb-1 text-muted-foreground text-xs">
							{tl("And {count} more", {
								count: String(unseated.length - shownThreads.length),
							})}
						</p>
					) : null}
				</section>
			) : null}
		</>
	);
}

/** The collapsed rail's name, and what it counts. */
export function railLabel(
	seats: number,
	unseated: number
): { name: string; unit: string } {
	if (seats > 0 && unseated > 0) {
		return { name: "Rail", unit: "item" };
	}
	return seats > 0
		? { name: "On the rail", unit: "agent" }
		: { name: "Off the table", unit: "thread" };
}

/**
 * The rail: agents who did not get a chair (more than six at the table), and
 * threads with no agent at all, so every thread is still one click away. Each
 * agent row opens the same seat menu as a chair. On a roomy stage it is a
 * panel in the top-left corner, sized to stop above the left-hand seats; on a
 * narrower one it folds into a small pill that opens the same list, so it
 * never sits over a chair.
 */
export function CardTableRail({
	acts,
	actions,
	collapsed,
	maxHeight,
	seats,
	top,
	unseated,
}: {
	/** With the act layer: rows read each agent's act. */
	acts?: RailActs;
	actions: SeatActions;
	collapsed: boolean;
	/** The panel's height limit, so it stays clear of the seats under it. */
	maxHeight?: number;
	seats: SeatInfo[];
	/** The panel's top inset (px), below a taller HUD. */
	top?: number;
	unseated: InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	if (seats.length === 0 && unseated.length === 0) {
		return null;
	}
	const count = seats.length + unseated.length;
	const { name, unit } = railLabel(seats.length, unseated.length);
	if (collapsed) {
		return (
			<nav
				aria-label="Rail"
				className="flex shrink-0"
				data-testid="card-table-rail"
			>
				<Popover onOpenChange={setOpen} open={open}>
					<PopoverTrigger
						render={
							<button
								aria-label={tl("{name}: {count}. Show them", {
									name,
									count: plural(count, unit),
								})}
								className={cn(
									GAME_PLATE,
									GAME_FOCUS,
									"gk-display flex h-12 items-center gap-1.5 px-3.5 text-[15px] transition-colors hover:bg-(--gk-plate-sunk) aria-expanded:bg-(--gk-plate-sunk)"
								)}
								type="button"
							/>
						}
					>
						<span aria-hidden="true" className="text-(--gk-ink-muted)">
							♣
						</span>
						<span className="max-sm:hidden">{name}</span>
						<span
							aria-hidden="true"
							className="text-(--gk-ink-muted) max-sm:hidden"
						>
							·
						</span>
						<span className="tabular-nums">{count}</span>
						<ChevronDown
							aria-hidden="true"
							className="size-4 text-(--gk-ink-muted)"
						/>
					</PopoverTrigger>
					<PopoverContent
						align="end"
						appearance="composer-menu"
						className="w-72 gap-2 bg-popover"
						corners="rounded"
						side="bottom"
						sideOffset={8}
						spacing="inset"
					>
						<RailSections
							actions={actions}
							acts={acts}
							onDone={() => setOpen(false)}
							seats={seats}
							unseated={unseated}
						/>
					</PopoverContent>
				</Popover>
			</nav>
		);
	}
	return (
		<nav
			aria-label="Rail"
			className="absolute top-3 left-3 z-30 flex w-56 max-w-[calc(100%-1.5rem)] flex-col gap-2 overflow-y-auto rounded-2xl border-(--gk-edge) border-2 bg-background p-1.5 shadow-(--gk-lip)"
			data-testid="card-table-rail"
			style={top === undefined ? { maxHeight } : { maxHeight, top }}
		>
			<RailSections
				actions={actions}
				acts={acts}
				seats={seats}
				unseated={unseated}
			/>
		</nav>
	);
}
