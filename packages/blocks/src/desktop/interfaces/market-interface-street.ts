import {
	type InterfaceParamsByRenderer,
	type InterfaceSnapshot,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import { overlayBudget } from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	actOrderStatuses,
	actShops,
	shopNeedYou,
	shopSign,
	upcomingRuns,
} from "./market-acts.tsx";
import { customerId } from "./market-diorama.tsx";
import {
	ACT_EAST_SPACING,
	ACT_KEEPER_SPACING,
	ACT_KEEPER_SPACING_NARROW,
	ACT_MIN_SQUARE,
	ACT_MIN_SQUARE_NARROW,
	buildMarket,
	layoutMarket,
	marketTotals,
} from "./market-model.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

export const STAGE_FALLBACK = { height: 808, width: 1200 };
/**
 * World units of sea framed past the act street's +x end (down the screen)
 * while a sheet is open beside the stage.
 */
export const OPEN_SEA = 8;
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
 * The street's shops and, with acts, who keeps which shop, what waits on
 * you, the block layout and the villagers' looks.
 */
export function useMarketStreet({
	loading,
	night,
	snapshot,
	width,
}: {
	loading: boolean;
	night: boolean;
	snapshot: InterfaceSnapshot;
	width: number;
}) {
	const size = { width };
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
	return {
		acts,
		actsOn,
		actsView,
		block,
		clock,
		customerLooks,
		keptShops,
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
	};
}
