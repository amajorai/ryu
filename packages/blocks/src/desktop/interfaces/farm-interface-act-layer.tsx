import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { type RefObject, useMemo, useRef } from "react";
import { benchOf, farmActVillagers, farmPaths } from "./farm-acts.tsx";
import type { FarmActScene } from "./farm-diorama.tsx";
import type { ElementSize } from "./farm-hooks.ts";
import type { FarmDiorama } from "./farm-model.ts";
import {
	actOverlays,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import {
	askOwners,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import type { ActsView, useActClockOptions } from "./use-acts.ts";

export interface FarmActLayerInput {
	acts: ActsView["acts"];
	actsOn: boolean;
	clock: ReturnType<typeof useActClockOptions>;
	compact: boolean;
	diorama: FarmDiorama;
	hudHeadingRef: RefObject<HTMLHeadingElement | null>;
	looks: Parameters<typeof farmActVillagers>[0]["looks"];
	nowMs: number;
	port: InterfaceRendererProps<unknown>["port"];
	privacy: ActsView["privacy"];
	queueOn: boolean;
	reduced: boolean;
	size: ElementSize;
	snapshot: InterfaceSnapshot;
	unowned: ActsView["unowned"];
}

/**
 * The farm's act layer: the ask cards, the overlays that fit the stage,
 * the farmers acting out their asks, and the Need you / Queue buttons.
 */
export function useFarmActLayer({
	acts,
	actsOn,
	clock,
	compact,
	diorama,
	hudHeadingRef,
	looks,
	nowMs,
	port,
	privacy,
	queueOn,
	reduced,
	size,
	snapshot,
	unowned,
}: FarmActLayerInput) {
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: hudHeadingRef,
		nowMs,
		port,
		snapshot,
	});
	const { openAsk, openBlocker } = cards;
	const queueOpener = useRef<(() => void) | null>(null);
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const tally = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(size.width, { domTargets: true });
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
		// A phone has no room beside the plates for a work bubble (it stands
		// wider than its plate): the bed's board and act sentence carry it.
		.filter((id) => !(budget.iconOnly && id.startsWith("work:")))
		.sort()
		.join("|");
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const paths = useMemo(() => farmPaths(diorama), [diorama]);
	const benches = useMemo(() => benchOf(diorama, acts), [acts, diorama]);
	const actVillagers = useMemo(
		() =>
			actsOn
				? farmActVillagers({
						acts,
						benches,
						diorama,
						looks,
						nowMs,
						onAsk: (askId) => openAsk(askId),
						paths,
						reduced,
						shown,
						slots: slots.slots,
					})
				: [],
		[
			acts,
			actsOn,
			benches,
			diorama,
			looks,
			nowMs,
			openAsk,
			paths,
			reduced,
			shown,
			slots,
		]
	);
	const actScene: FarmActScene | null = actsOn
		? {
				acts,
				benches,
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
	const onAsk = (askId: string, opener?: HTMLElement) => openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => openBlocker(threadId, agentName, opener);
	const actButtons = queueOn ? (
		<>
			{actsOn ? (
				<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={tally} />
			) : null}
			<QueueButton
				acts={acts}
				clock={clock}
				narrow={compact}
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
	return { actButtons, actScene, cards, onAsk, onBlocker, tally };
}
