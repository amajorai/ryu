import { defineRequestState, hasRequestState } from "@better-auth/core/context";
import type { OrganizationOptions } from "better-auth/plugins";
import { z } from "zod";
import type { encryptedMongoAdapter } from "../lib/sso-provider-encryption.ts";
import type {
	AuthAdapter,
	InvitationBeingCreated,
} from "./invitation-policy.ts";
import {
	invitationsBeforeResend,
	releaseOrganizationInvitationPolicy,
	takeInvitationBeingCreated,
} from "./invitation-policy.ts";
import {
	refreshResentInvitationSeat,
	releaseSeatClaims,
} from "./member-grants.ts";

// Invitation emails that could not be sent: recorded per request, then the
// invitation is withdrawn or restored so no unsent invite stays pending.

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
export async function takeUnsentInvitationEmail(
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
export function recordUnsentInvitationEmail(
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
export function releaseReservationsOfFailedInvitationWrites(
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
export type UnsentInvitationOutcome = "kept" | "settled" | "withdrawn";

/**
 * Remove a new invitation whose email was not sent, then give back its seat
 * claim and 24-hour cooldown, so nothing is left that looks pending or blocks
 * the owner from sending it again. Nothing is given back unless exactly that
 * pending invitation was removed.
 */
export async function withdrawUnsentInvitation(
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
export const returnedInvitationId = (returned: unknown): string | null => {
	const parsed = z.object({ id: z.string().min(1) }).safeParse(returned);
	return parsed.success ? parsed.data.id : null;
};

/**
 * Put back the expiry a resend stored when its email was not sent. Without the
 * earlier expiry, keep the seat claim on the stored one instead.
 */
export async function restoreInvitationAfterUnsentResend(
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
