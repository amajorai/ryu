// Core-KV storage adapter for the unified hotkey system.
//
// Overrides live in Core's preferences store (key `keybindings`) so every desktop
// window on the node reads the same set. `save` also broadcasts a same-process
// CustomEvent so sibling windows in this renderer update live without a reload;
// cross-process surfaces pick it up on their next mount.

import type { HotkeyStorage } from "@ryu/hotkeys/react";
import type { Overrides } from "@ryu/hotkeys/registry";
import { toTarget } from "@/src/lib/api/client.ts";
import { getKeybindings, setKeybindings } from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

const CHANGE_EVENT = "ryu:keybindings-changed";

function activeTarget() {
	return toTarget(useNodeStore.getState().getActiveNode());
}

/** The desktop hotkey storage backed by Core preferences. */
export const coreKvHotkeyStorage: HotkeyStorage = {
	load(): Promise<Overrides> {
		return getKeybindings(activeTarget());
	},
	async save(overrides: Overrides): Promise<void> {
		await setKeybindings(activeTarget(), overrides);
		window.dispatchEvent(
			new CustomEvent<Overrides>(CHANGE_EVENT, { detail: overrides })
		);
	},
	subscribe(onChange: (overrides: Overrides) => void): () => void {
		const handler = (e: Event) => {
			onChange((e as CustomEvent<Overrides>).detail);
		};
		window.addEventListener(CHANGE_EVENT, handler);
		return () => window.removeEventListener(CHANGE_EVENT, handler);
	},
};
