// apps/desktop/src/components/settings/DictationSettings.tsx
//
// Settings for system-wide dictation (the `apps-store/dictation` plugin): hold a
// global shortcut, speak, and the transcript is typed into whatever native app
// has OS focus. Agent-ask is a second mode: speak a question, run an agent, paste
// the answer. Island hosts the OS surface (shortcut registration, capture, insert);
// this page persists the cross-process `dictation` preference blob.

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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import {
	useActiveTarget,
	useActiveTargetGetter,
} from "@/src/hooks/useActiveNode.ts";
import {
	DEFAULT_DICTATION_ASK,
	DEFAULT_DICTATION_PREFS,
	DEFAULT_SPEECH_PROCESSING_PREFS,
	type DictationInsertMode,
	type DictationMode,
	type DictationPrefs,
	getDictationPrefs,
	getSpeechProcessingPrefs,
	SPEECH_PROCESSING_ENGINES,
	type SpeechProcessingPrefs,
	setDictationPrefs,
	setSpeechProcessingPrefs,
	VOICE_ENGINES,
	type VoiceEngine,
} from "@/src/lib/api/preferences.ts";
import {
	ISLAND_ENABLED,
	ISLAND_UNAVAILABLE_NOTE,
} from "@/src/lib/island-availability.ts";
import { AgentAccessPanel } from "./AgentAccessPanel.tsx";
import { ShortcutCapture } from "./shared/ShortcutCapture.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** Activation-mode choices for dictation shortcuts. */
const DICTATION_MODE_OPTIONS: { value: DictationMode; label: string }[] = [
	{ value: "push-to-talk", label: "Hold to talk" },
	{ value: "toggle", label: "Press to start / stop" },
];

/** How dictated text lands in the focused app. */
const DICTATION_INSERT_OPTIONS: {
	value: DictationInsertMode;
	label: string;
}[] = [
	{ value: "type", label: "Type (synthetic keystrokes)" },
	{ value: "paste", label: "Paste (clipboard)" },
];

const IS_WINDOWS = navigator.userAgent.includes("Windows");

type DictationPrefsUpdate = (current: DictationPrefs) => DictationPrefs;
type SpeechProcessingPrefsUpdate = (
	current: SpeechProcessingPrefs
) => SpeechProcessingPrefs;

