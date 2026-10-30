import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { useMemo, useRef } from "react";
import {
	actBubble,
	actOverlays,
	actTotals,
	bubbleOverlayId,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import type { LifeBubble } from "./game3d-life.ts";
import type { GameKitSettings } from "./game3d-settings.tsx";
import {
	askOwners,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	actTown,
	actTownKey,
	TownActProps,
	townActAnchors,
	townActEntries,
} from "./town-acts.tsx";
import { MINIMAL_DROPS } from "./town-interface-layout.tsx";
import type { Town } from "./town-model.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

type TownProps = InterfaceRendererProps<InterfaceParamsByRenderer["town"]>;

/** The town's act layer, its overlays and its queue buttons. */
export function useTownActLayer({
	hudWidth,
	kit,
	loading,
	narrowStage,
	port,
	reduced,
	snapshot,
	town,
}: {
	hudWidth: number;
	kit: GameKitSettings;
	loading: TownProps["loading"];
	narrowStage: boolean;
	port: TownProps["port"];
	reduced: boolean;
	snapshot: TownProps["snapshot"];
	town: Town;
}) {
	// The act layer (when the host sends asks): the townsfolk act out their
	// acts, the act props join the DOM layer, the queue waits at City Hall.
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
	const queueOpener = useRef<(() => void) | null>(null);
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const tally = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(hudWidth, { domTargets: true });
	const cast = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY).onStage,
		[acts]
	);
	// Bubbles hang on the building tags and queue plates; a phone keeps no
	// work bubble (it would run off the stage beside its tag). The kit game
	// settings apply here too, as town draws these overlays itself: no work
	// bubbles when they are off, and only limit and cue lines when minimal.
	const shownKey = [
		...budget.fill(
			actOverlays(
				cast,
				slots,
				{ count: 0 },
				cast.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced }
			).filter(
				(item) =>
					!(
						((budget.iconOnly || !kit.workBubbles) &&
							item.id.startsWith("work:")) ||
						(kit.overlayDensity === "minimal" &&
							MINIMAL_DROPS.some((prefix) => item.id.startsWith(prefix)))
					)
			)
		),
	]
		.sort()
		.join("|");
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const bubbles = useMemo(() => {
		const kept = new Map<string, LifeBubble>();
		for (const act of acts.values()) {
			const id = bubbleOverlayId(act);
			const bubble = id && shown.has(id) ? actBubble(act) : null;
			if (bubble) {
				kept.set(act.agentId, bubble);
			}
		}
		return kept;
	}, [acts, shown]);
	// An asking villager's bubble rides its queue plate, not its building.
	const queued = useMemo(
		() =>
			new Set(
				slots.slots
					.filter((slot) => slot.carrier === "villager")
					.map((slot) => slot.agentId ?? "")
			),
		[slots.slots]
	);
	const tagBubbles = useMemo(
		() => new Map([...bubbles].filter(([id]) => !queued.has(id))),
		[bubbles, queued]
	);
	const actEntries = useMemo(
		() =>
			actsOn
				? townActEntries({
						acts,
						bubbles,
						clock,
						nowMs,
						overflow: slots.overflow,
						owners,
						shown,
						slots: slots.slots,
						snapshot,
						town,
					})
				: [],
		[acts, actsOn, bubbles, clock, nowMs, owners, shown, slots, snapshot, town]
	);
	const actAnchors = useMemo(() => townActAnchors(actEntries), [actEntries]);
	// With acts the buildings' art (crane, beacon, bubble) follows the acts,
	// rebuilt only when what it reads changes (not on every clock tick).
	const latestActs = useRef(acts);
	latestActs.current = acts;
	const townKey = actsOn ? actTownKey(acts) : "";
	const sceneTown = useMemo(
		() => (townKey ? actTown(town, latestActs.current) : town),
		[townKey, town]
	);
	const actScene = useMemo(
		() =>
			actsOn ? { acts, anchors: actAnchors, clock, slots: slots.slots } : null,
		[actAnchors, acts, actsOn, clock, slots.slots]
	);
	const onAsk = (askId: string, opener?: HTMLElement) => openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => openBlocker(threadId, agentName, opener);
	const actButtons = actsOn ? (
		<>
			<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={tally} />
			<QueueButton
				acts={acts}
				clock={clock}
				narrow={narrowStage}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				openRef={queueOpener}
				snapshot={snapshot}
				totals={tally}
				unowned={unowned}
			/>
		</>
	) : null;
	const overlayActLayer = actsOn
		? {
				acts,
				bubbles: tagBubbles,
				needYou: tally.needYou,
				onAsk: (askId: string) => openAsk(askId),
				props: (
					<TownActProps
						entries={actEntries}
						handlers={{
							clock,
							iconOnly: budget.iconOnly,
							nowMs,
							onAsk: (askId) => openAsk(askId),
							onBlocker: (threadId, agentName) =>
								openBlocker(threadId, agentName),
							onQueue: () => openQueue(queueOpener),
							privacy,
							snapshot,
						}}
					/>
				),
			}
		: null;
	return {
		actButtons,
		acts,
		actScene,
		actsOn,
		cards,
		clock,
		fallbackRef,
		nowMs,
		onAsk,
		onBlocker,
		openAsk,
		overlayActLayer,
		sceneTown,
		sentence,
		tally,
		unowned,
	};
}
