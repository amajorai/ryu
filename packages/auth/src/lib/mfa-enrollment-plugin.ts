import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	sessionMiddleware,
} from "better-auth/api";
import { z } from "zod";
import {
	forgetMfaEnrollment,
	hasStrongSecondFactor,
	isDeviceSessionPath,
	isMfaEnrollmentBlockedAuthPath,
	isPlatformStaff,
	isStrongSessionFactor,
	MFA_ENROLLMENT_REQUIRED_CODE,
	MFA_ENROLLMENT_REQUIRED_MESSAGE,
	MFA_LAST_FACTOR_CODE,
	MFA_LAST_FACTOR_MESSAGE,
	mfaEnrollmentAppliesToUser,
	mfaEnrollmentEnforcedForUser,
	ORG_MFA_FACTOR_PROVISIONING_MESSAGE,
	ORG_MFA_SESSION_REQUIRED_CODE,
	requiresMfaEnrollment,
	resolveCurrentRole,
	SESSION_STRONG_FACTOR_FIELD,
	STAFF_FACTOR_PROVISIONING_AUTH_PATHS,
	STAFF_SESSION_FACTOR_REQUIRED_CODE,
	STAFF_SESSION_FACTOR_REQUIRED_MESSAGE,
	staffSessionNeedsStrongFactor,
	strongFactorForLoginPath,
	wouldRemoveLastFactor,
} from "./mfa-enrollment.ts";
import { organizationMutationSucceeded } from "./organization-mutation-result.ts";
import { type HookSession, resolveSessionForHook } from "./step-up-plugin.ts";

const TWO_FACTOR_DISABLE_PATH = "/two-factor/disable";
const PASSKEY_DELETE_PATH = "/passkey/delete-passkey";

const passkeyDeleteBody = z
	.object({ id: z.string().min(1).nullable().catch(null) })
	.catch(() => ({ id: null }));

interface PasskeyRow {
	id?: string;
}

interface AdapterContext {
	context: {
		adapter: {
			findOne<T>(input: {
				model: string;
				where: { field: string; value: string }[];
			}): Promise<T | null>;
			findMany<T>(input: {
				model: string;
				where?: { field: string; value: string }[];
			}): Promise<T[]>;
		};
		internalAdapter: {
			findUserById(userId: string): Promise<unknown>;
		};
	};
}

async function userPasskeys(
	ctx: AdapterContext,
	userId: string
): Promise<PasskeyRow[]> {
	return await ctx.context.adapter.findMany<PasskeyRow>({
		model: "passkey",
		where: [{ field: "userId", value: userId }],
	});
}

function enrollmentRequiredError(): APIError {
	return new APIError("FORBIDDEN", {
		code: MFA_ENROLLMENT_REQUIRED_CODE,
		message: MFA_ENROLLMENT_REQUIRED_MESSAGE,
	});
}

function staffSessionFactorError(): APIError {
	return new APIError("FORBIDDEN", {
		code: STAFF_SESSION_FACTOR_REQUIRED_CODE,
		message: STAFF_SESSION_FACTOR_REQUIRED_MESSAGE,
	});
}

/** The `strongFactor` stamp on this session's stored row, if any. */
async function storedStrongFactor(
	ctx: AdapterContext,
	sessionId: string
): Promise<unknown> {
	const row = await ctx.context.adapter.findOne<Record<string, unknown>>({
		model: "session",
		where: [{ field: "id", value: sessionId }],
	});
	return row?.[SESSION_STRONG_FACTOR_FIELD];
}

/**
 * Whether this staff session was signed in without (and never re-proved) a
 * strong factor. Support sessions are the support-access plugin's to restrict.
 * Fails closed.
 */
async function staffSessionIsWeak(
	ctx: AdapterContext,
	session: Pick<HookSession, "session" | "user">
): Promise<boolean> {
	if (session.session.impersonatedBy) {
		return false;
	}
	const stored = session.session as { id: string; strongFactor?: unknown };
	try {
		return await staffSessionNeedsStrongFactor({
			findStoredStrongFactor: (sessionId) => storedStrongFactor(ctx, sessionId),
			session: { id: stored.id, strongFactor: stored.strongFactor },
			user: session.user,
		});
	} catch {
		return true;
	}
}

