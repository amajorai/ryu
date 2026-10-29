// packages/services/src/wrap.ts
//
// The facade mechanics (design §2.3). `ryu.<ns>` is a Proxy that records the
// property path (`sessions.create`); applying it:
//
// 1. creates a CallContext from the bound per-call options;
// 2. resolves the service config (lazily, so a missing env var surfaces on the
//    first call, not at construction); a method the definition lists as
//    credential-free falls back to a config without credentials;
// 3. builds the underlying client with that call's service-scoped fetch.
//    Constructors do no I/O, so per-call construction is cheap and binds the
//    shim to the call's signal, idempotency key and meta without
//    AsyncLocalStorage, which keeps the facade edge-safe;
// 4. invokes the method and maps errors on the returned promise or async
//    iterable. In object mode promises resolve to `{ data, error, meta }`.

import type { RyuFetch } from "@ryuhq/client";
import {
	type ConfigResolution,
	defaultErrorHint,
	type ResolvedServiceConfig,
	type RyuResultMode,
} from "./config.ts";
import {
	type ErrorCallContext,
	isRyuError,
	RyuAbortError,
	RyuConfigurationError,
	RyuConnectionError,
	type RyuError,
	type RyuService,
	RyuTimeoutError,
	toRyuError,
	withRyuErrorFields,
} from "./errors.ts";
import {
	EMPTY_META,
	type RyuResult,
	registerCallMeta,
	type Safe,
} from "./result.ts";
import type { ServiceRouteTable } from "./routes.ts";
import { SERVICE_TITLES } from "./service-titles.ts";
import {
	type CallContext,
	type CallOptions,
	createCallContext,
	createServiceFetch,
	type RouteKeySelector,
	type ServiceErrorMode,
	type ServiceFetchConfig,
} from "./transport/fetch-shim.ts";

/** How the facade builds and talks to one service's client. Each `src/<svc>/namespace.ts` exports one. */
export interface NamespaceDefinition<Client> {
	/**
	 * Builds the client for one call. Must do no I/O. `options` are the call's
	 * own options, for clients that need the call's signal directly (a
	 * reconnecting stream must stop on abort, not treat it as a dropped
	 * connection).
	 */
	create(
		config: ResolvedServiceConfig,
		fetch: RyuFetch,
		options: CallOptions
	): Client;
	/**
	 * Dotted paths of methods whose route needs no credential (Messaging
	 * `status`). When the service's credentials are missing, only these
	 * methods run, on a config resolved with `credentials: "optional"`; every
	 * other method still fails with the missing-credential error. With
	 * credentials configured they behave like any other method.
	 */
	credentialFreeMethods?: readonly string[];
	/**
	 * Adjusts every RyuError the call raises, after the facade has added the
	 * call's context (Managed Agents adds its preview hint here).
	 */
	decorateError?(error: RyuError): RyuError;
	/** `passthrough` for clients that raise their own typed errors (Managed Agents). */
	errors: ServiceErrorMode;
	/**
	 * Reads the server's feature flags (Passport `GET /v1/capabilities`
	 * `features`) for `capabilityIdempotent` routes. Its answer is cached per
	 * Ryu instance and base URL for {@link CAPABILITY_TTL_MS}; it runs through
	 * a shim with no retries, no caller hooks and its own short timeout.
	 */
	probeCapabilities?(
		config: ResolvedServiceConfig,
		fetch: RyuFetch,
		options: CallOptions
	): Promise<CapabilityFeatures>;
	/** Adjusts a parsed error from its raw JSON body before the retry decision (Gateway `upstream_status`). */
	refineError?(error: RyuError, body: unknown): RyuError;
	/**
	 * Names a machine code for an error the service reports only as prose
	 * (Mail send-ledger conflicts). The shim applies it before its retry
	 * decision.
	 */
	refineErrorCode?(status: number, message: string): string | null;
	routes: ServiceRouteTable;
	/** Per-route key swaps (Connect management, Passport runtime). */
	selectKey?(config: ResolvedServiceConfig): RouteKeySelector | undefined;
	service: RyuService;
	/**
	 * Dotted paths of methods that return a plain value (no I/O). A config
	 * failure on them throws synchronously, in both result modes, so a caller
	 * cannot mistake the failed call for a config object.
	 */
	syncMethods?: readonly string[];
}

/** A server's advertised feature flags. */
export type CapabilityFeatures = Readonly<Record<string, unknown>>;

/** One cached capability answer; `expiresAt` is Infinity while the probe is pending. */
export interface CapabilityCacheEntry {
	expiresAt: number;
	readonly value: Promise<CapabilityFeatures | null>;
}

