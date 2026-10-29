import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { AudioDevicesSettings } from "../../src/components/settings/AudioDevicesSettings.tsx";
import { TtsEngineSettings } from "../../src/components/settings/TtsEngineSettings.tsx";
import { VoiceInputSettings } from "../../src/components/settings/VoiceInputSettings.tsx";
import { VoiceModeDisplaySettings } from "../../src/components/settings/VoiceModeDisplaySettings.tsx";
import { VoiceReadbackSettings } from "../../src/components/settings/VoiceReadbackSettings.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { type ProofJsonRecord, parseProofJsonRecord } from "../fixture-json.ts";
import "../../src/index.css";

interface ProofCall {
	body: unknown;
	method: string;
	path: string;
}

interface MicrophonePrivacySettingsCall {
	args: { capability: "microphone" };
	command: "open_privacy_settings";
}

interface ProofWindow extends Window {
	__TAURI_INTERNALS__?: {
		invoke: (command: string, args?: ProofJsonRecord) => Promise<null>;
		transformCallback: () => number;
	};
	__voiceProof?: {
		calls: ProofCall[];
		microphoneGranted: boolean;
		openExternalUrls: string[];
		privacySettingsCalls: MicrophonePrivacySettingsCall[];
		permissionRequests: number;
		sinkIds: string[];
		stoppedTracks: number;
		playbackPending: boolean;
		completePlayback: () => void;
		setMicrophoneGranted: (granted: boolean) => void;
	};
}

interface VoicePrefs {
	enabled: boolean;
	engine: string;
	mode: string;
	model: string;
	shortcut: string;
}

interface CatalogSidecar {
	category: "voice";
	deprecated: boolean;
	description: string;
	display_name: string;
	install_state: "not_installed" | "installed";
	installed_version: string | null;
	latest_version: string | null;
	name: string;
	platforms: string[];
	recommended: boolean;
	supported: boolean;
	update_available: boolean;
}

interface CuratedTtsModel {
	default: boolean;
	display_name: string;
	engine: string;
	engine_display_name: string;
	hf_repo_id: string;
	installed: boolean;
	languages: string[];
	model_name: string;
	size_mb: number;
}

// SAFETY: This write view publishes the local proofState arrays, scalar getters, and two callbacks below before rendering; captured request bodies stay unknown. The installed bridge has only the local null result.
const proofWindow = window as ProofWindow;
const privacySettingsCalls: MicrophonePrivacySettingsCall[] = [];
let finishPendingPlayback: (() => void) | null = null;
const proofState: Pick<
	NonNullable<ProofWindow["__voiceProof"]>,
	| "calls"
	| "microphoneGranted"
	| "openExternalUrls"
	| "permissionRequests"
	| "sinkIds"
	| "stoppedTracks"
> = {
	calls: [],
	microphoneGranted:
		new URLSearchParams(location.search).get("mic") !== "denied",
	openExternalUrls: [],
	permissionRequests: 0,
	sinkIds: [],
	stoppedTracks: 0,
};
proofWindow.__voiceProof = {
	calls: proofState.calls,
	get microphoneGranted() {
		return proofState.microphoneGranted;
	},
	openExternalUrls: proofState.openExternalUrls,
	privacySettingsCalls,
	get permissionRequests() {
		return proofState.permissionRequests;
	},
	sinkIds: proofState.sinkIds,
	get stoppedTracks() {
		return proofState.stoppedTracks;
	},
	get playbackPending() {
		return finishPendingPlayback !== null;
	},
	completePlayback: () => {
		const finish = finishPendingPlayback;
		finishPendingPlayback = null;
		finish?.();
	},
	setMicrophoneGranted: (granted) => {
		proofState.microphoneGranted = granted;
	},
};