/**
 * Whether this Better Auth caller still has to enroll a factor. Support
 * sessions are the support-access plugin's to restrict. Fails closed: a
 * storage error answers "must enroll" rather than letting a credential out.
 */
async function sessionMustEnroll(
	ctx: AdapterContext,
	session: Pick<HookSession, "session" | "user">
): Promise<boolean> {
	if (
		session.session.impersonatedBy ||
		!mfaEnrollmentEnforcedForUser(session.user)
	) {
		return false;
	}
	try {
		return await requiresMfaEnrollment({
			countPasskeys: async (userId) => (await userPasskeys(ctx, userId)).length,
			enforced: true,
			findStoredRole: async (userId) => {
				const stored = await ctx.context.internalAdapter.findUserById(userId);
				return (stored as { role?: string | null } | null)?.role;
			},
			user: session.user,
		});
	} catch {
		return true;
	}
}

/** Remove the JWT plugin's `set-auth-jwt` header from this response. */
function dropAuthJwtHeader(responseHeaders: Headers | undefined): void {
	responseHeaders?.delete("set-auth-jwt");
	const exposed = responseHeaders?.get("access-control-expose-headers");
	if (exposed) {
		responseHeaders?.set(
			"access-control-expose-headers",
			exposed
				.split(",")
				.map((value) => value.trim())
				.filter((value) => value.toLowerCase() !== "set-auth-jwt")
				.join(", ")
		);
	}
}

const DEVICE_APPROVE_PATH = "/device/approve";
const DEVICE_APPROVAL_PROOF_PREFIX = "ryu-device-strong-approval:";

const deviceApproveBody = z
	.object({ userCode: z.string().min(1).nullable().catch(null) })
	.catch(() => ({ userCode: null }));
const deviceRedeemBody = z
	.object({ device_code: z.string().min(1).nullable().catch(null) })
	.catch(() => ({ device_code: null }));

interface DeviceCodeRow {
	deviceCode?: string;
	expiresAt?: Date | string;
	status?: string;
	userCode?: string;
	userId?: unknown;
}

/** Verification identifier for a device code; the code itself is never stored. */
function deviceApprovalProofIdentifier(deviceCode: string): string {
	return `${DEVICE_APPROVAL_PROOF_PREFIX}${createHash("sha256").update(deviceCode).digest("hex")}`;
}

/** Whether this session was signed in with, or re-proved, a strong factor. */
async function sessionHasStrongFactor(
	ctx: AdapterContext,
	session: Pick<HookSession, "session">
): Promise<boolean> {
	const stored = session.session as { id: string; strongFactor?: unknown };
	if (isStrongSessionFactor(stored.strongFactor)) {
		return true;
	}
	return isStrongSessionFactor(await storedStrongFactor(ctx, stored.id));
}

/**
 * After a successful `/device/approve`, remember that the approving session
 * proved a strong factor, keyed by the (hashed) device code and bound to the
 * approving user. The device session redeemed from that code is then stamped
 * `delegated` (see `consumeDeviceApprovalProof`), so organizations that
 * require two-factor accept the desktop app or CLI exactly when the browser
 * that approved it did. A weak approval, or any failure here, records nothing
 * and the device session stays unstamped.
 */
async function recordDeviceApprovalProof(
	ctx: AdapterContext & {
		body?: unknown;
		context: {
			internalAdapter: {
				createVerificationValue(data: {
					expiresAt: Date;
					identifier: string;
					value: string;
				}): Promise<unknown>;
			};
			returned?: unknown;
		};
	} & Parameters<typeof resolveSessionForHook>[0]
): Promise<void> {
	if (!organizationMutationSucceeded(ctx.context.returned)) {
		return;
	}
	try {
		const { userCode } = deviceApproveBody.parse(ctx.body);
		if (!userCode) {
			return;
		}
		const session = await resolveSessionForHook(ctx);
		if (
			!session ||
			session.session.impersonatedBy ||
			!(await sessionHasStrongFactor(ctx, session))
		) {
			return;
		}
		const candidates = [
			userCode,
			userCode.replace(/-/g, "").toUpperCase(),
		].filter((value, index, all) => all.indexOf(value) === index);
		for (const candidate of candidates) {
			const record = await ctx.context.adapter.findOne<DeviceCodeRow>({
				model: "deviceCode",
				where: [{ field: "userCode", value: candidate }],
			});
			if (
				record?.deviceCode &&
				record.expiresAt &&
				record.status === "approved" &&
				String(record.userId) === session.user.id
			) {
				await ctx.context.internalAdapter.createVerificationValue({
					expiresAt: new Date(record.expiresAt),
					identifier: deviceApprovalProofIdentifier(record.deviceCode),
					value: session.user.id,
				});
				return;
			}
		}
	} catch {
		// Fail closed: without the proof the device session stays unstamped.
	}
}

