import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { Plane, X } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, type Ref, useEffect, useRef } from "react";
import { LAMP_TEXT, StatusLamp } from "./departures-board.tsx";
import { BookingForm, type BookingInput } from "./departures-booking.tsx";
import {
	FLIGHT_LAMPS,
	FLIGHT_STATUS_LABELS,
	type Flight,
	type FlightLamp,
	flightProgress,
	flightTimeline,
	type TimelineStep,
} from "./departures-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** How many of a gate's flights the booking panel lists. */
const GATE_FLIGHTS_SHOWN = 6;

/** Small caps shared with the board's labels. */
const EYEBROW =
	"font-medium font-mono text-[11px] uppercase leading-4 tracking-[0.12em]";

/** Timeline markers use the theme's own signals, not the board's lamps. */
const STEP_MARKER: Record<FlightLamp, string> = {
	alert: "bg-destructive",
	go: "bg-success",
	hold: "bg-warning",
	idle: "border border-muted-foreground bg-background",
	off: "bg-muted-foreground",
};

/**
 * Outside the board the lamps and status words take the theme's own signals,
 * at the strength the theme prints status text with.
 */
const PANEL_LAMPS =
	"[--dep-alert:var(--status-destructive)] [--dep-go:var(--status-success)] [--dep-hold:var(--status-warning)] [--dep-ink:var(--foreground)] [--dep-ink-dim:var(--muted-foreground)] [--dep-ink-faint:var(--muted-foreground)]";

/** Where the plane sits on the route line, 0 (origin) to 1 (destination). */
function planePosition(flight: Flight, now: number): number {
	switch (flight.status) {
		case "scheduled":
		case "boarding":
			return 0;
		case "in-flight":
			return flightProgress(flight, now) ?? 0.5;
		case "delayed":
			return 0.5;
		default:
			return 1;
	}
}

/** One end of the route, printed the way a boarding pass prints a city. */
function RouteEnd({
	align,
	label,
	name,
}: {
	align: "end" | "start";
	label: string;
	name: string;
}) {
	return (
		<div
			className={cn(
				"flex min-w-0 max-w-[40%] shrink-0 flex-col gap-1",
				align === "end" && "items-end text-right"
			)}
		>
			<span className="font-medium text-muted-foreground text-xs uppercase leading-4 tracking-[0.08em]">
				{label}
			</span>
			<span className="truncate font-mono font-semibold text-foreground text-xl uppercase leading-7 tracking-tight">
				{name}
			</span>
		</div>
	);
}

function TimelineRow({ last, step }: { last: boolean; step: TimelineStep }) {
	return (
		<li className="relative flex gap-3 pb-4 last:pb-0">
			{last ? null : (
				<span
					aria-hidden="true"
					className="absolute top-3 bottom-0 left-[3.5px] w-px bg-border"
				/>
			)}
			<span
				aria-hidden="true"
				className={cn(
					"relative mt-1.5 size-2 shrink-0 rounded-full",
					STEP_MARKER[step.tone]
				)}
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-baseline justify-between gap-3">
					<span
						className={cn(
							"font-medium text-sm",
							step.state === "next"
								? "text-muted-foreground"
								: "text-foreground"
						)}
					>
						{step.label}
					</span>
					{step.time ? (
						<span
							className={cn(
								"shrink-0 font-mono text-xs tabular-nums",
								step.state === "next"
									? "text-muted-foreground"
									: "text-foreground"
							)}
						>
							{step.time}
						</span>
					) : null}
				</div>
				{step.detail ? (
					<span className="truncate text-muted-foreground text-xs">
						{step.detail}
					</span>
				) : null}
			</div>
		</li>
	);
}

/**
 * The flight details card: a boarding-pass route from you to the gate agent
 * (reversed on Arrivals, since the reply is flying back to you), the plane
 * placed by progress, and the trip's timeline.
 */
