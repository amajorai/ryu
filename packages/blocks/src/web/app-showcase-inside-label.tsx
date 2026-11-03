"use client";

import { useLiteralMessages } from "@ryu/i18n/react";

/**
 * "Inside {app}", the caption above an app's feature list. One whole message
 * so a translation can place the name; the caption's CSS uppercases it, so
 * the source string and the app name stay in their normal case.
 */
export function InsideAppLabel({ app }: { app: string }) {
	const tl = useLiteralMessages();
	return tl("Inside {app}", { app });
}
