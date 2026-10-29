import { describe, expect, test } from "bun:test";
import {
	agentActs,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceSnapshot,
	unownedAsks,
} from "@ryuhq/protocol/interfaces";
import {
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	usefulStateFixture,
} from "./game-acts-fixture.ts";
import {
	type ActSpots,
	actAnnouncement,
	actKey,
	actLife,
	actOverlays,
	actorTarget,
	actSummaryLine,
	actTotals,
	blockerEntries,
	bubbleOverlayId,
	overlayBudget,
	stageAgents,
	toolForActivity,
	YOU_SLOTS,
	youSpotSlots,
} from "./game3d-acts.ts";
import {
	compileLife,
	emptyLifeFrame,
	type LifePaths,
	sampleLife,
} from "./game3d-life.ts";

const MINUTE = 60_000;

function actsOf(snapshot: InterfaceSnapshot, nowMs = FIXTURE_NOW) {
	return agentActs(snapshot, nowMs, FIXTURE_CLOCK);
}

function byName(
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	name: string
): InterfaceAgentAct {
	const found = [...acts.values()].find((act) => act.agentName === name);
	if (!found) {
		throw new Error(`no act for ${name}`);
	}
	return found;
}

const names = (list: readonly InterfaceAgentAct[]) =>
	list.map((act) => act.agentName);

const PATHS: LifePaths = {
	links: [
		["you", "you-1"],
		["you-1", "you-2"],
		["you-2", "you-3"],
		["you-3", "you-4"],
		["you", "you-tray"],
		["you", "hub"],
		["hub", "station"],
	],
	points: {
		hub: [0, 0, 0],
		station: [4, 0, 0],
		you: [-3, 0, 2],
		"you-1": [-3.6, 0, 2.6],
		"you-2": [-2.6, 0, 2.6],
		"you-3": [-1.6, 0, 2.6],
		"you-4": [-0.6, 0, 2.6],
		"you-tray": [-3, 0, 1.2],
	},
};

const SKIN = { deliverable: { shape: "box" as const } };

function spotsFor(slot: ActSpots["slot"] = null): ActSpots {
	return { paths: PATHS, slot, station: "station" };
}

