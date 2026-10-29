import { useOptionalI18n } from "@ryu/i18n/react";
import { useEffect } from "react";
import { registerNativeCopyTranslator } from "@/src/lib/native-copy.ts";
import { createNativeCopyTranslator } from "@/src/lib/native-copy-translator.ts";

/**
 * Keeps the native-copy translator in step with the active locale and the
 * bot vocabulary. The i18n value changes identity on every locale or pack
 * change, so the translator is re-registered then. Only known first-party
 * literals are translated or swapped; runtime text passes through unchanged.
 */
export function NativeCopyLocalizer({
	botTerminology,
}: {
	botTerminology: boolean;
}) {
	const i18n = useOptionalI18n();
	useEffect(() => {
		if (!(i18n || botTerminology)) {
			return;
		}
		return registerNativeCopyTranslator(
			createNativeCopyTranslator(i18n, botTerminology)
		);
	}, [botTerminology, i18n]);
	return null;
}
