import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import { motion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
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
	cssString,
	EASE,
	isEditable,
	isShown,
	NARROW_BELOW,
	pagerFor,
	readSerif,
	STACK_BELOW,
	useElementWidth,
	useMinuteClock,
	VIEWS,
} from "./journal-interface-support.ts";
import { JournalToolbar } from "./journal-interface-toolbar.tsx";
import {
	buildJournalEntries,
	countLabel,
	currentStreak,
	entriesByDay,
	entryNeighbors,
	eventsOnDay,
	filterJournalEntries,
	type JournalEntry,
	type JournalView,
	journalStats,
	onThisDay,
	shiftDayKey,
	shiftMonthKey,
	timeLabel,
} from "./journal-model.ts";
import { JournalComposer, titleFace } from "./journal-parts.tsx";
import {
	JournalSearch,
	JournalStrip,
	JournalTimeline,
} from "./journal-sidebar.tsx";
import { JournalCalendar, JournalStatsPage } from "./journal-views.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

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
		<JournalToolbar
			activeEntry={activeEntry}
			chooseView={chooseView}
			entryOpen={entryOpen}
			neighbors={neighbors}
			newEntry={newEntry}
			pager={pager}
			selectDay={selectDay}
			serif={serif}
			setPane={setPane}
			setSerif={setSerif}
			stacked={stacked}
			stepEntry={stepEntry}
			todayKey={todayKey}
			view={view}
		/>
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
