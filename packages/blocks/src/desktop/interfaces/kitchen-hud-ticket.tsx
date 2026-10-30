import { cn } from "@ryu/ui/lib/utils";
import type { KeyboardEvent } from "react";
import { GAME_FOCUS } from "./game-hud.tsx";
import { ChefAvatar } from "./kitchen-avatar.tsx";
import { DishGlyph } from "./kitchen-dish.tsx";
import { useNow } from "./kitchen-hooks.ts";
import {
	askPatience,
	cookProgress,
	type KitchenTicket,
	readyPatience,
	TICKET_LABELS,
	type TicketAct,
	type TicketState,
	ticketLabel,
	ticketTimer,
} from "./kitchen-model.ts";
import type { KitchenPalette } from "./kitchen-palette.ts";
import { CookRing, StateMark } from "./kitchen-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActNow } from "./use-acts.ts";

/** A minute, for the rail and clock under reduced motion. */
const MINUTE = 60_000;

/** Ticket state to the game kit's tones. */
const STATE_TONE: Record<TicketState, string> = {
	burnt: "bg-(--gk-bad)",
	cooking: "bg-(--gk-warn)",
	limited: "bg-(--gk-warn)/50",
	needs: "bg-(--gk-gold)",
	queued: "bg-(--gk-ink-soft)",
	ready: "bg-(--gk-good)",
	served: "bg-(--gk-paper-edge)",
};

/** No chef on the ticket: an empty dashed seat instead of a generated face. */
function UnassignedMark() {
	return (
		<span
			aria-hidden="true"
			className="size-[22px] shrink-0 rounded-full border-(--gk-paper-ink-muted) border-2 border-dashed"
		/>
	);
}

/** Paper with a torn (zigzag) bottom edge. */
const TORN =
	"[mask:conic-gradient(from_-45deg_at_bottom,transparent,black_1deg_89deg,transparent_90deg)_50%/10px_100%]";

