import type { AppJsonValue } from "@ryuhq/core-client/app-request-json.ts";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";

const ugcJsonValueSchema = appResponseValueSchema.nonoptional();

// These are the native public-mount records, not the per-app RPC protocol.
// Rust owners: ugc/backend/src/{store,composio,lib}.rs. Validate every known
// published field without replacing records, nested metadata or future keys.
function preserveUgcReply<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			ugcJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

const ugcNumberSchema = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
export const campaignStatusSchema = z.enum([
	"draft",
	"active",
	"paused",
	"ended",
]);
export const submissionStatusSchema = z.enum([
	"pending",
	"approved",
	"rejected",
	"paid",
]);
export const payoutStatusSchema = z.enum(["accrued", "approved", "paid"]);
export const payoutRuleSchema = preserveUgcReply(
	z.discriminatedUnion("type", [
		z.object({ type: z.literal("cpm"), cpm_cents: ugcNumberSchema }),
		z.object({ type: z.literal("flat"), flat_cents: ugcNumberSchema }),
	])
);
const bonusTierSchema = preserveUgcReply(
	z.object({ views: ugcNumberSchema, bonus_cents: ugcNumberSchema })
);
const campaignFieldsSchema = z.object({
	id: z.string(),
	brand: z.string(),
	brief: z.string(),
	status: campaignStatusSchema,
	platforms: z.array(z.string()),
	required_hashtags: z.array(z.string()),
	required_mentions: z.array(z.string()),
	starts_at: z.string().optional(),
	ends_at: z.string().optional(),
	budget_cents: ugcNumberSchema,
	payout: payoutRuleSchema,
	bonus_tiers: z.array(bonusTierSchema),
	max_payout_per_creator_cents: ugcNumberSchema,
	created_at: z.string(),
	updated_at: z.string(),
});
export const campaignRecordSchema = preserveUgcReply(campaignFieldsSchema);
// Independently shipped older panels/sidecars omit the later campaign fields.
// Keep that honest renderer projection distinct from a complete current record.
export const campaignViewSchema = preserveUgcReply(
	campaignFieldsSchema
		.partial()
		.required({
			id: true,
			brand: true,
			status: true,
			budget_cents: true,
		})
		.extend({ starts_at: z.string().nullish(), ends_at: z.string().nullish() })
);

const handlesSchema = z.custom<Record<string, string>>((value) => {
	const fields = z.record(z.string(), z.string()).safeParse(value);
	return (
		fields.success &&
		Object.values(new Object(value)).every(
			(entry) => z.string().safeParse(entry).success
		)
	);
});
const creatorFieldsSchema = z.object({
	id: z.string(),
	display_name: z.string(),
	handles: handlesSchema,
	contact_email: z.string().optional(),
	payout_handle: z.string().optional(),
	notes: z.string().optional(),
	created_at: z.string(),
	updated_at: z.string(),
});
export const creatorRecordSchema = preserveUgcReply(creatorFieldsSchema);
export const creatorViewSchema = preserveUgcReply(
	creatorFieldsSchema
		.partial()
		.required({ id: true, display_name: true })
		.extend({ contact_email: z.string().nullish() })
);

const metricSnapshotFieldsSchema = z.object({
	id: ugcNumberSchema,
	submission_id: z.string(),
	captured_at: z.string(),
	views: ugcNumberSchema,
	likes: ugcNumberSchema,
	comments: ugcNumberSchema,
	shares: ugcNumberSchema,
	saves: ugcNumberSchema,
	source: z.enum(["manual", "composio"]),
});
export const metricSnapshotRecordSchema = preserveUgcReply(
	metricSnapshotFieldsSchema
);
export const metricSnapshotViewSchema = preserveUgcReply(
	metricSnapshotFieldsSchema.partial({ id: true, submission_id: true })
);

