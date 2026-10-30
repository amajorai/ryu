// apps/desktop/src/lib/api/shadow-schemas.ts

import { z } from "zod";

export const shadowMetadataSchema = z.record(z.string(), z.json());
export type ShadowMetadata = z.infer<typeof shadowMetadataSchema>;
export const shadowActivityEventSchema = z
	.object({ type: z.string() })
	.catchall(z.json());
export type ShadowActivityEvent = z.infer<typeof shadowActivityEventSchema>;
export const timelineEventSchema = z
	.object({
		app_name: z.string().nullable(),
		app_path: z.string().nullable(),
		bundle_id: z.string().nullable(),
		event_type: z.string(),
		track: z.number(),
		ts: z.number(),
		url: z.string().nullable(),
		window_title: z.string().nullable(),
	})
	.passthrough();
export const journalStatSchema = z
	.object({ event_count: z.number(), minutes: z.number(), name: z.string() })
	.passthrough();
export const focusStatsSchema = z
	.object({
		communication_minutes: z.number(),
		deep_work_minutes: z.number(),
		distraction_minutes: z.number(),
		focus_minutes: z.number(),
		focus_ratio: z.number(),
		longest_focus_streak_minutes: z.number(),
		total_minutes: z.number(),
	})
	.passthrough();
export const journalCardSchema = z
	.object({
		apps: z
			.array(
				z
					.object({
						app_path: z.string().nullable(),
						bundle_id: z.string().nullable(),
						name: z.string(),
					})
					.passthrough()
			)
			.optional(),
		category: z.string(),
		detailed_summary: z.string(),
		distraction: z.boolean(),
		distractions: z.array(
			z
				.object({
					end_ts: z.number(),
					start_ts: z.number(),
					summary: z.string(),
					title: z.string(),
				})
				.passthrough()
		),
		end_ts: z.number(),
		event_count: z.number(),
		id: z.string(),
		primary_app: z.string(),
		start_ts: z.number(),
		summary: z.string(),
		title: z.string(),
	})
	.passthrough();
export const journalSnapshotSchema = z
	.object({
		apps: z.array(journalStatSchema),
		cards: z.array(journalCardSchema),
		categories: z.array(journalStatSchema),
		end_ts: z.number(),
		focus: focusStatsSchema,
		standup: z
			.object({
				blockers: z.array(z.string()),
				highlights: z.array(z.string()),
				tasks: z.array(z.string()),
			})
			.passthrough(),
		start_ts: z.number(),
	})
	.passthrough();
export const weeklyReviewSchema = z
	.object({
		apps: z.array(journalStatSchema),
		categories: z.array(journalStatSchema),
		days: z.array(
			z
				.object({
					card_count: z.number(),
					day: z.string(),
					distraction_minutes: z.number(),
					focus_minutes: z.number(),
					focus_ratio: z.number(),
					start_ts: z.number(),
					top_category: z.string(),
				})
				.passthrough()
		),
		end_ts: z.number(),
		focus: focusStatsSchema,
		highlights: z.array(z.string()),
		start_ts: z.number(),
	})
	.passthrough();
export const shadowSearchResultSchema = z
	.object({
		app_name: z.string().nullable(),
		event_type: z.string(),
		match_reason: z.string().nullable(),
		snippet: z.string().nullable(),
		source_kind: z.string().nullable(),
		track: z.number(),
		ts: z.number(),
		url: z.string().nullable(),
		window_title: z.string().nullable(),
	})
	.passthrough();
export const shadowContextSchema = z
	.object({
		accessibility_text: z.string().nullable().optional(),
		active_app: z.string().nullable(),
		paused: z.boolean().optional(),
		screen_text: z.string().nullable(),
		selected_text: z.string().nullable(),
		window_title: z.string().nullable(),
	})
	.passthrough();
export const proactiveSuggestionSchema = z
	.object({
		body: z.string().nullable(),
		confidence: z.number(),
		created_at: z.number(),
		disposition: z.enum(["push_now", "inbox_only", "drop"]),
		id: z.string(),
		metadata: shadowMetadataSchema,
		suggestion_type: z.string(),
		title: z.string(),
	})
	.passthrough();
export const captureControlSchema = z
	.object({
		app_allowlist: z.array(z.string()),
		frames: z.boolean(),
		history_retention_days: z.number(),
		paused: z.boolean(),
	})
	.passthrough();
