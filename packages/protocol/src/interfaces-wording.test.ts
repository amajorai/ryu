import { describe, expect, test } from "bun:test";
import {
	askAriaLabel,
	askBubble,
	blockerAriaLabel,
	estimateProgress,
	type InterfaceBlocker,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	isSuggestion,
	medianRunMs,
	riskTagLabel,
	shortLine,
	stepKindForTool,
	unownedAsks,
	waitLabel,
} from "./interfaces.ts";
import {
	FIXTURE_ASK_IDS,
	FIXTURE_CLOCK,
	FIXTURE_THREAD_IDS,
	usefulStateFixture,
} from "./interfaces-fixture.ts";
import {
	actOf,
	actsOf,
	askOf,
	at,
	HOUR,
	MINUTE,
	makeAsk,
	miniSnapshot,
	NOW,
	thread,
} from "./interfaces-test-fixtures.ts";

describe("wording helpers (test 4)", () => {
	test("shortLine keeps at most 5 words and leads with a verb for tool labels", () => {
		expect(shortLine("one two three four five six seven")).toBe(
			"one two three four five…"
		);
		expect(shortLine("Bash: bun test")).toBe("Running bun test");
		expect(shortLine("Edit: snapshot.ts")).toBe("Editing snapshot.ts");
		expect(shortLine("a b c d e f", 3)).toBe("a b c…");
	});

	test("askBubble", () => {
		const fixture = usefulStateFixture();
		const ada = askOf(fixture, FIXTURE_ASK_IDS.adaToolCall);
		expect(askBubble(ada)).toBe("Run deploy.sh?");
		expect(askBubble({ ...ada, target: null })).toBe(
			"Can I run shell.run now?"
		);
		expect(askBubble(ada, "redacted")).toBe("Needs approval");
		expect(
			askBubble(askOf(fixture, FIXTURE_ASK_IDS.boQuestion), "redacted")
		).toBe("Question for you");
		for (const ask of fixture.asks ?? []) {
			const owner = fixture.threads.find((item) => item.id === ask.threadId);
			expect(askBubble(ask).split(" ").length).toBeLessThanOrEqual(5);
			expect(askBubble(ask)).not.toBe(owner?.lastMessage ?? "");
		}
	});

	test("askAriaLabel phrasings", () => {
		const fixture = usefulStateFixture({ livePermission: true });
		const ask = (id: string) => askOf(fixture, id);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.adaToolCall), "Ada", NOW)).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.boQuestion), "Bo", NOW)).toBe(
			"Bo asks: Which DB to use? Waited 3 minutes. Expires within 7 minutes."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.workflowGate), null, NOW)).toBe(
			"Inbox asks: Workflow gate: Deploy. Waited 20 minutes. Risk: workflow."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.adaPermission), "Ada", NOW)).toBe(
			"Ada asks: Allow Edit deploy.sh? Waited about 7 minutes. Expires within 3 minutes."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.guReply), "Gu", NOW)).toBe(
			"Gu has an answer ready: Edited 3 files. Waiting 40 minutes."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.juReply), "Ju", NOW)).toBe(
			"Ju has an answer ready: Here is the weekly report summary you asked for. Waiting about 1 day."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.haHeal), "Ha", NOW)).toBe(
			"Ha suggests: Apply the fix for Daily digest? Waiting 2 hours."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.haHeal), null, NOW)).toBe(
			"Inbox suggests: Apply the fix for Daily digest? Waiting 2 hours."
		);
		expect(
			askAriaLabel(ask(FIXTURE_ASK_IDS.adaToolCall), "Ada", NOW, "redacted")
		).toBe("Ada asks: Needs approval. Waited 14 minutes. Risk: run.");
		expect(
			askAriaLabel(ask(FIXTURE_ASK_IDS.adaPermission), "Ada", NOW)
		).not.toBe(askAriaLabel(ask(FIXTURE_ASK_IDS.adaToolCall), "Ada", NOW));
	});

	test("blockerAriaLabel", () => {
		const di = actOf(actsOf(), "di").blockers[0] as InterfaceBlocker;
		const ed = actOf(actsOf(), "ed").blockers[0] as InterfaceBlocker;
		expect(blockerAriaLabel(di, "Di", NOW)).toBe(
			"Di stopped: Tests failed, 20 minutes ago."
		);
		expect(blockerAriaLabel(ed, "Ed", NOW)).toBe(
			"Ed stopped: Interrupted, about 1 hour ago."
		);
		expect(blockerAriaLabel({ ...di, at: null }, "Di", NOW)).toBe(
			"Di stopped: Tests failed."
		);
		expect(blockerAriaLabel(di, "Di", NOW, "redacted")).toBe(
			"Di stopped: Failed, 20 minutes ago."
		);
		expect(
			blockerAriaLabel(
				{
					at: at(NOW - HOUR),
					atApprox: true,
					clearsAt: "2026-10-16T15:10:00Z",
					kind: "rate-limited",
					source: "estimate",
					title: "Limit hit",
				},
				"Fa",
				NOW,
				"full",
				FIXTURE_CLOCK
			)
		).toBe("Fa stopped, likely limit hit, about 1 hour ago. Clears 15:10.");
	});

	test("riskTagLabel", () => {
		expect(riskTagLabel("force_push")).toBe("force push");
		expect(riskTagLabel("agent-configuration")).toBe("agent configuration");
		expect(riskTagLabel("a__b--c")).toBe("a b c");
	});
});

