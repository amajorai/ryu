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
import {
	cloneElement,
	type MouseEvent,
	type ReactElement,
	type ReactNode,
	useState,
} from "react";
import {
	plural,
	type SeatInfo,
	type SeatTone,
	seatTone,
} from "./card-table-model.ts";
import { SeatAvatar, SuitGlyph, TimerChip } from "./card-table-pieces.tsx";
import { ThreadRow } from "./card-table-rows.tsx";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { compactAge } from "./interface-renderer.ts";

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
	const { agent } = seat;
	const shown = seat.threads.slice(0, MENU_THREADS);
	const more = seat.threads.length - shown.length;
	return (
		<>
			{shown.length > 0 ? (
				<ul aria-label={`${agent.name}'s threads`} className="flex flex-col">
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
					No threads with {agent.name} yet.
				</p>
			)}
			{more > 0 ? (
				<p className="px-2 text-muted-foreground text-xs">
					And {plural(more, "more thread")}
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

/** Status lines can sit over the felt, so they carry their own surface. */
const STATUS_PILL =
	"flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-2.5 font-bold text-[12px] leading-none shadow-[0_2px_0_var(--gk-edge)]";

function StatusLine({ seat, now }: { now: number; seat: SeatInfo }) {
	const tone = seatTone(seat);
	if (tone === "working") {
		const live = seat.running[0];
		return (
			<span className={cn(STATUS_PILL, "text-status-success")}>
				<span aria-hidden="true" className="flex gap-0.5">
					<span className="size-1 rounded-full bg-success motion-safe:animate-pulse" />
					<span className="size-1 rounded-full bg-success motion-safe:animate-pulse motion-safe:[animation-delay:150ms]" />
					<span className="size-1 rounded-full bg-success motion-safe:animate-pulse motion-safe:[animation-delay:300ms]" />
				</span>
				Working{live ? ` · ${compactAge(live.updatedAt, now)}` : ""}
			</span>
		);
	}
	if (tone === "attention") {
		return (
			<span className={cn(STATUS_PILL, "text-status-destructive")}>
				Needs attention
			</span>
		);
	}
	return null;
}

/**
 * On a compact plate there is no room for a status line, so the threads
 * waiting on you ride its corner as a tiny playing card: the suit they would
 * carry in your hand, and how many. The seat's accessible name says it too.
 */
function TurnBadge({ seat }: { seat: SeatInfo }) {
	const forYou = seat.attention + seat.yourTurn;
	if (forYou === 0) {
		return null;
	}
	const urgent = seat.attention > 0;
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex h-5 shrink-0 items-center gap-px rounded-[4px] border bg-card px-1 font-semibold text-[11px] tabular-nums leading-none shadow-xs",
				urgent
					? "border-destructive/60 text-status-destructive"
					: "border-primary/60 text-primary"
			)}
			data-turn-badge=""
		>
			<SuitGlyph
				className="text-current"
				status={urgent ? "attention" : "your-turn"}
			/>
			{forYou}
		</span>
	);
}

/** The plate's second line: how many threads, and how many wait on you. */
function SeatSubline({ seat }: { seat: SeatInfo }) {
	const forYou = seat.attention + seat.yourTurn;
	return (
		<span className="flex min-w-0 items-baseline gap-1 font-semibold text-(--gk-ink-muted) text-[13px] tabular-nums leading-5">
			<span className="shrink-0">{plural(seat.threads.length, "thread")}</span>
			{forYou > 0 ? (
				<>
					<span aria-hidden="true">·</span>
					<span
						className={cn(
							"truncate font-medium",
							seat.attention > 0 ? "text-(--gk-bad)" : "text-(--gk-info)"
						)}
						data-turn-badge=""
					>
						{forYou} for you
					</span>
				</>
			) : null}
		</span>
	);
}

