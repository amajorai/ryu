import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	Fragment,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	BoardColumnHeader,
	BoardDayRow,
	BoardEmpty,
	BoardFooter,
	BoardLoadingRows,
	BoardMasthead,
	BoardSpareRows,
	FlightRow,
} from "./departures-board.tsx";
import type { BookingInput } from "./departures-booking.tsx";
import {
	airborneCount,
	BOARD_LABELS,
	boardForThread,
	buildBoards,
	type DeparturesBoard,
	type Flight,
	nextRowIndex,
} from "./departures-model.ts";
import { BOARD_PALETTE } from "./departures-palette.ts";
import { DeparturesPanel } from "./departures-panel.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";

/** How often the clock and the airborne times refresh. */
const CLOCK_TICK_MS = 10_000;
/** How long a requested focus move may wait for the host to open a thread. */
const FOCUS_REQUEST_TTL_MS = 2000;
/** The Terminal column earns its width once this many rows name one. */
const MIN_TERMINAL_ROWS = 2;

interface FocusRequest {
	at: number;
	to: "cursor" | "heading";
}

const EMPTY_COPY: Record<DeparturesBoard, string> = {
	arrivals:
		"Replies from your agents land here, along with any run that was delayed.",
	departures:
		"Book a flight to start a conversation. Scheduled routines are listed here before they leave.",
};

/**
 * Row indexes that open a new day: every change of section, plus the first
 * row when the board does not start today.
 */
function dayDividers(flights: readonly Flight[]): Set<number> {
	const indexes = new Set<number>();
	let previous: string | null = null;
	for (const [index, flight] of flights.entries()) {
		const key = flight.section.key;
		if (key !== previous && (previous !== null || key !== "today")) {
			indexes.add(index);
		}
		previous = key;
	}
	return indexes;
}

/** Escape inside a text field belongs to the field (or the host's composer). */
function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

/** Wall-clock time that advances on an interval and on the minute. */
function useNow(interval: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			const current = Date.now();
			setNow(current);
			// Land on the minute so the clock never shows a stale minute.
			const toMinute = 60_000 - (current % 60_000);
			timer = setTimeout(tick, Math.min(interval, toMinute + 50));
		};
		tick();
		return () => clearTimeout(timer);
	}, [interval]);
	return now;
}

/**
 * Departures: conversations as flights on an airport split-flap board.
 * DEPARTURES lists scheduled routine runs, threads boarding (you wrote, the
 * agent has not started) and threads in flight; ARRIVALS lists replies that
 * landed or wait at the gate, delayed runs, and finished trips. Opening a
 * flight shows its details over the host's own conversation surface.
 */