const tauriCalls: string[] = [];
proofWindow.__TAURI_INTERNALS__ = {
	invoke: async (command, args) => {
		tauriCalls.push(command);
		if (command === "open_privacy_settings") {
			if (args?.capability !== "microphone" || Object.keys(args).length !== 1) {
				throw new Error("Unexpected microphone privacy-settings arguments");
			}
			privacySettingsCalls.push({
				command,
				args: { capability: "microphone" },
			});
		}
		if (command === "open_external" && isNativeText(args?.url)) {
			proofState.openExternalUrls.push(args.url);
		}
		return null;
	},
	transformCallback: () => 0,
};

const audioDevices = {
	enumerateDevices: async () => [
		{
			deviceId: "mic-built-in",
			kind: "audioinput",
			label: "MacBook Pro Microphone",
		},
		{ deviceId: "mic-usb", kind: "audioinput", label: "USB Studio Mic" },
		{
			deviceId: "speaker-built-in",
			kind: "audiooutput",
			label: "MacBook Pro Speakers",
		},
		{ deviceId: "speaker-usb", kind: "audiooutput", label: "USB Headphones" },
		{ deviceId: "camera", kind: "videoinput", label: "Camera" },
	],
	getUserMedia: async () => {
		proofState.permissionRequests += 1;
		if (!proofState.microphoneGranted) {
			throw new DOMException("Permission denied", "NotAllowedError");
		}
		return {
			getTracks: () => [
				{
					stop: () => {
						proofState.stoppedTracks += 1;
					},
				},
			],
		};
	},
};
Object.defineProperty(navigator, "mediaDevices", {
	configurable: true,
	value: audioDevices,
});
HTMLMediaElement.prototype.play = async () => {
	if (
		new URLSearchParams(location.search).get("scenario") !== "tts-play-pending"
	) {
		return;
	}
	await new Promise<void>((resolve) => {
		finishPendingPlayback = resolve;
	});
};
Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
	configurable: true,
	value: async (deviceId: string) => {
		proofState.sinkIds.push(deviceId);
	},
});

const makeEngine = (
	id: string,
	displayName: string,
	voices: string[],
	defaultVoice: string,
	installed = true,
	options: { languages?: string[]; supportsCloning?: boolean } = {}
) => ({
	default_voice: defaultVoice,
	description:
		id === "gateway"
			? "Routed to this node's audio provider · no local model"
			: `${displayName} speech synthesis runtime`,
	display_name: displayName,
	id,
	installed,
	languages: options.languages ?? ["en"],
	loaded: true,
	sample_rate: 24_000,
	size_mb: 12,
	supports_cloning: options.supportsCloning ?? false,
	voices,
});

