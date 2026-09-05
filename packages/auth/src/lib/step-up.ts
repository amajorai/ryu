import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import {
	StepUpAttempt,
	StepUpChallenge,
	StepUpGrant,
	type StepUpMethod,
} from "@ryu/db/models/step-up.model";
import { StepUpOTPEmail, sendEmail } from "@ryu/email";

/**
 * Step-up ("sudo mode") authentication: re-proving a second factor immediately
 * before an irreversible action, on a session that is ALREADY signed in.
 *
 * Why this exists separately from sign-in 2FA: a login proves who opened the
 * session, hours or weeks ago. It says nothing about who is holding the laptop
 * when someone clicks "delete organization" — the exact moment a stolen cookie,
 * an unlocked machine or a session-riding XSS is worth the most. Every scope
 * below is an action with no undo, or one that hands over control of somebody
 * else's data.
 *
 * The primitive is Better Auth's own two-factor verification. Its
 * `verifyTwoFactor` helper already has a signed-in branch: with a live session
 * it verifies the code and returns 200 WITHOUT minting a new session, which is
 * exactly a possession proof. This module records the successful proof so the
 * control-plane handlers — which are plain Hono routes, not Better Auth
 * endpoints — can require it.
 *
 * The record is keyed by session id, never by user id: proving TOTP in one
 * browser must not silently arm the same account's other logged-in devices.
 */

/**
 * The families of dangerous action a step-up unlocks. Deliberately coarse — a
 * scope per action would mean an admin re-typing a code between two clicks in
 * the same queue, and a gate people route around is worse than no gate.
 */
export const STEP_UP_SCOPES = [
	/** Delete an organization / workspace outright. */
	"org.delete",
	/** Membership and control: remove a member, change a role, hand over ownership. */
	"org.members",
	/** Organization-owned feature access controls. */
	"org.features",
	/** Long-lived secrets: gateway keys, API keys, the provider key vault. */
	"org.credentials",
	/** Cloud nodes: schedule removal, transfer, or destroy live infrastructure. */
	"node.destroy",
	/** Card-funded billing: top-ups, plan changes, subscriptions, and purchases. */
	"billing",
	/** Any Ryu-staff (platform-admin) mutation, in /admin and its routers. */
	"platform.admin",
	/**
	 * Fold another account into this one (see `docs/account-merge.md`). The one
	 * account-level action that IS listed, because unlike the three below it is
	 * not self-gated: the request body carries no password, and the confirmation
	 * mail that follows goes to the OTHER address — so without this, a stolen
	 * session plus access to any second mailbox the attacker already controls is
	 * enough to absorb someone's account.
	 */
	"account.merge",
] as const;

/**
 * Three account-level actions are DELIBERATELY not in that list, because each
 * already carries a re-authentication of its own and a second one would be
 * friction bought with nothing:
 *
 *   - `/change-password` and `/two-factor/disable` both require the current
 *     password in their request body.
 *   - `/change-email` does not take effect on the click: Better Auth mails a
 *     confirmation link to the EXISTING address, so it is already gated on the
 *     same mailbox our emailed fallback would test.
 *
 * Self-serve account deletion has no scope because it has no endpoint —
 * `user.deleteUser` is off in this config. Turning it on means adding a scope
 * and a `STEP_UP_AUTH_PATHS` entry in the same change; deleting an account is
 * the one account-level action with nothing else standing in front of it.
 */

export type StepUpScope = (typeof STEP_UP_SCOPES)[number];

export type { StepUpMethod };

/** The wire code a gated endpoint returns so a client knows to prompt. */
export const STEP_UP_REQUIRED = "STEP_UP_REQUIRED";

const MINUTE_MS = 60 * 1000;

/**
 * How long one proof stays good, per scope.
 *
 * Short by default: a step-up is meant to cover the action the user is taking
 * right now, not the rest of the afternoon. `platform.admin` gets the long
 * window because staff work queues — thirty moderation decisions in a row —
 * and a five-minute window there buys nothing but re-prompt fatigue, since the
 * whole session is already staff-privileged either way.
 */
