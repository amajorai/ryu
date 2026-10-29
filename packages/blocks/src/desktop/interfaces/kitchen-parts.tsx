import { cn } from "@ryu/ui/lib/utils";
import type { TicketState } from "./kitchen-model.ts";

/**
 * Small pieces the Kitchen HUD, overlay and panel share: the status tones
 * (theme tokens only) and the circular cooking ring.
 *
 * Ready is success, cooking is warning and burnt is destructive. None of
 * them is `primary`, so a theme with a green or amber accent never makes
 * two states the same colour. State words stay `foreground`: warning and
 * success are too light to pass AA as 12px text on a light card, so the
 * mark, the ticket's top bar and the dish glow carry the colour instead.
 */

export const STATE_BAR: Record<TicketState, string> = {
	burnt: "bg-destructive",
	cooking: "bg-warning",
	limited: "bg-warning/50",
	needs: "bg-(--gk-gold)",
	queued: "bg-muted-foreground/35",
	ready: "bg-success",
	served: "bg-border",
};

/** The ticket bar's track: the state colour, faint, so it never reads empty. */
export const STATE_TRACK: Record<TicketState, string> = {
	burnt: "bg-destructive/25",
	cooking: "bg-warning/25",
	limited: "bg-warning/15",
	needs: "bg-(--gk-gold)/30",
	queued: "bg-muted",
	ready: "bg-success/30",
	served: "bg-muted",
};

export const STATE_TEXT: Record<TicketState, string> = {
	burnt: "text-foreground",
	cooking: "text-foreground",
	limited: "text-foreground",
	needs: "text-foreground",
	queued: "text-muted-foreground",
	ready: "text-foreground",
	served: "text-muted-foreground",
};

/** A status mark that differs by shape as well as colour. */
export function StateMark({
	className,
	state,
}: {
	className?: string;
	state: TicketState;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				state === "ready" && "bg-success",
				state === "burnt" && "bg-destructive",
				state === "cooking" && "border-2 border-warning",
				state === "needs" && "bg-(--gk-gold)",
				state === "limited" && "border-2 border-warning border-dotted",
				state === "queued" && "border-[1.5px] border-muted-foreground/70",
				state === "served" && "border border-muted-foreground/60 border-dashed",
				className
			)}
		/>
	);
}

/**
 * Circular progress: a track and an arc that fills clockwise from twelve,
 * in the cooking (warning) tone. Past the usual time the arc stays full and
 * dashes, so "over" reads without a new colour; an estimate draws its
 * track hatched and its arc faded, so it never reads as exact.
 */
export function CookRing({
	className,
	estimate = false,
	fraction,
	over,
	size = 16,
	stroke = 2.5,
}: {
	className?: string;
	/** An estimate (a routine's usual run time): hatched track, faded arc. */
	estimate?: boolean;
	fraction: number;
	over: boolean;
	size?: number;
	stroke?: number;
}) {
	const radius = (size - stroke) / 2;
	const length = 2 * Math.PI * radius;
	const shown = over ? 1 : Math.max(0.04, Math.min(1, fraction));
	return (
		<svg
			aria-hidden="true"
			className={cn("shrink-0 -rotate-90", className)}
			height={size}
			viewBox={`0 0 ${size} ${size}`}
			width={size}
		>
			<circle
				className={cn("stroke-warning", estimate ? "opacity-60" : "opacity-25")}
				cx={size / 2}
				cy={size / 2}
				fill="none"
				r={radius}
				strokeDasharray={
					estimate ? `${(length / 16) * 0.5} ${(length / 16) * 0.5}` : undefined
				}
				strokeWidth={stroke}
			/>
			<circle
				className={cn(
					"stroke-warning transition-[stroke-dashoffset] duration-700 ease-linear motion-reduce:transition-none",
					// A guess reads lighter than a measured run.
					estimate && "opacity-55"
				)}
				cx={size / 2}
				cy={size / 2}
				fill="none"
				r={radius}
				strokeDasharray={
					over ? `${(length / 8) * 0.7} ${(length / 8) * 0.3}` : length
				}
				strokeDashoffset={over ? 0 : length * (1 - shown)}
				strokeLinecap="round"
				strokeWidth={stroke}
			/>
		</svg>
	);
}

/** `14:05` in the viewer's locale (24 or 12 hour as they prefer). */
export function clockTime(now: number): string {
	return new Date(now).toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}
