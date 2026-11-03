import { z } from "zod";
import {
	ADMIN_ROLE,
	APPROVED_ROLE,
	isAdminEmail,
	isVerifiedAdminEmail,
	isWaitlistBypassed,
	WAITLIST_ROLE,
} from "../lib/waitlist.ts";

// Shared hook-input schemas and the signup role decision used by the auth
// configuration modules.

export const DUPLICATE_KEY_ERROR_CODE = 11_000;
export const userHookFieldsSchema = z.object({
	isAnonymous: z.boolean().catch(false),
	referredBy: z.string().nullish().catch(undefined),
});
/**
 * The admin-plugin role a new durable account starts with, and whether that
 * puts it in the waitlist queue. Support staff (the admin allowlist) get the
 * real "admin" role so the admin plugin's impersonation primitive accepts them
 * (#545). With no admins configured (self-hosted, ADMIN_EMAILS empty) nobody
 * could ever approve a queued user, so signups are auto-approved
 * (APPROVED_ROLE) instead of dead-ending on the waitlist; otherwise everyone
 * else is queued (WAITLIST_ROLE), fail-closed. `user.create.before` stamps the
 * role and `user.create.after` decides the welcome email from the same call,
 * so the two cannot drift.
 *
 * The allowlist grants ADMIN_ROLE only to a VERIFIED address. An allowlisted
 * address that is not yet proven (email/password sign-up before the mailbox
 * link, or an SSO/SCIM account whose IdP asserted it) is held on WAITLIST_ROLE
 * without the queue email; `afterEmailVerification` and the session-create
 * reconcile promote it once the mailbox is verified.
 */
export function resolveSignupRole(user: {
	email?: string | null;
	emailVerified?: boolean | null;
}): {
	queued: boolean;
	role: typeof ADMIN_ROLE | typeof APPROVED_ROLE | typeof WAITLIST_ROLE;
} {
	if (isVerifiedAdminEmail(user)) {
		return { queued: false, role: ADMIN_ROLE };
	}
	if (isWaitlistBypassed()) {
		return { queued: false, role: APPROVED_ROLE };
	}
	if (isAdminEmail(user.email)) {
		return { queued: false, role: WAITLIST_ROLE };
	}
	return { queued: true, role: WAITLIST_ROLE };
}

const polarSubscriptionSchema = z.object({
	product: z.object({ id: z.string().nullish() }).nullish(),
	productId: z.string().nullish(),
	quantity: z.number().nullish(),
	seats: z.number().nullish(),
	status: z.string().nullish(),
});
const polarSubscriptionsSchema = z.array(polarSubscriptionSchema);
/** The session field the JWT flag claim reads; lenient so a mint never fails. */
export const flagClaimSessionSchema = z
	.object({ activeOrganizationId: z.string().nullish().catch(null) })
	.catch(() => ({ activeOrganizationId: null }));
export const polarPageItems = z
	.union([
		polarSubscriptionsSchema,
		z
			.object({
				items: polarSubscriptionsSchema.nullish(),
				result: z
					.object({ items: polarSubscriptionsSchema.nullish() })
					.nullish(),
			})
			.transform((page) => page.result?.items ?? page.items ?? []),
	])
	.catch(() => []).parse;
const organizationHookStringSchema = z.string().optional().catch(undefined);
export const invitationNotificationFieldsSchema = z
	.object({
		referralTag: organizationHookStringSchema,
		teamId: organizationHookStringSchema,
	})
	.catch(() => ({}));
export const organizationHookBodySchema = z
	.object({
		email: organizationHookStringSchema,
		provider: organizationHookStringSchema,
		organizationId: organizationHookStringSchema,
		memberId: organizationHookStringSchema,
		userId: organizationHookStringSchema,
		teamId: organizationHookStringSchema,
		invitationId: organizationHookStringSchema,
		resend: z.boolean().optional().catch(undefined),
	})
	.catch(() => ({}));
export const hookActiveOrganizationId = z
	.object({
		session: z.object({ activeOrganizationId: z.string().nullish() }),
	})
	.nullable()
	.transform((value) => value?.session.activeOrganizationId ?? null)
	.catch(null).parse;
const auditResourceSchema = z
	.object({
		id: organizationHookStringSchema,
		organizationId: organizationHookStringSchema,
	})
	.catch(() => ({}));
export const auditReturnSchema = z
	.object({
		id: organizationHookStringSchema,
		organizationId: organizationHookStringSchema,
		organization: auditResourceSchema,
		invitation: auditResourceSchema,
		member: auditResourceSchema,
		team: auditResourceSchema,
		// The role an invitation or member row carries (invite, add, role update).
		role: organizationHookStringSchema,
	})
	.catch(() => ({ organization: {}, invitation: {}, member: {}, team: {} }));

// Narrow an unknown caught error to its string `code` (e.g. better-auth's
// RATE_LIMIT_EXCEEDED) without an `as any` cast.
export const errorCode = z
	.object({ code: z.union([z.string(), z.number()]) })
	.transform((error) => String(error.code))
	.optional()
	.catch(undefined).parse;
