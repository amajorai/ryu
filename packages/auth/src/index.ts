import { createHash } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import {
	defineRequestState,
	getCurrentAuthContext,
	hasRequestState,
	queueAfterTransactionHook,
} from "@better-auth/core/context";
import { expo } from "@better-auth/expo";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { polar } from "@polar-sh/better-auth";
import { client, mongoClient } from "@ryu/db";
import { writeBound } from "@ryu/db/crypto";
import { User } from "@ryu/db/models/auth.model";
import {
	Member,
	Organization,
	RoleAssignment,
	Team,
	TeamMember,
} from "@ryu/db/models/control-plane.model";
import { markManagedAgentOrganizationDeleted } from "@ryu/db/models/managed-agent.model";
import { OrganizationInvitationPolicy } from "@ryu/db/models/organization-invitation-policy.model";
import { isOrganizationNotificationEnabled } from "@ryu/db/models/organization-notification.model";
import { OrganizationSeatReservation } from "@ryu/db/models/organization-seat-reservation.model";
import { isUserNotificationChannelEnabled } from "@ryu/db/models/user-notification.model";
import { VaultPolicyBinding } from "@ryu/db/models/vault.model";
import {
	organizationIdentityRevision,
	resolveOrganizationIdentityUpdate,
} from "@ryu/db/organization-identity";
import {
	revokeOrganizationRoleAssignments,
	revokeTeamRoleAssignments,
} from "@ryu/db/organization-role-assignments";
import {
	AccountExistsEmail,
	configureContactIdSaver,
	configureNotificationRateLimiting,
	configureRateLimiting,
	configureSentEmailRecorder,
	EmailVerificationOTPEmail,
	MagicLinkEmail,
	OrganizationInvitationExistingAccountEmail,
	OrganizationInvitationNewAccountEmail,
	PasswordChangeEmail,
	PasswordResetEmail,
	PasswordResetOTPEmail,
	type RateLimitResult,
	SignInOTPEmail,
	StaleAccountAdminEmail,
	StaleAccountUserEmail,
	sendEmail,
	TwoFactorOTPEmail,
	VerificationEmail,
	WaitlistConfirmationEmail,
} from "@ryu/email";
import { env } from "@ryu/env/server";
import { type Auth, type BetterAuthOptions, betterAuth } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
} from "better-auth/api";
import {
	anonymous,
	bearer,
	captcha,
	deviceAuthorization,
	emailOTP,
	lastLoginMethod,
	magicLink,
	multiSession,
	type OrganizationOptions,
	oneTap,
	oneTimeToken,
	organization,
	twoFactor,
	username,
} from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { jwt } from "better-auth/plugins/jwt";
import { z } from "zod";
import { adminAbuseGuardPlugin } from "./lib/admin-abuse-guard-plugin.ts";
import { ageEligibilityPlugin } from "./lib/age-eligibility-plugin.ts";
import { rejectClientApiKeyMetadata } from "./lib/api-key-metadata-guard.ts";
import { createRyuAuthI18nPlugin } from "./lib/auth-i18n.ts";
import { bannedSignInPlugin } from "./lib/banned-sign-in-plugin.ts";
import {
	organizationAuditDetails,
	recordOrganizationControlAudit,
	rememberMemberRoleBeforeUpdate,
} from "./lib/control-audit-recorder.ts";
import {
	resolveCoreFlagClaim,
	selectCoreFlagClaimOrganization,
	withCoreFlagClaim,
} from "./lib/core-flag-claim.ts";
import { resolveRyuCorsOrigins } from "./lib/cors-origins.ts";
import { revokeDepartedMemberNodeCredentials } from "./lib/departed-member-node-credentials.ts";
import { ryuEmailHarmony } from "./lib/email-harmony.ts";
import { hasEnterpriseCapability } from "./lib/enterprise-entitlement.ts";
import {
	isCustomRoleWritePath,
	type OrganizationSeatCopy,
	organizationSeatCopy,
} from "./lib/family-admission.ts";
import { disableFamilyBotGrantsOnMemberExit } from "./lib/family-bot-grants.ts";
import {
	claimFamilyMembershipSlot,
	confirmFamilyMembershipSlot,
	familyMembershipSlotExists,
	releaseFamilyMembershipSlot,
	releaseFamilyMembershipSlotsForOrganization,
} from "./lib/family-membership-slots.ts";
import {
	familySharingCapacity,
	userFamilyOrganizationIds,
} from "./lib/family-sharing.ts";
import { removeTeamCreatedInFamily } from "./lib/family-team-guard.ts";
import {
	GUEST_MODE_DISABLED_MESSAGE,
	shouldRejectGuestSignIn,
} from "./lib/guest-mode.ts";
import { invitationEmailNotSentError } from "./lib/invitation-email-delivery.ts";
import {
	jwtIdentityClaims,
	jwtSessionBindingClaims,
} from "./lib/jwt-identity-claims.ts";
import {
	admitJwtOrgMemberships,
	jwtOrgAccessUnavailable,
} from "./lib/jwt-org-access.ts";
import { LOGIN_APPROVAL_CLIENTS } from "./lib/login-approval-contract.ts";
import { loginApprovalSessionPlugin } from "./lib/login-approval-session-plugin.ts";
import {
	assertPendingEmailMatches,
	assertPendingPasskeyMatches,
	loginAssuranceAfterFactor,
	loginAssuranceAfterMagicLinkRequest,
	loginAssuranceAfterPassword,
	loginAssuranceCleanupPlugin,
} from "./lib/login-assurance.ts";
import {
	clearPriorMembershipGrants,
	recordRoleGrantCleanupFailure,
} from "./lib/membership-grant-cleanup.ts";
import { mfaEnrollmentPlugin } from "./lib/mfa-enrollment-plugin.ts";
import { checkNotificationEmailRateLimit } from "./lib/notification-email-rate.ts";
import { authorizeScopeDefaultsFromStore } from "./lib/oauth-authorize-scope.ts";
import { userInMfaRequiredOrganization } from "./lib/org-mfa-membership.ts";
import {
	createOrganizationAdmission,
	requireVerifiedBusinessEmail,
} from "./lib/organization-admission.ts";
import { businessEmailDomainDecision } from "./lib/organization-email-policy.ts";
import {
	normalizeInvitationEmail,
	normalizeReferralTag,
	ORGANIZATION_INVITATION_COOLDOWN_MS,
} from "./lib/organization-invitation-policy.ts";
import {
	FAMILY_ORGANIZATION_KIND,
	metadataWithOrganizationKind,
	ORGANIZATION_KIND_KEY,
	type OrganizationKind,
	type OrganizationMetadataInput,
	organizationKindFromMetadata,
	organizationKindFromRecord,
	PERSONAL_ORGANIZATION_KIND,
	parseOrganizationMetadata,
	readOrganizationKind,
	reconcileOrganizationKindMetadata,
	TEAMS_ORGANIZATION_KIND,
} from "./lib/organization-kind.ts";
import { organizationMutationSucceeded } from "./lib/organization-mutation-result.ts";
import {
	notifyOrganizationEvent,
	organizationAppUrl,
} from "./lib/organization-notifications.ts";
import { activeTeamsSeatAllowance } from "./lib/organization-seat-entitlement.ts";
import { decideSeatAdmission } from "./lib/organization-seat-gate.ts";
import {
	claimPendingInvitationCancellation,
	ensurePersonalOrganization,
	resolveInitialActiveOrganization,
	resolvePersonalOrgId,
} from "./lib/organizations.ts";
import { passwordPolicyRefusal } from "./lib/password-endpoints.ts";
import { polarClient, syncPolarCustomer } from "./lib/payments.ts";
import {
	ORGANIZATION_PLAN_IDS,
	PLANS,
	planByProductId,
	resolveCoreLimitsClaim,
	resolveProductId,
	withCoreLimitsClaim,
} from "./lib/plans.ts";
import { platformAdminAuditPlugin } from "./lib/platform-admin-audit-plugin.ts";
import { resolveOrganizationPolarCustomerId } from "./lib/polar-customer-identity.ts";
import {
	PRIMARY_OWNER_GUARDED_PATHS,
	primaryOwnerHookDecision,
} from "./lib/primary-owner-guard.ts";
import {
	creditPendingReferral,
	creditReferrerAtSignup,
} from "./lib/referral-credit.ts";
import { runRefereeGrantHook } from "./lib/referral-grant-hook.ts";
import {
	type ResentInvitationSeat,
	successfulResentInvitationSeat,
} from "./lib/resent-invitation-seat.ts";
import { retireOrganizationMail } from "./lib/retire-organization-mail.ts";
import { ryuClientSessionPlugin } from "./lib/ryu-client-session.ts";
import { scimAdminEmailGuardPlugin } from "./lib/scim-admin-email-guard.ts";
import {
	createScimIdentity,
	createScimMembershipProjection,
	type ScimRemovedMember,
} from "./lib/scim-deprovisioning.ts";
import { recordSentEmail } from "./lib/sent-email-archive.ts";
import {
	authoritativeAuthContext,
	refreshSessionCookieFromStore,
	sessionCookieCache,
} from "./lib/session-cache.ts";
import {
	ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS,
	isAllowedSocialSignInProvider,
	SOCIAL_SIGN_IN_PROVIDER,
} from "./lib/social-provider-policy.ts";
import { validateSsoIdentityUserInfo } from "./lib/sso-email-domain.ts";
import { resolveEnterpriseSsoUser } from "./lib/sso-enterprise-gate.ts";
import { settleSsoMembership } from "./lib/sso-membership.ts";
import { providerIdFromSsoCallbackPath } from "./lib/sso-organization.ts";
import { encryptedMongoAdapter } from "./lib/sso-provider-encryption.ts";
import {
	boundedLoginDetail,
	daysSinceLastActive,
	formatLoginTime,
	isStaleAccountLogin,
} from "./lib/stale-account.ts";
import {
	platformAdminAccessControl,
	platformAdminRoles,
} from "./lib/step-up.ts";
import { resolveSessionForHook, stepUpGate } from "./lib/step-up-plugin.ts";
import { supportAccessPlugin } from "./lib/support-access-plugin.ts";
import { telegramMiniAppSessionPlugin } from "./lib/telegram-mini-app-session-plugin.ts";
import {
	ADMIN_ROLE,
	APPROVED_ROLE,
	adminEmails,
	generateReferralCode,
	isAdminEmail,
	isVerifiedAdminEmail,
	isWaitlistBypassed,
	reconciledAdminRole,
	referralUrlFor,
	WAITLIST_ROLE,
	webOrigin,
} from "./lib/waitlist.ts";
import { waitlistPositionFor } from "./lib/waitlist-queue.ts";
import {
	ryuOrganizationAccessControl,
	ryuOrganizationRoles,
} from "./organization-access.ts";
import {
	implicitPermissionsForRole,
	OAUTH_OPT_IN_SCOPES,
	RYU_DEFAULT_OAUTH_SCOPES,
	RYU_SUPPORTED_SCOPES,
} from "./scopes.ts";

