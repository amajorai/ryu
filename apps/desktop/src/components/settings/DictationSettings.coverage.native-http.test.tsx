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

// Control-level coverage for the shipping DictationSettings tab. Every read and
// write crosses real loopback HTTP to a Core-shaped preference store owned by
// this file, through the production preference SDK and request client. The
// island's real `parseDictationPrefs` then reads the stored blob, which is the
// consumer that registers the shortcuts and inserts text on the OS side.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
window.fetch = nativeFetch;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE_TOKEN = "dictation-coverage-node-token";
const DICTATION_PATH = "/api/preferences/dictation";
const SPEECH_PATH = "/api/preferences/speech-processing";
const EMPTY_SELECTION = {
	access_mode: "",
	agent_id: "",
	effort: "",
	model: "",
	provider: "",
	thinking_level: "",
};
const ENTITLEMENT_MIRRORS = new Set([
	"entitlement-active",
	"managed-inference-entitled",
]);
const AGENTS = [
	{ id: "dictation-scribe", name: "Scribe agent", tools: [] },
	{ id: "dictation-editor", name: "Editor agent", tools: [] },
];

interface CoreCall {
	body: string | null;
	method: string;
	path: string;
	status: number;
}

const store = new Map<string, string>();
const calls: CoreCall[] = [];
const unexpected: string[] = [];
const armed = new Map<string, number[]>();
let holdNextPut: string | null = null;
let releaseHeld: (() => void) | null = null;

function arm(method: string, path: string, ...statuses: number[]) {
	armed.set(`${method} ${path}`, statuses);
}

