import { describe, expect, test } from "bun:test";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import { interfaceEventsAround } from "./use-interface-events.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 30, 0);
const HOUR_MS = 3_600_000;

function hourlyJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		appId: null,
		createdAt: new Date(NOW - 90 * 24 * HOUR_MS).toISOString(),
		enabled: true,
		history: [],
		id: "digest",
		lastOutcome: null,
		lastRunAt: null,
		name: "Digest",
		ownerApp: null,
		requireApproval: false,
		schedule: { expr: "0 */6 * * *", kind: "cron" },
		system: false,
		target: { agentId: "atlas", prompt: "Summarise", type: "agent" },
		updatedAt: new Date(NOW).toISOString(),
		...overrides,
	};
}

describe("interfaceEventsAround", () => {
	test("projects upcoming runs from now and keeps real run history", () => {
		const ranAt = new Date(NOW - 2 * 24 * HOUR_MS);
		const events = interfaceEventsAround(
			[
				hourlyJob({
					history: [
						{
							error: null,
							finishedAt: new Date(ranAt.getTime() + 60_000).toISOString(),
							outcome: "success",
							runId: null,
							startedAt: ranAt.toISOString(),
						},
					],
				}),
			],
			NOW
		);
		const upcoming = events.filter((event) => event.kind === "upcoming");
		const past = events.filter((event) => event.kind === "past");
		expect(upcoming.length).toBeGreaterThan(0);
		// No phantom scheduled runs on past dates.
		for (const event of upcoming) {
			expect(Date.parse(event.start)).toBeGreaterThanOrEqual(NOW);
		}
		expect(past.map((event) => event.start)).toEqual([ranAt.toISOString()]);
	});

	test("a disabled job contributes history only", () => {
		const events = interfaceEventsAround([hourlyJob({ enabled: false })], NOW);
		expect(events).toEqual([]);
	});
});