const baseEngines = [
	makeEngine("outetts", "OuteTTS (built-in)", [], "", true),
	makeEngine("audiocpp", "audio.cpp", ["alba"], "alba", false, {
		languages: ["en", "de", "it", "pt", "es"],
		supportsCloning: true,
	}),
	makeEngine(
		"gateway",
		"Cloud (via gateway)",
		["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
		"alloy"
	),
];
const sidecarEngines = [
	makeEngine(
		"kokoro",
		"Kokoro 82M",
		[
			"af_heart",
			"af_alloy",
			"af_aoede",
			"af_bella",
			"af_jessica",
			"af_kore",
			"af_nicole",
			"af_nova",
			"af_river",
			"af_sarah",
			"af_sky",
			"am_adam",
			"am_echo",
			"am_eric",
			"am_fenrir",
			"am_liam",
			"am_michael",
			"am_onyx",
			"am_puck",
			"am_santa",
			"bf_alice",
			"bf_emma",
			"bf_isabella",
			"bf_lily",
			"bm_daniel",
			"bm_fable",
			"bm_george",
			"bm_lewis",
		],
		"af_heart"
	),
	makeEngine(
		"kitten",
		"KittenTTS",
		["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"],
		"Jasper"
	),
	makeEngine(
		"pocket",
		"Pocket TTS (Kyutai)",
		[
			"alba",
			"giovanni",
			"lola",
			"juergen",
			"rafael",
			"estelle",
			"anna",
			"azelma",
			"charles",
			"cosette",
			"eve",
			"fantine",
			"george",
			"jane",
			"jean",
			"javert",
			"marius",
			"mary",
			"michael",
			"paul",
			"vera",
		],
		"alba"
	),
];

const voicePrefsSchema = z.object({
	enabled: z.boolean(),
	engine: z.string(),
	mode: z.string(),
	model: z.string(),
	shortcut: z.string(),
}) satisfies z.ZodType<VoicePrefs>;
const readbackSchema = z.object({ enabled: z.boolean() });
const catalogSchema = z.array(
	z.object({
		category: z.literal("voice"),
		deprecated: z.boolean(),
		description: z.string(),
		display_name: z.string(),
		install_state: z.enum(["not_installed", "installed"]),
		installed_version: z.string().nullable(),
		latest_version: z.string().nullable(),
		name: z.string(),
		platforms: z.array(z.string()),
		recommended: z.boolean(),
		supported: z.boolean(),
		update_available: z.boolean(),
	})
) satisfies z.ZodType<CatalogSidecar[]>;
const modelsSchema = z.array(
	z.object({
		default: z.boolean(),
		display_name: z.string(),
		engine: z.string(),
		engine_display_name: z.string(),
		hf_repo_id: z.string(),
		installed: z.boolean(),
		languages: z.array(z.string()),
		model_name: z.string(),
		size_mb: z.number(),
	})
) satisfies z.ZodType<CuratedTtsModel[]>;
function readFixture<T>(key: string, fallback: T, schema: z.ZodType<T>): T {
	try {
		const value = localStorage.getItem(key);
		return value ? schema.parse(JSON.parse(value)) : fallback;
	} catch {
		return fallback;
	}
}

function writeFixture<FixturePayload>(
	key: string,
	value: FixturePayload
): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// The harness still exercises the visible state if browser storage is disabled.
	}
}

let voicePrefs: VoicePrefs = readFixture(
	"proof:core:voice-input",
	{
		enabled: true,
		engine: "parakeet",
		mode: "toggle",
		model: "parakeet-tdt-0.6b-v3",
		shortcut: "CommandOrControl+Shift+A",
	},
	voicePrefsSchema
);
let readbackPrefs = readFixture(
	"proof:core:voice-mode-readback",
	{
		enabled: false,
	},
	readbackSchema
);
let engineLoadFailures =
	new URLSearchParams(location.search).get("scenario") === "tts-load-error"
		? 1
		: 0;
