// apps/desktop/src/lib/picker-favorites.ts
//
// Local "Recents" + "Pinned" for the composer's model/agent picker. Same
// localStorage-map pattern as `acp-selections.ts`: these are personal, sticky UI
// hints, not agent-owned state and not synced to Core. A "target" is one of:
//   - an agent  (`agent:<id>` — covers Auto, the Ryu agent, and external agents)
//   - a model   (`pm:<providerId>:<modelId>` — a provider + model pick)
// Both Recents and Pinned store these ref-keys; the picker resolves each back to a
// live row (label / logo / apply handler) at render, dropping refs that no longer
// resolve (an uninstalled agent, a vanished model).
//
// `recordRecent` is called from the composer's agent-select seam and the picker
// resolves these refs back to live catalog rows. Refs that no longer resolve
// (an uninstalled agent or removed model) are dropped at render time.

const RECENTS_KEY = "ryu_picker_recents";
const PINS_KEY = "ryu_picker_pins";
/** Shared with the Settings control (via `usePersistedNumber`). */
export const RECENTS_LIMIT_KEY = "ryu_picker_recents_limit";

/** How many recents are kept in storage (the display limit is applied on top). */
const RECENTS_STORE_CAP = 20;
/** Default number of recents shown; user-configurable in Settings. */
export const DEFAULT_RECENTS_LIMIT = 5;

/** A picker target: an agent, or a provider+model pair. */
export type PickerRef =
	| { kind: "agent"; agentId: string }
	| { effort?: string; kind: "model"; providerId: string; modelId: string };

/** Serialize a ref to its stable storage key. */
export function refKey(ref: PickerRef): string {
	return ref.kind === "agent"
		? `agent:${ref.agentId}`
		: `pm:${ref.providerId}:${ref.modelId}`;
}

/** Parse a storage key back into a ref, or null if malformed. */
export function parseRefKey(key: string): PickerRef | null {
	if (key.startsWith("agent:")) {
		const agentId = key.slice("agent:".length);
		return agentId ? { kind: "agent", agentId } : null;
	}
	if (key.startsWith("pm:")) {
		const rest = key.slice("pm:".length);
		const sep = rest.indexOf(":");
		if (sep <= 0) {
			return null;
		}
		const providerId = rest.slice(0, sep);
		const modelId = rest.slice(sep + 1);
		return providerId && modelId
			? { kind: "model", providerId, modelId }
			: null;
	}
	return null;
}

function readList(key: string): string[] {
	try {
		const raw = localStorage.getItem(key);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed)
			? parsed.filter((v): v is string => typeof v === "string")
			: [];
	} catch {
		return [];
	}
}

function writeList(key: string, list: string[]): void {
	try {
		localStorage.setItem(key, JSON.stringify(list));
	} catch {
		// Storage unavailable — favorites simply won't persist this session.
	}
}

/** The recents ref-keys, most-recent first. */
export function getRecents(): string[] {
	return readList(RECENTS_KEY);
}

/** The pinned ref-keys, in pin order. */
export function getPins(): string[] {
	return readList(PINS_KEY);
}

/** Record a target as just-used: dedup, move to front, cap the stored list. */
export function recordRecent(ref: PickerRef): void {
	const key = refKey(ref);
	const next = [key, ...readList(RECENTS_KEY).filter((k) => k !== key)].slice(
		0,
		RECENTS_STORE_CAP
	);
	writeList(RECENTS_KEY, next);
}

/** Remove one target from the recent list without affecting pinned targets. */
export function removeRecent(ref: PickerRef): void {
	writeList(
		RECENTS_KEY,
		readList(RECENTS_KEY).filter((key) => key !== refKey(ref))
	);
}

/** True when a target is pinned. */
export function isPinned(ref: PickerRef): boolean {
	return getPins().includes(refKey(ref));
}

/** Toggle a target's pinned state; returns the new pin list. */
export function togglePin(ref: PickerRef): string[] {
	const key = refKey(ref);
	const pins = getPins();
	const next = pins.includes(key)
		? pins.filter((k) => k !== key)
		: [...pins, key];
	writeList(PINS_KEY, next);
	return next;
}

/** How many recents to show (user setting, clamped to a sane range). */
export function getRecentsLimit(): number {
	try {
		const raw = localStorage.getItem(RECENTS_LIMIT_KEY);
		const n = raw ? Number.parseInt(raw, 10) : DEFAULT_RECENTS_LIMIT;
		if (!Number.isFinite(n)) {
			return DEFAULT_RECENTS_LIMIT;
		}
		return Math.min(20, Math.max(0, n));
	} catch {
		return DEFAULT_RECENTS_LIMIT;
	}
}

export function setRecentsLimit(limit: number): void {
	try {
		localStorage.setItem(
			RECENTS_LIMIT_KEY,
			String(Math.min(20, Math.max(0, limit)))
		);
	} catch {
		// Storage unavailable.
	}
}
