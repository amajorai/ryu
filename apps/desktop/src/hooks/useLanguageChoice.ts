import {
	LANGUAGE_PACK_STORAGE_KEY,
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguagePack,
} from "@ryu/i18n";
import {
	findLanguagePackForLocale,
	isEnglishLocale,
	preferredOfficialLocale,
	systemLocales,
} from "@ryu/i18n/core";
import { useI18n } from "@ryu/i18n/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	LANGUAGE_MODE_CHANGED_EVENT,
	LANGUAGE_MODE_KEY,
	useLanguageMode,
} from "@/src/hooks/useLanguageMode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	importLanguagePack,
	setLanguagePackEnabled,
} from "@/src/lib/api/language-packs.ts";
import { cachedOsPreferredLanguages } from "@/src/lib/native-copy.ts";

/** Picker value for plain English (no pack selected). */
export const DEFAULT_PACK_VALUE = "__english__";
/** Picker value for following the system language. */
export const AUTO_DETECT_VALUE = "__auto_detect__";

/** A language shown by its own name, which is never translated. */
export interface LanguageName {
	locale: string;
	name: string;
}

export const ENGLISH_LANGUAGE: LanguageName = { locale: "en", name: "English" };

/**
 * The packs a picker can apply at once, without asking the node to enable
 * anything: translations of another language that are already switched on.
 * English flavor packs are a voice, not a language, and stay in Settings.
 */
export function readyLanguagePacks(
	packs: readonly LanguagePack[]
): LanguagePack[] {
	return packs.filter(
		(pack) => pack.enabled !== false && !isEnglishLocale(pack.locale)
	);
}

/** The language "Auto detect" resolves to for this system language list. */
export function systemLanguageName(
	languages: readonly string[],
	packs: readonly LanguagePack[]
): LanguageName {
	const locale = preferredOfficialLocale(languages, packs);
	const pack = locale ? findLanguagePackForLocale(packs, locale) : null;
	return pack ? { locale: pack.locale, name: pack.name } : ENGLISH_LANGUAGE;
}

/**
 * The app language choice: the option list, the current value and `select`,
 * shared by Settings and the onboarding control so both write the same
 * storage keys. It also owns the pack import, because an import and a
 * selection retire each other's pending work.
 */
