import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { SquarePen } from "lucide-react";
import { motion } from "motion/react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { GamePlate } from "./game-hud.tsx";
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
	type IsoInsets,
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
import { kitchenActVillagers, kitchenPaths } from "./kitchen-acts.tsx";
import { ChefColorsProvider } from "./kitchen-avatar.tsx";
import {
	KITCHEN_RIM,
	type KitchenActScene,
	KitchenDioramaScene,
	SLAB,
} from "./kitchen-diorama.tsx";
import { useNow, useThemeColors } from "./kitchen-hooks.ts";
import {
	type HudDensity,
	hudDensity,
	hudInsets,
	KitchenTitle,
	NewOrderButton,
	OrderRail,
	ServiceClock,
	ServiceScore,
} from "./kitchen-hud.tsx";
import {
	ACT_SPREAD,
	actTickets,
	buildService,
	chefOrders,
	floorCentreZ,
	plural,
	STATIONS_PER_ROW,
} from "./kitchen-model.ts";
import { KitchenLine } from "./kitchen-overlay.tsx";
import { kitchenPalette } from "./kitchen-palette.ts";
import { KitchenPanel, type KitchenPanelView } from "./kitchen-panel.tsx";
import {
	hasActs,
	useActAnnouncement,
	useActClockOptions,
	useActs,
} from "./use-acts.ts";

