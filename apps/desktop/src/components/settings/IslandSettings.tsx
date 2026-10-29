import { Button } from "@ryu/ui/components/button.tsx";
import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveTargetGetter } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useShadowCapture } from "@/src/hooks/useShadowCapture.ts";
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
	getIslandNotchMode,
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
	setIslandNotchMode,
	setIslandScreenPrivacy,
	setIslandTtsPrefs,
	setVoiceInputPrefs,
	VOICE_ENGINES,
	type VoiceEngine,
	type VoiceInputMode,
	type VoiceInputPrefs,
} from "@/src/lib/api/preferences.ts";
import { listTtsEngines, type TtsEngine } from "@/src/lib/api/voice.ts";
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
	// The dialog's scoped computer, or the active node outside one. Effects keep
	// `[]` deps: the node settings dialog remounts its content per computer.
	const getTarget = useActiveTargetGetter();
	// Shadow capture controls — the island surfaces Shadow's screen context, so
	// the most relevant toggles are mirrored here as well as in the Shadow tab.
	const shadow = useShadowCapture();
	const [preferenceWriteError, setPreferenceWriteError] = useState(false);
	const preferenceWriteVersions = useRef(new Map<string, number>());
	const persistPreferenceChange = useCallback(
		(
			key: string,
			write: Promise<boolean>,
			onFailure: () => void,
			onSuccess?: () => void
		) => {
			const version = (preferenceWriteVersions.current.get(key) ?? 0) + 1;
			preferenceWriteVersions.current.set(key, version);
			void write
				.then((saved) => {
					if (!saved) {
						throw new Error("Island preference was not saved");
					}
					if (preferenceWriteVersions.current.get(key) === version) {
						setPreferenceWriteError(false);
						onSuccess?.();
					}
				})
				.catch(() => {
					if (preferenceWriteVersions.current.get(key) !== version) {
						return;
					}
					onFailure();
					setPreferenceWriteError(true);
				});
		},
		[]
	);

	const [notchMode, setNotchMode] = useState(false);
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
		void getIslandNotchMode(target).then((value) => {
			if (!cancelled) {
				setNotchMode(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const handleNotchMode = (enabled: boolean) => {
		const previous = notchMode;
		setNotchMode(enabled);
		const target = getTarget();
		persistPreferenceChange(
			"island-notch-mode",
			setIslandNotchMode(target, enabled),
			() => setNotchMode(previous)
		);
	};
	// Background. Stored in Core (cross-process), so we load it async on mount and
	// write it back on change; the island picks up the change live via SSE.
	const [islandBg, setIslandBg] = useState<IslandBackground>("acrylic");
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
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
		const previous = islandBg;
		setIslandBg(value);
		const target = getTarget();
		persistPreferenceChange(
			"island-appearance",
			setIslandBackground(target, value),
			() => setIslandBg(previous)
		);
	};

	// Edge offset (gap from a docked screen edge). The slider fires continuously
	// while dragging, so the local value updates live but the Core write is
	// debounced to avoid spamming PUTs (and the island re-docking on every tick).
	const [islandEdgeOffset, setIslandEdgeOffsetState] = useState<number>(
		DEFAULT_ISLAND_EDGE_OFFSET
	);
	const persistedEdgeOffset = useRef(DEFAULT_ISLAND_EDGE_OFFSET);
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
		getIslandEdgeOffset(target).then((offset) => {
			if (!cancelled) {
				persistedEdgeOffset.current = offset;
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
	const writeIslandEdgeOffset = useCallback(
		(offset: number) => {
			if (edgeOffsetWriteTimer.current) {
				clearTimeout(edgeOffsetWriteTimer.current);
			}
			edgeOffsetWriteTimer.current = setTimeout(() => {
				const target = getTarget();
				persistPreferenceChange(
					"island-edge-offset",
					setIslandEdgeOffset(target, offset),
					() => setIslandEdgeOffsetState(persistedEdgeOffset.current),
					() => {
						persistedEdgeOffset.current = offset;
					}
				);
			}, EDGE_OFFSET_WRITE_DEBOUNCE_MS);
		},
		[persistPreferenceChange]
	);
	const handleIslandEdgeOffset = (vals: number | readonly number[]) => {
		// SAFETY: This callback's complete numeric port is number | readonly number[]. Native Array.isArray distinguishes those two runtime alternatives, but its mutable-array predicate does not eliminate the readonly array from the declared false branch. Both assertions retain the original numeric values; the array branch only reads index zero and never mutates it.
		const value = Array.isArray(vals)
			? ((vals as readonly number[])[0] ?? DEFAULT_ISLAND_EDGE_OFFSET)
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
		const target = getTarget();
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
		const previous = autoJump;
		setAutoJumpState(value);
		const target = getTarget();
		persistPreferenceChange(
			"island-auto-jump",
			setIslandAutoJump(target, value),
			() => setAutoJumpState(previous)
		);
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
		const target = getTarget();
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
		const previous = hideOnFullscreen;
		setHideOnFullscreenState(value);
		const target = getTarget();
		persistPreferenceChange(
			"island-hide-on-fullscreen",
			setIslandHideOnFullscreen(target, value),
			() => setHideOnFullscreenState(previous)
		);
	};

	// Screen privacy. When on, the island is excluded from screen capture — still
	// visible to you, but omitted from screenshots, recordings, and screen-sharing.
	// Stored in Core; the island toggles `setContentProtection` live via SSE.
	const [screenPrivacy, setScreenPrivacyState] = useState<boolean>(
		DEFAULT_ISLAND_SCREEN_PRIVACY
	);
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
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
		const previous = screenPrivacy;
		setScreenPrivacyState(value);
		const target = getTarget();
		persistPreferenceChange(
			"island-screen-privacy",
			setIslandScreenPrivacy(target, value),
			() => setScreenPrivacyState(previous)
		);
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
		const target = getTarget();
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
		const previous = islandAgents;
		setIslandAgentsState(next);
		const target = getTarget();
		persistPreferenceChange(
			"island-agents",
			setIslandAgentPrefs(target, next),
			() => setIslandAgentsState(previous)
		);
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
		const target = getTarget();
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
		const previous = voicePrefs;
		setVoicePrefsState(next);
		const target = getTarget();
		persistPreferenceChange(
			"voice-input",
			setVoiceInputPrefs(target, next),
			() => setVoicePrefsState(previous)
		);
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
		const target = getTarget();
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
		const previous = commandShortcut;
		setCommandShortcutState(value);
		const target = getTarget();
		persistPreferenceChange(
			"island-command-shortcut",
			setIslandCommandShortcut(target, value),
			() => setCommandShortcutState(previous)
		);
	};

	// Audio: whether the island speaks replies aloud, and which engine + voice.
	// The default engine is the auto-downloaded built-in OuteTTS. The engine list
	// is whatever Core serves (built-in, native audio.cpp, and Ryu Audio sidecar).
	const [tts, setTtsState] = useState<IslandTtsPrefs>(DEFAULT_ISLAND_TTS_PREFS);
	const [ttsEngines, setTtsEngines] = useState<TtsEngine[]>([]);
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
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
		const previous = tts;
		setTtsState(next);
		const target = getTarget();
		persistPreferenceChange("island-tts", setIslandTtsPrefs(target, next), () =>
			setTtsState(previous)
		);
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
		const fallbackLabels = new Map([
			["kokoro", "Kokoro 82M"],
			["outetts", "OuteTTS (fallback)"],
			["gateway", "Cloud (via gateway)"],
		]);
		return [
			{
				value: tts.engine,
				label: fallbackLabels.get(tts.engine) ?? tts.engine,
			},
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
		const target = getTarget();
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
		const previous = consent;
		setConsentState(next);
		const target = getTarget();
		persistPreferenceChange(
			"island-consent",
			setIslandConsent(target, next),
			() => setConsentState(previous)
		);
	};

	return (
		<div className="space-y-6">
			{preferenceWriteError ? (
				<div
					className="rounded-lg border border-status-destructive/40 bg-status-destructive/10 p-3 text-sm text-status-destructive"
					role="alert"
				>
					Couldn't save Island setting. The previous value was restored. Choose
					the setting again to retry.
				</div>
			) : null}
			<SettingsSection
				caption="What Shadow records for the island's context. Full controls live in the Shadow tab."
				title="Shadow capture"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Screen recording (frames)"
								checked={shadow.frames}
								disabled={!shadow.ready || shadow.captureApplying}
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
								aria-label="Pause all capture (incognito)"
								checked={shadow.paused}
								disabled={!shadow.ready || shadow.captureApplying}
								onCheckedChange={(v) => {
									shadow.setPaused(v).catch(() => undefined);
								}}
							/>
						}
						title="Pause all capture (incognito)"
					/>
				</SettingsGroup>
				{shadow.captureApplying ? (
					<p className="px-3 text-muted-foreground text-xs" role="status">
						Applying capture settings…
					</p>
				) : null}
				{shadow.captureReadError ? (
					<p className="px-3 text-status-destructive text-xs" role="alert">
						Could not read saved capture preferences. Capture has not been
						changed. Retry to load the saved preferences first.
					</p>
				) : null}
				{shadow.captureError ? (
					<p className="px-3 text-status-destructive text-xs" role="alert">
						Capture settings could not be applied. The selected preferences do
						not confirm that capture has changed.
					</p>
				) : null}
				{shadow.persistenceError ? (
					<p className="px-3 text-status-destructive text-xs" role="alert">
						Could not save capture preferences. An accepted capture change may
						still be active for this session, but these preferences may not
						survive a restart.
					</p>
				) : null}
				{shadow.captureReadError ||
				shadow.captureError ||
				shadow.persistenceError ? (
					<Button
						disabled={shadow.captureApplying}
						onClick={shadow.retryCaptureSettings}
						variant="outline"
					>
						Retry capture settings
					</Button>
				) : null}
			</SettingsSection>

			<SettingsSection
				caption="What the island companion is allowed to do. Screen context lets it see your active app and window; proactive suggestions read that context and then offer tips, so screen context has to be on too. Chat lets the island send and receive messages. Turning one off here turns it off on the island right away."
				title="Privacy & permissions"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Chat"
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
								aria-label="Screen context"
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
								aria-label="Proactive suggestions"
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

			<SettingsSection caption="Native glass is the default: it uses Liquid Glass on newer macOS, vibrancy on older macOS, and Acrylic on Windows while the split gap stays clear. Translucent keeps a CSS-only floating surface whose blur reaches the Island's own contents. Mica uses a native material on Windows 11 and falls back to Acrylic elsewhere.">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Notch mode"
								checked={notchMode}
								onCheckedChange={handleNotchMode}
							/>
						}
						description="Attach Island to the camera notch on supported Macs. Uses a black surface and keeps controls below the camera. Falls back to floating mode when no notched display is available."
						title="Notch mode"
					/>

					<SettingsItem
						actions={
							<Select
								items={[
									{
										value: "translucent",
										label: "Translucent (tinted glass)",
									},
									{ value: "acrylic", label: "Native glass (default)" },
									{ value: "mica", label: "Mica (Windows 11 native blur)" },
								]}
								onValueChange={handleIslandBg}
								value={islandBg}
							>
								<SelectTrigger aria-label="Background" className="h-8 w-56">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="translucent">
										Translucent (tinted glass)
									</SelectItem>
									<SelectItem value="acrylic">
										Native glass (default)
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
							<Switch
								aria-label="Auto-jump to active monitor"
								checked={autoJump}
								onCheckedChange={handleAutoJump}
							/>
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
								aria-label="Hide on fullscreen apps"
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
								aria-label="Hide from screen capture"
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
