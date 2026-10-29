import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
	answerDesktopSecretSlot,
	memorySlotStorage,
} from "../../../e2e/harness/desktop-secret-slots.ts";

// The REAL Settings → Island tab, mounted in happy-dom and talking through the
// production preference SDK to two loopback Bun servers: the device-local Core
// (Shadow capture control) and the user's SELECTED node, which owns every
// Island preference. Nothing under test is substituted. The Island companion is
// a separate Electron process that reads the same Core keys, so each case also
// feeds what Core stored into the Island's OWN parsers
// (apps/island/src/shared/*) and asserts the setting the companion would apply.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const previousCoreUrl = process.env.VITE_CORE_URL;
const DEVICE_TOKEN = "ibk-device-local-bearer";
const NODE_TOKEN = "ibk-selected-node-bearer";

interface Exchange {
	authorization: string | null;
	body: unknown;
	completed: boolean;
	method: string;
	path: string;
	server: "device" | "node";
	status: number;
}
let exchanges: Exchange[] = [];
let undeclared: string[] = [];
const egress: string[] = [];

// ── Device-local Core: Shadow capture control only ─────────────────────────
const deviceCapture = {
	app_allowlist: [] as string[],
	frames: true,
	history_retention_days: 30,
	paused: false,
};
const deviceServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const body = request.method === "POST" ? await request.json() : null;
		const exchange: Exchange = {
			authorization: request.headers.get("authorization"),
			body,
			completed: false,
			method: request.method,
			path: url.pathname,
			server: "device",
			status: 0,
		};
		exchanges.push(exchange);
		const reply = (value: unknown, status = 200) => {
			exchange.status = status;
			exchange.completed = true;
			return NativeResponse.json(value, { status });
		};
		if (exchange.authorization !== `Bearer ${DEVICE_TOKEN}`) {
			undeclared.push(`device ${request.method} ${url.pathname} bad bearer`);
			return reply({ error: "unknown authority" }, 401);
		}
		if (url.pathname === "/api/shadow/capture/control") {
			if (request.method === "POST") {
				Object.assign(deviceCapture, body);
			}
			return reply({ ...deviceCapture });
		}
		undeclared.push(`device ${request.method} ${url.pathname}`);
		return reply({ error: "undeclared device route" }, 404);
	},
});

// ── Selected node: the Island preference store plus the pickers' catalogs ──
const SEEDED_PREFERENCES: Record<string, string> = {
	"island-agents": JSON.stringify({ voiceAgent: "ryu", proactiveAgent: "ryu" }),
	"island-appearance": JSON.stringify({ background: "acrylic" }),
	"island-auto-jump": "false",
	"island-command-shortcut": "CommandOrControl+Shift+Space",
	"island-consent": JSON.stringify({
		chat: true,
		contextRead: null,
		proactive: null,
	}),
	"island-edge-offset": "20",
	"island-hide-on-fullscreen": "true",
	"island-notch-mode": "false",
	"island-screen-privacy": "true",
	"island-tts": JSON.stringify({
		enabled: false,
		engine: "kokoro",
		voice: "af_heart",
	}),
	"voice-input": JSON.stringify({
		enabled: false,
		engine: "parakeet",
		mode: "toggle",
		model: "parakeet-tdt-0.6b-v3",
		shortcut: "CommandOrControl+Shift+A",
	}),
	// Records this tab must never touch.
	dictation: JSON.stringify({ shortcut: "CommandOrControl+Alt+D" }),
	keybindings: JSON.stringify({ "chat.new": "Mod+Shift+N" }),
};
const UNRELATED_KEYS = ["dictation", "keybindings"] as const;
const ENTITLEMENT_KEYS = ["entitlement-active", "managed-inference-entitled"];
let nodePreferences = new Map<string, string>();
/** `PUT key` → status to answer the next matching write with. */
let refusals = new Map<string, number>();
/** `PUT key` → a held write; the test releases it with a status. */
const holdRequests = new Set<string>();
let held: Array<{ key: string; release: (status: number) => void }> = [];

const nodeServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const body = request.method === "PUT" ? await request.json() : null;
		const exchange: Exchange = {
			authorization: request.headers.get("authorization"),
			body,
			completed: false,
			method: request.method,
			path: url.pathname,
			server: "node",
			status: 0,
		};
		exchanges.push(exchange);
		const reply = (value: unknown, status = 200) => {
			exchange.status = status;
			exchange.completed = true;
			return NativeResponse.json(value, { status });
		};
		if (exchange.authorization !== `Bearer ${NODE_TOKEN}` || url.search) {
			undeclared.push(`node ${request.method} ${url.pathname} bad authority`);
			return reply({ error: "unknown authority" }, 401);
		}
		if (url.pathname.startsWith("/api/preferences/")) {
			const key = decodeURIComponent(
				url.pathname.slice("/api/preferences/".length)
			);
			if (request.method === "GET") {
				const value = nodePreferences.get(key);
				return value === undefined
					? reply({ error: "preference_not_found" }, 404)
					: reply({ key, value });
			}
			if (request.method === "PUT") {
				const value =
					body && typeof body === "object" && "value" in body
						? (body as { value: unknown }).value
						: undefined;
				if (typeof value !== "string" || Object.keys(body).length !== 1) {
					undeclared.push(`node PUT ${key} malformed body`);
					return reply({ error: "invalid_preference_value" }, 400);
				}
				const marker = `PUT ${key}`;
				let status = refusals.get(marker) ?? 200;
				refusals.delete(marker);
				if (holdRequests.has(marker)) {
					holdRequests.delete(marker);
					status = await new Promise<number>((resolve) => {
						held.push({ key, release: resolve });
					});
				}
				if (status !== 200) {
					return reply({ error: "fixture_refusal" }, status);
				}
				nodePreferences.set(key, value);
				return reply({ key, value });
			}
		}
		if (request.method === "GET" && url.pathname === "/api/agents") {
			return reply({
				agents: [
					{ id: "ryu", name: "Ryu", recommended: true, transport: "acp" },
					{ id: "support-agent", name: "Support agent" },
				],
			});
		}
		if (request.method === "GET" && url.pathname === "/api/voice/tts-engines") {
			const engine = (
				id: string,
				displayName: string,
				voices: string[],
				installed = true
			) => ({
				default_voice: voices[0] ?? "",
				description: `${displayName} fixture`,
				display_name: displayName,
				id,
				installed,
				languages: ["en"],
				loaded: installed,
				sample_rate: 24_000,
				size_mb: 100,
				supports_cloning: false,
				voices,
			});
			return reply({
				data: [
					engine("kokoro", "Kokoro 82M", ["af_heart", "af_nova"]),
					engine("outetts", "OuteTTS", ["Mika", "af_nova"]),
					engine("piper", "Piper", [], false),
				],
			});
		}
		if (request.method === "GET" && url.pathname === "/api/engines") {
			return reply({ engines: [] });
		}
		if (request.method === "GET" && url.pathname === "/api/engine/active") {
			return reply({
				active: null,
				available: [],
				llamacpp_variant: null,
				running: false,
			});
		}
		undeclared.push(`node ${request.method} ${url.pathname}`);
		return reply({ error: "undeclared node route" }, 404);
	},
});

process.env.VITE_CORE_URL = deviceServer.url.origin;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Tauri store IPC boundary (companion.bin for Shadow capture, entitlement.bin
// for the entitlement provider). This is the host command boundary the shipping
// @tauri-apps/plugin-store frontend invokes; no store logic is replaced.
const companionStore = new Map<string, unknown>();
const secretSlots = memorySlotStorage();
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: (command: string, args: Record<string, unknown>) => {
		// The auth client and entitlement provider read their sealed slots on load.
		const slot = answerDesktopSecretSlot(secretSlots, command, args);
		if (slot.handled) {
			return slot.value;
		}
		if (command === "plugin:store|load") {
			if (args.path === "companion.bin") {
				return 1;
			}
			if (args.path === "entitlement.bin") {
				return 2;
			}
		}
		if (command === "plugin:store|get" && args.rid === 2) {
			return args.key === "firstLaunchAtMs"
				? [Date.now(), true]
				: [null, false];
		}
		if (args.rid === 1) {
			const key = String(args.key);
			if (command === "plugin:store|get") {
				return [companionStore.get(key), companionStore.has(key)];
			}
			if (command === "plugin:store|set") {
				companionStore.set(key, args.value);
				return;
			}
			if (command === "plugin:store|save") {
				return;
			}
		}
		undeclared.push(`ipc ${command}`);
		throw new Error(`Undeclared store IPC ${command}`);
	},
});

let inFlight = 0;
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof nativeFetch>) => {
		const input = args[0];
		const href =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const origin = new URL(href).origin;
		if (
			origin !== deviceServer.url.origin &&
			origin !== nodeServer.url.origin
		) {
			egress.push(origin);
			throw new Error("Island coverage refuses unowned egress");
		}
		// Counts requests still waiting for their response headers.
		inFlight += 1;
		try {
			return await nativeFetch(...args);
		} finally {
			inFlight -= 1;
		}
	},
	{ preconnect: nativeFetch.preconnect }
);

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { queryClient: sharedAgentQueryClient } = await import(
	"@/src/lib/query-client.ts"
);
const componentSource =
	process.env.RYU_IBK_ISLAND_SETTINGS_SOURCE ?? "./IslandSettings.tsx";
