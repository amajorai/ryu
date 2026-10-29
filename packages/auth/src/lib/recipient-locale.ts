// The language each person's email is written in.
//
// `user.locale` holds the recipient's preferred locale. Sign-up stores the
// request's choice (the website's `locale` cookie, else `Accept-Language`);
// each sign-in refreshes it from an explicit cookie, or fills it from
// `Accept-Language` when nothing is stored; the website saves a language
// change through Better Auth's `update-user` with `{ locale }`.
//
// Only self-service endpoints (sign-up, sign-in, callbacks) write it, so an
// admin creating, provisioning or impersonating an account never stamps
// their own language on it.
//
// `@ryu/email` asks `resolveRecipientLocale` for every send that names no
// locale:
// - mail to the signed-in requester: their picked language (cookie), else
//   the stored one, else their browser's;
// - mail to an address named in an unauthenticated body (magic link, OTP,
//   reset): the account's stored language first, so a stranger naming the
//   address cannot pick it, else the request's language;
// - mail to any other existing account: its stored language, else English;
// - mail to an address with no account (an invitee): the requester's
//   language;
// - outside a request: the stored language, else English.
//
// A plain API route (not a Better Auth endpoint) has no Better Auth scope;
// its request's headers and signed-in requester come from
// `request-locale-context.ts`, so the same precedence applies there.

import type { AuthEndpointContext } from "@better-auth/core/context";
import {
	canonicalEmailLocale,
	emailLocaleFromAcceptLanguage,
} from "@ryu/email/i18n/email-locale.ts";
import { z } from "zod";
import { currentRequestLocaleScope } from "./request-locale-context.ts";

/** The website's language cookie, shared with Better Auth's error i18n. */
export const LOCALE_COOKIE = "locale";

/** What one request says about its language. */
export interface RequestLocales {
	/** `Accept-Language`'s best match: a browser default, not a choice. */
	accepted: string | null;
	/** The `locale` cookie: a language the person picked. */
	chosen: string | null;
}

function cookieValue(header: string | null, name: string): string | null {
	if (!header) {
		return null;
	}
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator > 0 && part.slice(0, separator).trim() === name) {
			const raw = part.slice(separator + 1).trim();
			try {
				return decodeURIComponent(raw);
			} catch {
				return null;
			}
		}
	}
	return null;
}

export function requestLocales(
	headers: Headers | null | undefined
): RequestLocales {
	if (!headers) {
		return { accepted: null, chosen: null };
	}
	return {
		accepted: emailLocaleFromAcceptLanguage(headers.get("accept-language")),
		chosen: canonicalEmailLocale(
			cookieValue(headers.get("cookie"), LOCALE_COOKIE)
		),
	};
}

/** The slice of a Better Auth endpoint context this module reads. */
export type LocaleRequestScope = Pick<
	AuthEndpointContext,
	"body" | "headers" | "path" | "request"
> & {
	context?: { session?: { user?: { email?: unknown } | null } | null } | null;
};

export function scopeHeaders(
	scope: LocaleRequestScope | null | undefined
): Headers | null {
	return scope?.headers ?? scope?.request?.headers ?? null;
}

const requestBodySchema = z
	.object({
		email: z.string().optional().catch(undefined),
		newEmail: z.string().optional().catch(undefined),
	})
	.catch(() => ({}));

const normalizeAddress = (address: unknown): string | null =>
	typeof address === "string" && address.trim()
		? address.trim().toLowerCase()
		: null;

/** Addresses an unauthenticated request body names (`email`, `newEmail`). */
function bodyAddresses(scope: LocaleRequestScope | null | undefined) {
	const body = requestBodySchema.parse(scope?.body ?? {});
	return new Set(
		[body.email, body.newEmail]
			.map(normalizeAddress)
			.filter((address): address is string => address !== null)
	);
}

/** One recipient's account: null when the address has no account. */
export type StoredRecipient = { locale: unknown } | null;

/** See the module comment for the precedence. */
export async function resolveRecipientLocale(input: {
	scope: LocaleRequestScope | null | undefined;
	storedLocale: (email: string) => Promise<StoredRecipient>;
	to: string;
}): Promise<string | null> {
	const to = input.to.trim().toLowerCase();
	// A Better Auth endpoint's own request wins; a server-side call without
	// headers (or no Better Auth scope at all) falls back to the API request.
	const scope = scopeHeaders(input.scope)
		? input.scope
		: (currentRequestLocaleScope() ?? input.scope);
	const { accepted, chosen } = requestLocales(scopeHeaders(scope));
	const sessionEmail = normalizeAddress(scope?.context?.session?.user?.email);
	const isSessionUser = sessionEmail === to;
	if (isSessionUser && chosen) {
		return chosen;
	}
	const account = await input.storedLocale(to);
	const stored = canonicalEmailLocale(account?.locale);
	if (stored) {
		return stored;
	}
	if (!account || isSessionUser || bodyAddresses(scope).has(to)) {
		return chosen ?? accepted;
	}
	return null;
}

/**
 * Endpoints where the person acting is the account's owner: sign-up,
 * sign-in and their callbacks. Admin, SCIM and impersonation endpoints are
 * deliberately absent.
 */
const SELF_SERVICE_AUTH_PATHS = [
	"/sign-up/",
	"/sign-in/",
	"/callback/",
	"/oauth2/callback/",
	"/magic-link/verify",
	"/verify-email",
	"/email-otp/verify-email",
	"/one-tap/callback",
	"/passkey/verify-authentication",
	"/two-factor/verify-",
	"/phone-number/verify",
	"/sso/callback/",
	"/sso/saml2/callback/",
	"/siwe/verify",
];

/** Whether this request is the account owner signing up or in. */
export function isSelfServiceAuthRequest(
	scope: LocaleRequestScope | null | undefined
): boolean {
	const path = scope?.path;
	return (
		typeof path === "string" &&
		SELF_SERVICE_AUTH_PATHS.some(
			(prefix) => path === prefix.replace(/\/$/u, "") || path.startsWith(prefix)
		)
	);
}

/** The locale to store on a new account, from its sign-up request. */
export function signUpLocale(
	submitted: unknown,
	headers: Headers | null
): string | null {
	const { accepted, chosen } = requestLocales(headers);
	return canonicalEmailLocale(submitted) ?? chosen ?? accepted;
}

/**
 * The locale to store after a sign-in, or null to leave it: an explicit
 * cookie replaces a different stored value; `Accept-Language` only fills an
 * empty one, so a browser default never overrides a chosen language.
 */
export function signInLocaleUpdate(
	stored: unknown,
	headers: Headers | null
): string | null {
	const { accepted, chosen } = requestLocales(headers);
	const current = canonicalEmailLocale(stored);
	if (chosen) {
		return chosen === current ? null : chosen;
	}
	return current ? null : accepted;
}

/** `update-user` input: one locale tag, or null to clear it. */
export const userLocaleInputSchema = z
	.string()
	.max(35)
	.refine((value) => canonicalEmailLocale(value) !== null, {
		message: "Unsupported locale",
	})
	.nullish();
