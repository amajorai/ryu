import { describe, expect, it, spyOn } from "bun:test";
import {
	FAMILY_CUSTOM_ROLES_REFUSED_MESSAGE,
	FAMILY_INVITER_EMAIL_UNVERIFIED_MESSAGE,
	FAMILY_MEMBER_EMAIL_UNVERIFIED_MESSAGE,
	FAMILY_ORGANIZER_EMAIL_UNVERIFIED_MESSAGE,
	FAMILY_ROLE_REFUSED_MESSAGE,
	FAMILY_TEAMS_REFUSED_MESSAGE,
} from "./family-admission.ts";
import {
	FAMILY_SHARING_DELETE_REFUSED_MESSAGE,
	FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE,
	FAMILY_SHARING_MEMBER_TURNED_OFF_MESSAGE,
	FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE,
	FAMILY_SHARING_SELF_TURNED_OFF_MESSAGE,
} from "./family-sharing.ts";
import {
	createOrganizationAdmission,
	FAMILY_ADMISSION_UNFINISHED_MEMBER_MESSAGE,
	FAMILY_ADMISSION_UNFINISHED_SELF_MESSAGE,
	type OrganizationAdmissionDeps,
	PERSONAL_WORKSPACE_MESSAGE,
} from "./organization-admission.ts";
import type { OrganizationKind } from "./organization-kind.ts";

/**
 * The organization hook bodies against in-memory dependencies: every kind
 * branch, without Mongo or Polar. The Better Auth plumbing around them is
 * covered by `organization-admission.integration.test.ts`.
 */

const FAMILY_ID = "64b000000000000000000001";
const OTHER_FAMILY_ID = "64b000000000000000000002";
const PERSONAL_ID = "64b000000000000000000003";
const TEAMS_ID = "64b000000000000000000004";
/** Five families other than {@link FAMILY_ID}: the families-per-account cap. */
const FIVE_OTHER_FAMILY_IDS = [
	OTHER_FAMILY_ID,
	"64b000000000000000000005",
	"64b000000000000000000006",
	"64b000000000000000000007",
	"64b000000000000000000008",
];

const gmailVerified = {
	email: "kid@gmail.com",
	emailVerified: true,
	id: "user-kid",
};
const gmailUnverified = { ...gmailVerified, emailVerified: false };
const businessVerified = {
	email: "dev@acme.example",
	emailVerified: true,
	id: "user-dev",
};

