/**
 * Membership admission for Better Auth organizations: the bodies of the
 * organization hooks that decide who may join, be invited, change role, or
 * use sub-teams and custom roles, for each org kind.
 *
 * - personal: one person; every invitation and second member is refused.
 * - teams (and legacy shared orgs without a kind): a verified business email
 *   and a paid seat.
 * - family (Ryu Max family sharing): any verified mailbox, at most six people
 *   including pending invitations, at most five families per person (an
 *   atomic per-person place claim, see `family-membership-slots.ts`), no
 *   sub-teams, no custom or billing roles, and no deletion while sharing is
 *   on.
 *
 * Storage, Polar and the seat-claim machinery are injected so `index.ts` wires
 * the Mongo-backed implementations and tests can run the same rules against
 * Better Auth's memory adapter. The pure decisions live in
 * `family-admission.ts`.
 */
import { roleChangeGrantsPermissions } from "@ryu/db/models/control-plane.model";
import { APIError } from "better-auth/api";
import {
	assignedRoleRefusal,
	customRoleRefusal,
	familyMembershipRefusal,
	familyVerifiedEmailRefusal,
	invitationNamesTeam,
	organizationAdmissionPolicy,
	teamRefusal,
} from "./family-admission.ts";
import {
	FAMILY_SHARING_DELETE_REFUSED_MESSAGE,
	FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE,
	FAMILY_SHARING_MEMBER_TURNED_OFF_MESSAGE,
	FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE,
	FAMILY_SHARING_SELF_TURNED_OFF_MESSAGE,
} from "./family-sharing.ts";
import {
	businessEmailDecision,
	businessEmailDomainDecision,
	businessEmailMessage,
	memberRoleChangeRefusal,
} from "./organization-email-policy.ts";
import {
	normalizeInvitationEmail,
	normalizeReferralTag,
} from "./organization-invitation-policy.ts";
import {
	FAMILY_ORGANIZATION_KIND,
	memberRoleIncludesOwner,
	type OrganizationKind,
	type OrganizationMetadataInput,
	PERSONAL_ORGANIZATION_KIND,
} from "./organization-kind.ts";

export const PERSONAL_WORKSPACE_MESSAGE =
	"Personal workspaces are for one person. Upgrade this workspace to Teams to invite teammates and share access.";

interface OrganizationPolicyUser {
	email?: string | null;
	emailVerified?: boolean | null;
}

interface AdmissionUser extends OrganizationPolicyUser {
	id: string;
}

interface AdmissionOrganization {
	id: string;
	metadata?: OrganizationMetadataInput;
}

export function requireVerifiedBusinessEmail(
	user: OrganizationPolicyUser,
	context: "member" | "upgrade" = "member"
): void {
	const decision = businessEmailDecision({
		email: user.email,
		emailVerified: user.emailVerified,
	});
	if (!decision.allowed) {
		throw new APIError("FORBIDDEN", {
			message: businessEmailMessage(decision, context),
		});
	}
}

function requireBusinessEmailDomain(email: string): void {
	const decision = businessEmailDomainDecision(email);
	if (!decision.allowed) {
		throw new APIError("BAD_REQUEST", {
			message: businessEmailMessage(decision, "invitation"),
		});
	}
}

function refuse(
	status: "BAD_REQUEST" | "FORBIDDEN",
	message: string | null
): void {
	if (message !== null) {
		throw new APIError(status, { message });
	}
}

interface FamilyPlace {
	organizationId: string;
	userId: string;
}

/** A family admission could not be verified, so it was undone (best effort). */
export const FAMILY_ADMISSION_UNFINISHED_SELF_MESSAGE =
	"We couldn't finish adding you to this family. Please try again.";
export const FAMILY_ADMISSION_UNFINISHED_MEMBER_MESSAGE =
	"We couldn't finish adding this person to this family. Please try again.";

