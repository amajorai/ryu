import { getCurrentAuthContext } from "@better-auth/core/context";
import { OrganizationInvitationPolicy } from "@ryu/db/models/organization-invitation-policy.model";
import { OrganizationSeatReservation } from "@ryu/db/models/organization-seat-reservation.model";
import { APIError } from "better-auth/api";
import type { OrganizationOptions } from "better-auth/plugins";
import { invitationEmailNotSentError } from "../lib/invitation-email-delivery.ts";
import { cancelMemberDataPurgeOnRejoin } from "../lib/member-data-purge.ts";
import { clearPriorMembershipGrants } from "../lib/membership-grant-cleanup.ts";
import {
	normalizeInvitationEmail,
	ORGANIZATION_INVITATION_COOLDOWN_MS,
} from "../lib/organization-invitation-policy.ts";
import {
	notifyOrganizationEvent,
	organizationAppUrl,
} from "../lib/organization-notifications.ts";
import { claimPendingInvitationCancellation } from "../lib/organizations.ts";

import {
	finalizeCanceledOrganizationInvitation,
	organizationAdmission,
} from "./admission.ts";
import type { UnsentInvitationOutcome } from "./invitation-emails.ts";
import {
	takeUnsentInvitationEmail,
	withdrawUnsentInvitation,
} from "./invitation-emails.ts";
import { takeInvitationBeingCreated } from "./invitation-policy.ts";
import {
	releaseSeatClaims,
	revokeStaleRoleGrantsBeforeAdmission,
} from "./member-grants.ts";
import { pendingInvitationClaimId } from "./seat-capacity.ts";

// Organization invitation create, accept, reject and cancel hooks.

type OrganizationHooks = NonNullable<OrganizationOptions["organizationHooks"]>;

export const organizationInvitationHooks = {
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
		// A rejoining member keeps what they create from now on: cancel the
		// node purge still pending from their removal. Never rejects.
		await cancelMemberDataPurgeOnRejoin({
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
} satisfies OrganizationHooks;
