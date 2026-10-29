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

// Control-level coverage for the shipping VoiceInputSettings and
// VoiceReadbackSettings sections and their shared voice-preference-state
// hooks. Reads and writes cross real loopback HTTP to a Core-shaped store
// owned by this file. The consumers are the real readers: the island's
// `parseVoicePrefs` for voice input, and the preference SDK call ChatPage
// makes before it reads a finished reply aloud.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE_TOKEN = "voice-coverage-node-token";
const INPUT_PATH = "/api/preferences/voice-input";
const READBACK_PATH = "/api/preferences/voice-mode-readback";
const STATUS_PATH = "/api/sidecar/status";

interface CoreCall {
	body: string | null;
	method: string;
	path: string;
	status: number;
}

const store = new Map<string, string>();
const sidecars = new Map<string, boolean>();
const calls: CoreCall[] = [];
const unexpected: string[] = [];
const armed = new Map<string, number[]>();
let holdNextPut = false;
let releaseHeld: (() => void) | null = null;

function arm(method: string, path: string, ...statuses: number[]) {
	armed.set(`${method} ${path}`, statuses);
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
		const body = request.method === "PUT" ? await request.text() : null;
		const call: CoreCall = { body, method: request.method, path, status: 0 };
		calls.push(call);
		const armedStatus = armed.get(`${request.method} ${path}`)?.shift();
		if (armedStatus !== undefined) {
			call.status = armedStatus;
			return NativeResponse.json(
				{ error: "Voice coverage refusal" },
				{ status: armedStatus }
			);
		}
		if (path === STATUS_PATH && request.method === "GET") {
			call.status = 200;
			return NativeResponse.json({
				sidecars: [...sidecars].map(([name, running]) => ({ name, running })),
			});
		}
		if (path === INPUT_PATH || path === READBACK_PATH) {
			const key = path.slice("/api/preferences/".length);
			if (request.method === "GET") {
				const value = store.get(key);
				call.status = value === undefined ? 404 : 200;
				return value === undefined
					? NativeResponse.json({ error: "Unset preference" }, { status: 404 })
					: NativeResponse.json({ key, value });
			}
			if (request.method === "PUT") {
				if (holdNextPut) {
					holdNextPut = false;
					await new Promise<void>((resolve) => {
						releaseHeld = resolve;
					});
				}
				const parsed = JSON.parse(body ?? "null") as { value?: unknown };
				if (
					typeof parsed?.value !== "string" ||
					Object.keys(parsed).join() !== "value"
				) {
					unexpected.push(`Invalid preference body ${body}`);
					call.status = 400;
					return NativeResponse.json({ error: "bad body" }, { status: 400 });
				}
				store.set(key, parsed.value);
				call.status = 200;
				return NativeResponse.json({ key, value: parsed.value });
			}
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
const { getVoiceModeReadbackPrefs, VOICE_ENGINES } = await import(
	"@/src/lib/api/preferences.ts"
);
const { parseVoicePrefs } = await import(
	"../../../../island/src/shared/voice.ts"
);
const { VoiceInputSettings } = await import("./VoiceInputSettings.tsx");
const { VoiceReadbackSettings } = await import("./VoiceReadbackSettings.tsx");

const initialNodeState = useNodeStore.getState();
const target = () => ({
	token: NODE_TOKEN,
	url: server.url.origin,
	userJwt: null,
});
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
	store.clear();
	sidecars.clear();
	calls.length = 0;
	unexpected.length = 0;
	armed.clear();
	holdNextPut = false;
	releaseHeld = null;
	localStorage.clear();
	localStorage.setItem("voice-coverage-unrelated", "kept");
	useNodeStore.setState({
		autoSelect: false,
		autoSelectedNode: null,
		defaultNode: "voice-coverage",
		nodes: [
			{ name: "voice-coverage", token: NODE_TOKEN, url: server.url.origin },
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	releaseHeld?.();
	await unmount();
	container.remove();
	useNodeStore.setState(initialNodeState, true);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("voice-coverage-unrelated")).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
	expect(unexpected.join("\n")).toBe("");
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

async function until(predicate: () => boolean, label: string, attempts = 400) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	throw new Error(`${label} did not settle: ${container.textContent}`);
}

async function mount(section: "input" | "readback") {
	root = createRoot(container);
	await act(async () =>
		root!.render(
			section === "input" ? <VoiceInputSettings /> : <VoiceReadbackSettings />
		)
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

function required<T extends HTMLElement = HTMLElement>(selector: string): T {
	const found = container.querySelector<T>(selector);
	if (!found) {
		throw new Error(`Missing ${selector}: ${container.textContent}`);
	}
	return found;
}

const engineSelect = () =>
	required<HTMLButtonElement>('[aria-label="Voice Recognition engine"]');
const modelSelect = () =>
	required<HTMLButtonElement>('[aria-label="Voice model"]');
const readbackSwitch = () => required<HTMLButtonElement>('[role="switch"]');

function isDisabled(element: HTMLElement) {
	return (
		element.hasAttribute("disabled") ||
		element.getAttribute("aria-disabled") === "true" ||
		element.hasAttribute("data-disabled")
	);
}

/** The muted caption a settings group prints under the row with this title. */
function captionFor(title: string) {
	const heading = [
		...container.querySelectorAll('[data-slot="item-title"]'),
	].find((candidate) => text(candidate) === title);
	return text(heading?.closest('[data-slot="item-group"]')?.nextElementSibling);
}

function alertMessage() {
	return text(container.querySelector('[role="alert"] p'));
}

function retryButton() {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => text(button) === "Retry"
	);
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

async function chooseEngine(label: string) {
	await act(async () => engineSelect().click());
	await until(() => openOptions().length > 0, "engine options");
	const option = openOptions().find((candidate) => text(candidate) === label);
	if (!option) {
		throw new Error(`Missing engine option ${label}`);
	}
	await act(async () => option.click());
	await until(
		() => engineSelect().getAttribute("aria-expanded") === "false",
		"engine list close"
	);
}

function puts(path: string) {
	return calls.filter((call) => call.method === "PUT" && call.path === path);
}

function stored(key: string) {
	return JSON.parse(store.get(key) ?? "null");
}

test("each Voice Recognition engine is written with its bundled model, the Model row follows, the island reads the same pair, and the other voice-input fields survive", async () => {
	store.set(
		"voice-input",
		JSON.stringify({
			enabled: false,
			engine: "parakeet",
			mode: "push-to-talk",
			model: "parakeet-tdt-0.6b-v3",
			shortcut: "F9",
		})
	);
	sidecars.set("parakeet", true);
	await mount("input");
	await until(() => !isDisabled(engineSelect()), "voice input load");
	expect(text(engineSelect())).toBe("Parakeet v3");
	expect(isDisabled(modelSelect())).toBe(true);
	expect(text(modelSelect())).toBe("parakeet-tdt-0.6b-v3");
	expect(captionFor("Model")).toBe("The bundled model this engine serves.");

	await act(async () => engineSelect().click());
	await until(() => openOptions().length > 0, "engine options");
	expect(openOptions().map((option) => text(option))).toEqual(
		VOICE_ENGINES.map((entry) => entry.label)
	);
	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});

	let writes = 0;
	for (const entry of [
		VOICE_ENGINES.find((candidate) => candidate.engine === "whisper")!,
		VOICE_ENGINES.find((candidate) => candidate.engine === "audiocpp")!,
		VOICE_ENGINES.find((candidate) => candidate.engine === "gateway")!,
		VOICE_ENGINES.find((candidate) => candidate.engine === "parakeet")!,
	]) {
		await chooseEngine(entry.label);
		writes += 1;
		await until(
			() =>
				puts(INPUT_PATH).length === writes &&
				puts(INPUT_PATH).at(-1)!.status === 200 &&
				!isDisabled(engineSelect()),
			`${entry.label} write`
		);
		const saved = {
			enabled: false,
			engine: entry.engine,
			mode: "push-to-talk" as const,
			model: entry.model,
			shortcut: "F9",
		};
		expect(stored("voice-input")).toEqual(saved);
		expect(text(engineSelect())).toBe(entry.label);
		expect(text(modelSelect())).toBe(entry.model);
		// The island picks its engine and model from this exact preference.
		expect(parseVoicePrefs(store.get("voice-input") ?? null)).toEqual(saved);
	}

	// While a save is in flight the picker is locked, so a second choice
	// cannot race the first one to Core.
	holdNextPut = true;
	await chooseEngine("Whisper");
	await until(() => releaseHeld !== null, "held write");
	expect(isDisabled(engineSelect())).toBe(true);
	await act(async () => engineSelect().click());
	expect(puts(INPUT_PATH)).toHaveLength(writes + 1);
	releaseHeld!();
	await until(
		() =>
			puts(INPUT_PATH).at(-1)!.status === 200 && !isDisabled(engineSelect()),
		"held write settles"
	);
	expect(stored("voice-input").engine).toBe("whisper");

	await unmount();
	await mount("input");
	await until(
		() => !isDisabled(engineSelect()) && text(engineSelect()) === "Whisper",
		"remount read"
	);
	expect(text(modelSelect())).toBe("ggml-base.en");
});

test("the Engine row reports the chosen engine's run state from Core, refreshes it on the five-second poll, treats the cloud engine as running, and stops polling once unmounted", async () => {
	store.set(
		"voice-input",
		JSON.stringify({
			enabled: true,
			engine: "parakeet",
			mode: "toggle",
			model: "parakeet-tdt-0.6b-v3",
			shortcut: "F9",
		})
	);
	sidecars.set("parakeet", false);
	sidecars.set("whispercpp", true);
	await mount("input");
	await until(
		() =>
			!isDisabled(engineSelect()) &&
			calls.some((call) => call.path === STATUS_PATH && call.status === 200),
		"voice input load"
	);
	await until(
		() =>
			captionFor("Engine") ===
			"Not running. Install and start it from Services first.",
		"parakeet stopped"
	);

	await chooseEngine("Whisper");
	await until(() => captionFor("Engine") === "Running.", "whisper running");
	await until(() => !isDisabled(engineSelect()), "whisper saved");
	await chooseEngine("Parakeet v3");
	await until(
		() =>
			captionFor("Engine") ===
			"Not running. Install and start it from Services first.",
		"parakeet stopped again"
	);

	// The engine is started elsewhere; the next poll picks that up without a
	// remount or a new preference read.
	sidecars.set("parakeet", true);
	const reads = calls.filter((call) => call.path === INPUT_PATH).length;
	await until(() => captionFor("Engine") === "Running.", "poll refresh", 1400);
	expect(calls.filter((call) => call.path === INPUT_PATH)).toHaveLength(reads);

	// An engine whose sidecar Core does not report at all is not running.
	await until(() => !isDisabled(engineSelect()), "parakeet saved");
	await chooseEngine("audio.cpp");
	await until(
		() =>
			captionFor("Engine") ===
			"Not running. Install and start it from Services first.",
		"unreported audio.cpp sidecar"
	);

	// A cloud engine has no sidecar to run, so it is never reported stopped.
	sidecars.clear();
	await until(() => !isDisabled(engineSelect()), "audio.cpp saved");
	await chooseEngine("Cloud (via gateway)");
	await until(() => captionFor("Engine") === "Running.", "cloud running");

	const polls = calls.filter((call) => call.path === STATUS_PATH).length;
	await unmount();
	await Bun.sleep(5500);
	expect(calls.filter((call) => call.path === STATUS_PATH)).toHaveLength(polls);
});

test("Always read back responses is saved through Core, is what the chat read-back consumer reads, locks while saving, and reports refused saves and reads with a working Retry", async () => {
	await mount("readback");
	await until(() => !isDisabled(readbackSwitch()), "unset read-back load");
	expect(readbackSwitch().getAttribute("aria-checked")).toBe("false");
	expect(captionFor("Always read back responses")).toBe(
		"Speak assistant replies aloud when a chat turn finishes."
	);
	// An unset preference shows the default without writing it.
	expect(puts(READBACK_PATH)).toHaveLength(0);
	expect(await getVoiceModeReadbackPrefs(target())).toEqual({ enabled: false });

	holdNextPut = true;
	await act(async () => readbackSwitch().click());
	await until(() => releaseHeld !== null, "held read-back write");
	expect(isDisabled(readbackSwitch())).toBe(true);
	releaseHeld!();
	await until(
		() =>
			!isDisabled(readbackSwitch()) &&
			readbackSwitch().getAttribute("aria-checked") === "true",
		"read-back saved"
	);
	expect(puts(READBACK_PATH).map((call) => call.body)).toEqual([
		JSON.stringify({ value: JSON.stringify({ enabled: true }) }),
	]);
	// ChatPage asks this SDK whether to speak a finished reply.
	expect(await getVoiceModeReadbackPrefs(target())).toEqual({ enabled: true });

	arm("PUT", READBACK_PATH, 503);
	await act(async () => readbackSwitch().click());
	await until(() => alertMessage() !== undefined, "refused save");
	expect(alertMessage()).toBe(
		"Could not save voice settings. The previous saved settings are still selected."
	);
	// The switch shows what Core still holds, not the refused change.
	expect(readbackSwitch().getAttribute("aria-checked")).toBe("true");
	expect(stored("voice-mode-readback")).toEqual({ enabled: true });
	await act(async () => retryButton()!.click());
	await until(
		() =>
			alertMessage() === undefined &&
			readbackSwitch().getAttribute("aria-checked") === "false",
		"retried save"
	);
	expect(
		puts(READBACK_PATH)
			.slice(1)
			.map((call) => [call.status, call.body])
	).toEqual([
		[503, JSON.stringify({ value: JSON.stringify({ enabled: false }) })],
		[200, JSON.stringify({ value: JSON.stringify({ enabled: false }) })],
	]);
	expect(await getVoiceModeReadbackPrefs(target())).toEqual({ enabled: false });

	await unmount();
	store.set("voice-mode-readback", JSON.stringify({ enabled: true }));
	arm("GET", READBACK_PATH, 500);
	await mount("readback");
	await until(() => alertMessage() !== undefined, "refused read");
	expect(alertMessage()).toBe(
		"Could not load voice settings. Your saved settings have not been changed."
	);
	// Nothing can be written over the unread preference.
	expect(isDisabled(readbackSwitch())).toBe(true);
	await act(async () => readbackSwitch().click());
	await act(async () => retryButton()!.click());
	await until(
		() =>
			!isDisabled(readbackSwitch()) &&
			readbackSwitch().getAttribute("aria-checked") === "true",
		"retried read"
	);
	expect(alertMessage()).toBeUndefined();
	expect(puts(READBACK_PATH)).toHaveLength(3);
	expect(stored("voice-mode-readback")).toEqual({ enabled: true });
});
