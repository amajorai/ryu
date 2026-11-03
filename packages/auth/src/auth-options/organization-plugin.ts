import { User } from "@ryu/db/models/auth.model";
import { Team } from "@ryu/db/models/control-plane.model";
import { isOrganizationNotificationEnabled } from "@ryu/db/models/organization-notification.model";
import { isUserNotificationChannelEnabled } from "@ryu/db/models/user-notification.model";
import {
	OrganizationInvitationExistingAccountEmail,
	OrganizationInvitationNewAccountEmail,
	sendEmail,
} from "@ryu/email";
import { organization } from "better-auth/plugins";
import { normalizeReferralTag } from "../lib/organization-invitation-policy.ts";
import {
	ryuOrganizationAccessControl,
	ryuOrganizationRoles,
} from "../organization-access.ts";

import { recordUnsentInvitationEmail } from "./invitation-emails.ts";
import { organizationInvitationHooks } from "./organization-invitation-hooks.ts";
import { organizationLifecycleHooks } from "./organization-lifecycle-hooks.ts";
import { organizationMemberHooks } from "./organization-member-hooks.ts";
import { organizationTeamHooks } from "./organization-team-hooks.ts";
import { invitationNotificationFieldsSchema } from "./schemas.ts";
import { ORGANIZATION_INVITATION_EXPIRES_IN_SEC } from "./seat-capacity.ts";

// The organization plugin: roles, teams, invitation limits, schema and hooks.

export const organizationPlugin = organization({
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
		...organizationLifecycleHooks,
		...organizationMemberHooks,
		...organizationInvitationHooks,
		...organizationTeamHooks,
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
						invitedByName: data.inviter.user.name || data.inviter.user.email,
						organizationName: data.organization.name,
						inviteUrl,
						referralTag,
						teamName,
					})
				: OrganizationInvitationNewAccountEmail({
						invitedByName: data.inviter.user.name || data.inviter.user.email,
						organizationName: data.organization.name,
						signUpUrl,
						referralTag,
						teamName,
					}),
		});
	}),
});
