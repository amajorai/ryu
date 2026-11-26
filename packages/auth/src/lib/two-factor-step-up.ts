import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
	authorizeStepUp,
	STEP_UP_REQUIRED,
	type StepUpScope,
} from "./step-up.ts";
import { resolveSessionForHook } from "./step-up-plugin.ts";

/**
 * Better Auth endpoints that reveal, re-mint or remove an EXISTING
 * authenticator: its secret (`get-totp-uri`, and `enable`, which rotates it),
 * its recovery codes (`generate-backup-codes`), or the factor itself
 * (`disable`). Each asks only for the account password, so on an account that
 * already has two-factor turned on a stolen session plus a reused or phished
 * password would hand over the second factor every other step-up relies on
 * (billing accepts only the authenticator code). While two-factor is on they
 * therefore need an `account.security` step-up, which for such an account
 * accepts only a second-factor proof, never the password. First enrollment
 * (two-factor still off) stays password-gated so it can be finished.
 *
 * Paths are matched exactly, like `STEP_UP_AUTH_PATHS`; re-read this list when
 * upgrading `better-auth`.
 */
export const ENROLLED_TWO_FACTOR_STEP_UP_PATHS: ReadonlySet<string> = new Set([
	"/two-factor/disable",
	"/two-factor/enable",
	"/two-factor/generate-backup-codes",
	"/two-factor/get-totp-uri",
]);

/**
 * Better Auth's emailed two-factor code endpoints. Ryu sends them only during
 * sign-in, while the pending two-factor cookie stands in for a session. Called
 * with a signed-in session, `verify-otp` instead turns `twoFactorEnabled` on
 * from an emailed code with no authenticator behind it, which every
 * stored-enrollment check (org `requireMfa`, marketplace publishing, the
 * account mandate) would then read as an enrolled second factor. Ryu's own
 * step-up flow never routes a signed-in session here, so the gate refuses both
 * paths whenever one is present.
 */
export const SIGN_IN_ONLY_TWO_FACTOR_PATHS: ReadonlySet<string> = new Set([
	"/two-factor/send-otp",
	"/two-factor/verify-otp",
]);

export const TWO_FACTOR_OTP_SIGNED_IN = "TWO_FACTOR_OTP_SIGNED_IN";

export const TWO_FACTOR_OTP_ENROLLMENT_DISABLED =
	"TWO_FACTOR_OTP_ENROLLMENT_DISABLED";

/**
 * Better Auth's authenticator and recovery code checks. The library counts
 * wrong guesses only for a pending two-factor sign-in (its cookie, no session
 * yet). Asked by a signed-in session over HTTP, both answer right or wrong
 * with no counter and no lockout, and a right recovery code is spent. On an
 * account whose two-factor is on that is a guessing oracle beside the step-up
 * guess budget (`reserveStepUpAttempt`), so the gate refuses the HTTP request.
 *
 * Two callers stay open. First enrollment (two-factor still off) confirms the
 * secret the caller was just handed. Ryu's own step-up check
 * (`/api/step-up/verify`) reserves a guess and then calls `auth.api.verifyTOTP`
 * or `auth.api.verifyBackupCode` in process, which carries no `request`; every
 * HTTP call reaches a hook with one.
 */
export const ENROLLED_TWO_FACTOR_VERIFY_PATHS: ReadonlySet<string> = new Set([
	"/two-factor/verify-backup-code",
	"/two-factor/verify-totp",
]);

export const TWO_FACTOR_VERIFY_SIGNED_IN = "TWO_FACTOR_VERIFY_SIGNED_IN";

/**
 * Whether a code check on `path` is refused: an HTTP request (`viaHttp`) from a
 * signed-in session of an account whose two-factor is on.
 */
export function isRefusedTwoFactorVerify(
	path: string,
	caller: { signedIn: boolean; twoFactorEnabled: boolean; viaHttp: boolean }
): boolean {
	return (
		ENROLLED_TWO_FACTOR_VERIFY_PATHS.has(path) &&
		caller.viaHttp &&
		caller.signedIn &&
		caller.twoFactorEnabled
	);
}

