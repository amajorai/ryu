// The language of a plain API request, for emails sent outside Better Auth.
//
// Better Auth endpoints expose their request through its own async context,
// which `resolveRecipientLocale` reads. Routes on the API router (email-change
// verification, referral and waitlist invites, account merge and deletion)
// run outside it, so their sends used to fall back to the stored locale or
// English. `@ryu/api`'s request-locale middleware runs each request inside
// this store; `createContext` names the signed-in requester once the session
// is known, so a send to them can honor the language they picked.
//
// The store keeps only the request's headers and the requester's address,
// never a body: nothing an unauthenticated caller writes can pick another
// account's language.

import { AsyncLocalStorage } from "node:async_hooks";
import type { LocaleRequestScope } from "./recipient-locale.ts";

interface RequestLocaleStore {
	headers: Headers;
	requesterEmail: string | null;
}

const requestLocaleStorage = new AsyncLocalStorage<RequestLocaleStore>();

/** Run `fn` (one API request) with its headers as the request language. */
export function runWithRequestLocale<T>(headers: Headers, fn: () => T): T {
	return requestLocaleStorage.run({ headers, requesterEmail: null }, fn);
}

/**
 * Name the signed-in account the current request acts for. Callers pass only
 * a self-service session's address, never an impersonated or support one, so
 * an operator's language is never taken for the account owner's.
 */
export function setRequestLocaleRequester(email: unknown): void {
	const store = requestLocaleStorage.getStore();
	if (store) {
		store.requesterEmail =
			typeof email === "string" && email.trim() ? email : null;
	}
}

/** The current API request as a locale scope, or null outside one. */
export function currentRequestLocaleScope(): LocaleRequestScope | null {
	const store = requestLocaleStorage.getStore();
	if (!store) {
		return null;
	}
	return {
		context: store.requesterEmail
			? { session: { user: { email: store.requesterEmail } } }
			: null,
		headers: store.headers,
	};
}
