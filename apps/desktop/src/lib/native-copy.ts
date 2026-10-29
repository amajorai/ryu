// apps/desktop/src/lib/native-copy.ts
//
// Copy handed to native APIs (OS notifications, file-dialog titles and filter
// names) never reaches the DOM, so the DOM localizer cannot translate it.
// `NativeCopyLocalizer` registers the active translator here; senders call
// `localizeNativeCopy` right before the native call. Without a registered
// translator (tests, early startup) the English source passes through.

export type NativeCopyTranslator = (text: string) => string;

let activeTranslator: NativeCopyTranslator | null = null;

/** Register the translator; returns a disposer that only clears its own. */
export function registerNativeCopyTranslator(
	translator: NativeCopyTranslator
): () => void {
	activeTranslator = translator;
	return () => {
		if (activeTranslator === translator) {
			activeTranslator = null;
		}
	};
}

/** Translate a known UI literal for a native surface; other text is unchanged. */
export function localizeNativeCopy(text: string): string;
export function localizeNativeCopy(
	text: string | null | undefined
): string | null | undefined;
export function localizeNativeCopy(
	text: string | null | undefined
): string | null | undefined {
	if (!(text && activeTranslator)) {
		return text;
	}
	try {
		return activeTranslator(text);
	} catch {
		return text;
	}
}
