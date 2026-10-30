// Per-viewer collapse state for the "All computers" sidebar groups.

/** Per-viewer collapse state: the names of collapsed computer groups. */
export const COMPUTERS_COLLAPSED_KEY = "ryu:sidebar-computers-collapsed";

export function readCollapsed(): Set<string> {
	try {
		const raw = localStorage.getItem(COMPUTERS_COLLAPSED_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return new Set(
			Array.isArray(parsed)
				? parsed.filter((name): name is string => typeof name === "string")
				: []
		);
	} catch {
		return new Set();
	}
}

export function writeCollapsed(collapsed: ReadonlySet<string>): void {
	try {
		localStorage.setItem(
			COMPUTERS_COLLAPSED_KEY,
			JSON.stringify([...collapsed])
		);
	} catch {
		// Collapse state is a convenience; an unavailable store just forgets it.
	}
}
