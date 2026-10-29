import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { useTimezoneRevision } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils";
import { type CalendarParams, localDayKey } from "@ryuhq/protocol/interfaces";
import {
	CalendarCheck,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	PanelLeft,
	Plus,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	type CalendarLayer,
	type CalendarScale,
	calendarItemsByDay,
	displayWallDate,
	moveDayKey,
	parseDayKey,
	rangeTitle,
	rangeTitleShort,
	shiftDay,
	upcomingRuns,
	visibleDays,
} from "./calendar-model.ts";
import type { CalendarItemHandlers } from "./calendar-month.tsx";
import { CalendarMonthGrid } from "./calendar-month.tsx";
import { CalendarThreadPanel } from "./calendar-panel.tsx";
import {
	CALENDAR_DAY_ATTRIBUTE,
	CALENDAR_ITEM_ATTRIBUTE,
} from "./calendar-parts.tsx";
import { CalendarRail } from "./calendar-rail.tsx";
import { CalendarWeekGrid } from "./calendar-week.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";

type Zone = "main" | "mini";

interface FocusRequest {
	key: string;
	zone: Zone;
}

/**
 * The scale toggle speaks the toolbar's one button language: an outlined
 * group the height of Today, the chosen segment filled with muted.
 */
const SEGMENT_CLASS =
	"h-6.5 rounded-md px-2.5 text-sm text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:shadow-none";

/**
 * Header icon buttons share the toolbar's rounded-lg square; the sidebar
 * toggle says it is open through aria-expanded alone, never with a fill.
 */
const HEADER_ICON_CLASS =
	"rounded-lg aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted aria-expanded:hover:text-foreground";

/** "M" and "W" switch the scale, like the reference's shortcuts. */
const SCALE_KEYS: Partial<Record<string, CalendarScale>> = {
	m: "month",
	w: "week",
};

const SCALE_LABELS: Record<CalendarScale, string> = {
	month: "Month",
	week: "Week",
};

/**
 * The current time on the display zone's wall clock ({@link displayWallDate}),
 * refreshed every half minute, and at once when the display-timezone
 * preference (`revision`) changes, so "today" and "now" stay true.
 */
function useNow(revision: string): Date {
	const [now, setNow] = useState(() => displayWallDate(Date.now()));
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new display-timezone revision moves the wall clock now, not on the next tick.
	useEffect(() => {
		setNow(displayWallDate(Date.now()));
		const timer = window.setInterval(
			() => setNow(displayWallDate(Date.now())),
			30_000
		);
		return () => window.clearInterval(timer);
	}, [revision]);
	return now;
}

/**
 * Whether a media query matches. Server renders (and tests without layout)
 * assume a wide desktop window, which is where the calendar usually lives.
 */
function useMediaMatch(query: string): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (typeof window === "undefined" || !window.matchMedia) {
				return () => undefined;
			}
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		[query]
	);
	return useSyncExternalStore(
		subscribe,
		() =>
			typeof window !== "undefined" && window.matchMedia
				? window.matchMedia(query).matches
				: false,
		() => false
	);
}

/** Keys typed into a field belong to the field (or the host's composer). */
function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

function zoneOf(target: HTMLElement): Zone | null {
	const zone = target.closest<HTMLElement>("[data-calendar-zone]")?.dataset
		.calendarZone;
	return zone === "main" || zone === "mini" ? zone : null;
}

const SKELETON_CELLS = Array.from(
	{ length: 42 },
	(_, index) => `cell-${index}`
);
const SKELETON_WEEKDAYS = Array.from(
	{ length: 7 },
	(_, index) => `day-${index}`
);