const initialCatalog: CatalogSidecar[] = ["ryutts", "audiocpp"].map((name) => ({
	category: "voice",
	deprecated: false,
	description: `${name} optional audio runtime`,
	display_name: name === "ryutts" ? "Ryu Audio engine" : "audio.cpp runtime",
	installed_version: null,
	install_state: "not_installed",
	latest_version: "1.0.0",
	name,
	platforms: [],
	recommended: true,
	supported: true,
	update_available: false,
}));
let catalog = readFixture("proof:catalog", initialCatalog, catalogSchema);
let sidecarRunning = readFixture(
	"proof:sidecars-running",
	{
		audiocpp: false,
		ryutts: false,
	},
	z.object({ audiocpp: z.boolean(), ryutts: z.boolean() })
);
const initialCuratedModels: CuratedTtsModel[] = [
	{
		default: true,
		display_name: "PocketTTS English Q8_0 (audio.cpp)",
		engine: "audiocpp",
		engine_display_name: "audio.cpp",
		hf_repo_id: "audio-cpp/audio.cpp-gguf",
		installed: false,
		languages: ["en", "de", "it", "pt", "es"],
		model_name: "pocket_tts_english_q8_0",
		size_mb: 1040,
	},
];
const sidecarCuratedModels: CuratedTtsModel[] = [
	{
		default: true,
		display_name: "Kokoro 82M (v1.0)",
		engine: "kokoro",
		engine_display_name: "Kokoro 82M",
		hf_repo_id: "onnx-community/Kokoro-82M-v1.0-ONNX",
		installed: false,
		languages: ["en", "es", "fr", "hi", "it", "ja", "pt", "zh"],
		model_name: "kokoro-82m-v1.0",
		size_mb: 310,
	},
	{
		default: true,
		display_name: "KittenTTS Mini (80M)",
		engine: "kitten",
		engine_display_name: "KittenTTS",
		hf_repo_id: "KittenML/kitten-tts-mini-0.8",
		installed: false,
		languages: ["en"],
		model_name: "kitten-tts-mini-0.8",
		size_mb: 80,
	},
	{
		default: false,
		display_name: "KittenTTS Nano (15M)",
		engine: "kitten",
		engine_display_name: "KittenTTS",
		hf_repo_id: "KittenML/kitten-tts-nano-0.1",
		installed: false,
		languages: ["en"],
		model_name: "kitten-tts-nano-0.1",
		size_mb: 25,
	},
	{
		default: true,
		display_name: "Pocket TTS (100M)",
		engine: "pocket",
		engine_display_name: "Pocket TTS (Kyutai)",
		hf_repo_id: "kyutai/pocket-tts-without-voice-cloning",
		installed: false,
		languages: ["en"],
		model_name: "pocket-tts",
		size_mb: 100,
	},
];
let models = readFixture<CuratedTtsModel[]>(
	"proof:tts-models",
	initialCuratedModels,
	modelsSchema
);

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function bodyRecord(body: BodyInit | null | undefined): ProofJsonRecord {
	if (!isNativeText(body)) {
		return {};
	}
	try {
		return parseProofJsonRecord(body);
	} catch {
		return {};
	}
}

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const requestUrl = new URL(rawUrl, window.location.href);
	const method = (init?.method ?? "GET").toUpperCase();
	const path = requestUrl.pathname;
	const requestBody = bodyRecord(init?.body);
	if (!path.startsWith("/api/")) {
		return nativeFetch(input, init);
	}
	proofState.calls.push({ body: requestBody, method, path });

	if (path === "/api/preferences/voice-input") {
		if (method === "PUT") {
			try {
				voicePrefs = voicePrefsSchema.parse(
					JSON.parse(String(requestBody.value))
				);
				writeFixture("proof:core:voice-input", voicePrefs);
			} catch {
				return jsonResponse({ error: "Invalid voice-input preference" }, 400);
			}
		}
		return jsonResponse({
			key: "voice-input",
			value: JSON.stringify(voicePrefs),
		});
	}
	if (path === "/api/preferences/voice-mode-readback") {
		if (method === "PUT") {
			try {
				readbackPrefs = readbackSchema.parse(
					JSON.parse(String(requestBody.value))
				);
				writeFixture("proof:core:voice-mode-readback", readbackPrefs);
			} catch {
				return jsonResponse({ error: "Invalid read-back preference" }, 400);
			}
		}
		return jsonResponse({
			key: "voice-mode-readback",
			value: JSON.stringify(readbackPrefs),
		});
	}
	if (path === "/api/voice/tts-engines") {
		if (engineLoadFailures > 0) {
			engineLoadFailures -= 1;
			return jsonResponse({ error: "Fixture engine-list outage" }, 503);
		}
		const readyEngines = catalog.some(
			(entry) =>
				entry.name === "ryutts" &&
				entry.install_state === "installed" &&
				sidecarRunning.ryutts
		)
			? [...baseEngines, ...sidecarEngines]
			: baseEngines;
		return jsonResponse({
			data: readyEngines.map((engine) =>
				engine.id === "audiocpp"
					? {
							...engine,
							installed:
								catalog.some(
									(entry) =>
										entry.name === "audiocpp" &&
										entry.install_state === "installed"
								) && sidecarRunning.audiocpp,
						}
					: engine
			),
		});
	}
	if (path === "/api/voice/tts-models") {
		const ryuttsReady = catalog.some(
			(entry) =>
				entry.name === "ryutts" &&
				entry.install_state === "installed" &&
				sidecarRunning.ryutts
		);
		if (ryuttsReady) {
			const existingModelNames = new Set(
				models.map((model) => model.model_name)
			);
			models = [
				...models,
				...sidecarCuratedModels.filter(
					(model) => !existingModelNames.has(model.model_name)
				),
			];
			writeFixture("proof:tts-models", models);
		}
		return jsonResponse({ data: models });
	}
	if (path === "/api/voice/tts-models/install" && method === "POST") {
		const modelName = String(requestBody.model_name ?? "");
		models = models.map((model) =>
			model.model_name === modelName ? { ...model, installed: true } : model
		);
		writeFixture("proof:tts-models", models);
		return jsonResponse({ ok: true });
	}
	if (path === "/api/voice/speak" && method === "POST") {
		if (
			new URLSearchParams(location.search).get("scenario") === "tts-speak-error"
		) {
			return jsonResponse({ error: "Fixture synthesis failure" }, 502);
		}
		return new Response(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]), {
			headers: { "content-type": "audio/wav" },
			status: 200,
		});
	}
	if (path === "/api/catalog") {
		return jsonResponse({ sidecars: catalog });
	}
	if (path === "/api/sidecar/status") {
		return jsonResponse({
			sidecars: Object.entries(sidecarRunning).map(([name, running]) => ({
				name,
				running,
			})),
		});
	}
	const installMatch = path.match(/^\/api\/setup\/(ryutts|audiocpp)\/install$/);
	if (installMatch && method === "POST") {
		catalog = catalog.map((entry) =>
			entry.name === installMatch[1]
				? { ...entry, install_state: "installed", installed_version: "1.0.0" }
				: entry
		);
		writeFixture("proof:catalog", catalog);
		// Core's setup install route always answers with `forced` and `message`.
		return jsonResponse({
			forced: false,
			message: `Sidecar '${installMatch[1]}' installation started in background`,
			success: true,
		});
	}
	const startMatch = path.match(/^\/api\/sidecar\/(ryutts|audiocpp)\/start$/);
	if (startMatch && method === "POST") {
		sidecarRunning = { ...sidecarRunning, [startMatch[1]]: true };
		writeFixture("proof:sidecars-running", sidecarRunning);
		return jsonResponse({ success: true });
	}
	return jsonResponse(
		{ error: `Unhandled proof request ${method} ${path}` },
		404
	);
};

