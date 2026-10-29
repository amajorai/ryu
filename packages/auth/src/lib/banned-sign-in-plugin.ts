import { abuseReasonClassLabel } from "@ryu/db/models/abuse.model";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { z } from "zod";

/**
 * The restricted sign-in answer (managed guardrails spec 05.9).
 *
 * Better Auth's admin plugin refuses a session for a banned user with a bare
 * 403 `BANNED_USER` ("You have been banned from this application"). This
 * plugin runs the same check one step earlier, from a session-create hook
 * registered before the admin plugin's, and refuses with the same status and
 * code plus a `reasonLabel` (the plain reason class label) and the public
 * `appealPath`, so the sign-in screen can say why and where to appeal.
 *
 * Revealing the label is safe: a session is only created after the caller
 * proved they control the account (password, passkey, email code or OAuth).
 * The label is the plain one used in the ban email, so child safety is never
 * named in more detail than "child safety policy".
 *
 * A ban past its `banExpires` is left to the admin plugin's own hook, which
 * clears it and lets the sign-in continue. Keep the code `BANNED_USER`: web
 * and desktop clients recognize it from either hook, and a client that gets
 * the admin plugin's bare answer still shows the restricted screen, only
 * without the reason.
 */

export const BANNED_USER_ERROR_CODE = "BANNED_USER";
export const RESTRICTED_ACCOUNT_MESSAGE = "Your account is restricted";
export const APPEAL_PATH = "/appeal";

const bannedUserSchema = z.looseObject({
	banExpires: z.coerce.date().nullish(),
	banReason: z.string().nullish(),
	banned: z.boolean().nullish(),
});

/** The refusal for this user row, or null when the user may sign in. */
export function bannedSignInError(user: unknown, now: Date): APIError | null {
	const parsed = bannedUserSchema.safeParse(user);
	if (!(parsed.success && parsed.data.banned === true)) {
		return null;
	}
	const { banExpires, banReason } = parsed.data;
	if (banExpires && banExpires.getTime() < now.getTime()) {
		return null;
	}
	return new APIError("FORBIDDEN", {
		appealPath: APPEAL_PATH,
		code: BANNED_USER_ERROR_CODE,
		message: RESTRICTED_ACCOUNT_MESSAGE,
		reasonLabel: abuseReasonClassLabel(banReason ?? "other"),
	});
}

/**
 * Register before `admin()` in the plugin list: Better Auth runs plugin
 * database hooks in plugin order, so this refusal wins over the bare one.
 */
export function bannedSignInPlugin(): BetterAuthPlugin {
	return {
		id: "ryu-banned-sign-in",
		init: () => ({
			options: {
				databaseHooks: {
					session: {
						create: {
							before: async (session, ctx) => {
								// Server-side session writes without a request context are
								// skipped, like the admin plugin's own check.
								if (!ctx) {
									return;
								}
								const user = await ctx.context.internalAdapter.findUserById(
									session.userId
								);
								const refusal = bannedSignInError(user, new Date());
								if (refusal) {
									throw refusal;
								}
							},
						},
					},
				},
			},
		}),
	};
}
