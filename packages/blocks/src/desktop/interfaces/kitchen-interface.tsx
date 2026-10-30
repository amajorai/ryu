import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import { actSummaryLine } from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import {
	type IsoInsets,
	IsoStage,
	useFocusOnOpen,
	useGameNight,
	useIsoView,
	useReducedMotion,
} from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import { ActAnnouncer, AskQueueList } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { ChefColorsProvider } from "./kitchen-avatar.tsx";
import { KITCHEN_RIM, KitchenDioramaScene } from "./kitchen-diorama.tsx";
import { useNow, useThemeColors } from "./kitchen-hooks.ts";
import { type HudDensity, hudDensity, hudInsets } from "./kitchen-hud.tsx";
import { useKitchenActLayer } from "./kitchen-interface-acts.tsx";
import { KitchenEmptyState } from "./kitchen-interface-empty.tsx";
import { useKitchenEscape } from "./kitchen-interface-escape.ts";
import { KitchenLineFallback } from "./kitchen-interface-fallback.tsx";
import { KitchenInterfaceHud } from "./kitchen-interface-hud.tsx";
import { useStageSize } from "./kitchen-interface-stage-size.ts";
import {
	ACT_SPREAD,
	buildService,
	chefOrders,
	STATIONS_PER_ROW,
} from "./kitchen-model.ts";
import { kitchenPalette } from "./kitchen-palette.ts";
import { KitchenPanel, type KitchenPanelView } from "./kitchen-panel.tsx";
import { hasActs, useActs } from "./use-acts.ts";

type Selection =
	| { agentId: string; kind: "chef" }
	| {
			agentId: string | undefined;
			kind: "new";
	  };

/**
 * Kitchen: your agents as a kitchen brigade, after the co-op cooking game,
 * on the shared game kit (game-shell.tsx). Each agent is a chef at their own
 * station in a kitchen that fills the interface; conversations are paper
 * order tickets on the rail across the top. Cooking chefs work their station with
 * a progress ring (an estimate against their usual run time); a reply is a
 * plated dish glowing on the pass, ready to serve; a failed run is a burnt
 * order with smoke over the station. Serving a ticket (or a dish) opens the
 * host's own conversation in the side panel; clicking a chef shows their
 * tickets; New order places one with a chef you pick.
 */
