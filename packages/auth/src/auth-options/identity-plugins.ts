import { queueAfterTransactionHook } from "@better-auth/core/context";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { env } from "@ryu/env/server";
import { recordOrganizationControlAudit } from "../lib/control-audit-recorder.ts";
import { disableFamilyBotGrantsOnMemberExit } from "../lib/family-bot-grants.ts";
import { assertPendingPasskeyMatches } from "../lib/login-assurance.ts";
import {
	createScimIdentity,
	createScimMembershipProjection,
	type ScimRemovedMember,
} from "../lib/scim-deprovisioning.ts";

import {
	notifyOrganizationHookActivity,
	organizationAdmission,
} from "./admission.ts";
import {
	releaseSeatClaims,
	revokeRemovedMemberGrants,
} from "./member-grants.ts";
import { PASSKEY_WEBAUTHN_OPTIONS } from "./origins.ts";

// The passkey and SCIM plugins with Ryu's relying party and deprovisioning.

interface RyuPasskeyPlugin extends ReturnType<typeof passkey> {}
interface RyuScimPlugin extends ReturnType<typeof scim> {}

export function createRyuPasskeyPlugin(): RyuPasskeyPlugin {
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

export function createRyuScimPlugin(): RyuScimPlugin {
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
