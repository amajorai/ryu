import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// Control-level coverage for the shipping TtsEngineSettings (the Voice tab's
// Audio section). The engine and model lists come from a Core-shaped server
// over real loopback HTTP. The consumer is ChatPage's read-aloud call: it
// reads the same desktop speech preferences and sends them to Core's
// /api/voice/speak through the production `speakText` SDK, so each test
// asserts the exact request body Core receives after the settings change.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE_TOKEN = "tts-coverage-node-token";
const ENGINES_PATH = "/api/voice/tts-engines";
const MODELS_PATH = "/api/voice/tts-models";
const SPEAK_PATH = "/api/voice/speak";
const CATALOG_PATH = "/api/catalog";
const STATUS_PATH = "/api/sidecar/status";

const engine = (
	id: string,
	displayName: string,
	voices: string[],
	defaultVoice: string,
	extra: { installed?: boolean; languages?: string[]; cloning?: boolean } = {}
) => ({
	default_voice: defaultVoice,
	description: `${displayName} speech runtime`,
	display_name: displayName,
	id,
	installed: extra.installed ?? true,
	languages: extra.languages ?? ["en"],
	loaded: true,
	sample_rate: 24_000,
	size_mb: 12,
	supports_cloning: extra.cloning ?? false,
	voices,
});
const ENGINES = [
	engine("outetts", "OuteTTS (built-in)", [], ""),
	engine("audiocpp", "audio.cpp", ["alba", "marius"], "alba", {
		cloning: true,
		installed: false,
		languages: ["en", "de", "fr"],
	}),
	engine("gateway", "Cloud (via gateway)", ["alloy", "echo", "nova"], "alloy"),
];
const MODELS = [
	{
		default: true,
		display_name: "PocketTTS English Q8_0 (audio.cpp)",
		engine: "audiocpp",
		engine_display_name: "audio.cpp",
		hf_repo_id: "audio-cpp/audio.cpp-gguf",
		installed: true,
		languages: ["en"],
		model_name: "pocket_tts_english_q8_0",
		size_mb: 1040,
	},
];

/** A Core catalog row for a run-alongside voice runtime. */
const catalogRuntime = (name: string, installState: string) => ({
	category: "voice",
	deprecated: false,
	description: `${name} runtime`,
	display_name: name,
	install_state: installState,
	installed_version: installState === "installed" ? "1.0.0" : null,
	latest_version: "1.0.0",
	name,
	platforms: [],
	recommended: true,
	supported: true,
	update_available: false,
});

// Per-case Core state; each case starts with no runtimes and the ENGINES list.
const core = {
	catalog: [] as ReturnType<typeof catalogRuntime>[],
	engines: ENGINES,
	status: [] as { name: string; running: boolean }[],
};

interface CoreCall {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

const calls: CoreCall[] = [];
const unexpected: string[] = [];
const armed = new Map<string, number[]>();

function arm(method: string, path: string, ...statuses: number[]) {
	armed.set(`${method} ${path}`, statuses);
}

// One-shot holds: the next matching request is recorded, then answered only
// after its release runs (every hold is released after each case).
const holds = new Map<string, Promise<void>>();
const releases: (() => void)[] = [];
function hold(method: string, path: string) {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	holds.set(`${method} ${path}`, gate);
	releases.push(release);
	return release;
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (request.headers.get("authorization") !== `Bearer ${NODE_TOKEN}`) {
			unexpected.push(`${request.method} ${path} without the node token`);
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		const body = request.method === "POST" ? await request.json() : null;
		const call: CoreCall = { body, method: request.method, path, status: 200 };
		calls.push(call);
		const gate = holds.get(`${request.method} ${path}`);
		if (gate) {
			holds.delete(`${request.method} ${path}`);
			await gate;
		}
		const armedStatus = armed.get(`${request.method} ${path}`)?.shift();
		if (armedStatus !== undefined) {
			call.status = armedStatus;
			return NativeResponse.json(
				{ error: "TTS coverage refusal" },
				{ status: armedStatus }
			);
		}
		if (request.method === "GET" && path === ENGINES_PATH) {
			return NativeResponse.json({ data: core.engines });
		}
		if (request.method === "GET" && path === MODELS_PATH) {
			return NativeResponse.json({ data: MODELS });
		}
		if (request.method === "GET" && path === CATALOG_PATH) {
			return NativeResponse.json({ sidecars: core.catalog });
		}
		if (request.method === "GET" && path === STATUS_PATH) {
			return NativeResponse.json({ sidecars: core.status });
		}
		if (request.method === "POST" && path === SPEAK_PATH) {
			return new NativeResponse(new Uint8Array([82, 73, 70, 70]), {
				headers: { "content-type": "audio/wav" },
			});
		}
		unexpected.push(`Undeclared ${request.method} ${path}`);
		call.status = 404;
		return NativeResponse.json({ error: "undeclared" }, { status: 404 });
	},
});

const ownedFetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (new URL(url).origin !== server.url.origin) {
			unexpected.push(`Unowned origin ${url}`);
			return Promise.reject(new Error(`Unowned origin ${url}`));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = ownedFetch;
window.fetch = ownedFetch;

const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const {
	DESKTOP_TTS_ENGINE_KEY,
	DESKTOP_TTS_VOICE_KEY,
	getDesktopTtsEngineOptions,
	getDesktopTtsPrefs,
	setDesktopTtsPref,
} = await import("@/src/lib/api/preferences.ts");
const { speakText } = await import("@/src/lib/api/voice.ts");
const { TtsEngineSettings } = await import("./TtsEngineSettings.tsx");

const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
	calls.length = 0;
	unexpected.length = 0;
	armed.clear();
	core.catalog = [];
	core.engines = ENGINES;
	core.status = [];
	localStorage.clear();
	localStorage.setItem("tts-coverage-unrelated", "kept");
	useNodeStore.setState({
		autoSelect: false,
		autoSelectedNode: null,
		defaultNode: "tts-coverage",
		nodes: [
			{ name: "tts-coverage", token: NODE_TOKEN, url: server.url.origin },
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	for (const release of releases.splice(0)) {
		release();
	}
	holds.clear();
	await unmount();
	container.remove();
	useNodeStore.setState(initialNodeState, true);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("tts-coverage-unrelated")).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
	expect(unexpected.join("\n")).toBe("");
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

async function until(predicate: () => boolean, label: string) {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	throw new Error(`${label} did not settle: ${container.textContent}`);
}

async function mount() {
	root = createRoot(container);
	await act(async () => root!.render(<TtsEngineSettings />));
}

async function mountLoaded() {
	await mount();
	await until(
		() =>
			calls.some((call) => call.path === ENGINES_PATH && call.status === 200) &&
			!text(combo("Audio engine"))?.startsWith("gateway") &&
			!text(combo("Audio engine"))?.startsWith("outetts") &&
			!text(combo("Audio engine"))?.startsWith("audiocpp"),
		"engine list"
	);
}

async function unmount() {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
}

function text(element: Element | null | undefined) {
	return element?.textContent?.replace("▼", "").replace(/\s+/g, " ").trim();
}

function combo(label: string) {
	return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}

function requiredCombo(label: string) {
	const found = combo(label);
	if (!found) {
		throw new Error(`Missing ${label}: ${container.textContent}`);
	}
	return found;
}

/** The control a generation-defaults field's <label> points at. */
function field<T extends HTMLElement = HTMLInputElement>(label: string) {
	const element = [...container.querySelectorAll("label")].find(
		(candidate) => text(candidate) === label
	);
	const id = element?.getAttribute("for");
	return id ? container.querySelector<T>(`#${CSS.escape(id)}`) : null;
}

function openOptions() {
	const listbox = [
		...document.querySelectorAll<HTMLElement>('[role="listbox"]'),
	]
		.filter(
			(box) =>
				!(box.hasAttribute("data-closed") || box.closest("[data-closed]"))
		)
		.at(-1);
	return [...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
}

async function optionsOf(trigger: HTMLElement) {
	await act(async () => trigger.click());
	await until(() => openOptions().length > 0, "options");
	const labels = openOptions().map((option) => text(option));
	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	return labels;
}

async function choose(trigger: HTMLElement, option: string) {
	await act(async () => trigger.click());
	await until(() => openOptions().length > 0, `${option} options`);
	const match = openOptions().find((candidate) => text(candidate) === option);
	if (!match) {
		throw new Error(`Missing option ${option}`);
	}
	await act(async () => match.click());
	await until(
		() => trigger.getAttribute("aria-expanded") === "false",
		`${option} close`
	);
}

async function type(element: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)!.set!.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function alerts() {
	return [...container.querySelectorAll('[role="alert"]')].map((alert) =>
		text(alert)
	);
}

function buttonNamed(name: string) {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => (button.getAttribute("aria-label") ?? text(button)) === name
	);
}

function statusesOf(path: string) {
	return calls.filter((call) => call.path === path).map((call) => call.status);
}

function storedOptions() {
	return JSON.parse(localStorage.getItem("ryu.tts.engine-options") ?? "{}");
}

/** ChatPage's read-aloud call, verbatim: it reads the same preferences. */
async function chatReadAloud(reply: string) {
	const prefs = getDesktopTtsPrefs();
	const engineOptions = getDesktopTtsEngineOptions(prefs.engine);
	await speakText(
		{ token: NODE_TOKEN, url: server.url.origin, userJwt: null },
		reply,
		{
			engine: prefs.engine,
			language: engineOptions.language,
			referenceAudio: engineOptions.referenceAudio,
			speed: engineOptions.speed,
			voice: engineOptions.voice || prefs.voice || undefined,
		}
	);
	return calls.filter((call) => call.path === SPEAK_PATH).at(-1)?.body;
}

test("engine, voice and generation defaults persist per engine, the chat read-aloud request carries exactly those choices, and invalid speed is refused", async () => {
	localStorage.setItem(DESKTOP_TTS_ENGINE_KEY, "gateway");
	localStorage.setItem(DESKTOP_TTS_VOICE_KEY, "alloy");
	await mountLoaded();
	const engineSelect = requiredCombo("Audio engine");
	expect(text(engineSelect)).toBe("Cloud (via gateway)");
	// The list is exactly what Core reported, marking engines not installed.
	expect(await optionsOf(engineSelect)).toEqual([
		"OuteTTS (built-in)",
		"audio.cpp (not installed)",
		"Cloud (via gateway)",
	]);
	expect(await optionsOf(requiredCombo("Voice"))).toEqual([
		"alloy",
		"echo",
		"nova",
	]);
	await choose(requiredCombo("Voice"), "nova");
	expect(localStorage.getItem(DESKTOP_TTS_VOICE_KEY)).toBe("nova");
	expect(storedOptions()).toEqual({ gateway: { voice: "nova" } });

	// Gateway takes speed but chooses its own language.
	expect(container.textContent).toContain("Generation defaults");
	expect(container.textContent).toContain(
		"The Gateway provider chooses language."
	);
	expect(field("Language")).toBeNull();
	const speed = field("Speaking speed")!;
	await type(speed, "5");
	expect(container.textContent).toContain(
		"Speaking speed must be between 0.25 and 4."
	);
	expect(storedOptions().gateway.speed).toBeUndefined();
	await type(speed, "1.5");
	expect(container.textContent).not.toContain(
		"Speaking speed must be between 0.25 and 4."
	);
	expect(storedOptions()).toEqual({ gateway: { speed: 1.5, voice: "nova" } });
	expect(await chatReadAloud("Your meeting moved to 3pm.")).toEqual({
		engine: "gateway",
		speed: 1.5,
		text: "Your meeting moved to 3pm.",
		voice: "nova",
	});

	// audio.cpp has its own defaults: its default voice, language and cloning.
	await choose(engineSelect, "audio.cpp (not installed)");
	expect(localStorage.getItem(DESKTOP_TTS_ENGINE_KEY)).toBe("audiocpp");
	expect(text(requiredCombo("Voice"))).toBe("alba");
	expect(localStorage.getItem(DESKTOP_TTS_VOICE_KEY)).toBe("alba");
	expect(field("Speaking speed")!.value).toBe("");
	await choose(field<HTMLButtonElement>("Language")!, "de");
	await type(field("Reference audio path")!, "/voices/approved/sample.wav");
	await choose(requiredCombo("Voice"), "marius");
	expect(storedOptions().audiocpp).toEqual({
		language: "de",
		referenceAudio: "/voices/approved/sample.wav",
		voice: "marius",
	});
	// The gateway defaults are untouched by audio.cpp edits.
	expect(storedOptions().gateway).toEqual({ speed: 1.5, voice: "nova" });
	expect(await chatReadAloud("Bonjour.")).toEqual({
		engine: "audiocpp",
		language: "de",
		reference_audio: "/voices/approved/sample.wav",
		text: "Bonjour.",
		voice: "marius",
	});

	// Coming back restores the gateway's own voice and speed.
	await choose(engineSelect, "Cloud (via gateway)");
	expect(text(requiredCombo("Voice"))).toBe("nova");
	expect(field("Speaking speed")!.value).toBe("1.5");

	// OuteTTS takes none of the overrides; the read-aloud sends none.
	await choose(engineSelect, "OuteTTS (built-in)");
	expect(combo("Voice")).toBeNull();
	expect(field("Speaking speed")).toBeNull();
	expect(container.textContent).toContain(
		"OuteTTS uses its bundled model voice and does not accept speech-rate, language, or cloning overrides."
	);
	expect(localStorage.getItem(DESKTOP_TTS_VOICE_KEY)).toBe("");
	expect(await chatReadAloud("Done.")).toEqual({
		engine: "outetts",
		text: "Done.",
	});

	await unmount();
	await mountLoaded();
	expect(text(requiredCombo("Audio engine"))).toBe("OuteTTS (built-in)");
	await choose(requiredCombo("Audio engine"), "audio.cpp (not installed)");
	expect(text(requiredCombo("Voice"))).toBe("marius");
	expect(text(field<HTMLButtonElement>("Language"))).toBe("de");
});

test("a change made from the node selector shows up in the open Audio section at once, and a closed section no longer listens", async () => {
	localStorage.setItem(DESKTOP_TTS_ENGINE_KEY, "gateway");
	localStorage.setItem(DESKTOP_TTS_VOICE_KEY, "alloy");
	await mountLoaded();
	// The node selector's Text-to-speech layer writes through these setters.
	await act(async () => {
		setDesktopTtsPref(DESKTOP_TTS_ENGINE_KEY, "audiocpp");
		setDesktopTtsPref(DESKTOP_TTS_VOICE_KEY, "marius");
	});
	expect(text(requiredCombo("Audio engine"))).toBe("audio.cpp (not installed)");
	expect(text(requiredCombo("Voice"))).toBe("marius");
	expect(field("Reference audio path")).not.toBeNull();

	const errors: unknown[] = [];
	const consoleError = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args);
	};
	try {
		await unmount();
		await act(async () => {
			setDesktopTtsPref(DESKTOP_TTS_ENGINE_KEY, "gateway");
			setDesktopTtsPref(DESKTOP_TTS_VOICE_KEY, "echo");
		});
	} finally {
		console.error = consoleError;
	}
	expect(errors).toEqual([]);
	await mountLoaded();
	expect(text(requiredCombo("Audio engine"))).toBe("Cloud (via gateway)");
	expect(text(requiredCombo("Voice"))).toBe("echo");
});

test("failed engine and model listings each show a Retry that reloads them from Core", async () => {
	localStorage.setItem(DESKTOP_TTS_ENGINE_KEY, "gateway");
	arm("GET", ENGINES_PATH, 503);
	arm("GET", MODELS_PATH, 503);
	await mount();
	await until(
		() =>
			container.textContent?.includes(
				"Couldn’t load the voice engines. Check your connection and try again."
			) === true,
		"engine failure"
	);
	await until(
		() =>
			text(container.querySelector('[role="alert"]')) ===
			"Couldn’t load the voice models. Retry to confirm installed models.",
		"model failure"
	);
	expect(combo("Voice")).toBeNull();
	expect(container.textContent).not.toContain("Curated voice models");

	const retryModels = container.querySelector<HTMLButtonElement>(
		'[aria-label="Retry loading voice models"]'
	)!;
	await act(async () => retryModels.click());
	await until(
		() => container.textContent?.includes("Curated voice models") === true,
		"model retry"
	);
	expect(container.textContent).toContain("PocketTTS English Q8_0 (audio.cpp)");
	expect(container.textContent).toContain("Installed");

	const retryEngines = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find(
		(button) => text(button) === "Retry" && !button.getAttribute("aria-label")
	);
	await act(async () => retryEngines!.click());
	await until(
		() => text(combo("Audio engine")) === "Cloud (via gateway)",
		"engine retry"
	);
	expect(container.textContent).not.toContain(
		"Couldn’t load the voice engines"
	);
	expect(
		calls
			.filter((call) => call.path === ENGINES_PATH)
			.map((call) => call.status)
	).toEqual([503, 200]);
	// Retrying the engines also re-reads the model inventory.
	expect(
		calls.filter((call) => call.path === MODELS_PATH).map((call) => call.status)
	).toEqual([503, 200, 200]);
});

test("an unreadable runtime status shows its own Retry, which re-reads the status and only then re-lists the engines and models", async () => {
	const statusAlert =
		"Couldn’t load the runtime status. Status is unknown; retry to confirm it.";
	localStorage.setItem(DESKTOP_TTS_ENGINE_KEY, "audiocpp");
	core.catalog = [catalogRuntime("audiocpp", "not_installed")];
	core.status = [{ name: "audiocpp", running: false }];
	arm("GET", STATUS_PATH, 503);
	await mount();
	await until(() => alerts().includes(statusAlert), "runtime status failure");
	await until(
		() => text(combo("Audio engine")) === "audio.cpp (not installed)",
		"engine list"
	);
	// Unknown status blocks the runtime action instead of guessing it.
	expect(buttonNamed("Audio runtime status unknown")?.disabled).toBe(true);
	expect(buttonNamed("Install audio.cpp runtime")).toBeUndefined();
	expect(statusesOf(STATUS_PATH)).toEqual([503]);
	expect(statusesOf(ENGINES_PATH)).toEqual([200]);
	expect(statusesOf(MODELS_PATH)).toEqual([200]);

	// Core finishes installing audio.cpp before the user retries.
	core.catalog = [catalogRuntime("audiocpp", "installed")];
	core.engines = ENGINES.map((entry) =>
		entry.id === "audiocpp" ? { ...entry, installed: true } : entry
	);
	const firstRetryCall = calls.length;
	const releaseStatus = hold("GET", STATUS_PATH);
	const retry = buttonNamed("Retry loading voice runtime status");
	expect(text(retry)).toBe("Retry");
	await act(async () => retry!.click());
	await until(
		() =>
			statusesOf(STATUS_PATH).length === 2 &&
			statusesOf(CATALOG_PATH).length === 2,
		"runtime status re-read"
	);
	// While the fresh status is outstanding, the engines and models are not
	// re-listed and the runtime action stays blocked.
	await act(async () => {
		await Bun.sleep(100);
	});
	expect(statusesOf(ENGINES_PATH)).toEqual([200]);
	expect(statusesOf(MODELS_PATH)).toEqual([200]);
	expect(text(combo("Audio engine"))).toBe("audio.cpp (not installed)");
	expect(buttonNamed("Start audio.cpp runtime")).toBeUndefined();
	releaseStatus();
	await until(() => !alerts().includes(statusAlert), "runtime status retry");
	await until(
		() => text(combo("Audio engine")) === "audio.cpp",
		"engine re-list after the status retry"
	);
	await until(
		() => statusesOf(MODELS_PATH).length === 2,
		"model re-list after the status retry"
	);
	expect(buttonNamed("Retry loading voice runtime status")).toBeUndefined();
	expect(statusesOf(STATUS_PATH)).toEqual([503, 200]);
	expect(statusesOf(CATALOG_PATH)).toEqual([200, 200]);
	expect(statusesOf(ENGINES_PATH)).toEqual([200, 200]);
	expect(statusesOf(MODELS_PATH)).toEqual([200, 200]);
	// The Retry read the catalog and status together, and only then the
	// engines and models (each pair may arrive in either order).
	const retryCalls = calls.slice(firstRetryCall).map((call) => call.path);
	expect(retryCalls).toHaveLength(4);
	expect(retryCalls.slice(0, 2).sort()).toEqual(
		[CATALOG_PATH, STATUS_PATH].sort()
	);
	expect(retryCalls.slice(2).sort()).toEqual(
		[ENGINES_PATH, MODELS_PATH].sort()
	);
	// The confirmed status turns the blocked action into the real next step.
	expect(buttonNamed("Audio runtime status unknown")).toBeUndefined();
	expect(buttonNamed("Start audio.cpp runtime")?.disabled).toBe(false);
});
