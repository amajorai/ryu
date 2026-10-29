import {
	EmailAddressReservation,
	EmailAlias,
	EmailWebhook,
	Inbox,
} from "@ryu/db/models/email.model";

/** The revoke and orphan reason recorded when an organization is deleted. */
export const ORGANIZATION_DELETED_REASON = "organization_deleted";

/**
 * Retire a deleted organization's hosted mail. Nothing is deleted: every
 * address the organization ever claimed stays reserved forever, so none of
 * them can be reissued to anyone. This only stops the mail:
 *
 * - every inbox is disabled, so it neither receives nor sends;
 * - every live (active or pending) alias is revoked with reason
 *   `organization_deleted`, freeing its agent key and quota slot, with no
 *   reinstate window;
 * - every reservation of `org:<id>` becomes `orphaned`, so inbound to any of
 *   its addresses is dropped;
 * - every webhook is disabled.
 *
 * Permanence never depends on this running: the reservations already exist.
 * It is idempotent, so a retried deletion hook changes nothing twice.
 */
export async function retireOrganizationMail(
	organizationId: string,
	now: Date = new Date()
): Promise<{
	inboxes: number;
	aliases: number;
	reservations: number;
	webhooks: number;
}> {
	if (!organizationId) {
		throw new Error("retireOrganizationMail requires an organization id");
	}
	const inboxes = await Inbox.updateMany(
		{ organizationId, enabled: true },
		{ $set: { enabled: false, updatedAt: now } }
	);
	const aliases = await EmailAlias.updateMany(
		{ organizationId, status: { $in: ["active", "pending"] } },
		{
			$set: {
				status: "revoked",
				revokedAt: now,
				revokedBy: null,
				revokeReason: ORGANIZATION_DELETED_REASON,
				reinstatableUntil: null,
				pendingExpiresAt: null,
				liveAgentKey: null,
				aliasSlot: null,
				updatedAt: now,
			},
		}
	);
	const reservations = await EmailAddressReservation.updateMany(
		{ ownerKey: `org:${organizationId}`, state: "live" },
		{
			$set: {
				state: "orphaned",
				orphanedAt: now,
				orphanReason: ORGANIZATION_DELETED_REASON,
			},
		}
	);
	const webhooks = await EmailWebhook.updateMany(
		{ organizationId, enabled: true },
		{ $set: { enabled: false, updatedAt: now } }
	);
	return {
		inboxes: inboxes.modifiedCount,
		aliases: aliases.modifiedCount,
		reservations: reservations.modifiedCount,
		webhooks: webhooks.modifiedCount,
	};
}
