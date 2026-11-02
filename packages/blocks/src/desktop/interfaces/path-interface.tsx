import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import {
	type FocusEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { gameTitleHeight } from "./game-hud.tsx";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import {
	actOverlays,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import {
	IsoStage,
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
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	agentStones,
	type PathActScene,
	pathActVillagers,
	pathPaths,
} from "./path-acts.tsx";
import { PathDiorama } from "./path-diorama.tsx";
import { usePathPanelFocus } from "./path-interface-focus.ts";
import { PathHud } from "./path-interface-hud.tsx";
import {
	COMPACT_BELOW,
	ISLAND_RIM,
	moveAlongPath,
	PathSkeleton,
	pathStopKeys,
	revealStop,
	STOP_SELECTOR,
	tabStopKey,
} from "./path-interface-nav.tsx";
import { PathEmpty, PathList } from "./path-interface-views.tsx";
import {
	buildPath,
	type PathUnit,
	pathLeaderboard,
	pathStats,
	pathUnitItemCount,
} from "./path-model.ts";
import { PATH_SCENE_MODE, PATH_SCENE_VARS } from "./path-palette.ts";
import { PathThreadPanel } from "./path-panel.tsx";
import { PATH_STOP_ATTRIBUTE } from "./path-stop.tsx";
import { layoutPathWorld } from "./path-world.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

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
	const tl = useLiteralMessages();
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
						tl,
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
			tl,
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
	const revealedRef = useRef(false);
	const { closePanel, onRootKeyDown, openStop, startIn, startNew } =
		usePathPanelFocus({ activeThreadId, headingRef, panelOpen, port, rootRef });

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

	const hud = (
		<PathHud
			actButtons={actButtons}
			compact={compact}
			isEmpty={isEmpty}
			isoView={isoView}
			leaders={leaders}
			legendRoom={stageWidth - sheetCover >= 1100}
			loading={loading}
			model={model}
			onNewThread={startNew}
			params={params}
			queueOn={queueOn}
			snapshot={snapshot}
			stats={stats}
			tally={tally}
		/>
	);

	const list = (
		<PathList
			activeThreadId={activeThreadId}
			model={model}
			now={now}
			onFocus={onPathFocus}
			onKeyDown={onPathKeyDown}
			onOpen={openStop}
			onStart={startIn}
			pathEnd={pathEnd}
			pathStarts={pathStarts}
			reduceMotion={reduceMotion}
			rovingKey={rovingKey}
			scrollerRef={scrollerRef}
		/>
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
				{isEmpty ? <PathEmpty onStart={() => port.startThread({})} /> : null}
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
