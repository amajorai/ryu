import type { Overrides } from "@ryu/hotkeys/registry";
import type { DictationPrefs } from "../../src/lib/api/preferences.ts";

export interface ShortcutProofState {
	__registerShortcutTransport: (input: {
		origin: string;
		prefs: DictationPrefs;
	}) => Promise<void>;
	__shortcutApiOrigin: string;
	__shortcutDictationPrefs: DictationPrefs;
	__shortcutOverrides: Overrides;
	__shortcutStorage: { refuseNext: boolean; calls: Overrides[] };
	__shortcutUnmount: () => void;
}

declare global {
	interface Window extends ShortcutProofState {}
}
