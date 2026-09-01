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
	{ label: "Console", value: "console" },
	{ label: "OS", value: "os" },
] as const satisfies ReadonlyArray<{ label: string; value: StartupRealm }>;

const PRODUCT_MODE_VALUES: readonly ProductMode[] = ["bot", "console", "os"];
const STARTUP_REALM_VALUES: readonly StartupRealm[] = [
	"last-used",
	...PRODUCT_MODE_VALUES,
];

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function isProductMode(value: string | null): value is ProductMode {
	return value !== null && PRODUCT_MODE_VALUES.includes(value as ProductMode);
}

export function isStartupRealm(value: string | null): value is StartupRealm {
	return value !== null && STARTUP_REALM_VALUES.includes(value as StartupRealm);
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

export function setStartupRealm(startupRealm: StartupRealm): void {
	try {
		storage()?.setItem(STARTUP_REALM_KEY, startupRealm);
	} catch {
		// A preference that cannot be persisted still keeps its existing value.
	}
	if (typeof window !== "undefined") {
		window.dispatchEvent(new Event("storage"));
	}
}

function readRequestedMode(): ProductMode {
	return resolveStartupRealm(readStartupRealm(), readLastUsedRealm());
}

interface ProductModeState {
	consoleAccess: boolean;
	requestedMode: ProductMode;
	setConsoleAccess: (allowed: boolean) => void;
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
 */
export const useProductModeStore = create<ProductModeState>((set) => ({
	consoleAccess: false,
	requestedMode: readRequestedMode(),
	setConsoleAccess: (allowed) => set({ consoleAccess: allowed }),
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
			: resolveProductMode(state.requestedMode, state.consoleAccess)
	);
}

/** Console is the only mode gated by organization authority; OS is a workspace
 * surface and remains available to the same users who can use Bot. */
export function resolveProductMode(
	requestedMode: ProductMode,
	consoleAccess: boolean
): ProductMode {
	if (requestedMode === "console") {
		return consoleAccess ? "console" : "bot";
	}
	return requestedMode;
}

/** Non-React read for routing and preference helpers. */
export function readProductMode(): ProductMode {
	const state = useProductModeStore.getState();
	return isRyuBot()
		? "bot"
		: resolveProductMode(state.requestedMode, state.consoleAccess);
}

export function isBotMode(): boolean {
	return readProductMode() === "bot";
}

export function setProductMode(mode: ProductMode): void {
	useProductModeStore.getState().setRequestedMode(mode);
}