const DUPLICATE_KEY_ERROR_CODE = 11_000;
const optionalPolarPlugins: Parameters<typeof polar>[0]["use"][number][] = [];
const userHookFieldsSchema = z.object({
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
function resolveSignupRole(user: {
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
const flagClaimSessionSchema = z
	.object({ activeOrganizationId: z.string().nullish().catch(null) })
	.catch(() => ({ activeOrganizationId: null }));
const polarPageItems = z
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
const invitationNotificationFieldsSchema = z
	.object({
		referralTag: organizationHookStringSchema,
		teamId: organizationHookStringSchema,
	})
	.catch(() => ({}));
const organizationHookBodySchema = z
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
const hookActiveOrganizationId = z
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
const auditReturnSchema = z
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

const ORGANIZATION_PRODUCT_IDS = (): Set<string> =>
	new Set(
		ORGANIZATION_PLAN_IDS.flatMap((planId) =>
			Object.values(PLANS[planId].bindings)
				.filter((binding): binding is NonNullable<typeof binding> =>
					Boolean(binding)
				)
				.map((binding) => resolveProductId(binding))
				.filter((productId) => !productId.startsWith("polar_product_"))
		)
	);

/**
 * Resolve the live admitting capacity for an organization, with the org kind
 * it was resolved for (the kind picks the refusal copy).
 *
 * - family: the Ryu Max family-sharing capacity registered by the API (six
 *   people when the owner's plan and the rollout flag allow it, else null). It
 *   never reads a Polar seat quantity or bonus seats: a family's plan is the
 *   owner's personal Max subscription, not a seat contract.
 * - otherwise: the live Teams seat quantity. A missing active Teams
 *   subscription returns null (shared membership has no paid capacity).
 *
 * A Polar or database failure is a hard error because allowing a paid-org
 * membership change while the meter is unknown would be an authorization
 * decision made blind.
 */
async function activeOrganizationSeatCapacity(organizationId: string): Promise<{
	kind: OrganizationKind | null;
	seatCapacity: number | null;
}> {
	try {
		const kind = await readOrganizationKind(organizationId);
		if (kind === FAMILY_ORGANIZATION_KIND) {
			return {
				kind,
				seatCapacity: await familySharingCapacity(organizationId),
			};
		}
		const customerId = await resolveOrganizationPolarCustomerId(organizationId);
		if (!customerId) {
			return { kind, seatCapacity: null };
		}

		const subscriptions = await polarClient.subscriptions.list({
			customerId,
			// Keep invitation authorization aligned with the billing router's
			// organization subscription resolver; old records must not hide a live plan.
			limit: 100,
		});
		const productIds = ORGANIZATION_PRODUCT_IDS();
		for await (const page of subscriptions) {
			const active = polarPageItems(page).find((subscription) => {
				const status = (subscription.status ?? "").toLowerCase();
				const productId =
					subscription.productId ?? subscription.product?.id ?? null;
				return (
					(status === "active" || status === "trialing") &&
					Boolean(productId && productIds.has(productId))
				);
			});
			if (active) {
				const productId = active.productId ?? active.product?.id ?? null;
				const activePlan = productId
					? planByProductId().get(productId)?.plan
					: null;
				const requested = Number(active.seats ?? active.quantity);
				const minimum =
					activePlan?.seatModel.kind === "per_seat"
						? activePlan.seatModel.minSeats
						: 1;
				const billedSeats = Number.isFinite(requested)
					? Math.max(Math.floor(requested), minimum)
					: minimum;
				return {
					kind,
					seatCapacity: (
						await activeTeamsSeatAllowance(organizationId, billedSeats)
					).includedSeats,
				};
			}
		}
		return { kind, seatCapacity: null };
	} catch (error) {
		console.error("Failed to verify organization seat capacity:", error);
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message:
				"We could not verify the organization’s seat capacity. Try again.",
		});
	}
}

/** The live admitting capacity alone; see {@link activeOrganizationSeatCapacity}. */
async function activeTeamsSeatCount(
	organizationId: string
): Promise<number | null> {
	return (await activeOrganizationSeatCapacity(organizationId)).seatCapacity;
}

const SEAT_CLAIM_TTL_MS = 2 * 60 * 1000;
const ORGANIZATION_INVITATION_EXPIRES_IN_SEC = 48 * 60 * 60;
const PENDING_INVITATION_CLAIM_PREFIX = "pending_invitation:";
const DIRECT_MEMBER_CLAIM_PREFIX = "direct_member:";

const pendingInvitationClaimId = (
	organizationId: string,
	email: string
): string =>
	`${PENDING_INVITATION_CLAIM_PREFIX}${createHash("sha256")
		.update(`${organizationId}:${normalizeInvitationEmail(email)}`)
		.digest("hex")}`;

const directMemberClaimId = (userId: string): string =>
	`${DIRECT_MEMBER_CLAIM_PREFIX}${userId}`;

async function requireActiveOrganizationSeatCapacity(
	organizationId: string
): Promise<{ copy: OrganizationSeatCopy; seatCapacity: number }> {
	const { kind, seatCapacity } =
		await activeOrganizationSeatCapacity(organizationId);
	const copy = organizationSeatCopy(kind);
	if (seatCapacity === null) {
		throw new APIError("FORBIDDEN", { message: copy.noCapacity });
	}
	return { copy, seatCapacity };
}

/**
 * Atomically claim one seat for a pending invitation, an accepting invitation,
 * or a trusted direct member add. The unique `(organizationId, seatIndex)`
 * index is the collision guard; the member count is deliberately read again
 * by every claimant instead of trusting a client-side roster.
 */
async function reserveSeatClaim(input: {
	allowExisting?: boolean;
	claimId: string;
	expiresAt?: Date;
	kind: "pending_invitation" | "accepting_invitation" | "direct_member";
	organizationId: string;
}): Promise<void> {
	const { copy, seatCapacity } = await requireActiveOrganizationSeatCapacity(
		input.organizationId
	);
	const now = new Date();
	const existing = await OrganizationSeatReservation.findOne({
		organizationId: input.organizationId,
		invitationId: input.claimId,
	});
	if (existing && existing.expiresAt > now) {
		if (input.allowExisting === false) {
			throw new APIError("FORBIDDEN", {
				message:
					"An invitation for this recipient is already being sent. Try again shortly.",
			});
		}
		// A billing admin may have reduced the subscription while this claim was
		// in flight. A reservation outside the new quantity is not authorization
		// to add a member; release it and reallocate inside the live seat range.
		if (existing.seatIndex < seatCapacity) {
			return;
		}
		await OrganizationSeatReservation.deleteOne({
			_id: existing._id,
			invitationId: input.claimId,
			organizationId: input.organizationId,
		});
	}
	if (existing) {
		await OrganizationSeatReservation.deleteOne({
			_id: existing._id,
			invitationId: input.claimId,
			organizationId: input.organizationId,
		});
	}

	const [memberCount, reservations] = await Promise.all([
		Member.countDocuments({ organizationId: input.organizationId }),
		OrganizationSeatReservation.find({
			organizationId: input.organizationId,
			expiresAt: { $gt: now },
		})
			.select("seatIndex")
			.lean<Array<{ seatIndex: number }>>(),
	]);
	const decision = decideSeatAdmission({
		billedSeats: seatCapacity,
		memberCount,
		reservedSeatCount: reservations.length,
	});
	if (!decision.allowed) {
		throw new APIError("FORBIDDEN", { message: copy.full });
	}

	const used = new Set(reservations.map((row) => row.seatIndex));
	const expiresAt =
		input.expiresAt ?? new Date(now.getTime() + SEAT_CLAIM_TTL_MS);
	// Existing members conceptually occupy the first `memberCount` seats. A
	// pending/accepting/direct claim starts after them, and Mongo's unique index
	// serializes two callers that both observe the same final free index.
	for (let seatIndex = memberCount; seatIndex < seatCapacity; seatIndex += 1) {
		if (used.has(seatIndex)) {
			continue;
		}
		try {
			await OrganizationSeatReservation.create({
				expiresAt,
				invitationId: input.claimId,
				kind: input.kind,
				organizationId: input.organizationId,
				seatIndex,
			});
			return;
		} catch (error) {
			if (!isDuplicateKeyError(error)) {
				throw error;
			}
			// The unique claim index can win this race too. If the original claim
			// is still inside the billed range, the operation is already authorized.
			const claimed = await OrganizationSeatReservation.findOne({
				expiresAt: { $gt: new Date() },
				invitationId: input.claimId,
				organizationId: input.organizationId,
			});
			if (claimed) {
				if (input.allowExisting === false) {
					throw new APIError("FORBIDDEN", {
						message:
							"An invitation for this recipient is already being sent. Try again shortly.",
					});
				}
				if (claimed.seatIndex < seatCapacity) {
					return;
				}
				throw new APIError("FORBIDDEN", { message: copy.capacityChanged });
			}
			// Mongo's TTL monitor is eventually consistent. Remove a stale row that
			// still owns the unique seat index, then retry this same index.
			const conflicting = await OrganizationSeatReservation.findOne({
				organizationId: input.organizationId,
				seatIndex,
			});
			if (conflicting && conflicting.expiresAt <= new Date()) {
				await OrganizationSeatReservation.deleteOne({
					_id: conflicting._id,
					organizationId: input.organizationId,
					seatIndex,
				});
				continue;
			}
			// Another admission won this index. Try the next one; the next loop's
			// unique insert remains the final authority if another race is in flight.
			used.add(seatIndex);
		}
	}
	throw new APIError("FORBIDDEN", { message: copy.full });
}

/**
 * Test seam for the real Mongo/Polar seat path (`index.family-seat.test.ts`).
 * Not a package API: production callers reach these only through the Better
 * Auth organization hooks below.
 */
export const organizationSeatPathForTests = {
	activeOrganizationSeatCapacity,
	reserveSeatClaim,
} as const;

/** Reserve the seat before Better Auth creates the pending invitation row. */
async function reservePendingInvitationSeat(input: {
	email: string;
	organizationId: string;
}): Promise<void> {
	const claimId = pendingInvitationClaimId(input.organizationId, input.email);
	const existing = await OrganizationSeatReservation.findOne({
		organizationId: input.organizationId,
		invitationId: claimId,
		expiresAt: { $gt: new Date() },
	});
	if (existing) {
		// There is no invitation id yet, so an existing deterministic claim means
		// another request is creating an invitation for the same recipient. Do not
		// let the second request reuse the first request's seat and then release it
		// if the invitation cooldown rejects the second request.
		throw new APIError("FORBIDDEN", {
			message:
				"An invitation for this recipient is already being sent. Try again shortly.",
		});
	}
	await reserveSeatClaim({
		allowExisting: false,
		claimId,
		expiresAt: new Date(Date.now() + SEAT_CLAIM_TTL_MS),
		kind: "pending_invitation",
		organizationId: input.organizationId,
	});
}

/** Convert a pending invitation claim into a short-lived acceptance claim. */
async function reserveInvitationSeat(input: {
	email: string;
	invitationId: string;
	organizationId: string;
	userId: string;
}): Promise<void> {
	if (
		await Member.exists({
			organizationId: input.organizationId,
			userId: input.userId,
		})
	) {
		return;
	}

	const { seatCapacity } = await requireActiveOrganizationSeatCapacity(
		input.organizationId
	);
	const now = new Date();
	const pendingClaimId = pendingInvitationClaimId(
		input.organizationId,
		input.email
	);
	const pending = await OrganizationSeatReservation.findOne({
		organizationId: input.organizationId,
		invitationId: pendingClaimId,
		kind: "pending_invitation",
		expiresAt: { $gt: now },
	});
	if (pending) {
		if (pending.seatIndex < seatCapacity) {
			const converted = await OrganizationSeatReservation.findOneAndUpdate(
				{
					_id: pending._id,
					expiresAt: { $gt: now },
					invitationId: pendingClaimId,
					kind: "pending_invitation",
					organizationId: input.organizationId,
				},
				{
					$set: {
						expiresAt: new Date(now.getTime() + SEAT_CLAIM_TTL_MS),
						invitationId: input.invitationId,
						kind: "accepting_invitation",
						updatedAt: now,
					},
				},
				{ new: true }
			);
			if (converted) {
				return;
			}
		} else {
			// A subscription reduction can make a previously reserved invitation
			// ineligible. Do not treat that old index as permission to accept.
			await OrganizationSeatReservation.deleteOne({
				_id: pending._id,
				invitationId: pendingClaimId,
				kind: "pending_invitation",
				organizationId: input.organizationId,
			});
		}
	}

	await reserveSeatClaim({
		claimId: input.invitationId,
		expiresAt: new Date(now.getTime() + SEAT_CLAIM_TTL_MS),
		kind: "accepting_invitation",
		organizationId: input.organizationId,
	});
}

async function reserveDirectMemberSeat(input: {
	organizationId: string;
	userId: string;
}): Promise<void> {
	await reserveSeatClaim({
		claimId: directMemberClaimId(input.userId),
		kind: "direct_member",
		organizationId: input.organizationId,
	});
}

/**
 * Revoke the custom-role grants of a member who left or was removed. Better
 * Auth deletes the `member` row and its team memberships, but Ryu's
 * `roleAssignment` rows and `user:<id>` vault policy bindings would otherwise
 * come back into force if the same user were invited again. Mirrors the
 * Admin API removal (`org-admin-ops.ts`). Best effort: the removal has already
 * happened. Console removal already revoked fail-closed in
 * `beforeRemoveMember`, and `revokeStaleRoleGrantsBeforeAdmission` fails
 * closed on re-admission.
 */
async function revokeRemovedMemberGrants(input: {
	organizationId: string;
	userId: string;
}): Promise<void> {
	try {
		await revokeOrganizationRoleAssignments(input);
	} catch (error) {
		// The member row is already gone, so this cannot fail the request. The
		// permission resolvers ignore grants older than the current membership,
		// so a leftover row never comes back into force; record it for admins.
		console.error("Failed to revoke removed member's role grants:", error);
		await recordRoleGrantCleanupFailure({ ...input, phase: "remove" });
	}
	// Vault policies bound directly to the user would otherwise come back into
	// force (secret reads, writes, approvals) if the same user were re-invited.
	try {
		await VaultPolicyBinding.deleteMany({
			organizationId: input.organizationId,
			subject: `user:${input.userId}`,
		});
	} catch (error) {
		// The vault principal ignores `user:<id>` bindings older than the
		// current membership, so a leftover never comes back into force on a
		// re-invite; record it for admins as for role grants.
		console.error("Failed to revoke removed member's vault bindings:", error);
		await recordRoleGrantCleanupFailure({
			...input,
			grant: "vault_bindings",
			phase: "remove",
		});
	}
	// Personal gateway keys and Fleet nodes issued for the member would
	// otherwise keep authenticating as an org node. The gateway and Fleet
	// resolvers re-check membership, so a failure here still fails closed.
	try {
		await revokeDepartedMemberNodeCredentials(input);
	} catch (error) {
		console.error("Failed to revoke removed member's node credentials:", error);
	}
}

/**
 * Revoke custom-role grants scoped to a team the user no longer belongs to
 * (or, without `userId`, to a deleted team). Team-scoped assignments require
 * team membership when granted; leaving them behind would silently restore the
 * role, and its gateway ACL role key, if the user were re-added to the team.
 */
async function revokeTeamScopedGrants(input: {
	organizationId: string;
	teamId: string;
	userId?: string;
}): Promise<void> {
	try {
		await RoleAssignment.deleteMany({
			organizationId: input.organizationId,
			teamId: input.teamId,
			...(input.userId ? { userId: input.userId } : {}),
		});
	} catch (error) {
		console.error("Failed to revoke team-scoped role grants:", error);
	}
}

/**
 * Fail closed on custom-role grants an earlier membership left behind (a
 * removal path whose best-effort cleanup failed, or a writer that skipped it):
 * before admitting a user to an organization (or, with `teamId`, to a team),
 * delete their grants there so a re-admission never revives them. Skipped
 * while the user still holds that membership, so a repeated or refused
 * admission cannot strip a current member's live grants.
 */
async function revokeStaleRoleGrantsBeforeAdmission(input: {
	organizationId: string;
	teamId?: string;
	userId: string;
}): Promise<void> {
	const { teamId } = input;
	if (teamId) {
		if (await TeamMember.exists({ teamId, userId: input.userId })) {
			return;
		}
		await revokeTeamRoleAssignments({ ...input, teamId });
		return;
	}
	if (
		await Member.exists({
			organizationId: input.organizationId,
			userId: input.userId,
		})
	) {
		return;
	}
	await revokeOrganizationRoleAssignments(input);
}

const leftMemberSchema = z.object({
	organizationId: z.coerce.string().min(1),
	userId: z.coerce.string().min(1),
});

async function releaseSeatClaims(input: {
	email?: string;
	invitationId?: string;
	organizationId: string;
	userId?: string;
}): Promise<void> {
	const claimIds = [
		input.invitationId,
		input.email
			? pendingInvitationClaimId(input.organizationId, input.email)
			: undefined,
		input.userId ? directMemberClaimId(input.userId) : undefined,
	].filter((claimId): claimId is string => Boolean(claimId));
	if (claimIds.length === 0) {
		return;
	}
	await OrganizationSeatReservation.deleteMany({
		invitationId: { $in: [...new Set(claimIds)] },
		organizationId: input.organizationId,
	});
}

/**
 * Better Auth handles `resend: true` as an in-place expiry update and returns
 * before running its organization invitation hooks. Extend the existing seat
 * claim as well; if an older invitation has no claim, acceptance will still
 * perform the authoritative live-capacity check before adding its member.
 */
async function refreshResentInvitationSeat(
	input: ResentInvitationSeat
): Promise<void> {
	await OrganizationSeatReservation.updateOne(
		{
			invitationId: input.invitationId,
			organizationId: input.organizationId,
		},
		{
			$set: {
				expiresAt: input.expiresAt,
				updatedAt: new Date(),
			},
		}
	);
}

// Better Auth's API-key plugin asks the organization access-control layer for
// `apiKey` permissions when it manages organization-owned keys. Keep that
// native management capability separate from Ryu's API-key scope vocabulary:
// org membership may manage the key record, but it never grants the key any
// Ryu capability by itself. The control-plane route still supplies the
// role-clamped Ryu statements at creation time.
const isDuplicateKeyError = z
	.unknown()
	.transform(
		(error) =>
			z.object({ code: z.literal(DUPLICATE_KEY_ERROR_CODE) }).safeParse(error)
				.success
	).parse;

/** A reserved invitation send, with what is needed to undo it. */
interface InvitationPolicyReservation {
	cooldownUntil: Date;
	email: string;
	organizationId: string;
	/** The fields the reservation overwrote, or null when it created the row. */
	previous: {
		cooldownUntil: Date | null;
		lastSentAt: Date | null;
	} | null;
}

async function reserveOrganizationInvitationPolicy(input: {
	email: string;
	organizationId: string;
}): Promise<InvitationPolicyReservation> {
	const now = new Date();
	const cooldownUntil = new Date(
		now.getTime() + ORGANIZATION_INVITATION_COOLDOWN_MS
	);
	try {
		const reserved = await OrganizationInvitationPolicy.findOneAndUpdate(
			{
				organizationId: input.organizationId,
				email: input.email,
				$and: [
					{
						$or: [{ blockedAt: null }, { blockedAt: { $exists: false } }],
					},
					{
						$or: [
							{ cooldownUntil: null },
							{ cooldownUntil: { $exists: false } },
							{ cooldownUntil: { $lte: now } },
						],
					},
				],
			},
			{
				$set: {
					cooldownUntil,
					lastSentAt: now,
				},
				$setOnInsert: {
					email: input.email,
					organizationId: input.organizationId,
				},
			},
			// The row as it was before, so an invitation whose email never went
			// out can give its cooldown back (releaseOrganizationInvitationPolicy).
			{ includeResultMetadata: true, lean: true, new: false, upsert: true }
		);
		const outcome = reserved.lastErrorObject;
		if (outcome?.updatedExisting || outcome?.upserted) {
			const previous = outcome.updatedExisting ? reserved.value : null;
			return {
				cooldownUntil,
				email: input.email,
				organizationId: input.organizationId,
				previous: previous
					? {
							cooldownUntil: previous.cooldownUntil ?? null,
							lastSentAt: previous.lastSentAt ?? null,
						}
					: null,
			};
		}
	} catch (error) {
		if (!isDuplicateKeyError(error)) {
			throw error;
		}
	}

	const policy = await OrganizationInvitationPolicy.findOne({
		organizationId: input.organizationId,
		email: input.email,
	});
	if (policy?.blockedAt) {
		throw new APIError("FORBIDDEN", {
			message: "This recipient has blocked invitations from this organization.",
		});
	}
	throw new APIError("TOO_MANY_REQUESTS", {
		message:
			"Please wait 24 hours before sending another invitation to this recipient.",
	});
}

/**
 * Give back a reservation whose invitation was never sent, so the 24-hour
 * cooldown does not stop the owner from sending it again. The filter matches
 * only this reservation (its exact `cooldownUntil`) and never a decline block.
 */
async function releaseOrganizationInvitationPolicy(
	reservation: InvitationPolicyReservation
): Promise<void> {
	const reserved = {
		blockedAt: null,
		cooldownUntil: reservation.cooldownUntil,
		email: reservation.email,
		organizationId: reservation.organizationId,
	};
	if (!reservation.previous) {
		await OrganizationInvitationPolicy.deleteOne(reserved);
		return;
	}
	await OrganizationInvitationPolicy.updateOne(reserved, {
		$set: reservation.previous,
	});
}

/**
 * Request-scoped state for the invitation hooks. Better Auth gives each
 * top-level request its own store, but a nested `auth.api` call reuses the
 * caller's (`to-auth-endpoints`), so every entry is keyed by the invitation it
 * belongs to rather than held in a single slot.
 */

/**
 * What `beforeCreateInvitation` reserved for an invitation this request is
 * creating, keyed by organization and recipient (the id does not exist yet).
 * Better Auth writes the invitation before it calls `sendInvitationEmail`, with
 * no transaction around the two, so an invitation whose email does not go out
 * must give these back.
 */
interface InvitationBeingCreated {
	email: string;
	organizationId: string;
	policy: InvitationPolicyReservation;
}

const invitationsBeingCreated = defineRequestState(
	() => new Map<string, InvitationBeingCreated>()
);

const invitationCreationKey = (organizationId: string, email: string) =>
	`${organizationId}:${normalizeInvitationEmail(email)}`;

/** Take the reservations made for this invitation, if this request made them. */
async function takeInvitationBeingCreated(invitation: {
	email: string;
	organizationId: string;
}): Promise<InvitationBeingCreated | null> {
	if (!(await hasRequestState())) {
		return null;
	}
	const creating = await invitationsBeingCreated.get();
	const key = invitationCreationKey(
		invitation.organizationId,
		invitation.email
	);
	const reserved = creating.get(key) ?? null;
	creating.delete(key);
	return reserved;
}

/**
 * Invitations as they were before a resend, by id, recorded by the global
 * before hook. Better Auth stores a resend's new expiry before it calls
 * `sendInvitationEmail`; a resend whose email is not sent puts the old expiry
 * back, so the invitation and its seat claim are left as they were.
 */
const invitationsBeforeResend = defineRequestState(
	() => new Map<string, Date>()
);

type AuthAdapter = Awaited<
	ReturnType<typeof getCurrentAuthContext>
>["context"]["adapter"];

/**
 * Record a resend's pending invitation before Better Auth changes it. Only for
 * a request that carries a session (the endpoint authorizes it next), and only
 * in the named organization: one recipient can hold pending invitations from
 * many organizations.
 */
async function rememberInvitationsBeforeResend(
	adapter: AuthAdapter,
	body: z.infer<typeof organizationHookBodySchema>
): Promise<void> {
	if (!(body.resend === true && body.email && (await hasRequestState()))) {
		return;
	}
	try {
		const pending = await adapter.findMany<{ expiresAt: Date; id: string }>({
			// Without an organization in the body Better Auth uses the session's
			// active one; the read is then bounded and may miss the target, in
			// which case the seat claim follows the stored expiry instead.
			limit: 50,
			model: "invitation",
			where: [
				{ field: "email", value: normalizeInvitationEmail(body.email) },
				{ field: "status", value: "pending" },
				...(body.organizationId
					? [{ field: "organizationId", value: body.organizationId }]
					: []),
			],
		});
		const before = await invitationsBeforeResend.get();
		for (const { expiresAt, id } of pending) {
			before.set(id, expiresAt);
		}
	} catch (error) {
		console.error("Failed to read an invitation before its resend:", error);
	}
}

/**
 * An invitation email that was not sent in this request, by invitation id.
 * Better Auth runs `sendInvitationEmail` through `runInBackgroundOrAwait`,
 * which logs and swallows anything it throws, so the failure is recorded here
 * and raised by `afterCreateInvitation` (a new invitation) or the global after
 * hook (a resend) instead.
 */
interface UnsentInvitationEmail {
	error: unknown;
	/** The expiry Better Auth stored for this send. */
	expiresAt: Date;
	invitationId: string;
	organizationId: string;
}

const unsentInvitationEmails = defineRequestState(
	() => new Map<string, UnsentInvitationEmail>()
);

/** Take the recorded failure for one invitation, if its email was not sent. */
async function takeUnsentInvitationEmail(
	invitationId: string
): Promise<UnsentInvitationEmail | null> {
	if (!(await hasRequestState())) {
		return null;
	}
	const unsent = await unsentInvitationEmails.get();
	const recorded = unsent.get(invitationId) ?? null;
	unsent.delete(invitationId);
	return recorded;
}

type InvitationEmail = Parameters<
	NonNullable<OrganizationOptions["sendInvitationEmail"]>
>[0];

/** Run the invitation email and record a failure instead of only logging it. */
function recordUnsentInvitationEmail(
	send: (invitation: InvitationEmail) => Promise<void>
): (invitation: InvitationEmail) => Promise<void> {
	return async (invitation) => {
		try {
			await send(invitation);
		} catch (error) {
			console.error("Failed to send organization invitation email:", error);
			if (await hasRequestState()) {
				(await unsentInvitationEmails.get()).set(invitation.id, {
					error,
					expiresAt: invitation.invitation.expiresAt,
					invitationId: invitation.id,
					organizationId: invitation.organization.id,
				});
			}
		}
	};
}

/** Give back the seat claim and 24-hour cooldown one request reserved. */
async function releaseInvitationReservations(
	reserved: InvitationBeingCreated,
	invitationId?: string
): Promise<void> {
	const releases = await Promise.allSettled([
		releaseSeatClaims({
			email: reserved.email,
			invitationId,
			organizationId: reserved.organizationId,
		}),
		releaseOrganizationInvitationPolicy(reserved.policy),
	]);
	for (const release of releases) {
		if (release.status === "rejected") {
			console.error(
				"Failed to release a reservation of an organization invitation:",
				release.reason
			);
		}
	}
}

const unwrittenInvitationSchema = z.object({
	email: z.string(),
	organizationId: z.string(),
});

/**
 * Better Auth writes a new invitation after `beforeCreateInvitation` reserved
 * its seat claim and 24-hour cooldown. When that database write fails, Better
 * Auth rethrows the database error, so neither `afterCreateInvitation` nor the
 * after hooks run. The adapter is the only Ryu code on that path: give back
 * what this request reserved for that invitation there, and let the error
 * continue. Nothing is released for an invitation this request did not
 * reserve.
 */
function releaseReservationsOfFailedInvitationWrites(
	factory: ReturnType<typeof encryptedMongoAdapter>
): ReturnType<typeof encryptedMongoAdapter> {
	return (options) => {
		const adapter = factory(options);
		return {
			...adapter,
			create: async <T extends Record<string, unknown>, R = T>(
				input: Parameters<typeof adapter.create<T, R>>[0]
			): Promise<R> => {
				try {
					return await adapter.create<T, R>(input);
				} catch (error) {
					const unwritten = unwrittenInvitationSchema.safeParse(input.data);
					if (input.model === "invitation" && unwritten.success) {
						const reserved = await takeInvitationBeingCreated(unwritten.data);
						if (reserved) {
							await releaseInvitationReservations(reserved);
						}
					}
					throw error;
				}
			},
		};
	};
}

/**
 * What became of a new invitation whose email was not sent:
 * - `withdrawn`: removed, with its seat claim and cooldown given back;
 * - `settled`: accepted, declined or cancelled while the email was at the
 *   provider, so it was used and keeps what it reserved;
 * - `kept`: the database would not remove it, so it stays pending without its
 *   email.
 */
type UnsentInvitationOutcome = "kept" | "settled" | "withdrawn";

/**
 * Remove a new invitation whose email was not sent, then give back its seat
 * claim and 24-hour cooldown, so nothing is left that looks pending or blocks
 * the owner from sending it again. Nothing is given back unless exactly that
 * pending invitation was removed.
 */
async function withdrawUnsentInvitation(
	adapter: AuthAdapter,
	invitation: {
		email: string;
		expiresAt: Date;
		id: string;
		organizationId: string;
	}
): Promise<UnsentInvitationOutcome> {
	const reserved = await takeInvitationBeingCreated(invitation);
	let removed: number;
	try {
		// Only the send attempt that failed: a resend that went out meanwhile
		// moved `expiresAt`, and its working link must not be withdrawn.
		removed = await adapter.deleteMany({
			model: "invitation",
			where: [
				{ field: "id", value: invitation.id },
				{ field: "status", value: "pending" },
				{ field: "expiresAt", value: invitation.expiresAt },
			],
		});
	} catch (error) {
		console.error(
			"Failed to withdraw an organization invitation whose email was not sent:",
			error
		);
		return "kept";
	}
	if (removed !== 1) {
		return "settled";
	}
	if (reserved) {
		await releaseInvitationReservations(reserved, invitation.id);
	}
	return "withdrawn";
}

/** The id of the invitation an `invite-member` call answered with, if any. */
const returnedInvitationId = (returned: unknown): string | null => {
	const parsed = z.object({ id: z.string().min(1) }).safeParse(returned);
	return parsed.success ? parsed.data.id : null;
};

/**
 * Put back the expiry a resend stored when its email was not sent. Without the
 * earlier expiry, keep the seat claim on the stored one instead.
 */
async function restoreInvitationAfterUnsentResend(
	adapter: AuthAdapter,
	unsent: UnsentInvitationEmail
): Promise<void> {
	try {
		const before = (await invitationsBeforeResend.get()).get(
			unsent.invitationId
		);
		if (!before) {
			await refreshResentInvitationSeat(unsent);
			return;
		}
		await adapter.update({
			model: "invitation",
			update: { expiresAt: before },
			where: [
				{ field: "id", value: unsent.invitationId },
				{ field: "expiresAt", value: unsent.expiresAt },
			],
		});
	} catch (error) {
		console.error(
			"Failed to restore an organization invitation whose resend email was not sent:",
			error
		);
	}
}

/**
 * Resolve the durable personal/teams/family kind, with a legacy fallback: an
 * unmarked org is personal when it is its first member's personal org, and
 * otherwise shared (null, admitted under the Teams rules).
 */
async function resolveOrganizationKind(
	organizationId: string,
	metadata?: OrganizationMetadataInput
): Promise<OrganizationKind | null> {
	// The authoritative field wins over the hook's metadata, which Better Auth
	// read from the same row and which a stale organization update can carry
	// (see `organizationKindFromRecord`).
	const authoritative = await readOrganizationKind(organizationId);
	const kind = authoritative ?? organizationKindFromMetadata(metadata ?? null);
	if (kind) {
		return kind;
	}

	const firstMember = await Member.findOne({ organizationId })
		.sort({ createdAt: 1 })
		.select("userId")
		.lean<Pick<ReturnType<typeof Member.hydrate>, "userId">>();
	if (!firstMember) {
		return null;
	}
	const personalOrgId = await resolvePersonalOrgId(String(firstMember.userId));
	return personalOrgId === organizationId ? PERSONAL_ORGANIZATION_KIND : null;
}

/** The account id for an already-normalized email, or null when none exists. */
async function findUserIdByEmail(email: string): Promise<string | null> {
	const user = await User.findOne({ email }, "_id").lean<{ _id: unknown }>();
	return user ? String(user._id) : null;
}

/**
 * Admission decisions for every organization hook below, wired to the Mongo
 * seat claims, Polar capacity and family-sharing capacity in this file.
 */
const organizationAdmission = createOrganizationAdmission({
	activeSeatCapacity: activeTeamsSeatCount,
	claimFamilyPlace: (place) =>
		claimFamilyMembershipSlot({
			...place,
			listFamilyOrganizationIds: userFamilyOrganizationIds,
		}),
	confirmFamilyPlace: confirmFamilyMembershipSlot,
	countMembers: (organizationId) => Member.countDocuments({ organizationId }),
	familyOrganizationIdsForUser: userFamilyOrganizationIds,
	findUserIdByEmail,
	hasFamilyPlace: familyMembershipSlotExists,
	readOrganizationKind,
	releaseFamilyPlace: releaseFamilyMembershipSlot,
	releaseSeatClaims,
	removeMember: async ({ memberId, organizationId, userId }) => {
		await Member.deleteOne({ _id: memberId, organizationId, userId });
	},
	reserveDirectMemberSeat,
	// Record what each send reserved, so an invitation whose write fails or
	// whose email is not sent can give its 24-hour cooldown back.
	reserveInvitationPolicy: async (input) => {
		const policy = await reserveOrganizationInvitationPolicy(input);
		if (await hasRequestState()) {
			(await invitationsBeingCreated.get()).set(
				invitationCreationKey(input.organizationId, input.email),
				{ email: input.email, organizationId: input.organizationId, policy }
			);
		}
	},
	reserveInvitationSeat,
	reservePendingInvitationSeat,
	resolveOrganizationKind,
});

/**
 * Finish an invitation cancellation that won the invitation's single
 * pending -> canceled transition: release its seat claims and any family place
 * an unfinished accept reserved, then tell the organization and the recipient.
 * Better Auth's `afterCancelInvitation` hook and Ryu's atomic revoke route
 * (`cancelInvitationAtomically` in packages/api) both finish through this one
 * function, so neither path can skip a release or the notification. Call it
 * only for the winning cancellation; an idempotent retry must not notify again.
 */
export async function finalizeCanceledOrganizationInvitation(invitation: {
	email: string | null;
	id: string;
	organizationId: string;
}): Promise<void> {
	const email = invitation.email || null;
	await releaseSeatClaims({
		email: email ?? undefined,
		invitationId: invitation.id,
		organizationId: invitation.organizationId,
	});
	if (email) {
		await organizationAdmission.releaseInvitationFamilyPlace({
			email,
			organizationId: invitation.organizationId,
		});
	}
	await notifyOrganizationEvent({
		actionLabel: "Manage organization members",
		actionUrl: organizationAppUrl("/organizations/invitations"),
		actionUrlForOrganization: () =>
			organizationAppUrl("/organizations/members"),
		body: email
			? `The invitation for ${normalizeInvitationEmail(email)} was cancelled.`
			: "An invitation was cancelled.",
		dedupeKey: `organization-invitation:${invitation.id}:cancelled`,
		extraRecipients: email
			? [
					{
						actionLabel: "Open invitations",
						actionUrl: organizationAppUrl("/organizations/invitations"),
						email,
					},
				]
			: [],
		kind: "organization-invitation",
		organizationIds: [String(invitation.organizationId)],
		sourceId: String(invitation.id),
		sourceType: "organization-invitation",
		subject: "Organization invitation cancelled",
		title: "Organization invitation cancelled",
	});
}

const boundedOrganizationHookValue = z.union([
	z
		.string()
		.transform((value) => (value.trim() ? value.trim().slice(0, 300) : null)),
	z
		.custom<Date>((value) => value instanceof Date)
		.transform((value) => value.toISOString()),
	z.null().transform(() => null),
	z.undefined().transform(() => null),
	z.coerce.string().transform((value) => value.slice(0, 300)),
]).parse;

/**
 * Publish the non-sensitive activity projection for Better Auth organization
 * lifecycle hooks. The generic auth after-hook records the mutation itself;
 * this projection is the user-facing fan-out that keeps owners/admins informed
 * without copying request bodies or credentials into notifications.
 */
async function notifyOrganizationHookActivity(input: {
	body: string;
	event: string;
	organizationId: unknown;
	sourceId: unknown;
	sourceType: string;
	target: "member" | "organization" | "team" | "team-member";
	title: string;
	updatedAt?: unknown;
}): Promise<void> {
	const organizationId = boundedOrganizationHookValue(input.organizationId);
	const sourceId = boundedOrganizationHookValue(input.sourceId);
	if (!(organizationId && sourceId)) {
		return;
	}
	const revision =
		boundedOrganizationHookValue(input.updatedAt) ?? String(Date.now());
	await notifyOrganizationEvent({
		actionLabel: "Open organization",
		actionUrl: organizationAppUrl(`/organizations/${organizationId}`),
		body: input.body,
		dedupeKey: `organization-hook:${input.event}:${sourceId}:${revision}`,
		kind: "organization-activity",
		organizationIds: [organizationId],
		sourceId,
		sourceType: input.sourceType,
		subject: input.title,
		title: input.title,
	});
}

// Narrow an unknown caught error to its string `code` (e.g. better-auth's
// RATE_LIMIT_EXCEEDED) without an `as any` cast.
const errorCode = z
	.object({ code: z.union([z.string(), z.number()]) })
	.transform((error) => String(error.code))
	.optional()
	.catch(undefined).parse;

interface EmailUser {
	email: string;
	name?: string | null;
}

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY?.trim() || null;
const TURNSTILE_CAPTCHA_ENABLED =
	TURNSTILE_SECRET_KEY !== null || process.env.NODE_ENV === "production";

interface LoginSession {
	createdAt?: Date;
	ipAddress?: string | null;
	userAgent?: string | null;
	userId?: string;
}

/**
 * Record the successful session and, only when the previous session was dormant,
 * send the two stale-account notifications. The atomic read-before-update
 * prevents concurrent logins from sending duplicate alerts.
 */
async function recordLoginAndNotifyStaleAccount(
	session: LoginSession
): Promise<void> {
	if (!session.userId) {
		return;
	}

	const now = new Date();
	try {
		const previous = await User.findOneAndUpdate(
			{ _id: session.userId, isAnonymous: { $ne: true } },
			{
				$set: {
					lastLoginAt: now,
					// Sealed per user once content sealing is on (nothing reads them back here).
					lastLoginDevice: writeBound(
						"user",
						"lastLoginDevice",
						session.userId,
						session.userId,
						boundedLoginDetail(session.userAgent) ?? null
					),
					lastLoginIp: writeBound(
						"user",
						"lastLoginIp",
						session.userId,
						session.userId,
						boundedLoginDetail(session.ipAddress) ?? null
					),
				},
			},
			{ new: false }
		).lean<{
			email?: string;
			lastLoginAt?: Date;
			name?: string;
		}>();

		const lastLoginAt = previous?.lastLoginAt;
		if (!(previous?.email && lastLoginAt instanceof Date)) {
			return;
		}
		if (!isStaleAccountLogin(lastLoginAt, now)) {
			return;
		}

		const loginTime = formatLoginTime(session.createdAt ?? now);
		const inactiveDays = daysSinceLastActive(lastLoginAt, now);
		const loginDevice = boundedLoginDetail(session.userAgent);
		const loginIp = boundedLoginDetail(session.ipAddress);
		const securityUrl = `${webOrigin()}/settings?tab=account`;
		const sends = [
			sendEmail({
				to: previous.email,
				subject: "Your Ryu account was accessed",
				react: StaleAccountUserEmail({
					daysSinceLastActive: inactiveDays,
					loginDevice,
					loginIp,
					loginTime,
					securityUrl,
					userEmail: previous.email,
					userName: previous.name || "there",
				}),
			}),
		];

		for (const adminEmail of adminEmails()) {
			sends.push(
				sendEmail({
					to: adminEmail,
					subject: "Dormant Ryu account reactivated",
					react: StaleAccountAdminEmail({
						adminEmail,
						daysSinceLastActive: inactiveDays,
						loginDevice,
						loginIp,
						loginTime,
						userEmail: previous.email,
						userId: session.userId,
						userName: previous.name || "there",
					}),
				})
			);
		}

		await Promise.allSettled(sends);
	} catch (error) {
		// A security notification must never turn a successful login into a
		// failed login. The account timestamp is still useful if mail is down.
		console.error("Failed to record stale-account login notification:", error);
	}
}

const retryAfterSeconds = z
	.object({ retryAfter: z.number().optional() })
	.optional()
	.transform((error) => error?.retryAfter)
	.catch(undefined).parse;

const EMAIL_COOLDOWN_MS = 60 * 1000;
const EMAIL_DAILY_LIMIT = 20;

/**
 * Start a fresh daily email count when the stored one belongs to an earlier
 * day. Also normalizes a null count (users created before the field existed),
 * which `$inc` and range filters would otherwise trip over.
 */
async function rollEmailDayOver(userId: unknown, today: Date): Promise<void> {
	await User.updateOne(
		{
			_id: userId,
			$or: [
				{ lastEmailResetDate: { $not: { $gte: today } } },
				{ dailyEmailCount: null },
			],
		},
		{ $set: { dailyEmailCount: 0, lastEmailResetDate: today } }
	);
}

/**
 * Undo one cooldown claim whose email was never delivered, restoring the
 * stamp it replaced. Only while the claim is still the latest stamp: a later
 * claim or a counted delivery has moved `lastEmailSentAt` and is kept.
 */
async function releaseEmailCooldownClaim(
	userId: unknown,
	claimedAt: Date,
	previous: Date | null
): Promise<void> {
	await User.updateOne(
		{ _id: userId, lastEmailSentAt: claimedAt },
		previous
			? { $set: { lastEmailSentAt: previous } }
			: { $unset: { lastEmailSentAt: 1 } }
	);
}

const checkEmailRateLimit = async (email: string): Promise<RateLimitResult> => {
	try {
		const user = await User.findOne({ email: email.toLowerCase() });

		if (!user) {
			return { allowed: true };
		}

		const now = new Date();
		const today = new Date();
		today.setHours(0, 0, 0, 0);

		// Roll the daily counter over first, as its own conditional write, so the
		// claim below sees today's count rather than yesterday's in-memory value.
		await rollEmailDayOver(user._id, today);

		// Claim the cooldown slot atomically. A read-then-check let concurrent
		// requests (parallel resets, sign-up retries) all pass before the first
		// send stamped `lastEmailSentAt`, defeating the per-recipient cooldown.
		// `updateEmailStats` still counts the delivery after a successful send,
		// and a send that never delivers releases the claim, so a provider outage
		// does not start a cooldown for an email nobody received.
		const claimed = await User.findOneAndUpdate(
			{
				_id: user._id,
				dailyEmailCount: { $not: { $gte: EMAIL_DAILY_LIMIT } },
				lastEmailSentAt: {
					$not: { $gt: new Date(now.getTime() - EMAIL_COOLDOWN_MS) },
				},
			},
			{ $set: { lastEmailSentAt: now } },
			// The document as it was, so a release can restore the prior stamp.
			{ new: false }
		);
		if (claimed) {
			const previous = claimed.lastEmailSentAt ?? null;
			return {
				allowed: true,
				release: () => releaseEmailCooldownClaim(user._id, now, previous),
			};
		}

		const current = await User.findOne({ _id: user._id });
		if ((current?.dailyEmailCount ?? 0) >= EMAIL_DAILY_LIMIT) {
			const tomorrow = new Date(today);
			tomorrow.setDate(tomorrow.getDate() + 1);
			const retryAfter = Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);

			return {
				allowed: false,
				reason:
					"You have reached the daily email limit. Please try again tomorrow",
				retryAfter,
			};
		}

		const lastSentAt = current?.lastEmailSentAt?.getTime() ?? now.getTime();
		const retryAfter = Math.max(
			1,
			Math.ceil((EMAIL_COOLDOWN_MS - (now.getTime() - lastSentAt)) / 1000)
		);
		return {
			allowed: false,
			reason: "Please wait before requesting another email",
			retryAfter,
		};
	} catch (error) {
		console.error("Error checking email rate limit:", error);
		return { allowed: true };
	}
};

const updateEmailStats = async (email: string): Promise<void> => {
	try {
		const user = await User.findOne({ email: email.toLowerCase() });

		if (!user) {
			return;
		}

		const now = new Date();
		const today = new Date();
		today.setHours(0, 0, 0, 0);

		await rollEmailDayOver(user._id, today);
		// `$inc`, not read-then-`$set`: concurrent sends must each be counted.
		await User.updateOne(
			{ _id: user._id },
			{ $set: { lastEmailSentAt: now }, $inc: { dailyEmailCount: 1 } }
		);
	} catch (error) {
		console.error("Error updating user email stats:", error);
	}
};

configureRateLimiting(checkEmailRateLimit, updateEmailStats);
configureNotificationRateLimiting(checkNotificationEmailRateLimit);

const saveContactIdToUser = async (
	email: string,
	contactId: string
): Promise<void> => {
	try {
		const user = await User.findOne({ email: email.toLowerCase() });
		if (!user) {
			return;
		}
		if (!user.resendContactId) {
			await User.updateOne(
				{ _id: user._id },
				{ $set: { resendContactId: contactId } }
			);
		}
	} catch (error) {
		console.error("Error saving contact ID to user:", error);
	}
};

configureContactIdSaver(saveContactIdToUser);
configureSentEmailRecorder(recordSentEmail);

// The browser extension's pages (dashboard.html, popup) run on a fixed
// chrome-extension:// origin and call Better Auth directly (device-auth flow,
// matching desktop + CLI). That origin must be trusted or POSTs to
// /api/auth/device/* are rejected by Better Auth's origin/CSRF check. The
// desktop never needed this because Core calls these endpoints server-side
// (reqwest) with no Origin header.
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1"]);

function frontendOrigin(): string | undefined {
	const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
	try {
		return new URL(frontendUrl).origin;
	} catch {
		return undefined;
	}
}

interface PasskeyWebAuthnOptionsResult {
	origin?: string;
	rpID?: string;
}

function passkeyWebAuthnOptions(): PasskeyWebAuthnOptionsResult {
	const origin = frontendOrigin();
	if (!origin) {
		return {};
	}

	try {
		return {
			origin,
			rpID: new URL(origin).hostname,
		};
	} catch {
		return {};
	}
}

const PASSKEY_WEBAUTHN_OPTIONS = passkeyWebAuthnOptions();

/** Strip a leading `www.` so api.ryuhq.com + www.ryuhq.com share ryuhq.com. */
function normalizeHostname(hostname: string): string {
	return hostname.replace(/^www\./, "");
}

/**
 * When the auth API and marketing web live on sibling subdomains (api.ryuhq.com
 * vs ryuhq.com), the session cookie must use the shared parent domain or SSR on
 * the apex never sees it and /login <-> /console loops forever. Explicit
 * AUTH_COOKIE_DOMAIN wins; otherwise infer from FRONTEND_URL + BETTER_AUTH_URL.
 */
function resolveAuthCookieDomain(): string | undefined {
	if (env.AUTH_COOKIE_DOMAIN) {
		return env.AUTH_COOKIE_DOMAIN;
	}

	const frontendUrl = process.env.FRONTEND_URL;
	if (!frontendUrl) {
		return undefined;
	}

	try {
		const authHost = normalizeHostname(new URL(env.BETTER_AUTH_URL).hostname);
		const frontendHost = normalizeHostname(new URL(frontendUrl).hostname);

		if (authHost === frontendHost) {
			return undefined;
		}
		if (LOCAL_DEV_HOSTS.has(authHost) || LOCAL_DEV_HOSTS.has(frontendHost)) {
			return undefined;
		}
		if (authHost.endsWith(`.${frontendHost}`)) {
			return frontendHost;
		}
		if (frontendHost.endsWith(`.${authHost}`)) {
			return authHost;
		}
	} catch {
		return undefined;
	}

	return undefined;
}

function parseCorsOrigins(): string[] {
	return resolveRyuCorsOrigins({
		corsOrigin: process.env.CORS_ORIGIN,
		extensionOrigin: process.env.EXTENSION_ORIGIN,
		frontendUrl: frontendOrigin(),
		nodeEnv: env.NODE_ENV,
		webappUrl: env.WEBAPP_URL || "https://app.ryuhq.com",
	});
}

function parseCsvEnv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * Recover a referral code from the `ryu_ref` cookie on the sign-up request.
 * Social/OAuth sign-up (`signIn.social`) has no request body to carry a
 * `referredBy` field, so a Google-referred visitor's code only survives as the
 * cookie the web client set when they landed on a `?ref=` link. The DB create
 * hook reads it here so social referrals attribute the same as email/password.
 * Defensive against Better Auth's context shape: returns undefined if the
 * cookie (or the context) is absent, so a missing cookie is simply a no-op.
 */
interface ReferralCookieContext {
	headers?: Pick<Headers, "get"> | null;
	request?: { headers?: Pick<Headers, "get"> | null } | null;
}
function referredByFromCookie(
	ctx: ReferralCookieContext | null | undefined
): string | undefined {
	const cookieHeader =
		ctx?.headers?.get?.("cookie") ??
		ctx?.request?.headers?.get?.("cookie") ??
		null;
	if (!cookieHeader) {
		return;
	}
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) {
			continue;
		}
		const key = part.slice(0, eq).trim();
		if (key === "ryu_ref") {
			const value = decodeURIComponent(part.slice(eq + 1).trim()).trim();
			return value || undefined;
		}
	}
	return;
}

