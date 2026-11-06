import { formatMessage, messageIdForLiteral } from "@ryu/i18n/core";
import { useOptionalI18n } from "@ryu/i18n/react";
import { useEffect } from "react";
import { useLanguageMode } from "@/src/hooks/useLanguageMode.ts";
import {
	buildNativeShellCopy,
	type NativeShellTranslate,
	pushNativeShellCopy,
	registerNativeCopyTranslator,
} from "@/src/lib/native-copy.ts";
import { createNativeCopyTranslator } from "@/src/lib/native-copy-translator.ts";

/**
 * Keeps the native-copy translator in step with the active locale and the
 * bot vocabulary. The i18n value changes identity on every locale or pack
 * change, so the translator is re-registered then. Only known first-party
 * literals are translated or swapped; runtime text passes through unchanged.
 *
 * It also hands the Tauri shell its tray labels, quit and update
 * confirmations and macOS app menu in the same language, with the language
 * mode so macOS can keep an explicit choice for the chrome AppKit draws. Until
 * that first hand-off the shell shows English.
 */
export function NativeCopyLocalizer({
	botTerminology,
}: {
	botTerminology: boolean;
}) {
	const i18n = useOptionalI18n();
	const [languageMode] = useLanguageMode();
	useEffect(() => {
		if (!(i18n || botTerminology)) {
			return;
		}
		return registerNativeCopyTranslator(
			createNativeCopyTranslator(i18n, botTerminology)
		);
	}, [botTerminology, i18n]);
	useEffect(() => {
		if (!i18n) {
			return;
		}
		// `tl()` semantics: the catalog sentence, else the English source
		// formatted with its values. Unchanged copy is never sent twice.
		const tl: NativeShellTranslate = (source, values = {}) => {
			const translated = i18n.t(messageIdForLiteral(source), values, source);
			return translated === source
				? formatMessage(source, values, i18n.locale)
				: translated;
		};
		const tid = (id: string, source: string) => i18n.t(id, {}, source);
		void pushNativeShellCopy({
			...buildNativeShellCopy(tl, i18n.locale, tid),
			languageMode,
		});
	}, [i18n, languageMode]);
	return null;
}
