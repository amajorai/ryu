import { type RefObject, useEffect, useState } from "react";

/**
 * Shared guard for the interface renderers' document-level shortcuts.
 *
 * Renderers listen on `document` or `window` so their keys keep working after
 * focus falls back to `body` (a click on empty space). The desktop host keeps
 * the active interface mounted under a page it opens over it (Settings, the
 * Marketplace, an app) and marks the interface `inert` while that page shows.
 * A covered interface must not act on keys meant for the page on top: it
 * would scroll or open things the user cannot see.
 *
 * Pass the renderer's outermost element. Renderers that make part of their
 * own tree inert (behind an open panel) do so below that element, so only the
 * host's cover counts here.
 */
export function isInterfaceCovered(root: Element | null): boolean {
	return Boolean(root?.closest("[inert]"));
}

/**
 * Whether the host covers the interface under `rootRef`, kept current as the
 * host toggles `inert` (a page opens over it or closes). A renderer that
 * draws every frame pauses while this is true: the cover is neither off
 * screen nor a hidden tab, so nothing else stops its loop.
 */
export function useInterfaceCovered(
	rootRef: RefObject<Element | null>
): boolean {
	const [covered, setCovered] = useState(false);
	useEffect(() => {
		const root = rootRef.current;
		if (!root || typeof MutationObserver === "undefined") {
			return;
		}
		const update = () => setCovered(isInterfaceCovered(root));
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.body, {
			attributeFilter: ["inert"],
			attributes: true,
			subtree: true,
		});
		return () => observer.disconnect();
	}, [rootRef]);
	return covered;
}

/** The talk keys: next to an asker they open its ask card. */
const ASK_KEYS = new Set(["e", "enter", " "]);

/**
 * Whether `event` is a talk key (E, Enter, Space) for the world's ask card:
 * not with a modifier held (those are shortcuts), and not when the focused
 * element inside the world needs the key itself (text fields, and Enter/Space
 * on a button or link, which activate it natively).
 */
export function isAskKey(event: {
	altKey: boolean;
	ctrlKey: boolean;
	currentTarget: EventTarget;
	key: string;
	metaKey: boolean;
	target: EventTarget;
}): boolean {
	if (event.metaKey || event.ctrlKey || event.altKey) {
		return false;
	}
	if (!ASK_KEYS.has(event.key.toLowerCase())) {
		return false;
	}
	const { target } = event;
	if (target === event.currentTarget || !(target instanceof HTMLElement)) {
		return true;
	}
	if (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	) {
		return false;
	}
	return !(
		event.key !== "e" &&
		event.key !== "E" &&
		(target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement)
	);
}
