import type {
	InterfaceActivityKind,
	InterfaceAgentAct,
	InterfaceBlocker,
} from "@ryuhq/protocol/interfaces";
import { ACT_ART } from "./game3d-acts-palette.ts";
import {
	ambientLife,
	LIFE_FACE_CAMERA,
	type LifeAction,
	type LifeBubble,
	type LifeItem,
	type LifePaths,
	type LifePlace,
	type LifeScript,
	type LifeStep,
} from "./game3d-life.ts";
import type { VillagerTool } from "./game3d-villager.tsx";

export {
	actOverlays,
	type BudgetItem,
	bubbleOverlayId,
	NARROW_STAGE,
	type OverlayBudget,
	overlayBudget,
	spotPoint,
} from "./game3d-acts-overlays.ts";
export {
	type ActTotals,
	actorTarget,
	actTotals,
	type NextRun,
	nextRunOf,
	type OffStage,
	slotOf,
	stageAgents,
	type YouSpotSlot,
	youSpotSlots,
} from "./game3d-acts-stage.ts";

export {
	type AnnounceState,
	actAnnouncement,
	actHasBlocker,
	actSummaryLine,
	type BlockerEntry,
	blockerEntries,
	countedBlockerThreads,
} from "./game3d-acts-summary.ts";

/**
 * The act layer: turns each agent's `InterfaceAgentAct` (from the
 * protocol's `agentActs`) into what the kit draws, with no WebGL, so every
 * game shares one vocabulary and it is unit-tested once.
 *
 * - `actLife`: the villager's `LifeScript` for its act (walk to the
 *   you-spot with the ask, deliver to the tray, work at the station...).
 * - `stageAgents`: who gets a station when a game has fewer than agents.
 * - `youSpotSlots`: which ask waits in which you-spot slot, carried by a
 *   villager or pinned as a notice, and how many overflow.
 * - `actorTarget`: the same placement for non-villager actors.
 * - `actTotals` / `actSummaryLine`: the HUD summary.
 * - `actAnnouncement`: the polite live-region sentence for new asks,
 *   new failures and asks about to expire.
 * - `toolForActivity`, `overlayBudget`, `actOverlays`.
 *
 * Words only ever come from the protocol helpers (`askBubble`, the act's
 * bubble, blocker titles) on a snapshot the host already redacted.
 */

/** The you-spot queue points every scene declares in its `LifePaths`. */
export type YouSlot = "you-1" | "you-2" | "you-3" | "you-4";
export const YOU_SLOTS: readonly YouSlot[] = [
	"you-1",
	"you-2",
	"you-3",
	"you-4",
];
/** The you-spot itself (asking villagers without a slot wait here). */
export const YOU_SPOT = "you";
/** Where deliverables are set down. */
export const YOU_TRAY = "you-tray";

/** Where one agent's act plays out. */
export interface ActSpots {
	/** The scene's waypoints, holding "you", "you-1".."you-4" and "you-tray". */
	paths: LifePaths;
	/** Where a limited agent rests (a bench, the coffee corner); default station. */
	rest?: LifePlace;
	/** This agent's you-spot slot (from `youSpotSlots`) while it asks. */
	slot?: YouSlot | null;
	/** This agent's station: where it works, stops and idles. */
	station: LifePlace;
	/** Facing at the station (default: the camera). */
	stationFacing?: number;
}

/** A game's look for the act items. */
export interface ActSkin {
	/**
	 * What an asking villager carries for its ask instead of the letter or
	 * scroll (a clue card, a ticket). Its accent turns to the letter's
	 * destructive accent when a choice is destructive.
	 */
	askItem?: LifeItem;
	/** The pose a downed (red-blocked) agent ends in (default "slump"; "kneel"). */
	blockedPose?: LifeAction;
	/** The game's produce for a deliverable (crate, plate, parcel...). */
	deliverable: LifeItem;
	/** Overrides for what the ask letter's seal looks like. */
	letter?: { accent: string; color?: string; destructiveAccent: string };
	/** The pose an idle agent holds at its station (default "idle"). */
	rest?: LifeAction;
}

/** How long a work bubble stays up before fading to the plate. */
export const WORK_BUBBLE_SECONDS = 6;
/** How long a done or waiting bubble stays up. */
export const SHORT_BUBBLE_SECONDS = 2.5;

