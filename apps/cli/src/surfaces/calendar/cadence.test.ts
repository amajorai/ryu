import { describe, expect, test } from "bun:test";
import type { ScheduledJob } from "@ryuhq/core-client/schedules";
import { cadenceLabel } from "./cadence.ts";

function job(schedule: ScheduledJob["schedule"]): ScheduledJob {
	return {
		createdAt: "2026-01-01T00:00:00Z",
		enabled: true,
		history: [],
		id: "j1",
		lastOutcome: null,
		lastRunAt: null,
		name: "Job",
		schedule,
		system: false,
		target: { type: "agent", agentId: "a", prompt: "p" },
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

describe("calendar cadence", () => {
	test("an empty schedule shows the Tasks placeholder, not an English word", () => {
		expect(cadenceLabel(job({ kind: "cron", expr: "" }))).toBe("—");
		expect(cadenceLabel(job({ kind: "cron", expr: "0 * * * *" }))).toBe(
			"0 * * * *"
		);
	});
});