describe("actLife (test 12)", () => {
	const acts = actsOf(usefulStateFixture());

	test("compiles without WebGL; asking walks to its slot and faces the camera", () => {
		const bo = byName(acts, "Bo");
		const script = actLife(bo, spotsFor("you-1"), SKIN, { reduced: false });
		expect(
			script.steps.some((step) => step.do === "goTo" && step.to === "you-1")
		).toBe(true);
		const timeline = compileLife(
			{ action: "idle", bubble: null, item: null, position: [4, 0, 0], yaw: 0 },
			script,
			PATHS
		);
		const end = sampleLife(timeline, 0, emptyLifeFrame(), true);
		expect(end.position).toEqual([-3.6, 0, 2.6]);
		expect(end.yaw).toBeCloseTo(Math.PI / 4);
		expect(end.bubble?.tone).toBe("ask");
		expect(end.item?.shape).toBe("scroll");
	});

	test("Ada carries a red-sealed letter (destructive approve)", () => {
		const ada = byName(acts, "Ada");
		const script = actLife(ada, spotsFor("you-3"), SKIN, { reduced: true });
		const carry = script.steps.find((step) => step.do === "carry" && step.item);
		expect(carry?.do === "carry" ? carry.item?.shape : null).toBe("letter");
	});

	test("delivering sets the item down at the tray and walks back", () => {
		const gu = byName(acts, "Gu");
		const script = actLife(gu, spotsFor(), SKIN, { reduced: false });
		const steps = script.steps;
		const tray = steps.findIndex(
			(step) => step.do === "goTo" && step.to === "you-tray"
		);
		const drop = steps.findIndex(
			(step, index) => index > tray && step.do === "carry" && step.item === null
		);
		const back = steps.findIndex(
			(step, index) =>
				index > drop && step.do === "goTo" && step.to === "station"
		);
		expect(tray).toBeGreaterThan(-1);
		expect(drop).toBeGreaterThan(tray);
		expect(back).toBeGreaterThan(drop);
		const timeline = compileLife(
			{ action: "idle", bubble: null, item: null, position: [4, 0, 0], yaw: 0 },
			script,
			PATHS
		);
		const end = sampleLife(timeline, 0, emptyLifeFrame(), true);
		expect(end.position).toEqual([4, 0, 0]);
		expect(end.item).toBeNull();
	});

	test("under reduced motion a working act scripts no bubble", () => {
		const cy = byName(acts, "Cy");
		const full = actLife(cy, spotsFor(), SKIN, { reduced: false });
		const reduced = actLife(cy, spotsFor(), SKIN, { reduced: true });
		const says = (steps: typeof full.steps) =>
			steps.filter((step) => step.do === "say" && step.bubble !== null);
		expect(says(full.steps)).toHaveLength(1);
		expect(says(reduced.steps)).toHaveLength(0);
	});

	test("budget items cover every bubble; reduced motion has no work bubbles", () => {
		const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
		const slots = youSpotSlots(acts, unownedAsks(usefulStateFixture()));
		const ids = actOverlays(onStage, slots, offStage).map((item) => item.id);
		const gu = byName(acts, "Gu").agentId;
		const cy = byName(acts, "Cy").agentId;
		expect(ids).toContain(`done:${gu}`);
		expect(ids).toContain(`count:${gu}`);
		expect(ids).toContain(`work:${cy}`);
		const still = actOverlays(onStage, slots, offStage, null, {
			reduced: true,
		}).map((item) => item.id);
		expect(still.some((id) => id.startsWith("work:"))).toBe(false);
		expect(bubbleOverlayId(byName(acts, "Bo"))).toBe(
			`ask:${byName(acts, "Bo").ask?.id ?? ""}`
		);
		expect(bubbleOverlayId(byName(acts, "Di"))).toBeNull();
	});

	test("the key changes only on act, thread, ask or step", () => {
		const cy = byName(acts, "Cy");
		const key = actKey(cy, spotsFor());
		expect(
			actKey(
				{
					...cy,
					bubble: {
						...(cy.bubble ?? { partial: false, tone: "work", text: "" }),
						text: "Editing other.ts",
					},
				},
				spotsFor()
			)
		).toBe(key);
		expect(actKey({ ...cy, elapsed: "13m", timer: null }, spotsFor())).toBe(
			key
		);
		expect(actKey({ ...cy, carry: "run" }, spotsFor())).not.toBe(key);
		expect(actKey({ ...cy, threadId: "other" }, spotsFor())).not.toBe(key);
		expect(actKey({ ...cy, act: "blocked" }, spotsFor())).not.toBe(key);
	});

	test("actorTarget settles at the slot point", () => {
		const bo = byName(acts, "Bo");
		expect(actorTarget(bo, spotsFor("you-1"), true)).toEqual({
			phase: "settled",
			position: [-3.6, 0, 2.6],
		});
		expect(actorTarget(bo, spotsFor("you-1")).phase).toBe("travel");
		const cy = byName(acts, "Cy");
		expect(actorTarget(cy, spotsFor(), true)).toEqual({
			phase: "settled",
			position: [4, 0, 0],
		});
	});

	test("toolForActivity", () => {
		expect(toolForActivity("edit")).toBe("quill");
		expect(toolForActivity("edit", { edit: "hoe" })).toBe("hoe");
		expect(toolForActivity("search")).toBe("lens");
		expect(toolForActivity("nope")).toBeUndefined();
		expect(toolForActivity(null)).toBeUndefined();
	});
});

describe("stageAgents (test 16)", () => {
	const acts = actsOf(usefulStateFixture());

	test("capacity 4: the asking and blocked agents", () => {
		const { offStage, onStage } = stageAgents(acts, 4);
		expect(names(onStage)).toEqual(["Bo", "Ada", "Di", "Ed"]);
		expect(offStage.count).toBe(6);
		expect(offStage.byAct).toEqual({
			delivering: 1,
			idle: 2,
			limited: 1,
			working: 2,
		});
	});

	test("capacity 6 adds Fa and Cy; picks only reorder within an act", () => {
		expect(names(stageAgents(acts, 6).onStage)).toEqual([
			"Bo",
			"Ada",
			"Di",
			"Ed",
			"Fa",
			"Cy",
		]);
		const ha = byName(acts, "Ha").agentId;
		expect(names(stageAgents(acts, 6, [ha]).onStage)).toEqual([
			"Bo",
			"Ada",
			"Di",
			"Ed",
			"Fa",
			"Cy",
		]);
		const io = byName(acts, "Io").agentId;
		expect(names(stageAgents(acts, 6, [io]).onStage)).toEqual([
			"Bo",
			"Ada",
			"Di",
			"Ed",
			"Fa",
			"Io",
		]);
	});

	test("capacity 9, and a pick among idle agents", () => {
		expect(names(stageAgents(acts, 9).onStage)).toEqual([
			"Bo",
			"Ada",
			"Di",
			"Ed",
			"Fa",
			"Cy",
			"Io",
			"Gu",
			"Ha",
		]);
		const ju = byName(acts, "Ju").agentId;
		expect(names(stageAgents(acts, 9, [ju]).onStage)).toEqual([
			"Bo",
			"Ada",
			"Di",
			"Ed",
			"Fa",
			"Cy",
			"Io",
			"Gu",
			"Ju",
		]);
		expect(stageAgents(acts, Number.POSITIVE_INFINITY).offStage.count).toBe(0);
	});
});