/**
 * Consume the strong-approval proof for the device code being redeemed. True
 * only when it exists, is unexpired and was recorded for this same user.
 */
async function consumeDeviceApprovalProof(
	authContext: {
		internalAdapter: {
			consumeVerificationValue(
				identifier: string
			): Promise<{ value?: unknown } | null>;
		};
	},
	body: unknown,
	userId: string
): Promise<boolean> {
	const deviceCode = deviceRedeemBody.parse(body).device_code;
	if (!deviceCode) {
		return false;
	}
	try {
		const proof = await authContext.internalAdapter.consumeVerificationValue(
			deviceApprovalProofIdentifier(deviceCode)
		);
		return proof?.value === userId;
	} catch {
		return false;
	}
}

function lastFactorError(): APIError {
	return new APIError("FORBIDDEN", {
		code: MFA_LAST_FACTOR_CODE,
		message: MFA_LAST_FACTOR_MESSAGE,
	});
}

function orgSessionFactorError(): APIError {
	return new APIError("FORBIDDEN", {
		code: ORG_MFA_SESSION_REQUIRED_CODE,
		message: ORG_MFA_FACTOR_PROVISIONING_MESSAGE,
	});
}

export interface MfaEnrollmentPluginOptions {
	/**
	 * Whether this account belongs to an organization that requires two-factor
	 * authentication. Such a member, like platform staff, may add or reveal a
	 * factor only from a session that proved one. May throw; a failure refuses.
	 */
	userInMfaRequiredOrganization: (userId: string) => Promise<boolean>;
}

/**
 * Why this session may not add or reveal a sign-in factor, or null when it
 * may. An account that already holds a factor needs a session that proved one
 * when it is platform staff or a member of an organization that requires
 * two-factor; otherwise a mailbox-only session could enroll its own
 * authenticator or passkey and then use it to satisfy those checks. First
 * enrollment stays open so an unenrolled account can finish it. Support
 * sessions are the support-access plugin's to restrict. Fails closed.
 */
async function factorProvisioningRefusal(
	ctx: AdapterContext,
	session: Pick<HookSession, "session" | "user">,
	options: MfaEnrollmentPluginOptions
): Promise<APIError | null> {
	if (session.session.impersonatedBy) {
		return null;
	}
	let strong: boolean;
	try {
		strong = await sessionHasStrongFactor(ctx, session);
	} catch {
		strong = false;
	}
	if (strong) {
		return null;
	}
	let enrolled: boolean;
	try {
		enrolled = hasStrongSecondFactor({
			passkeyCount: (await userPasskeys(ctx, session.user.id)).length,
			twoFactorEnabled: session.user.twoFactorEnabled === true,
		});
	} catch {
		enrolled = true;
	}
	if (!enrolled) {
		return null;
	}
	if (isPlatformStaff(session.user)) {
		return staffSessionFactorError();
	}
	let orgRequiresFactor: boolean;
	try {
		orgRequiresFactor = await options.userInMfaRequiredOrganization(
			session.user.id
		);
	} catch {
		orgRequiresFactor = true;
	}
	return orgRequiresFactor ? orgSessionFactorError() : null;
}

