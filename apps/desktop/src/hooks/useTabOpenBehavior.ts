import { useEffect, useState } from "react";

/** Where sidebar / palette navigation lands: a fresh tab (default, Chrome-style)
    or the currently focused tab (a browser's "open in current tab"). Window-local
    + reactive across the sidebar, settings, and TabsContext via the same
    localStorage + `storage`-event pattern as the other desktop UI prefs
    (see `useTabLayout`). */
export type TabOpenBehavior = "new" | "current";

const KEY = "ryu_tab_open_behavior";

/** Read the preference synchronously. Exported so non-hook call sites (e.g.
    `openTab` in TabsContext) can consult it fresh on each navigation without
    subscribing. */
export function readTabOpenBehavior(): TabOpenBehavior {
	return localStorage.getItem(KEY) === "current" ? "current" : "new";
}

export function useTabOpenBehavior(): TabOpenBehavior {
	const [behavior, setBehavior] =
		useState<TabOpenBehavior>(readTabOpenBehavior);

	useEffect(() => {
		const handler = () => setBehavior(readTabOpenBehavior());
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return behavior;
}

export function setTabOpenBehavior(behavior: TabOpenBehavior) {
	localStorage.setItem(KEY, behavior);
	// Same-document listeners don't get the native `storage` event, so broadcast
	// one ourselves — every useTabOpenBehavior() consumer re-reads on this.
	window.dispatchEvent(new Event("storage"));
}
