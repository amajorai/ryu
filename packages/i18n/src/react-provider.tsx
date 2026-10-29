"use client";

import { BUILT_IN_LANGUAGE_PACKS } from "./messages.ts";
import type { LanguagePack } from "./pack.ts";
import {
	type I18nProviderProps,
	useI18nProviderElement,
} from "./react-provider-base.tsx";
import { I18nRuntime, type I18nRuntimeOptions } from "./runtime.ts";

const BUNDLED_BUILT_INS = { packs: BUILT_IN_LANGUAGE_PACKS };

function createBundledRuntime(
	packs: readonly LanguagePack[],
	options: I18nRuntimeOptions
): I18nRuntime {
	return new I18nRuntime(packs, options, BUNDLED_BUILT_INS);
}

/**
 * Mount the shared locale runtime and keep the document's language/direction
 * current. Every first-party catalog is bundled and available synchronously,
 * so the provider renders any official language offline on its first render.
 */
export function I18nProvider(props: I18nProviderProps) {
	return useI18nProviderElement(props, createBundledRuntime).element;
}
