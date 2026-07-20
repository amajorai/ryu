import { useEffect, useState } from "react";

const KEY = "ryu_dialog_overlay_blur";
const ENABLED_BACKGROUND = "rgb(0 0 0 / 30%)";
const DISABLED_BACKGROUND = "rgb(0 0 0 / 0)";
const ENABLED_BLUR = "8px";
const DISABLED_BLUR = "0px";

function applyOverlayVars(enabled: boolean) {
	const root = document.documentElement;
	root.style.setProperty(
		"--ryu-dialog-overlay-background",
		enabled ? ENABLED_BACKGROUND : DISABLED_BACKGROUND
	);
	root.style.setProperty(
		"--ryu-dialog-overlay-blur",
		enabled ? ENABLED_BLUR : DISABLED_BLUR
	);
	if (enabled) {
		root.setAttribute("data-dialog-overlay-blur", "on");
	} else {
		root.removeAttribute("data-dialog-overlay-blur");
	}
}

export function initDialogOverlayBlur() {
	applyOverlayVars(localStorage.getItem(KEY) === "true");
}

export function useDialogOverlayBlur(): boolean {
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

export function setDialogOverlayBlur(enabled: boolean) {
	localStorage.setItem(KEY, String(enabled));
	applyOverlayVars(enabled);
	window.dispatchEvent(new Event("storage"));
}
