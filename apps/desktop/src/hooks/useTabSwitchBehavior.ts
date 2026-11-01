import { useEffect, useState } from "react";
import { announceLocalStorageChange } from "@/src/lib/same-document-storage-event.ts";

/** How Ctrl/Cmd+Tab cycles open window tabs: visual left-to-right order
    (default, browser-style) or most-recently-active order (VS Code / Chrome
    MRU). Window-local + reactive across settings and the cycle hotkey via the
    same localStorage + `storage`-event pattern as the other tab prefs. */
export type TabSwitchBehavior = "sequential" | "recent";

const KEY = "ryu_tab_switch_behavior";

/** Read the preference synchronously. Exported so the cycle hotkey can consult
    it fresh on each keypress without subscribing. */
export function readTabSwitchBehavior(): TabSwitchBehavior {
	return localStorage.getItem(KEY) === "recent" ? "recent" : "sequential";
}

export function useTabSwitchBehavior(): TabSwitchBehavior {
	const [behavior, setBehavior] = useState<TabSwitchBehavior>(
		readTabSwitchBehavior
	);

	useEffect(() => {
		const handler = () => setBehavior(readTabSwitchBehavior());
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return behavior;
}

export function setTabSwitchBehavior(behavior: TabSwitchBehavior) {
	localStorage.setItem(KEY, behavior);
	// Same-document listeners don't get the native `storage` event, so broadcast
	// one ourselves — every useTabSwitchBehavior() consumer re-reads on this.
	announceLocalStorageChange(KEY);
}
