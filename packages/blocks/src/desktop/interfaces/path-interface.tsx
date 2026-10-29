import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { Footprints, Plus } from "lucide-react";
import {
	type CSSProperties,
	type FocusEvent,
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	GameAction,
	GameLegend,
	GamePlate,
	GameTitlePlate,
	gameTitleHeight,
} from "./game-hud.tsx";
import { GameHudSlot, GameShell, gameSheetCover } from "./game-shell.tsx";
import {
	actOverlays,
	actSummaryLine,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import {
	IsoStage,
	IsoZoomControls,
	useGameNight,
	useIsoView,
	useReducedMotion,
} from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActAgentList,
	ActAnnouncer,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	agentStones,
	type PathActScene,
	pathActVillagers,
	pathPaths,
} from "./path-acts.tsx";
import { PathDiorama } from "./path-diorama.tsx";
import {
	buildPath,
	type PathUnit,
	pathLeaderboard,
	pathStats,
	pathSwing,
	pathUnitItemCount,
} from "./path-model.ts";
import { PATH_SCENE_MODE, PATH_SCENE_VARS } from "./path-palette.ts";
import { PathThreadPanel } from "./path-panel.tsx";
import { PathStatsBar } from "./path-rail.tsx";
import {
	PATH_STOP_ATTRIBUTE,
	PathFinishItem,
	pathAddKey,
} from "./path-stop.tsx";
import { PathUnitSection } from "./path-unit.tsx";
import { layoutPathWorld } from "./path-world.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

/** How long a requested focus move may wait for the host to open or close. */
const FOCUS_REQUEST_TTL_MS = 2000;
const NAV_HINT_ID = "path-nav-hint";

/** Below this stage width the HUD plates go compact. */
const COMPACT_BELOW = 720;

/** The island's rim round the trail, for trees and shore. */
const ISLAND_RIM = 2.4;

/** What the stones' colours and marks mean, for the HUD's legend. */
const LEGEND_ITEMS = [
	{ className: "bg-(--gk-gold)", key: "done", label: "Done" },
	{ className: "bg-(--gk-warn)", key: "current", label: "Up next" },
	{ className: "bg-(--gk-info)", key: "reply", label: "Your turn" },
	{ className: "bg-(--gk-bad)", key: "attention", label: "Needs you" },
	{ className: "bg-(--gk-good)", key: "working", label: "Working" },
] as const;
/**
 * The path's horizontal geometry: its center and one swing step. Narrow
 * columns move the path left and tighten the swing so labels fit beside it.
 */
const PATH_GEOMETRY =
	"[--path-center:50%] [--path-step:min(68px,11.5cqw)] @max-[519px]/col:[--path-center:26%] @max-[519px]/col:[--path-step:18px]";

interface FocusRequest {
	at: number;
	to: "opener" | "panel";
}

