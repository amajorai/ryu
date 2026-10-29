import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import { z } from "zod";
import {
	ADMIN_UPDATE_USER_PATH,
	authorizeStepUp,
	isClientNativeApiKeyCreate,
	isClientNativeOrgApiKeyMutation,
	isClientNativeOrgApiKeyRead,
	isNativeApiKeyRead,
	isStepUpApiKeyMutation,
	NATIVE_API_KEY_CREATE_PATH,
	NATIVE_API_KEY_GET_PATH,
	protectedAdminUpdateUserFields,
	STEP_UP_INVITE_MEMBER_PATH,
	STEP_UP_REQUIRED,
	stepUpAppliesToUser,
	stepUpRequiresEnrolled2fa,
	stepUpScopeForApiKeyConfig,
	stepUpScopeForAuthPath,
	stepUpScopeForInvitedRole,
} from "./step-up.ts";

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
 * So: a bearer header is judged exactly as the bearer plugin will judge it
 * (`bearerEndpointSessionToken`), and its session is read straight from the
 * session table; when the plugin would leave the request's cookie in place, the
 * hook reads that cookie session instead. The hook and the endpoint must judge
 * the SAME session: a header the plugin rejects (bad signature, JWT-shaped
 * value) leaves the endpoint running as the caller's cookie session, so a hook
 * that resolved the bearer anyway would vet one session while the endpoint
 * acted as another. A token that resolves to no session leaves the gate open
 * for the endpoint's own 401 to handle.
 */
export interface HookSession {
	session: {
		expiresAt?: Date | string | null;
		id: string;
		impersonatedBy?: string | null;
		token?: string;
		userId?: string;
	};
	user: {
		email?: string;
		id: string;
		role?: string;
		twoFactorEnabled?: boolean | null;
	};
}

interface HookContext {
	context: {
		session?: HookSession | null;
		internalAdapter: {
			findSession: (token: string) => Promise<HookSession | null>;
		};
		options: {
			plugins?: readonly { id: string; options?: unknown }[];
		};
		secret: string;
	};
	headers?: Headers;
	request?: Request;
}

/** `Authorization: Bearer …`, compared the way the bearer plugin compares it. */
const BEARER_SCHEME = "bearer ";
/** better-call's signed-cookie signature: standard base64 of a SHA-256 HMAC. */
const SIGNED_COOKIE_SIGNATURE_LENGTH = 44;
const BASE64_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const bearerRequiresSignature = z.object({ requireSignature: z.literal(true) });

function tryDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * `@better-auth/utils` base64 decoding, which the bearer plugin verifies
 * signatures with: either alphabet (url-safe when `-` or `_` appears), stopping
 * at the first `=`, and throwing on any other character.
 */
function decodeBearerSignature(value: string): Uint8Array<ArrayBuffer> {
	const alphabet =
		value.includes("-") || value.includes("_")
			? BASE64URL_ALPHABET
			: BASE64_ALPHABET;
	const bytes: number[] = [];
	let buffer = 0;
	let bitsCollected = 0;
	for (const char of value) {
		if (char === "=") {
			break;
		}
		const sextet = alphabet.indexOf(char);
		if (sextet === -1) {
			throw new Error("Invalid base64 signature");
		}
		buffer = (buffer << 6) | sextet;
		bitsCollected += 6;
		if (bitsCollected >= 8) {
			bitsCollected -= 8;
			bytes.push((buffer >> bitsCollected) & 255);
		}
	}
	return Uint8Array.from(bytes);
}

async function verifyHmac(
	secret: string,
	value: string,
	signature: Uint8Array<ArrayBuffer>
): Promise<boolean> {
	const key = await globalThis.crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"]
	);
	return globalThis.crypto.subtle.verify(
		"HMAC",
		key,
		signature,
		new TextEncoder().encode(value)
	);
}

/**
 * The session token a Better Auth endpoint will run as for this Authorization
 * header, mirroring better-auth 1.7.1's `bearer()` before-hook and then
 * better-call's `getSignedCookie` on the cookie it writes.
 *
 * - `undefined`: the plugin leaves the request alone (no bearer scheme, empty
 *   token, or a dotted token whose signature does not verify — an unsigned
 *   `<token>.x` or a JWT), so the endpoint runs as the request's own cookie.
 * - `null`: the plugin replaces the session cookie with a value no session can
 *   be read from, so the endpoint runs with no session.
 * - a string: the session token the endpoint will look up.
 *
 * With no `bearer()` plugin registered nothing rewrites the request, so the
 * header is ignored. An undotted raw token is signed by the plugin itself and
 * accepted, unless the plugin was registered with `requireSignature`, in which
 * case it leaves the request on its cookie.
 */