/** The month's own frame (rail, weekday strip, six weeks), so nothing jumps. */
function CalendarSkeleton() {
	return (
		<div aria-hidden="true" className="flex min-h-0 flex-1">
			<div className="flex w-56 shrink-0 flex-col gap-5 px-3 pt-3 max-lg:hidden xl:w-64">
				<Skeleton className="h-12 w-36" radius="panel" />
				<Skeleton className="h-52 w-full" radius="panel" />
				<div className="flex flex-col gap-2">
					<Skeleton className="h-3 w-24" radius="dense" />
					<Skeleton className="h-9 w-full" radius="row" />
					<Skeleton className="h-9 w-full" radius="row" />
				</div>
			</div>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col border-border lg:border-l">
				<div className="grid h-9 shrink-0 grid-cols-7 items-center border-border border-b">
					{SKELETON_WEEKDAYS.map((day) => (
						<Skeleton className="mx-auto h-2.5 w-7" key={day} radius="dense" />
					))}
				</div>
				<div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
					{SKELETON_CELLS.map((cell) => (
						<div
							className="flex flex-col gap-1.5 border-border border-r border-b p-1.5 [&:nth-child(7n)]:border-r-0 [&:nth-last-child(-n+7)]:border-b-0"
							key={cell}
						>
							<Skeleton className="mx-auto h-4 w-5" radius="pill" />
							<Skeleton className="h-3.5 w-4/5" radius="dense" />
							<Skeleton className="h-3.5 w-3/5" radius="dense" />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * Calendar: threads (at their latest activity) and scheduled runs on a month
 * or a week, with a month picker and the next runs in a left rail. Opening a
 * thread keeps the calendar in view and shows the host's real conversation in
 * a side panel; a run opens a popover with a way to message its agent.
 */
export function CalendarInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<CalendarParams>) {
	// Day buckets follow the display-timezone preference, so they recompute
	// when it changes (see `useTimezoneRevision`).
	const timezoneRevision = useTimezoneRevision();
	const now = useNow(timezoneRevision);
	const todayKey = localDayKey(now);
	const [scale, setScale] = useInterfaceSetting<CalendarScale>(
		port,
		"scale",
		params.scale
	);
	const [selectedKey, setSelectedKey] = useState(todayKey);
	const [miniKey, setMiniKey] = useState(todayKey);
	const [direction, setDirection] = useState<-1 | 0 | 1>(0);
	const [hidden, setHidden] = useState<ReadonlySet<CalendarLayer>>(
		() => new Set()
	);
	const [openRunKey, setOpenRunKey] = useState<string | null>(null);
	const [railOpen, setRailOpen] = useInterfaceSetting(
		port,
		"rail",
		params.rail
	);
	const [railOverlayOpen, setRailOverlayOpen] = useState(false);
	const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const railToggleRef = useRef<HTMLButtonElement>(null);
	const railOverlayRef = useRef<HTMLDivElement>(null);
	/** Whether closing the rail overlay hands focus back to its toggle. */
	const railReturnFocusRef = useRef(false);

	const panelOpen = threadView !== null;
	const belowLg = useMediaMatch("(max-width: 1023.98px)");
	const below2xl = useMediaMatch("(max-width: 1535.98px)");
	// The rail sits beside the grid when there is room for both; otherwise it
	// stays closed and opens over the grid, so neither is squeezed to slivers.
	const railOverlay = belowLg || (panelOpen && below2xl);
	const railShown = railOverlay ? railOverlayOpen : railOpen;
	const reduceMotion = useReducedMotion();
	// biome-ignore lint/correctness/useExhaustiveDependencies: close the overlay whenever the layout switches between inline and overlay.
	useEffect(() => setRailOverlayOpen(false), [railOverlay]);
	const closeRailOverlay = useCallback((returnFocus: boolean) => {
		railReturnFocusRef.current = returnFocus;
		setRailOverlayOpen(false);
	}, []);
	// The overlay takes focus when it opens and gives it back when dismissed.
	useEffect(() => {
		if (railOverlayOpen) {
			railOverlayRef.current
				?.querySelector<HTMLElement>("button:not([disabled])")
				?.focus();
			return;
		}
		if (railReturnFocusRef.current) {
			railReturnFocusRef.current = false;
			railToggleRef.current?.focus();
		}
	}, [railOverlayOpen]);
	const anchor = parseDayKey(selectedKey);
	const days = useMemo(
		() => visibleDays(scale, parseDayKey(selectedKey)),
		[scale, selectedKey]
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the buckets read the display timezone, so a preference change must rebucket.
	const allItemsByDay = useMemo(
		() => calendarItemsByDay(snapshot),
		[snapshot, timezoneRevision]
	);
	const itemsByDay = useMemo(
		() =>
			hidden.size === 0 ? allItemsByDay : calendarItemsByDay(snapshot, hidden),
		[allItemsByDay, snapshot, hidden]
	);
	// The picker's dots agree with the grid: hidden layers leave no dot.
	const activeDayKeys = useMemo(() => new Set(itemsByDay.keys()), [itemsByDay]);
	const runs = useMemo(
		() => upcomingRuns(snapshot.events, now),
		[snapshot.events, now]
	);
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const isEmpty =
		!loading &&
		snapshot.threads.length === 0 &&
		(snapshot.events?.length ?? 0) === 0;
	const title = rangeTitle(scale, anchor);

	/** Move the selected day; the visible month or week follows it. */
	const selectDay = useCallback(
		(key: string, zone: Zone | null = null) => {
			if (key !== selectedKey) {
				setDirection(key > selectedKey ? 1 : -1);
			}
			setSelectedKey(key);
			setMiniKey(key);
			if (zone) {
				setFocusRequest({ key, zone });
			}
		},
		[selectedKey]
	);

	const step = (offset: -1 | 1) => {
		setDirection(offset);
		const next = shiftDay(scale, selectedKey, offset);
		setSelectedKey(next);
		setMiniKey(next);
	};

	// Focus the requested day once it has rendered.
	useEffect(() => {
		const root = rootRef.current;
		if (!(root && focusRequest)) {
			return;
		}
		const target = root.querySelector<HTMLElement>(
			`[data-calendar-zone="${focusRequest.zone}"] [${CALENDAR_DAY_ATTRIBUTE}="${CSS.escape(focusRequest.key)}"]`
		);
		target?.focus({ preventScroll: false });
		setFocusRequest(null);
	}, [focusRequest]);

	const openFirstItem = useCallback(
		(key: string) => {
			const first = itemsByDay.get(key)?.[0];
			if (!first) {
				return;
			}
			if (first.kind === "thread") {
				port.openThread(first.thread.id);
			} else {
				setOpenRunKey(first.key);
			}
		},
		[itemsByDay, port]
	);

	const closePanel = useCallback(() => {
		port.closeThread();
		setFocusRequest({ key: selectedKey, zone: "main" });
	}, [port, selectedKey]);

	// One key handler for the whole calendar, also reached when nothing has
	// focus yet (keys land on <body>), so the calendar is keyboard-first.
	const onKey = useCallback(
		(event: KeyboardEvent) => {
			const root = rootRef.current;
			const target = event.target;
			if (
				!(root && target instanceof HTMLElement) ||
				isInterfaceCovered(root) ||
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				isEditable(target)
			) {
				return;
			}
			const inRoot = root.contains(target);
			if (!(inRoot || target === document.body)) {
				return;
			}
			if (event.key === "Escape" && railOverlay && railOverlayOpen) {
				event.preventDefault();
				closeRailOverlay(true);
				return;
			}
			if (target.closest("[data-calendar-panel]")) {
				if (event.key === "Escape" && panelOpen) {
					event.preventDefault();
					closePanel();
				}
				return;
			}
			if (event.key === "Escape" && panelOpen && openRunKey === null) {
				event.preventDefault();
				closePanel();
				return;
			}
			if ((event.key === "t" || event.key === "T") && !event.shiftKey) {
				event.preventDefault();
				selectDay(todayKey, "main");
				return;
			}
			const scaleKey = SCALE_KEYS[event.key.toLowerCase()];
			if (scaleKey && !event.shiftKey) {
				event.preventDefault();
				setDirection(0);
				setScale(scaleKey);
				return;
			}
			const zone = target === document.body ? "main" : zoneOf(target);
			if (!zone) {
				return;
			}
			const onDay = target.hasAttribute(CALENDAR_DAY_ATTRIBUTE);
			if (event.key === "Enter" && (onDay || target === document.body)) {
				event.preventDefault();
				const key = target.getAttribute(CALENDAR_DAY_ATTRIBUTE) ?? selectedKey;
				if (zone === "mini") {
					selectDay(key, "main");
					return;
				}
				openFirstItem(key);
				return;
			}
			const from =
				target.getAttribute(CALENDAR_DAY_ATTRIBUTE) ??
				(target.hasAttribute(CALENDAR_ITEM_ATTRIBUTE)
					? target
							.closest<HTMLElement>(`[${CALENDAR_DAY_ATTRIBUTE}]`)
							?.getAttribute(CALENDAR_DAY_ATTRIBUTE)
					: null) ??
				selectedKey;
			const next = moveDayKey(from, event.key, scale);
			if (next) {
				event.preventDefault();
				selectDay(next, zone);
			}
		},
		[
			closePanel,
			closeRailOverlay,
			openFirstItem,
			openRunKey,
			panelOpen,
			railOverlay,
			railOverlayOpen,
			scale,
			selectDay,
			selectedKey,
			todayKey,
		]
	);
	useEffect(() => {
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onKey]);

	const onMessage = useCallback(
		(agentId: string) => port.startThread({ agentId }),
		[port]
	);
	// With no agent there is nothing to start a thread with: no such button.
	const newThread =
		snapshot.agents.length > 0 ? () => port.startThread({}) : null;
	const handlers: CalendarItemHandlers = {
		activeThreadId: panelOpen ? activeThreadId : null,
		onMessage,
		onOpenRunChange: setOpenRunKey,
		onOpenThread: (threadId) => port.openThread(threadId),
		openRunKey,
		snapshot,
	};

	const toggleLayer = (layer: CalendarLayer) => {
		setHidden((current) => {
			const next = new Set(current);
			if (next.has(layer)) {
				next.delete(layer);
			} else {
				next.add(layer);
			}
			return next;
		});
	};

	const toggleRail = () => {
		if (railOverlay && railOverlayOpen) {
			closeRailOverlay(true);
		} else if (railOverlay) {
			setRailOverlayOpen(true);
		} else {
			setRailOpen((open) => !open);
		}
	};
	const chooseScale = (value: CalendarScale) => {
		setDirection(0);
		setScale(value);
	};
	/** A date number opens its week, like the reference calendars. */
	const openWeekOf = (key: string) => {
		setDirection(0);
		setScale("week");
		selectDay(key, "main");
	};
	const railInline = railShown && !railOverlay;
	const showDayOfThread =
		activeThread && !Number.isNaN(Date.parse(activeThread.updatedAt))
			? () =>
					selectDay(
						localDayKey(displayWallDate(Date.parse(activeThread.updatedAt))),
						"main"
					)
			: null;

	return (
		<div
			aria-busy={loading || undefined}
			className="relative flex size-full min-h-0 bg-background text-foreground"
			data-testid="interface-calendar"
			ref={rootRef}
		>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<header className="flex h-14 shrink-0 items-center gap-1.5 border-border border-b px-3 sm:gap-3">
					<Button
						aria-expanded={railShown}
						aria-label={railShown ? "Hide sidebar" : "Show sidebar"}
						className={HEADER_ICON_CLASS}
						disabled={loading}
						onClick={toggleRail}
						ref={railToggleRef}
						size="icon-sm"
						title={railShown ? "Hide sidebar" : "Show sidebar"}
						type="button"
						variant="ghost-muted"
					>
						<PanelLeft aria-hidden="true" />
					</Button>
					<h1 className="sr-only">Calendar</h1>
					<Button
						className="rounded-lg max-sm:hidden"
						disabled={loading}
						onClick={() => selectDay(todayKey)}
						size="sm"
						title="Go to today (T)"
						type="button"
						variant="outline"
					>
						Today
					</Button>
					<Button
						aria-label="Today"
						className="rounded-lg sm:hidden"
						disabled={loading}
						onClick={() => selectDay(todayKey)}
						size="icon-sm"
						title="Go to today (T)"
						type="button"
						variant="outline"
					>
						<CalendarCheck aria-hidden="true" />
					</Button>
					<div className="flex items-center">
						<Button
							aria-label={
								scale === "month" ? "Previous month" : "Previous week"
							}
							className={HEADER_ICON_CLASS}
							disabled={loading}
							onClick={() => step(-1)}
							size="icon-sm"
							title={scale === "month" ? "Previous month" : "Previous week"}
							type="button"
							variant="ghost-muted"
						>
							<ChevronLeft aria-hidden="true" />
						</Button>
						<Button
							aria-label={scale === "month" ? "Next month" : "Next week"}
							className={HEADER_ICON_CLASS}
							disabled={loading}
							onClick={() => step(1)}
							size="icon-sm"
							title={scale === "month" ? "Next month" : "Next week"}
							type="button"
							variant="ghost-muted"
						>
							<ChevronRight aria-hidden="true" />
						</Button>
					</div>
					<h2
						aria-live="polite"
						className="min-w-0 flex-1 truncate whitespace-nowrap font-heading font-normal text-base text-foreground sm:text-xl"
						data-testid="calendar-range-title"
					>
						<span className="max-sm:hidden">{title}</span>
						<span className="sm:hidden">{rangeTitleShort(scale, anchor)}</span>
					</h2>
					<p className="items-center gap-1 text-muted-foreground text-xs max-2xl:hidden 2xl:flex">
						<Kbd>←</Kbd>
						<Kbd>→</Kbd>
						<span>days</span>
						<Kbd className="ms-1.5">T</Kbd>
						<span>today</span>
					</p>
					<ToggleGroup
						appearance="segmented"
						aria-label="Calendar scale"
						className="h-8 border border-border bg-background max-sm:hidden dark:bg-transparent"
						multiple={false}
						onValueChange={(values: string[]) => {
							const value = values[0];
							if (value === "month" || value === "week") {
								chooseScale(value);
							}
						}}
						spacing={0}
						value={[scale]}
					>
						<ToggleGroupItem
							className={SEGMENT_CLASS}
							density="segmented"
							title="Month (M)"
							value="month"
						>
							Month
						</ToggleGroupItem>
						<ToggleGroupItem
							className={SEGMENT_CLASS}
							density="segmented"
							title="Week (W)"
							value="week"
						>
							Week
						</ToggleGroupItem>
					</ToggleGroup>
					{/* A phone has no room for two segments: one menu, like the reference's mobile view. */}
					<DropdownMenu>
						<DropdownMenuTrigger
							aria-label={`Calendar scale: ${SCALE_LABELS[scale]}`}
							disabled={loading}
							render={
								<button
									className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 font-medium text-foreground text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted sm:hidden"
									type="button"
								/>
							}
						>
							{SCALE_LABELS[scale]}
							<ChevronDown
								aria-hidden="true"
								className="size-4 text-muted-foreground"
							/>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							className="w-36"
							drawerLabel="Calendar scale"
						>
							<DropdownMenuRadioGroup
								onValueChange={(value: string) => {
									if (value === "month" || value === "week") {
										chooseScale(value);
									}
								}}
								value={scale}
							>
								<DropdownMenuRadioItem value="month">
									Month
								</DropdownMenuRadioItem>
								<DropdownMenuRadioItem value="week">Week</DropdownMenuRadioItem>
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					{/* With the rail hidden, its New thread action moves into the header, unchanged. */}
					{newThread && !railInline ? (
						<Button
							aria-label="New thread"
							className="rounded-lg max-md:px-2"
							onClick={newThread}
							size="sm"
							title="New thread"
							type="button"
							variant="outline"
						>
							<Plus aria-hidden="true" data-icon="inline-start" />
							<span className="max-md:hidden">New thread</span>
						</Button>
					) : null}
				</header>
				{loading ? (
					<CalendarSkeleton />
				) : (
					<div className="relative flex min-h-0 flex-1">
						{railInline ? (
							<CalendarRail
								activeDayKeys={activeDayKeys}
								className="flex"
								hidden={hidden}
								miniKey={miniKey}
								now={now}
								onMessage={onMessage}
								onMiniChange={setMiniKey}
								onNewThread={newThread}
								onSelectDay={(key) => selectDay(key)}
								onToggleLayer={toggleLayer}
								runs={runs}
								scale={scale}
								selectedKey={selectedKey}
								snapshot={snapshot}
								todayKey={todayKey}
							/>
						) : null}
						<AnimatePresence>
							{railOverlay && railOverlayOpen ? (
								<motion.div
									animate={{ opacity: 1 }}
									className="absolute inset-0 z-20 flex"
									exit={{ opacity: 0 }}
									initial={reduceMotion ? false : { opacity: 0 }}
									key="rail-overlay"
									transition={{ duration: 0.16 }}
								>
									<motion.div
										animate={{ x: 0 }}
										className="flex h-full shrink-0 border-border border-r bg-background shadow-xl"
										exit={reduceMotion ? {} : { x: -16 }}
										initial={reduceMotion ? false : { x: -16 }}
										ref={railOverlayRef}
										transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
									>
										<CalendarRail
											activeDayKeys={activeDayKeys}
											className="flex"
											hidden={hidden}
											miniKey={miniKey}
											now={now}
											onMessage={onMessage}
											onMiniChange={setMiniKey}
											onNewThread={newThread}
											onSelectDay={(key) => {
												closeRailOverlay(false);
												selectDay(key, "main");
											}}
											onToggleLayer={toggleLayer}
											runs={runs}
											scale={scale}
											selectedKey={selectedKey}
											snapshot={snapshot}
											todayKey={todayKey}
										/>
									</motion.div>
									<button
										aria-label="Close sidebar"
										className="min-w-0 flex-1 cursor-default bg-foreground/15 outline-none dark:bg-background/55"
										onClick={() => closeRailOverlay(true)}
										tabIndex={-1}
										type="button"
									/>
								</motion.div>
							) : null}
						</AnimatePresence>
						<section
							aria-label={`Calendar, ${title}`}
							className={cn(
								"relative flex min-h-0 min-w-0 flex-1 flex-col",
								railInline && "border-border border-l"
							)}
						>
							{scale === "month" ? (
								<CalendarMonthGrid
									anchor={anchor}
									days={days}
									direction={direction}
									focusKey={selectedKey}
									handlers={handlers}
									itemsByDay={itemsByDay}
									label={title}
									onOpenDay={openWeekOf}
									onSelectDay={(key) => selectDay(key, "main")}
									todayKey={todayKey}
								/>
							) : (
								<CalendarWeekGrid
									days={days}
									direction={direction}
									focusKey={selectedKey}
									handlers={handlers}
									itemsByDay={itemsByDay}
									label={title}
									now={now}
									onSelectDay={(key) => selectDay(key, "main")}
									todayKey={todayKey}
								/>
							)}
							{isEmpty ? (
								<div className="pointer-events-none absolute inset-x-0 top-9 bottom-0 flex items-center justify-center p-6">
									<Empty className="pointer-events-auto max-w-sm flex-none bg-background p-4">
										<EmptyHeader>
											<EmptyTitle>Nothing on the calendar yet</EmptyTitle>
											<EmptyDescription>
												{snapshot.agents.length === 0
													? "Add an agent to start a thread."
													: "Threads appear on the day they were last active."}
											</EmptyDescription>
										</EmptyHeader>
										{newThread ? (
											<EmptyContent>
												<Button
													className="rounded-lg"
													onClick={newThread}
													size="sm"
													type="button"
													variant="outline"
												>
													<Plus aria-hidden="true" data-icon="inline-start" />
													New thread
												</Button>
											</EmptyContent>
										) : null}
									</Empty>
								</div>
							) : null}
						</section>
					</div>
				)}
			</div>
			{/* The open thread spans the full height, so its header shares the
			    toolbar's row and rule. */}
			<AnimatePresence initial={false}>
				{panelOpen && !loading ? (
					<CalendarThreadPanel
						key="panel"
						onClose={closePanel}
						onShowDay={showDayOfThread}
						snapshot={snapshot}
						thread={activeThread}
						threadView={threadView}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}
