import { createHash } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { expo } from "@better-auth/expo";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { polar } from "@polar-sh/better-auth";
import { client, mongoClient } from "@ryu/db";
import { User } from "@ryu/db/models/auth.model";
import { ControlAuditEvent } from "@ryu/db/models/control-audit.model";
import {
	Member,
	Organization,
	Team,
	TeamMember,
} from "@ryu/db/models/control-plane.model";
import { OrganizationInvitationPolicy } from "@ryu/db/models/organization-invitation-policy.model";
import { isOrganizationNotificationEnabled } from "@ryu/db/models/organization-notification.model";
import { OrganizationSeatEntitlement } from "@ryu/db/models/organization-seat-entitlement.model";
import { OrganizationSeatReservation } from "@ryu/db/models/organization-seat-reservation.model";
import { isUserNotificationChannelEnabled } from "@ryu/db/models/user-notification.model";
import {
	AccountExistsEmail,
	configureContactIdSaver,
	configureRateLimiting,
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
	subscribeContact,
	TwoFactorOTPEmail,
	VerificationEmail,
	WaitlistConfirmationEmail,
} from "@ryu/email";
import { env } from "@ryu/env/server";
import { betterAuth } from "better-auth";
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
	oneTap,
	oneTimeToken,
	organization,
	twoFactor,
	username,
} from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { jwt } from "better-auth/plugins/jwt";
import { createRyuAuthI18nPlugin } from "./lib/auth-i18n.ts";
import { resolveRyuCorsOrigins } from "./lib/cors-origins.ts";
import { ryuEmailHarmony } from "./lib/email-harmony.ts";
import {
	GUEST_MODE_DISABLED_MESSAGE,
	shouldRejectGuestSignIn,
} from "./lib/guest-mode.ts";
import { LOGIN_APPROVAL_CLIENTS } from "./lib/login-approval-contract.ts";
import { loginApprovalSessionPlugin } from "./lib/login-approval-session-plugin.ts";
import {
	assertPendingEmailMatches,
	assertPendingPasskeyMatches,
	loginAssuranceAfterFactor,
	loginAssuranceAfterPassword,
	loginAssuranceCleanupPlugin,
} from "./lib/login-assurance.ts";
import {
	businessEmailDecision,
	businessEmailDomainDecision,
	businessEmailMessage,
} from "./lib/organization-email-policy.ts";
import {
	normalizeInvitationEmail,
	normalizeReferralTag,
	ORGANIZATION_INVITATION_COOLDOWN_MS,
} from "./lib/organization-invitation-policy.ts";
import {
	metadataWithOrganizationKind,
	ORGANIZATION_KIND_KEY,
	organizationKindFromMetadata,
	PERSONAL_ORGANIZATION_KIND,
	parseOrganizationMetadata,
	TEAMS_ORGANIZATION_KIND,
} from "./lib/organization-kind.ts";
import {
	notifyOrganizationEvent,
	organizationAppUrl,
} from "./lib/organization-notifications.ts";
import { activeTeamsSeatAllowance } from "./lib/organization-seat-entitlement.ts";
import { decideSeatAdmission } from "./lib/organization-seat-gate.ts";
import {
	ensurePersonalOrganization,
	type OrganizationApi,
	resolveInitialActiveOrganization,
	resolvePersonalOrgId,
} from "./lib/organizations.ts";
import {
	ensurePolarCustomer,
	polarClient,
	syncPolarCustomer,
} from "./lib/payments.ts";
import {
	ORGANIZATION_PLAN_IDS,
	PLANS,
	planByProductId,
	resolveProductId,
} from "./lib/plans.ts";
import { runRefereeGrantHook } from "./lib/referral-grant-hook.ts";
import {
	ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS,
	isAllowedSocialSignInProvider,
	SOCIAL_SIGN_IN_PROVIDER,
} from "./lib/social-provider-policy.ts";
import { providerIdFromSsoCallbackPath } from "./lib/sso-organization.ts";
import { encryptedMongoAdapter } from "./lib/sso-provider-encryption.ts";
import {
	boundedLoginDetail,
	daysSinceLastActive,
	formatLoginTime,
	isStaleAccountLogin,
} from "./lib/stale-account.ts";
import { stepUpGate } from "./lib/step-up-plugin.ts";
import {
	ADMIN_ROLE,
	APPROVED_ROLE,
	adminEmails,
	generateReferralCode,
	isAdminEmail,
	isWaitlistBypassed,
	referralUrlFor,
	WAITLIST_ROLE,
	webOrigin,
} from "./lib/waitlist.ts";
import { waitlistPositionFor } from "./lib/waitlist-queue.ts";
import {
	ryuOrganizationAccessControl,
	ryuOrganizationRoles,
} from "./organization-access.ts";
import { defaultPermissionsForRole, RYU_SUPPORTED_SCOPES } from "./scopes.ts";

const DUPLICATE_KEY_ERROR_CODE = 11_000;

interface PolarListPage<T> {
	readonly items?: readonly T[];
	readonly result?: { readonly items?: readonly T[] };
}

