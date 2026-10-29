import { randomUUID } from "node:crypto";
import {
	SupportAccessAudit,
	SupportAccessGrant,
} from "@ryu/db/models/support-access.model";
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	getAuthoritativeSessionFromCtx,
	getSessionFromCtx,
} from "better-auth/api";
import {
	deleteSessionCookie,
	expireCookie,
	setSessionCookie,
} from "better-auth/cookies";
import { parseSessionOutput, parseUserOutput } from "better-auth/db";
import { z } from "zod";
import { hasStepUp } from "./step-up.ts";
import { resolveSessionForHook } from "./step-up-plugin.ts";
import {
	isGrantUsable,
	isSupportActor,
	isVerifiedSupportActor,
	normalizeScopes,
	resolveSupportAccessSession,
	SUPPORT_ACCESS_RAW_SAFE_PATHS,
	SUPPORT_ACCESS_REQUIRED,
	SUPPORT_ACCESS_SCOPE_REQUIRED,
	type SupportAccessScope,
} from "./support-access.ts";

const BEARER_PREFIX = /^bearer\s+/i;

/**
 * Whether Better Auth's bearer plugin could turn this request's Authorization
 * header into a session. That plugin reads the request header and falls back
 * to the context headers when the first is empty, so check both sources: a
 * bearer caller misread as a cookie caller would skip the support checks.
 */
function hasBearerAuthorization(ctx: {
	headers?: Headers;
	request?: Request;
}): boolean {
	return [
		ctx.request?.headers.get("authorization"),
		ctx.headers?.get("authorization"),
	].some((authorization) =>
		Boolean(authorization && BEARER_PREFIX.test(authorization))
	);
}

const supportSessionBody = z.object({
	reason: z.string().trim().min(1).max(500),
	scopes: z.array(z.string().trim().min(1).max(64)).min(1).optional(),
	userId: z.string().trim().min(1),
});

const SUPPORT_SESSION_MAX_DURATION_MS = 60 * 60 * 1000;

const hasAdminRole = z
	.string()
	.transform((role) =>
		role.split(",").some((value) => value.trim() === "admin")
	)
	.catch(false).parse;

function isValidScopeList(input: readonly unknown[]): boolean {
	const normalized = input.map((value) =>
		z.string().trim().catch("").parse(value)
	);
	const known = normalizeScopes(normalized);
	return (
		known.length === normalized.length &&
		new Set(normalized).size === normalized.length
	);
}

function supportError(code: string, message: string): APIError {
	return new APIError("FORBIDDEN", { code, message });
}

async function closeSupportAudit(
	sessionId: string,
	endedReason: "stopped" | "revoked" | "expired"
): Promise<void> {
	await SupportAccessAudit.updateMany(
		{ endedAt: null, sessionId },
		{ $set: { endedAt: new Date(), endedReason } }
	);
}

/**
 * Restore the actor when a revoke/expiry sweep has already removed the target
 * session row. Better Auth's native stop endpoint normally performs this work,
 * but its session middleware cannot run after a hard deletion. The recovery
 * uses the same signed `admin_session` cookie and native session/cookie helpers;
 * it never manufactures a token or trusts a client-supplied user id.
 */
async function restoreAdminSessionAfterDeletedTarget(
	ctx: Parameters<typeof getAuthoritativeSessionFromCtx>[0]
) {
	const adminCookie = ctx.context.createAuthCookie("admin_session");
	const raw = await ctx.getSignedCookie(adminCookie.name, ctx.context.secret);
	if (!raw) {
		return null;
	}
	const [adminSessionToken, dontRememberMeCookie] = raw.split(":");
	if (!adminSessionToken) {
		return null;
	}
	const adminSession =
		await ctx.context.internalAdapter.findSession(adminSessionToken);
	if (
		!adminSession ||
		new Date(adminSession.session.expiresAt).getTime() <= Date.now()
	) {
		return null;
	}

	deleteSessionCookie(ctx);
	await setSessionCookie(ctx, adminSession, Boolean(dontRememberMeCookie));
	expireCookie(ctx, adminCookie);
	try {
		await SupportAccessAudit.updateMany(
			{ actorId: adminSession.user.id, endedAt: null },
			{ $set: { endedAt: new Date(), endedReason: "stopped" } }
		);
	} catch (error) {
		// The target row is already gone and the actor has been restored. An audit
		// outage must not strand the operator behind a dead support session; the
		// next status/audit read can reconcile the orphaned row.
		ctx.context.logger.error(
			"Failed to close support access audit during native recovery",
			error
		);
	}
	return ctx.json({
		session: parseSessionOutput(ctx.context.options, adminSession.session),
		user: parseUserOutput(ctx.context.options, adminSession.user),
	});
}