async function bearerEndpointSessionToken(
	ctx: HookContext,
	authorization: string
): Promise<string | null | undefined> {
	const plugin = ctx.context.options.plugins?.find(
		(entry) => entry.id === "bearer"
	);
	if (
		!plugin ||
		authorization.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME
	) {
		return undefined;
	}
	const secret = ctx.context.secret;
	const token = authorization.slice(BEARER_SCHEME.length).trim();
	if (!token) {
		return undefined;
	}
	if (!token.includes(".")) {
		// The plugin signs it and writes `<token>.<signature>`, which
		// getSignedCookie reads straight back to the raw token.
		return bearerRequiresSignature.safeParse(plugin.options).success
			? undefined
			: token;
	}
	const cookieValue = token.includes("%")
		? tryDecodeURIComponent(token)
		: token;
	const [signedPart = "", signaturePart = ""] = cookieValue.split(".");
	try {
		if (
			!(await verifyHmac(
				secret,
				signedPart,
				decodeBearerSignature(signaturePart)
			))
		) {
			return undefined;
		}
	} catch {
		return undefined;
	}
	// Accepted: the endpoint now reads `cookieValue` as its signed session
	// cookie, splitting at the LAST dot and requiring a padded 44-character
	// standard-base64 signature over everything before it.
	const signatureStart = cookieValue.lastIndexOf(".");
	if (signatureStart < 1) {
		return null;
	}
	const signedValue = cookieValue.slice(0, signatureStart);
	const signature = cookieValue.slice(signatureStart + 1);
	if (
		signature.length !== SIGNED_COOKIE_SIGNATURE_LENGTH ||
		!signature.endsWith("=")
	) {
		return null;
	}
	try {
		const binary = atob(signature);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		return (await verifyHmac(secret, signedValue, bytes)) ? signedValue : null;
	} catch {
		return null;
	}
}

function isUnexpired(found: HookSession): boolean {
	return (
		!found.session.expiresAt ||
		new Date(found.session.expiresAt).getTime() > Date.now()
	);
}

/**
 * Resolve the session visible to a Better Auth before-hook.
 *
 * Before-hooks all receive the original request context. The bearer plugin's
 * header-to-cookie rewrite is applied only after the phase, so a hook that calls
 * `getSessionFromCtx` alone misses every Authorization-only caller. Resolve the
 * bearer directly through Better Auth's internal adapter, while retaining the
 * native cookie/session lookup for browser callers.
 */
export async function resolveSessionForHook(
	ctx: HookContext
): Promise<HookSession | null> {
	// Read the header exactly as the bearer plugin does: it falls back to the
	// context headers when the request's own Authorization header is EMPTY, so
	// `||`, not `??`. Anything else could resolve a different caller than the
	// session the handler later runs as.
	const authorization =
		ctx.request?.headers.get("authorization") ||
		ctx.headers?.get("authorization") ||
		null;
	const bearerToken = authorization
		? await bearerEndpointSessionToken(ctx, authorization)
		: undefined;
	if (bearerToken !== undefined) {
		// The plugin replaces the request's session cookie with this bearer, so
		// the endpoint runs as this session or, when none matches, as nobody.
		const found = bearerToken
			? await ctx.context.internalAdapter.findSession(bearerToken)
			: null;
		const resolved = found?.session?.id && isUnexpired(found) ? found : null;
		// An endpoint's getSessionFromCtx returns a session an earlier hook
		// already read, and that hook read the request's own cookie before
		// `bearer` replaced it. Drop a different one so the endpoint runs as
		// the bearer session these hooks authorize (or as nobody).
		if (
			ctx.context.session &&
			ctx.context.session.session?.id !== resolved?.session.id
		) {
			ctx.context.session = null;
		}
		return resolved;
	}
	// Another before-hook may already have populated the shared session from a
	// cookie cache. getSessionFromCtx returns that copy without consulting its
	// options, so independently revalidate it before any hook can authorize it.
	// With nothing prepopulated, the lookup below already read the session store
	// with the cookie cache disabled and applied expiry, so a second store read
	// would only repeat it.
	const prepopulated = ctx.context.session ?? null;
	// SAFETY: Runtime callers are Better Auth middleware contexts. HookContext exposes only the session/header projection used by this resolver; native cookie lookup receives the original SDK-created context with its cookie and adapter services.
	const active: HookSession | null = await getSessionFromCtx(
		ctx as Parameters<typeof getSessionFromCtx>[0],
		{ disableCookieCache: true }
	);
	if (!prepopulated) {
		return active;
	}
	const token = active?.session?.token;
	const found = token
		? await ctx.context.internalAdapter.findSession(token)
		: null;
	const valid = found && isUnexpired(found) ? found : null;
	ctx.context.session = valid;
	return valid;
}