/**
 * Per-Ryu-instance capability answers keyed by service and base URL. A
 * pending answer is shared; a definitive one is kept for
 * {@link CAPABILITY_TTL_MS} (an auth failure for
 * {@link CAPABILITY_AUTH_FAILURE_TTL_MS}); any other failed probe is dropped
 * so the next call asks again.
 */
export type CapabilityCache = Map<string, CapabilityCacheEntry>;

/**
 * How long a definitive capability answer is trusted. Bounded so a server
 * rolled back to a build without the feature stops getting keyed retries.
 */
export const CAPABILITY_TTL_MS = 5 * 60_000;
/** How long a 401/403 probe answer (no features) is kept, so a bad key does not double the failed authentications. */
export const CAPABILITY_AUTH_FAILURE_TTL_MS = 30_000;
/** The capability probe's own per-request timeout, independent of the call's. */
export const CAPABILITY_PROBE_TIMEOUT_MS = 5000;

/** What the facade needs from the Ryu instance. */
export interface WrapRuntime {
	/** Where capability probes are cached; without it every gated route is off. */
	readonly capabilityCache?: CapabilityCache;
	/** Resolves (and memoizes) the service config; throws RyuConfigurationError. */
	resolveConfig(
		service: RyuService,
		resolution?: ConfigResolution
	): ResolvedServiceConfig;
	/** The shim settings for one call to the service. */
	shimConfig(
		config: ResolvedServiceConfig,
		definition: NamespaceDefinition<unknown>
	): ServiceFetchConfig;
}

/** A namespace in the given result mode. */
export type ResultModeNamespace<C, R extends RyuResultMode> = R extends "object"
	? Safe<C>
	: C;

/** A namespace plus `.with()` for per-call options. */
export type BoundNamespace<
	C,
	R extends RyuResultMode = "throw",
> = ResultModeNamespace<C, R> & {
	/** The same namespace with `options` applied to every call made through it. */
	with(options: CallOptions): BoundNamespace<C, R>;
};

type AnyFunction = (...args: unknown[]) => unknown;

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { [Symbol.asyncIterator]?: unknown })[
			Symbol.asyncIterator
		] === "function"
	);
}

function callErrorContext(ctx: CallContext): ErrorCallContext {
	const last = ctx.lastRequest;
	const aborted = ctx.options.signal?.aborted === true;
	return last
		? {
				aborted,
				attempts: last.attempts,
				deprecation: last.deprecation,
				idempotencyKey: last.idempotencyKey,
				lastFailure: ctx.lastFailure,
				method: last.method,
				rateLimit: last.rateLimit,
				url: last.url,
			}
		: { aborted };
}

type ErrorMapper = (error: unknown) => RyuError;

/** Error mapping plus the call's own signal, for iterables a call returns. */
interface IterationGuard {
	mapError: ErrorMapper;
	signal: AbortSignal | undefined;
}

/** Closes an iterator without waiting: a stuck `next()` would hold `return()` in the generator's queue. */
function closeQuietly(close: (() => unknown) | undefined): void {
	try {
		Promise.resolve(close?.()).catch(() => undefined);
	} catch {
		// Closing is best effort.
	}
}

/**
 * Pulls one step and rejects with RyuAbortError as soon as the call's signal
 * fires, closing the source. Without this a client that retries inside its
 * iterator (the Managed Agents stream) could keep waiting on a call the
 * caller already gave up on.
 */
function guardedStep<R>(
	step: () => PromiseLike<R>,
	close: (() => unknown) | undefined,
	{ mapError, signal }: IterationGuard
): Promise<R> {
	const mapped = (): Promise<R> =>
		Promise.resolve()
			.then(step)
			.then(
				(value) => value,
				(error: unknown) => {
					throw mapError(error);
				}
			);
	if (signal === undefined) {
		return mapped();
	}
	if (signal.aborted) {
		closeQuietly(close);
		return Promise.reject(mapError(signal.reason));
	}
	return new Promise<R>((resolve, reject) => {
		const onAbort = () => {
			closeQuietly(close);
			reject(mapError(signal.reason));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		mapped().then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			}
		);
	});
}

function mapIterator<T>(
	iterator: AsyncIterator<T>,
	guardOptions: IterationGuard
): AsyncIterableIterator<T> {
	const { mapError } = guardOptions;
	const guard = <R>(promise: Promise<R>): Promise<R> =>
		promise.then(
			(value) => value,
			(error: unknown) => {
				throw mapError(error);
			}
		);
	const close = iterator.return?.bind(iterator);
	return {
		next: (...args: [] | [unknown]) =>
			guardedStep(() => iterator.next(...args), close, guardOptions),
		return: (value?: unknown) =>
			iterator.return
				? guard(iterator.return(value))
				: Promise.resolve({ done: true, value: value as T }),
		throw: (error?: unknown) =>
			iterator.throw ? guard(iterator.throw(error)) : Promise.reject(error),
		[Symbol.asyncIterator]() {
			return this;
		},
	};
}

