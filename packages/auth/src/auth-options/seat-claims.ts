import { Member } from "@ryu/db/models/control-plane.model";
import { OrganizationSeatReservation } from "@ryu/db/models/organization-seat-reservation.model";
import { APIError } from "better-auth/api";
import { decideSeatAdmission } from "../lib/organization-seat-gate.ts";

import { isDuplicateKeyError } from "./invitation-policy.ts";
import {
	activeOrganizationSeatCapacity,
	directMemberClaimId,
	pendingInvitationClaimId,
	requireActiveOrganizationSeatCapacity,
	SEAT_CLAIM_TTL_MS,
} from "./seat-capacity.ts";

// Atomic seat claims for pending invitations and direct members.

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
	const { copy, seatCapacity } = await requireActiveOrganizationSeatCapacity(
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
		throw new APIError("FORBIDDEN", { message: copy.full });
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
				throw new APIError("FORBIDDEN", { message: copy.capacityChanged });
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
	throw new APIError("FORBIDDEN", { message: copy.full });
}

/**
 * Test seam for the real Mongo/Polar seat path (`index.family-seat.test.ts`).
 * Not a package API: production callers reach these only through the Better
 * Auth organization hooks below.
 */
export const organizationSeatPathForTests = {
	activeOrganizationSeatCapacity,
	reserveSeatClaim,
} as const;

/** Reserve the seat before Better Auth creates the pending invitation row. */
export async function reservePendingInvitationSeat(input: {
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
export async function reserveInvitationSeat(input: {
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

	const { seatCapacity } = await requireActiveOrganizationSeatCapacity(
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

export async function reserveDirectMemberSeat(input: {
	organizationId: string;
	userId: string;
}): Promise<void> {
	await reserveSeatClaim({
		claimId: directMemberClaimId(input.userId),
		kind: "direct_member",
		organizationId: input.organizationId,
	});
}
