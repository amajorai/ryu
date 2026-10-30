import { useEffect, useMemo, useState } from "react";
import { useAgents } from "@/src/hooks/useAgents.ts";
import {
	DEFAULT_AGENT_ID,
	DEFAULT_ISLAND_COMMAND_SHORTCUT,
	DEFAULT_ISLAND_TTS_PREFS,
	DEFAULT_VOICE_PREFS,
	getIslandAgentPrefs,
	getIslandCommandShortcut,
	getIslandTtsPrefs,
	getVoiceInputPrefs,
	type IslandAgentPrefs,
	type IslandTtsPrefs,
	setIslandAgentPrefs,
	setIslandCommandShortcut,
	setIslandTtsPrefs,
	setVoiceInputPrefs,
	VOICE_ENGINES,
	type VoiceEngine,
	type VoiceInputPrefs,
} from "@/src/lib/api/preferences.ts";
import { listTtsEngines, type TtsEngine } from "@/src/lib/api/voice.ts";
import {
	type IslandTargetGetter,
	LOCAL_MODEL_OPTION,
	type PersistIslandPreferenceChange,
} from "./IslandSettings-constants.ts";

/**
 * Island conversation, shortcut, Voice Recognition, and read-back preferences,
 * each loaded from Core on mount and written back optimistically.
 */
export function useIslandVoicePrefs(
	getTarget: IslandTargetGetter,
	persistPreferenceChange: PersistIslandPreferenceChange
) {
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

	return {
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
	};
}

export type IslandVoicePrefsState = ReturnType<typeof useIslandVoicePrefs>;