function familyAdmissionUnfinished(actor: "other" | "self"): APIError {
	return new APIError("SERVICE_UNAVAILABLE", {
		message:
			actor === "self"
				? FAMILY_ADMISSION_UNFINISHED_SELF_MESSAGE
				: FAMILY_ADMISSION_UNFINISHED_MEMBER_MESSAGE,
	});
}

type FamilyAdmissionOutcome =
	| { settled: true }
	| { kind: OrganizationKind | null; settled: false };

export interface OrganizationAdmissionDeps {
	/** Live admitting capacity (Teams seats or family capacity); null when none. */
	activeSeatCapacity(organizationId: string): Promise<number | null>;
	/**
	 * Atomically claim one of the user's family places for the org (the
	 * families-per-account cap); false when every place is held. Idempotent
	 * for the same family. See `claimFamilyMembershipSlot`.
	 */
	claimFamilyPlace(input: FamilyPlace): Promise<boolean>;
	/** Confirm a claimed place once the member row exists. */
	confirmFamilyPlace(input: FamilyPlace): Promise<void>;
	countMembers(organizationId: string): Promise<number>;
	/**
	 * Family orgs the user belongs to, other than `excludeOrganizationId`. The
	 * cap counts the target family once more, so excluding it does not change
	 * the answer for someone already in it.
	 */
	familyOrganizationIdsForUser(
		userId: string,
		options: { excludeOrganizationId: string }
	): Promise<string[]>;
	/** The id of the account that owns `email` (already normalized), if any. */
	findUserIdByEmail(email: string): Promise<string | null>;
	/** Whether the user holds a family place in the org (the family-path marker). */
	hasFamilyPlace(input: FamilyPlace): Promise<boolean>;
	/** The durable kind only, for family-only checks on caller-supplied ids. */
	readOrganizationKind(
		organizationId: string
	): Promise<OrganizationKind | null>;
	/** Release a family place; `reservedOnly` keeps a confirmed membership's. */
	releaseFamilyPlace(
		input: FamilyPlace & { reservedOnly?: boolean }
	): Promise<void>;
	releaseSeatClaims(input: {
		email?: string;
		invitationId?: string;
		organizationId: string;
		userId?: string;
	}): Promise<void>;
	/** Delete one member row (the after-hook compensation below). */
	removeMember(input: FamilyPlace & { memberId: string }): Promise<void>;
	reserveDirectMemberSeat(input: {
		organizationId: string;
		userId: string;
	}): Promise<void>;
	reserveInvitationPolicy(input: {
		email: string;
		organizationId: string;
	}): Promise<void>;
	reserveInvitationSeat(input: {
		email: string;
		invitationId: string;
		organizationId: string;
		userId: string;
	}): Promise<void>;
	reservePendingInvitationSeat(input: {
		email: string;
		organizationId: string;
	}): Promise<void>;
	/**
	 * The durable kind, with the legacy fallback that classifies an unmarked org
	 * as personal when it is its first member's personal org. Reads the org when
	 * `metadata` is omitted.
	 */
	resolveOrganizationKind(
		organizationId: string,
		metadata?: OrganizationMetadataInput
	): Promise<OrganizationKind | null>;
}

