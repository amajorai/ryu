import type { Vec3 } from "./game3d-palette.ts";

/**
 * The villagers' behaviour layer: pure choreography, no rendering. A game
 * hands each villager a `LifeScript` (a list of generic steps: walk to a
 * place, face something, strike a pose, carry an item, say something in a
 * bubble, wait, show an effect), and `compileLife` turns it into a
 * timeline that `sampleLife` reads at any time, into a reused frame, with
 * no allocation. `Villagers` (game3d-villager.tsx) plays the timelines:
 * when a script's `key` changes it compiles the new steps from wherever
 * the villager is at that moment, so a change of state is acted out
 * instead of snapping.
 *
 * Everything here is deterministic: the same steps from the same start
 * give the same timeline, so transitions are unit-tested without WebGL.
 * Under reduced motion a timeline is read at its settled end (`still`):
 * no walking, the last pose, item and bubble shown at once.
 */

/** What a villager does with its body while it stands still. */
export type LifeAction =
	| "chat"
	| "cheer"
	| "idle"
	/** Down on one knee (a downed or blocked agent; games pick it via `ActSkin.blockedPose`). */
	| "kneel"
	| "look"
	| "sip"
	| "slump"
	| "stretch"
	| "stumble"
	| "wave"
	| "work";

/** A bubble's icon: a thought, a call for you, a tick, a cross. */
export type LifeIcon = "alert" | "check" | "cross" | "dots" | "heart" | "note";

/** A short speech or thought bubble over a villager. */
export interface LifeBubble {
	icon?: LifeIcon;
	/**
	 * At most five words ("Need you", "Done!"). Never raw message text:
	 * labels come only from `askBubble` / `activityBubble` / blocker
	 * titles (game3d-acts.ts), from a snapshot the host already redacted.
	 */
	label?: string;
	/** Drawn dashed: the words are partial (a summary-only thread). */
	partial?: boolean;
	/** Colors the bubble: good news, a problem, a call for you, a limit. */
	tone?: "ask" | "bad" | "good" | "plain" | "warn";
}

/**
 * Where a villager's bubble hangs from its plate: up-right (the default
 * look), up-left, straight up, or `auto` (the stage picks the first of
 * right, left, up whose box meets no other plate; under reduced motion
 * every pass picks afresh, so the frame stays a function of the scene).
 */
export type LifeBubbleSide = "auto" | "left" | "right" | "up";

/** Shapes a villager can carry in both hands. */
export type LifeItemShape =
	| "bag"
	| "basket"
	| "bowl"
	| "box"
	| "laptop"
	| "letter"
	| "plate"
	| "scroll"
	| "tablet";

/** Something carried: a shape and, optionally, the game's colors for it. */
export interface LifeItem {
	/** A second color (a basket's crop, a box's tape, a plate's food). */
	accent?: string;
	color?: string;
	shape: LifeItemShape;
}

/** A short burst at the villager: sparkles, smoke, or a dust puff. */
export type LifeEffect = "puff" | "smoke" | "sparkle";

/** A waypoint id from the game's `LifePaths`, or a world point. */
export type LifePlace = string | Vec3;

/** One step of a choreography. Steps run in order. */
export type LifeStep =
	/** Walks to a place along the game's paths (`direct`: straight there). */
	| { direct?: boolean; do: "goTo"; speed?: number; to: LifePlace }
	/** Snaps to a place (where a newcomer appears, before walking in). */
	| { at: LifePlace; do: "place"; facing?: number }
	/** Turns on the spot to face a place, a yaw, or the camera. */
	| { do: "face"; toward: LifePlace | number }
	/** Strikes a pose until the next one. */
	| { action: LifeAction; do: "pose" }
	/** Picks an item up (both hands) or, with null, puts it down. */
	| { do: "carry"; item: LifeItem | null }
	/** Shows a bubble for `seconds` (or until the next `say`); null clears. */
	| { bubble: LifeBubble | null; do: "say"; seconds?: number }
	| { do: "wait"; seconds: number }
	| { do: "effect"; effect: LifeEffect };

