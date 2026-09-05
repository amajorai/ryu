// apps/desktop/src/components/settings/TtsEngineSettings.tsx
//
// Picks the default audio engine + voice and lets the user test it.
// The engine set is whatever Core returns from `/api/voice/tts-engines` (the
// built-in OuteTTS, native audio.cpp, plus whatever the universal Ryu TTS sidecar registry serves)
// — nothing is hardcoded here, this is a GUI layer over the Core data path. The
// choice is persisted to localStorage so any future in-chat "speak" surface can
// read the same default.

import { VoiceIcon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useSpeechPlayback } from "@/src/hooks/useSpeechPlayback.ts";
import { useVoiceEngines } from "@/src/hooks/useVoiceEngines.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	DESKTOP_TTS_ENGINE_KEY,
	DESKTOP_TTS_VOICE_KEY,
	getDesktopTtsPrefs,
	setDesktopTtsPref,
	subscribeDesktopTtsPrefs,
} from "@/src/lib/api/preferences.ts";
import {
	installTtsModel,
	listTtsEngines,
	listTtsModels,
	speakText,
	type TtsEngine,
	type TtsModel,
} from "@/src/lib/api/voice.ts";
import { applyDefaultSpeaker } from "@/src/lib/audio/devices.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const SAMPLE_TEXT = "Hi, this is Ryu speaking with the selected voice engine.";
// The optional multi-engine TTS sidecar lives in the catalog's `voice` category;
// installing/starting it is what unlocks the non-OuteTTS voices.
const VOICE_CATEGORIES = ["voice"] as const;

