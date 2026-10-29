import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { PlaneLanding, PlaneTakeoff, Plus } from "lucide-react";
import { motion } from "motion/react";
import {
	Fragment,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	type RefObject,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	BlankFlap,
	BlankFlapText,
	Flap,
	FlapText,
} from "./departures-flap.tsx";
import {
	BLINKING_STATUSES,
	BOARD_LABELS,
	boardDate,
	boardTime,
	DEPARTURES_BOARDS,
	type DeparturesBoard,
	FLIGHT_LAMPS,
	FLIGHT_STATUS_CODES,
	FLIGHT_STATUS_LABELS,
	type Flight,
	type FlightLamp,
	flightAccessibleName,
	STATUS_FLAP_LENGTH,
} from "./departures-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** Seconds between one row starting to flip and the next. */
const ROW_STAGGER_SECONDS = 0.035;
/** How long one lamp blink takes, dim and back. */
const LAMP_BLINK_SECONDS = 1.6;

/**
 * Column slots shared by the header and every row, so edges line up. The
 * board sizes itself by its own width (container queries). Destination comes
 * first and keeps about 40 characters wherever the board can give them; as
 * the board narrows it gives up, in order: Terminal, Gate (the panel names
 * it), the spelled-out status (a three-letter code and the lamp remain),
 * then Remarks, then the flight number. Remarks outlive Gate because they
 * carry the ETA, the airborne time and the failure reason.
 */
export const COLUMN = {
	// Seven 18px flaps and their 1px gaps.
	flight: "hidden w-[132px] shrink-0 @2xl:flex",
	gate: "hidden w-28 shrink-0 @7xl:flex",
	remarks: "hidden w-40 shrink-0 @3xl:flex @5xl:w-52 @7xl:w-64",
	// The lamp, its gap, and three flaps; nine flaps on a wide board.
	status: "flex w-[74px] shrink-0 items-center gap-2.5 @6xl:w-[188px]",
	terminal: "hidden w-32 shrink-0 @[88rem]:flex",
	// Five 18px flaps and their 1px gaps.
	time: "flex w-[94px] shrink-0",
	title: "flex min-w-0 flex-1",
} as const;

export const LAMP_COLOR: Record<FlightLamp, string> = {
	alert: "bg-(--dep-alert)",
	go: "bg-(--dep-go)",
	hold: "bg-(--dep-hold)",
	idle: "border border-(--dep-ink-faint)",
	off: "bg-(--dep-ink-faint)",
};

export const LAMP_TEXT: Record<FlightLamp, string> = {
	alert: "text-(--dep-alert)",
	go: "text-(--dep-go)",
	hold: "text-(--dep-hold)",
	idle: "text-(--dep-ink)",
	off: "text-(--dep-ink-dim)",
};

const ROW_GRID = "flex items-center gap-4 px-4 @5xl:gap-5 @5xl:px-5";
/** Every board row, live or spare, is one 48px module. */
export const ROW_HEIGHT_PX = 48;
const SMALL_CAPS =
	"font-medium font-mono text-[11px] uppercase tracking-[0.12em]";

/** Whether a flight's lamp blinks: boarding and fresh landings, not held ones. */
export function lampBlinks(flight: Flight): boolean {
	return BLINKING_STATUSES.has(flight.status) && flight.section.key !== "held";
}

/**
 * The status lamp: shape and color both carry the status. A blinking lamp
 * dims to just over half and back, so it is never darker than its word.
 */
export function StatusLamp({
	blink = false,
	className,
	dim = false,
	status,
}: {
	blink?: boolean;
	className?: string;
	/** A reply left waiting a long time: still lit, at half strength. */
	dim?: boolean;
	status: Flight["status"];
}) {
	const reduceMotion = useReducedMotion();
	const animated = blink && !reduceMotion;
	return (
		<motion.span
			animate={
				animated ? { opacity: [1, 0.55, 1] } : { opacity: dim ? 0.5 : 1 }
			}
			aria-hidden="true"
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				LAMP_COLOR[FLIGHT_LAMPS[status]],
				className
			)}
			initial={false}
			transition={
				animated
					? {
							duration: LAMP_BLINK_SECONDS,
							ease: "easeInOut",
							repeat: Number.POSITIVE_INFINITY,
						}
					: { duration: 0 }
			}
		/>
	);
}

