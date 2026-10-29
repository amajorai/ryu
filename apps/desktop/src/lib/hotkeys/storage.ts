// Core-KV storage adapter for the unified hotkey system.
//
// Overrides live in Core's preferences store (key `keybindings`) so every desktop
// window on the node reads the same set. `save` also broadcasts a same-process
// CustomEvent so sibling windows in this renderer update live without a reload;
// cross-process surfaces pick it up on their next mount.
//
// Core's set is node-wide and shared by every account signed in on this device,
// and an editor may hold a set that is out of date (another window or account
// changed Core since it loaded). So `save` also announces the EDIT itself, the
// set it was made on and the result, for settings sync: that lets sync upload
// only the overrides the user actually changed, never ones the editor carried.

import type { HotkeyStorage } from "@ryu/hotkeys/react";
import type { Overrides } from "@ryu/hotkeys/registry";
import { toTarget } from "@/src/lib/api/client.ts";
import { getKeybindings, setKeybindings } from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

const CHANGE_EVENT = "ryu:keybindings-changed";

/** Same-process event announcing one edit made in this window's editor. */
export const KEYBINDINGS_EDIT_EVENT = "ryu:keybindings-edited";

/** `before`: the set the edit was made on. `after`: the set saved to Core. */
export interface KeybindingsEdit {
	after: Overrides;
	before: Overrides;
}

function activeTarget() {
	return toTarget(useNodeStore.getState().getActiveNode());
}

/** The desktop hotkey storage backed by Core preferences. */
export const coreKvHotkeyStorage: HotkeyStorage = {
	load(): Promise<Overrides> {
		return getKeybindings(activeTarget());
	},
	async save(overrides: Overrides, previous?: Overrides): Promise<void> {
		// The edit is announced synchronously, at the moment the user made it and
		// before Core's write is awaited: it belongs to the account active then.
		// An account switch can land while the write is in flight (the vault moves
		// the session before the reload), and an edit announced after the write
		// would be credited to whichever account had become active meanwhile. The
		// provider keeps an edit in its state even when the write fails, and its
		// next save writes it, so the edit stands either way.
		if (previous !== undefined) {
			window.dispatchEvent(
				new CustomEvent<KeybindingsEdit>(KEYBINDINGS_EDIT_EVENT, {
					detail: { after: overrides, before: previous },
				})
			);
		}
		await setKeybindings(activeTarget(), overrides);
		window.dispatchEvent(
			new CustomEvent<Overrides>(CHANGE_EVENT, { detail: overrides })
		);
	},
	subscribe(onChange: (overrides: Overrides) => void): () => void {
		const handler = (e: Event) => {
			// SAFETY: this adapter's save publishes CHANGE_EVENT as CustomEvent<Overrides>;
			// DOM EventListener erases the same complete native Overrides detail owner.
			onChange((e as CustomEvent<Overrides>).detail);
		};
		window.addEventListener(CHANGE_EVENT, handler);
		return () => window.removeEventListener(CHANGE_EVENT, handler);
	},
};
