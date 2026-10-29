import {
	createHash,
	randomBytes,
	randomInt,
	timingSafeEqual,
} from "node:crypto";
import { roleChangeGrantsPermissions } from "@ryu/db/models/control-plane.model";
import {
	StepUpAttempt,
	StepUpChallenge,
	StepUpGrant,
	type StepUpMethod,
} from "@ryu/db/models/step-up.model";
import { StepUpMagicLinkEmail, StepUpOTPEmail, sendEmail } from "@ryu/email";
import { createAccessControl } from "better-auth/plugins/access";
import { z } from "zod";

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
	/**
	 * Org-wide, bypass-proof security policy: the org and per-agent firewall/DLP
	 * overlays, org-level or locked policy layers, and config apply/rollback
	 * that rewrites them.
	 */
	"org.security",
	/** Long-lived secrets: gateway keys, API keys, the provider key vault. */
	"org.credentials",
	/**
	 * Cloud nodes and Boxes: schedule removal, transfer, or destroy live
	 * infrastructure (including deleting a Box and its disk).
	 */
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
	/** Changes to account authentication and sign-in recovery methods. */
	"account.security",
	/**
	 * Confirm the current session with the authenticator app or a recovery code,
	 * which stamps it as strongly signed in (`strongFactor`). An organization
	 * that requires two-factor refuses a session signed in by email, social
	 * login or a remembered device (`org_mfa_session_required`) until this is
	 * done. Only real second factors are offered, so mailbox possession alone
	 * cannot satisfy it.
	 */
	"session.confirm",
] as const;