/** Spoken with the board tabs: how to switch, and how to reach the rows. */
const TAB_HINT = "Left and Right switch board. Down moves to the flights.";

/**
 * Title band. The title is the board switch: the board showing is lit and
 * the other is printed dim beside it, the way a FIDS header alternates its
 * languages. Book a flight and the big flap clock sit on the right. The band
 * has a fixed height (h-24) so the panel beside the board can rule off at
 * the same line; its first line (titles, button, clock flaps) and second line
 * (summary, date) each share one centre.
 */
export function BoardMasthead({
	airborne,
	board,
	boardId,
	count,
	loading,
	now,
	onBook,
	onEnterRows,
	onSwitch,
}: {
	airborne: number;
	board: DeparturesBoard;
	/** The grid the tabs control. */
	boardId: string;
	count: number;
	loading: boolean;
	now: number;
	onBook: () => void;
	/** ArrowDown on a tab: move focus to the board's cursor row. */
	onEnterRows: () => void;
	onSwitch: (board: DeparturesBoard, focusTab: boolean) => void;
}) {
	const hintId = useId();
	const Icon = board === "departures" ? PlaneTakeoff : PlaneLanding;
	const summary = loading
		? "Updating"
		: [
				`${count} ${count === 1 ? "flight" : "flights"}`,
				board === "departures" && airborne > 0 ? `${airborne} in flight` : null,
			]
				.filter(Boolean)
				.join(" · ");
	const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			onEnterRows();
			return;
		}
		const keys: Record<string, DeparturesBoard> = {
			ArrowLeft: "departures",
			ArrowRight: "arrivals",
			End: "arrivals",
			Home: "departures",
		};
		const next = keys[event.key];
		if (next) {
			event.preventDefault();
			onSwitch(next, true);
		}
	};
	const line = "flex h-8 items-center @lg:h-10";
	return (
		<div className="flex h-24 shrink-0 items-start gap-4 @5xl:px-5 px-4 @lg:pt-2 pt-3">
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<div className={cn(line, "min-w-0 gap-3")}>
					<Icon
						aria-hidden="true"
						className="@2xl:block hidden size-6 shrink-0 text-(--dep-ink)"
						strokeWidth={1.75}
					/>
					<span className="sr-only" id={hintId}>
						{TAB_HINT}
					</span>
					<div
						aria-label="Board"
						className="flex min-w-0 items-center @2xl:gap-6 gap-4"
						role="tablist"
					>
						{DEPARTURES_BOARDS.map((candidate) => {
							const selected = candidate === board;
							return (
								<button
									aria-controls={selected ? boardId : undefined}
									aria-describedby={hintId}
									aria-selected={selected}
									className={cn(
										"truncate font-semibold @2xl:text-2xl text-lg uppercase leading-none @2xl:tracking-[0.08em] tracking-[0.04em] decoration-(--dep-focus) decoration-2 underline-offset-[7px] outline-none transition-colors duration-150 focus-visible:underline",
										selected
											? "text-(--dep-ink)"
											: "text-(--dep-ink-faint) hover:text-(--dep-ink-dim)"
									)}
									data-board={candidate}
									key={candidate}
									onClick={() => onSwitch(candidate, false)}
									onKeyDown={onTabKeyDown}
									role="tab"
									tabIndex={selected ? 0 : -1}
									type="button"
								>
									{BOARD_LABELS[candidate]}
								</button>
							);
						})}
					</div>
				</div>
				<p
					className={cn("truncate @2xl:pl-9 text-(--dep-ink-dim)", SMALL_CAPS)}
				>
					{summary}
				</p>
			</div>
			<div className={line}>
				<Button
					aria-label="Book a flight"
					className={cn(
						"h-8 gap-2 rounded-md border border-(--dep-rule) bg-transparent @2xl:px-3 px-2 text-(--dep-ink) hover:bg-(--dep-row-hover) hover:text-(--dep-ink) focus-visible:border-(--dep-focus) focus-visible:ring-(--dep-focus)/40 active:bg-(--dep-row-active) dark:active:bg-(--dep-row-active) dark:hover:bg-(--dep-row-hover)",
						SMALL_CAPS
					)}
					onClick={onBook}
					type="button"
					variant="ghost"
				>
					<Plus aria-hidden="true" className="size-3.5" />
					<span className="@2xl:inline hidden">Book a flight</span>
				</Button>
			</div>
			<time
				aria-label={`${boardDate(now)}, ${boardTime(now)}`}
				className="@md:flex hidden shrink-0 flex-col items-end gap-2 @2xl:border-(--dep-rule) @2xl:border-l @2xl:pl-5"
				dateTime={new Date(now).toISOString()}
			>
				<FlapText
					className={cn(line, "font-mono font-semibold @lg:text-2xl text-xl")}
					flipIn={false}
					length={5}
					tileClassName="@lg:h-10 h-8 @lg:w-7 w-6"
					value={boardTime(now)}
				/>
				<span className={cn("text-(--dep-ink-dim) leading-4", SMALL_CAPS)}>
					{boardDate(now)}
				</span>
			</time>
		</div>
	);
}