describe("stepKindForTool (test 5)", () => {
	test("canonical tool names and ACP kinds", () => {
		const table: [string | null, string | null, string][] = [
			["Bash", null, "run"],
			["Read", null, "read"],
			["Write", null, "write"],
			["Edit", null, "edit"],
			["MultiEdit", null, "edit"],
			["Grep", null, "search"],
			["Glob", null, "read"],
			["WebFetch", null, "web"],
			["WebSearch", null, "search"],
			["TodoWrite", null, "plan"],
			["Thinking", null, "think"],
			["Question", null, "ask"],
			["AskUserQuestion", null, "ask"],
			["Task", null, "delegate"],
			["threads.create_thread", null, "delegate"],
			["send_message_to_thread", null, "delegate"],
			["acp-plan", null, "plan"],
			["mcp__browser__navigate", null, "web"],
			[null, "read", "read"],
			[null, "edit", "edit"],
			[null, "delete", "edit"],
			[null, "move", "edit"],
			[null, "execute", "run"],
			[null, "search", "search"],
			[null, "fetch", "web"],
			["mcp__github__create_pull_request", null, "tool"],
			["SomethingNew", "other", "tool"],
			[null, null, "tool"],
		];
		for (const [tool, acp, kind] of table) {
			expect(stepKindForTool(tool, acp)).toBe(
				kind as ReturnType<typeof stepKindForTool>
			);
		}
	});
});

describe("medianRunMs and estimateProgress (test 6)", () => {
	const events = usefulStateFixture().events as InterfaceEvent[];

	test("per routine, raw, and null without history", () => {
		expect(medianRunMs(events, { jobId: "job-login" })).toBe(20 * MINUTE);
		expect(medianRunMs(events, { jobId: "job-unknown" })).toBeNull();
		expect(medianRunMs(undefined, { jobId: "job-login" })).toBeNull();
		// agentId alone pools both of Io's routines (the legacy callers).
		expect(medianRunMs(events, { agentId: "io" })).toBe(
			(20 * MINUTE + 2 * HOUR) / 2
		);
	});

	test("Io's estimate uses its own routine from the fire time", () => {
		const fixture = usefulStateFixture();
		const io = fixture.threads.find(
			(item) => item.id === FIXTURE_THREAD_IDS.io
		) as InterfaceThread;
		const progress = estimateProgress(io, NOW, events);
		expect(progress?.kind).toBe("estimate");
		expect((progress?.done ?? 0) / (progress?.total ?? 1)).toBeCloseTo(0.75);
		const late = estimateProgress(io, NOW + 3 * HOUR, events);
		expect((late?.done ?? 0) / (late?.total ?? 1)).toBeCloseTo(0.94);
		const cy = fixture.threads.find(
			(item) => item.id === FIXTURE_THREAD_IDS.cy
		) as InterfaceThread;
		expect(estimateProgress(cy, NOW, events)).toBeNull();
		expect(estimateProgress(io, NOW, [])).toBeNull();
		expect(actOf(actsOf(fixture), "io").progress?.kind).toBe("estimate");
	});
});

describe("ownership and the need-you count (tests 17, 18)", () => {
	test("unownedAsks returns the workflow gate, plus an ask whose agent is unknown", () => {
		const fixture = usefulStateFixture();
		expect(unownedAsks(fixture).map((ask) => ask.id)).toEqual([
			FIXTURE_ASK_IDS.workflowGate,
		]);
		const ghost = makeAsk({
			agentId: "ghost",
			id: "approval:ghost",
			since: at(NOW - MINUTE),
		});
		const variant = { ...fixture, asks: [...(fixture.asks ?? []), ghost] };
		expect(unownedAsks(variant).map((ask) => ask.id)).toEqual([
			FIXTURE_ASK_IDS.workflowGate,
			"approval:ghost",
		]);
		expect((variant.asks ?? []).filter((ask) => ask.blocking)).toHaveLength(4);
	});

	test("an ask with an unknown agent falls back to its thread's agent", () => {
		const ask = makeAsk({ agentId: "ghost", id: "approval:t", threadId: "t" });
		const snap = miniSnapshot(
			["x"],
			[thread({ agentIds: ["x"], id: "t", updatedAt: at(NOW) })],
			[ask]
		);
		expect(unownedAsks(snap)).toEqual([]);
		expect(actOf(actsOf(snap), "x").ask?.id).toBe("approval:t");
	});

	test("needYou counts blocking asks only", () => {
		const blocking = (fixture: InterfaceSnapshot) =>
			(fixture.asks ?? []).filter((ask) => ask.blocking).length;
		expect(blocking(usefulStateFixture())).toBe(3);
		expect(blocking(usefulStateFixture({ livePermission: true }))).toBe(4);
		expect(
			isSuggestion(askOf(usefulStateFixture(), FIXTURE_ASK_IDS.haHeal))
		).toBe(true);
		expect(
			isSuggestion(askOf(usefulStateFixture(), FIXTURE_ASK_IDS.guReply))
		).toBe(false);
	});
});