function harness(
	input: {
		/** The atomic place claim loses (a concurrent admission took the last place). */
		claimLoses?: boolean;
		/** Transient failures injected into the after-hook's checks. */
		confirmPlaceError?: Error;
		countMembersError?: Error;
		familiesByUser?: Record<string, string[]>;
		hasFamilyPlaceError?: Error;
		kinds?: Record<string, OrganizationKind | null>;
		memberCounts?: Record<string, number>;
		/** Places already held, keyed `${userId}:${organizationId}`. */
		places?: Record<string, "member" | "reserved">;
		readKindError?: Error;
		releasePlaceError?: Error;
		removeMemberError?: Error;
		seatCapacity?: number | null;
		seatError?: Error;
		usersByEmail?: Record<string, string>;
	} = {}
) {
	const calls: string[] = [];
	let invitationPolicyError: Error | null = null;
	const places = new Map(Object.entries(input.places ?? {}));
	const placeKey = (place: { organizationId: string; userId: string }) =>
		`${place.userId}:${place.organizationId}`;
	const kinds: Record<string, OrganizationKind | null> = {
		[FAMILY_ID]: "family",
		[OTHER_FAMILY_ID]: "family",
		[PERSONAL_ID]: "personal",
		[TEAMS_ID]: "teams",
		...input.kinds,
	};
	const deps: OrganizationAdmissionDeps = {
		activeSeatCapacity: async () => input.seatCapacity ?? null,
		claimFamilyPlace: async (place) => {
			calls.push(`claim:${place.userId}`);
			if (input.claimLoses) {
				return false;
			}
			places.set(placeKey(place), places.get(placeKey(place)) ?? "reserved");
			return true;
		},
		confirmFamilyPlace: async (place) => {
			calls.push(`confirm:${place.userId}`);
			if (input.confirmPlaceError) {
				throw input.confirmPlaceError;
			}
			places.set(placeKey(place), "member");
		},
		countMembers: async (organizationId) => {
			if (input.countMembersError) {
				throw input.countMembersError;
			}
			return input.memberCounts?.[organizationId] ?? 1;
		},
		familyOrganizationIdsForUser: async (userId, options) => {
			calls.push(`families:${userId}`);
			return (input.familiesByUser?.[userId] ?? []).filter(
				(organizationId) => organizationId !== options.excludeOrganizationId
			);
		},
		findUserIdByEmail: async (email) => input.usersByEmail?.[email] ?? null,
		hasFamilyPlace: async (place) => {
			if (input.hasFamilyPlaceError) {
				throw input.hasFamilyPlaceError;
			}
			return places.has(placeKey(place));
		},
		readOrganizationKind: async (organizationId) => {
			if (input.readKindError) {
				throw input.readKindError;
			}
			return kinds[organizationId] ?? null;
		},
		releaseFamilyPlace: async ({ reservedOnly, ...place }) => {
			calls.push(
				`release-place:${place.userId}${reservedOnly ? ":reserved" : ""}`
			);
			if (input.releasePlaceError) {
				throw input.releasePlaceError;
			}
			if (!reservedOnly || places.get(placeKey(place)) === "reserved") {
				places.delete(placeKey(place));
			}
		},
		releaseSeatClaims: async ({ email }) => {
			calls.push(`release:${email}`);
		},
		removeMember: async ({ memberId }) => {
			calls.push(`remove:${memberId}`);
			if (input.removeMemberError) {
				throw input.removeMemberError;
			}
		},
		reserveDirectMemberSeat: async ({ userId }) => {
			if (input.seatError) {
				throw input.seatError;
			}
			calls.push(`direct-seat:${userId}`);
		},
		reserveInvitationPolicy: async ({ email }) => {
			if (invitationPolicyError) {
				throw invitationPolicyError;
			}
			calls.push(`policy:${email}`);
		},
		reserveInvitationSeat: async ({ userId }) => {
			if (input.seatError) {
				throw input.seatError;
			}
			calls.push(`accept-seat:${userId}`);
		},
		reservePendingInvitationSeat: async ({ email }) => {
			calls.push(`pending-seat:${email}`);
		},
		resolveOrganizationKind: async (organizationId) =>
			kinds[organizationId] ?? null,
	};
	return {
		admission: createOrganizationAdmission(deps),
		calls,
		kinds,
		places,
		failInvitationPolicy: (error: Error) => {
			invitationPolicyError = error;
		},
	};
}

const addMember = (
	organizationId: string,
	user: typeof gmailVerified,
	role = "member"
) => ({
	member: { organizationId, role, userId: user.id },
	// The kind comes from the injected resolver; no metadata is passed.
	organization: {},
	user,
});

const invite = (organizationId: string, email: string, role = "member") => ({
	invitation: {
		email,
		inviterId: "user-owner",
		organizationId,
		role,
	},
	inviter: { email: "parent@gmail.com", emailVerified: true },
});

const accept = (organizationId: string, role = "member") => ({
	invitation: {
		email: gmailVerified.email,
		id: "invitation-1",
		organizationId,
		role,
	},
	user: gmailVerified,
});

describe("personal organizations", () => {
	it("admit only their first member", async () => {
		const { admission } = harness({ memberCounts: { [PERSONAL_ID]: 0 } });
		await expect(
			admission.beforeAddMember(addMember(PERSONAL_ID, gmailVerified, "owner"))
		).resolves.toBeUndefined();
		const occupied = harness().admission;
		await expect(
			occupied.beforeAddMember(addMember(PERSONAL_ID, gmailVerified))
		).rejects.toThrow(PERSONAL_WORKSPACE_MESSAGE);
	});

	it("refuse invitations, acceptance and team members", async () => {
		const { admission, calls } = harness();
		await expect(
			admission.beforeCreateInvitation(invite(PERSONAL_ID, "kid@gmail.com"))
		).rejects.toThrow(PERSONAL_WORKSPACE_MESSAGE);
		await expect(
			admission.beforeAcceptInvitation(accept(PERSONAL_ID))
		).rejects.toThrow(PERSONAL_WORKSPACE_MESSAGE);
		await expect(
			admission.beforeAddTeamMember({
				organization: { id: PERSONAL_ID },
				user: gmailVerified,
			})
		).rejects.toThrow(PERSONAL_WORKSPACE_MESSAGE);
		expect(calls).toEqual([]);
	});
});

