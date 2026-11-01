/**
 * Per-surface device limits, enforced by the auth server.
 *
 * Wired through `ryuClientSessionPlugin()` (`ryu-client-session.ts`), which
 * calls `stampDeviceLimitSession` from its session-create hook and registers
 * `deviceLimitBeforeHooks()`. Three checks, one rule (`device-limits.ts`):
 *
 * - Every new session is stamped with its `surface`, whatever the flag says.
 *   The session-create hook is the authoritative check for every sign-in path
 *   (email, social, passkey, OTP, magic link, SSO, one-tap, `/device/session`,
 *   Telegram, `/device/token`).
 * - `/device/approve`: a browser approving a Desktop, CLI, extension, or
 *   mobile sign-in is refused BEFORE the grant is approved, so the user is
 *   told in the browser instead of the device timing out.
 * - `/device/token`: an approved grant over the cap is refused WITHOUT
 *   consuming the device code, so the device can retry once the user signs
 *   out elsewhere. The surface computed there (it needs the grant's scope,
 *   which is gone once the code is consumed) is handed to the session hook
 *   through a short-lived in-process cache keyed by the device code.
 *
 * Only refusal is gated by `auth.device_limits` (resolved through
 * `device-limit-policy.ts`); any policy failure allows the sign-in.
 * Impersonated sessions (support access, admin impersonation), anonymous
 * guests, and server-side replacements of an existing session (two-factor
 * enable/disable re-issuing the current session) are never refused.
 */
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
	rememberGrantSurface,
	takeGrantSurface,
} from "./device-limit-grant-surfaces.ts";
import {
	countLiveSessionsBySurfaceForUser,
	type DeviceLimitPolicy,
	resolveDeviceLimitPolicy,
	type SessionFindManyAdapter,
} from "./device-limit-policy.ts";
import {
	DEVICE_LIMIT_REACHED_CODE,
	DEVICE_LIMIT_REACHED_ERROR,
	DEVICE_SURFACE_FIELD,
	type DeviceSurface,
	declaredDeviceSurface,
	deviceLimitReachedMessage,
	isDeviceSurface,
} from "./device-limits.ts";
import {
	approvalDeclaredSurface,
	classifyDeviceSurface,
	deviceGrantSurface,
	scopeDeclaringSurface,
} from "./device-surface.ts";
import { resolveSessionForHook } from "./step-up-plugin.ts";

// biome-ignore lint/performance/noBarrelFile: keeps the plugin's public import path for the grant cache stable after the split.
export {
	rememberGrantSurface,
	takeGrantSurface,
} from "./device-limit-grant-surfaces.ts";

const DEVICE_APPROVE_PATH = "/device/approve";
const DEVICE_TOKEN_PATH = "/device/token";
const MAX_CODE_LENGTH = 512;

/** Context fields the device-limit checks read (a Better Auth endpoint context). */
export interface DeviceLimitContext {
	body?: unknown;
	context: {
		adapter: SessionFindManyAdapter & {
			findOne<T>(input: {
				model: string;
				where: { field: string; value: string }[];
			}): Promise<T | null>;
			/** Records an approval-time surface declaration on the grant. */
			update?<T>(input: {
				model: string;
				update: Record<string, unknown>;
				where: { field: string; value: string }[];
			}): Promise<T | null>;
		};
		internalAdapter: { findUserById(userId: string): Promise<unknown> };
	};
	headers?: Headers;
	path?: string;
	request?: Request;
}

interface DeviceCodeRow {
	clientId?: string | null;
	expiresAt?: Date | string;
	id?: string;
	scope?: string | null;
	status?: string;
	userCode?: string;
	userId?: unknown;
}

export type DeviceLimitPolicyLookup = (
	userId: string
) => Promise<DeviceLimitPolicy>;

/** The refusal Better Auth returns (403) when a surface is at its cap. */
export function deviceLimitRefusalError(
	surface: DeviceSurface,
	limit: number
): APIError {
	const message = deviceLimitReachedMessage(surface, limit);
	return new APIError("FORBIDDEN", {
		code: DEVICE_LIMIT_REACHED_CODE,
		error: DEVICE_LIMIT_REACHED_ERROR,
		error_description: message,
		limit,
		message,
		surface,
	});
}

