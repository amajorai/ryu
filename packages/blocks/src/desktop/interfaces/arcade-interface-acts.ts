import { useMemo } from "react";
import { keepsActOverlay } from "./act-settings.ts";
import type { buildFloor } from "./arcade-model.ts";
import {
	actOverlays,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import type { useActs } from "./use-acts.ts";

type ActsView = ReturnType<typeof useActs>;

/**
 * The act layer on the floor: who is on stage, the you-spots, and which
 * overlays the stage has room for.
 */
export function useArcadeStageActs({
	acts,
	floor,
	floorSize,
	reduced,
	unowned,
	withActs,
}: {
	acts: ActsView["acts"];
	floor: ReturnType<typeof buildFloor>;
	floorSize: { width: number };
	reduced: boolean;
	unowned: ActsView["unowned"];
	withActs: boolean;
}) {
	// The act layer: the floor's players are on stage (every station), the
	// agents a filter hides are off stage.
	const { offStage, onStage } = useMemo(() => {
		const onFloor = new Set(floor.machines.map((machine) => machine.agent.id));
		const shown = new Map([...acts].filter(([id]) => onFloor.has(id)));
		const hidden = new Map([...acts].filter(([id]) => !onFloor.has(id)));
		return {
			offStage: stageAgents(hidden, 0).offStage,
			onStage: stageAgents(shown, Number.POSITIVE_INFINITY).onStage,
		};
	}, [acts, floor.machines]);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				onStage.map((act) => act.agentId)
			),
		[acts, onStage, unowned]
	);
	// The kit settings (overlay density, work bubbles) for its own pieces too.
	const kitSettings = useGameKitSettings();
	const budget = overlayBudget(floorSize.width > 0 ? floorSize.width : 1280, {
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
						{ reduced }
					).filter((item) => keepsActOverlay(item, kitSettings))
				),
			]
				.sort()
				.join("|")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	return { budget, offStage, onStage, shown, slots };
}