export function DeparturesInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const tl = useLiteralMessages();
	const now = useNow(CLOCK_TICK_MS);
	const boards = useMemo(() => buildBoards(snapshot, now), [snapshot, now]);
	const [board, setBoard] = useState<DeparturesBoard>(
		() =>
			(activeThreadId ? boardForThread(boards, activeThreadId) : null) ??
			"departures"
	);
	const [cursorKey, setCursorKey] = useState<string | null>(null);
	const [openEventKey, setOpenEventKey] = useState<string | null>(null);
	const [booking, setBooking] = useState(false);
	const rowRefs = useRef(new Map<string, HTMLDivElement>());
	const headingRef = useRef<HTMLHeadingElement>(null);
	const pendingFocus = useRef<FocusRequest | null>(null);
	const tabFocus = useRef<DeparturesBoard | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const gridId = useId();

	const flights = boards[board];
	const activeKey = activeThreadId ? `thread:${activeThreadId}` : null;
	const cursorIndex = Math.max(
		0,
		flights.findIndex(
			(flight) => flight.key === (cursorKey ?? openEventKey ?? activeKey)
		)
	);
	const cursorFlight = flights[cursorIndex];

	// Follow the host: when it opens a thread, show the board that lists it.
	const boardsRef = useRef(boards);
	boardsRef.current = boards;
	useEffect(() => {
		if (!activeThreadId) {
			return;
		}
		const target = boardForThread(boardsRef.current, activeThreadId);
		if (target) {
			setBoard(target);
			setCursorKey(`thread:${activeThreadId}`);
		}
	}, [activeThreadId]);

	const allFlights = useMemo(
		() => [...boards.departures, ...boards.arrivals],
		[boards]
	);
	const panelFlight = threadView
		? allFlights.find((flight) => flight.key === activeKey)
		: allFlights.find((flight) => flight.key === openEventKey);
	const panelOpen = booking || threadView !== null || panelFlight !== undefined;

	const focusCursor = useCallback(() => {
		pendingFocus.current = { at: Date.now(), to: "cursor" };
	}, []);

	const switchBoard = useCallback(
		(next: DeparturesBoard) => {
			setBoard(next);
			setCursorKey(null);
			focusCursor();
		},
		[focusCursor]
	);

	const activate = useCallback(
		(flight: Flight) => {
			setCursorKey(flight.key);
			setBooking(false);
			if (flight.threadId) {
				setOpenEventKey(null);
				port.openThread(flight.threadId);
			} else {
				setOpenEventKey(flight.key);
				// The panel shows the open conversation over any event, so
				// close it for the run's own timeline to show.
				if (threadView) {
					port.closeThread();
				}
			}
			pendingFocus.current = { at: Date.now(), to: "heading" };
		},
		[port, threadView]
	);

	const closePanel = useCallback(() => {
		setOpenEventKey(null);
		setBooking(false);
		if (threadView) {
			port.closeThread();
		}
		pendingFocus.current = { at: Date.now(), to: "cursor" };
	}, [port, threadView]);

	const book = useCallback(
		(input: BookingInput) => {
			setOpenEventKey(null);
			setBooking(false);
			port.startThread(input);
		},
		[port]
	);

	// The masthead tabs keep focus on themselves when switched by key.
	const onTabSwitch = useCallback(
		(next: DeparturesBoard, focusTab: boolean) => {
			setBoard(next);
			setCursorKey(null);
			if (focusTab) {
				tabFocus.current = next;
			}
		},
		[]
	);

	const openBooking = useCallback(() => {
		setOpenEventKey(null);
		setBooking(true);
		if (threadView) {
			port.closeThread();
		}
	}, [port, threadView]);

	// ArrowDown on a board tab drops into the rows at the cursor.
	const enterRows = useCallback(() => {
		const row = cursorFlight
			? rowRefs.current.get(cursorFlight.key)
			: undefined;
		row?.focus({ preventScroll: true });
		row?.scrollIntoView?.({ block: "nearest" });
	}, [cursorFlight]);

	// Move focus after the render that a key press or open caused.
	useLayoutEffect(() => {
		if (tabFocus.current) {
			const tab = rootRef.current?.querySelector<HTMLButtonElement>(
				`[data-board="${tabFocus.current}"][role="tab"]`
			);
			tabFocus.current = null;
			tab?.focus();
		}
		const request = pendingFocus.current;
		if (!request) {
			return;
		}
		// A host that never opens the thread must not steal focus later.
		if (Date.now() - request.at > FOCUS_REQUEST_TTL_MS) {
			pendingFocus.current = null;
			return;
		}
		if (request.to === "heading") {
			if (headingRef.current) {
				pendingFocus.current = null;
				headingRef.current.focus({ preventScroll: true });
			}
			return;
		}
		pendingFocus.current = null;
		const row = cursorFlight
			? rowRefs.current.get(cursorFlight.key)
			: undefined;
		row?.focus({ preventScroll: true });
		row?.scrollIntoView?.({ block: "nearest" });
	});

	// Escape closes the panel unless a field (or the host's composer) has it.
	useEffect(() => {
		if (!panelOpen) {
			return;
		}
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				isEditable(event.target)
			) {
				return;
			}
			event.preventDefault();
			closePanel();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [closePanel, panelOpen]);

	const onRowKeyDown = (
		event: KeyboardEvent<HTMLDivElement>,
		flight: Flight
	) => {
		if (event.altKey || event.metaKey || event.ctrlKey) {
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			activate(flight);
			return;
		}
		// Left and right switch boards; Tab is left to the browser, so focus
		// moves on to the panel and the host's UI.
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			const target = event.key === "ArrowLeft" ? "departures" : "arrivals";
			if (target !== board) {
				switchBoard(target);
			}
			return;
		}
		const index = flights.findIndex(
			(candidate) => candidate.key === flight.key
		);
		const next = nextRowIndex(event.key, index, flights.length);
		if (next === null) {
			return;
		}
		event.preventDefault();
		const target = flights[next];
		if (target) {
			setCursorKey(target.key);
			focusCursor();
		}
	};

	const showTerminal =
		flights.filter((flight) => flight.terminal !== null).length >=
		MIN_TERMINAL_ROWS;
	const dividers = dayDividers(flights);
	const rowCount = flights.length + dividers.size + 1;

	return (
		<div
			className="relative flex size-full min-h-0 bg-background text-foreground"
			data-testid="interface-departures"
			ref={rootRef}
		>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div className="flex min-h-0 flex-1 flex-col p-2 sm:p-3">
					<section
						aria-busy={loading}
						aria-label={tl("{board} board", { board: BOARD_LABELS[board] })}
						className={cn(
							BOARD_PALETTE,
							"@container flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-(--dep-board) text-(--dep-ink) shadow-[0_0_0_1px_var(--dep-edge)]"
						)}
					>
						<BoardMasthead
							airborne={airborneCount(flights)}
							board={board}
							boardId={gridId}
							count={flights.length}
							loading={loading}
							now={now}
							onBook={openBooking}
							onEnterRows={enterRows}
							onSwitch={onTabSwitch}
						/>
						{loading ? (
							<BoardLoadingRows />
						) : flights.length === 0 ? (
							<BoardEmpty board={board} description={EMPTY_COPY[board]} />
						) : (
							<div
								aria-colcount={7}
								aria-label={BOARD_LABELS[board]}
								aria-rowcount={rowCount}
								className="flex min-h-0 flex-1 flex-col"
								id={gridId}
								role="grid"
							>
								<BoardColumnHeader board={board} showTerminal={showTerminal} />
								<div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain [scrollbar-width:thin]">
									{flights.map((flight, index) => (
										<Fragment key={flight.key}>
											{dividers.has(index) ? (
												<BoardDayRow label={flight.section.label} />
											) : null}
											<FlightRow
												active={
													flight.key === activeKey && threadView !== null
														? true
														: flight.key === openEventKey
												}
												flight={flight}
												index={index}
												onActivate={activate}
												onFocusRow={(focused) => setCursorKey(focused.key)}
												onKeyDown={onRowKeyDown}
												rowRef={(node) => {
													if (node) {
														rowRefs.current.set(flight.key, node);
													} else {
														rowRefs.current.delete(flight.key);
													}
												}}
												selected={index === cursorIndex}
												showTerminal={showTerminal}
											/>
										</Fragment>
									))}
									<BoardSpareRows
										offset={flights.length}
										showTerminal={showTerminal}
									/>
								</div>
							</div>
						)}
						{loading || flights.length === 0 ? null : (
							<BoardFooter panelOpen={panelOpen} />
						)}
					</section>
				</div>
			</div>
			{panelOpen ? (
				<DeparturesPanel
					booking={booking}
					flight={booking ? undefined : panelFlight}
					flights={allFlights}
					headingRef={headingRef}
					now={now}
					onBook={book}
					onClose={closePanel}
					onOpen={activate}
					snapshot={snapshot}
					threadView={threadView}
				/>
			) : null}
		</div>
	);
}
