import { describe, expect, test } from "bun:test";
import {
	askAriaLabel,
	clockLabel,
	compareAsks,
	type InterfaceAsk,
	type InterfaceSnapshot,
	isSuggestion,
	waitBand,
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
	DAY,
	HOUR,
	MINUTE,
	makeAsk,
	miniSnapshot,
	NOW,
	thread,
	withThread,
} from "./interfaces-test-fixtures.ts";

describe("agentActs priority table (test 1)", () => {
	test("each fixture agent gets its act", () => {
		const acts = actsOf();
		expect(
			Object.fromEntries([...acts].map(([id, item]) => [id, item.act]))
		).toEqual({
			ada: "asking",
			bo: "asking",
			cy: "working",
			di: "blocked",
			ed: "blocked",
			fa: "limited",
			gu: "delivering",
			ha: "idle",
			io: "working",
			ju: "idle",
		});
	});

	test("Ha is idle with one old failure and one suggestion that is never parked", () => {
		const ha = actOf(actsOf(), "ha");
		expect(ha.pending).toEqual({
			asks: 0,
			blocked: 0,
			old: 1,
			suggestions: 1,
			unread: 0,
		});
		expect(ha.blockers).toEqual([]);
		expect(ha.parkedAsks).toEqual([]);
		expect(ha.suggestions.map((ask) => ask.id)).toEqual([
			FIXTURE_ASK_IDS.haHeal,
		]);
		expect(ha.bubble).toBeNull();
	});

	test("Ju's reply older than 24 h does not walk", () => {
		const ju = actOf(actsOf(), "ju");
		expect(ju.act).toBe("idle");
		expect(ju.pending.unread).toBe(1);
		expect(ju.ask).toBeNull();
	});

	test("Ha's read answer yields no ask, and Gu's thread yields exactly one item", () => {
		const fixture = usefulStateFixture();
		expect(
			fixture.asks?.filter((ask) => ask.threadId === FIXTURE_THREAD_IDS.ha)
		).toEqual([]);
		expect(
			fixture.asks?.filter((ask) => ask.threadId === FIXTURE_THREAD_IDS.gu)
		).toHaveLength(1);
		const gu = actOf(actsOf(fixture), "gu");
		expect(gu.ask?.id).toBe(FIXTURE_ASK_IDS.guReply);
		expect(gu.carry).toBe("deliverable");
		expect(gu.pending.unread).toBe(0);
		expect(gu.bubble).toEqual({
			partial: false,
			text: "3 files edited",
			tone: "done",
		});
	});

	test("Di's focus is the newest counted failure", () => {
		const di = actOf(actsOf(), "di");
		expect(di.blockers.map((blocker) => blocker.title)).toEqual([
			"Tests failed",
			"Nightly backup failed",
		]);
		expect(di.pending.blocked).toBe(1);
		expect(di.threadId).toBe(FIXTURE_THREAD_IDS.di);
		expect(di.bubble).toEqual({
			partial: false,
			text: "Tests failed",
			tone: "error",
		});
	});

	test("a shared team thread produces exactly one act", () => {
		const shared = thread({
			agentIds: ["x", "y"],
			blocker: {
				at: at(NOW - 5 * MINUTE),
				kind: "error",
				source: "messages",
				title: "Broke",
			},
			id: "team-thread",
			runState: "failed",
			updatedAt: at(NOW - 5 * MINUTE),
		});
		const acts = actsOf(miniSnapshot(["x", "y"], [shared]));
		expect(actOf(acts, "x").act).toBe("blocked");
		expect(actOf(acts, "y").act).toBe("idle");
		expect(actOf(acts, "y").blockers).toEqual([]);
	});

	test("a running agent with a recent failed thread is working with that failure pending", () => {
		const acts = actsOf(
			miniSnapshot(
				["x"],
				[
					thread({
						agentIds: ["x"],
						id: "live",
						running: true,
						updatedAt: at(NOW),
					}),
					thread({
						agentIds: ["x"],
						blocker: {
							at: at(NOW - 10 * MINUTE),
							kind: "tool-failed",
							source: "messages",
							title: "Edit failed",
						},
						id: "broken",
						runState: "failed",
						updatedAt: at(NOW - 10 * MINUTE),
					}),
				]
			)
		);
		const x = actOf(acts, "x");
		expect(x.act).toBe("working");
		expect(x.pending.blocked).toBe(1);
		expect(x.blockers).toHaveLength(1);
		expect(x.threadId).toBe("live");
	});

	test("a tool_call approval on a running agent is parked, not carried", () => {
		const toolCall = makeAsk({
			agentId: "x",
			holdsRun: false,
			id: "approval:t",
			since: at(NOW - 2 * MINUTE),
			subject: "tool_call",
			text: "Can I run `shell.run` now?",
			threadId: "live",
		});
		const acts = actsOf(
			miniSnapshot(
				["x"],
				[
					thread({
						agentIds: ["x"],
						id: "live",
						running: true,
						updatedAt: at(NOW),
					}),
				],
				[toolCall]
			)
		);
		const x = actOf(acts, "x");
		expect(x.act).toBe("working");
		expect(x.ask).toBeNull();
		expect(x.parkedAsks).toEqual([toolCall]);
		expect(x.pending.asks).toBe(1);
		expect(x.ariaLabel).toContain(" Ask waiting: Can I run shell.run now?");
		expect(x.ariaLabel).not.toContain("more asks");
	});

	test("Bo's blocking question holds its run, so Bo is asking", () => {
		const bo = actOf(actsOf(), "bo");
		expect(bo.act).toBe("asking");
		expect(bo.ask?.id).toBe(FIXTURE_ASK_IDS.boQuestion);
		expect(bo.carry).toBe("question");
		expect(bo.timer).toEqual({
			approx: false,
			since: at(NOW - 3 * MINUTE),
			until: at(NOW + 7 * MINUTE),
			untilApprox: true,
		});
		expect(bo.bubble).toEqual({
			partial: false,
			text: "Which DB to use?",
			tone: "ask",
		});
	});

	test("Bo's deferred question is a suggestion and Bo keeps working", () => {
		const fixture = usefulStateFixture();
		const deferred = fixture.asks?.map((ask): InterfaceAsk => {
			if (ask.id !== FIXTURE_ASK_IDS.boQuestion) {
				return ask;
			}
			const {
				choices: _choices,
				expiresAt: _expiresAt,
				expiresApprox: _approx,
				...rest
			} = ask;
			return { ...rest, blocking: false, holdsRun: false };
		});
		const variant = { ...fixture, asks: deferred };
		const bo = actOf(actsOf(variant), "bo");
		expect(bo.act).toBe("working");
		expect(bo.pending.suggestions).toBe(1);
		expect(bo.parkedAsks).toEqual([]);
		const ask = askOf(variant, FIXTURE_ASK_IDS.boQuestion);
		expect(isSuggestion(ask)).toBe(true);
		expect(askAriaLabel(ask, "Bo", NOW)).toBe(
			"Bo has a question when you have time: Which DB to use? Waiting 3 minutes."
		);
	});

	test("with livePermission Ada carries the permission and parks the tool_call", () => {
		const ada = actOf(
			actsOf(usefulStateFixture({ livePermission: true })),
			"ada"
		);
		expect(ada.act).toBe("asking");
		expect(ada.ask?.id).toBe(FIXTURE_ASK_IDS.adaPermission);
		expect(ada.parkedAsks.map((ask) => ask.id)).toEqual([
			FIXTURE_ASK_IDS.adaToolCall,
		]);
		expect(ada.pending.asks).toBe(1);
		expect(ada.carry).toBe("approval");
		expect(ada.ariaLabel).toContain(" Ask waiting: Can I run shell.run now?");
	});

	test("the blocker counting rule", () => {
		const old = (unread: number, blockerAt: string | null, updatedAt: string) =>
			actOf(
				actsOf(
					miniSnapshot(
						["x"],
						[
							thread({
								agentIds: ["x"],
								blocker: {
									at: blockerAt,
									kind: "error",
									source: "run-stream",
									title: "Run failed",
								},
								id: "f",
								runState: "failed",
								unread,
								updatedAt,
							}),
						]
					)
				),
				"x"
			);
		const dayAgo = at(NOW - 25 * HOUR);
		expect(old(1, dayAgo, dayAgo).act).toBe("blocked");
		expect(old(0, dayAgo, dayAgo).act).toBe("idle");
		expect(old(0, dayAgo, dayAgo).pending.old).toBe(1);
		expect(old(0, null, at(NOW - 2 * HOUR)).act).toBe("blocked");
		expect(old(0, null, dayAgo).pending.old).toBe(1);
		// A recent `at` counts even when the thread moved long ago.
		expect(old(0, at(NOW - HOUR), dayAgo).act).toBe("blocked");
	});

	test("the workflow gate produces no act", () => {
		const acts = actsOf();
		expect(acts.size).toBe(10);
		for (const item of acts.values()) {
			expect(item.ask?.id).not.toBe(FIXTURE_ASK_IDS.workflowGate);
			expect(item.parkedAsks.map((ask) => ask.id)).not.toContain(
				FIXTURE_ASK_IDS.workflowGate
			);
		}
	});

	test("elapsed only for an exact run start", () => {
		const acts = actsOf();
		expect(actOf(acts, "cy").elapsed).toBe("12m");
		expect(actOf(acts, "io").elapsed).toBeNull();
		expect(actOf(acts, "io").bubble).toEqual({
			partial: true,
			text: "Working on Fix login",
			tone: "work",
		});
		expect(actOf(acts, "cy").carry).toBe("edit");
		expect(actOf(acts, "cy").next).toBe("Next: write tests");
	});

	test("stalled: no progress for 10 minutes on a hydrated thread", () => {
		const fixture = withThread(usefulStateFixture(), FIXTURE_THREAD_IDS.cy, {
			lastProgressAt: at(NOW - 12 * MINUTE),
		});
		const cy = actOf(actsOf(fixture), "cy");
		expect(cy.act).toBe("working");
		expect(cy.stalled).toBe(true);
		expect(cy.stalledFor).toBe("12 minutes");
		expect(cy.bubble).toBeNull();
		expect(
			cy.ariaLabel.startsWith(
				"Cy shows no progress for 12 minutes; the run may have stopped. "
			)
		).toBe(true);
		const io = withThread(usefulStateFixture(), FIXTURE_THREAD_IDS.io, {
			lastProgressAt: at(NOW - 30 * MINUTE),
		});
		expect(actOf(actsOf(io), "io").stalled).toBe(false);
	});

	test("longer than usual only for a routine run past twice its median", () => {
		const later = actsOf(usefulStateFixture(), NOW + 30 * MINUTE);
		expect(actOf(later, "io").longerThanUsual).toBe(true);
		expect(actOf(later, "io").ariaLabel).toContain(", longer than usual.");
		expect(actOf(later, "cy").longerThanUsual).toBe(false);
		expect(actOf(actsOf(), "io").longerThanUsual).toBe(false);
	});

	test("Fa limit precedence as host inputs", () => {
		const resetsAt = Date.parse("2026-10-16T15:10:00Z");
		const errorAt = at(NOW - HOUR);
		const inferred = withThread(usefulStateFixture(), FIXTURE_THREAD_IDS.fa, {
			blocker: {
				at: errorAt,
				atApprox: true,
				clearsAt: at(resetsAt),
				detail: "The agent stopped with an error.",
				kind: "rate-limited",
				source: "estimate",
				title: "Limit hit",
			},
			runState: "failed",
		});
		const fa = actOf(actsOf(inferred), "fa");
		expect(fa.act).toBe("limited");
		expect(fa.blockers[0]?.source).toBe("estimate");
		expect(fa.bubble).toEqual({
			partial: false,
			text: "Likely limit, back 15:10",
			tone: "limit",
		});
		expect(fa.timer?.until).toBe(at(resetsAt));
		const kept = withThread(usefulStateFixture(), FIXTURE_THREAD_IDS.fa, {
			blocker: {
				at: errorAt,
				kind: "error",
				source: "messages",
				title: "Agent error",
			},
			runState: "failed",
		});
		expect(actOf(actsOf(kept), "fa").act).toBe("blocked");
		const plain = actOf(actsOf(), "fa");
		expect(plain.timer).toEqual({
			approx: false,
			since: null,
			until: at(resetsAt),
			untilApprox: false,
		});
		expect(plain.bubble?.text).toBe("Limit hit, back 15:10");
	});
});

