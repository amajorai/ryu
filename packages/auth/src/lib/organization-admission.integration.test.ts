import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";
import {
	FAMILY_ROLE_REFUSED_MESSAGE,
	organizationSeatCopy,
} from "./family-admission.ts";
import {
	FAMILY_SHARING_FULL_MESSAGE,
	FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT,
	FAMILY_SHARING_MAX_MEMBERS,
	FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE,
	FAMILY_SHARING_NOT_ELIGIBLE_MESSAGE,
	FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE,
	FAMILY_SHARING_SELF_TURNED_OFF_MESSAGE,
	familySharingCapacity,
	registerFamilySharingCapacityResolver,
} from "./family-sharing.ts";
import {
	createOrganizationAdmission,
	PERSONAL_WORKSPACE_MESSAGE,
} from "./organization-admission.ts";
import {
	FAMILY_ORGANIZATION_KIND,
	organizationKindFromMetadata,
} from "./organization-kind.ts";
import { decideSeatAdmission } from "./organization-seat-gate.ts";

/**
 * Family-sharing admission through Better Auth's real organization endpoints
 * and the memory adapter: the hook bodies from `organization-admission.ts`
 * wired the way `index.ts` wires them, with an in-memory seat-claim store in
 * place of the Mongo `OrganizationSeatReservation` collection and Polar.
 */

type Database = Pick<
	AuthFixtureDatabase,
	| "account"
	| "invitation"
	| "member"
	| "organization"
	| "session"
	| "user"
	| "verification"
>;

const database: Database = {
	account: [],
	invitation: [],
	member: [],
	organization: [],
	session: [],
	user: [],
	verification: [],
};

const FAMILY = "family-org";
const SECOND_FAMILY = "second-family-org";
const THIRD_FAMILY = "third-family-org";
const INELIGIBLE_FAMILY = "ineligible-family-org";
const PERSONAL = "personal-org";
const TEAMS = "teams-org";
const TEAMS_SEATS = 5;

/** Families whose owner has Max and the rollout flag on (the API's decision). */
const eligibleFamilies = new Set([FAMILY, SECOND_FAMILY, THIRD_FAMILY]);
/** claimId -> organizationId: pending and accepting seat reservations. */
const seatClaims = new Map<string, string>();
/**
 * `${userId}:${organizationId}` -> state: the in-memory counterpart of the
 * Mongo `FamilyMembershipSlot` places (`family-membership-slots.ts`).
 */
const familyPlaces = new Map<string, "member" | "reserved">();
const placeKey = (place: { organizationId: string; userId: string }) =>
	`${place.userId}:${place.organizationId}`;
/**
 * Holds the families-per-account READ for the armed user until `size` reads
 * are waiting, so racing accepts provably all pass the read and only the
 * place claim can stop them.
 */
let readBarrier: {
	size: number;
	userId: string;
	waiting: Array<() => void>;
} | null = null;
/** Runs after the accept before-hook passed and before Better Auth writes. */
let afterAcceptChecks: ((organizationId: string) => void) | null = null;

const kindOf = (organizationId: string) =>
	organizationKindFromMetadata(
		database.organization.find((org) => org.id === organizationId)?.metadata
	);
const familyIdsFor = (userId: string) =>
	database.member
		.filter(
			(member) =>
				member.userId === userId &&
				kindOf(member.organizationId) === FAMILY_ORGANIZATION_KIND
		)
		.map((member) => member.organizationId);
const memberCount = (organizationId: string) =>
	database.member.filter((member) => member.organizationId === organizationId)
		.length;
const pendingClaimId = (organizationId: string, email: string) =>
	`pending:${organizationId}:${email.trim().toLowerCase()}`;

async function seatCapacity(organizationId: string): Promise<number | null> {
	return kindOf(organizationId) === FAMILY_ORGANIZATION_KIND
		? await familySharingCapacity(organizationId)
		: TEAMS_SEATS;
}

