"use client";

import { useEffect, useRef } from "react";
import { BUILT_IN_LANGUAGE_PACK_INFO } from "./built-in-pack-info.ts";
import type { LanguagePack } from "./pack.ts";
import {
	type I18nProviderProps,
	useI18nProviderElement,
} from "./react-provider-base.tsx";
import { I18nRuntime, type I18nRuntimeOptions } from "./runtime.ts";

const NO_PACKS: readonly LanguagePack[] = [];
const RESERVED_BUILT_IN_IDS = BUILT_IN_LANGUAGE_PACK_INFO.map(
	(pack) => pack.id
);

export interface LiteI18nProviderProps extends I18nProviderProps {
	/**
	 * The first-party catalogs this page has loaded so far: trusted packs from
	 * `@ryu/i18n/messages` (for example the request locale's pack, rendered by
	 * the server, or the whole catalog once it is imported). Pass a new array
	 * to add more; the runtime re-applies its selection exactly as when remote
	 * packs change. Every built-in id stays reserved while its catalog is absent.
	 */
	builtInPacks?: readonly LanguagePack[];
}

interface AppliedBuiltIns {
	packs: readonly LanguagePack[];
	runtime: I18nRuntime;
}

/**
 * `I18nProvider` for pages that must not bundle every built-in catalog. It
 * shares the context, hooks and DOM localizer of `@ryu/i18n/react`, so shared
 * components read it unchanged; the runtime starts from `builtInPacks` only.
 */
export function I18nProvider({
	builtInPacks = NO_PACKS,
	...props
}: LiteI18nProviderProps) {
	const { element, runtime } = useI18nProviderElement(
		props,
		(packs: readonly LanguagePack[], options: I18nRuntimeOptions) =>
			new I18nRuntime(packs, options, {
				packs: builtInPacks,
				reservedIds: RESERVED_BUILT_IN_IDS,
			})
	);
	// A runtime built (or rebuilt for a new selection key) during this render
	// already holds this render's built-in packs.
	const applied = useRef<AppliedBuiltIns | null>(null);
	if (applied.current?.runtime !== runtime) {
		applied.current = { packs: builtInPacks, runtime };
	}
	useEffect(() => {
		const current = applied.current;
		if (current?.runtime === runtime && current.packs === builtInPacks) {
			return;
		}
		applied.current = { packs: builtInPacks, runtime };
		runtime.setBuiltInPacks(builtInPacks);
	}, [builtInPacks, runtime]);
	return element;
}
