import { Button } from "@ryu/ui/components/button.tsx";
import { Toggle } from "@ryu/ui/components/toggle.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Plus,
} from "lucide-react";
import { motion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import {
	agentById,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";
import { JournalDayPage } from "./journal-day.tsx";
import { JournalEntryPage } from "./journal-entry.tsx";
import {
	buildJournalEntries,
	countLabel,
	currentStreak,
	entriesByDay,
	entryNeighbors,
	entryTitle,
	eventsOnDay,
	filterJournalEntries,
	type JournalEntry,
	type JournalView,
	journalStats,
	mediumDateLabel,
	onThisDay,
	shiftDayKey,
	shiftMonthKey,
	timeLabel,
} from "./journal-model.ts";
import {
	JournalComposer,
	JournalIconButton,
	titleFace,
} from "./journal-parts.tsx";
import {
	JournalSearch,
	JournalStrip,
	JournalTimeline,
} from "./journal-sidebar.tsx";
import { JournalCalendar, JournalStatsPage } from "./journal-views.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const MINUTE = 60_000;
/** Below this width the timeline and the page take turns. */
const STACK_BELOW = 720;
/** Below this width the timeline narrows to give the page room. */
const NARROW_BELOW = 1100;
const SERIF_KEY = "ryu.interfaces.journal.serif";
const EASE = [0.22, 1, 0.36, 1] as const;

const VIEWS: { id: JournalView; label: string }[] = [
	{ id: "day", label: "Day" },
	{ id: "calendar", label: "Calendar" },
	{ id: "stats", label: "Stats" },
];

function readSerif(): boolean {
	try {
		return window.localStorage.getItem(SERIF_KEY) !== "off";
	} catch {
		return true;
	}
}

function writeSerif(serif: boolean): void {
	try {
		window.localStorage.setItem(SERIF_KEY, serif ? "on" : "off");
	} catch {
		// Storage can be blocked; the choice then lasts for this session only.
	}
}

/** Wall clock that ticks once a minute so "today" rolls over at midnight. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's width, kept current with a ResizeObserver. */
function useElementWidth(ref: { current: HTMLElement | null }): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((records) => {
			const rect = records[0]?.contentRect;
			if (rect) {
				setWidth(rect.width);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

function isEditable(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}

/** Whether the element is rendered (not detached or inside display: none). */
function isShown(element: HTMLElement): boolean {
	if (!element.isConnected) {
		return false;
	}
	return typeof element.checkVisibility === "function"
		? element.checkVisibility()
		: element.getClientRects().length > 0;
}

/** Escapes a value for a quoted CSS attribute selector. */
function cssString(value: string): string {
	return value.replace(/["\\]/g, "\\$&");
}

interface JournalPager {
	atToday: boolean;
	nextKeys?: string[];
	nextLabel: string;
	nextShortcut?: string;
	onStep: (direction: -1 | 1) => void;
	onToday: () => void;
	previousKeys?: string[];
	previousLabel: string;
	previousShortcut?: string;
}

/** The toolbar's previous / Today / next group for the day and month pages. */
function pagerFor(
	view: JournalView,
	actions: Pick<JournalPager, "atToday" | "onStep" | "onToday">
): JournalPager | null {
	if (view === "day") {
		return {
			...actions,
			nextKeys: ["⌥", "→"],
			nextLabel: "Next day",
			nextShortcut: "Alt+ArrowRight",
			previousKeys: ["⌥", "←"],
			previousLabel: "Previous day",
			previousShortcut: "Alt+ArrowLeft",
		};
	}
	if (view === "calendar") {
		return {
			...actions,
			nextLabel: "Next month",
			previousLabel: "Previous month",
		};
	}
	return null;
}

/**
 * Journal: conversations as Day One entries. The timeline files each thread
 * on the day of its latest activity; the page shows a day, the month, or the
 * journal's stats, and opening an entry puts the host's conversation in the
 * entry body.
 */
export function JournalInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const width = useElementWidth(rootRef);
	const now = useMinuteClock();
	const reduceMotion = useReducedMotion();
	// Unmeasured (server render, tests): assume a desktop window.
	const stacked = width > 0 && width < STACK_BELOW;
	const narrow = width > 0 && width < NARROW_BELOW;
	const timelineRef = useRef<HTMLDivElement>(null);

	const today = useMemo(() => new Date(now), [now]);
	const todayKey = localDayKey(today);

	const entries = useMemo(() => buildJournalEntries(snapshot), [snapshot]);
	const byDay = useMemo(() => entriesByDay(entries), [entries]);
	const stats = useMemo(() => journalStats(entries, today), [entries, today]);
	const streak = useMemo(
		() => currentStreak(new Set(byDay.keys()), today),
		[byDay, today]
	);

	const [view, setView] = useState<JournalView>("day");
	const [selectedDay, setSelectedDay] = useState(todayKey);
	const [stripExpanded, setStripExpanded] = useState(false);
	const [query, setQuery] = useState("");
	const [composing, setComposing] = useState(false);
	const [draftAgentId, setDraftAgentId] = useState<string>();
	const [serif, setSerif] = useState(true);
	const [pane, setPane] = useState<"list" | "page">(() =>
		activeThreadId ? "page" : "list"
	);

	useEffect(() => {
		setSerif(readSerif());
	}, []);

	const shown = useMemo(
		() => filterJournalEntries(entries, query),
		[entries, query]
	);
	const activeEntry =
		(activeThreadId
			? entries.find((entry) => entry.thread.id === activeThreadId)
			: undefined) ?? null;
	const entryOpen = threadView !== null && threadView !== undefined;

	// Follow the open entry to its day, so the strip and timeline agree.
	const activeDay = activeEntry?.day;
	useEffect(() => {
		if (activeDay) {
			setSelectedDay(activeDay);
		}
	}, [activeDay]);

	// Keep the timeline on the selected day, or on the open entry's row, so
	// strip, page, and list agree.
	const followSelector = entryOpen
		? activeThreadId
			? `[data-thread-id="${cssString(activeThreadId)}"]`
			: null
		: `[data-day="${selectedDay}"]`;
	useEffect(() => {
		if (!followSelector) {
			return;
		}
		const target = timelineRef.current?.querySelector(followSelector);
		if (target instanceof HTMLElement && "scrollIntoView" in target) {
			target.scrollIntoView({
				behavior: reduceMotion ? "auto" : "smooth",
				block: "nearest",
			});
		}
	}, [followSelector, reduceMotion]);

	const titleClass = titleFace(serif);
	const transition = reduceMotion
		? { duration: 0 }
		: { duration: 0.2, ease: EASE };

	const showPage = useCallback(() => {
		setPane("page");
	}, []);

	const selectDay = useCallback(
		(key: string) => {
			setSelectedDay(key);
			setView("day");
			setComposing(false);
			showPage();
			if (entryOpen) {
				port.closeThread();
			}
		},
		[entryOpen, port, showPage]
	);

	const openEntry = useCallback(
		(entry: JournalEntry) => {
			setComposing(false);
			setDraftAgentId(undefined);
			showPage();
			port.openThread(entry.thread.id);
		},
		[port, showPage]
	);

	const newEntry = useCallback(() => {
		setView("day");
		setSelectedDay(todayKey);
		setComposing(true);
		showPage();
		if (entryOpen) {
			port.closeThread();
		}
	}, [entryOpen, port, showPage, todayKey]);

	const chooseView = useCallback(
		(next: JournalView) => {
			setView(next);
			setComposing(false);
			if (entryOpen) {
				port.closeThread();
			}
		},
		[entryOpen, port]
	);

	const neighbors = entryNeighbors(entries, activeThreadId);
	const stepEntry = (direction: -1 | 1) => {
		const target = direction === -1 ? neighbors.previous : neighbors.next;
		if (target) {
			openEntry(target);
		}
	};
	const stepDay = (direction: -1 | 1) => {
		setComposing(false);
		setSelectedDay((key) => shiftDayKey(key, direction));
	};
	const pageStrip = (direction: -1 | 1) => {
		setSelectedDay((key) =>
			stripExpanded
				? shiftMonthKey(key, direction)
				: shiftDayKey(key, 7 * direction)
		);
	};

	const onShortcut = (event: globalThis.KeyboardEvent) => {
		if (event.defaultPrevented || !event.altKey || isEditable(event.target)) {
			return;
		}
		if (entryOpen && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
			event.preventDefault();
			stepEntry(event.key === "ArrowUp" ? -1 : 1);
			return;
		}
		if (
			!entryOpen &&
			view === "day" &&
			(event.key === "ArrowLeft" || event.key === "ArrowRight")
		) {
			event.preventDefault();
			stepDay(event.key === "ArrowLeft" ? -1 : 1);
		}
	};

	// The toolbar advertises these shortcuts, so they work from anywhere in
	// the journal (the open entry's thread included) and from <body>, outside
	// text fields, while the journal is on screen. Keys from the host's own
	// chrome, or while a host page covers the journal, are not ours.
	const shortcutRef = useRef(onShortcut);
	shortcutRef.current = onShortcut;
	useEffect(() => {
		const listener = (event: globalThis.KeyboardEvent) => {
			const root = rootRef.current;
			if (!(root && isShown(root)) || isInterfaceCovered(root)) {
				return;
			}
			const target = event.target;
			const ours =
				target === document.body ||
				target === document.documentElement ||
				(target instanceof Node && root.contains(target));
			if (!ours) {
				return;
			}
			shortcutRef.current(event);
		};
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, []);

	const dayEntries = byDay.get(selectedDay) ?? [];
	const latestDay = entries[0]?.day ?? null;
	const draftAgent = agentById(snapshot, draftAgentId);

	let page: ReactNode;
	let pageKey: string;
	if (entryOpen) {
		pageKey = `entry:${activeThreadId ?? "new"}`;
		page = (
			<JournalEntryPage
				draftAgents={draftAgent ? [draftAgent] : []}
				draftPlace={null}
				entry={activeEntry}
				threadView={threadView}
				titleClass={titleClass}
			/>
		);
	} else if (view === "calendar") {
		pageKey = `calendar:${selectedDay.slice(0, 7)}`;
		page = (
			<JournalCalendar
				byDay={byDay}
				monthKey={selectedDay}
				onSelectDay={selectDay}
				selectedDay={selectedDay}
				titleClass={titleClass}
				todayKey={todayKey}
			/>
		);
	} else if (view === "stats") {
		pageKey = "stats";
		page = (
			<JournalStatsPage
				byDay={byDay}
				onSelectDay={selectDay}
				stats={stats}
				titleClass={titleClass}
				today={today}
			/>
		);
	} else {
		pageKey = `day:${selectedDay}`;
		page = (
			<JournalDayPage
				composer={
					composing ? (
						<JournalComposer
							agents={snapshot.agents}
							dateLine={`Now · ${timeLabel(today)}`}
							onCancel={() => setComposing(false)}
							onSubmit={({ agentId, prompt }) => {
								setComposing(false);
								setDraftAgentId(agentId);
								port.startThread({ agentId, prompt });
							}}
							titleClass={titleClass}
						/>
					) : null
				}
				dayKey={selectedDay}
				entries={dayEntries}
				events={eventsOnDay(snapshot.events, selectedDay)}
				isFuture={selectedDay > todayKey}
				isToday={selectedDay === todayKey}
				latestDay={latestDay}
				loading={loading}
				onNewEntry={newEntry}
				onOpen={openEntry}
				onSelectDay={selectDay}
				onThisDayGroups={onThisDay(byDay, selectedDay)}
				snapshot={snapshot}
				titleClass={titleClass}
			/>
		);
	}

	const sidebar = (
		<aside
			aria-label="Journal"
			className={cn(
				"flex min-h-0 flex-col bg-background",
				stacked
					? "w-full"
					: cn("shrink-0 border-border border-e", narrow ? "w-72" : "w-80")
			)}
		>
			<div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-4">
				<h2
					className={cn(
						"font-semibold text-foreground text-lg leading-7",
						titleClass
					)}
				>
					Journal
				</h2>
				<p className="ms-auto flex shrink-0 items-baseline gap-1 text-muted-foreground text-xs">
					{streak > 0 ? (
						<>
							<span className="font-semibold text-foreground text-sm tabular-nums">
								{streak}
							</span>
							{" day streak"}
						</>
					) : (
						countLabel(entries.length, "entry", "entries")
					)}
				</p>
				{stacked ? (
					<Button
						aria-label="New entry"
						onClick={newEntry}
						size="icon-sm"
						title="New entry"
						variant="ghost"
					>
						<Plus aria-hidden="true" className="size-4" />
					</Button>
				) : null}
			</div>
			<JournalStrip
				days={byDay}
				expanded={stripExpanded}
				onExpandedChange={setStripExpanded}
				onPage={pageStrip}
				onSelect={selectDay}
				selectedDay={selectedDay}
				todayKey={todayKey}
				transition={transition}
			/>
			<JournalSearch onChange={setQuery} query={query} />
			<div
				className="min-h-0 flex-1 overflow-y-auto border-border border-t"
				ref={timelineRef}
			>
				<JournalTimeline
					activeThreadId={entryOpen ? activeThreadId : null}
					entries={shown}
					loading={loading}
					onNewEntry={newEntry}
					onOpen={openEntry}
					query={query}
					selectedDay={entryOpen ? null : selectedDay}
					titleClass={titleClass}
				/>
			</div>
		</aside>
	);

	const pager = pagerFor(view, {
		atToday:
			view === "calendar"
				? selectedDay.slice(0, 7) === todayKey.slice(0, 7)
				: selectedDay === todayKey,
		onStep: (direction) => {
			if (view === "calendar") {
				setSelectedDay((key) => shiftMonthKey(key, direction));
			} else {
				stepDay(direction);
			}
		},
		onToday: () => {
			if (view === "calendar") {
				setSelectedDay(todayKey);
			} else {
				selectDay(todayKey);
			}
		},
	});

	const toolbar = (
		<div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-3">
			{stacked ? (
				<Button onClick={() => setPane("list")} size="sm" variant="ghost">
					<ChevronLeft
						aria-hidden="true"
						className="size-4"
						data-icon="inline-start"
					/>
					Entries
				</Button>
			) : null}
			{entryOpen ? (
				<>
					{stacked ? null : (
						<Button
							onClick={() => selectDay(activeEntry?.day ?? todayKey)}
							size="sm"
							variant="ghost"
						>
							<ChevronLeft
								aria-hidden="true"
								className="size-4"
								data-icon="inline-start"
							/>
							{mediumDateLabel(activeEntry?.day ?? todayKey)}
						</Button>
					)}
					<div className="ms-auto flex items-center gap-1">
						{neighbors.position > 0 ? (
							<span className="pe-2 text-muted-foreground text-xs tabular-nums">
								{neighbors.position} of{" "}
								{countLabel(neighbors.total, "entry", "entries")}
							</span>
						) : null}
						<JournalIconButton
							disabled={!neighbors.previous}
							hint={
								neighbors.previous
									? `Newer: ${entryTitle(neighbors.previous.thread)}`
									: "Newer entry"
							}
							keys={["⌥", "↑"]}
							label="Newer entry"
							onClick={() => stepEntry(-1)}
							shortcut="Alt+ArrowUp"
						>
							<ChevronUp aria-hidden="true" className="size-4" />
						</JournalIconButton>
						<JournalIconButton
							disabled={!neighbors.next}
							hint={
								neighbors.next
									? `Older: ${entryTitle(neighbors.next.thread)}`
									: "Older entry"
							}
							keys={["⌥", "↓"]}
							label="Older entry"
							onClick={() => stepEntry(1)}
							shortcut="Alt+ArrowDown"
						>
							<ChevronDown aria-hidden="true" className="size-4" />
						</JournalIconButton>
					</div>
				</>
			) : (
				<>
					<ToggleGroup
						appearance="segmented"
						aria-label="View"
						onValueChange={(values: unknown[]) => {
							const next = VIEWS.find((item) => item.id === values[0]);
							if (next) {
								chooseView(next.id);
							}
						}}
						spacing={0}
						value={[view]}
					>
						{VIEWS.map((item) => (
							<ToggleGroupItem
								density="segmented"
								key={item.id}
								value={item.id}
							>
								{item.label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
					{pager ? (
						<div className="flex items-center max-sm:hidden">
							<JournalIconButton
								keys={pager.previousKeys}
								label={pager.previousLabel}
								onClick={() => pager.onStep(-1)}
								shortcut={pager.previousShortcut}
							>
								<ChevronLeft aria-hidden="true" className="size-4" />
							</JournalIconButton>
							<Button
								aria-disabled={pager.atToday || undefined}
								className={cn(
									pager.atToday &&
										"cursor-default text-muted-foreground hover:bg-transparent hover:text-muted-foreground"
								)}
								onClick={pager.atToday ? undefined : pager.onToday}
								size="sm"
								variant="ghost"
							>
								Today
							</Button>
							<JournalIconButton
								keys={pager.nextKeys}
								label={pager.nextLabel}
								onClick={() => pager.onStep(1)}
								shortcut={pager.nextShortcut}
							>
								<ChevronRight aria-hidden="true" className="size-4" />
							</JournalIconButton>
						</div>
					) : null}
					<div className="ms-auto flex items-center gap-1">
						<Tooltip>
							<TooltipTrigger
								render={
									<Toggle
										aria-label="Serif titles"
										className={cn(
											"text-muted-foreground aria-pressed:bg-transparent aria-pressed:text-foreground aria-pressed:hover:bg-muted",
											serif ? "font-serif" : "font-sans"
										)}
										onPressedChange={(pressed: boolean) => {
											setSerif(pressed);
											writeSerif(pressed);
										}}
										pressed={serif}
										size="sm"
									/>
								}
							>
								{/* An element, not bare text: bare text gets its own overflow tooltip. */}
								<span>Aa</span>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{serif ? "Serif titles: on" : "Serif titles: off"}
							</TooltipContent>
						</Tooltip>
						<Button onClick={newEntry} size="sm" variant="default">
							<Plus
								aria-hidden="true"
								className="size-4"
								data-icon="inline-start"
							/>
							New entry
						</Button>
					</div>
				</>
			)}
		</div>
	);

	const main = (
		<main
			aria-label={
				entryOpen ? "Entry" : VIEWS.find((item) => item.id === view)?.label
			}
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
		>
			{toolbar}
			<div
				className={cn(
					"relative min-h-0 flex-1",
					entryOpen ? "flex flex-col" : "overflow-y-auto"
				)}
			>
				<motion.div
					animate={{ opacity: 1, y: 0 }}
					className={cn(entryOpen && "flex min-h-0 flex-1 flex-col")}
					initial={reduceMotion ? false : { opacity: 0, y: 4 }}
					key={pageKey}
					transition={transition}
				>
					{page}
				</motion.div>
			</div>
		</main>
	);

	return (
		<div
			className="flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-journal"
			ref={rootRef}
		>
			{stacked ? (
				pane === "list" ? (
					sidebar
				) : (
					main
				)
			) : (
				<>
					{sidebar}
					{main}
				</>
			)}
		</div>
	);
}