function VoiceSettingsProof() {
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
		[]
	);

	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<I18nProvider>
					<I18nDirectionProvider>
						<ThemeProvider
							attribute="class"
							defaultTheme="dark"
							enableSystem={false}
						>
							<Toaster position="bottom-right" theme="dark" />
							<main
								className="min-h-dvh bg-background p-8 text-foreground"
								data-testid="voice-settings-proof"
							>
								<div className="mx-auto flex max-w-5xl flex-col gap-6">
									<header className="rounded-2xl border bg-card p-6 shadow-sm">
										<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
											Desktop settings verification
										</p>
										<h1 className="mt-2 font-semibold text-2xl">Voice</h1>
										<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
											Microphone, transcript, recognition, read-back, and spoken
											reply controls from the Desktop settings surface.
										</p>
									</header>
									<section className="rounded-2xl border bg-card p-6 shadow-sm">
										<div className="flex flex-col gap-7">
											<AudioDevicesSettings />
											<VoiceModeDisplaySettings />
											<VoiceInputSettings />
											<VoiceReadbackSettings />
											<TtsEngineSettings />
										</div>
									</section>
								</div>
							</main>
						</ThemeProvider>
					</I18nDirectionProvider>
				</I18nProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Voice settings proof root is missing");
}

createRoot(root).render(<VoiceSettingsProof />);
