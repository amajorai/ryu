import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	BellRing,
	ChefHat,
	ChevronLeft,
	ChevronRight,
	CookingPot,
	Flame,
	HandPlatter,
	Plus,
	Utensils,
} from "lucide-react";
import {
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameAction,
	GameCounter,
	GameCounters,
	GameIconButton,
	GameTitlePlate,
	gameTitleHeight,
} from "./game-hud.tsx";
import type { ActTotals } from "./game3d-acts.ts";
import { ChefAvatar } from "./kitchen-avatar.tsx";
import { DishGlyph } from "./kitchen-dish.tsx";
import { useNow } from "./kitchen-hooks.ts";
import {
	askPatience,
	cookProgress,
	type KitchenService,
	type KitchenTicket,
	plural,
	readyPatience,
	TICKET_LABELS,
	type TicketAct,
	type TicketState,
	ticketLabel,
	ticketTimer,
} from "./kitchen-model.ts";
import type { KitchenPalette } from "./kitchen-palette.ts";
import { CookRing, clockTime, StateMark } from "./kitchen-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActNow } from "./use-acts.ts";

/** A minute, for the rail and clock under reduced motion. */
const MINUTE = 60_000;

/**
 * The Kitchen HUD, on the shared game kit (game-shell.tsx): the title plate
 * top left, the order rail of paper tickets hanging from a steel bar across
 * the top, New order top right, today's tally bottom left and the service
 * clock bottom right. All of it floats over the full-bleed kitchen.
 */

/**
 * How much room the HUD has, measured on the stage (not the viewport) less
 * what an open sheet covers, so the HUD and the scene's insets always switch
 * together. Wide HUDs hang the rail between the title and New order;
 * narrower ones give it its own row.
 */
export type HudDensity = "medium" | "narrow" | "wide";

export function hudDensity(hudWidth: number): HudDensity {
	if (hudWidth < 640) {
		return "narrow";
	}
	return hudWidth < 1100 ? "medium" : "wide";
}

/** Ticket heights; the rail's height follows. */
const TICKET_HEIGHT = { medium: 132, narrow: 124, wide: 132 } as const;

/**
 * Room the HUD covers at the top and bottom, so the scene camera can frame
 * the line between them. The wall behind the rail may sit under it.
 */
export function hudInsets(
	density: HudDensity,
	withActStatus = false
): {
	bottom: number;
	top: number;
} {
	const rail = TICKET_HEIGHT[density] + 26;
	if (density === "wide") {
		return { bottom: 92, top: rail + 20 };
	}
	if (density === "narrow") {
		// The narrow title plate wraps the act summary to two lines.
		return {
			bottom: 70,
			top: 10 + gameTitleHeight(withActStatus ? 2 : 1) + 10 + rail + 8,
		};
	}
	return { bottom: 92, top: 16 + 64 + 12 + rail + 8 };
}

/** The served ticket, its chef plate and its dish all wear this. */
export const SELECTED =
	"outline-3 outline-(--gk-accent) outline-offset-2 outline-solid";

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