/** Escape inside a text field belongs to the field (or the host's composer). */
function isEditable(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

const STOP_SELECTOR = `[${PATH_STOP_ATTRIBUTE}]`;

/** Every stop key on the path, in path order. */
function pathStopKeys(units: readonly PathUnit[]): string[] {
	const keys: string[] = [];
	for (const unit of units) {
		for (const stop of unit.stops) {
			keys.push(stop.thread.id);
		}
		keys.push(pathAddKey(unit.id));
	}
	return keys;
}

/**
 * The path's single Tab stop: the last stop you focused, else the open
 * thread, else the stop the path points at, else the first one.
 */
function tabStopKey(
	keys: readonly string[],
	candidates: readonly (string | null | undefined)[]
): string | null {
	for (const candidate of candidates) {
		if (candidate && keys.includes(candidate)) {
			return candidate;
		}
	}
	return keys[0] ?? null;
}

/** Up/Down (and Home/End) walk the path from stop to stop. */
function moveAlongPath(
	root: HTMLElement,
	from: HTMLElement,
	key: string
): boolean {
	const stops = [...root.querySelectorAll<HTMLElement>(STOP_SELECTOR)];
	const index = stops.indexOf(from);
	if (index === -1) {
		return false;
	}
	const target = pathKeyTarget(key, index, stops.length);
	if (target === null) {
		return false;
	}
	stops[target]?.focus();
	return true;
}

function pathKeyTarget(key: string, index: number, count: number) {
	switch (key) {
		case "ArrowDown":
			return Math.min(count - 1, index + 1);
		case "ArrowUp":
			return Math.max(0, index - 1);
		case "End":
			return count - 1;
		case "Home":
			return 0;
		default:
			return null;
	}
}

/**
 * Bring a stop into view the way the reference opens on the current lesson:
 * with its unit's banner at the top when that still shows the stop, centered
 * (clear of the sticky banner) otherwise.
 */
function revealStop(scroller: HTMLElement, threadId: string) {
	const stop = scroller.querySelector<HTMLElement>(
		`[data-thread-id="${CSS.escape(threadId)}"]`
	);
	if (!stop) {
		return;
	}
	const view = scroller.getBoundingClientRect();
	const rect = stop.getBoundingClientRect();
	const section = stop.closest("section");
	const sectionTop = section?.getBoundingClientRect().top;
	// The banner sticks below the HUD: its sticky offset is the top inset.
	const banner = section?.firstElementChild;
	const inset =
		banner instanceof HTMLElement
			? Number.parseFloat(getComputedStyle(banner).top) || 0
			: 0;
	// The stop's label and ring sit up to 24px below its box.
	if (
		sectionTop !== undefined &&
		rect.bottom + 24 - sectionTop <= view.height - inset
	) {
		scroller.scrollTop += sectionTop - view.top - inset;
		return;
	}
	const target = view.top + (view.height + 96 + inset) / 2;
	scroller.scrollTop += rect.top + rect.height / 2 - target;
}

function PathSkeleton() {
	const rows = [
		{ id: "a", swing: 0 },
		{ id: "b", swing: -1 },
		{ id: "c", swing: -1.6 },
		{ id: "d", swing: -1 },
		{ id: "e", swing: 0 },
	];
	return (
		<div aria-hidden="true" className={cn("flex flex-col", PATH_GEOMETRY)}>
			<div className="pt-4 pb-4">
				<Skeleton className="h-[92px]" />
			</div>
			<ul className="flex flex-col pt-8">
				{rows.map(({ id, swing }) => (
					<li
						className="relative h-[104px]"
						key={id}
						// SAFETY: React's CSSProperties omits custom properties; the
						// swing is a plain number the skeleton's `left` calc uses.
						style={{ "--path-swing": swing } as CSSProperties}
					>
						<Skeleton
							className="absolute top-0 left-[calc(var(--path-center)+var(--path-swing)*var(--path-step)-32px)] size-16"
							radius="pill"
						/>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Path: every conversation as a stop on a winding trail across a meadow, on
 * the shared game kit (game-shell.tsx), grouped into units (projects, teams,
 * each agent's unfiled threads). Finished stops show a check and the trail up
 * to the last one is trodden; the one that needs you next is raised with a
 * callout and a "you are here" flag; live runs spin a progress ring; threads
 * waiting on an agent are dimmed. The HUD keeps the streak, XP and daily
 * goal; a rail of plates shows the goal and the agent leaderboard on wide
 * stages; opening a stop shows the host's real conversation in the sheet.
 */
export function PathInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["path"]>) {
	const reduceMotion = useReducedMotion();
	const model = useMemo(() => buildPath(snapshot), [snapshot]);
	const stats = useMemo(() => pathStats(snapshot), [snapshot]);
	const leaders = useMemo(() => pathLeaderboard(snapshot), [snapshot]);
	const now = Date.now();
	const panelOpen = threadView !== null;
	const [focusedKey, setFocusedKey] = useState<string | null>(null);
	const stopKeys = useMemo(() => pathStopKeys(model.units), [model.units]);
	const rovingKey = tabStopKey(stopKeys, [
		focusedKey,
		activeThreadId,
		model.currentThreadId,
	]);

	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLElement>(null);
	const [stageWidth, setStageWidth] = useState(0);
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setStageWidth(entry.contentRect.width);
			}
		});
		observer.observe(stage);
		return () => observer.disconnect();
	}, []);
	const night = useGameNight(rootRef);
	const isoView = useIsoView();
	const world = useMemo(() => layoutPathWorld(model), [model]);
	const shape = useMemo(
		() =>
			islandFor(
				world.bounds.maxX - world.bounds.minX,
				world.bounds.maxZ - world.bounds.minZ,
				ISLAND_RIM
			),
		[world]
	);
	const agentIds = useMemo(
		() => snapshot.agents.map((agent) => agent.id),
		[snapshot.agents]
	);
	const { looks } = useVillagerLooks(agentIds, night);
	// The sheet floats over the right; the diorama refits beside it (on a
	// narrow stage the sheet covers it all).
	const cover = panelOpen && stageWidth > 0 ? gameSheetCover(stageWidth) : 0;
	const sheetCover = cover < stageWidth ? cover : 0;
	const compact = stageWidth > 0 && stageWidth - sheetCover < COMPACT_BELOW;
	const fallbackRef = useRef<HTMLHeadingElement>(null);
	const actsView = useActs(snapshot);
	const { acts, nowMs, privacy, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: fallbackRef,
		nowMs,
		port,
		snapshot,
	});
	const { openAsk, openBlocker } = cards;
	const queueOpener = useRef<(() => void) | null>(null);
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const tally = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(stageWidth || 1280, { domTargets: true });
	const staged = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const shownKey = [
		...budget.fill(
			actOverlays(
				staged.onStage,
				slots,
				staged.offStage,
				staged.onStage.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced: reduceMotion }
			)
		),
	]
		// The terraces stack the stones too close for speech bubbles: the queue
		// plate, the ask queue and the Queue sheet carry the ask, and the
		// stone's board and the agent list carry what a hiker is working on.
		.filter((id) => !(id.startsWith("ask:") || id.startsWith("work:")))
		.sort()
		.join("|");
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const stones = useMemo(() => agentStones(world, acts), [acts, world]);
	const actPaths = useMemo(() => pathPaths(world, stones), [stones, world]);
	const actVillagers = useMemo(
		() =>
			actsView.enabled
				? pathActVillagers({
						acts,
						looks,
						nowMs,
						onAsk: (askId) => openAsk(askId),
						onOpen: (threadId) => port.openThread(threadId),
						paths: actPaths,
						reduced: reduceMotion,
						shown,
						slots: slots.slots,
						stones,
					})
				: [],
		[
			acts,
			actPaths,
			actsView.enabled,
			looks,
			nowMs,
			openAsk,
			port,
			reduceMotion,
			shown,
			slots.slots,
			stones,
		]
	);
	const onAsk = (askId: string, opener?: HTMLElement) => openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => openBlocker(threadId, agentName, opener);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const openerRef = useRef<string | null>(null);
	const focusRequestRef = useRef<FocusRequest | null>(null);
	const wasOpenRef = useRef(panelOpen);
	const revealedRef = useRef(false);
	// The last thread the panel showed, so closing returns focus to its stop
	// even when the host opened it (a deep link) rather than a click here.
	const lastThreadRef = useRef<string | null>(activeThreadId);
	useEffect(() => {
		if (activeThreadId) {
			lastThreadRef.current = activeThreadId;
		}
	}, [activeThreadId]);

	let activeUnit: PathUnit | undefined;
	let activeStop: PathUnit["stops"][number] | undefined;
	for (const unit of model.units) {
		const found = unit.stops.find((stop) => stop.thread.id === activeThreadId);
		if (found) {
			activeUnit = unit;
			activeStop = found;
			break;
		}
	}

	const requestFocus = (to: FocusRequest["to"]) => {
		focusRequestRef.current = { at: Date.now(), to };
	};
	const openStop = (threadId: string) => {
		openerRef.current = threadId;
		requestFocus("panel");
		port.openThread(threadId);
	};
	const startIn = (unit: PathUnit) => {
		openerRef.current = null;
		requestFocus("panel");
		port.startThread(unit.start);
	};
	const closePanel = () => {
		requestFocus("opener");
		port.closeThread();
	};

	// Move focus with the panel: into its heading when a stop opens it, and
	// back to that stop when it closes.
	useLayoutEffect(() => {
		const wasOpen = wasOpenRef.current;
		wasOpenRef.current = panelOpen;
		const request = focusRequestRef.current;
		const fresh =
			request !== null && Date.now() - request.at < FOCUS_REQUEST_TTL_MS;
		if (panelOpen && fresh && request.to === "panel") {
			focusRequestRef.current = null;
			headingRef.current?.focus();
			return;
		}
		if (!(wasOpen && !panelOpen)) {
			return;
		}
		focusRequestRef.current = null;
		const active = document.activeElement;
		const lost =
			active === null ||
			active === document.body ||
			!rootRef.current?.contains(active);
		if (!((fresh && request.to === "opener") || lost)) {
			return;
		}
		const threadId = openerRef.current ?? lastThreadRef.current;
		const root = rootRef.current;
		const fromStop = threadId
			? root?.querySelector<HTMLElement>(
					`[data-thread-id="${CSS.escape(threadId)}"]`
				)
			: null;
		(
			fromStop ??
			root?.querySelector<HTMLElement>(`${STOP_SELECTOR}[tabindex="0"]`) ??
			root?.querySelector<HTMLElement>(STOP_SELECTOR)
		)?.focus();
	}, [panelOpen]);

	// Like the reference, open on the stop that matters: the open thread, or
	// the one that needs you next. Only once, so live updates never yank the
	// path while you read it.
	const revealId = activeStop?.thread.id ?? model.currentThreadId;
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (loading || revealedRef.current || !scroller || !revealId) {
			return;
		}
		revealedRef.current = true;
		revealStop(scroller, revealId);
	}, [loading, revealId]);

	// Escape with focus nowhere (after clicking plain text) still closes.
	useEffect(() => {
		if (!panelOpen) {
			return;
		}
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				event.target === document.body
			) {
				event.preventDefault();
				focusRequestRef.current = { at: Date.now(), to: "opener" };
				port.closeThread();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, [panelOpen, port]);

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "Escape" &&
			panelOpen &&
			!event.defaultPrevented &&
			!isEditable(event.target)
		) {
			event.preventDefault();
			closePanel();
		}
	};

	const onPathKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const target = event.target;
		const scroller = scrollerRef.current;
		if (
			scroller &&
			target instanceof HTMLElement &&
			target.matches(STOP_SELECTOR) &&
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			moveAlongPath(scroller, target, event.key)
		) {
			event.preventDefault();
		}
	};

	const onPathFocus = (event: FocusEvent<HTMLDivElement>) => {
		const key = event.target.getAttribute(PATH_STOP_ATTRIBUTE);
		if (key) {
			setFocusedKey(key);
		}
	};

	const isEmpty = !loading && model.units.length === 0;

	// The act layer (when the host sends asks): one hiker per agent at its
	// stop, the trailhead's queue, the stops' props (spec §5 path row).
	const actsOn = actsView.enabled && !loading && !isEmpty;
	// Asks that belong to no thread or agent (a workflow gate, a scheduled run)
	// can arrive on a path with no stops: the queue stays reachable then.
	const queueOn =
		actsView.enabled && !loading && (!isEmpty || unowned.length > 0);
	// A phone's title plate wraps the act summary to two lines.
	const insets = useMemo(
		() => ({
			bottom: compact ? 72 : 96,
			left: 16,
			right: 16 + sheetCover,
			top: compact ? 10 + gameTitleHeight(queueOn ? 2 : 1) + 8 : 92,
		}),
		[compact, queueOn, sheetCover]
	);
	const actButtons = queueOn ? (
		<>
			<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={tally} />
			<QueueButton
				acts={acts}
				clock={clock}
				narrow={compact}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				openRef={queueOpener}
				snapshot={snapshot}
				totals={tally}
				unowned={unowned}
			/>
		</>
	) : null;
	const actScene: PathActScene | null = actsOn
		? {
				acts,
				handlers: {
					clock,
					iconOnly: budget.iconOnly,
					nowMs,
					onAsk: (askId) => openAsk(askId),
					onBlocker: (threadId, agentName) => openBlocker(threadId, agentName),
					onQueue: () => openQueue(queueOpener),
					privacy,
					reduced: reduceMotion,
					shown,
					snapshot,
				},
				offStage: staged.offStage,
				onStage: staged.onStage,
				owners,
				paths: actPaths,
				slots,
				stones,
				villagers: actVillagers,
			}
		: null;

	// Each unit's first path index, so the winding runs across the banners.
	const pathStarts: number[] = [];
	let pathEnd = 0;
	for (const unit of model.units) {
		pathStarts.push(pathEnd);
		pathEnd += pathUnitItemCount(unit);
	}

	const needYou = model.units.reduce(
		(count, unit) =>
			count +
			unit.stops.filter(
				(stop) =>
					stop.state === "current" ||
					stop.state === "attention" ||
					stop.state === "reply"
			).length,
		0
	);
	const status = loading
		? "Laying out the path"
		: [
				`${model.doneCount} of ${model.stopCount} finished`,
				needYou > 0 ? `${needYou} need you` : null,
			]
				.filter(Boolean)
				.join(" \u00b7 ");

	const hud = (
		<>
			<GameHudSlot at="top-left">
				<div className="flex min-w-0 flex-col items-start gap-2">
					<GameTitlePlate
						compact={compact}
						icon={<Footprints aria-hidden="true" />}
						keepStatus={queueOn}
						status={queueOn ? actSummaryLine(tally) : status}
						title="Path"
					/>
					{queueOn ? <BlindSpotCaption snapshot={snapshot} /> : null}
				</div>
			</GameHudSlot>
			<GameHudSlot at="top-right" className="items-start">
				{/* A phone's top row holds the act summary or the stats, not both:
				    with acts the summary line wins. The stats setting hides them. */}
				{loading ||
				isEmpty ||
				params?.stats === false ||
				(compact && queueOn) ? null : (
					<PathStatsBar leaders={leaders} stats={stats} />
				)}
				<GameAction
					compact={compact || !isEmpty}
					disabled={loading}
					icon={<Plus aria-hidden="true" strokeWidth={3} />}
					label="New thread"
					onClick={() => {
						openerRef.current = null;
						requestFocus("panel");
						port.startThread({});
					}}
				/>
				{/* On a phone the act buttons sit in the footer: the top row has
				    no room beside the stats and New thread. */}
				{compact ? null : actButtons}
			</GameHudSlot>
			{compact && actButtons ? (
				<GameHudSlot at="bottom-left">{actButtons}</GameHudSlot>
			) : null}
			{loading || isEmpty ? null : (
				<GameHudSlot at="bottom-right">
					{stageWidth - sheetCover < 1100 ? null : (
						<GameLegend
							items={LEGEND_ITEMS.map((item) => ({
								key: item.key,
								label: item.label,
								mark: (
									<span
										className={cn(
											"size-3.5 rounded-full border-(--gk-edge) border-2",
											item.className
										)}
									/>
								),
							}))}
							label="What the stones mean"
						/>
					)}
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</>
	);

	// Without WebGL (and in tests) the path is a plain list of the same stops.
	const list = (
		<div
			aria-describedby={NAV_HINT_ID}
			className="absolute inset-0 overflow-y-auto overscroll-contain @max-[719px]/game:pt-16 pt-24"
			onFocus={onPathFocus}
			onKeyDown={onPathKeyDown}
			ref={scrollerRef}
		>
			<div className="@container/col mx-auto w-full min-w-0 max-w-[600px] px-4 pb-16">
				<div className={cn("relative", PATH_GEOMETRY)}>
					{model.units.map((unit, position) => (
						<PathUnitSection
							activeThreadId={activeThreadId}
							key={unit.id}
							now={now}
							onOpen={openStop}
							onStart={startIn}
							pathStart={pathStarts[position] ?? 0}
							reduceMotion={reduceMotion}
							tabStopKey={rovingKey}
							unit={unit}
						/>
					))}
					<ul aria-label="End of the path" className="relative pt-4">
						<PathFinishItem
							done={model.doneCount}
							swing={pathSwing(pathEnd)}
							total={model.stopCount}
						/>
					</ul>
				</div>
				<p className="sr-only" id={NAV_HINT_ID}>
					Up and Down arrows move between stops; Home and End jump to the first
					and last. Escape closes the open thread.
				</p>
			</div>
		</div>
	);

	return (
		<GameShell
			accent="leaf"
			busy={loading}
			hud={hud}
			label="Path"
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			sheet={
				panelOpen ? (
					<PathThreadPanel
						headingRef={headingRef}
						onClose={closePanel}
						stop={activeStop}
						threadView={threadView}
						unit={activeUnit}
					/>
				) : null
			}
			stageRef={stageRef}
			testId="interface-path"
		>
			<div
				className={cn(
					"absolute inset-0 flex flex-col [container-name:path] [container-type:size]",
					PATH_SCENE_MODE
				)}
				style={PATH_SCENE_VARS}
			>
				<h1 className="sr-only" ref={fallbackRef} tabIndex={-1}>
					Path
				</h1>
				{queueOn ? (
					<>
						<AskQueueList
							acts={acts}
							clock={clock}
							fallbackFocus={fallbackRef}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							snapshot={snapshot}
							unowned={unowned}
						/>
						{actsOn ? (
							<ActAgentList
								acts={acts}
								clock={clock}
								nowMs={nowMs}
								onAsk={onAsk}
								onBlocker={onBlocker}
								onOpenThread={openStop}
								revealOnFocus
								snapshot={snapshot}
							/>
						) : null}
						<ActAnnouncer sentence={sentence} />
					</>
				) : null}
				{isEmpty ? (
					<div className="flex flex-1 items-center justify-center px-6">
						<GamePlate className="flex max-w-sm flex-col items-center gap-4 px-6 py-6 text-center">
							<div
								aria-hidden="true"
								className="flex size-16 items-center justify-center rounded-full border-(--gk-edge)/45 border-[3px] border-dashed text-(--gk-ink-muted)"
							>
								<Plus className="size-8" strokeWidth={3} />
							</div>
							<div className="flex flex-col gap-1.5">
								<h2 className="gk-display text-[24px] leading-7">
									No conversations yet
								</h2>
								<p className="text-pretty font-medium text-(--gk-ink-muted) text-sm leading-5">
									Each conversation becomes a stop on your path, grouped by
									project, team, and agent. Start one to take the first step.
								</p>
							</div>
							<Button onClick={() => port.startThread({})} type="button">
								<Plus aria-hidden="true" data-icon="inline-start" />
								Start a thread
							</Button>
						</GamePlate>
					</div>
				) : null}
				{loading ? (
					<div
						aria-busy="true"
						className="mx-auto w-full max-w-[600px] px-4 pt-24"
					>
						<PathSkeleton />
					</div>
				) : null}
				{loading || isEmpty ? null : (
					<IsoStage
						bounds={{
							...world.bounds,
							// With acts the frame takes the trailhead's queue in front.
							maxZ: world.bounds.maxZ + (actsOn ? 2.5 : 0),
							top: (world.terraces.at(-1)?.height ?? 0) + 3,
						}}
						fallback={list}
						insets={insets}
						label="Path diorama: a stepping stone per conversation along a trail, a signpost per unit. Tab or the arrow keys move between stones and signposts; drag to pan, plus and minus to zoom."
						night={night}
						reducedMotion={reduceMotion}
						view={isoView}
					>
						{({ quality, theme }) => (
							<PathDiorama
								activeThreadId={panelOpen ? activeThreadId : null}
								actScene={actScene}
								looks={looks}
								night={night}
								onOpen={openStop}
								onStart={startIn}
								quality={quality}
								reducedMotion={reduceMotion}
								shape={shape}
								theme={theme}
								world={world}
							/>
						)}
					</IsoStage>
				)}
			</div>
			{cards.element}
		</GameShell>
	);
}
