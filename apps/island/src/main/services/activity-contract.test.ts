import { expect, test } from "bun:test";
import {
	meetingEventSchema,
	meetingResponseSchema,
	questEventSchema,
	questResponseSchema,
} from "./activity-contract.ts";

test("meeting responses and events keep optional app and complete segment payloads", () => {
	const meeting = {
		id: "meeting",
		status: "recording",
		title: "Planning",
		app: null,
	};
	expect(meetingResponseSchema.parse({ meeting })).toEqual({ meeting });
	expect(meetingResponseSchema.parse({})).toEqual({});
	expect(meetingEventSchema.parse({ type: "started", meeting })).toEqual({
		type: "started",
		meeting,
	});
	expect(
		meetingEventSchema.parse({
			type: "segment",
			segment: { meeting_id: "meeting", text: "notes" },
		})
	).toEqual({
		type: "segment",
		segment: { meeting_id: "meeting", text: "notes" },
	});
	expect(
		meetingEventSchema.safeParse({
			type: "segment",
			segment: { text: "notes" },
		}).success
	).toBe(false);
});

test("quest events preserve auto-completion and require complete suggestion payloads", () => {
	const quest = { id: "quest", status: "done", title: "Review" };
	expect(questResponseSchema.parse({ quest })).toEqual({ quest });
	expect(questResponseSchema.parse({})).toEqual({});
	expect(
		questEventSchema.parse({ type: "completed", quest, auto: false })
	).toEqual({ type: "completed", quest, auto: false });
	expect(
		questEventSchema.safeParse({ type: "suggested", quest, confidence: 0.9 })
			.success
	).toBe(false);
	expect(questEventSchema.safeParse({ type: "unknown", quest }).success).toBe(
		false
	);
});
