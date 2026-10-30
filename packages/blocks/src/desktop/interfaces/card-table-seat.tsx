import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	cloneElement,
	type MouseEvent,
	type ReactElement,
	type ReactNode,
} from "react";
import {
	plural,
	type SeatInfo,
	type SeatTone,
	seatTone,
} from "./card-table-model.ts";
import { SeatAvatar, TimerChip } from "./card-table-pieces.tsx";
import {
	type SeatActions,
	SeatMenu,
	type SeatMenuAlign,
	type SeatMenuSide,
	seatSummary,
} from "./card-table-seat-menu.tsx";
import {
	SeatSubline,
	StatusLine,
	TurnBadge,
} from "./card-table-seat-status.tsx";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { compactAge } from "./interface-renderer.ts";

export {
	EmptySeat,
	EmptySeatMenuBody,
} from "./card-table-seat-empty.tsx";
export {
	type SeatActions,
	SeatMenu,
	type SeatMenuAlign,
	SeatMenuBody,
	type SeatMenuSide,
	seatSummary,
} from "./card-table-seat-menu.tsx";

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
	inPlay: boolean,
	tl: LiteralMessage
): string {
	if (act) {
		return `${act.sentence} ${act.answer ? "Answer their ask." : "Seat menu."}`;
	}
	const working = seatTone(seat) === "working";
	return tl(
		"{name}{working, select, true {, working} other {}}: {summary}{inPlay, select, true {, thread open} other {}}. Seat menu",
		{
			inPlay: inPlay ? "true" : "false",
			name: seat.agent.name,
			summary: seatSummary(seat),
			working: working ? "true" : "false",
		}
	);
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
	const tl = useLiteralMessages();
	const tone = act ? act.tone : seatTone(seat);
	const { agent } = seat;
	// With acts the timer's lap starts nowhere in particular: `updatedAt`
	// moves with renames and pins, so it is no run's start.
	const since = act ? undefined : seat.running[0]?.updatedAt;
	// The open thread is this agent's: the seat is "in play" too.
	const inPlay = seat.threads.some(
		(thread) => thread.id === actions.activeThreadId
	);
	const label = seatLabel(seat, act, inPlay, tl);
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
