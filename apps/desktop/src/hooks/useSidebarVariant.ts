import { useCallback, useSyncExternalStore } from "react";

/**
 * How the left sidebar sits against the main content.
 *
 * - "floating": the default — the sidebar is a rounded, bordered card that
 *   floats over the window, and the main content fills the rest flush.
 * - "inset": the sidebar sits flush to the window edge and the main content is
 *   pulled in as its own rounded, shadowed card (an "inset" canvas).
 *
 * Both map directly onto the shadcn `<Sidebar variant>` prop, so flipping this
 * value is all that's needed — `<SidebarInset>` already carries the matching
 * `peer-data-[variant=inset]` styles.
 */
export type SidebarVariant = "floating" | "inset";

const STORAGE_KEY = "ryu:sidebar-variant";
const DEFAULT_VARIANT: SidebarVariant = "floating";

const listeners = new Set<() => void>();

function read(): SidebarVariant {
	try {
		return localStorage.getItem(STORAGE_KEY) === "inset" ? "inset" : "floating";
	} catch {
		return DEFAULT_VARIANT;
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === STORAGE_KEY) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
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
	const variant = useSyncExternalStore(subscribe, read, () => DEFAULT_VARIANT);

	const setVariant = useCallback((next: SidebarVariant) => {
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// best-effort
		}
		for (const cb of listeners) {
			cb();
		}
	}, []);

	return [variant, setVariant];
}
