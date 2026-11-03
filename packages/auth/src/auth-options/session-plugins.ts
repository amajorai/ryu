import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import {
	deviceAuthorization,
	lastLoginMethod,
	multiSession,
	username,
} from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { expoWithoutSessionHandoff } from "../lib/expo-session-handoff.ts";
import { LOGIN_APPROVAL_CLIENTS } from "../lib/login-approval-contract.ts";
import { loginApprovalSessionPlugin } from "../lib/login-approval-session-plugin.ts";
import { ryuClientSessionPlugin } from "../lib/ryu-client-session.ts";
import {
	platformAdminAccessControl,
	platformAdminRoles,
} from "../lib/step-up.ts";
import { telegramMiniAppSessionPlugin } from "../lib/telegram-mini-app-session-plugin.ts";

// Device authorization and client sessions, then (after `bearer()`, which
// index.ts installs between the two groups) multi-session, Expo and platform
// admin.

export const deviceSessionPlugins = [
	deviceAuthorization({
		verificationUri: `${process.env.FRONTEND_URL || "http://localhost:3001"}/device`,
		validateClient: (clientId) =>
			[...Object.values(LOGIN_APPROVAL_CLIENTS), "ryu-cli", "ryu-mcp"].includes(
				clientId
			),
	}),
	loginApprovalSessionPlugin(),
	// Stamp the device-flow client id (ryu-desktop, ryu-cli, ...) on the
	// session `/device/token` issues, so routes can tell a Ryu client's
	// session from a browser sign-in. Server-side only; see the module.
	ryuClientSessionPlugin(),
	// Telegram Mini App launches exchange Telegram-signed initData for a bearer
	// session, only for a Telegram identity the owner already linked.
	telegramMiniAppSessionPlugin(),
	// The built-in GET /device only returns { user_code, status } — it hides the
	// requesting clientId/scope. The approve consent screen needs to name the app
	// asking for access ("Ryu Desktop is requesting…"), so expose a read-only
	// lookup that surfaces the persisted clientId + scope for a pending code.
	{
		id: "device-authorization-info",
		endpoints: {
			getDeviceInfo: createAuthEndpoint(
				"/device/info",
				{ method: "GET" },
				async (ctx) => {
					const userCode = (ctx.query?.user_code ?? "")
						.replace(/-/g, "")
						.toUpperCase();
					if (!userCode) {
						throw new APIError("BAD_REQUEST", {
							error: "invalid_request",
							error_description: "user_code is required",
						});
					}
					const record = await ctx.context.adapter.findOne<{
						clientId?: string | null;
						scope?: string | null;
						status?: string | null;
					}>({
						model: "deviceCode",
						where: [{ field: "userCode", value: userCode }],
					});
					if (!record) {
						throw new APIError("NOT_FOUND", {
							error: "invalid_request",
							error_description: "Unknown or expired code",
						});
					}
					return ctx.json({
						clientId: record.clientId ?? null,
						scope: record.scope ?? null,
						status: record.status ?? null,
					});
				}
			),
		},
	},
] satisfies NonNullable<BetterAuthOptions["plugins"]>;

export const accountSessionPlugins = [
	// Multi-account: keep multiple concurrent device sessions in one browser
	// so a user can switch between accounts (Notion-style). Cookie-based, so it
	// drives web directly; the Bearer surfaces (desktop/cli/tui/extension/native)
	// each keep their own local token vault and switch the active bearer token.
	multiSession({ maximumSessions: 5 }),
	// Never copies the session cookie into a ryu:// redirect (see module).
	expoWithoutSessionHandoff(),
	admin({
		// Support access (#545): cap any impersonation session at 1 hour, the AC
		// ceiling for a user-granted support session. Admins still cannot
		// impersonate other admins by default (Better Auth's built-in behavior —
		// we deliberately do NOT grant the `impersonate-admins` permission).
		impersonationSessionDuration: 60 * 60,
		// The default admin role would also grant session listing (live
		// tokens), raw user updates and user creation, none of them consented,
		// stepped up or audited. Grant only the step-up-gated staff actions.
		ac: platformAdminAccessControl,
		roles: platformAdminRoles,
	}),
	lastLoginMethod(),
	username({
		minUsernameLength: 3,
		maxUsernameLength: 32,
	}),
] satisfies NonNullable<BetterAuthOptions["plugins"]>;
