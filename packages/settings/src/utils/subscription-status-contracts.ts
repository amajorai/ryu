import { z } from "zod";

const nullableText = z.string().nullable();
const optionalText = nullableText.optional();
const optionalNumber = z.number().nullable().optional();
// All fourteen normalized fields in the actual billing router PolarListItem
// publisher; passthrough SDK/future fields remain admitted only as JSON.
const subscriptionFields = z.looseObject({
	id: z.string().optional(),
	productId: optionalText,
	status: optionalText,
	createdAt: optionalText,
	metadata: z.record(z.string(), z.json()).nullable().optional(),
	product: z.looseObject({ id: optionalText }).nullable().optional(),
	quantity: optionalNumber,
	seats: optionalNumber,
	currentPeriodStart: optionalText,
	currentPeriodEnd: optionalText,
	modifiedAt: optionalText,
	cancelAtPeriodEnd: z.boolean().optional(),
	pendingUpdate: z
		.union([z.record(z.string(), z.json()), z.array(z.json())])
		.nullable()
		.optional(),
	planVersion: z.union([z.string(), z.number()]).nullable().optional(),
	// interval is a preserved legacy passthrough field, not a Polar guarantee.
	interval: z.json().optional(),
});
const entitlementFields = z.looseObject({
	desktopAccess: z.boolean(),
	managedInference: z.boolean(),
	marketplaceApps: z.boolean(),
	monthlyCreditPoolMicroUsd: z.number(),
	plan: nullableText,
	seats: z.number(),
});
const hostedAgentFields = z.looseObject({
	bonusAgents: z.number(),
	contractedAgents: z.number(),
	effectiveAgents: z.number(),
	includedCreditPoolMicroUsd: z.number(),
	monthlyPriceMicroUsd: z.number(),
	nodeProfile: z.enum(["pooled-standard", "dedicated-performance"]),
	planId: z.string(),
	bonusExpiresAt: nullableText,
	organizationId: z.string(),
	subscriptionId: nullableText,
});
const fields = z.looseObject({
	entitlement: entitlementFields,
	features: z.record(z.string(), z.boolean()),
	giftSubscription: z
		.looseObject({
			endsAt: z.string(),
			id: z.string(),
			plan: z.string(),
			source: z.enum(["gift", "rewards"]).optional(),
			startsAt: z.string(),
		})
		.nullable()
		.optional(),
	hostedAgents: hostedAgentFields.nullable(),
	lifetime: z
		.looseObject({
			expired: z.boolean(),
			purchasedAt: z.string().optional(),
			updatesExpiresAt: z.string(),
		})
		.nullable(),
	organizationId: nullableText,
	plan: nullableText,
	scope: z.enum(["org", "user"]),
	seats: z.number(),
	subscription: subscriptionFields.nullable(),
	zeroDataRetentionEnabled: z.boolean().optional(),
});
// Only the JSON returned by /api/billing/subscription-status crosses this
// admission boundary. Successful parsing returns the complete original tree.
export const subscriptionStatusResponseSchema = z.custom<
	z.output<typeof fields>
>(
	(value) =>
		z.json().safeParse(value).success && fields.safeParse(value).success
);
export type SubscriptionStatus = z.output<
	typeof subscriptionStatusResponseSchema
>;