interface OrgClaim {
	id: string;
	role: string;
}

/** Mirrors Core's `TeamMembership` — the keys are a wire contract, keep them short. */
interface TeamClaim {
	id: string;
	org: string;
	role: string;
}

/**
 * Resolves the team claims embedded in a user's JWT, given the org claims already
 * resolved for the same payload.
 *
 * Better Auth's `teamMember` row carries no role of its own (verified against the
 * organization plugin's schema), so a team's effective role is the user's role in
 * the team's owning org — hence the join back through `orgs`. A team whose org is
 * not in `orgs` is dropped: a team is only ever reachable through its org, which
 * is exactly what Core narrows on, so carrying it would only inflate every token.
 *
 * Never throws. Teams are additive to a payload that already works, so a failure
 * here degrades to "no teams" (fail closed for team access) instead of failing
 * the whole mint the way an unreadable org roster does.
 */
async function resolveTeamClaims(
	userId: string,
	teamIds: string[],
	orgs: OrgClaim[]
): Promise<TeamClaim[]> {
	if (teamIds.length === 0) {
		return [];
	}
	try {
		// `org.id` and `team.organizationId` are both ObjectId-backed (see the
		// schema note in `control-plane.model.ts`), so BOTH the key and the lookup
		// go through `String(...)`. Comparing them raw type-checks but misses by
		// reference — two ObjectId instances for the same id are never `===` — and
		// the `flatMap` would then drop every team, shipping `teams: []` in every
		// token with nothing logged. Normalizing only the lookup side is the same
		// bug wearing a green typecheck.
		const roleByOrg = new Map(orgs.map((org) => [String(org.id), org.role]));
		const teams = await Team.find({ _id: { $in: teamIds } }).lean();
		return teams.flatMap((team) => {
			const org = String(team.organizationId);
			const role = roleByOrg.get(org);
			return role ? [{ id: String(team._id), org, role }] : [];
		});
	} catch (error) {
		console.error("Failed to resolve teams for JWT:", error, { userId });
		return [];
	}
}

