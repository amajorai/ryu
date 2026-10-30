import { useCallback, useSyncExternalStore } from "react";

/**
 * How sidebars sit against the main content.
 *
 * - "inset": the default — sidebars sit flush with the window (no card chrome)
 *   and the content area is set off by tone alone (Layout drops the primitive's
 *   inset card margin, radius and shadow).
 * - "floating": opt-in — sidebars are rounded, bordered cards that float over
 *   the window, and the main content fills the rest flush.
 *
 * The left rail maps this onto the shadcn `<Sidebar variant>` prop;
 * `<SidebarInset>` already carries the matching `peer-data-[variant=inset]`
 * styles. Workspace right/bottom docks and the docked Ask Ryu panel reuse the
 * same preference via {@link sidebarFloatingChrome} so they invert in lockstep.
 */
export type SidebarVariant = "floating" | "inset";

/**
 * Card chrome matching shadcn's `group-data-[variant=floating]` sidebar-inner
 * treatment (`rounded-3xl` tracks the Appearance roundness token). Apply only
 * when the variant is `"floating"`; inset mode is flush. In-flow surfaces carry
 * no shadow: a hairline and the sidebar tone separate the card.
 */
export const sidebarFloatingChrome = "rounded-3xl border border-border";

export const SIDEBAR_VARIANT_KEY = "ryu:sidebar-variant";
export const DEFAULT_SIDEBAR_VARIANT: SidebarVariant = "inset";

const listeners = new Set<() => void>();

function read(): SidebarVariant {
	try {
		// A stored "floating" opt-in is kept; anything else is the flush default.
		return localStorage.getItem(SIDEBAR_VARIANT_KEY) === "floating"
			? "floating"
			: "inset";
	} catch {
		return DEFAULT_SIDEBAR_VARIANT;
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === SIDEBAR_VARIANT_KEY) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

/** Write the sidebar variant and notify every consumer. */
export function setSidebarVariant(next: SidebarVariant): void {
	try {
		localStorage.setItem(SIDEBAR_VARIANT_KEY, next);
	} catch {
		// best-effort
	}
	for (const cb of listeners) {
		cb();
	}
}

/**
 * Read + set the sidebar variant. Persists to localStorage and broadcasts to
 * every mounted instance (other windows via the `storage` event, same-window
 * subscribers via the listener set), mirroring useSidebarMode.
 */
export function useSidebarVariant(): [
	SidebarVariant,
	(variant: SidebarVariant) => void,
] {
	const variant = useSyncExternalStore(
		subscribe,
		read,
		() => DEFAULT_SIDEBAR_VARIANT
	);

	const setVariant = useCallback((next: SidebarVariant) => {
		setSidebarVariant(next);
	}, []);

	return [variant, setVariant];
}
