/**
 * The signed rollout-flag claim a node's Core enforces offline.
 *
 * Better Auth's JWT `definePayload` (in `../index.ts`) adds `CORE_FLAG_CLAIM`
 * (`ryu_flags`): the catalog flags marked `coreClaim` that evaluate ON for the
 * token's user, and `CORE_FLAG_ORG_CLAIM` (`ryu_flags_org`): the organization
 * they were evaluated for. Core verifies the token against the JWKS and reads
 * both without calling the control plane (`apps/core/src/identity_verify`).
 *
 * ORG CONTEXT. The evaluation org is the session's active organization when
 * the user is a member of it, else the user's earliest membership: the same
 * choice `/subscription-status` makes (`resolveActiveOrgId` in `@ryu/api`).
 * The resolver receives that org and the caller's member role in it, so
 * org-role audiences and plan-targeted rules evaluate as they do in the
 * desktop's flag map. A user in no org is evaluated user-scoped (org `null`).
 *
 * WHY A REGISTRY AND NOT AN IMPORT. The evaluator (overrides, kill switch,
 * rollout rules, waitlist grants, audience traits) lives in `@ryu/api`, which
 * depends on `@ryu/auth`; importing it back would invert the dependency. As
 * with `referral-grant-hook.ts`, `apps/server` imports both packages and
 * registers the implementation at boot. Single slot, last wins.
 *
 * FAIL CLOSED BY OMISSION. A missing registration, a throwing resolver or a
 * non-boolean value all yield no key, so Core treats the flag as off. Token
 * issuance itself never fails because of this claim.
 *
 * STALENESS. The claim is evaluated when the token is minted and is not
 * refreshed until the next mint, so a flip reaches Core within one token
 * lifetime (Better Auth's JWT default is 15 minutes).
 */

import { z } from "zod";
import {
	CORE_FLAG_CLAIM,
	CORE_FLAG_ORG_CLAIM,
	coreFlagClaimFromValues,
} from "./feature-flags.ts";

/**
 * The user fields the resolver reads, parsed leniently from the mint input,
 * plus the org the claim is evaluated for and the caller's raw Better Auth
 * member role in it (both `null` when the user belongs to no org).
 */
export interface CoreFlagClaimSubject {
	email: string | null;
	emailVerified: boolean | null;
	id: string;
	isAnonymous: boolean | null;
	organizationId: string | null;
	orgMemberRole: string | null;
	role: string | null;
}

/** The org the claim is evaluated for, with the caller's member role in it. */
export interface CoreFlagClaimOrganization {
	id: string;
	role: string;
}

/** A membership row as `definePayload` reads it from the `member` collection. */
export interface CoreFlagClaimMembership {
	createdAt?: Date | string | null;
	id: string;
	role: string;
}

/** The evaluated claim: enabled keys and the org they were evaluated for. */
export interface CoreFlagClaim {
	keys: string[];
	organizationId: string | null;
}

const EMPTY_CLAIM: CoreFlagClaim = { keys: [], organizationId: null };

/** Returns the evaluated flag map for the subject; `@ryu/api` provides it. */
export type CoreFlagClaimResolver = (
	subject: CoreFlagClaimSubject
) => Promise<Readonly<Record<string, unknown>>>;

let resolver: CoreFlagClaimResolver | null = null;

/**
 * Upper bound on evaluation per mint. The evaluator's own reads are cached;
 * this only stops a stalled database from stalling sign-in. A timeout omits
 * the claim (fail closed) rather than delaying the token.
 */
const RESOLVE_TIMEOUT_MS = 2000;

const TIMED_OUT = Symbol("core-flag-claim-timeout");

