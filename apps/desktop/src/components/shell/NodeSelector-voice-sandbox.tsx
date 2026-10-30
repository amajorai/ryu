import {
	Download04Icon,
	Mic01Icon,
	PackageIcon,
	SparklesIcon,
	VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { startSidecar, stopSidecar } from "@/src/lib/api/plugins.ts";
import {
	DEFAULT_SPEECH_PROCESSING_PREFS,
	DEFAULT_VOICE_PREFS,
	DESKTOP_TTS_ENGINE_KEY,
	DESKTOP_TTS_VOICE_KEY,
	getDesktopTtsEngineOptions,
	getDesktopTtsPrefs,
	SPEECH_PROCESSING_ENGINES,
	setDesktopTtsEngineOptions,
	setDesktopTtsPref,
	setSpeechProcessingPrefs,
	setVoiceInputPrefs,
	subscribeDesktopTtsPrefs,
	VOICE_ENGINES,
} from "@/src/lib/api/preferences.ts";
import { setSandboxBackend } from "@/src/lib/api/sandbox.ts";
import {
	installSpeechProcessingModel,
	type TtsEngine,
} from "@/src/lib/api/voice.ts";
import { uninstallSidecar } from "@/src/lib/services-api.ts";
import {
	type LayerAction,
	type LayerOption,
	NodeLayerMenu,
	startStopAction,
} from "./NodeLayerMenu.tsx";
import { PanelSection } from "./NodePanelNav.tsx";
import { installEngine, useNodeEngines } from "./NodeSelector-engines.tsx";
import {
	SpeechProcessingOptionMenus,
	useVoiceAndSandboxQuery,
} from "./NodeSelector-voice-sandbox-parts.tsx";

/**
 * The remaining swappable layers of a node that aren't catalog sidecars: the
 * Audio engine + voice, the Voice Recognition engine, and the sandbox
 * backend the agent's `sandbox_exec` tool runs in.
 *
 * These share ONE poll (Audio engines + Voice Recognition preference + sandbox backends + a
 * sidecar sample) so adding three layers to the dropdown costs one request, not
 * four. Each layer renders as the same submenu as the engines above it.
 *
 * The sandbox backend answers "which sandbox am I actually using" — it defaults
 * to wasmtime and is distinct from the Running Sandboxes list below, which is
 * the live runs, not the runtime choice.
 */
export function VoiceAndSandboxSection({
	target,
	enabled,
}: {
	target: ApiTarget;
	enabled: boolean;
}) {
	// The Audio default is device-local (localStorage), so it is not reactive on its
	// own — mirror it into state and re-read whenever any surface writes it.
	const tl = useLiteralMessages();
	const [ttsPrefs, setTtsPrefs] = useState(getDesktopTtsPrefs);
	useEffect(
		() => subscribeDesktopTtsPrefs(() => setTtsPrefs(getDesktopTtsPrefs())),
		[]
	);

	// The catalog + live sidecar sample, shared with the Engines section above (same
	// query key ⇒ one poll). Audio, Voice Recognition, and Speech Processing each
	// have their own layer: ASR produces text, Speech Processing optionally cleans
	// it, and Audio speaks it back.
	const { catalog, details, refresh: refreshEngines } = useNodeEngines(target);

	const query = useVoiceAndSandboxQuery(target, enabled);

	const refresh = async () => {
		await Promise.all([query.refetch(), refreshEngines()]);
	};

	const ttsEngines = query.data?.ttsEngines ?? [];
	const sttPrefs = query.data?.sttPrefs ?? DEFAULT_VOICE_PREFS;
	const speechProcessingEngines = query.data?.speechProcessingEngines ?? [];
	const speechProcessingPrefs =
		query.data?.speechProcessingPrefs ?? DEFAULT_SPEECH_PROCESSING_PREFS;
	const sandboxBackends = query.data?.sandboxBackends ?? null;

	/** Start/stop/install one voice sidecar by catalog name, then reconcile. */
	const catalogItem = (name: string) =>
		catalog.find((item) => item.name === name) ?? null;

	const toggleSidecar = async (name: string, label: string, next: boolean) => {
		try {
			if (next) {
				await startSidecar(target, name);
			} else {
				await stopSidecar(target, name);
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: `Couldn't ${next ? "start" : "stop"} ${label}`,
			});
		}
		await refresh();
	};

	/** The install/start action a voice layer needs before it can actually run —
	 *  null once its sidecar is installed AND up. Mirrors the Voice settings tab's
	 *  "Install / Start Ryu Audio engine" prompt, so the dropdown isn't a dead end
	 *  for an engine the node hasn't downloaded yet. */
	const sidecarReadyAction = (
		name: string,
		label: string
	): LayerAction | null => {
		const item = catalogItem(name);
		if (!item) {
			return null;
		}
		if (item.installState !== "installed") {
			return {
				id: `install-${name}`,
				label: `Install ${label}`,
				busyLabel: "Installing…",
				icon: Download04Icon,
				run: async () => {
					await installEngine(target, item, tl);
					await refresh();
				},
			};
		}
		if (!details[name]?.running) {
			return {
				id: `start-${name}`,
				label: `Start ${label}`,
				busyLabel: "Starting…",
				run: () => toggleSidecar(name, label, true),
			};
		}
		return null;
	};

	// ---- Text-to-speech -----------------------------------------------------
	const selectedTts = ttsEngines.find((e) => e.id === ttsPrefs.engine) ?? null;
	const activeVoice = ttsPrefs.voice || selectedTts?.default_voice || "";

	const pickTtsEngine = (engine: TtsEngine) => {
		const engineOptions = getDesktopTtsEngineOptions(engine.id);
		const savedVoice = engineOptions.voice;
		const voice =
			savedVoice && engine.voices.includes(savedVoice)
				? savedVoice
				: engine.voices.includes(activeVoice)
					? activeVoice
					: (engine.default_voice ?? "");
		setDesktopTtsPref(DESKTOP_TTS_ENGINE_KEY, engine.id);
		setDesktopTtsPref(DESKTOP_TTS_VOICE_KEY, voice);
		setDesktopTtsEngineOptions(engine.id, { voice });
	};

	// The multi-engine Audio sidecar that serves every non-built-in voice.
	const ttsReadyAction = sidecarReadyAction("ryutts", "Ryu Audio engine");

	// ---- Speech-to-text -----------------------------------------------------
	const selectedStt =
		VOICE_ENGINES.find((e) => e.engine === sttPrefs.engine) ?? VOICE_ENGINES[0];
	const selectedSttSidecar = selectedStt.sidecar;
	const sttRunning = selectedSttSidecar
		? (details[selectedSttSidecar]?.running ?? false)
		: true;

	const pickStt = async (entry: (typeof VOICE_ENGINES)[number]) => {
		try {
			// Switching engine also moves to that engine's bundled model.
			await setVoiceInputPrefs(target, {
				...sttPrefs,
				engine: entry.engine,
				model: entry.model,
			});
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Couldn't switch voice engine",
			});
		}
		await refresh();
	};

	const toggleStt = (next: boolean) =>
		selectedSttSidecar
			? toggleSidecar(selectedSttSidecar, selectedStt.label, next)
			: Promise.resolve();

	// Transcription needs its sidecar present before Start means anything, so an
	// uninstalled engine offers Install first.
	const sttActions: LayerAction[] = [];
	const sttReady = selectedSttSidecar
		? sidecarReadyAction(selectedSttSidecar, selectedStt.label)
		: null;
	if (sttReady) {
		sttActions.push(sttReady);
	} else {
		sttActions.push(startStopAction(sttRunning, toggleStt));
	}
	const sttInstalled = selectedSttSidecar
		? catalogItem(selectedSttSidecar)?.installState === "installed"
		: true;

	// ---- Speech Processing --------------------------------------------------
	// S1-mini is a separate, lazy local model. Voice Recognition creates the raw
	// transcript; this layer only formats it when Dictation cleanup is enabled.
	const selectedSpeech =
		speechProcessingEngines.find(
			(engine) => engine.id === speechProcessingPrefs.engine
		) ??
		speechProcessingEngines[0] ??
		null;
	const selectedSpeechMeta =
		SPEECH_PROCESSING_ENGINES.find(
			(engine) => engine.engine === speechProcessingPrefs.engine
		) ?? SPEECH_PROCESSING_ENGINES[0];
	const speechInstalled = selectedSpeech?.installed ?? false;
	const speechRunning = selectedSpeech?.loaded ?? false;

	const updateSpeechProcessing = async (
		patch: Partial<typeof speechProcessingPrefs>
	) => {
		try {
			await setSpeechProcessingPrefs(target, {
				...speechProcessingPrefs,
				...patch,
			});
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error ? e.message : "Couldn't update Speech Processing",
			});
		}
		await refresh();
	};

	const pickSpeechProcessing = async (
		entry: (typeof SPEECH_PROCESSING_ENGINES)[number]
	) => {
		await updateSpeechProcessing({ engine: entry.engine });
	};

	const installSpeechProcessing = async () => {
		try {
			await installSpeechProcessingModel(target, speechProcessingPrefs.engine);
			sileo.success({ title: `Installing ${selectedSpeechMeta.label}` });
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: tl("Couldn't install {label}", {
								label: selectedSpeechMeta.label,
							}),
			});
		}
		await refresh();
	};

	const speechInstallAction: LayerAction | null = speechInstalled
		? null
		: {
				id: "install-speech-processing",
				label: `Install ${selectedSpeechMeta.label}`,
				busyLabel: "Installing…",
				icon: Download04Icon,
				run: installSpeechProcessing,
			};
	const speechActions: LayerAction[] = speechInstallAction
		? [speechInstallAction]
		: [
				startStopAction(speechRunning ? true : null, (next) =>
					toggleSidecar(
						selectedSpeechMeta.sidecar,
						selectedSpeechMeta.label,
						next
					)
				),
			];

	// ---- Sandbox backend ----------------------------------------------------
	const activeBackend =
		sandboxBackends?.available.find((b) => b.name === sandboxBackends.active) ??
		null;

	const pickBackend = async (name: string, label: string) => {
		try {
			await setSandboxBackend(target, name);
			sileo.success({ title: `Sandbox → ${label}` });
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: tl("Couldn't switch to {label}", { label }),
			});
		}
		await refresh();
	};

	// Voice Recognition is a fixed, always-valid list, so it shows on any reachable
	// node — its visibility is deliberately NOT tied to the Audio/sandbox probes.
	if (!enabled) {
		return null;
	}

	return (
		<PanelSection>
			{ttsEngines.length > 0 && (
				<NodeLayerMenu
					// The extra (non-built-in) voices only exist once the `ryutts`
					// sidecar is installed and up, so surface that bring-up here rather
					// than sending the user to the Voice settings tab for it.
					actions={ttsReadyAction ? [ttsReadyAction] : []}
					caption={
						selectedTts
							? tl("Speaks as {voice}", {
									voice: activeVoice || "default voice",
								})
							: "Engine not available on this computer"
					}
					currentLabel={selectedTts?.display_name ?? ttsPrefs.engine}
					icon={VolumeHighIcon}
					installed={ttsEngines.map(
						(engine): LayerOption => ({
							name: engine.id,
							label: engine.display_name,
							active: engine.id === ttsPrefs.engine,
							detail: engine.installed
								? `${engine.voices.length} voices`
								: "not installed",
							select: () => pickTtsEngine(engine),
						})
					)}
					label="Audio"
					running={selectedTts?.loaded ?? null}
					trailing={selectedTts?.display_name ?? ttsPrefs.engine}
				>
					{/* The voice is a second dimension of the SAME layer, so it nests
						    inside the engine's submenu instead of claiming a sibling row. */}
					{selectedTts && selectedTts.voices.length > 0 && (
						<NodeLayerMenu
							currentLabel={activeVoice || "Default"}
							installed={selectedTts.voices.map(
								(voice): LayerOption => ({
									name: voice,
									label: voice,
									active: voice === activeVoice,
									select: () => {
										setDesktopTtsPref(DESKTOP_TTS_VOICE_KEY, voice);
										setDesktopTtsEngineOptions(ttsPrefs.engine, { voice });
										return Promise.resolve();
									},
								})
							)}
							label="Voice"
						/>
					)}
				</NodeLayerMenu>
			)}
			{speechProcessingEngines.length > 0 && (
				<NodeLayerMenu
					actions={speechActions}
					available={
						speechInstalled
							? []
							: SPEECH_PROCESSING_ENGINES.map(
									(entry): LayerOption => ({
										name: entry.engine,
										label: entry.label,
										detail: `${entry.model} · 484 MB`,
										select: installSpeechProcessing,
									})
								)
					}
					caption={
						speechInstalled
							? "Optional cleanup after Voice Recognition · off in Dictation settings"
							: "S1-mini model is not installed on this computer"
					}
					currentLabel={
						selectedSpeech?.display_name ?? selectedSpeechMeta.label
					}
					icon={SparklesIcon}
					installed={
						speechInstalled
							? SPEECH_PROCESSING_ENGINES.map(
									(entry): LayerOption => ({
										name: entry.engine,
										label: entry.label,
										active: entry.engine === speechProcessingPrefs.engine,
										detail: selectedSpeech?.model ?? entry.model,
										select: () => pickSpeechProcessing(entry),
									})
								)
							: []
					}
					label="Speech Processing"
					running={speechRunning ? true : null}
					trailing={speechInstalled ? "ready" : "install"}
				>
					{speechInstalled && (
						<SpeechProcessingOptionMenus
							speechProcessingPrefs={speechProcessingPrefs}
							updateSpeechProcessing={updateSpeechProcessing}
						/>
					)}
				</NodeLayerMenu>
			)}
			<NodeLayerMenu
				actions={sttActions}
				caption={
					sttInstalled
						? tl("Transcribes with {model}", { model: sttPrefs.model })
						: "Engine not installed on this computer"
				}
				currentLabel={selectedStt.label}
				icon={Mic01Icon}
				installed={VOICE_ENGINES.map((entry): LayerOption => {
					const item = entry.sidecar ? catalogItem(entry.sidecar) : null;
					let detail = entry.model;
					if (entry.sidecar && details[entry.sidecar]?.running) {
						detail = "running";
					} else if (item && item.installState !== "installed") {
						detail = "not installed";
					}
					return {
						name: entry.engine,
						label: entry.label,
						active: entry.engine === sttPrefs.engine,
						detail,
						select: () => pickStt(entry),
						// Only the engine that is NOT selected is removable — dropping
						// the one transcription is bound to would break voice input.
						uninstall:
							entry.engine === sttPrefs.engine || !item
								? undefined
								: async () => {
										await uninstallSidecar(
											target.url,
											target.token,
											item.name,
											target.userJwt
										);
										await refresh();
									},
					};
				})}
				label="Voice Recognition"
				running={sttRunning}
			/>
			{sandboxBackends && (
				// Which isolated runtime `sandbox_exec` uses by default. wasmtime is
				// the built-in; a per-call `backend` argument still overrides this.
				<NodeLayerMenu
					caption={
						activeBackend?.detected
							? "Default runtime for sandboxed execution"
							: "Runtime not detected on this computer"
					}
					currentLabel={activeBackend?.displayName ?? "None"}
					icon={PackageIcon}
					installed={sandboxBackends.available.map(
						(backend): LayerOption => ({
							name: backend.name,
							label: backend.displayName,
							active: backend.name === sandboxBackends.active,
							detail: backend.detected ? "ready" : "not detected",
							disabled: !backend.supported,
							disabledReason: "unsupported here",
							select: () => pickBackend(backend.name, backend.displayName),
						})
					)}
					label="Sandbox"
					running={activeBackend?.detected ?? null}
				/>
			)}
		</PanelSection>
	);
}