describe("review follow-ups", () => {
	test("questions and titles that start with a tool name keep their first word", () => {
		for (const text of [
			"Write tests first?",
			"Read the spec now?",
			"Edit the config?",
			"Task list looks right?",
		]) {
			expect(shortLine(text)).toBe(text);
			expect(
				askBubble(makeAsk({ id: "approval:q", subject: "heal_fix", text }))
			).toBe(text);
		}
		const blockerTitle = {
			at: null,
			kind: "tool-failed" as const,
			source: "messages" as const,
			title: "Read failed",
		};
		const acts = actsOf(
			miniSnapshot(
				["x"],
				[
					thread({
						agentIds: ["x"],
						blocker: blockerTitle,
						id: "f",
						runState: "failed",
						updatedAt: at(NOW),
					}),
				]
			)
		);
		expect(actOf(acts, "x").bubble?.text).toBe("Read failed");
	});

	test("identifiers and globs keep their markers in names and bubbles", () => {
		for (const target of ["__init__.py", "a*b*c", "**/*.ts"]) {
			const ask = makeAsk({
				agentId: "x",
				id: "approval:t",
				subject: "tool_call",
				target,
				text: "Can I run `shell.run` now?",
			});
			expect(askBubble(ask)).toBe(`Run ${target}?`);
			expect(askAriaLabel(ask, "X", NOW)).toContain(`Target: ${target}.`);
		}
		expect(shortLine("Ship **now** please")).toBe("Ship now please");
	});

	test("countdowns round up whole hours and days", () => {
		expect(
			waitLabel(null, NOW, {
				long: true,
				until: at(NOW + 119 * MINUTE),
				untilApprox: true,
			})
		).toBe("within 2 hours");
		expect(waitLabel(null, NOW, { until: at(NOW + 25 * HOUR) })).toBe("in 2d");
		expect(
			waitLabel(null, NOW, { until: at(NOW + 23 * HOUR + 30 * MINUTE) })
		).toBe("in 1d");
		expect(waitLabel(at(NOW - 119 * MINUTE), NOW, { long: true })).toBe(
			"1 hour"
		);
	});

	test("a likely blocker keeps an acronym's capitals", () => {
		expect(
			blockerAriaLabel(
				{
					at: null,
					kind: "rate-limited",
					source: "estimate",
					title: "API key expired",
				},
				"X",
				NOW
			)
		).toBe("X stopped, likely API key expired.");
	});

	test("redacted ask names say the kind once", () => {
		const fixture = usefulStateFixture({ privacy: "redacted" });
		expect(
			askAriaLabel(
				askOf(fixture, FIXTURE_ASK_IDS.guReply),
				"Gu",
				NOW,
				"redacted"
			)
		).toBe("Gu has an answer ready. Waiting 40 minutes.");
		expect(
			askAriaLabel(
				askOf(fixture, FIXTURE_ASK_IDS.haHeal),
				"Ha",
				NOW,
				"redacted"
			)
		).toBe("Ha has a suggestion. Waiting 2 hours.");
	});

	test("helpers are named only while some run", () => {
		const acts = actsOf(
			miniSnapshot(
				["x"],
				[
					thread({
						agentIds: ["x"],
						helpers: { done: 1, failed: 1, running: 0, titles: [] },
						id: "t",
						updatedAt: at(NOW),
					}),
				]
			)
		);
		expect(actOf(acts, "x").ariaLabel).toBe("X is idle.");
	});

	test("a shared running thread keeps every member working; a stopped one counts once", () => {
		const own = thread({
			agentIds: ["a"],
			id: "own-a",
			running: true,
			updatedAt: at(NOW),
		});
		const team = thread({
			agentIds: ["a", "b"],
			id: "team",
			running: true,
			updatedAt: at(NOW - MINUTE),
		});
		const snap = miniSnapshot(["a", "b"], [own, team]);
		snap.agents = snap.agents.map((agent) => ({ ...agent, status: "working" }));
		const acts = actsOf(snap);
		expect(actOf(acts, "a").act).toBe("working");
		expect(actOf(acts, "b")).toMatchObject({
			act: "working",
			threadId: "team",
		});
		expect(actOf(acts, "b").ariaLabel).toBe("B is working on team.");
		const failed = thread({
			agentIds: ["a", "b"],
			blocker: {
				at: at(NOW - MINUTE),
				kind: "error",
				source: "messages",
				title: "Broke",
			},
			id: "team",
			runState: "failed",
			updatedAt: at(NOW - MINUTE),
		});
		const stopped = actsOf(miniSnapshot(["a", "b"], [own, failed]));
		expect(actOf(stopped, "a")).toMatchObject({ act: "working" });
		expect(actOf(stopped, "a").pending.blocked).toBe(1);
		expect(actOf(stopped, "b")).toMatchObject({
			act: "idle",
			blockers: [],
			threadId: "team",
		});
	});
});