export function TicketCard({
	act,
	active,
	compact,
	height,
	hovered,
	index,
	onFocusMove,
	onHover,
	onServe,
	palette,
	ticket,
	typicalMs,
}: {
	/** The act layer's view of this ticket; absent for an old host. */
	act?: TicketAct | null;
	active: boolean;
	/** Narrow rails say "Ready" instead of "Ready to serve". */
	compact: boolean;
	height: number;
	hovered: boolean;
	index: number;
	palette: KitchenPalette;
	onFocusMove: (event: KeyboardEvent<HTMLButtonElement>) => void;
	onHover: (id: string | null) => void;
	onServe: (id: string) => void;
	ticket: KitchenTicket;
	typicalMs: number;
}) {
	const reduced = useReducedMotion();
	// Under reduced motion the rail moves with the minute, as its timer text
	// does, so a still frame stays still.
	const liveNow = useNow();
	const now = reduced ? Math.floor(liveNow / MINUTE) * MINUTE : liveNow;
	// An ask's patience drains on the act clock (the one its words use);
	// under reduced motion it steps with the minute.
	const actNow = useActNow();
	const askNow = reduced ? Math.floor(actNow / MINUTE) * MINUTE : actNow;
	const state = act?.state ?? ticket.state;
	const cooking = state === "cooking";
	let progress: ReturnType<typeof cookProgress> | null = null;
	if (act) {
		progress =
			cooking && act.estimate !== null
				? { fraction: act.estimate, over: false }
				: null;
	} else if (cooking) {
		progress = cookProgress(ticket.updatedAt, typicalMs, now);
	}
	let status: string = act?.label ?? TICKET_LABELS[ticket.state];
	if (act) {
		// The act's words as they are.
	} else if (ticket.state === "ready" && !compact) {
		status = "Ready to serve";
	} else if (progress?.over) {
		status = compact ? "Over time" : "Over usual time";
	}
	// With acts only a run's exact elapsed time shows; never a last update.
	const timer = act
		? (act.elapsed ?? "")
		: ticketTimer(ticket.updatedAt, now, cooking);
	// The coloured band is patience, as in the reference: only a ticket
	// waiting on you (ready) drains; every other ticket shows a full band in
	// its state colour. Cooking progress lives in the ring.
	let bar = ticket.state === "ready" ? readyPatience(ticket.updatedAt, now) : 1;
	if (act) {
		bar = act.ask ? (askPatience(act.ask, askNow) ?? 1) : 1;
	}
	const lifted = active || hovered;
	return (
		<li
			className={cn(
				"relative flex shrink-0 snap-start pt-3 drop-shadow-[0_3px_0_var(--gk-paper-edge)] transition-transform duration-150 ease-out motion-reduce:transition-none",
				index % 2 === 0 ? "-rotate-[0.6deg]" : "rotate-[0.5deg]",
				lifted && "motion-safe:translate-y-1"
			)}
		>
			{/* The clip that holds the ticket on the rail. */}
			<span
				aria-hidden="true"
				className="absolute top-0 left-1/2 z-10 h-5 w-9 -translate-x-1/2 rounded-md border-(--gk-edge) border-2 bg-(--gk-paper-edge)"
			/>
			<button
				aria-current={active ? "true" : undefined}
				aria-label={ticketLabel(ticket, now, act)}
				className={cn(
					"relative flex w-(--ticket-width) flex-col rounded-t-md bg-(--gk-paper) pb-2.5 text-left text-(--gk-paper-ink)",
					TORN,
					GAME_FOCUS
				)}
				data-active={active ? "" : undefined}
				data-state={state}
				onBlur={() => onHover(null)}
				onClick={() => onServe(ticket.id)}
				onFocus={() => onHover(ticket.id)}
				onKeyDown={onFocusMove}
				onPointerEnter={() => onHover(ticket.id)}
				onPointerLeave={() => onHover(null)}
				style={{ height }}
				type="button"
			>
				{active ? (
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 rounded-t-md border-(--gk-accent) border-x-4 border-t-4"
					/>
				) : null}
				<span
					aria-hidden="true"
					className="relative mt-3.5 h-1.5 w-full bg-(--gk-paper-edge)/60"
				>
					<span
						className={cn(
							"absolute inset-y-0 left-0 transition-[width] duration-700 ease-linear motion-reduce:transition-none",
							STATE_TONE[state]
						)}
						style={{ width: `${bar * 100}%` }}
					/>
				</span>
				<span className="flex min-h-0 flex-1 flex-col gap-1.5 px-3 pt-2">
					<span className="flex h-6 items-center gap-1.5">
						{ticket.chef ? (
							<ChefAvatar agentId={ticket.chef.id} size={22} />
						) : (
							<UnassignedMark />
						)}
						<span className="gk-display min-w-0 flex-1 truncate text-(--gk-paper-ink-muted) text-[14px]">
							{ticket.chef?.name ?? "Unassigned"}
						</span>
						<span
							className={cn(
								"flex shrink-0 items-center gap-1 whitespace-nowrap font-semibold text-[13px] tabular-nums",
								cooking
									? "text-(--gk-paper-ink)"
									: "text-(--gk-paper-ink-muted)"
							)}
						>
							{progress ? (
								<CookRing
									estimate={act !== null && act !== undefined}
									fraction={progress.fraction}
									over={progress.over}
									size={14}
									stroke={2.5}
								/>
							) : null}
							{timer}
						</span>
					</span>
					<span className="line-clamp-2 font-semibold text-[15px] leading-5">
						{ticket.title}
					</span>
					<span className="mt-auto flex items-center gap-1.5 font-bold text-[12px] uppercase leading-4 tracking-wide">
						{state === "ready" ? (
							<DishGlyph id={ticket.id} palette={palette} size={18} />
						) : (
							<span className="flex size-[18px] shrink-0 items-center justify-center">
								<StateMark className="size-2.5" state={state} />
							</span>
						)}
						<span className="truncate">{status}</span>
					</span>
				</span>
			</button>
		</li>
	);
}
