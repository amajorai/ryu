import { Member, TeamMember } from "@ryu/db/models/control-plane.model";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { z } from "zod";
import {
	resolveCoreFlagClaim,
	selectCoreFlagClaimOrganization,
	withCoreFlagClaim,
} from "../lib/core-flag-claim.ts";
import {
	jwtIdentityClaims,
	jwtSessionBindingClaims,
} from "../lib/jwt-identity-claims.ts";
import {
	admitJwtOrgMemberships,
	jwtOrgAccessUnavailable,
} from "../lib/jwt-org-access.ts";
import { resolveCoreLimitsClaim, withCoreLimitsClaim } from "../lib/plans.ts";
import { flagClaimSessionSchema } from "./schemas.ts";
import { resolveTeamClaims } from "./team-claims.ts";

// The JWT plugin and the claims Ryu issues in its tokens.

export const jwtPlugins = [
	jwt({
		// Mint only on `GET /api/auth/token`. With the header on, Better Auth
		// would also mint (and run `definePayload`, with its roster reads and
		// org policy evaluation) on every `/get-session`, including every
		// control-plane request's `createContext`. Nothing reads
		// `set-auth-jwt`, and a mint that can fail (see below) must never fail
		// a session read. The MFA-enrollment and support-access plugins still
		// strip the header as defense in depth.
		disableSettingJwtHeader: true,
		jwt: {
			// Enrich the JWT so a node's Core can verify org + team membership and
			// role OFFLINE (it validates the signature against the JWKS, no live call
			// to better-auth). The session carries only the ACTIVE org, so we
			// resolve every org the user belongs to from the `member`
			// collection, and every team from `teamMember`, the same sources of truth
			// the control plane reads from. Core narrows both to its bound org.
			// The payload always carries `email_verified`, so Core never treats an
			// unproven address as one the caller owns when an app grants access by
			// email, and `ryu_sid` (lib/jwt-identity-claims.ts), the id of the
			// session the token is minted from: the control plane accepts a token
			// Core forwards only while that session is live, and applies that
			// session's step-up grants and access policy to it. `iss`, `aud` and
			// `sub` are never set here; Better Auth stamps them.
			// `ryu_flags` (lib/core-flag-claim.ts) carries the enabled rollout flags
			// Core enforces offline, evaluated for the session's active org (or the
			// earliest membership) with the caller's role in it; `ryu_flags_org`
			// names that org. It waits only on the org roster, never rejects, and is
			// omitted (flags off) on any failure, including a roster read failure.
			// `ryu_limits` (`CORE_LIMITS_CLAIM` in lib/plans.ts) carries the same
			// org's Box concurrency cap, `{ boxConcurrency }`, and is omitted on
			// any failure, so Core falls back to the Box service's own limits.
			// Each org's access policy (IP allowlist, required two-factor, session
			// max age; lib/jwt-org-access.ts) is applied to this mint first: an org
			// that refuses this session is left out of `orgs`, `teams` and the
			// `ryu_flags_org` choice, so its nodes never see this caller as a member.
			// When the roster or that policy cannot be read, the mint FAILS with a
			// 503 the client retries, instead of going out without the org claims
			// (which would lock an org member out for the token's lifetime with
			// no signal). A user with no memberships never consults the policy.
			// The team roster still degrades to no teams (teams are additive and
			// fail closed), as do the flags.
			definePayload: async ({ user, session }) => {
				const base = {
					...jwtIdentityClaims(user),
					...jwtSessionBindingClaims(session),
				};
				// A support (impersonation) session never gets a token: `/token` is
				// already outside every support scope, this is defense in depth.
				if (
					z.object({ impersonatedBy: z.string().min(1) }).safeParse(session)
						.success
				) {
					throw new APIError("FORBIDDEN", {
						code: "SUPPORT_SESSION_JWT_REFUSED",
						message: "A support session cannot mint a token",
					});
				}
				const activeOrganizationId =
					flagClaimSessionSchema.parse(session).activeOrganizationId ?? null;
				// `exec()` so the roster runs once: both the flag claim and the
				// roster below await this promise, and a mongoose Query re-executes
				// on every `then`. Only memberships whose org policy admits this
				// mint go further; an undecidable policy rejects the mint.
				const memberRows = Member.find({ userId: user.id })
					.lean()
					.exec()
					.then((rows) => admitJwtOrgMemberships(rows, { session, user }));
				// `{ organization }` once the roster is read, null when it failed.
				const claimOrganization = memberRows.then(
					(rows) => ({
						organization: selectCoreFlagClaimOrganization(
							activeOrganizationId,
							rows.map((row) => ({
								createdAt: row.createdAt ?? null,
								id: String(row.organizationId),
								role: row.role,
							}))
						),
					}),
					() => null
				);
				const coreFlags = claimOrganization.then((selected) =>
					selected
						? resolveCoreFlagClaim(user, selected.organization)
						: { keys: [], organizationId: null }
				);
				const coreLimits = claimOrganization.then((selected) =>
					resolveCoreLimitsClaim(selected?.organization?.id ?? null)
				);
				// The two rosters are independent, so they overlap. The team
				// roster's `catch` keeps a team-roster failure from rejecting the
				// pair: teams are additive, org claims are not.
				const rosters = await Promise.all([
					memberRows,
					TeamMember.find({ userId: user.id })
						.lean()
						.catch((error) => {
							console.error(
								"Failed to read team memberships:",
								z
									.union([z.instanceof(Error), z.json()])
									.nullable()
									.catch(null)
									.parse(error)
							);
							return [];
						}),
				]).catch((error) => {
					console.error("Failed to embed org memberships in JWT:", error);
					return null;
				});
				if (!rosters) {
					throw jwtOrgAccessUnavailable();
				}
				const [members, teamRows] = rosters;
				// Both id fields are ObjectId on disk; the claim is a JSON string
				// id, and Core compares it as text. Stringify at the boundary
				// rather than relying on `ObjectId.toJSON()` at serialize time,
				// so the in-process value matches what the token carries.
				const orgs = members.map((member) => ({
					id: String(member.organizationId),
					role: member.role,
				}));
				const teams = await resolveTeamClaims(
					user.id,
					teamRows.map((row) => String(row.teamId)),
					orgs
				);
				return withCoreLimitsClaim(
					withCoreFlagClaim({ ...base, orgs, teams }, await coreFlags),
					await coreLimits
				);
			},
		},
	}),
] satisfies NonNullable<BetterAuthOptions["plugins"]>;
