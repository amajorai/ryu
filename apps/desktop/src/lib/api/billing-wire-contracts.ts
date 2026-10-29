import type { Entitlement, PlanId } from "@ryu/auth/lib/plans";
import type { UpsellCard } from "@ryu/auth/lib/upsell";
import {
	appJsonValueSchema,
	appRequestValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import type {
	LicenseValidateResult,
	SubscriptionStatus,
	TrialAnchor,
} from "./billing.ts";
import { billingSubscriptionFieldsSchema } from "./billing-login-stream-contracts.ts";

// These are the actual plan IDs published by auth/plans.ts PLAN_IDS. Keep this
// browser boundary independent of that module's environment-backed catalog.
const billingPlanSchema = z.enum([
	"desktop-license",
	"marketplace-membership",
	"plus",
	"pro",
	"max",
	"teams",
	"teams-lite",
	"business",
] satisfies PlanId[]);
const entitlementFieldsSchema =
	billingSubscriptionFieldsSchema.shape.entitlement.extend({
		plan: billingPlanSchema.nullable(),
	}) satisfies z.ZodType<Entitlement>;

// The HTTP gate deliberately supports older servers omitting rollout fields.
// Validate the same complete publisher fields as the SSE path when present,
// while retaining original nested objects and raw Polar/additive JSON metadata.
const subscriptionStatusFieldsSchema = billingSubscriptionFieldsSchema
	.partial()
	.extend({
		entitlement: entitlementFieldsSchema.nullish(),
		features: billingSubscriptionFieldsSchema.shape.features.nullish(),
		lifetime: billingSubscriptionFieldsSchema.shape.lifetime.optional(),
		plan: billingPlanSchema.nullish(),
		subscription: z
			.object({
				currentPeriodEnd: z.string().nullish(),
				interval: z.string().nullish(),
				status: z.string().nullish(),
			})
			.nullable()
			.optional(),
	});
export const subscriptionStatusSchema = z.custom<SubscriptionStatus>(
	(value) =>
		appJsonValueSchema.safeParse(value).success &&
		subscriptionStatusFieldsSchema.safeParse(value).success
);
const trialAnchorFieldsSchema = z.object({
	firstLaunchAt: z.string().nullish(),
});
export const trialAnchorSchema = z.custom<Partial<TrialAnchor>>(
	(value) =>
		appJsonValueSchema.safeParse(value).success &&
		trialAnchorFieldsSchema.safeParse(value).success
);
const licenseValidateFieldsSchema = z.object({
	active: z.boolean(),
	expiresAt: z.string().nullable(),
	productId: z.string().nullable(),
	status: z.string().nullable(),
}) satisfies z.ZodType<LicenseValidateResult>;
export const licenseValidateSchema = z.custom<LicenseValidateResult>(
	(value) =>
		appJsonValueSchema.safeParse(value).success &&
		licenseValidateFieldsSchema.safeParse(value).success
);
export const checkoutReplySchema = z.object({ url: z.string().nullish() });

const upsellCardFieldsSchema = z.object({
	headline: z.string(),
	id: z.string(),
	lever: z.enum(["investment", "friction", "desire"]),
	metric: z.string(),
	subtext: z.string(),
	value: z.number(),
}) satisfies z.ZodType<UpsellCard>;
export const upsellCardsSchema = z.custom<UpsellCard[]>(
	(value) =>
		appJsonValueSchema.safeParse(value).success &&
		z.array(upsellCardFieldsSchema).safeParse(value).success
);
export const upsellPitchEnvelopeSchema = z.object({
	cards: upsellCardsSchema.nullish(),
});
export const upsellStateReplySchema = z.object({
	lastUpsellShownAt: appRequestValueSchema.optional(),
});
export const upsellShownAtSchema = z
	.union([
		z.number(),
		z.string().transform((value) => {
			const parsed = Date.parse(value);
			return Number.isFinite(parsed) ? parsed : null;
		}),
	])
	.catch(null);
