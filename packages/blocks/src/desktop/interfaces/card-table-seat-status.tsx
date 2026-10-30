import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { plural, type SeatInfo, seatTone } from "./card-table-model.ts";
import { SuitGlyph } from "./card-table-pieces.tsx";
import { compactAge } from "./interface-renderer.ts";

/** Status lines can sit over the felt, so they carry their own surface. */
const STATUS_PILL =
	"flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-2.5 font-bold text-[12px] leading-none shadow-[0_2px_0_var(--gk-edge)]";

export function StatusLine({ seat, now }: { now: number; seat: SeatInfo }) {
	const tl = useLiteralMessages();
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
				{live
					? tl("Working · {age}", { age: compactAge(live.updatedAt, now) })
					: tl("Working")}
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
export function TurnBadge({ seat }: { seat: SeatInfo }) {
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
export function SeatSubline({ seat }: { seat: SeatInfo }) {
	const tl = useLiteralMessages();
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
						{tl("{forYou} for you", { forYou: String(forYou) })}
					</span>
				</>
			) : null}
		</span>
	);
}