/** Column labels, in the board's own small caps. */
export function BoardColumnHeader({
	board,
	showTerminal,
}: {
	board: DeparturesBoard;
	showTerminal: boolean;
}) {
	return (
		<div
			className={cn(
				ROW_GRID,
				"h-8 shrink-0 border-(--dep-rule) border-y text-(--dep-ink-dim)",
				SMALL_CAPS
			)}
			role="row"
		>
			<span className={COLUMN.time} role="columnheader">
				Time
			</span>
			<span className={COLUMN.flight} role="columnheader">
				Flight
			</span>
			<span className={COLUMN.title} role="columnheader">
				{board === "departures" ? "Destination" : "From"}
			</span>
			<span className={COLUMN.gate} role="columnheader">
				Gate
			</span>
			{showTerminal ? (
				<span className={COLUMN.terminal} role="columnheader">
					Terminal
				</span>
			) : null}
			<span className={COLUMN.status} role="columnheader">
				Status
			</span>
			<span className={COLUMN.remarks} role="columnheader">
				Remarks
			</span>
		</div>
	);
}

/**
 * A day divider, printed across the board the way a FIDS screen heads
 * next-day departures. It is a row of its own, so the grid stays one table.
 */
export function BoardDayRow({ label }: { label: string }) {
	return (
		<div
			className={cn(
				ROW_GRID,
				"h-8 shrink-0 border-(--dep-rule) border-y bg-(--dep-board) text-(--dep-ink)",
				SMALL_CAPS
			)}
			role="row"
		>
			<span aria-colspan={7} className="truncate" role="gridcell">
				{label}
			</span>
		</div>
	);
}

function Remarks({ flight }: { flight: Flight }) {
	const lamp = FLIGHT_LAMPS[flight.status];
	return (
		<span className="truncate">
			{flight.remarkParts.map((part, position) => (
				<Fragment key={part.text}>
					{position > 0 ? (
						<span className="text-(--dep-ink-faint)"> · </span>
					) : null}
					<span className={part.emphasis ? LAMP_TEXT[lamp] : undefined}>
						{part.text}
					</span>
				</Fragment>
			))}
		</span>
	);
}

