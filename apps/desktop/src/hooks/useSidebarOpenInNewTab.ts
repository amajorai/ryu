import { useEffect, useState } from "react";

/** Whether clicking a page in the left sidebar opens it in a NEW tab (on) or
    reuses the current tab, navigating it in place (off — the standard
    single-view behavior). Default OFF. Window-local + reactive across the
    sidebar and settings via the same localStorage + `storage`-event pattern as
    the other desktop UI prefs (see useTabLayout). */
const KEY = "ryu_sidebar_open_in_new_tab";

export function readSidebarOpenInNewTab(): boolean {
	return localStorage.getItem(KEY) === "true";
}

export function useSidebarOpenInNewTab(): boolean {
	const [openInNewTab, setOpenInNewTab] = useState<boolean>(
		readSidebarOpenInNewTab
	);

	useEffect(() => {
		const handler = () => setOpenInNewTab(readSidebarOpenInNewTab());
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return openInNewTab;
}

export function setSidebarOpenInNewTab(openInNewTab: boolean) {
	localStorage.setItem(KEY, openInNewTab ? "true" : "false");
	// Same-document listeners don't get the native `storage` event, so broadcast
	// one ourselves — every useSidebarOpenInNewTab() consumer re-reads on this.
	window.dispatchEvent(new Event("storage"));
}
