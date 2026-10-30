import type {
	InterfaceParamsByRenderer,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { useMemo, useRef } from "react";
import {
	actOverlays,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import {
	askOwners,
	openQueue,
	type useActCards,
} from "./interface-ask-card.tsx";
import type { useActClockOptions, useActs } from "./use-acts.ts";
import type { WorkersActScene } from "./workers-diorama.tsx";

type ActsView = ReturnType<typeof useActs>;
type ActCards = ReturnType<typeof useActCards>;

/**
 * The workers' act layer: the queue at your door, the overlays shown within
 * the stage's budget, and the scene the diorama acts out.
 */
export function useWorkersActScene({
	acts,
	actsOn,
	clock,
	nowMs,
	openAsk,
	openBlocker,
	params,
	privacy,
	reduced,
	snapshot,
	unowned,
	width,
}: {
	acts: ActsView["acts"];
	actsOn: boolean;
	clock: ReturnType<typeof useActClockOptions>;
	nowMs: ActsView["nowMs"];
	openAsk: ActCards["openAsk"];
	openBlocker: ActCards["openBlocker"];
	params: InterfaceParamsByRenderer["workers"] | undefined;
	privacy: ActsView["privacy"];
	reduced: boolean;
	snapshot: InterfaceSnapshot;
	unowned: ActsView["unowned"];
	width: number;
}) {
	const queueOpener = useRef<(() => void) | null>(null);
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const tally = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(width, { domTargets: true });
	const staged = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const cast = staged.onStage;
	const shownKey = [
		...budget.fill(
			actOverlays(
				cast,
				slots,
				staged.offStage,
				cast.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced }
			)
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
	const actScene: WorkersActScene | null = actsOn
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
				onAsk: (askId) => openAsk(askId),
				onStage: cast,
				owners,
				screenWords: params?.screenWords ?? "step",
				slots,
			}
		: null;
	return { actScene, onAsk, onBlocker, queueOpener, tally };
}
