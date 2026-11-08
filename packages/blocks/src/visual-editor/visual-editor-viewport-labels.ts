import type { MessageValuesInput } from "@ryu/i18n/core";
import type { Viewport } from "./visual-editor-config.ts";

/** Translator shape: `useLiteralMessages()` in React. */
export type ViewportLiteral = (
	source: string,
	values?: MessageValuesInput
) => string;

/**
 * The visual editor's canvas-width toggle labels. Each label is a literal
 * `tl()` call so the extractor puts it in the Sites and App Studio catalogs.
 * The sense is the device viewport (canvas width), not the Ryu Desktop or
 * Mobile product names.
 */
export function viewportLabel(item: Viewport, tl: ViewportLiteral): string {
	switch (item) {
		case "desktop":
			return tl("Desktop");
		case "tablet":
			return tl("Tablet");
		case "mobile":
			return tl("Mobile");
		default:
			return item;
	}
}
