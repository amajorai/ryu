/**
 * Organization membership for a user arriving through an organization-bound
 * SSO provider.
 *
 * `@better-auth/sso` can provision this membership itself, but it writes the
 * `member` row through the raw adapter. That skips the organization plugin's
 * `beforeAddMember` hook, so the paid-seat reservation and the verified
 * business-email gate that every invitation and direct add passes would not
 * run, and a verified domain could grow membership past the billed seats.
 * Ryu therefore disables plugin provisioning and admits the user here through
 * the organization plugin's own `addMember`, which runs those hooks.
 */

/** How the membership for an SSO login was settled. */
export type SsoMembershipOutcome =
	/** Already a member before this login. */
	| { kind: "member" }
	/** Admitted by this login through the seat-gated path. */
	| { kind: "joined" }
	/** A pending invitation exists; the user accepts it instead. */
	| { kind: "invitation-pending" }
	/** The seat or business-email gate (or a write) refused the admission. */
	| { kind: "refused"; error: unknown };

/** The reads and the one write the decision needs, injected for tests. */
export interface SsoMembershipStore {
	/** Admit through the organization plugin so its admission hooks run. */
	addMember(input: { organizationId: string; userId: string }): Promise<void>;
	/** True while a pending, unexpired invitation exists for this email. */
	hasPendingInvitation(input: {
		email: string;
		organizationId: string;
	}): Promise<boolean>;
	/** True when the user already belongs to the organization. */
	isMember(input: { organizationId: string; userId: string }): Promise<boolean>;
}

/**
 * Settle the SSO organization's membership for this user. A refusal is
 * returned rather than thrown: the identity provider has already proven who
 * the user is, so the sign-in completes and only the organization access waits
 * for a free seat (or a verified business email).
 */
export async function settleSsoMembership(
	input: {
		organizationId: string;
		user: { email: string; id: string };
	},
	store: SsoMembershipStore
): Promise<SsoMembershipOutcome> {
	const membership = {
		organizationId: input.organizationId,
		userId: input.user.id,
	};
	if (await store.isMember(membership)) {
		return { kind: "member" };
	}
	// Match the plugin's own behavior: an outstanding invitation already holds
	// a seat claim, and accepting it is how this user joins.
	if (
		await store.hasPendingInvitation({
			email: input.user.email.toLowerCase(),
			organizationId: input.organizationId,
		})
	) {
		return { kind: "invitation-pending" };
	}
	try {
		await store.addMember(membership);
		return { kind: "joined" };
	} catch (error) {
		// A concurrent callback for the same user may have admitted them first.
		if (await store.isMember(membership)) {
			return { kind: "member" };
		}
		return { error, kind: "refused" };
	}
}
