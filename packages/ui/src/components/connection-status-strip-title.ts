"use client";

import { type RefObject, useLayoutEffect } from "react";

/**
 * Keeps an element's `title` equal to the text it shows, so a truncated
 * status sentence reads in full on hover in the active language.
 *
 * The tooltip is read from the rendered text rather than composed from props:
 * a strip's parts may be translated in place by the DOM localizer after React
 * commits, and joining English props would leave the hover text in English.
 * A `MutationObserver` follows those later rewrites.
 */
export function useTitleFromText(ref: RefObject<HTMLElement | null>): void {
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const sync = () => {
			const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
			if (!text) {
				element.removeAttribute("title");
				return;
			}
			if (element.getAttribute("title") !== text) {
				element.setAttribute("title", text);
			}
		};
		sync();
		if (typeof MutationObserver === "undefined") {
			return;
		}
		const observer = new MutationObserver(sync);
		observer.observe(element, {
			characterData: true,
			childList: true,
			subtree: true,
		});
		return () => observer.disconnect();
	});
}
