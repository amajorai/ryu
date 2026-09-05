import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Switch } from "@ryu/ui/components/switch";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useShadowCapture } from "@/src/hooks/useShadowCapture.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	clampIslandEdgeOffset,
	DEFAULT_AGENT_ID,
	DEFAULT_ISLAND_AUTO_JUMP,
	DEFAULT_ISLAND_COMMAND_SHORTCUT,
	DEFAULT_ISLAND_CONSENT,
	DEFAULT_ISLAND_EDGE_OFFSET,
	DEFAULT_ISLAND_HIDE_ON_FULLSCREEN,
	DEFAULT_ISLAND_SCREEN_PRIVACY,
	DEFAULT_ISLAND_TTS_PREFS,
	DEFAULT_VOICE_PREFS,
	getIslandAgentPrefs,
	getIslandAutoJump,
	getIslandBackground,
	getIslandCommandShortcut,
	getIslandConsent,
	getIslandEdgeOffset,
	getIslandHideOnFullscreen,
	getIslandScreenPrivacy,
	getIslandTtsPrefs,
	getVoiceInputPrefs,
	type IslandAgentPrefs,
	type IslandBackground,
	type IslandConsentPrefs,
	type IslandTtsPrefs,
	MAX_ISLAND_EDGE_OFFSET,
	MIN_ISLAND_EDGE_OFFSET,
	setIslandAgentPrefs,
	setIslandAutoJump,
	setIslandBackground,
	setIslandCommandShortcut,
	setIslandConsent,
	setIslandEdgeOffset,
	setIslandHideOnFullscreen,
	setIslandScreenPrivacy,
	setIslandTtsPrefs,
	setVoiceInputPrefs,
	VOICE_ENGINES,
	type VoiceEngine,
	type VoiceInputMode,
	type VoiceInputPrefs,
} from "@/src/lib/api/preferences.ts";
import { listTtsEngines, type TtsEngine } from "@/src/lib/api/voice.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { ShortcutCapture } from "./shared/ShortcutCapture.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** Option value standing in for "Core's default local model" (no agent). */
const LOCAL_MODEL_OPTION = "__local__";

/** Activation-mode choices for the push-to-talk shortcut. */
const VOICE_MODE_OPTIONS: { value: VoiceInputMode; label: string }[] = [
	{ value: "toggle", label: "Press to start / stop" },
	{ value: "push-to-talk", label: "Hold to talk" },
];

/** Debounce for the offset slider's Core write (the slider fires continuously). */
const EDGE_OFFSET_WRITE_DEBOUNCE_MS = 200;

/**
 * Fullscreen hiding relies on a Windows-only detection signal, so the toggle is
 * disabled elsewhere rather than shown as a silent no-op.
 */
const IS_WINDOWS = navigator.userAgent.includes("Windows");

/**
 * Settings for the island companion (a separate Electron overlay). Both controls
 * persist to Core's cross-process preferences store; the island reads them on
 * startup and subscribes to Core's SSE stream, so a change here re-configures the
 * live overlay (the offset re-docks it; the background recreates its window).
 */
