import type {
	InterfaceActivityKind,
	InterfaceAgentAct,
} from "@ryuhq/protocol/interfaces";
import type { YouSpotLayout } from "./game3d-act-stage.tsx";
import {
	type ActSpots,
	actLife,
	bubbleOverlayId,
	slotOf,
	toolForActivity,
	YOU_SLOTS,
	type YouSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { LIFE_FACE_CAMERA, type LifePaths } from "./game3d-life.ts";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type {
	MemberLooks,
	VillagerSpec,
	VillagerTool,
} from "./game3d-villager.tsx";
import {
	besideStation,
	LECTERN,
	PODIUM_LINE,
	QUEUE_SPOTS,
	QUIZ_ACT_SKIN,
	QUIZ_CHAIR,
	type QuizActView,
	setPoint,
} from "./quiz-acts-set.ts";
import { wallPoint } from "./quiz-world.ts";

export {
	QUIZ_STATION_LAYOUT,
	QUIZ_STATION_LAYOUT_SITTING_OUT,
	QuizActProps,
	quizLimitText,
} from "./quiz-acts-props.tsx";
export {
	besideStation,
	QUIZ_ACT_SKIN,
	type QuizActView,
} from "./quiz-acts-set.ts";

/**
 * The quiz show's act layer: contestants work at their podiums (scribbling
 * their answers, the podium's screen saying what they are on and its
 * lights counting progress), buzz in and walk to the host's lectern to ask
 * (you are the host; a shot clock counts their wait, and notices for
 * parked and unowned asks pin to posts there), set an answer down on the
 * lectern's tray, sit out a usage limit on a chair beside the stage, and
 * light a red X on their podium when a run stops. Words only come from
 * the act (`agentActs` on an already-redacted snapshot).
 */

/**
 * The queue at the host's lectern: on wide stages four slots in two rows
 * left of the lectern (clear of the host, the podium screens and the
 * audience); on a phone one diagonal from the lectern, left of the
 * podiums. The tray stands on the lectern's left; the off-stage tally
 * beyond the podiums' right end.
 */
export function quizYouSpot(narrow: boolean): {
	layout: YouSpotLayout;
	points: Record<string, Vec3>;
} {
	const slot = (index: number): Vec3 =>
		narrow
			? setPoint(
					LECTERN.along + 0.4 + index * 1.5,
					LECTERN.out + 2 + index * 1.9
				)
			: // Left of the podiums: clear of their screens, the audience and
				// the contestants' plates and alarms.
				setPoint(
					QUEUE_SPOTS[index]?.[0] ?? 0,
					PODIUM_LINE + (QUEUE_SPOTS[index]?.[1] ?? 0)
				);
	const slots = Object.fromEntries(
		YOU_SLOTS.map((point, index) => [point, slot(index)])
	) as Record<YouSlot, Vec3>;
	const tray = setPoint(LECTERN.along - 1.3, LECTERN.out + 0.2);
	const last = slot(3);
	return {
		layout: {
			offStage: wallPoint(narrow ? 6.6 : 8.4, 4.8, 0.6),
			slots,
			tally: [last[0] + 1.1, last[1] + 0.6, last[2] - 0.6],
			timer: [0.45, 0, 0.2],
			tray,
			trayStep: [-0.42, 0, 0.42],
		},
		points: {
			...slots,
			you: setPoint(LECTERN.along + 0.9, LECTERN.out + 1.2),
			"you-tray": tray,
		},
	};
}

/**
 * Waypoints: each contestant's place behind its podium, the gap beside
 * the podium, the front of the stage below it, joined along the front to
 * the lectern.
 */
export function quizPaths(
	stations: ReadonlyMap<string, Vec3>,
	you: Record<string, Vec3>
): LifePaths {
	const points: Record<string, Vec3> = { ...you };
	const links: [string, string][] = [
		["you", "you-1"],
		["you", "you-2"],
		["you-1", "you-3"],
		["you-2", "you-4"],
		["you-1", "you-2"],
		["you-3", "you-4"],
		["you", "you-tray"],
	];
	for (const [id, at] of stations) {
		const side = `side:${id}`;
		const front = `front:${id}`;
		points[`station:${id}`] = at;
		points[side] = besideStation(at, 1.15, 0.2);
		points[front] = besideStation(at, 1.15, 1.9);
		points[`chair:${id}`] = besideStation(
			at,
			QUIZ_CHAIR.across,
			QUIZ_CHAIR.out
		);
		links.push(
			[`station:${id}`, side],
			[side, front],
			[front, "you"],
			[front, `chair:${id}`]
		);
	}
	return { links, points };
}

/**
 * A contestant's villager for its act: its life script, its plate named
 * by the act sentence (an asking contestant's plate is its queue plate,
 * "Ada · 14m", and answers the ask), its tool while working.
 */
export function quizContestant({
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
	/** The game's own action suffix for other acts ("Ask the final question."). */
	label: string;
	looks: MemberLooks;
	paths: LifePaths;
	reduced: boolean;
	view: QuizActView;
}): VillagerSpec[] {
	const spots: ActSpots = {
		paths,
		// A limited contestant sits out on the chair beside its podium.
		rest: `chair:${act.agentId}`,
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
		bubble: bubbleId ? view.shown.has(bubbleId) : true,
		// The back row's bubbles hang left, toward open ground: hung right
		// they reach the host's lectern.
		bubbleSide:
			queued && (spots.slot === "you-3" || spots.slot === "you-4")
				? "left"
				: undefined,
		iconOnly: queued ? false : undefined,
		label: ask
			? `${act.ariaLabel} Answer their ask.`
			: `${act.ariaLabel} ${label}`,
		life: actLife(act, spots, QUIZ_ACT_SKIN, { reduced }),
		looks: {
			...looks,
			tool:
				act.act === "working"
					? toolForActivity(act.carry, QUIZ_TOOLS)
					: undefined,
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
	const station = base.position;
	return [
		player,
		...apprenticeSpecs({
			agentId: act.agentId,
			helpers: act.helpers,
			looks,
			// Behind the contestant's left: the podium lights stay in view.
			station: besideStation(station, -0.9, -0.3),
		}),
	];
}

/** Podium screen words stay this short: one line, big enough to read. */
export const PODIUM_WORD_MAX = 8;

/**
 * What a podium's screen says for its contestant's act, in one short word
 * (the reasons ride the alarm plates beside it): the step's verb while
 * working, a buzzer's X for a stopped run, or the show's words.
 */
export function podiumWords(act: InterfaceAgentAct): string {
	const focus = act.blockers[0];
	switch (act.act) {
		case "asking":
			return "Buzzed";
		case "blocked":
			return focus?.kind === "interrupted" ? "Paused" : "X";
		case "delivering":
			return "Answer";
		case "limited":
			return "Out";
		case "working": {
			const verb = act.bubble?.text?.split(/\s+/)[0] ?? "";
			return verb && verb.length <= PODIUM_WORD_MAX ? verb : "Working";
		}
		default: {
			const letters = Array.from(act.agentName);
			return letters.length > PODIUM_WORD_MAX
				? `${letters.slice(0, PODIUM_WORD_MAX - 1).join("")}…`
				: act.agentName;
		}
	}
}

/** A contestant scribbles its answers with a quill, whatever it does. */
const QUIZ_TOOLS: Partial<Record<InterfaceActivityKind, VillagerTool>> = {
	answer: "quill",
	edit: "quill",
	plan: "quill",
	think: "quill",
	write: "quill",
};
