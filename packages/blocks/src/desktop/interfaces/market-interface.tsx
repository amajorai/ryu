import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { GAME_PLATE, GameAction } from "./game-hud.tsx";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import {
	actSummaryLine,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	IsoStage,
	useGameNight,
	useIsoView,
	useReducedMotion,
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
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	actKeepers,
	actOrderStatuses,
	actShops,
	keeperStations,
	keeperWords,
	MarketActProps,
	marketActPaths,
	marketShownOverlays,
	shopNeedYou,
	shopSign,
	upcomingRuns,
	worksLive,
} from "./market-acts.tsx";
import {
	customerId,
	type MarketActors,
	MarketDioramaScene,
} from "./market-diorama.tsx";
import { useElementSize } from "./market-hooks.ts";
import { MarketStreetHud, STREET_NAME } from "./market-hud.tsx";
import { MarketList } from "./market-list.tsx";
import {
	ACT_EAST_SPACING,
	ACT_KEEPER_SPACING,
	ACT_KEEPER_SPACING_NARROW,
	ACT_MIN_SQUARE,
	ACT_MIN_SQUARE_NARROW,
	buildMarket,
	layoutMarket,
	marketTotals,
	newOrderInput,
	plural,
	shopForThread,
	shopState,
} from "./market-model.ts";
import { MARKET_SCENE_CSS, marketArt } from "./market-palette.ts";
import { MarketPanel, type MarketPanelView } from "./market-panel.tsx";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

/**
 * Escape inside a text field belongs to the field, except in the order
 * composer while it is empty: there it closes the shop.
 */
function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	const editable =
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !==
			null;
	if (!editable) {
		return true;
	}
	return (
		target instanceof HTMLTextAreaElement &&
		target.closest("[data-market-composer]") !== null &&
		target.value.trim() === ""
	);
}

const STAGE_FALLBACK = { height: 808, width: 1200 };
/**
 * World units of sea framed past the act street's +x end (down the screen)
 * while a sheet is open beside the stage.
 */
const OPEN_SEA = 8;
/**
 * With acts on a phone the street turns so its long back row runs down the
 * screen (the kit allows about 20 degrees off its 45).
 */
/** On a phone the back row starts nearer the corner (no bubbles there). */
const ACT_BACK_INSET_NARROW = 0.9;
const ACT_PORTRAIT_YAW = Math.PI / 4 + 0.35;
/** Lawn around the block for trees and the shore. */
const ISLAND_RIM = 1.6;

/** The Market's own settings, resolved from its live params. */
export function marketSettings(
	params: InterfaceParamsByRenderer["market"] | undefined
): Required<InterfaceParamsByRenderer["market"]> {
	return resolveInterfaceParams("market", params) as Required<
		InterfaceParamsByRenderer["market"]
	>;
}

/**
 * Market: the workspace as a cosy market square on an island, built
 * on the 3D game kit. Each project is a shop and each team a striped stall
 * (agents in neither share the general store); the agents are their
 * shopkeepers, out front, posed by their orders, and a queue of customers
 * waits at a shop for every conversation that needs you. A shop's sign (or
 * the directory) opens its sheet: its shopkeepers, its cork order board and
 * the order composer. Serving an order opens the host's own conversation
 * in the sheet; placing an order starts a thread with a shopkeeper there.
 */
