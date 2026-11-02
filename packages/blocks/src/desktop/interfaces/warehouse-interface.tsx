import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { GameShell } from "./game-shell.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import { useGameNight, useIsoView } from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import { ActAnnouncer, AskQueueList } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";
import { orderActs } from "./warehouse-acts.tsx";
import { useWarehouseActs } from "./warehouse-interface-acts.tsx";
import { WarehouseFloor } from "./warehouse-interface-floor.tsx";
import {
	CREATE_TARGET,
	escapeIsFree,
	useClock,
	useElementSize,
	useViewFocus,
} from "./warehouse-interface-hooks.ts";
import { WarehouseHud } from "./warehouse-interface-hud.tsx";
import {
	type PanelView,
	WarehousePanel,
} from "./warehouse-interface-panel.tsx";
import {
	buildOrders,
	buildPickers,
	filterOrders,
	floorStats,
	type OrderTab,
	placeOrders,
	tabCounts,
} from "./warehouse-model.ts";
import { WAREHOUSE_SCENE_CSS, warehouseArt } from "./warehouse-palette.ts";
import { Clipboard, WarehouseActsContext } from "./warehouse-parts.tsx";

/** Below this stage width the clipboard sits under the floor. */
const NARROW_BELOW = 900;

/**
 * The floor's fill beside an open thread (the clipboard widens to 560, so
 * the floor narrows): a closer look, so its plates keep their spacing.
 */
const OPEN_FILL = 1.3;

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
	const tl = useLiteralMessages();
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

	useViewFocus({ headingRef, moveFocus, returnTo, rootRef, viewKey });

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
	const floorAgentId =
		view === "create" ? (createAgentId ?? null) : activeFulfillerId;
	const panelWidth = wide ? 560 : 440;
	const panelCover = narrow ? 0 : Math.min(panelWidth, size.width * 0.42) + 24;
	const compact = size.width - panelCover < 720;
	// With the act layer a narrow floor keeps more room for its cues.
	const clipboardShare = actsOn ? 0.4 : 0.56;
	const warehouseActs = useWarehouseActs({
		actsView,
		clock,
		floorWidth: size.width - panelCover,
		headingRef: hudHeadingRef,
		kitSettings,
		looks,
		pickers,
		port,
		reduceMotion,
		snapshot,
		tl,
	});
	const { cards, onAsk, onBlocker } = warehouseActs;
	const hud = (
		<WarehouseHud
			acts={acts}
			actsOn={actsOn}
			clipboardShare={clipboardShare}
			clock={clock}
			compact={compact}
			isoView={isoView}
			loading={loading}
			narrow={narrow}
			nowMs={nowMs}
			onCreate={startCreate}
			onPickTab={pickTab}
			onTogglePaused={() => setPaused((value) => !value)}
			panelCover={panelCover}
			paused={paused}
			reduceMotion={reduceMotion}
			snapshot={snapshot}
			stats={stats}
			tab={tab}
			unowned={unowned}
			warehouseActs={warehouseActs}
		/>
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
							<WarehouseFloor
								actors={warehouseActs.actors}
								art={art}
								fadedIds={fadedIds}
								fill={actsOn && wide ? OPEN_FILL : 1.1}
								highlightedOrderId={highlightedOrderId}
								insets={{
									bottom: narrow ? size.height * clipboardShare + 8 : 88,
									left: 16,
									// Room for the queue's bubbles, which hang up and to the right
									// of the plates at the yard's edge.
									right: 16 + panelCover + (actsOn && !narrow ? 64 : 0),
									top: (narrow ? 64 : 88) + (actsOn ? 96 : 0),
								}}
								isoView={isoView}
								listActs={warehouseActs.listActs}
								looks={looks}
								night={night}
								onPickTab={pickTab}
								onSelectOrder={selectOrder}
								onSelectPicker={togglePicker}
								orders={orders}
								paused={paused}
								pickers={pickers}
								placement={placement}
								reduceMotion={reduceMotion}
								selectedAgentId={floorAgentId}
							/>
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
								: "inset-y-3 end-3"
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
								<WarehousePanel
									agents={snapshot.agents}
									counts={counts}
									createAgentId={createAgentId}
									fulfiller={fulfiller}
									headingRef={headingRef}
									hoveredOrderId={hoveredOrderId}
									loadByAgent={loadByAgent}
									loading={loading}
									now={now}
									onBack={backToList}
									onBackFromThread={backFromThread}
									onClearFulfiller={() => setFulfillerId(null)}
									onCreate={startCreate}
									onFulfil={fulfil}
									onHover={setHoveredOrderId}
									onPick={setCreatePick}
									onSelect={selectOrder}
									onSubmit={submitOrder}
									onTab={setTab}
									openOrder={openOrder}
									selectedOrder={selectedOrder}
									selectedOrderId={selectedOrderId}
									tab={tab}
									threadView={threadView}
									totalOrders={orders.length}
									view={view}
									visibleOrders={visibleOrders}
								/>
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
