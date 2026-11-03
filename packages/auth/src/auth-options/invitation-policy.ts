import {
	defineRequestState,
	type getCurrentAuthContext,
	hasRequestState,
} from "@better-auth/core/context";
import { OrganizationInvitationPolicy } from "@ryu/db/models/organization-invitation-policy.model";
import { APIError } from "better-auth/api";
import { z } from "zod";
import {
	normalizeInvitationEmail,
	ORGANIZATION_INVITATION_COOLDOWN_MS,
} from "../lib/organization-invitation-policy.ts";

import {
	DUPLICATE_KEY_ERROR_CODE,
	type organizationHookBodySchema,
} from "./schemas.ts";

// Per-organization invitation policy reservations and the request state that
// tracks invitations while Better Auth writes them.

// Better Auth's API-key plugin asks the organization access-control layer for
// `apiKey` permissions when it manages organization-owned keys. Keep that
// native management capability separate from Ryu's API-key scope vocabulary:
// org membership may manage the key record, but it never grants the key any
// Ryu capability by itself. The control-plane route still supplies the
// role-clamped Ryu statements at creation time.
export const isDuplicateKeyError = z
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

export async function reserveOrganizationInvitationPolicy(input: {
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
export async function releaseOrganizationInvitationPolicy(
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
export interface InvitationBeingCreated {
	email: string;
	organizationId: string;
	policy: InvitationPolicyReservation;
}

export const invitationsBeingCreated = defineRequestState(
	() => new Map<string, InvitationBeingCreated>()
);

export const invitationCreationKey = (organizationId: string, email: string) =>
	`${organizationId}:${normalizeInvitationEmail(email)}`;

/** Take the reservations made for this invitation, if this request made them. */
export async function takeInvitationBeingCreated(invitation: {
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
export const invitationsBeforeResend = defineRequestState(
	() => new Map<string, Date>()
);

export type AuthAdapter = Awaited<
	ReturnType<typeof getCurrentAuthContext>
>["context"]["adapter"];

/**
 * Record a resend's pending invitation before Better Auth changes it. Only for
 * a request that carries a session (the endpoint authorizes it next), and only
 * in the named organization: one recipient can hold pending invitations from
 * many organizations.
 */
export async function rememberInvitationsBeforeResend(
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
