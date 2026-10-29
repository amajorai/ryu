import { describe, expect, test } from "bun:test";
import {
	ambientLife,
	changedScripts,
	compileLife,
	emptyLifeFrame,
	LIFE_CHAT_GAP,
	LIFE_FACE_CAMERA,
	LIFE_TURN_SECONDS,
	LIFE_WALK_SPEED,
	type LifePaths,
	type LifeState,
	type LifeStep,
	lifeStateAt,
	meetUp,
	routeLife,
	sampleLife,
	turnBetween,
} from "./game3d-life.ts";

const START: LifeState = {
	action: "work",
	bubble: null,
	item: null,
	position: [0, 0, 0],
	yaw: LIFE_FACE_CAMERA,
};

/** An L-shaped lane: station (0,0) to corner (4,0) to porch (4,4). */
const PATHS: LifePaths = {
	links: [
		["station", "corner"],
		["corner", "porch"],
		["porch", "shed"],
	],
	points: {
		corner: [4, 0, 0],
		porch: [4, 0, 4],
		shed: [8, 0, 4],
		station: [0, 0, 0],
	},
};

const BOX = { shape: "box" as const };

/** The classic "needs you" choreography, in generic steps. */
const FETCH_YOU: LifeStep[] = [
	{ action: "idle", do: "pose" },
	{ do: "carry", item: BOX },
	{ do: "goTo", to: "porch" },
	{ do: "face", toward: LIFE_FACE_CAMERA },
	{ action: "wave", do: "pose" },
	{ bubble: { icon: "alert", label: "Need you" }, do: "say" },
];

function sample(steps: LifeStep[], at: number, still = false) {
	const timeline = compileLife(START, { steps }, PATHS);
	return sampleLife(timeline, at, emptyLifeFrame(), still);
}

describe("routeLife", () => {
	test("follows the links to a waypoint", () => {
		expect(routeLife(PATHS, [0, 0, 0], "porch")).toEqual([
			[0, 0, 0],
			[4, 0, 0],
			[4, 0, 4],
		]);
	});

	test("joins the paths where that is cheapest, never backtracking", () => {
		// Next to the corner, heading for the porch: straight onto the
		// corner, not back via the station.
		expect(routeLife(PATHS, [3, 0, -0.5], "porch")).toEqual([
			[4, 0, 0],
			[4, 0, 4],
		]);
	});

	test("walks straight when that is clearly shorter", () => {
		expect(routeLife(PATHS, [0, 0, 3.5], [3.5, 0, 4])).toEqual([[3.5, 0, 4]]);
	});

	test("walks straight for a short hop", () => {
		expect(routeLife(PATHS, [0, 0, 0], [0.5, 0, 0.5])).toEqual([[0.5, 0, 0.5]]);
	});

	test("walks straight without paths, and nowhere to an unknown id", () => {
		expect(routeLife(undefined, [0, 0, 0], [2, 0, 2])).toEqual([[2, 0, 2]]);
		expect(routeLife(PATHS, [0, 0, 0], "nowhere")).toEqual([]);
	});
});

