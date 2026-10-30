import {
	type ClockOptions,
	clockLabel,
	type InterfaceAgentAct,
	type InterfaceBlocker,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { ActStation, type StationLayout } from "./game3d-act-stage.tsx";
import { isRedBlocker } from "./game3d-acts.ts";
import type { KitchenStation } from "./kitchen-model.ts";
import { COUNTER_HEIGHT } from "./kitchen-props.tsx";

/** The station counters stand at villager scale (kitchen-diorama.tsx). */
const STATION_SCALE = 0.68;
const COUNTER_Z = 0.72;
const COUNTER_TOP = (COUNTER_HEIGHT + 0.08) * STATION_SCALE;

/**
 * Where a chef's station pieces sit (with the act layer stations stand
 * `ACT_SPREAD` farther apart): pips on the counter's front, the words on
 * a board at its chef's left, under its own plate (speech bubbles hang up
 * and right of a plate, so the right side belongs to the chef's bubble),
 * alarms beside the chef on its lower left (the kit hangs their plates on
 * that side, so the stack never hides its kneel), the meshes at its left end, unread and
 * suggestion openers by its front corners (below the plate line).
 */
export const KITCHEN_STATION_LAYOUT: Partial<StationLayout> = {
	alarms: [-1.6, 0, 1.6],
	board: [-1.0, 1.1, 0.2],
	cue: [0, 0.02, 0],
	limit: [-1.1, 0, 0.35],
	next: [-1.1, 0, -0.2],
	pips: [0, COUNTER_TOP * 0.55, COUNTER_Z + 0.36],
	suggestion: [-0.85, 0, 0.6],
	unread: [0.85, 0, 0.6],
};

/** The station's smoke and burnt ring: a red alarm, not just any attention. */
export function stationBurnt(blockers: readonly InterfaceBlocker[]): boolean {
	return blockers.some((blocker) => isRedBlocker(blocker));
}

/**
 * The kitchen's words for a limit: "86'd till 15:10" (when it resets, from
 * the focus rate-limit blocker or the agent's limit), "Likely 86'd till …"
 * for an inferred one, plain "86'd" with no reset time.
 */
export function eightySixed(
	act: InterfaceAgentAct,
	nowMs: number,
	clock?: ClockOptions
): string {
	const blocker = act.blockers.find((item) => item.kind === "rate-limited");
	const clears = blocker?.clearsAt ?? act.timer?.until ?? null;
	const words = clears
		? `86'd till ${clockLabel(clears, nowMs, clock)}`
		: "86'd";
	return blocker?.source === "estimate" ? `Likely ${words}` : words;
}

/** The act as a station shows it: a limited chef's bubble in kitchen words. */
export function kitchenStationAct(
	act: InterfaceAgentAct,
	nowMs: number,
	clock?: ClockOptions
): InterfaceAgentAct {
	if (act.act !== "limited" || !act.bubble) {
		return act;
	}
	return {
		...act,
		bubble: { ...act.bubble, text: eightySixed(act, nowMs, clock) },
	};
}

/** What the act props need to answer and open cards. */
export interface KitchenActHandlers {
	clock?: ClockOptions;
	iconOnly: boolean;
	nowMs: number;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	privacy: "full" | "redacted";
	reduced: boolean;
	shown: ReadonlySet<string>;
	snapshot: InterfaceSnapshot;
}

/**
 * A station's layout: its alarm stack stands beside the chef, away from
 * the room's middle (a station right of the middle stacks on its right,
 * a little behind; the rest on their left, a little in front), so the kit
 * hangs its plates on that side and the kneel shows, clear of the next chef.
 */
function stationLayout(station: KitchenStation): Partial<StationLayout> {
	return station.x > 0
		? { ...KITCHEN_STATION_LAYOUT, alarms: [1.9, 0, -0.9] }
		: KITCHEN_STATION_LAYOUT;
}

/** One chef's station: the kit's ActStation, in the room's frame. */
export function KitchenStationActs({
	act,
	handlers,
	station,
}: {
	act: InterfaceAgentAct;
	handlers: KitchenActHandlers;
	station: KitchenStation;
}) {
	return (
		<ActStation
			act={kitchenStationAct(act, handlers.nowMs, handlers.clock)}
			at={[station.x, 0, station.z]}
			clock={handlers.clock}
			iconOnly={handlers.iconOnly}
			layout={stationLayout(station)}
			nowMs={handlers.nowMs}
			onAsk={handlers.onAsk}
			onBlocker={handlers.onBlocker}
			privacy={handlers.privacy}
			reduced={handlers.reduced}
			shown={handlers.shown}
			snapshot={handlers.snapshot}
		/>
	);
}
