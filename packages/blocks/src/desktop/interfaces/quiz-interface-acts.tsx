import type {
	InterfaceAgentAct,
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { type RefObject, useMemo } from "react";
import { keepsActOverlay } from "./act-settings.ts";
import { GAME_PLATE } from "./game-hud.tsx";
import {
	actOverlays,
	type OffStage,
	overlayBudget,
	type youSpotSlots,
} from "./game3d-acts.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	ActAgentList,
	ActStatus,
	openQueue,
	type useActCards,
} from "./interface-ask-card.tsx";
import type { QuizActView } from "./quiz-acts.tsx";
import type { useActClockOptions } from "./use-acts.ts";

/**
 * The act layer's views for the quiz: the studio's act view, the
 * contestants' act rows and the ask/blocker openers.
 */
export function useQuizActViews({
	actCards,
	acts,
	clock,
	nowMs,
	offStage,
	onStage,
	owners,
	port,
	privacy,
	queueOpener,
	reducedMotion,
	slots,
	snapshot,
	stageWidth,
	withActs,
}: {
	actCards: ReturnType<typeof useActCards>;
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock: ReturnType<typeof useActClockOptions>;
	nowMs: number;
	offStage: OffStage;
	onStage: InterfaceAgentAct[];
	owners: QuizActView["owners"];
	port: InterfacePort;
	privacy: QuizActView["privacy"];
	queueOpener: RefObject<(() => void) | null>;
	reducedMotion: boolean;
	slots: ReturnType<typeof youSpotSlots>;
	snapshot: InterfaceSnapshot;
	stageWidth: number;
	withActs: boolean;
}) {
	// The kit settings (overlay density, work bubbles) for its own pieces too.
	const kitSettings = useGameKitSettings();
	const budget = overlayBudget(stageWidth > 0 ? stageWidth : 1280, {
		domTargets: true,
	});
	const shownKey = withActs
		? [
				...budget.fill(
					actOverlays(
						onStage,
						slots,
						offStage,
						onStage.find((act) => act.act === "working")?.agentId ?? null,
						{ reduced: reducedMotion }
					).filter((item) => keepsActOverlay(item, kitSettings))
				),
			]
				.sort()
				.join("|")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shownIds = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		actCards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => actCards.openBlocker(threadId, agentName, opener);
	const actView: QuizActView | null = withActs
		? {
				acts,
				clock,
				iconOnly: budget.iconOnly,
				nowMs,
				offStage,
				onAsk: (askId) => actCards.openAsk(askId),
				onBlocker: (threadId, agentName) =>
					actCards.openBlocker(threadId, agentName),
				onQueue: () => openQueue(queueOpener),
				owners,
				privacy,
				shown: shownIds,
				slots,
				snapshot,
			}
		: null;
	const offStageActs = new Map(
		[...acts].filter(([id]) => !onStage.some((act) => act.agentId === id))
	);
	const contestantActs = withActs
		? {
				offStage:
					offStageActs.size > 0 ? (
						<section
							aria-label="Off the podiums"
							className={`${GAME_PLATE} mt-3 p-3`}
						>
							<ActAgentList
								acts={offStageActs}
								clock={clock}
								nowMs={nowMs}
								onAsk={onAsk}
								onBlocker={onBlocker}
								onOpenThread={port.openThread}
								snapshot={snapshot}
							/>
						</section>
					) : null,
				row: (agentId: string) => {
					const act = acts.get(agentId);
					return act
						? {
								label: act.ariaLabel,
								status: (
									<ActStatus
										act={act}
										clock={clock}
										nowMs={nowMs}
										onAsk={onAsk}
										onBlocker={onBlocker}
										snapshot={snapshot}
									/>
								),
							}
						: null;
				},
			}
		: undefined;
	return { actView, contestantActs, onAsk, onBlocker };
}