const submissionFieldsSchema = z.object({
	id: z.string(),
	campaign_id: z.string(),
	creator_id: z.string(),
	platform: z.string(),
	post_url: z.string(),
	external_post_id: z.string(),
	status: submissionStatusSchema,
	submitted_at: z.string(),
	reviewed_at: z.string().optional(),
	rejection_reason: z.string().optional(),
	created_at: z.string(),
	updated_at: z.string(),
});
export const submissionRecordSchema = preserveUgcReply(submissionFieldsSchema);
export const submissionWithMetricsRecordSchema = preserveUgcReply(
	submissionFieldsSchema.extend({
		latest: metricSnapshotRecordSchema.optional(),
		accrued_cents: ugcNumberSchema.nullable(),
		// Rust deliberately binds Option<String> straight from the payout row.
		// Future states must survive rather than masquerading as accrued money.
		payout_status: z.string().nullable(),
	})
);
export const submissionViewSchema = preserveUgcReply(
	submissionFieldsSchema
		.partial({
			external_post_id: true,
			created_at: true,
			updated_at: true,
		})
		.extend({
			rejection_reason: z.string().nullish(),
			latest: metricSnapshotViewSchema.nullish(),
			accrued_cents: ugcNumberSchema.nullish(),
			payout_status: z.string().nullish(),
		})
);

const submissionCountsSchema = preserveUgcReply(
	z.object({
		pending: ugcNumberSchema,
		approved: ugcNumberSchema,
		rejected: ugcNumberSchema,
		paid: ugcNumberSchema,
	})
);
const campaignSummaryFieldsSchema = z.object({
	budget_cents: ugcNumberSchema,
	accrued_cents: ugcNumberSchema,
	approved_cents: ugcNumberSchema,
	paid_cents: ugcNumberSchema,
	committed_cents: ugcNumberSchema,
	remaining_cents: ugcNumberSchema.nullable(),
	total_views: ugcNumberSchema,
	total_likes: ugcNumberSchema,
	total_comments: ugcNumberSchema,
	submissions: submissionCountsSchema,
	creators: ugcNumberSchema,
});
export const campaignSummaryRecordSchema = preserveUgcReply(
	campaignSummaryFieldsSchema
);
export const campaignSummaryViewSchema = preserveUgcReply(
	campaignSummaryFieldsSchema.partial({ committed_cents: true })
);
export const ugcOverviewSchema = preserveUgcReply(
	z.object({
		campaigns: ugcNumberSchema,
		creators: ugcNumberSchema,
		submissions: submissionCountsSchema,
		accrued_cents: ugcNumberSchema,
		paid_cents: ugcNumberSchema,
	})
);

const payoutFieldsSchema = z.object({
	id: z.string(),
	campaign_id: z.string(),
	creator_id: z.string(),
	submission_id: z.string().optional(),
	amount_cents: ugcNumberSchema,
	status: payoutStatusSchema,
	reason: z.string(),
	accrued_at: z.string(),
	approved_at: z.string().optional(),
	paid_at: z.string().optional(),
	created_at: z.string(),
	updated_at: z.string(),
});
export const payoutRecordSchema = preserveUgcReply(payoutFieldsSchema);
export const payoutViewSchema = preserveUgcReply(
	payoutFieldsSchema
		.partial({
			reason: true,
			accrued_at: true,
			created_at: true,
			updated_at: true,
		})
		.extend({ submission_id: z.string().nullish() })
);
const leaderboardFieldsSchema = z.object({
	creator_id: z.string(),
	display_name: z.string(),
	views: ugcNumberSchema,
	approved_submissions: ugcNumberSchema,
	accrued_cents: ugcNumberSchema,
	paid_cents: ugcNumberSchema,
});
export const leaderboardRecordSchema = preserveUgcReply(
	leaderboardFieldsSchema
);
export const leaderboardViewSchema = preserveUgcReply(
	leaderboardFieldsSchema.partial({ display_name: true })
);

