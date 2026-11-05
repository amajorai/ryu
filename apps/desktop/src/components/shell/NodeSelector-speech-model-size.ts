// The Speech Processing model's download size in the node menu, in the
// viewer's number format and unit ("484 MB", "484 Mo", "484 МБ").

import { activeLocale } from "@ryu/i18n/core";
import { formatByteSize } from "@ryu/i18n/format-intl";

/** Every bundled Speech Processing model downloads about this much. */
const SPEECH_MODEL_BYTES = 484 * 1024 ** 2;

/** "<model> · 484 MB": the menu detail line for one engine's model. */
export function speechModelDetail(
	model: string,
	locale: string = activeLocale()
): string {
	const size = formatByteSize(SPEECH_MODEL_BYTES, locale, {
		fractionDigits: 0,
	});
	return `${model} · ${size}`;
}
