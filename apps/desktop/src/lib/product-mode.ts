import { create } from "zustand";
import { isRyuBot } from "./product.ts";

export type ProductMode = "bot" | "console" | "os";
export type StartupRealm = "last-used" | ProductMode;

const STORAGE_KEY = "ryu:product-mode";
export const STARTUP_REALM_KEY = "ryu:startup-realm";

export const DEFAULT_STARTUP_REALM: StartupRealm = "last-used";

export const STARTUP_REALM_OPTIONS = [
	{ label: "Last used", value: "last-used" },
	{ label: "Bot", value: "bot" },
	{ label: "Agent", value: "console" },
	{ label: "OS", value: "os" },
] as const satisfies ReadonlyArray<{ label: string; value: StartupRealm }>;

function storage(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

export function isProductMode(value: string | null): value is ProductMode {
	return value === "bot" || value === "console" || value === "os";
}
export function isStartupRealm(value: string | null): value is StartupRealm {
	return value === "last-used" || isProductMode(value);
}

/** Resolve the realm to open before the access gate applies. */
export function resolveStartupRealm(
	startupRealm: StartupRealm,
	lastUsedRealm: ProductMode
): ProductMode {
	return startupRealm === "last-used" ? lastUsedRealm : startupRealm;
}

function readLastUsedRealm(): ProductMode {
	try {
		const stored = storage()?.getItem(STORAGE_KEY) ?? null;
		return isProductMode(stored) ? stored : "bot";
	} catch {
		return "bot";
	}
}

export function readStartupRealm(): StartupRealm {
	try {
		const stored = storage()?.getItem(STARTUP_REALM_KEY) ?? null;
		return isStartupRealm(stored) ? stored : DEFAULT_STARTUP_REALM;
	} catch {
		return DEFAULT_STARTUP_REALM;
	}
}

export type StartupRealmSaveResult =
	| { ok: true; realm: StartupRealm }
	| { ok: false; error: string };

export function setStartupRealm(
	startupRealm: StartupRealm
): StartupRealmSaveResult {
	try {
		const target = storage();
		if (!target) {
			return {
				ok: false,
				error:
					"Startup realm could not be saved. Local storage is unavailable.",
			};
		}
		target.setItem(STARTUP_REALM_KEY, startupRealm);
		if (target.getItem(STARTUP_REALM_KEY) !== startupRealm) {
			return {
				ok: false,
				error: "Startup realm could not be confirmed in local storage.",
			};
		}
	} catch {
		return {
			ok: false,
			error: "Startup realm could not be saved. Allow local storage and retry.",
		};
	}
	if (globalThis.window !== undefined) {
		window.dispatchEvent(new Event("storage"));
	}
	return { ok: true, realm: startupRealm };
}

function readRequestedMode(): ProductMode {
	return resolveStartupRealm(readStartupRealm(), readLastUsedRealm());
}

interface ProductModeState {
	consoleAccess: boolean;
	/** Whether the OS desktop (the workspace tier) is rolled out to this account. */
	osAccess: boolean;
	requestedMode: ProductMode;
	setConsoleAccess: (allowed: boolean) => void;
	setOsAccess: (allowed: boolean) => void;
	setRequestedMode: (mode: ProductMode) => void;
}

/**
 * The product switch is deliberately separate from the old Work/Code
 * preference. Bot/Console chooses the product surface; the surface then sets
 * the existing interface preferences to the safe level for that product.
 *
 * `consoleAccess` starts false so a stale local preference cannot briefly expose
 * Console to a managed-org member while the control-plane role query is still
 * resolving. Local/unbound nodes are explicitly granted access by the access
 * hook because there is no organization boundary to bypass.
 *
 * `osAccess` mirrors the `ui.interface_os` rollout flag (synced by the app's
 * access gate) and also starts false, so Bot and Console are the only surfaces
 * until the flag says otherwise. A remembered OS choice stays stored and comes
 * back when the flag turns on.
 */
export const useProductModeStore = create<ProductModeState>((set) => ({
	consoleAccess: false,
	osAccess: false,
	requestedMode: readRequestedMode(),
	setConsoleAccess: (allowed) => set({ consoleAccess: allowed }),
	setOsAccess: (allowed) => set({ osAccess: allowed }),
	setRequestedMode: (mode) => {
		try {
			storage()?.setItem(STORAGE_KEY, mode);
		} catch {
			// Best-effort persistence; the in-memory mode remains authoritative.
		}
		set({ requestedMode: mode });
	},
}));

/** The effective product surface after the server-backed access gate applies. */
export function useProductMode(): ProductMode {
	return useProductModeStore((state) =>
		isRyuBot()
			? "bot"
			: resolveProductMode(
					state.requestedMode,
					state.consoleAccess,
					state.osAccess
				)
	);
}

/**
 * Console is the only mode gated by organization authority. OS is a workspace
 * surface for the same users who can use Bot, but it is held behind its
 * rollout flag; without it a remembered OS choice opens Bot.
 */
export function resolveProductMode(
	requestedMode: ProductMode,
	consoleAccess: boolean,
	osAccess: boolean
): ProductMode {
	if (requestedMode === "console") {
		return consoleAccess ? "console" : "bot";
	}
	if (requestedMode === "os") {
		return osAccess ? "os" : "bot";
	}
	return requestedMode;
}

/** Non-React read for routing and preference helpers. */
export function readProductMode(): ProductMode {
	const state = useProductModeStore.getState();
	return isRyuBot()
		? "bot"
		: resolveProductMode(
				state.requestedMode,
				state.consoleAccess,
				state.osAccess
			);
}

export function isBotMode(): boolean {
	return readProductMode() === "bot";
}

export function setProductMode(mode: ProductMode): void {
	useProductModeStore.getState().setRequestedMode(mode);
}
