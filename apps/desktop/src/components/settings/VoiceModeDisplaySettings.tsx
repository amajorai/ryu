// Desktop voice-mode display preference: stream the call's turns into the chat as
// normal messages and show any UI cards the assistant emits above the call
// composer (default), or keep the call to its single composer row. Client-only
// (localStorage, cross-window synced) — no node round-trip needed.

import { Switch } from "@ryu/ui/components/switch.tsx";
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
			caption="When off, a live call stays a single row in the composer."
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
					description="Show call turns in the chat while the call is live."
					title="Show transcript in voice mode"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
