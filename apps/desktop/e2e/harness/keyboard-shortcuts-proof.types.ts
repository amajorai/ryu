import type { Overrides } from "@ryu/hotkeys/registry";
import type { DictationPrefs } from "../../src/lib/api/preferences.ts";

export interface ShortcutProofState {
	__shortcutDictationPrefs: DictationPrefs;
	__shortcutOverrides: Overrides;
	__shortcutApiOrigin: string;
	__registerShortcutTransport: (input: {
		origin: string;
		prefs: DictationPrefs;
	}) => Promise<void>;
	__shortcutUnmount: () => void;
	__shortcutStorage: { refuseNext: boolean; calls: Overrides[] };
}

declare global {
	interface Window extends ShortcutProofState {}
}