/**
 * Mandatory 2FA support inside Better Auth:
 *
 * - `GET /mfa-enrollment/status` tells clients whether the signed-in account
 *   still has to enroll an authenticator app or passkey.
 * - The mandate is enforced for everyone when `AUTH_REQUIRE_MFA` is on, and
 *   for platform staff always.
 * - While the mandate is enforced, disabling TOTP or deleting a passkey is
 *   refused when it would leave the account with no strong factor.
 * - While the mandate is enforced, an unenrolled account cannot mint a
 *   credential that outlives the browser session or skips the API gate: API
 *   keys, Core JWTs (`/token` and the `set-auth-jwt` header on
 *   `/get-session`), one-time tokens, device-flow approvals, OAuth/MCP
 *   authorizations and client secrets, and new organizations or invitations
 *   are refused with `mfa_enrollment_required`. So is Better Auth's
 *   `/admin/*` surface. API keys minted before the
 *   mandate stay valid; they carry only their own scopes, never a session.
 * - Platform staff must also have signed the session in with an authenticator
 *   app, a recovery code or a passkey (stamped as `session.strongFactor` when
 *   the session is created, or later by a strong step-up). Until then the same
 *   endpoints answer `staff_session_factor_required`, and so does adding or
 *   revealing a factor on an account that already holds one.
 * - A member of an organization that requires two-factor is held to the same
 *   rule for adding or revealing a factor (`org_mfa_session_required`), so a
 *   mailbox-only session cannot enroll its own passkey to satisfy the policy.
 *
 * Registered as a plugin (not a config-level hook) so its before-hooks run
 * after `bearer` and see token callers too; see `stepUpGate`.
 */