const polarPageItems = <T>(page: unknown): readonly T[] => {
	if (Array.isArray(page)) {
		return page as readonly T[];
	}
	if (!(page && typeof page === "object")) {
		return [];
	}
	const value = page as PolarListPage<T>;
	return value.result?.items ?? value.items ?? [];
};

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
 * The same org billing identity used by the billing router. A reconciled
 * contract survives the original owner leaving; before reconciliation, use the
 * deterministic earliest-owner bootstrap identity.
 */
async function organizationBillingEmail(
	organizationId: string
): Promise<string | null> {
	const persisted = await OrganizationSeatEntitlement.findOne({
		organizationId,
		status: "active",
	})
		.select("billingEmail")
		.lean<{ billingEmail?: string | null }>();
	if (persisted?.billingEmail?.trim()) {
		return persisted.billingEmail.trim().toLowerCase();
	}
	const owner = await Member.findOne({
		organizationId,
		role: /owner/i,
	}).sort({ createdAt: 1 });
	const member =
		owner ?? (await Member.findOne({ organizationId }).sort({ createdAt: 1 }));
	if (!member) {
		return null;
	}
	const user = await User.findById(member.userId);
	return user?.email ?? null;
}

/**
 * Resolve the live Teams seat quantity for an organization. A missing active
 * Teams subscription returns null (shared membership has no paid capacity);
 * a Polar failure is a hard error because allowing a paid-org membership
 * change while the meter is unknown would be an authorization decision made
 * blind.
 */
async function activeTeamsSeatCount(
	organizationId: string
): Promise<number | null> {
	try {
		const persisted = await OrganizationSeatEntitlement.findOne({
			organizationId,
			status: "active",
		})
			.select("polarCustomerId")
			.lean<{ polarCustomerId?: string | null }>();
		let customerId = persisted?.polarCustomerId?.trim() || null;
		if (!customerId) {
			const email = await organizationBillingEmail(organizationId);
			if (!email) {
				return null;
			}
			const customers = await polarClient.customers.list({
				email,
				limit: 1,
				organizationId: process.env.POLAR_ORGANIZATION_ID,
			});
			for await (const page of customers) {
				const first = polarPageItems<{ id?: string | null }>(page)[0];
				if (first?.id) {
					customerId = first.id;
					break;
				}
			}
		}
		if (!customerId) {
			return null;
		}

		const subscriptions = await polarClient.subscriptions.list({
			customerId,
			// Keep invitation authorization aligned with the billing router's
			// organization subscription resolver; old records must not hide a live plan.
			limit: 100,
		});
		const productIds = ORGANIZATION_PRODUCT_IDS();
		for await (const page of subscriptions) {
			const active = polarPageItems<{
				product?: { id?: string | null } | null;
				productId?: string | null;
				quantity?: number | null;
				seats?: number | null;
				status?: string | null;
			}>(page).find((subscription) => {
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
				return (await activeTeamsSeatAllowance(organizationId, billedSeats))
					.includedSeats;
			}
		}
		return null;
	} catch (error) {
		console.error("Failed to verify organization seat capacity:", error);
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message:
				"We could not verify the organization’s seat capacity. Try again.",
		});
	}
}

