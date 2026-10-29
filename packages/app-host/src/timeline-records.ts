import { z } from "zod";
import { jsonResponseDocumentSchema } from "./json-values.ts";

/** Shadow journal records after the host removes device-local app locators.
 * Parse every published field while retaining original nested records and metadata. */
function preserveTimelineRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			jsonResponseDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

export const timelineJournalAppRecordSchema = preserveTimelineRecord(
	z.object({
		icon_url: z.string().nullable(),
		name: z.string(),
	})
).refine(
	(value) => !("app_path" in value || "bundle_id" in value),
	"Device-local app locators must be removed before forwarding journal apps"
);

const journalStatSchema = preserveTimelineRecord(
	z.object({
		event_count: z.number(),
		minutes: z.number(),
		name: z.string(),
	})
);
const journalDistractionSchema = preserveTimelineRecord(
	z.object({
		end_ts: z.number(),
		start_ts: z.number(),
		summary: z.string(),
		title: z.string(),
	})
);
const journalCardSchema = preserveTimelineRecord(
	z.object({
		apps: z.array(timelineJournalAppRecordSchema).optional(),
		category: z.string(),
		detailed_summary: z.string(),
		distraction: z.boolean(),
		distractions: z.array(journalDistractionSchema),
		end_ts: z.number(),
		event_count: z.number(),
		id: z.string(),
		primary_app: z.string(),
		start_ts: z.number(),
		summary: z.string(),
		title: z.string(),
	})
);
const journalFocusSchema = preserveTimelineRecord(
	z.object({
		communication_minutes: z.number(),
		deep_work_minutes: z.number(),
		distraction_minutes: z.number(),
		focus_minutes: z.number(),
		focus_ratio: z.number(),
		longest_focus_streak_minutes: z.number(),
		total_minutes: z.number(),
	})
);
const journalStandupSchema = preserveTimelineRecord(
	z.object({
		blockers: z.array(z.string()),
		highlights: z.array(z.string()),
		tasks: z.array(z.string()),
	})
);

export const timelineJournalRecordSchema = preserveTimelineRecord(
	z.object({
		apps: z.array(journalStatSchema),
		cards: z.array(journalCardSchema),
		categories: z.array(journalStatSchema),
		end_ts: z.number(),
		focus: journalFocusSchema,
		standup: journalStandupSchema,
		start_ts: z.number(),
	})
);
export type TimelineJournalRecord = z.output<
	typeof timelineJournalRecordSchema
>;
