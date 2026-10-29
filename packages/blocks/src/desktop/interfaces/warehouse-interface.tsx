import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { Pause, Play, Plus, Warehouse } from "lucide-react";
import { motion } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { keepsActOverlay } from "./act-settings.ts";
import { GameAction, GameIconButton, GameTitlePlate } from "./game-hud.tsx";
import { GameHudSlot, GameShell } from "./game-shell.tsx";
import {
	actOverlays,
	actSummaryLine,
	actTotals,
	blockerEntries,
	overlayBudget,
	youSpotSlots,
} from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	IsoStage,
	IsoZoomControls,
	useGameNight,
	useIsoView,
} from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActAnnouncer,
	ActStatus,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";
import {
	actPickers,
	CAGE_REASON_ID,
	cageReason,
	floorAgents,
	orderActs,
	pickerStations,
	shelfLabels,
	WarehouseActProps,
	warehouseActPaths,
} from "./warehouse-acts.tsx";
import {
	TILE,
	WAREHOUSE_BOUNDS,
	type WarehouseActors,
	WarehouseDioramaScene,
} from "./warehouse-diorama.tsx";
import { WarehouseList } from "./warehouse-list.tsx";
import {
	buildOrders,
	buildPickers,
	filterOrders,
	floorStats,
	type OrderTab,
	placeOrders,
	plural,
	tabCounts,
} from "./warehouse-model.ts";
import {
	CreateOrder,
	OrderConversation,
	OrderDetail,
} from "./warehouse-order.tsx";
import { OrdersList } from "./warehouse-orders.tsx";
import { WAREHOUSE_SCENE_CSS, warehouseArt } from "./warehouse-palette.ts";
import {
	Clipboard,
	StatsStrip,
	WarehouseActsContext,
} from "./warehouse-parts.tsx";

/** Below this stage width the clipboard sits under the floor. */
const NARROW_BELOW = 900;

/** Stages move with time (packing, then shipped), so the clock ticks. */
const CLOCK_MS = 30_000;
/**
 * The floor's fill beside an open thread (the clipboard widens to 560, so
 * the floor narrows): a closer look, so its plates keep their spacing.
 */
const OPEN_FILL = 1.3;

type PanelView = "create" | "detail" | "list" | "thread";

/** Where focus returns after Create order closes. */
const CREATE_TARGET = "create";

/** Escape inside a text field belongs to the field unless the field is empty. */
function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	if (target.closest("[data-testid='warehouse-thread']")) {
		return false;
	}
	const field = target.closest("input:not([type='radio']), textarea, select");
	if (target.isContentEditable) {
		return false;
	}
	if (
		field instanceof HTMLTextAreaElement ||
		field instanceof HTMLInputElement
	) {
		return field.value.trim() === "";
	}
	return field === null;
}

/** The element's size, kept current; zero until measured. */
function useElementSize(ref: RefObject<HTMLElement | null>) {
	const [size, setSize] = useState({ height: 0, width: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () =>
			setSize((current) =>
				current.width === element.clientWidth &&
				current.height === element.clientHeight
					? current
					: { height: element.clientHeight, width: element.clientWidth }
			);
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

function useClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
		return () => clearInterval(timer);
	}, []);
	return now;
}

type WarehouseSettings = Required<InterfaceParamsByRenderer["warehouse"]>;

/** The Warehouse's own settings, resolved from its live params. */
export function warehouseSettings(
	params: InterfaceParamsByRenderer["warehouse"] | undefined
): WarehouseSettings {
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	return resolveInterfaceParams("warehouse", params) as WarehouseSettings;
}

/** The floor's light: the color theme's (dark is night), or the shift's. */
export function warehouseNight(
	shift: WarehouseSettings["shift"],
	themeNight: boolean
): boolean {
	return shift === "theme" ? themeNight : shift === "night";
}

