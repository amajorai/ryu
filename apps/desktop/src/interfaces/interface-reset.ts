// The startup reset: boot into the default chat whatever interface was open
// last, as a recovery path that needs no working interface. Two triggers:
//
// - the desktop app launched with `--reset-interface`, or with
//   `RYU_RESET_INTERFACE=1` in its environment (asked of the native side);
// - the one-shot settings key `ryu:reset-interface` = "1" in this window's
//   storage (any build), consumed when applied.
//
// Applied once per window session, so a reload keeps the user's later choice.

import { setProductMode } from "@/src/lib/product-mode.ts";
import { invokeWhenReady, isTauriReady } from "@/src/lib/tauri-ready.ts";

export const RESET_INTERFACE_KEY = "ryu:reset-interface";
const APPLIED_KEY = "ryu:reset-interface-applied";

function takeStorageRequest(): boolean {
	try {
		if (localStorage.getItem(RESET_INTERFACE_KEY) !== "1") {
			return false;
		}
		localStorage.removeItem(RESET_INTERFACE_KEY);
		return true;
	} catch {
		return false;
	}
}

function alreadyApplied(): boolean {
	try {
		return sessionStorage.getItem(APPLIED_KEY) === "1";
	} catch {
		return false;
	}
}

function markApplied(): void {
	try {
		sessionStorage.setItem(APPLIED_KEY, "1");
	} catch {
		// Without session storage a reload may reset again; harmless.
	}
}

async function launchRequested(): Promise<boolean> {
	// The desktop bridge is injected before any script runs; without it this is
	// not the desktop app, so do not wait for one.
	if (!isTauriReady()) {
		return false;
	}
	try {
		return await invokeWhenReady<boolean>("interface_reset_requested");
	} catch {
		// Not the desktop app, or an older native side without the command.
		return false;
	}
}

/** Put the window on the default chat, forgetting the remembered interface.
 *  The interface registry loads only when a reset actually applies, so it stays
 *  out of every other window's startup bundle. */
export async function resetToDefaultInterface(): Promise<void> {
	const [{ DEFAULT_WORKSPACE_INTERFACE_ID }, { useInterfaceStore }] =
		await Promise.all([
			import("@/src/interfaces/registry.ts"),
			import("./interface-store.ts"),
		]);
	useInterfaceStore
		.getState()
		.setWorkspaceInterfaceId(DEFAULT_WORKSPACE_INTERFACE_ID);
	// Agent falls back to Bot for users who may not open it.
	setProductMode("console");
}

/** Apply a requested startup reset; resolves true when one was applied. */
export async function applyStartupInterfaceReset(): Promise<boolean> {
	const fromStorage = takeStorageRequest();
	if (alreadyApplied() && !fromStorage) {
		return false;
	}
	if (!(fromStorage || (await launchRequested()))) {
		return false;
	}
	markApplied();
	await resetToDefaultInterface();
	return true;
}