/**
 * A villager's choreography. `steps` play once from wherever the villager
 * is when `key` changes; then `idle` loops (and walks back to where the
 * loop started, so it never jumps). Give a new `key` for every change of
 * state you want acted out.
 */
export interface LifeScript {
	idle?: readonly LifeStep[];
	key: string;
	steps: readonly LifeStep[];
}

/** A game's walkable paths: named points and the links between them. */
export interface LifePaths {
	links: readonly (readonly [string, string])[];
	points: Readonly<Record<string, Vec3>>;
}

/** Where a villager is and what it shows, at the start of a script. */
export interface LifeState {
	action: LifeAction;
	bubble: LifeBubble | null;
	item: LifeItem | null;
	position: Vec3;
	yaw: number;
}

/** Walking pace, world units a second. */
export const LIFE_WALK_SPEED = 1.35;
/** How long a turn to face something takes, seconds. */
export const LIFE_TURN_SECONDS = 0.3;
/** How long an effect burst lasts, seconds. */
export const LIFE_EFFECT_SECONDS = 1.4;
/** How long a pose that plays once (cheer, stumble) takes, seconds. */
export const LIFE_ONE_SHOT_SECONDS = 0.9;
/** The yaw that faces the isometric camera. */
export const LIFE_FACE_CAMERA = Math.PI / 4;

interface Leg {
	end: number;
	from: Vec3;
	start: number;
	to: Vec3;
	/** Distance walked before this leg, for a continuous walk cycle. */
	walked: number;
}

interface Turn {
	at: number;
	from: number;
	to: number;
}

interface Mark<T> {
	at: number;
	value: T;
}

interface BubbleMark {
	at: number;
	bubble: LifeBubble;
	/** Cleared by a later `say` (null or another bubble) rather than time. */
	replaced: boolean;
	until: number;
}

/** A compiled choreography: read it with `sampleLife`. */
export interface LifeTimeline {
	actions: Mark<LifeAction>[];
	bubbles: BubbleMark[];
	effects: Mark<LifeEffect>[];
	/** When the idle loop ends (equal to `settled` without one). */
	end: number;
	items: Mark<LifeItem | null>[];
	legs: Leg[];
	/** When the idle loop starts, or null without one. */
	loopFrom: number | null;
	/** How many marks of each track the one-off steps wrote (the rest loop). */
	main: { bubbles: number; turns: number };
	/** When the one-off steps are done: the settled state. */
	settled: number;
	start: LifeState;
	turns: Turn[];
}

/** One villager's state at a moment, written by `sampleLife`. */
export interface LifeFrame {
	action: LifeAction;
	/** Seconds since the current action began. */
	actionAge: number;
	/** The bubble shown, or null. */
	bubble: LifeBubble | null;
	effect: LifeEffect | null;
	/** Seconds since the current effect began (Infinity when none). */
	effectAge: number;
	item: LifeItem | null;
	position: [number, number, number];
	/** Distance walked so far, for the walk cycle. */
	stride: number;
	walking: boolean;
	yaw: number;
}

export function emptyLifeFrame(): LifeFrame {
	return {
		action: "idle",
		actionAge: 0,
		bubble: null,
		effect: null,
		effectAge: Number.POSITIVE_INFINITY,
		item: null,
		position: [0, 0, 0],
		stride: 0,
		walking: false,
		yaw: LIFE_FACE_CAMERA,
	};
}

/** The signed shortest turn from `from` to `to`, radians. */
export function turnBetween(from: number, to: number): number {
	const full = Math.PI * 2;
	const delta = (((to - from) % full) + full * 1.5) % full;
	return delta - Math.PI;
}

function flat(from: Vec3, to: Vec3): number {
	return Math.hypot(to[0] - from[0], to[2] - from[2]);
}

