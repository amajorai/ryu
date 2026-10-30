// apps/desktop/src/components/settings/DictationSettings.tsx
//
// Settings for system-wide dictation (the `apps-store/dictation` plugin): hold a
// global shortcut, speak, and the transcript is typed into whatever native app
// has OS focus. Agent-ask is a second mode: speak a question, run an agent, paste
// the answer. Island hosts the OS surface (shortcut registration, capture, insert);
// this page persists the cross-process `dictation` preference blob.

import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useMemo } from "react";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import { useActiveTarget } from "@/src/hooks/useActiveNode.ts";
import {
	DEFAULT_DICTATION_PREFS,
	type DictationInsertMode,
	type DictationMode,
	SPEECH_PROCESSING_ENGINES,
	type SpeechProcessingPrefs,
	VOICE_ENGINES,
	type VoiceEngine,
} from "@/src/lib/api/preferences.ts";
import {
	ISLAND_ENABLED,
	ISLAND_UNAVAILABLE_NOTE,
} from "@/src/lib/island-availability.ts";
import { AgentAccessPanel } from "./AgentAccessPanel.tsx";
import { DictationAgentAskSection } from "./DictationSettings-agent-ask-section.tsx";
import {
	DICTATION_INSERT_OPTIONS,
	DICTATION_MODE_OPTIONS,
	IS_WINDOWS,
} from "./DictationSettings-options.ts";
import { useDictationSettingsPrefs } from "./DictationSettings-prefs.ts";
import { ShortcutCapture } from "./shared/ShortcutCapture.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function DictationSettings() {
	// One memoized target per node identity for the child pickers and the access
	// panel. A fresh object on every render made the access panel reload the
	// agent, its Spaces and its tools on each keystroke in the prompts.
	const nodeTarget = useActiveTarget();
	const {
		prefs,
		speechPrefs,
		loadingPrefs,
		loadError,
		setLoadAttempt,
		saveError,
		writePrefs,
		writeSpeechPrefs,
		retryFailedSave,
	} = useDictationSettingsPrefs();
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();

	const sttEngineOptions = useMemo(
		() =>
			VOICE_ENGINES.map((e) => ({
				value: e.engine,
				label: e.label,
			})),
		[]
	);
	const speechEngineOptions = useMemo(
		() =>
			SPEECH_PROCESSING_ENGINES.map((entry) => ({
				value: entry.engine,
				label: entry.label,
			})),
		[]
	);

	if (loadingPrefs) {
		return (
			<div className="py-3 text-muted-foreground text-sm" role="status">
				Loading Dictation settings…
			</div>
		);
	}

	if (loadError) {
		return (
			<div
				className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-status-destructive"
				role="alert"
			>
				<span>Could not load Dictation settings.</span>
				<Button
					onClick={() => setLoadAttempt((attempt) => attempt + 1)}
					size="sm"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{saveError ? (
				<div
					className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-status-destructive"
					role="alert"
				>
					<span>
						{tl("Could not save {surface} settings.", {
							surface:
								saveError === "dictation" ? "Dictation" : "Speech Processing",
						})}
					</span>
					<Button onClick={retryFailedSave} size="sm" variant="outline">
						Retry save
					</Button>
				</div>
			) : null}
			<SettingsSection
				caption={
					<>
						System-wide dictation types your speech into whatever app has focus.
						Unlike push-to-talk voice input (which runs an agent), this just
						enters text, optionally cleaned up by a model first.
					</>
				}
				title="Dictation"
			>
				<SettingsCard>
					<p className="text-muted-foreground text-sm">
						{tlRich(
							"Dictation is on because the <strong>Dictation</strong> plugin is enabled. To turn it off everywhere, disable the plugin in <strong>Gateway settings → Plugins</strong>. {islandNote} The settings below tune what it does once it is on.",
							{
								islandNote: ISLAND_ENABLED
									? "The island companion hosts the OS surface (global shortcuts, capture, insert)."
									: tl(
											"{ISLAND_UNAVAILABLE_NOTE} System-wide dictation shortcuts start working once it ships.",
											{ ISLAND_UNAVAILABLE_NOTE }
										),
							},
							{ strong: (chunks) => <strong>{chunks}</strong> }
						)}
					</p>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Hold the dictation shortcut, speak, and the transcript is typed into the focused app."
				title="Transcribe"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<ShortcutCapture
								ariaLabel="Set dictation shortcut"
								onChange={(acc) =>
									writePrefs((current) => ({ ...current, shortcut: acc }))
								}
								onReset={() =>
									writePrefs((current) => ({
										...current,
										shortcut: DEFAULT_DICTATION_PREFS.shortcut,
									}))
								}
								value={prefs.shortcut}
							/>
						}
						description="Global key to dictate into the focused app. Kept separate from the voice-input shortcut."
						title="Dictation shortcut"
					/>
					<SettingsItem
						actions={
							<Select<DictationMode>
								items={DICTATION_MODE_OPTIONS}
								onValueChange={(v) =>
									writePrefs((current) => ({
										...current,
										mode: v,
									}))
								}
								value={prefs.mode}
							>
								<SelectTrigger
									aria-label="Dictation activation mode"
									className="h-8 w-56"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DICTATION_MODE_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description={
							prefs.mode === "push-to-talk"
								? "Hold the shortcut to record; release to insert."
								: "Press once to start, again to stop and insert."
						}
						title="Activation"
					/>
					<SettingsItem
						actions={
							<Select<VoiceEngine>
								items={sttEngineOptions}
								onValueChange={(v) =>
									writePrefs((current) => ({
										...current,
										engine: v,
									}))
								}
								value={prefs.engine}
							>
								<SelectTrigger
									aria-label="Dictation engine"
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
						description="Voice Recognition engine used for dictation."
						title="Engine"
					/>
					<SettingsItem
						actions={
							<Select<DictationInsertMode>
								items={DICTATION_INSERT_OPTIONS}
								onValueChange={(v) =>
									writePrefs((current) => ({
										...current,
										insertMode: v,
									}))
								}
								value={prefs.insertMode}
							>
								<SelectTrigger
									aria-label="Dictation insertion method"
									className="h-8 w-56"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DICTATION_INSERT_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description={
							prefs.insertMode === "paste"
								? "Copies the text and sends the paste shortcut, so it stays instant even for long dictations."
								: "Types the text character by character. No clipboard clobber; works everywhere."
						}
						title="Insertion"
					/>
					{/* One conditional per row, never a fragment: SettingsGroup reads each
					    row's description off its direct children, so rows wrapped in a
					    fragment lost their captions and merged into the next row's card. */}
					{prefs.insertMode === "paste" ? (
						<SettingsItem
							actions={
								<Input
									aria-label="Paste command"
									className="w-56"
									onChange={(e) =>
										writePrefs((current) => ({
											...current,
											pasteKeys: e.target.value,
										}))
									}
									placeholder={
										IS_WINDOWS ? "ctrl+v (default)" : "cmd+v (default)"
									}
									size="settings-search"
									value={prefs.pasteKeys}
								/>
							}
							description="Key combo to paste, `+`-joined (e.g. ctrl+v, cmd+shift+v). Empty uses the platform default."
							title="Paste command"
						/>
					) : null}
					{prefs.insertMode === "paste" ? (
						<SettingsItem
							actions={
								<Switch
									aria-label="Restore clipboard after paste"
									checked={prefs.restoreClipboard}
									onCheckedChange={(v) =>
										writePrefs((current) => ({
											...current,
											restoreClipboard: v,
										}))
									}
								/>
							}
							description="Put your previous clipboard back after pasting the dictation."
							title="Restore clipboard"
						/>
					) : null}
					<SettingsItem
						actions={
							<Switch
								aria-label="Auto-send after dictation"
								checked={prefs.autoSend}
								onCheckedChange={(v) =>
									writePrefs((current) => ({ ...current, autoSend: v }))
								}
							/>
						}
						description="Press Enter after inserting, which sends the message in a chat box (or adds a newline in an editor)."
						title="Auto-send (press Enter)"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Clean up dictation with Speech Processing"
								checked={prefs.postProcess.enabled}
								onCheckedChange={(v) =>
									writePrefs((current) => ({
										...current,
										postProcess: {
											...current.postProcess,
											enabled: v,
										},
									}))
								}
							/>
						}
						description="Run the selected Speech Processing engine after Voice Recognition. Defaults to S1-mini by Superwhisper; turn this off to insert the raw transcript."
						title="Clean up with Speech Processing"
					/>
					{prefs.postProcess.enabled ? (
						<SettingsItem
							actions={
								<Select
									items={speechEngineOptions}
									onValueChange={(value) => {
										if (value === "s1-mini") {
											writeSpeechPrefs(
												(current) =>
													({
														...current,
														engine: value,
													}) satisfies SpeechProcessingPrefs
											);
										}
									}}
									value={speechPrefs.engine}
								>
									<SelectTrigger
										aria-label="Speech Processing engine"
										className="h-8 w-56"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{speechEngineOptions.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							}
							description="The node-local cleanup model. Style, structure, and context are configured from the Speech Processing layer on the Computer dialog's Voice & sandbox page."
							title="Cleanup engine"
						/>
					) : null}
					{prefs.postProcess.enabled ? (
						<SettingsItem
							description="Leave empty to use the selected Speech Processing engine. Pick an agent or model only for an explicit custom cleanup override."
							title="Custom cleanup override"
						>
							<AgentSelectionField
								ariaLabel="Dictation cleanup agent or model"
								onChange={(selection) =>
									writePrefs((current) => ({
										...current,
										postProcess: {
											...current.postProcess,
											selection,
										},
									}))
								}
								placeholder="Use Speech Processing engine"
								target={nodeTarget}
								value={prefs.postProcess.selection}
							/>
						</SettingsItem>
					) : null}
				</SettingsGroup>
				{/* Outside the group on purpose: a prompt is a tall text block, so it
				    goes `bare` — the row to itself, full width — instead of a 288px
				    box crammed into the row's right column on top of the card fill. */}
				{prefs.postProcess.enabled ? (
					<SettingsItem
						bare
						description="Used only when a custom cleanup agent/model is selected. S1-mini uses its required local control prompt."
						title="Custom cleanup prompt"
					>
						<Textarea
							aria-label="Dictation cleanup prompt"
							className="min-h-24"
							onChange={(e) =>
								writePrefs((current) => ({
									...current,
									postProcess: {
										...current.postProcess,
										prompt: e.target.value,
									},
								}))
							}
							typography="small"
							value={prefs.postProcess.prompt}
						/>
					</SettingsItem>
				) : null}
			</SettingsSection>

			<DictationAgentAskSection
				nodeTarget={nodeTarget}
				prefs={prefs}
				writePrefs={writePrefs}
			/>

			{prefs.ask.enabled && prefs.ask.selection.agent_id.trim() ? (
				<AgentAccessPanel
					agentId={prefs.ask.selection.agent_id.trim()}
					target={nodeTarget}
				/>
			) : prefs.postProcess.enabled &&
				prefs.postProcess.selection.agent_id.trim() ? (
				<AgentAccessPanel
					agentId={prefs.postProcess.selection.agent_id.trim()}
					target={nodeTarget}
				/>
			) : null}
		</div>
	);
}