/**
 * Warehouse: the fulfillment side of your agents. On the left an isometric
 * warehouse floor, where every agent is a picker working an aisle and every
 * conversation is an order box moving through the building: received at the
 * inbound bay, picked in the aisles, packed off the conveyor, staged at the
 * dock when the agent has replied, loaded on the truck when done, or flagged
 * in the returns cage when a run failed. On the right a Shopify-style orders
 * list; "Fulfil" opens the order's conversation (the host's own thread view)
 * and "Create order" starts a new one with a chosen picker.
 */
export function WarehouseInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["warehouse"]>) {
	const now = useClock();
	const reduceMotion = useReducedMotion();
	const settings = warehouseSettings(params);
	const kitSettings = useGameKitSettings();
	// The pause button keeps its choice (a setting), live from Settings too.
	const [paused, setPaused] = useInterfaceSetting(
		port,
		"paused",
		settings.paused
	);
	const [tab, setTab] = useState<OrderTab>("all");
	const [fulfillerId, setFulfillerId] = useState<string | null>(null);
	const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [createPick, setCreatePick] = useState<string | null>(null);
	const [hoveredOrderId, setHoveredOrderId] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const size = useElementSize(stageRef);
	// Narrow stages stack the clipboard under the floor instead of beside it.
	const narrow = size.width > 0 && size.width < NARROW_BELOW;
	const headingRef = useRef<HTMLHeadingElement>(null);
	const floorId = useId();
	// A view change asked for by the keyboard moves focus with it: into the
	// panel heading when a panel opens, and back to whatever opened it (the
	// order's row, or Create order) when the panel closes again.
	const moveFocus = useRef(false);
	const returnTo = useRef<string | null>(null);

	const actsView = useActs(snapshot);
	const { acts, enabled: actsOn, nowMs, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const hudHeadingRef = useRef<HTMLHeadingElement>(null);
	// With acts, a thread's stage follows its agent's act: stopped only while
	// its blocker counts, shipped only once its reply is read and nothing waits.
	const threadActs = useMemo(
		() => (actsOn ? orderActs(snapshot, acts) : undefined),
		[acts, actsOn, snapshot]
	);
	const orders = useMemo(
		() => (loading ? [] : buildOrders(snapshot, now, threadActs)),
		[loading, now, snapshot, threadActs]
	);
	const pickers = useMemo(
		() => (loading ? [] : buildPickers(snapshot.agents, orders)),
		[loading, orders, snapshot.agents]
	);
	const placement = useMemo(() => placeOrders(orders), [orders]);
	const themeNight = useGameNight(rootRef);
	const night = warehouseNight(settings.shift, themeNight);
	const isoView = useIsoView();
	const art = warehouseArt(night);
	const agentIds = useMemo(
		() => snapshot.agents.map((agent) => agent.id),
		[snapshot.agents]
	);
	const { looks } = useVillagerLooks(agentIds, night);
	const shape = useMemo(
		() =>
			islandFor(
				WAREHOUSE_BOUNDS.maxX - WAREHOUSE_BOUNDS.minX,
				WAREHOUSE_BOUNDS.maxZ - WAREHOUSE_BOUNDS.minZ,
				TILE * 2.4
			),
		[]
	);
	const stats = useMemo(() => floorStats(orders, now), [now, orders]);
	const fulfiller = snapshot.agents.find((agent) => agent.id === fulfillerId);
	const activeFulfillerId = fulfiller ? fulfiller.id : null;
	const counts = useMemo(
		() => tabCounts(orders, activeFulfillerId),
		[activeFulfillerId, orders]
	);
	const fadedIds = useMemo(
		() =>
			new Set(
				activeFulfillerId
					? orders
							.filter((order) => order.agent?.id !== activeFulfillerId)
							.map((order) => order.id)
					: []
			),
		[activeFulfillerId, orders]
	);
	const visibleOrders = useMemo(
		() => filterOrders(orders, tab, activeFulfillerId),
		[activeFulfillerId, orders, tab]
	);
	const loadByAgent = useMemo(() => {
		const load = new Map<string, number>();
		for (const order of orders) {
			if (order.agent && order.stage !== "shipped") {
				load.set(order.agent.id, (load.get(order.agent.id) ?? 0) + 1);
			}
		}
		return load;
	}, [orders]);

	// The fulfiller a new order goes to: the one picked in the form, else the
	// active fulfiller filter, else the first picker on shift.
	const createAgentId =
		snapshot.agents.find((agent) => agent.id === createPick)?.id ??
		activeFulfillerId ??
		snapshot.agents[0]?.id;
	const threadOpen = threadView !== null;
	const selectedOrder = orders.find((order) => order.id === selectedOrderId);
	const openOrder = activeThreadId
		? orders.find((order) => order.id === activeThreadId)
		: undefined;
	let view: PanelView = "list";
	if (threadOpen) {
		view = "thread";
	} else if (creating) {
		view = "create";
	} else if (selectedOrder) {
		view = "detail";
	}
	const highlightedOrderId =
		view === "thread" ? (openOrder?.id ?? null) : (selectedOrder?.id ?? null);
	const viewKey = `${view}:${highlightedOrderId ?? ""}`;

	useLayoutEffect(() => {
		if (!moveFocus.current) {
			return;
		}
		moveFocus.current = false;
		if (!viewKey.startsWith("list")) {
			headingRef.current?.focus();
			return;
		}
		const root = rootRef.current;
		const target = returnTo.current;
		const row =
			target && target !== CREATE_TARGET
				? root?.querySelector<HTMLElement>(
						`[data-order-row="${CSS.escape(target)}"]`
					)
				: null;
		(
			row ??
			root?.querySelector<HTMLElement>('button[aria-label="Create order"]')
		)?.focus();
	}, [viewKey]);

	const showList = () => {
		if (threadOpen) {
			port.closeThread();
		}
		setCreating(false);
		setSelectedOrderId(null);
	};
	/** Close the panel from inside it (back button, Escape). */
	const backToList = () => {
		moveFocus.current = true;
		showList();
	};
	const selectOrder = (orderId: string) => {
		if (threadOpen && orderId !== activeThreadId) {
			port.closeThread();
		}
		moveFocus.current = true;
		returnTo.current = orderId;
		setCreating(false);
		setSelectedOrderId(orderId);
	};
	const fulfil = () => {
		if (!selectedOrder) {
			return;
		}
		moveFocus.current = true;
		returnTo.current = selectedOrder.id;
		port.openThread(selectedOrder.id);
	};
	const backFromThread = () => {
		moveFocus.current = true;
		returnTo.current = activeThreadId;
		setSelectedOrderId(activeThreadId);
		port.closeThread();
	};
	const startCreate = () => {
		if (threadOpen) {
			port.closeThread();
		}
		moveFocus.current = true;
		returnTo.current = CREATE_TARGET;
		setSelectedOrderId(null);
		setCreatePick(null);
		setCreating(true);
	};
	const submitOrder = ({
		agentId,
		prompt,
	}: {
		agentId?: string;
		prompt: string;
	}) => {
		moveFocus.current = true;
		setCreating(false);
		port.startThread(agentId ? { agentId, prompt } : { prompt });
	};
	const togglePicker = (agentId: string) => {
		showList();
		setFulfillerId((current) => (current === agentId ? null : agentId));
	};
	const pickTab = (next: OrderTab) => {
		showList();
		setTab(next);
	};

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			!escapeIsFree(event.target)
		) {
			return;
		}
		if (view === "thread") {
			backFromThread();
		} else if (view === "detail" || view === "create") {
			backToList();
		} else if (fulfillerId) {
			setFulfillerId(null);
		} else {
			return;
		}
		event.preventDefault();
	};

	const wide = view === "thread";
	const pickerCount = snapshot.agents.length;
	let panel: ReactNode;
	if (view === "thread") {
		panel = (
			<OrderConversation
				agents={snapshot.agents}
				headingRef={headingRef}
				now={now}
				onBack={backFromThread}
				order={openOrder}
				threadView={threadView}
			/>
		);
	} else if (view === "create") {
		panel = (
			<CreateOrder
				agentId={createAgentId}
				agents={snapshot.agents}
				headingRef={headingRef}
				loadByAgent={loadByAgent}
				onBack={backToList}
				onPick={setCreatePick}
				onSubmit={submitOrder}
			/>
		);
	} else if (view === "detail" && selectedOrder) {
		panel = (
			<OrderDetail
				agents={snapshot.agents}
				headingRef={headingRef}
				now={now}
				onBack={backToList}
				onFulfil={fulfil}
				order={selectedOrder}
			/>
		);
	} else {
		panel = (
			<OrdersList
				counts={counts}
				fulfiller={fulfiller}
				hoveredOrderId={hoveredOrderId}
				loading={loading}
				now={now}
				onClearFulfiller={() => setFulfillerId(null)}
				onCreate={startCreate}
				onHover={setHoveredOrderId}
				onSelect={selectOrder}
				onTab={setTab}
				orders={visibleOrders}
				selectedOrderId={selectedOrderId}
				shownOrders={counts.all}
				tab={tab}
				totalOrders={orders.length}
			/>
		);
	}

	const floorAgentId =
		view === "create" ? (createAgentId ?? null) : activeFulfillerId;
	const panelWidth = wide ? 560 : 440;
	const panelCover = narrow ? 0 : Math.min(panelWidth, size.width * 0.42) + 24;
	const compact = size.width - panelCover < 720;
	// With the act layer a narrow floor keeps more room for its cues.
	const clipboardShare = actsOn ? 0.4 : 0.56;
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: hudHeadingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const totals = actTotals(snapshot, acts);
	const stations = useMemo(() => pickerStations(pickers), [pickers]);
	const { offStage, onStage } = useMemo(
		() =>
			floorAgents(
				acts,
				snapshot.agents.map((agent) => agent.id)
			),
		[acts, snapshot.agents]
	);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				onStage.map((act) => act.agentId)
			),
		[acts, onStage, unowned]
	);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const cageLit = blockerEntries(snapshot, acts).length > 0;
	// The floor's own width: the clipboard covers the rest.
	const budget = overlayBudget(Math.max(0, size.width - panelCover), {
		domTargets: true,
	});
	const shownKey = [
		...budget.fill([
			...actOverlays(
				onStage,
				slots,
				offStage,
				onStage.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced: reduceMotion }
			).filter((item) => keepsActOverlay(item, kitSettings)),
			// The cage's reason tag competes last, after every picker's words.
			...(cageLit ? [{ id: CAGE_REASON_ID, kind: "text" as const }] : []),
		]),
	]
		.sort()
		.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const actPaths = useMemo(
		() => warehouseActPaths(stations, budget.narrow),
		[budget.narrow, stations]
	);
	const openAsk = cards.openAsk;
	const pickerCast = useMemo(
		() =>
			actPickers({
				acts,
				looks,
				nowMs,
				onAsk: (askId) => openAsk(askId),
				paths: actPaths,
				reduced: reduceMotion,
				shown,
				slots: slots.slots,
				stations,
			}),
		[
			acts,
			actPaths,
			looks,
			nowMs,
			openAsk,
			reduceMotion,
			shown,
			slots,
			stations,
		]
	);
	// A shelf label says what its picker is working on: off with work bubbles.
	const shelvesOn = !budget.narrow && kitSettings.workBubbles;
	const shelves = useMemo(
		() =>
			shelvesOn ? shelfLabels(stations, acts, snapshot.threads, shown) : [],
		[acts, shelvesOn, shown, snapshot.threads, stations]
	);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const actors: WarehouseActors | undefined = actsOn
		? {
				iconOnly: budget.iconOnly,
				paths: actPaths,
				pickers: pickerCast,
				props: (
					<WarehouseActProps
						acts={acts}
						clock={clock}
						iconOnly={budget.iconOnly}
						narrow={budget.narrow}
						nowMs={nowMs}
						offStage={offStage}
						onAsk={(askId) => cards.openAsk(askId)}
						onBlocker={(threadId, agentName) =>
							cards.openBlocker(threadId, agentName)
						}
						onQueue={() => openQueue(queueOpener)}
						onStage={onStage}
						owners={owners}
						reduced={reduceMotion}
						shown={shown}
						slots={slots}
						snapshot={snapshot}
						stations={stations}
					/>
				),
				cageLit,
				cageReason: cageReason(snapshot, acts, {
					iconOnly: budget.iconOnly,
					shown,
				}),
				shelves,
			}
		: undefined;
	const titlePlate = (
		<GameTitlePlate
			compact={compact}
			icon={<Warehouse strokeWidth={2.25} />}
			keepStatus={actsOn}
			status={
				actsOn && !loading ? (
					actSummaryLine(totals)
				) : (
					<>
						<span className="dark:hidden">Day shift</span>
						<span className="hidden dark:inline">Night shift</span>
						{loading ? null : ` · ${plural(pickerCount, "picker")}`}
					</>
				)
			}
			title="Warehouse"
		/>
	);
	const hud = (
		<div
			className="absolute top-0 left-0"
			style={{
				bottom: narrow ? `${clipboardShare * 100}%` : 0,
				right: panelCover,
			}}
		>
			<GameHudSlot
				at="top-left"
				className={actsOn ? "right-0 flex-wrap" : "right-0"}
			>
				{actsOn ? (
					<div className="flex min-w-0 flex-col items-start gap-2">
						{titlePlate}
						<div className="flex flex-wrap items-center gap-2">
							<NeedYouButton
								onAsk={onAsk}
								snapshot={snapshot}
								totals={totals}
							/>
							<QueueButton
								acts={acts}
								clock={clock}
								narrow={budget.narrow}
								nowMs={nowMs}
								onAsk={onAsk}
								onBlocker={onBlocker}
								openRef={queueOpener}
								snapshot={snapshot}
								totals={totals}
								unowned={unowned}
							/>
						</div>
						<BlindSpotCaption snapshot={snapshot} />
					</div>
				) : (
					titlePlate
				)}
				<div className="ms-auto flex items-start gap-2">
					{reduceMotion || loading ? null : (
						<span className="pointer-events-auto mt-1">
							<GameIconButton
								label={paused ? "Resume" : "Pause"}
								onClick={() => setPaused((value) => !value)}
								title={paused ? "Resume the floor" : "Pause the floor"}
							>
								{paused ? (
									<Play
										aria-hidden="true"
										className="size-5"
										strokeWidth={2.5}
									/>
								) : (
									<Pause
										aria-hidden="true"
										className="size-5"
										strokeWidth={2.5}
									/>
								)}
								<span className="sr-only">{paused ? "Resume" : "Pause"}</span>
							</GameIconButton>
						</span>
					)}
					<GameAction
						compact={compact}
						disabled={loading}
						icon={<Plus strokeWidth={2.75} />}
						label="Create order"
						onClick={startCreate}
					/>
				</div>
			</GameHudSlot>
			{narrow ? null : (
				<GameHudSlot at="bottom-left">
					<StatsStrip
						activeTab={tab}
						compact={compact}
						loading={loading}
						onPick={pickTab}
						stats={stats}
					/>
				</GameHudSlot>
			)}
			{narrow || loading ? null : (
				<GameHudSlot at="bottom-right">
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</div>
	);

	return (
		<WarehouseActsContext.Provider value={actsOn}>
			<GameShell
				accent="sun"
				busy={loading}
				data-warehouse-scene=""
				hud={hud}
				label="Warehouse floor"
				onKeyDown={onRootKeyDown}
				rootRef={rootRef}
				testId="interface-warehouse"
			>
				<style>{WAREHOUSE_SCENE_CSS}</style>
				{/* Focus lands here when an ask or blocker card closes on nothing. */}
				<h1
					className="sr-only"
					ref={hudHeadingRef}
					tabIndex={actsOn ? -1 : undefined}
				>
					Warehouse
				</h1>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0"
					ref={stageRef}
				/>
				<div className="absolute inset-0">
					<div className="absolute inset-0" id={floorId}>
						{loading || !actsOn ? null : (
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
						)}
						{loading ? null : (
							<IsoStage
								animate={!paused}
								bounds={{ ...WAREHOUSE_BOUNDS, top: 2.7 }}
								fallback={
									<WarehouseList
										acts={
											actsOn
												? {
														sentence: (agentId) =>
															acts.get(agentId)?.ariaLabel ?? null,
														status: (agentId) => {
															const act = acts.get(agentId);
															return act ? (
																<ActStatus
																	act={act}
																	clock={clock}
																	nowMs={nowMs}
																	onAsk={onAsk}
																	onBlocker={onBlocker}
																	snapshot={snapshot}
																/>
															) : null;
														},
													}
												: undefined
										}
										fadedIds={fadedIds}
										onPickTab={pickTab}
										onSelectOrder={selectOrder}
										onSelectPicker={togglePicker}
										orders={orders}
										pickers={pickers}
										selectedAgentId={floorAgentId}
										selectedOrderId={highlightedOrderId}
									/>
								}
								fill={actsOn && wide ? OPEN_FILL : 1.1}
								insets={{
									bottom: narrow ? size.height * clipboardShare + 8 : 88,
									left: 16,
									// Room for the queue's bubbles, which hang up and to the right
									// of the plates at the yard's edge.
									right: 16 + panelCover + (actsOn && !narrow ? 64 : 0),
									top: (narrow ? 64 : 88) + (actsOn ? 96 : 0),
								}}
								label="Warehouse diorama: pickers in their aisles and an order box per conversation. Tab or the arrow keys move between pickers and zones; drag to pan, plus and minus to zoom."
								night={night}
								reducedMotion={reduceMotion}
								view={isoView}
							>
								{({ quality, theme }) => (
									<WarehouseDioramaScene
										actors={actors}
										art={art}
										fadedIds={fadedIds}
										looks={looks}
										night={night}
										onPickTab={pickTab}
										onSelectPicker={togglePicker}
										orders={orders}
										pickers={pickers}
										placement={placement}
										quality={quality}
										reducedMotion={reduceMotion}
										running={!paused}
										selectedAgentId={floorAgentId}
										selectedOrder={orders.find(
											(order) => order.id === highlightedOrderId
										)}
										shape={shape}
										theme={theme}
									/>
								)}
							</IsoStage>
						)}
						{!loading && snapshot.agents.length === 0 ? (
							<p className="absolute inset-x-0 bottom-24 flex justify-center">
								<span className="rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-4 py-1.5 font-semibold text-(--gk-ink) text-[14px]">
									No pickers on shift. Agents you add work an aisle here.
								</span>
							</p>
						) : null}
					</div>
					<div
						className={cn(
							"absolute z-30",
							narrow
								? cn(
										"inset-x-2 bottom-2",
										actsOn ? "h-[calc(40%-12px)]" : "h-[calc(56%-12px)]"
									)
								: "inset-y-3 right-3"
						)}
						style={narrow ? undefined : { width: panelCover - 24 }}
					>
						<Clipboard label="Orders" view={view}>
							<motion.div
								animate={{ opacity: 1 }}
								className="flex min-h-0 flex-1 flex-col"
								initial={reduceMotion ? false : { opacity: 0 }}
								key={viewKey}
								transition={{
									duration: reduceMotion ? 0 : 0.16,
									ease: "easeOut",
								}}
							>
								{panel}
							</motion.div>
						</Clipboard>
					</div>
				</div>
				{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
				{cards.element}
			</GameShell>
		</WarehouseActsContext.Provider>
	);
}