function takeArmed(method: string, path: string): number | null {
	const queue = armed.get(`${method} ${path}`);
	const status = queue?.shift();
	return status ?? null;
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const path = url.pathname;
		if (request.headers.get("authorization") !== `Bearer ${NODE_TOKEN}`) {
			unexpected.push(`${request.method} ${path} without the node token`);
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		const body = request.method === "PUT" ? await request.text() : null;
		const call: CoreCall = { body, method: request.method, path, status: 0 };
		calls.push(call);
		const armedStatus = takeArmed(request.method, path);
		if (armedStatus !== null) {
			call.status = armedStatus;
			return NativeResponse.json(
				{ error: "Dictation coverage refusal" },
				{ status: armedStatus }
			);
		}
		// The app shell's EntitlementProvider mirrors its verdict to Core.
		if (
			request.method === "PUT" &&
			ENTITLEMENT_MIRRORS.has(path.slice("/api/preferences/".length))
		) {
			call.status = 200;
			return NativeResponse.json({ ok: true });
		}
		if (path === DICTATION_PATH || path === SPEECH_PATH) {
			const key = path.slice("/api/preferences/".length);
			if (request.method === "GET") {
				const value = store.get(key);
				call.status = value === undefined ? 404 : 200;
				return value === undefined
					? NativeResponse.json({ error: "Unset preference" }, { status: 404 })
					: NativeResponse.json({ key, value });
			}
			if (request.method === "PUT") {
				if (holdNextPut === path) {
					holdNextPut = null;
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
		if (request.method !== "GET") {
			unexpected.push(`Undeclared ${request.method} ${path}`);
			call.status = 405;
			return NativeResponse.json({ error: "undeclared" }, { status: 405 });
		}
		call.status = 200;
		if (path === "/api/agents") {
			return NativeResponse.json({ agents: AGENTS });
		}
		// The picker probes a picked agent's advertised modes; these agents
		// advertise none, so no access-mode or effort picker is offered.
		if (
			AGENTS.some(
				(candidate) => path === `/api/agents/${candidate.id}/acp-config`
			)
		) {
			return NativeResponse.json({ configOptions: [], modes: null });
		}
		const agent = AGENTS.find(
			(candidate) => path === `/api/agents/${candidate.id}`
		);
		if (agent) {
			return NativeResponse.json({
				agent: {
					...agent,
					memory: { read_levels: [], space_ids: [], write_enabled: false },
				},
			});
		}
		if (path === "/api/spaces") {
			return NativeResponse.json({ spaces: [] });
		}
		if (path === "/api/mcp/tools") {
			return NativeResponse.json({ tools: [] });
		}
		if (path === "/api/engines") {
			return NativeResponse.json({ engines: [] });
		}
		if (path === "/api/engine/active") {
			return NativeResponse.json({
				active: null,
				available: [],
				running: false,
			});
		}
		if (path === "/api/pi-config/catalog") {
			return NativeResponse.json({
				agentModelOverrides: {},
				apiTypes: ["openai-completions"],
				providers: [
					{
						active: true,
						api: "openai-completions",
						authEnv: "",
						authKind: "none",
						configured: true,
						custom: false,
						id: "local",
						label: "Local",
						modelOverrides: {},
						routing: "direct",
						suggestedModels: ["qwen-local"],
						supportsDiscovery: false,
					},
				],
				thinkingLevels: [],
			});
		}
		unexpected.push(`Undeclared GET ${path}`);
		call.status = 404;
		return NativeResponse.json({ error: "undeclared" }, { status: 404 });
	},
});

// Production modules read the control-plane origin at import time; point it
// at this fixture and refuse any other egress.
process.env.VITE_APP_BACKEND_URL = server.url.origin;
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
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const {
	DEFAULT_DICTATION_PREFS,
	DEFAULT_DICTATION_ASK_PROMPT,
	DEFAULT_DICTATION_POSTPROCESS_PROMPT,
	VOICE_ENGINES,
} = await import("@/src/lib/api/preferences.ts");
const { parseDictationPrefs } = await import(
	"../../../../island/src/shared/dictation.ts"
);
const { DictationSettings } = await import("./DictationSettings.tsx");

const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
	store.clear();
	calls.length = 0;
	unexpected.length = 0;
	armed.clear();
	holdNextPut = null;
	releaseHeld = null;
	queryClient.clear();
	localStorage.clear();
	localStorage.setItem("dictation-coverage-unrelated", "kept");
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "dictation-coverage",
		nodes: [
			{ name: "dictation-coverage", token: NODE_TOKEN, url: server.url.origin },
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
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("dictation-coverage-unrelated")).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
	expect(unexpected.join("\n")).toBe("");
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
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
	await act(async () =>
		root!.render(
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<DictationSettings />
				</EntitlementProvider>
			</QueryClientProvider>
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

async function mountLoaded() {
	await mount();
	await until(
		() => labelled("Set dictation shortcut") !== null,
		"Dictation preferences load"
	);
}

async function remount() {
	await unmount();
	await mountLoaded();
}

function labelled<T extends HTMLElement = HTMLElement>(
	label: string
): T | null {
	return container.querySelector<T>(`[aria-label="${label}"]`);
}

function required<T extends HTMLElement = HTMLElement>(label: string): T {
	const found = labelled<T>(label);
	if (!found) {
		throw new Error(`Missing control ${label}: ${container.textContent}`);
	}
	return found;
}

function text(element: Element | null | undefined) {
	return element?.textContent?.replace("▼", "").replace(/\s+/g, " ").trim();
}

function rowTitles() {
	return [...container.querySelectorAll('[data-slot="item-title"]')].map(
		(title) => text(title)
	);
}

/** The muted caption a settings group prints under the row with this title. */
function captionFor(title: string) {
	const heading = [
		...container.querySelectorAll('[data-slot="item-title"]'),
	].find((candidate) => text(candidate) === title);
	if (!heading) {
		throw new Error(`Missing row ${title}: ${rowTitles().join(" | ")}`);
	}
	const card = heading.closest('[data-slot="item-group"]');
	if (card) {
		return text(card.nextElementSibling);
	}
	// A bare row renders its own description beneath its control.
	return text(heading.parentElement?.parentElement?.lastElementChild);
}

function stored(key = "dictation") {
	const raw = store.get(key);
	if (raw === undefined) {
		throw new Error(`Core has no ${key} preference`);
	}
	return JSON.parse(raw);
}

function puts(path = DICTATION_PATH) {
	return calls.filter((call) => call.method === "PUT" && call.path === path);
}

function putValues(path = DICTATION_PATH) {
	return puts(path).map(
		(call) => JSON.parse(JSON.parse(call.body ?? "{}").value) as unknown
	);
}

/** The listbox of the one select that is open now (closed popups linger). */
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

async function openSelect(label: string) {
	const combo = required(label);
	await act(async () => combo.click());
	await until(() => openOptions().length > 0, `${label} options`);
	return openOptions().map((option) => text(option));
}

async function choose(label: string, option: string) {
	await openSelect(label);
	const match = openOptions().find((candidate) => text(candidate) === option);
	if (!match) {
		throw new Error(`Missing option ${option} in ${label}`);
	}
	await act(async () => match.click());
	await until(
		() => required(label).getAttribute("aria-expanded") === "false",
		`${label} close`
	);
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
}

async function type(
	element: HTMLInputElement | HTMLTextAreaElement,
	value: string
) {
	const prototype =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	await act(async () => {
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
			element,
			value
		);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function press(
	element: HTMLElement,
	key: string,
	modifiers: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}
) {
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key,
				...modifiers,
			})
		);
	});
}

