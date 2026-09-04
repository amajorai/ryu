"use client";

import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import {
	I18nRuntime,
	type I18nRuntimeOptions,
	type LanguagePack,
	messageIdForLiteral,
} from "./core.ts";
import { EN_MESSAGES } from "./messages.ts";

interface I18nContextValue {
	runtime: I18nRuntime;
	version: number;
}

const I18nContext = createContext<I18nContextValue | null>(null);
const EMPTY_PACKS: readonly LanguagePack[] = [];
const NOOP_SUBSCRIBE = () => () => undefined;
const ZERO_VERSION = () => 0;

export interface I18nProviderProps extends I18nRuntimeOptions {
	children: React.ReactNode;
	packs?: readonly LanguagePack[];
}

/** Mount the shared locale runtime and keep the document's language/direction current. */
export function I18nProvider({
	children,
	initialLocale,
	initialPackId,
	persistPackId,
	packs = EMPTY_PACKS,
}: I18nProviderProps) {
	const runtime = useRef<I18nRuntime | null>(null);
	if (runtime.current === null) {
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
		runtime.current = new I18nRuntime(packs, options);
	}
	const instance = runtime.current;
	const packSignature = packs
		.map((pack) => `${pack.id}:${pack.version}:${pack.enabled !== false}`)
		.join("|");

	const packsRef = useRef(packs);
	packsRef.current = packs;
	useEffect(() => {
		instance.setPacks(packsRef.current);
	}, [instance, packSignature]);

	const version = useSyncExternalStore(
		instance.subscribe,
		instance.getVersion,
		instance.getVersion
	);

	useEffect(() => {
		if (typeof document === "undefined") {
			return;
		}
		const root = document.documentElement;
		root.lang = instance.locale;
		root.dir = instance.direction;
	}, [instance, version]);

	return (
		<I18nContext.Provider value={{ runtime: instance, version }}>
			{children}
		</I18nContext.Provider>
	);
}

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
			runtime
				? {
						availablePacks: runtime.availablePacks,
						direction: runtime.direction,
						formatDate: runtime.formatDate.bind(runtime),
						formatNumber: runtime.formatNumber.bind(runtime),
						getSnapshot: runtime.getSnapshot,
						locale: runtime.locale,
						selectedPack: runtime.selectedPack,
						selectedPackId: runtime.selectedPackId,
						selectPack: (id: string | null) => runtime.selectPack(id),
						setLocale: (locale: string) => runtime.setLocale(locale),
						snapshot: runtime.getSnapshot(),
						subscribe: runtime.subscribe,
						t: (
							id: string,
							values?: Record<string, unknown>,
							fallback?: string
						) => runtime.translate(id, values, fallback),
						version,
					}
				: null,
		[context?.version, externalVersion, runtime, version]
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
	const isCatalogMessage = Object.hasOwn(EN_MESSAGES, id);
	const isPublishedLiteral = i18n.availablePacks.some((pack) =>
		Object.hasOwn(pack.messages, id)
	);
	return isCatalogMessage || isPublishedLiteral ? i18n.t(id, {}, value) : value;
}

export function I18nText({
	id,
	values,
}: {
	id: string;
	values?: Record<string, unknown>;
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
