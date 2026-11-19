import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, formCsrfMiddleware } from "better-auth/api";
import { z } from "zod";
import { deferredAnswer, isDeferredReplay } from "./deferred-auth-request.ts";
import { claimEmailCooldown, type EmailBudget } from "./email-cooldown.ts";
import { emailCooldownRefusal } from "./email-cooldown-refusal.ts";
import {
	type PrepaidSend,
	prepaidSend,
	rememberPrepaidSend,
} from "./email-send-budget.ts";
import { pendingLogin } from "./login-assurance-state.ts";
import { resolveSessionForHook } from "./step-up-plugin.ts";

// The request-path half of the authentication email cooldown
// (lib/email-cooldown.ts). Every endpoint that emails a sign-in link or code,
// a password reset or a verification message claims the recipient's slot
// before Better Auth runs it, so a refusal is a 429 the caller sees, decided
// before Better Auth looks the address up. A send that runs in the background
// (where Better Auth swallows its errors) cannot answer the caller at all.
// Every send itself is detached (lib/sign-in-email-senders.ts,
// lib/password-email-senders.ts), so no request waits for a delivery.

/** Endpoints whose recipient is the `email` in the request body. */
const BODY_RECIPIENT_PATHS = new Set([
	"/sign-in/magic-link",
	"/email-otp/send-verification-otp",
	"/email-otp/request-password-reset",
	"/forget-password/email-otp",
	"/request-password-reset",
	"/send-verification-email",
]);
const TWO_FACTOR_SEND_PATH = "/two-factor/send-otp";
/** Better Auth's two-factor challenge cookie (plugins/two-factor/constant). */
const TWO_FACTOR_COOKIE_NAME = "two_factor";

export const EMAIL_COOLDOWN_PATHS: ReadonlySet<string> = new Set([
	...BODY_RECIPIENT_PATHS,
	TWO_FACTOR_SEND_PATH,
]);

const bodyEmailSchema = z
	.object({ email: z.string() })
	.transform((body) => body.email)
	.optional()
	.catch(undefined);
const recordSchema = z.object({ email: z.string() }).nullish().catch(null);
const verificationSchema = z
	.object({ value: z.string() })
	.nullish()
	.catch(null);

type CooldownHookContext = Parameters<
	Parameters<typeof createAuthMiddleware>[0]
>[0];

/**
 * The address a two-factor code goes to: the signed-in user's, or the user
 * the signed two-factor challenge cookie names. Null when neither resolves;
 * Better Auth then refuses the request itself, and nothing is sent.
 */
async function twoFactorRecipient(
	ctx: CooldownHookContext
): Promise<string | null> {
	// SAFETY: a Better Auth middleware context carries the session, adapter,
	// option and header projection resolveSessionForHook reads.
	const session = await resolveSessionForHook(
		ctx as Parameters<typeof resolveSessionForHook>[0]
	);
	if (session?.user.email) {
		return session.user.email;
	}
	const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
	const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
	if (!identifier) {
		return null;
	}
	const verification = verificationSchema.parse(
		await ctx.context.internalAdapter.findVerificationValue(identifier)
	);
	if (!verification) {
		return null;
	}
	const user = recordSchema.parse(
		await ctx.context.internalAdapter.findUserById(verification.value)
	);
	return user?.email ?? null;
}

async function requestRecipient(
	ctx: CooldownHookContext
): Promise<string | null> {
	if (ctx.path === TWO_FACTOR_SEND_PATH) {
		return await twoFactorRecipient(ctx);
	}
	return bodyEmailSchema.parse(ctx.body) ?? null;
}

const EMAIL_FACTOR_PATH = "/email-otp/send-verification-otp";
/** Endpoints Better Auth guards with its form CSRF middleware. */
const FORM_CSRF_PATHS: ReadonlySet<string> = new Set([
	"/sign-in/magic-link",
	EMAIL_FACTOR_PATH,
]);
const codeTypeSchema = z
	.object({ type: z.string() })
	.transform((body) => body.type)
	.optional()
	.catch(undefined);

