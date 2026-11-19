import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
	bodySchema,
	clearCookie,
	type LoginAssuranceContext,
	mailboxKey,
	newLoginSession,
	normalizeEmail,
	pendingLogin,
	pendingMatchesSession,
	removeNewSession,
	requestHeader,
	setPendingLogin,
	setTrustedDevice,
	stringValue,
	trustedDevice,
} from "./login-assurance-state.ts";

export {
	LOGIN_PENDING_COOKIE,
	LOGIN_TRUST_COOKIE,
	LOGIN_TRUST_MAX_AGE_SECONDS,
} from "./login-assurance-state.ts";

/** The order used after a password has been accepted. */
export type LoginFactor = "passkey" | "two-factor" | "email" | "none";

export type LoginFallbackFactor = "two-factor" | "email";

export interface LoginFactorDecisionInput {
	fallback?: LoginFallbackFactor;
	hasPasskey: boolean;
	trustedDevice: boolean;
	twoFactorEnabled: boolean;
}

export interface LoginAssuranceChallenge {
	fallbackFactor: LoginFallbackFactor;
	loginFactor: Exclude<LoginFactor, "none">;
}

export interface LoginFactorDecision {
	factor: LoginFactor;
	fallbackFactor: LoginFallbackFactor;
}

/**
 * Decide the factor without touching a request or database. Keeping this pure
 * makes the precedence explicit and protects it from UI-only regressions.
 */
export function decideLoginFactor(
	input: LoginFactorDecisionInput
): LoginFactorDecision {
	const fallbackFactor: LoginFallbackFactor = input.twoFactorEnabled
		? "two-factor"
		: "email";

	if (input.trustedDevice) {
		return { factor: "none", fallbackFactor };
	}

	if (input.fallback === "two-factor" && input.twoFactorEnabled) {
		return { factor: "two-factor", fallbackFactor };
	}

	if (input.fallback === "email" && !input.twoFactorEnabled) {
		return { factor: "email", fallbackFactor };
	}

	if (input.hasPasskey) {
		return { factor: "passkey", fallbackFactor };
	}

	if (input.twoFactorEnabled) {
		return { factor: "two-factor", fallbackFactor };
	}

	return { factor: "email", fallbackFactor };
}

/**
 * Runs in the config-level after hook, before Better Auth's 2FA plugin hook.
 * That ordering lets passkey and email challenges replace the password session
 * while still allowing the built-in 2FA plugin to own its fallback challenge.
 */
export async function loginAssuranceAfterPassword(
	ctx: LoginAssuranceContext
): Promise<LoginAssuranceChallenge | undefined> {
	if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-in/username") {
		return;
	}

	const session = newLoginSession(ctx);
	if (!session) {
		return;
	}

	const body = bodySchema.parse(ctx.body);
	const fallback =
		body?.factorFallback === "two-factor" || body?.factorFallback === "email"
			? body.factorFallback
			: undefined;
	const rememberDevice = body?.rememberDevice === true;
	const twoFactorEnabled = Boolean(
		ctx.context.newSession?.user?.twoFactorEnabled
	);

	if (await trustedDevice(ctx, session.userId)) {
		if (rememberDevice) {
			await setTrustedDevice(ctx, session.userId);
		}
		return;
	}

	const pending = await pendingLogin(ctx);
	const pendingMatches =
		pending.pending?.flow === "password" &&
		pendingMatchesSession(pending.pending, session, ctx.context.secret);
	if (pendingMatches && fallback === "two-factor" && twoFactorEnabled) {
		await setPendingLogin(ctx, {
			email: session.userEmail,
			rememberDevice,
			userId: session.userId,
		});
		return;
	}

	const passkeys = await ctx.context.adapter.findMany({
		model: "passkey",
		where: [{ field: "userId", value: session.userId }],
	});
	const decision = decideLoginFactor({
		fallback: pendingMatches ? fallback : undefined,
		hasPasskey: passkeys.length > 0,
		trustedDevice: false,
		twoFactorEnabled,
	});

	if (decision.factor === "none") {
		return;
	}

	await setPendingLogin(ctx, {
		email: session.userEmail,
		rememberDevice,
		userId: session.userId,
	});

	if (decision.factor === "two-factor") {
		// Leave the password-created session for Better Auth's 2FA after hook,
		// which replaces it with its own signed challenge cookie.
		return;
	}

	await removeNewSession(ctx, session);
	return ctx.json({
		fallbackFactor: decision.fallbackFactor,
		loginFactor: decision.factor,
	});
}

/**
 * Bind an optional 30-day device choice to a magic-link request. The signed
 * pending cookie is consumed only after Better Auth finishes the link on this
 * same browser, so opening the email on another device cannot trust it.
 *
 * The cookie names the requested address and no account, and it is set
 * without looking one up: a registered, a banned and an unknown address get
 * the same cookie after the same work, so the answer cannot tell them apart.
 */
