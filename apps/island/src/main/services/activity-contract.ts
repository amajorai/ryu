import { z } from "zod";
import type {
	IslandMeeting,
	IslandMeetingEvent,
	IslandQuest,
	IslandQuestEvent,
} from "../../shared/ipc.ts";

export const meetingSchema = z.object({
	app: z.string().nullable().optional(),
	id: z.string(),
	status: z.string(),
	title: z.string(),
}) satisfies z.ZodType<IslandMeeting>;

export const meetingResponseSchema = z.object({
	meeting: meetingSchema.optional(),
});

export const meetingEventSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("detected"),
		app: z.string(),
		title: z.string(),
		detected_at: z.string(),
	}),
	z.object({ type: z.literal("started"), meeting: meetingSchema }),
	z.object({
		type: z.literal("segment"),
		segment: z.object({ meeting_id: z.string(), text: z.string() }),
	}),
	z.object({
		type: z.literal("status"),
		meeting_id: z.string(),
		status: z.string(),
	}),
	z.object({ type: z.literal("finalized"), meeting: meetingSchema }),
]) satisfies z.ZodType<IslandMeetingEvent>;

export const questSchema = z.object({
	id: z.string(),
	status: z.string(),
	title: z.string(),
}) satisfies z.ZodType<IslandQuest>;

export const questResponseSchema = z.object({ quest: questSchema.optional() });

export const questEventSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("suggested"),
		quest: questSchema,
		confidence: z.number(),
		reason: z.string(),
	}),
	z.object({
		type: z.literal("completed"),
		quest: questSchema,
		auto: z.boolean(),
	}),
	z.object({ type: z.literal("updated"), quest: questSchema }),
	z.object({ type: z.literal("deleted"), id: z.string() }),
]) satisfies z.ZodType<IslandQuestEvent>;
