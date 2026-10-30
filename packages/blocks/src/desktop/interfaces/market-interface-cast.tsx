import type { LiteralMessage } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { useMemo, useRef } from "react";
import { actTotals, stageAgents, youSpotSlots } from "./game3d-acts.ts";
import type { GameKitSettings } from "./game3d-settings.tsx";
import type { useVillagerLooks } from "./game3d-villager.tsx";
import {
	askOwners,
	openQueue,
	type useActCards,
} from "./interface-ask-card.tsx";
import {
	actKeepers,
	keeperStations,
	MarketActProps,
	marketActPaths,
	marketShownOverlays,
} from "./market-acts.tsx";
import { customerId, type MarketActors } from "./market-diorama.tsx";
import type { useMarketStreet } from "./market-interface-street.ts";
import { shopState } from "./market-model.ts";

type MarketStreet = ReturnType<typeof useMarketStreet>;

/**
 * The act cast on the street: each keeper at a station, the customers
 * queueing for upcoming runs, and the props around the market cross.
 */
export function useMarketActCast({
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
}: Pick<
	MarketStreet,
	| "acts"
	| "actsOn"
	| "block"
	| "clock"
	| "customerLooks"
	| "narrowStage"
	| "needYou"
	| "nowMs"
	| "runs"
	| "unowned"
	| "viewShops"
> & {
	cards: ReturnType<typeof useActCards>;
	kitSettings: GameKitSettings;
	looks: ReturnType<typeof useVillagerLooks>["looks"];
	reduced: boolean;
	size: { width: number };
	snapshot: InterfaceSnapshot;
	tl: LiteralMessage;
}) {
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
								label: tl("An upcoming run at {name}: {title}", {
									name: lot.shop.name,
									title: event.title,
								}),
								looks: base,
								name: "",
								pose: "waiting" as const,
								position,
							},
						];
					})
			),
		[block, customerLooks, runs, tl]
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
	return { actors, actTotalsNow, budget, home, queueOpener };
}
