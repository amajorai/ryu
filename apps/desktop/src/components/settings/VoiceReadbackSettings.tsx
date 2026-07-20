// Desktop chat read-back: automatically speak assistant replies when a text turn
// finishes. Separate from island-tts (island companion) and from the realtime
// voice-mode WebSocket session (which always speaks via Core while active).

import { Switch } from "@ryu/ui/components/switch";
import { useCallback, useEffect, useState } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_VOICE_MODE_READBACK_PREFS,
	getVoiceModeReadbackPrefs,
	setVoiceModeReadbackPrefs,
	type VoiceModeReadbackPrefs,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function VoiceReadbackSettings() {
	const [prefs, setPrefs] = useState<VoiceModeReadbackPrefs>(
		DEFAULT_VOICE_MODE_READBACK_PREFS
	);

	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getVoiceModeReadbackPrefs(target).then((saved) => {
			if (!cancelled) {
				setPrefs(saved);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const persist = useCallback((next: VoiceModeReadbackPrefs) => {
		setPrefs(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setVoiceModeReadbackPrefs(target, next).catch(() => undefined);
	}, []);

	return (
		<SettingsSection
			caption="Applies to desktop chat. Read-back is automatically disabled while a meeting is recording, even when this toggle is on. Engine and voice come from the Text-to-speech section below."
			title="Read back responses"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={prefs.enabled}
							onCheckedChange={(enabled) => persist({ ...prefs, enabled })}
						/>
					}
					description="Speak assistant replies aloud when a chat turn finishes."
					title="Always read back responses"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