describe("teams organizations", () => {
	it("admit the first owner without a seat, then require a verified business email and a seat", async () => {
		const empty = harness({ memberCounts: { [TEAMS_ID]: 0 } });
		await empty.admission.beforeAddMember(
			addMember(TEAMS_ID, gmailUnverified, "owner")
		);
		expect(empty.calls).toEqual([]);

		const { admission, calls } = harness();
		await expect(
			admission.beforeAddMember(addMember(TEAMS_ID, gmailVerified))
		).rejects.toThrow("Teams requires a company email address");
		await admission.beforeAddMember(addMember(TEAMS_ID, businessVerified));
		expect(calls).toEqual(["direct-seat:user-dev"]);
	});

	it("refuse a consumer invitee, keep business invitations and custom roles", async () => {
		const { admission, calls } = harness();
		await expect(
			admission.beforeCreateInvitation({
				...invite(TEAMS_ID, "kid@gmail.com"),
				inviter: businessVerified,
			})
		).rejects.toThrow("Teams invitations must use a company email address");
		const result = await admission.beforeCreateInvitation({
			...invite(TEAMS_ID, " New@Acme.Example ", "custom-role"),
			inviter: businessVerified,
		});
		expect(result.data).toMatchObject({
			email: "new@acme.example",
			role: "custom-role",
		});
		expect(calls).toEqual([
			"pending-seat:new@acme.example",
			"policy:new@acme.example",
		]);
		await expect(
			admission.requireCustomRoleWriteAllowed(TEAMS_ID)
		).resolves.toBeUndefined();
	});

	it("refuse a consumer-mailbox promotion and never consult families", async () => {
		const { admission, calls } = harness();
		await expect(
			admission.beforeUpdateMemberRole({
				member: { organizationId: TEAMS_ID, role: "member" },
				newRole: "admin",
				organization: {},
				user: gmailVerified,
			})
		).rejects.toThrow("Teams requires a company email address");
		await admission.beforeAcceptInvitation({
			...accept(TEAMS_ID),
			user: businessVerified,
		});
		expect(calls).toEqual(["accept-seat:user-dev"]);
	});

	it("allow sub-teams with a business member", async () => {
		const { admission } = harness();
		await expect(
			admission.beforeCreateTeam({
				organization: { id: TEAMS_ID },
				team: { name: "  Platform  ", organizationId: TEAMS_ID },
			})
		).resolves.toEqual({
			data: { name: "Platform", organizationId: TEAMS_ID },
		});
		await expect(
			admission.beforeAddTeamMember({
				organization: { id: TEAMS_ID },
				user: businessVerified,
			})
		).resolves.toBeUndefined();
	});

	it("block deletion while a paid plan is active", async () => {
		const { admission } = harness({ seatCapacity: 5 });
		await expect(
			admission.beforeDeleteOrganization({ organization: { id: TEAMS_ID } })
		).rejects.toThrow("Cancel the active organization plan");
		await expect(
			harness().admission.beforeDeleteOrganization({
				organization: { id: TEAMS_ID },
			})
		).resolves.toBeUndefined();
	});
});

