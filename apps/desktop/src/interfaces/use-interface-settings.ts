// The user's own settings for each interface (Settings → Appearance →
// Interfaces, or a renderer's in-view toggle through
// `InterfacePort.updateSettings`): overrides over the interface descriptor's
// params, keyed by interface id and persisted like the other interface prefs.
// `interfaceParamsWithOverrides` applies them, keeping only keys the
// interface shows and values that fit.

import type { InterfaceSettingValue } from "@ryuhq/protocol/interfaces";
import { create } from "zustand";

export const INTERFACE_SETTINGS_KEY = "ryu:interface-settings";

export type InterfaceOverrides = Readonly<
	Record<string, Readonly<Record<string, InterfaceSettingValue>>>
>;

/** Most interfaces whose settings are kept (oldest dropped beyond it). */
const MAX_INTERFACES = 64;
/** Most settings kept for one interface (the protocol's cap). */
const MAX_KEYS = 16;

function isSettingValue(value: unknown): value is InterfaceSettingValue {
	return (
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(typeof value === "string" && value.length <= 128)
	);
}

/** Only an object of interface ids to objects of scalar values survives. */
export function sanitizeOverrides(raw: unknown): InterfaceOverrides {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}
	const out: Record<string, Record<string, InterfaceSettingValue>> = {};
	for (const [id, values] of Object.entries(raw).slice(-MAX_INTERFACES)) {
		if (!values || typeof values !== "object" || Array.isArray(values)) {
			continue;
		}
		const kept: Record<string, InterfaceSettingValue> = {};
		for (const [key, value] of Object.entries(values).slice(0, MAX_KEYS)) {
			if (isSettingValue(value)) {
				kept[key] = value;
			}
		}
		if (Object.keys(kept).length > 0) {
			out[id] = kept;
		}
	}
	return out;
}

function readOverrides(): InterfaceOverrides {
	try {
		const stored =
			typeof localStorage === "undefined"
				? null
				: localStorage.getItem(INTERFACE_SETTINGS_KEY);
		return stored ? sanitizeOverrides(JSON.parse(stored)) : {};
	} catch {
		return {};
	}
}

function writeOverrides(overrides: InterfaceOverrides): void {
	try {
		if (Object.keys(overrides).length === 0) {
			localStorage.removeItem(INTERFACE_SETTINGS_KEY);
		} else {
			localStorage.setItem(INTERFACE_SETTINGS_KEY, JSON.stringify(overrides));
		}
	} catch {
		// Storage unavailable: the choice still holds for this session.
	}
}

export interface InterfaceSettingsState {
	/**
	 * The interface Settings → Appearance → Interfaces shows, when one was
	 * picked there or asked for by the switcher; null means the active one.
	 * Not persisted.
	 */
	focusedId: string | null;
	/** Show `interfaceId`'s settings in the Interfaces section. */
	focusInterface: (interfaceId: string | null) => void;
	overrides: InterfaceOverrides;
	/** Forget the user's settings for one interface (back to its defaults). */
	resetSettings: (interfaceId: string) => void;
	/** Merge `patch` into one interface's settings. */
	setSettings: (
		interfaceId: string,
		patch: Readonly<Record<string, InterfaceSettingValue>>
	) => void;
}

/** A fresh store reading the persisted overrides; exported for tests. */
export function createInterfaceSettingsStore() {
	return create<InterfaceSettingsState>((set, get) => ({
		focusedId: null,
		focusInterface: (interfaceId) => set({ focusedId: interfaceId }),
		overrides: readOverrides(),
		resetSettings: (interfaceId) => {
			const { [interfaceId]: _dropped, ...rest } = get().overrides;
			writeOverrides(rest);
			set({ overrides: rest });
		},
		setSettings: (interfaceId, patch) => {
			const current = get().overrides;
			const next = sanitizeOverrides({
				...current,
				[interfaceId]: { ...current[interfaceId], ...patch },
			});
			writeOverrides(next);
			set({ overrides: next });
		},
	}));
}

export const useInterfaceSettings = createInterfaceSettingsStore();
