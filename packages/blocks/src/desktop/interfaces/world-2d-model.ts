import {
	type InterfaceAgent,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
	type WorldLayout,
	type WorldPoint,
} from "@ryuhq/protocol/interfaces";
import { tileKey, type VillageLayout } from "./world-village.ts";

/**
 * View-model logic for the 2D village, kept free of React and the canvas so
 * it can be tested on its own: where each villager stands with the user
 * (from their threads), where the player starts, and when the controls hint
 * opens by itself.
 */

/** A villager's standing: their most urgent thread, or idle. */
export type VillagerStatus = ThreadStatus | "idle";

/** Villagers wearing the "!" quest marker: they are waiting on the user. */
export function needsYou(status: VillagerStatus): boolean {
	return status === "attention" || status === "your-turn";
}

function rank(status: VillagerStatus): number {
	const index = THREAD_STATUS_ORDER.indexOf(status as ThreadStatus);
	return index < 0 ? THREAD_STATUS_ORDER.length : index;
}

/**
 * Each agent's status as a villager: "Needs attention" when any of its
 * threads failed or was interrupted (that never goes stale), otherwise the
 * status of its most recent thread, with a running agent always at least
 * working. The more urgent wins, by `THREAD_STATUS_ORDER`. An agent with no
 * threads is idle (or working).
 */
export function villagerStatuses(
	agents: readonly Pick<InterfaceAgent, "id" | "status">[],
	threads: readonly InterfaceThread[]
): Map<string, VillagerStatus> {
	const latest = new Map<string, InterfaceThread>();
	const troubled = new Set<string>();
	for (const thread of threads) {
		const status = threadStatus(thread);
		for (const agentId of thread.agentIds) {
			if (status === "attention") {
				troubled.add(agentId);
			}
			const current = latest.get(agentId);
			if (!current || thread.updatedAt > current.updatedAt) {
				latest.set(agentId, thread);
			}
		}
	}
	const statuses = new Map<string, VillagerStatus>();
	for (const agent of agents) {
		const candidates: VillagerStatus[] = [
			agent.status === "working" ? "working" : "idle",
		];
		const recent = latest.get(agent.id);
		const recentStatus = recent ? threadStatus(recent) : "quiet";
		// A conversation nobody has spoken in says nothing about the villager.
		if (recentStatus !== "quiet") {
			candidates.push(recentStatus);
		}
		if (troubled.has(agent.id)) {
			candidates.push("attention");
		}
		let best: VillagerStatus = "idle";
		for (const candidate of candidates) {
			if (rank(candidate) < rank(best)) {
				best = candidate;
			}
		}
		statuses.set(agent.id, best);
	}
	return statuses;
}

/** What a villager's status reads as in the talk panel ("Your turn"). */
export function villagerStatusLabel(status: VillagerStatus): string {
	return status === "idle" ? "Idle" : THREAD_STATUS_LABELS[status];
}

/**
 * The status as it is appended to an accessible name ("Visit Cipher (needs
 * attention)"), or empty when there is nothing to say.
 */
export function villagerStatusSuffix(status: VillagerStatus): string {
	switch (status) {
		case "attention":
			return " (needs attention)";
		case "your-turn":
			return " (your turn)";
		case "working":
			return " (working)";
		default:
			return "";
	}
}

/** How many villagers are waiting on the user. */
export function countNeedingYou(
	statuses: ReadonlyMap<string, VillagerStatus>
): number {
	let count = 0;
	for (const status of statuses.values()) {
		if (needsYou(status)) {
			count++;
		}
	}
	return count;
}

/**
 * Where the player starts: on the main road where it crosses the street in
 * the middle of the village (between the first two rows of cottages), so
 * the opening view frames the cottages around the player instead of the
 * empty square, on a road tile no villager stands next to. An empty
 * village (or one with no such tile) starts on the square.
 */
export function startPoint(
	layout: WorldLayout,
	village: VillageLayout
): WorldPoint {
	const rows = [...new Set(layout.entities.map((entity) => entity.y))].sort(
		(a, b) => a - b
	);
	const row = rows[Math.floor((rows.length - 1) / 2)];
	if (row === undefined) {
		return layout.spawn;
	}
	const street = row + 1;
	// Clear of every villager (diagonals too), so nobody is "nearby" yet.
	const crowded = (x: number) =>
		layout.entities.some(
			(entity) =>
				Math.abs(entity.x - x) <= 1 && Math.abs(entity.y - street) <= 1
		);
	let best: WorldPoint | null = null;
	for (let x = 0; x < layout.width; x++) {
		if (crowded(x) || !village.paths.has(tileKey(x, street))) {
			continue;
		}
		if (
			!best ||
			Math.abs(x - layout.spawn.x) < Math.abs(best.x - layout.spawn.x)
		) {
			best = { x, y: street };
		}
	}
	return best ?? layout.spawn;
}

/** Below this stage width (CSS px) the controls hint starts closed. */
export const HINT_NARROW_WIDTH = 600;

/** Whether the controls hint opens by itself on a stage this wide. */
export function hintOpensByDefault(stageWidth: number): boolean {
	return stageWidth >= HINT_NARROW_WIDTH;
}

/** The last street (the row below the southernmost cottages). */
export function lastStreet(layout: WorldLayout): number {
	let bottom = -1;
	for (const entity of layout.entities) {
		bottom = Math.max(bottom, entity.y + 1);
	}
	return bottom;
}

/**
 * How far beside a villager (in tiles) the player stands to talk: the
 * yards on either side hold a mailbox or a barrel toward their outer edge,
 * so this clears both the villager and the yard's furniture.
 */
export const TALK_SIDE_OFFSET = 11 / 16;

/**
 * Where the player is drawn while talking to a villager. Walking up (or a
 * hotbar visit) leaves the player on the street tile below the villager's
 * doorstep, which runs under the eaves of the next row's roofs; drawn
 * there, the player would stand on that roof. So while talking, the player
 * is shown at the villager's side on the doorstep (right, else left),
 * facing them, the way a Stardew farmer stands beside a villager. This is
 * where the player is drawn only: walking still starts from the street
 * tile. Anywhere else the player is drawn where they are.
 */
export function talkSpot(
	layout: WorldLayout,
	talkingTo: string | null,
	player: WorldPoint,
	/** Whether a tile is open ground (not a cottage, inside the world). */
	open: (point: WorldPoint) => boolean
): { facing: "left" | "right"; point: WorldPoint } | null {
	const entity = talkingTo
		? layout.entities.find((item) => item.agentId === talkingTo)
		: undefined;
	if (!entity || player.x !== entity.x || player.y !== entity.y + 1) {
		return null;
	}
	if (open({ x: entity.x + 1, y: entity.y })) {
		return {
			facing: "left",
			point: { x: entity.x + TALK_SIDE_OFFSET, y: entity.y },
		};
	}
	if (open({ x: entity.x - 1, y: entity.y })) {
		return {
			facing: "right",
			point: { x: entity.x - TALK_SIDE_OFFSET, y: entity.y },
		};
	}
	return null;
}
