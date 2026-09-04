import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { redeemDeviceCode } from "better-auth/plugins/device-authorization";
import { z } from "zod";
import { LOGIN_APPROVAL_CLIENTS } from "./login-approval-contract.ts";

const deviceSessionBody = z.object({
	client_id: z.string().min(1).max(80),
	device_code: z.string().min(1).max(191),
	grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
});

/**
 * Redeem the website's device grant into the normal Better Auth cookie.
 *
 * Better Auth's RFC 8628 token endpoint intentionally returns a bearer token
 * and does not set a browser cookie. The website requester is the one special
 * case: it needs the same HttpOnly cookie as a normal browser sign-in. Keeping
 * this as a Better Auth endpoint lets the library own the signed cookie format,
 * cache strategy, and one-time device-code claim instead of duplicating them in
 * the Hono API router.
 */
export function loginApprovalSessionPlugin(): BetterAuthPlugin {
	return {
		id: "ryu-login-approval-session",
		endpoints: {
			loginApprovalSession: createAuthEndpoint(
				"/device/session",
				{
					body: deviceSessionBody,
					method: "POST",
					metadata: { noStore: true },
				},
				async (ctx) => {
					const { client_id: clientId, device_code: deviceCode } = ctx.body;
					if (clientId !== LOGIN_APPROVAL_CLIENTS.web) {
						throw new APIError("BAD_REQUEST", {
							error: "invalid_grant",
							error_description: "Invalid client ID",
						});
					}

					const { user } = await redeemDeviceCode({
						ctx,
						deviceCode,
						authorizeRedemption: async (deviceCodeRecord) => {
							if (deviceCodeRecord.clientId !== clientId) {
								throw new APIError("BAD_REQUEST", {
									error: "invalid_grant",
									error_description: "Client ID mismatch",
								});
							}
							return {
								context: undefined,
								ownershipWhere: { field: "clientId", value: clientId },
							};
						},
						prepareRedemption: () => undefined,
					});

					const session = await ctx.context.internalAdapter.createSession(
						user.id
					);
					if (!session) {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							error: "server_error",
							error_description: "Failed to create a browser session",
						});
					}
					await setSessionCookie(ctx, { session, user });
					ctx.setHeader("Cache-Control", "no-store");
					ctx.setHeader("Pragma", "no-cache");
					return ctx.json({
						expires_in: Math.floor(
							(new Date(session.expiresAt).getTime() - Date.now()) / 1000
						),
						ok: true,
					});
				}
			),
		},
	};
}