/** The in-memory counterpart of `reserveSeatClaim` in `index.ts`. */
async function reserveSeat(organizationId: string, claimId: string) {
	const copy = organizationSeatCopy(kindOf(organizationId));
	const capacity = await seatCapacity(organizationId);
	if (capacity === null) {
		throw new APIError("FORBIDDEN", { message: copy.noCapacity });
	}
	const reserved = [...seatClaims.values()].filter(
		(claimOrganizationId) => claimOrganizationId === organizationId
	).length;
	const decision = decideSeatAdmission({
		billedSeats: capacity,
		memberCount: memberCount(organizationId),
		reservedSeatCount: reserved,
	});
	if (!decision.allowed) {
		throw new APIError("FORBIDDEN", { message: copy.full });
	}
	seatClaims.set(claimId, organizationId);
}

const admission = createOrganizationAdmission({
	activeSeatCapacity: seatCapacity,
	// Same contract as `claimFamilyMembershipSlot`: places held plus
	// memberships that have none, against the cap, with no await between the
	// check and the write (Mongo's unique index plays that part).
	claimFamilyPlace: async (place) => {
		const held = new Set(familyIdsFor(place.userId));
		for (const key of familyPlaces.keys()) {
			if (key.startsWith(`${place.userId}:`)) {
				held.add(key.slice(place.userId.length + 1));
			}
		}
		if (held.has(place.organizationId)) {
			return true;
		}
		if (held.size >= FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT) {
			return false;
		}
		familyPlaces.set(placeKey(place), "reserved");
		return true;
	},
	confirmFamilyPlace: async (place) => {
		familyPlaces.set(placeKey(place), "member");
	},
	countMembers: async (organizationId) => memberCount(organizationId),
	familyOrganizationIdsForUser: async (userId, { excludeOrganizationId }) => {
		const barrier = readBarrier;
		if (barrier?.userId === userId) {
			await new Promise<void>((resolve) => {
				barrier.waiting.push(resolve);
				if (barrier.waiting.length >= barrier.size) {
					for (const release of barrier.waiting) {
						release();
					}
				}
			});
		}
		return familyIdsFor(userId).filter(
			(organizationId) => organizationId !== excludeOrganizationId
		);
	},
	findUserIdByEmail: async (email) =>
		database.user.find((user) => user.email === email)?.id ?? null,
	hasFamilyPlace: async (place) => familyPlaces.has(placeKey(place)),
	readOrganizationKind: async (organizationId) => kindOf(organizationId),
	releaseFamilyPlace: async ({ reservedOnly, ...place }) => {
		if (!reservedOnly || familyPlaces.get(placeKey(place)) === "reserved") {
			familyPlaces.delete(placeKey(place));
		}
	},
	releaseSeatClaims: async ({ email, invitationId, organizationId }) => {
		if (email) {
			seatClaims.delete(pendingClaimId(organizationId, email));
		}
		if (invitationId) {
			seatClaims.delete(invitationId);
		}
	},
	removeMember: async ({ memberId }) => {
		const index = database.member.findIndex((member) => member.id === memberId);
		if (index >= 0) {
			database.member.splice(index, 1);
		}
	},
	reserveDirectMemberSeat: async ({ organizationId, userId }) =>
		reserveSeat(organizationId, `direct:${userId}`),
	reserveInvitationPolicy: async () => undefined,
	reserveInvitationSeat: async ({ email, invitationId, organizationId }) => {
		const pending = pendingClaimId(organizationId, email);
		if (seatClaims.has(pending)) {
			seatClaims.delete(pending);
			seatClaims.set(invitationId, organizationId);
			return;
		}
		await reserveSeat(organizationId, invitationId);
	},
	reservePendingInvitationSeat: async ({ email, organizationId }) =>
		reserveSeat(organizationId, pendingClaimId(organizationId, email)),
	resolveOrganizationKind: async (organizationId, metadata) =>
		organizationKindFromMetadata(metadata ?? null) ?? kindOf(organizationId),
});