function headingOf(from: Vec3, to: Vec3): number {
	return Math.atan2(to[0] - from[0], to[2] - from[2]);
}

/** A place as a point (unknown waypoint ids resolve to null). */
export function placeAt(
	place: LifePlace,
	paths: LifePaths | undefined
): Vec3 | null {
	if (typeof place !== "string") {
		return place;
	}
	return paths?.points[place] ?? null;
}

/** How much dearer a step off the paths is than one along them. */
export const LIFE_OFF_PATH = 1.6;

/**
 * Every waypoint's cheapest cost to reach `target` (along the links, then
 * a straight, off-path step to the target), and the next waypoint on that
 * way: Dijkstra from the target outward.
 */
function costsTo(
	paths: LifePaths,
	target: Vec3,
	targetId: string | null,
	offPath: number
): { cost: Map<string, number>; next: Map<string, string> } {
	const cost = new Map<string, number>();
	const next = new Map<string, string>();
	for (const [id, point] of Object.entries(paths.points)) {
		if (targetId === null || id === targetId) {
			cost.set(id, targetId === null ? flat(point, target) * offPath : 0);
		}
	}
	const done = new Set<string>();
	for (;;) {
		let current: string | null = null;
		for (const [id, value] of cost) {
			if (
				!done.has(id) &&
				(current === null || value < (cost.get(current) ?? 0))
			) {
				current = id;
			}
		}
		if (current === null) {
			break;
		}
		done.add(current);
		const here = paths.points[current];
		const base = cost.get(current) ?? 0;
		for (const [a, b] of paths.links) {
			let neighbour: string | null = null;
			if (a === current) {
				neighbour = b;
			} else if (b === current) {
				neighbour = a;
			}
			const there = neighbour ? paths.points[neighbour] : undefined;
			if (!(neighbour && here && there) || done.has(neighbour)) {
				continue;
			}
			const through = base + flat(here, there);
			if (through < (cost.get(neighbour) ?? Number.POSITIVE_INFINITY)) {
				cost.set(neighbour, through);
				next.set(neighbour, current);
			}
		}
	}
	return { cost, next };
}

/**
 * The points a villager walks through from `from` to `to`: onto the paths
 * where that is cheapest, along the links, then off to the target. Steps
 * off the paths cost `LIFE_OFF_PATH` times more, so villagers keep to the
 * paths unless the straight walk is clearly shorter; unreachable or
 * pathless targets walk straight.
 */
export function routeLife(
	paths: LifePaths | undefined,
	from: Vec3,
	to: LifePlace
): Vec3[] {
	const target = placeAt(to, paths);
	if (!target) {
		return [];
	}
	if (!paths) {
		return [target];
	}
	const offPath = LIFE_OFF_PATH;
	const { cost, next } = costsTo(
		paths,
		target,
		typeof to === "string" ? to : null,
		offPath
	);
	let entry: string | null = null;
	let best = flat(from, target) * offPath;
	for (const [id, value] of cost) {
		const point = paths.points[id] as Vec3;
		const total = flat(from, point) * offPath + value;
		if (total < best - 1e-6) {
			best = total;
			entry = id;
		}
	}
	if (entry === null) {
		return [target];
	}
	const points: Vec3[] = [];
	let cursor: string | undefined = entry;
	while (cursor !== undefined) {
		points.push(paths.points[cursor] as Vec3);
		cursor = next.get(cursor);
	}
	const last = points.at(-1);
	if (last && flat(last, target) > 0.01) {
		points.push(target);
	}
	return points;
}

/** Actions that play once and then hold their last frame. */
export const ONE_SHOT_ACTIONS: ReadonlySet<LifeAction> = new Set([
	"cheer",
	"stumble",
]);

interface Cursor {
	action: LifeAction;
	bubble: BubbleMark | null;
	item: LifeItem | null;
	position: Vec3;
	time: number;
	walked: number;
	yaw: number;
}

