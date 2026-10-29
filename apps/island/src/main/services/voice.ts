// Main-process client for Core's shared voice-input preference.
//
// Mirrors `services/appearance.ts`: the desktop writes the voice-input blob under
// the `voice-input` preference key, and this service reads it (on startup) and
// subscribes to Core's SSE change stream so a settings change re-registers the
// push-to-talk shortcut + swaps the transcription engine live. The blob stays an
// opaque JSON string here; `shared/voice.ts` owns the parsing (no `@ryu/ui` dep,
// because the main process inlines workspace packages and `@ryu/ui` is renderer
// UI code).

import { VOICE_PREF_KEY } from "../../shared/voice.ts";
import { subscribePreferenceChanges } from "./preference-stream.ts";
import { getPreferenceRaw } from "./preferences.ts";

/** Read the current voice-input blob (raw JSON), or `null` if unset/unreachable. */
export async function getVoicePrefsRaw(): Promise<string | null> {
	return getPreferenceRaw(VOICE_PREF_KEY);
}

export function subscribeVoiceChanges(
	onValue: (value: string) => void
): () => void {
	return subscribePreferenceChanges(VOICE_PREF_KEY, onValue);
}
