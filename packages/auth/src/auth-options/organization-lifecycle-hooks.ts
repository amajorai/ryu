import { Organization } from "@ryu/db/models/control-plane.model";
import { markManagedAgentOrganizationDeleted } from "@ryu/db/models/managed-agent.model";
import { OrgVerificationRequest } from "@ryu/db/models/org-verification.model";
import { OrganizationSeatReservation } from "@ryu/db/models/organization-seat-reservation.model";
import {
	holdsBrandExemptVerification,
	type OrganizationIdentityUpdateBase,
	organizationIdentityRevision,
	resolveOrganizationIdentityUpdate,
	type VettedPublisher,
} from "@ryu/db/organization-identity";
import { reservedOrganizationIdentityError } from "@ryu/db/organization-reserved-identity";
import type { OrganizationOptions } from "better-auth/plugins";
import { releaseFamilyMembershipSlotsForOrganization } from "../lib/family-membership-slots.ts";
import { requireVerifiedBusinessEmail } from "../lib/organization-admission.ts";
import { businessEmailDomainDecision } from "../lib/organization-email-policy.ts";
import {
	metadataWithOrganizationKind,
	ORGANIZATION_KIND_KEY,
	organizationKindFromRecord,
	PERSONAL_ORGANIZATION_KIND,
	parseOrganizationMetadata,
	reconcileOrganizationKindMetadata,
	TEAMS_ORGANIZATION_KIND,
} from "../lib/organization-kind.ts";
import { retireOrganizationMail } from "../lib/retire-organization-mail.ts";
import { isAdmin } from "../lib/waitlist.ts";

import {
	notifyOrganizationHookActivity,
	organizationAdmission,
} from "./admission.ts";

// Organization create, update and delete hooks.

type OrganizationHooks = NonNullable<OrganizationOptions["organizationHooks"]>;

/** What `beforeUpdateOrganization` reads to resolve a rename. */
const IDENTITY_UPDATE_FIELDS = [
	"logo",
	"metadata",
	"name",
	"organizationKind",
	"slug",
	"revokedVerificationRequestIds",
	"verificationRequestId",
	"verificationTier",
	"verified",
	"verifiedIdentityRevision",
].join(" ");

/**
 * The approved request behind a current official or partner verdict: its legal
 * name names the one brand the organization may rename into. Nothing is read
 * for any other organization, and a request that is not this organization's
 * approved one vets nothing.
 */
async function vettedPublisherOf(
	organizationId: string,
	existing: OrganizationIdentityUpdateBase | null
): Promise<VettedPublisher | null> {
	if (!(existing && holdsBrandExemptVerification(existing))) {
		return null;
	}
	return await OrgVerificationRequest.findOne({
		_id: existing.verificationRequestId,
		organizationId,
		status: "approved",
	})
		.select("legalName")
		.lean<VettedPublisher | null>();
}

export const organizationLifecycleHooks = {
	beforeCreateOrganization: async ({ organization, user }) => {
		// The name and slug are the publisher line on every Marketplace card, so
		// a new organization may not borrow a protected vendor's or Ryu's own
		// name (lookalikes included). This runs for every slug: a caller can ask
		// for a `personal-` slug with any name. Only a platform admin may create
		// one, for Ryu's own or a vendor's organization.
		if (!isAdmin(user)) {
			const reserved = reservedOrganizationIdentityError({}, organization);
			if (reserved) {
				throw reserved;
			}
		}
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
			const bootstrapKind = businessEmailDomainDecision(user.email).allowed
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
		// The verification fields let a vendor's own staff-verified (official or
		// partner) organization rename into the brand its approved legal name
		// reads as.
		const existing = await Organization.findById(member.organizationId)
			.select(IDENTITY_UPDATE_FIELDS)
			.lean<{
				logo?: string | null;
				metadata?: string;
				name?: string;
				organizationKind?: unknown;
				revokedVerificationRequestIds?: string[] | null;
				slug?: string;
				verificationRequestId?: string | null;
				verificationTier?: string | null;
				verified?: boolean | null;
				verifiedIdentityRevision?: string | null;
			}>();
		const currentMetadata = parseOrganizationMetadata(existing?.metadata);
		const requestedMetadata = parseOrganizationMetadata(organization.metadata);
		const currentKind = organizationKindFromRecord(existing);
		if (currentKind) {
			requestedMetadata[ORGANIZATION_KIND_KEY] = currentKind;
		} else {
			delete requestedMetadata[ORGANIZATION_KIND_KEY];
		}
		const identityUpdate = resolveOrganizationIdentityUpdate(
			existing ?? {},
			organization,
			await vettedPublisherOf(member.organizationId, existing)
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
	afterDeleteOrganization: async ({ organization }) => {
		await OrganizationSeatReservation.deleteMany({
			organizationId: organization.id,
		});
		await releaseFamilyMembershipSlotsForOrganization(organization.id);
		await markManagedAgentOrganizationDeleted(organization.id);
		// Stop its mail; every address it claimed stays reserved forever.
		await retireOrganizationMail(organization.id);
	},
} satisfies OrganizationHooks;