function turnTo(timeline: LifeTimeline, cursor: Cursor, yaw: number) {
	if (Math.abs(turnBetween(cursor.yaw, yaw)) < 0.01) {
		return;
	}
	timeline.turns.push({ at: cursor.time, from: cursor.yaw, to: yaw });
	cursor.yaw = yaw;
}

function closeBubble(cursor: Cursor) {
	if (cursor.bubble) {
		cursor.bubble.until = Math.min(cursor.bubble.until, cursor.time);
		cursor.bubble.replaced = true;
	}
	cursor.bubble = null;
}

function applyStep(
	timeline: LifeTimeline,
	cursor: Cursor,
	step: LifeStep,
	paths: LifePaths | undefined
) {
	switch (step.do) {
		case "goTo": {
			const points = step.direct
				? [placeAt(step.to, paths)].filter((point): point is Vec3 =>
						Boolean(point)
					)
				: routeLife(paths, cursor.position, step.to);
			const speed = step.speed ?? LIFE_WALK_SPEED;
			for (const point of points) {
				const length = flat(cursor.position, point);
				if (length < 0.01) {
					continue;
				}
				turnTo(timeline, cursor, headingOf(cursor.position, point));
				const seconds = length / speed;
				timeline.legs.push({
					end: cursor.time + seconds,
					from: cursor.position,
					start: cursor.time,
					to: point,
					walked: cursor.walked,
				});
				cursor.time += seconds;
				cursor.walked += length;
				cursor.position = point;
			}
			break;
		}
		case "place": {
			const point = placeAt(step.at, paths);
			if (point) {
				timeline.legs.push({
					end: cursor.time,
					from: point,
					start: cursor.time,
					to: point,
					walked: cursor.walked,
				});
				cursor.position = point;
			}
			if (step.facing !== undefined) {
				timeline.turns.push({
					at: cursor.time - LIFE_TURN_SECONDS,
					from: step.facing,
					to: step.facing,
				});
				cursor.yaw = step.facing;
			}
			break;
		}
		case "face": {
			let yaw: number | null = null;
			if (typeof step.toward === "number") {
				yaw = step.toward;
			} else {
				const point = placeAt(step.toward, paths);
				if (point && flat(cursor.position, point) > 0.01) {
					yaw = headingOf(cursor.position, point);
				}
			}
			if (yaw !== null && Math.abs(turnBetween(cursor.yaw, yaw)) >= 0.01) {
				turnTo(timeline, cursor, yaw);
				cursor.time += LIFE_TURN_SECONDS;
			}
			break;
		}
		case "pose":
			timeline.actions.push({ at: cursor.time, value: step.action });
			cursor.action = step.action;
			break;
		case "carry":
			timeline.items.push({ at: cursor.time, value: step.item });
			cursor.item = step.item;
			break;
		case "say": {
			closeBubble(cursor);
			if (step.bubble) {
				const mark: BubbleMark = {
					at: cursor.time,
					bubble: step.bubble,
					replaced: false,
					until:
						step.seconds === undefined
							? Number.POSITIVE_INFINITY
							: cursor.time + step.seconds,
				};
				timeline.bubbles.push(mark);
				cursor.bubble = mark;
			}
			break;
		}
		case "wait":
			cursor.time += Math.max(0, step.seconds);
			break;
		case "effect":
			timeline.effects.push({ at: cursor.time, value: step.effect });
			break;
		default:
			break;
	}
}

/**
 * Compiles a script into a timeline starting at `start` (where and how the
 * villager is when the script begins), at time 0.
 */
