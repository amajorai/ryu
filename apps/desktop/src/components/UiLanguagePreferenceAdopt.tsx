import { useI18n } from "@ryu/i18n/react";
import { useEffect, useRef, useState } from "react";
import { useLanguageMode } from "@/src/hooks/useLanguageMode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AdoptedUiLanguage,
	adoptionStillCurrent,
	readAdoptableUiLanguage,
} from "@/src/lib/ui-language-adopt.ts";
import {
	beginUiLanguageAdoption,
	uiLanguagePreference,
} from "@/src/lib/ui-language-preference.ts";

/**
 * Adopts a language chosen in the Island. On node connect and whenever the
 * window regains focus, it reads Core's shared `ui-language` preference; a
 * fixed choice Desktop did not write itself is applied through the same
 * setters Settings uses (`setLanguageMode` and `selectPack`, which persists
 * `LANGUAGE_PACK_STORAGE_KEY`), so the locale and direction switch in place
 * without remounting the app. Syncs are held until Desktop shows the adopted
 * value, so `UiLanguagePreferenceSync` never writes the previous choice (or
 * the adopted one) back. Render it inside
 * `LanguagePackBridge`.
 */
export function UiLanguagePreferenceAdopt({ target }: { target: ApiTarget }) {
	const { availablePacks, selectedPackId, selectPack } = useI18n();
	const [languageMode, setLanguageMode] = useLanguageMode();
	const [pending, setPending] = useState<AdoptedUiLanguage | null>(null);
	const current = useRef(uiLanguagePreference(languageMode, selectedPackId));
	current.current = uiLanguagePreference(languageMode, selectedPackId);

	useEffect(() => {
		let cancelled = false;
		const check = () => {
			void readAdoptableUiLanguage(target, () => current.current).then(
				(adopted) => {
					if (!cancelled && adopted) {
						setPending(adopted);
					}
				}
			);
		};
		const onVisibility = () => {
			if (document.visibilityState === "visible") {
				check();
			}
		};
		check();
		window.addEventListener("focus", check);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			cancelled = true;
			window.removeEventListener("focus", check);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [target]);

	useEffect(() => {
		if (!pending) {
			return;
		}
		const { packId } = pending;
		// A pack the runtime does not hold yet is applied once the catalog loads.
		if (packId !== null && !availablePacks.some((pack) => pack.id === packId)) {
			return;
		}
		setPending(null);
		if (!adoptionStillCurrent(target, pending)) {
			return;
		}
		beginUiLanguageAdoption(target, uiLanguagePreference("fixed", packId));
		setLanguageMode("fixed");
		selectPack(packId);
	}, [availablePacks, pending, selectPack, setLanguageMode, target]);

	return null;
}