/** The step a working act is on: its activity kind, or stalled. */
function stepOf(act: InterfaceAgentAct): string {
	if (act.act !== "working") {
		return act.carry ?? "";
	}
	return act.stalled ? "stalled" : (act.carry ?? "");
}

/**
 * The life script key: changes only when the act, its thread, its ask,
 * its step (activity kind) or its you-spot slot changes, so a ticking
 * timer or a new bubble word never restarts the walk. The slot is part of
 * the key so that when a slot frees, the villagers behind it get a new
 * script and step forward (spec 4.1 item 1); `spots.slot` is the only
 * thing that moves them.
 */
export function actKey(act: InterfaceAgentAct, spots: ActSpots): string {
	const slot = act.act === "asking" ? (spots.slot ?? YOU_SPOT) : "";
	return `${act.act}:${act.threadId ?? ""}:${act.ask?.id ?? ""}:${stepOf(act)}:${slot}`;
}

/** A villager bubble for an act's bubble (the text is already short). */
export function actBubble(act: InterfaceAgentAct): LifeBubble | null {
	const bubble = act.bubble;
	if (!bubble?.text) {
		return null;
	}
	switch (bubble.tone) {
		case "ask":
			return { icon: "alert", label: bubble.text, tone: "ask" };
		case "error":
			return { icon: "cross", label: bubble.text, tone: "bad" };
		case "limit":
			return { label: bubble.text, tone: "warn" };
		case "done":
			return { icon: "check", label: bubble.text, tone: "good" };
		case "work":
			return {
				icon: "dots",
				label: bubble.text,
				partial: bubble.partial,
				tone: "plain",
			};
		default:
			return { label: bubble.text, tone: "plain" };
	}
}

const DEFAULT_LETTER = {
	accent: ACT_ART.sealAmber,
	destructiveAccent: ACT_ART.sealRed,
};

/** What an asking villager carries: a letter, a scroll, or nothing. */
export function askItem(
	act: InterfaceAgentAct,
	skin: ActSkin
): LifeItem | null {
	if (act.carry !== "question" && act.carry !== "approval") {
		return null;
	}
	const letter = skin.letter ?? DEFAULT_LETTER;
	const destructive = act.ask?.choices?.some((choice) => choice.destructive);
	if (skin.askItem) {
		return {
			...skin.askItem,
			accent: destructive
				? letter.destructiveAccent
				: (skin.askItem.accent ?? letter.accent),
		};
	}
	if (act.carry === "question") {
		return { shape: "scroll" };
	}
	return {
		accent: destructive ? letter.destructiveAccent : letter.accent,
		color: skin.letter?.color,
		shape: "letter",
	};
}

/** What a working villager holds in both hands for its step, if anything. */
function workItem(kind: string | null): LifeItem | null {
	if (kind === "run") {
		return { shape: "tablet" };
	}
	if (kind === "plan") {
		return { shape: "laptop" };
	}
	return null;
}

/** Blocker kinds drawn as a red alarm (smoke and a slump). */
export function isRedBlocker(blocker: InterfaceBlocker | undefined): boolean {
	return (
		blocker !== undefined &&
		blocker.kind !== "interrupted" &&
		blocker.kind !== "rate-limited" &&
		blocker.kind !== "schedule-failed"
	);
}

function atStation(
	spots: ActSpots,
	place: LifePlace = spots.station
): LifeStep[] {
	return [
		{ do: "goTo", to: place },
		{ do: "face", toward: spots.stationFacing ?? LIFE_FACE_CAMERA },
	];
}

/**
 * The villager's script for its act. Asking: carry the ask to its slot,
 * face the camera, show the ask. Working: the tool at the station, a work
 * bubble that fades after 6 s (none under `reduced`, none when stalled).
 * Blocked / limited: at the station (the alarm or limit plate carries the
 * words, so no bubble). Delivering: set the produce down at the tray and
 * walk back. Waiting / idle: at the station with a subtle idle loop.
 */
