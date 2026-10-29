import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { Member, Organization } from "@ryu/db/models/control-plane.model";
import { FamilyMembershipSlot } from "@ryu/db/models/family-membership-slot.model";
import {
	claimFamilyMembershipSlot,
	FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT,
} from "./family-membership-slots.ts";
import { userFamilyOrganizationIds } from "./family-sharing.ts";
import {
	organizationKindFromMetadata,
	promoteOrganizationToFamily,
	readOrganizationKind,
	reconcileOrganizationKindMetadata,
	revertFamilyOrganizationToPersonal,
} from "./organization-kind.ts";

/**
 * Persistence proof against a real Mongo (the replica set the API tests use):
 * the unique `(userId, slotIndex)` index is what keeps racing admissions under
 * the families-per-account cap, and the authoritative `organizationKind` field
 * is what survives a stale Better Auth metadata write. In-memory doubles cannot
 * show either, because both depend on the server's write semantics.
 *
 * Opt-in like the other native-Mongo proofs (CI's JS job has no Mongo): set
 * `RYU_AUTH_MONGODB_PROOF_URI`, for example
 * `mongodb://127.0.0.1:27019/ryu_auth_family_slots_persistence_proof`. The
 * database is dropped before and after the run.
 */

const proofUri = process.env.RYU_AUTH_MONGODB_PROOF_URI;
/** The Mongoose instance `@ryu/db` registers its models on (not a direct dependency here). */
const mongoose = Organization.base;

let nextId = 1;
function objectId(): string {
	nextId += 1;
	return `64c${String(nextId).padStart(21, "0")}`;
}

async function seedOrganization(
	kind: "family" | "personal",
	ownerId: string
): Promise<string> {
	const organizationId = objectId();
	await Organization.collection.insertOne({
		_id: new mongoose.Types.ObjectId(organizationId),
		metadata: JSON.stringify({ organizationKind: kind, source: "signup" }),
		name: `Org ${organizationId.slice(-3)}`,
	});
	await addMember(organizationId, ownerId, "owner");
	return organizationId;
}

async function addMember(
	organizationId: string,
	userId: string,
	role = "member"
): Promise<void> {
	await Member.collection.insertOne({
		_id: new mongoose.Types.ObjectId(),
		createdAt: new Date(),
		organizationId: new mongoose.Types.ObjectId(organizationId),
		role,
		userId: new mongoose.Types.ObjectId(userId),
	});
}

/** A person already in `count` families, none of which they own. */
async function personInFamilies(count: number): Promise<string> {
	const userId = objectId();
	for (let index = 0; index < count; index += 1) {
		await addMember(await seedOrganization("family", objectId()), userId);
	}
	return userId;
}

const claim = (userId: string, organizationId: string) =>
	claimFamilyMembershipSlot({
		listFamilyOrganizationIds: userFamilyOrganizationIds,
		organizationId,
		userId,
	});

const slotsOf = (userId: string) =>
	FamilyMembershipSlot.find({ userId })
		.lean<Array<{ organizationId: string; slotIndex: number; state: string }>>()
		.exec();

beforeAll(async () => {
	if (!proofUri) {
		return;
	}
	await mongoose.connect(proofUri, { serverSelectionTimeoutMS: 5000 });
	await mongoose.connection.dropDatabase();
	await FamilyMembershipSlot.init();
});

afterAll(async () => {
	if (!proofUri) {
		return;
	}
	await mongoose.connection.dropDatabase();
	await mongoose.disconnect();
});

beforeEach(async () => {
	if (proofUri) {
		await FamilyMembershipSlot.deleteMany({});
	}
});