const auth = betterAuth({
	baseURL: "http://localhost:3000",
	secret: "family-admission-".repeat(3),
	database: memoryAdapter(database),
	emailAndPassword: { enabled: true },
	plugins: [
		organization({
			requireEmailVerificationOnInvitation: true,
			organizationHooks: {
				beforeAddMember: async (data) => {
					await admission.beforeAddMember(data);
				},
				afterAddMember: async ({ member }) => {
					await admission.afterMemberAdmitted({
						actor: "other",
						memberId: member.id,
						organizationId: member.organizationId,
						userId: member.userId,
					});
				},
				beforeCreateInvitation: async ({ invitation, inviter }) =>
					await admission.beforeCreateInvitation({ invitation, inviter }),
				beforeAcceptInvitation: async ({ invitation, user }) => {
					await admission.beforeAcceptInvitation({ invitation, user });
					afterAcceptChecks?.(invitation.organizationId);
				},
				afterAcceptInvitation: async ({ invitation, member }) => {
					seatClaims.delete(invitation.id);
					seatClaims.delete(
						pendingClaimId(invitation.organizationId, invitation.email)
					);
					await admission.afterMemberAdmitted({
						actor: "self",
						memberId: member.id,
						organizationId: invitation.organizationId,
						userId: member.userId,
					});
				},
			},
		}),
	],
});

const cookies = new Map<string, string>();

async function signUp(email: string): Promise<string> {
	const response = await auth.api.signUpEmail({
		body: { email, name: email, password: ["synthetic", "1234"].join("-") },
		asResponse: true,
	});
	cookies.set(
		email,
		response.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ")
	);
	const user = database.user.find((row) => row.email === email);
	if (!user) {
		throw new Error(`Missing synthetic user ${email}`);
	}
	user.emailVerified = true;
	return user.id;
}

function seedOrganization(input: {
	id: string;
	kind: "family" | "personal" | "teams";
	ownerId: string;
}) {
	database.organization.push({
		createdAt: new Date(),
		id: input.id,
		metadata: JSON.stringify({ organizationKind: input.kind }),
		name: input.id,
		slug: input.id,
	});
	database.member.push({
		createdAt: new Date(),
		id: `${input.id}-owner`,
		organizationId: input.id,
		role: "owner",
		userId: input.ownerId,
	});
}

async function post(path: string, actorEmail: string, body: object) {
	const response = await auth.handler(
		new Request(`http://localhost:3000/api/auth${path}`, {
			body: JSON.stringify(body),
			headers: {
				"content-type": "application/json",
				cookie: cookies.get(actorEmail) ?? "",
				origin: "http://localhost:3000",
			},
			method: "POST",
		})
	);
	const payload: unknown = await response.json().catch(() => null);
	const message =
		payload && typeof payload === "object" && "message" in payload
			? String(payload.message)
			: null;
	return { message, payload, status: response.status };
}

const invite = (organizationId: string, inviter: string, email: string) =>
	post("/organization/invite-member", inviter, {
		email,
		organizationId,
		role: "member",
	});

async function acceptInvitation(organizationId: string, email: string) {
	const invitation = database.invitation.find(
		(row) =>
			row.organizationId === organizationId &&
			row.email === email &&
			row.status === "pending"
	);
	if (!invitation) {
		throw new Error(`Missing invitation for ${email}`);
	}
	return await post("/organization/accept-invitation", email, {
		invitationId: invitation.id,
	});
}

beforeAll(async () => {
	registerFamilySharingCapacityResolver(async (organizationId) =>
		eligibleFamilies.has(organizationId) ? FAMILY_SHARING_MAX_MEMBERS : null
	);
	seedOrganization({
		id: FAMILY,
		kind: "family",
		ownerId: await signUp("parent@gmail.com"),
	});
	seedOrganization({
		id: SECOND_FAMILY,
		kind: "family",
		ownerId: await signUp("other-parent@icloud.com"),
	});
	seedOrganization({
		id: THIRD_FAMILY,
		kind: "family",
		ownerId: await signUp("aunt@gmail.com"),
	});
	seedOrganization({
		id: INELIGIBLE_FAMILY,
		kind: "family",
		ownerId: await signUp("lapsed-parent@gmail.com"),
	});
	seedOrganization({
		id: PERSONAL,
		kind: "personal",
		ownerId: await signUp("solo@gmail.com"),
	});
	seedOrganization({
		id: TEAMS,
		kind: "teams",
		ownerId: await signUp("lead@acme.example"),
	});
	await signUp("kid@gmail.com");
}, 60_000);