const WINDOW_MS: Record<StepUpScope, number> = {
	"org.delete": 5 * MINUTE_MS,
	"org.members": 10 * MINUTE_MS,
	"org.features": 10 * MINUTE_MS,
	"org.credentials": 10 * MINUTE_MS,
	"node.destroy": 5 * MINUTE_MS,
	billing: 5 * MINUTE_MS,
	"platform.admin": 30 * MINUTE_MS,
	"account.merge": 5 * MINUTE_MS,
};

/** True when `value` is one of the known scopes. */
export function isStepUpScope(value: unknown): value is StepUpScope {
	return (
		typeof value === "string" &&
		(STEP_UP_SCOPES as readonly string[]).includes(value)
	);
}

/** The lifetime of a fresh grant for `scope`, in milliseconds. */
export function stepUpWindowMs(scope: StepUpScope): number {
	return WINDOW_MS[scope];
}

/**
 * Which factors this user can actually prove right now.
 *
 * With 2FA enrolled it is the authenticator app plus the printed recovery
 * codes, and the emailed code as the fallback the sign-in flow already offers.
 * WITHOUT 2FA enrolled the only thing we can ask for is the emailed code —
 * weaker than a real second factor (it falls to whoever holds the mailbox), but
 * still useful for non-financial account actions. Card-funded actions are a
 * deliberate exception: they require an enrolled authenticator and never fall
 * back to mailbox possession.
 */
export function stepUpMethods(user: {
	twoFactorEnabled?: boolean | null;
}): StepUpMethod[] {
	return user.twoFactorEnabled ? ["totp", "otp", "backup"] : ["otp"];
}

/**
 * The factors a particular action may accept. Billing deliberately accepts
 * only the live authenticator code when 2FA is enabled: an emailed fallback
 * would weaken a card-funded action back to mailbox possession.
 */
export function stepUpMethodsForScope(
	user: { twoFactorEnabled?: boolean | null },
	scope: StepUpScope
): StepUpMethod[] {
	if (scope === "billing") {
		return user.twoFactorEnabled ? ["totp"] : [];
	}
	return stepUpMethods(user);
}

/**
 * Billing step-up is mandatory. A card-funded mutation must never be authorized
 * by a session cookie plus mailbox possession alone, so an account without an
 * enrolled authenticator is refused before a challenge can be issued.
 */
export function stepUpAppliesToUser(
	_scope: StepUpScope,
	_user: { twoFactorEnabled?: boolean | null }
): boolean {
	return true;
}

/**
 * What the prompt (and the emailed code) calls each scope, in the second person
 * and in plain language. The email in particular has to name the action: a
 * recipient who is not the one clicking should be able to tell from the subject
 * line alone that somebody else is holding their session.
 */
const SCOPE_LABELS: Record<StepUpScope, string> = {
	"org.credentials": "change long-lived access keys",
	"org.delete": "delete a workspace",
	"org.members": "change who can access a workspace",
	"org.features": "change organization feature access",
	"node.destroy": "remove a cloud node",
	billing: "complete this billing action",
	"platform.admin": "use Ryu staff powers",
	"account.merge": "merge another account into this one",
};

/** Plain-language description of what a step-up on `scope` authorizes. */
export function stepUpActionLabel(scope: StepUpScope): string {
	return SCOPE_LABELS[scope];
}

/** How long an emailed challenge stays answerable. */
const CHALLENGE_TTL_MS = 10 * MINUTE_MS;
/** Wrong guesses allowed before the challenge is burned. */
const CHALLENGE_MAX_ATTEMPTS = 5;
const CHALLENGE_DIGITS = 6;

function hashCode(code: string): string {
	return createHash("sha256").update(code).digest("hex");
}

/**
 * Issue (or replace) the emailed step-up code for this session+scope and send
 * it. Returns nothing about the code itself — the only way to learn it is to
 * read the mailbox, which is the entire point.
 */