/** Wait for the writes queued so far to reach Core. */
async function settled(count: number, path = DICTATION_PATH) {
	await until(
		() => puts(path).filter((call) => call.status !== 0).length >= count,
		`${count} ${path} writes`
	);
}

/** The message of the tab's one alert, without its action button. */
function alertMessage() {
	return text(container.querySelector('[role="alert"] > span'));
}

function keycaps(label: string) {
	return [...required(label).querySelectorAll("kbd")].map((cap) => text(cap));
}

function seed(prefs: Record<string, unknown>) {
	store.set(
		"dictation",
		JSON.stringify({ ...DEFAULT_DICTATION_PREFS, ...prefs })
	);
}

async function pickCustomModel(fieldLabel: string, model: string) {
	await click(required(fieldLabel));
	await until(
		() => document.querySelector('[aria-label="Custom model id"]') !== null,
		"custom model row"
	);
	const input = document.querySelector<HTMLInputElement>(
		'[aria-label="Custom model id"]'
	)!;
	await type(input, model);
	await click(
		document.querySelector<HTMLElement>('[aria-label="Use this model"]')!
	);
	await until(
		() => document.querySelector('[aria-label="Custom model id"]') === null,
		"picker close"
	);
}

async function pickAgent(fieldLabel: string, agentName: string) {
	await click(required(fieldLabel));
	await until(
		() =>
			[...document.querySelectorAll<HTMLElement>("[cmdk-item]")].some(
				(item) => text(item) === agentName
			),
		`${agentName} picker row`
	);
	const row = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
		(item) => text(item) === agentName
	)!;
	await click(row);
	await until(
		() => document.querySelector('[aria-label="Custom model id"]') === null,
		"picker close"
	);
}

function agentReads(id: string) {
	return calls.filter(
		(call) => call.method === "GET" && call.path === `/api/agents/${id}`
	);
}

