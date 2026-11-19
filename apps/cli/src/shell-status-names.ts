// The names the shell's status bar shows for the product mode and the focused
// region. The bar's `left` and `leftSuffix` are not copy props the JSX runtime
// translates, so each name is translated here as a whole word.

import type { WorkbenchRegion } from "@ryu/workbench/model";
import type { ProductMode } from "./core/productMode.ts";
import { tr } from "./i18n/translate.ts";

/** A product mode's display name (the stored values stay "bot" / "console" / "os"). */
export function productModeName(mode: ProductMode): string {
	switch (mode) {
		case "bot":
			return tr("Bot");
		case "console":
			return tr("Agent");
		default:
			return "OS";
	}
}

/** The status bar's left text: the mode's name in capitals, then the node URL. */
export function shellStatusLeft(mode: ProductMode, url: string): string {
	return `${productModeName(mode).toUpperCase()} · ${url}`;
}

/** The focused region's name, or undefined for Center, which goes unnamed. */
export function focusedRegionName(region: WorkbenchRegion): string | undefined {
	switch (region) {
		case "bottom":
			return tr("Bottom");
		case "left":
			return tr("Left");
		case "right":
			return tr("Right");
		default:
			return;
	}
}
