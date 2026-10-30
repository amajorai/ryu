import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
	notePinnedSummaryToggle,
	pinnedSummaryOpenWasRequested,
} from "./pinned-summary-open-request.ts";

afterEach(() => {
	setSystemTime();
});

test("a toggle that opens the summary counts as a request for a short window", () => {
	setSystemTime(new Date("2026-01-01T00:00:00Z"));
	notePinnedSummaryToggle(false);
	expect(pinnedSummaryOpenWasRequested()).toBe(true);
	setSystemTime(new Date("2026-01-01T00:00:02Z"));
	expect(pinnedSummaryOpenWasRequested()).toBe(false);
});

test("a toggle that closes the summary is not an open request", () => {
	setSystemTime(new Date("2026-02-01T00:00:00Z"));
	notePinnedSummaryToggle(true);
	expect(pinnedSummaryOpenWasRequested()).toBe(false);
});