export function DictationSettings() {
	const getTarget = useActiveTargetGetter();
	// One memoized target per node identity for the child pickers and the access
	// panel. A fresh object on every render made the access panel reload the
	// agent, its Spaces and its tools on each keystroke in the prompts.
	const nodeTarget = useActiveTarget();
	const [prefs, setPrefs] = useState<DictationPrefs>(DEFAULT_DICTATION_PREFS);
	const [speechPrefs, setSpeechPrefs] = useState<SpeechProcessingPrefs>(
		DEFAULT_SPEECH_PROCESSING_PREFS
	);
	const [loadingPrefs, setLoadingPrefs] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [saveError, setSaveError] = useState<"dictation" | "speech" | null>(
		null
	);
	const dictationPrefsRef = useRef(prefs);
	const speechPrefsRef = useRef(speechPrefs);
	const dictationWriteQueue = useRef(Promise.resolve());
	const speechWriteQueue = useRef(Promise.resolve());

	useEffect(() => {
		let cancelled = false;
		setLoadingPrefs(true);
		setLoadError(false);
		Promise.all([
			getDictationPrefs(getTarget()),
			getSpeechProcessingPrefs(getTarget()),
		])
			.then(([dictation, speechProcessing]) => {
				if (!cancelled) {
					dictationPrefsRef.current = dictation;
					speechPrefsRef.current = speechProcessing;
					setPrefs(dictation);
					setSpeechPrefs(speechProcessing);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setLoadError(true);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoadingPrefs(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [loadAttempt]);

	const writePrefs = useCallback((update: DictationPrefsUpdate) => {
		const withEnabled = { ...update(dictationPrefsRef.current), enabled: true };
		const target = getTarget();
		dictationPrefsRef.current = withEnabled;
		setPrefs(withEnabled);
		dictationWriteQueue.current = dictationWriteQueue.current
			.catch(() => undefined)
			.then(async () => {
				await setDictationPrefs(target, withEnabled);
				setSaveError((current) => (current === "dictation" ? null : current));
			})
			.catch(() => setSaveError("dictation"));
	}, []);

	const writeSpeechPrefs = useCallback(
		(update: SpeechProcessingPrefsUpdate) => {
			const next = update(speechPrefsRef.current);
			const target = getTarget();
			speechPrefsRef.current = next;
			setSpeechPrefs(next);
			speechWriteQueue.current = speechWriteQueue.current
				.catch(() => undefined)
				.then(async () => {
					await setSpeechProcessingPrefs(target, next);
					setSaveError((current) => (current === "speech" ? null : current));
				})
				.catch(() => setSaveError("speech"));
		},
		[]
	);

	const retryFailedSave = () => {
		if (saveError === "dictation") {
			const target = getTarget();
			dictationWriteQueue.current = dictationWriteQueue.current
				.catch(() => undefined)
				.then(async () => {
					await setDictationPrefs(target, dictationPrefsRef.current);
					setSaveError((current) => (current === "dictation" ? null : current));
				})
				.catch(() => setSaveError("dictation"));
			return;
		}
		if (saveError === "speech") {
			const target = getTarget();
			speechWriteQueue.current = speechWriteQueue.current
				.catch(() => undefined)
				.then(async () => {
					await setSpeechProcessingPrefs(target, speechPrefsRef.current);
					setSaveError((current) => (current === "speech" ? null : current));
				})
				.catch(() => setSaveError("speech"));
		}
	};

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
						Could not save{" "}
						{saveError === "dictation" ? "Dictation" : "Speech Processing"}{" "}
						settings.
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
						Dictation is on because the <strong>Dictation</strong> plugin is
						enabled. To turn it off everywhere, disable the plugin in{" "}
						<strong>Gateway settings → Plugins</strong>.{" "}
						{ISLAND_ENABLED
							? "The island companion hosts the OS surface (global shortcuts, capture, insert)."
							: `${ISLAND_UNAVAILABLE_NOTE} System-wide dictation shortcuts start working once it ships.`}{" "}
						The settings below tune what it does once it is on.
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

			<SettingsSection
				caption="Speak a question anywhere; an agent answers and the text is pasted into the focused app. Uses a separate shortcut from plain dictation."
				title="Agent ask"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Enable agent ask"
								checked={prefs.ask.enabled}
								onCheckedChange={(v) =>
									writePrefs((current) => ({
										...current,
										ask: { ...current.ask, enabled: v },
									}))
								}
							/>
						}
						description="Hold the agent-ask shortcut, ask a question, and paste the agent's answer."
						title="Agent ask"
					/>
					{prefs.ask.enabled ? (
						<SettingsItem
							actions={
								<ShortcutCapture
									ariaLabel="Set agent-ask shortcut"
									onChange={(acc) =>
										writePrefs((current) => ({
											...current,
											ask: { ...current.ask, shortcut: acc },
										}))
									}
									onReset={() =>
										writePrefs((current) => ({
											...current,
											ask: {
												...current.ask,
												shortcut: DEFAULT_DICTATION_ASK.shortcut,
											},
										}))
									}
									value={prefs.ask.shortcut}
								/>
							}
							description="Global key for agent-ask. Kept separate from the dictation shortcut."
							title="Agent-ask shortcut"
						/>
					) : null}
					{prefs.ask.enabled ? (
						<SettingsItem
							actions={
								<Select<DictationMode>
									items={DICTATION_MODE_OPTIONS}
									onValueChange={(v) =>
										writePrefs((current) => ({
											...current,
											ask: { ...current.ask, mode: v },
										}))
									}
									value={prefs.ask.mode}
								>
									<SelectTrigger
										aria-label="Agent-ask activation mode"
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
								prefs.ask.mode === "push-to-talk"
									? "Hold the shortcut to record; release to ask and paste the answer."
									: "Press once to start, again to stop, ask, and paste the answer."
							}
							title="Activation"
						/>
					) : null}
					{prefs.ask.enabled ? (
						<SettingsItem
							description="Prefer an agent when you want tool access (Spaces, Ghost, other apps). A model-only pick answers without tools."
							title="Agent"
						>
							<AgentSelectionField
								ariaLabel="Agent-ask agent or model"
								onChange={(selection) =>
									writePrefs((current) => ({
										...current,
										ask: { ...current.ask, selection },
									}))
								}
								placeholder="Default local model"
								target={nodeTarget}
								value={prefs.ask.selection}
							/>
						</SettingsItem>
					) : null}
				</SettingsGroup>
				{/* `bare`, outside the group — same reason as the cleanup prompt. */}
				{prefs.ask.enabled ? (
					<SettingsItem
						bare
						description="Instructions for the ask agent. It sees this plus your spoken question."
						title="Ask prompt"
					>
						<Textarea
							aria-label="Agent-ask prompt"
							className="min-h-24"
							onChange={(e) =>
								writePrefs((current) => ({
									...current,
									ask: { ...current.ask, prompt: e.target.value },
								}))
							}
							typography="small"
							value={prefs.ask.prompt}
						/>
					</SettingsItem>
				) : null}
			</SettingsSection>

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
