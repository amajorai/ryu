import type {
	ClockOptions,
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { type RefObject, useMemo, useRef } from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	cardOverlays,
	cardPaths,
	seatHelpers,
	seatPose,
} from "./card-table-acts.tsx";
import { CardActProps } from "./card-table-acts-props.tsx";
import type { CardRoomActors } from "./card-table-diorama.tsx";
import { actSeatTone, type SeatInfo } from "./card-table-model.ts";
import { roomSeats } from "./card-table-room.ts";
import {
	actTotals,
	overlayBudget,
	type stageAgents,
	toolForActivity,
	youSpotSlots,
} from "./game3d-acts.ts";
import type { useGameKitSettings } from "./game3d-settings.tsx";
import type { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActStatus,
	askOwners,
	openQueue,
	useActCards,
} from "./interface-ask-card.tsx";
import type { useActs } from "./use-acts.ts";

/**
 * The Card Table's act layer wiring: the ask cards, the HUD totals, which
 * overlays the budget shows, and what each seat, the rail and the 3D room
 * read from the acts. Split out of `card-table-interface.tsx`.
 */

type ActsView = ReturnType<typeof useActs>;

interface CardTableActsOptions {
	actsView: ActsView;
	clock: ClockOptions | undefined;
	dealer: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
	kitSettings: ReturnType<typeof useGameKitSettings>;
	looks: ReturnType<typeof useVillagerLooks>["looks"];
	port: InterfacePort;
	reduceMotion: boolean;
	seated: readonly SeatInfo[];
	snapshot: InterfaceSnapshot;
	staged: ReturnType<typeof stageAgents>;
	stageWidth: number;
}

export function useCardTableActs({
	actsView,
	clock,
	dealer,
	headingRef,
	kitSettings,
	looks,
	port,
	reduceMotion,
	seated,
	snapshot,
	staged,
	stageWidth,
}: CardTableActsOptions) {
	const { acts, enabled: actsOn, nowMs, unowned } = actsView;
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: headingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const totals = actTotals(snapshot, acts);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				staged.onStage.map((act) => act.agentId)
			),
		[acts, staged, unowned]
	);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(stageWidth, { domTargets: true });
	const shownKey = [
		...budget.fill(
			cardOverlays(staged.onStage, slots, staged.offStage, reduceMotion).filter(
				(item) => keepsActOverlay(item, kitSettings)
			)
		),
	]
		.sort()
		.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const roomPlaces = useMemo(() => roomSeats(), []);
	const actPaths = useMemo(
		() => cardPaths(roomPlaces, budget.narrow),
		[budget.narrow, roomPlaces]
	);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const actStatus = (agentId: string) => {
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
	};
	/** A seat's act: its plate's words and what activating it does. */
	const seatAct = (agentId: string, scene: boolean) => {
		const act = acts.get(agentId);
		if (!(actsOn && act)) {
			return undefined;
		}
		const ask = act.act === "asking" ? act.ask : null;
		return {
			answer: ask
				? (opener: HTMLElement) => cards.openAsk(ask.id, opener)
				: null,
			iconOnly: scene && budget.iconOnly,
			scene,
			sentence: act.ariaLabel,
			status: scene ? undefined : actStatus(agentId),
			tone: actSeatTone(act),
		};
	};
	const tone = (agentId: string) => {
		const act = acts.get(agentId);
		return act ? actSeatTone(act) : "idle";
	};
	const railActs = actsOn
		? {
				answer: (agentId: string) => {
					const ask = acts.get(agentId)?.ask;
					return acts.get(agentId)?.act === "asking" && ask
						? (opener: HTMLElement) => cards.openAsk(ask.id, opener)
						: null;
				},
				sentence: (agentId: string) => acts.get(agentId)?.ariaLabel ?? null,
				status: actStatus,
				tone,
			}
		: undefined;
	const spreadActs = railActs
		? {
				act: (agentId: string) => acts.get(agentId),
				answer: railActs.answer,
				status: actStatus,
				tone,
			}
		: undefined;
	const roomActors: CardRoomActors | undefined = actsOn
		? {
				helpers: seated.flatMap((seat, slot) => {
					const act = acts.get(seat.agent.id);
					const look = looks.get(seat.agent.id);
					const place = roomPlaces[slot];
					return act && look && place ? seatHelpers(act, look, place) : [];
				}),
				poses: new Map(
					seated.flatMap((seat) => {
						const act = acts.get(seat.agent.id);
						return act
							? [
									[
										seat.agent.id,
										{
											pose: seatPose(act),
											tool:
												act.act === "working"
													? toolForActivity(act.carry)
													: undefined,
										},
									] as const,
								]
							: [];
					})
				),
				props: (
					<CardActProps
						clock={clock}
						dealer={dealer}
						iconOnly={budget.iconOnly}
						narrow={budget.narrow}
						nowMs={nowMs}
						offStage={staged.offStage}
						onAsk={(askId, opener) => cards.openAsk(askId, opener)}
						onBlocker={(threadId, agentName) =>
							cards.openBlocker(threadId, agentName)
						}
						onQueue={() => openQueue(queueOpener)}
						onStage={staged.onStage}
						owners={owners}
						paths={actPaths}
						reduced={reduceMotion}
						seated={seated.flatMap((seat, slot) => {
							const act = acts.get(seat.agent.id);
							const place = roomPlaces[slot];
							return act && place ? [{ act, seat: place }] : [];
						})}
						shown={shown}
						slots={slots}
						snapshot={snapshot}
					/>
				),
			}
		: undefined;
	return {
		budget,
		cards,
		onAsk,
		onBlocker,
		queueOpener,
		railActs,
		roomActors,
		seatAct,
		shown,
		spreadActs,
		totals,
	};
}

export type CardTableActs = ReturnType<typeof useCardTableActs>;
