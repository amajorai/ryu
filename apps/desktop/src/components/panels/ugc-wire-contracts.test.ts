import { expect, test } from "bun:test";
import type { AppJsonValue } from "@ryuhq/core-client/app-request-json.ts";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import type { z } from "zod";
import {
	type CampaignView,
	campaignRecordSchema,
	campaignViewSchema,
	creatorRecordSchema,
	creatorViewSchema,
	normalizedSubmissionRefreshSchema,
	readUgcList,
	type SubmissionRefreshReport,
	type SubmissionView,
	submissionRefreshRecordSchema,
	submissionViewSchema,
} from "./ugc-wire-contracts.ts";

test("separates complete publisher records from existing legacy campaign projections without inventing fields", () => {
	const legacy = {
		id: "campaign",
		brand: "Brand",
		status: "active",
		budget_cents: 0,
		starts_at: null,
	} satisfies CampaignView;
	expect(campaignViewSchema.parse(legacy)).toBe(legacy);
	expect(campaignRecordSchema.safeParse(legacy).success).toBe(false);
	const current = {
		...legacy,
		starts_at: "2026-10-07",
		brief: "Brief",
		platforms: ["future-platform"],
		required_hashtags: ["brand"],
		required_mentions: ["brand"],
		payout: { type: "flat", flat_cents: 1200 },
		bonus_tiers: [{ views: 1000, bonus_cents: 100 }],
		max_payout_per_creator_cents: 0,
		created_at: "created",
		updated_at: "updated",
		future: appResponseValueSchema
			.nonoptional()
			.parse(JSON.parse('{"__proto__":{"number":1e400}}')),
	} satisfies z.output<typeof campaignRecordSchema> & { future: AppJsonValue };
	expect(campaignRecordSchema.parse(current)).toBe(current);
	expect(campaignViewSchema.parse(current)).toBe(current);
	expect(
		campaignRecordSchema.safeParse({ ...current, payout: { type: "flat" } })
			.success
	).toBe(false);
	expect(
		campaignViewSchema.safeParse({ ...legacy, bonus_tiers: [{ views: "100" }] })
			.success
	).toBe(false);
});

test("retains bare/enveloped list identities, empty-list fallbacks and future own JSON keys", () => {
	const row = { id: "creator", display_name: "Creator" };
	const rows = [row];
	expect(readUgcList(rows, "creators", creatorViewSchema)).toBe(rows);
	expect(
		readUgcList({ creators: rows, future: null }, "creators", creatorViewSchema)
	).toBe(rows);
	const emptyListReplies: AppJsonValue[] = [
		null,
		false,
		3,
		"reply",
		{},
		{ creators: null },
		{ creators: 1 },
	];
	for (const reply of emptyListReplies) {
		expect(readUgcList(reply, "creators", creatorViewSchema)).toEqual([]);
	}
	expect(() =>
		readUgcList([{ id: "creator" }], "creators", creatorViewSchema)
	).toThrow();
	const handles = JSON.parse(
		'{"__proto__":"future-handle","youtube":"channel"}'
	);
	const creator = {
		...row,
		handles,
		created_at: "created",
		updated_at: "updated",
	};
	expect(creatorRecordSchema.parse(creator)).toBe(creator);
	expect(creatorRecordSchema.parse(creator).handles).toBe(handles);
	expect(
		creatorRecordSchema.safeParse({
			...creator,
			handles: JSON.parse('{"__proto__":4}'),
		}).success
	).toBe(false);
});

test("retains unknown joined payout states and nullable unaccrued money without rewriting valid submission rows", () => {
	const row = {
		id: "post",
		campaign_id: "campaign",
		creator_id: "creator",
		platform: "future-platform",
		post_url: "https://example.com/post",
		status: "approved",
		submitted_at: "submitted",
		payout_status: "future-settled",
		accrued_cents: 0,
	} satisfies SubmissionView;
	expect(submissionViewSchema.parse(row)).toBe(row);
	expect(submissionViewSchema.parse(row).payout_status).toBe("future-settled");
	expect(
		submissionViewSchema.parse({ ...row, accrued_cents: null }).accrued_cents
	).toBeNull();
	expect(
		submissionViewSchema.safeParse({ ...row, accrued_cents: "0" }).success
	).toBe(false);
});

test("normalizes future refresh states to a failed row while retaining metadata and valid known row identities", () => {
	const row = {
		submission_id: "post",
		status: "needs_connection",
		message: "Link the account",
		connect_url: "https://example.com/connect",
		snapshot: null,
	} satisfies SubmissionRefreshReport;
	expect(normalizedSubmissionRefreshSchema.parse(row)).toBe(row);
	expect(submissionRefreshRecordSchema.parse(row)).toBe(row);
	const future = {
		...row,
		status: "waiting-for-new-provider",
		future: appResponseValueSchema
			.nonoptional()
			.parse(JSON.parse('{"__proto__":{"number":1e400}}')),
	};
	const normalized = normalizedSubmissionRefreshSchema.parse(future);
	expect(normalized).not.toBe(future);
	expect(normalized).toEqual({ ...future, status: "error" });
	expect(Object.getOwnPropertyDescriptor(normalized, "future")?.value).toBe(
		future.future
	);
	expect(submissionRefreshRecordSchema.safeParse(future).success).toBe(false);
});

test("admits complete native deep and large future JSON without erasing it, while rejecting cyclic or undefined metadata", () => {
	const depth = 15_000;
	const deep = JSON.parse(
		`${'{"value":'.repeat(depth)}1e400${"}".repeat(depth)}`
	);
	const row = {
		id: "creator",
		display_name: "Creator",
		future: {
			deep,
			large: Array.from({ length: 150_000 }, (_value, index) => index),
		},
	};
	expect(creatorViewSchema.parse(row)).toBe(row);
	expect(
		Object.getOwnPropertyDescriptor(creatorViewSchema.parse(row), "future")
			?.value
	).toBe(row.future);
	const cycle: AppJsonValue[] = [];
	cycle.push(cycle);
	expect(creatorViewSchema.safeParse({ ...row, future: cycle }).success).toBe(
		false
	);
	expect(
		creatorViewSchema.safeParse({ ...row, future: { omitted: undefined } })
			.success
	).toBe(false);
});
