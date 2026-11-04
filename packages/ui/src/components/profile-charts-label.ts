import type { LiteralMessage } from "@ryu/i18n/react";
import { formatCount as formatSharedCount } from "@ryu/ui/lib/number-format.ts";

/**
 * The hover title of a profile chart segment or bar ("Chat: 3"), as one
 * translated message with the series name translated first. A raw
 * `${name}: ${count}` template left most series in English: only names that
 * happened to match another catalog template were localized.
 */
export function chartEntryTitle(
	tl: LiteralMessage,
	name: string,
	value: number,
	formatCount: (value: number) => string = (count) =>
		formatSharedCount(count) ?? "—"
): string {
	return tl("{feature}: {count}", {
		count: formatCount(value),
		feature: tl(name),
	});
}
