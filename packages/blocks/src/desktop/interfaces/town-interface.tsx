import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	compareAsks,
	type InterfaceParamsByRenderer,
} from "@ryuhq/protocol/interfaces";
import { Landmark, Megaphone, SquarePen, X } from "lucide-react";
import { motion } from "motion/react";
import {
	type KeyboardEvent,
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { GameAction, GameIconButton, GamePlate } from "./game-hud.tsx";
import {
	GameHudSlot,
	GameSheet,
	GameShell,
	gameSheetCover,
} from "./game-shell.tsx";
import {
	actBubble,
	actOverlays,
	actSummaryLine,
	actTotals,
	bubbleOverlayId,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import type { LifeBubble } from "./game3d-life.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
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
import { useReducedMotion } from "./reduced-motion.ts";
import {
	actTown,
	actTownKey,
	TownActProps,
	townActAnchors,
	townActEntries,
} from "./town-acts.tsx";
import { TownActMode, TownDesk, TownDeskBody } from "./town-desk.tsx";
import {
	useElementWidth,
	useStageVisible,
	useThemeColors,
	useWebGLSupport,
} from "./town-hooks.ts";
import {
	CityHallButton,
	DataViewControl,
	SpeedControl,
	TownStatsPlate,
	TownTitle,
	ZoomControls,
} from "./town-hud.tsx";
import {
	actHappiness,
	agentSchedule,
	buildingFor,
	buildTown,
	formatFunds,
	plural,
	upcomingRuns,
} from "./town-model.ts";
import { TownDirectory, TownOverlay } from "./town-overlay.tsx";
import { type TownDataView, townPalette } from "./town-palette.ts";
import { TownPanel, TownPanelActs, type TownPanelView } from "./town-panel.tsx";
import type { SceneInsets, TownCamera } from "./town-scene.tsx";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

const loadScene = () => import("./town-scene.tsx");
const TownScene = lazy(loadScene);

/** The docked City Hall desk's width, and the HUD's gutter. */
const DESK_WIDTH = 340;
const GUTTER = 16;
/**
 * The desk never docks: it folds into the City Hall plate (petitions count)
 * and opens over the town on demand, so the town fills the frame.
 */
const DESK_DOCKS_AT = Number.POSITIVE_INFINITY;

/**
 * While the scene loads: the island's outline, the way the diorama will sit,
 * in the theme's muted tone and pulsing like the other skeletons.
 */
function IslandPlaceholder() {
	return (
		<svg
			aria-hidden="true"
			className="aspect-[2/1.3] w-full max-w-3xl animate-pulse text-(--gk-plate) motion-reduce:animate-none"
			focusable="false"
			viewBox="0 0 200 130"
		>
			<path
				className="fill-current stroke-(--gk-edge) opacity-40"
				d="M100 4 L196 60 L100 116 L4 60 Z"
				strokeWidth={1}
				vectorEffect="non-scaling-stroke"
			/>
			<path
				className="fill-current stroke-(--gk-edge) opacity-60"
				d="M4 60 L100 116 L196 60 L196 70 L100 126 L4 70 Z"
				strokeWidth={1}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

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

/**
 * Town: your agents as a small city, and you as its mayor, after the city
 * builders. Projects and teams are districts (agents in neither live in Old
 * Town); every agent is a building that grows from cottage to shop to office
 * tower as its conversations add up. A crane works over an agent with a live
 * run, a red beacon smokes over a failed one, and a speech bubble floats
 * over a reply waiting on you. Those replies and failures are petitions on
 * City Hall's desk; hearing one opens the host's own conversation in the
 * side sheet. Built on the shared game kit (game-shell.tsx): the map fills
 * the interface and the HUD floats over it. Clicking a building focuses the camera on it and opens its
 * card, where Commission work starts a conversation with that agent.
 */
/** The status lines a minimal overlay density leaves off (limit and cue stay). */
const MINIMAL_DROPS = ["elapsed:", "next:", "progress:"] as const;

/** The speed setting's values on the HUD's speed control. */
const SPEED_OF = { fast: 3, normal: 1, paused: 0 } as const;

/** The speed setting for a speed control value. */
function speedName(speed: number): keyof typeof SPEED_OF {
	if (speed === 0) {
		return "paused";
	}
	return speed > 1 ? "fast" : "normal";
}

export function TownInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["town"]>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLElement>(null);
	const layerRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const petitionsRef = useRef<HTMLHeadingElement>(null);
	const cameraRef = useRef<TownCamera | null>(null);
	const focusHeading = useRef(false);
	const reduced = useReducedMotion();
	const kit = useGameKitSettings();
	const webgl = useWebGLSupport();
	const visible = useStageVisible(stageRef);
	const theme = useThemeColors(rootRef);
	const stageWidth = useElementWidth(stageRef);
	const palette = useMemo(() => townPalette(theme), [theme]);
	// Ages only feed the activity view: read the clock once per snapshot.
	const town = useMemo(() => buildTown(snapshot, Date.now()), [snapshot]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [hoverId, setHoverId] = useState<string | null>(null);
	// The data view and the speed are settings: the HUD's controls change them
	// at once and save them through the port, and a change from Settings
	// (new params) takes over.
	const paramDataView: TownDataView = params?.dataView ?? "none";
	const paramSpeed = params?.speed ?? "auto";
	const [dataView, setDataView] = useState<TownDataView>(paramDataView);
	const [speed, setSpeed] = useState<number | null>(
		paramSpeed === "auto" ? null : SPEED_OF[paramSpeed]
	);
	useEffect(() => {
		setDataView(paramDataView);
	}, [paramDataView]);
	useEffect(() => {
		// A choice the mayor just made (and saved) stands; only "auto" leaves the
		// speed to the reduced-motion default.
		setSpeed((current) => {
			if (current !== null && speedName(current) === paramSpeed) {
				return current;
			}
			return paramSpeed === "auto" ? null : SPEED_OF[paramSpeed];
		});
	}, [paramSpeed]);
	const chooseDataView = (next: TownDataView) => {
		setDataView(next);
		port.updateSettings?.({ dataView: next });
	};
	const chooseSpeed = (next: number) => {
		setSpeed(next);
		port.updateSettings?.({ speed: speedName(next) });
	};
	const [drawn, setDrawn] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const [deskOpen, setDeskOpen] = useState(false);
	// Reduced motion starts the clock paused; the mayor can still press play.
	const effectiveSpeed = speed ?? (reduced ? 0 : 1);

	const threadOpen = threadView !== null;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const selected = buildingFor(town, selectedId);
	const threadBuilding =
		selected && activeThread?.agentIds.includes(selected.agent.id)
			? selected
			: buildingFor(town, activeThread?.agentIds[0]);
	const names = useMemo(
		() => new Map(town.districts.map((item) => [item.id, item.name])),
		[town.districts]
	);

	let view: TownPanelView | null = null;
	if (threadOpen) {
		view = {
			building: threadBuilding,
			districtName: threadBuilding
				? names.get(threadBuilding.districtId)
				: undefined,
			kind: "thread",
			thread: activeThread,
		};
	} else if (selected) {
		view = {
			building: selected,
			districtName: names.get(selected.districtId) ?? "",
			kind: "building",
			schedule: agentSchedule(snapshot.events, selected.agent.id),
		};
	}
	const viewKey = view
		? `${view.kind}:${selectedId ?? ""}:${activeThreadId ?? ""}`
		: "";
	// The sheet's building: the camera glides to it when the sheet opens.
	const sheetLot = view?.building?.lot;
	const sheetLotX = sheetLot?.x;
	const sheetLotZ = sheetLot?.z;
	useEffect(() => {
		if (sheetLotX === undefined || sheetLotZ === undefined) {
			return;
		}
		// After the stage has refitted beside the sheet.
		const frame = requestAnimationFrame(() =>
			cameraRef.current?.focus({ x: sheetLotX, z: sheetLotZ, zoom: 2.1 })
		);
		return () => cancelAnimationFrame(frame);
	}, [sheetLotX, sheetLotZ]);
	const focusedId =
		view?.kind === "thread"
			? (view.building?.agent.id ?? null)
			: (selected?.agent.id ?? null);

	useLayoutEffect(() => {
		if (!(viewKey && focusHeading.current)) {
			return;
		}
		focusHeading.current = false;
		headingRef.current?.focus();
	}, [viewKey]);

	// The HUD shares the part of the stage the sheet leaves uncovered.
	// City Hall opens as the kit sheet when no building or record is open.
	const hallSheet = !view && deskOpen && stageWidth < DESK_DOCKS_AT;
	const sheetCover =
		(view || hallSheet) && stageWidth > 0 ? gameSheetCover(stageWidth) : 0;
	const hudWidth =
		stageWidth === 0
			? 1440
			: stageWidth - (sheetCover < stageWidth ? sheetCover : 0);
	const deskDocked = hudWidth >= DESK_DOCKS_AT;
	const deskShown = deskDocked || deskOpen;
	const narrowStage = hudWidth < 640;
	// Name tags collide on a small stage: show them on hover and selection.
	const roomyStage = hudWidth >= 820;
	const insets = useMemo<SceneInsets>(
		() => ({
			bottom: narrowStage ? 64 : 84,
			left: deskDocked ? GUTTER * 2 + DESK_WIDTH : GUTTER,
			right: GUTTER + (sheetCover < stageWidth ? sheetCover : 0),
			top: narrowStage ? 70 : 84,
		}),
		[deskDocked, narrowStage, sheetCover, stageWidth]
	);

	// The act layer (when the host sends asks): the townsfolk act out their
	// acts, the act props join the DOM layer, the queue waits at City Hall.
	const fallbackRef = useRef<HTMLHeadingElement>(null);
	const actsView = useActs(snapshot);
	const { acts, nowMs, privacy, unowned } = actsView;
	const actsOn = actsView.enabled && !loading;
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
	const budget = overlayBudget(hudWidth, { domTargets: true });
	const cast = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY).onStage,
		[acts]
	);
	// Bubbles hang on the building tags and queue plates; a phone keeps no
	// work bubble (it would run off the stage beside its tag). The kit game
	// settings apply here too, as town draws these overlays itself: no work
	// bubbles when they are off, and only limit and cue lines when minimal.
	const shownKey = [
		...budget.fill(
			actOverlays(
				cast,
				slots,
				{ count: 0 },
				cast.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced }
			).filter(
				(item) =>
					!(
						((budget.iconOnly || !kit.workBubbles) &&
							item.id.startsWith("work:")) ||
						(kit.overlayDensity === "minimal" &&
							MINIMAL_DROPS.some((prefix) => item.id.startsWith(prefix)))
					)
			)
		),
	]
		.sort()
		.join("|");
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const bubbles = useMemo(() => {
		const kept = new Map<string, LifeBubble>();
		for (const act of acts.values()) {
			const id = bubbleOverlayId(act);
			const bubble = id && shown.has(id) ? actBubble(act) : null;
			if (bubble) {
				kept.set(act.agentId, bubble);
			}
		}
		return kept;
	}, [acts, shown]);
	// An asking villager's bubble rides its queue plate, not its building.
	const queued = useMemo(
		() =>
			new Set(
				slots.slots
					.filter((slot) => slot.carrier === "villager")
					.map((slot) => slot.agentId ?? "")
			),
		[slots.slots]
	);
	const tagBubbles = useMemo(
		() => new Map([...bubbles].filter(([id]) => !queued.has(id))),
		[bubbles, queued]
	);
	const actEntries = useMemo(
		() =>
			actsOn
				? townActEntries({
						acts,
						bubbles,
						clock,
						nowMs,
						overflow: slots.overflow,
						owners,
						shown,
						slots: slots.slots,
						snapshot,
						town,
					})
				: [],
		[acts, actsOn, bubbles, clock, nowMs, owners, shown, slots, snapshot, town]
	);
	const actAnchors = useMemo(() => townActAnchors(actEntries), [actEntries]);
	// With acts the buildings' art (crane, beacon, bubble) follows the acts,
	// rebuilt only when what it reads changes (not on every clock tick).
	const latestActs = useRef(acts);
	latestActs.current = acts;
	const townKey = actsOn ? actTownKey(acts) : "";
	const sceneTown = useMemo(
		() => (townKey ? actTown(town, latestActs.current) : town),
		[townKey, town]
	);
	const actScene = useMemo(
		() =>
			actsOn ? { acts, anchors: actAnchors, clock, slots: slots.slots } : null,
		[actAnchors, acts, actsOn, clock, slots.slots]
	);
	const onAsk = (askId: string, opener?: HTMLElement) => openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => openBlocker(threadId, agentName, opener);
	const actButtons = actsOn ? (
		<>
			<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={tally} />
			<QueueButton
				acts={acts}
				clock={clock}
				narrow={narrowStage}
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

	const selectBuilding = useCallback(
		(agentId: string) => {
			if (threadOpen) {
				port.closeThread();
			}
			focusHeading.current = true;
			setSelectedId(agentId);
			const building = buildingFor(town, agentId);
			setAnnouncement(
				building
					? `${building.agent.name}'s building, ${plural(building.threads.length, "conversation")}`
					: ""
			);
		},
		[port, threadOpen, town]
	);
	const hear = useCallback(
		(threadId: string) => {
			focusHeading.current = true;
			if (!deskDocked) {
				setDeskOpen(false);
			}
			port.openThread(threadId);
		},
		[deskDocked, port]
	);
	const showDistrict = useCallback(
		(districtId: string) => {
			const district = town.districts.find((item) => item.id === districtId);
			if (!district) {
				return;
			}
			cameraRef.current?.focus({ x: district.x, z: district.z, zoom: 1.75 });
			setAnnouncement(
				`${district.name}: ${plural(district.buildings.length, "building")}, ${plural(district.threads.length, "conversation")}`
			);
		},
		[town.districts]
	);
	const showHall = useCallback(() => {
		cameraRef.current?.focus({ x: 0, z: 0, zoom: 1.65 });
		if (!deskShown) {
			setDeskOpen(true);
		}
		// The desk mounts with the click: focus its petitions once it is in.
		requestAnimationFrame(() => petitionsRef.current?.focus());
	}, [deskShown]);
	const back = () => {
		port.closeThread();
		focusHeading.current = true;
		if (threadBuilding) {
			setSelectedId(threadBuilding.agent.id);
		}
	};
	const close = () => {
		if (threadOpen) {
			port.closeThread();
		}
		setSelectedId(null);
		cameraRef.current?.reset();
		setAnnouncement("Back to the whole town");
	};
	const commission = (input: { agentId: string; prompt: string }) => {
		focusHeading.current = true;
		setSelectedId(input.agentId);
		port.startThread({ agentId: input.agentId, prompt: input.prompt });
	};

	const stepBack = (): boolean => {
		if (deskOpen && !deskDocked) {
			setDeskOpen(false);
			return true;
		}
		if (threadOpen) {
			back();
			return true;
		}
		if (view) {
			close();
			return true;
		}
		return false;
	};
	const stepBackRef = useRef(stepBack);
	stepBackRef.current = stepBack;

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

	// Keep the camera on whoever the panel is about, including a thread the
	// host opened before the scene existed.
	const focusTarget = buildingFor(town, focusedId);
	const focusX = focusTarget?.lot.x;
	const focusZ = focusTarget?.lot.z;
	const pendingFocus = useRef<{ x: number; z: number } | null>(null);
	useEffect(() => {
		if (focusX === undefined || focusZ === undefined) {
			return;
		}
		const target = { x: focusX, z: focusZ };
		if (cameraRef.current) {
			cameraRef.current.focus(target);
		} else {
			pendingFocus.current = target;
		}
	}, [focusX, focusZ]);
	const onCamera = useCallback((camera: TownCamera) => {
		cameraRef.current = camera;
		if (pendingFocus.current) {
			camera.focus(pendingFocus.current);
			pendingFocus.current = null;
		}
	}, []);
	const onDrawn = useCallback(() => setDrawn(true), []);
	// Fetch the scene's code as soon as WebGL is known to work, while the
	// snapshot may still be loading, so the diorama is ready sooner.
	const webglSupported = webgl?.supported === true;
	useEffect(() => {
		if (webglSupported) {
			loadScene().catch(() => undefined);
		}
	}, [webglSupported]);
	const isEmpty =
		!loading && snapshot.agents.length === 0 && snapshot.threads.length === 0;
	const sceneReady = !loading && webgl?.supported === true;
	// With acts every count follows the acts: what needs you, who works.
	const stats = actsOn
		? {
				...town.stats,
				happiness: actHappiness(snapshot.asks, nowMs),
				working: tally.working,
			}
		: town.stats;
	let summary = `Town: ${plural(town.districts.length, "district")}, ${plural(town.buildings.length, "building")}, population ${stats.population}, happiness ${stats.happiness}%, ${stats.working} under construction, ${plural(town.petitions.length, "petition")} at City Hall.`;
	if (loading) {
		summary = "Town, loading";
	} else if (actsOn) {
		summary = `Town: ${actSummaryLine(tally)}.`;
	}
	const hallCount = actsOn ? tally.needYou : town.petitions.length;
	const firstPetition = town.petitions[0];
	// With acts City Hall's desk holds what needs you, from the asks.
	const deskQueue = actsOn
		? {
				// The heading counts what the list holds.
				count: tally.queue,
				list: (
					<AskQueueList
						acts={acts}
						clock={clock}
						fallbackFocus={fallbackRef}
						mode="sheet"
						nowMs={nowMs}
						onAsk={onAsk}
						onBlocker={onBlocker}
						snapshot={snapshot}
						unowned={unowned}
					/>
				),
			}
		: undefined;
	// With acts "Hear next" answers the first blocking ask, in ask order.
	const nextAsk = actsOn
		? [...(snapshot.asks ?? [])]
				.filter((ask) => ask.blocking)
				.sort(compareAsks)[0]
		: undefined;
	const desk = deskDocked ? (
		<TownDesk
			activeThreadId={activeThreadId}
			actQueue={deskQueue}
			className={
				deskDocked
					? "absolute bottom-4 left-4 w-[340px]"
					: "absolute inset-x-2.5 bottom-2.5 z-10 sm:right-auto sm:w-[360px]"
			}
			dataView={dataView}
			header={
				deskDocked ? null : (
					<GameIconButton
						label="Close City Hall"
						onClick={() => setDeskOpen(false)}
						title="Close City Hall (Esc)"
					>
						<X aria-hidden="true" className="size-5" strokeWidth={2.5} />
					</GameIconButton>
				)
			}
			headingRef={petitionsRef}
			loading={loading}
			onAgent={selectBuilding}
			onDistrict={showDistrict}
			onHall={showHall}
			onHear={hear}
			palette={palette}
			selectedId={focusedId}
			style={{ top: narrowStage ? 70 : 84 }}
			town={sceneTown}
			upcoming={upcomingRuns(snapshot.events)}
		/>
	) : null;
	const hud = (
		<>
			<div
				className={cn(
					"pointer-events-none absolute inset-x-0 top-0 flex items-start",
					narrowStage ? "gap-2 p-2.5" : "gap-3 p-4"
				)}
			>
				<div className="flex min-w-0 flex-col items-start gap-2">
					<div className="max-w-full">
						<TownTitle
							actStatus={actsOn ? actSummaryLine(tally) : undefined}
							compact={narrowStage}
							speed={effectiveSpeed}
						/>
					</div>
					{actsOn ? <BlindSpotCaption snapshot={snapshot} /> : null}
				</div>
				{deskDocked ? null : (
					<CityHallButton
						actMode={actsOn}
						onClick={() => setDeskOpen((open) => !open)}
						open={deskOpen}
						petitions={hallCount}
					/>
				)}
				{deskDocked && !loading ? (
					<div className="flex min-w-0 flex-1 justify-center">
						<TownStatsPlate
							compact={false}
							funds={formatFunds(snapshot)}
							stats={stats}
						/>
					</div>
				) : null}
				<div className="ms-auto flex shrink-0 flex-wrap items-start justify-end gap-3">
					<SpeedControl onSpeed={chooseSpeed} speed={effectiveSpeed} />
					{narrowStage ? null : actButtons}
					{!(actsOn || loading || narrowStage) && firstPetition ? (
						<GameAction
							icon={<Megaphone strokeWidth={2.5} />}
							label="Hear next petition"
							onClick={() => hear(firstPetition.thread.id)}
						/>
					) : null}
					{actsOn && nextAsk && !narrowStage ? (
						<GameAction
							icon={<Megaphone strokeWidth={2.5} />}
							label="Hear next ask"
							onClick={() => openAsk(nextAsk.id)}
						/>
					) : null}
				</div>
			</div>
			{desk}
			{loading || isEmpty || webgl?.supported === false ? null : (
				<GameHudSlot
					at="bottom-left"
					className={cn("flex-col items-start", deskDocked && "left-[356px]")}
				>
					<DataViewControl
						actMode={actsOn}
						onChange={chooseDataView}
						palette={palette}
						value={dataView}
					/>
					{actsOn && narrowStage ? (
						<div className="flex gap-2">{actButtons}</div>
					) : null}
					{deskDocked || (actsOn && narrowStage) ? null : (
						<TownStatsPlate
							compact={narrowStage}
							funds={formatFunds(snapshot)}
							stats={stats}
						/>
					)}
				</GameHudSlot>
			)}
			{loading || isEmpty || webgl?.supported === false ? null : (
				<GameHudSlot
					at="bottom-right"
					className={narrowStage ? "bottom-[60px]" : undefined}
				>
					<ZoomControls
						onFit={() => cameraRef.current?.reset()}
						onZoom={(factor) => cameraRef.current?.zoomBy(factor)}
					/>
				</GameHudSlot>
			)}
		</>
	);

	return (
		<TownActMode.Provider value={actsOn}>
			<TownPanelActs.Provider value={actsOn ? acts : null}>
				<GameShell
					accent="sky"
					busy={loading}
					hud={hud}
					label="Town map"
					onKeyDown={onRootKeyDown}
					rootRef={rootRef}
					sheet={
						view ? (
							<TownPanel
								headingRef={headingRef}
								onBack={back}
								onClose={close}
								onCommission={commission}
								onOpen={hear}
								threadView={threadView}
								view={view}
							/>
						) : hallSheet ? (
							<GameSheet
								closeLabel="Close City Hall"
								data-town-panel="hall"
								label="City Hall"
								leading={
									<span
										aria-hidden="true"
										className="grid size-9 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink)"
									>
										<Landmark className="size-5" strokeWidth={2.25} />
									</span>
								}
								onClose={() => setDeskOpen(false)}
								subtitle={
									actsOn
										? `${tally.needYou} need you`
										: plural(town.petitions.length, "petition")
								}
								title="City Hall"
							>
								<div className="flex min-h-full flex-col">
									<TownDeskBody
										activeThreadId={activeThreadId}
										actQueue={deskQueue}
										dataView={dataView}
										headingRef={petitionsRef}
										loading={loading}
										onAgent={selectBuilding}
										onDistrict={showDistrict}
										onHall={showHall}
										onHear={hear}
										palette={palette}
										selectedId={focusedId}
										town={sceneTown}
										upcoming={upcomingRuns(snapshot.events)}
									/>
								</div>
							</GameSheet>
						) : null
					}
					stageRef={stageRef}
					testId="interface-town"
				>
					<h1 className="sr-only" ref={fallbackRef} tabIndex={-1}>
						Town
					</h1>
					<p className="sr-only">{summary}</p>
					{actsOn ? (
						// While the City Hall sheet holds the queue, this copy steps
						// aside (one "Ask queue" to Tab through, not two).
						<div className="contents" inert={hallSheet}>
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
						</div>
					) : null}
					<motion.div
						animate={{ opacity: drawn ? 1 : 0 }}
						aria-hidden="true"
						className="absolute inset-0"
						initial={false}
						transition={{ duration: reduced ? 0 : 0.32, ease: "easeOut" }}
					>
						{sceneReady ? (
							<Suspense fallback={null}>
								<TownScene
									actAsks={snapshot.asks}
									active={visible}
									actNow={nowMs}
									actScene={actScene}
									dataView={dataView}
									hoverId={hoverId}
									insets={insets}
									onCamera={onCamera}
									onDrawn={onDrawn}
									overlay={layerRef}
									palette={palette}
									quality={webgl.quality}
									reduced={reduced}
									selectedId={focusedId}
									speed={effectiveSpeed}
									town={sceneTown}
								/>
							</Suspense>
						) : null}
					</motion.div>
					{sceneReady ? (
						<motion.div
							animate={{ opacity: drawn ? 1 : 0 }}
							className="pointer-events-none absolute inset-0 z-10"
							inert={!drawn}
							initial={false}
							transition={{ duration: reduced ? 0 : 0.32, ease: "easeOut" }}
						>
							<TownOverlay
								actLayer={
									actsOn
										? {
												acts,
												bubbles: tagBubbles,
												needYou: tally.needYou,
												onAsk: (askId) => openAsk(askId),
												props: (
													<TownActProps
														entries={actEntries}
														handlers={{
															clock,
															iconOnly: budget.iconOnly,
															nowMs,
															onAsk: (askId) => openAsk(askId),
															onBlocker: (threadId, agentName) =>
																openBlocker(threadId, agentName),
															onQueue: () => openQueue(queueOpener),
															privacy,
															snapshot,
														}}
													/>
												),
											}
										: null
								}
								hoverId={hoverId}
								layerRef={layerRef}
								onBuilding={selectBuilding}
								onDistrict={showDistrict}
								onHall={showHall}
								onHover={setHoverId}
								selectedId={focusedId}
								showCounts={!narrowStage}
								showTags={roomyStage}
								town={sceneTown}
							/>
						</motion.div>
					) : null}
					{!loading && webgl?.supported === false ? (
						<div
							className={cn(
								"absolute inset-y-0 right-0 overflow-y-auto px-4 pb-6",
								// With acts the blind-spot caption (and on a phone the
								// summary's own plate) sit under the title plate.
								actsOn ? (narrowStage ? "pt-56" : "pt-36") : "pt-24"
							)}
							style={{ left: deskDocked ? GUTTER * 2 + DESK_WIDTH : 0 }}
						>
							<GamePlate className="mx-auto max-w-2xl px-2 py-2">
								<p className="px-2 pt-2 font-medium text-(--gk-ink-muted) text-sm">
									The 3D town needs WebGL, which is off here, so its buildings
									are listed by district.
								</p>
								<TownDirectory
									actLayer={
										actsOn
											? { acts, clock, nowMs, onAsk, onBlocker, snapshot }
											: null
									}
									onBuilding={selectBuilding}
									town={town}
								/>
							</GamePlate>
						</div>
					) : null}
					{loading || webgl === null || (sceneReady && !drawn) ? (
						<div
							className="pointer-events-none absolute flex items-center justify-center"
							style={{
								bottom: insets.bottom,
								left: insets.left,
								right: insets.right,
								top: insets.top,
							}}
						>
							<IslandPlaceholder />
							<span className="sr-only">Laying out the town</span>
						</div>
					) : null}
					{isEmpty ? (
						<motion.div
							animate={{ opacity: 1, transform: "translateY(0px)" }}
							className="absolute bottom-24 z-20 flex justify-center px-4"
							initial={
								reduced ? false : { opacity: 0, transform: "translateY(6px)" }
							}
							style={{ left: insets.left, right: insets.right }}
						>
							<GamePlate className="flex max-w-md flex-col gap-3 px-5 py-4">
								<div className="flex flex-col gap-1">
									<h2 className="gk-display text-[22px] leading-7">
										No one lives here yet
									</h2>
									<p className="text-pretty font-medium text-(--gk-ink-muted) text-sm leading-5">
										Every agent gets a building, and projects and teams become
										districts around City Hall. Start a conversation to found
										the town.
									</p>
								</div>
								<Button
									className="self-start"
									onClick={() => port.startThread({})}
									size="sm"
									type="button"
								>
									<SquarePen aria-hidden="true" data-icon="inline-start" />
									Start a conversation
								</Button>
							</GamePlate>
						</motion.div>
					) : null}
					<p aria-live="polite" className="sr-only">
						{announcement}
					</p>
					{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
					{cards.element}
				</GameShell>
			</TownPanelActs.Provider>
		</TownActMode.Provider>
	);
}