export function compileLife(
	start: LifeState,
	script: Pick<LifeScript, "idle" | "steps">,
	paths?: LifePaths
): LifeTimeline {
	const timeline: LifeTimeline = {
		actions: [{ at: 0, value: start.action }],
		bubbles: [],
		effects: [],
		end: 0,
		items: [{ at: 0, value: start.item }],
		legs: [],
		loopFrom: null,
		main: { bubbles: 0, turns: 0 },
		settled: 0,
		start,
		turns: [],
	};
	const cursor: Cursor = {
		action: start.action,
		bubble: null,
		item: start.item,
		position: start.position,
		time: 0,
		walked: 0,
		yaw: start.yaw,
	};
	if (start.bubble) {
		const mark: BubbleMark = {
			at: 0,
			bubble: start.bubble,
			replaced: false,
			until: Number.POSITIVE_INFINITY,
		};
		timeline.bubbles.push(mark);
		cursor.bubble = mark;
	}
	for (const step of script.steps) {
		applyStep(timeline, cursor, step, paths);
	}
	// A one-shot pose as the last step still gets to play.
	if (ONE_SHOT_ACTIONS.has(cursor.action)) {
		const last = timeline.actions.at(-1);
		if (last && cursor.time - last.at < LIFE_ONE_SHOT_SECONDS) {
			cursor.time = last.at + LIFE_ONE_SHOT_SECONDS;
		}
	}
	timeline.settled = cursor.time;
	timeline.end = cursor.time;
	timeline.main = {
		bubbles: timeline.bubbles.length,
		turns: timeline.turns.length,
	};
	const idle = script.idle ?? [];
	if (idle.length === 0) {
		return timeline;
	}
	const home = cursor.position;
	const homeYaw = cursor.yaw;
	const homeAction = cursor.action;
	const loopFrom = cursor.time;
	timeline.loopFrom = loopFrom;
	// Restate the held action and item at the loop's start, so wrapping
	// back to it restores them.
	timeline.actions.push({ at: loopFrom, value: cursor.action });
	timeline.items.push({ at: loopFrom, value: cursor.item });
	for (const step of idle) {
		applyStep(timeline, cursor, step, paths);
	}
	applyStep(timeline, cursor, { direct: true, do: "goTo", to: home }, paths);
	applyStep(timeline, cursor, { do: "face", toward: homeYaw }, paths);
	applyStep(timeline, cursor, { action: homeAction, do: "pose" }, paths);
	// Never a zero-length loop.
	timeline.end = Math.max(cursor.time, loopFrom + 1);
	return timeline;
}

function latest<T extends { at: number }>(
	marks: readonly T[],
	time: number,
	count = marks.length
): T | null {
	let found: T | null = null;
	for (let index = 0; index < count; index++) {
		const mark = marks[index] as T;
		if (mark.at > time) {
			break;
		}
		found = mark;
	}
	return found;
}

function lerpTurn(turn: Turn, time: number): number {
	const t = Math.min(1, Math.max(0, (time - turn.at) / LIFE_TURN_SECONDS));
	const eased = t * t * (3 - 2 * t);
	return turn.from + turnBetween(turn.from, turn.to) * eased;
}

/** The time within the timeline that `elapsed` seconds land on. */
export function lifeTime(timeline: LifeTimeline, elapsed: number): number {
	const { end, loopFrom } = timeline;
	if (loopFrom === null || elapsed < end) {
		return Math.max(0, elapsed);
	}
	const span = end - loopFrom;
	return loopFrom + ((elapsed - loopFrom) % span);
}

/**
 * Reads the timeline `elapsed` seconds after it started into `out`. With
 * `still` (reduced motion) it reads the settled end of the one-off steps
 * instead: no walking, no idle loop, and the last bubble the steps showed
 * stays up even if it was timed (only an explicit clear removes it).
 */
