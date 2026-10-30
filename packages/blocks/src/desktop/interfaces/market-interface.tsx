import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import { actSummaryLine } from "./game3d-acts.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	IsoStage,
	useGameNight,
	useIsoView,
	useReducedMotion,
} from "./game3d-stage.tsx";
import {
	ActAnnouncer,
	ActStatus,
	AskQueueList,
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { keeperWords, worksLive } from "./market-acts.tsx";
import { MarketDioramaScene } from "./market-diorama.tsx";
import { useElementSize } from "./market-hooks.ts";
import { MarketStreetHud, STREET_NAME } from "./market-hud.tsx";
import { useMarketActCast } from "./market-interface-cast.tsx";
import { MarketEmptyState } from "./market-interface-empty.tsx";
import { useMarketEscape } from "./market-interface-escape.ts";
import {
	marketSettings,
	OPEN_SEA,
	STAGE_FALLBACK,
	useMarketStreet,
} from "./market-interface-street.ts";
import { MarketList } from "./market-list.tsx";
import { newOrderInput, plural, shopForThread } from "./market-model.ts";
import { MARKET_SCENE_CSS, marketArt } from "./market-palette.ts";
import { MarketPanel, type MarketPanelView } from "./market-panel.tsx";

export { marketSettings } from "./market-interface-street.ts";

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
	const tl = useLiteralMessages();
	const {
		acts,
		actsOn,
		block,
		clock,
		customerLooks,
		looks,
		narrowStage,
		needYou,
		nowMs,
		orderStatuses,
		portrait,
		runs,
		sentence,
		shape,
		shops,
		totals,
		unowned,
		viewShops,
	} = useMarketStreet({ loading, night, snapshot, width: size.width });
	const art = useMemo(() => marketArt(night, awnings), [awnings, night]);

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
		setAnnouncement(tl("Back on {street}", { street: STREET_NAME }));
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
	const onRootKeyDown = useMarketEscape(rootRef, stepBack);

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
	const { actors, actTotalsNow, budget, home, queueOpener } = useMarketActCast({
		acts,
		actsOn,
		block,
		cards,
		clock,
		customerLooks,
		kitSettings,
		looks,
		narrowStage,
		needYou,
		nowMs,
		reduced,
		runs,
		size,
		snapshot,
		tl,
		unowned,
		viewShops,
	});
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const summary = actsOn
		? `${STREET_NAME}: ${plural(totals.shops, "shop")}, ${actSummaryLine(actTotalsNow)}.`
		: tl(
				"{street}: {shopCount, plural, one {{shops} shop} other {{shops} shops}}, {orderCount, plural, one {{orders} order} other {{orders} orders}}, {waitingOnYou} waiting on you, {busy} busy.",
				{
					busy: String(totals.busy),
					orderCount: totals.orders,
					orders: String(totals.orders),
					shopCount: totals.shops,
					shops: String(totals.shops),
					street: STREET_NAME,
					waitingOnYou: String(totals.waitingOnYou),
				}
			);

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
					<MarketEmptyState onStart={() => port.startThread({})} />
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
