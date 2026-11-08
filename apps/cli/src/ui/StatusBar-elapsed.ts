// The live busy timer shared by the shell StatusBar and the chat StatusLine.
// It uses the same locale-aware narrow units as turn receipts and tool
// durations (`12s`, `2m 5s`, `12 Sek.`, `2 Min., 5 Sek.`), so a turn's ticking
// clock and its receipt read alike, and it rolls over into minutes.

import { formatCliElapsed } from "../i18n/format.ts";
import { CLI_FORMAT_LOCALE } from "../i18n/translate.ts";

/** Whole elapsed seconds as the status-row timer text. */
export function busyElapsedLabel(
	elapsedSeconds: number,
	locale: string = CLI_FORMAT_LOCALE
): string {
	return formatCliElapsed(elapsedSeconds * 1000, { trimZeros: true }, locale);
}