test("Transcribe controls load the saved Core blob, write the complete blob on each change, and the island reads every choice back", async () => {
	seed({
		autoSend: false,
		engine: "whisper",
		insertMode: "type",
		mode: "toggle",
		pasteKeys: "",
		postProcess: {
			enabled: true,
			prompt: "Keep the speaker's jargon.",
			selection: EMPTY_SELECTION,
		},
		restoreClipboard: true,
		shortcut: "CommandOrControl+Alt+J",
	});
	await mountLoaded();

	// Every value comes from Core, not from the defaults.
	expect(keycaps("Set dictation shortcut")).toEqual(["Ctrl", "Alt", "J"]);
	expect(text(required("Dictation activation mode"))).toBe(
		"Press to start / stop"
	);
	expect(captionFor("Activation")).toBe(
		"Press once to start, again to stop and insert."
	);
	expect(text(required("Dictation engine"))).toBe("Whisper");
	expect(captionFor("Engine")).toBe(
		"Voice Recognition engine used for dictation."
	);
	expect(text(required("Dictation insertion method"))).toBe(
		"Type (synthetic keystrokes)"
	);
	expect(captionFor("Insertion")).toBe(
		"Types the text character by character. No clipboard clobber; works everywhere."
	);
	expect(labelled("Paste command")).toBeNull();
	expect(labelled("Restore clipboard after paste")).toBeNull();
	expect(captionFor("Auto-send (press Enter)")).toBe(
		"Press Enter after inserting, which sends the message in a chat box (or adds a newline in an editor)."
	);
	expect(
		required("Auto-send after dictation").getAttribute("aria-checked")
	).toBe("false");
	expect(puts()).toHaveLength(0);

	await choose("Dictation activation mode", "Hold to talk");
	await settled(1);
	expect(captionFor("Activation")).toBe(
		"Hold the shortcut to record; release to insert."
	);
	expect(stored().mode).toBe("push-to-talk");

	// The engine list is the shipping VOICE_ENGINES set, in order.
	expect(await openSelect("Dictation engine")).toEqual(
		VOICE_ENGINES.map((entry) => entry.label)
	);
	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	await choose("Dictation engine", "audio.cpp");
	await settled(2);
	expect(stored().engine).toBe("audiocpp");

	await choose("Dictation insertion method", "Paste (clipboard)");
	await settled(3);
	expect(captionFor("Insertion")).toBe(
		"Copies the text and sends the paste shortcut, so it stays instant even for long dictations."
	);
	const pasteCommand = required<HTMLInputElement>("Paste command");
	// happy-dom reports a non-Windows user agent, so the macOS default is shown.
	expect(pasteCommand.placeholder).toBe("cmd+v (default)");
	expect(captionFor("Paste command")).toBe(
		"Key combo to paste, `+`-joined (e.g. ctrl+v, cmd+shift+v). Empty uses the platform default."
	);
	await type(pasteCommand, "ctrl+shift+v");
	await settled(4);
	expect(stored().pasteKeys).toBe("ctrl+shift+v");

	const restore = required("Restore clipboard after paste");
	expect(restore.getAttribute("aria-checked")).toBe("true");
	expect(captionFor("Restore clipboard")).toBe(
		"Put your previous clipboard back after pasting the dictation."
	);
	await click(restore);
	await settled(5);
	expect(stored().restoreClipboard).toBe(false);

	await click(required("Auto-send after dictation"));
	await settled(6);
	expect(
		required("Auto-send after dictation").getAttribute("aria-checked")
	).toBe("true");

	// Each write carried the whole blob: the cleanup prompt, the shortcut and
	// the agent-ask defaults were never dropped, and `enabled` is stamped on.
	const expected = {
		...DEFAULT_DICTATION_PREFS,
		autoSend: true,
		enabled: true,
		engine: "audiocpp",
		insertMode: "paste",
		mode: "push-to-talk",
		pasteKeys: "ctrl+shift+v",
		postProcess: {
			enabled: true,
			prompt: "Keep the speaker's jargon.",
			selection: EMPTY_SELECTION,
		},
		restoreClipboard: false,
		shortcut: "CommandOrControl+Alt+J",
	};
	expect(stored()).toEqual(expected);
	for (const value of putValues()) {
		expect(value).toMatchObject({
			ask: { prompt: DEFAULT_DICTATION_ASK_PROMPT },
			enabled: true,
			postProcess: { prompt: "Keep the speaker's jargon." },
			shortcut: "CommandOrControl+Alt+J",
		});
	}
	expect(puts().every((call) => call.status === 200)).toBe(true);

	// The island companion's own parser reads the identical configuration.
	const island = parseDictationPrefs(store.get("dictation") ?? null);
	expect(island).toMatchObject({
		autoSend: true,
		engine: "audiocpp",
		insertMode: "paste",
		mode: "push-to-talk",
		pasteKeys: "ctrl+shift+v",
		restoreClipboard: false,
		shortcut: "CommandOrControl+Alt+J",
	});

	await remount();
	expect(text(required("Dictation activation mode"))).toBe("Hold to talk");
	expect(text(required("Dictation engine"))).toBe("audio.cpp");
	expect(text(required("Dictation insertion method"))).toBe(
		"Paste (clipboard)"
	);
	expect(required<HTMLInputElement>("Paste command").value).toBe(
		"ctrl+shift+v"
	);
	expect(
		required("Restore clipboard after paste").getAttribute("aria-checked")
	).toBe("false");
	expect(
		required("Auto-send after dictation").getAttribute("aria-checked")
	).toBe("true");

	// Switching back to typing hides the paste rows but keeps their saved values.
	await choose("Dictation insertion method", "Type (synthetic keystrokes)");
	await settled(7);
	expect(labelled("Paste command")).toBeNull();
	expect(labelled("Restore clipboard after paste")).toBeNull();
	expect(stored()).toMatchObject({
		insertMode: "type",
		pasteKeys: "ctrl+shift+v",
		restoreClipboard: false,
	});
});

