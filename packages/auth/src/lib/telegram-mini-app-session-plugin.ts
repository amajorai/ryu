import { PlatformIdentity } from "@ryu/db/models/platform-identity.model";
import { env } from "@ryu/env/server";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import {
	TELEGRAM_INIT_DATA_MAX_LENGTH,
	verifyTelegramInitData,
} from "./telegram-init-data.ts";

const telegramMiniAppSessionBody = z.object({
	initData: z.string().min(1).max(TELEGRAM_INIT_DATA_MAX_LENGTH),
});

interface LinkedTelegramIdentity {
	enabled?: boolean;
	ryuUserId?: unknown;
}

function configuredBotToken(): string | null {
	const token = env.TELEGRAM_MINI_APP_BOT_TOKEN?.trim() ?? "";
	return token.length > 0 ? token : null;
}

/**
 * Exchange Telegram Mini App launch data for a Ryu bearer session.
 *
 * The Mini App is the shared Desktop shell opened inside Telegram. It proves the
 * Telegram account with `initData`, which Telegram signs with the official
 * bot's token; this endpoint re-verifies that signature server-side and never
 * trusts the browser's parsed `initDataUnsafe`.
 *
 * Sign-in only resolves an identity that the account owner already linked
 * through Telegram Login (`/api/telegram-login`), the same `PlatformIdentity`
 * row the hosted bot uses for inbound messages. It never creates a Ryu account
 * or links a Telegram id on its own. Accounts protected by two-factor
 * authentication fall back to the normal sign-in flow, because Telegram
 * possession alone would skip their second factor.
 *
 * Like the RFC 8628 device grant, the result is a bearer token for the client's
 * local vault, not a cookie: the Telegram WebView is a third-party frame on
 * some clients, and bearer is how every non-cookie Ryu surface authenticates.
 */
export function telegramMiniAppSessionPlugin(): BetterAuthPlugin {
	return {
		id: "ryu-telegram-mini-app-session",
		endpoints: {
			telegramMiniAppSession: createAuthEndpoint(
				"/telegram-mini-app/session",
				{
					body: telegramMiniAppSessionBody,
					method: "POST",
					metadata: { noStore: true },
				},
				async (ctx) => {
					const botToken = configuredBotToken();
					if (!botToken) {
						throw new APIError("SERVICE_UNAVAILABLE", {
							code: "telegram_mini_app_unavailable",
							message:
								"Telegram Mini App sign-in is not enabled for this deployment.",
						});
					}

					const verified = verifyTelegramInitData(ctx.body.initData, botToken);
					if (!verified.ok) {
						throw new APIError("UNAUTHORIZED", {
							code:
								verified.reason === "expired"
									? "telegram_launch_expired"
									: "telegram_launch_invalid",
							message:
								verified.reason === "expired"
									? "This Telegram launch expired. Close and reopen Ryu in Telegram."
									: "Telegram launch data could not be verified.",
						});
					}

					const identity = await PlatformIdentity.findOne({
						platformType: "telegram",
						platformUserId: verified.user.id,
					})
						.select("enabled ryuUserId")
						.lean<LinkedTelegramIdentity>();
					const linkedUserId = identity?.ryuUserId
						? String(identity.ryuUserId)
						: null;
					if (!linkedUserId) {
						throw new APIError("NOT_FOUND", {
							code: "telegram_not_linked",
							message:
								"This Telegram account is not connected to a Ryu account yet.",
						});
					}
					if (identity?.enabled === false) {
						throw new APIError("FORBIDDEN", {
							code: "telegram_disabled",
							message: "Telegram access is disabled for this Ryu workspace.",
						});
					}

					const user =
						await ctx.context.internalAdapter.findUserById(linkedUserId);
					if (!user) {
						throw new APIError("NOT_FOUND", {
							code: "telegram_not_linked",
							message:
								"This Telegram account is not connected to a Ryu account yet.",
						});
					}
					if (
						z.object({ twoFactorEnabled: z.literal(true) }).safeParse(user)
							.success
					) {
						throw new APIError("FORBIDDEN", {
							code: "telegram_second_factor_required",
							message:
								"This account uses two-factor authentication. Sign in with your usual method.",
						});
					}

					const session = await ctx.context.internalAdapter.createSession(
						user.id
					);
					if (!session) {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							code: "telegram_session_failed",
							message: "Could not start a Ryu session.",
						});
					}
					ctx.setHeader("Cache-Control", "no-store");
					ctx.setHeader("Pragma", "no-cache");
					return ctx.json({
						expires_in: Math.floor(
							(new Date(session.expiresAt).getTime() - Date.now()) / 1000
						),
						telegram_user_id: verified.user.id,
						token: session.token,
					});
				}
			),
		},
	};
}
