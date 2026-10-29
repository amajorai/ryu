import { randomUUID } from "node:crypto";
import { User } from "@ryu/db/models/auth.model";
import {
	Member,
	Organization,
	PersonalOrganizationClaim,
} from "@ryu/db/models/control-plane.model";
import { z } from "zod";
import { businessEmailDomainDecision } from "./organization-email-policy.ts";
import {
	ORGANIZATION_KIND_RECORD_FIELDS,
	type OrganizationKindRecord,
	type OrganizationMetadata,
	organizationKindFromRecord,
	personalOrganizationIdForEarliestMembership,
} from "./organization-kind.ts";

/**
 * The single organization-plugin endpoint this module needs. `auth.api` is
 * typed via deep inference that collapses when the betterAuth options have any
 * pre-existing type error, so we narrow to just `createOrganization` at the call
 * site (the org plugin guarantees it at runtime) rather than depending on the
 * full inferred surface.
 */
export interface OrganizationApi {
	createOrganization: (args: {
		body: {
			metadata?: OrganizationMetadata;
			name: string;
			slug: string;
			userId: string;
			keepCurrentActiveOrganization?: boolean;
		};
	}) => Promise<{ id: string } | null> | Promise<void>;
}

/** The organization endpoint's invitation fields used by sender cancellation. */
interface OrganizationInvitationRecord {
	expiresAt?: Date | string;
	id: string;
	status?: string;
}
const invitationSchema = z.object({
	id: z.string(),
	status: z.string().optional(),
	expiresAt: z.union([z.date(), z.string()]).optional(),
});
const invitationsSchema = z
	.union([
		z.array(invitationSchema),
		z
			.object({ invitations: z.array(invitationSchema).optional() })
			.transform((value) => value.invitations ?? []),
	])
	.catch(() => []);
export interface OrganizationInvitationApi {
	cancelInvitation: (args: {
		body: { invitationId: string };
		headers: Headers;
	}) => Promise<{ id: string } | null> | Promise<void>;
	listInvitations: (args: {
		query: { organizationId: string };
		headers: Headers;
	}) => Promise<
		| OrganizationInvitationRecord[]
		| { invitations?: OrganizationInvitationRecord[] }
	>;
}

export type OrganizationInvitationCancelResult =
	| { changed: boolean; status: "canceled" }
	| { changed: false; status: "accepted" | "rejected" | "expired" }
	| { changed: false; status: "not_found" };

/**
 * Cancel a sender-owned invitation through Better Auth's organization plugin.
 *
 * The list-before-cancel guard is important: Better Auth's mutation is the
 * authoritative write, but its low-level endpoint will mark even a terminal
 * invitation as canceled. We only invoke it for the live pending invitation
 * in the requested organization. Repeating a canceled request is a safe
 * no-op, and an accepted/rejected/expired request is never rewritten.
 */
export async function cancelOrganizationInvitation(
	api: OrganizationInvitationApi,
	args: {
		headers: Headers;
		invitationId: string;
		organizationId: string;
		now?: Date;
	}
): Promise<OrganizationInvitationCancelResult> {
	const response = await api.listInvitations({
		query: { organizationId: args.organizationId },
		headers: args.headers,
	});
	const invitations = invitationsSchema.parse(response);
	const invitation = invitations.find(
		(value) => value.id === args.invitationId
	);

	if (!invitation) {
		return { changed: false, status: "not_found" };
	}
	if (invitation.status !== "pending") {
		return {
			changed: false,
			status:
				invitation.status === "canceled"
					? "canceled"
					: invitation.status === "accepted"
						? "accepted"
						: "rejected",
		};
	}
	const expiresAt = invitation.expiresAt
		? new Date(invitation.expiresAt).getTime()
		: Number.POSITIVE_INFINITY;
	if (expiresAt <= (args.now ?? new Date()).getTime()) {
		return { changed: false, status: "expired" };
	}

	await api.cancelInvitation({
		body: { invitationId: args.invitationId },
		headers: args.headers,
	});
	return { changed: true, status: "canceled" };
}

/** The outcome of claiming an invitation's pending -> canceled transition. */
export type InvitationCancellationClaim =
	| { won: true }
	| { status: string | null; won: false };

/** Better Auth's Mongo adapter stores ids as ObjectIds; callers pass hex strings. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/iu;

const storedInvitationStatusSchema = z
	.object({ status: z.string().nullish().catch(null) })
	.nullable()
	.transform((row) => (row ? (row.status ?? null) : null));

/**
 * Claim one invitation's terminal transition for a cancellation, atomically.
 *
 * Better Auth's `accept-invitation` claims the same row with a
 * `pending -> accepted` compare-and-set (`fromStatus: "pending"`) before it
 * creates the member, but its `cancel-invitation` writes `canceled` by id with
 * no expected status. Running this from `beforeCancelInvitation` makes the
 * native cancel share the single pending transition: when it wins, the accept
 * that raced it fails before membership exists (Better Auth's own later write
 * of `canceled` is then a no-op); when acceptance already won, the caller is
 * told the real status and must refuse instead of rewriting an accepted
 * invitation as canceled while its member row stays.
 */
