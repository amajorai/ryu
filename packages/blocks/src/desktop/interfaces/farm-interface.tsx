import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	type InterfaceParamsByRenderer,
	isSuggestion,
} from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	actGrowth,
	benchOf,
	farmActVillagers,
	farmPaths,
	growFocusCrops,
	overripeReplies,
	porchSpots,
} from "./farm-acts.tsx";
import { type FarmActScene, FarmDioramaScene } from "./farm-diorama.tsx";
import { useElementSize, useMinuteClock } from "./farm-hooks.ts";
import {
	FarmActions,
	FarmCounters,
	FarmLegend,
	FarmTitle,
} from "./farm-hud.tsx";
import { FarmList } from "./farm-list.tsx";
import {
	buildFarm,
	type FarmCrop,
	type FarmField,
	farmDay,
	layoutDiorama,
	makePlot,
	OPEN_FIELD_ID,
	plotForThread,
	plural,
} from "./farm-model.ts";
import { FARM_SCENE_CSS } from "./farm-palette.ts";
import { FarmPanel, type FarmPanelView } from "./farm-panel.tsx";
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
	useFocusOnOpen,
	useGameNight,
	useIsoView,
	useReducedMotion,
} from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
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
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

/** Room kept in front of the last queue slot: its farmer and hourglass. */
const QUEUE_DEPTH = 1.4;

type Drawer = { kind: "barn" } | { kind: "plot"; plotId: string | null };

/** Escape inside a text field belongs to the field. */
function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	return (
		!target.isContentEditable &&
		target.closest("input, textarea, select, [contenteditable='true']") === null
	);
}

const STAGE_FALLBACK = { height: 808, width: 1200 };

/** An empty farm still has a bed waiting by the barn for the first seed. */
const FIRST_PLOT_ID = "plot-first";
const FIRST_FIELDS: FarmField[] = [
	{
		fenced: false,
		id: OPEN_FIELD_ID,
		name: "Open plots",
		plots: [{ ...makePlot(FIRST_PLOT_ID, null, []), name: "New plot" }],
	},
];

function LoadingFarm() {
	return (
		<div className="flex w-full flex-wrap content-center items-start justify-center gap-6 p-8">
			{["a", "b", "c", "d", "e", "f"].map((key) => (
				<div className="flex w-60 flex-col gap-3" key={key}>
					<Skeleton className="h-32 w-full rounded-lg" />
					<Skeleton className="h-4 w-24" />
				</div>
			))}
			<span className="sr-only">Loading the farm</span>
		</div>
	);
}

/** The farm's island: the laid-out farm plus a rim for trees and shore. */
const ISLAND_RIM = 2.6;

/**
 * Farm: the workspace as a cosy farm diorama on an island, built on the 3D
 * game kit. Each agent tends a raised bed (projects fence their agents'
 * beds into fields), and every conversation is a crop whose growth shows
 * where it stands: a watered sprout while the agent has yet to answer, a
 * leafy plant while it works, ripe fruit when it is your turn, a withered
 * plant when a run failed. The agent stands by its bed as a villager,
 * posed by its most urgent crop. Clicking a crop opens its conversation
 * beside the farm; a farmer's plate opens the plot, whose seed bag starts
 * a new conversation with that agent; the barn lists every crop.
 */