export async function issueStepUpChallenge(input: {
	scope: StepUpScope;
	sessionId: string;
	user: { email: string; id: string; name?: string | null };
}): Promise<void> {
	// `randomInt` rather than `Math.random`: this is a credential.
	const code = String(randomInt(0, 10 ** CHALLENGE_DIGITS)).padStart(
		CHALLENGE_DIGITS,
		"0"
	);
	// Upsert on the unique session+scope key, so a resend REPLACES the pending
	// code. Stacking them would mean every resend widened the set of codes an
	// attacker could guess against.
	await StepUpChallenge.findOneAndUpdate(
		{ scope: input.scope, sessionId: input.sessionId },
		{
			$set: {
				attempts: 0,
				codeHash: hashCode(code),
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
				userId: input.user.id,
			},
		},
		{ new: true, upsert: true }
	);
	await sendEmail({
		react: StepUpOTPEmail({
			actionLabel: stepUpActionLabel(input.scope),
			otpCode: code,
			userName: input.user.name || "there",
		}),
		subject: `Your confirmation code is ${code}`,
		to: input.user.email,
	});
}

/** Why an emailed step-up code was refused, for a message the user can act on. */
export type StepUpChallengeFailure =
	| "no-challenge"
	| "expired"
	| "too-many-attempts"
	| "invalid";

/**
 * Check an emailed code. On success the challenge is consumed, so a code that
 * worked once cannot be replayed inside its remaining window.
 */
export async function verifyStepUpChallenge(input: {
	code: string;
	scope: StepUpScope;
	sessionId: string;
}): Promise<{ ok: true } | { ok: false; reason: StepUpChallengeFailure }> {
	const challenge = await StepUpChallenge.findOne({
		scope: input.scope,
		sessionId: input.sessionId,
	});
	if (!challenge) {
		return { ok: false, reason: "no-challenge" };
	}
	// Checked here rather than left to the TTL sweep, same reason as grants.
	if (challenge.expiresAt.getTime() <= Date.now()) {
		await challenge.deleteOne();
		return { ok: false, reason: "expired" };
	}
	if (challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) {
		await challenge.deleteOne();
		return { ok: false, reason: "too-many-attempts" };
	}
	const supplied = Buffer.from(hashCode(input.code.trim()), "hex");
	const stored = Buffer.from(challenge.codeHash, "hex");
	// Both are fixed-length SHA-256 digests, so the length guard is belt and
	// braces against a malformed stored value rather than a real branch.
	const matches =
		supplied.length === stored.length && timingSafeEqual(supplied, stored);
	if (!matches) {
		challenge.attempts += 1;
		await challenge.save();
		return {
			ok: false,
			reason:
				challenge.attempts >= CHALLENGE_MAX_ATTEMPTS
					? "too-many-attempts"
					: "invalid",
		};
	}
	await challenge.deleteOne();
	return { ok: true };
}

/**
 * Whether `scope` demands a REAL enrolled second factor rather than accepting
 * the emailed fallback.
 *
 * Platform-admin and billing do. A Ryu-staff session can reach every tenant's
 * data, and a billing session can move real money, so "whoever controls the
 * mailbox" is not an acceptable answer to "who is holding this session" — the
 * actor must enrol 2FA or they do not act. Other tenant-side scopes retain the
 * emailed fallback so those controls apply to everyone from day one.
 */
export function stepUpRequiresEnrolled2fa(scope: StepUpScope): boolean {
	return scope === "platform.admin" || scope === "billing";
}

/** True when this session already holds a live grant for `scope`. */
export async function hasStepUp(
	sessionId: string,
	scope: StepUpScope
): Promise<boolean> {
	if (!sessionId) {
		return false;
	}
	// `expiresAt` is compared here rather than trusted to the TTL monitor: that
	// sweep runs about once a minute, which is an eternity next to a five-minute
	// window guarding an irreversible delete.
	const grant = await StepUpGrant.findOne({
		expiresAt: { $gt: new Date() },
		scope,
		sessionId,
	})
		.select({ _id: 1 })
		.lean();
	return Boolean(grant);
}

/**
 * Wrong codes tolerated per session+scope before the prompt refuses to look at
 * another one. Covers every method together, so switching from the
 * authenticator to backup codes does not hand out a fresh budget.
 */
