/** Default inactivity window for unmounting background tab trees. */
export const DEFAULT_TAB_UNLOAD_MINUTES = 10;

/** Shared localStorage key for the tab-memory preference. */
export const TAB_UNLOAD_MINUTES_KEY = "ryu_tab_unload_minutes";

/** How often the tab owner checks whether an inactive tree can be unmounted. */
export const TAB_UNLOAD_INTERVAL_MS = 30_000;

export interface TabMemoryCandidate {
	busy?: boolean;
	id: string;
	pinned?: boolean;
	splitId?: string;
	unloaded?: boolean;
}

/** Give every tab known at startup a safe baseline for inactivity accounting. */
export function initialTabActivity(
	tabs: readonly Pick<TabMemoryCandidate, "id">[],
	now: number
): Record<string, number> {
	return Object.fromEntries(tabs.map((tab) => [tab.id, now]));
}

/**
 * Select tab trees that can be unmounted without changing user-visible state.
 * The transcript remains in Core's durable conversation store; this only drops
 * the mounted route tree that holds message parts, providers, and subscriptions.
 */
export function inactiveTabIds(
	tabs: readonly TabMemoryCandidate[],
	activeTabId: string,
	lastActiveAt: Readonly<Record<string, number>>,
	now: number,
	idleMinutes: number
): string[] {
	if (
		!(Number.isFinite(now) && Number.isFinite(idleMinutes)) ||
		idleMinutes <= 0
	) {
		return [];
	}

	const activeSplitId = tabs.find((tab) => tab.id === activeTabId)?.splitId;
	const protectedIds = new Set(
		activeSplitId
			? tabs.filter((tab) => tab.splitId === activeSplitId).map((tab) => tab.id)
			: []
	);
	const cutoff = now - idleMinutes * 60_000;

	return tabs
		.filter((tab) => {
			if (
				tab.id === activeTabId ||
				tab.pinned ||
				tab.busy ||
				tab.unloaded ||
				protectedIds.has(tab.id)
			) {
				return false;
			}
			const lastActive = lastActiveAt[tab.id];
			return lastActive !== undefined && lastActive < cutoff;
		})
		.map((tab) => tab.id);
}