const { IslandSettings } = (await import(
	componentSource
)) as typeof import("./IslandSettings.tsx");
// The Island companion's own readers for the same Core keys.
const { parseNotchMode } = await import(
	"../../../../island/src/shared/notch.ts"
);
const { parseAppearance } = await import(
	"../../../../island/src/shared/appearance.ts"
);
const { parseEdgeOffset } = await import(
	"../../../../island/src/shared/edge-offset.ts"
);
const { parseAutoJump } = await import(
	"../../../../island/src/shared/auto-jump.ts"
);
const { parseHideOnFullscreen } = await import(
	"../../../../island/src/shared/hide-on-fullscreen.ts"
);
const { parseScreenPrivacy } = await import(
	"../../../../island/src/shared/screen-privacy.ts"
);
const { parseIslandAgentPrefs, agentIdOrUndefined } = await import(
	"../../../../island/src/shared/agents.ts"
);
const { parseVoicePrefs } = await import(
	"../../../../island/src/shared/voice.ts"
);
const { parseCommandShortcut } = await import(
	"../../../../island/src/shared/command-shortcut.ts"
);
const { parseIslandTtsPrefs } = await import(
	"../../../../island/src/shared/tts.ts"
);
const { parseConsent } = await import(
	"../../../../island/src/shared/consent.ts"
);
const { chatAllowed, contextReadAllowed, engineAllowed } = await import(
	"../../../../island/src/main/services/consent-logic.ts"
);

const originalNodeState = useNodeStore.getState();

/** What the Island companion applies after reading the selected node. */
function islandView() {
	const raw = (key: string) => nodePreferences.get(key) ?? null;
	const consent = parseConsent(raw("island-consent"));
	return {
		agents: parseIslandAgentPrefs(raw("island-agents")),
		appearance: parseAppearance(raw("island-appearance")).background,
		autoJump: parseAutoJump(raw("island-auto-jump")),
		commandShortcut: parseCommandShortcut(raw("island-command-shortcut")),
		consent,
		edgeOffset: parseEdgeOffset(raw("island-edge-offset")),
		gates: {
			chat: chatAllowed(consent),
			contextRead: contextReadAllowed(consent),
			suggestions: engineAllowed(consent),
		},
		hideOnFullscreen: parseHideOnFullscreen(raw("island-hide-on-fullscreen")),
		notch: parseNotchMode(raw("island-notch-mode")),
		screenPrivacy: parseScreenPrivacy(raw("island-screen-privacy")),
		tts: parseIslandTtsPrefs(raw("island-tts")),
		voice: parseVoicePrefs(raw("voice-input")),
	};
}

// ── Mounting and DOM helpers ───────────────────────────────────────────────
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: InstanceType<typeof QueryClient> | null = null;

async function settle(predicate: () => boolean, label: string) {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`Condition not reached: ${label}`);
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
}

async function flush(ms = 30) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

// IslandSettings.tsx EDGE_OFFSET_WRITE_DEBOUNCE_MS. While held, timers with
// exactly this delay wait for the case to elapse them, so a loaded host can
// neither fire the debounced write early nor split one settle into several.
const EDGE_OFFSET_DEBOUNCE_MS = 200;
let releaseDebounceHold: (() => void) | null = null;

function holdDebounce() {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const pending = new Map<number, () => void>();
	let nextId = 900_000_000;
	const heldSetTimeout = (
		handler: TimerHandler,
		timeout?: number,
		...args: unknown[]
	) => {
		if (timeout === EDGE_OFFSET_DEBOUNCE_MS && typeof handler === "function") {
			nextId += 1;
			pending.set(nextId, () => handler(...args));
			return nextId;
		}
		return realSetTimeout(handler, timeout, ...args);
	};
	const heldClearTimeout = (id?: Parameters<typeof clearTimeout>[0]) => {
		if (typeof id === "number" && pending.delete(id)) {
			return;
		}
		realClearTimeout(id);
	};
	Reflect.set(globalThis, "setTimeout", heldSetTimeout);
	Reflect.set(globalThis, "clearTimeout", heldClearTimeout);
	releaseDebounceHold = () => {
		Reflect.set(globalThis, "setTimeout", realSetTimeout);
		Reflect.set(globalThis, "clearTimeout", realClearTimeout);
		releaseDebounceHold = null;
	};
	return {
		pending: () => pending.size,
		async elapse() {
			const due = [...pending.values()];
			pending.clear();
			await act(async () => {
				for (const run of due) {
					run();
				}
			});
		},
	};
}

const ISLAND_KEYS = Object.keys(SEEDED_PREFERENCES).filter(
	(key) => !(UNRELATED_KEYS as readonly string[]).includes(key)
);

function preferenceReads() {
	return exchanges
		.filter(
			(exchange) =>
				exchange.method === "GET" &&
				exchange.completed &&
				exchange.path.startsWith("/api/preferences/")
		)
		.map((exchange) => exchange.path.slice("/api/preferences/".length));
}

async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	client = new QueryClient({
		defaultOptions: { queries: { gcTime: 0, retry: false } },
	});
	root = createRoot(container);
	const readsBefore = preferenceReads().length;
	await act(async () =>
		root!.render(
			<QueryClientProvider client={client!}>
				<EntitlementProvider>
					<IslandSettings />
				</EntitlementProvider>
			</QueryClientProvider>
		)
	);
	await settle(() => {
		const reads = preferenceReads().slice(readsBefore);
		return (
			ISLAND_KEYS.every((key) => reads.includes(key)) &&
			exchanges.some(
				(exchange) => exchange.path === "/api/agents" && exchange.completed
			) &&
			exchanges.some(
				(exchange) =>
					exchange.path === "/api/voice/tts-engines" && exchange.completed
			) &&
			inFlight === 0
		);
	}, "every Island preference and catalog read");
	await flush();
}

