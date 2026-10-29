import { FamilyMembershipSlot } from "@ryu/db/models/family-membership-slot.model";
import { isDuplicateKeyError } from "@ryu/db/native-duplicate-key";

/**
 * Family orgs one account may belong to, owned and joined together (for
 * example an immediate family and a cousins' family). An account still OWNS at
 * most one: its own personal workspace promoted in place. Re-exported by
 * `family-sharing.ts`, which is where callers import it from.
 */
export const FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT = 5;

/**
 * How long an unconfirmed claim holds a place. It only has to outlive one
 * Better Auth admission request (before hook, member write, after hook); a
 * request that dies in between frees the place when it expires.
 */
export const FAMILY_MEMBERSHIP_SLOT_TTL_MS = 2 * 60 * 1000;

/** Retries of one index after removing an expired claim that still held it. */
const EXPIRED_HOLDER_RETRIES = 3;

interface SlotRow {
	_id: string;
	expiresAt?: Date | null;
	organizationId: string;
	slotIndex: number;
	state: "member" | "reserved";
}

interface SlotKey {
	organizationId: string;
	userId: string;
}

/** A confirmed membership always holds its place; a claim until it expires. */
function isLive(slot: SlotRow, now: Date): boolean {
	return (
		slot.state === "member" ||
		(slot.expiresAt instanceof Date && slot.expiresAt > now)
	);
}

/**
 * Insert one place for `organizationId` at the lowest free index below
 * `limit`. The unique `(userId, slotIndex)` index is the authority: a racing
 * claim that took the same index makes this one move on, and a racing claim
 * for the same family makes this one reuse that row. Returns false when every
 * index is held.
 */
async function insertSlot(input: {
	expiresAt: Date | null;
	limit: number;
	organizationId: string;
	state: SlotRow["state"];
	used: Set<number>;
	userId: string;
}): Promise<boolean> {
	let expiredHolderRetries = EXPIRED_HOLDER_RETRIES;
	for (let slotIndex = 0; slotIndex < input.limit; slotIndex += 1) {
		if (input.used.has(slotIndex)) {
			continue;
		}
		try {
			await FamilyMembershipSlot.create({
				expiresAt: input.expiresAt,
				organizationId: input.organizationId,
				slotIndex,
				state: input.state,
				userId: input.userId,
			});
			input.used.add(slotIndex);
			return true;
		} catch (error) {
			if (!isDuplicateKeyError(error)) {
				throw error;
			}
		}
		const now = new Date();
		const sameFamily = await FamilyMembershipSlot.findOne({
			organizationId: input.organizationId,
			userId: input.userId,
		}).lean<SlotRow>();
		if (sameFamily && isLive(sameFamily, now)) {
			// A concurrent admission into the same family (a retried accept) or a
			// reconcile already holds it; one place per family either way.
			input.used.add(sameFamily.slotIndex);
			return true;
		}
		const holder = await FamilyMembershipSlot.findOne({
			slotIndex,
			userId: input.userId,
		}).lean<SlotRow>();
		if (holder && !isLive(holder, now) && expiredHolderRetries > 0) {
			// Mongo's TTL monitor is eventually consistent: an expired claim can
			// still own the index. Remove exactly that row and retry the index.
			expiredHolderRetries -= 1;
			await FamilyMembershipSlot.deleteOne({
				_id: holder._id,
				expiresAt: holder.expiresAt ?? null,
				state: "reserved",
			});
			slotIndex -= 1;
			continue;
		}
		input.used.add(slotIndex);
	}
	return false;
}

/**
 * Claim one of `userId`'s family places for `organizationId` before they are
 * admitted into it (an accepted invitation, a direct add, or an owner turning
 * sharing on). Returns false when the person already holds `limit` places, so
 * concurrent admissions into different families cannot together exceed the
 * cap. Idempotent for the same family.
 *
 * The claim first reconciles the person's places against
 * `listFamilyOrganizationIds` (every family org they are a member of now):
 *
 * - a confirmed place for a family they are no longer in, or that is no longer
 *   a family, is released (a removal path that skipped the release);
 * - an expired, unconfirmed claim is released;
 * - a family membership with no place (it predates this collection, or its
 *   confirmation was lost) is given one, so it counts against the cap.
 *
 * Places are read before memberships: a place is only confirmed after its
 * member row exists, so a confirmed place missing from the later membership
 * read really has ended.
 */
