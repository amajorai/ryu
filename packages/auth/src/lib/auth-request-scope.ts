import { getRequestStateAsyncLocalStorage } from "@better-auth/core/context";

/**
 * The Better Auth call the current code runs in.
 *
 * Better Auth opens one `AsyncLocalStorage` scope for every endpoint call,
 * over HTTP and through `auth.api.*` alike, and a nested `auth.api` call made
 * while one is open shares it. The scope object lives exactly as long as that
 * call, so state keyed by it (a `WeakMap` of the caller's own) can never be
 * read by another request. Code that runs outside any endpoint call has no
 * scope.
 *
 * Better Auth hands its storage out asynchronously, so an async caller awaits
 * {@link loadAuthRequestScope} once and then reads the scope synchronously.
 */

export type AuthRequestScope = object;

type RequestStorage = Awaited<
	ReturnType<typeof getRequestStateAsyncLocalStorage>
>;

let storage: RequestStorage | undefined;
let loading: Promise<void> | undefined;

/**
 * Resolve Better Auth's request storage. Safe to await on every call. When
 * the runtime has no `AsyncLocalStorage`, no scope is ever reported, which is
 * the safe side for everything built on it.
 */
export function loadAuthRequestScope(): Promise<void> {
	loading ??= getRequestStateAsyncLocalStorage().then(
		(resolved) => {
			storage = resolved;
		},
		() => undefined
	);
	return loading;
}

/** The scope of the Better Auth call in progress, or `undefined` outside one. */
export function currentAuthRequestScope(): AuthRequestScope | undefined {
	return storage?.getStore();
}