function readHeader(ctx: DeviceLimitContext, name: string): string | null {
	return ctx.request?.headers.get(name) ?? ctx.headers?.get(name) ?? null;
}

function readBodyString(body: unknown, field: string): string | null {
	if (typeof body !== "object" || body === null) {
		return null;
	}
	const value = (body as Record<string, unknown>)[field];
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_CODE_LENGTH
		? value
		: null;
}

function isExpired(row: DeviceCodeRow, now: Date): boolean {
	const expiry = row.expiresAt ? new Date(row.expiresAt).getTime() : Number.NaN;
	return !Number.isFinite(expiry) || expiry < now.getTime();
}

async function isAnonymousUser(
	ctx: DeviceLimitContext,
	userId: string
): Promise<boolean> {
	const user = await ctx.context.internalAdapter.findUserById(userId);
	return (
		typeof user === "object" &&
		user !== null &&
		(user as { isAnonymous?: unknown }).isAnonymous === true
	);
}

/**
 * The refusal for one more `surface` session of `userId`, or null when the
 * sign-in may proceed (not enforced, anonymous guest, or under the cap).
 */
export async function deviceLimitRefusalFor(
	ctx: DeviceLimitContext,
	userId: string,
	surface: DeviceSurface,
	lookupPolicy: DeviceLimitPolicyLookup = resolveDeviceLimitPolicy
): Promise<APIError | null> {
	const policy = await lookupPolicy(userId);
	if (!policy.enforced) {
		return null;
	}
	try {
		if (await isAnonymousUser(ctx, userId)) {
			return null;
		}
		const counts = await countLiveSessionsBySurfaceForUser(
			ctx.context.adapter,
			userId
		);
		const limit = policy.limits[surface];
		return counts[surface] >= limit
			? deviceLimitRefusalError(surface, limit)
			: null;
	} catch {
		// A failed user or session read leaves the limit unknown: allow the
		// sign-in rather than turn a database hiccup into a lockout.
		return null;
	}
}

function isDeviceLimitRefusal(error: unknown): boolean {
	if (!(error instanceof APIError)) {
		return false;
	}
	const body: unknown = error.body;
	return (
		typeof body === "object" &&
		body !== null &&
		(body as { code?: unknown }).code === DEVICE_LIMIT_REACHED_CODE
	);
}

/**
 * Runs a device-flow pre-check fail-open: only a device-limit refusal is
 * rethrown; any other failure (a device-code or session read) is left for
 * the endpoint itself to handle.
 */
export async function failOpenPreCheck(
	check: () => Promise<void>
): Promise<void> {
	try {
		await check();
	} catch (error) {
		if (isDeviceLimitRefusal(error)) {
			throw error;
		}
	}
}

// --- Session-create hook ----------------------------------------------------

/** The surface of the session `ctx` is creating. */
export function sessionCreationSurface(
	ctx: DeviceLimitContext | null | undefined,
	grantClientId: string | null
): DeviceSurface {
	if (!ctx) {
		return classifyDeviceSurface({});
	}
	if (ctx.path === DEVICE_TOKEN_PATH) {
		const deviceCode = readBodyString(ctx.body, "device_code");
		const remembered = deviceCode ? takeGrantSurface(deviceCode) : null;
		if (remembered) {
			return remembered;
		}
	}
	return classifyDeviceSurface({
		clientId: grantClientId,
		expoOrigin: readHeader(ctx, "expo-origin"),
		origin: readHeader(ctx, "origin"),
	});
}

/**
 * True when `session` is a server-side copy of an existing session. `surface`
 * is `input: false`, so no endpoint accepts it from a caller; session data
 * that already carries a valid one can only come from server code passing an
 * existing session to `internalAdapter.createSession(userId, false, existing)`,
 * which spreads it into the new row. Better Auth's two-factor enable, disable,
 * and first TOTP/OTP verification do this and then delete the old session:
 * a REPLACEMENT on the same device, not a new one.
 */
