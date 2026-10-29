import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { BOARD_STATUS_EMPTY } from "./board-status.tsx";
import { ActivityChart } from "./dashboard-activity.tsx";
import { DashboardHeader } from "./dashboard-header.tsx";
import {
	useDashboardLayout,
	useNow,
	useWidgetDrag,
} from "./dashboard-hooks.ts";
import { AgentList, ThreadList, UpcomingList } from "./dashboard-lists.tsx";
import {
	addWidget,
	availableWidgets,
	buildDashboard,
	cycleWidgetSize,
	type DashboardView,
	DEFAULT_LAYOUT,
	type LayoutItem,
	moveWidget,
	plural,
	removeWidget,
	sameLayout,
	WIDGET_SIZE_NAMES,
	type WidgetId,
	widgetSpec,
} from "./dashboard-model.ts";
import { DashboardScrim, DashboardThreadPanel } from "./dashboard-panel.tsx";
import { StatValue } from "./dashboard-stat.tsx";
import { DashboardWidget, widgetSpanClass } from "./dashboard-widget.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";

/** Relative ages and the hourly buckets refresh on this beat. */
const TICK_MS = 30_000;
/**
 * The grid: 12 columns of 84px rows. Dense flow lets number tiles fill the
 * holes beside a taller panel instead of leaving them empty.
 */
const GRID = "grid grid-flow-row-dense auto-rows-[84px] grid-cols-12 gap-3";
const MOVE_HINT_ID = "dashboard-move-hint";

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

interface WidgetContent {
	body: ReactNode;
	meta?: ReactNode;
}

interface WidgetContext {
	activeThreadId: string | null;
	now: number;
	onOpen: (threadId: string) => void;
	onStart: (agentId: string) => void;
	snapshot: InterfaceRendererProps<unknown>["snapshot"];
	view: DashboardView;
}

function threadsWord(count: number): string {
	return count === 1 ? "thread" : "threads";
}

/** Each tile: one figure and the noun it counts. */
function statContent(id: WidgetId, view: DashboardView): WidgetContent {
	const { stats } = view;
	const tiles: Record<string, { context: string; value: number }> = {
		"stat-agents": {
			context: `of ${plural(stats.agents, "agent")}`,
			value: stats.agentsWorking,
		},
		"stat-attention": {
			context:
				stats.failedRuns > 0
					? `${plural(stats.attention, "thread")}, ${plural(stats.failedRuns, "run")}`
					: threadsWord(stats.attention),
			value: stats.attention + stats.failedRuns,
		},
		"stat-scheduled": {
			context: view.upcoming ? "scheduled runs" : "no schedules",
			value: stats.scheduled24h,
		},
		"stat-updated": {
			context: `of ${plural(stats.threads, "thread")}`,
			value: stats.updated24h,
		},
		"stat-working": {
			context: threadsWord(stats.working),
			value: stats.working,
		},
		"stat-your-turn": {
			context: threadsWord(stats.yourTurn),
			value: stats.yourTurn,
		},
	};
	const tile = tiles[id] ?? { context: "", value: 0 };
	return { body: <StatValue context={tile.context} value={tile.value} /> };
}

function threadWidget(
	context: WidgetContext,
	id: "attention" | "pinned" | "recent" | "working" | "your-turn"
): WidgetContent {
	const { activeThreadId, now, onOpen, snapshot, view } = context;
	const lists = {
		attention: {
			empty: BOARD_STATUS_EMPTY.attention,
			threads: view.byStatus.attention,
			variant: "attention",
		},
		pinned: {
			empty: "Pin a thread to keep it here.",
			threads: view.pinned,
			variant: "mixed",
		},
		recent: {
			empty: "No threads yet.",
			threads: view.recent,
			variant: "mixed",
		},
		working: {
			empty: BOARD_STATUS_EMPTY.working,
			threads: view.byStatus.working,
			variant: "working",
		},
		"your-turn": {
			empty: BOARD_STATUS_EMPTY["your-turn"],
			threads: view.byStatus["your-turn"],
			variant: "your-turn",
		},
	} as const;
	const list = lists[id];
	const runs = id === "attention" ? view.failedRuns : [];
	const count = list.threads.length + runs.length;
	return {
		body: (
			<ThreadList
				activeThreadId={activeThreadId}
				empty={list.empty}
				label={widgetSpec(id).title}
				now={now}
				onOpen={onOpen}
				runs={runs}
				snapshot={snapshot}
				threads={list.threads}
				variant={list.variant}
			/>
		),
		meta: count > 0 ? count : undefined,
	};
}

