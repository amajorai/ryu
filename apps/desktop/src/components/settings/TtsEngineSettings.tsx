// apps/desktop/src/components/settings/TtsEngineSettings.tsx
//
// Configures the default speech engine, per-engine generation options, and voice test.
// The engine set is whatever Core returns from `/api/voice/tts-engines` (the
// built-in OuteTTS, native audio.cpp, plus whatever the universal Ryu TTS sidecar registry serves)
// — nothing is hardcoded here, this is a GUI layer over the Core data path. The
// choice is persisted to localStorage and shared by desktop speech controls.

import { VoiceIcon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	EnumField,
	FieldGrid,
	FieldGroup,
	NumberField,
	TextField,
} from "@/src/components/inference/fields.tsx";
import { useVoiceAuthority } from "@/src/hooks/useVoiceAuthority.ts";
import { useSpeechPlayback } from "@/src/hooks/useSpeechPlayback.ts";
import { useVoiceEngines } from "@/src/hooks/useVoiceEngines.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	DESKTOP_TTS_ENGINE_KEY,
	DESKTOP_TTS_VOICE_KEY,
	type DesktopTtsEngineOptions,
	getDesktopTtsEngineOptions,
	getDesktopTtsPrefs,
	setDesktopTtsEngineOptions,
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

export function TtsEngineSettings({
	sectionTitle = "Audio",
}: {
	sectionTitle?: string | null;
} = {}) {
	const { authority, isCurrent } = useVoiceAuthority("tts-settings");
	const node = authority.node;
	const target = useMemo(
		() => toTarget(node),
		[node.url, node.token, node.userJwt]
	);
	const [engineView, setEngineView] = useState({
		authority,
		items: [] as TtsEngine[],
	});
	const engines = engineView.authority === authority ? engineView.items : [];
	const [engineId, setEngineId] = useState<string>(
		() => getDesktopTtsPrefs().engine
	);
	const [voice, setVoice] = useState<string>(() => {
		const prefs = getDesktopTtsPrefs();
		return getDesktopTtsEngineOptions(prefs.engine).voice ?? prefs.voice;
	});
	const [speechOptions, setSpeechOptions] = useState(() =>
		getDesktopTtsEngineOptions(getDesktopTtsPrefs().engine)
	);
	const [speechSpeedError, setSpeechSpeedError] = useState<string | null>(null);

	// The node selector's Audio layer writes the same two keys, so pull
	// them back in when it changes them while this screen is open.
	useEffect(
		() =>
			subscribeDesktopTtsPrefs(() => {
				const next = getDesktopTtsPrefs();
				const engineOptions = getDesktopTtsEngineOptions(next.engine);
				setEngineId(next.engine);
				setVoice(engineOptions.voice ?? next.voice);
				setSpeechOptions(engineOptions);
				setSpeechSpeedError(null);
			}),
		[]
	);
	const [engineFailure, setEngineFailure] = useState({
		authority,
		failed: false,
	});
	const loadFailed =
		engineFailure.authority === authority && engineFailure.failed;
	const [reloadNonce, setReloadNonce] = useState(0);
	const [testState, setTestState] = useState<"idle" | "speaking">("idle");
	const [testFailed, setTestFailed] = useState(false);
	const [modelView, setModelView] = useState({
		authority,
		items: [] as TtsModel[],
		known: false,
		error: null as string | null,
	});
	const models = modelView.authority === authority ? modelView.items : [];
	const modelsKnown = modelView.authority === authority && modelView.known;
	const modelError = modelView.authority === authority ? modelView.error : null;
	const [actionView, setActionView] = useState({
		authority,
		error: null as string | null,
	});
	const actionError =
		actionView.authority === authority ? actionView.error : null;
	const modelReads = useRef(0);
	const modelReadReady = useRef<{
		authority: typeof authority;
		known: boolean;
	}>({ authority, known: false });
	const modelWrite = useRef<object | null>(null);
	const runtimeWrite = useRef<object | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
	const { play: playSpeech } = useSpeechPlayback();
	// The optional multi-engine TTS sidecar ("ryutts"), installed/started right
	// here at the point of use rather than from a separate Services page.
	const [sidecarPending, setSidecarPending] = useState(false);
	const {
		engines: voiceSidecars,
		error: runtimeError,
		loading: runtimeLoading,
		reload: reloadRuntime,
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

	const refreshModels = useCallback(async () => {
		if (!isCurrent()) return;
		const sequence = ++modelReads.current;
		modelReadReady.current = { authority, known: false };
		const live = () => isCurrent() && sequence === modelReads.current;
		setModelView((old) => ({
			authority,
			items: old.authority === authority ? old.items : [],
			known: false,
			error: null,
		}));
		try {
			const items = await listTtsModels(target);
			if (live()) {
				modelReadReady.current = { authority, known: true };
				setModelView({ authority, items, known: true, error: null });
			}
		} catch {
			if (live())
				setModelView((old) => ({
					authority,
					items: old.authority === authority ? old.items : [],
					known: false,
					error:
						"Couldn’t load the voice models. Retry to confirm installed models.",
				}));
		}
	}, [target, authority]);

	useEffect(() => {
		modelWrite.current = null;
		runtimeWrite.current = null;
		setInstalling(null);
		setSidecarPending(false);
		setActionView({ authority, error: null });
	}, [authority]);
	useEffect(() => {
		let cancelled = false;
		setEngineFailure({ authority, failed: false });
		listTtsEngines(target)
			.then((items) => {
				if (!cancelled && isCurrent()) {
					setEngineView({ authority, items });
					setEngineFailure({ authority, failed: false });
				}
			})
			.catch(() => {
				if (!cancelled && isCurrent())
					setEngineFailure({ authority, failed: true });
			});
		void refreshModels();
		return () => {
			cancelled = true;
		};
	}, [target, authority, refreshModels, reloadNonce]);

	const readyRuntime = useCallback(
		async (name: string) => {
			const engine = voiceSidecars.find((entry) => entry.name === name);
			if (
				!engine ||
				!isCurrent() ||
				runtimeWrite.current ||
				runtimeLoading ||
				!engine.runningKnown
			)
				return;
			const ticket = {};
			runtimeWrite.current = ticket;
			setSidecarPending(true);
			setActionView({ authority, error: null });
			try {
				if (engine.installState !== "installed")
					await installVoiceSidecar(name);
				else if (!engine.running) await setVoiceRunning(name, true);
				if (!isCurrent()) return;
				setReloadNonce((n) => n + 1);
			} catch {
				if (isCurrent())
					setActionView({
						authority,
						error:
							engine.installState !== "installed"
								? "Couldn’t install the audio runtime. Try again."
								: "Couldn’t start the audio runtime. Try again.",
					});
			} finally {
				if (runtimeWrite.current === ticket) {
					runtimeWrite.current = null;
					if (isCurrent()) setSidecarPending(false);
				}
			}
		},
		[
			voiceSidecars,
			runtimeLoading,
			authority,
			installVoiceSidecar,
			setVoiceRunning,
			refreshModels,
		]
	);
	const handleReadyRyuTts = useCallback(
		() => readyRuntime("ryutts"),
		[readyRuntime]
	);
	const handleReadyAudioCpp = useCallback(
		() => readyRuntime("audiocpp"),
		[readyRuntime]
	);

	const handleInstall = useCallback(
		async (model: TtsModel) => {
			if (
				!isCurrent() ||
				modelWrite.current ||
				!modelsKnown ||
				modelReadReady.current.authority !== authority ||
				!modelReadReady.current.known
			)
				return;
			const ticket = {};
			modelWrite.current = ticket;
			setInstalling(model.model_name);
			setActionView({ authority, error: null });
			try {
				await installTtsModel(target, model.engine, model.model_name);
				if (isCurrent()) {
					setModelView((old) =>
						old.authority === authority ? { ...old, known: false } : old
					);
					await refreshModels();
				}
			} catch {
				if (isCurrent())
					setActionView({
						authority,
						error: "Couldn’t install the voice model. Try again.",
					});
			} finally {
				if (modelWrite.current === ticket) {
					modelWrite.current = null;
					if (isCurrent()) setInstalling(null);
				}
			}
		},
		[target, authority, modelsKnown, refreshModels]
	);

	const selected = useMemo(
		() => engines.find((e) => e.id === engineId),
		[engines, engineId]
	);
	const supportsSpeechRate = engineId !== "outetts";
	const supportsLanguage =
		engineId === "audiocpp" ||
		(engineId !== "outetts" && engineId !== "gateway");

	const handleEngine = (value: string | null) => {
		if (value === null) {
			return;
		}
		const nextEngine = engines.find((engine) => engine.id === value);
		const saved = getDesktopTtsEngineOptions(value);
		const nextVoice =
			saved.voice && nextEngine?.voices.includes(saved.voice)
				? saved.voice
				: (nextEngine?.default_voice ?? "");
		const nextOptions: DesktopTtsEngineOptions = {
			...saved,
			voice: nextVoice,
			speed: value === "outetts" ? undefined : saved.speed,
			language:
				(value === "audiocpp" ||
					(value !== "outetts" && value !== "gateway")) &&
				saved.language &&
				nextEngine?.languages.includes(saved.language)
					? saved.language
					: undefined,
			referenceAudio: nextEngine?.supports_cloning
				? saved.referenceAudio
				: undefined,
		};
		setEngineId(value);
		setDesktopTtsPref(DESKTOP_TTS_ENGINE_KEY, value);
		setVoice(nextVoice);
		setDesktopTtsPref(DESKTOP_TTS_VOICE_KEY, nextVoice);
		setDesktopTtsEngineOptions(value, nextOptions);
		setSpeechOptions(nextOptions);
		setSpeechSpeedError(null);
	};

	const handleVoice = (value: string | null) => {
		if (value === null) {
			return;
		}
		setVoice(value);
		setDesktopTtsPref(DESKTOP_TTS_VOICE_KEY, value);
		setDesktopTtsEngineOptions(engineId, { voice: value });
	};

	const updateSpeechOptions = (patch: Partial<DesktopTtsEngineOptions>) => {
		setSpeechOptions((current) => ({ ...current, ...patch }));
		setDesktopTtsEngineOptions(engineId, patch);
	};

	const updateSpeechSpeed = (speed: number | undefined) => {
		if (speed !== undefined && (speed < 0.25 || speed > 4)) {
			setSpeechSpeedError("Speaking speed must be between 0.25 and 4.");
			return;
		}
		setSpeechSpeedError(null);
		updateSpeechOptions({ speed });
	};

	const handleTest = useCallback(async () => {
		setTestFailed(false);
		setTestState("speaking");
		try {
			await playSpeech(
				`${engineId}:${voice}:${SAMPLE_TEXT}`,
				() =>
					speakText(target, SAMPLE_TEXT, {
						engine: engineId,
						language: speechOptions.language,
						referenceAudio: speechOptions.referenceAudio,
						speed: speechOptions.speed,
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
	}, [engineId, speechOptions, target, voice, playSpeech]);

	const voices = selected?.voices ?? [];
	// Prompt to install/start the ryutts sidecar until it is both installed and
	// running; the extra engines only appear in the picker once it is up.
	const ryuTtsPrompt = useMemo(() => {
		if (!ryutts) {
			return null;
		}
		if (!ryutts.runningKnown) return { label: "Audio runtime status unknown" };
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
		if (!audiocpp.runningKnown)
			return { label: "Audio runtime status unknown" };
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
		<SettingsSection title={sectionTitle ?? undefined}>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							items={engineOptions}
							onValueChange={handleEngine}
							value={engineId}
						>
							<SelectTrigger aria-label="Audio engine" className="h-8 w-56">
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
								<SelectTrigger aria-label="Voice" className="h-8 w-56">
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

			{selected && engineId === "outetts" ? (
				<p className="px-3 pt-4 text-muted-foreground text-xs">
					OuteTTS uses its bundled model voice and does not accept speech-rate,
					language, or cloning overrides.
				</p>
			) : null}
			{selected && engineId === "gateway" ? (
				<p className="px-3 pt-4 text-muted-foreground text-xs">
					The Gateway provider chooses language. Voice and speaking speed are
					forwarded when the provider supports them.
				</p>
			) : null}
			{selected &&
			(supportsSpeechRate ||
				(supportsLanguage && selected.languages.length > 0) ||
				selected.supports_cloning) ? (
				<div className="px-3 pt-4">
					<FieldGroup
						description="Defaults are saved for this speech engine. Leave a field blank to use the engine default."
						title="Generation defaults"
					>
						<FieldGrid>
							{supportsSpeechRate ? (
								<NumberField
									hint="Speaking-rate multiplier when supported by the engine."
									label="Speaking speed"
									max={4}
									min={0.25}
									onChange={updateSpeechSpeed}
									step={0.05}
									value={speechOptions.speed}
								/>
							) : null}
							{supportsLanguage && selected.languages.length > 0 ? (
								<EnumField
									label="Language"
									onChange={(language) =>
										updateSpeechOptions({ language: language ?? undefined })
									}
									options={selected.languages.map((language) => ({
										value: language,
										label: language,
									}))}
									value={speechOptions.language}
								/>
							) : null}
							{selected.supports_cloning ? (
								<TextField
									hint="Path to a voice sample managed by the connected node."
									label="Reference audio path"
									onChange={(referenceAudio) =>
										updateSpeechOptions({
											referenceAudio: referenceAudio || undefined,
										})
									}
									value={speechOptions.referenceAudio}
								/>
							) : null}
						</FieldGrid>
						{speechSpeedError ? (
							<p aria-live="polite" className="text-status-destructive text-xs">
								{speechSpeedError}
							</p>
						) : null}
					</FieldGroup>
				</div>
			) : null}

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
						disabled={sidecarPending || runtimeLoading || Boolean(runtimeError)}
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

			{actionError && (
				<p role="alert" className="px-3 pt-2 text-status-destructive text-xs">
					{actionError}
				</p>
			)}
			{runtimeError && (
				<div className="flex items-center gap-2 px-3 pt-2">
					<p role="alert" className="text-status-destructive text-xs">
						{runtimeError}
					</p>
					<button
						type="button"
						aria-label="Retry loading voice runtime status"
						className="rounded-md px-2 py-1 text-xs hover:bg-muted/50"
						onClick={() => {
							void reloadRuntime().then(() => {
								if (isCurrent()) setReloadNonce((n) => n + 1);
							});
						}}
					>
						Retry
					</button>
				</div>
			)}
			{modelError && (
				<div className="flex items-center gap-2 px-3 pt-2">
					<p role="alert" className="text-status-destructive text-xs">
						{modelError}
					</p>
					<button
						type="button"
						aria-label="Retry loading voice models"
						className="rounded-md px-2 py-1 text-xs hover:bg-muted/50"
						onClick={() => {
							void refreshModels();
						}}
					>
						Retry
					</button>
				</div>
			)}

			{loadFailed && (
				<div className="flex items-center gap-2 px-3 pt-2">
					<p className="text-status-destructive text-xs">
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
				<p className="px-3 pt-2 text-status-destructive text-xs">
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
												disabled={isBusy || !modelsKnown}
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