export async function claimPendingInvitationCancellation(
	invitationId: string
): Promise<InvitationCancellationClaim> {
	const ids: (string | InstanceType<typeof Member.base.Types.ObjectId>)[] =
		OBJECT_ID_HEX.test(invitationId)
			? [invitationId, new Member.base.Types.ObjectId(invitationId)]
			: [invitationId];
	// Better Auth owns this collection; its rows carry either id form.
	const invitations = Member.db.collection<{
		_id: string | InstanceType<typeof Member.base.Types.ObjectId>;
		status?: string | null;
	}>("invitation");
	const claimed = await invitations.updateOne(
		{ _id: { $in: ids }, status: "pending" },
		{ $set: { status: "canceled" } }
	);
	if (claimed.matchedCount === 1) {
		return { won: true };
	}
	const current = await invitations.findOne(
		{ _id: { $in: ids } },
		{ projection: { status: 1 } }
	);
	return { status: storedInvitationStatusSchema.parse(current), won: false };
}

/** How long one heal may hold a user's claim before another may take it over. */
const PERSONAL_ORGANIZATION_CLAIM_TTL_MS = 120_000;
const duplicateKeyErrorSchema = z.object({ code: z.literal(11_000) });

/** The persistence seams `ensurePersonalOrganization` needs, injectable for tests. */
export interface PersonalOrganizationDeps {
	/**
	 * Take the per-user heal claim. Returns this call's claim key, or null while
	 * another heal for the same user holds an unexpired claim.
	 */
	claim: (userId: string) => Promise<string | null>;
	/** The fields the provisioning decision reads, or null for a missing user. */
	findUser: (
		userId: string
	) => Promise<{ email?: string | null; isAnonymous?: boolean } | null>;
	/** Whether the user already has any organization membership. */
	hasMembership: (userId: string) => Promise<boolean>;
	/** Release a claim this call took. The TTL is only a crash backstop. */
	release: (userId: string, claimKey: string) => Promise<void>;
}

async function claimPersonalOrganization(
	userId: string
): Promise<string | null> {
	const claimKey = randomUUID();
	const now = new Date();
	try {
		// `_id` = userId is the unique key: a live claim makes the upsert's insert
		// fail with a duplicate key, while an expired one is taken over in place.
		const claim = await PersonalOrganizationClaim.findOneAndUpdate(
			{ _id: userId, expiresAt: { $lte: now } },
			{
				$set: {
					claimKey,
					expiresAt: new Date(
						now.getTime() + PERSONAL_ORGANIZATION_CLAIM_TTL_MS
					),
				},
				$setOnInsert: { createdAt: now },
			},
			{ new: true, upsert: true }
		).lean<{ claimKey?: string }>();
		return claim?.claimKey === claimKey ? claimKey : null;
	} catch (error) {
		if (duplicateKeyErrorSchema.safeParse(error).success) {
			return null;
		}
		throw error;
	}
}

const defaultPersonalOrganizationDeps: PersonalOrganizationDeps = {
	claim: claimPersonalOrganization,
	findUser: (userId) =>
		User.findById(userId)
			.select("email isAnonymous")
			.lean<{ email?: string | null; isAnonymous?: boolean }>(),
	hasMembership: async (userId) => Boolean(await Member.exists({ userId })),
	release: async (userId, claimKey) => {
		await PersonalOrganizationClaim.deleteOne({ _id: userId, claimKey });
	},
};

/**
 * Idempotently gives a user the default one-person organization. Returns `created: false`
 * without writing when the user already has any membership, so this is safe to
 * call from the sign-up hook (which may fire more than once) and to re-run from
 * the backfill script after a partial failure.
 *
 * Concurrency: the membership check alone is check-then-create, and Better
 * Auth's createOrganization has no unique guard, so two concurrent heals (two
 * logins at once, or a login racing the backfill) would each mint an org. A
 * per-user `PersonalOrganizationClaim` serializes them: the loser returns
 * `created: false` and the session hook re-reads until the winner's membership
 * lands. Membership is re-checked after claiming, because a heal that finished
 * and released between the first check and the claim must win.
 *
 * Guests never get an organization, matching the `session.create.before`
 * policy for anonymous users.
 *
 * Server-side path: passes `userId` with no session headers, which the org
 * plugin uses to create the org on that user's behalf and assign them the
 * configured `creatorRole` ("owner") plus the backing `member` row — the
 * control plane's single source of truth for membership.
 *
 * Org naming is intentionally generic ("Personal") with a random, collision-free
 * slug so a freshly-signed-up user always lands in a valid org context. The
 * organization hook owns the final kind marker; a consumer-email account stays
 * personal, while a company-domain account is provisioned into the Teams
 * boundary and must verify before it can add members or check out.
 */
