import { PLAN_IDS } from "@ryu/auth/lib/plans";
import { z } from "zod";

// Tauri mockIPC passes the genuine raw JS payload. This native plain-object
// contract deliberately retains own undefined values, getters and raw identity.
const proofRecordFields = z.looseObject({});
const proofObjectTypeSchema = z.object({});
export const updateProofRecordSchema = z.custom<
	z.output<typeof proofRecordFields>
>(
	(value) =>
		proofObjectTypeSchema.safeParse(value).success &&
		Object.getPrototypeOf(value) === Object.prototype
);
const proofStringSchema = z.string();
const proofBooleanSchema = z.boolean();
const proofNumberTypeSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const accountFields = z.looseObject({
	userId: z.string(),
	token: z.string(),
	email: z.string(),
	name: z.string().nullable(),
	image: z.string().nullable(),
	isAnonymous: z.boolean().optional(),
});
const accountSchema = z.custom<z.output<typeof accountFields>>((value) => {
	const parsed = updateProofRecordSchema.safeParse(value);
	if (!parsed.success) {
		return false;
	}
	const account = parsed.data;
	return (
		proofStringSchema.safeParse(account.userId).success &&
		proofStringSchema.safeParse(account.token).success &&
		proofStringSchema.safeParse(account.email).success &&
		(account.name === null ||
			proofStringSchema.safeParse(account.name).success) &&
		(account.image === null ||
			proofStringSchema.safeParse(account.image).success) &&
		(account.isAnonymous === undefined ||
			proofBooleanSchema.safeParse(account.isAnonymous).success) &&
		Object.keys(account).every((field) =>
			["userId", "token", "email", "name", "image", "isAnonymous"].includes(
				field
			)
		)
	);
});
// Native Array.every skips holes; the mock SDK has always retained sparse arrays.
const accountsSchema = z.custom<z.output<typeof accountSchema>[]>(
	(value) =>
		Array.isArray(value) &&
		value.every((account) => accountSchema.safeParse(account).success)
);
const entitlementFields = z.looseObject({
	cachedAtMs: z.number(),
	proUnlocked: z.boolean(),
	marketplaceApps: z.boolean(),
	managedInference: z.boolean(),
	plan: z.enum(PLAN_IDS).nullable(),
});
const entitlementSchema = z.custom<z.output<typeof entitlementFields>>(
	(value) => {
		const parsed = updateProofRecordSchema.safeParse(value);
		if (!parsed.success) {
			return false;
		}
		const record = parsed.data;
		return (
			proofNumberTypeSchema.safeParse(record.cachedAtMs).success &&
			Number.isFinite(record.cachedAtMs) &&
			proofBooleanSchema.safeParse(record.proUnlocked).success &&
			proofBooleanSchema.safeParse(record.marketplaceApps).success &&
			proofBooleanSchema.safeParse(record.managedInference).success &&
			(record.plan === null || PLAN_IDS.some((plan) => plan === record.plan)) &&
			Object.keys(record).length === 5
		);
	}
);
const consentFields = z.looseObject({
	contextRead: z.boolean(),
	doIt: z.boolean(),
	proactive: z.boolean(),
});
const consentSchema = z.custom<z.output<typeof consentFields>>((value) => {
	const parsed = updateProofRecordSchema.safeParse(value);
	if (!parsed.success) {
		return false;
	}
	return (
		["contextRead", "doIt", "proactive"].every(
			(key) => proofBooleanSchema.safeParse(parsed.data[key]).success
		) && Object.keys(parsed.data).length === 3
	);
});
const allowlistSchema = z.custom<string[]>(
	(value) =>
		Array.isArray(value) &&
		value.every((entry) => z.string().safeParse(entry).success)
);
export const updateProofStoreValueSchema = z.union([
	accountsSchema,
	z.string(),
	z.number(),
	z.boolean(),
	entitlementSchema,
	consentSchema,
	allowlistSchema,
]);
export type UpdateProofStoreValue = z.output<
	typeof updateProofStoreValueSchema
>;
export const updateProofStoreValueSchemas = new Map<
	string,
	z.ZodType<UpdateProofStoreValue>
>([
	["accounts", accountsSchema],
	["activeUserId", z.string().min(1)],
	["token", z.string().min(1)],
	["firstLaunchAtMs", z.number().positive()],
	["licenseKey", z.string()],
	["lastGoodEntitlement", entitlementSchema],
	["companion_consent", consentSchema],
	["companion_app_allowlist", allowlistSchema],
	["companion_paused", z.boolean()],
	["companion_frames", z.boolean()],
	["shadow_history_retention_days", z.number().int().min(1).max(3650)],
]);
export const updateProofStringSchema = z.string();