/**
 * Make the stored role agree with the admin allowlist for a VERIFIED address.
 *
 * The user-create hook writes the role once, from `isVerifiedAdminEmail(user)`.
 * An address added to `ADMIN_EMAILS` after its account existed, or one whose
 * mailbox was proven after sign-up, would otherwise never receive it. Server
 * gates that see the session user (`requirePlatformAdmin`, `isAdmin` with
 * `emailVerified`) already admit such a verified address, but gates that read
 * only the stored role, every client-side admin affordance, and the Better Auth
 * admin plugin's `adminRoles` check do not until this runs. It runs on session
 * create, on `afterEmailVerification`, and when an update verifies the mailbox.
 *
 * The reverse also holds: an allowlisted address that is NOT verified loses an
 * `ADMIN_ROLE` it carries (stamped before verification was required) and goes
 * back to the signup role, so an unproven address never keeps admin. Proving
 * the mailbox promotes it again. An unlisted admin (granted through the admin
 * plugin) is left alone.
 *
 * Fail-open: a lookup error must never block login.
 */
async function reconcileAdminRole(userId: string): Promise<void> {
	try {
		const record = await User.findById(userId)
			.select("email emailVerified role")
			.lean<{ email?: string; emailVerified?: boolean; role?: string }>();
		if (!record) {
			return;
		}
		// Only a verified address earns the durable role; an unverified one is
		// promoted later, by `afterEmailVerification` or the next session.
		const role = reconciledAdminRole(record);
		if (!role) {
			return;
		}
		// Conditional on the role read above, so a concurrent change wins.
		await User.updateOne(
			{ _id: userId, role: record.role ?? null },
			{ $set: { role } }
		);
	} catch (error) {
		console.error("Failed to reconcile admin role:", error);
	}
}

interface RyuPasskeyPlugin extends ReturnType<typeof passkey> {}
interface RyuScimPlugin extends ReturnType<typeof scim> {}

function createRyuPasskeyPlugin(): RyuPasskeyPlugin {
	return passkey({
		...PASSKEY_WEBAUTHN_OPTIONS,
		rpName: "Ryu",
		authentication: {
			afterVerification: ({ ctx }) => assertPendingPasskeyMatches(ctx),
		},
	});
}

/**
 * Member-exit cleanup for a membership SCIM deprovisioning removed. Mirrors
 * `afterRemoveMember` (seat claim, custom-role grants, personal node
 * credentials, family bot grants and place) and records the removal in the
 * control audit log. Runs after the SCIM transaction commits.
 */
async function cleanUpScimRemovedMember(
	removed: ScimRemovedMember
): Promise<void> {
	const membership = {
		organizationId: removed.organizationId,
		userId: removed.userId,
	};
	await releaseSeatClaims(membership);
	await revokeRemovedMemberGrants(membership);
	await disableFamilyBotGrantsOnMemberExit(membership);
	await organizationAdmission.releaseMemberFamilyPlace(membership);
	try {
		await recordOrganizationControlAudit({
			action: "member.remove",
			actorId: null,
			actorType: "system",
			details: { source: "scim", status: "success", userId: removed.userId },
			organizationId: removed.organizationId,
			target: "member",
			targetId: removed.memberId,
		});
	} catch (error) {
		console.error("Failed to append SCIM member removal audit:", error);
	}
	await notifyOrganizationHookActivity({
		body: "Directory sync (SCIM) deprovisioned a member and removed their organization access.",
		event: "member.removed",
		organizationId: removed.organizationId,
		sourceId: removed.memberId,
		sourceType: "member",
		target: "member",
		title: "Organization member removed",
	});
}

function createRyuScimPlugin(): RyuScimPlugin {
	return scim({
		// Ryu provisions SCIM connections through the organization-scoped
		// Enterprise router. Better Auth owns the managed connection catalog and
		// stores only credential digests; no personal/static token path is exposed.
		connections: [],
		managedConnections: {
			credentialHashSecret: env.BETTER_AUTH_SECRET,
			maxActiveCredentials: 5,
		},
		// Link existing verified-domain non-owner members (who joined through SSO
		// before SCIM ran) so the directory can deprovision them too.
		identity: createScimIdentity(),
		// A connection's provisioningDomainId is its organization. Deactivating
		// or deleting the user's last active source there removes the membership
		// (never an owner's; revocation runs through runScimConnectionRetirement).
		projection: createScimMembershipProjection({
			afterMemberRemoved: cleanUpScimRemovedMember,
			queueAfterCommit: (hook) =>
				queueAfterTransactionHook(hook, {
					onError: (error) => {
						console.error("Failed to clean up a SCIM-removed member:", error);
					},
				}),
		}),
	});
}

