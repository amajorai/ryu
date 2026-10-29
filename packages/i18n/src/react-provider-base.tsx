"use client";

import {
	type ReactElement,
	useEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import type { LanguagePack } from "./pack.ts";
import {
	type AppliedCatalog,
	sameCatalogValue,
	snapshotCatalogValue,
} from "./react-catalog.ts";
import { I18nContext } from "./react-context.tsx";
import { I18nDomLocalizer } from "./react-dom-localizer.tsx";
import { useI18nHostRelay } from "./react-host-relay.ts";
import type {
	I18nRuntime,
	I18nRuntimeOptions,
	MessageOverlays,
} from "./runtime.ts";

const EMPTY_PACKS: readonly LanguagePack[] = [];

export interface I18nProviderProps extends I18nRuntimeOptions {
	/**
	 * Translate catalog literals and explicitly opted-in legacy UI DOM copy.
	 * `true` waits for hydration to settle before the first scan (for
	 * server-rendered pages); `"immediate"` scans on mount, for client-only
	 * apps that have nothing to hydrate.
	 */
	autoLocalizeDom?: boolean | "immediate";
	children: React.ReactNode;
	/**
	 * Subtree the DOM localizer scans and observes instead of the document,
	 * such as a content script's shadow root. `null` waits for the root to
	 * exist; omit it to localize the whole document.
	 */
	domRoot?: Node | null;
	/**
	 * Write `<html lang/dir>` and `--ryu-locale` for the active locale. Turn it
	 * off when the provider renders inside a page it does not own.
	 */
	manageDocument?: boolean;
	/** App message catalogs layered under the selected pack. */
	overlays?: MessageOverlays;
	packs?: readonly LanguagePack[];
	/** Re-read selection options without remounting consumer state or focus. */
	selectionKey?: string | number;
}

/** Build the runtime a provider mounts, from its packs and selection options. */
export type CreateI18nRuntime = (
	packs: readonly LanguagePack[],
	options: I18nRuntimeOptions
) => I18nRuntime;

/**
 * The provider body shared by `@ryu/i18n/react` and `@ryu/i18n/react-lite`.
 * It is a hook rather than a wrapper component so either provider mounts the
 * same component tree; only `createRuntime` (which built-in packs the runtime
 * holds) differs between them. Returns the provider element and its runtime.
 */
export function useI18nProviderElement(
	{
		children,
		initialLocale,
		initialPackId,
		persistPackId,
		packs = EMPTY_PACKS,
		overlays,
		autoLocalizeDom = true,
		domRoot,
		manageDocument = true,
		selectionKey,
	}: I18nProviderProps,
	createRuntime: CreateI18nRuntime
): { element: ReactElement; runtime: I18nRuntime } {
	const runtime = useRef<I18nRuntime | null>(null);
	const appliedCatalog = useRef<AppliedCatalog | null>(null);
	const previousSelectionKey = useRef(selectionKey);
	if (
		runtime.current === null ||
		previousSelectionKey.current !== selectionKey
	) {
		const options: I18nRuntimeOptions = {};
		if (initialLocale !== undefined) {
			options.initialLocale = initialLocale;
		}
		if (initialPackId !== undefined) {
			options.initialPackId = initialPackId;
		}
		if (persistPackId !== undefined) {
			options.persistPackId = persistPackId;
		}
		if (overlays !== undefined) {
			options.overlays = overlays;
		}
		runtime.current = createRuntime(packs, options);
		// The constructor applies this catalog without publishing it.
		appliedCatalog.current = {
			catalog: snapshotCatalogValue(packs),
			packs,
			runtime: runtime.current,
		};
		previousSelectionKey.current = selectionKey;
	}
	const instance = runtime.current;
	const hostMethods = useI18nHostRelay(instance);

	const overlaysRef = useRef(overlays);
	useEffect(() => {
		if (overlaysRef.current !== overlays) {
			overlaysRef.current = overlays;
			instance.setOverlays(overlays ?? {});
		}
	}, [instance, overlays]);

	// No dependency list: a host that edits its packs in place and re-renders
	// with the same array must still publish, so the content comparison runs on
	// every commit rather than only when the array identity changes.
	useEffect(() => {
		// Hosts hand over a new array for every read, even when Core's answer is
		// unchanged ([] -> []). Each publication bumps the version, re-renders
		// every consumer, rewrites <html> lang/dir and rescans the whole DOM, so
		// publish only content that differs from what this runtime applied. An
		// acknowledged replacement can change messages, locale or direction
		// without changing package identity or version, so compare all of it.
		const applied = appliedCatalog.current;
		if (
			applied?.runtime === instance &&
			sameCatalogValue(applied.catalog, packs)
		) {
			if (applied.packs !== packs) {
				applied.packs = packs;
				// Skipping setPacks must not skip its re-read of a pack id saved
				// while none was selected; that publishes only when it adopts one.
				instance.adoptStoredPackId();
			}
			return;
		}
		instance.setPacks(packs);
		appliedCatalog.current = {
			catalog: snapshotCatalogValue(packs),
			packs,
			runtime: instance,
		};
	});

	const version = useSyncExternalStore(
		instance.subscribe,
		instance.getVersion,
		instance.getVersion
	);

	useEffect(() => {
		if (!manageDocument || globalThis.document === undefined) {
			return;
		}
		const root = document.documentElement;
		root.lang = instance.locale;
		root.dir = instance.direction;
		root.style.setProperty("--ryu-locale", instance.locale);
	}, [instance, manageDocument, version]);

	return {
		element: (
			<I18nContext.Provider value={{ hostMethods, runtime: instance, version }}>
				{autoLocalizeDom ? (
					<I18nDomLocalizer
						defer={autoLocalizeDom !== "immediate"}
						{...(domRoot === undefined ? {} : { root: domRoot })}
					/>
				) : null}
				{children}
			</I18nContext.Provider>
		),
		runtime: instance,
	};
}
