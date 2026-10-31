// apps/desktop/src/lib/app-update-schedule.test.ts
//
// Tests for the desktop's quiet-hour maths and, more importantly, for the
// PROMISE it is allowed to make. The node half of this feature says "will
// install at 03:00" and that is true of a server; a laptop is asleep at 03:00,
// so the sentence here has to be different, and the test below pins it.
//
// The DST cases are asserted as an INVARIANT SWEEP rather than two hardcoded
// nights, because the local zone is whatever the machine running the suite is
// in — a fixture pinned to Europe/Berlin would silently pass by being skipped
// everywhere else. Sweeping a full year crosses both transitions in any zone
// that has them, and still asserts something true in a zone that does not.

import { describe, expect, it } from "bun:test";
import { formatMessage } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	describePendingAppUpdate,
	localTimeZone,
	nextQuietWindow,
	type PendingAppUpdate,
} from "./app-update-schedule.ts";

const tl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

const QUIET_HOUR = 3;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function pending(overrides?: Partial<PendingAppUpdate>): PendingAppUpdate {
	return {
		scheduled_for_ms: Date.parse("2026-08-15T01:00:00Z"),
		time_zone: "Europe/Berlin",
		verdict: {
			asset: null,
			channel: "stable",
			current: "0.1.4",
			html_url: null,
			latest: "0.1.5",
			notes: null,
			update_available: true,
		},
		version: "0.1.5",
		...overrides,
	};
}

describe("nextQuietWindow", () => {
	it("picks tonight's quiet hour when it has not passed", () => {
		const now = new Date(2026, 7, 14, 18, 0, 0);
		const { at } = nextQuietWindow(now);
		expect(at.getHours()).toBe(QUIET_HOUR);
		expect(at.getDate()).toBe(15);
		expect(at.getTime()).toBeGreaterThan(now.getTime());
	});

	it("rolls to tomorrow once the window has passed", () => {
		const now = new Date(2026, 7, 14, 4, 0, 0);
		const { at } = nextQuietWindow(now);
		expect(at.getHours()).toBe(QUIET_HOUR);
		expect(at.getDate()).toBe(15);
	});

	it("skips a window too close to be worth deferring to", () => {
		// 02:58 -> 03:00 is two minutes away. "Tonight" that fires almost
		// immediately is worse than not offering the choice at all.
		const now = new Date(2026, 7, 14, 2, 58, 0);
		const { at } = nextQuietWindow(now);
		expect(at.getDate()).toBe(15);
		expect(at.getTime() - now.getTime()).toBeGreaterThan(15 * MINUTE_MS);
	});

	it("never returns an instant inside the lead margin", () => {
		// The margin is the whole reason a 02:58 booking rolls over, so it has to
		// hold at every minute of the day, not just the one near the boundary.
		for (let minute = 0; minute < 24 * 60; minute += 7) {
			const now = new Date(2026, 5, 1, 0, minute, 0);
			const { at } = nextQuietWindow(now);
			expect(at.getTime() - now.getTime()).toBeGreaterThan(15 * MINUTE_MS);
		}
	});

	it("always lands ON the quiet hour, including across DST transitions", () => {
		// The spring-forward failure this guards: `new Date(y, m, d, 3, …)` on a
		// date whose 03:00 does not exist NORMALISES to a real hour, which would
		// book an install at an hour nobody was offered. A skipped day must roll
		// forward instead — so the resolved hour is 03 on every day of the year.
		let cursor = new Date(2026, 0, 1, 12, 0, 0);
		const end = new Date(2027, 0, 1, 12, 0, 0).getTime();
		while (cursor.getTime() < end) {
			const { at } = nextQuietWindow(cursor);
			expect(at.getHours()).toBe(QUIET_HOUR);
			expect(at.getTime()).toBeGreaterThan(cursor.getTime());
			cursor = new Date(cursor.getTime() + DAY_MS);
		}
	});

	it("reports the machine's own zone", () => {
		const { timeZone } = nextQuietWindow(new Date(2026, 7, 14, 18, 0, 0));
		expect(timeZone).toBe(localTimeZone());
		expect(timeZone.length).toBeGreaterThan(0);
	});
});

describe("describePendingAppUpdate", () => {
	it("promises the next launch, NOT the hour itself", () => {
		// The node surface may say "will install at <time>" because a node is a
		// server that is genuinely up then. This app cannot: nothing registers a
		// wake or a calendar launch, so a laptop asleep at 03:00 installs when it
		// is next opened. Claiming the hour would be a promise it cannot keep —
		// which is the exact failure the whole deferred-actions design exists to
		// avoid.
		const sentence = describePendingAppUpdate(pending(), tl);
		expect(sentence).toContain("the next time you open Ryu after");
		expect(sentence).not.toMatch(/will install at \d/);
	});

	it("names the version and the zone", () => {
		// The zone is not decoration: a booked instant rendered without one is the
		// ambiguity deferring exists to remove.
		const sentence = describePendingAppUpdate(pending(), tl);
		expect(sentence).toContain("v0.1.5");
		expect(sentence).toContain("Europe/Berlin");
	});
});