/**
 * Wraps an async iterable (a client stream, an async generator, or a
 * Paginated) so every failure is a RyuError. Other methods on it (`pages()`,
 * `collect()`) are wrapped the same way.
 */
function mapIterable<T extends object>(
	source: T,
	guardOptions: IterationGuard
): T {
	const { mapError } = guardOptions;
	return new Proxy(source, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (property === Symbol.asyncIterator && typeof value === "function") {
				return () =>
					mapIterator(
						(value as () => AsyncIterator<unknown>).call(target),
						guardOptions
					);
			}
			if (property === "next" && typeof value === "function") {
				const close = Reflect.get(target, "return", target) as
					| (() => unknown)
					| undefined;
				return (...args: unknown[]) =>
					guardedStep(
						() =>
							(value as AnyFunction).apply(
								target,
								args
							) as PromiseLike<unknown>,
						typeof close === "function" ? close.bind(target) : undefined,
						guardOptions
					);
			}
			if (
				(property === "return" || property === "throw") &&
				typeof value === "function"
			) {
				return (...args: unknown[]) =>
					Promise.resolve((value as AnyFunction).apply(target, args)).then(
						(result) => result,
						(error: unknown) => {
							throw mapError(error);
						}
					);
			}
			if (typeof value === "function") {
				return (...args: unknown[]) =>
					mapValue((value as AnyFunction).apply(target, args), guardOptions);
			}
			return value;
		},
	});
}

/** Error-maps a value returned inside an iterable or a nested helper (never object-wrapped). */
function mapValue(value: unknown, guardOptions: IterationGuard): unknown {
	const { mapError } = guardOptions;
	if (isThenable(value)) {
		return Promise.resolve(value).then(
			(result) => result,
			(error: unknown) => {
				throw mapError(error);
			}
		);
	}
	if (isAsyncIterable(value)) {
		return mapIterable(value, guardOptions);
	}
	return value;
}

/**
 * A call that failed before it started (config, unknown method). It is both a
 * thenable and an async iterable, because the facade cannot know which one the
 * method would have returned: awaiting it rejects (or, in object mode,
 * resolves to the error result), iterating it throws. It is lazy, so an
 * unawaited failure raises no unhandled rejection.
 */
function failedCall(
	error: RyuError,
	mode: RyuResultMode
): PromiseLike<unknown> & AsyncIterable<never> {
	const settle = (): Promise<unknown> =>
		mode === "object"
			? Promise.resolve({ data: null, error, meta: null })
			: Promise.reject(error);
	const failed = {
		// biome-ignore lint/suspicious/noThenProperty: a failed call must be awaitable like the promise the method would have returned.
		then<A = unknown, B = never>(
			onFulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
			onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
		): Promise<A | B> {
			return settle().then(onFulfilled, onRejected);
		},
		catch<B = never>(
			onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
		): Promise<unknown> {
			return settle().catch(onRejected);
		},
		finally(onFinally?: (() => void) | null): Promise<unknown> {
			return settle().finally(onFinally);
		},
		[Symbol.asyncIterator](): AsyncIterator<never> {
			return {
				next: () => Promise.reject(error),
				return: () =>
					Promise.resolve({ done: true, value: undefined as never }),
			};
		},
	};
	registerCallMeta(failed, () => null);
	return failed;
}

/** Turns a successful top-level result into the call's final form. */
function finishCall(
	value: unknown,
	ctx: CallContext,
	mode: RyuResultMode,
	mapError: ErrorMapper
): unknown {
	const guardOptions: IterationGuard = {
		mapError,
		signal: ctx.options.signal,
	};
	if (isThenable(value)) {
		const mapped = Promise.resolve(value).then(
			(result) => mapValue(result, guardOptions),
			(error: unknown) => {
				throw mapError(error);
			}
		);
		const final =
			mode === "object"
				? mapped.then(
						(data): RyuResult<unknown> => ({
							data,
							error: null,
							meta: ctx.meta ?? { ...EMPTY_META },
						}),
						(error: unknown): RyuResult<unknown> => {
							if (isRyuError(error)) {
								return { data: null, error, meta: ctx.meta };
							}
							throw error;
						}
					)
				: mapped;
		registerCallMeta(final, () => ctx.meta);
		return final;
	}
	return mapValue(value, guardOptions);
}

