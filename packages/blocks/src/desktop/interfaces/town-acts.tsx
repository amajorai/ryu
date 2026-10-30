import {
	type ClockOptions,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceBlocker,
	type InterfaceSnapshot,
	threadClaims,
} from "@ryuhq/protocol/interfaces";
import {
	limitWords,
	oldBlockersOf,
	unreadAsksOf,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	actHasBlocker,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { alarmTone } from "./game3d-alarm.tsx";
import type { LifeBubble, LifePaths } from "./game3d-life.ts";
import { progressText } from "./game3d-meters.tsx";
import {
	CLOCK_TOWER,
	doorOf,
	HALL_SPOTS,
	oldestBlockingAsk,
	townLimitText,
} from "./town-acts-spots.tsx";
import type { Vec3 } from "./town-art.tsx";
import {
	LOT,
	needsLevel,
	SIDEWALK,
	type Town,
	type TownBuilding,
} from "./town-model.ts";

export { TownActMeshes } from "./town-acts-meshes.tsx";
export { type TownActHandlers, TownActProps } from "./town-acts-props.tsx";
export {
	doorOf,
	HALL_SPOTS,
	oldestBlockingAsk,
	townLimitText,
} from "./town-acts-spots.tsx";

/**
 * The town's act layer (spec §5 town row). Each agent's building button
 * stays its one target, named by its act sentence. The act props are
 * anchored overlay buttons in the town's DOM layer (the `data-anchor`
 * pattern): alarms, unread answers and suggestions at each building, and
 * at City Hall's steps the queue (petition letters for unowned or parked
 * asks, a plate over each villager who walked there to ask), the delivery
 * crate at the inbox and the "+N more" tally. The townsfolk walk to the
 * steps to ask and to the inbox to deliver (`actLife`).
 */

/** A delivery crate is the town's deliverable. */
export const TOWN_SKIN: ActSkin = { deliverable: { shape: "box" } };

/**
 * The townsfolk's waypoints (world units): each door, its block's corner
 * nearest City Hall, then the plaza in front of the steps, the queue
 * slots along the steps and the inbox.
 */
export function townPaths(town: Town): LifePaths {
	const points: Record<string, Vec3> = {};
	const links: [string, string][] = [];
	const ring = town.grid.inner / 2 + SIDEWALK / 2;
	points.you = HALL_SPOTS.you;
	points["you-tray"] = HALL_SPOTS.tray;
	for (const [index, slot] of HALL_SPOTS.slots.entries()) {
		points[`you-${index + 1}`] = slot;
	}
	links.push(
		["you", "you-1"],
		["you-1", "you-2"],
		["you-2", "you-3"],
		["you-3", "you-4"],
		["you", "you-tray"]
	);
	for (const district of town.districts) {
		const corner = `corner-${district.id}`;
		points[corner] = [
			district.x - Math.sign(district.x || 1) * ring,
			0.19,
			district.z - Math.sign(district.z || 1) * ring,
		];
		links.push([corner, "you"]);
		for (const building of district.buildings) {
			const door = `door-${building.agent.id}`;
			points[door] = doorOf(building);
			links.push([door, corner]);
		}
	}
	return { links, points };
}

/**
 * The town as the act layer draws it: each agent's building art follows
 * its act, never the threads' statuses. A crane only while its agent
 * works; a beacon only for a counted blocker, toned by kind (an old,
 * uncounted failure lights nothing); no reply bubble (the act's own
 * bubble carries an answer).
 */
export function actTown(
	town: Town,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Town {
	const remade = new Map<TownBuilding, TownBuilding>();
	for (const building of town.buildings) {
		const act = acts.get(building.agent.id);
		if (!act) {
			remade.set(building, building);
			continue;
		}
		const alarm = beaconTone(act);
		remade.set(building, {
			...building,
			alarm,
			calendar: act.blockers.some(
				(blocker) => alarmTone(blocker) === "calendar"
			),
			alert: alarm !== undefined,
			replied: false,
			working: act.act === "working",
		});
	}
	const swap = (building: TownBuilding) => remade.get(building) ?? building;
	// The desk's "Waiting" column and the "Needs you" view: who here asks you
	// or has stopped (a limited agent waits on its limit, not on you).
	const waiting = town.districts.map(
		(district) =>
			district.buildings.filter((building) => {
				const act = acts.get(building.agent.id);
				return act
					? act.act === "asking" || act.act === "blocked"
					: building.counts.attention + building.counts["your-turn"] > 0;
			}).length
	);
	const most = Math.max(0, ...waiting);
	return {
		...town,
		buildings: town.buildings.map(swap),
		districts: town.districts.map((district, index) => ({
			...district,
			buildings: district.buildings.map(swap),
			needs: needsLevel(waiting[index] ?? 0, most),
			petitions: waiting[index] ?? 0,
		})),
	};
}

/** Beacon tones, most severe first (amber is a limit: no beacon). */
const BEACON_ORDER = ["red", "calendar", "grey"] as const;

/**
 * The beacon over an agent's building: the most severe of its counted
 * blockers, whatever their order (a limit first and a failure after still
 * lights red); none for a limit alone.
 */
export function beaconTone(
	act: InterfaceAgentAct
): (typeof BEACON_ORDER)[number] | undefined {
	const tones = new Set(act.blockers.map((blocker) => alarmTone(blocker)));
	return BEACON_ORDER.find((tone) => tones.has(tone));
}

/**
 * What `actTown` reads from the acts, as a key: the building art is rebuilt
 * only when this changes, not on every clock tick.
 */
export function actTownKey(
	acts: ReadonlyMap<string, InterfaceAgentAct>
): string {
	return [...acts.values()]
		.map(
			(act) =>
				`${act.agentId}:${act.act}:${act.blockers.map((blocker) => alarmTone(blocker)).join(",")}`
		)
		.sort()
		.join("|");
}

/** One act prop in the town's DOM layer, at a world point. */
export type TownActEntry =
	| {
			agentName: string;
			anchor: string;
			at: Vec3;
			blocker: InterfaceBlocker;
			kind: "alarm" | "old";
			/** The failed thread (matched by value and claim), for its card. */
			threadId: string | null;
	  }
	| {
			agentName: string | null;
			anchor: string;
			asks: InterfaceAsk[];
			at: Vec3;
			/** The tray's files-changed sticker, when the budget keeps it. */
			count?: number | null;
			kind: "notice" | "suggestion" | "tray" | "unread";
	  }
	| {
			agentName: string;
			anchor: string;
			ask: InterfaceAsk;
			at: Vec3;
			/** The asking villager's bubble, when the budget keeps it. */
			bubble: LifeBubble | null;
			kind: "slot";
	  }
	| { anchor: string; at: Vec3; count: number; kind: "tally" }
	/** The clock tower's hourglass: an obstacle labels keep off (no text). */
	| { anchor: string; at: Vec3; kind: "clock" }
	| {
			anchor: string;
			at: Vec3;
			kind: "text";
			/** The budget kind it is drawn as (`data-budgeted-overlay`). */
			overlay: "elapsed" | "limit" | "text";
			text: string;
	  };

/**
 * Every act prop and where it stands: per building (one alarm per counted
 * blocker, dim older ones, unread answers, suggestions) and at City Hall
 * (the queue in `slots` order, the inbox's crates, the tally).
 */
export function townActEntries({
	acts,
	bubbles = new Map(),
	clock,
	nowMs = 0,
	overflow,
	owners,
	shown,
	slots,
	snapshot,
	town,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	/** The asking villagers' bubbles the budget kept, by agent id. */
	bubbles?: ReadonlyMap<string, LifeBubble>;
	clock?: ClockOptions;
	/** For the limit's clock label ("Closed till 15:10"). */
	nowMs?: number;
	overflow: number;
	owners: ReadonlyMap<string, string>;
	/** The status text the overlay budget chose (`actOverlays` ids). */
	shown: ReadonlySet<string>;
	slots: readonly YouSpotSlot[];
	snapshot: InterfaceSnapshot;
	town: Town;
}): TownActEntry[] {
	const entries: TownActEntry[] = [];
	const claims = threadClaims(snapshot);
	for (const building of town.buildings) {
		const act = acts.get(building.agent.id);
		if (!act) {
			continue;
		}
		const { x, z } = building.lot;
		const id = building.agent.id;
		const marks = [
			...act.blockers.map((blocker) => ({ blocker, old: false })),
			...oldBlockersOf(act, snapshot, claims).map((blocker) => ({
				blocker,
				old: true,
			})),
		];
		for (const [index, mark] of marks.entries()) {
			entries.push({
				agentName: act.agentName,
				anchor: `act:alarm:${id}:${index}`,
				// Inside its own lot on its screen-right side (clear of the folk
				// at the front door below), climbing up the screen.
				at: [x + LOT * 0.18, 1.2 + index * 1.0, z - LOT * 0.42],
				blocker: mark.blocker,
				kind: mark.old ? "old" : "alarm",
				threadId: mark.old
					? null
					: (snapshot.threads.find((thread) =>
							actHasBlocker(
								{ agentId: act.agentId, blockers: [mark.blocker] },
								thread,
								claims
							)
						)?.id ?? null),
			});
		}
		const texts: {
			id: string;
			overlay: "elapsed" | "limit" | "text";
			text: string | null;
		}[] = [
			{
				id: `limit:${id}`,
				overlay: "limit",
				text: limitWords(act, { clock, limitText: townLimitText, nowMs }),
			},
			{
				id: `progress:${id}`,
				overlay: "text",
				text: progressText(act.progress),
			},
			{ id: `next:${id}`, overlay: "text", text: act.next },
			{ id: `elapsed:${id}`, overlay: "elapsed", text: act.elapsed },
			{
				id: `cue:${id}`,
				overlay: "text",
				text: act.stalled
					? "stalled?"
					: act.longerThanUsual
						? `Longer than usual${act.elapsed ? ` · ${act.elapsed}` : ""}`
						: null,
			},
		];
		for (const [index, item] of texts.entries()) {
			if (item.text && shown.has(item.id)) {
				entries.push({
					anchor: `act:text:${item.id}`,
					// Low by the lot's front-left (the limit at its door, as a sign).
					at:
						item.overlay === "limit"
							? [doorOf(building)[0], 0.75, doorOf(building)[2]]
							: [x - LOT * 0.3, 0.5 + index * 0.42, z + LOT * 0.25],
					kind: "text",
					overlay: item.overlay,
					text: item.text,
				});
			}
		}
		// Unread answers wait only at an idle or working station (§4.1).
		const unread =
			act.act === "idle" || act.act === "working"
				? unreadAsksOf(act, snapshot, claims)
				: [];
		if (unread.length > 0) {
			entries.push({
				agentName: act.agentName,
				anchor: `act:unread:${id}`,
				asks: unread,
				at: [x - LOT * 0.25, 0.45, z + LOT * 0.25],
				kind: "unread",
			});
		}
		if (act.suggestions.length > 0) {
			entries.push({
				agentName: act.agentName,
				anchor: `act:suggestion:${id}`,
				asks: act.suggestions,
				at: [x + LOT * 0.25, 0.45, z - LOT * 0.25],
				kind: "suggestion",
			});
		}
	}
	for (const [index, slot] of slots.entries()) {
		const at = HALL_SPOTS.slots[index] ?? HALL_SPOTS.you;
		if (slot.carrier === "notice") {
			entries.push({
				agentName: owners.get(slot.ask.id) ?? null,
				anchor: `act:notice:${slot.ask.id}`,
				asks: [slot.ask],
				at: [at[0], 0.75, at[2]],
				kind: "notice",
			});
		} else {
			entries.push({
				agentName: acts.get(slot.agentId ?? "")?.agentName ?? "",
				anchor: `act:slot:${slot.ask.id}`,
				ask: slot.ask,
				bubble: bubbles.get(slot.agentId ?? "") ?? null,
				at: [at[0], 1.25, at[2]],
				kind: "slot",
			});
		}
	}
	const delivering = [...acts.values()].filter(
		(act) => act.act === "delivering" && act.ask
	);
	for (const [index, act] of delivering.entries()) {
		entries.push({
			agentName: act.agentName,
			anchor: `act:tray:${act.agentId}`,
			asks: [act.ask as InterfaceAsk],
			count: shown.has(`count:${act.agentId}`)
				? (snapshot.threads.find((thread) => thread.id === act.threadId)
						?.outcome?.filesChanged ?? null)
				: null,
			at: [
				HALL_SPOTS.tray[0] + index * 0.6,
				0.5,
				HALL_SPOTS.tray[2] + index * 0.3,
			],
			kind: "tray",
		});
	}
	if (overflow > 0) {
		entries.push({
			anchor: "act:tally",
			at: HALL_SPOTS.tally,
			count: overflow,
			kind: "tally",
		});
	}
	// The clock tower's hourglass (a 3D prop): labels and bubbles keep off it.
	if (oldestBlockingAsk(snapshot.asks)) {
		entries.push({ anchor: "act:clock", at: CLOCK_TOWER, kind: "clock" });
	}
	return entries;
}

/** The anchor points of the act props, for the scene to place. */
export function townActAnchors(
	entries: readonly TownActEntry[]
): Map<string, Vec3> {
	return new Map(entries.map((entry) => [entry.anchor, entry.at]));
}