export function mfaEnrollmentPlugin(
	options: MfaEnrollmentPluginOptions
): BetterAuthPlugin {
	return {
		id: "ryu-mfa-enrollment",
		schema: {
			session: {
				fields: {
					[SESSION_STRONG_FACTOR_FIELD]: {
						type: "string",
						required: false,
						input: false,
					},
				},
			},
		},
		init(authContext) {
			return {
				options: {
					databaseHooks: {
						session: {
							create: {
								// Stamp a session created by proving a strong factor. The
								// endpoint context names the path; every other creation
								// (password, magic link, email code, OAuth) stays unstamped
								// and keeps any stamp a server-side override copied over.
								before: async (
									session: Record<string, unknown>,
									context: { body?: unknown; path?: string } | null
								) => {
									let factor = strongFactorForLoginPath(context?.path);
									if (
										!factor &&
										isDeviceSessionPath(context?.path) &&
										typeof session.userId === "string"
									) {
										// A device approved from a session that proved a strong
										// factor inherits it (see `recordDeviceApprovalProof`).
										if (
											await consumeDeviceApprovalProof(
												authContext,
												context?.body,
												session.userId
											)
										) {
											factor = "delegated";
										} else {
											// See `StrongSessionFactor`: the approval was already
											// refused to a weak staff session. A lookup failure
											// leaves the session unstamped (refused for staff).
											const user = await authContext.internalAdapter
												.findUserById(session.userId)
												.catch(() => null);
											if (
												user &&
												isPlatformStaff(
													user as { email?: string; role?: string }
												)
											) {
												factor = "delegated";
											}
										}
									}
									if (!factor) {
										return;
									}
									return {
										data: { ...session, [SESSION_STRONG_FACTOR_FIELD]: factor },
									};
								},
							},
						},
					},
				},
			};
		},
		endpoints: {
			mfaEnrollmentStatus: createAuthEndpoint(
				"/mfa-enrollment/status",
				{
					method: "GET",
					metadata: { noStore: true },
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const user = ctx.context.session.user as {
						email?: string | null;
						id: string;
						isAnonymous?: boolean | null;
						role?: string | null;
						twoFactorEnabled?: boolean | null;
					};
					const passkeys = await userPasskeys(ctx, user.id);
					const twoFactorEnabled = user.twoFactorEnabled === true;
					// A just-approved account's session can still carry the cached
					// "waitlist" role; the stored role decides the exemption.
					const role = await resolveCurrentRole(user, async (userId) => {
						const stored =
							await ctx.context.internalAdapter.findUserById(userId);
						return (stored as { role?: string | null } | null)?.role;
					});
					const enforced =
						mfaEnrollmentEnforcedForUser({ ...user, role }) &&
						mfaEnrollmentAppliesToUser({ ...user, role });
					const enrolled = hasStrongSecondFactor({
						passkeyCount: passkeys.length,
						twoFactorEnabled,
					});
					const enrollmentRequired = enforced && !enrolled;
					// An enrolled staff account whose session never proved a
					// strong factor must confirm it before staff surfaces answer.
					const sessionFactorRequired =
						!enrollmentRequired &&
						(await staffSessionIsWeak(ctx, {
							session: ctx.context.session.session,
							user: {
								...user,
								email: user.email ?? undefined,
								role: role ?? undefined,
							},
						}));
					let code: string | null = null;
					if (enrollmentRequired) {
						code = MFA_ENROLLMENT_REQUIRED_CODE;
					} else if (sessionFactorRequired) {
						code = STAFF_SESSION_FACTOR_REQUIRED_CODE;
					}
					return ctx.json({
						code,
						enforced,
						passkeyCount: passkeys.length,
						required: enrollmentRequired || sessionFactorRequired,
						sessionFactorRequired,
						twoFactorEnabled,
					});
				}
			),
		},
		hooks: {
			after: [
				{
					matcher: (ctx: { path?: string }) => ctx.path === DEVICE_APPROVE_PATH,
					handler: createAuthMiddleware(async (ctx) => {
						await recordDeviceApprovalProof(ctx);
					}),
				},
				{
					matcher: (ctx: { path?: string }) => ctx.path === "/get-session",
					handler: createAuthMiddleware(async (ctx) => {
						const session = ctx.context.session ?? ctx.context.newSession;
						if (!(session?.session && session.user)) {
							return;
						}
						// The JWT plugin attaches a Core-accepted token here; Core
						// verifies it offline, so an unenrolled account (or a staff
						// session that never proved a strong factor) must not get one.
						if (
							(await sessionMustEnroll(ctx, session)) ||
							(await staffSessionIsWeak(ctx, session))
						) {
							dropAuthJwtHeader(ctx.context.responseHeaders);
						}
					}),
				},
			],
			before: [
				{
					matcher: (ctx: { path?: string }) =>
						isMfaEnrollmentBlockedAuthPath(ctx.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						const session = await resolveSessionForHook(ctx);
						if (!session) {
							// The endpoint's own auth answers an anonymous caller.
							return;
						}
						if (await sessionMustEnroll(ctx, session)) {
							throw enrollmentRequiredError();
						}
						if (await staffSessionIsWeak(ctx, session)) {
							throw staffSessionFactorError();
						}
					}),
				},
				{
					// Staff, and members of an organization that requires two-factor,
					// may add or reveal a factor only from a session that proved one;
					// see `STAFF_FACTOR_PROVISIONING_AUTH_PATHS` and
					// `factorProvisioningRefusal`.
					matcher: (ctx: { path?: string }) =>
						STAFF_FACTOR_PROVISIONING_AUTH_PATHS.has(ctx.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						const session = await resolveSessionForHook(ctx);
						if (!session) {
							return;
						}
						const refusal = await factorProvisioningRefusal(
							ctx,
							session,
							options
						);
						if (refusal) {
							throw refusal;
						}
					}),
				},
				{
					matcher: (ctx: { path?: string }) =>
						ctx.path === TWO_FACTOR_DISABLE_PATH ||
						ctx.path === PASSKEY_DELETE_PATH,
					handler: createAuthMiddleware(async (ctx) => {
						const session = await resolveSessionForHook(ctx);
						if (!session) {
							// The endpoint's own session middleware answers 401.
							return;
						}
						const userId = session.user.id;
						forgetMfaEnrollment(userId);
						if (
							!(
								mfaEnrollmentEnforcedForUser(session.user) &&
								mfaEnrollmentAppliesToUser(session.user)
							)
						) {
							return;
						}
						const passkeys = await userPasskeys(ctx, userId);
						const state = {
							passkeyCount: passkeys.length,
							twoFactorEnabled: session.user.twoFactorEnabled === true,
						};
						if (ctx.path === TWO_FACTOR_DISABLE_PATH) {
							if (wouldRemoveLastFactor(state, "two-factor")) {
								throw lastFactorError();
							}
							return;
						}
						const { id } = passkeyDeleteBody.parse(ctx.body);
						// A passkey this user does not own is left to the native
						// handler's own not-found answer; it cannot lower their count.
						if (!passkeys.some((passkey) => passkey.id === id)) {
							return;
						}
						if (wouldRemoveLastFactor(state, "passkey")) {
							throw lastFactorError();
						}
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
