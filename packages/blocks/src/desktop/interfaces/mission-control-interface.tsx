import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { ActivityChart } from "./mission-control-activity.tsx";
import { AlertsPanel, UpcomingPanel } from "./mission-control-alerts.tsx";
import { MissionHeader } from "./mission-control-header.tsx";
import { useNow } from "./mission-control-hooks.ts";
import { buildMissionControl } from "./mission-control-model.ts";
import { MissionScrim, MissionThreadPanel } from "./mission-control-panel.tsx";
import { KpiTile } from "./mission-control-parts.tsx";
import { StationBoard } from "./mission-control-stations.tsx";
import { EventTape } from "./mission-control-tape.tsx";

/** Relative ages ("3m ago") and the hourly buckets refresh on this beat. */
const WALL_TICK_MS = 30_000;
const KPI_SKELETONS = ["k1", "k2", "k3", "k4", "k5", "k6"] as const;
const PANEL_SKELETONS = ["stations", "alerts", "activity", "upcoming"] as const;

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

/**
 * Two rows of panels from 860px up that share the wall's height, each at
 * least as tall as its content (the board, the chart), so the panels end flush
 * with the tape. The lists scroll in place with a fade, and when the wall is
 * short, <main> scrolls instead.
 */
const PANEL_GRID =
	"grid flex-1 shrink-0 auto-rows-max grid-cols-1 content-start gap-2 @min-[860px]:grid-cols-12 @min-[860px]:grid-rows-[minmax(min-content,1fr)_minmax(min-content,1fr)] @min-[860px]:content-stretch";
const WIDE = "@min-[860px]:col-span-7";
const NARROW = "min-h-56 @min-[860px]:col-span-5";
/** One flat strip of stat cells split by hairlines. */
const KPI_STRIP =
	"grid shrink-0 @min-[640px]:grid-cols-3 @min-[860px]:grid-cols-6 grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border";

function LoadingWall() {
	return (
		<>
			<div className={KPI_STRIP}>
				{KPI_SKELETONS.map((key) => (
					<div className="flex flex-col gap-2 bg-card p-3" key={key}>
						<Skeleton className="h-4 w-20" radius="block" />
						<Skeleton
							className="@min-[1100px]/wall:h-8 h-7 w-12"
							radius="block"
						/>
						<Skeleton
							className="@min-[1100px]/wall:block hidden h-6"
							radius="block"
						/>
					</div>
				))}
			</div>
			<div className={PANEL_GRID}>
				{PANEL_SKELETONS.map((key, index) => (
					<Skeleton
						className={index % 2 === 0 ? `h-64 ${WIDE}` : `h-64 ${NARROW}`}
						key={key}
						radius="dense"
					/>
				))}
			</div>
		</>
	);
}

/**
 * Mission Control: a live wall for a second monitor. With no agents or
 * threads yet it still shows the full wall, zeroed, each panel saying what
 * will appear there. A clock and status
 * banner up top, six KPI tiles with 24-hour spark trends, the agent status
 * board, alerts, hourly activity, upcoming scheduled runs, and a slim tape of
 * the latest updates. Any thread opens in a slide-over over the wall, showing
 * the host's own conversation surface.
 */
export function MissionControlInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["mission-control"]>) {
	const now = useNow(WALL_TICK_MS);
	const view = useMemo(
		() => buildMissionControl(snapshot, now),
		[snapshot, now]
	);
	const panelOpen = threadView !== null && threadView !== undefined;
	const rootRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const alertsRef = useRef<HTMLDivElement>(null);
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
		if (!panelOpen) {
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
			port.closeThread();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [panelOpen, port]);

	const [reviewFlash, setReviewFlash] = useState(false);
	const reviewAlerts = useCallback(() => {
		const list = alertsRef.current;
		const first = list?.querySelector<HTMLElement>("button");
		list?.scrollIntoView({ behavior: "smooth", block: "nearest" });
		if (!first) {
			return;
		}
		first.focus({ preventScroll: true });
		// A mouse click on Review does not draw a focus ring on the row it
		// focuses, so that row stays marked until focus moves on.
		setReviewFlash(true);
		first.addEventListener("blur", () => setReviewFlash(false), {
			once: true,
		});
	}, []);

	const openThreadRecord = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;

	return (
		<div
			aria-busy={loading ? "true" : undefined}
			className="@container/wall relative flex size-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
			data-testid="interface-mission-control"
			ref={rootRef}
		>
			<div className="flex min-h-0 flex-1 flex-col" inert={panelOpen}>
				<MissionHeader
					agentCount={snapshot.agents.length}
					banner={view.banner}
					lastUpdate={view.lastUpdate}
					loading={loading}
					now={now}
					onNewThread={() => startThread()}
					onReview={reviewAlerts}
					threadCount={snapshot.threads.length}
				/>
				<main className="min-h-0 flex-1 overflow-y-auto">
					<div className="flex h-full flex-col gap-2 @min-[1000px]:p-3 p-2">
						{loading ? <LoadingWall /> : null}
						{loading ? null : (
							<>
								<dl aria-label="Key figures" className={KPI_STRIP}>
									{view.kpis.map((kpi) => (
										<KpiTile key={kpi.id} kpi={kpi} />
									))}
								</dl>
								<div className={PANEL_GRID}>
									<div className={`flex ${WIDE}`}>
										<StationBoard
											activeThreadId={panelOpen ? activeThreadId : null}
											now={now}
											onMessage={startThread}
											onOpen={openThread}
											stations={view.stations}
										/>
									</div>
									<div className={`flex ${NARROW}`}>
										<AlertsPanel
											activeThreadId={panelOpen ? activeThreadId : null}
											alerts={view.alerts}
											flash={reviewFlash}
											listRef={alertsRef}
											now={now}
											onMessage={startThread}
											onOpen={openThread}
											snapshot={snapshot}
										/>
									</div>
									<div className={`flex ${WIDE}`}>
										<ActivityChart
											activity={view.activity}
											onOpen={openThread}
											snapshot={snapshot}
										/>
									</div>
									<div className={`flex ${NARROW}`}>
										<UpcomingPanel
											events={view.upcoming}
											now={now}
											recent={view.recentRuns}
											snapshot={snapshot}
										/>
									</div>
								</div>
							</>
						)}
					</div>
				</main>
				<EventTape items={view.tape} onOpen={openThread} snapshot={snapshot} />
			</div>
			<AnimatePresence>
				{panelOpen ? <MissionScrim key="scrim" onClose={closeThread} /> : null}
				{panelOpen ? (
					<MissionThreadPanel
						headingRef={headingRef}
						key="panel"
						now={now}
						onClose={closeThread}
						snapshot={snapshot}
						thread={openThreadRecord}
						threadView={threadView}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}