/** The seat's hover hint: what the agent is doing and what waits on you. */
export function seatTooltip(seat: SeatInfo): string {
	const parts: string[] = [];
	if (seat.agentTurn > 0) {
		parts.push(`Holding the action on ${plural(seat.agentTurn, "thread")}`);
	}
	const forYou = seat.attention + seat.yourTurn;
	if (forYou > 0) {
		parts.push(`${forYou} waiting on you`);
	}
	if (parts.length === 0) {
		parts.push(plural(seat.threads.length, "thread"));
	}
	return parts.join(" · ");
}

/**
 * A seat's act, when the snapshot carries the act layer: the plate is named
 * by the act sentence, an asking act's plate answers its ask (instead of
 * opening the seat menu), and the timer shows only an exact elapsed time.
 */
export interface SeatAct {
	/**
	 * Opens the ask card for an asking act (from the plate, so focus comes
	 * back to it); null keeps the seat menu.
	 */
	answer: ((opener: HTMLElement) => void) | null;
	/** Narrow stages: the plate shows the agent's initial only. */
	iconOnly: boolean;
	/** An in-scene target (the card room's name plate). */
	scene: boolean;
	/** `act.ariaLabel`. */
	sentence: string;
	/** The act's status line (`ActStatus`), under a plain table's plate. */
	status?: ReactNode;
	/** The seat's ring from its act (`actSeatTone`). */
	tone: SeatTone;
}

/** The plate's control: an asking act answers, any other opens the menu. */
function SeatControl({
	act,
	actions,
	align,
	seat,
	side,
	trigger,
	triggerContent,
}: {
	act: SeatAct | undefined;
	actions: SeatActions;
	align: SeatMenuAlign;
	seat: SeatInfo;
	side: SeatMenuSide;
	trigger: ReactElement<{
		children?: ReactNode;
		onClick?: (event: MouseEvent<HTMLElement>) => void;
	}>;
	triggerContent: ReactNode;
}) {
	const answer = act?.answer;
	if (answer) {
		return cloneElement(trigger, {
			children: triggerContent,
			onClick: (event: MouseEvent<HTMLElement>) => answer(event.currentTarget),
		});
	}
	return (
		<SeatMenu
			actions={actions}
			actSentence={act?.sentence}
			actTone={act?.tone}
			align={align}
			seat={seat}
			side={side}
			tooltip={act ? undefined : seatTooltip(seat)}
			trigger={trigger}
			triggerContent={triggerContent}
		/>
	);
}

/** A seat plate's accessible name: its act sentence and action, or its summary. */
function seatLabel(
	seat: SeatInfo,
	act: SeatAct | undefined,
	inPlay: boolean
): string {
	if (act) {
		return `${act.sentence} ${act.answer ? "Answer their ask." : "Seat menu."}`;
	}
	const working = seatTone(seat) === "working";
	return `${seat.agent.name}${working ? ", working" : ""}: ${seatSummary(seat)}${inPlay ? ", thread open" : ""}. Seat menu`;
}

/** The count chip's colour on a name plate, by the seat's strongest signal. */
const NAMEPLATE_CHIP: Record<ReturnType<typeof seatTone>, string> = {
	attention: "bg-(--gk-bad) text-white",
	idle: "bg-(--gk-plate-sunk) text-(--gk-ink)",
	working: "bg-(--gk-good) text-white",
	"your-turn": "bg-(--gk-gold) text-(--gk-edge)",
};

const PLATE =
	"group/seat flex items-center rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) text-(--gk-ink) shadow-(--gk-lip) outline-none transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-(--gk-plate-sunk) focus-visible:outline-3 focus-visible:outline-(--gk-focus) focus-visible:outline-offset-2 focus-visible:outline-solid active:translate-y-0 aria-expanded:bg-(--gk-plate-sunk) motion-reduce:transition-none motion-reduce:hover:translate-y-0";

/**
 * An agent's chair: a plate with its face, name and thread count, and a status
 * line hung under it. The plate is centred on the seat point and opens the
 * seat menu; hovering it says what the agent holds and what waits on you.
 */