export function actLife(
	act: InterfaceAgentAct,
	spots: ActSpots,
	skin: ActSkin,
	{ reduced }: { reduced: boolean }
): LifeScript {
	const key = actKey(act, spots);
	const bubble = actBubble(act);
	const rest = skin.rest ?? "idle";
	const clear: LifeStep = { bubble: null, do: "say" };
	switch (act.act) {
		case "asking": {
			const steps: LifeStep[] = [
				clear,
				{ do: "carry", item: askItem(act, skin) },
				{ do: "goTo", to: spots.slot ?? YOU_SPOT },
				{ do: "face", toward: LIFE_FACE_CAMERA },
				{ action: act.carry === null ? "wave" : "idle", do: "pose" },
			];
			if (bubble) {
				steps.push({ bubble, do: "say" });
			}
			return {
				idle: [
					{ do: "wait", seconds: 4 },
					{ action: "look", do: "pose" },
					{ do: "wait", seconds: 1.6 },
					{ action: act.carry === null ? "wave" : "idle", do: "pose" },
				],
				key,
				steps,
			};
		}
		case "working": {
			const steps: LifeStep[] = [
				clear,
				{ do: "carry", item: workItem(act.stalled ? null : act.carry) },
				...atStation(spots),
				{ action: act.stalled ? "idle" : "work", do: "pose" },
			];
			if (bubble && !reduced && !act.stalled) {
				steps.push({ bubble, do: "say", seconds: WORK_BUBBLE_SECONDS });
			}
			return { idle: [{ do: "wait", seconds: 5 }], key, steps };
		}
		case "blocked": {
			const red = isRedBlocker(act.blockers[0]);
			const steps: LifeStep[] = [
				clear,
				{ do: "carry", item: null },
				...atStation(spots),
			];
			if (red) {
				steps.push(
					{ action: "stumble", do: "pose" },
					{ do: "effect", effect: "smoke" },
					{ action: skin.blockedPose ?? "slump", do: "pose" }
				);
				return {
					idle: [
						{ do: "wait", seconds: 4 },
						{ do: "effect", effect: "smoke" },
					],
					key,
					steps,
				};
			}
			steps.push({ action: "look", do: "pose" });
			return { idle: [{ do: "wait", seconds: 5 }], key, steps };
		}
		case "limited":
			return {
				idle: [
					{ do: "wait", seconds: 5 },
					{ action: "sip", do: "pose" },
					{ do: "wait", seconds: 2.2 },
					{ action: "idle", do: "pose" },
				],
				key,
				steps: [
					clear,
					{ do: "carry", item: null },
					...atStation(spots, spots.rest ?? spots.station),
					{ action: "idle", do: "pose" },
				],
			};
		case "delivering": {
			const steps: LifeStep[] = [
				clear,
				{ do: "carry", item: skin.deliverable },
				{ do: "goTo", to: YOU_TRAY },
				{ do: "face", toward: LIFE_FACE_CAMERA },
				{ do: "carry", item: null },
				{ do: "effect", effect: "sparkle" },
			];
			if (bubble) {
				steps.push({ bubble, do: "say", seconds: SHORT_BUBBLE_SECONDS });
			}
			steps.push({ do: "wait", seconds: 1 }, ...atStation(spots), {
				action: rest,
				do: "pose",
			});
			return { idle: ambientLife(act.agentId, { rest }), key, steps };
		}
		case "waiting": {
			const steps: LifeStep[] = [
				clear,
				{ do: "carry", item: null },
				...atStation(spots),
				{ action: "look", do: "pose" },
			];
			if (bubble) {
				steps.push({ bubble, do: "say", seconds: WORK_BUBBLE_SECONDS });
			}
			return { idle: [{ do: "wait", seconds: 5 }], key, steps };
		}
		default:
			return {
				idle: ambientLife(act.agentId, { rest }),
				key,
				steps: [
					clear,
					{ do: "carry", item: null },
					...atStation(spots),
					{ action: rest, do: "pose" },
				],
			};
	}
}

/** The kit's tool for each step kind; a game overrides any of them. */
const ACTIVITY_TOOLS: Record<InterfaceActivityKind, VillagerTool | undefined> =
	{
		answer: "quill",
		ask: undefined,
		delegate: "clipboard",
		edit: "quill",
		plan: "clipboard",
		read: "book",
		run: "wrench",
		search: "lens",
		think: "book",
		tool: "wrench",
		web: "globe",
		write: "quill",
	};

/** The tool a working villager holds for its step kind. */
export function toolForActivity(
	kind: InterfaceActivityKind | string | null | undefined,
	gameDefaults: Partial<Record<InterfaceActivityKind, VillagerTool>> = {}
): VillagerTool | undefined {
	if (!(kind && kind in ACTIVITY_TOOLS)) {
		return undefined;
	}
	const activity = kind as InterfaceActivityKind;
	return gameDefaults[activity] ?? ACTIVITY_TOOLS[activity];
}