export function TtsEngineSettings() {
	const node = useActiveNode();
	const [engines, setEngines] = useState<TtsEngine[]>([]);
	const [engineId, setEngineId] = useState<string>(
		() => getDesktopTtsPrefs().engine
	);
	const [voice, setVoice] = useState<string>(() => getDesktopTtsPrefs().voice);

	// The node selector's Audio layer writes the same two keys, so pull
	// them back in when it changes them while this screen is open.
	useEffect(
		() =>
			subscribeDesktopTtsPrefs(() => {
				const next = getDesktopTtsPrefs();
				setEngineId(next.engine);
				setVoice(next.voice);
			}),
		[]
	);
	const [loadFailed, setLoadFailed] = useState(false);
	const [reloadNonce, setReloadNonce] = useState(0);
	const [testState, setTestState] = useState<"idle" | "speaking">("idle");
	const [testFailed, setTestFailed] = useState(false);
	const [models, setModels] = useState<TtsModel[]>([]);
	const [installing, setInstalling] = useState<string | null>(null);
	const { play: playSpeech } = useSpeechPlayback();
	// The optional multi-engine TTS sidecar ("ryutts"), installed/started right
	// here at the point of use rather than from a separate Services page.
	const [sidecarPending, setSidecarPending] = useState(false);
	const {
		engines: voiceSidecars,
		install: installVoiceSidecar,
		setRunning: setVoiceRunning,
	} = useVoiceEngines(VOICE_CATEGORIES);
	const ryutts = useMemo(
		() => voiceSidecars.find((e) => e.name === "ryutts"),
		[voiceSidecars]
	);
	const audiocpp = useMemo(
		() => voiceSidecars.find((e) => e.name === "audiocpp"),
		[voiceSidecars]
	);

	const handleReadyRyuTts = useCallback(async () => {
		if (!ryutts) {
			return;
		}
		setSidecarPending(true);
		try {
			if (ryutts.installState !== "installed") {
				await installVoiceSidecar("ryutts");
			} else if (!ryutts.running) {
				await setVoiceRunning("ryutts", true);
			}
		} catch {
			// Failures surface via the global download overlay / engine error state.
		} finally {
			setSidecarPending(false);
		}
	}, [ryutts, installVoiceSidecar, setVoiceRunning]);

	const handleReadyAudioCpp = useCallback(async () => {
		if (!audiocpp) {
			return;
		}
		setSidecarPending(true);
		try {
			if (audiocpp.installState !== "installed") {
				await installVoiceSidecar("audiocpp");
			} else if (!audiocpp.running) {
				await setVoiceRunning("audiocpp", true);
			}
		} catch {
			// Failures surface via the global download overlay / engine error state.
		} finally {
			setSidecarPending(false);
		}
	}, [audiocpp, installVoiceSidecar, setVoiceRunning]);

	const refreshModels = useCallback(() => {
		listTtsModels(toTarget(node))
			.then(setModels)
			.catch(() => setModels([]));
	}, [node]);

	useEffect(() => {
		let cancelled = false;
		listTtsEngines(toTarget(node))
			.then((list) => {
				if (!cancelled) {
					setEngines(list);
					setLoadFailed(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setLoadFailed(true);
				}
			});
		refreshModels();
		return () => {
			cancelled = true;
		};
		// `reloadNonce` is load-bearing: the "Retry" button only bumps it, so
		// without it the button is dead.
	}, [node, refreshModels, reloadNonce]);

	const handleInstall = useCallback(
		async (model: TtsModel) => {
			setInstalling(model.model_name);
			try {
				await installTtsModel(toTarget(node), model.engine, model.model_name);
				refreshModels();
			} catch {
				// Surfaced via the global download overlay / kept silent here.
			} finally {
				setInstalling(null);
			}
		},
		[node, refreshModels]
	);

	const selected = useMemo(
		() => engines.find((e) => e.id === engineId),
		[engines, engineId]
	);

	const handleEngine = (value: string | null) => {
		if (value === null) {
			return;
		}
		setEngineId(value);
		setDesktopTtsPref(DESKTOP_TTS_ENGINE_KEY, value);
		// Reset the voice to the new engine's default if the current one is invalid.
		const next = engines.find((e) => e.id === value);
		const stillValid = next?.voices.includes(voice);
		if (!stillValid) {
			const fallback = next?.default_voice ?? "";
			setVoice(fallback);
			setDesktopTtsPref(DESKTOP_TTS_VOICE_KEY, fallback);
		}
	};

	const handleVoice = (value: string | null) => {
		if (value === null) {
			return;
		}
		setVoice(value);
		setDesktopTtsPref(DESKTOP_TTS_VOICE_KEY, value);
	};

	const handleTest = useCallback(async () => {
		setTestFailed(false);
		setTestState("speaking");
		try {
			await playSpeech(
				`${engineId}:${voice}:${SAMPLE_TEXT}`,
				() =>
					speakText(toTarget(node), SAMPLE_TEXT, {
						engine: engineId,
						voice: voice || undefined,
					}),
				{
					prepareAudio: applyDefaultSpeaker,
					toggle: false,
				}
			);
		} catch {
			setTestFailed(true);
		} finally {
			setTestState("idle");
		}
	}, [engineId, voice, node, playSpeech]);

	const voices = selected?.voices ?? [];
	// Prompt to install/start the ryutts sidecar until it is both installed and
	// running; the extra engines only appear in the picker once it is up.
	const ryuTtsPrompt = useMemo(() => {
		if (!ryutts) {
			return null;
		}
		if (ryutts.installState !== "installed") {
			return {
				label: sidecarPending ? "Installing…" : "Install Ryu Audio engine",
			};
		}
		if (!ryutts.running) {
			return { label: sidecarPending ? "Starting…" : "Start Ryu Audio engine" };
		}
		return null;
	}, [ryutts, sidecarPending]);
	const audioCppPrompt = useMemo(() => {
		if (!audiocpp) {
			return null;
		}
		if (audiocpp.installState !== "installed") {
			return {
				label: sidecarPending ? "Installing…" : "Install audio.cpp runtime",
			};
		}
		if (!audiocpp.running) {
			return {
				label: sidecarPending ? "Starting…" : "Start audio.cpp runtime",
			};
		}
		return null;
	}, [audiocpp, sidecarPending]);
	const selectedRuntimePrompt =
		engineId === "audiocpp"
			? audioCppPrompt
			: engineId !== "outetts" && engineId !== "gateway"
				? ryuTtsPrompt
				: null;

	const engineOptions = useMemo(
		() =>
			engines.map((e) => ({
				value: e.id,
				label: `${e.display_name}${e.installed ? "" : " (not installed)"}`,
			})),
		[engines]
	);
	const voiceOptions = useMemo(
		() => voices.map((v) => ({ value: v, label: v })),
		[voices]
	);

	return (
		<SettingsSection title="Audio">
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							items={engineOptions}
							onValueChange={handleEngine}
							value={engineId}
						>
							<SelectTrigger
								aria-label="Audio engine"
								className="h-8 w-56 text-sm"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{engineOptions.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description={
						selected?.description ?? "Voice used for spoken replies."
					}
					title={
						<span className="flex items-center gap-2">
							<HugeiconsIcon
								className="text-muted-foreground"
								icon={VolumeHighIcon}
								size={16}
							/>
							Engine
						</span>
					}
				/>
				{voices.length > 0 && (
					<SettingsItem
						actions={
							<Select
								items={voiceOptions}
								onValueChange={handleVoice}
								value={voice || selected?.default_voice || ""}
							>
								<SelectTrigger aria-label="Voice" className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{voiceOptions.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description={
							selected?.supports_cloning
								? "Preset voices; this engine also supports cloning."
								: "Preset voices for this engine."
						}
						title={
							<span className="flex items-center gap-2">
								<HugeiconsIcon
									className="text-muted-foreground"
									icon={VoiceIcon}
									size={16}
								/>
								Voice
							</span>
						}
					/>
				)}
			</SettingsGroup>

			<div className="flex items-center gap-3 px-3 pt-2">
				<button
					className="rounded-md px-2 py-1 text-xs hover:bg-muted/50 disabled:opacity-50"
					disabled={testState === "speaking"}
					onClick={() => {
						handleTest().catch(() => undefined);
					}}
					type="button"
				>
					{testState === "speaking" ? "Speaking…" : "Test voice"}
				</button>
				{selectedRuntimePrompt && (
					<button
						className="rounded-md px-2 py-1 text-xs hover:bg-muted/50 disabled:opacity-50"
						disabled={sidecarPending}
						onClick={() => {
							(engineId === "audiocpp"
								? handleReadyAudioCpp
								: handleReadyRyuTts)().catch(() => undefined);
						}}
						type="button"
					>
						{selectedRuntimePrompt.label}
					</button>
				)}
				{selectedRuntimePrompt && (
					<span className="text-muted-foreground text-xs">
						{engineId === "audiocpp"
							? "Runs PocketTTS and Parakeet through one native runtime."
							: "Unlocks more voices (KittenTTS, Pocket TTS, …)."}
					</span>
				)}
			</div>

			{loadFailed && (
				<div className="flex items-center gap-2 px-3 pt-2">
					<p className="text-destructive text-xs">
						Couldn’t load the voice engines. Check your connection and try
						again.
					</p>
					<button
						className="rounded-md px-2 py-1 text-xs hover:bg-muted/50"
						onClick={() => setReloadNonce((n) => n + 1)}
						type="button"
					>
						Retry
					</button>
				</div>
			)}
			{testFailed && (
				<p className="px-3 pt-2 text-destructive text-xs">
					Couldn’t play the test audio. Make sure the engine is installed and
					running, then try again.
				</p>
			)}

			{models.length > 0 && (
				<div className="px-3 pt-4">
					<p className="mb-2 font-medium text-muted-foreground text-xs">
						Curated voice models
					</p>
					<SettingsGroup>
						{models.map((m) => {
							const isInstallingThis = installing === m.model_name;
							const isBusy = installing !== null;
							let installLabel = "Install";
							if (isInstallingThis) {
								installLabel = "Installing…";
							} else if (isBusy) {
								installLabel = "Waiting…";
							}
							return (
								<SettingsItem
									actions={
										m.installed ? (
											<span className="text-muted-foreground text-xs">
												Installed
											</span>
										) : (
											<button
												className="rounded-md px-2 py-1 text-xs hover:bg-muted/50 disabled:opacity-50"
												disabled={isBusy}
												onClick={() => {
													handleInstall(m).catch(() => undefined);
												}}
												title={
													isBusy && !isInstallingThis
														? "Waiting for the current install to finish…"
														: undefined
												}
												type="button"
											>
												{installLabel}
											</button>
										)
									}
									description={`${m.engine_display_name} · ${m.size_mb} MB · ${m.hf_repo_id}`}
									key={`${m.engine}:${m.model_name}`}
									title={m.display_name}
								/>
							);
						})}
					</SettingsGroup>
					<p className="pt-2 text-muted-foreground text-xs">
						Looking for more? Browse every Hugging Face audio model in the
						Models tab (filter “Audio”). Those need a matching engine to run.
					</p>
				</div>
			)}
		</SettingsSection>
	);
}