async function withTimeout<T>(
	work: Promise<T>,
	timeoutMs: number
): Promise<T | typeof TIMED_OUT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function membershipTime(membership: CoreFlagClaimMembership): number {
	const time = membership.createdAt
		? new Date(membership.createdAt).getTime()
		: Number.NaN;
	return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * The org a claim is evaluated for: the session's active org when the user is
 * a member of it, else their earliest membership, else `null`. Mirrors
 * `resolveActiveOrgId` (`@ryu/api/lib/credits`) on the rows `definePayload`
 * already loaded, so the token and `/subscription-status` agree on the org
 * without a second read. An active org the user is not a member of is ignored.
 */
export function selectCoreFlagClaimOrganization(
	activeOrganizationId: string | null | undefined,
	memberships: readonly CoreFlagClaimMembership[]
): CoreFlagClaimOrganization | null {
	const active = activeOrganizationId?.trim();
	const activeMembership = active
		? memberships.find((membership) => membership.id === active)
		: undefined;
	if (activeMembership) {
		return { id: activeMembership.id, role: activeMembership.role };
	}
	let earliest: CoreFlagClaimMembership | undefined;
	for (const membership of memberships) {
		if (!earliest || membershipTime(membership) < membershipTime(earliest)) {
			earliest = membership;
		}
	}
	return earliest ? { id: earliest.id, role: earliest.role } : null;
}

/** Install the evaluator. Called once, from `apps/server` boot. */
export function registerCoreFlagClaimResolver(
	implementation: CoreFlagClaimResolver | null
): void {
	resolver = implementation;
}

const subjectSchema = z.object({
	id: z.string().min(1),
	email: z.string().nullish().catch(null),
	emailVerified: z.boolean().nullish().catch(null),
	isAnonymous: z.boolean().nullish().catch(null),
	role: z.string().nullish().catch(null),
});

/**
 * The enabled `coreClaim` keys for a user in `organization` (the result of
 * {@link selectCoreFlagClaimOrganization}, or `null` for a user in no org).
 * NEVER THROWS AND NEVER REJECTS: its caller mints every token, so any failure
 * resolves to no keys.
 */
export async function resolveCoreFlagClaim(
	user: unknown,
	organization: CoreFlagClaimOrganization | null = null,
	timeoutMs: number = RESOLVE_TIMEOUT_MS
): Promise<CoreFlagClaim> {
	const implementation = resolver;
	if (!implementation) {
		return EMPTY_CLAIM;
	}
	const parsed = subjectSchema.safeParse(user);
	if (!parsed.success) {
		return EMPTY_CLAIM;
	}
	const organizationId = organization?.id ?? null;
	try {
		const values = await withTimeout(
			implementation({
				email: parsed.data.email ?? null,
				emailVerified: parsed.data.emailVerified ?? null,
				id: parsed.data.id,
				isAnonymous: parsed.data.isAnonymous ?? null,
				organizationId,
				orgMemberRole: organization?.role ?? null,
				role: parsed.data.role ?? null,
			}),
			timeoutMs
		);
		if (values === TIMED_OUT) {
			console.error("[auth] core flag claim evaluation timed out");
			return EMPTY_CLAIM;
		}
		return { keys: coreFlagClaimFromValues(values), organizationId };
	} catch (error) {
		console.error("[auth] core flag claim evaluation failed:", error);
		return EMPTY_CLAIM;
	}
}

/**
 * Add the claim to a JWT payload. Both keys are omitted when no flag is
 * enabled, which Core reads identically to an empty list, so most tokens stay
 * unchanged. When present, `ryu_flags_org` is the evaluation org or `null`.
 */
export function withCoreFlagClaim<T extends object>(
	payload: T,
	claim: CoreFlagClaim
): T & {
	[CORE_FLAG_CLAIM]?: string[];
	[CORE_FLAG_ORG_CLAIM]?: string | null;
} {
	if (claim.keys.length === 0) {
		return payload;
	}
	return {
		...payload,
		[CORE_FLAG_CLAIM]: [...claim.keys],
		[CORE_FLAG_ORG_CLAIM]: claim.organizationId,
	};
}