describe("agentActs ariaLabel template (test 1)", () => {
	const full: Record<string, string> = {
		ada: "Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run.",
		bo: "Bo asks: Which DB to use? Waited 3 minutes. Expires within 7 minutes.",
		cy: "Cy is editing snapshot.ts, step 3 of 7, running 12 minutes. 2 helpers running. Next: write tests.",
		di: "Di stopped: Tests failed, 20 minutes ago. Also: 1 failed thread.",
		ed: "Ed stopped: Interrupted, about 1 hour ago.",
		fa: "Fa hit a usage limit (Weekly), back 15:10.",
		gu: "Gu has an answer ready: Edited 3 files. 3 files changed.",
		ha: "Ha is idle. Also: 1 suggestion, 1 older failure.",
		io: "Io is working on Fix login flow, progress estimated.",
		ju: "Ju is idle. Also: 1 unread answer.",
	};
	const redacted: Record<string, string> = {
		ada: "Ada: Needs approval. Waited 14 minutes. Risk: run.",
		bo: "Bo: Question for you. Waited 3 minutes. Expires within 7 minutes.",
		cy: "Cy is working, step 3 of 7, running 12 minutes. 2 helpers running. Next run tomorrow 09:00.",
		di: "Di stopped: Failed, 20 minutes ago. Also: 1 failed thread.",
		ed: "Ed stopped: Interrupted, about 1 hour ago.",
		fa: "Fa hit a usage limit (Weekly), back 15:10.",
		gu: "Gu has an answer ready.",
		ha: "Ha is idle. Also: 1 suggestion, 1 older failure.",
		io: "Io is working, progress estimated.",
		ju: "Ju is idle. Also: 1 unread answer.",
	};

	test("full column", () => {
		const acts = actsOf();
		for (const [id, sentence] of Object.entries(full)) {
			expect(actOf(acts, id).ariaLabel).toBe(sentence);
		}
	});

	test("redacted column", () => {
		const acts = actsOf(usefulStateFixture({ privacy: "redacted" }));
		for (const [id, sentence] of Object.entries(redacted)) {
			expect(actOf(acts, id).ariaLabel).toBe(sentence);
		}
		expect(actOf(acts, "ada").bubble?.text).toBe("Needs approval");
		expect(actOf(acts, "io").bubble?.text).toBe("Working");
	});

	test("waiting variant", () => {
		const acts = actsOf(
			miniSnapshot(
				["x"],
				[
					thread({
						agentIds: ["x"],
						id: "sent",
						lastMessageRole: "user",
						updatedAt: at(NOW - MINUTE),
					}),
				]
			)
		);
		const x = actOf(acts, "x");
		expect(x.act).toBe("waiting");
		expect(x.ariaLabel).toBe("X has your message and has not started.");
		expect(x.bubble).toEqual({
			partial: false,
			text: "Picking this up",
			tone: "wait",
		});
	});

	test("markdown is stripped from sentences", () => {
		const ask = makeAsk({
			agentId: "x",
			id: "approval:md",
			since: at(NOW - MINUTE),
			text: "**Can** I [deploy](https://example.com) `prod`?",
		});
		const x = actOf(actsOf(miniSnapshot(["x"], [], [ask])), "x");
		expect(x.ariaLabel).toBe("X asks: Can I deploy prod? Waited 1 minute.");
	});
});