export function FarmInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["farm"]>) {
	const reduced = useReducedMotion();
	const now = useMinuteClock();
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const size = useElementSize(stageRef, STAGE_FALLBACK);
	const night = useGameNight(rootRef);
	const isoView = useIsoView();
	const model = useMemo(
		() =>
			buildFarm(
				loading
					? { ...snapshot, agents: [], groups: [], threads: [] }
					: snapshot
			),
		[loading, snapshot]
	);
	const isEmpty =
		!loading && snapshot.agents.length === 0 && snapshot.threads.length === 0;
	const actsView = useActs(snapshot);
	const { acts, nowMs, privacy, unowned } = actsView;
	// Unowned asks wait at the gate even before any farmer has a bed; an
	// empty farm with nothing asked keeps its first-seed guidance.
	const actsOn =
		actsView.enabled &&
		!loading &&
		(!isEmpty || unowned.some((ask) => !isSuggestion(ask)));
	// An empty farm with only an unowned suggestion keeps its guidance, but
	// the suggestion stays reachable through the Queue and the ask queue.
	const queueOn =
		actsOn || (actsView.enabled && !loading && unowned.length > 0);
	// Re-grow crops only when a plan's twelfths or a reply's wait band
	// change, not every clock tick (an estimate's `done` moves each second).
	const overripe = useMemo(
		() => (actsOn ? overripeReplies(snapshot.asks, nowMs) : new Map()),
		[actsOn, nowMs, snapshot.asks]
	);
	const growthKey = actsOn
		? [
				...[...acts.values()].map(
					(act) => `${act.threadId}:${actGrowth(act) ?? "-"}`
				),
				...[...overripe].map(([id, fallen]) => `${id}:${fallen}`),
			].join("|")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the plans' twelfths and the replies' bands, not the maps' identities.
	const sceneFields = useMemo(() => {
		if (isEmpty) {
			return FIRST_FIELDS;
		}
		return actsOn ? growFocusCrops(model.fields, acts, overripe) : model.fields;
	}, [actsOn, growthKey, isEmpty, model.fields]);
	const diorama = useMemo(() => layoutDiorama(sceneFields), [sceneFields]);
	const shape = useMemo(
		() =>
			islandFor(
				diorama.bounds.maxX - diorama.bounds.minX,
				diorama.bounds.maxZ - diorama.bounds.minZ,
				ISLAND_RIM
			),
		[diorama]
	);
	const agentIds = useMemo(
		() => snapshot.agents.map((agent) => agent.id),
		[snapshot.agents]
	);
	const { looks } = useVillagerLooks(agentIds, night);
	const [drawer, setDrawer] = useState<Drawer | null>(null);
	// The sheet floats over the farm's right side; the diorama refits to the
	// part it leaves uncovered (narrow stages: the sheet covers it all).
	const sheetOpen = threadView !== null || drawer !== null;
	const cover = sheetOpen ? gameSheetCover(size.width) : 0;
	const sheetCover = cover < size.width ? cover : 0;
	const compact = size.width - sheetCover < 640;
	const insets = useMemo(
		() => ({
			bottom: compact ? 72 : 96,
			left: 16,
			right: 16 + sheetCover,
			top: compact ? 64 : 92,
		}),
		[compact, sheetCover]
	);
	const [announcement, setAnnouncement] = useState("");
	const hudHeadingRef = useRef<HTMLHeadingElement>(null);
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: hudHeadingRef,
		nowMs,
		port,
		snapshot,
	});
	const { openAsk, openBlocker } = cards;
	const queueOpener = useRef<(() => void) | null>(null);
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const tally = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(size.width, { domTargets: true });
	const staged = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const cast = staged.onStage;
	const shownKey = [
		...budget.fill(
			actOverlays(
				cast,
				slots,
				staged.offStage,
				cast.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced }
			)
		),
	]
		// A phone has no room beside the plates for a work bubble (it stands
		// wider than its plate): the bed's board and act sentence carry it.
		.filter((id) => !(budget.iconOnly && id.startsWith("work:")))
		.sort()
		.join("|");
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const paths = useMemo(() => farmPaths(diorama), [diorama]);
	const benches = useMemo(() => benchOf(diorama, acts), [acts, diorama]);
	const actVillagers = useMemo(
		() =>
			actsOn
				? farmActVillagers({
						acts,
						benches,
						diorama,
						looks,
						nowMs,
						onAsk: (askId) => openAsk(askId),
						paths,
						reduced,
						shown,
						slots: slots.slots,
					})
				: [],
		[
			acts,
			actsOn,
			benches,
			diorama,
			looks,
			nowMs,
			openAsk,
			paths,
			reduced,
			shown,
			slots,
		]
	);
	const actScene: FarmActScene | null = actsOn
		? {
				acts,
				benches,
				handlers: {
					clock,
					iconOnly: budget.iconOnly,
					nowMs,
					onAsk: (askId) => openAsk(askId),
					onBlocker: (threadId, agentName) => openBlocker(threadId, agentName),
					onQueue: () => openQueue(queueOpener),
					privacy,
					reduced,
					shown,
					snapshot,
				},
				offStage: staged.offStage,
				onStage: cast,
				owners,
				paths,
				slots,
				villagers: actVillagers,
			}
		: null;
	const onAsk = (askId: string, opener?: HTMLElement) => openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => openBlocker(threadId, agentName, opener);
	const actButtons = queueOn ? (
		<>
			{actsOn ? (
				<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={tally} />
			) : null}
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
	const panelHeadingRef = useRef<HTMLHeadingElement>(null);
	const focusTarget = useRef<"hud" | "panel" | null>(null);

	const threadOpen = threadView !== null;
	const activeCrop = activeThreadId
		? model.crops.find((crop) => crop.thread.id === activeThreadId)
		: undefined;
	const drawerPlot =
		drawer?.kind === "plot" && drawer.plotId
			? (model.plots.find((plot) => plot.id === drawer.plotId) ?? null)
			: null;

	let view: FarmPanelView | null = null;
	if (threadOpen) {
		view = {
			crop: activeCrop,
			kind: "thread",
			plot: plotForThread(model, activeThreadId),
		};
	} else if (drawer?.kind === "barn") {
		view = { kind: "barn" };
	} else if (drawer?.kind === "plot") {
		view = { kind: "plot", plot: drawerPlot };
	}
	// The sheet's object: the camera glides to it when the sheet opens.
	let focusId: string | null = null;
	if (view?.kind === "barn") {
		focusId = "barn";
	} else if (view) {
		focusId = view.plot?.id ?? null;
	}
	useFocusOnOpen(isoView, focusId);
	const viewKey = view
		? `${view.kind}:${drawer?.kind === "plot" ? drawer.plotId : ""}:${threadOpen ? (activeThreadId ?? "new") : ""}`
		: "farm";

	useLayoutEffect(() => {
		const target = focusTarget.current;
		if (!(target && viewKey)) {
			return;
		}
		focusTarget.current = null;
		if (target === "panel") {
			panelHeadingRef.current?.focus();
		} else {
			hudHeadingRef.current?.focus();
		}
	}, [viewKey]);

	// Announce only new ripe crops, not every snapshot's tallies.
	const ripeCount = loading ? null : model.totals.ripe;
	const lastRipe = useRef<number | null>(null);
	useEffect(() => {
		const previous = lastRipe.current;
		lastRipe.current = ripeCount;
		if (previous !== null && ripeCount !== null && ripeCount > previous) {
			setAnnouncement(`${plural(ripeCount, "crop")} ready to harvest`);
		}
	}, [ripeCount]);

	const harvest = (threadId: string) => {
		const crop = model.crops.find((item) => item.thread.id === threadId);
		focusTarget.current = "panel";
		setAnnouncement(
			crop?.stage === "ripe" ? `Harvested ${crop.thread.title}` : ""
		);
		port.openThread(threadId);
	};
	const openPlot = (plotId: string | null) => {
		if (threadOpen) {
			port.closeThread();
		}
		focusTarget.current = "panel";
		setDrawer({ kind: "plot", plotId });
	};
	const toggleBarn = () => {
		if (threadOpen) {
			port.closeThread();
		}
		if (drawer?.kind === "barn" && !threadOpen) {
			setDrawer(null);
			focusTarget.current = "hud";
			return;
		}
		focusTarget.current = "panel";
		setDrawer({ kind: "barn" });
	};
	const plant = (input: { agentId?: string; prompt: string }) => {
		focusTarget.current = "panel";
		const plot = input.agentId
			? model.plots.find((item) => item.id === input.agentId)
			: undefined;
		setAnnouncement(plot ? `Planted a seed in ${plot.name}'s plot` : "");
		port.startThread(
			input.agentId
				? { agentId: input.agentId, prompt: input.prompt }
				: { prompt: input.prompt }
		);
	};
	const closePanel = () => {
		if (threadOpen) {
			port.closeThread();
			focusTarget.current = drawer ? "panel" : "hud";
			return;
		}
		setDrawer(null);
		focusTarget.current = "hud";
	};

	/** Escape closes the conversation, then the panel. */
	const stepBack = (): boolean => {
		if (view) {
			closePanel();
			return true;
		}
		return false;
	};
	const stepBackRef = useRef(stepBack);
	stepBackRef.current = stepBack;

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			!escapeIsFree(event.target)
		) {
			return;
		}
		if (stepBackRef.current()) {
			event.preventDefault();
		}
	};
	useEffect(() => {
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.target !== document.body
			) {
				return;
			}
			if (stepBackRef.current()) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, []);

	const plotName = (crop: FarmCrop) =>
		model.plots.find((plot) => plot.crops.includes(crop))?.name ?? "";
	const { totals } = model;
	const summary = actsOn
		? `Farm: ${actSummaryLine(tally)}.`
		: `Farm: ${plural(model.plots.length, "plot")}, ${totals.ripe} ready to harvest, ${totals.growing} growing, ${totals.seeds} seeded, ${totals.withered} withered.`;
	const selectedPlotId = view?.kind === "plot" ? (view.plot?.id ?? null) : null;

	const hud = (
		<>
			<GameHudSlot at="top-left" className="right-0 items-start">
				<div className="flex min-w-0 flex-1 flex-col items-start gap-2">
					{/* Capped, so the title never runs under the actions. */}
					<div className="max-w-full">
						<FarmTitle
							actStatus={actsOn ? actSummaryLine(tally) : undefined}
							compact={compact}
							day={farmDay(snapshot.threads, now)}
							empty={isEmpty}
							totals={totals}
						/>
					</div>
					{actsOn ? <BlindSpotCaption snapshot={snapshot} /> : null}
				</div>
				<div className="ms-auto flex flex-col items-end gap-2">
					<FarmActions
						barnOpen={view?.kind === "barn"}
						compact={compact}
						crops={totals.crops}
						disabled={loading}
						onOpenBarn={toggleBarn}
						onPlant={() => openPlot(drawerPlot?.id ?? null)}
					/>
					{/* On a phone the act buttons sit in the footer, unless the farm is
					    empty (then only the queue shows, here). */}
					{compact && actsOn ? null : actButtons}
				</div>
			</GameHudSlot>
			{loading || (isEmpty && !actsOn) ? null : (
				<GameHudSlot at="bottom-left">
					{actsOn && compact ? (
						actButtons
					) : (
						<FarmCounters
							actTotals={actsOn ? tally : undefined}
							compact={compact}
							showCoins={params?.coins !== false}
							totals={totals}
						/>
					)}
				</GameHudSlot>
			)}
			{loading ? null : (
				<GameHudSlot at="bottom-right">
					{isEmpty || size.width - sheetCover < 1100 ? null : <FarmLegend />}
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</>
	);
	const list = (
		<FarmList
			activeThreadId={threadOpen ? activeThreadId : null}
			actLayer={
				actsOn ? { acts, clock, nowMs, onAsk, onBlocker, snapshot } : null
			}
			emptyFarm={isEmpty}
			fields={sceneFields}
			onOpenBarn={toggleBarn}
			onOpenCrop={harvest}
			onOpenPlot={openPlot}
			selectedPlotId={selectedPlotId}
			totalCrops={totals.crops}
		/>
	);

	return (
		<GameShell
			accent="leaf"
			busy={loading}
			data-farm-scene=""
			data-motion={reduced ? "reduce" : "full"}
			hud={hud}
			label="Farm"
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			sheet={
				view ? (
					<FarmPanel
						activeThreadId={activeThreadId}
						actMode={actsOn}
						agents={snapshot.agents}
						crops={model.crops}
						headingRef={panelHeadingRef}
						onClose={closePanel}
						onOpen={harvest}
						onPlant={plant}
						onSelectPlot={openPlot}
						plotName={plotName}
						plots={model.plots}
						threadView={threadView}
						view={view}
					/>
				) : null
			}
			testId="interface-farm"
		>
			<style>{FARM_SCENE_CSS}</style>
			<h1 className="sr-only" ref={hudHeadingRef} tabIndex={-1}>
				Farm
			</h1>
			<div className="absolute inset-0" ref={stageRef}>
				{loading ? (
					<LoadingFarm />
				) : (
					<>
						<p className="sr-only">{summary}</p>
						{queueOn ? (
							<AskQueueList
								acts={acts}
								clock={clock}
								fallbackFocus={hudHeadingRef}
								nowMs={nowMs}
								onAsk={onAsk}
								onBlocker={onBlocker}
								snapshot={snapshot}
								unowned={unowned}
							/>
						) : null}
						<IsoStage
							bounds={{
								...diorama.bounds,
								// With acts the porch and the gate's queue stand past the front edge.
								// With acts the frame reaches past the gate's last queue slot
								// and the farmer standing there.
								maxZ: actsOn
									? Math.max(
											diorama.bounds.maxZ,
											(porchSpots(diorama).slots.at(-1)?.[2] ?? 0) + QUEUE_DEPTH
										)
									: diorama.bounds.maxZ,
								top: 2.6,
							}}
							fallback={list}
							fill={1.18}
							insets={insets}
							label="Farm diorama: a bed per agent and a crop per conversation. Tab or the arrow keys move between farmers, plots and the barn; drag to pan, plus and minus to zoom."
							night={night}
							reducedMotion={reduced}
							view={isoView}
						>
							{({ quality, theme }) => (
								<FarmDioramaScene
									actScene={actScene}
									diorama={diorama}
									looks={looks}
									night={night}
									onOpenBarn={toggleBarn}
									onOpenCrop={harvest}
									onOpenPlot={openPlot}
									quality={quality}
									reducedMotion={reduced}
									selectedPlotId={selectedPlotId}
									shape={shape}
									theme={theme}
								/>
							)}
						</IsoStage>
					</>
				)}
			</div>
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
			{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
			{cards.element}
		</GameShell>
	);
}
