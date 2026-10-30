/* eslint-disable react/no-unknown-property */
import {
	type ClockOptions,
	clockLabel,
	type InterfaceActivityKind,
	type InterfaceAgentAct,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { besideStation, stationLayoutFor } from "./arcade-acts-layout.ts";
import { ARCADE_3D } from "./arcade-palette.ts";
import {
	ActStation,
	type LimitText,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	type ActSpots,
	actLife,
	bubbleOverlayId,
	type OffStage,
	slotOf,
	toolForActivity,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { LIFE_FACE_CAMERA, type LifePaths } from "./game3d-life.ts";
import { type PipSkin, queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type { MemberLooks, VillagerSpec } from "./game3d-villager.tsx";

export {
	ARCADE_STATION_LAYOUT,
	ARCADE_STATION_LAYOUT_BACK,
	ARCADE_STATION_LAYOUT_MID,
	ARCADE_STATION_LAYOUT_MID_NARROW,
	arcadePaths,
	arcadeYouSpot,
	besideStation,
	floorPoint,
	stationLayoutFor,
} from "./arcade-acts-layout.ts";

/**
 * The arcade's act layer: where each player works (beside its cabinet),
 * the you-spot queue in the aisle in front of the prize counter (asking
 * players wave a ticket there, notices pin to posts), the ticket strips
 * answers leave on the counter, and each player's station (the kit's
 * `ActStation`, kept inside the player's own footprint). Words only come
 * from the act (`agentActs` on an already-redacted snapshot); the arcade
 * themes them: "INSERT COIN 15:10" for a limit, "TILT" for a stopped run.
 */

/** What the arcade scene needs to act out the snapshot. */
export interface ArcadeActView {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	/** Narrow stages: act props and plates collapse to glyphs. */
	iconOnly: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	/** Owner names of asks, for notice plates ("Ada asks: …"). */
	owners: ReadonlyMap<string, string>;
	privacy: "full" | "redacted";
	/** The overlay budget's chosen ids (actOverlays). */
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
}

/** The arcade's produce: a strip of prize tickets. */
export const ARCADE_ACT_SKIN: ActSkin = {
	deliverable: {
		accent: ARCADE_3D.ticketEdge,
		color: ARCADE_3D.ticket,
		shape: "scroll",
	},
};

/** "INSERT COIN 15:10": an arcade's words for a usage limit. */
export function insertCoinText(
	act: InterfaceAgentAct,
	nowMs: number,
	clock?: ClockOptions
): string {
	const focus = act.blockers[0];
	const clears = focus?.clearsAt ?? act.timer?.until ?? null;
	const coin = clears
		? `INSERT COIN ${clockLabel(clears, nowMs, clock)}`
		: "INSERT COIN";
	return focus?.source === "estimate" ? `Likely ${coin}` : coin;
}

/** "INSERT COIN 15:10" on the station board (the kit adds "Likely"). */
export const arcadeLimitText: LimitText = (_act, at) =>
	at ? `INSERT COIN ${at}` : "INSERT COIN";

/** The credit bar: progress pips in the cabinet's LED colours. */
const ARCADE_PIPS: PipSkin = {
	done: ARCADE_3D.creditLit,
	estimate: ARCADE_3D.creditEstimate,
	todo: ARCADE_3D.creditDim,
};

/** What a cabinet's lettering says for its player's act. */
export interface CabinetWords {
	/**
	 * The marquee: TILT and why, PAUSED (an interrupted run, not a
	 * failure), INSERT COIN, or the step being played.
	 */
	marquee: string | null;
	/** The screen's attract line: what comes next. */
	next: string | null;
	/** The reels: the current step's kind and the two before it. */
	reels: InterfaceActivityKind[];
	tone: "ink" | "limit" | "paused" | "tilt";
}

/** The words on a cabinet for its player's act. */
export function cabinetWords(
	act: InterfaceAgentAct,
	snapshot: InterfaceSnapshot,
	nowMs: number,
	clock?: ClockOptions,
	/** The kit's work bubbles setting: off, the marquee leaves out the step. */
	workBubbles = true
): CabinetWords {
	const thread = act.threadId
		? snapshot.threads.find((item) => item.id === act.threadId)
		: undefined;
	const activity = act.act === "working" ? thread?.activity : null;
	const reels = activity
		? [activity.kind, ...(activity.recent ?? []).slice(-2).reverse()]
		: [];
	const focus = act.blockers[0];
	if (act.act === "blocked" && focus) {
		const paused = focus.kind === "interrupted";
		return {
			marquee: `${paused ? "PAUSED" : "TILT"} · ${focus.title}`,
			next: act.next,
			reels,
			tone: paused ? "paused" : "tilt",
		};
	}
	if (act.act === "limited") {
		return {
			// Two lines on the sign: INSERT COIN over its reset time.
			marquee: insertCoinText(act, nowMs, clock).replace(
				"INSERT COIN ",
				"INSERT COIN · "
			),
			next: act.next,
			reels,
			tone: "limit",
		};
	}
	return {
		marquee:
			act.act === "working" && workBubbles ? (act.bubble?.text ?? null) : null,
		next: act.next,
		reels,
		tone: "ink",
	};
}

/**
 * Whether a player's bubble shows: the overlay budget's pick, except a
 * work bubble on a narrow stage (it would run off the edge; the status
 * line and the queue carry the step) and, under reduced motion, a
 * delivery's "3 files edited" (it never fades there, and the tray's ticket
 * with its count says the same).
 */
function showBubble(
	act: InterfaceAgentAct,
	bubbleId: string,
	view: ArcadeActView,
	reduced: boolean
): boolean {
	if (view.iconOnly && act.act === "working") {
		return false;
	}
	if (reduced && act.act === "delivering") {
		return false;
	}
	return view.shown.has(bubbleId);
}

/**
 * An on-stage player's villager for its act: its life script, its plate
 * named by the act sentence (an asking player's plate is its queue plate,
 * "Ada · 14m", and answers the ask), its tool while working.
 */
export function arcadePlayer({
	act,
	base,
	label,
	looks,
	paths,
	reduced,
	view,
}: {
	act: InterfaceAgentAct;
	base: Pick<VillagerSpec, "facing" | "id" | "position">;
	/** The game's own action suffix for other acts ("Open the machine."). */
	label: string;
	looks: MemberLooks;
	paths: LifePaths;
	reduced: boolean;
	view: ArcadeActView;
}): VillagerSpec[] {
	const spots: ActSpots = {
		paths,
		slot: slotOf(view.slots.slots, act.agentId),
		station: `station:${act.agentId}`,
		stationFacing: base.facing ?? LIFE_FACE_CAMERA,
	};
	const ask = act.act === "asking" ? act.ask : null;
	const queued = ask !== null && spots.slot !== null;
	const bubbleId = bubbleOverlayId(act);
	const player: VillagerSpec = {
		...base,
		activate: ask ? () => view.onAsk(ask.id) : undefined,
		actAgent: act.agentId,
		bubble: bubbleId ? showBubble(act, bubbleId, view, reduced) : true,
		// A player at its cabinet has neighbours' plates either side: its work
		// bubble hangs straight up, over its own cabinet. (An animated auto side
		// keeps its first pick, which can land on a neighbour while plates fit.)
		bubbleSide: act.act === "working" && !queued ? "up" : undefined,
		iconOnly: queued ? false : undefined,
		label: ask
			? `${act.ariaLabel} Answer their ask.`
			: `${act.ariaLabel} ${label}`,
		life: actLife(act, spots, ARCADE_ACT_SKIN, { reduced }),
		looks: {
			...looks,
			tool: act.act === "working" ? toolForActivity(act.carry) : undefined,
		},
		name: ask
			? queuePlateText(
					act.agentName,
					{
						approx: ask.sinceApprox,
						since: ask.since,
						until: ask.expiresAt ?? null,
						untilApprox: ask.expiresApprox,
					},
					view.nowMs
				)
			: act.agentName,
		pose: "idle",
		youSpot: queued ? "slot" : undefined,
	};
	return [
		player,
		...apprenticeSpecs({
			agentId: act.agentId,
			helpers: act.helpers,
			looks,
			station: besideStation(base.position, 0.35, 0.3),
		}),
	];
}

/**
 * Everything the act layer draws besides the players: the kit's you-spot
 * (notices, timers, tallies, the ticket tray on the counter) and each
 * player's station.
 */
export function ArcadeActProps({
	onStage,
	reduced,
	stations,
	view,
	youLayout,
}: {
	onStage: readonly InterfaceAgentAct[];
	reduced: boolean;
	stations: ReadonlyMap<string, Vec3>;
	view: ArcadeActView;
	youLayout: YouSpotLayout;
}) {
	const layoutOf = stationLayoutFor(stations, view.iconOnly);
	return (
		<group>
			<YouSpots
				iconOnly={view.iconOnly}
				item={ARCADE_ACT_SKIN.deliverable}
				layout={youLayout}
				nowMs={view.nowMs}
				offStage={view.offStage}
				onAsk={view.onAsk}
				onOpenQueue={view.onQueue}
				onStage={onStage}
				owners={view.owners}
				privacy={view.privacy}
				reduced={reduced}
				shown={view.shown}
				slots={view.slots}
				snapshot={view.snapshot}
				timerSkin={{ color: ARCADE_3D.ledTimer }}
			/>
			{onStage.map((act) => {
				const station = stations.get(act.agentId);
				return station ? (
					<ActStation
						act={act}
						at={station}
						clock={view.clock}
						iconOnly={view.iconOnly}
						key={act.agentId}
						layout={layoutOf(station)}
						limitText={arcadeLimitText}
						nowMs={view.nowMs}
						onAsk={view.onAsk}
						onBlocker={view.onBlocker}
						pipSkin={ARCADE_PIPS}
						privacy={view.privacy}
						reduced={reduced}
						shown={view.shown}
						snapshot={view.snapshot}
					/>
				) : null;
			})}
		</group>
	);
}
