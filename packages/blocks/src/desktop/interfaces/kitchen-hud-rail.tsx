import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
	type CSSProperties,
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { GAME_PLATE, GameIconButton } from "./game-hud.tsx";
import { type HudDensity, TICKET_HEIGHT } from "./kitchen-hud-layout.ts";
import { TicketCard } from "./kitchen-hud-ticket.tsx";
import type {
	KitchenService,
	KitchenTicket,
	TicketAct,
} from "./kitchen-model.ts";
import type { KitchenPalette } from "./kitchen-palette.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** How many tickets sit past each edge of the rail's visible area. */
function useRailOverflow(
	list: RefObject<HTMLOListElement | null>,
	count: number
) {
	const [hidden, setHidden] = useState({ after: 0, before: 0 });
	useEffect(() => {
		const element = list.current;
		if (!element || count === 0) {
			setHidden({ after: 0, before: 0 });
			return;
		}
		const measure = () => {
			const left = element.scrollLeft;
			const right = left + element.clientWidth;
			let before = 0;
			let after = 0;
			for (const child of element.children) {
				if (!(child instanceof HTMLElement)) {
					continue;
				}
				const start = child.offsetLeft - element.offsetLeft;
				const end = start + child.offsetWidth;
				// A ticket counts as hidden once most of it is out of view.
				if (end - child.offsetWidth / 3 > right) {
					after += 1;
				} else if (start + child.offsetWidth / 3 < left) {
					before += 1;
				}
			}
			setHidden((previous) =>
				previous.after === after && previous.before === before
					? previous
					: { after, before }
			);
		};
		measure();
		element.addEventListener("scroll", measure, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		observer?.observe(element);
		return () => {
			element.removeEventListener("scroll", measure);
			observer?.disconnect();
		};
	}, [count, list]);
	return hidden;
}

/** Ticket width the rail aims for, and the gap between tickets. */
const TICKET_WIDTH = 188;
const TICKET_GAP = 12;
/** The rail's `p-1` on each side (room for focus rings). */
const RAIL_PADDING = 4;

/**
 * Sizes tickets so a whole number of them fills the rail: no ticket is cut
 * at either edge, and a snapped scroll always lands on a ticket's start.
 */
function useTicketWidth(
	list: RefObject<HTMLOListElement | null>,
	count: number,
	minimum: number
): number {
	const [width, setWidth] = useState(TICKET_WIDTH);
	useEffect(() => {
		const element = list.current;
		if (!element || count === 0 || typeof ResizeObserver === "undefined") {
			return;
		}
		const measure = () => {
			const content = element.clientWidth - RAIL_PADDING * 2;
			if (content <= 0) {
				return;
			}
			const fits = Math.max(
				minimum,
				Math.floor((content + TICKET_GAP) / (TICKET_WIDTH + TICKET_GAP))
			);
			const next = (content - TICKET_GAP * (fits - 1)) / fits;
			setWidth((previous) => (previous === next ? previous : next));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [count, list, minimum]);
	return width;
}

/**
 * The order rail: a steel bar with one paper ticket per open conversation,
 * what needs you first (ready, then burnt), then what is cooking and what
 * is waiting on a chef. Arrow keys move between tickets; Enter serves one.
 * Round buttons at the ends page through tickets that do not fit.
 */
export function OrderRail({
	activeThreadId,
	className,
	density,
	headingRef,
	hoverId,
	loading,
	onHover,
	onServe,
	palette,
	service,
	showEmptyRail = true,
	ticketActs = null,
}: {
	activeThreadId: string | null;
	className?: string;
	density: HudDensity;
	/** The game's fallback focus heading ("Orders"), focusable by script. */
	headingRef?: RefObject<HTMLHeadingElement | null>;
	hoverId: string | null;
	loading: boolean;
	onHover: (id: string | null) => void;
	onServe: (id: string) => void;
	palette: KitchenPalette;
	service: KitchenService;
	/** False when the stage itself explains the empty kitchen. */
	showEmptyRail?: boolean;
	/**
	 * The act layer's rail (tickets in act order) and each ticket's view;
	 * null for an old host.
	 */
	ticketActs?: {
		rail: readonly KitchenTicket[];
		views: ReadonlyMap<string, TicketAct>;
	} | null;
}) {
	const tl = useLiteralMessages();
	const rail = ticketActs?.rail ?? service.rail;
	const list = useRef<HTMLOListElement>(null);
	const reduced = useReducedMotion();
	const count = loading ? 0 : rail.length;
	const hidden = useRailOverflow(list, count);
	const narrow = density === "narrow";
	const ticketWidth = useTicketWidth(list, count, narrow ? 2 : 1);
	const height = TICKET_HEIGHT[density];
	// Keep the served ticket in view, however it was opened.
	useEffect(() => {
		if (!activeThreadId) {
			return;
		}
		const current = list.current?.querySelector("[aria-current='true']");
		current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [activeThreadId, ticketWidth]);
	const typical = new Map(
		service.stations.map((station) => [station.agent.id, station.typicalMs])
	);
	const page = (direction: -1 | 1) => {
		const element = list.current;
		if (!element) {
			return;
		}
		element.scrollBy({
			behavior: reduced ? "auto" : "smooth",
			// A page is every whole ticket on screen, so it lands on a start.
			left: direction * (element.clientWidth - RAIL_PADDING * 2 + TICKET_GAP),
		});
	};
	const onFocusMove = (event: KeyboardEvent<HTMLButtonElement>) => {
		const keys: Record<string, number> = {
			ArrowLeft: -1,
			ArrowRight: 1,
			End: Number.POSITIVE_INFINITY,
			Home: Number.NEGATIVE_INFINITY,
		};
		const step = keys[event.key];
		if (step === undefined || !list.current) {
			return;
		}
		const buttons = [...list.current.querySelectorAll("button")];
		const index = buttons.indexOf(event.currentTarget);
		const next = Math.max(
			0,
			Math.min(buttons.length - 1, Number.isFinite(step) ? index + step : step)
		);
		const target = buttons[Number.isFinite(next) ? next : 0];
		event.preventDefault();
		target?.focus();
		target?.scrollIntoView({ block: "nearest", inline: "nearest" });
	};
	const scrollable = hidden.after > 0 || hidden.before > 0;
	return (
		<nav
			aria-label="Order rail"
			className={cn("relative flex min-w-0 items-start gap-2", className)}
		>
			{/* The steel bar the tickets hang from. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 top-[13px] h-3 rounded-full border-(--gk-edge) border-2 bg-(--gk-paper-edge) shadow-[0_3px_0_var(--gk-edge)]"
			/>
			<h2 className="sr-only" ref={headingRef} tabIndex={-1}>
				{loading
					? tl("Orders")
					: tl("Orders, {count}", { count: String(rail.length) })}
			</h2>
			{scrollable ? (
				<div className="relative z-10 mt-9 shrink-0">
					<GameIconButton
						disabled={hidden.before === 0}
						label="Earlier tickets"
						onClick={() => page(-1)}
					>
						<ChevronLeft
							aria-hidden="true"
							className="size-5"
							strokeWidth={2.5}
						/>
					</GameIconButton>
				</div>
			) : null}
			{loading ? (
				<div
					aria-hidden="true"
					className="flex min-w-0 flex-1 gap-3 overflow-hidden pt-3"
				>
					{[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
						<Skeleton
							className="w-44 shrink-0 rounded-md bg-(--gk-paper)/70"
							key={`ticket-skeleton-${index.toString()}`}
							style={{ height }}
						/>
					))}
				</div>
			) : null}
			{!loading && showEmptyRail && rail.length === 0 ? (
				<p
					className={cn(
						GAME_PLATE,
						"pointer-events-auto relative mt-6 flex w-fit items-center px-4 py-3 font-semibold text-(--gk-ink-muted) text-sm"
					)}
				>
					No open orders. New conversations hang here as tickets.
				</p>
			) : null}
			{!loading && rail.length > 0 ? (
				<ol
					aria-label="Tickets"
					className="pointer-events-auto relative -mx-1 flex min-w-0 flex-1 snap-x snap-mandatory scroll-px-1 gap-3 overflow-x-auto px-1 pb-3 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					ref={list}
					style={{ "--ticket-width": `${ticketWidth}px` } as CSSProperties}
					tabIndex={-1}
				>
					{rail.map((ticket, index) => (
						<TicketCard
							act={
								ticketActs ? (ticketActs.views.get(ticket.id) ?? null) : null
							}
							active={ticket.id === activeThreadId}
							compact={narrow}
							height={height}
							hovered={ticket.id === hoverId}
							index={index}
							key={ticket.id}
							onFocusMove={onFocusMove}
							onHover={onHover}
							onServe={onServe}
							palette={palette}
							ticket={ticket}
							typicalMs={typical.get(ticket.chef?.id ?? "") ?? 0}
						/>
					))}
				</ol>
			) : null}
			{scrollable ? (
				<div className="relative z-10 mt-9 flex shrink-0 flex-col items-center gap-1.5">
					<GameIconButton
						disabled={hidden.after === 0}
						label={
							hidden.after > 0
								? tl("Later tickets, {count} more", {
										count: String(hidden.after),
									})
								: "Later tickets"
						}
						onClick={() => page(1)}
					>
						<ChevronRight
							aria-hidden="true"
							className="size-5"
							strokeWidth={2.5}
						/>
					</GameIconButton>
					<span
						aria-live="polite"
						className={cn(
							"gk-display rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-2 text-(--gk-ink) text-[13px] tabular-nums leading-5",
							hidden.after === 0 && "invisible"
						)}
					>
						{hidden.after > 0 ? `+${hidden.after}` : "End"}
					</span>
				</div>
			) : null}
		</nav>
	);
}