async function unmount() {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	client?.clear();
	sharedAgentQueryClient.clear();
	client = null;
	container?.remove();
	container = null;
}

async function remount() {
	await unmount();
	await mount();
}

function text(node: Element | null = container) {
	return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function byLabel<T extends HTMLElement = HTMLElement>(label: string): T {
	const matches = Array.from(
		container!.querySelectorAll<T>(`[aria-label="${label}"]`)
	);
	if (matches.length !== 1) {
		throw new Error(`Expected one "${label}" control, found ${matches.length}`);
	}
	return matches[0]!;
}

function present(label: string) {
	return container!.querySelector(`[aria-label="${label}"]`) !== null;
}

function row(title: string) {
	const titles = Array.from(
		container!.querySelectorAll('[data-slot="item-title"]')
	).filter((candidate) => candidate.textContent?.trim() === title);
	if (titles.length !== 1) {
		throw new Error(`Expected one "${title}" row, found ${titles.length}`);
	}
	return titles[0]!.closest<HTMLElement>('[data-slot="item"]')!;
}

function hasRow(title: string) {
	return Array.from(
		container!.querySelectorAll('[data-slot="item-title"]')
	).some((candidate) => candidate.textContent?.trim() === title);
}

function isOn(control: HTMLElement) {
	return control.getAttribute("aria-checked") === "true";
}

function isDisabled(control: HTMLElement) {
	return (
		control.hasAttribute("data-disabled") ||
		control.getAttribute("aria-disabled") === "true" ||
		(control instanceof HTMLButtonElement && control.disabled)
	);
}

function keycaps(label: string) {
	return Array.from(byLabel(label).querySelectorAll("kbd")).map(
		(cap) => cap.textContent
	);
}

function shown(combo: HTMLElement) {
	return combo.textContent?.replace("▼", "").replace(/\s+/g, " ").trim();
}

function openOptions() {
	const box = Array.from(
		document.querySelectorAll<HTMLElement>('[role="listbox"]')
	)
		.filter(
			(candidate) =>
				!(
					candidate.hasAttribute("data-closed") ||
					candidate.closest("[data-closed]")
				)
		)
		.at(-1);
	return Array.from(
		box?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
	);
}

function optionLabels() {
	return openOptions().map((option) =>
		option.textContent?.replace(/\s+/g, " ").trim()
	);
}

/** Pick `option` from the select labelled `label`; returns every option offered. */
async function choose(label: string, option: string) {
	const combo = byLabel(label);
	await act(async () => combo.click());
	await settle(() => optionLabels().includes(option), `${label} → ${option}`);
	const offered = optionLabels();
	const match = openOptions().find(
		(candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === option
	)!;
	await act(async () => match.click());
	await settle(
		() => combo.getAttribute("aria-expanded") !== "true",
		`${label} listbox closed`
	);
	await settlePuts();
	return offered;
}

async function toggle(label: string) {
	await act(async () => byLabel(label).click());
	await settlePuts();
}

async function keydown(target: HTMLElement, init: KeyboardEventInit) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
		);
	});
	await settlePuts();
}

async function settlePuts() {
	await flush(20);
	await settle(
		() =>
			inFlight === held.length &&
			exchanges.every((exchange) => exchange.completed || isHeld(exchange)),
		"preference writes acknowledged"
	);
	await flush(20);
}

function isHeld(exchange: Exchange) {
	return held.some(
		(entry) =>
			exchange.method === "PUT" &&
			exchange.path === `/api/preferences/${entry.key}`
	);
}

function writes(key: string) {
	return exchanges
		.filter(
			(exchange) =>
				exchange.method === "PUT" && exchange.path === `/api/preferences/${key}`
		)
		.map((exchange) => ({
			status: exchange.status,
			value: (exchange.body as { value: string }).value,
		}));
}

function islandWrites() {
	return exchanges.filter(
		(exchange) =>
			exchange.method === "PUT" &&
			ISLAND_KEYS.some((key) => exchange.path === `/api/preferences/${key}`)
	);
}

const ALERT =
	"Couldn't save Island setting. The previous value was restored. Choose the setting again to retry.";
function alertShown() {
	return Array.from(container!.querySelectorAll('[role="alert"]')).some(
		(node) => text(node) === ALERT
	);
}

async function waitForHeld(key: string) {
	await settle(
		() => held.some((entry) => entry.key === key),
		`held write for ${key}`
	);
}

async function releaseHeld(key: string, status: number) {
	const index = held.findIndex((entry) => entry.key === key);
	const [entry] = held.splice(index, 1);
	await act(async () => entry!.release(status));
	await settlePuts();
}

