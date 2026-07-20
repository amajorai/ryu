import { useEffect, useState } from "react";

/** Tab sizing preference for the horizontal title-bar strip.
    - `fit`: Chrome-style — tabs share the available width equally, shrinking as
      more open (capped at a max, floored at an icon) and only scrolling in the
      extreme case.
    - `fixed`: each tab keeps a fixed width and the strip scrolls once they
      overflow (wheel over the strip / trackpad swipe).
    Window-local + reactive across the TitleBar, settings, and context menus via
    the same localStorage + `storage`-event pattern as the other desktop UI
    prefs. */
export type TabSizing = "fit" | "fixed";

const KEY = "ryu_tab_sizing";

function read(): TabSizing {
	return localStorage.getItem(KEY) === "fixed" ? "fixed" : "fit";
}

export function useTabSizing(): TabSizing {
	const [sizing, setSizing] = useState<TabSizing>(read);

	useEffect(() => {
		const handler = () => setSizing(read());
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return sizing;
}

export function setTabSizing(sizing: TabSizing) {
	localStorage.setItem(KEY, sizing);
	// Same-document listeners don't get the native `storage` event, so broadcast
	// one ourselves — every useTabSizing() consumer re-reads on this.
	window.dispatchEvent(new Event("storage"));
}
