import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { useMemo, useRef } from "react";
import type { Creature } from "./aquarium-model.ts";
import type { AquariumTankActs, CreatureListActs } from "./aquarium-tank.tsx";
import {
	actOverlays,
	actTotals,
	isRedBlocker,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { askOwners, useActCards } from "./interface-ask-card.tsx";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

interface AquariumActsInput {
	creatures: Creature[];
	loading: boolean;
	port: InterfacePort;
	reduceMotion: boolean;
	rootWidth: number;
	snapshot: InterfaceSnapshot;
}

export type AquariumActsLayer = ReturnType<typeof useAquariumActs>;

/**
 * The act layer (when the host sends asks): the creatures swim to their
 * acts, the props sit on the sand and at the front glass (pointer targets
 * only), and the list and the queue carry the keyboard (spec §5 aquarium).
 */
export function useAquariumActs({
	creatures,
	loading,
	port,
	reduceMotion,
	rootWidth,
	snapshot,
}: AquariumActsInput) {
	const fallbackRef = useRef<HTMLHeadingElement>(null);
	const actsView = useActs(snapshot);
	const { acts, nowMs, privacy, unowned } = actsView;
	const actsOn = actsView.enabled && !loading;
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
	const { openAsk, openBlocker } = cards;
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const tally = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const staged = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const budget = overlayBudget(rootWidth || 1280, { domTargets: false });
	const phone = rootWidth > 0 && rootWidth < 640;
	const shownKey = [
		...budget.fill(
			actOverlays(
				staged.onStage,
				slots,
				staged.offStage,
				staged.onStage.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced: reduceMotion }
				// A phone's tank has no room beside the plates for a bubble (asks
				// get none there already): the plates and the list carry it.
			).filter((item) => !(phone && /^(work|done|wait):/.test(item.id)))
		),
	]
		.sort()
		.join("|");
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const onAsk = (askId: string, opener?: HTMLElement) => openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => openBlocker(threadId, agentName, opener);
	const queueOpener = useRef<(() => void) | null>(null);
	const onAskRef = useRef(onAsk);
	onAskRef.current = onAsk;
	const onBlockerRef = useRef(onBlocker);
	onBlockerRef.current = onBlocker;
	const tankActs = useMemo(
		(): AquariumTankActs | null =>
			actsOn
				? {
						acts,
						handlers: {
							clock,
							iconOnly: budget.iconOnly,
							nowMs,
							onAsk: (askId) => onAskRef.current(askId),
							onBlocker: (threadId, agentName) =>
								onBlockerRef.current(threadId, agentName),
							onQueue: () => queueOpener.current?.(),
							privacy,
							reduced: reduceMotion,
							shown,
							snapshot,
						},
						offStage: staged.offStage,
						onStage: staged.onStage,
						owners,
						slots,
					}
				: null,
		[
			acts,
			actsOn,
			budget.iconOnly,
			clock,
			nowMs,
			owners,
			privacy,
			reduceMotion,
			shown,
			slots,
			snapshot,
			staged,
		]
	);
	// With acts the creatures' own signs follow the acts, not the threads:
	// bubbles and the high, quick loop only while working; a pearl only when
	// a run stopped. Keyed on what changed, so a ticking clock rebuilds
	// nothing.
	const actSignature = actsOn
		? [...acts.values()]
				.map(
					(act) =>
						`${act.agentId}:${act.act === "blocked" && act.blockers.some((blocker) => isRedBlocker(blocker)) ? "failed" : act.act}`
				)
				.sort()
				.join("|")
		: "";
	const sceneCreatures = useMemo(() => {
		if (!actSignature) {
			return creatures;
		}
		const byId = new Map(
			actSignature.split("|").map((entry) => {
				const [id = "", state = ""] = entry.split(":");
				return [id, state] as const;
			})
		);
		return creatures.map((creature) => {
			const state = byId.get(creature.id);
			return state
				? {
						...creature,
						// A pearl means a failed run (an interrupted one has none).
						pearl: state === "failed",
						working: state === "working",
					}
				: creature;
		});
	}, [actSignature, creatures]);
	const listActs: CreatureListActs | null = actsOn
		? { acts, clock, nowMs, onAsk, onBlocker, snapshot }
		: null;
	return {
		acts,
		actsOn,
		cards,
		clock,
		fallbackRef,
		listActs,
		nowMs,
		onAsk,
		onBlocker,
		phone,
		queueOpener,
		sceneCreatures,
		sentence,
		tally,
		tankActs,
		unowned,
	};
}