function isSessionReplacement(session: Record<string, unknown>): boolean {
	return isDeviceSurface(session[DEVICE_SURFACE_FIELD]);
}

/**
 * Stamp `surface` on a session being created and, when enforced, refuse it
 * over the cap. Returns the session data to store; throws the refusal.
 * A replacement of an existing session keeps its surface and is never
 * refused. `grantClientId` is `deviceGrantClientId(ctx)` from
 * `ryu-client-session.ts`.
 */
export async function stampDeviceLimitSession<
	T extends Record<string, unknown>,
>(
	session: T,
	ctx: DeviceLimitContext | null | undefined,
	grantClientId: string | null,
	lookupPolicy: DeviceLimitPolicyLookup = resolveDeviceLimitPolicy
): Promise<T & { [DEVICE_SURFACE_FIELD]: DeviceSurface }> {
	if (isSessionReplacement(session)) {
		return session as T & { [DEVICE_SURFACE_FIELD]: DeviceSurface };
	}
	const surface = sessionCreationSurface(ctx, grantClientId);
	const stamped = { ...session, [DEVICE_SURFACE_FIELD]: surface };
	const userId = session.userId;
	const impersonated =
		typeof session.impersonatedBy === "string" &&
		session.impersonatedBy.length > 0;
	// Server-side writes without a request context are stamped, never refused.
	if (!ctx || impersonated || typeof userId !== "string" || !userId) {
		return stamped;
	}
	const refusal = await deviceLimitRefusalFor(
		ctx,
		userId,
		surface,
		lookupPolicy
	);
	if (refusal) {
		throw refusal;
	}
	return stamped;
}

// --- Device-flow pre-checks -------------------------------------------------

const DEFAULT_USER_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/i;

/** Better Auth's own `findDeviceCodeByUserCode` (device-authorization/routes). */
async function findDeviceCodeByUserCode(
	ctx: DeviceLimitContext,
	userCode: string
): Promise<DeviceCodeRow | null> {
	const findByUserCode = async (value: string) => {
		const row = await ctx.context.adapter.findOne<DeviceCodeRow>({
			model: "deviceCode",
			where: [{ field: "userCode", value }],
		});
		return row?.userCode === value ? row : null;
	};
	const exact = await findByUserCode(userCode);
	if (exact) {
		return exact;
	}
	const normalized = userCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
	if (normalized === userCode || !DEFAULT_USER_CODE_PATTERN.test(normalized)) {
		return null;
	}
	return findByUserCode(normalized);
}

export type HookUserIdResolver = (
	ctx: DeviceLimitContext
) => Promise<string | null>;

async function hookSessionUserId(
	ctx: DeviceLimitContext
): Promise<string | null> {
	const session = await resolveSessionForHook(
		ctx as unknown as Parameters<typeof resolveSessionForHook>[0]
	);
	return session?.user?.id ?? null;
}

export interface DeviceLimitPreCheckDeps {
	lookupPolicy?: DeviceLimitPolicyLookup;
	now?: () => Date;
	resolveUserId?: HookUserIdResolver;
}

/**
 * `/device/approve`: refuse approving a grant whose surface is at its cap.
 * Anything the endpoint itself rejects (unknown, expired, already processed,
 * someone else's code) is left to the endpoint.
 *
 * The approving account owner may also declare the surface of an undeclared
 * Core grant (`surface: "mobile"` in the approve body, which the Ryu mobile
 * app's approval link carries). The declaration is checked against that
 * surface's cap and recorded in the grant's scope, so `/device/token` stamps
 * the session with it.
 */
