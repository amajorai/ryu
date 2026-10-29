import { describe, expect, test } from "bun:test";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import { buildCalendarEvents, cronFireTimes } from "./events.ts";

const T0 = Date.UTC(2026, 9, 16, 0, 0);
const HOUR = 3_600_000;

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		appId: null,
		createdAt: new Date(T0 - 30 * 24 * HOUR).toISOString(),
		enabled: true,
		history: [
			{
				error: "disk full",
				finishedAt: new Date(T0 - 20 * HOUR).toISOString(),
				outcome: "failure",
				runId: null,
				startedAt: new Date(T0 - 21 * HOUR).toISOString(),
			},
			{
				error: null,
				finishedAt: new Date(T0 - 2 * HOUR).toISOString(),
				outcome: "success",
				runId: "agentrun_1",
				startedAt: new Date(T0 - 3 * HOUR).toISOString(),
			},
		],
		id: "job-1",
		lastOutcome: "success",
		lastRunAt: null,
		name: "Nightly backup",
		ownerApp: null,
		requireApproval: true,
		schedule: { expr: "45 9 * * *", kind: "cron", tz: "UTC" },
		system: false,
		target: {
			agentId: "coder",
			conversationId: "chat-1",
			prompt: "back up",
			type: "agent",
		},
		updatedAt: new Date(T0).toISOString(),
		...overrides,
	};
}

describe("calendar events for interfaces", () => {
	test("past runs carry the run id, the persistent chat and the approval flag", () => {
		const events = buildCalendarEvents(
			[job()],
			new Date(T0 - 48 * HOUR),
			new Date(T0 + 24 * HOUR)
		);
		const past = events.filter((event) => event.kind === "past");
		expect(past.map((event) => event.runId)).toEqual([null, "agentrun_1"]);
		for (const event of events) {
			expect(event.conversationId).toBe("chat-1");
			expect(event.requireApproval).toBe(true);
		}
	});

	test("a per-firing agent job has no conversation id", () => {
		const events = buildCalendarEvents(
			[
				job({
					requireApproval: false,
					target: { agentId: "coder", prompt: "x", type: "agent" },
				}),
			],
			new Date(T0 - 48 * HOUR),
			new Date(T0 + 24 * HOUR)
		);
		expect(events.every((event) => event.conversationId === undefined)).toBe(
			true
		);
		expect(events.every((event) => event.requireApproval === undefined)).toBe(
			true
		);
	});

	test("cronFireTimes includes a fire at the window start and skips interval jobs", () => {
		const fire = Date.UTC(2026, 9, 16, 9, 45);
		expect(
			cronFireTimes(job(), new Date(fire), new Date(fire + 90_000)).map((d) =>
				d.getTime()
			)
		).toEqual([fire]);
		expect(
			cronFireTimes(
				job(),
				new Date(fire - 90_000),
				new Date(fire + 20_000)
			).map((d) => d.getTime())
		).toEqual([fire]);
		expect(
			cronFireTimes(
				job({ schedule: { interval: "1h", kind: "every" } }),
				new Date(T0),
				new Date(T0 + 24 * HOUR)
			)
		).toEqual([]);
	});
});