describe("compileLife and sampleLife", () => {
	test("walks the route at walking pace, carrying the item", () => {
		const legSeconds = 4 / LIFE_WALK_SPEED;
		const midway = sample(FETCH_YOU, legSeconds / 2);
		expect(midway.walking).toBe(true);
		expect(midway.item).toEqual(BOX);
		expect(midway.position[0]).toBeCloseTo(2);
		expect(midway.position[2]).toBeCloseTo(0);
		// Heading +x along the first leg (after the turn settles).
		expect(midway.yaw).toBeCloseTo(Math.PI / 2);
		const second = sample(FETCH_YOU, legSeconds * 1.5);
		expect(second.position[0]).toBeCloseTo(4);
		expect(second.position[2]).toBeCloseTo(2);
	});

	test("arrives, turns to the camera, waves and calls for you", () => {
		const done = sample(FETCH_YOU, 30);
		expect(done.walking).toBe(false);
		expect(done.position).toEqual([4, 0, 4]);
		expect(done.yaw).toBeCloseTo(LIFE_FACE_CAMERA);
		expect(done.action).toBe("wave");
		expect(done.bubble).toEqual({ icon: "alert", label: "Need you" });
	});

	test("turns smoothly rather than snapping", () => {
		const timeline = compileLife(
			START,
			{ steps: [{ do: "face", toward: LIFE_FACE_CAMERA + Math.PI / 2 }] },
			PATHS
		);
		const half = sampleLife(timeline, LIFE_TURN_SECONDS / 2, emptyLifeFrame());
		expect(half.yaw).toBeGreaterThan(LIFE_FACE_CAMERA);
		expect(half.yaw).toBeLessThan(LIFE_FACE_CAMERA + Math.PI / 2);
		expect(timeline.settled).toBeCloseTo(LIFE_TURN_SECONDS);
	});

	test("reduced motion snaps to the end state with the bubble up", () => {
		const still = sample(FETCH_YOU, 0, true);
		expect(still.walking).toBe(false);
		expect(still.position).toEqual([4, 0, 4]);
		expect(still.action).toBe("wave");
		expect(still.item).toEqual(BOX);
		expect(still.bubble?.label).toBe("Need you");
	});

	test("a timed bubble expires, but stays up under reduced motion", () => {
		const steps: LifeStep[] = [
			{ bubble: { icon: "check", label: "Done!" }, do: "say", seconds: 1 },
			{ do: "wait", seconds: 3 },
		];
		expect(sample(steps, 0.5).bubble?.label).toBe("Done!");
		expect(sample(steps, 2).bubble).toBeNull();
		expect(sample(steps, 2, true).bubble?.label).toBe("Done!");
	});

	test("an explicit clear removes the bubble, even under reduced motion", () => {
		const steps: LifeStep[] = [
			{ bubble: { icon: "dots" }, do: "say" },
			{ do: "wait", seconds: 1 },
			{ bubble: null, do: "say" },
		];
		expect(sample(steps, 0.5).bubble).toEqual({ icon: "dots" });
		expect(sample(steps, 2).bubble).toBeNull();
		expect(sample(steps, 0, true).bubble).toBeNull();
	});

	test("a newcomer is placed at the door, then walks in", () => {
		const steps: LifeStep[] = [
			{ at: "shed", do: "place" },
			{ do: "goTo", to: "porch" },
		];
		expect(sample(steps, 0).position).toEqual([8, 0, 4]);
		expect(sample(steps, 30).position).toEqual([4, 0, 4]);
	});

	test("a one-shot pose at the end still gets time to play", () => {
		const timeline = compileLife(
			START,
			{ steps: [{ action: "cheer", do: "pose" }] },
			PATHS
		);
		expect(timeline.settled).toBeGreaterThan(0);
	});

	test("effects show briefly and never under reduced motion", () => {
		const steps: LifeStep[] = [
			{ do: "effect", effect: "sparkle" },
			{ do: "wait", seconds: 5 },
		];
		expect(sample(steps, 0.2).effect).toBe("sparkle");
		expect(sample(steps, 4).effect).toBeNull();
		expect(sample(steps, 0, true).effect).toBeNull();
	});

	test("the idle loop repeats and returns home without jumping", () => {
		const timeline = compileLife(
			START,
			{
				idle: [
					{ do: "goTo", to: [1, 0, 0] },
					{ action: "sip", do: "pose" },
					{ do: "wait", seconds: 1 },
				],
				steps: [{ action: "work", do: "pose" }],
			},
			PATHS
		);
		expect(timeline.loopFrom).toBe(0);
		const span = timeline.end - (timeline.loopFrom ?? 0);
		const frame = emptyLifeFrame();
		sampleLife(timeline, span * 3 + 0.01, frame);
		// Wrapped back to the loop's start: home, working again.
		expect(frame.position[0]).toBeLessThan(0.05);
		expect(frame.action).toBe("work");
		sampleLife(timeline, span * 3 + 1 / LIFE_WALK_SPEED + 0.1, frame);
		expect(frame.action).toBe("sip");
	});

	test("reduced motion ignores the idle loop", () => {
		const timeline = compileLife(
			START,
			{
				idle: [{ do: "goTo", to: [2, 0, 0] }],
				steps: [{ action: "work", do: "pose" }],
			},
			PATHS
		);
		const frame = sampleLife(timeline, 50, emptyLifeFrame(), true);
		expect(frame.position).toEqual([0, 0, 0]);
		expect(frame.walking).toBe(false);
	});

	test("a new script continues from wherever the old one was", () => {
		const first = compileLife(START, { steps: FETCH_YOU }, PATHS);
		const legSeconds = 4 / LIFE_WALK_SPEED;
		const midway = lifeStateAt(first, legSeconds / 2);
		expect(midway.position[0]).toBeCloseTo(2);
		expect(midway.item).toEqual(BOX);
		const back = compileLife(
			midway,
			{
				steps: [
					{ do: "goTo", to: "station" },
					{ do: "carry", item: null },
					{ action: "work", do: "pose" },
				],
			},
			PATHS
		);
		const start = sampleLife(back, 0, emptyLifeFrame());
		expect(start.position[0]).toBeCloseTo(2);
		const end = sampleLife(back, 30, emptyLifeFrame());
		expect(end.position).toEqual([0, 0, 0]);
		expect(end.item).toBeNull();
		expect(end.action).toBe("work");
	});
});