type Selection =
	| { agentId: string; kind: "chef" }
	| {
			agentId: string | undefined;
			kind: "new";
	  };

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
	const [stageSize, setStageSize] = useState<{
		height: number;
		width: number;
	} | null>(null);
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

	useEffect(() => {
		const stage = stageRef.current;
		if (!stage || typeof ResizeObserver === "undefined") {
			return;
		}
		// Committed before the browser paints, so the HUD and the diorama
		// refit in the same frame the stage changes size (a panel opening).
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				flushSync(() => {
					setStageSize({
						height: entry.contentRect.height,
						width: entry.contentRect.width,
					});
				});
			}
		});
		observer.observe(stage);
		return () => observer.disconnect();
	}, []);

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
			setAnnouncement(station ? `${station.agent.name}'s tickets` : "");
		},
		[port, service.stations, threadOpen]
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

	// The act layer (when the host sends asks): what each chef acts out, the
	// queue at the pass, the cards, the HUD summary and the announcer.
	const fallbackRef = useRef<HTMLHeadingElement>(null);
	const { acts, nowMs, privacy, unowned } = actsView;
	const actsOn = actsView.enabled;
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
	const queueOpener = useRef<(() => void) | null>(null);
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const tally = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(stageSize?.width ?? 1280, { domTargets: true });
	// Urgency order (the kit's stage order): the budget keeps what matters.
	const staged = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const cast = staged.onStage;
	// A phone has no room beside the plates for a work bubble (it stands
	// wider than its plate and would run off the stage): the station board
	// and the act sentence carry the step there.
	const phone = budget.iconOnly;
	const shownKey = [
		...budget.fill(
			actOverlays(
				cast,
				slots,
				{ count: 0 },
				cast.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced }
			)
		),
	]
		.filter((id) => !(phone && id.startsWith("work:")))
		.sort()
		.join("|");
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const centreZ = floorCentreZ(service.floor);
	const paths = useMemo(
		() => kitchenPaths(service, centreZ, SLAB),
		[centreZ, service]
	);
	const { openAsk, openBlocker } = cards;
	const actVillagers = useMemo(
		() =>
			actsOn
				? kitchenActVillagers({
						acts,
						centreZ,
						looks,
						nowMs,
						onAsk: (askId) => openAsk(askId),
						paths,
						reduced,
						service,
						shown,
						slab: SLAB,
						slots: slots.slots,
					})
				: [],
		[
			acts,
			actsOn,
			centreZ,
			looks,
			nowMs,
			openAsk,
			paths,
			reduced,
			service,
			shown,
			slots.slots,
		]
	);
	const actScene: KitchenActScene | null = actsOn
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
	const ticketActs = useMemo(
		() => (actsOn ? actTickets(snapshot, acts, nowMs) : null),
		[acts, actsOn, nowMs, snapshot]
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
				narrow={narrow}
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
	const legacySummary = `Kitchen: ${plural(service.stations.length, "chef")}, ${totals.cooking} cooking, ${totals.ready} ready to serve, ${totals.burnt} burnt.`;

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
		<>
			<div
				className={cn(
					"pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start",
					narrow ? "gap-2.5 p-2.5" : "gap-3 p-4"
				)}
			>
				{/* Shrinks on a narrow stage so the title's status can wrap (K2). */}
				<div className="flex min-w-0 shrink flex-col items-start gap-2">
					<KitchenTitle
						actStatus={actsOn ? actSummaryLine(tally) : undefined}
						density={density}
						service={service}
					/>
					{actsOn ? <BlindSpotCaption snapshot={snapshot} /> : null}
				</div>
				<OrderRail
					activeThreadId={activeThreadId}
					className={cn(
						"order-3 basis-full",
						density === "wide" && "order-none mx-2 basis-0 self-stretch",
						density === "wide" && "flex-1"
					)}
					density={density}
					headingRef={fallbackRef}
					hoverId={hoverId}
					loading={loading}
					onHover={setHoverId}
					onServe={serve}
					palette={palette}
					service={service}
					// With acts the rail holds only what moves; open quiet orders
					// are not "no open orders".
					showEmptyRail={
						!(isEmpty || (ticketActs && snapshot.threads.length > 0))
					}
					ticketActs={ticketActs}
				/>
				<div className="ms-auto flex shrink-0 flex-col items-end gap-2">
					<NewOrderButton
						density={density}
						disabled={loading}
						onNewOrder={newOrder}
					/>
					{narrow ? null : actButtons}
				</div>
			</div>
			{actsOn && narrow ? (
				// Clear of the zoom column on the right, and kept while asks exist.
				<GameHudSlot at="bottom-left" className="right-[68px] flex-wrap">
					{actButtons}
				</GameHudSlot>
			) : null}
			{loading || isEmpty ? null : (
				<>
					{actsOn && narrow ? null : (
						<GameHudSlot
							at="bottom-left"
							className={narrow ? "right-0 justify-center" : undefined}
						>
							<ServiceScore
								actTotals={actsOn ? tally : undefined}
								density={density}
								service={service}
							/>
						</GameHudSlot>
					)}
					<GameHudSlot at="bottom-right">
						{narrow || params?.serviceClock === false ? null : <ServiceClock />}
						<IsoZoomControls view={isoView} />
					</GameHudSlot>
				</>
			)}
		</>
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
							? `Kitchen: ${actSummaryLine(tally)}.`
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
							<div
								className="absolute inset-x-0 overflow-y-auto bg-(--gk-backdrop) px-4"
								style={{ bottom: insets.bottom, top: insets.top }}
							>
								<KitchenLine
									actLayer={
										actsOn
											? { acts, clock, nowMs, onAsk, onBlocker, snapshot }
											: null
									}
									onSelectChef={selectChef}
									onServe={serve}
									service={service}
								/>
								<p className="mx-auto mt-4 max-w-2xl font-medium text-(--gk-ink-muted) text-sm">
									The 3D kitchen needs WebGL, which is off here, so the line is
									shown as a list.
								</p>
							</div>
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
					<motion.div
						animate={{ opacity: 1 }}
						className="absolute inset-x-0 z-20 flex items-center justify-center"
						initial={reduced ? false : { opacity: 0 }}
						style={{
							bottom: insets.bottom,
							paddingInline: side,
							top: insets.top,
						}}
						transition={{ duration: 0.2, ease: "easeOut" }}
					>
						<div className="absolute inset-0 flex items-center justify-center px-6">
							<GamePlate className="flex max-w-sm flex-col items-center gap-4 px-6 py-6 text-center">
								<div className="flex flex-col gap-1.5">
									<h2 className="gk-display text-[24px] leading-7">
										No chefs on the line
									</h2>
									<p className="text-pretty font-medium text-(--gk-ink-muted) text-sm leading-5">
										{snapshot.threads.length > 0
											? "These orders have no agent to cook them. Add an agent to staff a station."
											: "Add an agent to staff a station, or start a conversation."}
									</p>
								</div>
								<Button
									onClick={() => port.startThread({})}
									size="sm"
									type="button"
								>
									<SquarePen aria-hidden="true" data-icon="inline-start" />
									Start a conversation
								</Button>
							</GamePlate>
						</div>
					</motion.div>
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