const SEAT_CLAIM_TTL_MS = 2 * 60 * 1000;
const ORGANIZATION_INVITATION_EXPIRES_IN_SEC = 48 * 60 * 60;
const PENDING_INVITATION_CLAIM_PREFIX = "pending_invitation:";
const DIRECT_MEMBER_CLAIM_PREFIX = "direct_member:";
const NO_ACTIVE_ORGANIZATION_PLAN_MESSAGE =
	"An active Teams or Business subscription is required before this organization can add members. Buy seats first.";

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
): Promise<number> {
	const seatCapacity = await activeTeamsSeatCount(organizationId);
	if (seatCapacity === null) {
		throw new APIError("FORBIDDEN", {
			message: NO_ACTIVE_ORGANIZATION_PLAN_MESSAGE,
		});
	}
	return seatCapacity;
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
	const seatCapacity = await requireActiveOrganizationSeatCapacity(
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
		throw new APIError("FORBIDDEN", { message: decision.reason });
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
				throw new APIError("FORBIDDEN", {
					message:
						"Organization seat capacity changed while this member was being added. Ask an organization owner or admin to add a seat and try again.",
				});
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
	throw new APIError("FORBIDDEN", {
		message:
			"No unassigned organization seat is available. Buy another seat or remove a member first.",
	});
}

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

	const seatCapacity = await requireActiveOrganizationSeatCapacity(
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
async function refreshResentInvitationSeat(input: {
	email: string;
	organizationId: string;
}): Promise<void> {
	const policy = await OrganizationInvitationPolicy.findOne({
		organizationId: input.organizationId,
		email: normalizeInvitationEmail(input.email),
	})
		.select("lastInvitationId")
		.lean<{ lastInvitationId?: string | null }>();
	if (!policy?.lastInvitationId) {
		return;
	}
	await OrganizationSeatReservation.updateOne(
		{
			invitationId: policy.lastInvitationId,
			organizationId: input.organizationId,
		},
		{
			$set: {
				expiresAt: new Date(
					Date.now() + ORGANIZATION_INVITATION_EXPIRES_IN_SEC * 1000
				),
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
function isDuplicateKeyError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE
	);
}

async function reserveOrganizationInvitationPolicy(input: {
	email: string;
	organizationId: string;
	referralTag?: string;
}): Promise<void> {
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
					referralTag: input.referralTag,
				},
				$setOnInsert: {
					email: input.email,
					organizationId: input.organizationId,
				},
			},
			{ new: true, upsert: true }
		);
		if (reserved) {
			return;
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

const PERSONAL_WORKSPACE_MESSAGE =
	"Personal workspaces are for one person. Upgrade this workspace to Teams to invite teammates and share access.";

interface OrganizationPolicyUser {
	email?: string | null;
	emailVerified?: boolean | null;
}

function requireVerifiedBusinessEmail(
	user: OrganizationPolicyUser,
	context: "member" | "upgrade" = "member"
): void {
	const decision = businessEmailDecision({
		email: user.email,
		emailVerified: user.emailVerified,
	});
	if (!decision.allowed) {
		throw new APIError("FORBIDDEN", {
			message: businessEmailMessage(decision, context),
		});
	}
}

function requireBusinessEmailDomain(email: string): void {
	const decision = businessEmailDomainDecision(email);
	if (!decision.allowed) {
		throw new APIError("BAD_REQUEST", {
			message: businessEmailMessage(decision, "invitation"),
		});
	}
}

/** Resolve the durable personal/shared kind, with a legacy fallback. */
async function isPersonalOrganization(
	organizationId: string,
	metadata?: unknown
): Promise<boolean> {
	const organization = metadata
		? null
		: await Organization.findById(organizationId)
				.select("metadata")
				.lean<{ metadata?: unknown }>();
	const kind = organizationKindFromMetadata(metadata ?? organization?.metadata);
	if (kind === PERSONAL_ORGANIZATION_KIND) {
		return true;
	}
	if (kind === TEAMS_ORGANIZATION_KIND) {
		return false;
	}

	const firstMember = await Member.findOne({ organizationId })
		.sort({ createdAt: 1 })
		.select("userId")
		.lean<{ userId: unknown }>();
	if (!firstMember) {
		return false;
	}
	const personalOrgId = await resolvePersonalOrgId(String(firstMember.userId));
	return personalOrgId === organizationId;
}

/** Keep the personal workspace genuinely personal; shared access needs an org. */
async function rejectPersonalWorkspaceInvitation(
	organizationId: string,
	metadata?: unknown
): Promise<void> {
	if (await isPersonalOrganization(organizationId, metadata)) {
		throw new APIError("BAD_REQUEST", {
			message: PERSONAL_WORKSPACE_MESSAGE,
		});
	}
}

function boundedOrganizationHookValue(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed.slice(0, 300) : null;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	return value === null || value === undefined
		? null
		: String(value).slice(0, 300);
}

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
const errorCode = (e: unknown): string | undefined =>
	typeof e === "object" && e !== null && "code" in e
		? String((e as { code: unknown }).code)
		: undefined;

interface EmailUser {
	email: string;
	name?: string | null;
}

interface AuthAccount {
	providerId: string;
}

interface RateLimitedError {
	retryAfter?: number;
}

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY ?? "";

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
					lastLoginDevice: boundedLoginDetail(session.userAgent) ?? null,
					lastLoginIp: boundedLoginDetail(session.ipAddress) ?? null,
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

function retryAfterSeconds(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null || !("retryAfter" in error)) {
		return;
	}
	const { retryAfter } = error as RateLimitedError;
	return typeof retryAfter === "number" ? retryAfter : undefined;
}

const checkEmailRateLimit = async (email: string): Promise<RateLimitResult> => {
	try {
		const user = await User.findOne({ email: email.toLowerCase() });

		if (!user) {
			return { allowed: true };
		}

		const now = new Date();

		if (user.lastEmailSentAt) {
			const timeSinceLastEmail = now.getTime() - user.lastEmailSentAt.getTime();
			const cooldownPeriod = 60 * 1000;

			if (timeSinceLastEmail < cooldownPeriod) {
				const retryAfter = Math.ceil(
					(cooldownPeriod - timeSinceLastEmail) / 1000
				);
				return {
					allowed: false,
					reason: "Please wait before requesting another email",
					retryAfter,
				};
			}
		}

		const today = new Date();
		today.setHours(0, 0, 0, 0);

		if (user.lastEmailResetDate) {
			const lastReset = new Date(user.lastEmailResetDate);
			lastReset.setHours(0, 0, 0, 0);

			if (today.getTime() > lastReset.getTime()) {
				await User.updateOne(
					{ _id: user._id },
					{ $set: { dailyEmailCount: 0, lastEmailResetDate: today } }
				);
			}
		} else {
			await User.updateOne(
				{ _id: user._id },
				{ $set: { lastEmailResetDate: today } }
			);
		}

		if ((user.dailyEmailCount ?? 0) >= 20) {
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

		return { allowed: true };
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

		let newDailyCount: number;
		let newResetDate: Date | undefined;

		if (user.lastEmailResetDate) {
			const lastReset = new Date(user.lastEmailResetDate);
			lastReset.setHours(0, 0, 0, 0);

			if (today.getTime() > lastReset.getTime()) {
				newDailyCount = 1;
				newResetDate = today;
			} else {
				newDailyCount = (user.dailyEmailCount ?? 0) + 1;
			}
		} else {
			newDailyCount = 1;
			newResetDate = today;
		}

		await User.updateOne(
			{ _id: user._id },
			{
				$set: {
					lastEmailSentAt: now,
					dailyEmailCount: newDailyCount,
					...(newResetDate && { lastEmailResetDate: newResetDate }),
				},
			}
		);
	} catch (error) {
		console.error("Error updating user email stats:", error);
	}
};

configureRateLimiting(checkEmailRateLimit, updateEmailStats);

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

function passkeyWebAuthnOptions(): { origin?: string; rpID?: string } {
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
 * the apex never sees it and /login <-> /dashboard loops forever. Explicit
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
function referredByFromCookie(context: unknown): string | undefined {
	const ctx = context as
		| {
				headers?: { get?: (k: string) => string | null } | null;
				request?: {
					headers?: { get?: (k: string) => string | null } | null;
				} | null;
		  }
		| null
		| undefined;
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
 * here degrades to "no teams" instead of costing the caller their org claims —
 * which is what sharing the caller's try/catch would do.
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
 * Stamp `ADMIN_ROLE` on an allowlisted address that does not carry it yet.
 *
 * The role is written ONCE, in the user-create hook, from `isAdminEmail(email)`.
 * So an address added to `ADMIN_EMAILS` AFTER its account already existed never
 * receives the role — the server-side gates still let them through (they read
 * the allowlist directly), but everything that can only see the session, which
 * is every client-side admin affordance and the Better Auth admin plugin's own
 * `adminRoles` check, treats them as an ordinary user. That is an admin who is
 * allowed in and cannot find the door.
 *
 * Reconciling on session create is the same lazy-heal idiom the referral code
 * already uses, and it grants nothing new: the create hook's own comment says
 * the allowlist is exactly who should hold this role, and the allowlist is
 * already sufficient for the server-side admin gates and for impersonation
 * (`support-access.ts`). This only makes the stored role agree with it.
 *
 * Fail-open: a lookup error must never block login.
 */
async function reconcileAdminRole(userId: string): Promise<void> {
	try {
		const record = await User.findById(userId)
			.select("email role")
			.lean<{ email?: string; role?: string }>();
		if (!record?.email || record.role === ADMIN_ROLE) {
			return;
		}
		if (!isAdminEmail(record.email)) {
			return;
		}
		await User.updateOne({ _id: userId }, { $set: { role: ADMIN_ROLE } });
	} catch (error) {
		console.error("Failed to reconcile admin role:", error);
	}
}

export const auth = betterAuth({
	// SCIM creates/updates a user, account, and organization membership as one
	// operation. Pass the native MongoClient so Better Auth enables interactive
	// transactions; passing only the Db silently disables the transaction hook.
	database: encryptedMongoAdapter(client, { client: mongoClient }),
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
	socialProviders: {
		google: {
			clientId: env.GOOGLE_CLIENT_ID ?? "",
			clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
		},
		...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
			? {
					github: {
						clientId: env.GITHUB_CLIENT_ID,
						clientSecret: env.GITHUB_CLIENT_SECRET,
					},
				}
			: {}),
		...(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET
			? {
					discord: {
						clientId: env.DISCORD_CLIENT_ID,
						clientSecret: env.DISCORD_CLIENT_SECRET,
					},
				}
			: {}),
	},
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: [...ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS],
			allowUnlinkingAll: true,
		},
	},
	emailAndPassword: {
		enabled: true,
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

				try {
					await subscribeContact(user.email, user.name ?? undefined);
				} catch (subscribeError) {
					console.error(
						"Failed to subscribe contact (non-critical):",
						subscribeError
					);
				}
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
		},
	},
	user: {
		additionalFields: {
			avatarId: {
				type: "string",
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
		return {
			ipAddress: {
				// Better Auth only trusts a single forwarded value unless explicit
				// proxy ranges are configured. This keeps spoofed forwarded chains from
				// becoming distinct rate-limit buckets by accident.
				ipAddressHeaders:
					ipAddressHeaders.length > 0 ? ipAddressHeaders : ["x-forwarded-for"],
				...(trustedProxies.length > 0 ? { trustedProxies } : {}),
			},
			// When the frontend and auth API live on different subdomains
			// (ryuhq.com vs api.ryuhq.com), the session cookie must carry the shared
			// parent domain (AUTH_COOKIE_DOMAIN="ryuhq.com") so the apex SSR portal gate
			// can read it.
			// Without this it is host-only on the API subdomain, invisible to SSR, and
			// /dashboard <-> /login loops forever. Env-gated so local dev (no shared
			// parent) keeps host-only cookies.
			...(authCookieDomain
				? {
						crossSubDomainCookies: {
							enabled: true,
							domain: authCookieDomain,
						},
					}
				: {}),
			defaultCookieAttributes: {
				sameSite: "lax",
				secure: process.env.NODE_ENV === "production",
				httpOnly: true,
			},
		};
	})(),
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			if (shouldRejectGuestSignIn(ctx.path)) {
				throw new APIError("FORBIDDEN", {
					message: GUEST_MODE_DISABLED_MESSAGE,
				});
			}
			if (ctx.path === "/sign-in/social") {
				const body = ctx.body as { provider?: unknown };
				if (!isAllowedSocialSignInProvider(body?.provider)) {
					throw new APIError("FORBIDDEN", {
						message: `Social sign-in is available only with ${SOCIAL_SIGN_IN_PROVIDER}.`,
					});
				}
			}
			if (ctx.path === "/sign-in/email") {
				const body = ctx.body as { email?: string };
				if (!body?.email) {
					return;
				}

				const user = await ctx.context.internalAdapter.findUserByEmail(
					body.email.toLowerCase(),
					{ includeAccounts: true }
				);

				if (
					user?.accounts &&
					!user.accounts.find(
						(account: AuthAccount) => account.providerId === "credential"
					)
				) {
					throw new APIError("UNAUTHORIZED", {
						message: "NO_PASSWORD_ACCOUNT",
					});
				}
			}
			await assertPendingEmailMatches(ctx);
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
					} catch (error) {
						console.error("Failed to clear active organization team:", error);
					}
				}
			}
			if (ctx.path === "/organization/invite-member") {
				const body = ctx.body as {
					email?: unknown;
					organizationId?: unknown;
					resend?: unknown;
				};
				if (body?.resend === true && typeof body.email === "string") {
					const organizationId =
						typeof body.organizationId === "string"
							? body.organizationId
							: ctx.context.session?.session.activeOrganizationId;
					if (organizationId) {
						try {
							await refreshResentInvitationSeat({
								email: body.email,
								organizationId,
							});
						} catch (error) {
							// The acceptance hook remains authoritative if this maintenance
							// refresh cannot reach Mongo; do not turn a successfully resent
							// invitation into a misleading 500 response.
							console.error(
								"Failed to refresh resent organization invitation seat:",
								error
							);
						}
					}
				}
			}

			// Better Auth owns the organization/member/team mutations themselves, so
			// they do not pass through the Hono control-plane router middleware. Keep
			// the audit append at this post-success hook: the session is authenticated,
			// the mutation has completed, and only stable ids are persisted.
			const organizationAuditActions: Record<
				string,
				{ action: string; target: string }
			> = {
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
			};
			const auditAction = organizationAuditActions[ctx.path];
			const session = ctx.context.session;
			const body =
				ctx.body && typeof ctx.body === "object"
					? (ctx.body as Record<string, unknown>)
					: {};
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
			const returned =
				ctx.context.returned && typeof ctx.context.returned === "object"
					? (ctx.context.returned as Record<string, unknown>)
					: {};
			const returnedOrganization =
				returned.organization && typeof returned.organization === "object"
					? (returned.organization as Record<string, unknown>)
					: {};
			const returnedInvitation =
				returned.invitation && typeof returned.invitation === "object"
					? (returned.invitation as Record<string, unknown>)
					: {};
			const returnedMember =
				returned.member && typeof returned.member === "object"
					? (returned.member as Record<string, unknown>)
					: {};
			const returnedTeam =
				returned.team && typeof returned.team === "object"
					? (returned.team as Record<string, unknown>)
					: {};
			const returnedOrganizationId = [
				returnedOrganization.id,
				returned.organizationId,
				returnedInvitation.organizationId,
				returnedMember.organizationId,
				returnedTeam.organizationId,
				returned.id,
			].find(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0
			);
			const organizationId =
				auditAction?.action === "organization.create"
					? returnedOrganizationId
					: typeof body.organizationId === "string"
						? body.organizationId
						: (returnedOrganizationId ?? session?.session.activeOrganizationId);
			if (auditAction && organizationId && session?.user?.id) {
				const targetId =
					["memberId", "userId", "teamId", "invitationId"].reduce<
						string | null
					>((found, key) => {
						if (found) {
							return found;
						}
						const value = body[key];
						return typeof value === "string" && value.trim() ? value : null;
					}, null) ?? organizationId;
				try {
					await ControlAuditEvent.create({
						action: auditAction.action,
						actorId: session.user.id,
						actorType: "user",
						details: { method: ctx.method, status: "success" },
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
			const loginAssuranceResponse = await loginAssuranceAfterPassword(ctx);
			if (loginAssuranceResponse) {
				return loginAssuranceResponse;
			}
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

			const providerId = providerIdFromSsoCallbackPath(ctx.path);
			const newSession = ctx.context.newSession;
			const sessionToken = newSession?.session?.token;
			const userId = newSession?.user?.id;
			if (!(providerId && sessionToken && userId)) {
				return;
			}

			try {
				const provider = (await ctx.context.adapter.findOne({
					model: "ssoProvider",
					where: [{ field: "providerId", value: providerId }],
				})) as { organizationId?: unknown } | null;
				const organizationId =
					provider && typeof provider.organizationId === "string"
						? provider.organizationId
						: null;
				if (!organizationId) {
					return;
				}

				const member = await Member.findOne({ organizationId, userId })
					.select("_id")
					.lean();
				if (!member) {
					return;
				}

				const activeOrganizationId = newSession.session.activeOrganizationId as
					| string
					| undefined;
				if (activeOrganizationId === organizationId) {
					return;
				}

				await ctx.context.internalAdapter.updateSession(sessionToken, {
					activeOrganizationId: organizationId,
					updatedAt: new Date(),
				});
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
									await ensurePersonalOrganization(
										userId,
										auth.api as unknown as OrganizationApi
									);
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
					if ((user as { isAnonymous?: boolean }).isAnonymous) {
						return { data: user };
					}
					// Stamp every new user with a referral code. Normalize any inbound
					// referral code to the canonical upper-case form. (Role is set in the
					// after hook so it reliably overrides the admin plugin's default.)
					const inboundReferredBy = (user as { referredBy?: string | null })
						.referredBy;
					// Email/password sign-up threads `referredBy` in the body (wins here);
					// social/OAuth sign-up has no body, so fall back to the `ryu_ref`
					// cookie the web client set at the ?ref= landing. Without this,
					// Google-referred signups silently attribute to no one.
					const rawReferredBy =
						inboundReferredBy || referredByFromCookie(context);
					const referredBy = rawReferredBy
						? rawReferredBy.trim().toUpperCase()
						: undefined;
					return {
						data: {
							...user,
							referralCode: generateReferralCode(),
							referralCount: 0,
							...(referredBy ? { referredBy } : {}),
						},
					};
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
					await ensurePolarCustomer({
						id: user.id,
						email: user.email,
						name: user.name,
					});
					// Credit the referrer (if any) so referrals move them up the queue.
					// Best-effort: a bad/unknown code just means no credit.
					if (user.referredBy) {
						try {
							await User.updateOne(
								{ referralCode: user.referredBy },
								{ $inc: { referralCount: 1 } }
							);
						} catch (error) {
							console.error("Failed to credit referrer:", error);
						}
					}
					// Put the new user in the queue (role WAITLIST_ROLE); admins skip it
					// and keep the normal role. This overrides the admin plugin's default
					// "user" role. Written via Mongoose so it definitely persists. Also
					// ensure a referral code exists.
					const approved = isAdminEmail(user.email);
					// Support staff (the admin allowlist) get the real "admin" role so
					// the admin plugin's impersonation primitive accepts them (#545).
					// With no admins configured (self-hosted, ADMIN_EMAILS empty) nobody
					// could ever approve a queued user, so signups are auto-approved
					// (APPROVED_ROLE) instead of dead-ending on the waitlist; otherwise
					// everyone else is queued (WAITLIST_ROLE), fail-closed as before.
					const queued = !(approved || isWaitlistBypassed());
					let resolvedRole = APPROVED_ROLE;
					if (approved) {
						resolvedRole = ADMIN_ROLE;
					} else if (queued) {
						resolvedRole = WAITLIST_ROLE;
					}
					const referralCode = user.referralCode ?? generateReferralCode();
					try {
						await User.updateOne(
							{ _id: user.id },
							{
								$set: {
									role: resolvedRole,
									...(user.emailVerified
										? { emailVerifiedAt: new Date() }
										: {}),
								},
							}
						);
						await User.updateOne(
							{ _id: user.id, referralCode: { $in: [null, undefined, ""] } },
							{ $set: { referralCode, referralCount: user.referralCount ?? 0 } }
						);
					} catch (error) {
						console.error("Failed to set waitlist role:", error);
					}
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
						await ensurePersonalOrganization(
							user.id,
							auth.api as unknown as OrganizationApi
						);
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
				after: async (user: { id: string; email: string; name?: string }) => {
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
		// Better Auth owns authentication responses, so localize its standard error
		// codes at the server boundary. The product language-pack runtime owns UI
		// copy; this plugin is deliberately limited to auth errors and keeps the
		// original message in the response for support and diagnostics.
		createRyuAuthI18nPlugin(),
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
			secretKey: TURNSTILE_SECRET_KEY,
		}),
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
		passkey({
			...PASSKEY_WEBAUTHN_OPTIONS,
			rpName: "Ryu",
			authentication: {
				afterVerification: ({ ctx }) => assertPendingPasskeyMatches(ctx),
			},
		}),
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
		}),
		polar({
			client: polarClient,
			// Keep the Polar integration for customer/subscription webhooks, but do
			// not register its generic checkout/portal routes. All money creation is
			// owned by the org-aware billing routers below.
			// The SDK types `use` as a non-empty tuple even when no optional Polar
			// endpoint should be registered. Keep the runtime list empty; the cast is
			// only to satisfy that type-level tuple requirement.
			use: [] as unknown as [never],
			// Customer provisioning is handled by databaseHooks.user.create.after via
			// ensurePolarCustomer so a Polar/API error never makes sign-up fail.
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
		}),
		lastLoginMethod(),
		username({
			minUsernameLength: 3,
			maxUsernameLength: 32,
		}),
		jwt({
			jwt: {
				// Enrich the JWT so a node's Core can verify org + team membership and
				// role OFFLINE (it validates the signature against the JWKS, no live call
				// to better-auth). definePayload only receives `user` (not the session),
				// so we resolve every org the user belongs to from the `member`
				// collection, and every team from `teamMember`, the same sources of truth
				// the control plane reads from. Core narrows both to its bound org.
				// Fail-open: a lookup error must never block token issuance, so we fall
				// back to a user-only payload.
				definePayload: async ({ user }) => {
					const base = { id: user.id, email: user.email };
					try {
						// This runs on every token mint, and the two rosters are independent,
						// so they overlap. The `catch` keeps a team-roster failure from
						// rejecting the pair: teams are additive, org claims are not.
						const [members, teamRows] = await Promise.all([
							Member.find({ userId: user.id }).lean(),
							TeamMember.find({ userId: user.id })
								.lean()
								.catch((error: unknown) => {
									console.error("Failed to read team memberships:", error);
									return [];
								}),
						]);
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
						return { ...base, orgs, teams };
					} catch (error) {
						console.error("Failed to embed org memberships in JWT:", error);
						return base;
					}
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
				permissions: {
					defaultPermissions: async (referenceId) => {
						try {
							const user = await User.findById(referenceId).lean();
							return defaultPermissionsForRole(user?.role);
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
		sso({
			domainVerification: { enabled: true },
			organizationProvisioning: {
				defaultRole: "member",
				getRole: async () => "member",
			},
			provisionUserOnEveryLogin: true,
			saml: {
				algorithms: { onDeprecated: "reject" },
				allowIdpInitiated: true,
				enableInResponseToValidation: true,
				requireTimestamps: true,
			},
		}),
		scim({
			// Ryu provisions SCIM connections through the organization-scoped
			// Enterprise router. Better Auth owns the managed connection catalog and
			// stores only credential digests; no personal/static token path is exposed.
			connections: [],
			managedConnections: {
				credentialHashSecret: env.BETTER_AUTH_SECRET,
				maxActiveCredentials: 5,
			},
		}),
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
			// Enable Better Auth's organization-role lifecycle endpoints. These
			// roles are additive to the Ryu control-plane RBAC below; they never
			// widen a Ryu scope without an explicit server-side permission check.
			ac: ryuOrganizationAccessControl,
			roles: ryuOrganizationRoles,
			dynamicAccessControl: {
				enabled: true,
				maximumRolesPerOrganization: 20,
			},
			teams: {
				enabled: true,
				maximumTeams: 50,
				allowRemovingAllTeams: true,
			},
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
								metadata: metadataWithOrganizationKind(
									organization.metadata,
									bootstrapKind
								),
							},
						};
					}
					requireVerifiedBusinessEmail(user);
					return {
						data: {
							...organization,
							metadata: metadataWithOrganizationKind(
								organization.metadata,
								TEAMS_ORGANIZATION_KIND
							),
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
					const existing = await Organization.findById(member.organizationId)
						.select("metadata")
						.lean<{ metadata?: unknown }>();
					const currentMetadata = parseOrganizationMetadata(existing?.metadata);
					const requestedMetadata = parseOrganizationMetadata(
						organization.metadata
					);
					const currentKind = organizationKindFromMetadata(currentMetadata);
					if (currentKind) {
						requestedMetadata[ORGANIZATION_KIND_KEY] = currentKind;
					} else {
						delete requestedMetadata[ORGANIZATION_KIND_KEY];
					}
					return {
						data: {
							...organization,
							metadata: { ...currentMetadata, ...requestedMetadata },
						},
					};
				},
				afterUpdateOrganization: async ({ organization, member }) => {
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
					// Deleting the Better Auth organization must not strand an active
					// Polar subscription that would keep charging its payer. Cancel the
					// plan through billing first; once Polar reports it inactive, deletion
					// can proceed and the after hook removes transient seat claims.
					if ((await activeTeamsSeatCount(organization.id)) !== null) {
						throw new APIError("BAD_REQUEST", {
							message:
								"Cancel the active organization plan before deleting this organization. Billing is managed from Organization billing.",
						});
					}
				},
				beforeAddMember: async ({ member, user, organization }) => {
					const personal = await isPersonalOrganization(
						member.organizationId,
						organization.metadata
					);
					const memberCount = await Member.countDocuments({
						organizationId: member.organizationId,
					});
					if (personal) {
						if (memberCount > 0) {
							throw new APIError("BAD_REQUEST", {
								message: PERSONAL_WORKSPACE_MESSAGE,
							});
						}
						return;
					}
					const isFirstOwner =
						memberCount === 0 &&
						member.role
							.split(",")
							.map((role) => role.trim())
							.includes("owner");
					// The signup bootstrap can stamp a company-domain account as a Teams
					// org before its verification email is completed. Permit that one
					// owner row so the account has a usable home. A newly-created shared
					// organization also needs its first owner before it has a subscription;
					// every later member requires both a paid seat and the verified-business
					// decision.
					const bootstrapTeams =
						isFirstOwner &&
						(organization.slug ?? "")
							.trim()
							.toLowerCase()
							.startsWith("personal-") &&
						businessEmailDomainDecision(user.email).allowed;
					if (bootstrapTeams || isFirstOwner) {
						return;
					}
					requireVerifiedBusinessEmail(user);
					await reserveDirectMemberSeat({
						organizationId: member.organizationId,
						userId: user.id,
					});
				},
				afterAddMember: async ({ member, organization, user }) => {
					// The direct-add lock is needed only until Better Auth has created the
					// member row. Invitation acceptance has its own invitation claim and
					// does not pass through this hook.
					await releaseSeatClaims({
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
				},
				beforeUpdateMemberRole: async ({ user }) => {
					// A role promotion is another shared-organization admission point.
					// Keep a user whose email was changed or unverified from gaining a
					// stronger organization role through the native Better Auth endpoint.
					requireVerifiedBusinessEmail(user);
				},
				afterUpdateMemberRole: async ({ member, organization, user }) => {
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
				beforeCreateInvitation: async ({ invitation, inviter }) => {
					await rejectPersonalWorkspaceInvitation(invitation.organizationId);
					requireVerifiedBusinessEmail(inviter);
					requireBusinessEmailDomain(invitation.email);
					const email = normalizeInvitationEmail(invitation.email);
					// The seat is reserved before Better Auth writes the invitation. The
					// short TTL covers a failed create; afterCreateInvitation extends it to
					// the invitation's real expiry.
					await reservePendingInvitationSeat({
						email,
						organizationId: invitation.organizationId,
					});
					try {
						await reserveOrganizationInvitationPolicy({
							email,
							organizationId: invitation.organizationId,
							referralTag: normalizeReferralTag(invitation.referralTag),
						});
					} catch (error) {
						// Do not strand the seat when the independent invitation policy
						// rejects this send (cooldown or decline block).
						await releaseSeatClaims({
							email,
							organizationId: invitation.organizationId,
						});
						throw error;
					}
					return {
						data: {
							...invitation,
							email,
							referralTag: normalizeReferralTag(invitation.referralTag),
						},
					};
				},
				afterCreateInvitation: async ({ invitation }) => {
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
								referralTag: normalizeReferralTag(invitation.referralTag),
							},
						}
					);
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
				afterAcceptInvitation: async ({ invitation }) => {
					await releaseSeatClaims({
						email: invitation.email,
						invitationId: invitation.id,
						organizationId: invitation.organizationId,
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
					await rejectPersonalWorkspaceInvitation(invitation.organizationId);
					requireVerifiedBusinessEmail(user);
					await reserveInvitationSeat({
						email: invitation.email,
						invitationId: invitation.id,
						organizationId: invitation.organizationId,
						userId: user.id,
					});
				},
				beforeRejectInvitation: async ({ invitation }) => {
					await rejectPersonalWorkspaceInvitation(invitation.organizationId);
				},
				afterRejectInvitation: async ({ invitation }) => {
					await releaseSeatClaims({
						email: invitation.email,
						invitationId: invitation.id,
						organizationId: invitation.organizationId,
					});
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
					await rejectPersonalWorkspaceInvitation(invitation.organizationId);
				},
				afterCancelInvitation: async ({ invitation }) => {
					await releaseSeatClaims({
						email: invitation.email,
						invitationId: invitation.id,
						organizationId: invitation.organizationId,
					});
					await notifyOrganizationEvent({
						actionLabel: "Manage organization members",
						actionUrl: organizationAppUrl("/organizations/invitations"),
						actionUrlForOrganization: () =>
							organizationAppUrl("/organizations/members"),
						body: `The invitation for ${normalizeInvitationEmail(invitation.email)} was cancelled.`,
						dedupeKey: `organization-invitation:${invitation.id}:cancelled`,
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
						subject: "Organization invitation cancelled",
						title: "Organization invitation cancelled",
					});
				},
				beforeCreateTeam: async ({ team }) => {
					const name = team.name.trim();
					if (!name) {
						throw new APIError("BAD_REQUEST", {
							message: "Team name is required.",
						});
					}
					return { data: { ...team, name } };
				},
				afterCreateTeam: async ({ team, organization }) => {
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
					if (typeof updates.name !== "string") {
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
				beforeAddTeamMember: async ({ organization, user }) => {
					await rejectPersonalWorkspaceInvitation(
						organization.id,
						organization.metadata
					);
					requireVerifiedBusinessEmail(user);
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
				},
			},
			// Providing this implementation enables member invitations. The invite
			// link lands on the web org shell where the invitee accepts.
			sendInvitationEmail: async (data) => {
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
				const referralTag = normalizeReferralTag(
					(data.invitation as { referralTag?: unknown } | undefined)
						?.referralTag
				);
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
				const teamId =
					typeof data.invitation.teamId === "string"
						? data.invitation.teamId.split(",")[0]?.trim()
						: undefined;
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
				try {
					await sendEmail({
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
				} catch (error) {
					console.error("Failed to send organization invitation email:", error);
				}
			},
		}),
		loginAssuranceCleanupPlugin(),
		// LAST on purpose. Before-hooks run in `[config.hooks.before, ...plugins]`
		// order, so this has to sit after `bearer` — which rewrites an
		// `Authorization` header into the session cookie — or the gate resolves no
		// session for token callers and silently waves them through. See the note
		// in lib/step-up-plugin.ts.
		stepUpGate(),
	],
});
