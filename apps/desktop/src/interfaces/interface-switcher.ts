// Opening the interface switcher from anywhere (the Switch Interface hotkey,
// a command): every mounted switcher menu registers here, and a request opens
// the one the user can see, newest first. With none on screen (a collapsed
// sidebar, a hidden logo), Layout's fallback dialog opens instead.

import { create } from "zustand";
import { selectInterface } from "./interface-store.ts";
import { BOT_INTERFACE, CONSOLE_INTERFACE } from "./registry.ts";

interface SwitcherHost {
	/** The element whose visibility decides whether this switcher can open. */
	element: () => Element | null;
	open: () => void;
}

const hosts: SwitcherHost[] = [];

/** Register a switcher menu; returns its unregister function. */
export function registerInterfaceSwitcher(host: SwitcherHost): () => void {
	hosts.push(host);
	return () => {
		const index = hosts.indexOf(host);
		if (index >= 0) {
			hosts.splice(index, 1);
		}
	};
}

function isVisible(element: Element | null): boolean {
	if (!element?.isConnected) {
		return false;
	}
	return element.getClientRects().length > 0 && !element.closest("[inert]");
}

interface InterfaceSwitcherState {
	/** The fallback dialog, for when no switcher menu is on screen. */
	fallbackOpen: boolean;
	setFallbackOpen: (open: boolean) => void;
}

export const useInterfaceSwitcher = create<InterfaceSwitcherState>((set) => ({
	fallbackOpen: false,
	setFallbackOpen: (open) => set({ fallbackOpen: open }),
}));

/** Open the switcher the user can see, or the fallback dialog. */
export function openInterfaceSwitcher(): void {
	for (let index = hosts.length - 1; index >= 0; index -= 1) {
		const host = hosts[index];
		if (host && isVisible(host.element())) {
			host.open();
			return;
		}
	}
	useInterfaceSwitcher.getState().setFallbackOpen(true);
}

/**
 * Leave any interface for the default chat: Agent where the user may open
 * it, else Bot. Always available, whatever the interface did.
 */
export function backToChat(canSwitchToConsole: boolean): void {
	selectInterface(canSwitchToConsole ? CONSOLE_INTERFACE : BOT_INTERFACE);
}
