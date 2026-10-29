import { describe, expect, test } from "bun:test";
import {
	type GhostRecordingStop,
	ghostRecipeSummariesSchema,
	ghostRecordingStateSchema,
	ghostRecordingStopSchema,
} from "./ghost-recording.ts";

describe("native Ghost recording reply owners", () => {
	test("recipe summaries retain the original list and additive Core metadata", () => {
		const summaries = [
			{
				app: null,
				description: "Flow",
				name: "flow",
				params: ["query"],
				step_count: 2,
				future: { retained: true },
			},
		];
		expect(ghostRecipeSummariesSchema.parse(summaries)).toBe(summaries);
		expect(
			ghostRecipeSummariesSchema.safeParse([{ ...summaries[0], params: [1] }])
				.success
		).toBe(false);
	});
	test("recording status permits idle replies and retains nested native status", () => {
		const idle = { recording: false };
		const active = {
			recording: true,
			started_at: "2026-10-06",
			task: "Open file",
			status: { event_count: 3, future: [true, null] },
		};
		expect(ghostRecordingStateSchema.parse(idle)).toBe(idle);
		expect(ghostRecordingStateSchema.parse(active)).toBe(active);
		expect(
			ghostRecordingStateSchema.safeParse({ recording: "true" }).success
		).toBe(false);
	});
	test("stop replies validate captured actions and optional drafts without changing legacy replies", () => {
		const reply = {
			recording: false,
			event_count: 1,
			events: [{ event_type: "click", ts_ms: 10, app_name: null }],
			started_at: "2026-10-06",
			task: "Open file",
			future: "retained",
		} satisfies GhostRecordingStop & Record<"future", string>;
		expect(ghostRecordingStopSchema.parse(reply)).toBe(reply);
		const legacy = {
			recording: false,
			task: "Open file",
			started_at: "2026-10-06",
		} satisfies GhostRecordingStop;
		expect(ghostRecordingStopSchema.parse(legacy)).toBe(legacy);
		const draft = {
			schema_version: 2,
			name: "flow",
			description: "Flow",
			steps: [{ id: 1, action: "click", target: { query: "Open" } }],
			params: JSON.parse(
				'{"__proto__":{"description":"Parameter","type":"string"}}'
			),
		};
		const withDraft = { ...reply, draft };
		expect(ghostRecordingStopSchema.parse(withDraft)).toBe(withDraft);
		expect(
			ghostRecordingStopSchema.safeParse({ ...reply, recording: true }).success
		).toBe(false);
		expect(
			ghostRecordingStopSchema.safeParse({
				...reply,
				events: [{ event_type: "click", ts_ms: "10" }],
			}).success
		).toBe(false);
		expect(
			ghostRecordingStopSchema.safeParse({
				...reply,
				draft: {
					...draft,
					params: JSON.parse('{"__proto__":{"type":"string"}}'),
				},
			}).success
		).toBe(false);
	});
});