function TicketCard({
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
				Orders{loading ? null : `, ${rail.length}`}
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
								? `Later tickets, ${hidden.after} more`
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

/** Top left: the kitchen's name and what is going on. */
export function KitchenTitle({
	actStatus,
	density,
	service,
}: {
	/** The act layer's summary line, when the host sends asks. */
	actStatus?: string;
	density: HudDensity;
	service: KitchenService;
}) {
	const { totals } = service;
	const parts = [
		totals.ready > 0 ? `${totals.ready} ready to serve` : null,
		totals.cooking > 0 ? `${totals.cooking} cooking` : null,
		totals.burnt > 0 ? `${totals.burnt} burnt` : null,
	].filter(Boolean);
	return (
		<GameTitlePlate
			compact={density === "narrow"}
			icon={<ChefHat strokeWidth={2.25} />}
			keepStatus={actStatus !== undefined}
			status={
				actStatus ?? (parts.length > 0 ? parts.join(" · ") : "A quiet service")
			}
			title="Kitchen"
		/>
	);
}

/** Top right: the one primary action. */
export function NewOrderButton({
	density,
	disabled,
	onNewOrder,
}: {
	density: HudDensity;
	disabled: boolean;
	onNewOrder: () => void;
}) {
	return (
		<GameAction
			compact={density === "narrow"}
			disabled={disabled}
			icon={<Plus strokeWidth={3} />}
			label="New order"
			onClick={onNewOrder}
		/>
	);
}

/**
 * Bottom left: today's tally, like the reference's score counter. The
 * cooking count carries the note that its rings are estimates.
 */
export function ServiceScore({
	actTotals,
	density,
	service,
}: {
	/** The act layer's counts, when the host sends asks. */
	actTotals?: ActTotals;
	density: HudDensity;
	service: KitchenService;
}) {
	const { totals } = service;
	if (actTotals) {
		return (
			<ActServiceScore
				compact={density === "narrow"}
				servedToday={totals.servedToday}
				totals={actTotals}
			/>
		);
	}
	const compact = density === "narrow";
	const cookingChefs = service.stations.filter(
		(station) => station.working
	).length;
	const note = `${plural(cookingChefs, "chef")} cooking. Rings estimate each run against that chef's usual run time.`;
	const cookingLabel: ReactNode =
		cookingChefs > 0 && !compact ? (
			<Tooltip>
				<TooltipTrigger
					aria-label={`Cooking. ${note}`}
					className="cursor-help rounded-sm uppercase underline decoration-(--gk-ink-soft) decoration-dotted underline-offset-4 outline-none focus-visible:outline-(--gk-focus) focus-visible:outline-3 focus-visible:outline-solid"
					type="button"
				>
					Cooking
				</TooltipTrigger>
				<TooltipContent side="top">{note}</TooltipContent>
			</Tooltip>
		) : (
			"Cooking"
		);
	return (
		<GameCounters label="Service totals">
			<GameCounter
				compact={compact}
				icon={<HandPlatter strokeWidth={2.5} />}
				label={compact ? "Served" : "Served today"}
				tone="gold"
				value={totals.servedToday}
			/>
			<GameCounter
				compact={compact}
				icon={<Utensils strokeWidth={2.5} />}
				label="Ready"
				tone="good"
				value={totals.ready}
			/>
			<GameCounter
				compact={compact}
				icon={<CookingPot strokeWidth={2.5} />}
				label={cookingLabel}
				tone="warn"
				value={totals.cooking}
			/>
			{totals.burnt > 0 ? (
				<GameCounter
					compact={compact}
					icon={<Flame strokeWidth={2.5} />}
					label="Burnt"
					tone="bad"
					value={totals.burnt}
				/>
			) : null}
		</GameCounters>
	);
}

/** Today's tally with the act layer's counts (asks, cooking, burnt). */
function ActServiceScore({
	compact,
	servedToday,
	totals,
}: {
	compact: boolean;
	servedToday: number;
	totals: ActTotals;
}) {
	return (
		<GameCounters label="Service totals">
			<GameCounter
				compact={compact}
				icon={<HandPlatter strokeWidth={2.5} />}
				label={compact ? "Served" : "Served today"}
				tone="gold"
				value={servedToday}
			/>
			<GameCounter
				compact={compact}
				icon={<BellRing strokeWidth={2.5} />}
				label="Need you"
				tone="gold"
				value={totals.needYou}
			/>
			<GameCounter
				compact={compact}
				icon={<CookingPot strokeWidth={2.5} />}
				label="Cooking"
				tone="warn"
				value={totals.working}
			/>
			{totals.failed > 0 ? (
				<GameCounter
					compact={compact}
					icon={<Flame strokeWidth={2.5} />}
					label="Burnt"
					tone="bad"
					value={totals.failed}
				/>
			) : null}
		</GameCounters>
	);
}

/**
 * Bottom right: the service clock. A dial with twelve hour ticks whose ring
 * fills as the hour goes by, beside the time.
 */
export function ServiceClock() {
	// The act clock (pinned by the harness); under reduced motion the ring
	// moves with the minute.
	const now = useActNow();
	const reduced = useReducedMotion();
	const date = new Date(now);
	// Under reduced motion the ring moves with the minute, not each second.
	const minutes = date.getMinutes() + (reduced ? 0 : date.getSeconds() / 60);
	const size = 40;
	const centre = size / 2;
	const radius = 17;
	const ring = 2 * Math.PI * (radius - 2.5);
	const ticks = Array.from({ length: 12 }, (_, hour) => {
		const angle = (hour / 12) * 2 * Math.PI;
		const inner = hour % 3 === 0 ? radius - 6 : radius - 4;
		return {
			hour,
			x1: centre + Math.cos(angle) * inner,
			x2: centre + Math.cos(angle) * (radius - 2),
			y1: centre + Math.sin(angle) * inner,
			y2: centre + Math.sin(angle) * (radius - 2),
		};
	});
	return (
		<section
			aria-label="Service clock"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex items-center gap-3 py-2 ps-2.5 pe-4"
			)}
		>
			<svg
				aria-hidden="true"
				className="block shrink-0 -rotate-90"
				height={size}
				viewBox={`0 0 ${size} ${size}`}
				width={size}
			>
				<circle
					cx={centre}
					cy={centre}
					fill="var(--gk-plate-sunk)"
					r={radius}
					stroke="var(--gk-edge)"
					strokeWidth={2}
				/>
				<circle
					cx={centre}
					cy={centre}
					fill="none"
					r={radius - 2.5}
					stroke="var(--gk-accent)"
					strokeDasharray={ring}
					strokeDashoffset={ring * (1 - minutes / 60)}
					strokeWidth={3}
				/>
				{ticks.map((tick) => (
					<line
						key={`tick-${tick.hour.toString()}`}
						stroke={
							tick.hour % 3 === 0 ? "var(--gk-edge)" : "var(--gk-ink-soft)"
						}
						strokeLinecap="round"
						strokeWidth={tick.hour % 3 === 0 ? 2 : 1.25}
						x1={tick.x1}
						x2={tick.x2}
						y1={tick.y1}
						y2={tick.y2}
					/>
				))}
				<circle cx={centre} cy={centre} fill="var(--gk-edge)" r={2} />
			</svg>
			<div className="flex flex-col-reverse">
				<span className="font-semibold text-(--gk-ink-muted) text-[12px] uppercase leading-4 tracking-wide">
					Service
				</span>
				<time
					className="gk-display whitespace-nowrap text-[26px] tabular-nums leading-7"
					dateTime={date.toISOString()}
				>
					{clockTime(now)}
				</time>
			</div>
		</section>
	);
}
