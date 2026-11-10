import { hasRequestState } from "@better-auth/core/context";
import { User } from "@ryu/db/models/auth.model";
import { Member } from "@ryu/db/models/control-plane.model";
import { z } from "zod";
import {
	claimFamilyMembershipSlot,
	confirmFamilyMembershipSlot,
	familyMembershipSlotExists,
	releaseFamilyMembershipSlot,
} from "../lib/family-membership-slots.ts";
import { userFamilyOrganizationIds } from "../lib/family-sharing.ts";
import { createOrganizationAdmission } from "../lib/organization-admission.ts";
import { normalizeInvitationEmail } from "../lib/organization-invitation-policy.ts";
import {
	type OrganizationKind,
	type OrganizationMetadataInput,
	organizationKindFromMetadata,
	PERSONAL_ORGANIZATION_KIND,
	readOrganizationKind,
} from "../lib/organization-kind.ts";
import {
	notifyOrganizationEvent,
	organizationAppUrl,
} from "../lib/organization-notifications.ts";
import { resolvePersonalOrgId } from "../lib/organizations.ts";

import {
	invitationCreationKey,
	invitationsBeingCreated,
	reserveOrganizationInvitationPolicy,
} from "./invitation-policy.ts";
import { releaseSeatClaims } from "./member-grants.ts";
import { activeTeamsSeatCount } from "./seat-capacity.ts";
import {
	reserveDirectMemberSeat,
	reserveInvitationSeat,
	reservePendingInvitationSeat,
} from "./seat-claims.ts";

// Organization admission wiring, canceled-invitation settlement and the
// organization activity notifications sent from hooks.

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
export const organizationAdmission: ReturnType<
	typeof createOrganizationAdmission
> = createOrganizationAdmission({
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
export async function notifyOrganizationHookActivity(input: {
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