export async function loginAssuranceAfterMagicLinkRequest(
	ctx: LoginAssuranceContext
): Promise<void> {
	if (ctx.path !== "/sign-in/magic-link") {
		return;
	}

	const email = stringValue(bodySchema.parse(ctx.body)?.email);
	if (!email) {
		return;
	}

	// The cookie names an opaque key of the mailbox the caller typed, never the
	// address Better Auth resolved it to (lib/login-assurance-state.ts).
	const requested = mailboxKey(ctx.context.secret, email);
	if (!requested) {
		return;
	}
	const pending = await pendingLogin(ctx);
	const rememberDevice = requestHeader(ctx, "x-ryu-remember-device") === "true";
	if (!rememberDevice) {
		if (
			pending.pending?.flow === "magic-link" &&
			pending.pending.mailboxKey === requested
		) {
			clearCookie(ctx, pending.cookie);
		}
		return;
	}

	await setPendingLogin(ctx, {
		flow: "magic-link",
		mailboxKey: requested,
		rememberDevice: true,
	});
}

/**
 * Prevent an email OTP from a different account being used to finish a
 * pending password login. Direct email-OTP sign-in without a pending cookie is
 * still supported by Better Auth's normal passwordless flow.
 */
export async function assertPendingEmailMatches(
	ctx: LoginAssuranceContext
): Promise<void> {
	if (ctx.path !== "/sign-in/email-otp") {
		return;
	}

	const { pending } = await pendingLogin(ctx);
	if (pending?.flow !== "password") {
		return;
	}

	const email = stringValue(bodySchema.parse(ctx.body)?.email);
	if (!email || normalizeEmail(email) !== pending.email) {
		throw new APIError("UNAUTHORIZED", {
			message: "This sign-in challenge belongs to a different account",
		});
	}
}

/**
 * Better Auth's passkey endpoint normally accepts any discoverable passkey.
 * During the password-login flow, bind the assertion to the account whose
 * password was just accepted before the plugin creates a real session.
 */
export async function assertPendingPasskeyMatches(
	ctx: LoginAssuranceContext
): Promise<void> {
	const { pending } = await pendingLogin(ctx);
	if (pending?.flow !== "password") {
		return;
	}

	const response = bodySchema.parse(ctx.body).response;
	const credentialId = stringValue(response?.id);
	if (!credentialId) {
		throw new APIError("UNAUTHORIZED", {
			message: "Invalid passkey sign-in challenge",
		});
	}

	const passkey = await ctx.context.adapter.findOne({
		model: "passkey",
		where: [{ field: "credentialID", value: credentialId }],
	});
	if (!passkey || String(passkey.userId) !== pending.userId) {
		throw new APIError("UNAUTHORIZED", {
			message: "That passkey is not registered to this account",
		});
	}
}

/**
 * Finalize the unified trust cookie after a passkey, 2FA, or email fallback
 * succeeds. The trust choice is never accepted until the factor endpoint has
 * completed successfully.
 */
export async function loginAssuranceAfterFactor(
	ctx: LoginAssuranceContext
): Promise<void> {
	if (
		ctx.path !== "/magic-link/verify" &&
		ctx.path !== "/passkey/verify-authentication" &&
		ctx.path !== "/sign-in/email-otp" &&
		ctx.path !== "/two-factor/verify-totp" &&
		ctx.path !== "/two-factor/verify-otp" &&
		ctx.path !== "/two-factor/verify-backup-code"
	) {
		return;
	}

	const session = newLoginSession(ctx);
	if (!session) {
		return;
	}

	const pending = await pendingLogin(ctx);
	const expectedFlow =
		ctx.path === "/magic-link/verify" ? "magic-link" : "password";
	if (
		pending.pending?.flow === expectedFlow &&
		pendingMatchesSession(pending.pending, session, ctx.context.secret)
	) {
		const body = bodySchema.parse(ctx.body);
		if (pending.pending?.rememberDevice || body?.trustDevice === true) {
			await setTrustedDevice(ctx, session.userId);
		}
		clearCookie(ctx, pending.cookie);
		return;
	}

	if (
		ctx.path === "/passkey/verify-authentication" &&
		requestHeader(ctx, "x-ryu-remember-device") === "true"
	) {
		await setTrustedDevice(ctx, session.userId);
	}
}

/** Remove an abandoned pending cookie when Better Auth's 2FA trust cookie lets the password login through. */
async function cleanupPendingAfterPasswordSignIn(
	ctx: LoginAssuranceContext
): Promise<void> {
	if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-in/username") {
		return;
	}
	const session = newLoginSession(ctx);
	if (!session) {
		return;
	}
	const pending = await pendingLogin(ctx);
	if (
		pending.pending?.flow === "password" &&
		pendingMatchesSession(pending.pending, session, ctx.context.secret)
	) {
		clearCookie(ctx, pending.cookie);
	}
}

/**
 * This hook must run after the built-in two-factor hook. It only cleans up the
 * pending cookie when that hook chose its trusted-device fast path and kept the
 * session alive; a real 2FA challenge leaves the pending cookie in place until
 * its verification endpoint calls loginAssuranceAfterFactor.
 */
export function loginAssuranceCleanupPlugin(): BetterAuthPlugin {
	return {
		id: "ryu-login-assurance-cleanup",
		hooks: {
			after: [
				{
					matcher: (ctx: { path?: string }) =>
						ctx.path === "/sign-in/email" || ctx.path === "/sign-in/username",
					handler: createAuthMiddleware(async (ctx) => {
						await cleanupPendingAfterPasswordSignIn(ctx);
					}),
				},
			],
		},
	};
}
