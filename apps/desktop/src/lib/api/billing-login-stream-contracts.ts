import { z } from "zod";
import type { PiLoginEvent } from "./pi-config.ts";
import { pluginValueSchema } from "./plugin-wire-values.ts";
import type { BillingStatusUpdate } from "./teams-billing.ts";

function streamPayloadSchema<T>(contract: z.ZodType<T>) {
	return z.custom<T>(
		(value) =>
			pluginValueSchema.safeParse(value).success &&
			contract.safeParse(value).success
	);
}

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const featureFlagsContract = z.record(z.string(), z.boolean());
const featureFlagsSchema = z.custom<z.output<typeof featureFlagsContract>>(
	(value) =>
		featureFlagsContract.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(flag) => z.boolean().safeParse(flag).success
		)
);
const hostedAgentsSchema = z
	.object({
		bonusAgents: z.number(),
		bonusExpiresAt: nullableString,
		contractedAgents: z.number(),
		effectiveAgents: z.number(),
		includedCreditPoolMicroUsd: z.number(),
		monthlyPriceMicroUsd: z.number(),
		nodeProfile: z.string(),
		organizationId: z.string(),
		planId: z.enum(["max", "pro", "teams"]),
		subscriptionId: nullableString,
	})
	.catchall(z.json());

// Full billing-status wire payload, including fields beyond the desktop's view.
// billing-scope.ts SubscriptionStatusPayload and billing.ts SeatStatusPayload
// serialize Date values as strings; raw Polar subscriptions remain JSON.
export const billingSubscriptionFieldsSchema = z
	.object({
		entitlement: z
			.object({
				desktopAccess: z.boolean(),
				managedInference: z.boolean(),
				marketplaceApps: z.boolean(),
				monthlyCreditPoolMicroUsd: z.number(),
				plan: nullableString,
				seats: z.number(),
			})
			.catchall(z.json()),
		features: featureFlagsSchema,
		giftSubscription: z
			.object({
				endsAt: z.string(),
				id: z.string(),
				plan: z.string(),
				source: z.enum(["gift", "rewards"]).optional(),
				startsAt: z.string(),
			})
			.catchall(z.json())
			.nullable()
			.optional(),
		hostedAgents: hostedAgentsSchema.nullable(),
		lifetime: z
			.object({
				expired: z.boolean(),
				purchasedAt: z.string().optional(),
				updatesExpiresAt: z.string(),
			})
			.catchall(z.json())
			.nullable(),
		organizationId: nullableString,
		plan: nullableString,
		scope: z.enum(["org", "user"]),
		seats: z.number(),
		subscription: pluginValueSchema,
		zeroDataRetentionEnabled: z.boolean().optional(),
	})
	.catchall(z.json());
export const billingSeatsFieldsSchema = z
	.object({
		allocatedSeats: z.number(),
		availableSeats: nullableNumber,
		billedSeats: nullableNumber,
		bonusExpiresAt: nullableString,
		bonusSeats: z.number(),
		businessEmailBlockedMemberCount: z.number(),
		businessEmailReason: nullableString,
		businessEmailRequired: z.boolean(),
		canInvite: z.boolean(),
		canUpgradeToTeams: z.boolean(),
		includedCreditPoolMicroUsd: nullableNumber,
		includedSeats: nullableNumber,
		invitationBlockedReason: nullableString,
		memberCount: z.number(),
		minRequired: z.number(),
		minSeats: z.number(),
		organizationId: z.string(),
		organizationKind: z.string(),
		overAllocated: z.boolean(),
		pendingInvitations: z.number(),
		pendingSeatReservations: z.number(),
		plan: nullableString,
		teamEmailPolicyPassed: z.boolean(),
	})
	.catchall(z.json());
export const billingStatusUpdateSchema = streamPayloadSchema(
	z
		.object({
			organizationId: nullableString,
			scope: z.enum(["org", "user"]),
			seats: billingSeatsFieldsSchema.nullable(),
			subscription: billingSubscriptionFieldsSchema,
		})
		.catchall(z.json()) satisfies z.ZodType<BillingStatusUpdate>
);

// Core forwards non-credential bridge events unchanged. Event and prompt type
// names stay open, while every documented field is checked before consumption.
export const piLoginEventSchema = streamPayloadSchema(
	z
		.object({
			accountId: z.string().optional(),
			id: z.string().optional(),
			instructions: z.string().optional(),
			message: z.string().optional(),
			planUseAuthorized: z.boolean().optional(),
			prompt: z
				.object({
					message: z.string(),
					options: z
						.array(
							z.object({ id: z.string(), label: z.string() }).catchall(z.json())
						)
						.optional(),
					placeholder: z.string().optional(),
					type: z.string(),
				})
				.catchall(z.json())
				.optional(),
			provider: z.string().optional(),
			type: z.string(),
			url: z.string().optional(),
			userCode: z.string().optional(),
			verificationUri: z.string().optional(),
		})
		.catchall(z.json()) satisfies z.ZodType<PiLoginEvent>
);