function FlightCard({
	flight,
	now,
	snapshot,
}: {
	flight: Flight;
	now: number;
	snapshot: InterfaceSnapshot;
}) {
	const reduceMotion = useReducedMotion();
	const agent = flight.gateAgentId
		? snapshot.agents.find((candidate) => candidate.id === flight.gateAgentId)
		: undefined;
	const you = "You";
	const gate = agent?.name ?? "No gate";
	const [origin, destination] =
		flight.board === "departures" ? [you, gate] : [gate, you];
	const position = planePosition(flight, now);
	const steps = flightTimeline(flight, now);
	return (
		<section
			aria-label="Flight details"
			className="flex flex-col gap-5 border-border border-b px-4 py-4"
		>
			<div className="flex items-start gap-4">
				<RouteEnd align="start" label="From" name={origin} />
				<div aria-hidden="true" className="relative mt-5 h-7 min-w-12 flex-1">
					<span className="absolute inset-x-0 top-1/2 border-border border-t border-dashed" />
					<span
						className="absolute top-1/2 left-0 h-px bg-foreground/60"
						style={{ width: `${position * 100}%` }}
					/>
					<motion.span
						animate={{ left: `${position * 100}%` }}
						className="absolute top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background"
						initial={false}
						transition={reduceMotion ? { duration: 0 } : { duration: 0.4 }}
					>
						<Plane
							className={cn(
								"size-4 rotate-45 text-foreground",
								flight.status === "delayed" && "text-status-destructive"
							)}
							strokeWidth={1.75}
						/>
					</motion.span>
				</div>
				<RouteEnd align="end" label="To" name={destination} />
			</div>
			<ol aria-label="Timeline" className="flex flex-col">
				{steps.map((step, position) => (
					<TimelineRow
						key={step.key}
						last={position === steps.length - 1}
						step={step}
					/>
				))}
			</ol>
		</section>
	);
}

/**
 * A gate's recent flights, listed under the booking form so the panel shows
 * what that agent is already carrying. Each one opens like a board row.
 */