export function sampleLife(
	timeline: LifeTimeline,
	elapsed: number,
	out: LifeFrame,
	still = false
): LifeFrame {
	const time = still ? timeline.settled : lifeTime(timeline, elapsed);
	// Position: inside a leg, or where the last finished leg left off.
	let position = timeline.start.position;
	let walking = false;
	let stride = 0;
	for (const leg of timeline.legs) {
		if (leg.start > time) {
			break;
		}
		if (time < leg.end) {
			const t = (time - leg.start) / (leg.end - leg.start);
			out.position[0] = leg.from[0] + (leg.to[0] - leg.from[0]) * t;
			out.position[1] = leg.from[1] + (leg.to[1] - leg.from[1]) * t;
			out.position[2] = leg.from[2] + (leg.to[2] - leg.from[2]) * t;
			walking = !still;
			stride = leg.walked + flat(leg.from, leg.to) * t;
			position = out.position;
			break;
		}
		position = leg.to;
		stride = leg.walked + flat(leg.from, leg.to);
	}
	if (position !== out.position) {
		out.position[0] = position[0];
		out.position[1] = position[1];
		out.position[2] = position[2];
	}
	out.walking = walking;
	out.stride = stride;
	// Facing.
	const turn = still
		? latest(timeline.turns, time, timeline.main.turns)
		: latest(timeline.turns, time);
	out.yaw = turn
		? lerpTurn(turn, still ? Number.POSITIVE_INFINITY : time)
		: timeline.start.yaw;
	// Action, item.
	const action = latest(timeline.actions, time);
	out.action = action?.value ?? "idle";
	out.actionAge = still ? LIFE_ONE_SHOT_SECONDS : time - (action?.at ?? 0);
	out.item = latest(timeline.items, time)?.value ?? null;
	// Bubble: the latest one up at this time.
	out.bubble = null;
	const bubbles = still ? timeline.main.bubbles : timeline.bubbles.length;
	for (let index = 0; index < bubbles; index++) {
		const mark = timeline.bubbles[index] as BubbleMark;
		if (mark.at > time) {
			break;
		}
		if (mark.until > time || (still && !mark.replaced)) {
			out.bubble = mark.bubble;
		}
	}
	// Effect: the latest burst, with its age.
	const effect = latest(timeline.effects, time);
	const age = effect ? time - effect.at : Number.POSITIVE_INFINITY;
	out.effect =
		effect && age < LIFE_EFFECT_SECONDS && !still ? effect.value : null;
	out.effectAge = out.effect ? age : Number.POSITIVE_INFINITY;
	return out;
}

/** The state a timeline is in at `elapsed`, as a new script's start. */
export function lifeStateAt(
	timeline: LifeTimeline,
	elapsed: number,
	still = false
): LifeState {
	const frame = sampleLife(timeline, elapsed, emptyLifeFrame(), still);
	return {
		action: frame.action,
		bubble: null,
		item: frame.item,
		position: [frame.position[0], frame.position[1], frame.position[2]],
		yaw: frame.yaw,
	};
}

/**
 * Which villagers' scripts changed between two renders: ids whose key is
 * new or different. Ids that left are ignored (their villager is gone).
 */
export function changedScripts(
	previous: ReadonlyMap<string, string>,
	next: ReadonlyMap<string, string>
): string[] {
	const changed: string[] = [];
	for (const [id, key] of next) {
		if (previous.get(id) !== key) {
			changed.push(id);
		}
	}
	return changed;
}

/** Two villagers' steps to meet: one list each, and where they meet. */
export interface LifeMeeting {
	a: LifeStep[];
	b: LifeStep[];
	spot: Vec3;
}

/** How far apart two villagers stand to talk, world units. */
export const LIFE_CHAT_GAP = 1.05;

/**
 * Two villagers meet halfway, face each other and chat ("…" bubbles, in
 * turn). With `handOff`, `a` arrives carrying the item and hands it over:
 * afterwards `b` carries it. The one with the shorter walk waits, so they
 * arrive together. Both lists end standing at the meeting spot.
 */
