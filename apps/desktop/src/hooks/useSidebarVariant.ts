import { useCallback, useSyncExternalStore } from "react";

/**
 * How sidebars sit against the main content.
 *
 * - "floating": the default — sidebars are rounded, bordered cards that float
 *   over the window, and the main content fills the rest flush.
 * - "inset": sidebars sit flush (no card chrome) and the main content is pulled
 *   in as its own rounded, shadowed card (an "inset" canvas).
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
 * when the variant is `"floating"`; inset mode is flush. The drop shadow is
 * marked `ryu-chrome-shadow`, so the Appearance "Chrome shadows" toggle strips it.
 */
export const sidebarFloatingChrome =
	"ryu-chrome-shadow inset-shadow-sm rounded-3xl border border-background drop-shadow-2xl";

export const SIDEBAR_VARIANT_KEY = "ryu:sidebar-variant";
export const DEFAULT_SIDEBAR_VARIANT: SidebarVariant = "floating";

const listeners = new Set<() => void>();

/** The stored sidebar variant, falling back to the floating default. */
export function readSidebarVariant(): SidebarVariant {
	try {
		// A stored "inset" choice is kept; anything else is the floating default.
		return localStorage.getItem(SIDEBAR_VARIANT_KEY) === "inset"
			? "inset"
			: "floating";
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
		readSidebarVariant,
		() => DEFAULT_SIDEBAR_VARIANT
	);

	const setVariant = useCallback((next: SidebarVariant) => {
		setSidebarVariant(next);
	}, []);

	return [variant, setVariant];
}
