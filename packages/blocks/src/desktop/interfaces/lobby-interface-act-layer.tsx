import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { useMemo, useRef } from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	actOverlays,
	actTotals,
	overlayBudget,
	youSpotSlots,
} from "./game3d-acts.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	ActStatus,
	askOwners,
	NeedYouButton,
	openQueue,
	QueueButton,
} from "./interface-ask-card.tsx";
import { type LobbyActView, lobbyYouSpot } from "./lobby-acts.tsx";
import { YOU_SPOT_ROOM } from "./lobby-interface-constants.ts";
import type { LobbyInterfaceState } from "./lobby-interface-state.ts";

/** The act layer over the plaza: overlays, the ready-check pad and the act HUD buttons. */
export function useLobbyActLayer(
	snapshot: InterfaceSnapshot,
	{
		acts,
		cards,
		clock,
		compact,
		nowMs,
		offStage,
		onStage,
		privacy,
		reduceMotion,
		stageWidth,
		unowned,
		withActs,
		world,
	}: Pick<
		LobbyInterfaceState,
		| "acts"
		| "cards"
		| "clock"
		| "compact"
		| "nowMs"
		| "offStage"
		| "onStage"
		| "privacy"
		| "reduceMotion"
		| "stageWidth"
		| "unowned"
		| "withActs"
		| "world"
	>
) {
	const queueOpener = useRef<(() => void) | null>(null);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				onStage.map((act) => act.agentId)
			),
		[acts, onStage, unowned]
	);
	const totals = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
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
						{ reduced: reduceMotion }
					).filter((item) => keepsActOverlay(item, kitSettings))
				),
			]
				.sort()
				.join("|")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	// The plaza and, with acts, the ready-check pad in front of it: no more.
	const stageBounds = useMemo(() => {
		const bounds = { ...world.bounds, top: 4.4 };
		if (!withActs) {
			return bounds;
		}
		for (const [x, , z] of Object.values(
			lobbyYouSpot(budget.iconOnly).points
		)) {
			bounds.minX = Math.min(bounds.minX, x - YOU_SPOT_ROOM);
			bounds.maxX = Math.max(bounds.maxX, x + YOU_SPOT_ROOM);
			bounds.minZ = Math.min(bounds.minZ, z - YOU_SPOT_ROOM);
			bounds.maxZ = Math.max(bounds.maxZ, z + YOU_SPOT_ROOM);
		}
		return bounds;
	}, [budget.iconOnly, withActs, world.bounds]);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const actView: LobbyActView | null = withActs
		? {
				acts,
				clock,
				iconOnly: budget.iconOnly,
				nowMs,
				offStage,
				onAsk: (askId) => cards.openAsk(askId),
				onBlocker: (threadId, agentName) =>
					cards.openBlocker(threadId, agentName),
				onQueue: () => openQueue(queueOpener),
				owners,
				privacy,
				shown,
				slots,
				snapshot,
			}
		: null;
	const offStageActs = useMemo(() => {
		const staged = new Set(onStage.map((act) => act.agentId));
		return new Map([...acts].filter(([id]) => !staged.has(id)));
	}, [acts, onStage]);
	const statusOf = (agentId: string) => {
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
	};
	const actButtons = (
		<>
			<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={totals} />
			<QueueButton
				acts={acts}
				clock={clock}
				narrow={compact}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				openRef={queueOpener}
				snapshot={snapshot}
				totals={totals}
				unowned={unowned}
			/>
		</>
	);
	return {
		actButtons,
		actView,
		budget,
		offStageActs,
		onAsk,
		onBlocker,
		stageBounds,
		statusOf,
		totals,
	};
}