const authOptions = {
	session: { cookieCache: sessionCookieCache },
	// Identifiers that embed a bearer token (password reset, account deletion)
	// are stored as SHA-256 digests, so a database dump cannot complete a reset.
	// Email-keyed OTP identifiers stay plain on purpose: their values are
	// already encrypted (`storeOTP: "encrypted"`), and account merge deletes the
	// absorbed address's rows by matching the email in the identifier.
	verification: {
		storeIdentifier: {
			default: "plain",
			overrides: {
				"delete-account-": "hashed",
				"reset-password:": "hashed",
			},
		},
	},
	// SCIM creates/updates a user and its SCIM source records, and removes the
	// organization membership on deprovisioning, as one operation. Pass the native MongoClient so Better Auth enables interactive
	// transactions; passing only the Db silently disables the transaction hook.
	database: releaseReservationsOfFailedInvitationWrites(
		encryptedMongoAdapter(client, { client: mongoClient })
	),
	trustedOrigins: parseCorsOrigins(),
	appName: "Ryu",
	// Better Auth reads BETTER_AUTH_SECRETS automatically when present. Keep the
	// scalar secret for backwards compatibility with deployments and Ryu code
	// that still reads BETTER_AUTH_SECRET directly; the versioned list takes
	// precedence for Better Auth signing and verification.
	secret: env.BETTER_AUTH_SECRET,
	baseURL: env.BETTER_AUTH_URL,
	rateLimit: {
		enabled: true,
		window: 60,
		max: 100,
		storage: "database",
		customRules: {
			"/oauth2/token": { window: 60, max: 30 },
			"/oauth2/register": { window: 60, max: 10 },
			"/device/code": { window: 60, max: 10 },
			"/device/token": { window: 60, max: 10 },
			"/device/approve": { window: 60, max: 10 },
			"/device/deny": { window: 60, max: 10 },
			"/scim/v2/*": { window: 60, max: 120 },
		},
	},
	socialProviders: (() => {
		const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {
			google: {
				clientId: env.GOOGLE_CLIENT_ID ?? "",
				clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
			},
		};
		if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
			providers.github = {
				clientId: env.GITHUB_CLIENT_ID,
				clientSecret: env.GITHUB_CLIENT_SECRET,
			};
		}
		if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
			providers.discord = {
				clientId: env.DISCORD_CLIENT_ID,
				clientSecret: env.DISCORD_CLIENT_SECRET,
			};
		}
		return providers;
	})(),
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: [...ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS],
			allowUnlinkingAll: true,
		},
	},
	emailAndPassword: {
		enabled: true,
		minPasswordLength: 8,
		maxPasswordLength: 128,
		requireEmailVerification: true,
		// `requireEmailVerification` makes Better Auth answer a sign-up for an
		// already-registered address with a *generic success* — a synthetic user,
		// no error, and (without this hook) no email at all. That protects against
		// email enumeration, but it strands the person: the UI says "check your
		// email" and nothing ever lands. This hook makes that promise true.
		//
		// Runs inside the sign-up handler, so after captcha and after the request
		// body has been validated, and Better Auth dispatches it in the background
		// so it adds no timing signal. `sendEmail` is per-recipient rate limited
		// (60s cooldown + daily cap, see `checkEmailRateLimit`), so repeat attempts
		// against a known address cannot be turned into a mail bomb.
		//
		// NOTE: `onExistingUserSignUp` is implemented in better-auth 1.5.2
		// (`api/routes/sign-up.mjs`) but absent from its published `.d.mts`, so
		// nothing type-checks the name — a rename on upgrade goes silently inert.
		// Re-grep the option name in `better-auth/dist` when bumping.
		onExistingUserSignUp: async ({
			user,
		}: {
			user: EmailUser & { emailVerified?: boolean };
		}) => {
			try {
				if (user.emailVerified) {
					const frontendUrl =
						process.env.FRONTEND_URL || "http://localhost:3001";
					await sendEmail({
						to: user.email,
						subject: "You already have a Ryu account",
						react: AccountExistsEmail({
							userName: user.name || "there",
							signInUrl: `${frontendUrl}/login?view=signin`,
							resetPasswordUrl: `${frontendUrl}/login?view=forgot`,
						}),
					});
					return;
				}
				// Account exists but was never verified: re-send the verification
				// email so this sign-up attempt actually completes the signup.
				await auth.api.sendVerificationEmail({
					body: { email: user.email, callbackURL: "/" },
				});
			} catch (error) {
				// Never propagate. A throw here would turn the generic 200 into a
				// 5xx and hand back the exact enumeration oracle this branch exists
				// to close — including on a benign rate-limit hit.
				console.error("Failed to send existing-account sign-up email:", error);
			}
		},
		sendResetPassword: async ({
			user,
			url,
		}: {
			user: EmailUser;
			url: string;
			token: string;
		}) => {
			try {
				await sendEmail({
					to: user.email,
					subject: "Let's get you a new password",
					react: PasswordResetEmail({
						userName: user.name || "there",
						resetUrl: url,
					}),
				});
			} catch (error) {
				console.error("Failed to send password reset email:", error);
				if (
					error instanceof Error &&
					errorCode(error) === "RATE_LIMIT_EXCEEDED"
				) {
					const retryAfter = retryAfterSeconds(error);
					throw new Error(
						retryAfter
							? `Please wait ${retryAfter} seconds before requesting another password reset email`
							: "Please wait before requesting another password reset email"
					);
				}
				throw error;
			}
		},
	},
	emailVerification: {
		sendOnSignUp: true,
		autoSignInAfterVerification: true,
		sendVerificationEmail: async ({
			user,
			url,
		}: {
			user: EmailUser;
			url: string;
			token: string;
		}) => {
			try {
				const parsedUrl = new URL(url);
				parsedUrl.searchParams.set(
					"callbackURL",
					`${process.env.FRONTEND_URL || "http://localhost:3001"}/email-verified`
				);

				await sendEmail({
					to: user.email,
					subject: "Let's make it official",
					react: VerificationEmail({
						userName: user.name || "there",
						verificationUrl: parsedUrl.toString(),
					}),
				});
			} catch (error) {
				console.error("Failed to send verification email:", error);
				if (
					error instanceof Error &&
					errorCode(error) === "RATE_LIMIT_EXCEEDED"
				) {
					const retryAfter = retryAfterSeconds(error);
					throw new Error(
						retryAfter
							? `Please wait ${retryAfter} seconds before requesting another verification email`
							: "Please wait before requesting another verification email"
					);
				}
				throw error;
			}
		},
		// Better Auth owns the emailVerified boolean. Keep the timestamp in
		// Ryu's read-compatible Mongoose mirror so public profiles can show
		// when the email signal was established without exposing the address.
		afterEmailVerification: async (user: { id: string }) => {
			try {
				await User.updateOne(
					{ _id: user.id },
					{
						$set: { emailVerifiedAt: new Date() },
					}
				);
			} catch (error) {
				// A display timestamp must never turn a successful mailbox verification
				// into a failed sign-in. The boolean remains Better Auth's authority.
				console.error("Failed to record email verification timestamp:", error);
			}
			// A referee who signed up unverified earns their referrer's credit now.
			// Idempotent and self-contained, so it cannot fail the verification.
			await creditPendingReferral(user.id);
			// An allowlisted address held back at sign-up for want of proof gets
			// its admin role now. Fail-open, like the referral credit above.
			await reconcileAdminRole(user.id);
		},
	},
	user: {
		// Better Auth calls this before it creates a user, links a provider
		// account, or signs a provider user in. SSO identities must stay on the
		// provider's DNS-verified domain (asserted and stored address alike), so
		// an organization cannot pre-register or take over an address it does
		// not own (lib/sso-email-domain.ts). Other sources pass through.
		validateUserInfo: validateSsoIdentityUserInfo,
		additionalFields: {
			// Match the twoFactor plugin's server-owned field in the canonical
			// options so getSession inference retains the existing enrollment state.
			twoFactorEnabled: {
				type: "boolean",
				required: false,
				defaultValue: false,
				input: false,
			},
			avatarId: {
				type: "string",
				required: false,
				input: false,
			},
			resendContactId: {
				type: "string",
				input: false,
			},
			emailVerifiedAt: {
				type: "date",
				input: false,
			},
			lastEmailSentAt: {
				type: "date",
				input: false,
			},
			dailyEmailCount: {
				type: "number",
				input: false,
			},
			lastEmailResetDate: {
				type: "date",
				input: false,
			},
			// Referral. `referralCode` and `referralCount` are server-managed
			// (input:false). `referredBy` is the only one accepted from the sign-up
			// request: the referral code the new user arrived with (from a `?ref=`
			// share link). The waitlist itself rides the admin-plugin `role` field.
			referralCode: {
				type: "string",
				input: false,
			},
			referredBy: {
				type: "string",
				input: true,
				required: false,
			},
			referralCount: {
				type: "number",
				input: false,
			},
			profileVisibility: {
				type: "string",
				input: false,
				defaultValue: "public",
			},
		},
	},
	advanced: (() => {
		const authCookieDomain = resolveAuthCookieDomain();
		const ipAddressHeaders = parseCsvEnv(env.BETTER_AUTH_IP_ADDRESS_HEADERS);
		const trustedProxies = parseCsvEnv(env.BETTER_AUTH_TRUSTED_PROXIES);
		const ipAddress: NonNullable<
			NonNullable<BetterAuthOptions["advanced"]>["ipAddress"]
		> = {
			// Trust one forwarded value unless explicit proxy ranges are configured.
			ipAddressHeaders:
				ipAddressHeaders.length > 0 ? ipAddressHeaders : ["x-forwarded-for"],
		};
		if (trustedProxies.length > 0) {
			ipAddress.trustedProxies = trustedProxies;
		}
		const advanced: NonNullable<BetterAuthOptions["advanced"]> = {
			ipAddress,
			defaultCookieAttributes: {
				sameSite: "lax",
				secure: process.env.NODE_ENV === "production",
				httpOnly: true,
			},
		};
		// Sharing the cookie domain keeps apex/subdomain SSR session checks aligned.
		if (authCookieDomain) {
			advanced.crossSubDomainCookies = {
				enabled: true,
				domain: authCookieDomain,
			};
		}
		return advanced;
	})(),
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			// Cache ordinary session display reads only. Auth operations and plugin
			// hooks must see revoked sessions and current account/organization state.
			const override = authoritativeAuthContext(ctx);
			if (override) {
				ctx.query = override.context.query;
			}
			if (ctx.path === "/oauth2/authorize" && override) {
				// Without this, an authorize request that omits `scope` asks for
				// every scope, `mail:manage` included (oauth-authorize-scope.ts).
				// Better Auth reads a POST authorize from the body, a GET from the
				// query, so the default goes wherever the request carries it.
				const defaults = await authorizeScopeDefaultsFromStore(
					{ body: ctx.body, method: ctx.method, query: ctx.query },
					ctx.context.adapter
				);
				if (defaults && "query" in defaults) {
					override.context.query = {
						...override.context.query,
						...defaults.query,
					};
					ctx.query = override.context.query;
				} else if (defaults) {
					const overrideContext: {
						body?: Record<string, unknown>;
						query: typeof override.context.query;
					} = override.context;
					overrideContext.body = defaults.body;
					ctx.body = defaults.body;
				}
			}
			if (shouldRejectGuestSignIn(ctx.path)) {
				throw new APIError("FORBIDDEN", {
					message: GUEST_MODE_DISABLED_MESSAGE,
				});
			}
			// API-key metadata is server-only: a key's class and organization come
			// from its stored configId/referenceId, never from client-written metadata.
			rejectClientApiKeyMetadata(ctx);
			if (
				ctx.path === "/organization/invite-member" &&
				(ctx.headers?.get("authorization")?.startsWith("Bearer ") ||
					ctx.headers
						?.get("cookie")
						?.includes(ctx.context.authCookies.sessionToken.name))
			) {
				await rememberInvitationsBeforeResend(
					ctx.context.adapter,
					organizationHookBodySchema.parse(ctx.body)
				);
			}
			if (ctx.path === "/sign-in/social") {
				const body = organizationHookBodySchema.parse(ctx.body);
				if (!isAllowedSocialSignInProvider(body?.provider)) {
					throw new APIError("FORBIDDEN", {
						message: `Social sign-in is available only with ${SOCIAL_SIGN_IN_PROVIDER}.`,
					});
				}
			}
			// Email sign-in gets no account lookup here. Better Auth answers an
			// account without a password exactly like an unknown address (the same
			// INVALID_EMAIL_OR_PASSWORD after the same password hash); a distinct
			// reply would tell callers which addresses hold a passwordless account.
			if (isCustomRoleWritePath(ctx.path)) {
				// Better Auth's dynamic access control is off (custom roles are Ryu's
				// control-plane roles), so these endpoints are not mounted today. A
				// family keeps the built-in owner/organizer/member roles; the role
				// endpoints have no organization hook, so if dynamic roles ever come
				// back the write is still refused here. They default to the
				// session's active organization when the body names none.
				const body = organizationHookBodySchema.parse(ctx.body);
				const organizationId =
					body?.organizationId ??
					hookActiveOrganizationId(await resolveSessionForHook(ctx));
				await organizationAdmission.requireCustomRoleWriteAllowed(
					organizationId
				);
			}
			// Every endpoint that stores a password a person chose (sign-up, both
			// resets, change-password) is held to the sign-up rules. It runs before
			// the endpoint, so a refused password does not use up the emailed reset
			// link or code that came with it.
			const passwordRefusal = passwordPolicyRefusal(ctx.path, ctx.body);
			if (passwordRefusal) {
				throw new APIError("BAD_REQUEST", { message: passwordRefusal });
			}
			if (PRIMARY_OWNER_GUARDED_PATHS.has(ctx.path)) {
				// This config hook runs before the bearer plugin's rewrite, so the
				// actor must come from resolveSessionForHook (cookie AND bearer);
				// an unresolved actor is refused rather than skipping the ladder.
				const decision = await primaryOwnerHookDecision({
					body: ctx.body,
					path: ctx.path,
					resolveSession: () => resolveSessionForHook(ctx),
				});
				if (decision) {
					throw new APIError(decision.code, { message: decision.message });
				}
			}
			await assertPendingEmailMatches(ctx);
			return override;
		}),
		after: createAuthMiddleware(async (ctx) => {
			// Better Auth stores active organization and active team on the same
			// session. A team from the previous organization must never survive an
			// organization switch and accidentally become the next request's scope.
			if (
				ctx.path === "/organization/set-active" ||
				ctx.path === "/organization/delete"
			) {
				const sessionToken = ctx.context.session?.session.token;
				if (sessionToken) {
					try {
						await ctx.context.internalAdapter.updateSession(sessionToken, {
							activeTeamId: null,
							updatedAt: new Date(),
						});
						await refreshSessionCookieFromStore(ctx, sessionToken);
					} catch (error) {
						console.error("Failed to clear active organization team:", error);
					}
				}
			}
			if (ctx.path === "/organization/invite-member") {
				// A resend whose email was not sent: Better Auth answered with the
				// invitation, but the owner must learn the email did not go out.
				const resentId = returnedInvitationId(ctx.context.returned);
				const unsentResend = resentId
					? await takeUnsentInvitationEmail(resentId)
					: null;
				if (
					unsentResend &&
					organizationMutationSucceeded(ctx.context.returned)
				) {
					await restoreInvitationAfterUnsentResend(
						ctx.context.adapter,
						unsentResend
					);
					throw invitationEmailNotSentError(unsentResend.error, "resend");
				}
				const body = organizationHookBodySchema.parse(ctx.body);
				const resentSeat = successfulResentInvitationSeat({
					returned: ctx.context.returned,
					resend: body?.resend,
				});
				if (resentSeat) {
					try {
						await refreshResentInvitationSeat(resentSeat);
					} catch (error) {
						// Keep a completed resend successful if seat maintenance is unavailable.
						console.error(
							"Failed to refresh resent organization invitation seat:",
							error
						);
					}
				}
			}

			// Better Auth owns the organization/member/team mutations themselves, so
			// they do not pass through the Hono control-plane router middleware. Keep
			// the audit append at this post-success hook: the session is authenticated,
			// the mutation has completed, and only stable ids are persisted.
			const organizationAuditActions = new Map(
				Object.entries({
					"/organization/add-member": {
						action: "member.add",
						target: "member",
					},
					"/organization/accept-invitation": {
						action: "invitation.accept",
						target: "invitation",
					},
					"/organization/add-team-member": {
						action: "team.member.add",
						target: "team-member",
					},
					"/organization/create-team": {
						action: "team.create",
						target: "team",
					},
					"/organization/create": {
						action: "organization.create",
						target: "organization",
					},
					"/organization/cancel-invitation": {
						action: "invitation.cancel",
						target: "invitation",
					},
					"/organization/delete": {
						action: "organization.delete",
						target: "organization",
					},
					"/organization/invite-member": {
						action: "member.invite",
						target: "member",
					},
					"/organization/leave": {
						action: "organization.leave",
						target: "organization",
					},
					"/organization/remove-member": {
						action: "member.remove",
						target: "member",
					},
					"/organization/remove-team": {
						action: "team.remove",
						target: "team",
					},
					"/organization/remove-team-member": {
						action: "team.member.remove",
						target: "team-member",
					},
					"/organization/reject-invitation": {
						action: "invitation.reject",
						target: "invitation",
					},
					"/organization/set-active": {
						action: "organization.set-active",
						target: "organization",
					},
					"/organization/set-active-team": {
						action: "team.set-active",
						target: "team",
					},
					"/organization/update": {
						action: "organization.update",
						target: "organization",
					},
					"/organization/update-member-role": {
						action: "member.role.update",
						target: "member",
					},
					"/organization/update-team": {
						action: "team.update",
						target: "team",
					},
				})
			);
			const auditAction = organizationAuditActions.get(ctx.path);
			const session = ctx.context.session;
			const body = organizationHookBodySchema.parse(ctx.body);
			if (
				ctx.path === "/organization/remove-team-member" &&
				session?.session.token &&
				session.session.activeTeamId &&
				body.teamId === session.session.activeTeamId &&
				body.userId === session.user.id
			) {
				try {
					await ctx.context.internalAdapter.updateSession(
						session.session.token,
						{
							activeTeamId: null,
							updatedAt: new Date(),
						}
					);
				} catch (error) {
					console.error("Failed to clear removed active team:", error);
				}
			}
			const returned = auditReturnSchema.parse(ctx.context.returned);
			const returnedOrganization = returned.organization;
			const returnedInvitation = returned.invitation;
			const returnedMember = returned.member;
			const returnedTeam = returned.team;
			const returnedOrganizationId = [
				returnedOrganization.id,
				returned.organizationId,
				returnedInvitation.organizationId,
				returnedMember.organizationId,
				returnedTeam.organizationId,
				returned.id,
			].find((value) => Boolean(value?.trim().length));
			const organizationId =
				auditAction?.action === "organization.create"
					? returnedOrganizationId
					: body.organizationId === undefined
						? (returnedOrganizationId ?? session?.session.activeOrganizationId)
						: body.organizationId;
			if (
				auditAction &&
				organizationId &&
				session?.user?.id &&
				organizationMutationSucceeded(ctx.context.returned)
			) {
				const targetId =
					(["memberId", "userId", "teamId", "invitationId"] as const).reduce<
						string | null
					>((found, key) => {
						if (found) {
							return found;
						}
						const value = body[key];
						return value?.trim() ? value : null;
					}, null) ?? organizationId;
				try {
					// Through the API's writer, so the row also reaches the org's
					// SIEM stream (see control-audit-recorder.ts).
					await recordOrganizationControlAudit({
						action: auditAction.action,
						actorId: session.user.id,
						actorType: "user",
						details: await organizationAuditDetails({
							memberId: body.memberId ?? returned.id,
							method: String(ctx.method),
							path: ctx.path,
							role: returned.role,
						}),
						organizationId,
						target: auditAction.target,
						targetId,
					});
				} catch (error) {
					// Never turn a completed Better Auth mutation into a failed auth
					// response because the optional audit projection is unavailable.
					console.error("Failed to append organization control audit:", error);
				}
			}
			// `/organization/leave` runs none of Better Auth's member hooks, so the
			// seat claim and custom-role grants are released here instead.
			if (
				ctx.path === "/organization/leave" &&
				organizationMutationSucceeded(ctx.context.returned)
			) {
				const left = leftMemberSchema.safeParse(ctx.context.returned);
				if (left.success) {
					try {
						await releaseSeatClaims(left.data);
					} catch (error) {
						console.error("Failed to release a leaving member's seat:", error);
					}
					await revokeRemovedMemberGrants(left.data);
					await disableFamilyBotGrantsOnMemberExit(left.data);
					await organizationAdmission.releaseMemberFamilyPlace(left.data);
				}
			}
			const loginAssuranceResponse = await loginAssuranceAfterPassword(ctx);
			if (loginAssuranceResponse) {
				return loginAssuranceResponse;
			}
			await loginAssuranceAfterMagicLinkRequest(ctx);
			await loginAssuranceAfterFactor(ctx);

			if (ctx.path === "/change-password") {
				const session = ctx.context.session;
				if (session?.user) {
					try {
						await sendEmail({
							to: session.user.email,
							subject: "Your new password is live",
							react: PasswordChangeEmail({
								userName: session.user.name || "there",
							}),
						});
					} catch (error) {
						console.error(
							"Failed to send password change notification email:",
							error
						);
					}
				}
			}

			// `ctx.path` is the route template here; the id is in `ctx.params`.
			const providerId = providerIdFromSsoCallbackPath(ctx.path, ctx.params);
			const newSession = ctx.context.newSession;
			const sessionToken = newSession?.session?.token;
			const userId = newSession?.user?.id;
			const userEmail = newSession?.user?.email;
			if (!(providerId && sessionToken && userId && userEmail)) {
				return;
			}

			try {
				const provider = z
					.object({ organizationId: z.string().nullable().catch(null) })
					.nullable()
					.catch(null)
					.parse(
						await ctx.context.adapter.findOne({
							model: "ssoProvider",
							where: [{ field: "providerId", value: providerId }],
						})
					);
				const organizationId = provider?.organizationId;
				if (!organizationId) {
					return;
				}

				// Plugin provisioning is disabled in `sso()` below because it writes
				// the member row past `beforeAddMember`. Admit through the
				// organization plugin instead, so the paid-seat reservation and the
				// verified business-email gate apply exactly as for invitations.
				const membership = await settleSsoMembership(
					{ organizationId, user: { email: userEmail, id: userId } },
					{
						addMember: async (member) => {
							await auth.api.addMember({
								body: { ...member, role: "member" },
							});
						},
						hasPendingInvitation: async ({ email }) =>
							Boolean(
								await ctx.context.adapter.findOne({
									model: "invitation",
									where: [
										{ field: "organizationId", value: organizationId },
										{ field: "email", value: email },
										{ field: "status", value: "pending" },
										{
											field: "expiresAt",
											operator: "gt",
											value: new Date(),
										},
									],
								})
							),
						isMember: async (member) =>
							Boolean(await Member.findOne(member).select("_id").lean()),
					}
				);
				if (membership.kind === "refused") {
					// The identity is proven, so the sign-in still completes; only the
					// organization access waits for a free seat or a verified email.
					console.warn(
						"SSO sign-in did not add an organization member:",
						membership.error instanceof Error
							? membership.error.message
							: membership.error
					);
					return;
				}
				if (membership.kind === "invitation-pending") {
					return;
				}

				const activeOrganizationId = newSession.session.activeOrganizationId;
				if (activeOrganizationId === organizationId) {
					return;
				}

				await ctx.context.internalAdapter.updateSession(sessionToken, {
					activeOrganizationId: organizationId,
					updatedAt: new Date(),
				});
				await refreshSessionCookieFromStore(ctx, sessionToken);
			} catch (error) {
				console.error("Failed to select the SSO organization:", error);
			}
		}),
	},
	databaseHooks: {
		session: {
			create: {
				before: async (session: { userId: string }) => {
					// Anonymous sessions are intentionally account-less. Do not create a
					// personal organization or reconcile account roles for a guest: those
					// hooks are for durable accounts and would turn every guest visit into
					// a Polar customer, waitlist row, and organization.
					try {
						const user = await User.findById(session.userId)
							.select("isAnonymous")
							.lean<{ isAnonymous?: boolean }>();
						if (user?.isAnonymous) {
							return { data: session };
						}
					} catch {
						// Preserve the existing fail-open session path if the auxiliary
						// Mongoose read is unavailable.
					}
					// Make the stored role agree with the admin allowlist before the
					// session exists, so the very first render of this session already
					// shows an allowlisted admin their admin affordances.
					await reconcileAdminRole(session.userId);
					// Start every new session scoped to the user's default org so
					// org-scoped reads (the control plane reads the `member` collection)
					// resolve immediately on first login. Earliest membership = the
					// default org created at sign-up.
					//
					// A user with NO membership is repaired here rather than left
					// unscoped. That state is reachable two ways — an account created
					// before auto-provisioning landed, or a sign-up whose fail-open
					// `ensurePersonalOrganization` threw — and it is not a cosmetic
					// "Select organization" prompt: org-scoped routes REFUSE such a
					// caller, so `/api/credits/wallet` 409s on every request and every
					// SSE reconnect until the membership exists.
					//
					// Fail-open as before: any error leaves the session without an active
					// org rather than blocking login.
					try {
						const activeOrganizationId = await resolveInitialActiveOrganization(
							{
								userId: session.userId,
								findEarliestMembership: async (userId) => {
									const member = await Member.findOne({ userId })
										.sort({ createdAt: 1 })
										.lean();
									return member?.organizationId
										? String(member.organizationId)
										: null;
								},
								ensureOrganization: async (userId) => {
									await ensurePersonalOrganization(userId, auth.api);
								},
							}
						);
						if (activeOrganizationId) {
							return {
								data: { ...session, activeOrganizationId },
							};
						}
					} catch (error) {
						console.error(
							"Failed to resolve initial active organization:",
							error
						);
					}
				},
				after: async (session) => {
					void recordLoginAndNotifyStaleAccount(session);
				},
			},
		},
		user: {
			create: {
				before: async (user, context) => {
					if (userHookFieldsSchema.parse(user).isAnonymous) {
						return { data: user };
					}
					// Stamp every new user with a referral code. Normalize any inbound
					// referral code to the canonical upper-case form.
					const inboundReferredBy = userHookFieldsSchema.parse(user).referredBy;
					// Email/password sign-up threads `referredBy` in the body (wins here);
					// social/OAuth sign-up has no body, so fall back to the `ryu_ref`
					// cookie the web client set at the ?ref= landing. Without this,
					// Google-referred signups silently attribute to no one.
					const rawReferredBy =
						inboundReferredBy || referredByFromCookie(context);
					const referredBy = rawReferredBy
						? rawReferredBy.trim().toUpperCase()
						: undefined;
					type SignupUserCreateData = typeof user & {
						emailVerifiedAt?: Date;
						referralCode: string;
						referralCount: number;
						referredBy?: string;
						role: string;
					};
					// The role is written with the insert, so no committed account ever
					// carries the admin plugin's default "user" (which the waitlist
					// treats as approved). Better Auth 1.7.1 runs plugin hooks first and
					// `databaseHooks` last (context/helpers.mjs), spreading each result
					// over the previous one (db/with-hooks.mjs), so this `role` replaces
					// the admin plugin's `{ role: "user", ...user }` and any role the
					// caller passed (admin createUser, SCIM, SSO). The adapter writes
					// every declared field whatever its `input` flag, so `role` and
					// `emailVerifiedAt` reach the document.
					const data: SignupUserCreateData = {
						...user,
						referralCode: generateReferralCode(),
						referralCount: 0,
						role: resolveSignupRole(user).role,
					};
					if (user.emailVerified) {
						data.emailVerifiedAt = new Date();
					}
					if (referredBy) {
						data.referredBy = referredBy;
					}
					return { data };
				},
				after: async (user: {
					id: string;
					email: string;
					name?: string;
					emailVerified?: boolean;
					isAnonymous?: boolean;
					role?: string;
					referralCode?: string;
					referralCount?: number;
					referredBy?: string;
				}) => {
					if (user.isAnonymous) {
						return;
					}
					// Credit the referrer (if any) so referrals move them up the queue —
					// at once for a verified referee, otherwise when the mailbox is
					// verified. Best-effort: a bad/unknown code just means no credit.
					await creditReferrerAtSignup(user);
					// The role (and `emailVerifiedAt`, and the referral code) were
					// written with the insert by `user.create.before`; the queue
					// decision is recomputed from the same helper rather than trusted
					// from this hook's argument.
					const { queued } = resolveSignupRole(user);
					const referralCode = user.referralCode;
					// Welcome queued users with their position and personal referral link.
					// Admins and auto-approved (waitlist-bypassed) users skip this — they
					// were never in the queue, so a position email would be wrong.
					if (queued) {
						try {
							const position = await waitlistPositionFor(user.id);
							const referralUrl = referralCode
								? referralUrlFor(referralCode)
								: `${webOrigin()}/login?view=signup`;
							await sendEmail({
								to: user.email,
								subject: "You're on the list, here's what's next",
								react: WaitlistConfirmationEmail({
									name: user.name,
									position,
									referralUrl,
								}),
								// Fires right after the verification email — bypass the cooldown
								// so it isn't silently dropped.
								skipRateLimit: true,
							});
						} catch (error) {
							console.error(
								"Failed to send waitlist confirmation email:",
								error
							);
						}
					}
					// Give every new user a default organization so they always have a
					// valid org context. Wrapped so a failure here never fails sign-up,
					// exactly like the Polar provisioning above.
					try {
						await ensurePersonalOrganization(user.id, auth.api);
					} catch (error) {
						console.error(
							"Failed to create default organization for user:",
							error
						);
					}
					// The referee's sign-up credit, if they arrived on someone's link.
					// STRICTLY AFTER the default organization: the grant lands in an
					// ORG wallet, so a referee with no membership yet has nowhere to put
					// it and the money is simply never minted.
					//
					// Deliberately UNCONDITIONAL — not gated on `user.referredBy`. The
					// implementation re-reads the stored code itself (its fast path for
					// the ~everyone who has none), and the `before` hook may have written
					// a code this hook's `user` object never carried: a social sign-up
					// has no request body, so its code comes from the `ryu_ref` cookie.
					// Swallows its own failures (see `runRefereeGrantHook`), like
					// `ensurePersonalOrganization` and `syncPolarCustomer` here.
					await runRefereeGrantHook(user.id);
				},
			},
			update: {
				after: async (user: {
					id: string;
					email: string;
					emailVerified?: boolean;
					name?: string;
				}) => {
					// Email-OTP sign-in, magic links and OAuth account linking verify
					// a mailbox through `updateUser` without `afterEmailVerification`,
					// so settle a pending referral credit here too (at most once).
					if (user.emailVerified) {
						await creditPendingReferral(user.id);
						await reconcileAdminRole(user.id);
					}
					await syncPolarCustomer({
						id: user.id,
						email: user.email,
						name: user.name,
					});
				},
			},
		},
	},
	plugins: [
		// FIRST on purpose. The admin plugin's account-control endpoints (ban,
		// unban, set-role, remove, set-password, revoke sessions, create/update
		// user) answer 404 unless the root-admin abuse console calls them through
		// `auth.api.*` inside its server-only context. Running before every other
		// plugin hook (age gate, support access, step-up) means a raw HTTP caller
		// learns nothing, not even that step-up would be needed.
		adminAbuseGuardPlugin(),
		// Before `admin()`: its session hook refuses a banned user with a bare
		// error, and this one runs first to add the reason label and appeal path.
		bannedSignInPlugin(),
		ageEligibilityPlugin(),
		// Better Auth owns authentication responses, so localize its standard error
		// codes at the server boundary. The product language-pack runtime owns UI
		// copy; this plugin is deliberately limited to auth errors and keeps the
		// original message in the response for support and diagnostics.
		createRyuAuthI18nPlugin(),
		// Turnstile is optional for local/self-hosted development. Better Auth treats
		// an empty secret as an internal error, which would make every local signup
		// with a widget response fail as HTTP 500. Keep the plugin in production so a
		// missing production secret remains fail-closed rather than silently disabling
		// bot protection.
		...(TURNSTILE_CAPTCHA_ENABLED
			? [
					captcha({
						// Keep the password-recovery request protected after moving from the
						// core reset-link endpoint to Email OTP. Better Auth's default list does
						// not include the Email OTP endpoint.
						endpoints: [
							"/sign-up/email",
							"/sign-in/email",
							"/request-password-reset",
							"/email-otp/request-password-reset",
						],
						provider: "cloudflare-turnstile",
						secretKey: TURNSTILE_SECRET_KEY ?? "",
					}),
				]
			: []),
		// Keep the plugin registered so legacy anonymous sessions can be removed by
		// the clients. New anonymous sign-ins are rejected by the auth hook below
		// while the hosted browser waitlist is active.
		anonymous({
			generateName: () => "Guest",
		}),
		// Google One Tap is a browser sign-in convenience. It still goes through
		// Better Auth's normal Google account-linking and user hooks, so waitlist,
		// organization provisioning, and session scoping remain authoritative.
		oneTap({
			clientId: env.GOOGLE_CLIENT_ID,
		}),
		// OTTs are reserved for an explicitly initiated app handoff (for example,
		// web -> extension/mobile). They are short-lived, hashed in MongoDB, and
		// never set a browser cookie when redeemed by a non-browser client.
		oneTimeToken({
			disableSetSessionCookie: true,
			expiresIn: 3,
			storeToken: "hashed",
		}),
		createRyuPasskeyPlugin(),
		twoFactor({
			issuer: "Ryu",
			otpOptions: {
				async sendOTP({ user, otp }) {
					try {
						await sendEmail({
							to: user.email,
							subject: "One more step to get you in",
							react: TwoFactorOTPEmail({
								userName: user.name || "there",
								otpCode: otp,
							}),
						});
					} catch (error) {
						console.error("Failed to send 2FA OTP email:", error);
						if (
							error instanceof Error &&
							errorCode(error) === "RATE_LIMIT_EXCEEDED"
						) {
							const retryAfter = retryAfterSeconds(error);
							throw new Error(
								retryAfter
									? `Please wait ${retryAfter} seconds before requesting another 2FA code`
									: "Please wait before requesting another 2FA code"
							);
						}
						throw error;
					}
				},
				period: 5,
				storeOTP: "encrypted",
			},
			backupCodesOptions: {
				amount: 10,
				length: 10,
				storeBackupCodes: "encrypted",
			},
		}),
		ryuEmailHarmony,
		emailOTP({
			async sendVerificationOTP({ email, otp, type }) {
				try {
					let userName = "there";
					try {
						const user = await User.findOne({ email: email.toLowerCase() })
							.select("name")
							.lean<{ name?: string }>();
						userName = user?.name || "there";
					} catch {
						// Use a generic greeting if the account lookup is unavailable.
					}

					const react =
						type === "sign-in"
							? SignInOTPEmail({ userName, otpCode: otp })
							: type === "email-verification"
								? EmailVerificationOTPEmail({ userName, otpCode: otp })
								: PasswordResetOTPEmail({ userName, otpCode: otp });
					const subject =
						type === "sign-in"
							? `Your sign-in code is ${otp}`
							: type === "email-verification"
								? "Your email verification code"
								: "Your password reset code";

					await sendEmail({ to: email, subject, react });
				} catch (error) {
					console.error("Failed to send email OTP:", error);
					if (
						error instanceof Error &&
						errorCode(error) === "RATE_LIMIT_EXCEEDED"
					) {
						const retryAfter = retryAfterSeconds(error);
						throw new Error(
							retryAfter
								? `Please wait ${retryAfter} seconds before requesting another email code`
								: "Please wait before requesting another email code"
						);
					}
					throw error;
				}
			},
			otpLength: 6,
			expiresIn: 300,
			sendVerificationOnSignUp: false,
			storeOTP: "encrypted",
			disableSignUp: false,
		}),
		magicLink({
			sendMagicLink: async ({ email, url }, ctx) => {
				try {
					let userName = "there";
					try {
						const user = await ctx?.context?.adapter?.findOne?.<{
							name?: string;
						}>({
							model: "user",
							where: [{ field: "email", value: email.toLowerCase() }],
						});
						userName = user?.name || "there";
					} catch {
						// Use generic greeting if user not found
					}

					await sendEmail({
						to: email,
						subject: "Let's get you signed in",
						react: MagicLinkEmail({
							userName,
							magicLinkUrl: url,
						}),
					});
				} catch (error) {
					console.error("Failed to send magic link email:", error);
					if (
						error instanceof Error &&
						errorCode(error) === "RATE_LIMIT_EXCEEDED"
					) {
						const retryAfter = retryAfterSeconds(error);
						throw new Error(
							retryAfter
								? `Please wait ${retryAfter} seconds before requesting another sign-in link`
								: "Please wait before requesting another sign-in link"
						);
					}
					throw error;
				}
			},
			expiresIn: 300,
			// The emailed link carries the token; only its digest is stored.
			storeToken: "hashed",
		}),
		polar({
			client: polarClient,
			// Keep the Polar integration for customer/subscription webhooks, but do
			// not register its generic checkout/portal routes. All money creation is
			// owned by the org-aware billing routers below.
			// SAFETY: Polar reduces this list with an initial empty endpoint object,
			// so an empty list is supported at runtime despite its non-empty tuple
			// declaration. Billing routers own checkout/portal registration in Ryu.
			use: optionalPolarPlugins as Parameters<typeof polar>[0]["use"],
			// Customer provisioning is deferred to the billing checkout routes. This
			// prevents a personal customer created at sign-up from colliding with the
			// dedicated team customer an organization may need later.
			createCustomerOnSignUp: false,
		}),
		deviceAuthorization({
			verificationUri: `${process.env.FRONTEND_URL || "http://localhost:3001"}/device`,
			validateClient: (clientId) =>
				[
					...Object.values(LOGIN_APPROVAL_CLIENTS),
					"ryu-cli",
					"ryu-mcp",
				].includes(clientId),
		}),
		loginApprovalSessionPlugin(),
		// Stamp the device-flow client id (ryu-desktop, ryu-cli, ...) on the
		// session `/device/token` issues, so routes can tell a Ryu client's
		// session from a browser sign-in. Server-side only; see the module.
		ryuClientSessionPlugin(),
		// Telegram Mini App launches exchange Telegram-signed initData for a bearer
		// session, only for a Telegram identity the owner already linked.
		telegramMiniAppSessionPlugin(),
		// The built-in GET /device only returns { user_code, status } — it hides the
		// requesting clientId/scope. The approve consent screen needs to name the app
		// asking for access ("Ryu Desktop is requesting…"), so expose a read-only
		// lookup that surfaces the persisted clientId + scope for a pending code.
		{
			id: "device-authorization-info",
			endpoints: {
				getDeviceInfo: createAuthEndpoint(
					"/device/info",
					{ method: "GET" },
					async (ctx) => {
						const userCode = (ctx.query?.user_code ?? "")
							.replace(/-/g, "")
							.toUpperCase();
						if (!userCode) {
							throw new APIError("BAD_REQUEST", {
								error: "invalid_request",
								error_description: "user_code is required",
							});
						}
						const record = await ctx.context.adapter.findOne<{
							clientId?: string | null;
							scope?: string | null;
							status?: string | null;
						}>({
							model: "deviceCode",
							where: [{ field: "userCode", value: userCode }],
						});
						if (!record) {
							throw new APIError("NOT_FOUND", {
								error: "invalid_request",
								error_description: "Unknown or expired code",
							});
						}
						return ctx.json({
							clientId: record.clientId ?? null,
							scope: record.scope ?? null,
							status: record.status ?? null,
						});
					}
				),
			},
		},
		bearer(),
		// Multi-account: keep multiple concurrent device sessions in one browser
		// so a user can switch between accounts (Notion-style). Cookie-based, so it
		// drives web directly; the Bearer surfaces (desktop/cli/tui/extension/native)
		// each keep their own local token vault and switch the active bearer token.
		multiSession({ maximumSessions: 5 }),
		expo(),
		admin({
			// Support access (#545): cap any impersonation session at 1 hour, the AC
			// ceiling for a user-granted support session. Admins still cannot
			// impersonate other admins by default (Better Auth's built-in behavior —
			// we deliberately do NOT grant the `impersonate-admins` permission).
			impersonationSessionDuration: 60 * 60,
			// The default admin role would also grant session listing (live
			// tokens), raw user updates and user creation, none of them consented,
			// stepped up or audited. Grant only the step-up-gated staff actions.
			ac: platformAdminAccessControl,
			roles: platformAdminRoles,
		}),
		lastLoginMethod(),
		username({
			minUsernameLength: 3,
			maxUsernameLength: 32,
		}),
		jwt({
			// Mint only on `GET /api/auth/token`. With the header on, Better Auth
			// would also mint (and run `definePayload`, with its roster reads and
			// org policy evaluation) on every `/get-session`, including every
			// control-plane request's `createContext`. Nothing reads
			// `set-auth-jwt`, and a mint that can fail (see below) must never fail
			// a session read. The MFA-enrollment and support-access plugins still
			// strip the header as defense in depth.
			disableSettingJwtHeader: true,
			jwt: {
				// Enrich the JWT so a node's Core can verify org + team membership and
				// role OFFLINE (it validates the signature against the JWKS, no live call
				// to better-auth). The session carries only the ACTIVE org, so we
				// resolve every org the user belongs to from the `member`
				// collection, and every team from `teamMember`, the same sources of truth
				// the control plane reads from. Core narrows both to its bound org.
				// The payload always carries `email_verified`, so Core never treats an
				// unproven address as one the caller owns when an app grants access by
				// email, and `ryu_sid` (lib/jwt-identity-claims.ts), the id of the
				// session the token is minted from: the control plane accepts a token
				// Core forwards only while that session is live, and applies that
				// session's step-up grants and access policy to it. `iss`, `aud` and
				// `sub` are never set here; Better Auth stamps them.
				// `ryu_flags` (lib/core-flag-claim.ts) carries the enabled rollout flags
				// Core enforces offline, evaluated for the session's active org (or the
				// earliest membership) with the caller's role in it; `ryu_flags_org`
				// names that org. It waits only on the org roster, never rejects, and is
				// omitted (flags off) on any failure, including a roster read failure.
				// `ryu_limits` (`CORE_LIMITS_CLAIM` in lib/plans.ts) carries the same
				// org's Box concurrency cap, `{ boxConcurrency }`, and is omitted on
				// any failure, so Core falls back to the Box service's own limits.
				// Each org's access policy (IP allowlist, required two-factor, session
				// max age; lib/jwt-org-access.ts) is applied to this mint first: an org
				// that refuses this session is left out of `orgs`, `teams` and the
				// `ryu_flags_org` choice, so its nodes never see this caller as a member.
				// When the roster or that policy cannot be read, the mint FAILS with a
				// 503 the client retries, instead of going out without the org claims
				// (which would lock an org member out for the token's lifetime with
				// no signal). A user with no memberships never consults the policy.
				// The team roster still degrades to no teams (teams are additive and
				// fail closed), as do the flags.
				definePayload: async ({ user, session }) => {
					const base = {
						...jwtIdentityClaims(user),
						...jwtSessionBindingClaims(session),
					};
					// A support (impersonation) session never gets a token: `/token` is
					// already outside every support scope, this is defense in depth.
					if (
						z.object({ impersonatedBy: z.string().min(1) }).safeParse(session)
							.success
					) {
						throw new APIError("FORBIDDEN", {
							code: "SUPPORT_SESSION_JWT_REFUSED",
							message: "A support session cannot mint a token",
						});
					}
					const activeOrganizationId =
						flagClaimSessionSchema.parse(session).activeOrganizationId ?? null;
					// `exec()` so the roster runs once: both the flag claim and the
					// roster below await this promise, and a mongoose Query re-executes
					// on every `then`. Only memberships whose org policy admits this
					// mint go further; an undecidable policy rejects the mint.
					const memberRows = Member.find({ userId: user.id })
						.lean()
						.exec()
						.then((rows) => admitJwtOrgMemberships(rows, { session, user }));
					// `{ organization }` once the roster is read, null when it failed.
					const claimOrganization = memberRows.then(
						(rows) => ({
							organization: selectCoreFlagClaimOrganization(
								activeOrganizationId,
								rows.map((row) => ({
									createdAt: row.createdAt ?? null,
									id: String(row.organizationId),
									role: row.role,
								}))
							),
						}),
						() => null
					);
					const coreFlags = claimOrganization.then((selected) =>
						selected
							? resolveCoreFlagClaim(user, selected.organization)
							: { keys: [], organizationId: null }
					);
					const coreLimits = claimOrganization.then((selected) =>
						resolveCoreLimitsClaim(selected?.organization?.id ?? null)
					);
					// The two rosters are independent, so they overlap. The team
					// roster's `catch` keeps a team-roster failure from rejecting the
					// pair: teams are additive, org claims are not.
					const rosters = await Promise.all([
						memberRows,
						TeamMember.find({ userId: user.id })
							.lean()
							.catch((error) => {
								console.error(
									"Failed to read team memberships:",
									z
										.union([z.instanceof(Error), z.json()])
										.nullable()
										.catch(null)
										.parse(error)
								);
								return [];
							}),
					]).catch((error) => {
						console.error("Failed to embed org memberships in JWT:", error);
						return null;
					});
					if (!rosters) {
						throw jwtOrgAccessUnavailable();
					}
					const [members, teamRows] = rosters;
					// Both id fields are ObjectId on disk; the claim is a JSON string
					// id, and Core compares it as text. Stringify at the boundary
					// rather than relying on `ObjectId.toJSON()` at serialize time,
					// so the in-process value matches what the token carries.
					const orgs = members.map((member) => ({
						id: String(member.organizationId),
						role: member.role,
					}));
					const teams = await resolveTeamClaims(
						user.id,
						teamRows.map((row) => String(row.teamId)),
						orgs
					);
					return withCoreLimitsClaim(
						withCoreFlagClaim({ ...base, orgs, teams }, await coreFlags),
						await coreLimits
					);
				},
			},
		}),
		// Scoped programmatic access tokens (PATs). Each key carries access-control
		// statements from the shared Ryu scope vocabulary (see scopes.ts) that Core
		// (the resource server) and the Gateway enforce. We deliberately do NOT set
		// enableSessionForAPIKeys: a scoped token must never be silently as powerful
		// as a full login session. Consumers verify + gate via
		// auth.api.verifyApiKey({ body: { key, permissions } }). Personal keys use
		// `references: "user"`; organization keys use the native organization config.
		apiKey([
			{
				// Keep the default config id stable so existing personal keys remain
				// verifiable after the organization config is added.
				configId: "default",
				references: "user",
				enableMetadata: true,
				// The plugin default is 10 verifications per day. The plugin stores the
				// limiter on each key at creation; migration
				// 1791936000000-api-key-rate-limit-backfill raised keys minted on that
				// default to this limiter, and custom limits were left alone.
				rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
				permissions: {
					defaultPermissions: async (referenceId) => {
						try {
							const user = await User.findById(referenceId).lean();
							// The implicit set leaves out opt-in scopes (such as
							// mail:manage), matching classic /me/api-keys tokens.
							return implicitPermissionsForRole(user?.role);
						} catch (error) {
							console.error(
								"[auth] apiKey defaultPermissions lookup failed:",
								error
							);
							// Fail CLOSED. A scoped token defaulting its own ceiling must never
							// widen on error: if we cannot read the role, mint a key with no
							// permissions rather than the write-capable standard set (which is
							// what an absent role resolves to). The caller can always pass
							// explicit permissions, and a re-create succeeds once the DB is
							// healthy.
							return {};
						}
					},
				},
			},
			{
				// Organization keys are owned by the Better Auth organization
				// reference itself. Ryu supplies an explicit, role-clamped permission
				// map from the control-plane route; an empty fallback prevents a direct
				// native call from receiving broader Ryu scopes.
				configId: "organization",
				references: "organization",
				enableMetadata: true,
				rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
				permissions: { defaultPermissions: {} },
			},
		]),
		// MCP OAuth: Better Auth's MCP plugin is itself the OAuth 2.1/OIDC provider.
		// It owns the /oauth2/* endpoints and protected-resource discovery, so a
		// separate oauthProvider plugin would register duplicate routes. Tokens are
		// bound to the canonical Ryu MCP resource and the shared Ryu scope vocabulary.
		mcp({
			loginPage: `${process.env.FRONTEND_URL || "http://localhost:3001"}/login`,
			consentPage: `${process.env.FRONTEND_URL || "http://localhost:3001"}/oauth/consent`,
			resource: new URL("/mcp", env.BETTER_AUTH_URL).toString(),
			scopes: RYU_SUPPORTED_SCOPES,
			// Opt-in scopes (`mail:manage`) are registrable and grantable, but are
			// requested only by name. Better Auth stores every dynamic or CIMD
			// client with the default-plus-allowed union, `mail:manage` included
			// (the default list only validates a registration that sends no
			// `scope`), and that stored list grants nothing by itself: an authorize
			// request without `scope` is defaulted in `hooks.before` above, and
			// consent leaves the scope unchecked.
			clientRegistrationDefaultScopes: RYU_DEFAULT_OAUTH_SCOPES,
			clientRegistrationAllowedScopes: [...OAUTH_OPT_IN_SCOPES],
			// Discovery (protected-resource and authorization-server metadata)
			// leaves opt-in scopes out. MCP clients request every advertised scope
			// when the 401 challenge names none, so advertising `mail:manage` would
			// put it in every connect request and re-prompt consent each time it
			// is declined. A client learns of it from the `insufficient_scope`
			// challenge `mail_create_inbox` returns (apps/server hosted MCP).
			advertisedMetadata: { scopes_supported: RYU_DEFAULT_OAUTH_SCOPES },
			allowDynamicClientRegistration: true,
			allowUnauthenticatedClientRegistration: true,
			accessTokenExpiresIn: 3600,
			// Hosted MCP access tokens must be revocable immediately. Better Auth's
			// JWT access tokens are intentionally self-contained and its revocation
			// endpoint cannot revoke them, while opaque tokens are checked against the
			// oauthAccessToken row on every protected-resource request.
			disableJwtPlugin: true,
			storeTokens: "hashed",
		}),
		// MCP 2026 clients identify themselves with a Client ID Metadata
		// Document. The Node transport resolves DNS once, rejects special-use IPs,
		// pins the approved address, and refuses redirects. DCR above remains
		// enabled only for compatibility with older MCP clients.
		cimd({
			fetchClientMetadataResource,
			metadataProfile: "mcp-2026-07-28",
		}),
		// Enterprise inbound identity. Provider registration and SCIM token
		// management are exposed through the org-scoped API router, which applies
		// Ryu's entitlement and membership policy before calling these Better Auth
		// endpoints. The protocol endpoints themselves remain available for the
		// hosted login/provisioning flows.
		//
		// Plugin organization provisioning stays disabled. It inserts the member
		// row through the raw adapter, which bypasses `beforeAddMember` and so
		// the paid-seat and business-email gates. Organization-bound SSO callbacks
		// admit through `settleSsoMembership` in the global after hook instead.
		// The plugin's other path, joining an organization on a plain social
		// login because the email domain matches a verified provider, is
		// deliberately not replaced: a matching email domain alone does not grant
		// organization access (see the public enterprise-identity docs). Those
		// users join through SSO or an invitation.
		sso({
			domainVerification: { enabled: true },
			// Live Enterprise entitlement gate, checked after Better Auth has
			// resolved the exact persisted provider and before it creates a user,
			// account, or session: a suspended or expired SSO entitlement stops the
			// protocol itself, not only the management API.
			resolveUser: async (input, context) =>
				await resolveEnterpriseSsoUser(
					input,
					context.database,
					hasEnterpriseCapability
				),
			organizationProvisioning: { disabled: true },
			provisionUserOnEveryLogin: true,
			saml: {
				algorithms: { onDeprecated: "reject" },
				allowIdpInitiated: true,
				enableInResponseToValidation: true,
				requireTimestamps: true,
			},
		}),
		createRyuScimPlugin(),
		// SCIM may not create or rename an account to a platform-admin address.
		scimAdminEmailGuardPlugin(),
		organization({
			// The creator of an org becomes its owner. This is the single source of
			// truth the control plane reads from (the `member` collection).
			creatorRole: "owner",
			// Keep the Better Auth expiry and the pending-seat reservation on the same
			// public contract. The global after hook also refreshes this claim when
			// Better Auth handles `resend: true` in place.
			invitationExpiresIn: ORGANIZATION_INVITATION_EXPIRES_IN_SEC,
			// Invitation ids are visible to organization members through the native
			// list endpoint. Require a verified recipient session for by-id get,
			// accept, and reject operations, in addition to Ryu's business-email gate.
			requireEmailVerificationOnInvitation: true,
			// Static Better Auth roles only. Custom roles are Ryu's control-plane
			// `orgRole`/`roleAssignment` (step-up gated, audited, ceiling-checked,
			// mirrored in Core). Better Auth's dynamic roles were a second, unused
			// custom-role system: a dynamic role carrying `member:update` gave
			// Better Auth-level member control to someone Ryu treats as a viewer,
			// outside step-up and audit, so it stays off.
			ac: ryuOrganizationAccessControl,
			roles: ryuOrganizationRoles,
			teams: {
				enabled: true,
				maximumTeams: 50,
				allowRemovingAllTeams: true,
			},
			// Better Auth's own size caps, stated rather than inherited: without
			// them it applies 100 members and 100 pending invitations anyway, and
			// checks them before Ryu's hooks run. Seat admission
			// (lib/organization-admission.ts and `reserveSeatClaim`, where pending
			// invitations hold seats) decides org size below this ceiling.
			// It stays at 100 until the paths that read at most 100 members page:
			// apps/web's `listMembers` callers show only the first page, and Better
			// Auth's last-owner checks (remove/leave/update role) count owners in an
			// unpaged `findMany` capped at 100 rows. Lifting it must use the function
			// form (`() => Number.POSITIVE_INFINITY`): a NUMERIC limit is also the
			// default `listMembers` / `getFullOrganization` page size, and 0 falls
			// back to 100.
			membershipLimit: 100,
			invitationLimit: 100,
			// Organization identity verification — the blue check on the PUBLISHING
			// ORG. Declared here purely so the values come back OUT of Better Auth:
			// its adapter's `transformOutput` iterates the DECLARED schema fields
			// and copies only those, so an undeclared column exists on disk and is
			// silently absent from `getFullOrganization` / `listOrganizations` /
			// `useActiveOrganization` — which is how apps/web reads an org. The
			// WRITE half is Mongoose's `organizationSchema` in
			// `@ryu/db/models/control-plane.model`; neither declaration substitutes
			// for the other and they must stay in step.
			//
			// Every field is `input: false`, matching the `user.additionalFields`
			// posture above: a verified badge is precisely the privilege a caller
			// would assert about itself, so `POST /organization/update` must not be
			// able to carry one. With `input: false` the field is excluded from the
			// client-side body schema outright and stripped by `parseInputData` even
			// if it arrives anyway; only the admin decision path (control plane,
			// Mongoose) can set it. `verificationTier` deliberately stays a plain
			// string here — `ORG_VERIFICATION_TIERS` is enforced at the Mongoose
			// write, and a second copy of the enum in the auth config is how the two
			// vocabularies drift apart.
			schema: {
				organization: {
					additionalFields: {
						verified: {
							type: "boolean",
							input: false,
							required: false,
							defaultValue: false,
						},
						verifiedAt: { type: "date", input: false, required: false },
						verifiedBy: { type: "string", input: false, required: false },
						verificationTier: {
							type: "string",
							input: false,
							required: false,
						},
						// Server-owned; changed only by the primary-ownership transfer.
						primaryOwnerUserId: {
							type: "string",
							input: false,
							required: false,
						},
						// Digest of the public publisher identity (name, slug, logo);
						// a change clears the staff verification verdict below.
						identityRevision: {
							type: "string",
							input: false,
							required: false,
						},
						// The authoritative personal/teams/family kind, written only by
						// `setOrganizationKind`. Declared so it reaches clients: the
						// metadata key can briefly lag it after a racing update, so
						// apps/web's `organizationKindOf` prefers this field. No
						// default, so Better Auth's create/update never write it.
						organizationKind: {
							type: "string",
							input: false,
							required: false,
						},
						verifiedIdentityRevision: {
							type: "string",
							input: false,
							required: false,
						},
						verificationRequestId: {
							type: "string",
							input: false,
							required: false,
						},
					},
				},
				invitation: {
					additionalFields: {
						referralTag: {
							type: "string",
							input: true,
							required: false,
						},
					},
				},
			},
			organizationHooks: {
				beforeCreateOrganization: async ({ organization, user }) => {
					const identityRevision = organizationIdentityRevision(organization);
					// The signup hook uses the reserved `personal-` slug when it
					// mints the default one-person workspace. A consumer mailbox stays
					// personal; a company-domain mailbox is stamped as the Teams boundary
					// immediately, even while verification is pending. Shared membership
					// and paid checkout still require the verified-business decision below.
					const isPersonal = (organization.slug ?? "")
						.trim()
						.toLowerCase()
						.startsWith("personal-");
					if (isPersonal) {
						const bootstrapKind = businessEmailDomainDecision(user.email)
							.allowed
							? TEAMS_ORGANIZATION_KIND
							: PERSONAL_ORGANIZATION_KIND;
						return {
							data: {
								...organization,
								identityRevision,
								metadata: metadataWithOrganizationKind(
									organization.metadata,
									bootstrapKind
								),
								// The creator is the primary owner (see primary-owner.ts),
								// written with the insert rather than patched afterwards.
								primaryOwnerUserId: user.id,
							},
						};
					}
					requireVerifiedBusinessEmail(user);
					return {
						data: {
							...organization,
							identityRevision,
							metadata: metadataWithOrganizationKind(
								organization.metadata,
								TEAMS_ORGANIZATION_KIND
							),
							// The creator is the primary owner (see primary-owner.ts),
							// written with the insert rather than patched afterwards.
							primaryOwnerUserId: user.id,
						},
					};
				},
				afterCreateOrganization: async ({ organization }) => {
					await notifyOrganizationHookActivity({
						body: `${organization.name} was created.`,
						event: "organization.created",
						organizationId: organization.id,
						sourceId: organization.id,
						sourceType: "organization",
						target: "organization",
						title: "Organization created",
						updatedAt: organization.createdAt,
					});
				},
				beforeUpdateOrganization: async ({ organization, member }) => {
					// `organizationKind` is a server-owned boundary marker. Better Auth
					// filters declared input:false fields, but arbitrary metadata remains
					// client-writable, so preserve the durable kind explicitly.
					// The kind comes from the authoritative field when present: Better
					// Auth writes this merged metadata back after the hook, so a family
					// enable/disable landing in between is restored by the after hook.
					const existing = await Organization.findById(member.organizationId)
						.select("logo metadata name organizationKind slug")
						.lean<{
							logo?: string | null;
							metadata?: string;
							name?: string;
							organizationKind?: unknown;
							slug?: string;
						}>();
					const currentMetadata = parseOrganizationMetadata(existing?.metadata);
					const requestedMetadata = parseOrganizationMetadata(
						organization.metadata
					);
					const currentKind = organizationKindFromRecord(existing);
					if (currentKind) {
						requestedMetadata[ORGANIZATION_KIND_KEY] = currentKind;
					} else {
						delete requestedMetadata[ORGANIZATION_KIND_KEY];
					}
					const identityUpdate = resolveOrganizationIdentityUpdate(
						existing ?? {},
						organization
					);
					const data = {
						...organization,
						identityRevision: identityUpdate.revision,
						metadata: { ...currentMetadata, ...requestedMetadata },
					};
					if (!identityUpdate.changed) {
						return { data };
					}
					// This is part of the SAME Better Auth adapter update as the public
					// identity change. A renamed publisher therefore cannot retain a
					// staff verdict even for one successful write.
					return {
						data: {
							...data,
							verificationRequestId: null,
							verificationTier: null,
							verified: false,
							verifiedAt: null,
							verifiedBy: null,
							verifiedIdentityRevision: null,
						},
					};
				},
				afterUpdateOrganization: async ({ organization, member }) => {
					try {
						await reconcileOrganizationKindMetadata(member.organizationId);
					} catch (error) {
						// Readers prefer the authoritative field; the next update retries.
						console.error("Failed to reconcile organization kind:", error);
					}
					if (!organization) {
						return;
					}
					await notifyOrganizationHookActivity({
						body: `${organization.name} was updated.`,
						event: "organization.updated",
						organizationId: member.organizationId,
						sourceId: organization.id,
						sourceType: "organization",
						target: "organization",
						title: "Organization updated",
					});
				},
				beforeDeleteOrganization: async ({ organization }) => {
					await organizationAdmission.beforeDeleteOrganization({
						organization,
					});
				},
				beforeAddMember: async (data) => {
					await revokeStaleRoleGrantsBeforeAdmission({
						organizationId: data.member.organizationId,
						userId: String(data.user.id),
					});
					await organizationAdmission.beforeAddMember(data);
				},
				afterAddMember: async ({ member, organization, user }) => {
					await clearPriorMembershipGrants({
						createdAt: member.createdAt,
						organizationId: member.organizationId,
						userId: String(member.userId),
					});
					// The direct-add lock is needed only until Better Auth has created the
					// member row. Invitation acceptance has its own invitation claim and
					// does not pass through this hook.
					await releaseSeatClaims({
						organizationId: member.organizationId,
						userId: String(member.userId),
					});
					// Confirms the family place, or undoes an add that raced sharing
					// being turned off (and fails the request).
					await organizationAdmission.afterMemberAdmitted({
						actor: "other",
						memberId: String(member.id),
						organizationId: member.organizationId,
						userId: String(member.userId),
					});
					await notifyOrganizationHookActivity({
						body: `${user.name || user.email} joined ${organization.name}.`,
						event: "member.added",
						organizationId: member.organizationId,
						sourceId: member.id,
						sourceType: "member",
						target: "member",
						title: "Organization member added",
						updatedAt: member.createdAt,
					});
				},
				beforeRemoveMember: async ({ member }) => {
					// Release any abandoned direct-add claim before the member row is
					// removed. The after hook repeats this idempotently for normal deletes.
					await releaseSeatClaims({
						organizationId: member.organizationId,
						userId: String(member.userId),
					});
					// Revoke custom-role grants while the removal can still be
					// refused: a failure here stops the removal instead of leaving
					// grants that a later re-admission would revive. The after hook
					// repeats this for a grant written in between.
					await revokeOrganizationRoleAssignments({
						organizationId: member.organizationId,
						userId: String(member.userId),
					});
				},
				beforeUpdateMemberRole: async (data) => {
					await organizationAdmission.beforeUpdateMemberRole(data);
				},
				afterUpdateMemberRole: async ({
					member,
					organization,
					previousRole,
					user,
				}) => {
					await rememberMemberRoleBeforeUpdate(member.id, previousRole);
					await notifyOrganizationHookActivity({
						body: `${user.name || user.email}'s organization role was updated in ${organization.name}.`,
						event: "member.role.updated",
						organizationId: member.organizationId,
						sourceId: member.id,
						sourceType: "member",
						target: "member",
						title: "Organization role updated",
					});
				},
				beforeCreateInvitation: async ({ invitation, inviter }) =>
					await organizationAdmission.beforeCreateInvitation({
						invitation,
						inviter,
					}),
				afterCreateInvitation: async ({ invitation }) => {
					const unsent = await takeUnsentInvitationEmail(invitation.id);
					let unsentOutcome: UnsentInvitationOutcome | null = null;
					if (unsent) {
						// The owner must not see a pending invitation nobody was told
						// about: withdraw it, give back its seat and cooldown, and
						// answer with why and when to send it again.
						const { context } = await getCurrentAuthContext();
						unsentOutcome = await withdrawUnsentInvitation(
							context.adapter,
							invitation
						);
						if (unsentOutcome === "withdrawn") {
							throw invitationEmailNotSentError(unsent.error, "invite");
						}
						// "settled": the invitation was used, so the request stands.
						// "kept": it stays pending without its email, so it is recorded
						// below as the pending invitation it is (its seat claim follows
						// it) and the owner is asked to resend it. Either way no
						// "invitation sent" notice is recorded.
					} else {
						// The email went out (or the recipient's preferences skip it),
						// so the reservations now belong to the invitation.
						await takeInvitationBeingCreated(invitation);
					}
					const now = new Date();
					await OrganizationSeatReservation.updateOne(
						{
							invitationId: pendingInvitationClaimId(
								invitation.organizationId,
								invitation.email
							),
							kind: "pending_invitation",
							organizationId: invitation.organizationId,
						},
						{
							$set: {
								expiresAt: invitation.expiresAt,
								invitationId: invitation.id,
								updatedAt: now,
							},
						}
					);
					await OrganizationInvitationPolicy.updateOne(
						{
							organizationId: invitation.organizationId,
							email: normalizeInvitationEmail(invitation.email),
						},
						{
							$set: {
								lastInvitationId: invitation.id,
								lastSentAt: now,
								cooldownUntil: new Date(
									now.getTime() + ORGANIZATION_INVITATION_COOLDOWN_MS
								),
							},
						}
					);
					if (unsent) {
						if (unsentOutcome === "kept") {
							throw invitationEmailNotSentError(unsent.error, "resend");
						}
						return;
					}
					await notifyOrganizationEvent({
						actionLabel: "Manage organization members",
						actionUrl: organizationAppUrl("/organizations/members"),
						body: `An invitation was sent to ${normalizeInvitationEmail(invitation.email)}.`,
						dedupeKey: `organization-invitation:${invitation.id}:created`,
						kind: "organization-invitation",
						organizationIds: [String(invitation.organizationId)],
						sourceId: String(invitation.id),
						sourceType: "organization-invitation",
						subject: "Organization invitation sent",
						title: "Organization invitation sent",
					});
				},
				afterAcceptInvitation: async ({ invitation, member }) => {
					await clearPriorMembershipGrants({
						createdAt: member.createdAt,
						organizationId: invitation.organizationId,
						userId: String(member.userId),
					});
					await releaseSeatClaims({
						email: invitation.email,
						invitationId: invitation.id,
						organizationId: invitation.organizationId,
					});
					// Confirms the family place, or undoes an accept that raced sharing
					// being turned off (and fails the request).
					await organizationAdmission.afterMemberAdmitted({
						actor: "self",
						memberId: String(member.id),
						organizationId: invitation.organizationId,
						userId: String(member.userId),
					});
					await OrganizationInvitationPolicy.updateOne(
						{
							organizationId: invitation.organizationId,
							email: normalizeInvitationEmail(invitation.email),
						},
						{ $set: { acceptedAt: new Date() } }
					);
					await notifyOrganizationEvent({
						actionLabel: "Open organization invitations",
						actionUrl: organizationAppUrl("/organizations/invitations"),
						actionUrlForOrganization: () =>
							organizationAppUrl("/organizations/members"),
						body: `${normalizeInvitationEmail(invitation.email)} accepted the organization invitation.`,
						dedupeKey: `organization-invitation:${invitation.id}:accepted`,
						extraRecipients: [
							{
								actionLabel: "Open invitations",
								actionUrl: organizationAppUrl("/organizations/invitations"),
								email: invitation.email,
							},
						],
						kind: "organization-invitation",
						organizationIds: [String(invitation.organizationId)],
						sourceId: String(invitation.id),
						sourceType: "organization-invitation",
						subject: "Organization invitation accepted",
						title: "Organization invitation accepted",
					});
				},
				beforeAcceptInvitation: async ({ invitation, user }) => {
					await revokeStaleRoleGrantsBeforeAdmission({
						organizationId: invitation.organizationId,
						userId: String(user.id),
					});
					await organizationAdmission.beforeAcceptInvitation({
						invitation,
						user,
					});
				},
				beforeRejectInvitation: async ({ invitation }) => {
					await organizationAdmission.rejectPersonalWorkspaceInvitation(
						invitation.organizationId
					);
				},
				afterRejectInvitation: async ({ invitation }) => {
					await releaseSeatClaims({
						email: invitation.email,
						invitationId: invitation.id,
						organizationId: invitation.organizationId,
					});
					await organizationAdmission.releaseInvitationFamilyPlace(invitation);
					await OrganizationInvitationPolicy.updateOne(
						{
							organizationId: invitation.organizationId,
							email: normalizeInvitationEmail(invitation.email),
						},
						{
							$set: {
								blockedAt: new Date(),
								declinedAt: new Date(),
								cooldownUntil: null,
							},
						},
						{ upsert: true }
					);
					await notifyOrganizationEvent({
						actionLabel: "Open organization invitations",
						actionUrl: organizationAppUrl("/organizations/invitations"),
						actionUrlForOrganization: () =>
							organizationAppUrl("/organizations/members"),
						body: `${normalizeInvitationEmail(invitation.email)} declined the organization invitation.`,
						dedupeKey: `organization-invitation:${invitation.id}:rejected`,
						extraRecipients: [
							{
								actionLabel: "Open invitations",
								actionUrl: organizationAppUrl("/organizations/invitations"),
								email: invitation.email,
							},
						],
						kind: "organization-invitation",
						organizationIds: [String(invitation.organizationId)],
						sourceId: String(invitation.id),
						sourceType: "organization-invitation",
						subject: "Organization invitation declined",
						title: "Organization invitation declined",
					});
				},
				beforeCancelInvitation: async ({ invitation }) => {
					await organizationAdmission.rejectPersonalWorkspaceInvitation(
						invitation.organizationId
					);
					// Better Auth's own cancel writes `canceled` by id with no expected
					// status, so an accept that won meanwhile would be rewritten as
					// canceled while its member row stays. Claim the single
					// pending -> canceled transition here instead (accept claims the
					// same one); a lost race refuses with the real terminal state.
					const claim = await claimPendingInvitationCancellation(
						String(invitation.id)
					);
					if (!claim.won) {
						throw new APIError("CONFLICT", {
							code: "INVITATION_NOT_PENDING",
							message: `This invitation is already ${claim.status ?? "gone"}.`,
						});
					}
				},
				afterCancelInvitation: async ({ invitation }) => {
					await finalizeCanceledOrganizationInvitation({
						email: invitation.email,
						id: invitation.id,
						organizationId: invitation.organizationId,
					});
				},
				beforeCreateTeam: async ({ team, organization }) =>
					await organizationAdmission.beforeCreateTeam({ organization, team }),
				afterCreateTeam: async ({ team, organization }) => {
					// A team whose before-hook read the personal kind can land after a
					// family enable promoted the org; re-read the kind after the write.
					const familyRefusal = await removeTeamCreatedInFamily({
						organizationId: organization.id,
						teamId: team.id,
					});
					if (familyRefusal) {
						throw new APIError("BAD_REQUEST", { message: familyRefusal });
					}
					await notifyOrganizationHookActivity({
						body: `${team.name} was created in ${organization.name}.`,
						event: "team.created",
						organizationId: organization.id,
						sourceId: team.id,
						sourceType: "team",
						target: "team",
						title: "Organization team created",
						updatedAt: team.createdAt,
					});
				},
				beforeUpdateTeam: async ({ updates }) => {
					if (updates.name === undefined) {
						return;
					}
					const name = updates.name.trim();
					if (!name) {
						throw new APIError("BAD_REQUEST", {
							message: "Team name is required.",
						});
					}
					return { data: { ...updates, name } };
				},
				afterUpdateTeam: async ({ team, organization }) => {
					if (!team) {
						return;
					}
					await notifyOrganizationHookActivity({
						body: `${team.name} was updated in ${organization.name}.`,
						event: "team.updated",
						organizationId: organization.id,
						sourceId: team.id,
						sourceType: "team",
						target: "team",
						title: "Organization team updated",
						updatedAt: team.updatedAt,
					});
				},
				beforeDeleteTeam: async ({ team, organization }) => {
					if (team.organizationId !== organization.id) {
						throw new APIError("BAD_REQUEST", {
							message: "Team does not belong to this organization.",
						});
					}
				},
				afterDeleteTeam: async ({ team, organization }) => {
					await revokeTeamScopedGrants({
						organizationId: organization.id,
						teamId: String(team.id),
					});
					await notifyOrganizationHookActivity({
						body: `${team.name} was deleted from ${organization.name}.`,
						event: "team.deleted",
						organizationId: organization.id,
						sourceId: team.id,
						sourceType: "team",
						target: "team",
						title: "Organization team deleted",
					});
				},
				beforeAddTeamMember: async ({ organization, team, user }) => {
					await revokeStaleRoleGrantsBeforeAdmission({
						organizationId: organization.id,
						teamId: team.id,
						userId: String(user.id),
					});
					await organizationAdmission.beforeAddTeamMember({
						organization,
						user,
					});
				},
				afterAddTeamMember: async ({
					team,
					teamMember,
					organization,
					user,
				}) => {
					await notifyOrganizationHookActivity({
						body: `${user.name || user.email} joined ${team.name}.`,
						event: "team.member.added",
						organizationId: organization.id,
						sourceId: teamMember.id,
						sourceType: "team-member",
						target: "team-member",
						title: "Team member added",
						updatedAt: teamMember.createdAt,
					});
				},
				beforeRemoveTeamMember: async ({ team, teamMember }) => {
					if (teamMember.teamId !== team.id) {
						throw new APIError("BAD_REQUEST", {
							message: "Team member does not belong to this team.",
						});
					}
				},
				afterRemoveTeamMember: async ({
					team,
					teamMember,
					organization,
					user,
				}) => {
					await revokeTeamScopedGrants({
						organizationId: organization.id,
						teamId: String(team.id),
						userId: String(teamMember.userId),
					});
					await notifyOrganizationHookActivity({
						body: `${user.name || user.email} left ${team.name}.`,
						event: "team.member.removed",
						organizationId: organization.id,
						sourceId: teamMember.id,
						sourceType: "team-member",
						target: "team-member",
						title: "Team member removed",
						updatedAt: teamMember.createdAt,
					});
				},
				afterRemoveMember: async ({ member, organization, user }) => {
					// Leaving/removing a member releases access capacity only. The Polar
					// quantity stays exactly as purchased until billing explicitly changes it.
					await releaseSeatClaims({
						organizationId: member.organizationId,
						userId: String(member.userId),
					});
					await revokeRemovedMemberGrants({
						organizationId: member.organizationId,
						userId: String(member.userId),
					});
					await disableFamilyBotGrantsOnMemberExit({
						organizationId: member.organizationId,
						userId: String(member.userId),
					});
					await organizationAdmission.releaseMemberFamilyPlace({
						organizationId: member.organizationId,
						userId: String(member.userId),
					});
					await notifyOrganizationHookActivity({
						body: `${user.name || user.email} left ${organization.name}.`,
						event: "member.removed",
						organizationId: member.organizationId,
						sourceId: member.id,
						sourceType: "member",
						target: "member",
						title: "Organization member removed",
						updatedAt: member.updatedAt,
					});
				},
				afterDeleteOrganization: async ({ organization }) => {
					await OrganizationSeatReservation.deleteMany({
						organizationId: organization.id,
					});
					await releaseFamilyMembershipSlotsForOrganization(organization.id);
					await markManagedAgentOrganizationDeleted(organization.id);
					// Stop its mail; every address it claimed stays reserved forever.
					await retireOrganizationMail(organization.id);
				},
			},
			// Providing this implementation enables member invitations. The invite
			// link lands on the web org shell where the invitee accepts. A send
			// that fails is recorded (recordUnsentInvitationEmail) and the request
			// answers with it: afterCreateInvitation for a new invitation, the
			// global after hook for a resend.
			sendInvitationEmail: recordUnsentInvitationEmail(async (data) => {
				if (
					!(await isOrganizationNotificationEnabled(
						data.organization.id,
						"organization-invitation"
					))
				) {
					return;
				}
				const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
				const invitationPath = `/organizations/accept-invitation/${encodeURIComponent(data.id)}`;
				const inviteUrl = `${frontendUrl}${invitationPath}`;
				const signUpUrl = `${frontendUrl}/login?view=signup&callback=${encodeURIComponent(invitationPath)}`;
				const invitationFields = invitationNotificationFieldsSchema.parse(
					data.invitation
				);
				const referralTag = normalizeReferralTag(invitationFields.referralTag);
				let recipientUserId: string | null = null;
				try {
					const recipient = await User.findOne(
						{ email: data.email.trim().toLowerCase() },
						"_id"
					);
					recipientUserId = recipient ? String(recipient._id) : null;
				} catch (error) {
					// A classification failure should not discard a valid invitation.
					// The new-account flow is safe: signup returns to the invitation,
					// and the accept page still requires a session.
					console.error(
						"Failed to classify organization invitation recipient:",
						error
					);
				}
				if (
					recipientUserId &&
					!(await isUserNotificationChannelEnabled(
						recipientUserId,
						"organization-invitation",
						"email"
					))
				) {
					return;
				}
				const hasRyuAccount = Boolean(recipientUserId);
				let teamName: string | undefined;
				const teamId = invitationFields.teamId?.split(",")[0]?.trim();
				if (teamId) {
					try {
						const team = await Team.findById(teamId)
							.select("name")
							.lean<{ name?: string }>();
						teamName = team?.name;
					} catch (error) {
						// Team context is helpful copy only; a lookup failure must not
						// prevent the native Better Auth invitation email from sending.
						console.error("Failed to resolve invitation team name:", error);
					}
				}
				await sendEmail({
					deliveryClass: "notification",
					to: data.email,
					subject: hasRyuAccount
						? `Come build with ${data.organization.name} on Ryu`
						: `${data.inviter.user.name || data.inviter.user.email} invited you to ${data.organization.name} on Ryu`,
					react: hasRyuAccount
						? OrganizationInvitationExistingAccountEmail({
								invitedByName:
									data.inviter.user.name || data.inviter.user.email,
								organizationName: data.organization.name,
								inviteUrl,
								referralTag,
								teamName,
							})
						: OrganizationInvitationNewAccountEmail({
								invitedByName:
									data.inviter.user.name || data.inviter.user.email,
								organizationName: data.organization.name,
								signUpUrl,
								referralTag,
								teamName,
							}),
				});
			}),
		}),
		loginAssuranceCleanupPlugin(),
		supportAccessPlugin(),
		// Append-only ControlAuditEvent rows for /admin/* account changes
		// (set-role, ban, remove, password, update, create, session revoke).
		platformAdminAuditPlugin(),
		// Mandatory authenticator-or-passkey enrollment: status endpoint plus the
		// guard against removing an account's last strong factor.
		mfaEnrollmentPlugin({ userInMfaRequiredOrganization }),
		// LAST on purpose. Before-hooks run in `[config.hooks.before, ...plugins]`
		// order, so this has to sit after `bearer` — which rewrites an
		// `Authorization` header into the session cookie — or the gate resolves no
		// session for token callers and silently waves them through. See the note
		// in lib/step-up-plugin.ts.
		stepUpGate(),
	],
} satisfies BetterAuthOptions;

export const auth: Auth<typeof authOptions> = betterAuth(authOptions);