describe("family organizations: direct add", () => {
	it("admits a verified Gmail member through the family cap check and the seat gate", async () => {
		const { admission, calls } = harness();
		await admission.beforeAddMember(addMember(FAMILY_ID, gmailVerified));
		expect(calls).toEqual([
			"families:user-kid",
			"claim:user-kid",
			"direct-seat:user-kid",
		]);
	});

	it("never takes the first-owner bootstrap, even for an empty family", async () => {
		const { admission, calls } = harness({ memberCounts: { [FAMILY_ID]: 0 } });
		await expect(
			admission.beforeAddMember(addMember(FAMILY_ID, gmailVerified, "owner"))
		).rejects.toThrow(FAMILY_ROLE_REFUSED_MESSAGE);
		await admission.beforeAddMember(addMember(FAMILY_ID, gmailVerified));
		expect(calls).toEqual([
			"families:user-kid",
			"claim:user-kid",
			"direct-seat:user-kid",
		]);
	});

	it("admits someone already in four other families", async () => {
		const { admission, calls } = harness({
			familiesByUser: { "user-kid": FIVE_OTHER_FAMILY_IDS.slice(0, 4) },
		});
		await admission.beforeAddMember(addMember(FAMILY_ID, gmailVerified));
		expect(calls).toEqual([
			"families:user-kid",
			"claim:user-kid",
			"direct-seat:user-kid",
		]);
	});

	it("refuses an unverified mailbox, a billing role, and someone in five other families", async () => {
		const { admission, calls } = harness({
			familiesByUser: { "user-kid": FIVE_OTHER_FAMILY_IDS },
		});
		await expect(
			admission.beforeAddMember(addMember(FAMILY_ID, gmailUnverified))
		).rejects.toThrow(FAMILY_MEMBER_EMAIL_UNVERIFIED_MESSAGE);
		await expect(
			admission.beforeAddMember(
				addMember(FAMILY_ID, gmailVerified, "member,billing")
			)
		).rejects.toThrow(FAMILY_ROLE_REFUSED_MESSAGE);
		await expect(
			admission.beforeAddMember(addMember(FAMILY_ID, gmailVerified))
		).rejects.toThrow(FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE);
		expect(calls).toEqual(["families:user-kid"]);
	});

	it("does not count a membership of the same family against the cap", async () => {
		const { admission, calls } = harness({
			familiesByUser: {
				"user-kid": [FAMILY_ID, ...FIVE_OTHER_FAMILY_IDS.slice(0, 4)],
			},
		});
		await admission.beforeAddMember(addMember(FAMILY_ID, gmailVerified));
		expect(calls).toEqual([
			"families:user-kid",
			"claim:user-kid",
			"direct-seat:user-kid",
		]);
	});
});

