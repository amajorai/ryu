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
 */
export function twoFactorStepUpGate(): BetterAuthPlugin {
	return {
		id: "ryu-two-factor-step-up",
		hooks: {
			before: [
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
			],
		},
	} satisfies BetterAuthPlugin;
}
