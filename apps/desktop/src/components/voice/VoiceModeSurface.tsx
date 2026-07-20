// Chooses how live voice mode is presented: the ChatGPT-style transcript panel
// (default) or the classic full-screen orb. Driven by the "Show transcript in
// voice mode" desktop setting (`ryu:voice-show-transcript`, default ON). One
// swap-in for every voice mount point (ChatPage, EmptyTabsState, composer slot)
// so the choice lives in a single place.

import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import type { VoiceMode } from "@/src/hooks/useVoiceMode.ts";
import { VOICE_SHOW_TRANSCRIPT_KEY } from "@/src/lib/voice-prefs.ts";
import { VoiceModeOverlay } from "./VoiceModeOverlay.tsx";
import { VoiceModePanel } from "./VoiceModePanel.tsx";

export function VoiceModeSurface({ voice }: { voice: VoiceMode }) {
	const [showTranscript] = usePersistedToggle(VOICE_SHOW_TRANSCRIPT_KEY, true);
	if (!voice.active) {
		return null;
	}
	return showTranscript ? (
		<VoiceModePanel voice={voice} />
	) : (
		<VoiceModeOverlay voice={voice} />
	);
}
