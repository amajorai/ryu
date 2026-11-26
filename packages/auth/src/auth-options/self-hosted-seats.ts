import { User } from "@ryu/db/models/auth.model";
import {
	isBaObjectId,
	Member,
	Organization,
} from "@ryu/db/models/control-plane.model";
import { OrganizationSeatReservation } from "@ryu/db/models/organization-seat-reservation.model";
import { env } from "@ryu/env/server";
import { APIError } from "better-auth/api";
import { verifySelfHostedEnterpriseLicense } from "../lib/enterprise-license.ts";
import { normalizeInvitationEmail } from "../lib/organization-invitation-policy.ts";
import {
	ORGANIZATION_KIND_RECORD_FIELDS,
	type OrganizationKindRecord,
	organizationKindFromRecord,
} from "../lib/organization-kind.ts";
import {
	decideSelfHostedInstallAdmission,
	SELF_HOSTED_MEMBER_LIMIT_CODE,
	type SelfHostedSeatAllowance,
	selfHostedSeatAllowance,
	selfHostedSeatedPeople,
	selfHostedSharedOrganizations,
} from "../lib/self-hosted-member-limit.ts";

// The Mongo and license reads behind the self-hosted member limit. Every
// function here is reached only when `RYU_DEPLOYMENT_MODE=self-hosted`
// (`seat-capacity.ts` checks the mode); the hosted cloud never runs them.

/**
 * The install's member allowance: the seat count of its verified license when
 * that license belongs to an organization on this install, else the free
 * limit. The license is the one in `RYU_ENTERPRISE_LICENSE`, verified offline.
 *
 * The seat count covers the whole install. The organization binding is kept
 * as the proof that the license was issued for this install: a license copied
 * from another install names an organization that does not exist here.
 */
export async function selfHostedInstallAllowance(): Promise<SelfHostedSeatAllowance> {
	const license = verifySelfHostedEnterpriseLicense(
		env.RYU_ENTERPRISE_LICENSE,
		env.RYU_ENTERPRISE_LICENSE_PUBLIC_KEY
	);
	const licensed = selfHostedSeatAllowance(license);
	if (!(license && licensed.licensed)) {
		return licensed;
	}
	const issuedForThisInstall =
		isBaObjectId(license.organizationId) &&
		Boolean(await Organization.exists({ _id: license.organizationId }));
	return issuedForThisInstall ? licensed : selfHostedSeatAllowance(null);
}

export interface SelfHostedInstallSeatUsage {
	/** Live pending-invitation and in-flight claims across shared organizations. */
	reservedSeats: number;
	/** Distinct people who are members of a shared organization. */
	seatedUserIds: Set<string>;
}

type StoredOrganization = OrganizationKindRecord & { _id: unknown };

/**
 * Places in use across the install. `excludeClaimIds` leaves out the caller's
 * own claims (the pending invitation being accepted), which would otherwise
 * count the joining person twice.
 */
export async function selfHostedInstallSeatUsage(
	input: { excludeClaimIds?: readonly string[]; now?: Date } = {}
): Promise<SelfHostedInstallSeatUsage> {
	const stored = await Organization.find({})
		.select(ORGANIZATION_KIND_RECORD_FIELDS)
		.lean<StoredOrganization[]>();
	const shared = selfHostedSharedOrganizations(
		stored.map((organization) => ({
			id: String(organization._id),
			kind: organizationKindFromRecord(organization),
		}))
	);
	if (shared.length === 0) {
		return { reservedSeats: 0, seatedUserIds: new Set() };
	}
	const organizationIds = shared.map((organization) => organization.id);
	const excluded = [...(input.excludeClaimIds ?? [])];
	const [members, reservedSeats] = await Promise.all([
		Member.find({ organizationId: { $in: organizationIds } })
			.select("organizationId userId")
			.lean<Array<{ organizationId: unknown; userId: unknown }>>(),
		OrganizationSeatReservation.countDocuments({
			expiresAt: { $gt: input.now ?? new Date() },
			organizationId: { $in: organizationIds },
			...(excluded.length > 0 ? { invitationId: { $nin: excluded } } : {}),
		}),
	]);
	return {
		reservedSeats,
		seatedUserIds: selfHostedSeatedPeople({
			members: members.map((member) => ({
				organizationId: String(member.organizationId),
				userId: String(member.userId),
			})),
			organizations: shared,
		}),
	};
}

/**
 * Refuse a join that would take the install past its member limit. The
 * candidate is known by user id (direct add, SSO, accepting an invitation) or
 * by the invited email; someone who already holds a place takes no new one.
 *
 * The existing per-organization seat claim runs after this and stays the
 * race-safe authority inside one organization. Two joins racing in two
 * different organizations can both pass this read; that window is one request
 * long and each later join is checked again.
 *
 * A failed read is a hard error: admitting while the count is unknown would be
 * an authorization decision made blind.
 */
export async function requireSelfHostedInstallSeat(input: {
	allowance: SelfHostedSeatAllowance;
	email?: string;
	ownClaimIds: readonly string[];
	refusal: string;
	userId?: string;
}): Promise<void> {
	let allowed: boolean;
	try {
		const usage = await selfHostedInstallSeatUsage({
			excludeClaimIds: input.ownClaimIds,
		});
		const decide = (candidateAlreadySeated: boolean) =>
			decideSelfHostedInstallAdmission({
				candidateAlreadySeated,
				limit: input.allowance.limit,
				reservedSeats: usage.reservedSeats,
				seatedPeople: usage.seatedUserIds.size,
			}).allowed;
		allowed = decide(false);
		if (!allowed) {
			// Full for a new person. Only now is it worth finding out whether the
			// candidate already holds a place.
			const candidateId = input.userId ?? (await userIdForEmail(input.email));
			allowed = decide(
				candidateId !== null && usage.seatedUserIds.has(candidateId)
			);
		}
	} catch (error) {
		console.error("Failed to verify the self-hosted member limit:", error);
		// The same sentence `seat-capacity.ts` answers with when its read fails.
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message:
				"We could not verify the organization’s seat capacity. Try again.",
		});
	}
	if (!allowed) {
		throw new APIError("FORBIDDEN", {
			code: SELF_HOSTED_MEMBER_LIMIT_CODE,
			message: input.refusal,
		});
	}
}

async function userIdForEmail(
	email: string | undefined
): Promise<string | null> {
	if (!email) {
		return null;
	}
	const user = await User.findOne(
		{ email: normalizeInvitationEmail(email) },
		"_id"
	).lean<{ _id: unknown }>();
	return user ? String(user._id) : null;
}