/**
 * Fills what a call's error lacks: a default hint naming the env var to check
 * (401, 403, connection failure), and the request id of the call's last
 * response for an error the client raised after it (Mail's `inbox_not_found`
 * after the inbox lookup), so support can still correlate it.
 */
function completeError(
	error: RyuError,
	ctx: CallContext,
	config: ResolvedServiceConfig | undefined
): RyuError {
	const overrides: { hint?: string; requestId?: string } = {};
	if (error.hint === null && config !== undefined) {
		const hint = defaultErrorHint(error, config);
		if (hint !== null) {
			overrides.hint = hint;
		}
	}
	const raisedAfterResponse =
		error.status === 0 &&
		!(
			error instanceof RyuConnectionError ||
			error instanceof RyuTimeoutError ||
			error instanceof RyuAbortError ||
			error instanceof RyuConfigurationError
		);
	const lastRequestId = ctx.meta?.requestId ?? null;
	if (
		error.requestId === null &&
		raisedAfterResponse &&
		lastRequestId !== null
	) {
		overrides.requestId = lastRequestId;
	}
	return Object.keys(overrides).length === 0
		? error
		: withRyuErrorFields(error, overrides);
}

/** Statuses that mean the server has no capabilities route: a definitive "no features". */
const NO_CAPABILITIES_ROUTE: ReadonlySet<number> = new Set([404, 405]);
/** Statuses that mean the probe's credential was refused: no features, briefly cached. */
const CAPABILITY_AUTH_FAILURE: ReadonlySet<number> = new Set([401, 403]);

/** How long a probe outcome is cached, or null to drop it. */
function capabilityTtl(error: unknown): number | null {
	if (!isRyuError(error)) {
		return null;
	}
	if (NO_CAPABILITIES_ROUTE.has(error.status)) {
		return CAPABILITY_TTL_MS;
	}
	return CAPABILITY_AUTH_FAILURE.has(error.status)
		? CAPABILITY_AUTH_FAILURE_TTL_MS
		: null;
}

/**
 * The server's features, from `cache` or a fresh probe. A successful probe,
 * and a 404/405 (no capabilities route, so an older build), are cached for
 * {@link CAPABILITY_TTL_MS}; a 401/403 answers null for
 * {@link CAPABILITY_AUTH_FAILURE_TTL_MS}; any other failure (network,
 * timeout, 5xx, an unreadable body) answers null for this call only, so the
 * caller fails closed and a later call probes again.
 */
export function cachedCapabilities(
	cache: CapabilityCache,
	key: string,
	probe: () => Promise<CapabilityFeatures>,
	now: () => number = Date.now
): Promise<CapabilityFeatures | null> {
	const cached = cache.get(key);
	if (cached !== undefined && cached.expiresAt > now()) {
		return cached.value;
	}
	const settle = (ttl: number | null): void => {
		if (cache.get(key) !== entry) {
			return;
		}
		if (ttl === null) {
			cache.delete(key);
		} else {
			entry.expiresAt = now() + ttl;
		}
	};
	const value = new Promise<CapabilityFeatures>((resolve) => {
		resolve(probe());
	}).then(
		(features) => {
			settle(CAPABILITY_TTL_MS);
			return features;
		},
		(error: unknown) => {
			settle(capabilityTtl(error));
			return null;
		}
	);
	const entry: CapabilityCacheEntry = {
		expiresAt: Number.POSITIVE_INFINITY,
		value,
	};
	cache.set(key, entry);
	return value;
}

/**
 * `promise`, or `fallback` as soon as `signal` aborts. Each caller waits on a
 * shared probe with its own signal, so one caller's cancellation never
 * settles the probe for the others.
 */
function untilAborted<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	fallback: T
): Promise<T> {
	if (signal === undefined) {
		return promise;
	}
	if (signal.aborted) {
		return Promise.resolve(fallback);
	}
	return new Promise<T>((resolve) => {
		const onAbort = () => resolve(fallback);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve(fallback);
			}
		);
	});
}

/**
 * Wires the shim's `capability` lookup to the definition's probe and the
 * runtime cache. The probe is SDK-internal: it runs without the caller's
 * hooks, signal or timeout (it has its own short timeout and no retries), so
 * hooks never see a request the caller did not make, and one caller aborting
 * cannot turn keyed creates off for concurrent callers sharing the probe.
 */