beforeEach(() => {
	exchanges = [];
	undeclared = [];
	egress.length = 0;
	refusals = new Map();
	holdRequests.clear();
	held = [];
	nodePreferences = new Map(Object.entries(SEEDED_PREFERENCES));
	companionStore.clear();
	Object.assign(deviceCapture, {
		app_allowlist: [],
		frames: true,
		history_retention_days: 30,
		paused: false,
	});
	localStorage.clear();
	const device = {
		name: "device-local",
		token: DEVICE_TOKEN,
		url: deviceServer.url.origin,
		userJwt: null,
	};
	const selected = {
		name: "selected-node",
		token: NODE_TOKEN,
		url: nodeServer.url.origin,
		userJwt: null,
	};
	useNodeStore.setState({
		autoSelect: false,
		autoSelectedNode: null,
		cloudNodes: [],
		defaultNode: selected.name,
		localNodes: [device, selected],
		nodes: [device, selected],
		tabOverrides: {},
	});
});

afterEach(async () => {
	releaseDebounceHold?.();
	for (const entry of held.splice(0)) {
		entry.release(503);
	}
	await settle(
		() =>
			ENTITLEMENT_KEYS.every((key) =>
				exchanges.some(
					(exchange) =>
						exchange.method === "PUT" &&
						exchange.path === `/api/preferences/${key}` &&
						exchange.completed
				)
			) && inFlight === 0,
		"entitlement bootstrap writes settled"
	);
	await unmount();
	// Every case also proves these invariants; a violation fails that case.
	// Unrelated records on the selected node are byte-identical.
	for (const key of UNRELATED_KEYS) {
		if (
			nodePreferences.get(key) !== SEEDED_PREFERENCES[key] ||
			writes(key).length > 0
		) {
			throw new Error(`Unrelated preference ${key} was written`);
		}
	}
	// Island preferences live on the selected node only; the device-local Core
	// sees nothing but Shadow capture control.
	const deviceRoutes = exchanges
		.filter((exchange) => exchange.server === "device")
		.map((exchange) => exchange.path)
		.filter((path) => path !== "/api/shadow/capture/control");
	if (deviceRoutes.length > 0) {
		throw new Error(`Device-local Core got ${JSON.stringify(deviceRoutes)}`);
	}
	if (undeclared.length > 0 || egress.length > 0) {
		throw new Error(
			`Undeclared traffic ${JSON.stringify({ egress, undeclared })}`
		);
	}
});

afterAll(async () => {
	useNodeStore.setState(originalNodeState);
	globalThis.fetch = nativeFetch;
	if (previousCoreUrl === undefined) {
		delete process.env.VITE_CORE_URL;
	} else {
		process.env.VITE_CORE_URL = previousCoreUrl;
	}
	await deviceServer.stop(true);
	await nodeServer.stop(true);
});

// ── Cases ──────────────────────────────────────────────────────────────────

test("Summon command bar records a chord by keyboard, ignores modifier-only, Escape and blur, rolls back a refused save, and the Island registers what Core stored", async () => {
	await mount();
	const capture = () => byLabel<HTMLButtonElement>("Set command bar shortcut");
	expect(hasRow("Summon command bar")).toBe(true);
	expect(keycaps("Set command bar shortcut")).toEqual([
		"Ctrl",
		"Shift",
		"Space",
	]);

	// Composing: a bare modifier keeps capturing; Escape and blur cancel.
	await act(async () => capture().click());
	expect(text(capture())).toBe("Press keys…");
	await keydown(capture(), { ctrlKey: true, key: "Control" });
	expect(text(capture())).toBe("Press keys…");
	await keydown(capture(), { key: "Escape" });
	expect(keycaps("Set command bar shortcut")).toEqual([
		"Ctrl",
		"Shift",
		"Space",
	]);
	await act(async () => {
		capture().focus();
		capture().click();
	});
	expect(text(capture())).toBe("Press keys…");
	await act(async () => capture().blur());
	expect(keycaps("Set command bar shortcut")).toEqual([
		"Ctrl",
		"Shift",
		"Space",
	]);
	// A keypress after cancelling is not a capture.
	await keydown(capture(), { altKey: true, key: "q" });
	expect(writes("island-command-shortcut")).toEqual([]);

	await act(async () => capture().click());
	await keydown(capture(), { altKey: true, ctrlKey: true, key: "k" });
	expect(writes("island-command-shortcut")).toEqual([
		{ status: 200, value: "CommandOrControl+Alt+K" },
	]);
	expect(keycaps("Set command bar shortcut")).toEqual(["Ctrl", "Alt", "K"]);
	expect(islandView().commandShortcut).toBe("CommandOrControl+Alt+K");

	// A refused save restores the previous chord and says so.
	refusals.set("PUT island-command-shortcut", 503);
	await act(async () => capture().click());
	await keydown(capture(), { altKey: true, key: "ArrowUp" });
	expect(writes("island-command-shortcut").at(-1)).toEqual({
		status: 503,
		value: "Alt+Up",
	});
	expect(keycaps("Set command bar shortcut")).toEqual(["Ctrl", "Alt", "K"]);
	expect(alertShown()).toBe(true);
	expect(islandView().commandShortcut).toBe("CommandOrControl+Alt+K");

	// Choosing again retries, clears the alert, and survives a remount.
	await act(async () => capture().click());
	await keydown(capture(), { altKey: true, key: "ArrowUp" });
	expect(alertShown()).toBe(false);
	expect(keycaps("Set command bar shortcut")).toEqual(["Alt", "Up"]);
	expect(islandView().commandShortcut).toBe("Alt+Up");
	await remount();
	expect(keycaps("Set command bar shortcut")).toEqual(["Alt", "Up"]);

	const reset = Array.from(
		row("Summon command bar").querySelectorAll("button")
	).find((button) => button.textContent?.trim() === "Reset")!;
	await act(async () => reset.click());
	await settlePuts();
	expect(writes("island-command-shortcut").at(-1)).toEqual({
		status: 200,
		value: "CommandOrControl+Shift+Space",
	});
	expect(keycaps("Set command bar shortcut")).toEqual([
		"Ctrl",
		"Shift",
		"Space",
	]);
	expect(islandView().commandShortcut).toBe("CommandOrControl+Shift+Space");
	// Only the command key was written by this case.
	expect(new Set(islandWrites().map((exchange) => exchange.path))).toEqual(
		new Set(["/api/preferences/island-command-shortcut"])
	);
}, 30_000);

