import { createHmac } from "node:crypto";
import { deleteSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { emailCooldownAddress } from "./email-cooldown.ts";
import type { LoginAssuranceChallenge } from "./login-assurance.ts";

// The signed cookies and request state behind login assurance
// (login-assurance.ts): the pending second-factor login, the 30-day trusted
// device, and the session a password sign-in just created.

export const LOGIN_PENDING_COOKIE = "ryu_login_pending";
export const LOGIN_TRUST_COOKIE = "ryu_login_trust";
export const LOGIN_TRUST_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const LOGIN_PENDING_MAX_AGE_SECONDS = 10 * 60;

type FrameworkCookieContext = Parameters<typeof deleteSessionCookie>[0];
type LoginCookie = ReturnType<
	FrameworkCookieContext["context"]["createAuthCookie"]
>;
type LoginCookieOptions = LoginCookie["attributes"];
interface AdapterLookupRecord {
	email?: string;
	id?: string;
	userId?: string;
}
interface LoginCreatedSession {
	session?: { token?: string };
	user?: { email?: string; id?: string; twoFactorEnabled?: boolean | null };
}

interface AdapterWhere {
	field: string;
	value: string;
}

export interface LoginAssuranceContext {
	body?: unknown;
	context: {
		adapter: {
			findMany(input: {
				model: string;
				where?: AdapterWhere[];
			}): Promise<readonly (object | undefined)[]>;
			findOne(input: {
				model: string;
				where: AdapterWhere[];
			}): Promise<AdapterLookupRecord | null>;
		};
		createAuthCookie: (
			name: string,
			overrides?: { maxAge?: number }
		) => LoginCookie;
		internalAdapter: {
			deleteSession: (token: string) => Promise<void>;
		};
		newSession?: LoginCreatedSession | null;
		authCookies: FrameworkCookieContext["context"]["authCookies"];
		options: FrameworkCookieContext["context"]["options"];
		oauthConfig: Pick<
			FrameworkCookieContext["context"]["oauthConfig"],
			"storeStateStrategy"
		>;
		secret: string;
		setNewSession: (session: null) => void;
	};
	getSignedCookie: (
		name: string,
		secret: string
	) => Promise<string | false | null>;
	header?: (name: string) => string | null;
	headers?: Headers;
	json: (body: LoginAssuranceChallenge) => Promise<LoginAssuranceChallenge>;
	path?: string;
	request?: Request;
	setCookie: (name: string, value: string, options: LoginCookieOptions) => void;
	setSignedCookie: (
		name: string,
		value: string,
		secret: string,
		options: LoginCookieOptions
	) => Promise<string>;
}

/**
 * A login waiting for its second step. A password login names the account
 * whose password was accepted. A magic-link request names only `mailboxKey`,
 * an HMAC of the requested mailbox: never an address, so whatever Better Auth
 * resolved the request to (an alias of a registered mailbox becomes the
 * stored address), the cookie cannot reveal an account.
 */
type PendingLogin = z.infer<typeof pendingLoginSchema>;

interface TrustedDevice {
	expiresAt: number;
	userId: string;
}

interface NewLoginSession {
	token: string;
	userEmail: string;
	userId: string;
}

export const stringValue = z.string().min(1).nullable().catch(null).parse;
export const bodySchema = z
	.object({
		email: z.string().optional().catch(undefined),
		factorFallback: z.enum(["two-factor", "email"]).optional().catch(undefined),
		rememberDevice: z.boolean().catch(false),
		trustDevice: z.boolean().catch(false),
		response: z
			.object({ id: z.string().optional().catch(undefined) })
			.optional()
			.catch(undefined),
	})
	.catch(() => ({ rememberDevice: false, trustDevice: false }));
const pendingExpirySchema = z
	.number()
	.refine((expiresAt) => expiresAt > Date.now());
// Each flow requires its own fields, so a same-secret payload of any other
// shape is no pending login at all, never a password one by default.
const pendingLoginSchema = z.discriminatedUnion("flow", [
	z.object({
		email: z
			.string()
			.min(1)
			.transform((email) => email.trim().toLowerCase()),
		expiresAt: pendingExpirySchema,
		flow: z.literal("password"),
		rememberDevice: z.boolean(),
		userId: z.string().min(1),
	}),
	z.object({
		expiresAt: pendingExpirySchema,
		flow: z.literal("magic-link"),
		mailboxKey: z.string().min(1),
		rememberDevice: z.boolean(),
	}),
]);
// The pending and trust cookies are signed with the same secret, and the
// signature covers only the value, not the cookie name. Parse trust strictly so
// a pending payload (which always carries email, flow and rememberDevice) can
// never be replayed as a 30-day trusted-device cookie.
const trustedDeviceSchema = z.strictObject({
	expiresAt: z.number().refine((expiresAt) => expiresAt > Date.now()),
	userId: z.string().min(1),
});

export function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

export function parsePendingLogin(value: string | null): PendingLogin | null {
	if (!value) {
		return null;
	}
	try {
		const parsed = pendingLoginSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
function parseTrustedDevice(value: string | null): TrustedDevice | null {
	if (!value) {
		return null;
	}
	try {
		const parsed = trustedDeviceSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function signedCookie(
	ctx: LoginAssuranceContext,
	name: string
): Promise<{ cookie: LoginCookie; value: string | null }> {
	const cookie = ctx.context.createAuthCookie(name);
	const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
	return { cookie, value: value === false ? null : value };
}

export async function pendingLogin(
	ctx: LoginAssuranceContext
): Promise<{ cookie: LoginCookie; pending: PendingLogin | null }> {
	const signed = await signedCookie(ctx, LOGIN_PENDING_COOKIE);
	return { cookie: signed.cookie, pending: parsePendingLogin(signed.value) };
}

export async function trustedDevice(
	ctx: LoginAssuranceContext,
	userId: string
): Promise<boolean> {
	const signed = await signedCookie(ctx, LOGIN_TRUST_COOKIE);
	const trusted = parseTrustedDevice(signed.value);
	if (signed.value && !trusted) {
		clearCookie(ctx, signed.cookie);
	}
	return trusted?.userId === userId;
}

export function clearCookie(
	ctx: LoginAssuranceContext,
	cookie: LoginCookie
): void {
	ctx.setCookie(cookie.name, "", {
		...cookie.attributes,
		maxAge: 0,
	});
}

export async function setPendingLogin(
	ctx: LoginAssuranceContext,
	input: {
		email?: string;
		flow?: PendingLogin["flow"];
		mailboxKey?: string;
		rememberDevice: boolean;
		userId?: string;
	}
): Promise<void> {
	const cookie = ctx.context.createAuthCookie(LOGIN_PENDING_COOKIE, {
		maxAge: LOGIN_PENDING_MAX_AGE_SECONDS,
	});
	await ctx.setSignedCookie(
		cookie.name,
		JSON.stringify({
			email: input.email ? normalizeEmail(input.email) : undefined,
			expiresAt: Date.now() + LOGIN_PENDING_MAX_AGE_SECONDS * 1000,
			flow: input.flow ?? "password",
			mailboxKey: input.mailboxKey,
			rememberDevice: input.rememberDevice,
			userId: input.userId,
		}),
		ctx.context.secret,
		cookie.attributes
	);
}

export async function setTrustedDevice(
	ctx: LoginAssuranceContext,
	userId: string
): Promise<void> {
	const cookie = ctx.context.createAuthCookie(LOGIN_TRUST_COOKIE, {
		maxAge: LOGIN_TRUST_MAX_AGE_SECONDS,
	});
	const expiresAt = Date.now() + LOGIN_TRUST_MAX_AGE_SECONDS * 1000;
	await ctx.setSignedCookie(
		cookie.name,
		JSON.stringify({ expiresAt, userId }),
		ctx.context.secret,
		cookie.attributes
	);
}

export function newLoginSession(
	ctx: LoginAssuranceContext
): NewLoginSession | null {
	const session = ctx.context.newSession;
	const token = stringValue(session?.session?.token);
	const userId = stringValue(session?.user?.id);
	const userEmail = stringValue(session?.user?.email);
	if (!(token && userId && userEmail)) {
		return null;
	}
	return { token, userEmail: normalizeEmail(userEmail), userId };
}

export async function removeNewSession(
	ctx: LoginAssuranceContext,
	session: NewLoginSession
): Promise<void> {
	// SAFETY: this framework hook supplies the SDK's cookie definitions, cookie
	// writer, request headers and OAuth cookie policy used by deleteSessionCookie.
	// Its broader context type also contains unrelated services unused here.
	deleteSessionCookie(ctx as FrameworkCookieContext, true);
	await ctx.context.internalAdapter.deleteSession(session.token);
	ctx.context.setNewSession(null);
}

export function requestHeader(
	ctx: LoginAssuranceContext,
	name: string
): string | null {
	return (
		ctx.request?.headers.get(name) ??
		ctx.headers?.get(name) ??
		ctx.header?.(name) ??
		null
	);
}

/**
 * The opaque binding of a magic-link request to its mailbox: an HMAC, under
 * the auth secret, of the address as email harmony normalizes it, so every
 * alias of one mailbox (and the stored address Better Auth substitutes for
 * a registered one) gives the same key. Null for an unusable address.
 */
export function mailboxKey(secret: string, email: string): string | null {
	const mailbox = emailCooldownAddress(email);
	return mailbox
		? createHmac("sha256", secret)
				.update(`magic-link-mailbox:${mailbox}`)
				.digest("base64url")
		: null;
}

export function pendingMatchesSession(
	pending: PendingLogin | null,
	session: NewLoginSession,
	secret: string
): boolean {
	if (pending?.flow === "magic-link") {
		// The link signs in whichever account the requested mailbox resolves to.
		const requested = pending.mailboxKey;
		return (
			requested !== undefined &&
			requested === mailboxKey(secret, session.userEmail)
		);
	}
	return (
		pending?.userId !== undefined &&
		pending.userId === session.userId &&
		pending.email !== undefined &&
		pending.email === session.userEmail
	);
}