function needYou(snapshot: InterfaceSnapshot): number {
	return (snapshot.asks ?? []).filter((ask) => ask.blocking).length;
}

describe("youSpotSlots (test 17)", () => {
	test("default fixture: Bo, the notice, Ada; no suggestion", () => {
		const snapshot = usefulStateFixture();
		const acts = actsOf(snapshot);
		const unowned = unownedAsks(snapshot);
		expect(unowned.map((ask) => ask.id)).toEqual(["approval:wf-deploy"]);
		const { overflow, slots } = youSpotSlots(acts, unowned);
		expect(
			slots.map((slot) => [slot.point, slot.carrier, slot.ask.id])
		).toEqual([
			["you-1", "villager", byName(acts, "Bo").ask?.id ?? ""],
			["you-2", "notice", "approval:wf-deploy"],
			["you-3", "villager", byName(acts, "Ada").ask?.id ?? ""],
		]);
		expect(overflow).toBe(0);
		expect(slots.some((slot) => slot.ask.id === "approval:heal-digest")).toBe(
			false
		);
	});

	test("live permission: Ada's permission, Bo, the gate, Ada's parked call", () => {
		const snapshot = usefulStateFixture({ livePermission: true });
		const acts = actsOf(snapshot);
		const unowned = unownedAsks(snapshot);
		const { overflow, slots } = youSpotSlots(acts, unowned);
		expect(
			slots.map((slot) => [
				slot.point,
				slot.carrier,
				slot.agentId === null
					? null
					: byName(acts, "Ada").agentId === slot.agentId
						? "Ada"
						: "Bo",
			])
		).toEqual([
			["you-1", "villager", "Ada"],
			["you-2", "villager", "Bo"],
			["you-3", "notice", null],
			["you-4", "notice", "Ada"],
		]);
		expect(slots[0]?.ask.id).toBe("permission:req-1");
		expect(overflow).toBe(0);
		expect(slots.length + overflow).toBe(needYou(snapshot));
		expect(needYou(snapshot)).toBe(4);
	});

	test("one more unowned blocking ask overflows into the tally", () => {
		const snapshot = usefulStateFixture({ livePermission: true });
		const extra: InterfaceAsk = {
			agentId: null,
			blocking: true,
			holdsRun: true,
			id: "approval:wf-extra",
			kind: "approval",
			since: new Date(FIXTURE_NOW - 30 * MINUTE).toISOString(),
			source: "approvals",
			text: "Workflow gate: Extra",
			threadId: null,
		};
		const withExtra = { ...snapshot, asks: [...(snapshot.asks ?? []), extra] };
		const acts = actsOf(withExtra);
		const { overflow, slots } = youSpotSlots(acts, unownedAsks(withExtra));
		expect(slots).toHaveLength(4);
		expect(overflow).toBe(1);
		expect(slots.length + overflow).toBe(needYou(withExtra));
	});

	test("the invariant holds on every fixture variant, off-stage asks included", () => {
		const variants = [
			usefulStateFixture(),
			usefulStateFixture({ livePermission: true }),
			usefulStateFixture({ privacy: "redacted" }),
			usefulStateFixture({ privacy: "redacted", livePermission: true }),
		];
		for (const snapshot of variants) {
			const acts = actsOf(snapshot);
			const unowned = unownedAsks(snapshot);
			for (const capacity of [0, 1, 4, 6, 10]) {
				const { onStage } = stageAgents(acts, capacity);
				const { overflow, slots } = youSpotSlots(
					acts,
					unowned,
					onStage.map((act) => act.agentId)
				);
				expect(slots.length + overflow).toBe(needYou(snapshot));
				expect(slots.length).toBeLessThanOrEqual(YOU_SLOTS.length);
			}
		}
	});
});