function capabilityLookup(
	runtime: WrapRuntime,
	definition: NamespaceDefinition<unknown>,
	config: ResolvedServiceConfig,
	shim: ServiceFetchConfig,
	ctx: CallContext
): ((name: string) => Promise<boolean>) | undefined {
	const cache = runtime.capabilityCache;
	const probeCapabilities = definition.probeCapabilities;
	if (cache === undefined || probeCapabilities === undefined) {
		return undefined;
	}
	const key = `${definition.service} ${config.baseUrl}`;
	const probe = () => {
		const probeOptions: CallOptions = {};
		const probeFetch = createServiceFetch(
			{
				...shim,
				capability: undefined,
				errors: "throw",
				hooks: undefined,
				maxRetries: 0,
				timeoutMs:
					shim.timeoutMs > 0
						? Math.min(shim.timeoutMs, CAPABILITY_PROBE_TIMEOUT_MS)
						: CAPABILITY_PROBE_TIMEOUT_MS,
			},
			createCallContext(probeOptions)
		);
		return probeCapabilities(config, probeFetch, probeOptions);
	};
	return async (name) => {
		const features = await untilAborted(
			cachedCapabilities(cache, key, probe),
			ctx.options.signal,
			null
		);
		return features?.[name] === true;
	};
}

/** Resolves the call's config, falling back to a credential-free one for listed methods. */
function resolveCallConfig(
	runtime: WrapRuntime,
	definition: NamespaceDefinition<unknown>,
	path: readonly string[]
): ResolvedServiceConfig {
	try {
		return runtime.resolveConfig(definition.service);
	} catch (error) {
		if (
			!(
				error instanceof RyuConfigurationError &&
				definition.credentialFreeMethods?.includes(path.join("."))
			)
		) {
			throw error;
		}
		return runtime.resolveConfig(definition.service, {
			credentials: "optional",
		});
	}
}

/**
 * The facade Proxy for one service. `bound` holds options applied by
 * `.with()`; `mode` picks throw or object results.
 */
export function wrapNamespace<C>(
	runtime: WrapRuntime,
	definition: NamespaceDefinition<C>,
	mode: RyuResultMode,
	bound: CallOptions = {}
): unknown {
	// One holder per bound namespace: its key is spent by the first write.
	const boundKey =
		bound.idempotencyKey === undefined ? undefined : { spent: false };
	const invoke = (path: readonly string[], args: unknown[]): unknown => {
		const ctx = createCallContext(bound, boundKey);
		let config: ResolvedServiceConfig | undefined;
		const mapError: ErrorMapper = (error) => {
			const mapped = toRyuError(
				error,
				definition.service,
				callErrorContext(ctx)
			);
			const decorated = definition.decorateError
				? definition.decorateError(mapped)
				: mapped;
			return completeError(decorated, ctx, config);
		};
		try {
			config = resolveCallConfig(
				runtime,
				definition as NamespaceDefinition<unknown>,
				path
			);
		} catch (error) {
			if (definition.syncMethods?.includes(path.join("."))) {
				throw mapError(error);
			}
			return failedCall(mapError(error), mode);
		}
		const shim = runtime.shimConfig(
			config,
			definition as NamespaceDefinition<unknown>
		);
		shim.capability = capabilityLookup(
			runtime,
			definition as NamespaceDefinition<unknown>,
			config,
			shim,
			ctx
		);
		const fetch = createServiceFetch(shim, ctx);
		let parent: unknown;
		let target: unknown = definition.create(config, fetch, ctx.options);
		for (const key of path) {
			parent = target;
			target =
				typeof parent === "object" || typeof parent === "function"
					? (parent as Record<string, unknown> | null)?.[key]
					: undefined;
		}
		if (typeof target !== "function") {
			return failedCall(
				new RyuConfigurationError({
					service: definition.service,
					status: 0,
					code: "unknown_method",
					message: `${SERVICE_TITLES[definition.service]}: ${path.join(".")} is not a method.`,
				}),
				mode
			);
		}
		let value: unknown;
		try {
			value = (target as AnyFunction).apply(parent, args);
		} catch (error) {
			return failedCall(mapError(error), mode);
		}
		return finishCall(value, ctx, mode, mapError);
	};

	const pathProxy = (path: readonly string[]): unknown =>
		new Proxy(() => undefined, {
			apply: (_target, _this, args: unknown[]) => invoke(path, args),
			get: (_target, property) => {
				if (typeof property === "symbol" || property === "then") {
					return undefined;
				}
				if (path.length === 0 && property === "with") {
					return (options: CallOptions) =>
						wrapNamespace(runtime, definition, mode, {
							...bound,
							...options,
							headers: { ...bound.headers, ...options.headers },
						});
				}
				return pathProxy([...path, property]);
			},
		});

	return pathProxy([]);
}