export function createOrganizationAdmission(deps: OrganizationAdmissionDeps) {
	/** Keep the personal workspace genuinely personal; shared access needs an org. */
	async function rejectPersonalWorkspaceInvitation(
		organizationId: string,
		metadata?: OrganizationMetadataInput
	): Promise<OrganizationKind | null> {
		const kind = await deps.resolveOrganizationKind(organizationId, metadata);
		if (kind === PERSONAL_ORGANIZATION_KIND) {
			throw new APIError("BAD_REQUEST", {
				message: PERSONAL_WORKSPACE_MESSAGE,
			});
		}
		return kind;
	}

	/**
	 * The families-per-account cap (`policy.maxPerPerson`) as a read: the early,
	 * friendly refusal. Admission then claims a place with
	 * {@link claimFamilyPlace}, which is the authority under concurrency.
	 */
	async function requireFamilyRoom(input: {
		actor: "other" | "self";
		limit: number;
		organizationId: string;
		userId: string;
	}): Promise<void> {
		const existingFamilyOrganizationIds =
			await deps.familyOrganizationIdsForUser(input.userId, {
				excludeOrganizationId: input.organizationId,
			});
		refuse(
			"FORBIDDEN",
			familyMembershipRefusal({
				actor: input.actor,
				existingFamilyOrganizationIds,
				limit: input.limit,
				targetOrganizationId: input.organizationId,
			})
		);
	}

	/**
	 * Claim the person's family place for an admission, after the read check.
	 * Two accepts racing into different families both pass the read; only as
	 * many as there are free places win the claim.
	 */
	async function claimFamilyPlace(input: {
		actor: "other" | "self";
		limit: number;
		organizationId: string;
		userId: string;
	}): Promise<void> {
		await requireFamilyRoom(input);
		const claimed = await deps.claimFamilyPlace({
			organizationId: input.organizationId,
			userId: input.userId,
		});
		refuse(
			"FORBIDDEN",
			claimed
				? null
				: input.actor === "self"
					? FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE
					: FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE
		);
	}

	/**
	 * Run the seat reservation after a family place was claimed, and give the
	 * place back if the seat is refused, so a full family does not also cost
	 * the person one of their places until the claim expires.
	 */
	async function withFamilyPlace(
		place: FamilyPlace | null,
		reserveSeat: () => Promise<void>
	): Promise<void> {
		try {
			await reserveSeat();
		} catch (error) {
			if (place) {
				await deps
					.releaseFamilyPlace({ ...place, reservedOnly: true })
					.catch((releaseError: unknown) => {
						console.error("Failed to release a family place:", releaseError);
					});
			}
			throw error;
		}
	}

	/**
	 * Whether a just-written member row is a valid family admission. Throws when
	 * the answer cannot be read, so the caller fails closed.
	 *
	 * The family-path marker is the person's place in the org. When that read
	 * fails, the kind decides: a family confirms as usual, and only a personal
	 * workspace that now has more than one member can be a family admission
	 * that raced sharing being turned off. A Teams admission, or a personal
	 * workspace's own owner row written at creation, stays.
	 */
	async function verifyFamilyAdmission(
		place: FamilyPlace
	): Promise<FamilyAdmissionOutcome> {
		let familyPath: boolean | null;
		try {
			familyPath = await deps.hasFamilyPlace(place);
		} catch (error) {
			console.error("Failed to read a family place; checking the kind:", {
				error,
				...place,
			});
			familyPath = null;
		}
		if (familyPath === false) {
			return { settled: true };
		}
		const kind = await deps.readOrganizationKind(place.organizationId);
		if (kind === FAMILY_ORGANIZATION_KIND) {
			await deps.confirmFamilyPlace(place);
			return { settled: true };
		}
		if (
			familyPath === null &&
			(kind !== PERSONAL_ORGANIZATION_KIND ||
				(await deps.countMembers(place.organizationId)) <= 1)
		) {
			return { settled: true };
		}
		return { kind, settled: false };
	}

	/**
	 * Remove an admitted member row and free its family place. Best effort:
	 * returns false (after logging) when the row could not be removed, in which
	 * case the place stays with the row it describes.
	 */
	async function undoAdmission(
		admitted: FamilyPlace & { memberId: string }
	): Promise<boolean> {
		try {
			await deps.removeMember(admitted);
		} catch (error) {
			console.error(
				"Failed to undo a family admission; the member row may remain and needs manual review:",
				{ error, ...admitted }
			);
			return false;
		}
		const { memberId: _memberId, ...place } = admitted;
		await deps.releaseFamilyPlace(place).catch((error: unknown) => {
			console.error("Failed to release a family place:", error);
		});
		return true;
	}

	return {
		rejectPersonalWorkspaceInvitation,

		/**
		 * After Better Auth wrote a member row: confirm the family place, or undo
		 * the admission when it came through the family path (the before hook
		 * claimed a place) but the org is no longer a family. That happens when
		 * the owner turns sharing off between this admission's checks and its
		 * write; without the undo a personal workspace would keep a second
		 * member.
		 *
		 * Fails closed: when the check cannot complete (a read or the
		 * confirmation fails) the member row is removed, the place released, and
		 * the request fails with retry copy. A removal that fails is logged and
		 * the request still fails, so Better Auth never reports an unverified
		 * family admission as a success.
		 */
		async afterMemberAdmitted(input: {
			actor: "other" | "self";
			memberId: string;
			organizationId: string;
			userId: string;
		}): Promise<void> {
			const place = {
				organizationId: input.organizationId,
				userId: input.userId,
			};
			const admitted = { ...place, memberId: input.memberId };
			let outcome: FamilyAdmissionOutcome;
			try {
				outcome = await verifyFamilyAdmission(place);
			} catch (error) {
				console.error("Could not verify a family admission; undoing it:", {
					error,
					...admitted,
				});
				await undoAdmission(admitted);
				throw familyAdmissionUnfinished(input.actor);
			}
			if (outcome.settled) {
				return;
			}
			if (!(await undoAdmission(admitted))) {
				throw familyAdmissionUnfinished(input.actor);
			}
			console.error(
				"Undid a family admission that raced family sharing being turned off:",
				{ kind: outcome.kind, ...admitted }
			);
			throw new APIError("CONFLICT", {
				message:
					input.actor === "self"
						? FAMILY_SHARING_SELF_TURNED_OFF_MESSAGE
						: FAMILY_SHARING_MEMBER_TURNED_OFF_MESSAGE,
			});
		},

		/** A member left or was removed: their family place is free again. */
		async releaseMemberFamilyPlace(place: FamilyPlace): Promise<void> {
			try {
				await deps.releaseFamilyPlace(place);
			} catch (error) {
				console.error("Failed to release a family place:", error);
			}
		},

		/**
		 * An invitation was rejected or cancelled: free a place an accept claimed
		 * for it but never completed. A confirmed membership's place stays.
		 */
		async releaseInvitationFamilyPlace(invitation: {
			email: string;
			organizationId: string;
		}): Promise<void> {
			try {
				const userId = await deps.findUserIdByEmail(
					normalizeInvitationEmail(invitation.email)
				);
				if (userId) {
					await deps.releaseFamilyPlace({
						organizationId: invitation.organizationId,
						reservedOnly: true,
						userId,
					});
				}
			} catch (error) {
				console.error("Failed to release an invitation's family place:", error);
			}
		},

		/**
		 * Refuse a custom-role write (dynamic access control) for a family org.
		 * With no organization id the endpoint itself rejects the request.
		 */
		async requireCustomRoleWriteAllowed(
			organizationId: string | null | undefined
		): Promise<void> {
			if (!organizationId) {
				return;
			}
			refuse(
				"FORBIDDEN",
				customRoleRefusal(await deps.readOrganizationKind(organizationId))
			);
		},

		async beforeDeleteOrganization({
			organization,
		}: {
			organization: AdmissionOrganization;
		}): Promise<void> {
			// A family is the owner's personal org carrying their Max plan, data and
			// members. Deleting it would strand every member; sharing is turned off
			// (members removed, kind reverted) before the workspace can go.
			const kind = await deps.resolveOrganizationKind(
				organization.id,
				organization.metadata
			);
			refuse(
				"BAD_REQUEST",
				kind === FAMILY_ORGANIZATION_KIND
					? FAMILY_SHARING_DELETE_REFUSED_MESSAGE
					: null
			);
			// Deleting the Better Auth organization must not strand an active
			// Polar subscription that would keep charging its payer. Cancel the
			// plan through billing first; once Polar reports it inactive, deletion
			// can proceed and the after hook removes transient seat claims.
			if ((await deps.activeSeatCapacity(organization.id)) !== null) {
				throw new APIError("BAD_REQUEST", {
					message:
						"Cancel the active organization plan before deleting this organization. Billing is managed from Organization billing.",
				});
			}
		},

		async beforeAddMember({
			member,
			user,
			organization,
		}: {
			member: { organizationId: string; role: string };
			organization: Pick<AdmissionOrganization, "metadata">;
			user: AdmissionUser;
		}): Promise<void> {
			const kind = await deps.resolveOrganizationKind(
				member.organizationId,
				organization.metadata
			);
			const memberCount = await deps.countMembers(member.organizationId);
			if (kind === PERSONAL_ORGANIZATION_KIND) {
				if (memberCount > 0) {
					throw new APIError("BAD_REQUEST", {
						message: PERSONAL_WORKSPACE_MESSAGE,
					});
				}
				return;
			}
			const policy = organizationAdmissionPolicy(kind);
			// The signup bootstrap can stamp a company-domain account as a Teams
			// org before its verification email is completed. Permit that one
			// owner row so the account has a usable home. A newly-created shared
			// organization also needs its first owner before it has a subscription;
			// every later member requires both a paid seat and the verified-business
			// decision. A family never takes this path: it is promoted, never
			// created, so an owner row for an empty family is not a bootstrap.
			if (
				policy.ownerBootstrap &&
				memberCount === 0 &&
				memberRoleIncludesOwner(member.role)
			) {
				return;
			}
			if (policy.businessEmail) {
				requireVerifiedBusinessEmail(user);
			} else {
				refuse("FORBIDDEN", assignedRoleRefusal(policy, member.role));
				refuse("FORBIDDEN", familyVerifiedEmailRefusal(user, "member"));
			}
			const place = { organizationId: member.organizationId, userId: user.id };
			if (policy.maxPerPerson !== null) {
				await claimFamilyPlace({
					...place,
					actor: "other",
					limit: policy.maxPerPerson,
				});
			}
			await withFamilyPlace(
				policy.maxPerPerson === null ? null : place,
				async () => await deps.reserveDirectMemberSeat(place)
			);
		},

		async beforeUpdateMemberRole({
			member,
			newRole,
			user,
			organization,
		}: {
			member: { organizationId: string; role: string };
			newRole: string;
			organization: Pick<AdmissionOrganization, "metadata">;
			user: OrganizationPolicyUser;
		}): Promise<void> {
			// A role promotion is another shared-organization admission point.
			// Keep a user whose email was changed or unverified from gaining a
			// stronger organization role; demotions are always allowed. The
			// Admin API role route applies the same shared check.
			const grantsPermissions = roleChangeGrantsPermissions(
				member.role,
				newRole
			);
			const kind = await deps.resolveOrganizationKind(
				member.organizationId,
				organization.metadata
			);
			const policy = organizationAdmissionPolicy(kind);
			if (!policy.businessEmail) {
				// Family: only organizer/member, and a promotion needs a verified
				// mailbox of any domain.
				refuse("FORBIDDEN", assignedRoleRefusal(policy, newRole));
				refuse(
					"FORBIDDEN",
					grantsPermissions
						? familyVerifiedEmailRefusal(user, "organizer")
						: null
				);
				return;
			}
			refuse(
				"FORBIDDEN",
				memberRoleChangeRefusal(
					{ email: user.email, emailVerified: user.emailVerified },
					{ grantsPermissions }
				)
			);
		},

		async beforeCreateInvitation({
			invitation,
			inviter,
		}: {
			invitation: {
				email: string;
				organizationId: string;
				referralTag?: unknown;
				role: string;
				teamId?: unknown;
				teamIds?: unknown;
			};
			inviter: OrganizationPolicyUser;
		}): Promise<{ data: Record<string, unknown> }> {
			const kind = await rejectPersonalWorkspaceInvitation(
				invitation.organizationId
			);
			const policy = organizationAdmissionPolicy(kind);
			const email = normalizeInvitationEmail(invitation.email);
			if (policy.businessEmail) {
				requireVerifiedBusinessEmail(inviter);
				requireBusinessEmailDomain(invitation.email);
			} else {
				refuse("FORBIDDEN", assignedRoleRefusal(policy, invitation.role));
				refuse(
					"BAD_REQUEST",
					invitationNamesTeam(invitation) ? teamRefusal(kind) : null
				);
				refuse("FORBIDDEN", familyVerifiedEmailRefusal(inviter, "inviter"));
			}
			if (policy.maxPerPerson !== null) {
				// A nicer, earlier answer than a refusal at acceptance. Only possible
				// when the invitee already has an account; acceptance re-checks.
				const inviteeId = await deps.findUserIdByEmail(email);
				if (inviteeId) {
					await requireFamilyRoom({
						actor: "other",
						limit: policy.maxPerPerson,
						organizationId: invitation.organizationId,
						userId: inviteeId,
					});
				}
			}
			// The seat is reserved before Better Auth writes the invitation. The
			// short TTL covers a failed create; afterCreateInvitation extends it to
			// the invitation's real expiry. A pending family invitation holds one
			// of the family's six places the same way.
			await deps.reservePendingInvitationSeat({
				email,
				organizationId: invitation.organizationId,
			});
			try {
				await deps.reserveInvitationPolicy({
					email,
					organizationId: invitation.organizationId,
				});
			} catch (error) {
				// Do not strand the seat when the independent invitation policy
				// rejects this send (cooldown or decline block).
				await deps.releaseSeatClaims({
					email,
					organizationId: invitation.organizationId,
				});
				throw error;
			}
			return {
				data: {
					...invitation,
					email,
					referralTag: normalizeReferralTag(invitation.referralTag),
				},
			};
		},

		async beforeAcceptInvitation({
			invitation,
			user,
		}: {
			invitation: {
				email: string;
				id: string;
				organizationId: string;
				role: string;
				teamId?: unknown;
			};
			user: AdmissionUser;
		}): Promise<void> {
			const kind = await rejectPersonalWorkspaceInvitation(
				invitation.organizationId
			);
			const policy = organizationAdmissionPolicy(kind);
			if (policy.businessEmail) {
				requireVerifiedBusinessEmail(user);
			} else {
				// Better Auth's `requireEmailVerificationOnInvitation` already
				// requires a verified recipient. Re-check what the invitation carries
				// in case it was created under different rules.
				refuse("FORBIDDEN", assignedRoleRefusal(policy, invitation.role));
				refuse(
					"BAD_REQUEST",
					invitationNamesTeam(invitation) ? teamRefusal(kind) : null
				);
			}
			const place = {
				organizationId: invitation.organizationId,
				userId: user.id,
			};
			if (policy.maxPerPerson !== null) {
				await claimFamilyPlace({
					...place,
					actor: "self",
					limit: policy.maxPerPerson,
				});
			}
			await withFamilyPlace(
				policy.maxPerPerson === null ? null : place,
				async () =>
					await deps.reserveInvitationSeat({
						email: invitation.email,
						invitationId: invitation.id,
						organizationId: invitation.organizationId,
						userId: user.id,
					})
			);
		},

		async beforeCreateTeam<Team extends { name: string }>({
			team,
			organization,
		}: {
			organization: AdmissionOrganization;
			team: Team;
		}): Promise<{ data: Team }> {
			refuse(
				"BAD_REQUEST",
				teamRefusal(
					await deps.resolveOrganizationKind(
						organization.id,
						organization.metadata
					)
				)
			);
			const name = team.name.trim();
			if (!name) {
				throw new APIError("BAD_REQUEST", {
					message: "Team name is required.",
				});
			}
			return { data: { ...team, name } };
		},

		async beforeAddTeamMember({
			organization,
			user,
		}: {
			organization: AdmissionOrganization;
			user: OrganizationPolicyUser;
		}): Promise<void> {
			const kind = await rejectPersonalWorkspaceInvitation(
				organization.id,
				organization.metadata
			);
			refuse("BAD_REQUEST", teamRefusal(kind));
			requireVerifiedBusinessEmail(user);
		},
	};
}

export type OrganizationAdmission = ReturnType<
	typeof createOrganizationAdmission
>;
