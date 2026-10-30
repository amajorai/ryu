import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	DEFAULT_ISLAND_COMMAND_SHORTCUT,
	DEFAULT_VOICE_PREFS,
	type VoiceEngine,
	type VoiceInputMode,
} from "@/src/lib/api/preferences.ts";
import { VOICE_MODE_OPTIONS } from "./IslandSettings-constants.ts";
import type { IslandVoicePrefsState } from "./IslandSettings-voice-prefs.ts";
import { ShortcutCapture } from "./shared/ShortcutCapture.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** Conversation agents, shortcuts, and Audio & Voice Recognition sections. */
export function IslandVoiceSections({
	agentOptions,
	commandShortcut,
	fromAgentValue,
	handleSttEngine,
	handleTtsEngine,
	islandAgents,
	selectedTtsEngine,
	sttEngineOptions,
	toAgentValue,
	tts,
	ttsEngineOptions,
	ttsVoiceOptions,
	voicePrefs,
	writeCommandShortcut,
	writeIslandAgents,
	writeTts,
	writeVoicePrefs,
}: IslandVoicePrefsState) {
	return (
		<>
			<SettingsSection
				caption="Which agent the island talks to. The chat agent handles both your typed messages and transcribed voice; the proactive agent generates the suggestion chips. Both default to Ryu, the flagship Pi + Gateway agent. Pick “Default local model” for the fast, no-subprocess local model instead."
				title="Conversation agents"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={agentOptions}
								onValueChange={(v) =>
									writeIslandAgents({
										...islandAgents,
										voiceAgent: fromAgentValue(v),
									})
								}
								value={toAgentValue(islandAgents.voiceAgent)}
							>
								<SelectTrigger
									aria-label="Chat agent (Voice Recognition)"
									className="h-8 w-56"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{agentOptions.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Handles voice + typed chat in the island."
						title="Chat agent (Voice Recognition)"
					/>
					<SettingsItem
						actions={
							<Select
								items={agentOptions}
								onValueChange={(v) =>
									writeIslandAgents({
										...islandAgents,
										proactiveAgent: fromAgentValue(v),
									})
								}
								value={toAgentValue(islandAgents.proactiveAgent)}
							>
								<SelectTrigger
									aria-label="Proactive suggestion agent"
									className="h-8 w-56"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{agentOptions.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Generates the proactive suggestion chips."
						title="Proactive suggestion agent"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Global hotkeys for the island. Summon the command bar from anywhere to type into the island; push-to-talk dictates by voice. System-wide dictation (type into any app) lives under Settings → Plugins → Dictation. Click a shortcut, then press the new key combination (Esc cancels)."
				title="Shortcuts"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<ShortcutCapture
								ariaLabel="Set command bar shortcut"
								onChange={writeCommandShortcut}
								onReset={() =>
									writeCommandShortcut(DEFAULT_ISLAND_COMMAND_SHORTCUT)
								}
								value={commandShortcut}
							/>
						}
						description="Show + focus the island and open its command bar so you can type."
						title="Summon command bar"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Enable push-to-talk Voice Recognition"
								checked={voicePrefs.enabled}
								onCheckedChange={(v) =>
									writeVoicePrefs({ ...voicePrefs, enabled: v })
								}
							/>
						}
						description="Press the shortcut to dictate into the island; a live waveform shows while listening, then the transcript drops into chat."
						title="Push-to-talk Voice Recognition"
					/>
					{/* Each row is a direct group child (never a Fragment): the group
					    reads a row's description to render it as the card footer, and
					    it cannot see rows nested inside a Fragment. */}
					{voicePrefs.enabled ? (
						<SettingsItem
							actions={
								<ShortcutCapture
									ariaLabel="Set push-to-talk shortcut"
									onChange={(acc) =>
										writeVoicePrefs({ ...voicePrefs, shortcut: acc })
									}
									onReset={() =>
										writeVoicePrefs({
											...voicePrefs,
											shortcut: DEFAULT_VOICE_PREFS.shortcut,
										})
									}
									value={voicePrefs.shortcut}
								/>
							}
							description="Global key to dictate into the island."
							title="Push-to-talk shortcut"
						/>
					) : null}
					{voicePrefs.enabled ? (
						<SettingsItem
							actions={
								<Select<VoiceInputMode>
									items={VOICE_MODE_OPTIONS}
									onValueChange={(v) =>
										writeVoicePrefs({
											...voicePrefs,
											mode: v,
										})
									}
									value={voicePrefs.mode}
								>
									<SelectTrigger
										aria-label="Voice activation mode"
										className="h-8 w-56"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{VOICE_MODE_OPTIONS.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							}
							description={
								voicePrefs.mode === "push-to-talk"
									? "Hold the shortcut to record; release to stop and transcribe. While recording, press Tab to switch which agent handles the task."
									: "Press the shortcut once to start, again to stop. While recording, press Tab to switch which agent handles the task."
							}
							title="Activation"
						/>
					) : null}
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption={
					<>
						Audio and Voice Recognition for the island. Voice Recognition
						transcribes what you say using the selected whisper, audio.cpp,
						Parakeet, or cloud runtime. Read-back speaks assistant replies aloud
						using the auto-downloaded Kokoro 82M by default (OuteTTS is the
						fallback). Read-back is automatically disabled while a meeting is
						recording.
					</>
				}
				title="Audio & Voice Recognition"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select<VoiceEngine>
								items={sttEngineOptions}
								onValueChange={(v) => handleSttEngine(v)}
								value={voicePrefs.engine}
							>
								<SelectTrigger
									aria-label="Voice input engine"
									className="h-8 w-56"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{sttEngineOptions.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Voice Recognition engine + bundled model."
						title="Voice Recognition"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Always read back responses"
								checked={tts.enabled}
								onCheckedChange={(v) => writeTts({ ...tts, enabled: v })}
							/>
						}
						description="Speak island assistant replies aloud when a turn finishes."
						title="Always read back responses"
					/>
					{tts.enabled && (
						<SettingsItem
							actions={
								<Select
									items={ttsEngineOptions}
									onValueChange={handleTtsEngine}
									value={tts.engine}
								>
									<SelectTrigger aria-label="Audio engine" className="h-8 w-56">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{ttsEngineOptions.map((opt) => (
											<SelectItem key={opt.value} value={opt.value}>
												{opt.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							}
							description="Audio engine for spoken replies."
							title="Audio engine"
						/>
					)}
					{tts.enabled &&
						selectedTtsEngine &&
						selectedTtsEngine.voices.length > 0 && (
							<SettingsItem
								actions={
									<Select
										items={ttsVoiceOptions}
										onValueChange={(v) => {
											if (v !== null) {
												writeTts({ ...tts, voice: v });
											}
										}}
										value={tts.voice || selectedTtsEngine.default_voice || ""}
									>
										<SelectTrigger aria-label="Voice" className="h-8 w-56">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{ttsVoiceOptions.map((opt) => (
												<SelectItem key={opt.value} value={opt.value}>
													{opt.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								}
								description="Preset voice for the chosen engine."
								title="Voice"
							/>
						)}
				</SettingsGroup>
			</SettingsSection>
		</>
	);
}