export async function deviceApprovePreCheck(
	ctx: DeviceLimitContext,
	deps: DeviceLimitPreCheckDeps = {}
): Promise<void> {
	const userCode = readBodyString(ctx.body, "userCode");
	if (!userCode) {
		return;
	}
	const row = await findDeviceCodeByUserCode(ctx, userCode);
	const now = deps.now?.() ?? new Date();
	if (row?.status !== "pending" || !row.userId || isExpired(row, now)) {
		return;
	}
	const userId = String(row.userId);
	const approverId = await (deps.resolveUserId ?? hookSessionUserId)(ctx);
	if (approverId !== userId) {
		return;
	}
	const approvalDeclared = approvalDeclaredSurface(
		row.clientId,
		row.scope,
		readBodyString(ctx.body, "surface")
	);
	const surface = deviceGrantSurface(
		row.clientId,
		approvalDeclared ?? declaredDeviceSurface(row.scope)
	);
	const refusal = await deviceLimitRefusalFor(
		ctx,
		userId,
		surface,
		deps.lookupPolicy
	);
	if (refusal) {
		throw refusal;
	}
	// Recorded here, before Better Auth approves (and before later before-hooks
	// such as required-MFA can still refuse): writing after approval would race
	// Core's next token poll, which could redeem the grant unlabelled. Only the
	// code's own account reaches this line and the label only picks a bucket, so
	// a declaration left on a refused approval is the owner's own choice.
	if (approvalDeclared && row.id) {
		await ctx.context.adapter.update?.({
			model: "deviceCode",
			update: { scope: scopeDeclaringSurface(row.scope, approvalDeclared) },
			where: [{ field: "id", value: row.id }],
		});
	}
}

/**
 * `/device/token`: for an approved grant, classify its surface, refuse over
 * the cap without consuming the device code, and hand the surface to the
 * session hook.
 */
export async function deviceTokenPreCheck(
	ctx: DeviceLimitContext,
	deps: DeviceLimitPreCheckDeps = {}
): Promise<void> {
	const deviceCode = readBodyString(ctx.body, "device_code");
	const clientId = readBodyString(ctx.body, "client_id");
	if (!(deviceCode && clientId)) {
		return;
	}
	const row = await ctx.context.adapter.findOne<DeviceCodeRow>({
		model: "deviceCode",
		where: [{ field: "deviceCode", value: deviceCode }],
	});
	const now = deps.now?.() ?? new Date();
	if (
		row?.status !== "approved" ||
		!row.userId ||
		(row.clientId && row.clientId !== clientId) ||
		isExpired(row, now)
	) {
		return;
	}
	const surface = classifyDeviceSurface({
		clientId: row.clientId || clientId,
		declaredSurface: declaredDeviceSurface(row.scope),
		expoOrigin: readHeader(ctx, "expo-origin"),
		origin: readHeader(ctx, "origin"),
	});
	const refusal = await deviceLimitRefusalFor(
		ctx,
		String(row.userId),
		surface,
		deps.lookupPolicy
	);
	if (refusal) {
		throw refusal;
	}
	rememberGrantSurface(deviceCode, surface, now.getTime());
}

/**
 * The registered `/device/approve` check: `deviceApprovePreCheck`, fail-open.
 * Only a device-limit refusal blocks the approval; a failed read or a failed
 * mobile-declaration write leaves the grant as it was (counted self-hosted).
 */
export function guardedDeviceApprovePreCheck(
	ctx: DeviceLimitContext,
	deps: DeviceLimitPreCheckDeps = {}
): Promise<void> {
	return failOpenPreCheck(() => deviceApprovePreCheck(ctx, deps));
}

/** The registered `/device/token` check: `deviceTokenPreCheck`, fail-open. */
export function guardedDeviceTokenPreCheck(
	ctx: DeviceLimitContext,
	deps: DeviceLimitPreCheckDeps = {}
): Promise<void> {
	return failOpenPreCheck(() => deviceTokenPreCheck(ctx, deps));
}

/** `hooks.before` entries for the device-authorization pre-checks. */
export function deviceLimitBeforeHooks() {
	return [
		{
			matcher: (ctx: { path?: string }) => ctx.path === DEVICE_APPROVE_PATH,
			handler: createAuthMiddleware(async (ctx) => {
				await guardedDeviceApprovePreCheck(
					ctx as unknown as DeviceLimitContext
				);
			}),
		},
		{
			matcher: (ctx: { path?: string }) => ctx.path === DEVICE_TOKEN_PATH,
			handler: createAuthMiddleware(async (ctx) => {
				await guardedDeviceTokenPreCheck(ctx as unknown as DeviceLimitContext);
			}),
		},
	];
}