export function IslandSettings() {
	// Shadow capture controls — the island surfaces Shadow's screen context, so
	// the most relevant toggles are mirrored here as well as in the Shadow tab.
	const shadow = useShadowCapture();

	// Background. Stored in Core (cross-process), so we load it async on mount and
	// write it back on change; the island picks up the change live via SSE.
	const [islandBg, setIslandBg] = useState<IslandBackground>("translucent");
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getIslandBackground(target).then((bg) => {
			if (!cancelled) {
				setIslandBg(bg);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const handleIslandBg = (value: string | null) => {
		if (value !== "translucent" && value !== "acrylic" && value !== "mica") {
			return;
		}
		setIslandBg(value);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setIslandBackground(target, value).catch(() => undefined);
	};

	// Edge offset (gap from a docked screen edge). The slider fires continuously
	// while dragging, so the local value updates live but the Core write is
	// debounced to avoid spamming PUTs (and the island re-docking on every tick).
	const [islandEdgeOffset, setIslandEdgeOffsetState] = useState<number>(
		DEFAULT_ISLAND_EDGE_OFFSET
	);
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getIslandEdgeOffset(target).then((offset) => {
			if (!cancelled) {
				setIslandEdgeOffsetState(offset);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const edgeOffsetWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(
		null
	);
	const writeIslandEdgeOffset = useCallback((offset: number) => {
		if (edgeOffsetWriteTimer.current) {
			clearTimeout(edgeOffsetWriteTimer.current);
		}
		edgeOffsetWriteTimer.current = setTimeout(() => {
			const target = toTarget(useNodeStore.getState().getActiveNode());
			setIslandEdgeOffset(target, offset).catch(() => undefined);
		}, EDGE_OFFSET_WRITE_DEBOUNCE_MS);
	}, []);
	const handleIslandEdgeOffset = (vals: number | readonly number[]) => {
		const value = Array.isArray(vals)
			? ((vals as number[])[0] ?? DEFAULT_ISLAND_EDGE_OFFSET)
			: (vals as number);
		const clamped = clampIslandEdgeOffset(value);
		setIslandEdgeOffsetState(clamped);
		writeIslandEdgeOffset(clamped);
	};

	// Auto-jump to the active desktop/monitor. Stored in Core (cross-process); the
	// island reads it on startup and starts/stops its follow-the-cursor loop live.
	const [autoJump, setAutoJumpState] = useState<boolean>(
		DEFAULT_ISLAND_AUTO_JUMP
	);
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getIslandAutoJump(target).then((value) => {
			if (!cancelled) {
				setAutoJumpState(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const handleAutoJump = (value: boolean) => {
		setAutoJumpState(value);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setIslandAutoJump(target, value).catch(() => undefined);
	};

	// Hide-on-fullscreen. When on, the island hides itself while another app is
	// fullscreen (video, game, presentation) and returns when it exits. Stored in
	// Core; the island starts/stops its fullscreen poll loop live via SSE. Windows
	// only for now (the detection signal is a Win32 shell state).
	const [hideOnFullscreen, setHideOnFullscreenState] = useState<boolean>(
		DEFAULT_ISLAND_HIDE_ON_FULLSCREEN
	);
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getIslandHideOnFullscreen(target).then((value) => {
			if (!cancelled) {
				setHideOnFullscreenState(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const handleHideOnFullscreen = (value: boolean) => {
		setHideOnFullscreenState(value);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setIslandHideOnFullscreen(target, value).catch(() => undefined);
	};

	// Screen privacy. When on, the island is excluded from screen capture — still
	// visible to you, but omitted from screenshots, recordings, and screen-sharing.
	// Stored in Core; the island toggles `setContentProtection` live via SSE.
	const [screenPrivacy, setScreenPrivacyState] = useState<boolean>(
		DEFAULT_ISLAND_SCREEN_PRIVACY
	);
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getIslandScreenPrivacy(target).then((value) => {
			if (!cancelled) {
				setScreenPrivacyState(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const handleScreenPrivacy = (value: boolean) => {
		setScreenPrivacyState(value);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setIslandScreenPrivacy(target, value).catch(() => undefined);
	};

	// Agent routing for the island's chat (voice + typed) and its proactive
	// suggestion engine. Both default to the flagship `ryu`; the empty string is
	// surfaced as the "default local model" option. The agent list is the same one
	// the chat picker uses (built-ins + custom), via `useAgents`.
	const { agents } = useAgents();
	const [islandAgents, setIslandAgentsState] = useState<IslandAgentPrefs>({
		voiceAgent: DEFAULT_AGENT_ID,
		proactiveAgent: DEFAULT_AGENT_ID,
	});
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getIslandAgentPrefs(target).then((prefs) => {
			if (!cancelled) {
				setIslandAgentsState(prefs);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const writeIslandAgents = (next: IslandAgentPrefs) => {
		setIslandAgentsState(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setIslandAgentPrefs(target, next).catch(() => undefined);
	};
	const agentOptions = useMemo(
		() => [
			{ value: LOCAL_MODEL_OPTION, label: "Default local model (fast)" },
			...agents.map((a) => ({ value: a.id, label: a.name })),
		],
		[agents]
	);
	const toAgentValue = (stored: string) =>
		stored.length > 0 ? stored : LOCAL_MODEL_OPTION;
	const fromAgentValue = (value: string | null) =>
		value && value !== LOCAL_MODEL_OPTION ? value : "";

	// Voice Recognition engine (the island's voice input). Reuses the shared
	// `voice-input` pref; only the engine (+ its bundled model) is edited here, the
	// shortcut/enable stay owned by the Voice settings tab. The default whisper
	// model (`ggml-base.en`) is the auto-downloaded one.
	const [voicePrefs, setVoicePrefsState] =
		useState<VoiceInputPrefs>(DEFAULT_VOICE_PREFS);
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getVoiceInputPrefs(target).then((prefs) => {
			if (!cancelled) {
				setVoicePrefsState(prefs);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const writeVoicePrefs = (next: VoiceInputPrefs) => {
		setVoicePrefsState(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setVoiceInputPrefs(target, next).catch(() => undefined);
	};
	const handleSttEngine = (engine: VoiceEngine) => {
		const model =
			VOICE_ENGINES.find((e) => e.engine === engine)?.model ??
			DEFAULT_VOICE_PREFS.model;
		writeVoicePrefs({ ...voicePrefs, engine, model });
	};

	// Command-bar summon shortcut: the global hotkey that shows + focuses the
	// island and opens its command palette so you can type. Stored in Core
	// (cross-process); the island reads it on startup and re-registers the global
	// accelerator live on change.
	const [commandShortcut, setCommandShortcutState] = useState<string>(
		DEFAULT_ISLAND_COMMAND_SHORTCUT
	);
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getIslandCommandShortcut(target).then((value) => {
			if (!cancelled) {
				setCommandShortcutState(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const writeCommandShortcut = (value: string) => {
		setCommandShortcutState(value);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setIslandCommandShortcut(target, value).catch(() => undefined);
	};

	// Audio: whether the island speaks replies aloud, and which engine + voice.
	// The default engine is the auto-downloaded built-in OuteTTS. The engine list
	// is whatever Core serves (built-in, native audio.cpp, and Ryu Audio sidecar).
	const [tts, setTtsState] = useState<IslandTtsPrefs>(DEFAULT_ISLAND_TTS_PREFS);
	const [ttsEngines, setTtsEngines] = useState<TtsEngine[]>([]);
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getIslandTtsPrefs(target).then((prefs) => {
			if (!cancelled) {
				setTtsState(prefs);
			}
		});
		listTtsEngines(target)
			.then((list) => {
				if (!cancelled) {
					setTtsEngines(list);
				}
			})
			.catch(() => {
				// Engine list is best-effort; the picker falls back to the saved id.
			});
		return () => {
			cancelled = true;
		};
	}, []);
	const writeTts = (next: IslandTtsPrefs) => {
		setTtsState(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setIslandTtsPrefs(target, next).catch(() => undefined);
	};
	const selectedTtsEngine = useMemo(
		() => ttsEngines.find((e) => e.id === tts.engine),
		[ttsEngines, tts.engine]
	);
	const sttEngineOptions = useMemo(
		() =>
			VOICE_ENGINES.map((e) => ({
				value: e.engine,
				label: e.label,
			})),
		[]
	);
	const ttsEngineOptions = useMemo(() => {
		if (ttsEngines.length > 0) {
			return ttsEngines.map((e) => ({
				value: e.id,
				label: `${e.display_name}${e.installed ? "" : " (not installed)"}`,
			}));
		}
		// Engines not loaded yet: label the current engine from its id (the default
		// is Kokoro 82M; OuteTTS is the built-in fallback).
		const fallbackLabels: Record<string, string> = {
			kokoro: "Kokoro 82M",
			outetts: "OuteTTS (fallback)",
			gateway: "Cloud (via gateway)",
		};
		return [
			{ value: tts.engine, label: fallbackLabels[tts.engine] ?? tts.engine },
		];
	}, [ttsEngines, tts.engine]);
	const ttsVoiceOptions = useMemo(
		() =>
			(selectedTtsEngine?.voices ?? []).map((v) => ({ value: v, label: v })),
		[selectedTtsEngine]
	);
	const handleTtsEngine = (engineId: string | null) => {
		if (engineId === null) {
			return;
		}
		const next = ttsEngines.find((e) => e.id === engineId);
		const stillValid = next?.voices.includes(tts.voice);
		writeTts({
			...tts,
			engine: engineId,
			voice: stillValid ? tts.voice : (next?.default_voice ?? ""),
		});
	};

	// Privacy consent for the island companion. Mirrored cross-process via Core:
	// the island stays the authoritative hard gate but pushes/pulls this blob, so
	// these toggles (formerly only in the island's own removed Settings tab) are
	// editable here. `contextRead`/`proactive` are tri-state; an unanswered (`null`)
	// capability renders as off, and flipping a switch writes an explicit boolean.
	const [consent, setConsentState] = useState<IslandConsentPrefs>(
		DEFAULT_ISLAND_CONSENT
	);
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getIslandConsent(target).then((prefs) => {
			if (!cancelled) {
				setConsentState(prefs);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const writeConsent = (next: IslandConsentPrefs) => {
		setConsentState(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setIslandConsent(target, next).catch(() => undefined);
	};

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="What Shadow records for the island's context. Full controls live in the Shadow tab."
				title="Shadow capture"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={shadow.frames}
								disabled={!shadow.ready}
								onCheckedChange={(v) => {
									shadow.setFrames(v).catch(() => undefined);
								}}
							/>
						}
						title="Screen recording (frames)"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={shadow.paused}
								disabled={!shadow.ready}
								onCheckedChange={(v) => {
									shadow.setPaused(v).catch(() => undefined);
								}}
							/>
						}
						title="Pause all capture (incognito)"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="What the island companion is allowed to do. Screen context lets it see your active app and window; proactive suggestions read that context and then offer tips, so screen context has to be on too. Chat lets the island send and receive messages. Turning one off here turns it off on the island right away."
				title="Privacy & permissions"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={consent.chat}
								onCheckedChange={(v) => writeConsent({ ...consent, chat: v })}
							/>
						}
						description="Let the island companion send and receive chat and voice messages."
						title="Chat"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={consent.contextRead === true}
								onCheckedChange={(v) =>
									writeConsent({ ...consent, contextRead: v })
								}
							/>
						}
						description="Let the island see your active app and window. Off keeps it away from anything that reads your screen."
						title="Screen context"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={consent.proactive === true}
								disabled={consent.contextRead !== true}
								onCheckedChange={(v) =>
									writeConsent({ ...consent, proactive: v })
								}
							/>
						}
						description="Generate proactive suggestion chips from your context. Requires Screen context to be on."
						title="Proactive suggestions"
					/>
				</SettingsGroup>
			</SettingsSection>

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
								<SelectTrigger className="h-8 w-56 text-sm">
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
								<SelectTrigger className="h-8 w-56 text-sm">
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
					{voicePrefs.enabled ? (
						<>
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
							<SettingsItem
								actions={
									<Select
										items={VOICE_MODE_OPTIONS}
										onValueChange={(v) =>
											writeVoicePrefs({
												...voicePrefs,
												mode: v as VoiceInputMode,
											})
										}
										value={voicePrefs.mode}
									>
										<SelectTrigger
											aria-label="Voice activation mode"
											className="h-8 w-56 text-sm"
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
						</>
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
							<Select
								items={sttEngineOptions}
								onValueChange={(v) => handleSttEngine(v as VoiceEngine)}
								value={voicePrefs.engine}
							>
								<SelectTrigger
									aria-label="Voice input engine"
									className="h-8 w-56 text-sm"
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
									<SelectTrigger
										aria-label="Audio engine"
										className="h-8 w-56 text-sm"
									>
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
										<SelectTrigger
											aria-label="Voice"
											className="h-8 w-56 text-sm"
										>
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

			<SettingsSection caption="How the island's background looks. Translucent works everywhere and keeps the smooth floating shape with a dark tint (no blur). Acrylic and Mica blur your desktop behind the island using a built-in system effect, but the island then shows as a rounded rectangle. Mica is a richer blur on Windows 11 and falls back to the standard blur on other systems.">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={[
									{
										value: "translucent",
										label: "Translucent (tinted glass)",
									},
									{ value: "acrylic", label: "Acrylic glass (native blur)" },
									{ value: "mica", label: "Mica (Windows 11 native blur)" },
								]}
								onValueChange={handleIslandBg}
								value={islandBg}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="translucent">
										Translucent (tinted glass)
									</SelectItem>
									<SelectItem value="acrylic">
										Acrylic glass (native blur)
									</SelectItem>
									<SelectItem value="mica">
										Mica (Windows 11 native blur)
									</SelectItem>
								</SelectContent>
							</Select>
						}
						title="Background"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption={`One value, applied to each edge: a corner is inset on both axes at once. ${DEFAULT_ISLAND_EDGE_OFFSET}px is the default.`}
			>
				<SettingsCard>
					<FluidSlider
						format={(v) => `${v}px`}
						label="Offset from edge"
						max={MAX_ISLAND_EDGE_OFFSET}
						min={MIN_ISLAND_EDGE_OFFSET}
						onValueChange={handleIslandEdgeOffset}
						step={1}
						value={islandEdgeOffset}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="When on, the island follows you to whichever desktop/monitor you are active on (the one under your cursor), re-docking to the same corner or edge. Has no effect on a single-monitor setup."
				title="Position"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch checked={autoJump} onCheckedChange={handleAutoJump} />
						}
						title="Auto-jump to active monitor"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Hide on fullscreen keeps the island out of immersive content (videos, games, presentations) and is Windows-only for now. Hide from screen capture excludes the island from screenshots, screen recordings, and screen-sharing. You still see it, but a shared or recorded screen does not."
				title="Privacy & visibility"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={IS_WINDOWS && hideOnFullscreen}
								disabled={!IS_WINDOWS}
								onCheckedChange={handleHideOnFullscreen}
							/>
						}
						description={
							IS_WINDOWS
								? "Hide the island while another app is fullscreen, and bring it back when you exit."
								: "Hide the island while another app is fullscreen, and bring it back when you exit. Available on Windows only for now."
						}
						title="Hide on fullscreen apps"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={screenPrivacy}
								onCheckedChange={handleScreenPrivacy}
							/>
						}
						description="Exclude the island from screenshots, screen recordings, and screen-sharing in meetings."
						title="Hide from screen capture"
					/>
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}