export function FlightRow({
	active,
	flight,
	index,
	onActivate,
	onFocusRow,
	onKeyDown,
	rowRef,
	selected,
	showTerminal,
}: {
	/** The flight whose conversation is open in the panel. */
	active: boolean;
	flight: Flight;
	index: number;
	onActivate: (flight: Flight) => void;
	onFocusRow: (flight: Flight) => void;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>, flight: Flight) => void;
	rowRef?: Ref<HTMLDivElement>;
	/** The roving keyboard position: the one row in the tab order. */
	selected: boolean;
	showTerminal: boolean;
}) {
	const delay = Math.min(index, 14) * ROW_STAGGER_SECONDS;
	const lamp = FLIGHT_LAMPS[flight.status];
	return (
		<div
			aria-current={active ? "true" : undefined}
			aria-label={flightAccessibleName(flight)}
			aria-selected={selected}
			className={cn(
				ROW_GRID,
				"group relative h-12 shrink-0 cursor-pointer font-mono font-semibold text-[15px] outline-none transition-colors duration-100",
				index % 2 === 1 ? "bg-(--dep-row-alt)" : "bg-(--dep-board)",
				"hover:bg-(--dep-row-hover)",
				active && "bg-(--dep-row-active) hover:bg-(--dep-row-active)",
				"focus-visible:bg-(--dep-row-hover) focus-visible:shadow-[inset_0_0_0_2px_var(--dep-focus)]"
			)}
			data-flight-key={flight.key}
			data-status={flight.status}
			onClick={() => onActivate(flight)}
			onFocus={() => onFocusRow(flight)}
			onKeyDown={(event) => onKeyDown(event, flight)}
			ref={rowRef}
			role="row"
			tabIndex={selected ? 0 : -1}
		>
			{active ? (
				<span
					aria-hidden="true"
					className="absolute inset-y-0 left-0 w-0.75 bg-(--dep-ink)"
				/>
			) : null}
			<span className={COLUMN.time} role="gridcell">
				<FlapText delay={delay} length={5} value={boardTime(flight.time)} />
			</span>
			<span className={COLUMN.flight} role="gridcell">
				<FlapText delay={delay + 0.03} length={7} value={flight.flightNumber} />
			</span>
			<span className={COLUMN.title} role="gridcell">
				<Flap
					align="start"
					className="h-7 w-full min-w-0"
					delay={delay + 0.06}
					value={flight.title.toUpperCase()}
				/>
			</span>
			<span className={COLUMN.gate} role="gridcell">
				<Flap
					align="start"
					className="h-7 w-full"
					delay={delay + 0.09}
					value={flight.gateLabel.toUpperCase()}
				/>
			</span>
			{showTerminal ? (
				<span
					className={cn(
						COLUMN.terminal,
						"font-medium text-(--dep-ink-dim) text-xs uppercase tracking-[0.04em]"
					)}
					role="gridcell"
				>
					{flight.terminal ? (
						<span className="truncate">{flight.terminal}</span>
					) : (
						<span className="text-(--dep-ink-faint)">—</span>
					)}
				</span>
			) : null}
			<span className={COLUMN.status} role="gridcell">
				<StatusLamp
					blink={lampBlinks(flight)}
					dim={flight.parked}
					status={flight.status}
				/>
				<FlapText
					className={cn("@6xl:hidden", LAMP_TEXT[lamp])}
					delay={delay + 0.12}
					length={3}
					value={FLIGHT_STATUS_CODES[flight.status]}
				/>
				<FlapText
					className={cn("@6xl:inline-flex hidden", LAMP_TEXT[lamp])}
					delay={delay + 0.12}
					length={STATUS_FLAP_LENGTH}
					value={FLIGHT_STATUS_LABELS[flight.status]}
				/>
			</span>
			<span
				className={cn(
					COLUMN.remarks,
					"min-w-0 font-medium text-(--dep-ink-dim) text-xs uppercase tracking-[0.04em]"
				)}
				role="gridcell"
			>
				<Remarks flight={flight} />
			</span>
		</div>
	);
}

const MAX_SPARE_ROWS = 40;

/** Whole rows that fit a height, so the board never ends on a cut-off row. */
export function spareRowCount(height: number): number {
	return Math.max(
		0,
		Math.min(MAX_SPARE_ROWS, Math.floor(height / ROW_HEIGHT_PX))
	);
}

/** How many whole spare rows fit the space the flights leave. */
function useSpareRows(): [RefObject<HTMLDivElement | null>, number] {
	const ref = useRef<HTMLDivElement>(null);
	const [rows, setRows] = useState(0);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) {
			return;
		}
		const measure = () => setRows(spareRowCount(node.clientHeight));
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	return [ref, rows];
}

/**
 * Unused board positions: blank flaps, the same hardware as a live row with
 * nothing printed on it. They fill the height the flights leave, in whole
 * rows; what is left under the last one is the board's frame.
 */