describe("actTotals and actSummaryLine (test 18)", () => {
	test("the default fixture", () => {
		const snapshot = usefulStateFixture();
		const totals = actTotals(snapshot, actsOf(snapshot));
		expect(totals).toEqual({
			failed: 1,
			limited: 1,
			needYou: 3,
			queue: 9,
			stalled: 0,
			working: 2,
		});
		expect(actSummaryLine(totals)).toBe(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
	});

	test("live permission counts Ada twice", () => {
		const snapshot = usefulStateFixture({ livePermission: true });
		expect(actTotals(snapshot, actsOf(snapshot)).needYou).toBe(4);
	});

	test("zero and stalled lines", () => {
		const zero = {
			failed: 0,
			limited: 0,
			needYou: 0,
			queue: 0,
			stalled: 0,
			working: 0,
		};
		expect(actSummaryLine(zero)).toBe("Nothing running");
		expect(
			actSummaryLine({ ...zero, needYou: 3, stalled: 1, working: 1 })
		).toBe("3 need you · 1 working · 1 stalled?");
	});
});

describe("blockerEntries", () => {
	test("every counted blocker with its thread, newest first", () => {
		const snapshot = usefulStateFixture();
		const entries = blockerEntries(snapshot, actsOf(snapshot));
		expect(
			entries.map((entry) => [entry.agentName, entry.blocker.title])
		).toEqual([
			["Di", "Tests failed"],
			["Ed", "Interrupted"],
			["Di", "Nightly backup failed"],
		]);
	});
});

describe("actAnnouncement (test 13c)", () => {
	function step(
		prev: ReturnType<typeof actAnnouncement>["state"] | null,
		snapshot: InterfaceSnapshot,
		nowMs = FIXTURE_NOW
	) {
		const acts = actsOf(snapshot, nowMs);
		return actAnnouncement(
			prev,
			acts,
			unownedAsks(snapshot),
			snapshot,
			nowMs,
			snapshot.privacy ?? "full"
		);
	}

	const full = usefulStateFixture();
	const boAsk = (full.asks ?? []).find((ask) => ask.kind === "question");
	const diThread = full.threads.find(
		(thread) => thread.blocker?.title === "Tests failed"
	);

	function without(snapshot: InterfaceSnapshot): InterfaceSnapshot {
		return {
			...snapshot,
			asks: (snapshot.asks ?? []).filter((ask) => ask.id !== boAsk?.id),
			threads: snapshot.threads.map((thread) =>
				thread.id === diThread?.id ? { ...thread, blocker: null } : thread
			),
		};
	}

	test("silent on the first call", () => {
		expect(step(null, full).sentence).toBeNull();
	});

	test("a new ask and a new blocker give one sentence, no expiry clause", () => {
		const first = step(null, without(full));
		const next = step(first.state, full);
		expect(next.sentence).toBe("Bo asks: Which DB to use?; Di: Tests failed");
		expect(step(next.state, full).sentence).toBeNull();
	});

	test("an ask crossing into its last 2 minutes is announced from the clock alone", () => {
		const first = step(null, full);
		const later = FIXTURE_NOW + 5 * MINUTE + 30_000;
		const next = step(first.state, full, later);
		expect(next.sentence).toBe("Bo's ask expires soon");
		expect(step(next.state, full, later + 1000).sentence).toBeNull();
	});

	test("an ask first seen already expiring is announced once, as new", () => {
		const first = step(null, without(full));
		const late = FIXTURE_NOW + 6 * MINUTE;
		const next = step(first.state, full, late);
		expect(next.sentence?.startsWith("Bo asks: Which DB to use?")).toBe(true);
		expect(next.sentence).not.toContain("expires soon");
		expect(step(next.state, full, late + 1000).sentence).toBeNull();
	});

	test("a hydration upgrade of the same failure is not announced again", () => {
		const summary: InterfaceSnapshot = {
			...full,
			threads: full.threads.map((thread) =>
				thread.id === diThread?.id
					? {
							...thread,
							blocker: {
								at: null,
								kind: "error",
								source: "run-stream",
								title: "Run failed",
							},
						}
					: thread
			),
		};
		const first = step(null, summary);
		expect(step(first.state, full).sentence).toBeNull();
		// It runs again, then fails again: announced again.
		const running: InterfaceSnapshot = {
			...full,
			threads: full.threads.map((thread) =>
				thread.id === diThread?.id
					? { ...thread, blocker: null, running: true }
					: thread
			),
		};
		const ran = step(first.state, running);
		expect(step(ran.state, full).sentence).toContain("Di: Tests failed");
	});

	test("more than 3 events give +N more; suggestions and replies never speak", () => {
		const empty: InterfaceSnapshot = {
			...full,
			asks: [],
			threads: full.threads.map((thread) => ({ ...thread, blocker: null })),
		};
		const first = step(null, empty);
		const next = step(first.state, full);
		expect(next.sentence).toMatch(/; \+\d more$/);
		expect(next.sentence).not.toContain("Ha");
		expect(next.sentence).not.toContain("Gu");
	});

	test("kind words only when redacted, even on a full snapshot", () => {
		const acts = actsOf(full);
		const unowned = unownedAsks(full);
		const first = actAnnouncement(
			null,
			actsOf(without(full)),
			unowned,
			without(full),
			FIXTURE_NOW,
			"redacted"
		);
		const next = actAnnouncement(
			first.state,
			acts,
			unowned,
			full,
			FIXTURE_NOW,
			"redacted"
		);
		expect(next.sentence).toBe("Bo asks: Question for you; Di: Failed");
		expect(next.sentence).not.toContain("Which DB");
		expect(next.sentence).not.toContain("Tests failed");
	});
});

describe("overlayBudget (test 21)", () => {
	const snapshot = usefulStateFixture();
	const acts = actsOf(snapshot);
	const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
	const slots = youSpotSlots(acts, unownedAsks(snapshot));
	const items = actOverlays(
		onStage,
		slots,
		offStage,
		byName(acts, "Cy").agentId
	);

	test("1280: everything budgeted fits in 16", () => {
		const budget = overlayBudget(1280, { domTargets: true });
		const chosen = budget.fill(items);
		expect(chosen.size).toBeLessThanOrEqual(16);
		// Nothing the fixture asks for is dropped at desktop width.
		expect(chosen.size).toBe(items.length);
		expect(budget.iconOnly).toBe(false);
		expect([...chosen].some((id) => id.startsWith("ask:"))).toBe(true);
	});

	test("390: at most 8, limits kept, no ask bubbles; plates collapse for DOM games", () => {
		const budget = overlayBudget(390, { domTargets: true });
		const chosen = budget.fill(items);
		expect(chosen.size).toBeLessThanOrEqual(8);
		expect(chosen.has(`limit:${byName(acts, "Fa").agentId}`)).toBe(true);
		expect([...chosen].some((id) => id.startsWith("ask:"))).toBe(false);
		expect(budget.iconOnly).toBe(true);
		// Pointer-only stages collapse too; their plates are just not keyboard targets.
		const pointer = overlayBudget(390, { domTargets: false });
		expect(pointer.iconOnly).toBe(true);
		expect(pointer.focusable).toBe(false);
		expect(budget.focusable).toBe(true);
	});

	test("a cramped stage halves the cap again and drops Next lines first", () => {
		const items = [
			{ id: "next:ada", kind: "text" as const },
			{ id: "next:bo", kind: "text" as const },
			...Array.from({ length: 6 }, (_, index) => ({
				id: `progress:${index}`,
				kind: "text" as const,
			})),
		];
		const roomy = overlayBudget(390, { domTargets: true, height: 780 });
		const squeezed = overlayBudget(390, { domTargets: true, height: 300 });
		expect(roomy.cramped).toBe(false);
		expect(squeezed.cramped).toBe(true);
		expect(roomy.fill(items).size).toBe(8);
		const chosen = squeezed.fill(items);
		expect(chosen.size).toBe(4);
		expect([...chosen].some((id) => id.startsWith("next:"))).toBe(false);
		// Without a height, as before.
		expect(overlayBudget(390, { domTargets: true }).fill(items)).toEqual(
			roomy.fill(items)
		);
		expect(overlayBudget(1280, { domTargets: true, height: 300 }).cap).toBe(8);
	});

	test("tallies come first", () => {
		const budget = overlayBudget(390, { domTargets: true });
		const many = [
			...Array.from({ length: 12 }, (_, index) => ({
				id: `t${index}`,
				kind: "text" as const,
			})),
			{ id: "tally:off", kind: "tally" as const },
		];
		const chosen = budget.fill(many);
		expect(chosen.has("tally:off")).toBe(true);
		expect(chosen.size).toBe(8);
	});
});
