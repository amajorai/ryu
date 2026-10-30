import { useMemo, useRef } from "react";
import {
	actOverlays,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import type { MemberLooks } from "./game3d-villager.tsx";
import {
	askOwners,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { kitchenActVillagers, kitchenPaths } from "./kitchen-acts.tsx";
import { type KitchenActScene, SLAB } from "./kitchen-diorama.tsx";
import {
	actTickets,
	floorCentreZ,
	type KitchenService,
} from "./kitchen-model.ts";
import {
	type ActsView,
	useActAnnouncement,
	useActClockOptions,
} from "./use-acts.ts";

/**
 * The act layer (when the host sends asks): what each chef acts out, the
 * queue at the pass, the cards, the HUD summary and the announcer.
 */
export function useKitchenActLayer({
	actsView,
	looks,
	narrow,
	port,
	reduced,
	service,
	snapshot,
	stageSize,
}: {
	actsView: ActsView;
	looks: ReadonlyMap<string, MemberLooks>;
	narrow: boolean;
	port: InterfaceRendererProps<unknown>["port"];
	reduced: boolean;
	service: KitchenService;
	snapshot: InterfaceRendererProps<unknown>["snapshot"];
	stageSize: { height: number; width: number } | null;
}) {
	const fallbackRef = useRef<HTMLHeadingElement>(null);
	const { acts, nowMs, privacy, unowned } = actsView;
	const actsOn = actsView.enabled;
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
	const queueOpener = useRef<(() => void) | null>(null);
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const tally = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(stageSize?.width ?? 1280, { domTargets: true });
	// Urgency order (the kit's stage order): the budget keeps what matters.
	const staged = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const cast = staged.onStage;
	// A phone has no room beside the plates for a work bubble (it stands
	// wider than its plate and would run off the stage): the station board
	// and the act sentence carry the step there.
	const phone = budget.iconOnly;
	const shownKey = [
		...budget.fill(
			actOverlays(
				cast,
				slots,
				{ count: 0 },
				cast.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced }
			)
		),
	]
		.filter((id) => !(phone && id.startsWith("work:")))
		.sort()
		.join("|");
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const centreZ = floorCentreZ(service.floor);
	const paths = useMemo(
		() => kitchenPaths(service, centreZ, SLAB),
		[centreZ, service]
	);
	const { openAsk, openBlocker } = cards;
	const actVillagers = useMemo(
		() =>
			actsOn
				? kitchenActVillagers({
						acts,
						centreZ,
						looks,
						nowMs,
						onAsk: (askId) => openAsk(askId),
						paths,
						reduced,
						service,
						shown,
						slab: SLAB,
						slots: slots.slots,
					})
				: [],
		[
			acts,
			actsOn,
			centreZ,
			looks,
			nowMs,
			openAsk,
			paths,
			reduced,
			service,
			shown,
			slots.slots,
		]
	);
	const actScene: KitchenActScene | null = actsOn
		? {
				acts,
				handlers: {
					clock,
					iconOnly: budget.iconOnly,
					nowMs,
					onAsk: (askId) => openAsk(askId),
					onBlocker: (threadId, agentName) => openBlocker(threadId, agentName),
					onQueue: () => openQueue(queueOpener),
					privacy,
					reduced,
					shown,
					snapshot,
				},
				offStage: staged.offStage,
				onStage: cast,
				owners,
				paths,
				slots,
				villagers: actVillagers,
			}
		: null;
	const ticketActs = useMemo(
		() => (actsOn ? actTickets(snapshot, acts, nowMs) : null),
		[acts, actsOn, nowMs, snapshot]
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
				narrow={narrow}
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
	return {
		actButtons,
		actScene,
		acts,
		actsOn,
		cards,
		clock,
		fallbackRef,
		nowMs,
		onAsk,
		onBlocker,
		sentence,
		tally,
		ticketActs,
		unowned,
	};
}