function GateFlights({
	agentId,
	flights,
	onOpen,
	snapshot,
}: {
	agentId: string | undefined;
	flights: readonly Flight[];
	onOpen: (flight: Flight) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	if (!agentId) {
		return null;
	}
	const gate =
		snapshot.agents.find((agent) => agent.id === agentId)?.name ?? "this gate";
	const listed = flights
		.filter((flight) => flight.gateAgentId === agentId)
		.sort((a, b) => b.time - a.time)
		.slice(0, GATE_FLIGHTS_SHOWN);
	return (
		<section
			aria-label={tl("Recent flights at {gate}", { gate })}
			className="flex min-h-0 flex-col border-border border-t"
		>
			<h3
				className={cn(
					"flex h-10 shrink-0 items-center px-4 text-muted-foreground",
					EYEBROW
				)}
			>
				{tl("Recent at {gate}", { gate })}
			</h3>
			{listed.length === 0 ? (
				<p className="px-4 pb-4 text-muted-foreground text-sm">
					No flights from this gate yet.
				</p>
			) : (
				<ul className="flex min-h-0 flex-col overflow-y-auto pb-2">
					{listed.map((flight) => (
						<li key={flight.key}>
							<button
								className="flex h-10 w-full items-center gap-3 px-4 text-left outline-none transition-colors duration-100 hover:bg-muted focus-visible:bg-muted focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]"
								onClick={() => onOpen(flight)}
								type="button"
							>
								<span className="w-16 shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
									{flight.flightNumber}
								</span>
								<span className="min-w-0 flex-1 truncate text-foreground text-sm">
									{flight.title}
								</span>
								<span
									className={cn(
										"flex shrink-0 items-center gap-1.5",
										EYEBROW,
										LAMP_TEXT[FLIGHT_LAMPS[flight.status]]
									)}
								>
									<StatusLamp
										className="size-1.5"
										dim={flight.parked}
										status={flight.status}
									/>
									{FLIGHT_STATUS_LABELS[flight.status]}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/**
 * The side panel. For a conversation it is the flight details card over the
 * host's real conversation surface; for a scheduled run (which has no
 * conversation yet) it offers to book a flight with that gate; and "Book a
 * flight" opens it with just the booking form.
 */
export function DeparturesPanel({
	booking,
	flight,
	flights,
	headingRef,
	now,
	onBook,
	onClose,
	onOpen,
	snapshot,
	threadView,
}: {
	booking: boolean;
	flight: Flight | undefined;
	/** Every flight on both boards, for the gate's recent flights. */
	flights: readonly Flight[];
	headingRef: Ref<HTMLHeadingElement>;
	now: number;
	onBook: (input: BookingInput) => void;
	onClose: () => void;
	onOpen: (flight: Flight) => void;
	snapshot: InterfaceSnapshot;
	threadView: ReactNode | null;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (booking) {
			fieldRef.current?.focus({ preventScroll: true });
		}
	}, [booking]);
	const title = booking ? "Book a flight" : (flight?.title ?? "Flight");
	const subtitle = booking
		? "Starts a conversation with the gate you pick"
		: [flight?.gateLabel ? `Gate ${flight.gateLabel}` : null, flight?.terminal]
				.filter(Boolean)
				.join(" · ");
	const showThread = !booking && threadView !== null;
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={booking ? title : tl("Flight details: {title}", { title })}
			className={cn(
				"absolute inset-0 z-20 flex min-h-0 flex-col bg-background md:static md:w-88 md:shrink-0 md:border-border md:border-l lg:w-[clamp(24rem,34vw,34rem)]",
				PANEL_LAMPS
			)}
			data-testid="departures-panel"
			initial={reduceMotion ? false : { opacity: 0, x: 16 }}
			transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
		>
			{/*
			 * The board's inset (3) plus its masthead (24), and the rule's own
			 * pixel, so this rule continues the board's column-header rule.
			 */}
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4 md:h-[calc(--spacing(27)+1px)] md:items-start md:pt-5">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<p
						className={cn(
							"flex min-w-0 items-center gap-2 text-muted-foreground max-md:hidden",
							EYEBROW
						)}
					>
						{flight && !booking ? (
							<>
								<StatusLamp
									className="size-1.5"
									dim={flight.parked}
									status={flight.status}
								/>
								<span className="text-foreground">{flight.flightNumber}</span>
								<span aria-hidden="true">·</span>
								<span className={LAMP_TEXT[FLIGHT_LAMPS[flight.status]]}>
									{FLIGHT_STATUS_LABELS[flight.status]}
								</span>
							</>
						) : (
							"New flight"
						)}
					</p>
					<h2
						className="truncate font-semibold text-base text-foreground leading-6 outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					{subtitle ? (
						<p className="truncate text-muted-foreground text-xs leading-4">
							{flight && !booking ? (
								<span
									className={cn(
										"font-medium md:hidden",
										LAMP_TEXT[FLIGHT_LAMPS[flight.status]]
									)}
								>
									{flight.flightNumber} · {FLIGHT_STATUS_LABELS[flight.status]}
									{" · "}
								</span>
							) : null}
							{subtitle}
						</p>
					) : null}
				</div>
				<Button
					aria-label={booking ? "Close booking" : "Close flight details"}
					onClick={onClose}
					size="icon-sm"
					title="Close (Esc)"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			{flight && !booking ? (
				<FlightCard flight={flight} now={now} snapshot={snapshot} />
			) : null}
			{showThread ? (
				<div className="min-h-0 flex-1">{threadView}</div>
			) : (
				<div className="flex min-h-0 flex-1 flex-col">
					{booking || !flight ? null : (
						<div className="flex flex-col gap-1 px-4 pt-4">
							<h3 className="font-medium text-foreground text-sm">
								Book a flight
							</h3>
							<p className="text-muted-foreground text-xs">
								{flight.status === "scheduled"
									? "Scheduled runs open their conversation when they leave."
									: "Routine runs have no conversation. Write to the gate to follow up."}
							</p>
						</div>
					)}
					<BookingForm
						agents={snapshot.agents}
						defaultAgentId={flight?.gateAgentId}
						fieldRef={fieldRef}
						groups={snapshot.groups}
						onSubmit={onBook}
						renderGate={(agentId) => (
							<GateFlights
								agentId={agentId}
								flights={flights}
								onOpen={onOpen}
								snapshot={snapshot}
							/>
						)}
					/>
				</div>
			)}
		</motion.aside>
	);
}