describe("compareAsks (test 2)", () => {
	const blockingIds = (fixture: InterfaceSnapshot) =>
		[...(fixture.asks ?? [])]
			.filter((ask) => ask.blocking)
			.sort(compareAsks)
			.map((ask) => ask.id);

	test("deadline first, then oldest", () => {
		expect(blockingIds(usefulStateFixture())).toEqual([
			FIXTURE_ASK_IDS.boQuestion,
			FIXTURE_ASK_IDS.workflowGate,
			FIXTURE_ASK_IDS.adaToolCall,
		]);
		expect(blockingIds(usefulStateFixture({ livePermission: true }))).toEqual([
			FIXTURE_ASK_IDS.adaPermission,
			FIXTURE_ASK_IDS.boQuestion,
			FIXTURE_ASK_IDS.workflowGate,
			FIXTURE_ASK_IDS.adaToolCall,
		]);
	});

	test("null since last, ties by id, earlier deadline first, blocking before non-blocking", () => {
		const a = makeAsk({ id: "a", since: null });
		const b = makeAsk({ id: "b", since: at(NOW - MINUTE) });
		const c = makeAsk({ id: "c", since: at(NOW - MINUTE) });
		expect([a, c, b].sort(compareAsks).map((ask) => ask.id)).toEqual([
			"b",
			"c",
			"a",
		]);
		const soon = makeAsk({ expiresAt: at(NOW + MINUTE), id: "soon" });
		const later = makeAsk({ expiresAt: at(NOW + HOUR), id: "later" });
		expect([later, soon].sort(compareAsks).map((ask) => ask.id)).toEqual([
			"soon",
			"later",
		]);
		const suggestion = makeAsk({
			blocking: false,
			expiresAt: at(NOW + MINUTE),
			id: "s",
		});
		expect([suggestion, a].sort(compareAsks).map((ask) => ask.id)).toEqual([
			"a",
			"s",
		]);
	});

	test("the order does not depend on the clock", () => {
		const asks = usefulStateFixture({ livePermission: true }).asks ?? [];
		const first = [...asks].sort(compareAsks).map((ask) => ask.id);
		const second = [...asks]
			.reverse()
			.sort(compareAsks)
			.map((ask) => ask.id);
		expect(second).toEqual(first);
	});
});