function widgetContent(id: WidgetId, context: WidgetContext): WidgetContent {
	const { activeThreadId, now, onOpen, onStart, snapshot, view } = context;
	switch (id) {
		case "attention":
		case "pinned":
		case "recent":
		case "working":
		case "your-turn":
			return threadWidget(context, id);
		case "agents":
			return {
				body: (
					<AgentList
						activeThreadId={activeThreadId}
						now={now}
						onOpen={onOpen}
						onStart={onStart}
						rows={view.agents}
					/>
				),
				meta:
					view.stats.agents > 0
						? `${view.stats.agentsWorking} of ${view.stats.agents} working`
						: undefined,
			};
		case "activity":
			return {
				body: (
					<ActivityChart
						activity={view.activity}
						onOpen={onOpen}
						snapshot={snapshot}
					/>
				),
				meta: `${plural(view.activity.total, "thread")} · last 24h`,
			};
		case "upcoming":
			return {
				body: (
					<UpcomingList events={view.upcoming} now={now} snapshot={snapshot} />
				),
				meta:
					view.upcoming && view.upcoming.length > 0
						? view.upcoming.length
						: undefined,
			};
		default:
			return statContent(id, view);
	}
}

function LoadingGrid() {
	return (
		<div aria-hidden="true" className={GRID}>
			{DEFAULT_LAYOUT.map((item) => (
				<Skeleton
					className={cn(widgetSpanClass(item), "rounded-lg")}
					key={item.id}
					radius="row"
				/>
			))}
		</div>
	);
}

/**
 * Dashboard: a grid of widgets the viewer arranges. Number tiles, the three
 * status lists, agents, 24-hour activity, upcoming runs, pinned, and recent.
 * Edit mode reorders (drag or arrow keys), resizes (S, M, L, full width),
 * removes, and adds widgets; the arrangement is remembered per viewer. Any
 * thread opens in a slide-over that shows the host's own conversation.
 */