export function meetUp(
	a: Vec3,
	b: Vec3,
	options: {
		bubble?: LifeBubble;
		handOff?: LifeItem;
		seconds?: number;
		speed?: number;
	} = {}
): LifeMeeting {
	const seconds = options.seconds ?? 3;
	const speed = options.speed ?? LIFE_WALK_SPEED;
	const spot: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
	const length = Math.max(0.001, flat(a, b));
	const half = Math.min(LIFE_CHAT_GAP / 2, length / 2);
	const dx = ((b[0] - a[0]) / length) * half;
	const dz = ((b[2] - a[2]) / length) * half;
	const spotA: Vec3 = [spot[0] - dx, spot[1], spot[2] - dz];
	const spotB: Vec3 = [spot[0] + dx, spot[1], spot[2] + dz];
	const walkA = flat(a, spotA) / speed;
	const walkB = flat(b, spotB) / speed;
	const bubble = options.bubble ?? { icon: "dots" as const };
	const beat = seconds / 2;
	const item = options.handOff;
	const side = (
		own: Vec3,
		other: Vec3,
		lead: number,
		first: boolean
	): LifeStep[] => {
		const steps: LifeStep[] = [];
		if (item && first) {
			steps.push({ do: "carry", item });
		}
		steps.push(
			{ direct: true, do: "goTo", speed, to: own },
			{ do: "wait", seconds: lead },
			{ do: "face", toward: other },
			{ action: "chat", do: "pose" }
		);
		if (item) {
			// The item passes over at the first beat of the chat.
			steps.push({ do: "carry", item: first ? null : item });
		}
		if (first) {
			steps.push({ bubble, do: "say", seconds: beat }, { do: "wait", seconds });
		} else {
			steps.push(
				{ do: "wait", seconds: beat },
				{ bubble, do: "say", seconds: seconds - beat },
				{ do: "wait", seconds: seconds - beat }
			);
		}
		steps.push({ action: "idle", do: "pose" });
		return steps;
	};
	const sideA = side(spotA, spotB, Math.max(0, walkB - walkA), true);
	const sideB = side(spotB, spotA, Math.max(0, walkA - walkB), false);
	return { a: sideA, b: sideB, spot };
}

/** A small deterministic hash of a string, for varying idle loops. */
function seedOf(text: string): number {
	let hash = 17;
	for (const character of text) {
		hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
	}
	return hash;
}

/**
 * A subtle, schedule-free idle loop for a villager standing at `home`:
 * long pauses broken by a glance around, a sip, a stretch, and (when the
 * game offers `nearby` places) a short stroll to one and back. Varied per
 * `seed`, the same every time for the same seed.
 */
export function ambientLife(
	seed: string,
	options: { nearby?: readonly LifePlace[]; rest?: LifeAction } = {}
): LifeStep[] {
	const hash = seedOf(seed);
	const rest = options.rest ?? "idle";
	const pause = (offset: number): LifeStep => ({
		do: "wait",
		seconds: 4 + ((hash >> offset) % 5),
	});
	const moments: LifeAction[] = ["look", "sip", "stretch"];
	const first = moments[hash % moments.length] as LifeAction;
	const second = moments[
		(hash + 1 + ((hash >> 3) % 2)) % moments.length
	] as LifeAction;
	const steps: LifeStep[] = [
		pause(2),
		{ action: first, do: "pose" },
		{ do: "wait", seconds: 2.2 },
		{ action: rest, do: "pose" },
		pause(5),
	];
	const nearby = options.nearby ?? [];
	const stroll = nearby[hash % Math.max(1, nearby.length)];
	if (stroll !== undefined && nearby.length > 0) {
		steps.push(
			{ do: "goTo", speed: LIFE_WALK_SPEED * 0.7, to: stroll },
			{ action: "look", do: "pose" },
			{ do: "wait", seconds: 2 },
			{ action: rest, do: "pose" }
		);
	}
	steps.push(
		{ action: second, do: "pose" },
		{ do: "wait", seconds: 2.2 },
		{ action: rest, do: "pose" }
	);
	return steps;
}