test("dictation and agent-ask shortcuts are recorded from the keyboard; Escape, blur and bare modifiers write nothing, and Reset restores each default", async () => {
	seed({ ask: { ...DEFAULT_DICTATION_PREFS.ask, enabled: true } });
	await mountLoaded();
	const dictation = required("Set dictation shortcut");
	expect(keycaps("Set dictation shortcut")).toEqual(["Ctrl", "Shift", "D"]);

	await act(async () => {
		dictation.focus();
	});
	await click(dictation);
	expect(text(dictation)).toBe("Press keys…");
	expect(document.activeElement).toBe(dictation);
	// A bare modifier keeps composing; Escape cancels without a write.
	await press(dictation, "Control", { ctrlKey: true });
	expect(text(dictation)).toBe("Press keys…");
	await press(dictation, "Escape");
	expect(keycaps("Set dictation shortcut")).toEqual(["Ctrl", "Shift", "D"]);
	// Without capture armed, a chord is ignored.
	await press(dictation, "k", { altKey: true, ctrlKey: true });
	expect(puts()).toHaveLength(0);

	await click(dictation);
	await press(dictation, "k", { altKey: true, ctrlKey: true });
	await settled(1);
	expect(keycaps("Set dictation shortcut")).toEqual(["Ctrl", "Alt", "K"]);
	expect(stored().shortcut).toBe("CommandOrControl+Alt+K");

	// Blurring an armed capture drops it.
	await click(dictation);
	await act(async () => {
		dictation.dispatchEvent(new FocusEvent("blur"));
		dictation.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
	});
	await press(dictation, "q", { ctrlKey: true });
	expect(puts()).toHaveLength(1);

	const ask = required("Set agent-ask shortcut");
	expect(keycaps("Set agent-ask shortcut")).toEqual(["Ctrl", "Shift", "A"]);
	await click(ask);
	await press(ask, " ", { ctrlKey: true, shiftKey: true });
	await settled(2);
	expect(keycaps("Set agent-ask shortcut")).toEqual(["Ctrl", "Shift", "Space"]);
	expect(stored().ask.shortcut).toBe("CommandOrControl+Shift+Space");
	expect(stored().shortcut).toBe("CommandOrControl+Alt+K");

	let island = parseDictationPrefs(store.get("dictation") ?? null);
	expect(island.shortcut).toBe("CommandOrControl+Alt+K");
	expect(island.ask.shortcut).toBe("CommandOrControl+Shift+Space");

	const resets = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].filter((button) => text(button) === "Reset");
	expect(resets).toHaveLength(2);
	await click(resets[0]!);
	await settled(3);
	expect(stored().shortcut).toBe("CommandOrControl+Shift+D");
	expect(stored().ask.shortcut).toBe("CommandOrControl+Shift+Space");
	await click(resets[1]!);
	await settled(4);
	island = parseDictationPrefs(store.get("dictation") ?? null);
	expect(island.shortcut).toBe("CommandOrControl+Shift+D");
	expect(island.ask.shortcut).toBe("CommandOrControl+Shift+A");

	await remount();
	expect(keycaps("Set dictation shortcut")).toEqual(["Ctrl", "Shift", "D"]);
	expect(keycaps("Set agent-ask shortcut")).toEqual(["Ctrl", "Shift", "A"]);
});