describe("waitBand and waitLabel (test 3)", () => {
	test("age bands at their boundaries", () => {
		const band = (ageMs: number) => waitBand(NOW - ageMs, NOW);
		expect(band(5 * MINUTE - 1000)).toBe("fresh");
		expect(band(5 * MINUTE)).toBe("waiting");
		expect(band(59 * MINUTE)).toBe("waiting");
		expect(band(60 * MINUTE)).toBe("long");
		expect(band(23 * HOUR)).toBe("long");
		expect(band(24 * HOUR)).toBe("stale");
		expect(waitBand(null, NOW)).toBe("unknown");
	});

	test("expiring only in the last 2 minutes", () => {
		expect(waitBand(NOW - HOUR, NOW, NOW + 2 * MINUTE)).toBe("expiring");
		expect(waitBand(NOW - HOUR, NOW, NOW + 2 * MINUTE + 1000)).toBe("long");
		expect(waitBand(NOW, NOW, NOW + 10 * MINUTE)).toBe("fresh");
		expect(waitBand(NOW - 3 * MINUTE, NOW, NOW + 7 * MINUTE)).toBe("fresh");
		expect(waitBand(NOW - 7 * MINUTE, NOW, NOW + 3 * MINUTE)).toBe("waiting");
		expect(waitBand(null, NOW, NOW + MINUTE)).toBe("expiring");
	});

	test("labels", () => {
		expect(waitLabel(at(NOW - 14 * MINUTE), NOW)).toBe("14m");
		expect(waitLabel(at(NOW - 3 * HOUR), NOW)).toBe("3h");
		expect(waitLabel(at(NOW - 2 * DAY), NOW)).toBe("2d");
		expect(waitLabel(at(NOW - 14 * MINUTE), NOW, { approx: true })).toBe(
			"~14m"
		);
		expect(waitLabel(null, NOW, { until: at(NOW + 4 * MINUTE) })).toBe("in 4m");
		expect(
			waitLabel(null, NOW, { until: at(NOW + 4 * MINUTE), untilApprox: true })
		).toBe("≤ 4m");
		expect(waitLabel(at(NOW - 14 * MINUTE), NOW, { long: true })).toBe(
			"14 minutes"
		);
		expect(waitLabel(at(NOW - HOUR), NOW, { long: true })).toBe("1 hour");
		expect(
			waitLabel(at(NOW - 30 * HOUR), NOW, { approx: true, long: true })
		).toBe("about 1 day");
		expect(waitLabel(null, NOW)).toBeNull();
	});
});

describe("clockLabel (test 3b)", () => {
	test("same day, tomorrow, weekday, date", () => {
		const label = (iso: string) => clockLabel(iso, NOW, FIXTURE_CLOCK);
		expect(label("2026-10-16T15:10:00Z")).toBe("15:10");
		expect(label("2026-10-17T09:00:00Z")).toBe("tomorrow 09:00");
		expect(label("2026-10-19T09:00:00Z")).toBe("Mon 09:00");
		expect(label("2026-10-26T09:00:00Z")).toBe("26 Oct 09:00");
	});

	test("a 12-hour locale keeps the hour", () => {
		const label = clockLabel("2026-10-16T15:10:00Z", NOW, {
			locale: "en-US",
			timeZone: "UTC",
		});
		expect(label).toContain("3:10");
		expect(label).toMatch(/pm/i);
	});

	test("the day comparison uses the time zone", () => {
		expect(
			clockLabel("2026-10-16T23:30:00Z", NOW, {
				locale: "en-GB",
				timeZone: "Asia/Tokyo",
			})
		).toBe("tomorrow 08:30");
	});
});
