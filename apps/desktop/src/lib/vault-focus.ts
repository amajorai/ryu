// A one-shot request to show something on the Vault page, set by a deep link
// (a tapped notification) before the Vault tab opens or while it is open.
//
// The Vault route is matched by its exact path, so the request travels here
// instead of in the tab path: the page switches to `tab`, and the Broker panel
// highlights `proposalId` until the person decides it or another request
// replaces it.

import { useSyncExternalStore } from "react";
import { type VaultTab, vaultTab } from "@/src/pages/VaultPage.model.ts";

export interface VaultFocus {
	proposalId: string | null;
	/** Increases with each request, so the same request twice still applies. */
	seq: number;
	tab: VaultTab;
}

let current: VaultFocus | null = null;
let nextSeq = 1;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) {
		listener();
	}
}

/** Ask the Vault page to show `tab`, highlighting `proposalId` on the Broker tab. */
export function requestVaultFocus(focus: {
	proposalId?: string | null;
	tab: string;
}): VaultFocus {
	current = {
		tab: vaultTab(focus.tab),
		proposalId: focus.proposalId ?? null,
		seq: nextSeq,
	};
	nextSeq += 1;
	emit();
	return current;
}

/** Drop the highlight once it served its purpose. */
export function clearVaultFocus(): void {
	if (current) {
		current = null;
		emit();
	}
}

export function getVaultFocus(): VaultFocus | null {
	return current;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The pending Vault focus request, or null. */
export function useVaultFocus(): VaultFocus | null {
	return useSyncExternalStore(subscribe, getVaultFocus, getVaultFocus);
}