describe("meetUp", () => {
	test("both meet halfway, face each other and chat in turn", () => {
		const meeting = meetUp([0, 0, 0], [4, 0, 0], { seconds: 2 });
		expect(meeting.spot).toEqual([2, 0, 0]);
		const a = compileLife({ ...START, action: "idle" }, { steps: meeting.a });
		const b = compileLife(
			{ ...START, action: "idle", position: [4, 0, 0] },
			{ steps: meeting.b }
		);
		const arrive = (2 - LIFE_CHAT_GAP / 2) / LIFE_WALK_SPEED;
		const early = sampleLife(a, arrive + 0.2, emptyLifeFrame());
		const other = sampleLife(b, arrive + 0.2, emptyLifeFrame());
		expect(early.action).toBe("chat");
		expect(other.action).toBe("chat");
		expect(early.bubble).toEqual({ icon: "dots" });
		expect(other.bubble).toBeNull();
		expect(turnBetween(early.yaw, other.yaw + Math.PI)).toBeCloseTo(0);
		const later = sampleLife(b, arrive + 1.4, emptyLifeFrame());
		expect(later.bubble).toEqual({ icon: "dots" });
		expect(sampleLife(a, arrive + 1.4, emptyLifeFrame()).bubble).toBeNull();
	});

	test("the shorter walker waits so they arrive together", () => {
		const meeting = meetUp([0, 0, 0], [4, 0, 0]);
		const waits = meeting.a.filter((step) => step.do === "wait");
		expect(waits[0]).toEqual({ do: "wait", seconds: 0 });
	});

	test("a hand-off passes the item from a to b", () => {
		const item = { shape: "plate" as const };
		const meeting = meetUp([0, 0, 0], [4, 0, 0], { handOff: item });
		const a = compileLife(START, { steps: meeting.a });
		const b = compileLife(
			{ ...START, position: [4, 0, 0] },
			{ steps: meeting.b }
		);
		expect(sampleLife(a, 0.5, emptyLifeFrame()).item).toEqual(item);
		expect(sampleLife(b, 0.5, emptyLifeFrame()).item).toBeNull();
		expect(sampleLife(a, 30, emptyLifeFrame()).item).toBeNull();
		expect(sampleLife(b, 30, emptyLifeFrame()).item).toEqual(item);
	});
});

describe("changedScripts", () => {
	test("reports new and changed keys, not departures", () => {
		const before = new Map([
			["ada", "working"],
			["bo", "working"],
			["cy", "idle"],
		]);
		const after = new Map([
			["ada", "needs-you"],
			["bo", "working"],
			["di", "arrive"],
		]);
		expect(changedScripts(before, after)).toEqual(["ada", "di"]);
	});
});

describe("ambientLife", () => {
	test("is deterministic per seed and stays subtle", () => {
		expect(ambientLife("ada")).toEqual(ambientLife("ada"));
		const steps = ambientLife("ada", { nearby: ["porch"] });
		const waits = steps
			.filter((step) => step.do === "wait")
			.reduce(
				(total, step) => total + (step.do === "wait" ? step.seconds : 0),
				0
			);
		expect(waits).toBeGreaterThan(8);
		expect(steps.some((step) => step.do === "goTo")).toBe(true);
		expect(steps.some((step) => step.do === "say")).toBe(false);
	});
});