/**
 * The Better Auth-owned part of hosted support access.
 *
 * The public `/admin/impersonate-user` endpoint is intentionally closed. The
 * support endpoint below is the only issuer: it checks the current allowlisted
 * staff session, user grant, requested scope, and platform step-up before using
 * Better Auth's own `internalAdapter.createSession` and cookie helpers. This
 * keeps native session lookup, expiry, and `admin_session` restoration intact
 * without making a second token format or a server-only bypass header.
 */
export function supportAccessPlugin() {
	return {
		id: "ryu-support-access",
		endpoints: {
			startSupportSession: createAuthEndpoint.serverOnly(
				{
					body: supportSessionBody,
					method: "POST",
					metadata: { noStore: true },
					requireHeaders: true,
				},
				async (ctx) => {
					const actorSession = await getAuthoritativeSessionFromCtx(ctx);
					if (!(actorSession?.session && actorSession.user)) {
						throw new APIError("UNAUTHORIZED", {
							message: "Sign in as a support actor to continue",
						});
					}
					if (actorSession.session.impersonatedBy) {
						throw supportError(
							SUPPORT_ACCESS_REQUIRED,
							"A support session cannot start another support session"
						);
					}

					const actor = actorSession.user;
					if (!(isVerifiedSupportActor(actor) && hasAdminRole(actor.role))) {
						throw supportError(
							SUPPORT_ACCESS_REQUIRED,
							"This account is not an allowlisted support actor"
						);
					}
					if (!actor.twoFactorEnabled) {
						throw supportError(
							"STEP_UP_REQUIRED",
							"Turn on two-factor authentication to start support access"
						);
					}
					if (!(await hasStepUp(actorSession.session.id, "platform.admin"))) {
						throw supportError(
							"STEP_UP_REQUIRED",
							"Verify your identity to start support access"
						);
					}

					const target = await ctx.context.internalAdapter.findUserById(
						ctx.body.userId
					);
					if (!target) {
						throw new APIError("NOT_FOUND", {
							message: "Target user not found",
						});
					}
					const targetRole = z
						.object({ role: z.string().optional() })
						.parse(target).role;
					if (hasAdminRole(targetRole) || isSupportActor(target.email)) {
						throw supportError(
							SUPPORT_ACCESS_REQUIRED,
							"Support access cannot target an administrator"
						);
					}

					const grant = await SupportAccessGrant.findOne({
						status: "active",
						userId: target.id,
					}).lean<{
						_id?: unknown;
						expiresAt?: Date | string | null;
						scopes?: string[] | null;
						status?: string;
					} | null>();
					if (!(grant && isGrantUsable(grant))) {
						throw supportError(
							SUPPORT_ACCESS_REQUIRED,
							"The user has not granted live support access"
						);
					}

					if (
						!(Array.isArray(grant.scopes) && isValidScopeList(grant.scopes))
					) {
						throw supportError(
							SUPPORT_ACCESS_REQUIRED,
							"The support grant has invalid scopes"
						);
					}
					const grantScopes = normalizeScopes(grant.scopes);
					if (grantScopes.length === 0) {
						throw supportError(
							SUPPORT_ACCESS_REQUIRED,
							"The support grant has no usable scopes"
						);
					}
					if (ctx.body.scopes && !isValidScopeList(ctx.body.scopes)) {
						throw new APIError("BAD_REQUEST", {
							message: "scopes must contain unique supported values",
						});
					}
					const requestedScopes = ctx.body.scopes
						? normalizeScopes(ctx.body.scopes)
						: grantScopes;
					const scopes = requestedScopes.filter((scope) =>
						grantScopes.includes(scope)
					);
					if (scopes.length !== requestedScopes.length || scopes.length === 0) {
						throw supportError(
							SUPPORT_ACCESS_SCOPE_REQUIRED,
							"The requested support scope is not in the user grant"
						);
					}

					const now = new Date();
					const grantExpiresAt = z
						.union([
							z.date(),
							z
								.string()
								.transform((value) => new Date(value))
								.pipe(z.date()),
						])
						.parse(grant.expiresAt);
					const nativeExpiresAt = new Date(
						now.getTime() + SUPPORT_SESSION_MAX_DURATION_MS
					);
					const expiresAt =
						grantExpiresAt < nativeExpiresAt ? grantExpiresAt : nativeExpiresAt;
					const supportSession =
						await ctx.context.internalAdapter.createSession(
							target.id,
							true,
							{
								expiresAt,
								impersonatedBy: actor.id,
							},
							true
						);
					// The grant may have been revoked or replaced while the native session
					// write was in flight. Re-read its authoritative row before writing an
					// audit entry; the per-request validator remains the final race guard.
					let stillLive: {
						expiresAt?: Date | string | null;
						status?: string;
					} | null;
					try {
						stillLive = await SupportAccessGrant.findOne({
							_id: String(grant._id),
							status: "active",
							userId: target.id,
						}).lean<{
							expiresAt?: Date | string | null;
							status?: string;
						} | null>();
					} catch (error) {
						try {
							await ctx.context.internalAdapter.deleteSession(
								supportSession.token
							);
						} catch (cleanupError) {
							ctx.context.logger.error(
								"Failed to clean up support session after grant lookup failure",
								cleanupError
							);
						}
						ctx.context.logger.error(
							"Failed to revalidate support access grant",
							error
						);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Support access is temporarily unavailable",
						});
					}
					if (!(stillLive && isGrantUsable(stillLive))) {
						await ctx.context.internalAdapter.deleteSession(
							supportSession.token
						);
						throw supportError(
							SUPPORT_ACCESS_REQUIRED,
							"The user grant ended before support access could start"
						);
					}

					const auditId = randomUUID();
					try {
						await SupportAccessAudit.create({
							_id: auditId,
							actorEmail: actor.email,
							actorId: actor.id,
							grantId: String(grant._id),
							reason: ctx.body.reason,
							scopes,
							sessionId: supportSession.id,
							startedAt: now,
							userId: target.id,
						});
					} catch (error) {
						// A support session without its audit binding is never usable. Remove
						// the native session before surfacing the database failure.
						try {
							await ctx.context.internalAdapter.deleteSession(
								supportSession.token
							);
						} catch (cleanupError) {
							ctx.context.logger.error(
								"Failed to clean up unaudited support session",
								cleanupError
							);
						}
						ctx.context.logger.error(
							"Failed to write support access audit",
							error
						);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Support access could not be audited",
						});
					}

					// The owner's status read deletes support sessions that stay unbound
					// past a grace period, conditional on the `updatedAt` it read. Touch
					// the row now that its audit binding is durable: either the touch
					// lands first and the sweep leaves the row, or the row is already
					// gone and this start fails instead of handing off a dead session.
					let bound: unknown;
					try {
						bound = await ctx.context.internalAdapter.updateSession(
							supportSession.token,
							{ updatedAt: new Date() }
						);
					} catch (error) {
						try {
							await ctx.context.internalAdapter.deleteSession(
								supportSession.token
							);
							await closeSupportAudit(supportSession.id, "stopped");
						} catch (cleanupError) {
							ctx.context.logger.error(
								"Failed to clean up unbound support session",
								cleanupError
							);
						}
						ctx.context.logger.error(
							"Failed to bind support session to its audit",
							error
						);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Support access is temporarily unavailable",
						});
					}
					if (!bound) {
						await closeSupportAudit(supportSession.id, "expired");
						throw new APIError("CONFLICT", {
							message:
								"The support session lapsed before it could start. Start it again.",
						});
					}

					// A grant replacement can race with the audit write as well as the
					// native session write. Re-read after the audit is durable so an
					// orphaned audit/session pair is never handed to the caller.
					let liveAfterAudit: {
						expiresAt?: Date | string | null;
						status?: string;
					} | null;
					try {
						liveAfterAudit = await SupportAccessGrant.findOne({
							_id: String(grant._id),
							status: "active",
							userId: target.id,
						}).lean<{
							expiresAt?: Date | string | null;
							status?: string;
						} | null>();
					} catch (error) {
						try {
							await ctx.context.internalAdapter.deleteSession(
								supportSession.token
							);
							await closeSupportAudit(supportSession.id, "revoked");
						} catch (cleanupError) {
							ctx.context.logger.error(
								"Failed to clean up support race after audit",
								cleanupError
							);
						}
						ctx.context.logger.error(
							"Failed to revalidate support access after audit",
							error
						);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Support access is temporarily unavailable",
						});
					}
					if (!(liveAfterAudit && isGrantUsable(liveAfterAudit))) {
						try {
							await ctx.context.internalAdapter.deleteSession(
								supportSession.token
							);
							await closeSupportAudit(supportSession.id, "revoked");
						} catch (cleanupError) {
							ctx.context.logger.error(
								"Failed to clean up replaced support session",
								cleanupError
							);
						}
						throw supportError(
							SUPPORT_ACCESS_REQUIRED,
							"The user grant ended before support access could start"
						);
					}

					// This is the same handoff Better Auth's native impersonation route
					// uses: preserve the actor token in `admin_session`, then install the
					// target session through Better Auth's signed cookie helper.
					try {
						deleteSessionCookie(ctx);
						const dontRememberMe = await ctx.getSignedCookie(
							ctx.context.authCookies.dontRememberToken.name,
							ctx.context.secret
						);
						const adminCookie = ctx.context.createAuthCookie("admin_session");
						await ctx.setSignedCookie(
							adminCookie.name,
							`${actorSession.session.token}:${dontRememberMe || ""}`,
							ctx.context.secret,
							ctx.context.authCookies.sessionToken.attributes
						);
						await setSessionCookie(
							ctx,
							{ session: supportSession, user: target },
							true
						);
					} catch (error) {
						try {
							await ctx.context.internalAdapter.deleteSession(
								supportSession.token
							);
							await closeSupportAudit(supportSession.id, "stopped");
						} catch (cleanupError) {
							ctx.context.logger.error(
								"Failed to clean up support handoff",
								cleanupError
							);
						}
						ctx.context.logger.error(
							"Failed to set support handoff cookies",
							error
						);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Support access could not be handed off",
						});
					}

					return ctx.json({
						auditId,
						expiresAt,
						grantId: String(grant._id),
						scopes,
						session: parseSessionOutput(ctx.context.options, supportSession),
						user: parseUserOutput(ctx.context.options, target),
					});
				}
			),
		},
		hooks: {
			before: [
				{
					// This runs for every Better Auth route. It is intentionally
					// fail-closed for an impersonated session: a new native endpoint
					// cannot accidentally become a support escape hatch by omission.
					matcher: () => true,
					handler: createAuthMiddleware(async (ctx) => {
						const path = ctx.path ?? "";
						let cachedSupportSession = false;
						if (path === "/get-session" && !hasBearerAuthorization(ctx)) {
							// Display reads are what the cookie cache exists for, and every
							// client polls this route. The signed cache is bound to the
							// session token and carries `impersonatedBy`, so an ordinary
							// session can be answered from it, while a support session still
							// falls through to the live store and grant checks below. Bearer
							// callers are excluded: their session is not in the cookies.
							// Honors the caller's own `disableCookieCache`.
							const cached = await getSessionFromCtx(ctx);
							// Never leave the cached copy behind for later hooks to trust.
							ctx.context.session = null;
							if (!cached?.session?.impersonatedBy) {
								return;
							}
							cachedSupportSession = true;
						}
						let session = await resolveSessionForHook(ctx);
						if (cachedSupportSession && !session?.session) {
							// The handler answers this route from the same signed cache, so
							// a support session the store no longer has would otherwise be
							// served until the cache expires.
							throw supportError(
								SUPPORT_ACCESS_REQUIRED,
								"Support session has ended"
							);
						}
						if (session?.session?.impersonatedBy) {
							// A cached support cookie must not survive deletion of the
							// authoritative target session, even while its grant is live.
							const authoritative = session.session.token
								? await ctx.context.internalAdapter.findSession(
										session.session.token
									)
								: null;
							ctx.context.session = authoritative;
							session = authoritative;
							ctx.query = { ...ctx.query, disableCookieCache: true };
							if (
								!session?.session &&
								path !== "/admin/stop-impersonating" &&
								path !== "/sign-out"
							) {
								throw supportError(
									SUPPORT_ACCESS_REQUIRED,
									"Support session has ended"
								);
							}
						}
						if (path === "/admin/stop-impersonating" && !session?.session) {
							// Revoke/expiry may have removed the target row before the
							// operator clicked Stop. Restore the original Better Auth
							// session from its signed recovery cookie in that case.
							const restored = await restoreAdminSessionAfterDeletedTarget(ctx);
							if (restored) {
								return restored;
							}
						}
						if (path === "/admin/impersonate-user") {
							// Native admin impersonation is intentionally not an alternate
							// issuer. The support endpoint below is the only path that binds
							// the new native session to consent and an audit row.
							if (session?.session) {
								throw supportError(
									SUPPORT_ACCESS_REQUIRED,
									"Use the audited support access flow"
								);
							}
							return;
						}
						if (!session?.session?.impersonatedBy) {
							return;
						}

						// Stop and sign-out are cleanup operations. They remain available even
						// after a grant expires/revokes so the native actor restoration path
						// cannot strand the support operator behind a dead session.
						if (
							SUPPORT_ACCESS_RAW_SAFE_PATHS.has(path) &&
							path !== "/get-session"
						) {
							const isBearerRequest = hasBearerAuthorization(ctx);
							const adminCookie = ctx.context.createAuthCookie("admin_session");
							const adminSessionCookie = isBearerRequest
								? await ctx.getSignedCookie(
										adminCookie.name,
										ctx.context.secret
									)
								: null;
							if (
								isBearerRequest &&
								(path === "/sign-out" || !adminSessionCookie) &&
								session.session.token
							) {
								// Better Auth's native cleanup reads the session cookie. Bearer
								// clients keep the actor token in their own vault, so explicitly
								// remove the target session when native actor restoration is not
								// possible and close its audit.
								await ctx.context.internalAdapter.deleteSession(
									session.session.token
								);
								try {
									await closeSupportAudit(session.session.id, "stopped");
								} catch (error) {
									// The native target is already deleted, so an audit outage
									// cannot re-authorize it or justify keeping the bearer alive.
									ctx.context.logger.error(
										"Failed to close bearer support access audit",
										error
									);
								}
								// A bearer caller can still carry browser cookies (for example,
								// a desktop webview). Clear the native target and recovery
								// cookies too; the actor token remains in the caller's vault.
								deleteSessionCookie(ctx);
								expireCookie(
									ctx,
									ctx.context.createAuthCookie("admin_session")
								);
								if (path === "/admin/stop-impersonating") {
									return ctx.json({
										message:
											"Support session ended. Select your retained support credential to continue.",
										requiresActorSession: true,
										restored: false,
										success: true,
									});
								}
								return ctx.json({ success: true });
							}
							return;
						}

						let supportSession: Awaited<
							ReturnType<typeof resolveSupportAccessSession>
						>;
						try {
							supportSession = await resolveSupportAccessSession(session);
						} catch (error) {
							ctx.context.logger.error(
								"Failed to validate support access session",
								error
							);
							throw new APIError("INTERNAL_SERVER_ERROR", {
								message: "Support access is temporarily unavailable",
							});
						}
						if (!supportSession) {
							throw new APIError("UNAUTHORIZED", {
								message: "Support access is no longer active",
							});
						}
						if (path === "/get-session") {
							// The issuer caps the native row at the grant expiry (<= 1h).
							// A bearer request carries no dont-remember cookie, so Better
							// Auth's sliding refresh would otherwise extend that row to the
							// ordinary account lifetime on first use. Hook mutations of
							// `ctx` do not reach the endpoint; return the query override.
							return {
								context: {
									query: {
										...ctx.query,
										disableCookieCache: true,
										disableRefresh: true,
									},
								},
							};
						}
						throw supportError(
							SUPPORT_ACCESS_SCOPE_REQUIRED,
							"Support sessions may use only their approved diagnostic flow"
						);
					}),
				},
			],
			after: [
				{
					matcher: (ctx) =>
						ctx.path === "/admin/stop-impersonating" ||
						ctx.path === "/sign-out",
					handler: createAuthMiddleware(async (ctx) => {
						const supportSession = ctx.context.session;
						const sessionId = supportSession?.session?.id;
						if (!(sessionId && supportSession?.session?.impersonatedBy)) {
							return;
						}
						try {
							await closeSupportAudit(sessionId, "stopped");
							if (ctx.path === "/sign-out") {
								expireCookie(
									ctx,
									ctx.context.createAuthCookie("admin_session")
								);
							}
						} catch (error) {
							// Native stop/sign-out already removed the session. Logging an audit
							// maintenance error cannot re-authorize it, so preserve cleanup while
							// making the failure visible to operations.
							ctx.context.logger.error(
								"Failed to close support access audit",
								error
							);
						}
					}),
				},
				{
					matcher: (ctx) => ctx.path === "/get-session",
					handler: createAuthMiddleware(async (ctx) => {
						if (!ctx.context.session?.session?.impersonatedBy) {
							return;
						}
						// The JWT plugin adds a bearer token to get-session responses. A
						// support session must never turn into a portable unrestricted JWT;
						// its live grant is checked by the API context on every request.
						ctx.context.responseHeaders?.delete("set-auth-jwt");
						const exposed = ctx.context.responseHeaders?.get(
							"access-control-expose-headers"
						);
						if (exposed) {
							const filtered = exposed
								.split(",")
								.map((value) => value.trim())
								.filter((value) => value.toLowerCase() !== "set-auth-jwt");
							ctx.context.responseHeaders?.set(
								"access-control-expose-headers",
								filtered.join(", ")
							);
						}
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}

export type { SupportAccessScope };
