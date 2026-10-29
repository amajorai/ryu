// packages/services/src/result.ts
//
// The object result form (`{ data, error, meta }`, Resend-style) and its type
// projection. `new Ryu({ result: "object" })` returns it from every
// promise-returning method; in throw mode `ryu.safe.<ns>.<method>()` and
// `toResult(promise)` give it per call. Async iterables are never wrapped:
// they throw RyuError in both modes.

import { isRyuError, type RyuError } from "./errors.ts";
import type { RyuDeprecation } from "./transport/deprecation.ts";
import type { RyuRateLimit } from "./transport/rate-limit.ts";

/**
 * Facts about a call. `attempts`, `deprecation`, `rateLimit`, `requestId` and
 * `status` describe its last HTTP response; `idempotencyKey` and `replayed`
 * describe its idempotent write, even when reads followed it (`box.run()`,
 * `notify.requestApproval()`).
 */
export interface RyuResponseMeta {
	/** Attempts the last request took, including retries. */
	attempts: number;
	deprecation: RyuDeprecation | null;
	/** The key the call's idempotent-route write was sent with, or null when it made none. */
	idempotencyKey: string | null;
	rateLimit: RyuRateLimit | null;
	/**
	 * The server answered the call's idempotent write with its stored result
	 * (an `Idempotent-Replayed: true` header, or the service's body marker).
	 */
	replayed: boolean;
	requestId: string | null;
	status: number;
}

/** A call's outcome without throwing. Exactly one of `data` and `error` is non-null. */
export type RyuResult<T> =
	| { data: T; error: null; meta: RyuResponseMeta }
	| { data: null; error: RyuError; meta: RyuResponseMeta | null };

/** Meta for a successful call that made no HTTP request (for example a config helper). */
export const EMPTY_META: Readonly<RyuResponseMeta> = Object.freeze({
	attempts: 0,
	deprecation: null,
	idempotencyKey: null,
	rateLimit: null,
	replayed: false,
	requestId: null,
	status: 0,
});

/**
 * A type-only key: an interface whose overloads the mapped {@link Safe} type
 * cannot project (a mapped type sees only the last overload) declares its
 * object-mode type as `readonly [SAFE_VIEW]?: TheObjectModeType`. Nothing
 * sets it at runtime.
 */
export const SAFE_VIEW: unique symbol = Symbol("ryu.safeView");

type SafeMapped<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R
		? R extends PromiseLike<infer U>
			? (...args: A) => Promise<RyuResult<U>>
			: T[K]
		: T[K] extends object
			? Safe<T[K]>
			: T[K];
};

/**
 * The object-mode projection of a namespace: methods that return a promise
 * resolve to {@link RyuResult} instead; nested resources are projected too;
 * methods returning anything else (async iterables, sync helpers) are left
 * as they are. An interface that declares a {@link SAFE_VIEW} type uses it
 * instead (Gateway's overloaded `chat.completions.create`).
 */
export type Safe<T> = T extends { readonly [SAFE_VIEW]?: infer View }
	? unknown extends View
		? SafeMapped<T>
		: View
	: SafeMapped<T>;

const CALL_META = new WeakMap<object, () => RyuResponseMeta | null>();

/** Associates a facade promise with its call's meta so {@link toResult} can report it. */
export function registerCallMeta(
	promise: object,
	meta: () => RyuResponseMeta | null
): void {
	CALL_META.set(promise, meta);
}

/**
 * Settles a facade call into a {@link RyuResult}. Errors that are not
 * RyuError (which a facade call never raises) are rethrown.
 */
export async function toResult<T>(
	promise: PromiseLike<T>
): Promise<RyuResult<T>> {
	const meta = CALL_META.get(promise);
	try {
		const data = await promise;
		return { data, error: null, meta: meta?.() ?? { ...EMPTY_META } };
	} catch (error) {
		if (isRyuError(error)) {
			return { data: null, error, meta: meta?.() ?? null };
		}
		throw error;
	}
}

/**
 * A proxy whose property `key` is `resolve(key)`: the facade passes a
 * resolver that returns each namespace in object mode.
 */
export function createSafeProxy<T extends object>(
	resolve: (key: string) => unknown
): T {
	const cache = new Map<string, unknown>();
	return new Proxy(Object.create(null) as T, {
		get(_target, property) {
			if (typeof property !== "string" || property === "then") {
				return undefined;
			}
			if (!cache.has(property)) {
				cache.set(property, resolve(property));
			}
			return cache.get(property);
		},
	});
}
