import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import {
	hasStepUp,
	STEP_UP_REQUIRED,
	stepUpAppliesToUser,
	stepUpRequiresEnrolled2fa,
	stepUpScopeForAuthPath,
} from "./step-up.ts";

/** `Authorization: Bearer …`, case-insensitively. */
const BEARER_PREFIX = /^bearer\s+/i;

/**
 * The id of the session behind this request, or null.
 *
 * Deliberately NOT `getSessionFromCtx` alone. Better Auth's `runBeforeHooks`
 * collects each hook's returned context and applies it only AFTER the whole
 * before-phase, passing every hook the ORIGINAL context — so the `bearer`
 * plugin's rewrite of `Authorization` into a session cookie is invisible to any
 * other before-hook, whatever the plugin order. A gate that relied on it would
 * resolve no session for the desktop, the CLI, Expo, or any token client, and
 * silently wave all of them through while looking correct in a browser.
 *
 * So: cookie callers go through the normal lookup, and a bearer token is
 * resolved straight against the session table. The signature half of a signed
 * token is dropped rather than verified — possession of the raw token IS the
 * credential (Better Auth looks the session up by exactly this value), the
 * signature only makes tampering evident, and a token that resolves to no
 * session simply leaves the gate open for the endpoint's own 401 to handle.
 */
async function resolveSessionId(ctx: {
	context: {
		internalAdapter: {
			findSession: (token: string) => Promise<{
				session: { id: string };
				user?: { twoFactorEnabled?: boolean | null } & Record<string, unknown>;
			} | null>;
		};
	};
	headers?: Headers;
	request?: Request;
}): Promise<{ id: string; twoFactorEnabled: boolean } | null> {
	const authorization =
		ctx.request?.headers.get("authorization") ??
		ctx.headers?.get("authorization") ??
		null;
	if (authorization && BEARER_PREFIX.test(authorization)) {
		const token = decodeURIComponent(
			authorization.replace(BEARER_PREFIX, "").trim()
		);
		// Both shapes are in the wild and the token itself cannot tell them apart:
		// a signed session cookie is `<token>.<signature>` (one dot), while the JWT
		// plugin makes some session tokens `<header>.<payload>.<signature>` (two) —
		// the note on `createContext` in packages/api says exactly this. Taking the
		// first segment blindly would look up a base64 header for the JWT case and
		// silently leave the gate open, so try the whole value first and only then
		// its leading segment.
		const candidates = [token, token.split(".")[0]].filter(
			(value, index, all): value is string =>
				typeof value === "string" &&
				value.length > 0 &&
				all.indexOf(value) === index
		);
		for (const candidate of candidates) {
			const found = await ctx.context.internalAdapter.findSession(candidate);
			if (found?.session?.id) {
				return {
					id: found.session.id,
					twoFactorEnabled: Boolean(found.user?.twoFactorEnabled),
				};
			}
		}
	}
	const active = await getSessionFromCtx(
		ctx as unknown as Parameters<typeof getSessionFromCtx>[0]
	);
	return active?.session?.id
		? {
				id: active.session.id,
				twoFactorEnabled: Boolean(active.user?.twoFactorEnabled),
			}
		: null;
}

/**
 * The step-up gate for Better Auth's OWN dangerous endpoints (delete an
 * organization, remove a user, change a member's role). Those are called
 * straight from `authClient`, so they never reach a Hono handler where
 * `requireStepUp` could run.
 *
 * It is a PLUGIN rather than a `hooks.before` entry in the auth config, and that
 * is load-bearing. Better Auth composes the before-phase as
 * `[config.hooks.before, ...pluginBeforeHooks]` (`api/to-auth-endpoints.ts`), so
 * a config-level hook runs BEFORE every plugin — including `bearer`, whose whole
 * job is to turn an `Authorization: Bearer …` header into the session cookie the
 * session lookup reads. From the config slot, `getSessionFromCtx` therefore
 * returns null for every non-browser caller — desktop, CLI, Expo, any
 * token-bearing client — and a gate that resolves no session has nothing to
 * check and waves the request through. That failure is silent: the endpoint's
 * own error comes back and everything looks like it is working.
 *
 * Registering here instead puts the gate after `bearer` in the same phase, so
 * cookie and token callers are both seen. Keep this plugin LAST in the `plugins`
 * array for that reason.
 */
export function stepUpGate(): BetterAuthPlugin {
	return {
		id: "ryu-step-up",
		hooks: {
			before: [
				{
					matcher: (context: { path?: string }) =>
						stepUpScopeForAuthPath(context.path ?? "") !== null,
					handler: createAuthMiddleware(async (ctx) => {
						const scope = stepUpScopeForAuthPath(ctx.path ?? "");
						if (!scope) {
							return;
						}
						const session = await resolveSessionId(ctx);
						// Fails OPEN with no session, on purpose: there is nothing to step
						// up FROM, and the endpoint's own auth check rejects a moment
						// later. A 403 here would only mask that 401.
						if (!session) {
							return;
						}
						if (
							!stepUpAppliesToUser(scope, {
								twoFactorEnabled: session.twoFactorEnabled,
							})
						) {
							return;
						}
						if (stepUpRequiresEnrolled2fa(scope) && !session.twoFactorEnabled) {
							throw new APIError("FORBIDDEN", {
								code: STEP_UP_REQUIRED,
								message: "Turn on two-factor authentication to continue",
								scope,
							});
						}
						if (await hasStepUp(session.id, scope)) {
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
	};
}