export function BoardSpareRows({
	offset,
	showTerminal,
}: {
	/** Rows already on the board, so the shading keeps alternating. */
	offset: number;
	showTerminal: boolean;
}) {
	const [ref, count] = useSpareRows();
	const rows = Array.from({ length: count }, (_, row) => `spare-${row}`);
	return (
		<div
			aria-hidden="true"
			className="flex min-h-0 flex-1 flex-col overflow-hidden"
			ref={ref}
		>
			{rows.map((row, index) => (
				<div
					className={cn(
						ROW_GRID,
						"h-12 shrink-0",
						(index + offset) % 2 === 1
							? "bg-(--dep-row-alt)"
							: "bg-(--dep-board)"
					)}
					key={row}
				>
					<span className={COLUMN.time}>
						<BlankFlapText length={5} />
					</span>
					<span className={COLUMN.flight}>
						<BlankFlapText length={7} />
					</span>
					<span className={COLUMN.title}>
						<BlankFlap className="h-7 w-full" />
					</span>
					<span className={COLUMN.gate}>
						<BlankFlap className="h-7 w-full" />
					</span>
					{showTerminal ? <span className={COLUMN.terminal} /> : null}
					<span className={COLUMN.status}>
						<span className="size-2 shrink-0" />
						<BlankFlapText className="@6xl:hidden" length={3} />
						<BlankFlapText
							className="@6xl:inline-flex hidden"
							length={STATUS_FLAP_LENGTH}
						/>
					</span>
					<span className={COLUMN.remarks} />
				</div>
			))}
		</div>
	);
}

const LOADING_ROWS = Array.from({ length: 12 }, (_, row) => `loading-${row}`);

/** While the first snapshot loads: soft bars in the column slots, pulsing. */
export function BoardLoadingRows() {
	const bar =
		"h-7 rounded-[0.18em] bg-(--dep-tile-bottom) motion-safe:animate-pulse";
	return (
		<div
			aria-hidden="true"
			className="flex min-h-0 flex-1 flex-col overflow-hidden border-(--dep-rule) border-t"
		>
			{LOADING_ROWS.map((row, index) => (
				<div
					className={cn(
						ROW_GRID,
						"h-12 shrink-0",
						index % 2 === 1 ? "bg-(--dep-row-alt)" : "bg-(--dep-board)"
					)}
					key={row}
				>
					<span className={cn(COLUMN.time, bar)} />
					<span className={cn(COLUMN.flight, bar)} />
					<span className={cn(COLUMN.title, bar)} />
					<span className={cn(COLUMN.gate, bar)} />
					<span className={COLUMN.status}>
						<span className="size-2 shrink-0" />
						<span className={cn("flex-1", bar)} />
					</span>
					<span className={COLUMN.remarks} />
				</div>
			))}
		</div>
	);
}

/** The board's foot line: how to drive it, printed like a FIDS ticker. */
export function BoardFooter({ panelOpen }: { panelOpen: boolean }) {
	const hints = [
		"↑ ↓ Select",
		"Enter Open",
		"← → Switch board",
		panelOpen ? "Esc Close" : null,
	].filter(Boolean);
	return (
		<p
			className={cn(
				"@3xl:flex hidden h-8 shrink-0 items-center gap-6 border-(--dep-rule) border-t @5xl:px-5 px-4 text-(--dep-ink-faint)",
				SMALL_CAPS
			)}
		>
			{hints.map((hint) => (
				<span key={hint}>{hint}</span>
			))}
		</p>
	);
}

/** The board with nothing on it: a flap message and one plain line. */
export function BoardEmpty({
	action,
	board,
	description,
}: {
	action?: ReactNode;
	board: DeparturesBoard;
	description: string;
}) {
	const message = `No ${BOARD_LABELS[board].toLowerCase()}`;
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 border-(--dep-rule) border-t px-6 py-16 text-center">
			<p className="sr-only">{message}</p>
			<FlapText
				className="font-mono font-semibold text-lg"
				length={message.length}
				tileClassName="h-8 w-[22px]"
				value={message}
			/>
			<p className="max-w-sm text-(--dep-ink-dim) text-sm">{description}</p>
			{action}
		</div>
	);
}