test("Push-to-talk switch, shortcut, activation and engine write one complete voice document the Island parses; off hides the rows and keeps the choices; a refused engine save restores it", async () => {
	await mount();
	const enable = "Enable push-to-talk Voice Recognition";
	expect(isOn(byLabel(enable))).toBe(false);
	expect(hasRow("Push-to-talk shortcut")).toBe(false);
	expect(hasRow("Activation")).toBe(false);
	expect(islandView().voice.enabled).toBe(false);

	await toggle(enable);
	expect(isOn(byLabel(enable))).toBe(true);
	expect(hasRow("Push-to-talk shortcut")).toBe(true);
	expect(JSON.parse(nodePreferences.get("voice-input")!)).toEqual({
		enabled: true,
		engine: "parakeet",
		mode: "toggle",
		model: "parakeet-tdt-0.6b-v3",
		shortcut: "CommandOrControl+Shift+A",
	});

	const ptt = byLabel<HTMLButtonElement>("Set push-to-talk shortcut");
	await act(async () => ptt.click());
	await keydown(ptt, { ctrlKey: true, key: " ", shiftKey: true });
	expect(keycaps("Set push-to-talk shortcut")).toEqual([
		"Ctrl",
		"Shift",
		"Space",
	]);
	expect(islandView().voice.shortcut).toBe("CommandOrControl+Shift+Space");

	// A carded row's description renders as its group's footer: both rows the
	// switch reveals carry their own guidance.
	expect(text()).toContain("Global key to dictate into the island.");
	expect(text()).toContain(
		"Press the shortcut once to start, again to stop. While recording, press Tab to switch which agent handles the task."
	);
	await choose("Voice activation mode", "Hold to talk");
	expect(text()).toContain(
		"Hold the shortcut to record; release to stop and transcribe."
	);
	expect(text()).not.toContain(
		"Press the shortcut once to start, again to stop."
	);
	expect(islandView().voice.mode).toBe("push-to-talk");

	await choose("Voice input engine", "audio.cpp");
	expect(islandView().voice).toEqual({
		enabled: true,
		engine: "audiocpp",
		mode: "push-to-talk",
		model: "parakeet-tdt-0.6b-v3-q8_0",
		shortcut: "CommandOrControl+Shift+Space",
	});

	refusals.set("PUT voice-input", 503);
	await choose("Voice input engine", "Whisper");
	expect(writes("voice-input").at(-1)?.status).toBe(503);
	expect(shown(byLabel("Voice input engine"))).toBe("audio.cpp");
	expect(alertShown()).toBe(true);
	expect(islandView().voice.engine).toBe("audiocpp");

	await toggle(enable);
	expect(alertShown()).toBe(false);
	expect(hasRow("Push-to-talk shortcut")).toBe(false);
	expect(hasRow("Activation")).toBe(false);
	expect(text()).not.toContain("Global key to dictate into the island.");
	expect(text()).not.toContain("While recording, press Tab");
	expect(islandView().voice).toEqual({
		enabled: false,
		engine: "audiocpp",
		mode: "push-to-talk",
		model: "parakeet-tdt-0.6b-v3-q8_0",
		shortcut: "CommandOrControl+Shift+Space",
	});

	await remount();
	expect(isOn(byLabel(enable))).toBe(false);
	expect(shown(byLabel("Voice input engine"))).toBe("audio.cpp");
	await toggle(enable);
	expect(keycaps("Set push-to-talk shortcut")).toEqual([
		"Ctrl",
		"Shift",
		"Space",
	]);
	expect(shown(byLabel("Voice activation mode"))).toBe("Hold to talk");
	// Every write was one whole document, never a partial patch.
	for (const write of writes("voice-input")) {
		expect(Object.keys(JSON.parse(write.value)).sort()).toEqual([
			"enabled",
			"engine",
			"mode",
			"model",
			"shortcut",
		]);
	}
}, 30_000);