describe("family organizations: invitations", () => {
	it("admits a Gmail invitee and reserves a pending seat", async () => {
		const { admission, calls } = harness({
			usersByEmail: { "kid@gmail.com": "user-kid" },
		});
		const result = await admission.beforeCreateInvitation(
			invite(FAMILY_ID, "Kid@Gmail.com", "admin")
		);
		expect(result.data).toMatchObject({
			email: "kid@gmail.com",
			role: "admin",
		});
		expect(calls).toEqual([
			"families:user-kid",
			"pending-seat:kid@gmail.com",
			"policy:kid@gmail.com",
		]);
	});

	it("skips the family cap pre-check for an email with no account", async () => {
		const { admission, calls } = harness();
		await admission.beforeCreateInvitation(invite(FAMILY_ID, "new@icloud.com"));
		expect(calls).toEqual([
			"pending-seat:new@icloud.com",
			"policy:new@icloud.com",
		]);
	});

	it("invites someone in another family", async () => {
		const { admission, calls } = harness({
			familiesByUser: { "user-kid": [OTHER_FAMILY_ID] },
			usersByEmail: { "kid@gmail.com": "user-kid" },
		});
		await admission.beforeCreateInvitation(invite(FAMILY_ID, "kid@gmail.com"));
		expect(calls).toEqual([
			"families:user-kid",
			"pending-seat:kid@gmail.com",
			"policy:kid@gmail.com",
		]);
	});

	it("refuses an invitee already in five families before reserving a seat", async () => {
		const { admission, calls } = harness({
			familiesByUser: { "user-kid": FIVE_OTHER_FAMILY_IDS },
			usersByEmail: { "kid@gmail.com": "user-kid" },
		});
		await expect(
			admission.beforeCreateInvitation(invite(FAMILY_ID, "kid@gmail.com"))
		).rejects.toThrow(FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE);
		expect(calls).toEqual(["families:user-kid"]);
	});

	it("refuses owner, billing and custom roles, sub-teams, and an unverified inviter", async () => {
		const { admission, calls } = harness();
		for (const role of ["owner", "billing", "parent"]) {
			await expect(
				admission.beforeCreateInvitation(
					invite(FAMILY_ID, "kid@gmail.com", role)
				)
			).rejects.toThrow(FAMILY_ROLE_REFUSED_MESSAGE);
		}
		await expect(
			admission.beforeCreateInvitation({
				...invite(FAMILY_ID, "kid@gmail.com"),
				invitation: {
					...invite(FAMILY_ID, "kid@gmail.com").invitation,
					teamId: "team-1",
				},
			})
		).rejects.toThrow(FAMILY_TEAMS_REFUSED_MESSAGE);
		await expect(
			admission.beforeCreateInvitation({
				...invite(FAMILY_ID, "kid@gmail.com"),
				inviter: { email: "parent@gmail.com", emailVerified: false },
			})
		).rejects.toThrow(FAMILY_INVITER_EMAIL_UNVERIFIED_MESSAGE);
		expect(calls).toEqual([]);
	});

	it("releases the pending seat when the invitation policy refuses the send", async () => {
		const { admission, calls, failInvitationPolicy } = harness();
		failInvitationPolicy(new Error("cooldown"));
		await expect(
			admission.beforeCreateInvitation(invite(FAMILY_ID, "kid@gmail.com"))
		).rejects.toThrow("cooldown");
		expect(calls).toEqual([
			"pending-seat:kid@gmail.com",
			"release:kid@gmail.com",
		]);
	});

	it("accepts a Gmail invitee in up to four other families and refuses one in five", async () => {
		const { admission, calls } = harness({
			familiesByUser: { "user-kid": FIVE_OTHER_FAMILY_IDS.slice(0, 4) },
		});
		await admission.beforeAcceptInvitation(accept(FAMILY_ID));
		expect(calls).toEqual([
			"families:user-kid",
			"claim:user-kid",
			"accept-seat:user-kid",
		]);

		const atLimit = harness({
			familiesByUser: { "user-kid": FIVE_OTHER_FAMILY_IDS },
		});
		await expect(
			atLimit.admission.beforeAcceptInvitation(accept(FAMILY_ID))
		).rejects.toThrow(FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE);
		expect(atLimit.calls).toEqual(["families:user-kid"]);
	});

	it("refuses to accept an invitation carrying a billing role or a team", async () => {
		const { admission, calls } = harness();
		await expect(
			admission.beforeAcceptInvitation(accept(FAMILY_ID, "billing"))
		).rejects.toThrow(FAMILY_ROLE_REFUSED_MESSAGE);
		await expect(
			admission.beforeAcceptInvitation({
				...accept(FAMILY_ID),
				invitation: { ...accept(FAMILY_ID).invitation, teamId: "team-1" },
			})
		).rejects.toThrow(FAMILY_TEAMS_REFUSED_MESSAGE);
		expect(calls).toEqual([]);
	});
});

