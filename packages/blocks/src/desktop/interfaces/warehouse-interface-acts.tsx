import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	ClockOptions,
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { type RefObject, useMemo, useRef } from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	actOverlays,
	actTotals,
	blockerEntries,
	overlayBudget,
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
import {
	actPickers,
	CAGE_REASON_ID,
	cageReason,
	floorAgents,
	pickerStations,
	shelfLabels,
	WarehouseActProps,
	warehouseActPaths,
} from "./warehouse-acts.tsx";
import type { WarehouseActors } from "./warehouse-diorama.tsx";
import type { Picker } from "./warehouse-model.ts";

/**
 * The Warehouse's act layer wiring: the ask cards, the HUD totals, which
 * overlays the floor's budget shows, the pickers as act villagers, and what
 * the diorama and the no-WebGL list read from the acts. Split out of
 * `warehouse-interface.tsx`.
 */

interface WarehouseActsOptions {
	actsView: ReturnType<typeof useActs>;
	clock: ClockOptions | undefined;
	/** The floor's own width: the clipboard covers the rest. */
	floorWidth: number;
	headingRef: RefObject<HTMLHeadingElement | null>;
	kitSettings: ReturnType<typeof useGameKitSettings>;
	looks: ReturnType<typeof useVillagerLooks>["looks"];
	pickers: Picker[];
	port: InterfacePort;
	reduceMotion: boolean;
	snapshot: InterfaceSnapshot;
	tl: LiteralMessage;
}

export function useWarehouseActs({
	actsView,
	clock,
	floorWidth,
	headingRef,
	kitSettings,
	looks,
	pickers,
	port,
	reduceMotion,
	snapshot,
	tl,
}: WarehouseActsOptions) {
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
	const budget = overlayBudget(Math.max(0, floorWidth), {
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
				tl,
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
			tl,
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
	/** The no-WebGL list's picker rows, described by their acts. */
	const listActs = actsOn
		? {
				sentence: (agentId: string) => acts.get(agentId)?.ariaLabel ?? null,
				status: (agentId: string) => {
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
		: undefined;
	return {
		actors,
		budget,
		cards,
		listActs,
		onAsk,
		onBlocker,
		queueOpener,
		totals,
	};
}

export type WarehouseActs = ReturnType<typeof useWarehouseActs>;
