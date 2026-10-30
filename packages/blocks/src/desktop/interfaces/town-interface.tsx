import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import { actSummaryLine } from "./game3d-acts.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import { ActAnnouncer, AskQueueList } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { TownActMode } from "./town-desk.tsx";
import {
	useElementWidth,
	useStageVisible,
	useThemeColors,
	useWebGLSupport,
} from "./town-hooks.ts";
import { useTownActLayer } from "./town-interface-acts.tsx";
import {
	TownEmptyState,
	TownLoadingPlaceholder,
	TownWebglFallback,
} from "./town-interface-fallbacks.tsx";
import { TownHallSheet } from "./town-interface-hall.tsx";
import { TownInterfaceHud } from "./town-interface-hud.tsx";
import { DESK_DOCKS_AT, DESK_WIDTH, GUTTER } from "./town-interface-layout.tsx";
import {
	useTownCameraFocus,
	useTownEscape,
} from "./town-interface-navigation.ts";
import { useTownSettings } from "./town-interface-settings.ts";
import { loadScene, TownStageLayers } from "./town-interface-stage.tsx";
import { useTownPanelView } from "./town-interface-view.ts";
import { actHappiness, buildingFor, buildTown, plural } from "./town-model.ts";
import { townPalette } from "./town-palette.ts";
import { TownPanel, TownPanelActs } from "./town-panel.tsx";
import type { SceneInsets, TownCamera } from "./town-scene.tsx";

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
	const tl = useLiteralMessages();
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
	const { chooseDataView, chooseSpeed, dataView, speed } = useTownSettings(
		params,
		port
	);
	const [drawn, setDrawn] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const [deskOpen, setDeskOpen] = useState(false);
	// Reduced motion starts the clock paused; the mayor can still press play.
	const effectiveSpeed = speed ?? (reduced ? 0 : 1);

	const { focusedId, threadBuilding, threadOpen, view, viewKey } =
		useTownPanelView({
			activeThreadId,
			cameraRef,
			selectedId,
			snapshot,
			threadView,
			town,
		});

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

	const {
		actButtons,
		acts,
		actScene,
		actsOn,
		cards,
		clock,
		fallbackRef,
		nowMs,
		onAsk,
		onBlocker,
		openAsk,
		overlayActLayer,
		sceneTown,
		sentence,
		tally,
		unowned,
	} = useTownActLayer({
		hudWidth,
		kit,
		loading,
		narrowStage,
		port,
		reduced,
		snapshot,
		town,
	});

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
					? tl(
							"{name}'s building, {count, plural, one {{countText} conversation} other {{countText} conversations}}",
							{
								count: building.threads.length,
								countText: String(building.threads.length),
								name: building.agent.name,
							}
						)
					: ""
			);
		},
		[port, threadOpen, tl, town]
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
	const onRootKeyDown = useTownEscape(rootRef, stepBack);

	// Keep the camera on whoever the panel is about, including a thread the
	// host opened before the scene existed.
	const focusTarget = buildingFor(town, focusedId);
	const focusX = focusTarget?.lot.x;
	const focusZ = focusTarget?.lot.z;
	const onCamera = useTownCameraFocus(cameraRef, focusX, focusZ);
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
	let summary = tl(
		"Town: {districtCount, plural, one {{districtText} district} other {{districtText} districts}}, {buildingCount, plural, one {{buildingText} building} other {{buildingText} buildings}}, population {population}, happiness {happiness}%, {working} under construction, {petitionCount, plural, one {{petitionText} petition} other {{petitionText} petitions}} at City Hall.",
		{
			buildingCount: town.buildings.length,
			buildingText: String(town.buildings.length),
			districtCount: town.districts.length,
			districtText: String(town.districts.length),
			happiness: String(stats.happiness),
			petitionCount: town.petitions.length,
			petitionText: String(town.petitions.length),
			population: String(stats.population),
			working: String(stats.working),
		}
	);
	if (loading) {
		summary = "Town, loading";
	} else if (actsOn) {
		summary = `Town: ${actSummaryLine(tally)}.`;
	}
	const hallCount = actsOn ? tally.needYou : town.petitions.length;
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
	const hud = (
		<TownInterfaceHud
			actButtons={actButtons}
			activeThreadId={activeThreadId}
			actsOn={actsOn}
			cameraRef={cameraRef}
			chooseDataView={chooseDataView}
			chooseSpeed={chooseSpeed}
			dataView={dataView}
			deskDocked={deskDocked}
			deskOpen={deskOpen}
			deskQueue={deskQueue}
			effectiveSpeed={effectiveSpeed}
			focusedId={focusedId}
			hallCount={hallCount}
			hear={hear}
			isEmpty={isEmpty}
			loading={loading}
			narrowStage={narrowStage}
			openAsk={openAsk}
			palette={palette}
			petitionsRef={petitionsRef}
			sceneTown={sceneTown}
			selectBuilding={selectBuilding}
			setDeskOpen={setDeskOpen}
			showDistrict={showDistrict}
			showHall={showHall}
			snapshot={snapshot}
			stats={stats}
			tally={tally}
			town={town}
			webgl={webgl}
		/>
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
							<TownHallSheet
								activeThreadId={activeThreadId}
								actsOn={actsOn}
								dataView={dataView}
								deskQueue={deskQueue}
								focusedId={focusedId}
								hear={hear}
								loading={loading}
								palette={palette}
								petitionsRef={petitionsRef}
								sceneTown={sceneTown}
								selectBuilding={selectBuilding}
								setDeskOpen={setDeskOpen}
								showDistrict={showDistrict}
								showHall={showHall}
								snapshot={snapshot}
								tally={tally}
								town={town}
							/>
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
					<TownStageLayers
						drawn={drawn}
						overlay={{
							actLayer: overlayActLayer,
							hoverId,
							layerRef,
							onBuilding: selectBuilding,
							onDistrict: showDistrict,
							onHall: showHall,
							onHover: setHoverId,
							selectedId: focusedId,
							showCounts: !narrowStage,
							showTags: roomyStage,
							town: sceneTown,
						}}
						reduced={reduced}
						scene={
							sceneReady
								? {
										actAsks: snapshot.asks,
										active: visible,
										actNow: nowMs,
										actScene,
										dataView,
										hoverId,
										insets,
										onCamera,
										onDrawn,
										overlay: layerRef,
										palette,
										quality: webgl.quality,
										reduced,
										selectedId: focusedId,
										speed: effectiveSpeed,
										town: sceneTown,
									}
								: null
						}
					/>
					{!loading && webgl?.supported === false ? (
						<TownWebglFallback
							actLayer={
								actsOn
									? { acts, clock, nowMs, onAsk, onBlocker, snapshot }
									: null
							}
							actsOn={actsOn}
							deskDocked={deskDocked}
							narrowStage={narrowStage}
							onBuilding={selectBuilding}
							town={town}
						/>
					) : null}
					{loading || webgl === null || (sceneReady && !drawn) ? (
						<TownLoadingPlaceholder insets={insets} />
					) : null}
					{isEmpty ? (
						<TownEmptyState
							insets={insets}
							onStart={() => port.startThread({})}
							reduced={reduced}
						/>
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
