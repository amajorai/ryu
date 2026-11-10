import { User } from "@ryu/db/models/auth.model";
import { Team } from "@ryu/db/models/control-plane.model";
import { reconciledAdminRole } from "../lib/waitlist.ts";

// Organization and team claims carried by sessions and tokens, and the
// platform admin role reconciliation.

interface OrgClaim {
	id: string;
	role: string;
}

/** Mirrors Core's `TeamMembership` — the keys are a wire contract, keep them short. */
export interface TeamClaim {
	id: string;
	org: string;
	role: string;
}

/**
 * Resolves the team claims embedded in a user's JWT, given the org claims already
 * resolved for the same payload.
 *
 * Better Auth's `teamMember` row carries no role of its own (verified against the
 * organization plugin's schema), so a team's effective role is the user's role in
 * the team's owning org — hence the join back through `orgs`. A team whose org is
 * not in `orgs` is dropped: a team is only ever reachable through its org, which
 * is exactly what Core narrows on, so carrying it would only inflate every token.
 *
 * Never throws. Teams are additive to a payload that already works, so a failure
 * here degrades to "no teams" (fail closed for team access) instead of failing
 * the whole mint the way an unreadable org roster does.
 */
export async function resolveTeamClaims(
	userId: string,
	teamIds: string[],
	orgs: OrgClaim[]
): Promise<TeamClaim[]> {
	if (teamIds.length === 0) {
		return [];
	}
	try {
		// `org.id` and `team.organizationId` are both ObjectId-backed (see the
		// schema note in `control-plane.model.ts`), so BOTH the key and the lookup
		// go through `String(...)`. Comparing them raw type-checks but misses by
		// reference — two ObjectId instances for the same id are never `===` — and
		// the `flatMap` would then drop every team, shipping `teams: []` in every
		// token with nothing logged. Normalizing only the lookup side is the same
		// bug wearing a green typecheck.
		const roleByOrg = new Map(orgs.map((org) => [String(org.id), org.role]));
		const teams = await Team.find({ _id: { $in: teamIds } }).lean();
		return teams.flatMap((team) => {
			const org = String(team.organizationId);
			const role = roleByOrg.get(org);
			return role ? [{ id: String(team._id), org, role }] : [];
		});
	} catch (error) {
		console.error("Failed to resolve teams for JWT:", error, { userId });
		return [];
	}
}

/**
 * Make the stored role agree with the admin allowlist for a VERIFIED address.
 *
 * The user-create hook writes the role once, from `isVerifiedAdminEmail(user)`.
 * An address added to `ADMIN_EMAILS` after its account existed, or one whose
 * mailbox was proven after sign-up, would otherwise never receive it. Server
 * gates that see the session user (`requirePlatformAdmin`, `isAdmin` with
 * `emailVerified`) already admit such a verified address, but gates that read
 * only the stored role, every client-side admin affordance, and the Better Auth
 * admin plugin's `adminRoles` check do not until this runs. It runs on session
 * create, on `afterEmailVerification`, and when an update verifies the mailbox.
 *
 * The reverse also holds: an allowlisted address that is NOT verified loses an
 * `ADMIN_ROLE` it carries (stamped before verification was required) and goes
 * back to the signup role, so an unproven address never keeps admin. Proving
 * the mailbox promotes it again. An unlisted admin (granted through the admin
 * plugin) is left alone.
 *
 * Fail-open: a lookup error must never block login.
 */
export async function reconcileAdminRole(userId: string): Promise<void> {
	try {
		const record = await User.findById(userId)
			.select("email emailVerified role")
			.lean<{ email?: string; emailVerified?: boolean; role?: string }>();
		if (!record) {
			return;
		}
		// Only a verified address earns the durable role; an unverified one is
		// promoted later, by `afterEmailVerification` or the next session.
		const role = reconciledAdminRole(record);
		if (!role) {
			return;
		}
		// Conditional on the role read above, so a concurrent change wins.
		await User.updateOne(
			{ _id: userId, role: record.role ?? null },
			{ $set: { role } }
		);
	} catch (error) {
		console.error("Failed to reconcile admin role:", error);
	}
}
