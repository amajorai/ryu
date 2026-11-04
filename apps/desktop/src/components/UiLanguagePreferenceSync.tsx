import { useI18n } from "@ryu/i18n/react";
import { useEffect, useMemo } from "react";
import { useLanguageMode } from "@/src/hooks/useLanguageMode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { fixedPackLoading } from "@/src/lib/ui-language-adopt.ts";
import {
	syncUiLanguagePreference,
	uiLanguagePreference,
} from "@/src/lib/ui-language-preference.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { UiLanguagePreferenceAdopt } from "./UiLanguagePreferenceAdopt.tsx";

/**
 * Mirrors Desktop's language choice (kept in localStorage by
 * `LanguagePackBridge` and `useLanguageMode`) into Core's shared `ui-language`
 * preference so the Island follows it. Render it inside `LanguagePackBridge`.
 * The first sync per node only seeds an unset key; later mode or pack changes
 * are Desktop choices and always write. In auto mode the shown locale rides
 * along, so Core's own messages match the UI instead of re-probing the OS.
 * The key is two-way: `UiLanguagePreferenceAdopt` applies a choice made in the
 * Island, so the last writer wins.
 */
export function UiLanguagePreferenceSync() {
	const node = useNodeStore((state) => state.getActiveNode());
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const [languageMode] = useLanguageMode();
	const { availablePacks, locale, selectedPackId } = useI18n();
	useEffect(() => {
		if (fixedPackLoading(languageMode, selectedPackId, availablePacks)) {
			return;
		}
		void syncUiLanguagePreference(
			target,
			uiLanguagePreference(languageMode, selectedPackId, locale)
		);
	}, [availablePacks, languageMode, locale, selectedPackId, target]);
	return <UiLanguagePreferenceAdopt target={target} />;
}