/**
 * Better Auth's `/two-factor/enable` also takes `method: "otp"`, which turns
 * `twoFactorEnabled` on from the password alone with no authenticator behind
 * it. Ryu enrolls only authenticator apps, so any method other than `totp`
 * (an omitted method defaults to `totp`) is refused.
 */
export function isRefusedTwoFactorEnableMethod(body: unknown): boolean {
	if (typeof body !== "object" || body === null || !("method" in body)) {
		return false;
	}
	const { method } = body as { method?: unknown };
	return method !== undefined && method !== "totp";
}

/**
 * The step-up scope `path` needs for an account whose two-factor state is
 * `twoFactorEnabled`, or null when it needs none.
 */
export function enrolledTwoFactorStepUpScope(
	path: string,
	twoFactorEnabled: boolean
): StepUpScope | null {
	return twoFactorEnabled && ENROLLED_TWO_FACTOR_STEP_UP_PATHS.has(path)
		? "account.security"
		: null;
}

/**
 * Gates `ENROLLED_TWO_FACTOR_STEP_UP_PATHS` behind a one-use
 * `account.security` proof while the caller's two-factor is on. Like
 * `stepUpGate`, it judges the session the endpoint will run as (cookie or
 * bearer) and fails open with no session so the endpoint's own 401 answers.
 * It also refuses `SIGN_IN_ONLY_TWO_FACTOR_PATHS` to a signed-in session, so an
 * emailed code can never mark an account as having an authenticator, and it
 * refuses `/two-factor/enable` with any method but `totp` for the same reason.
 * Last, it refuses `ENROLLED_TWO_FACTOR_VERIFY_PATHS` over HTTP to a signed-in
 * session whose two-factor is on, so a code is only ever guessed against the
 * step-up budget.
 */
export function twoFactorStepUpGate(): BetterAuthPlugin {
	return {
		id: "ryu-two-factor-step-up",
		hooks: {
			before: [
				{
					matcher: (context: { path?: string }) =>
						context.path === "/two-factor/enable",
					handler: createAuthMiddleware(async (ctx) => {
						if (!isRefusedTwoFactorEnableMethod(ctx.body)) {
							return;
						}
						throw new APIError("BAD_REQUEST", {
							code: TWO_FACTOR_OTP_ENROLLMENT_DISABLED,
							message: "Two-factor enrollment needs an authenticator app",
						});
					}),
				},
				{
					matcher: (context: { path?: string }) =>
						ENROLLED_TWO_FACTOR_STEP_UP_PATHS.has(context.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						const resolved = await resolveSessionForHook(ctx);
						if (!resolved?.session.id) {
							return;
						}
						const scope = enrolledTwoFactorStepUpScope(
							ctx.path ?? "",
							resolved.user.twoFactorEnabled === true
						);
						if (!scope) {
							return;
						}
						if (await authorizeStepUp(resolved.session.id, scope)) {
							return;
						}
						throw new APIError("FORBIDDEN", {
							code: STEP_UP_REQUIRED,
							message: "Verify your identity to continue",
							scope,
						});
					}),
				},
				{
					matcher: (context: { path?: string }) =>
						SIGN_IN_ONLY_TWO_FACTOR_PATHS.has(context.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						const resolved = await resolveSessionForHook(ctx);
						if (!resolved?.session.id) {
							return;
						}
						throw new APIError("FORBIDDEN", {
							code: TWO_FACTOR_OTP_SIGNED_IN,
							message:
								"Emailed two-factor codes are only used to finish signing in",
						});
					}),
				},
				{
					matcher: (context: { path?: string }) =>
						ENROLLED_TWO_FACTOR_VERIFY_PATHS.has(context.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						// An in-process `auth.api` call carries no request. It is
						// Ryu's own step-up check, whose guess is already counted.
						const viaHttp = Boolean(ctx.request);
						const resolved = viaHttp ? await resolveSessionForHook(ctx) : null;
						const refused = isRefusedTwoFactorVerify(ctx.path ?? "", {
							signedIn: Boolean(resolved?.session.id),
							twoFactorEnabled: resolved?.user.twoFactorEnabled === true,
							viaHttp,
						});
						if (!refused) {
							return;
						}
						throw new APIError("FORBIDDEN", {
							code: TWO_FACTOR_VERIFY_SIGNED_IN,
							message: "Verify your identity to continue",
						});
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