describe("family organizations: the atomic family place", () => {
	it("refuses an admission whose place claim loses a race the read check passed", async () => {
		const direct = harness({ claimLoses: true });
		await expect(
			direct.admission.beforeAddMember(addMember(FAMILY_ID, gmailVerified))
		).rejects.toThrow(FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE);
		expect(direct.calls).toEqual(["families:user-kid", "claim:user-kid"]);

		const accepting = harness({ claimLoses: true });
		await expect(
			accepting.admission.beforeAcceptInvitation(accept(FAMILY_ID))
		).rejects.toThrow(FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE);
		expect(accepting.calls).toEqual(["families:user-kid", "claim:user-kid"]);
	});

	it("gives the claimed place back when the family has no seat", async () => {
		const { admission, calls, places } = harness({
			seatError: new Error("family full"),
		});
		await expect(
			admission.beforeAcceptInvitation(accept(FAMILY_ID))
		).rejects.toThrow("family full");
		expect(calls).toEqual([
			"families:user-kid",
			"claim:user-kid",
			"release-place:user-kid:reserved",
		]);
		expect(places.size).toBe(0);
	});

	it("never claims a place for a Teams admission", async () => {
		const { admission, calls } = harness({ seatCapacity: 5 });
		await admission.beforeAddMember(addMember(TEAMS_ID, businessVerified));
		expect(calls).toEqual(["direct-seat:user-dev"]);
	});

	it("confirms the place once the member row exists", async () => {
		const { admission, calls, places } = harness({
			places: { [`user-kid:${FAMILY_ID}`]: "reserved" },
		});
		await admission.afterMemberAdmitted({
			actor: "self",
			memberId: "member-1",
			organizationId: FAMILY_ID,
			userId: "user-kid",
		});
		expect(calls).toEqual(["confirm:user-kid"]);
		expect(places.get(`user-kid:${FAMILY_ID}`)).toBe("member");
	});

	it("leaves an admission that did not come through the family path alone", async () => {
		const { admission, calls } = harness();
		await admission.afterMemberAdmitted({
			actor: "other",
			memberId: "member-1",
			organizationId: PERSONAL_ID,
			userId: "user-kid",
		});
		expect(calls).toEqual([]);
	});

	it("undoes an accept or add that raced family sharing being turned off", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(
			() => undefined
		);
		try {
			for (const [actor, message] of [
				["self", FAMILY_SHARING_SELF_TURNED_OFF_MESSAGE],
				["other", FAMILY_SHARING_MEMBER_TURNED_OFF_MESSAGE],
			] as const) {
				// The before hook claimed a place while the org was a family; the
				// owner's disable landed before Better Auth wrote the member row.
				const { admission, calls, places } = harness({
					kinds: { [FAMILY_ID]: "personal" },
					places: { [`user-kid:${FAMILY_ID}`]: "reserved" },
				});
				await expect(
					admission.afterMemberAdmitted({
						actor,
						memberId: "member-1",
						organizationId: FAMILY_ID,
						userId: "user-kid",
					})
				).rejects.toThrow(message);
				expect(calls).toEqual(["remove:member-1", "release-place:user-kid"]);
				expect(places.size).toBe(0);
			}
			expect(consoleError).toHaveBeenCalled();
		} finally {
			consoleError.mockRestore();
		}
	});

	it("still fails the request when the compensating removal fails", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(
			() => undefined
		);
		try {
			const { admission, calls, places } = harness({
				kinds: { [FAMILY_ID]: "personal" },
				places: { [`user-kid:${FAMILY_ID}`]: "reserved" },
				removeMemberError: new Error("mongo down"),
			});
			await expect(
				admission.afterMemberAdmitted({
					actor: "self",
					memberId: "member-1",
					organizationId: FAMILY_ID,
					userId: "user-kid",
				})
			).rejects.toMatchObject({
				message: FAMILY_ADMISSION_UNFINISHED_SELF_MESSAGE,
				status: "SERVICE_UNAVAILABLE",
			});
			// The place stays with the member row it still describes.
			expect(calls).toEqual(["remove:member-1"]);
			expect(places.get(`user-kid:${FAMILY_ID}`)).toBe("reserved");
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining("Failed to undo a family admission"),
				expect.objectContaining({ memberId: "member-1" })
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	describe("fails closed when the admission cannot be verified", () => {
		const transient = () => new Error("mongo blip");
		const afterAdmit = (
			admission: ReturnType<typeof harness>["admission"],
			actor: "other" | "self",
			organizationId = FAMILY_ID
		) =>
			admission.afterMemberAdmitted({
				actor,
				memberId: "member-1",
				organizationId,
				userId: "user-kid",
			});
		const reservedPlace = { [`user-kid:${FAMILY_ID}`]: "reserved" } as const;

		for (const [step, options, expectedCalls] of [
			[
				"the kind read",
				{ places: reservedPlace, readKindError: transient() },
				["remove:member-1", "release-place:user-kid"],
			],
			[
				"the place confirmation",
				{ confirmPlaceError: transient(), places: reservedPlace },
				["confirm:user-kid", "remove:member-1", "release-place:user-kid"],
			],
			[
				"the place read, then the kind read",
				{
					hasFamilyPlaceError: transient(),
					places: reservedPlace,
					readKindError: transient(),
				},
				["remove:member-1", "release-place:user-kid"],
			],
			[
				"the place read, then the confirmation",
				{
					confirmPlaceError: transient(),
					hasFamilyPlaceError: transient(),
					places: reservedPlace,
				},
				["confirm:user-kid", "remove:member-1", "release-place:user-kid"],
			],
			[
				"the place read, then the member count of a personal org",
				{
					countMembersError: transient(),
					hasFamilyPlaceError: transient(),
					kinds: { [FAMILY_ID]: "personal" },
					places: reservedPlace,
				},
				["remove:member-1", "release-place:user-kid"],
			],
		] as const) {
			it(`undoes the admission and asks for a retry when ${step} fails`, async () => {
				const consoleError = spyOn(console, "error").mockImplementation(
					() => undefined
				);
				try {
					for (const [actor, message] of [
						["self", FAMILY_ADMISSION_UNFINISHED_SELF_MESSAGE],
						["other", FAMILY_ADMISSION_UNFINISHED_MEMBER_MESSAGE],
					] as const) {
						const { admission, calls, places } = harness(options);
						await expect(afterAdmit(admission, actor)).rejects.toMatchObject({
							message,
							status: "SERVICE_UNAVAILABLE",
						});
						expect(calls).toEqual([...expectedCalls]);
						expect(places.size).toBe(0);
					}
					expect(consoleError).toHaveBeenCalledWith(
						"Could not verify a family admission; undoing it:",
						expect.objectContaining({ memberId: "member-1" })
					);
				} finally {
					consoleError.mockRestore();
				}
			});
		}

		it("still fails when both the check and the removal fail", async () => {
			const consoleError = spyOn(console, "error").mockImplementation(
				() => undefined
			);
			try {
				const { admission, calls } = harness({
					places: reservedPlace,
					readKindError: transient(),
					removeMemberError: transient(),
				});
				await expect(afterAdmit(admission, "self")).rejects.toMatchObject({
					message: FAMILY_ADMISSION_UNFINISHED_SELF_MESSAGE,
					status: "SERVICE_UNAVAILABLE",
				});
				expect(calls).toEqual(["remove:member-1"]);
				expect(consoleError).toHaveBeenCalledWith(
					expect.stringContaining("Failed to undo a family admission"),
					expect.objectContaining({ memberId: "member-1" })
				);
			} finally {
				consoleError.mockRestore();
			}
		});

		it("still fails with retry copy when releasing the place also fails", async () => {
			const consoleError = spyOn(console, "error").mockImplementation(
				() => undefined
			);
			try {
				const { admission, calls } = harness({
					places: reservedPlace,
					readKindError: transient(),
					releasePlaceError: transient(),
				});
				await expect(afterAdmit(admission, "other")).rejects.toMatchObject({
					message: FAMILY_ADMISSION_UNFINISHED_MEMBER_MESSAGE,
					status: "SERVICE_UNAVAILABLE",
				});
				expect(calls).toEqual(["remove:member-1", "release-place:user-kid"]);
			} finally {
				consoleError.mockRestore();
			}
		});

		it("undoes a second member of a now-personal org when the place read fails", async () => {
			const consoleError = spyOn(console, "error").mockImplementation(
				() => undefined
			);
			try {
				const { admission, calls } = harness({
					hasFamilyPlaceError: transient(),
					kinds: { [FAMILY_ID]: "personal" },
					memberCounts: { [FAMILY_ID]: 2 },
					places: reservedPlace,
				});
				await expect(afterAdmit(admission, "self")).rejects.toThrow(
					FAMILY_SHARING_SELF_TURNED_OFF_MESSAGE
				);
				expect(calls).toEqual(["remove:member-1", "release-place:user-kid"]);
			} finally {
				consoleError.mockRestore();
			}
		});

		it("confirms a family admission when only the place read fails", async () => {
			const consoleError = spyOn(console, "error").mockImplementation(
				() => undefined
			);
			try {
				const { admission, calls, places } = harness({
					hasFamilyPlaceError: transient(),
					places: reservedPlace,
				});
				await afterAdmit(admission, "self");
				expect(calls).toEqual(["confirm:user-kid"]);
				expect(places.get(`user-kid:${FAMILY_ID}`)).toBe("member");
			} finally {
				consoleError.mockRestore();
			}
		});

		it("keeps a Teams member or a personal org's owner row when only the place read fails", async () => {
			const consoleError = spyOn(console, "error").mockImplementation(
				() => undefined
			);
			try {
				for (const organizationId of [TEAMS_ID, PERSONAL_ID]) {
					const { admission, calls } = harness({
						hasFamilyPlaceError: transient(),
						memberCounts: { [PERSONAL_ID]: 1, [TEAMS_ID]: 4 },
					});
					await afterAdmit(admission, "other", organizationId);
					expect(calls).toEqual([]);
				}
			} finally {
				consoleError.mockRestore();
			}
		});
	});

	it("releases a leaver's place, and only an unconfirmed place for a dropped invitation", async () => {
		const { admission, calls, places } = harness({
			places: {
				[`user-kid:${FAMILY_ID}`]: "member",
				[`user-kid:${OTHER_FAMILY_ID}`]: "reserved",
			},
			usersByEmail: { "kid@gmail.com": "user-kid" },
		});
		await admission.releaseInvitationFamilyPlace({
			email: "Kid@Gmail.com",
			organizationId: FAMILY_ID,
		});
		expect(places.get(`user-kid:${FAMILY_ID}`)).toBe("member");
		await admission.releaseInvitationFamilyPlace({
			email: "kid@gmail.com",
			organizationId: OTHER_FAMILY_ID,
		});
		expect(places.has(`user-kid:${OTHER_FAMILY_ID}`)).toBe(false);
		await admission.releaseMemberFamilyPlace({
			organizationId: FAMILY_ID,
			userId: "user-kid",
		});
		expect(places.size).toBe(0);
		expect(calls).toEqual([
			"release-place:user-kid:reserved",
			"release-place:user-kid:reserved",
			"release-place:user-kid",
		]);
	});
});

describe("family organizations: roles, teams and deletion", () => {
	const roleChange = (
		role: string,
		newRole: string,
		user: { email?: string; emailVerified?: boolean }
	) => ({
		member: { organizationId: FAMILY_ID, role },
		newRole,
		organization: {},
		user,
	});

	it("promotes a verified Gmail member to organizer", async () => {
		const { admission } = harness();
		await expect(
			admission.beforeUpdateMemberRole(
				roleChange("member", "admin", gmailVerified)
			)
		).resolves.toBeUndefined();
	});

	it("refuses an unverified promotion but allows an unverified demotion", async () => {
		const { admission } = harness();
		await expect(
			admission.beforeUpdateMemberRole(
				roleChange("member", "admin", gmailUnverified)
			)
		).rejects.toThrow(FAMILY_ORGANIZER_EMAIL_UNVERIFIED_MESSAGE);
		await expect(
			admission.beforeUpdateMemberRole(
				roleChange("admin", "member", gmailUnverified)
			)
		).resolves.toBeUndefined();
	});

	it("refuses owner, billing and custom roles", async () => {
		const { admission } = harness();
		for (const newRole of ["owner", "member,billing", "parent"]) {
			await expect(
				admission.beforeUpdateMemberRole(
					roleChange("member", newRole, gmailVerified)
				)
			).rejects.toThrow(FAMILY_ROLE_REFUSED_MESSAGE);
		}
	});

	it("refuses sub-teams and custom-role writes", async () => {
		const { admission } = harness();
		await expect(
			admission.beforeCreateTeam({
				organization: { id: FAMILY_ID },
				team: { name: "Kids" },
			})
		).rejects.toThrow(FAMILY_TEAMS_REFUSED_MESSAGE);
		await expect(
			admission.beforeAddTeamMember({
				organization: { id: FAMILY_ID },
				user: gmailVerified,
			})
		).rejects.toThrow(FAMILY_TEAMS_REFUSED_MESSAGE);
		await expect(
			admission.requireCustomRoleWriteAllowed(FAMILY_ID)
		).rejects.toThrow(FAMILY_CUSTOM_ROLES_REFUSED_MESSAGE);
		await expect(
			admission.requireCustomRoleWriteAllowed(null)
		).resolves.toBeUndefined();
	});

	it("refuses deletion while sharing is on, even without capacity", async () => {
		const { admission } = harness();
		await expect(
			admission.beforeDeleteOrganization({ organization: { id: FAMILY_ID } })
		).rejects.toThrow(FAMILY_SHARING_DELETE_REFUSED_MESSAGE);
	});
});
