import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { useTimezoneRevision } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils";
import {
	localDayKey,
	projectTimeline,
	type TimelineParams,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowLeft, Plus } from "lucide-react";
import { motion } from "motion/react";
import {
	type FocusEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { TimelineDayList, timelineDayHeadingId } from "./timeline-day.tsx";
import {
	EVENT_SELECTOR,
	moveInDayList,
	moveInWeek,
	useNow,
	useTransientHighlight,
} from "./timeline-interface-navigation.ts";
import {
	DayListSkeleton,
	TimelineEmptyRail,
} from "./timeline-interface-placeholders.tsx";
import { displayWallSnapshot, weekRangeLabel } from "./timeline-model.ts";
import { TimelineThreadPanel } from "./timeline-panel.tsx";
import { TIMELINE_EVENT_ATTRIBUTE } from "./timeline-parts.tsx";
import {
	TIMELINE_NOW_ATTRIBUTE,
	TimelineWeekGrid,
	timelineWeekHeadingId,
} from "./timeline-week.tsx";
import { useInterfaceSetting } from "./use-interface-setting.ts";

type Scale = TimelineParams["scale"];

/** Header controls share one height and radius. */
const HEADER_CONTROL = "h-7 rounded-md px-2.5 text-xs";
/**
 * Scale segments: the selected one is lifted off the track in every theme,
 * lighter than the track in dark themes as well as light ones.
 */
const SEGMENT =
	"h-6 rounded-sm px-2.5 text-muted-foreground hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs aria-pressed:ring-1 aria-pressed:ring-border dark:aria-pressed:bg-foreground/15 dark:aria-pressed:ring-0";

const NAV_HINT_ID = "timeline-nav-hint";

/**
 * Timeline: threads across days and weeks. The Day scale is a reverse-
 * chronological rail with sticky day headings; the Week scale is a seven-day
 * grid placing each thread at the local time of its latest activity. Opening
 * a thread keeps the timeline in view and shows the host's real conversation
 * in a side panel.
 */
export function TimelineInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot: hostSnapshot,
	threadView,
}: InterfaceRendererProps<TimelineParams>) {
	const tl = useLiteralMessages();
	const [scale, setScale] = useInterfaceSetting<Scale>(
		port,
		"scale",
		params.scale
	);
	// Days, hours and labels follow the display time zone: the whole Timeline
	// works on its wall clock, as the Calendar does, and re-buckets when it
	// changes (see `useTimezoneRevision`).
	const timezoneRevision = useTimezoneRevision();
	const now = useNow(timezoneRevision);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the revision moves where each thread's day falls.
	const snapshot = useMemo(
		() => displayWallSnapshot(hostSnapshot),
		[hostSnapshot, timezoneRevision]
	);
	const reduceMotion = useReducedMotion();

	const timeline = useMemo(
		() => projectTimeline(snapshot, { scale }, now),
		[snapshot, scale, now]
	);
	const threadsById = useMemo(
		() => new Map(snapshot.threads.map((thread) => [thread.id, thread])),
		[snapshot.threads]
	);
	const activeThread = activeThreadId
		? threadsById.get(activeThreadId)
		: undefined;
	const panelOpen = threadView !== null;
	const workingCount = snapshot.threads.filter(
		(thread) => threadStatus(thread) === "working"
	).length;
	const isEmpty = !loading && snapshot.threads.length === 0;

	const contentRef = useRef<HTMLDivElement>(null);
	const dayScrollerRef = useRef<HTMLDivElement>(null);
	/** A day heading to focus once the Day scale has rendered it. */
	const [pendingDay, setPendingDay] = useState<string | null>(null);
	const [highlightKey, flashDay] = useTransientHighlight();
	/** The thread last focused in the timeline: the region's one Tab stop. */
	const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
	const preferredTabStop = focusedThreadId ?? activeThreadId;

	/** Thread whose row or chip takes focus back once the panel has closed. */
	const restoreFocusRef = useRef<string | null>(null);
	const closeAndRestore = useCallback(() => {
		restoreFocusRef.current = activeThreadId;
		port.closeThread();
	}, [activeThreadId, port]);
	useEffect(() => {
		const root = contentRef.current;
		const threadId = restoreFocusRef.current;
		if (panelOpen || !root || threadId === null) {
			return;
		}
		restoreFocusRef.current = null;
		const frame = requestAnimationFrame(() => {
			const target =
				root.querySelector<HTMLElement>(
					`[data-thread-id="${CSS.escape(threadId)}"]${EVENT_SELECTOR}`
				) ?? root.querySelector<HTMLElement>(`${EVENT_SELECTOR}[tabindex="0"]`);
			target?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [panelOpen]);

	useEffect(() => {
		const root = contentRef.current;
		if (!(root && pendingDay) || scale !== "day") {
			return;
		}
		// Scroll the day's section, not its heading: a sticky heading that is
		// already stuck at the top would not move the list at all.
		const scroller = dayScrollerRef.current;
		const section = root.querySelector<HTMLElement>(
			`[data-day-key="${CSS.escape(pendingDay)}"]`
		);
		if (scroller && section) {
			const offset =
				section.getBoundingClientRect().top -
				scroller.getBoundingClientRect().top;
			scroller.scrollTop =
				section === scroller.querySelector("[data-day-key]")
					? 0
					: scroller.scrollTop + offset;
		}
		root.ownerDocument
			.getElementById(timelineDayHeadingId(pendingDay))
			?.focus({ preventScroll: true });
		flashDay(pendingDay);
		setPendingDay(null);
	}, [pendingDay, scale, flashDay]);

	// Keep the open thread's row or chip in view (including on load).
	useEffect(() => {
		const root = contentRef.current;
		if (!(root && activeThreadId)) {
			return;
		}
		const frame = requestAnimationFrame(() => {
			root
				.querySelector(`[data-thread-id="${CSS.escape(activeThreadId)}"]`)
				?.scrollIntoView({ block: "nearest", inline: "nearest" });
		});
		return () => cancelAnimationFrame(frame);
	}, [activeThreadId]);

	const jumpToToday = () => {
		const root = contentRef.current;
		if (!root) {
			return;
		}
		const todayKey = localDayKey(now);
		if (scale === "week") {
			const heading = root.ownerDocument.getElementById(
				timelineWeekHeadingId(todayKey)
			);
			heading?.scrollIntoView({ block: "nearest", inline: "nearest" });
			heading?.focus({ preventScroll: true });
			root
				.querySelector(`[${TIMELINE_NOW_ATTRIBUTE}]`)
				?.scrollIntoView({ block: "center", inline: "nearest" });
			flashDay(todayKey);
			return;
		}
		const newest = timeline.days[0]?.key;
		const target = timeline.days.some((day) => day.key === todayKey)
			? todayKey
			: newest;
		if (target) {
			setPendingDay(target);
		}
	};

	const showEarlier = () => {
		const weekStart = timeline.days[0]?.key ?? localDayKey(now);
		const older = projectTimeline(snapshot, { scale: "day" }, now).days.find(
			(day) => day.key < weekStart
		);
		setScale("day");
		setPendingDay(older?.key ?? null);
	};

	const onContentKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const root = contentRef.current;
		const target = event.target;
		if (!(root && target instanceof HTMLElement)) {
			return;
		}
		if (event.key === "Escape" && panelOpen) {
			event.preventDefault();
			closeAndRestore();
			return;
		}
		if (!target.hasAttribute(TIMELINE_EVENT_ATTRIBUTE)) {
			return;
		}
		const handled =
			scale === "day"
				? moveInDayList(root, target, event.key)
				: moveInWeek(root, target, event.key);
		if (handled) {
			event.preventDefault();
		}
	};

	const onContentFocus = (event: FocusEvent<HTMLDivElement>) => {
		const target = event.target;
		if (
			target instanceof HTMLElement &&
			target.hasAttribute(TIMELINE_EVENT_ATTRIBUTE) &&
			target.dataset.threadId
		) {
			setFocusedThreadId(target.dataset.threadId);
		}
	};

	const threadCount = snapshot.threads.length;
	const firstKey = timeline.days[0]?.key;
	const lastKey = timeline.days.at(-1)?.key;
	const weekCount = timeline.days.reduce(
		(sum, day) => sum + day.threadIds.length,
		0
	);
	let summary = `${threadCount} ${threadCount === 1 ? "thread" : "threads"}${
		workingCount > 0 ? ` · ${workingCount} working` : ""
	}`;
	if (scale === "week" && firstKey && lastKey) {
		summary = `${weekRangeLabel(firstKey, lastKey)} · ${weekCount} ${
			weekCount === 1 ? "thread" : "threads"
		}`;
	}

	return (
		<div
			className="relative flex size-full min-h-0 flex-col bg-background text-foreground"
			data-testid="interface-timeline"
		>
			<header className="flex h-14 shrink-0 items-center gap-2 border-border border-b px-4">
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1 className="font-medium text-sm leading-5">Timeline</h1>
					{loading || isEmpty ? null : (
						<p className="truncate text-muted-foreground text-xs tabular-nums leading-5 max-sm:hidden">
							{summary}
						</p>
					)}
				</div>
				<nav
					aria-label="Timeline navigation"
					className="flex items-center gap-1"
				>
					{scale === "week" && timeline.earlierCount > 0 ? (
						<Button
							className={cn(
								HEADER_CONTROL,
								"text-muted-foreground max-md:hidden"
							)}
							onClick={showEarlier}
							size="sm"
							title={tl(
								"Open {earlierCount, plural, one {{earlierCountLabel} earlier thread} other {{earlierCountLabel} earlier threads}} in Day view",
								{
									earlierCount: timeline.earlierCount,
									earlierCountLabel: String(timeline.earlierCount),
								}
							)}
							type="button"
							variant="ghost"
						>
							<ArrowLeft aria-hidden="true" data-icon="inline-start" />
							Earlier in Day view
						</Button>
					) : null}
					<Button
						className={HEADER_CONTROL}
						disabled={loading || isEmpty}
						onClick={jumpToToday}
						size="sm"
						title={scale === "day" ? "Jump to today" : "Show today and now"}
						type="button"
						variant="outline"
					>
						Today
					</Button>
					<ToggleGroup
						appearance="segmented"
						aria-label="Timeline scale"
						className="ml-1 h-7 rounded-md bg-muted p-0.5"
						multiple={false}
						onValueChange={(values: string[]) => {
							const value = values[0];
							if (value === "day" || value === "week") {
								setScale(value);
							}
						}}
						spacing={0}
						value={[scale]}
					>
						<ToggleGroupItem
							className={SEGMENT}
							density="segmented"
							value="day"
						>
							Day
						</ToggleGroupItem>
						<ToggleGroupItem
							className={SEGMENT}
							density="segmented"
							value="week"
						>
							Week
						</ToggleGroupItem>
					</ToggleGroup>
				</nav>
				<Button
					aria-label="New thread"
					className={cn(HEADER_CONTROL, "ml-1")}
					onClick={() => port.startThread({})}
					size="sm"
					type="button"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					<span className="max-sm:hidden">New thread</span>
				</Button>
			</header>
			<div className="relative flex min-h-0 flex-1">
				{isEmpty ? (
					<div className="min-h-0 flex-1 overflow-y-auto">
						<TimelineEmptyRail now={now} onStart={() => port.startThread({})} />
					</div>
				) : (
					<div
						aria-busy={loading}
						aria-describedby={loading ? undefined : NAV_HINT_ID}
						aria-label={
							scale === "day" ? "Threads by day" : "Threads this week"
						}
						className="flex min-w-0 flex-1 flex-col"
						onFocus={onContentFocus}
						onKeyDown={onContentKeyDown}
						ref={contentRef}
						role="region"
					>
						<p className="sr-only" id={NAV_HINT_ID}>
							{scale === "day"
								? tl("Use the up and down arrow keys to move between threads.")
								: tl(
										"Use the arrow keys to move between threads and days."
									)}{" "}
							{tl(
								"Press Enter to open a thread and Escape to close it. Tab leaves the timeline."
							)}
						</p>
						{loading ? <DayListSkeleton /> : null}
						{!loading && scale === "day" ? (
							<div
								className="min-h-0 flex-1 overflow-y-auto"
								ref={dayScrollerRef}
							>
								<motion.div
									animate={{ opacity: 1 }}
									initial={reduceMotion ? false : { opacity: 0 }}
									transition={{ duration: 0.18, ease: "easeOut" }}
								>
									<TimelineDayList
										activeThreadId={activeThreadId}
										days={timeline.days}
										highlightKey={highlightKey}
										now={now}
										onOpen={port.openThread}
										preferredTabStop={preferredTabStop}
										snapshot={snapshot}
										threadsById={threadsById}
									/>
								</motion.div>
							</div>
						) : null}
						{!loading && scale === "week" ? (
							<TimelineWeekGrid
								activeThreadId={activeThreadId}
								compact={panelOpen}
								days={timeline.days}
								highlightKey={highlightKey}
								now={now}
								onOpen={port.openThread}
								preferredTabStop={preferredTabStop}
								snapshot={snapshot}
								threadsById={threadsById}
							/>
						) : null}
					</div>
				)}
				{panelOpen ? (
					<TimelineThreadPanel
						now={now}
						onClose={closeAndRestore}
						snapshot={snapshot}
						thread={activeThread}
						threadView={threadView}
					/>
				) : null}
			</div>
		</div>
	);
}
