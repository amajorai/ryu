// Copy a value to the clipboard and say how it went in a toast. The toast
// titles go through the caller's `tl`, so they render in the active locale
// whether or not the DOM localizer is running.

import type { LiteralMessage } from "@ryu/i18n/react";
import { sileo } from "sileo";

/** Copies `text`, toasts the outcome, and reports whether the copy worked. */
export async function copyWithToast(
	text: string,
	tl: LiteralMessage
): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		sileo.success({ title: tl("Copied") });
		return true;
	} catch {
		sileo.error({ title: tl("Could not copy") });
		return false;
	}
}
