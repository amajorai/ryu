"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { I18nHostSnapshot, I18nRuntime } from "./runtime.ts";

interface I18nHostSubscription {
	listener: () => void;
	unsubscribe: (() => void) | null;
}

interface I18nHostRelay {
	attached: boolean;
	retired: boolean;
	retirement: object | null;
	runtime: I18nRuntime | null;
	subscriptions: Set<I18nHostSubscription>;
}

function detachHostSubscription(subscription: I18nHostSubscription) {
	const unsubscribe = subscription.unsubscribe;
	subscription.unsubscribe = null;
	unsubscribe?.();
}

function attachHostSubscription(
	relay: I18nHostRelay,
	subscription: I18nHostSubscription
) {
	const instance = relay.attached ? relay.runtime : null;
	subscription.unsubscribe = instance
		? instance.subscribe(() => {
				if (
					relay.attached &&
					relay.runtime === instance &&
					relay.subscriptions.has(subscription)
				) {
					subscription.listener();
				}
			})
		: null;
}

export function useI18nHostRelay(runtime: I18nRuntime) {
	// One Provider owns the retained methods and native callback Set. All hooks
	// share these methods; their render-time fields still use the current runtime.
	const hostRelay = useRef<I18nHostRelay>({
		runtime,
		attached: false,
		retired: false,
		retirement: null,
		subscriptions: new Set(),
	});
	const hostMethods = useMemo(
		() => ({
			getSnapshot: (): I18nHostSnapshot => {
				const instance = hostRelay.current.runtime;
				if (!instance) {
					throw new Error("The language host is not mounted");
				}
				return instance.getSnapshot();
			},
			subscribe: (
				listener: () => void
			): ReturnType<I18nRuntime["subscribe"]> => {
				const relay = hostRelay.current;
				if (relay.retired) {
					return () => false;
				}
				// The runtime stores callbacks in a Set. Identical callbacks share
				// one registration, and either disposer removes that same record.
				const existing = Array.from(relay.subscriptions).find(
					(record) => record.listener === listener
				);
				const subscription: I18nHostSubscription = existing ?? {
					listener,
					unsubscribe: null,
				};
				if (!existing) {
					relay.subscriptions.add(subscription);
					attachHostSubscription(relay, subscription);
				}
				return () => {
					// Native Set disposers delete the callback, including a later
					// re-registration of that same callback after an earlier removal.
					const current = Array.from(relay.subscriptions).find(
						(record) => record.listener === listener
					);
					if (!current) {
						return false;
					}
					const removed = relay.subscriptions.delete(current);
					detachHostSubscription(current);
					return removed;
				};
			},
		}),
		[]
	);
	// Select the DOM commit hook when rendering, after a test or host has supplied
	// its DOM. SSR has no mounted host streams and uses the ordinary effect.
	const useHostCommitEffect =
		globalThis.document === undefined ? useEffect : useLayoutEffect;
	useHostCommitEffect(() => {
		const relay = hostRelay.current;
		const replaced = relay.runtime !== runtime;
		for (const subscription of relay.subscriptions) {
			detachHostSubscription(subscription);
		}
		relay.runtime = runtime;
		relay.attached = runtime !== null;
		relay.retired = false;
		relay.retirement = null;
		for (const subscription of relay.subscriptions) {
			attachHostSubscription(relay, subscription);
		}
		if (replaced && runtime) {
			for (const subscription of Array.from(relay.subscriptions)) {
				if (relay.subscriptions.has(subscription)) {
					subscription.listener();
				}
			}
		}
		return () => {
			relay.attached = false;
			for (const subscription of relay.subscriptions) {
				detachHostSubscription(subscription);
			}
		};
	}, [runtime]);
	useHostCommitEffect(() => {
		const relay = hostRelay.current;
		relay.retired = false;
		relay.retirement = null;
		return () => {
			// StrictMode replays descendant layouts before this hook's setup. Keep
			// the committed snapshot and queue records during that detached phase;
			// actual runtime listeners have already been removed synchronously.
			const retirement = {};
			relay.retirement = retirement;
			queueMicrotask(() => {
				if (relay.retirement !== retirement || relay.attached) {
					return;
				}
				relay.retired = true;
				for (const subscription of relay.subscriptions) {
					detachHostSubscription(subscription);
				}
				relay.subscriptions.clear();
				relay.runtime = null;
			});
		};
	}, []);
	return hostMethods;
}