export async function claimFamilyMembershipSlot(input: {
	limit?: number;
	listFamilyOrganizationIds: (userId: string) => Promise<readonly string[]>;
	organizationId: string;
	userId: string;
}): Promise<boolean> {
	const limit = input.limit ?? FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT;
	const now = new Date();
	const slots = await FamilyMembershipSlot.find({ userId: input.userId })
		.select("_id expiresAt organizationId slotIndex state")
		.lean<SlotRow[]>();
	const familyIds = new Set(
		await input.listFamilyOrganizationIds(input.userId)
	);

	const used = new Set<number>();
	const held = new Map<string, SlotRow>();
	for (const slot of slots) {
		const stale =
			slot.state === "member"
				? !familyIds.has(slot.organizationId)
				: !isLive(slot, now);
		if (stale) {
			await FamilyMembershipSlot.deleteOne({
				_id: slot._id,
				expiresAt: slot.expiresAt ?? null,
				state: slot.state,
			});
			continue;
		}
		used.add(slot.slotIndex);
		held.set(slot.organizationId, slot);
	}
	for (const familyId of familyIds) {
		const slot = held.get(familyId);
		if (slot?.state === "reserved") {
			// The member row exists but its confirmation was lost: keep the place.
			await FamilyMembershipSlot.updateOne(
				{ _id: slot._id, state: "reserved" },
				{ $set: { expiresAt: null, state: "member" } }
			);
		}
		if (!slot) {
			// Best effort: a person already past the cap (memberships that predate
			// this collection) finds no free index here, and the claim below then
			// refuses them too.
			await insertSlot({
				expiresAt: null,
				limit,
				organizationId: familyId,
				state: "member",
				used,
				userId: input.userId,
			});
		}
	}
	if (familyIds.has(input.organizationId)) {
		// Already a member: re-admission never trips the cap.
		return true;
	}

	const expiresAt = new Date(now.getTime() + FAMILY_MEMBERSHIP_SLOT_TTL_MS);
	const own = held.get(input.organizationId);
	if (own) {
		if (own.state === "reserved") {
			await FamilyMembershipSlot.updateOne(
				{ _id: own._id, state: "reserved" },
				{ $set: { expiresAt } }
			);
		}
		return true;
	}
	return await insertSlot({
		expiresAt,
		limit,
		organizationId: input.organizationId,
		state: "reserved",
		used,
		userId: input.userId,
	});
}

/** Confirm a claimed place once the member row exists; it no longer expires. */
export async function confirmFamilyMembershipSlot(
	input: SlotKey
): Promise<void> {
	await FamilyMembershipSlot.updateOne(
		{ organizationId: input.organizationId, userId: input.userId },
		{ $set: { expiresAt: null, state: "member" } }
	);
}

/**
 * Whether `userId` holds (or held, until the TTL monitor runs) a place in
 * `organizationId`: the marker that an admission went through the family path.
 */
export async function familyMembershipSlotExists(
	input: SlotKey
): Promise<boolean> {
	return Boolean(
		await FamilyMembershipSlot.exists({
			organizationId: input.organizationId,
			userId: input.userId,
		})
	);
}

/**
 * Release `userId`'s place in `organizationId`. `reservedOnly` leaves a
 * confirmed membership's place alone (an invitation rejected or cancelled while
 * the person is somehow already a member).
 */
export async function releaseFamilyMembershipSlot(
	input: SlotKey & { reservedOnly?: boolean }
): Promise<void> {
	await FamilyMembershipSlot.deleteOne({
		organizationId: input.organizationId,
		userId: input.userId,
		...(input.reservedOnly ? { state: "reserved" } : {}),
	});
}

/**
 * Release the places held in one org: every place when it is deleted, or only
 * confirmed ones when family sharing is turned off. The revert keeps in-flight
 * claims so the after-hook compensation of an admission that raced the revert
 * still sees that it came through the family path.
 */
export async function releaseFamilyMembershipSlotsForOrganization(
	organizationId: string,
	options: { confirmedOnly?: boolean } = {}
): Promise<void> {
	await FamilyMembershipSlot.deleteMany({
		organizationId,
		...(options.confirmedOnly ? { state: "member" } : {}),
	});
}
