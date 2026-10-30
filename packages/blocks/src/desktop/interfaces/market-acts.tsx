import {
	type InterfaceActivityKind,
	type InterfaceAgentAct,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { keepsActOverlay } from "./act-settings.ts";
import {
	type ActSpots,
	actLife,
	actOverlays,
	blockerEntries,
	bubbleOverlayId,
	type OffStage,
	type OverlayBudget,
	overlayBudget,
	slotOf,
	toolForActivity,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { LIFE_FACE_CAMERA, type LifePaths } from "./game3d-life.ts";
import { queuePlateText } from "./game3d-meters.tsx";
import { GAME_KIT_DEFAULTS, type GameKitSettings } from "./game3d-settings.tsx";
import type {
	MemberLooks,
	VillagerSpec,
	VillagerTool,
} from "./game3d-villager.tsx";
import { SKIN } from "./market-acts-props.tsx";
import type { KeeperStation } from "./market-acts-stations.ts";
import { type MarketShop, shopForThread } from "./market-model.ts";
/**
 * The Market's act layer (spec §5, market row): every shopkeeper keeps one
 * shop and works at a station of its own there; the asks that need you
 * queue at the market cross (the fountain) in front of your own little
 * stall, where delivered answers are set down as wrapped parcels; and the
 * customers waiting at a shop are its upcoming runs.
 */

/** Each agent keeps one shop: the one holding its focus thread, else its first. */
export function actShops(
	shops: readonly MarketShop[],
	acts: ReadonlyMap<string, InterfaceAgentAct>
): MarketShop[] {
	const home = new Map<string, string>();
	for (const act of acts.values()) {
		const keeps = shops.filter((shop) =>
			shop.agents.some((agent) => agent.id === act.agentId)
		);
		const owner = shopForThread([...keeps], act.threadId);
		const chosen = owner ?? keeps[0];
		if (chosen) {
			home.set(act.agentId, chosen.id);
		}
	}
	return shops.map((shop) => ({
		...shop,
		agents: shop.agents.filter(
			(agent) => (home.get(agent.id) ?? shop.id) === shop.id
		),
	}));
}

/** Each shop's upcoming runs (its keepers' routines), soonest first. */
export function upcomingRuns(
	shops: readonly MarketShop[],
	events: readonly InterfaceEvent[] | undefined
): Map<string, InterfaceEvent[]> {
	const runs = new Map<string, InterfaceEvent[]>();
	const upcoming = (events ?? [])
		.filter((event) => event.kind === "upcoming" && event.agentId)
		.sort((a, b) => a.start.localeCompare(b.start));
	for (const shop of shops) {
		const keepers = new Set(shop.agents.map((agent) => agent.id));
		runs.set(
			shop.id,
			upcoming.filter((event) => keepers.has(event.agentId ?? ""))
		);
	}
	return runs;
}

/** Each shop's blocking asks (those of the shopkeepers it is home to). */
export function shopNeedYou(
	shops: readonly MarketShop[],
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const shop of shops) {
		let count = 0;
		for (const agent of shop.agents) {
			const act = acts.get(agent.id);
			if (act) {
				count += (act.ask?.blocking ? 1 : 0) + act.parkedAsks.length;
			}
		}
		counts.set(shop.id, count);
	}
	return counts;
}

/**
 * Whether an act is live work: working and not stalled (a stalled run may
 * have stopped without Core saying so, so it is never worded as work).
 */
export function worksLive(act: InterfaceAgentAct | undefined): boolean {
	return act?.act === "working" && !act.stalled;
}

/**
 * A shop's door sign from its keepers' acts: "Busy" while one works (live,
 * not stalled), else "Stopped" when one's run is stopped, "Closed for now"
 * when one sits out a limit, else "Open".
 */
export function shopSign(
	shop: MarketShop,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): string {
	const keepers = shop.agents.map((agent) => acts.get(agent.id));
	const states = new Set(keepers.map((act) => act?.act));
	if (keepers.some(worksLive)) {
		return "Busy";
	}
	if (states.has("blocked")) {
		return "Stopped";
	}
	return states.has("limited") ? "Closed for now" : "Open";
}

/**
 * Each thread's board section from the acts, not the orders' statuses,
 * where the acts speak to it: a counted stopped run needs attention, a
 * thread waiting on your answer or holding an answer is your turn, and the
 * thread a keeper works on is working, unless its run is stalled: that run
 * may have stopped, so it needs attention (actTotals counts it "stalled?",
 * not working). Every other thread keeps its own status (a keeper's other
 * running threads stay working), except that an older failure the acts no
 * longer count and a reply already read (your turn with no ask) are quiet.
 */
export function actOrderStatuses(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, ThreadStatus> {
	const statuses = new Map<string, ThreadStatus>();
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		statuses.set(
			thread.id,
			status === "attention" || status === "your-turn" ? "quiet" : status
		);
	}
	for (const act of acts.values()) {
		if (act.threadId && act.act === "working") {
			statuses.set(act.threadId, act.stalled ? "attention" : "working");
		}
	}
	for (const ask of snapshot.asks ?? []) {
		if (ask.threadId) {
			statuses.set(ask.threadId, "your-turn");
		}
	}
	for (const entry of blockerEntries(snapshot, acts)) {
		statuses.set(entry.threadId, "attention");
	}
	return statuses;
}

/** A keeper's state in the sheet's words, from its act. */
export function keeperWords(act: InterfaceAgentAct | undefined): string {
	if (!act) {
		return "idle";
	}
	return act.act === "working" && act.stalled
		? "may have stopped"
		: KEEPER_ACT_WORDS[act.act];
}

/** Each act in the sheet's words (a stalled one: `keeperWords`). */
export const KEEPER_ACT_WORDS: Record<InterfaceAgentAct["act"], string> = {
	asking: "asking you",
	blocked: "stopped",
	delivering: "has an answer ready",
	idle: "idle",
	limited: "closed for now",
	waiting: "waiting to start",
	working: "working",
};

export {
	crossLayout,
	marketActPaths,
	marketCross,
	RING,
	youPoints,
	yourStallAt,
} from "./market-acts-cross.ts";
export {
	chalkedLimit,
	MARKET_ACT_SKIN,
	MarketActProps,
	type MarketActPropsInput,
} from "./market-acts-props.tsx";
export {
	type KeeperStation,
	keeperLayout,
	keeperStations,
	stationOffset,
} from "./market-acts-stations.ts";

/**
 * What a shopkeeper holds for its step: the ledger to read and think, the
 * scale to run a job, use a tool or hand work on, the quill to write up an
 * order, the lens to search, the clipboard to plan.
 */
export const MARKET_TOOLS: Partial<
	Record<InterfaceActivityKind, VillagerTool>
> = {
	delegate: "scale",
	edit: "quill",
	plan: "clipboard",
	read: "ledger",
	run: "scale",
	search: "lens",
	think: "ledger",
	tool: "scale",
	web: "globe",
	write: "quill",
};

/**
 * The overlay budget the street runs on, and the status overlays it shows:
 * the kit's `actOverlays` in its fill order, the first keeper working live
 * featured (its bubble first).
 *
 * On a narrow stage no work, done or wait bubble is offered to the budget
 * (the spec drops only ask bubbles there). The street is turned to run
 * down a phone's screen with keepers stacked about 16 px apart sideways
 * and 29 px down, so a 150 px bubble hangs off the stage's right edge
 * (the kit's automatic side picks right there), and to the left or above
 * it covers the next keeper's plate or the queue at the cross. Each
 * keeper's board carries its step and its plate its whole sentence.
 */
export function marketShownOverlays({
	kit = GAME_KIT_DEFAULTS,
	offStage,
	onStage,
	reduced,
	slots,
	width,
}: {
	/** The kit game settings: no work bubbles when off, fewer lines at minimal. */
	kit?: GameKitSettings;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	reduced: boolean;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	width: number;
}): { budget: OverlayBudget; shown: Set<string> } {
	const budget = overlayBudget(width, { domTargets: true });
	const featured = onStage.find(worksLive)?.agentId ?? null;
	const items = actOverlays(onStage, slots, offStage, featured, {
		reduced,
	})
		.filter((item) => !(budget.narrow && item.kind === "work-bubble"))
		.filter((item) => keepsActOverlay(item, kit));
	return { budget, shown: budget.fill(items) };
}

/** The shopkeepers as act villagers (plus their helpers). */
export function actKeepers({
	acts,
	looks,
	nowMs,
	onAsk,
	paths,
	reduced,
	shown,
	slots,
	stations,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	looks: ReadonlyMap<string, MemberLooks>;
	nowMs: number;
	onAsk: (askId: string) => void;
	paths: LifePaths;
	reduced: boolean;
	shown: ReadonlySet<string>;
	slots: readonly YouSpotSlot[];
	stations: readonly KeeperStation[];
}): VillagerSpec[] {
	const cast: VillagerSpec[] = [];
	for (const station of stations) {
		const act = acts.get(station.agentId);
		const look = looks.get(station.agentId);
		if (!(act && look)) {
			continue;
		}
		const spots: ActSpots = {
			paths,
			slot: slotOf(slots, act.agentId),
			station: station.id,
			stationFacing: LIFE_FACE_CAMERA,
		};
		const asking = act.act === "asking" && act.ask ? act.ask : null;
		const bubbleId = bubbleOverlayId(act);
		cast.push({
			actAgent: act.agentId,
			activate: asking ? () => onAsk(asking.id) : undefined,
			bubble: bubbleId ? shown.has(bubbleId) : true,
			iconOnly: asking && spots.slot ? false : undefined,
			id: `${station.shopId}\n${act.agentId}`,
			label: asking
				? `${act.ariaLabel} Answer their ask.`
				: `${act.ariaLabel} Place an order with ${act.agentName}.`,
			life: actLife(act, spots, SKIN, { reduced }),
			looks: {
				...look,
				tool: worksLive(act)
					? toolForActivity(act.carry, MARKET_TOOLS)
					: undefined,
			},
			name: asking
				? queuePlateText(
						act.agentName,
						{
							approx: asking.sinceApprox,
							since: asking.since,
							until: asking.expiresAt ?? null,
							untilApprox: asking.expiresApprox,
						},
						nowMs
					)
				: act.agentName,
			pose: "idle",
			position: station.at,
			youSpot: asking && spots.slot ? "slot" : undefined,
		});
		cast.push(
			...apprenticeSpecs({
				agentId: act.agentId,
				helpers: act.helpers,
				looks: look,
				station: station.at,
			})
		);
	}
	return cast;
}
