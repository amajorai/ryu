import { describe, expect, test } from "bun:test";
import { agentActs, threadClaims } from "@ryuhq/protocol/interfaces";
import {
	FIXTURE_CLOCK,
	FIXTURE_NOW_MS,
	usefulStateFixture,
} from "@ryuhq/protocol/interfaces-fixture";
import { actHasBlocker } from "./game3d-acts.ts";
import { stableActs } from "./use-acts.ts";

describe("stableActs", () => {
	test("a kept act points at the new snapshot's objects", () => {
		const first = usefulStateFixture();
		const second = structuredClone(first);
		const one = stableActs(
			agentActs(first, FIXTURE_NOW_MS, FIXTURE_CLOCK),
			new Map()
		);
		const two = stableActs(
			agentActs(second, FIXTURE_NOW_MS, FIXTURE_CLOCK),
			one.kept
		);
		let checked = 0;
		for (const [id, act] of two.acts) {
			// Same content: the same object, for memoised scenes.
			expect(act).toBe(one.acts.get(id) as typeof act);
			for (const blocker of act.blockers) {
				const owner = second.threads.find(
					(thread) => thread.blocker === blocker
				);
				expect(owner).toBeDefined();
				checked += 1;
			}
			if (act.ask) {
				expect(second.asks?.includes(act.ask)).toBe(true);
			}
		}
		expect(checked).toBeGreaterThan(1);
	});

	test("a changed act is a new object", () => {
		const first = usefulStateFixture();
		const one = stableActs(
			agentActs(first, FIXTURE_NOW_MS, FIXTURE_CLOCK),
			new Map()
		);
		const later = FIXTURE_NOW_MS + 6 * 60_000;
		const two = stableActs(agentActs(first, later, FIXTURE_CLOCK), one.kept);
		const changed = [...two.acts].filter(
			([id, act]) => act !== one.acts.get(id)
		);
		expect(changed.length).toBeGreaterThan(0);
	});
});

describe("actHasBlocker", () => {
	test("matches by value across snapshots, and by claim when given", () => {
		const first = usefulStateFixture();
		const second = structuredClone(first);
		const acts = agentActs(first, FIXTURE_NOW_MS, FIXTURE_CLOCK);
		const claims = threadClaims(second);
		const blocked = [...acts.values()].find((act) => act.blockers.length > 0);
		if (!blocked) {
			throw new Error("the fixture needs a blocked agent");
		}
		const thread = second.threads.find(
			(item) =>
				item.blocker !== undefined &&
				item.blocker !== null &&
				blocked.blockers.some(
					(blocker) =>
						blocker.title === item.blocker?.title &&
						blocker.kind === item.blocker?.kind
				)
		);
		if (!thread?.blocker) {
			throw new Error("no thread for the blocker");
		}
		// Different snapshots: identity fails, value matches.
		expect(blocked.blockers.includes(thread.blocker)).toBe(false);
		expect(actHasBlocker(blocked, thread)).toBe(true);
		expect(actHasBlocker(blocked, thread, claims)).toBe(
			claims.get(thread.id) === blocked.agentId
		);
		expect(
			actHasBlocker(blocked, thread, new Map([[thread.id, "someone-else"]]))
		).toBe(false);
		expect(actHasBlocker(blocked, { ...thread, blocker: null })).toBe(false);
	});
});