describe("family sharing admission through Better Auth", () => {
	it("invites and admits a Gmail member into a family", async () => {
		const invited = await invite(FAMILY, "parent@gmail.com", "kid@gmail.com");
		expect(invited.status).toBe(200);
		expect(seatClaims.get(pendingClaimId(FAMILY, "kid@gmail.com"))).toBe(
			FAMILY
		);

		const accepted = await acceptInvitation(FAMILY, "kid@gmail.com");
		expect(accepted.status).toBe(200);
		expect(memberCount(FAMILY)).toBe(2);
		expect(
			[...seatClaims.values()].filter((orgId) => orgId === FAMILY)
		).toHaveLength(0);
	});

	it("counts pending invitations and refuses the seventh person", async () => {
		// Owner and kid are members; four pending invitations fill six places.
		for (const email of [
			"a@gmail.com",
			"b@gmail.com",
			"c@icloud.com",
			"d@outlook.com",
		]) {
			expect((await invite(FAMILY, "parent@gmail.com", email)).status).toBe(
				200
			);
		}
		const seventh = await invite(FAMILY, "parent@gmail.com", "e@gmail.com");
		expect(seventh.status).toBe(403);
		expect(seventh.message).toBe(FAMILY_SHARING_FULL_MESSAGE);
		expect(database.invitation.some((row) => row.email === "e@gmail.com")).toBe(
			false
		);
	});

	it("admits a person into more families up to the per-account cap", async () => {
		const kidId = String(
			database.user.find((user) => user.email === "kid@gmail.com")?.id
		);
		// The kid is in FAMILY; three more seeded families make four, so THIRD_FAMILY
		// is their fifth.
		for (const id of ["cousins-1", "cousins-2", "cousins-3"]) {
			seedOrganization({ id, kind: "family", ownerId: `${id}-owner` });
			database.member.push({
				createdAt: new Date(),
				id: `${id}-kid`,
				organizationId: id,
				role: "member",
				userId: kidId,
			});
		}
		const invited = await invite(
			THIRD_FAMILY,
			"aunt@gmail.com",
			"kid@gmail.com"
		);
		expect(invited.status).toBe(200);
		const accepted = await acceptInvitation(THIRD_FAMILY, "kid@gmail.com");
		expect(accepted.status).toBe(200);
		expect(
			database.member.filter(
				(member) =>
					member.userId === kidId &&
					kindOf(member.organizationId) === FAMILY_ORGANIZATION_KIND
			)
		).toHaveLength(FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT);
	});

	it("refuses a sixth family at invitation and at acceptance", async () => {
		const invited = await invite(
			SECOND_FAMILY,
			"other-parent@icloud.com",
			"kid@gmail.com"
		);
		expect(invited.status).toBe(403);
		expect(invited.message).toBe(FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE);

		// An invitation that predates the kid reaching the cap is still refused
		// when they try to accept it.
		database.invitation.push({
			createdAt: new Date(),
			email: "kid@gmail.com",
			expiresAt: new Date(Date.now() + 86_400_000),
			id: "stale-second-family-invitation",
			inviterId: String(
				database.user.find((user) => user.email === "other-parent@icloud.com")
					?.id
			),
			organizationId: SECOND_FAMILY,
			role: "member",
			status: "pending",
		});
		const accepted = await acceptInvitation(SECOND_FAMILY, "kid@gmail.com");
		expect(accepted.status).toBe(403);
		expect(accepted.message).toBe(FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE);
		expect(
			database.member.some(
				(member) =>
					member.organizationId === SECOND_FAMILY &&
					member.userId ===
						database.user.find((user) => user.email === "kid@gmail.com")?.id
			)
		).toBe(false);
	});

	it("applies the same rules to a trusted direct add", async () => {
		const userIdFor = (email: string) =>
			String(database.user.find((user) => user.email === email)?.id);
		await expect(
			auth.api.addMember({
				body: {
					organizationId: SECOND_FAMILY,
					role: "member",
					userId: userIdFor("kid@gmail.com"),
				},
			})
		).rejects.toThrow(FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE);
		await expect(
			auth.api.addMember({
				body: {
					organizationId: SECOND_FAMILY,
					role: "owner",
					userId: userIdFor("solo@gmail.com"),
				},
			})
		).rejects.toThrow(FAMILY_ROLE_REFUSED_MESSAGE);
		await auth.api.addMember({
			body: {
				organizationId: SECOND_FAMILY,
				role: "admin",
				userId: userIdFor("solo@gmail.com"),
			},
		});
		expect(memberCount(SECOND_FAMILY)).toBe(2);
	});

	it("refuses invitations when the family is not eligible (no Max or flag off)", async () => {
		const invited = await invite(
			INELIGIBLE_FAMILY,
			"lapsed-parent@gmail.com",
			"cousin@gmail.com"
		);
		expect(invited.status).toBe(403);
		expect(invited.message).toBe(FAMILY_SHARING_NOT_ELIGIBLE_MESSAGE);
	});

	it("still refuses invitations into a personal workspace", async () => {
		const invited = await invite(
			PERSONAL,
			"solo@gmail.com",
			"friend@gmail.com"
		);
		expect(invited.status).toBe(400);
		expect(invited.message).toBe(PERSONAL_WORKSPACE_MESSAGE);
	});

	it("still requires a business email for a Teams invitation", async () => {
		const consumer = await invite(TEAMS, "lead@acme.example", "dev@gmail.com");
		expect(consumer.status).toBe(400);
		expect(consumer.message).toContain(
			"Teams invitations must use a company email address"
		);
		const business = await invite(
			TEAMS,
			"lead@acme.example",
			"dev@acme.example"
		);
		expect(business.status).toBe(200);
	});

	it("lets only one of two concurrent accepts take a person's fifth family", async () => {
		const racerId = await signUp("racer@gmail.com");
		for (const id of [
			"race-home-1",
			"race-home-2",
			"race-home-3",
			"race-home-4",
		]) {
			seedOrganization({ id, kind: "family", ownerId: `${id}-owner` });
			database.member.push({
				createdAt: new Date(),
				id: `${id}-racer`,
				organizationId: id,
				role: "member",
				userId: racerId,
			});
		}
		for (const id of ["race-a", "race-b"]) {
			seedOrganization({ id, kind: "family", ownerId: `${id}-owner` });
			eligibleFamilies.add(id);
			database.invitation.push({
				createdAt: new Date(),
				email: "racer@gmail.com",
				expiresAt: new Date(Date.now() + 86_400_000),
				id: `${id}-invitation`,
				inviterId: `${id}-owner`,
				organizationId: id,
				role: "member",
				status: "pending",
			});
		}
		// Both accepts pass the read check (four families) before either claims.
		readBarrier = { size: 2, userId: racerId, waiting: [] };
		try {
			const results = await Promise.all([
				acceptInvitation("race-a", "racer@gmail.com"),
				acceptInvitation("race-b", "racer@gmail.com"),
			]);
			expect(results.map((result) => result.status).toSorted()).toEqual([
				200, 403,
			]);
			expect(results.find((result) => result.status === 403)?.message).toBe(
				FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE
			);
		} finally {
			readBarrier = null;
		}
		expect(familyIdsFor(racerId)).toHaveLength(
			FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT
		);
	});

	it("undoes an accept that raced the owner turning family sharing off", async () => {
		const lateId = await signUp("late@gmail.com");
		seedOrganization({
			id: "toggle-family",
			kind: "family",
			ownerId: "toggle-owner",
		});
		eligibleFamilies.add("toggle-family");
		database.invitation.push({
			createdAt: new Date(),
			email: "late@gmail.com",
			expiresAt: new Date(Date.now() + 86_400_000),
			id: "toggle-family-invitation",
			inviterId: "toggle-owner",
			organizationId: "toggle-family",
			role: "member",
			status: "pending",
		});
		// The owner's disable lands after the accept's checks passed and before
		// Better Auth writes the member row.
		afterAcceptChecks = (organizationId) => {
			const organization = database.organization.find(
				(row) => row.id === organizationId
			);
			if (organization) {
				organization.metadata = JSON.stringify({
					organizationKind: "personal",
				});
			}
		};
		const consoleError = spyOn(console, "error").mockImplementation(
			() => undefined
		);
		try {
			const accepted = await acceptInvitation(
				"toggle-family",
				"late@gmail.com"
			);
			expect(accepted.status).toBe(409);
			expect(accepted.message).toBe(FAMILY_SHARING_SELF_TURNED_OFF_MESSAGE);
		} finally {
			afterAcceptChecks = null;
			consoleError.mockRestore();
		}
		expect(memberCount("toggle-family")).toBe(1);
		expect(
			familyPlaces.has(
				placeKey({ organizationId: "toggle-family", userId: lateId })
			)
		).toBe(false);
	});
});