export function KitchenInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["kitchen"]>) {
	const tl = useLiteralMessages();
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const focusHeading = useRef(false);
	const reduced = useReducedMotion();
	const night = useGameNight(rootRef);
	const isoView = useIsoView();
	const now = useNow();
	const theme = useThemeColors(rootRef);
	const palette = useMemo(() => kitchenPalette(theme), [theme]);
	const stageSize = useStageSize(stageRef);
	// A phone-shaped stage gets shorter counter lines, so the room is taller
	// than wide and fills the stage instead of sitting in a thin strip.
	const perRow =
		stageSize !== null &&
		stageSize.width < 640 &&
		stageSize.height > stageSize.width * 1.2
			? 2
			: STATIONS_PER_ROW;
	// "Today" only matters for the served tally: read the clock per snapshot.
	// With the act layer, stations stand farther apart for its props.
	const service = useMemo(
		() =>
			buildService(
				snapshot,
				Date.now(),
				perRow,
				hasActs(snapshot) ? ACT_SPREAD : 1
			),
		[perRow, snapshot]
	);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [hoverId, setHoverId] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [cameFromChef, setCameFromChef] = useState(false);

	const threadOpen = threadView !== null;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const selectedChef =
		selection?.kind === "chef"
			? service.stations.find(
					(station) => station.agent.id === selection.agentId
				)
			: undefined;
	const threadStation =
		selectedChef && activeThread?.agentIds.includes(selectedChef.agent.id)
			? selectedChef
			: service.stations.find((station) =>
					activeThread?.agentIds.includes(station.agent.id)
				);

	let view: KitchenPanelView | null = null;
	if (threadOpen) {
		view = { kind: "thread", station: threadStation, thread: activeThread };
	} else if (selectedChef) {
		view = {
			kind: "chef",
			orders: chefOrders(snapshot, selectedChef.agent.id),
			station: selectedChef,
		};
	} else if (selection?.kind === "new") {
		view = {
			agentId: selection.agentId,
			kind: "new",
			stations: service.stations,
		};
	}
	// The sheet's chef: the camera glides to their station when it opens.
	let focusId: string | null = null;
	if (view?.kind === "new") {
		focusId = view.agentId ?? null;
	} else if (view) {
		focusId = view.station?.agent.id ?? null;
	}
	useFocusOnOpen(isoView, focusId);
	const viewKey = view
		? `${view.kind}:${selection?.agentId ?? ""}:${activeThreadId ?? ""}`
		: "";
	// The sheet floats over the right of the kitchen: the camera frames the
	// line in what is left.
	const sheetCover = view && stageSize ? gameSheetCover(stageSize.width) : 0;
	// The HUD shares the uncovered part of the stage (all of it on a narrow
	// stage, where the sheet covers the HUD anyway).
	const density: HudDensity = stageSize
		? hudDensity(
				sheetCover < stageSize.width
					? stageSize.width - sheetCover
					: stageSize.width
			)
		: "wide";
	const narrow = density === "narrow";
	// The act layer's summary wraps the narrow title plate (see `hudInsets`).
	const actsView = useActs(snapshot);
	const hudRoom = hudInsets(density, actsView.enabled);
	const side = narrow ? 12 : 32;
	// A sheet that covers the whole stage leaves no room to frame the line
	// beside it: the camera keeps the whole stage, as the scene behind the
	// sheet is out of sight anyway.
	const frameCover = stageSize && sheetCover < stageSize.width ? sheetCover : 0;
	const insets = useMemo<IsoInsets>(
		() => ({
			bottom: hudRoom.bottom,
			left: side,
			right: side + frameCover,
			top: hudRoom.top,
		}),
		[frameCover, hudRoom.bottom, hudRoom.top, side]
	);

	useLayoutEffect(() => {
		if (!(viewKey && focusHeading.current)) {
			return;
		}
		focusHeading.current = false;
		headingRef.current?.focus();
	}, [viewKey]);

	const selectChef = useCallback(
		(agentId: string) => {
			if (threadOpen) {
				port.closeThread();
			}
			focusHeading.current = true;
			setSelection({ agentId, kind: "chef" });
			const station = service.stations.find(
				(item) => item.agent.id === agentId
			);
			setAnnouncement(
				station ? tl("{name}'s tickets", { name: station.agent.name }) : ""
			);
		},
		[port, service.stations, threadOpen, tl]
	);
	const serve = useCallback(
		(threadId: string) => {
			focusHeading.current = true;
			setCameFromChef(false);
			port.openThread(threadId);
		},
		[port]
	);
	/** Opens a ticket from a chef's pane: Back returns to that chef. */
	const serveFromChef = useCallback(
		(threadId: string) => {
			focusHeading.current = true;
			setCameFromChef(true);
			port.openThread(threadId);
		},
		[port]
	);
	const newOrder = () => {
		if (threadOpen) {
			port.closeThread();
		}
		focusHeading.current = true;
		setSelection({
			agentId: selectedChef?.agent.id ?? threadStation?.agent.id,
			kind: "new",
		});
	};
	const canGoBack = threadOpen && cameFromChef && threadStation !== undefined;
	const back = () => {
		port.closeThread();
		focusHeading.current = true;
		setCameFromChef(false);
		if (threadStation) {
			setSelection({ agentId: threadStation.agent.id, kind: "chef" });
		}
	};
	const close = () => {
		if (threadOpen) {
			port.closeThread();
		}
		setCameFromChef(false);
		setSelection(null);
		setAnnouncement("Back to the kitchen");
	};
	const order = (input: { agentId?: string; prompt: string }) => {
		focusHeading.current = true;
		setCameFromChef(input.agentId !== undefined);
		if (input.agentId) {
			setSelection({ agentId: input.agentId, kind: "chef" });
		}
		port.startThread(
			input.agentId
				? { agentId: input.agentId, prompt: input.prompt }
				: { prompt: input.prompt }
		);
	};

	const stepBack = (): boolean => {
		if (canGoBack) {
			back();
			return true;
		}
		if (view) {
			close();
			return true;
		}
		return false;
	};
	const onRootKeyDown = useKitchenEscape(rootRef, stepBack);

	const isEmpty = !loading && snapshot.agents.length === 0;
	const shape = useMemo(
		() => islandFor(service.floor.width, service.floor.depth, KITCHEN_RIM),
		[service.floor]
	);
	const bounds = useMemo(
		() => ({
			maxX: service.floor.width / 2 + 0.4,
			maxZ: service.floor.depth / 2 + 0.6,
			minX: -service.floor.width / 2 - 0.4,
			minZ: -service.floor.depth / 2 - 0.2,
			top: 2.6,
		}),
		[service.floor]
	);
	const { totals } = service;
	const stationIds = useMemo(
		() => service.stations.map((station) => station.agent.id),
		[service.stations]
	);
	const { looks } = useVillagerLooks(stationIds, night);

	const {
		actButtons,
		actScene,
		acts,
		actsOn,
		cards,
		clock,
		fallbackRef,
		nowMs,
		onAsk,
		onBlocker,
		sentence,
		tally,
		ticketActs,
		unowned,
	} = useKitchenActLayer({
		actsView,
		looks,
		narrow,
		port,
		reduced,
		service,
		snapshot,
		stageSize,
	});
	const legacySummary = tl(
		"Kitchen: {chefCount, plural, one {{chefs} chef} other {{chefs} chefs}}, {cooking} cooking, {ready} ready to serve, {burnt} burnt.",
		{
			burnt: String(totals.burnt),
			chefCount: service.stations.length,
			chefs: String(service.stations.length),
			cooking: String(totals.cooking),
			ready: String(totals.ready),
		}
	);

	const sheet = view ? (
		<KitchenPanel
			acts={actsOn ? acts : null}
			actViews={ticketActs?.views ?? null}
			headingRef={headingRef}
			onBack={canGoBack ? back : undefined}
			onClose={close}
			onOpen={serveFromChef}
			onOrder={order}
			threadView={threadView}
			view={view}
		/>
	) : null;
	const hud = (
		<KitchenInterfaceHud
			actButtons={actButtons}
			activeThreadId={activeThreadId}
			actsOn={actsOn}
			density={density}
			fallbackRef={fallbackRef}
			hoverId={hoverId}
			isEmpty={isEmpty}
			isoView={isoView}
			loading={loading}
			narrow={narrow}
			newOrder={newOrder}
			palette={palette}
			params={params}
			serve={serve}
			service={service}
			setHoverId={setHoverId}
			snapshot={snapshot}
			tally={tally}
			ticketActs={ticketActs}
		/>
	);

	return (
		<ChefColorsProvider agentIds={stationIds}>
			<GameShell
				accent="tomato"
				busy={loading}
				hud={hud}
				label="Kitchen"
				onKeyDown={onRootKeyDown}
				rootRef={rootRef}
				sheet={sheet}
				stageRef={stageRef}
				testId="interface-kitchen"
			>
				<p className="sr-only">
					{loading
						? "Kitchen, loading"
						: actsOn
							? tl("Kitchen: {summary}.", { summary: actSummaryLine(tally) })
							: legacySummary}
				</p>
				{loading ? (
					<span className="sr-only">Setting up the kitchen</span>
				) : null}
				{actsOn ? (
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
				) : null}
				<IsoStage
					bounds={bounds}
					fallback={
						loading || isEmpty ? null : (
							<KitchenLineFallback
								actLayer={
									actsOn
										? { acts, clock, nowMs, onAsk, onBlocker, snapshot }
										: null
								}
								insets={insets}
								onSelectChef={selectChef}
								onServe={serve}
								service={service}
							/>
						)
					}
					insets={insets}
					label="Kitchen diorama: a station per chef and the pass with ready dishes. Tab or the arrow keys move between chefs and dishes; drag to pan, plus and minus to zoom."
					night={night}
					reducedMotion={reduced}
					view={isoView}
				>
					{({ quality, theme: scene }) => (
						<KitchenDioramaScene
							actScene={actScene}
							hoverId={hoverId}
							looks={looks}
							night={night}
							now={now}
							onHover={setHoverId}
							onSelectChef={selectChef}
							onServe={serve}
							palette={palette}
							quality={quality}
							reduced={reduced}
							selectedChefId={
								view?.kind === "chef" || view?.kind === "thread"
									? (view.station?.agent.id ?? null)
									: null
							}
							service={service}
							shape={shape}
							theme={scene}
						/>
					)}
				</IsoStage>
				{isEmpty ? (
					<KitchenEmptyState
						hasThreads={snapshot.threads.length > 0}
						insets={insets}
						onStart={() => port.startThread({})}
						reduced={reduced}
						side={side}
					/>
				) : null}
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>
				{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
				{cards.element}
			</GameShell>
		</ChefColorsProvider>
	);
}