export function DashboardInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const now = useNow(TICK_MS);
	const view = useMemo(() => buildDashboard(snapshot, now), [snapshot, now]);
	const { layout, reset, update } = useDashboardLayout();
	const { draggingId, startDrag } = useWidgetDrag(update);
	const [editing, setEditing] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const panelOpen = threadView !== null && threadView !== undefined;
	const rootRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const gridRef = useRef<HTMLDivElement>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const wasOpenRef = useRef(panelOpen);

	const rememberFocus = useCallback(() => {
		const active = document.activeElement;
		returnFocusRef.current = active instanceof HTMLElement ? active : null;
	}, []);
	const openThread = useCallback(
		(threadId: string) => {
			rememberFocus();
			port.openThread(threadId);
		},
		[port, rememberFocus]
	);
	const startThread = useCallback(
		(agentId?: string) => {
			rememberFocus();
			port.startThread(agentId ? { agentId } : {});
		},
		[port, rememberFocus]
	);
	const closeThread = useCallback(() => port.closeThread(), [port]);

	useEffect(() => {
		const wasOpen = wasOpenRef.current;
		wasOpenRef.current = panelOpen;
		if (panelOpen && !wasOpen) {
			headingRef.current?.focus({ preventScroll: true });
		} else if (!panelOpen && wasOpen) {
			const target = returnFocusRef.current;
			returnFocusRef.current = null;
			if (target?.isConnected) {
				target.focus({ preventScroll: true });
			}
		}
	}, [panelOpen]);

	useEffect(() => {
		if (!(panelOpen || editing)) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
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
			if (panelOpen) {
				port.closeThread();
			} else {
				setEditing(false);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [editing, panelOpen, port]);

	const focusHandle = useCallback((index: number) => {
		requestAnimationFrame(() => {
			const handles = gridRef.current?.querySelectorAll<HTMLElement>(
				`[aria-describedby="${MOVE_HINT_ID}"]`
			);
			if (!handles || handles.length === 0) {
				return;
			}
			handles[Math.min(index, handles.length - 1)]?.focus();
		});
	}, []);

	const move = useCallback(
		(item: LayoutItem, toIndex: number) => {
			update((current) => moveWidget(current, item.id, toIndex));
			setAnnouncement(
				`${widgetSpec(item.id).title} moved to position ${toIndex + 1} of ${layout.length}.`
			);
		},
		[layout.length, update]
	);
	const cycleSize = useCallback(
		(item: LayoutItem) => {
			update((current) => cycleWidgetSize(current, item.id));
			const next = cycleWidgetSize([item], item.id)[0];
			if (next) {
				setAnnouncement(
					`${widgetSpec(item.id).title} is now ${WIDGET_SIZE_NAMES[next.size]}.`
				);
			}
		},
		[update]
	);
	const remove = useCallback(
		(item: LayoutItem, index: number) => {
			update((current) => removeWidget(current, item.id));
			setAnnouncement(`${widgetSpec(item.id).title} removed.`);
			focusHandle(index);
		},
		[focusHandle, update]
	);
	const add = useCallback(
		(id: WidgetId) => {
			update((current) => addWidget(current, id));
			setAnnouncement(`${widgetSpec(id).title} added.`);
		},
		[update]
	);
	const resetLayout = useCallback(() => {
		reset();
		setAnnouncement("Dashboard reset to the default widgets.");
	}, [reset]);

	const context: WidgetContext = {
		activeThreadId: panelOpen ? activeThreadId : null,
		now,
		onOpen: openThread,
		onStart: startThread,
		snapshot,
		view,
	};
	const empty =
		!loading && snapshot.agents.length === 0 && snapshot.threads.length === 0;
	const openRecord = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;

	let content: ReactNode;
	if (loading) {
		content = <LoadingGrid />;
	} else if (empty) {
		content = (
			<Empty appearance="bordered" className="min-h-80 rounded-lg">
				<EmptyHeader>
					<EmptyTitle>No threads or agents yet</EmptyTitle>
					<EmptyDescription>
						Widgets fill in as agents work: replies waiting on you, failed runs,
						live work, and the last 24 hours of activity.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={() => startThread()} size="sm" type="button">
						Start a thread
					</Button>
				</EmptyContent>
			</Empty>
		);
	} else if (layout.length === 0) {
		content = (
			<Empty appearance="bordered" className="min-h-80 rounded-lg">
				<EmptyHeader>
					<EmptyTitle>This dashboard has no widgets</EmptyTitle>
					<EmptyDescription>
						{editing
							? "Use Add widget to choose what to show."
							: "Edit the dashboard to add lists, charts, and numbers."}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={resetLayout}
						size="sm"
						type="button"
						variant="outline"
					>
						Restore default widgets
					</Button>
				</EmptyContent>
			</Empty>
		);
	} else {
		content = (
			<div className={GRID} ref={gridRef}>
				<AnimatePresence initial={false} mode="popLayout">
					{layout.map((item, index) => {
						const { body, meta } = widgetContent(item.id, context);
						return (
							<DashboardWidget
								edit={
									editing
										? {
												count: layout.length,
												dragging: draggingId === item.id,
												index,
												onCycleSize: () => cycleSize(item),
												onMove: (toIndex) => move(item, toIndex),
												onRemove: () => remove(item, index),
												onStartDrag: (event) => startDrag(item.id, event),
											}
										: null
								}
								item={item}
								key={item.id}
								meta={meta}
								title={widgetSpec(item.id).title}
							>
								{body}
							</DashboardWidget>
						);
					})}
				</AnimatePresence>
			</div>
		);
	}

	return (
		<div
			aria-busy={loading ? "true" : undefined}
			className="@container/dash relative flex size-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
			data-editing={editing ? "true" : undefined}
			data-testid="interface-dashboard"
			ref={rootRef}
		>
			<div className="flex min-h-0 flex-1 flex-col" inert={panelOpen}>
				<DashboardHeader
					agentCount={snapshot.agents.length}
					available={availableWidgets(layout)}
					canReset={!sameLayout(layout, DEFAULT_LAYOUT)}
					editing={editing}
					onAdd={add}
					onEditChange={setEditing}
					onNewThread={() => startThread()}
					onReset={resetLayout}
					threadCount={snapshot.threads.length}
				/>
				<main className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto w-full max-w-[1600px] @min-[640px]/dash:p-6 p-4">
						{content}
					</div>
				</main>
				<p className="sr-only" id={MOVE_HINT_ID}>
					Use the arrow keys to move this widget. Home and End move it to the
					start or end.
				</p>
				<p aria-live="polite" className="sr-only" role="status">
					{announcement}
				</p>
			</div>
			<AnimatePresence>
				{panelOpen ? (
					<DashboardScrim key="scrim" onClose={closeThread} />
				) : null}
				{panelOpen ? (
					<DashboardThreadPanel
						headingRef={headingRef}
						key="panel"
						now={now}
						onClose={closeThread}
						snapshot={snapshot}
						thread={openRecord}
						threadView={threadView}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}
