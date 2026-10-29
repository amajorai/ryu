import {
	appJsonValueSchema,
	appRequestValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import {
	billingSeatsFieldsSchema,
	billingSubscriptionFieldsSchema,
} from "./billing-login-stream-contracts.ts";
import type {
	checkoutHostedAgents,
	OrganizationPlanCheckout,
	OrgMembership,
	SubscriptionStatus,
	TeamsOnboardingCheckout,
	TeamsSeatStatus,
	updateTeamsSeats,
} from "./teams-billing.ts";

function teamsReplySchema<T>(fields: z.ZodType<T>) {
	return z.custom<T>(
		(value) =>
			appJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
// Older HTTP projections predate the extra billing/SSE rollout fields. Check
// every present publisher field, requiring the complete established HTTP view.
const teamsSubscriptionFieldsSchema = billingSubscriptionFieldsSchema
	.partial()
	.extend({
		entitlement: billingSubscriptionFieldsSchema.shape.entitlement
			.partial()
			.required({
				desktopAccess: true,
				managedInference: true,
				monthlyCreditPoolMicroUsd: true,
				plan: true,
			}),
		features: billingSubscriptionFieldsSchema.shape.features,
		hostedAgents: billingSubscriptionFieldsSchema.shape.hostedAgents
			.unwrap()
			.partial()
			.required({
				bonusAgents: true,
				contractedAgents: true,
				effectiveAgents: true,
				includedCreditPoolMicroUsd: true,
				monthlyPriceMicroUsd: true,
				nodeProfile: true,
				planId: true,
			})
			.nullable(),
		organizationId: z.string().nullable(),
		plan: z.string().nullable(),
		scope: z.enum(["org", "user"]),
	}) satisfies z.ZodType<SubscriptionStatus>;
export const teamsSubscriptionStatusSchema = teamsReplySchema(
	teamsSubscriptionFieldsSchema
);
export const teamsSeatStatusSchema = teamsReplySchema(
	billingSeatsFieldsSchema.partial().required({
		allocatedSeats: true,
		availableSeats: true,
		billedSeats: true,
		bonusExpiresAt: true,
		bonusSeats: true,
		canInvite: true,
		includedCreditPoolMicroUsd: true,
		includedSeats: true,
		invitationBlockedReason: true,
		memberCount: true,
		minRequired: true,
		minSeats: true,
		organizationId: true,
		overAllocated: true,
		pendingInvitations: true,
		pendingSeatReservations: true,
		plan: true,
	}) satisfies z.ZodType<TeamsSeatStatus>
);
export const organizationPlanCheckoutSchema = teamsReplySchema(
	z.object({
		monthlyPriceMicroUsd: z.number(),
		plan: z.enum(["teams", "teams-lite", "business"]),
		seats: z.number(),
		url: z.string(),
	}) satisfies z.ZodType<OrganizationPlanCheckout>
);
export const teamsCheckoutSchema = teamsReplySchema(
	z.object({ seats: z.number(), url: z.string() })
);
export const teamsOnboardingCheckoutSchema = teamsReplySchema(
	z.object({
		offer: z.object({
			firstMonthUsd: z.number(),
			interval: z.literal("monthly"),
			recurringMonthUsd: z.number(),
		}),
		seats: z.number(),
		url: z.string(),
	}) satisfies z.ZodType<TeamsOnboardingCheckout>
);
export const teamsSeatUpdateSchema = teamsReplySchema(
	z.object({
		memberCount: z.number(),
		pendingSeatCount: z.number(),
		prorationBehavior: z.literal("invoice"),
		prorationLabel: z.string(),
		seats: z.number(),
	}) satisfies z.ZodType<Awaited<ReturnType<typeof updateTeamsSeats>>>
);
export const hostedAgentsCheckoutSchema = teamsReplySchema(
	z.object({
		agentCount: z.number(),
		monthlyPriceUsd: z.number(),
		planId: z.enum(["max", "pro", "teams"]),
		url: z.string(),
	}) satisfies z.ZodType<Awaited<ReturnType<typeof checkoutHostedAgents>>>
);
export const teamsBillingPortalSchema = teamsReplySchema(
	z.object({ url: z.string() })
);
// control-plane.ts GET /orgs publishes these seven fields. The read-compatible
// DB organization owner has optional slug/createdAt fields, including null
// legacy slots; membership readers required id/name/role before this rollout.
const organizationFieldsSchema = z.object({
	createdAt: z.string().nullish(),
	id: z.string(),
	isPersonal: z.boolean().optional(),
	logo: z.string().nullable().optional(),
	name: z.string(),
	role: z.enum(["owner", "admin", "member", "viewer"]).nullable(),
	slug: z.string().nullish(),
}) satisfies z.ZodType<OrgMembership>;
export const organizationMembershipsSchema = teamsReplySchema(
	z.object({ organizations: z.array(organizationFieldsSchema) })
);
export const teamsBillingErrorReplySchema = z
	.object({
		error: appRequestValueSchema.optional(),
		message: appRequestValueSchema.optional(),
		needsUpgrade: appRequestValueSchema.optional(),
	})
	.catch({});