test("Privacy switches drive the Island's own consent gates; proactive needs screen context; a refused consent save restores the previous state", async () => {
	await mount();
	expect(islandView().gates).toEqual({
		chat: true,
		contextRead: false,
		suggestions: false,
	});
	expect(isDisabled(byLabel("Proactive suggestions"))).toBe(true);
	await act(async () => byLabel("Proactive suggestions").click());
	await settlePuts();
	expect(writes("island-consent")).toEqual([]);

	await toggle("Screen context");
	expect(isDisabled(byLabel("Proactive suggestions"))).toBe(false);
	await toggle("Proactive suggestions");
	expect(islandView().consent).toEqual({
		chat: true,
		contextRead: true,
		proactive: true,
	});
	expect(islandView().gates).toEqual({
		chat: true,
		contextRead: true,
		suggestions: true,
	});

	refusals.set("PUT island-consent", 503);
	await toggle("Chat");
	expect(writes("island-consent").at(-1)).toEqual({
		status: 503,
		value: JSON.stringify({ chat: false, contextRead: true, proactive: true }),
	});
	expect(isOn(byLabel("Chat"))).toBe(true);
	expect(alertShown()).toBe(true);
	expect(islandView().gates.chat).toBe(true);

	// Turning screen context off closes the Island's suggestion engine even
	// though the stored proactive answer stays true.
	await toggle("Screen context");
	expect(alertShown()).toBe(false);
	expect(isDisabled(byLabel("Proactive suggestions"))).toBe(true);
	expect(islandView().consent).toEqual({
		chat: true,
		contextRead: false,
		proactive: true,
	});
	expect(islandView().gates).toEqual({
		chat: true,
		contextRead: false,
		suggestions: false,
	});

	await toggle("Chat");
	expect(islandView().gates.chat).toBe(false);
	await remount();
	expect(isOn(byLabel("Chat"))).toBe(false);
	expect(isOn(byLabel("Screen context"))).toBe(false);
	expect(isDisabled(byLabel("Proactive suggestions"))).toBe(true);
}, 30_000);

test("Conversation agents route chat and suggestions to the picked agent; Default local model stores the empty id the Island maps to Core's local model; a refused save restores the pick", async () => {
	await mount();
	await choose("Chat agent (Voice Recognition)", "Support agent");
	await choose("Proactive suggestion agent", "Default local model (fast)");
	expect(islandView().agents).toEqual({
		proactiveAgent: "",
		voiceAgent: "support-agent",
	});
	expect(agentIdOrUndefined(islandView().agents.voiceAgent)).toBe(
		"support-agent"
	);
	expect(agentIdOrUndefined(islandView().agents.proactiveAgent)).toBe(
		undefined
	);

	refusals.set("PUT island-agents", 503);
	await choose("Chat agent (Voice Recognition)", "Ryu");
	expect(shown(byLabel("Chat agent (Voice Recognition)"))).toBe(
		"Support agent"
	);
	expect(alertShown()).toBe(true);
	expect(islandView().agents.voiceAgent).toBe("support-agent");

	await remount();
	expect(shown(byLabel("Chat agent (Voice Recognition)"))).toBe(
		"Support agent"
	);
	expect(shown(byLabel("Proactive suggestion agent"))).toBe(
		"Default local model (fast)"
	);
}, 30_000);

test("Read-back, Audio engine and Voice: a new engine keeps a voice it offers, otherwise takes its default; an engine without voices hides Voice; the Island speaks with what Core stored", async () => {
	await mount();
	const readBack = "Always read back responses";
	expect(isOn(byLabel(readBack))).toBe(false);
	expect(present("Audio engine")).toBe(false);
	expect(present("Voice")).toBe(false);

	await toggle(readBack);
	expect(islandView().tts).toEqual({
		enabled: true,
		engine: "kokoro",
		voice: "af_heart",
	});
	expect(shown(byLabel("Audio engine"))).toBe("Kokoro 82M");

	expect(await choose("Voice", "af_nova")).toEqual(["af_heart", "af_nova"]);
	expect(islandView().tts.voice).toBe("af_nova");
	// OuteTTS also offers af_nova, so the voice is kept.
	expect(await choose("Audio engine", "OuteTTS")).toEqual([
		"Kokoro 82M",
		"OuteTTS",
		"Piper (not installed)",
	]);
	expect(islandView().tts).toEqual({
		enabled: true,
		engine: "outetts",
		voice: "af_nova",
	});
	await choose("Voice", "Mika");
	// Kokoro has no "Mika": it falls back to Kokoro's default voice.
	await choose("Audio engine", "Kokoro 82M");
	expect(islandView().tts).toEqual({
		enabled: true,
		engine: "kokoro",
		voice: "af_heart",
	});
	await choose("Audio engine", "Piper (not installed)");
	expect(present("Voice")).toBe(false);
	expect(islandView().tts).toEqual({
		enabled: true,
		engine: "piper",
		voice: "",
	});

	refusals.set("PUT island-tts", 503);
	await toggle(readBack);
	expect(isOn(byLabel(readBack))).toBe(true);
	expect(alertShown()).toBe(true);
	expect(islandView().tts.enabled).toBe(true);

	await remount();
	expect(shown(byLabel("Audio engine"))).toBe("Piper (not installed)");
	await toggle(readBack);
	expect(present("Audio engine")).toBe(false);
	expect(islandView().tts).toEqual({
		enabled: false,
		engine: "piper",
		voice: "",
	});
}, 30_000);