export function useLanguageChoice() {
	const node = useActiveNode();
	const { availablePacks, selectedPack, selectPack, setLocale, t } = useI18n();
	const [languageMode, setLanguageMode] = useLanguageMode();
	const [busyId, setBusyId] = useState<string | null>(null);
	const [pendingPack, setPendingPack] = useState<{
		id: string;
		operation: symbol;
	} | null>(null);
	const [operationError, setOperationError] = useState<string | null>(null);
	const operationRef = useRef<symbol | null>(null);
	const packs = useMemo(
		() =>
			availablePacks.filter(
				(pack) => pack.id !== "en-x-ryu-online" || pack.enabled !== false
			),
		[availablePacks]
	);
	const readyPacks = useMemo(() => readyLanguagePacks(packs), [packs]);
	const retireOperation = useCallback(() => {
		operationRef.current = null;
		setPendingPack(null);
		setBusyId(null);
		setOperationError(null);
	}, []);

	useEffect(() => {
		// An operation belongs to one node and credential generation. Returning
		// to an earlier owner must not revive a response from its previous visit.
		retireOperation();
		return () => {
			operationRef.current = null;
		};
	}, [node.url, node.token, node.userJwt, retireOperation]);

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (
				(event.storageArea === null || event.storageArea === localStorage) &&
				(event.key === null ||
					event.key === LANGUAGE_MODE_KEY ||
					event.key === LANGUAGE_PACK_STORAGE_KEY)
			) {
				retireOperation();
			}
		};
		window.addEventListener(LANGUAGE_MODE_CHANGED_EVENT, retireOperation);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(LANGUAGE_MODE_CHANGED_EVENT, retireOperation);
			window.removeEventListener("storage", onStorage);
		};
	}, [retireOperation]);

	const select = useCallback(
		async (value: string | null) => {
			retireOperation();
			if (value === AUTO_DETECT_VALUE) {
				setLanguageMode("auto");
				selectPack(null);
				// The OS list the desktop shell reported (WKWebView's own
				// `navigator.language` is English on a non-English Mac).
				const languages = cachedOsPreferredLanguages() ?? systemLocales();
				setLocale(
					preferredOfficialLocale(languages, availablePacks) ??
						languages[0] ??
						navigator.language
				);
				return;
			}
			const id = value === DEFAULT_PACK_VALUE ? null : value;
			const pack = id ? packs.find((candidate) => candidate.id === id) : null;
			if (pack && pack.enabled === false) {
				const operation = Symbol("language enable");
				operationRef.current = operation;
				setBusyId(pack.id);
				try {
					await setLanguagePackEnabled(toTarget(node), {
						enabled: true,
						id: pack.id,
					});
				} catch (error) {
					if (operationRef.current !== operation) {
						return;
					}
					setOperationError(
						error instanceof Error ? error.message : String(error)
					);
					setBusyId(null);
					operationRef.current = null;
					return;
				}
				if (operationRef.current !== operation) {
					return;
				}
				operationRef.current = null;
				setBusyId(null);
			}
			setLanguageMode("fixed");
			selectPack(id);
		},
		[
			availablePacks,
			node,
			packs,
			retireOperation,
			selectPack,
			setLanguageMode,
			setLocale,
		]
	);

	useEffect(() => {
		if (
			!(
				pendingPack &&
				operationRef.current === pendingPack.operation &&
				availablePacks.some(
					(pack) => pack.id === pendingPack.id && pack.enabled !== false
				)
			)
		) {
			return;
		}
		operationRef.current = null;
		setLanguageMode("fixed");
		selectPack(pendingPack.id);
		setPendingPack(null);
	}, [availablePacks, pendingPack, selectPack, setLanguageMode]);

	const importFile = useCallback(
		async (file: File) => {
			retireOperation();
			const operation = Symbol("language import");
			operationRef.current = operation;
			setBusyId("__import__");
			try {
				const archive = new Uint8Array(await file.arrayBuffer());
				if (operationRef.current !== operation) {
					return;
				}
				const pack = await importLanguagePack(toTarget(node), archive);
				if (operationRef.current !== operation) {
					return;
				}
				setPendingPack({ id: pack.id, operation });
				window.dispatchEvent(
					new CustomEvent<LanguagePack>(LANGUAGE_PACKS_CHANGED_EVENT, {
						detail: pack,
					})
				);
			} catch (error) {
				if (operationRef.current !== operation) {
					return;
				}
				setOperationError(
					error instanceof Error
						? error.message
						: t(
								"language.import_failed",
								undefined,
								"Could not import language pack"
							)
				);
			} finally {
				if (operationRef.current === operation) {
					setBusyId(null);
				}
			}
		},
		[node, retireOperation, t]
	);

	// In auto mode the runtime's own selection is the truth. With a fixed
	// choice, work out what "Auto detect" would switch to.
	const systemLanguage =
		languageMode === "auto"
			? selectedPack
				? { locale: selectedPack.locale, name: selectedPack.name }
				: ENGLISH_LANGUAGE
			: systemLanguageName(
					cachedOsPreferredLanguages() ?? systemLocales(),
					availablePacks
				);

	return {
		/** The pack being enabled, `__import__` during an import, else null. */
		busyId,
		importFile,
		languageMode,
		operationError,
		/** Every pack Settings lists, including ones the node must enable. */
		packs,
		/** The packs that apply at once; see {@link readyLanguagePacks}. */
		readyPacks,
		select,
		selectedPack,
		systemLanguage,
		/** The picker value for the current choice. */
		value:
			languageMode === "auto"
				? AUTO_DETECT_VALUE
				: (selectedPack?.id ?? DEFAULT_PACK_VALUE),
	};
}