export async function ensurePersonalOrganization(
	userId: string,
	api: OrganizationApi,
	deps: PersonalOrganizationDeps = defaultPersonalOrganizationDeps
): Promise<{ created: boolean }> {
	if (await deps.hasMembership(userId)) {
		return { created: false };
	}
	const user = await deps.findUser(userId);
	if (user?.isAnonymous) {
		return { created: false };
	}

	const claimKey = await deps.claim(userId);
	if (!claimKey) {
		// Another heal for this user is in flight and will create the org.
		return { created: false };
	}
	try {
		if (await deps.hasMembership(userId)) {
			return { created: false };
		}
		const slug = `personal-${randomUUID()}`;
		const organizationKind = businessEmailDomainDecision(user?.email).allowed
			? "teams"
			: "personal";
		await api.createOrganization({
			body: {
				name: "Personal",
				slug,
				userId,
				metadata: { organizationKind },
				// No session is involved on this server-side path, so don't try to mutate
				// an active organization on a (non-existent) session.
				keepCurrentActiveOrganization: true,
			},
		});
		return { created: true };
	} finally {
		// Release at once so a failed attempt can be retried immediately. A failed
		// release only delays the next heal until the claim expires.
		await deps.release(userId, claimKey).catch((error: unknown) => {
			console.warn("Failed to release personal organization claim:", error);
		});
	}
}

/**
 * Resolve the earliest membership, which is the codebase's definition of a
 * user's personal organization, unless that same organization has completed a
 * paid in-place conversion to Teams. The conversion keeps the organization id
 * and all data, so every caller that needs personal-vs-shared semantics must
 * honour the durable kind marker rather than treating the first membership as
 * permanently personal. A family org remains its OWNER's personal org (the Max
 * subscription, gifts and payouts stay there) and is never a non-owner
 * member's; see `personalOrganizationIdForEarliestMembership`.
 */
export async function resolvePersonalOrgId(
	userId: string
): Promise<string | null> {
	const member = await Member.findOne({ userId }).sort({ createdAt: 1 });
	if (!member) {
		return null;
	}
	const organization = await Organization.findById(member.organizationId)
		.select(ORGANIZATION_KIND_RECORD_FIELDS)
		.lean<OrganizationKindRecord>();
	return personalOrganizationIdForEarliestMembership({
		// The top-level field is authoritative; metadata alone can be stale
		// after a Better Auth update raced a family enable/disable.
		kind: organizationKindFromRecord(organization),
		organizationId: String(member.organizationId),
		role: member.role,
	});
}

/** Re-reads after a lost heal claim: ~750 ms total, only on the race path. */
const CONCURRENT_HEAL_RETRY_DELAYS_MS = [250, 250, 250] as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Decide which organization a NEW SESSION starts scoped to, healing the user
 * first if they have none.
 *
 * Every org-scoped read in the control plane resolves membership through the
 * `member` collection, so a user with zero rows there is not merely unscoped —
 * they are permanently refused. `GET /api/credits/wallet` answers 409 ("no
 * active organization") on every request and every SSE reconnect, for the life
 * of the session, and no client retry can clear it.
 *
 * `ensurePersonalOrganization` already runs in the sign-up hook, but that hook
 * is deliberately FAIL-OPEN — it logs and lets sign-up succeed — so a transient
 * error there mints an account that is org-less forever. Users created before
 * auto-provisioning landed are in the same state. Session create is the right
 * place to repair both: it is the one moment every affected user passes through,
 * it happens once per login rather than per request, and it fixes every
 * org-scoped surface at once instead of one route at a time.
 *
 * Dependency-injected rather than reaching for `Member` and `auth.api` directly:
 * the ORDER here (look up → ensure → look up AGAIN) is the entire fix, and the
 * re-query is easy to drop in a refactor because `ensurePersonalOrganization`
 * reports only whether it created something, never which org. Injecting lets
 * that order be asserted without a database.
 *
 * When the re-read is still empty, a concurrent heal (another login, or the
 * backfill) may hold the user's claim and still be creating the org, so the
 * lookup is retried briefly rather than starting this session unscoped.
 *
 * Returns null only when the heal itself failed to produce a membership; the
 * caller stays fail-open and lets the session start unscoped rather than
 * blocking login.
 */
export async function resolveInitialActiveOrganization(deps: {
	/** Create the user's default organization if they have no membership. */
	ensureOrganization: (userId: string) => Promise<void>;
	/** Earliest membership for the user — the default org — or null. */
	findEarliestMembership: (userId: string) => Promise<string | null>;
	userId: string;
	/** Pause between re-reads while a concurrent heal finishes. */
	wait?: (ms: number) => Promise<void>;
}): Promise<string | null> {
	const existing = await deps.findEarliestMembership(deps.userId);
	if (existing) {
		// The overwhelmingly common path: one read, no write, on every login.
		return existing;
	}
	await deps.ensureOrganization(deps.userId);
	// `ensureOrganization` reports creation, not identity, so the id has to come
	// from a second read.
	const healed = await deps.findEarliestMembership(deps.userId);
	if (healed) {
		return healed;
	}
	const wait = deps.wait ?? sleep;
	for (const delayMs of CONCURRENT_HEAL_RETRY_DELAYS_MS) {
		// Sequential by design: each re-read waits for the winner's write.
		await wait(delayMs);
		const membership = await deps.findEarliestMembership(deps.userId);
		if (membership) {
			return membership;
		}
	}
	return null;
}