test("Notch, Background, Offset from edge, Auto-jump and Hide from screen capture reach the Island's parsers; the offset writes once per settle and restores the last saved offset on refusal; Hide on fullscreen cannot be written off Windows", async () => {
	await mount();
	await toggle("Notch mode");
	expect(islandView().notch).toBe(true);
	await choose("Background", "Mica (Windows 11 native blur)");
	expect(islandView().appearance).toBe("mica");
	await choose("Background", "Translucent (tinted glass)");
	// Desktop stores the translucent choice and the Island's own parser
	// (apps/island/src/shared/appearance.ts) reads it back as translucent.
	expect(nodePreferences.get("island-appearance")).toBe(
		JSON.stringify({ background: "translucent" })
	);
	expect(islandView().appearance).toBe("translucent");
	await choose("Background", "Native glass (default)");
	expect(islandView().appearance).toBe("acrylic");
	await choose("Background", "Mica (Windows 11 native blur)");
	expect(islandView().appearance).toBe("mica");

	const offset = byLabel("Offset from edge");
	expect(offset.getAttribute("aria-valuenow")).toBe("20");
	// The 200 ms write debounce elapses only when this case says so.
	const debounce = holdDebounce();
	await act(async () => offset.focus());
	for (const _ of [1, 2, 3]) {
		await act(async () => {
			offset.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					cancelable: true,
					key: "ArrowRight",
				})
			);
		});
	}
	expect(offset.getAttribute("aria-valuenow")).toBe("23");
	// Debounced: each press replaced the previous timer and nothing is
	// written while the value is still moving.
	expect(debounce.pending()).toBe(1);
	await settlePuts();
	expect(writes("island-edge-offset")).toEqual([]);
	await debounce.elapse();
	await settlePuts();
	expect(writes("island-edge-offset")).toEqual([{ status: 200, value: "23" }]);
	expect(islandView().edgeOffset).toBe(23);

	refusals.set("PUT island-edge-offset", 503);
	await keydown(offset, { key: "End" });
	expect(offset.getAttribute("aria-valuenow")).toBe("96");
	expect(writes("island-edge-offset")).toHaveLength(1);
	await debounce.elapse();
	await settlePuts();
	expect(writes("island-edge-offset").at(-1)).toEqual({
		status: 503,
		value: "96",
	});
	expect(offset.getAttribute("aria-valuenow")).toBe("23");
	expect(alertShown()).toBe(true);
	expect(islandView().edgeOffset).toBe(23);
	releaseDebounceHold?.();

	await toggle("Auto-jump to active monitor");
	expect(alertShown()).toBe(false);
	expect(islandView().autoJump).toBe(true);
	await toggle("Hide from screen capture");
	expect(islandView().screenPrivacy).toBe(false);

	const fullscreen = byLabel("Hide on fullscreen apps");
	expect(isDisabled(fullscreen)).toBe(true);
	expect(isOn(fullscreen)).toBe(false);
	await act(async () => fullscreen.click());
	await settlePuts();
	expect(writes("island-hide-on-fullscreen")).toEqual([]);
	expect(islandView().hideOnFullscreen).toBe(true);
	expect(text()).toContain("Available on Windows only for now.");

	await remount();
	expect(isOn(byLabel("Notch mode"))).toBe(true);
	expect(shown(byLabel("Background"))).toBe("Mica (Windows 11 native blur)");
	expect(byLabel("Offset from edge").getAttribute("aria-valuenow")).toBe("23");
	expect(isOn(byLabel("Auto-jump to active monitor"))).toBe(true);
	expect(isOn(byLabel("Hide from screen capture"))).toBe(false);
}, 30_000);

test("an older write that fails after newer ones succeed never rolls the switch back or raises the alert", async () => {
	await mount();
	holdRequests.add("PUT island-notch-mode");
	await act(async () => byLabel("Notch mode").click());
	await waitForHeld("island-notch-mode");
	expect(isOn(byLabel("Notch mode"))).toBe(true);
	await toggle("Notch mode");
	await toggle("Notch mode");
	expect(isOn(byLabel("Notch mode"))).toBe(true);
	expect(nodePreferences.get("island-notch-mode")).toBe("true");

	await releaseHeld("island-notch-mode", 503);
	expect(writes("island-notch-mode")).toEqual([
		{ status: 503, value: "true" },
		{ status: 200, value: "false" },
		{ status: 200, value: "true" },
	]);
	expect(isOn(byLabel("Notch mode"))).toBe(true);
	expect(alertShown()).toBe(false);
	expect(islandView().notch).toBe(true);

	// The latest write's own refusal still rolls back.
	refusals.set("PUT island-notch-mode", 503);
	await toggle("Notch mode");
	expect(isOn(byLabel("Notch mode"))).toBe(true);
	expect(alertShown()).toBe(true);
}, 30_000);
