import { useLiteralMessages } from "@ryu/i18n/react";
import { useTimezoneRevision } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils";
import { type CalendarParams, localDayKey } from "@ryuhq/protocol/interfaces";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarEmptyState } from "./calendar-interface-empty.tsx";
import { CalendarHeader } from "./calendar-interface-header.tsx";
import {
	type FocusRequest,
	isEditable,
	SCALE_KEYS,
	useMediaMatch,
	useNow,
	type Zone,
	zoneOf,
} from "./calendar-interface-hooks.ts";
import { CalendarRailOverlay } from "./calendar-interface-rail-overlay.tsx";
import { CalendarSkeleton } from "./calendar-interface-skeleton.tsx";
import {
	type CalendarLayer,
	type CalendarScale,
	calendarItemsByDay,
	displayWallDate,
	moveDayKey,
	parseDayKey,
	rangeTitle,
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
	const tl = useLiteralMessages();
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
				<CalendarHeader
					anchor={anchor}
					chooseScale={chooseScale}
					loading={loading}
					newThread={newThread}
					railInline={railInline}
					railShown={railShown}
					railToggleRef={railToggleRef}
					scale={scale}
					selectDay={selectDay}
					step={step}
					title={title}
					todayKey={todayKey}
					toggleRail={toggleRail}
				/>
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
						<CalendarRailOverlay
							activeDayKeys={activeDayKeys}
							closeRailOverlay={closeRailOverlay}
							hidden={hidden}
							miniKey={miniKey}
							newThread={newThread}
							now={now}
							onMessage={onMessage}
							railOverlay={railOverlay}
							railOverlayOpen={railOverlayOpen}
							railOverlayRef={railOverlayRef}
							reduceMotion={reduceMotion}
							runs={runs}
							scale={scale}
							selectDay={selectDay}
							selectedKey={selectedKey}
							setMiniKey={setMiniKey}
							snapshot={snapshot}
							todayKey={todayKey}
							toggleLayer={toggleLayer}
						/>
						<section
							aria-label={tl("Calendar, {title}", { title })}
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
								<CalendarEmptyState
									hasAgents={snapshot.agents.length > 0}
									newThread={newThread}
								/>
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
