import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { type RefObject, useMemo } from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	actOverlays,
	blockerEntries,
	overlayBudget,
	youSpotSlots,
} from "./game3d-acts.ts";
import type { GameKitSettings } from "./game3d-settings.tsx";
import type { useVillagerLooks } from "./game3d-villager.tsx";
import { askOwners, openQueue, useActCards } from "./interface-ask-card.tsx";
import {
	actVillagers,
	boardAgents,
	SeasonActProps,
	seasonActPaths,
	seasonStations,
} from "./seasonal-acts.tsx";
import type { SeasonActors } from "./seasonal-diorama.tsx";
import type { Season, SeasonBoard } from "./seasonal-model.ts";
import type { SeasonWorld } from "./seasonal-world.ts";
import type { ActsView, useActClockOptions } from "./use-acts.ts";

/** What the board's act layer needs. */
export interface SeasonalActorsArgs {
	acts: ActsView["acts"];
	actsOn: boolean;
	board: SeasonBoard;
	clock: ReturnType<typeof useActClockOptions>;
	headingRef: RefObject<HTMLElement | null>;
	kitSettings: GameKitSettings;
	looks: ReturnType<typeof useVillagerLooks>["looks"];
	nowMs: number;
	port: InterfacePort;
	queueOpener: RefObject<(() => void) | null>;
	reduceMotion: boolean;
	season: Season;
	sheetCover: number;
	snapshot: InterfaceSnapshot;
	stageWidth: number;
	unowned: ActsView["unowned"];
	world: SeasonWorld;
}

/**
 * The board's act layer: the ask and blocker cards, the overlay budget, and
 * the cast at their stations (`actors`, undefined without acts).
 */
export function useSeasonalActors({
	acts,
	actsOn,
	board,
	clock,
	headingRef,
	kitSettings,
	looks,
	nowMs,
	port,
	queueOpener,
	reduceMotion,
	season,
	sheetCover,
	snapshot,
	stageWidth,
	unowned,
	world,
}: SeasonalActorsArgs) {
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: headingRef,
		nowMs,
		port,
		snapshot,
	});

	// The diorama's own width: an open sheet covers the rest.
	const budget = overlayBudget(Math.max(0, stageWidth - sheetCover), {
		domTargets: true,
	});
	const narrow = budget.iconOnly;
	const stations = useMemo(
		() =>
			actsOn ? seasonStations(season, world, board.doors, acts, narrow) : [],
		[acts, actsOn, board.doors, narrow, season, world]
	);
	const { offStage, onStage } = useMemo(
		() => boardAgents(acts, stations),
		[acts, stations]
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
	const shownKey = [
		...budget.fill(
			actOverlays(
				onStage,
				slots,
				offStage,
				onStage.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced: reduceMotion }
			).filter(
				// On a phone only the focus agent's work bubble shows: the
				// others' words stay in their rows (as under reduced motion).
				(item) =>
					!(budget.iconOnly && item.kind === "work-bubble" && !item.focus) &&
					keepsActOverlay(item, kitSettings)
			)
		),
	]
		.sort()
		.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const actPaths = useMemo(
		() => seasonActPaths(season, stations),
		[season, stations]
	);
	const openAsk = cards.openAsk;
	const cast = useMemo(
		() =>
			actVillagers({
				acts,
				looks,
				nowMs,
				onAsk: (askId) => openAsk(askId),
				paths: actPaths,
				reduced: reduceMotion,
				season,
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
			season,
			shown,
			slots,
			stations,
		]
	);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const stoppedPlaces = actsOn
		? blockerEntries(snapshot, acts).flatMap((entry) => {
				const number = board.doors.find(
					(door) => door.thread?.id === entry.threadId
				)?.number;
				const place = world.doors.find((item) => item.number === number);
				return place ? [place] : [];
			})
		: [];
	const actors: SeasonActors | undefined = actsOn
		? {
				doorOf: new Map(
					stations.map((station) => [station.agentId, station.number])
				),
				iconOnly: budget.iconOnly,
				paths: actPaths,
				props: (
					<SeasonActProps
						acts={acts}
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
						reduced={reduceMotion}
						season={season}
						shown={shown}
						slots={slots}
						snapshot={snapshot}
						stations={stations}
						stopped={stoppedPlaces}
					/>
				),
				villagers: cast,
			}
		: undefined;
	return { actors, budget, cards, onAsk, onBlocker };
}