const platformFieldsSchema = z.object({
	platform: z.string(),
	label: z.string(),
	action: z.string(),
	id_arg: z.string(),
	extra_args: z.array(z.tuple([z.string(), z.string()])),
	views: z.string(),
	likes: z.string(),
	comments: z.string(),
	shares: z.string().nullable(),
	saves: z.string().nullable(),
});
export const platformRecordSchema = preserveUgcReply(platformFieldsSchema);
export const platformViewSchema = preserveUgcReply(
	platformFieldsSchema
		.partial()
		.required({ platform: true, label: true, action: true })
);
export const refreshStatusSchema = z.enum(["error", "needs_connection", "ok"]);
export const refreshCountsSchema = preserveUgcReply(
	z.object({
		error: ugcNumberSchema,
		needs_connection: ugcNumberSchema,
		ok: ugcNumberSchema,
	})
);
export const submissionRefreshRecordSchema = preserveUgcReply(
	z.object({
		submission_id: z.string(),
		status: refreshStatusSchema,
		message: z.string().nullable(),
		connect_url: z.string().nullable(),
		snapshot: metricSnapshotRecordSchema.nullable(),
	})
);
export const campaignRefreshRecordSchema = preserveUgcReply(
	z.object({
		results: z.array(submissionRefreshRecordSchema),
		counts: refreshCountsSchema,
	})
);
export const submissionRefreshViewSchema = preserveUgcReply(
	z.object({
		submission_id: z.string(),
		status: z.string(),
		message: z.string().nullish(),
		connect_url: z.string().nullish(),
		snapshot: metricSnapshotViewSchema.nullish(),
	})
);
const knownSubmissionRefreshViewSchema = preserveUgcReply(
	z.object({
		submission_id: z.string(),
		status: refreshStatusSchema,
		message: z.string().nullish(),
		connect_url: z.string().nullish(),
		snapshot: metricSnapshotViewSchema.nullish(),
	})
);
export const normalizedSubmissionRefreshSchema =
	submissionRefreshViewSchema.transform((row) => {
		const known = knownSubmissionRefreshViewSchema.safeParse(row);
		return known.success
			? known.data
			: knownSubmissionRefreshViewSchema.parse({ ...row, status: "error" });
	});
export const ugcDocumentSchema = preserveUgcReply(
	z.record(z.string(), ugcJsonValueSchema)
);
export function readUgcList<T>(
	data: AppJsonValue,
	key: string,
	rowSchema: z.ZodType<T>
) {
	const document = ugcDocumentSchema.safeParse(data);
	const candidate = Array.isArray(data)
		? data
		: document.success
			? document.data[key]
			: undefined;
	return Array.isArray(candidate)
		? preserveUgcReply(z.array(rowSchema)).parse(candidate)
		: [];
}

export type CampaignStatus = z.output<typeof campaignStatusSchema>;
export type SubmissionStatus = z.output<typeof submissionStatusSchema>;
export type PayoutStatus = z.output<typeof payoutStatusSchema>;
export type PayoutRule = z.output<typeof payoutRuleSchema>;
export type CampaignView = z.output<typeof campaignViewSchema>;
export type CreatorView = z.output<typeof creatorViewSchema>;
export type MetricSnapshotView = z.output<typeof metricSnapshotViewSchema>;
export type SubmissionView = z.output<typeof submissionViewSchema>;
export type CampaignSummaryView = z.output<typeof campaignSummaryViewSchema>;
export type UgcOverview = z.output<typeof ugcOverviewSchema>;
export type PayoutView = z.output<typeof payoutViewSchema>;
export type LeaderboardView = z.output<typeof leaderboardViewSchema>;
export type PlatformView = z.output<typeof platformViewSchema>;
export type RefreshStatus = z.output<typeof refreshStatusSchema>;
export type RefreshCounts = z.output<typeof refreshCountsSchema>;
export type SubmissionRefreshView = z.output<
	typeof submissionRefreshViewSchema
>;
export type SubmissionRefreshReport = z.output<
	typeof normalizedSubmissionRefreshSchema
>;