/**
 * Password and mailbox proofs are deliberately scoped to account security
 * changes. The grant is still bound to the current session and expires quickly,
 * so a proof for an email or password change cannot authorize another device.
 * Built-in 2FA enable/disable flows keep their own password checks because their
 * UI already collects that proof directly.
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
const WINDOW_MS = {
	"org.delete": 5 * MINUTE_MS,
	"org.members": 10 * MINUTE_MS,
	"org.features": 10 * MINUTE_MS,
	"org.security": 10 * MINUTE_MS,
	"org.credentials": 10 * MINUTE_MS,
	"node.destroy": 5 * MINUTE_MS,
	billing: 5 * MINUTE_MS,
	"platform.admin": 30 * MINUTE_MS,
	"account.merge": 5 * MINUTE_MS,
	"account.security": 5 * MINUTE_MS,
	"session.confirm": 5 * MINUTE_MS,
} satisfies Record<StepUpScope, number>;

/** True when `value` is one of the known scopes. */
const stepUpScopeBoundarySchema = z.preprocess(
	(value) => value,
	z.enum(STEP_UP_SCOPES)
);
export function isStepUpScope(
	value: z.input<typeof stepUpScopeBoundarySchema>
): value is StepUpScope {
	return stepUpScopeBoundarySchema.safeParse(value).success;
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
	user: {
		hasPassword?: boolean | null;
		twoFactorEnabled?: boolean | null;
	},
	scope: StepUpScope
): StepUpMethod[] {
	if (scope === "billing") {
		return user.twoFactorEnabled ? ["totp"] : [];
	}
	if (scope === "session.confirm") {
		// The point is to prove a factor the mailbox does not hold, so only the
		// authenticator app and its recovery codes are accepted.
		return user.twoFactorEnabled ? ["totp", "backup"] : [];
	}
	if (scope === "platform.admin") {
		// Staff powers reach every account and the fleet's provider keys. Like
		// billing they need a real second factor; the emailed code would let
		// mailbox possession alone approve them.
		return user.twoFactorEnabled ? ["totp", "backup"] : [];
	}
	if (scope === "account.security") {
		// An enrolled authenticator remains the strongest proof. Do not silently
		// weaken an account that has 2FA by offering its password alone.
		if (user.twoFactorEnabled) {
			return ["totp", "otp", "backup"];
		}
		return user.hasPassword ? ["password", "magic-link"] : ["magic-link"];
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
const SCOPE_LABELS = {
	"org.credentials": "change or reveal access keys and shared secrets",
	"org.delete": "delete a workspace",
	"org.members": "change who can access a workspace",
	"org.features": "change organization feature access",
	"org.security": "change organization security policy",
	"node.destroy": "remove or transfer a cloud node, or delete a Box",
	billing: "complete this billing action",
	"platform.admin": "use Ryu staff powers",
	"account.merge": "merge another account into this one",
	"account.security": "change your account security settings",
	"session.confirm": "confirm this session with two-factor authentication",
} satisfies Record<StepUpScope, string>;

/** Plain-language description of what a step-up on `scope` authorizes. */
export function stepUpActionLabel(scope: StepUpScope): string {
	return SCOPE_LABELS[scope];
}

/** How long an emailed challenge stays answerable. */
const CHALLENGE_TTL_MS = 10 * MINUTE_MS;
/** Wrong guesses allowed before the challenge is burned. */
const CHALLENGE_MAX_ATTEMPTS = 5;
const CHALLENGE_DIGITS = 6;

export type StepUpChallengeType = "otp" | "magic-link";

function hashCode(code: string): string {
	return createHash("sha256").update(code).digest("hex");
}

/**
 * Store a fresh emailed step-up code for this session+scope, send it and, once
 * it is sent, make it the pending one. Returns nothing about the code itself —
 * the only way to learn it is to read the mailbox, which is the entire point.
 *
 * Throws `sendEmail`'s errors unchanged, including its `EmailRateLimitError`
 * for the per-recipient email cooldown; the route turns that one into a 429.
 */
export async function issueStepUpChallenge(input: {
	method?: StepUpChallengeType;
	scope: StepUpScope;
	sessionId: string;
	user: { email: string; id: string; name?: string | null };
}): Promise<void> {
	if (input.scope === "account.security") {
		// Starting a different proof attempt invalidates an unspent proof. The
		// unique session+scope attempt row makes this update safe across requests.
		await StepUpAttempt.updateOne(
			{ scope: input.scope, sessionId: input.sessionId },
			{ $unset: { verifiedAt: "" } }
		);
	}
	const method = input.method ?? "otp";
	// `randomInt`/`randomBytes` rather than `Math.random`: these are credentials.
	const secret =
		method === "magic-link"
			? randomBytes(32).toString("hex")
			: String(randomInt(0, 10 ** CHALLENGE_DIGITS)).padStart(
					CHALLENGE_DIGITS,
					"0"
				);
	const codeHash = hashCode(secret);
	const filter = { scope: input.scope, sessionId: input.sessionId };
	const pendingFields = () => ({
		attempts: 0,
		challengeType: method,
		codeHash,
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
		userId: input.user.id,
	});
	// Stored before the email goes out, so a write that fails mails nothing. A
	// first challenge is inserted pending (there is no earlier code to protect);
	// a resend is only staged beside the pending code, which keeps working until
	// this email is on its way. `new: false` returns null exactly when this
	// request inserted the row.
	const previous = await StepUpChallenge.findOneAndUpdate(
		filter,
		{ $set: { stagedCodeHash: codeHash }, $setOnInsert: pendingFields() },
		{ new: false, upsert: true }
	);
	try {
		await sendStepUpChallengeEmail(input, method, secret);
	} catch (error) {
		// A send the per-recipient email cooldown or the provider refuses must
		// not leave a code nobody received, nor replace the code an earlier email
		// delivered: that earlier code stays the one that works, with its spent
		// guesses still counted. A failed cleanup leaves only an unanswerable
		// marker or a code nobody holds, both swept on expiry, so the send's own
		// error (the route's 429) is the one surfaced.
		await discardUnsentChallenge(filter, codeHash, previous === null).catch(
			() => undefined
		);
		throw error;
	}
	// Promote on the unique session+scope key, so a resend REPLACES the pending
	// code. Stacking them would mean every resend widened the set of codes an
	// attacker could guess against.
	const promoted = await StepUpChallenge.updateOne(
		{ ...filter, stagedCodeHash: codeHash },
		{ $set: pendingFields(), $unset: { stagedCodeHash: "" } }
	);
	if (promoted.matchedCount === 0) {
		// A concurrent request staged its own code over this marker, or a verify
		// consumed the row. This email was still delivered, so its code becomes
		// the pending one like any resend; the other request's marker is left for
		// it to promote or discard.
		await StepUpChallenge.updateOne(
			filter,
			{ $set: pendingFields() },
			{ upsert: true }
		);
	}
}

/**
 * Undo the store for a challenge whose email never went out. Only rows still
 * carrying this request's code are touched, so a concurrent resend that was
 * delivered keeps its code.
 */
async function discardUnsentChallenge(
	filter: { scope: StepUpScope; sessionId: string },
	codeHash: string,
	inserted: boolean
): Promise<void> {
	if (inserted) {
		await StepUpChallenge.deleteOne({ ...filter, codeHash });
		return;
	}
	await StepUpChallenge.updateOne(
		{ ...filter, stagedCodeHash: codeHash },
		{ $unset: { stagedCodeHash: "" } }
	);
}

async function sendStepUpChallengeEmail(
	input: {
		scope: StepUpScope;
		user: { email: string; name?: string | null };
	},
	method: StepUpChallengeType,
	secret: string
): Promise<void> {
	if (method === "magic-link") {
		const frontendUrl = (
			process.env.NEXT_PUBLIC_FRONTEND_URL ||
			process.env.FRONTEND_URL ||
			"http://localhost:3001"
		).replace(/\/$/, "");
		const verificationUrl = `${frontendUrl}/settings/verify?scope=${encodeURIComponent(input.scope)}&token=${encodeURIComponent(secret)}`;
		await sendEmail({
			react: StepUpMagicLinkEmail({
				actionLabel: stepUpActionLabel(input.scope),
				magicLinkUrl: verificationUrl,
				userName: input.user.name || "there",
			}),
			subject: "Confirm your Ryu account change",
			to: input.user.email,
		});
		return;
	}
	await sendEmail({
		react: StepUpOTPEmail({
			actionLabel: stepUpActionLabel(input.scope),
			otpCode: secret,
			userName: input.user.name || "there",
		}),
		subject: `Your confirmation code is ${secret}`,
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
	const now = new Date();
	const filter = {
		challengeType: "otp",
		scope: input.scope,
		sessionId: input.sessionId,
	} as const;
	// Reserve the attempt atomically BEFORE comparing. A read-then-save counter
	// lets a burst of concurrent guesses all observe the same `attempts` value
	// and each write back `attempts + 1`, so the five-guess cap would bound
	// rounds, not guesses. `$inc` under an `attempts < cap` filter bounds the
	// total number of comparisons no matter how requests interleave.
	const challenge = await StepUpChallenge.findOneAndUpdate(
		{
			...filter,
			attempts: { $lt: CHALLENGE_MAX_ATTEMPTS },
			expiresAt: { $gt: now },
		},
		{ $inc: { attempts: 1 } },
		{ new: true }
	);
	if (!challenge) {
		// Explain the refusal; the reservation above is the gate.
		const existing = await StepUpChallenge.findOne(filter);
		if (!existing) {
			return { ok: false, reason: "no-challenge" };
		}
		// Match the hash too: a resend reuses the row's _id, and a fresh code
		// issued between these two reads must survive.
		await StepUpChallenge.deleteOne({
			_id: existing._id,
			codeHash: existing.codeHash,
		});
		// Checked here rather than left to the TTL sweep, same reason as grants.
		return existing.expiresAt.getTime() <= Date.now()
			? { ok: false, reason: "expired" }
			: { ok: false, reason: "too-many-attempts" };
	}
	const supplied = Buffer.from(hashCode(input.code.trim()), "hex");
	const stored = Buffer.from(challenge.codeHash, "hex");
	// Both are fixed-length SHA-256 digests, so the length guard is belt and
	// braces against a malformed stored value rather than a real branch.
	const matches =
		supplied.length === stored.length && timingSafeEqual(supplied, stored);
	if (!matches) {
		return {
			ok: false,
			reason:
				challenge.attempts >= CHALLENGE_MAX_ATTEMPTS
					? "too-many-attempts"
					: "invalid",
		};
	}
	// Consume exactly once: two concurrent submissions of the right code must
	// not both open a window, so only the request whose conditional delete
	// removes this exact, still-live challenge wins. Every other verifier holding
	// the same snapshot (or a stale one a resend has since replaced) gets
	// `deletedCount: 0` and fails before the route records any proof.
	const consumed = await StepUpChallenge.deleteOne({
		_id: challenge._id,
		codeHash: challenge.codeHash,
		expiresAt: { $gt: now },
	});
	return consumed.deletedCount === 1
		? { ok: true }
		: { ok: false, reason: "no-challenge" };
}

/**
 * Consume a one-click mailbox proof. The link is still bound to the session
 * that requested it, so opening it from an unrelated signed-in device cannot
 * arm that other device by accident.
 */
export async function verifyStepUpMagicLink(input: {
	scope: StepUpScope;
	sessionId: string;
	token: string;
}): Promise<{ ok: true } | { ok: false; reason: StepUpChallengeFailure }> {
	const now = new Date();
	const challenge = await StepUpChallenge.findOne({
		challengeType: "magic-link",
		scope: input.scope,
		sessionId: input.sessionId,
	});
	if (!challenge) {
		return { ok: false, reason: "no-challenge" };
	}
	if (challenge.expiresAt.getTime() <= now.getTime()) {
		await StepUpChallenge.deleteOne({
			_id: challenge._id,
			codeHash: challenge.codeHash,
			expiresAt: { $lte: now },
		});
		return { ok: false, reason: "expired" };
	}
	const codeHash = hashCode(input.token);
	if (codeHash !== challenge.codeHash) {
		return { ok: false, reason: "invalid" };
	}
	// Consume exactly once (a double-clicked link must not open two windows),
	// and only while the proof is still live.
	const consumed = await StepUpChallenge.deleteOne({
		_id: challenge._id,
		codeHash,
		expiresAt: { $gt: now },
	});
	return consumed.deletedCount === 1
		? { ok: true }
		: { ok: false, reason: "no-challenge" };
}

/**
 * Whether `scope` demands a REAL enrolled second factor rather than accepting
 * the emailed fallback.
 *
 * Platform-admin and billing do. A Ryu-staff session can reach every tenant's
 * data, and a billing session can move real money, so "whoever controls the
 * mailbox" is not an acceptable answer to "who is holding this session" — the
 * actor must enrol 2FA or they do not act. `session.confirm` does too: it
 * exists to prove a factor the mailbox does not hold. Other tenant-side scopes retain the
 * emailed fallback so those controls apply to everyone from day one.
 */
export function stepUpRequiresEnrolled2fa(scope: StepUpScope): boolean {
	return (
		scope === "platform.admin" ||
		scope === "billing" ||
		scope === "session.confirm"
	);
}

/** True when this session holds a live step-up authorization for `scope`. */
export async function hasStepUp(
	sessionId: string,
	scope: StepUpScope
): Promise<boolean> {
	if (!sessionId) {
		return false;
	}
	if (scope === "account.security") {
		const proof = await StepUpAttempt.findOne({
			expiresAt: { $gt: new Date() },
			scope,
			sessionId,
			verifiedAt: { $type: "date" },
		})
			.select({ _id: 1 })
			.lean();
		return Boolean(proof);
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

/** Atomically consume the fresh, one-use proof for an account-security change. */
export async function consumeAccountSecurityProof(
	sessionId: string
): Promise<boolean> {
	if (!sessionId) {
		return false;
	}
	const proof = await StepUpAttempt.findOneAndDelete({
		expiresAt: { $gt: new Date() },
		scope: "account.security",
		sessionId,
		verifiedAt: { $type: "date" },
	})
		.select({ _id: 1 })
		.lean();
	return Boolean(proof);
}

/** Apply the scope's authorization semantics at the protected mutation boundary. */
export async function authorizeStepUp(
	sessionId: string,
	scope: StepUpScope
): Promise<boolean> {
	if (scope === "account.security") {
		return await consumeAccountSecurityProof(sessionId);
	}
	return await hasStepUp(sessionId, scope);
}

/**
 * Wrong codes tolerated per session+scope before the prompt refuses to look at
 * another one. Covers every method together, so switching from the
 * authenticator to backup codes does not hand out a fresh budget.
 */
const MAX_FAILED_ATTEMPTS = 5;
/** How long the failure count survives before a fresh budget is granted. */
const ATTEMPT_WINDOW_MS = 15 * MINUTE_MS;

const DUPLICATE_KEY_ERROR_CODE = 11_000;
const isDuplicateKeyError = z
	.unknown()
	.transform(
		(error) =>
			z.object({ code: z.literal(DUPLICATE_KEY_ERROR_CODE) }).safeParse(error)
				.success
	).parse;

/** The outcome of reserving one guess against a session+scope budget. */
export interface StepUpAttemptReservation {
	/** False when the budget is already spent: refuse without comparing. */
	ok: boolean;
	/** True when this reservation took the last attempt in the window. */
	spent: boolean;
}

/**
 * Reserve one attempt BEFORE a code or password is compared, for every method.
 *
 * A separate "is the budget spent?" read followed by a "count this failure"
 * write lets a parallel burst all pass the read before any write lands, so the
 * cap bounded rounds rather than guesses. That matters because the
 * authenticator and backup-code paths call Better Auth in-process, which skips
 * its HTTP limiter and records nothing on a wrong code. Here the `$inc` only
 * applies while `count` is under the cap, so the number of comparisons is
 * bounded no matter how requests interleave. A success clears the row through
 * `clearStepUpFailures`, so only wrong attempts stay counted.
 */
export async function reserveStepUpAttempt(
	sessionId: string,
	scope: StepUpScope
): Promise<StepUpAttemptReservation> {
	const now = Date.now();
	// Drop a lapsed row first. The TTL monitor sweeps about once a minute, and
	// counting a fresh attempt onto a stale row would keep a session blocked long
	// after its window should have reset.
	await StepUpAttempt.deleteOne({
		expiresAt: { $lte: new Date(now) },
		scope,
		sessionId,
	});
	const filter = { count: { $lt: MAX_FAILED_ATTEMPTS }, scope, sessionId };
	// `$max` on `expiresAt` extends a live window rather than restarting it, so a
	// steady drip of guesses cannot keep the count alive forever OR reset it.
	// Unsetting `verifiedAt` keeps the rule that a new attempt invalidates an
	// unspent account-security proof; `recordStepUp` sets it again on success.
	const update = {
		$inc: { count: 1 },
		$max: { expiresAt: new Date(now + ATTEMPT_WINDOW_MS) },
		$unset: { verifiedAt: "" },
	};
	let row: { count: number } | null;
	try {
		row = await StepUpAttempt.findOneAndUpdate(filter, update, {
			new: true,
			upsert: true,
		}).lean<{ count: number } | null>();
	} catch (error) {
		if (!isDuplicateKeyError(error)) {
			throw error;
		}
		// The insert collided on the unique session+scope key: either the live row
		// is already at the cap (so the filter missed it), or a concurrent first
		// attempt created it a moment ago. Retry without upsert: that counts onto
		// the racer's row, or returns null when the budget is spent.
		row = await StepUpAttempt.findOneAndUpdate(filter, update, {
			new: true,
		}).lean<{ count: number } | null>();
	}
	if (!row) {
		return { ok: false, spent: true };
	}
	return { ok: true, spent: row.count >= MAX_FAILED_ATTEMPTS };
}

/** Clear the attempt count — called once a code is accepted. */
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
	if (input.scope === "account.security") {
		// Reuse the unique attempt row as a one-use proof marker. The grant above
		// remains the audit record; consuming this marker is the authorization
		// check, so password/email/passkey changes cannot share one factor.
		await StepUpAttempt.findOneAndUpdate(
			{ scope: input.scope, sessionId: input.sessionId },
			{
				$set: {
					count: 0,
					expiresAt,
					verifiedAt: new Date(),
				},
			},
			{ new: true, upsert: true }
		);
	}
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
export const STEP_UP_AUTH_PATHS = {
	// Account settings can be reached directly through Better Auth's client,
	// so the server gate covers callers that skip the website UI.
	"/passkey/delete-passkey": "account.security",
	"/passkey/update-passkey": "account.security",
	"/passkey/verify-registration": "account.security",
	"/change-password": "account.security",
	"/unlink-account": "account.security",
	// Ryu-staff powers over any account. `impersonate-user` is included on
	// purpose: it is not destructive, it is *total* — it hands the operator the
	// victim's session. `platformAdminRoles` grants the admin role only
	// ban/unban, remove-user, impersonate-user, set-role and set-user-password.
	// The rest below are ungranted there and gated here too, so any later grant
	// still needs a fresh step-up.
	"/admin/ban-user": "platform.admin",
	"/admin/create-user": "platform.admin",
	"/admin/impersonate-user": "platform.admin",
	"/admin/list-user-sessions": "platform.admin",
	"/admin/remove-user": "platform.admin",
	"/admin/revoke-user-session": "platform.admin",
	"/admin/revoke-user-sessions": "platform.admin",
	"/admin/set-role": "platform.admin",
	"/admin/set-user-password": "platform.admin",
	// Also refused as raw HTTP paths by `adminAbuseGuardPlugin`; the step-up
	// here is defense in depth for the abuse console's own server-side calls.
	"/admin/unban-user": "platform.admin",
	"/admin/update-user": "platform.admin",
	// Workspace-level destruction and control transfer. Ryu's own
	// cancel-invitation wrapper requires `org.members`; the native endpoint
	// must match it. `invite-member` is role-dependent: see
	// `stepUpScopeForInvitedRole`.
	"/organization/cancel-invitation": "org.members",
	"/organization/delete": "org.delete",
	"/organization/remove-member": "org.members",
	"/organization/update-member-role": "org.members",
} satisfies Record<string, StepUpScope>;

/**
 * Better Auth `admin` plugin access control. Its default admin role grants
 * session listing (live tokens), raw user updates and user creation, none of
 * them consented, stepped up or audited. Grant only the gated staff actions;
 * `impersonate-admins` never.
 */
export const platformAdminAccessControl = createAccessControl({
	user: [
		"create",
		"list",
		"set-role",
		"ban",
		"impersonate",
		"impersonate-admins",
		"delete",
		"set-password",
		"set-email",
		"get",
		"update",
	],
	session: ["list", "revoke", "delete"],
} as const);

export const platformAdminRoles = {
	admin: platformAdminAccessControl.newRole({
		user: ["ban", "delete", "impersonate", "set-password", "set-role"],
		session: [],
	}),
	user: platformAdminAccessControl.newRole({ user: [], session: [] }),
};

export const ADMIN_UPDATE_USER_PATH = "/admin/update-user";

/** `/admin/update-user` data fields with their own gated or verified flow. */
const ADMIN_UPDATE_USER_PROTECTED_FIELDS = [
	"banExpires",
	"banReason",
	"banned",
	"email",
	"emailVerified",
	"role",
	"twoFactorEnabled",
] as const;

/** The protected fields an `/admin/update-user` body tries to write. */
export function protectedAdminUpdateUserFields(body: unknown): string[] {
	const data =
		typeof body === "object" && body !== null && "data" in body
			? body.data
			: null;
	if (typeof data !== "object" || data === null) {
		return [];
	}
	return ADMIN_UPDATE_USER_PROTECTED_FIELDS.filter((field) =>
		Object.hasOwn(data, field)
	);
}

/** The scope guarding a Better Auth path, or null when it is not gated. */
export function stepUpScopeForAuthPath(path: string): StepUpScope | null {
	return new Map(Object.entries(STEP_UP_AUTH_PATHS)).get(path) ?? null;
}

/** Better Auth's native invitation endpoint; its scope depends on the role. */
export const STEP_UP_INVITE_MEMBER_PATH = "/organization/invite-member";

const invitedRoleSchema = z.union([z.string(), z.array(z.string())]);

/**
 * The scope an invitation needs, from the role it will grant on acceptance.
 *
 * An invitation carries its role, so inviting someone as owner, admin, or
 * billing manager reaches the same outcome as promoting a member through
 * `update-member-role`, and needs the same `org.members` step-up. Inviting a
 * plain member or viewer stays ungated. A role this cannot read fails closed;
 * the native endpoint rejects it after the gate in any case.
 */
export function stepUpScopeForInvitedRole(role: unknown): StepUpScope | null {
	const parsed = invitedRoleSchema.safeParse(role);
	if (!parsed.success) {
		return "org.members";
	}
	const baRole = Array.isArray(parsed.data)
		? parsed.data.join(",")
		: parsed.data;
	return roleChangeGrantsPermissions("member", baRole) ? "org.members" : null;
}

/**
 * Better Auth's native key-minting endpoint. Ryu mints every key through its
 * control-plane routes, which require an `org.credentials` step-up, clamp scopes
 * to the caller's role, and write an audit row. The native endpoint does none of
 * that and hands a client a non-expiring key with the role's default
 * permissions, so a client call to it is refused outright. Server calls
 * (`auth.api.createApiKey` with neither a request nor headers) stay allowed.
 */
export const NATIVE_API_KEY_CREATE_PATH = "/api-key/create";

/** True for a client (not server) call to the native key-minting endpoint. */
export function isClientNativeApiKeyCreate(ctx: {
	readonly headers?: unknown;
	readonly path?: string;
	readonly request?: unknown;
}): boolean {
	return (
		ctx.path === NATIVE_API_KEY_CREATE_PATH &&
		Boolean(ctx.request || ctx.headers)
	);
}

/** Native key mutations need an ownership lookup before choosing a scope. */
export function isStepUpApiKeyMutation(path: string): boolean {
	return path === "/api-key/delete" || path === "/api-key/update";
}

/**
 * True for a client (not server) call to the native delete/update endpoint for a
 * key whose STORED config is `organization`. Ryu changes org keys only through
 * `/control-plane/orgs/:orgId/api-keys`, which checks `gateway.configure`, asks
 * for an `org.credentials` step-up, writes the audit row and clears the key's
 * spend cap. The native endpoint does none of the audit or cap work, so a
 * client call to it is refused outright.
 */
export function isClientNativeOrgApiKeyMutation(
	ctx: {
		readonly headers?: unknown;
		readonly path?: string;
		readonly request?: unknown;
	},
	storedConfigId: unknown
): boolean {
	return (
		isStepUpApiKeyMutation(ctx.path ?? "") &&
		storedConfigId === "organization" &&
		Boolean(ctx.request || ctx.headers)
	);
}

/** Better Auth's native key-read endpoints. */
export const NATIVE_API_KEY_GET_PATH = "/api-key/get";
export const NATIVE_API_KEY_LIST_PATH = "/api-key/list";

/** Native key reads can name an organization's key inventory. */
export function isNativeApiKeyRead(path: string): boolean {
	return path === NATIVE_API_KEY_GET_PATH || path === NATIVE_API_KEY_LIST_PATH;
}

/**
 * True for a client (not server) native read of organization keys: a `/list`
 * that names an `organizationId`, or a `/get` of a key whose STORED config is
 * `organization`. Ryu lists org keys only through
 * `/control-plane/orgs/:orgId/api-keys`, which checks `gateway.configure` and
 * the organization's access policy (IP allowlist, required 2FA, session max
 * age); the native endpoints check neither, so a client call is refused.
 */
export function isClientNativeOrgApiKeyRead(
	ctx: {
		readonly headers?: unknown;
		readonly path?: string;
		readonly query?: unknown;
		readonly request?: unknown;
	},
	storedConfigId: unknown
): boolean {
	if (!(ctx.request || ctx.headers)) {
		return false;
	}
	if (ctx.path === NATIVE_API_KEY_LIST_PATH) {
		// Better Auth lists org keys whenever `organizationId` is truthy; any
		// non-empty value (a repeated parameter included) fails closed.
		const organizationId = z
			.object({ organizationId: z.unknown() })
			.partial()
			.catch(() => ({}))
			.parse(ctx.query).organizationId;
		return Boolean(organizationId);
	}
	return (
		ctx.path === NATIVE_API_KEY_GET_PATH && storedConfigId === "organization"
	);
}

/** Resolve the credential scope from Better Auth's stored key configuration. */
export const stepUpScopeForApiKeyConfig = z
	.unknown()
	.transform((configId): StepUpScope | null =>
		configId === "organization" ? "org.credentials" : null
	).parse;