test("Clean up with Speech Processing gates the cleanup engine, override and prompt; the engine write keeps the node's other Speech Processing controls", async () => {
	seed({});
	const speech = {
		context: "email",
		engine: "s1-mini",
		structure: "lists",
		styling: "formal",
	};
	store.set("speech-processing", JSON.stringify(speech));
	await mountLoaded();

	expect(captionFor("Clean up with Speech Processing")).toBe(
		"Run the selected Speech Processing engine after Voice Recognition. Defaults to S1-mini by Superwhisper; turn this off to insert the raw transcript."
	);
	const cleanup = required("Clean up dictation with Speech Processing");
	expect(cleanup.getAttribute("aria-checked")).toBe("true");
	expect(text(required("Speech Processing engine"))).toBe(
		"S1-mini by Superwhisper"
	);
	expect(captionFor("Cleanup engine")).toBe(
		"The node-local cleanup model. Style, structure, and context are configured from the Speech Processing layer on the Computer dialog's Voice & sandbox page."
	);
	expect(captionFor("Custom cleanup override")).toBe(
		"Leave empty to use the selected Speech Processing engine. Pick an agent or model only for an explicit custom cleanup override."
	);
	expect(text(required("Dictation cleanup agent or model"))).toBe(
		"Use Speech Processing engine"
	);
	expect(captionFor("Custom cleanup prompt")).toBe(
		"Used only when a custom cleanup agent/model is selected. S1-mini uses its required local control prompt."
	);
	expect(required<HTMLTextAreaElement>("Dictation cleanup prompt").value).toBe(
		DEFAULT_DICTATION_POSTPROCESS_PROMPT
	);

	await choose("Speech Processing engine", "S1-mini by Superwhisper");
	await settled(1, SPEECH_PATH);
	// The cleanup engine is its own preference and conserves the style,
	// structure and context the Computer dialog owns.
	expect(stored("speech-processing")).toEqual(speech);
	expect(puts()).toHaveLength(0);

	await pickCustomModel("Dictation cleanup agent or model", "cleanup-local");
	await settled(1);
	expect(text(required("Dictation cleanup agent or model"))).toBe(
		"cleanup-local"
	);
	expect(stored().postProcess.selection).toEqual({
		...EMPTY_SELECTION,
		model: "cleanup-local",
	});

	await type(
		required<HTMLTextAreaElement>("Dictation cleanup prompt"),
		"Only fix punctuation."
	);
	await settled(2);
	expect(stored().postProcess).toEqual({
		enabled: true,
		prompt: "Only fix punctuation.",
		selection: { ...EMPTY_SELECTION, model: "cleanup-local" },
	});

	await click(cleanup);
	await settled(3);
	expect(labelled("Speech Processing engine")).toBeNull();
	expect(labelled("Dictation cleanup agent or model")).toBeNull();
	expect(labelled("Dictation cleanup prompt")).toBeNull();
	expect(rowTitles()).not.toContain("Custom cleanup prompt");
	// Turning cleanup off records the opt-out but keeps the override and prompt.
	expect(stored().postProcess).toEqual({
		enabled: false,
		prompt: "Only fix punctuation.",
		selection: { ...EMPTY_SELECTION, model: "cleanup-local" },
	});
	expect(
		parseDictationPrefs(store.get("dictation") ?? null).postProcess
	).toEqual({
		enabled: false,
		prompt: "Only fix punctuation.",
		selection: { ...EMPTY_SELECTION, model: "cleanup-local" },
	});

	await remount();
	expect(
		required("Clean up dictation with Speech Processing").getAttribute(
			"aria-checked"
		)
	).toBe("false");
	expect(labelled("Dictation cleanup prompt")).toBeNull();
	await click(required("Clean up dictation with Speech Processing"));
	await settled(4);
	expect(text(required("Dictation cleanup agent or model"))).toBe(
		"cleanup-local"
	);
	expect(required<HTMLTextAreaElement>("Dictation cleanup prompt").value).toBe(
		"Only fix punctuation."
	);

	// "Use the default" clears the override back to the Speech Processing engine.
	await click(required("Dictation cleanup agent or model"));
	await until(
		() =>
			[...document.querySelectorAll("button")].some(
				(button) => text(button) === "Use the default"
			),
		"inherit row"
	);
	await click(
		[...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => text(button) === "Use the default"
		)!
	);
	await settled(5);
	expect(stored().postProcess.selection).toEqual(EMPTY_SELECTION);
	expect(text(required("Dictation cleanup agent or model"))).toBe(
		"Use Speech Processing engine"
	);
	expect(stored("speech-processing")).toEqual(speech);
});

