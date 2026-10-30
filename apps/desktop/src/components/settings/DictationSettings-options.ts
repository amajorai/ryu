// apps/desktop/src/components/settings/DictationSettings-options.ts
//
// Option tables and prefs-update types shared by the Dictation settings page.

import type {
	DictationInsertMode,
	DictationMode,
	DictationPrefs,
	SpeechProcessingPrefs,
} from "@/src/lib/api/preferences.ts";

/** Activation-mode choices for dictation shortcuts. */
export const DICTATION_MODE_OPTIONS: { value: DictationMode; label: string }[] =
	[
		{ value: "push-to-talk", label: "Hold to talk" },
		{ value: "toggle", label: "Press to start / stop" },
	];

/** How dictated text lands in the focused app. */
export const DICTATION_INSERT_OPTIONS: {
	value: DictationInsertMode;
	label: string;
}[] = [
	{ value: "type", label: "Type (synthetic keystrokes)" },
	{ value: "paste", label: "Paste (clipboard)" },
];

export const IS_WINDOWS = navigator.userAgent.includes("Windows");

export type DictationPrefsUpdate = (current: DictationPrefs) => DictationPrefs;
export type SpeechProcessingPrefsUpdate = (
	current: SpeechProcessingPrefs
) => SpeechProcessingPrefs;