async function resolveSessionId(ctx: HookContext): Promise<{
	id: string;
	twoFactorEnabled: boolean;
} | null> {
	const session = await resolveSessionForHook(ctx);
	return session?.session.id
		? {
				id: session.session.id,
				twoFactorEnabled: Boolean(session.user?.twoFactorEnabled),
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
					// `/admin/update-user` writes its `data` record straight to the user
					// row. Role, email, 2FA and ban state each have their own gated or
					// verified flow, so this raw write must never carry them.
					matcher: (context: { path?: string }) =>
						context.path === ADMIN_UPDATE_USER_PATH,
					handler: createAuthMiddleware(async (ctx) => {
						const fields = protectedAdminUpdateUserFields(ctx.body);
						if (fields.length > 0) {
							throw new APIError("FORBIDDEN", {
								message: `Change ${fields.join(", ")} through its own endpoint`,
							});
						}
					}),
				},
				{
					// A client may not mint a key through Better Auth's native endpoint:
					// it skips the control plane's `org.credentials` step-up, scope
					// clamp and audit row (see NATIVE_API_KEY_CREATE_PATH).
					matcher: (context: { path?: string }) =>
						context.path === NATIVE_API_KEY_CREATE_PATH,
					handler: createAuthMiddleware(async (ctx) => {
						if (isClientNativeApiKeyCreate(ctx)) {
							throw new APIError("FORBIDDEN", {
								message: "Create API keys from your account settings",
							});
						}
					}),
				},
				{
					// A client may not read an organization's keys through the native
					// endpoints: they skip `gateway.configure` and the org's access
					// policy (see isClientNativeOrgApiKeyRead).
					matcher: (context: { path?: string }) =>
						isNativeApiKeyRead(context.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						if (!(ctx.request || ctx.headers)) {
							return;
						}
						let storedConfigId: string | null | undefined;
						if (ctx.path === NATIVE_API_KEY_GET_PATH) {
							const keyId = z
								.string()
								.min(1)
								.nullable()
								.catch(null)
								.parse(ctx.query?.id);
							if (keyId) {
								// The stored config decides, never the requested `configId`.
								const key = await ctx.context.adapter.findOne<{
									configId?: string | null;
								}>({
									model: "apikey",
									where: [{ field: "id", value: keyId }],
								});
								storedConfigId = key?.configId;
							}
						}
						if (!isClientNativeOrgApiKeyRead(ctx, storedConfigId)) {
							return;
						}
						if (ctx.path === NATIVE_API_KEY_GET_PATH) {
							// The native answer for a key the caller cannot see, so a
							// personal-key lookup by an org key's id still reads "not found".
							throw new APIError("NOT_FOUND", {
								code: "KEY_NOT_FOUND",
								message: "API Key not found",
							});
						}
						throw new APIError("FORBIDDEN", {
							message: "Use the organization API keys endpoint",
						});
					}),
				},
				{
					matcher: (context: { path?: string }) =>
						stepUpScopeForAuthPath(context.path ?? "") !== null ||
						context.path === STEP_UP_INVITE_MEMBER_PATH ||
						isStepUpApiKeyMutation(context.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						let scope = stepUpScopeForAuthPath(ctx.path ?? "");
						if (ctx.path === STEP_UP_INVITE_MEMBER_PATH) {
							// An owner/admin/billing invitation is a promotion the invitee
							// accepts later; gate it like `update-member-role`.
							scope = stepUpScopeForInvitedRole(ctx.body?.role);
						}
						if (isStepUpApiKeyMutation(ctx.path ?? "")) {
							const keyId = z
								.string()
								.min(1)
								.nullable()
								.catch(null)
								.parse(ctx.body?.keyId);
							if (!keyId) {
								return;
							}
							// Better Auth owns key storage and reference semantics. Inspect
							// the stored config, never writable metadata or the requested
							// configId: omitting/spoofing it must not skip an org's gate.
							// Native handlers still enforce config match and ownership.
							const key = await ctx.context.adapter.findOne<{
								configId?: string | null;
							}>({
								model: "apikey",
								where: [{ field: "id", value: keyId }],
							});
							// Org keys change only through the control-plane route, which
							// audits the change and clears the key's spend cap; a step-up
							// alone would let a client skip both.
							if (isClientNativeOrgApiKeyMutation(ctx, key?.configId)) {
								throw new APIError("FORBIDDEN", {
									message: "Use the organization API keys endpoint",
								});
							}
							scope = stepUpScopeForApiKeyConfig(key?.configId);
						}
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
						if (await authorizeStepUp(session.id, scope)) {
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