test("Agent ask reveals its shortcut, activation, agent and prompt; the picked agent opens its access panel and wins over the cleanup agent", async () => {
	seed({
		postProcess: {
			enabled: true,
			prompt: DEFAULT_DICTATION_POSTPROCESS_PROMPT,
			selection: { ...EMPTY_SELECTION, agent_id: "dictation-editor" },
		},
	});
	await mountLoaded();
	expect(captionFor("Agent ask")).toBe(
		"Hold the agent-ask shortcut, ask a question, and paste the agent's answer."
	);
	const enable = required("Enable agent ask");
	expect(enable.getAttribute("aria-checked")).toBe("false");
	for (const label of [
		"Set agent-ask shortcut",
		"Agent-ask activation mode",
		"Agent-ask agent or model",
		"Agent-ask prompt",
	]) {
		expect(labelled(label)).toBeNull();
	}
	// With agent ask off, the cleanup agent owns the access panel.
	await until(
		() => agentReads("dictation-editor").length === 1,
		"cleanup agent access panel"
	);
	expect(agentReads("dictation-scribe")).toHaveLength(0);

	await click(enable);
	await settled(1);
	expect(stored().ask.enabled).toBe(true);
	expect(rowTitles()).toEqual(
		expect.arrayContaining([
			"Agent-ask shortcut",
			"Activation",
			"Agent",
			"Ask prompt",
		])
	);
	expect(captionFor("Agent-ask shortcut")).toBe(
		"Global key for agent-ask. Kept separate from the dictation shortcut."
	);
	const activations = [
		...container.querySelectorAll('[data-slot="item-title"]'),
	].filter((title) => text(title) === "Activation");
	expect(activations).toHaveLength(2);
	const askActivationCaption = () =>
		text(
			activations[1]!.closest('[data-slot="item-group"]')?.nextElementSibling
		);
	expect(askActivationCaption()).toBe(
		"Hold the shortcut to record; release to ask and paste the answer."
	);
	await choose("Agent-ask activation mode", "Press to start / stop");
	await settled(2);
	expect(askActivationCaption()).toBe(
		"Press once to start, again to stop, ask, and paste the answer."
	);
	expect(stored().ask.mode).toBe("toggle");
	// The dictation activation is independent of the agent-ask one.
	expect(stored().mode).toBe("push-to-talk");

	expect(captionFor("Agent")).toBe(
		"Prefer an agent when you want tool access (Spaces, Ghost, other apps). A model-only pick answers without tools."
	);
	expect(text(required("Agent-ask agent or model"))).toBe(
		"Default local model"
	);
	await pickAgent("Agent-ask agent or model", "Scribe agent");
	await settled(3);
	expect(stored().ask.selection).toEqual({
		...EMPTY_SELECTION,
		agent_id: "dictation-scribe",
	});
	expect(text(required("Agent-ask agent or model"))).toBe("Scribe agent");
	// The ask agent now owns the access panel, ahead of the cleanup agent.
	await until(
		() => agentReads("dictation-scribe").length === 1,
		"ask agent access panel"
	);

	expect(captionFor("Ask prompt")).toBe(
		"Instructions for the ask agent. It sees this plus your spoken question."
	);
	const prompt = required<HTMLTextAreaElement>("Agent-ask prompt");
	expect(prompt.value).toBe(DEFAULT_DICTATION_ASK_PROMPT);
	// Typing re-renders the tab on every keystroke; the open access panel must
	// not reload the agent, its Spaces and its tools each time.
	const panelReads = () =>
		calls.filter(
			(call) =>
				call.method === "GET" &&
				[
					"/api/agents/dictation-scribe",
					"/api/spaces",
					"/api/mcp/tools",
				].includes(call.path)
		).length;
	const readsBeforeTyping = panelReads();
	await type(prompt, "A");
	await type(prompt, "Answer");
	await type(prompt, "Answer in one sentence.");
	await settled(6);
	expect(panelReads()).toBe(readsBeforeTyping);
	expect(stored().ask).toEqual({
		enabled: true,
		mode: "toggle",
		prompt: "Answer in one sentence.",
		selection: { ...EMPTY_SELECTION, agent_id: "dictation-scribe" },
		shortcut: "CommandOrControl+Shift+A",
	});
	expect(parseDictationPrefs(store.get("dictation") ?? null).ask).toEqual(
		stored().ask
	);
	// The cleanup agent was never touched by agent-ask writes.
	expect(stored().postProcess.selection.agent_id).toBe("dictation-editor");

	await remount();
	expect(required("Enable agent ask").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(text(required("Agent-ask activation mode"))).toBe(
		"Press to start / stop"
	);
	expect(required<HTMLTextAreaElement>("Agent-ask prompt").value).toBe(
		"Answer in one sentence."
	);
	await until(
		() => text(labelled("Agent-ask agent or model")) === "Scribe agent",
		"agent summary after remount"
	);
	// The remounted tab reopens the ask agent's access panel from Core.
	await until(
		() => agentReads("dictation-scribe").length === 2,
		"ask agent panel after remount"
	);

	// Turning agent ask off hides its rows, keeps its values, and hands the
	// access panel back to the cleanup agent.
	const scribeReads = agentReads("dictation-scribe").length;
	const editorReads = agentReads("dictation-editor").length;
	await click(required("Enable agent ask"));
	await settled(7);
	expect(labelled("Agent-ask prompt")).toBeNull();
	expect(stored().ask).toMatchObject({
		enabled: false,
		prompt: "Answer in one sentence.",
	});
	await until(
		() => agentReads("dictation-editor").length === editorReads + 1,
		"cleanup agent panel returns"
	);
	expect(agentReads("dictation-scribe")).toHaveLength(scribeReads);
});

test("a failed load offers Retry; refused saves keep the edit, name the failed preference, and Retry save writes the identical blob; queued writes reach Core in order", async () => {
	seed({ pasteKeys: "", insertMode: "paste" });
	arm("GET", DICTATION_PATH, 503);
	await mount();
	await until(
		() => container.querySelector('[role="alert"]') !== null,
		"load failure"
	);
	expect(alertMessage()).toBe("Could not load Dictation settings.");
	expect(labelled("Set dictation shortcut")).toBeNull();
	await click(
		[...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => text(button) === "Retry"
		)!
	);
	await until(() => labelled("Set dictation shortcut") !== null, "retry load");
	expect(
		calls
			.filter((call) => call.method === "GET" && call.path === DICTATION_PATH)
			.map((call) => call.status)
	).toEqual([503, 200]);

	arm("PUT", DICTATION_PATH, 503);
	await click(required("Auto-send after dictation"));
	await until(
		() => alertMessage() === "Could not save Dictation settings.",
		"dictation save failure"
	);
	// The control keeps the user's change while the save is retried.
	expect(
		required("Auto-send after dictation").getAttribute("aria-checked")
	).toBe("true");
	expect(stored().autoSend).toBe(false);
	await click(
		[...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => text(button) === "Retry save"
		)!
	);
	await settled(2);
	await until(
		() => container.querySelector('[role="alert"]') === null,
		"alert cleared"
	);
	expect(puts().map((call) => call.status)).toEqual([503, 200]);
	expect(putValues()[0]).toEqual(putValues()[1]);
	expect(stored().autoSend).toBe(true);

	arm("PUT", SPEECH_PATH, 500);
	await choose("Speech Processing engine", "S1-mini by Superwhisper");
	await until(
		() => alertMessage() === "Could not save Speech Processing settings.",
		"speech save failure"
	);
	expect(store.has("speech-processing")).toBe(false);
	await click(
		[...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => text(button) === "Retry save"
		)!
	);
	await settled(2, SPEECH_PATH);
	await until(
		() => container.querySelector('[role="alert"]') === null,
		"speech alert cleared"
	);
	expect(stored("speech-processing")).toEqual({
		context: "general",
		engine: "s1-mini",
		structure: "prose",
		styling: "semi-formal",
	});

	// Keystrokes queue behind a held write and land at Core in typing order,
	// never two at once, so the last keystroke is what Core keeps.
	holdNextPut = DICTATION_PATH;
	const pasteCommand = required<HTMLInputElement>("Paste command");
	await type(pasteCommand, "c");
	await until(() => releaseHeld !== null, "held write");
	await type(pasteCommand, "ct");
	await type(pasteCommand, "ctrl+v");
	// Give any unqueued write ample time to reach Core: none may, while the
	// first one is still unanswered.
	for (let tick = 0; tick < 20; tick += 1) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	expect(puts()).toHaveLength(3);
	expect(puts().filter((call) => call.status === 0)).toHaveLength(1);
	releaseHeld!();
	await settled(5);
	expect(
		putValues()
			.slice(2)
			.map((value) => (value as { pasteKeys: string }).pasteKeys)
	).toEqual(["c", "ct", "ctrl+v"]);
	expect(stored().pasteKeys).toBe("ctrl+v");
	expect(pasteCommand.value).toBe("ctrl+v");
});
