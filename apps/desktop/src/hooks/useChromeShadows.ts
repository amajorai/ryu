import { THEME_APPEARANCE_CHANGE_EVENT } from "@ryu/ui/theme/prefs.ts";
import { useEffect, useState } from "react";

// Controls the drop/box shadows on the titlebar navigation + custom action
// groups and the floating sidebar. Default OFF (separation comes from tone, not
// shadow); the Appearance setting can turn them on, and a stored opt-in is
// kept. We mark those elements with the `ryu-chrome-shadow` class and gate
// the shadow via a documentElement data attribute styled in index.css, so the
// toggle is a single attribute flip with no React re-render of the chrome.
const KEY = "ryu_chrome_shadows";

function applyDataAttribute(enabled: boolean) {
	if (enabled) {
		document.documentElement.removeAttribute("data-chrome-shadows");
	} else {
		document.documentElement.setAttribute("data-chrome-shadows", "off");
	}
}

export function initChromeShadows() {
	applyDataAttribute(localStorage.getItem(KEY) === "true");
}

export function useChromeShadows(): boolean {
	const [enabled, setEnabled] = useState(
		() => localStorage.getItem(KEY) === "true"
	);

	useEffect(() => {
		const handler = () => {
			setEnabled(localStorage.getItem(KEY) === "true");
		};
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return enabled;
}

export function setChromeShadows(enabled: boolean) {
	localStorage.setItem(KEY, String(enabled));
	applyDataAttribute(enabled);
	window.dispatchEvent(new Event("storage"));
	window.dispatchEvent(new Event(THEME_APPEARANCE_CHANGE_EVENT));
}
