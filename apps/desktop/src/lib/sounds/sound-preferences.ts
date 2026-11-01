import { useSyncExternalStore } from "react";
import { SETTINGS_REMOTE_APPLIED_EVENT } from "../settings-sync/local-store.ts";
import {
	isSoundSettingRowId,
	SOUND_EVENTS,
	type SoundEventId,
	type SoundSettingRowId,
	soundSettingRow,
} from "./sound-catalog.ts";
import {
	DEFAULT_SOUND_PACK,
	isSoundPackId,
	type SoundPackId,
} from "./sound-packs.ts";

/**
 * Which UI sounds play and in which pack. Settings-synced (allowlisted in
 * `settings-sync/keys.ts`), so turning a sound off follows the account.
 */
export const SOUND_PREFS_KEY = "ryu:sound-prefs";

/**
 * Output volume, 0..1. Device-local on purpose: speakers differ per machine,
 * the same reason the default speaker is not synced.
 */
export const SOUND_VOLUME_KEY = "ryu:sound-volume";

export const DEFAULT_SOUND_VOLUME = 0.6;

/** Stored values larger than this are ignored as corrupt. */
const MAX_PREFS_BYTES = 4096;

export interface SoundPrefsV1 {
	enabled: boolean;
	/** Sparse per-row overrides; a missing row uses the catalog default. */
	events: Partial<Record<SoundSettingRowId, boolean>>;
	pack: SoundPackId;
	/** Quiet notification and reward cues while Do Not Disturb is on. */
	quietInDnd: boolean;
	v: 1;
}

export type SoundPrefs = SoundPrefsV1;

export const DEFAULT_SOUND_PREFS: SoundPrefs = Object.freeze({
	v: 1,
	enabled: true,
	pack: DEFAULT_SOUND_PACK,
	events: Object.freeze({}),
	quietInDnd: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvents(value: unknown): SoundPrefsV1["events"] {
	const events: SoundPrefsV1["events"] = {};
	if (!isRecord(value)) {
		return events;
	}
	for (const [key, enabled] of Object.entries(value)) {
		if (isSoundSettingRowId(key) && typeof enabled === "boolean") {
			events[key] = enabled;
		}
	}
	return events;
}

/**
 * Turn any stored value into current prefs. The seam for future versions:
 * a v2 shape gets a branch here that upgrades it. Never throws.
 */
export function migrateSoundPrefs(raw: unknown): SoundPrefs {
	if (!isRecord(raw) || raw.v !== 1) {
		return DEFAULT_SOUND_PREFS;
	}
	return {
		v: 1,
		enabled:
			typeof raw.enabled === "boolean"
				? raw.enabled
				: DEFAULT_SOUND_PREFS.enabled,
		pack: isSoundPackId(raw.pack) ? raw.pack : DEFAULT_SOUND_PACK,
		events: parseEvents(raw.events),
		quietInDnd:
			typeof raw.quietInDnd === "boolean"
				? raw.quietInDnd
				: DEFAULT_SOUND_PREFS.quietInDnd,
	};
}

export function parseSoundPrefs(raw: string | null): SoundPrefs {
	if (!raw || raw.length > MAX_PREFS_BYTES) {
		return DEFAULT_SOUND_PREFS;
	}
	try {
		return migrateSoundPrefs(JSON.parse(raw));
	} catch {
		return DEFAULT_SOUND_PREFS;
	}
}

function readRaw(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

let prefsCache: { raw: string | null; prefs: SoundPrefs } | null = null;

/** Current prefs; the same object until the stored value changes. */
export function readSoundPrefs(): SoundPrefs {
	const raw = readRaw(SOUND_PREFS_KEY);
	if (prefsCache && prefsCache.raw === raw) {
		return prefsCache.prefs;
	}
	const prefs = parseSoundPrefs(raw);
	prefsCache = { raw, prefs };
	return prefs;
}

/** Clamp to 0..1; anything unreadable is the default volume. */
export function clampSoundVolume(value: number): number {
	if (!Number.isFinite(value)) {
		return DEFAULT_SOUND_VOLUME;
	}
	return Math.min(1, Math.max(0, value));
}

export function readSoundVolume(): number {
	const raw = readRaw(SOUND_VOLUME_KEY);
	if (raw === null || raw.trim() === "") {
		return DEFAULT_SOUND_VOLUME;
	}
	return clampSoundVolume(Number(raw));
}

const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) {
		listener();
	}
}

function writeRaw(key: string, value: string): void {
	try {
		// A plain setItem: the settings-sync observer uploads allowlisted keys.
		localStorage.setItem(key, value);
	} catch {
		// Storage can be unavailable (private windows); listeners still update
		// this page, which then reads the old value back. Best effort.
	}
}

export type SoundPrefsPatch = Partial<Omit<SoundPrefs, "v">>;

/** Merge a patch into the stored prefs (events merge per row). */
export function setSoundPrefs(patch: SoundPrefsPatch): void {
	const current = readSoundPrefs();
	const next: SoundPrefs = {
		...current,
		...patch,
		v: 1,
		events: { ...current.events, ...patch.events },
	};
	writeRaw(SOUND_PREFS_KEY, JSON.stringify(next));
	notify();
}

/** Turn one Settings row on or off, storing only real overrides. */
export function setSoundRowEnabled(
	row: SoundSettingRowId,
	enabled: boolean
): void {
	const current = readSoundPrefs();
	const events = { ...current.events };
	if (soundSettingRow(row).defaultEnabled === enabled) {
		delete events[row];
	} else {
		events[row] = enabled;
	}
	writeRaw(SOUND_PREFS_KEY, JSON.stringify({ ...current, events }));
	notify();
}

export function setSoundVolume(volume: number): void {
	writeRaw(SOUND_VOLUME_KEY, String(clampSoundVolume(volume)));
	notify();
}

/** Whether a Settings row is on, resolving overrides over the default. */
export function isSoundRowEnabled(
	prefs: SoundPrefs,
	row: SoundSettingRowId
): boolean {
	return prefs.events[row] ?? soundSettingRow(row).defaultEnabled;
}

/** Whether a cue's own switch is on (ignores the master switch). */
export function isSoundEventEnabled(
	prefs: SoundPrefs,
	id: SoundEventId
): boolean {
	return isSoundRowEnabled(prefs, SOUND_EVENTS[id].settingRow);
}

export function subscribeSoundPrefs(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (
			event.key === null ||
			event.key === SOUND_PREFS_KEY ||
			event.key === SOUND_VOLUME_KEY
		) {
			callback();
		}
	};
	// A remote settings apply writes through the original setter, which fires
	// no `storage` event in this document.
	const onRemoteApplied = (event: Event) => {
		const detail = (event as CustomEvent<{ key?: unknown }>).detail;
		if (detail?.key === SOUND_PREFS_KEY) {
			callback();
		}
	};
	window.addEventListener("storage", onStorage);
	window.addEventListener(SETTINGS_REMOTE_APPLIED_EVENT, onRemoteApplied);
	return () => {
		listeners.delete(callback);
		window.removeEventListener("storage", onStorage);
		window.removeEventListener(SETTINGS_REMOTE_APPLIED_EVENT, onRemoteApplied);
	};
}

export function useSoundPrefs(): SoundPrefs {
	return useSyncExternalStore(
		subscribeSoundPrefs,
		readSoundPrefs,
		() => DEFAULT_SOUND_PREFS
	);
}

export function useSoundVolume(): number {
	return useSyncExternalStore(
		subscribeSoundPrefs,
		readSoundVolume,
		() => DEFAULT_SOUND_VOLUME
	);
}