/**
 * The budget this request spends (lib/email-cooldown.ts). A 2FA code needs a
 * password-verified caller, and so does the emailed sign-in code that follows
 * a correct password: the signed pending-login cookie only a correct password
 * sets names this very address. Everything else is open to anyone who knows
 * an address.
 */
async function requestBudget(
	ctx: CooldownHookContext,
	recipient: string
): Promise<EmailBudget> {
	if (ctx.path === TWO_FACTOR_SEND_PATH) {
		return "account";
	}
	if (
		ctx.path !== EMAIL_FACTOR_PATH ||
		codeTypeSchema.parse(ctx.body) !== "sign-in"
	) {
		return "request";
	}
	// SAFETY: a Better Auth middleware context carries the cookie helpers and
	// auth context pendingLogin reads.
	const { pending } = await pendingLogin(
		ctx as unknown as Parameters<typeof pendingLogin>[0]
	);
	return pending?.flow === "password" &&
		pending.email === recipient.trim().toLowerCase()
		? "account"
		: "request";
}

/**
 * Claim the recipient's slot for a cooldown endpoint, or throw its 429. For
 * an endpoint whose own work depends on the account, also answer it here and
 * run it detached (lib/deferred-auth-request.ts); the returned answer then
 * replaces the endpoint's. The claim pays for exactly this request's send
 * (lib/email-send-budget.ts), never for another request's.
 */
export async function enforceEmailCooldown(
	ctx: CooldownHookContext
): Promise<Record<string, unknown> | undefined> {
	if (!(ctx.path && EMAIL_COOLDOWN_PATHS.has(ctx.path))) {
		return;
	}
	// SAFETY: a Better Auth middleware context carries the request, header,
	// session and option projection these helpers read.
	const hookContext = ctx as Parameters<typeof isDeferredReplay>[0];
	if (isDeferredReplay(hookContext)) {
		// Ryu's own replay of a request this hook already claimed and answered.
		return;
	}
	if (FORM_CSRF_PATHS.has(ctx.path)) {
		// The endpoint's own form CSRF check (Better Auth's `formCsrfMiddleware`,
		// run as is), before anything is claimed or answered early: a request
		// it refuses gets its 403 here, spends nothing and is never replayed.
		// SAFETY: the hook context is the middleware context it expects.
		await formCsrfMiddleware(
			ctx as unknown as Parameters<typeof formCsrfMiddleware>[0]
		);
	}
	const recipient = await requestRecipient(ctx);
	let prepaid: PrepaidSend | null = null;
	if (recipient) {
		const budget = await requestBudget(ctx, recipient);
		let claim: Awaited<ReturnType<typeof claimEmailCooldown>>;
		try {
			claim = await claimEmailCooldown(recipient, budget);
			prepaid = claim.allowed ? prepaidSend(budget, recipient) : null;
		} catch (error) {
			// A store outage hits every address alike, so failing open here
			// reveals nothing; the send path claims again and fails the same way.
			console.error("Email cooldown claim failed:", error);
			claim = { allowed: true };
		}
		if (!claim.allowed) {
			throw emailCooldownRefusal(claim.retryAfter);
		}
	}
	const answer = await deferredAnswer(hookContext, prepaid);
	if (!answer) {
		// The endpoint runs in this request; its sender finds the prepaid send.
		rememberPrepaidSend(ctx.request, prepaid);
	}
	return answer ?? undefined;
}

/**
 * Register after the email OTP, magic-link and email-harmony plugins, so their
 * own request checks (an invalid or disposable address) refuse first and an
 * already refused request never spends the recipient's cooldown.
 */
export function emailCooldownPlugin(): BetterAuthPlugin {
	return {
		id: "ryu-email-cooldown",
		hooks: {
			before: [
				{
					matcher: (ctx: { path?: string }) =>
						Boolean(ctx.path && EMAIL_COOLDOWN_PATHS.has(ctx.path)),
					handler: createAuthMiddleware(async (ctx) => {
						const answer = await enforceEmailCooldown(ctx);
						return answer ? ctx.json(answer) : undefined;
					}),
				},
			],
		},
	};
}
