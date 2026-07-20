// Desktop voice-mode display preference: show the live transcript like normal
// chat (default) instead of the full-screen orb. When on, voice mode also renders
// any UI components the assistant emits on its blank canvas. Client-only pref
// (localStorage, cross-window synced) — no node round-trip needed.

import { Switch } from "@ryu/ui/components/switch";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { VOICE_SHOW_TRANSCRIPT_KEY } from "@/src/lib/voice-prefs.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function VoiceModeDisplaySettings() {
	const [showTranscript, setShowTranscript] = usePersistedToggle(
		VOICE_SHOW_TRANSCRIPT_KEY,
		true
	);

	return (
		<SettingsSection
			caption="When on, live voice mode keeps the conversation readable as chat and renders any UI cards the assistant sends. When off, it shows the classic full-screen voice orb."
			title="Voice mode display"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={showTranscript}
							onCheckedChange={setShowTranscript}
						/>
					}
					description="See the transcript like normal chat instead of the voice screen."
					title="Show transcript in voice mode"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
