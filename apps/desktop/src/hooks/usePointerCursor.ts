import { useEffect, useState } from "react";

const KEY = "ryu_pointer_cursor";

function applyDataAttribute(enabled: boolean) {
	if (enabled) {
		document.documentElement.setAttribute("data-pointer-cursor", "true");
	} else {
		document.documentElement.removeAttribute("data-pointer-cursor");
	}
}

export function initPointerCursor() {
	applyDataAttribute(localStorage.getItem(KEY) === "true");
}

export function usePointerCursor(): boolean {
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

export function setPointerCursor(enabled: boolean) {
	localStorage.setItem(KEY, String(enabled));
	applyDataAttribute(enabled);
	window.dispatchEvent(new Event("storage"));
}