describe.skipIf(!proofUri)("family membership places on a real Mongo", () => {
	it("lets only one of several concurrent admissions take the last place", async () => {
		const userId = await personInFamilies(
			FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT - 1
		);
		const targets = await Promise.all(
			[1, 2, 3].map(() => seedOrganization("family", objectId()))
		);

		const results = await Promise.all(
			targets.map((organizationId) => claim(userId, organizationId))
		);

		expect(results.filter(Boolean)).toHaveLength(1);
		const slots = await slotsOf(userId);
		expect(slots).toHaveLength(FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT);
		expect(new Set(slots.map((slot) => slot.slotIndex)).size).toBe(
			FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT
		);
		expect(slots.filter((slot) => slot.state === "reserved")).toHaveLength(1);
	});

	it("is idempotent for concurrent claims into the same family", async () => {
		const userId = await personInFamilies(2);
		const target = await seedOrganization("family", objectId());

		const results = await Promise.all([
			claim(userId, target),
			claim(userId, target),
			claim(userId, target),
		]);

		expect(results).toEqual([true, true, true]);
		const slots = await slotsOf(userId);
		expect(slots.filter((slot) => slot.organizationId === target)).toHaveLength(
			1
		);
		expect(slots).toHaveLength(3);
	});

	it("counts memberships that predate the places and refuses past the cap", async () => {
		const userId = await personInFamilies(
			FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT
		);
		const target = await seedOrganization("family", objectId());

		expect(await claim(userId, target)).toBe(false);
		const slots = await slotsOf(userId);
		expect(slots).toHaveLength(FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT);
		expect(slots.every((slot) => slot.state === "member")).toBe(true);
	});

	it("re-admits into a family the person is already in without a free place", async () => {
		const userId = objectId();
		const families: string[] = [];
		for (
			let index = 0;
			index < FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT;
			index += 1
		) {
			const organizationId = await seedOrganization("family", objectId());
			await addMember(organizationId, userId);
			families.push(organizationId);
		}
		expect(await claim(userId, families[0] ?? "")).toBe(true);
	});

	it("reconciles a confirmed place whose membership ended without a release", async () => {
		const userId = await personInFamilies(
			FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT - 1
		);
		const left = await seedOrganization("family", objectId());
		await FamilyMembershipSlot.create({
			expiresAt: null,
			organizationId: left,
			slotIndex: 4,
			state: "member",
			userId,
		});
		const target = await seedOrganization("family", objectId());

		expect(await claim(userId, target)).toBe(true);
		const slots = await slotsOf(userId);
		expect(slots.some((slot) => slot.organizationId === left)).toBe(false);
		expect(slots).toHaveLength(FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT);
	});

	it("does not let an expired, unconfirmed claim hold a place", async () => {
		const userId = await personInFamilies(
			FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT - 1
		);
		const abandoned = await seedOrganization("family", objectId());
		await FamilyMembershipSlot.create({
			expiresAt: new Date(Date.now() - 1000),
			organizationId: abandoned,
			slotIndex: 0,
			state: "reserved",
			userId,
		});
		const target = await seedOrganization("family", objectId());

		expect(await claim(userId, target)).toBe(true);
		const slots = await slotsOf(userId);
		expect(slots.some((slot) => slot.organizationId === abandoned)).toBe(false);
		expect(slots.some((slot) => slot.organizationId === target)).toBe(true);
	});

	it("lets an owner's enable and an accept elsewhere race for the last place", async () => {
		const ownerId = await personInFamilies(
			FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT - 1
		);
		const own = await seedOrganization("personal", ownerId);
		const elsewhere = await seedOrganization("family", objectId());

		const [enabled, accepted] = await Promise.all([
			promoteOrganizationToFamily(own),
			claim(ownerId, elsewhere),
		]);

		expect([enabled, accepted].filter(Boolean)).toHaveLength(1);
		expect(await readOrganizationKind(own)).toBe(
			enabled ? "family" : "personal"
		);
		expect(await slotsOf(ownerId)).toHaveLength(
			FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT
		);
	});

	it("frees the owner's place when sharing is turned off", async () => {
		const ownerId = objectId();
		const own = await seedOrganization("personal", ownerId);
		expect(await promoteOrganizationToFamily(own)).toBe(true);
		expect(await slotsOf(ownerId)).toEqual([
			expect.objectContaining({ organizationId: own, state: "member" }),
		]);
		expect(await revertFamilyOrganizationToPersonal(own)).toBe(true);
		expect(await slotsOf(ownerId)).toEqual([]);
	});
});

describe.skipIf(!proofUri)(
	"the authoritative organization kind on a real Mongo",
	() => {
		it("survives a Better Auth update that writes back metadata read before an enable", async () => {
			const ownerId = objectId();
			const own = await seedOrganization("personal", ownerId);
			// Better Auth's update reads the org (beforeUpdateOrganization merges
			// that metadata) ...
			const staleRead = await Organization.collection.findOne({
				_id: new mongoose.Types.ObjectId(own),
			});
			const staleMetadata = JSON.stringify({
				...JSON.parse(String(staleRead?.metadata)),
				description: "renamed",
			});
			// ... the owner turns family sharing on in between ...
			expect(await promoteOrganizationToFamily(own)).toBe(true);
			// ... and the adapter then `$set`s the whole stale metadata string.
			await Organization.collection.updateOne(
				{ _id: new mongoose.Types.ObjectId(own) },
				{ $set: { metadata: staleMetadata, name: "Renamed" } }
			);

			expect(await readOrganizationKind(own)).toBe("family");
			expect(await userFamilyOrganizationIds(ownerId)).toEqual([own]);

			// The update after-hook restores the metadata kind and keeps the update.
			expect(await reconcileOrganizationKindMetadata(own)).toBe(true);
			const repaired = await Organization.collection.findOne({
				_id: new mongoose.Types.ObjectId(own),
			});
			expect(organizationKindFromMetadata(repaired?.metadata)).toBe("family");
			expect(JSON.parse(String(repaired?.metadata)).description).toBe(
				"renamed"
			);
			expect(repaired?.name).toBe("Renamed");
			expect(repaired?.organizationKind).toBe("family");
		});

		it("keeps a disable that a stale update tried to undo", async () => {
			const ownerId = objectId();
			const own = await seedOrganization("personal", ownerId);
			expect(await promoteOrganizationToFamily(own)).toBe(true);
			const staleRead = await Organization.collection.findOne({
				_id: new mongoose.Types.ObjectId(own),
			});
			expect(await revertFamilyOrganizationToPersonal(own)).toBe(true);
			await Organization.collection.updateOne(
				{ _id: new mongoose.Types.ObjectId(own) },
				{ $set: { metadata: staleRead?.metadata } }
			);

			expect(await readOrganizationKind(own)).toBe("personal");
			// Admission sees a personal workspace, so the stale family metadata
			// cannot reopen it to new members.
			expect(await userFamilyOrganizationIds(ownerId)).toEqual([]);
			expect(await reconcileOrganizationKindMetadata(own)).toBe(true);
			const repaired = await Organization.collection.findOne({
				_id: new mongoose.Types.ObjectId(own),
			});
			expect(organizationKindFromMetadata(repaired?.metadata)).toBe("personal");
		});
	}
);