export function TableSeat({
	act,
	actions,
	align = "center",
	compact,
	nameplate = false,
	seat,
	side,
}: {
	/** The seat's act, with the act layer. */
	act?: SeatAct;
	actions: SeatActions;
	align?: SeatMenuAlign;
	compact: boolean;
	/** The card room's small name plate over a villager, with a count chip. */
	nameplate?: boolean;
	seat: SeatInfo;
	side: SeatMenuSide;
}) {
	const tone = act ? act.tone : seatTone(seat);
	const { agent } = seat;
	// With acts the timer's lap starts nowhere in particular: `updatedAt`
	// moves with renames and pins, so it is no run's start.
	const since = act ? undefined : seat.running[0]?.updatedAt;
	// The open thread is this agent's: the seat is "in play" too.
	const inPlay = seat.threads.some(
		(thread) => thread.id === actions.activeThreadId
	);
	const label = seatLabel(seat, act, inPlay);
	const actData = act
		? {
				"data-act-agent": agent.id,
				"data-act-scene": act.scene ? "" : undefined,
				// In the room the plate joins the stage's targets: Tab and arrow
				// order, plate separation and the phone's plate fit.
				"data-iso-target": act.scene ? "" : undefined,
				"data-icon-only": act.iconOnly ? "" : undefined,
			}
		: {};
	const toneBorder = inPlay
		? "ring-4 ring-(--gk-accent)"
		: cn(
				tone === "working" && "ring-(--gk-good)/70 ring-3",
				tone === "attention" && "ring-(--gk-bad)/70 ring-3"
			);
	const chip = NAMEPLATE_CHIP[tone];
	if (nameplate) {
		// With acts the station board says how long a run has gone.
		const timer = !act && tone === "working";
		return (
			<SeatControl
				act={act}
				actions={actions}
				align={align}
				seat={seat}
				side={side}
				trigger={
					<button
						aria-label={label}
						className={cn(
							GAME_PLATE,
							GAME_FOCUS,
							"gk-display relative flex h-7 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full ps-2.5 pe-1 text-[13px] leading-none aria-expanded:bg-(--gk-plate-sunk)",
							// Phones: a smaller plate (name and count), so faces show.
							"@max-[559px]/game:h-6 @max-[559px]/game:gap-1 @max-[559px]/game:ps-2 @max-[559px]/game:text-[12px]",
							inPlay && "bg-(--gk-accent) text-(--gk-accent-ink)"
						)}
						data-in-play={inPlay ? "" : undefined}
						data-seat={agent.id}
						{...actData}
						type="button"
					/>
				}
				triggerContent={
					<>
						{timer ? (
							<span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2">
								<TimerChip
									elapsed={since ? compactAge(since, actions.now) : undefined}
									since={since}
								/>
							</span>
						) : null}
						{act?.iconOnly ? (
							<span aria-hidden="true">{Array.from(agent.name)[0] ?? ""}</span>
						) : (
							<span className="max-w-24 truncate">{agent.name}</span>
						)}
						{act ? null : (
							<span
								aria-hidden="true"
								className={cn(
									"grid h-5 min-w-5 place-items-center rounded-full border-(--gk-edge) border-2 px-1 text-[11px] tabular-nums",
									chip
								)}
							>
								{seat.threads.length}
							</span>
						)}
					</>
				}
			/>
		);
	}
	const trigger = compact ? (
		<button
			aria-label={label}
			className={cn(
				PLATE,
				"relative flex-col gap-0.5 px-2 pt-1.5 pb-1",
				inPlay && "ring-(--gk-accent) ring-4"
			)}
			data-in-play={inPlay ? "" : undefined}
			data-seat={agent.id}
			{...actData}
			type="button"
		/>
	) : (
		<button
			aria-label={label}
			className={cn(PLATE, "w-[240px] gap-2.5 py-2 ps-2 pe-3.5", toneBorder)}
			data-in-play={inPlay ? "" : undefined}
			data-seat={agent.id}
			{...actData}
			type="button"
		/>
	);
	const content = compact ? (
		<>
			<SeatAvatar agent={agent} since={since} size={28} tone={tone} />
			<span className="gk-display max-w-16 truncate pb-px text-[13px] leading-tight">
				{agent.name}
			</span>
			{act ? null : (
				<span className="absolute -top-1.5 -right-1">
					<TurnBadge seat={seat} />
				</span>
			)}
		</>
	) : (
		<>
			<SeatAvatar agent={agent} since={since} size={44} tone={tone} />
			<span className="flex min-w-0 flex-1 flex-col text-left">
				<span className="gk-display truncate text-[18px] leading-6">
					{agent.name}
				</span>
				{act ? null : <SeatSubline seat={seat} />}
			</span>
		</>
	);
	return (
		<div className="relative">
			<SeatControl
				act={act}
				actions={actions}
				align={align}
				seat={seat}
				side={side}
				trigger={trigger}
				triggerContent={content}
			/>
			{act ? (
				<span className="absolute top-full left-1/2 mt-1 flex w-56 -translate-x-1/2 justify-center text-(--gk-ink)">
					{act.status}
				</span>
			) : null}
			{compact || act ? null : (
				<span className="pointer-events-none absolute top-full left-1/2 mt-1 flex -translate-x-1/2">
					<StatusLine now={actions.now} seat={seat} />
				</span>
			)}
		</div>
	);
}