export function MarketInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["market"]>) {
	const { awnings, bunting } = marketSettings(params);
	const kitSettings = useGameKitSettings();
	const reduced = useReducedMotion();
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const size = useElementSize(stageRef, STAGE_FALLBACK);
	const night = useGameNight(rootRef);
	const isoView = useIsoView();
	const shops = useMemo(
		() => (loading ? [] : buildMarket(snapshot)),
		[loading, snapshot]
	);
	const totals = useMemo(() => marketTotals(shops), [shops]);
	const actsView = useActs(snapshot);
	const { acts, enabled: actsOn, nowMs, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	// The act layout: each agent keeps one shop, every keeper has a station,
	// and a shop's customers are its upcoming runs.
	// Keyed by who keeps which shop: the acts map is new every tick, and the
	// street's layout must not be rebuilt each second.
	const keepersKey = actsOn
		? actShops(shops, acts)
				.map((kept) => `${kept.id}:${kept.agents.map((agent) => agent.id)}`)
				.join("\n")
		: "";
	const keptShops = useMemo(
		() => (actsOn ? actShops(shops, acts) : shops),
		[actsOn, keepersKey, shops]
	);
	const needYou = useMemo(
		() => shopNeedYou(keptShops, acts),
		[acts, keptShops]
	);
	// What the HUD, directory, list and sheet show for each shop: with acts,
	// what waits on you and whether it is busy come from its keepers' acts,
	// never from the orders' statuses.
	const viewShops = useMemo(
		() =>
			actsOn
				? shops.map((item) => {
						const kept = keptShops.find((shop) => shop.id === item.id);
						const sign = kept ? shopSign(kept, acts) : "Open";
						return {
							...item,
							busy: sign === "Busy",
							sign,
							waitingOnYou: needYou.get(item.id) ?? 0,
						};
					})
				: shops,
		[acts, actsOn, keptShops, needYou, shops]
	);
	const orderStatuses = useMemo(
		() => actOrderStatuses(snapshot, acts),
		[acts, snapshot]
	);
	const runs = useMemo(
		() => upcomingRuns(keptShops, snapshot.events),
		[keptShops, snapshot.events]
	);
	// The overlay budget's breakpoint also picks the keepers' spacing.
	const narrowStage = overlayBudget(size.width, { domTargets: true }).narrow;
	const block = useMemo(
		() =>
			actsOn
				? layoutMarket(keptShops, {
						queue: new Map(
							[...runs].map(([id, events]) => [id, events.length])
						),
						backInset: narrowStage ? ACT_BACK_INSET_NARROW : undefined,
						eastSpacing: narrowStage
							? ACT_KEEPER_SPACING_NARROW
							: ACT_EAST_SPACING,
						spacing: narrowStage
							? ACT_KEEPER_SPACING_NARROW
							: ACT_KEEPER_SPACING,
						square: narrowStage ? ACT_MIN_SQUARE_NARROW : ACT_MIN_SQUARE,
					})
				: layoutMarket(shops),
		[actsOn, keptShops, narrowStage, runs, shops]
	);
	// On a phone the frame holds the whole island, act street and all, with
	// no zoom on to the plates (they run the street's whole length, so every
	// marker and plate stays inside the gutters).
	const portrait = useMemo(
		() => ({
			// A little lawn more on the screen-right (−z at this yaw), so the
			// back row's last alarms hang inside the right gutter.
			bounds: { ...block.bounds, minZ: block.bounds.minZ - 1.2, top: 3.2 },
			fill: 1,
			yaw: ACT_PORTRAIT_YAW,
		}),
		[block]
	);
	const shape = useMemo(
		() =>
			islandFor(
				block.bounds.maxX - block.bounds.minX,
				block.bounds.maxZ - block.bounds.minZ,
				ISLAND_RIM
			),
		[block]
	);
	const art = useMemo(() => marketArt(night, awnings), [awnings, night]);
	const agentIds = useMemo(
		() => snapshot.agents.map((agent) => agent.id),
		[snapshot.agents]
	);
	const { looks } = useVillagerLooks(agentIds, night);
	const customerIds = useMemo(
		() =>
			actsOn
				? block.lots.flatMap((lot) =>
						(runs.get(lot.shop.id) ?? [])
							.slice(0, lot.queue.length)
							.map((event) => customerId(event.id))
					)
				: block.lots.flatMap((lot) =>
						lot.shop.orders
							.filter(
								(order) =>
									order.status === "attention" || order.status === "your-turn"
							)
							.slice(0, lot.queue.length)
							.map((order) => customerId(order.thread.id))
					),
		[actsOn, block, runs]
	);
	const { looks: customerLooks } = useVillagerLooks(customerIds, night);

	const [shopId, setShopId] = useState<string | null>(
		() => shopForThread(shops, activeThreadId)?.id ?? null
	);
	const [composerAgentId, setComposerAgentId] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const hudHeadingRef = useRef<HTMLHeadingElement>(null);
	const panelHeadingRef = useRef<HTMLHeadingElement>(null);
	const focusTarget = useRef<"composer" | "hud" | "panel" | null>(null);

	// Opening a thread from anywhere (a new order, the host) opens the shop
	// it belongs to, so the sheet's way back leads to its own counter.
	const [syncedThreadId, setSyncedThreadId] = useState(activeThreadId);
	if (syncedThreadId !== activeThreadId) {
		setSyncedThreadId(activeThreadId);
		const owner = shopForThread(shops, activeThreadId);
		if (owner && owner.id !== shopId) {
			setShopId(owner.id);
		}
	}

	const shop = viewShops.find((item) => item.id === shopId);
	const threadOpen = threadView !== null;
	const activeOrder = activeThreadId
		? shops
				.flatMap((item) => item.orders)
				.find((order) => order.thread.id === activeThreadId)
		: undefined;
	let view: MarketPanelView | null = null;
	if (threadOpen) {
		view = { kind: "thread", order: activeOrder, shop };
	} else if (shop) {
		view = { kind: "shop", shop };
	}
	const viewKey = view
		? `${view.kind}:${shop?.id ?? ""}:${threadOpen ? (activeThreadId ?? "new") : ""}:${composerAgentId ?? ""}`
		: "street";

	useLayoutEffect(() => {
		const target = focusTarget.current;
		if (!(target && viewKey)) {
			return;
		}
		focusTarget.current = null;
		if (target === "composer") {
			rootRef.current
				?.querySelector<HTMLTextAreaElement>("[data-market-composer] textarea")
				?.focus();
		} else if (target === "panel") {
			panelHeadingRef.current?.focus();
		} else {
			hudHeadingRef.current?.focus();
		}
	}, [viewKey]);

	const openShop = (id: string) => {
		if (threadOpen) {
			port.closeThread();
		}
		const next = shops.find((item) => item.id === id);
		setShopId(id);
		setComposerAgentId(null);
		focusTarget.current = "panel";
		setAnnouncement(next ? `Inside ${next.name}` : "");
	};
	const openKeeper = (id: string, agentId: string) => {
		if (threadOpen) {
			port.closeThread();
		}
		setShopId(id);
		setComposerAgentId(agentId);
		focusTarget.current = "composer";
	};
	const leave = () => {
		if (threadOpen) {
			port.closeThread();
		}
		setShopId(null);
		setComposerAgentId(null);
		focusTarget.current = "hud";
		setAnnouncement(`Back on ${STREET_NAME}`);
	};
	const serve = (threadId: string) => {
		focusTarget.current = "panel";
		port.openThread(threadId);
	};
	const closeOrder = () => {
		port.closeThread();
		focusTarget.current = shop ? "panel" : "hud";
	};
	const placeOrder = (agentId: string | undefined, prompt: string) => {
		if (!shop) {
			return;
		}
		focusTarget.current = "panel";
		port.startThread(newOrderInput(shop, agentId, prompt));
	};

	/** Escape closes the open order (back to its shop), then the shop. */
	const stepBack = (): boolean => {
		if (threadOpen) {
			closeOrder();
			return true;
		}
		if (shop) {
			leave();
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

	const cover = view ? gameSheetCover(size.width) : 0;
	// On a narrow stage the sheet covers everything: nothing to reframe.
	const sheetCover = cover < size.width ? cover : 0;
	const compact = size.width - sheetCover < 720;
	const insets = useMemo(
		() => ({
			bottom: compact ? 72 : 96,
			left: 16,
			right: 16 + sheetCover,
			// The act HUD adds a row of buttons and the blind-spot caption.
			top: (compact ? 64 : 92) + (actsOn ? 84 : 0),
		}),
		[actsOn, compact, sheetCover]
	);
	// Beside an open sheet the stage is short of room on the right: framing
	// more sea past the street's +x end lifts the back row up the stage, so
	// its last keeper's alarms hang right of it above the zoom buttons
	// instead of being pushed back on to each other. Wide and phone stages
	// (no sheet beside them) keep the plain bounds.
	const stageBounds = useMemo(
		() => ({
			...block.bounds,
			maxX: block.bounds.maxX + (actsOn && sheetCover > 0 ? OPEN_SEA : 0),
			top: 3.2,
		}),
		[actsOn, block, sheetCover]
	);
	const empty = !loading && shops.length === 0;
	const now = Date.now();
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: hudHeadingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const actTotalsNow = actTotals(snapshot, acts);
	const stations = useMemo(() => keeperStations(block), [block]);
	const actPaths = useMemo(
		() => marketActPaths(block, stations, narrowStage),
		[block, narrowStage, stations]
	);
	const { offStage, onStage } = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const home = useMemo(
		() => new Map(stations.map((station) => [station.agentId, station.shopId])),
		[stations]
	);
	const { budget, shown: shownNow } = marketShownOverlays({
		kit: kitSettings,
		offStage,
		onStage,
		reduced,
		slots,
		width: size.width,
	});
	const shownKey = [...shownNow].sort().join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const openAsk = cards.openAsk;
	const keeperCast = useMemo(
		() =>
			actKeepers({
				acts,
				looks,
				nowMs,
				onAsk: (askId) => openAsk(askId),
				paths: actPaths,
				reduced,
				shown,
				slots: slots.slots,
				stations,
			}),
		[acts, actPaths, looks, nowMs, openAsk, reduced, shown, slots, stations]
	);
	const customerCast = useMemo(
		() =>
			block.lots.flatMap((lot) =>
				(runs.get(lot.shop.id) ?? [])
					.slice(0, lot.queue.length)
					.flatMap((event, index) => {
						const id = customerId(event.id);
						const base = customerLooks.get(id);
						const position = lot.queue[index];
						if (!(base && position)) {
							return [];
						}
						return [
							{
								facing:
									lot.facing === "south" ? -Math.PI / 2 + 0.45 : Math.PI - 0.45,
								id,
								label: `An upcoming run at ${lot.shop.name}: ${event.title}`,
								looks: base,
								name: "",
								pose: "waiting" as const,
								position,
							},
						];
					})
			),
		[block, customerLooks, runs]
	);
	const actors: MarketActors | undefined = actsOn
		? {
				busy: new Map(viewShops.map((item) => [item.id, item.busy])),
				signs: new Map(viewShops.map((item) => [item.id, shopState(item)])),
				customers: customerCast,
				iconOnly: budget.iconOnly,
				keepers: keeperCast,
				needYou,
				paths: actPaths,
				props: (
					<MarketActProps
						acts={acts}
						block={block}
						clock={clock}
						iconOnly={budget.iconOnly}
						nowMs={nowMs}
						offStage={offStage}
						onAsk={(askId) => cards.openAsk(askId)}
						onBlocker={(threadId, agentName) =>
							cards.openBlocker(threadId, agentName)
						}
						onQueue={() => openQueue(queueOpener)}
						onStage={onStage}
						owners={owners}
						reduced={reduced}
						shown={shown}
						slots={slots}
						snapshot={snapshot}
						stations={stations}
					/>
				),
			}
		: undefined;
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const summary = actsOn
		? `${STREET_NAME}: ${plural(totals.shops, "shop")}, ${actSummaryLine(actTotalsNow)}.`
		: `${STREET_NAME}: ${plural(totals.shops, "shop")}, ${plural(totals.orders, "order")}, ${totals.waitingOnYou} waiting on you, ${totals.busy} busy.`;

	return (
		<GameShell
			accent="sun"
			busy={loading}
			data-market-scene=""
			data-motion={reduced ? "reduce" : "full"}
			hud={
				<MarketStreetHud
					acts={
						actsOn
							? {
									actions: (
										<>
											<NeedYouButton
												onAsk={onAsk}
												snapshot={snapshot}
												totals={actTotalsNow}
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
												totals={actTotalsNow}
												unowned={unowned}
											/>
										</>
									),
									caption: <BlindSpotCaption snapshot={snapshot} />,
									summary: actSummaryLine(actTotalsNow),
									totals: actTotalsNow,
								}
							: undefined
					}
					compact={compact}
					loading={loading}
					onEnter={openShop}
					shops={viewShops}
					totals={totals}
					view={isoView}
				/>
			}
			label={STREET_NAME}
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			sheet={
				view ? (
					<MarketPanel
						activeThreadId={threadOpen ? activeThreadId : null}
						acts={
							actsOn
								? {
										busy: (id) =>
											viewShops.find((item) => item.id === id)?.busy ?? false,
										statuses: orderStatuses,
										sign: (id) =>
											viewShops.find((item) => item.id === id)?.sign ?? "Open",
										needYou: (id) => needYou.get(id) ?? 0,
										keeper: (agentId) => {
											const act = acts.get(agentId);
											return {
												working: worksLive(act),
												words: keeperWords(act),
											};
										},
									}
								: undefined
						}
						composerAgentId={composerAgentId}
						headingRef={panelHeadingRef}
						now={now}
						onBack={closeOrder}
						onClose={leave}
						onCloseOrder={closeOrder}
						onPickKeeper={(agentId) => {
							setComposerAgentId(agentId);
							focusTarget.current = "composer";
						}}
						onPlaceOrder={placeOrder}
						onServe={serve}
						reduceMotion={reduced}
						snapshot={snapshot}
						threadView={threadView}
						view={view}
					/>
				) : null
			}
			testId="interface-market"
		>
			<style>{MARKET_SCENE_CSS}</style>
			<h1 className="sr-only" ref={hudHeadingRef} tabIndex={-1}>
				{STREET_NAME}
			</h1>
			<div className="absolute inset-0" ref={stageRef}>
				{loading ? null : (
					<>
						<p className="sr-only">{summary}</p>
						{actsOn ? (
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
							bounds={stageBounds}
							fallback={
								<MarketList
									acts={
										actsOn
											? {
													home,
													needYou,
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
									onOpenKeeper={openKeeper}
									onOpenShop={openShop}
									selectedShopId={shop?.id ?? null}
									shops={viewShops}
								/>
							}
							fill={1.25}
							insets={insets}
							label={
								actsOn
									? "Market street diorama: a shop per project, a stall per team, and the queue of asks at the market cross. Tab or the arrow keys move between shop signs, shopkeepers and what waits on you; drag to pan, plus and minus to zoom."
									: "Market street diorama: a shop per project, a stall per team. Tab or the arrow keys move between shop signs and shopkeepers; drag to pan, plus and minus to zoom."
							}
							night={night}
							portrait={actsOn ? portrait : undefined}
							reducedMotion={reduced}
							view={isoView}
						>
							{({ quality, theme }) => (
								<MarketDioramaScene
									actors={actors}
									art={art}
									block={block}
									bunting={bunting}
									customerLooks={customerLooks}
									looks={looks}
									night={night}
									onOpenKeeper={openKeeper}
									onOpenShop={openShop}
									quality={quality}
									reducedMotion={reduced}
									selectedShopId={shop?.id ?? null}
									shape={shape}
									theme={theme}
								/>
							)}
						</IsoStage>
					</>
				)}
				{empty ? (
					<div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
						<div
							className={`${GAME_PLATE} pointer-events-auto flex max-w-sm flex-col items-start gap-4 p-5`}
						>
							<div className="flex flex-col gap-1.5">
								<h2 className="gk-display text-(--gk-ink) text-[22px] leading-7">
									No shops on this street yet
								</h2>
								<p className="text-pretty font-medium text-(--gk-ink-muted) text-[15px] leading-6">
									Projects open here as shops and teams as market stalls.
								</p>
							</div>
							<GameAction
								icon={<Plus strokeWidth={2.75} />}
								label="Start a conversation"
								onClick={() => port.startThread({})}
							/>
						</div>
					</div>
				) : null}
			</div>
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
			{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
			{cards.element}
		</GameShell>
	);
}
