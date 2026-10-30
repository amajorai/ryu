"use client";

import { useContext, useEffect, useRef } from "react";
import {
	createDomLocalizerRecords,
	type DomLocalizerRecords,
	type DomLocalizerState,
	observeDomLocalization,
} from "./dom-localizer.ts";
import { companionI18nApi } from "./dom-localizer-host.ts";
import { runtimeGeneration } from "./react-catalog.ts";
import { I18nContext, useI18n } from "./react-context.tsx";
import type { I18nRuntime } from "./runtime.ts";

/**
 * Run `start` once the page is idle, so the first scan never rewrites
 * server-rendered text that React has not hydrated yet. Returns a canceller.
 */
function afterHydration(start: () => void): () => void {
	if (typeof globalThis.requestIdleCallback === "function") {
		const handle = globalThis.requestIdleCallback(start, { timeout: 200 });
		return () => globalThis.cancelIdleCallback?.(handle);
	}
	const handle = setTimeout(start, 0);
	return () => clearTimeout(handle);
}

/** Localization state read straight from a runtime, for non-React callers. */
function runtimeState(runtime: I18nRuntime): DomLocalizerState {
	return {
		availablePacks: runtime.availablePacks,
		hasOverlayMessage: (id) => runtime.overlayMessage(id) !== undefined,
		t: (id, values, fallback) => runtime.translate(id, values, fallback),
		templateMessage: (text) => runtime.templateMessage(text),
	};
}

/**
 * Localize a DOM subtree, such as a content script's shadow root, that no
 * `I18nProvider` observes. Follows the runtime's language changes and
 * returns a disposer.
 */
export function localizeDomRoot(
	runtime: I18nRuntime,
	root: Node,
	options: { host?: Parameters<typeof observeDomLocalization>[0]["host"] } = {}
): () => void {
	const records = createDomLocalizerRecords();
	const start = () =>
		observeDomLocalization({
			host: options.host ?? null,
			records,
			root,
			state: () => runtimeState(runtime),
			translationKey: () =>
				`${runtime.getVersion()}\u0000${runtime.selectedPackId ?? ""}\u0000${runtime.locale}`,
		});
	let stop = start();
	const unsubscribe = runtime.subscribe(() => {
		stop();
		stop = start();
	});
	return () => {
		unsubscribe();
		stop();
	};
}

/**
 * Localize raw strings left by older first-party surfaces under `root`
 * (the document by default). With `defer` (the default) the first scan waits
 * until the page is idle (at most ~200ms), so it does not rewrite
 * server-rendered text before React hydrates it. That is a best-effort guard:
 * a Suspense boundary that hydrates later can still be scanned first. A
 * client-only app has nothing to hydrate and should pass `defer={false}` to
 * avoid showing English for that first moment. Later language changes rescan
 * immediately.
 */
export function I18nDomLocalizer({
	defer = true,
	root,
}: {
	defer?: boolean;
	root?: Node | null;
}) {
	const i18n = useI18n();
	// A rebuilt runtime starts its own version count, which can equal the
	// previous runtime's. Rescan on the runtime itself, not only its version.
	const runtime = useContext(I18nContext)?.runtime ?? null;
	const stateRef = useRef(i18n);
	stateRef.current = i18n;
	const recordsRef = useRef<DomLocalizerRecords | null>(null);
	recordsRef.current ??= createDomLocalizerRecords();
	const records = recordsRef.current;
	const hydratedRef = useRef(false);

	useEffect(() => {
		if (globalThis.document === undefined || root === null) {
			return;
		}
		const generation = runtimeGeneration(runtime);
		const version = i18n.version;
		const start = () =>
			observeDomLocalization({
				host: companionI18nApi(),
				records,
				root,
				state: () => stateRef.current,
				translationKey: () => {
					const current = stateRef.current;
					return `${generation}\u0000${version}\u0000${current.selectedPackId ?? ""}\u0000${current.locale}`;
				},
			});
		if (hydratedRef.current || !defer) {
			hydratedRef.current = true;
			return start();
		}
		let stop: (() => void) | null = null;
		const cancel = afterHydration(() => {
			hydratedRef.current = true;
			stop = start();
		});
		return () => {
			cancel();
			stop?.();
		};
	}, [defer, i18n.version, records, root, runtime]);

	return null;
}