/** The open seat's one action: deal a thread; `onDone` closes the menu. */
export function EmptySeatMenuBody({
	onDeal,
	onDone,
}: {
	onDeal: () => void;
	onDone: () => void;
}) {
	return (
		<Button
			className="w-full"
			onClick={() => {
				onDone();
				onDeal();
			}}
			size="sm"
			type="button"
		>
			<Plus aria-hidden="true" data-icon="inline-start" />
			Deal a thread
		</Button>
	);
}

/**
 * A chair nobody sits in. Like an agent's seat it opens a small menu, whose
 * one action deals a new thread with no agent picked yet.
 */
export function EmptySeat({
	align = "center",
	compact,
	onDeal,
	side = "bottom",
}: {
	align?: SeatMenuAlign;
	compact: boolean;
	onDeal: () => void;
	side?: SeatMenuSide;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<button
						aria-label="Open seat. Seat menu"
						className={cn(
							"gk-display flex items-center justify-center gap-1.5 rounded-2xl border-(--gk-plate)/60 border-[3px] border-dashed bg-(--gk-edge)/35 text-(--gk-plate) text-[14px] outline-none transition-colors hover:bg-(--gk-edge)/55 focus-visible:outline-(--gk-focus) focus-visible:outline-3 focus-visible:outline-solid aria-expanded:bg-(--gk-edge)/55",
							compact ? "size-12 rounded-full" : "h-12 w-36"
						)}
						data-empty-seat=""
						type="button"
					/>
				}
			>
				<Plus aria-hidden="true" className="size-4" strokeWidth={3} />
				{compact ? null : <span>Open seat</span>}
			</PopoverTrigger>
			<PopoverContent
				align={align}
				appearance="composer-menu"
				className="w-64 gap-3 bg-popover"
				corners="rounded"
				side={side}
				sideOffset={8}
				spacing="inset"
			>
				<PopoverHeader className="px-2 pt-1">
					<PopoverTitle className="font-semibold text-sm">
						Open seat
					</PopoverTitle>
					<PopoverDescription className="text-xs">
						Nobody sits here yet. Deal a thread and pick who joins in the
						composer.
					</PopoverDescription>
				</PopoverHeader>
				<EmptySeatMenuBody onDeal={onDeal} onDone={() => setOpen(false)} />
			</PopoverContent>
		</Popover>
	);
}
