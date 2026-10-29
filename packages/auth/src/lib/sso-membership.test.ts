import { describe, expect, it } from "bun:test";
import {
	type SsoMembershipStore,
	settleSsoMembership,
} from "./sso-membership.ts";

const ORGANIZATION_ID = "org-acme";
const USER = { email: "Ada@Acme.com", id: "user-ada" };
const SEAT_REFUSAL = "No unassigned organization seat";

interface FakeStore extends SsoMembershipStore {
	adds: { organizationId: string; userId: string }[];
	invitationLookups: { email: string; organizationId: string }[];
	members: Set<string>;
}

function fakeStore(options: {
	addMember?: (store: FakeStore) => Promise<void>;
	member?: boolean;
	pendingInvitation?: boolean;
}): FakeStore {
	const store: FakeStore = {
		adds: [],
		invitationLookups: [],
		members: new Set(options.member ? [USER.id] : []),
		addMember: async (input) => {
			store.adds.push(input);
			if (options.addMember) {
				await options.addMember(store);
				return;
			}
			store.members.add(input.userId);
		},
		hasPendingInvitation: async (input) => {
			store.invitationLookups.push(input);
			return options.pendingInvitation ?? false;
		},
		isMember: async ({ userId }) => store.members.has(userId),
	};
	return store;
}

const settle = (store: FakeStore) =>
	settleSsoMembership({ organizationId: ORGANIZATION_ID, user: USER }, store);

describe("settleSsoMembership", () => {
	it("admits through the seat-gated add when a seat is free", async () => {
		const store = fakeStore({});
		expect(await settle(store)).toEqual({ kind: "joined" });
		expect(store.adds).toEqual([
			{ organizationId: ORGANIZATION_ID, userId: USER.id },
		]);
		// The invitation lookup uses the normalized address, as invitations do.
		expect(store.invitationLookups).toEqual([
			{ email: "ada@acme.com", organizationId: ORGANIZATION_ID },
		]);
	});

	it("returns a seat refusal instead of throwing, and adds no member", async () => {
		const store = fakeStore({
			addMember: async () => {
				throw new Error(SEAT_REFUSAL);
			},
		});
		const outcome = await settle(store);
		expect(outcome.kind).toBe("refused");
		expect(
			outcome.kind === "refused" && outcome.error instanceof Error
				? outcome.error.message
				: null
		).toBe(SEAT_REFUSAL);
		expect(store.members.size).toBe(0);
	});

	it("leaves a pending invitation to be accepted rather than adding directly", async () => {
		const store = fakeStore({ pendingInvitation: true });
		expect(await settle(store)).toEqual({ kind: "invitation-pending" });
		expect(store.adds).toEqual([]);
	});

	it("does not add an existing member again", async () => {
		const store = fakeStore({ member: true });
		expect(await settle(store)).toEqual({ kind: "member" });
		expect(store.adds).toEqual([]);
		expect(store.invitationLookups).toEqual([]);
	});

	it("treats a concurrent admission of the same user as membership", async () => {
		const store = fakeStore({
			addMember: async (current) => {
				current.members.add(USER.id);
				throw new Error("User is already a member of this organization");
			},
		});
		expect(await settle(store)).toEqual({ kind: "member" });
	});
});