const MAX_FAILED_ATTEMPTS = 5;
/** How long the failure count survives before a fresh budget is granted. */
const ATTEMPT_WINDOW_MS = 15 * MINUTE_MS;

/** True when this session has burned its attempts for `scope`. */
export async function stepUpAttemptsExhausted(
	sessionId: string,
	scope: StepUpScope
): Promise<boolean> {
	const row = await StepUpAttempt.findOne({
		expiresAt: { $gt: new Date() },
		scope,
		sessionId,
	})
		.select({ count: 1 })
		.lean<{ count: number } | null>();
	return (row?.count ?? 0) >= MAX_FAILED_ATTEMPTS;
}

/** Count one wrong code. Returns true once the budget is spent. */
export async function recordStepUpFailure(
	sessionId: string,
	scope: StepUpScope
): Promise<boolean> {
	const now = Date.now();
	// Drop a lapsed row first. The TTL monitor sweeps about once a minute, and
	// counting a fresh failure onto a stale row would keep a session blocked long
	// after its window should have reset.
	await StepUpAttempt.deleteOne({
		expiresAt: { $lte: new Date(now) },
		scope,
		sessionId,
	});
	// `$max` on `expiresAt` extends a live window rather than restarting it, so a
	// steady drip of guesses cannot keep the count alive forever OR reset it.
	const row = await StepUpAttempt.findOneAndUpdate(
		{ scope, sessionId },
		{
			$inc: { count: 1 },
			$max: { expiresAt: new Date(now + ATTEMPT_WINDOW_MS) },
		},
		{ new: true, upsert: true }
	).lean<{ count: number }>();
	return (row?.count ?? 1) >= MAX_FAILED_ATTEMPTS;
}

/** Clear the failure count — called once a code is accepted. */
export async function clearStepUpFailures(
	sessionId: string,
	scope: StepUpScope
): Promise<void> {
	await StepUpAttempt.deleteOne({ scope, sessionId });
}

/** Record a successful proof and open the window for `scope`. */
export async function recordStepUp(input: {
	method: StepUpMethod;
	scope: StepUpScope;
	sessionId: string;
	userId: string;
}): Promise<{ expiresAt: Date }> {
	const expiresAt = new Date(Date.now() + stepUpWindowMs(input.scope));
	await StepUpGrant.create({
		createdAt: new Date(),
		expiresAt,
		method: input.method,
		scope: input.scope,
		sessionId: input.sessionId,
		userId: input.userId,
	});
	return { expiresAt };
}

/**
 * The Better Auth endpoints that are themselves the dangerous action, mapped to
 * the scope that unlocks them.
 *
 * These never reach a Hono handler of ours — the browser calls `authClient`
 * directly — so they are gated in the auth config's `hooks.before` instead.
 *
 * Paths are matched EXACTLY, which is the safe direction (a renamed endpoint
 * loses its gate rather than a similarly-named one gaining a spurious 403) but
 * also a silent one. `step-up.test.ts` pins each entry by name so a deletion has
 * to be deliberate; it cannot check the paths against the running auth instance,
 * because importing it needs the full server env. Re-read this list when
 * upgrading `better-auth`.
 */
export const STEP_UP_AUTH_PATHS: Record<string, StepUpScope> = {
	// Ryu-staff powers over any account. `impersonate-user` is included on
	// purpose: it is not destructive, it is *total* — it hands the operator the
	// victim's session.
	"/admin/ban-user": "platform.admin",
	"/admin/impersonate-user": "platform.admin",
	"/admin/remove-user": "platform.admin",
	"/admin/set-role": "platform.admin",
	"/admin/set-user-password": "platform.admin",
	// Workspace-level destruction and control transfer.
	"/organization/delete": "org.delete",
	"/organization/remove-member": "org.members",
	"/organization/update-member-role": "org.members",
};

/** The scope guarding a Better Auth path, or null when it is not gated. */
export function stepUpScopeForAuthPath(path: string): StepUpScope | null {
	return STEP_UP_AUTH_PATHS[path] ?? null;
}
