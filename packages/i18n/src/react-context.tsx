"use client";

import {
	createContext,
	useContext,
	useMemo,
	useSyncExternalStore,
} from "react";
import { EN_MESSAGES } from "./en-messages.ts";
import type { MessageValuesInput } from "./format.ts";
import { messageIdForLiteral } from "./literal-catalog.ts";
import type { I18nRuntime } from "./runtime.ts";

// The context and hooks every surface reads. They carry no catalog: a provider
// (`@ryu/i18n/react` or `@ryu/i18n/react-lite`) decides which packs a runtime
// holds, and shared components read whichever one mounted them.

export interface I18nContextValue {
	hostMethods: Pick<I18nRuntime, "getSnapshot" | "subscribe">;
	runtime: I18nRuntime;
	version: number;
}

export const I18nContext = createContext<I18nContextValue | null>(null);
const NOOP_SUBSCRIBE = () => () => undefined;
const ZERO_VERSION = () => 0;

export function useI18n() {
	const runtime = useContext(I18nContext);
	const value = useI18nValue(runtime);
	if (!value) {
		throw new Error("useI18n must be used inside I18nProvider");
	}
	return value;
}

/** Read the locale when a shared presentational block may be used standalone. */
export function useOptionalI18n() {
	return useI18nValue(useContext(I18nContext));
}

function useI18nValue(context: I18nContextValue | null) {
	const runtime = context?.runtime ?? null;
	const hostMethods = context?.hostMethods;
	const externalVersion = useSyncExternalStore(
		runtime?.subscribe ?? NOOP_SUBSCRIBE,
		runtime?.getVersion ?? ZERO_VERSION,
		runtime?.getVersion ?? ZERO_VERSION
	);
	// The context version is a second notification path. It matters for a
	// descendant that hydrates after a locale change: its external-store
	// subscription may not have observed the original emit, but the provider's
	// context value still carries the current version and forces a fresh snapshot.
	const version = Math.max(externalVersion, context?.version ?? 0);
	return useMemo(
		() =>
			runtime && hostMethods
				? {
						availablePacks: runtime.availablePacks,
						direction: runtime.direction,
						formatDate: runtime.formatDate.bind(runtime),
						formatNumber: runtime.formatNumber.bind(runtime),
						getSnapshot: hostMethods.getSnapshot,
						hasOverlayMessage: (id: string) =>
							runtime.overlayMessage(id) !== undefined,
						locale: runtime.locale,
						selectedPack: runtime.selectedPack,
						selectedPackId: runtime.selectedPackId,
						selectPack: (id: string | null) => runtime.selectPack(id),
						setLocale: (locale: string) => runtime.setLocale(locale),
						snapshot: runtime.getSnapshot(),
						subscribe: hostMethods.subscribe,
						t: (id: string, values?: MessageValuesInput, fallback?: string) =>
							runtime.translate(id, values, fallback),
						templateMessage: (text: string) => runtime.templateMessage(text),
						version,
					}
				: null,
		[context?.version, externalVersion, hostMethods, runtime, version]
	);
}

function localizeString(
	i18n: ReturnType<typeof useOptionalI18n>,
	value: string | undefined
): string | undefined {
	if (!i18n || value === undefined || value.trim().length === 0) {
		return value;
	}
	const id = messageIdForLiteral(value);
	// Translate known first-party literals, plus an explicitly published literal
	// id from the selected/base pack. Unknown runtime text (project names,
	// tool output, user content) remains untouched.
	const isCatalogMessage =
		Object.hasOwn(EN_MESSAGES, id) || i18n.hasOverlayMessage(id);
	const isPublishedLiteral = i18n.availablePacks.some((pack) =>
		Object.hasOwn(pack.messages, id)
	);
	if (isCatalogMessage || isPublishedLiteral) {
		return i18n.t(id, {}, value);
	}
	// A dynamic sentence matching a catalog template (`Deleted {name}`)
	// translates around its values, which stay as written.
	return i18n.templateMessage(value) ?? value;
}

export function I18nText({
	id,
	values,
}: {
	id: string;
	values?: MessageValuesInput;
}) {
	const { t } = useI18n();
	return <>{t(id, values)}</>;
}

/** Translate a literal while retaining a string return type for native/DOM
 * attributes such as `placeholder`, `title`, and `aria-label`. */
export function useLocalizedString(
	value: string | undefined
): string | undefined {
	const i18n = useOptionalI18n();
	return localizeString(i18n, value);
}

export function useLocalizedText(
	value: React.ReactNode,
	options: { literal?: boolean } = {}
): React.ReactNode {
	if (!options.literal) {
		return value;
	}
	const i18n = useOptionalI18n();
	if (typeof value === "string") {
		return localizeString(i18n, value);
	}
	if (!Array.isArray(value)) {
		return value;
	}
	return value.map((child) =>
		typeof child === "string" ? localizeString(i18n, child) : child
	);
}
