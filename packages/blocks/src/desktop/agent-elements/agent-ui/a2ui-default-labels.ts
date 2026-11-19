import type { LiteralMessage } from "@ryu/i18n/react";

/** The English label `normalizeA2ui` (`a2ui.ts`) gives a DateTimeInput that
    arrives without one. That module only builds data, so the label is
    translated here, when the input renders. */
export const A2UI_DATE_TIME_LABEL = "Date and time";

/** An input's label in the UI language when it is the A2UI default. */
export function localizeA2uiDefaultLabel(
	label: string | undefined,
	tl: LiteralMessage
): string | undefined {
	return label === A2UI_DATE_TIME_LABEL ? tl("Date and time") : label;
}
