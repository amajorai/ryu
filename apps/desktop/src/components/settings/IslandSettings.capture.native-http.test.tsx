import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
	answerDesktopSecretSlot,
	memorySlotStorage,
} from "../../../e2e/harness/desktop-secret-slots.ts";

// The shipping Shadow client is device-local. Configure its genuine supported
// Core URL before importing it; never rewrite a URL, SDK function or response.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
// Bun's native fetch rejects happy-dom's AbortSignal, and the shipping agent
// roster query forwards its React Query signal into that fetch.
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const previousCoreUrl = process.env.VITE_CORE_URL;
const nodeToken = "shadow-test-only-local-bearer";
interface Call {
	authorization: string | null;
	body: unknown;
	completed: boolean;
	jwt: string | null;
	method: string;
	path: string;
	status: number;
}
const capturePath = "/api/shadow/capture/control";
const baselineCapture = {
	frames: true,
	paused: false,
	app_allowlist: ["Terminal"],
	history_retention_days: 30,
};
let capture = structuredClone(baselineCapture);
let nextCaptureStatus: number | null = null;
const storeDirectory = mkdtempSync(
	join(tmpdir(), "shadow-capture-store-proof-")
);
const storeDisk = join(storeDirectory, "companion.bin.fixture.json");
const secretSlots = memorySlotStorage();
const initialPreferences: Record<string, unknown> = {
	companion_frames: true,
	companion_paused: false,
	companion_app_allowlist: ["Terminal"],
	shadow_history_retention_days: 30,
};
let stagedPreferences: Record<string, unknown> =
	structuredClone(initialPreferences);
let nextStoreGetRefusedKey: string | null = null;
let nextStoreSetRefused = false;
let nextStoreSaveRefused = false;
let ipcCalls: Array<{ command: string; args: unknown; outcome: string }> = [];
function persistedPreferences() {
	return JSON.parse(readFileSync(storeDisk, "utf8")) as Record<string, unknown>;
}

let calls: Call[] = [];
let unexpected: string[] = [];
let heldPath: string | null = null;
let heldMethod: string | null = null;
let releaseHeld: (() => void) | null = null;
let root: Root | null = null;
let client: InstanceType<typeof QueryClient> | null = null;
let container: HTMLDivElement;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const body = ["POST", "PUT"].includes(request.method)
			? await request.json()
			: null;
		const call: Call = {
			path: url.pathname + url.search,
			method: request.method,
			body,
			authorization: request.headers.get("authorization"),
			jwt: request.headers.get("x-ryu-user-jwt"),
			status: 0,
			completed: false,
		};
		calls.push(call);
		const reply = (value: unknown, status = 200) => {
			call.status = status;
			call.completed = true;
			return NativeResponse.json(value, { status });
		};
		if (
			call.authorization !== `Bearer ${nodeToken}` ||
			call.jwt !== null ||
			url.search
		) {
			unexpected.push(
				`${request.method} ${call.path} invalid local authority/query`
			);
			return reply({ error: "Unexpected authority or query" }, 503);
		}
		if (url.pathname === heldPath && request.method === heldMethod) {
			heldPath = null;
			heldMethod = null;
			await new Promise<void>((resolve) => {
				releaseHeld = resolve;
			});
		}
		if (
			url.pathname === capturePath &&
			["GET", "POST"].includes(request.method)
		) {
			if (request.method === "GET") {
				return reply(structuredClone(capture));
			}
			const keys = body && typeof body === "object" ? Object.keys(body) : [];
			if (
				!keys.length ||
				keys.some(
					(key) =>
						![
							"frames",
							"paused",
							"app_allowlist",
							"history_retention_days",
						].includes(key)
				) ||
				(body.frames !== undefined && typeof body.frames !== "boolean") ||
				(body.paused !== undefined && typeof body.paused !== "boolean") ||
				(body.app_allowlist !== undefined &&
					(!Array.isArray(body.app_allowlist) ||
						body.app_allowlist.some((x: unknown) => typeof x !== "string"))) ||
				(body.history_retention_days !== undefined &&
					(!Number.isInteger(body.history_retention_days) ||
						body.history_retention_days < 1 ||
						body.history_retention_days > 3650))
			) {
				unexpected.push("Invalid source-backed capture DTO");
				return reply({ error: "Invalid capture control" }, 400);
			}
			const refusal = nextCaptureStatus;
			nextCaptureStatus = null;
			if (refusal) {
				return reply({ error: "Owned capture write refused" }, refusal);
			}
			capture = { ...capture, ...body };
			return reply(structuredClone(capture));
		}
		unexpected.push(`${request.method} ${call.path}`);
		return reply({ error: "Undeclared Shadow regression request" }, 503);
	},
});
const remotePreferenceKeys = [
	"island-notch-mode",
	"island-appearance",
	"island-edge-offset",
	"island-auto-jump",
	"island-hide-on-fullscreen",
	"island-screen-privacy",
	"island-agents",
	"voice-input",
	"island-command-shortcut",
	"island-tts",
	"island-consent",
];
const remoteServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const body = request.method === "PUT" ? await request.json() : null;
		const call: Call = {
			path: url.pathname + url.search,
			method: request.method,
			body,
			authorization: request.headers.get("authorization"),
			jwt: request.headers.get("x-ryu-user-jwt"),
			status: 0,
			completed: false,
		};
		calls.push(call);
		const reply = (value: unknown, status = 200) => {
			call.status = status;
			call.completed = true;
			return NativeResponse.json(value, { status });
		};
		if (
			call.authorization !== "Bearer remote-only" ||
			call.jwt !== null ||
			url.search
		) {
			unexpected.push("Unexpected selected-remote authority/query");
			return reply({ error: "Unknown authority" }, 503);
		}
		const key = url.pathname.startsWith("/api/preferences/")
			? decodeURIComponent(url.pathname.slice("/api/preferences/".length))
			: null;
		if (
			request.method === "GET" &&
			key !== null &&
			remotePreferenceKeys.includes(key)
		) {
			return reply({ key, value: null });
		}
		if (
			request.method === "PUT" &&
			["entitlement-active", "managed-inference-entitled"].includes(
				key ?? ""
			) &&
			body &&
			Object.keys(body).length === 1 &&
			typeof body.value === "string" &&
			["true", "false"].includes(body.value)
		) {
			return reply({ key, value: body.value });
		}
		if (request.method === "GET" && url.pathname === "/api/agents") {
			return reply({ agents: [] });
		}
		if (request.method === "GET" && url.pathname === "/api/engines") {
			return reply({ engines: [] });
		}
		if (request.method === "GET" && url.pathname === "/api/engine/active") {
			return reply({
				active: null,
				available: [],
				running: false,
				llamacpp_variant: null,
			});
		}
		if (request.method === "GET" && url.pathname === "/api/voice/tts-engines") {
			return reply({ data: [] });
		}
		unexpected.push(
			`Unknown Island auxiliary contract ${request.method} ${url.pathname}`
		);
		return reply({ error: "Unknown route" }, 503);
	},
});
process.env.VITE_CORE_URL = server.url.origin;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const registeredAbortController = globalThis.AbortController;
const registeredAbortSignal = globalThis.AbortSignal;
Reflect.set(globalThis, "AbortController", NativeAbortController);
Reflect.set(globalThis, "AbortSignal", NativeAbortSignal);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Explicit NativeWindowIPC fixture, not a native OS or plugin backend claim.
// The production installed Tauri Store frontend invokes this command boundary.
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: async (command: string, args: Record<string, unknown>) => {
		const call = { command, args: structuredClone(args), outcome: "pending" };
		ipcCalls.push(call);
		const refuse = (message: string): never => {
			call.outcome = "refused";
			throw new Error(message);
		};
		// The auth client and entitlement provider read their sealed slots on load.
		const slot = answerDesktopSecretSlot(secretSlots, command, args);
		if (slot.handled) {
			call.outcome = "accepted";
			return slot.value;
		}
		if (
			command === "plugin:store|load" &&
			args.path === "entitlement.bin" &&
			Object.keys(args).every((key) => ["path", "options"].includes(key))
		) {
			call.outcome = "accepted";
			return 2;
		}
		if (
			command === "plugin:store|get" &&
			args.rid === 2 &&
			Object.keys(args).every((key) => ["rid", "key"].includes(key)) &&
			["firstLaunchAtMs", "lastGoodEntitlement", "licenseKey"].includes(
				String(args.key)
			)
		) {
			call.outcome = "accepted";
			return [
				args.key === "firstLaunchAtMs" ? Date.now() : null,
				args.key === "firstLaunchAtMs",
			];
		}
		if (
			command === "plugin:store|load" &&
			args.path === "companion.bin" &&
			Object.keys(args).every((key) => ["path", "options"].includes(key))
		) {
			call.outcome = "accepted";
			return 1;
		}
		if (
			args.rid !== 1 ||
			Object.keys(args).some((key) => !["rid", "key", "value"].includes(key))
		) {
			unexpected.push(`Unknown store IPC ${command}`);
			return refuse("Unknown store authority/DTO");
		}
		const key = args.key;
		if (
			command !== "plugin:store|save" &&
			(typeof key !== "string" || !Object.hasOwn(initialPreferences, key))
		) {
			unexpected.push(`Unknown store key ${String(key)}`);
			return refuse("Unknown capture store key");
		}
		if (command === "plugin:store|get") {
			if (key === nextStoreGetRefusedKey) {
				nextStoreGetRefusedKey = null;
				return refuse("Owned preference read refused");
			}
			call.outcome = "accepted";
			return [
				structuredClone(stagedPreferences[key as string]),
				Object.hasOwn(stagedPreferences, key as string),
			];
		}
		if (command === "plugin:store|set") {
			if (nextStoreSetRefused) {
				nextStoreSetRefused = false;
				return refuse("Owned capture store set refused");
			}
			stagedPreferences[key as string] = structuredClone(args.value);
			call.outcome = "accepted";
			return;
		}
		if (command === "plugin:store|delete") {
			delete stagedPreferences[key as string];
			call.outcome = "accepted";
			return true;
		}
		if (command === "plugin:store|save") {
			if (nextStoreSaveRefused) {
				nextStoreSaveRefused = false;
				return refuse("Owned capture store disk save refused");
			}
			writeFileSync(`${storeDisk}.next`, JSON.stringify(stagedPreferences));
			renameSync(`${storeDisk}.next`, storeDisk);
			call.outcome = "accepted";
			return;
		}
		unexpected.push(`Undeclared store IPC ${command}`);
		return refuse("Undeclared capture store command");
	},
});

const egress: string[] = [];
let inFlight = 0;
interface ClientRead {
	bodyConsumed: boolean;
	headersReceived: boolean;
	method: string;
	path: string;
	status: number | null;
}
let clientReads: ClientRead[] = [];
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof nativeFetch>) => {
		const input = args[0];
		const url = new URL(
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url
		);
		if (
			url.origin !== server.url.origin &&
			url.origin !== remoteServer.url.origin
		) {
			egress.push(url.origin);
			throw new Error("Shadow regression refuses unowned egress");
		}
		const requestInput =
			typeof input === "string" || input instanceof URL ? null : input;
		const operation: ClientRead = {
			path: url.pathname + url.search,
			method: (args[1]?.method ?? requestInput?.method ?? "GET").toUpperCase(),
			status: null,
			headersReceived: false,
			bodyConsumed: false,
		};
		clientReads.push(operation);
		inFlight += 1;
		try {
			const response = await nativeFetch(...args);
			operation.status = response.status;
			operation.headersReceived = true;
			const json = response.json.bind(response);
			response.json = async () => {
				try {
					return await json();
				} finally {
					operation.bodyConsumed = true;
				}
			};
			const text = response.text.bind(response);
			response.text = async () => {
				try {
					return await text();
				} finally {
					operation.bodyConsumed = true;
				}
			};
			return response;
		} finally {
			inFlight -= 1;
		}
	},
	{
		preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
			const url = new URL(String(args[0]));
			if (
				url.origin !== server.url.origin &&
				url.origin !== remoteServer.url.origin
			) {
				throw new Error("Unowned preconnect");
			}
			return nativeFetch.preconnect(...args);
		},
	}
);
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const componentSource =
	process.env.RYU_SHADOW_SETTINGS_PROOF_SOURCE ?? "./IslandSettings.tsx";
const { IslandSettings } = await import(componentSource);
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { queryClient: sharedAgentQueryClient } = await import(
	"@/src/lib/query-client.ts"
);
const originalNodeState = useNodeStore.getState();
const target = { url: server.url.origin, token: nodeToken, userJwt: null };

async function until(check: () => boolean, message: string) {
	const deadline = Date.now() + 2500;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		});
	}
}
function button(name: string) {
	const element = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((item) => item.textContent?.trim() === name);
	if (!element) {
		throw new Error(`Missing shipping action ${name}`);
	}
	return element;
}
async function click(name: string) {
	await act(async () => button(name).click());
}
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	root = createRoot(container);
	await act(async () =>
		root!.render(
			<QueryClientProvider client={client!}>
				<EntitlementProvider>
					<IslandSettings />
				</EntitlementProvider>
			</QueryClientProvider>
		)
	);
}
async function unmount() {
	await act(async () => {
		root?.unmount();
		root = null;
	});
	client?.clear();
	sharedAgentQueryClient.clear();
	client = null;
	container?.remove();
}
async function loaded() {
	await until(() => {
		const apply = clientReads
			.filter((read) => read.path === capturePath && read.method === "POST")
			.at(-1);
		const pause = container.querySelector<HTMLElement>(
			'[aria-label="Pause all capture (incognito)"]'
		);
		const readKeys = clientReads
			.filter((read) => read.method === "GET" && read.bodyConsumed)
			.map((read) => read.path);
		return (
			apply?.headersReceived === true &&
			(apply.status !== 200 || apply.bodyConsumed) &&
			pause !== null &&
			!pause.hasAttribute("data-disabled") &&
			pause.getAttribute("aria-disabled") !== "true" &&
			remotePreferenceKeys.every((key) =>
				readKeys.includes(`/api/preferences/${key}`)
			) &&
			[
				"/api/agents",
				"/api/engines",
				"/api/engine/active",
				"/api/voice/tts-engines",
			].every((path) => readKeys.includes(path))
		);
	}, "Actual mounted Island capture and finite auxiliary SDK contracts did not finish");
}

async function release() {
	const resolve = releaseHeld;
	if (!resolve) {
		throw new Error("No held actual native request");
	}
	releaseHeld = null;
	await act(async () => resolve());
}
function captureWrites() {
	return calls.filter(
		(call) => call.path === capturePath && call.method === "POST"
	);
}
async function captureRead() {
	const response = await nativeFetch(server.url.origin + capturePath, {
		headers: { Authorization: `Bearer ${nodeToken}` },
	});
	if (response.status !== 200) {
		throw new Error(`Independent HTTP read refused: ${response.status}`);
	}
	return response.json() as Promise<typeof baselineCapture>;
}
function captureSwitch(title: string) {
	const heading = [
		...container.querySelectorAll<HTMLElement>('[data-slot="item-title"]'),
	].find((item) => item.textContent?.trim() === title);
	if (!heading) {
		throw new Error(`Missing actual capture setting ${title}`);
	}
	let parent = heading.parentElement;
	while (parent && parent !== container) {
		const controls = parent.querySelectorAll<HTMLElement>('[role="switch"]');
		if (controls.length === 1) {
			return controls[0]!;
		}
		if (controls.length > 1) {
			throw new Error(`Ambiguous shipping capture row ${title}`);
		}
		parent = parent.parentElement;
	}
	throw new Error(`Missing actual capture switch ${title}`);
}
async function captureLoaded() {
	await loaded();
}

async function toggleCapture(title: string) {
	await act(async () => captureSwitch(title).click());
}
async function finishCaptureWrite(before: number) {
	await until(() => {
		const read = clientReads
			.filter((read) => read.path === capturePath && read.method === "POST")
			.at(-1);
		return (
			captureWrites().length > before &&
			captureWrites()
				.slice(before)
				.every((call) => call.completed) &&
			inFlight === 0 &&
			read?.headersReceived === true &&
			(read.status !== 200 || read.bodyConsumed)
		);
	}, "Actual capture POST body did not finish");
	await act(async () => {});
}
let evidenceSerial = 0;

beforeEach(() => {
	localStorage.clear();
	capture = structuredClone(baselineCapture);
	stagedPreferences = structuredClone(initialPreferences);
	writeFileSync(storeDisk, JSON.stringify(stagedPreferences));
	ipcCalls = [];
	nextCaptureStatus = null;
	nextStoreGetRefusedKey = null;
	nextStoreSetRefused = nextStoreSaveRefused = false;
	calls = [];
	clientReads = [];
	unexpected = [];
	egress.length = 0;
	const local = { name: "local-regression", ...target };
	const remote = {
		name: "selected-remote",
		url: remoteServer.url.origin,
		token: "remote-only",
		userJwt: null,
	};
	useNodeStore.setState({
		nodes: [local, remote],
		localNodes: [local, remote],
		cloudNodes: [],
		defaultNode: remote.name,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
	if (useNodeStore.getState().getActiveNode().name !== remote.name) {
		throw new Error("Unrelated remote must be selected");
	}
});
afterEach(async () => {
	if (releaseHeld) {
		await release();
	}
	// The genuine entitlement provider publishes ready before its sequential
	// Core preference writes finish; drain those actual responses before unmount.
	await until(
		() =>
			["entitlement-active", "managed-inference-entitled"].every((key) =>
				clientReads.some(
					(read) =>
						read.path === `/api/preferences/${key}` &&
						read.method === "PUT" &&
						read.status === 200 &&
						read.bodyConsumed
				)
			),
		"Owned entitlement bootstrap writes did not finish"
	);
	await unmount();
	await until(
		() => inFlight === 0 && calls.every((call) => call.completed),
		"Owned capture requests remain at teardown"
	);
	writeFileSync(
		join(storeDirectory, `case-${++evidenceSerial}.json`),
		JSON.stringify(
			{
				physicalDisk: persistedPreferences(),
				capture,
				http: calls,
				storeIpc: ipcCalls,
			},
			null,
			2
		)
	);
	if (unexpected.length) {
		throw new Error(`Unexpected HTTP/IPC: ${JSON.stringify(unexpected)}`);
	}
	if (egress.length) {
		throw new Error(`Unexpected egress: ${JSON.stringify(egress)}`);
	}
	if (ipcCalls.some((call) => call.outcome === "pending")) {
		throw new Error("Owned IPC remains pending");
	}
	if (calls.some((call) => /\/api\/(?:sidecar|setup)/.test(call.path))) {
		throw new Error("Unexpected sidecar/setup operation");
	}
});
afterAll(async () => {
	useNodeStore.setState(originalNodeState);
	globalThis.fetch = nativeFetch;
	Reflect.set(globalThis, "AbortController", registeredAbortController);
	Reflect.set(globalThis, "AbortSignal", registeredAbortSignal);
	if (previousCoreUrl === undefined) {
		delete process.env.VITE_CORE_URL;
	} else {
		process.env.VITE_CORE_URL = previousCoreUrl;
	}
	await server.stop(true);
	await remoteServer.stop(true);
});

for (const status of [403]) {
	test(`capture POST${status} leaves independently read active pause unchanged while desired pause is durably saved, and shows not-applied state`, async () => {
		await mount();
		await captureLoaded();
		nextCaptureStatus = status;
		const before = captureWrites().length;
		await toggleCapture("Pause all capture (incognito)");
		await finishCaptureWrite(before);
		expect(captureWrites().at(-1)).toMatchObject({
			body: { paused: true },
			status,
		});
		expect(persistedPreferences()).toEqual({
			...initialPreferences,
			companion_paused: true,
		});
		expect(await captureRead()).toEqual(baselineCapture);
		expect(container.textContent).toMatch(
			/capture.*(?:not applied|could not be applied|could not apply)|(?:not applied|could not apply).*capture/i
		);
		// A checked desired preference alone is never accepted as evidence of active incognito.
		expect(container.textContent).not.toContain(
			"Shadow records nothing at all"
		);
		const beforeRetry = captureWrites().length;
		await click("Retry capture settings");
		await finishCaptureWrite(beforeRetry);
		expect(captureWrites().at(-1)?.body).toEqual({
			...baselineCapture,
			paused: true,
		});
		expect(await captureRead()).toEqual({ ...baselineCapture, paused: true });
		expect(persistedPreferences()).toEqual({
			...initialPreferences,
			companion_paused: true,
		});
		expect(container.textContent).not.toMatch(
			/capture.*(?:not applied|could not be applied|could not apply)/i
		);
	});
}

for (const refusal of ["set"] as const) {
	test(`native store ${refusal} refusal cannot claim durable save; actual pause ACK is independently active and visible persistence error is required`, async () => {
		await mount();
		await captureLoaded();
		if (refusal === "set") {
			nextStoreSetRefused = true;
		} else {
			nextStoreSaveRefused = true;
		}
		const before = captureWrites().length;
		await toggleCapture("Pause all capture (incognito)");
		await finishCaptureWrite(before);
		expect(
			ipcCalls.some(
				(call) =>
					call.command === `plugin:store|${refusal}` &&
					call.outcome === "refused"
			)
		).toBe(true);
		expect(persistedPreferences()).toEqual(initialPreferences);
		expect(await captureRead()).toEqual({ ...baselineCapture, paused: true });
		expect(
			captureSwitch("Pause all capture (incognito)").getAttribute(
				"aria-checked"
			)
		).toBe("true");
		expect(container.textContent).toMatch(
			/(?:could not save|not saved|save.*failed|failed.*save)/i
		);
		expect(container.textContent).not.toContain("These settings are saved");
		const beforeRetry = captureWrites().length;
		await click("Retry capture settings");
		await finishCaptureWrite(beforeRetry);
		expect(persistedPreferences()).toEqual({
			...initialPreferences,
			companion_paused: true,
		});
		expect(await captureRead()).toEqual({ ...baselineCapture, paused: true });
		expect(container.textContent).not.toMatch(
			/(?:could not save|not saved|save.*failed|failed.*save)/i
		);
	});
}

test("held actual pause POST keeps physical capture unchanged and renders applying state until actual acknowledgment", async () => {
	await mount();
	await captureLoaded();
	heldPath = capturePath;
	heldMethod = "POST";
	const before = captureWrites().length;
	await toggleCapture("Pause all capture (incognito)");
	await until(
		() => releaseHeld !== null,
		"Actual pause HTTP request never reached held boundary"
	);
	expect(persistedPreferences().companion_paused).toBe(true);
	expect(await captureRead()).toEqual(baselineCapture);
	expect(container.textContent).toMatch(/applying.*capture|capture.*applying/i);
	expect(
		captureSwitch("Pause all capture (incognito)").getAttribute("aria-disabled")
	).toBe("true");
	expect(
		captureSwitch("Pause all capture (incognito)").hasAttribute("data-disabled")
	).toBe(true);
	expect(
		captureSwitch("Screen recording (frames)").getAttribute("aria-disabled")
	).toBe("true");
	expect(
		captureSwitch("Screen recording (frames)").hasAttribute("data-disabled")
	).toBe(true);
	await toggleCapture("Screen recording (frames)");
	expect(captureWrites()).toHaveLength(before + 1);
	expect(persistedPreferences()).toEqual({
		...initialPreferences,
		companion_paused: true,
	});
	await release();
	await finishCaptureWrite(before);
	expect(await captureRead()).toEqual({ ...baselineCapture, paused: true });
	expect(container.textContent).not.toMatch(
		/applying.*capture|capture.*applying/i
	);
});
test("initial paused preference read refusal must not replace active incognito with defaults; explicit retry rereads durable preferences before acknowledgment", async () => {
	stagedPreferences.companion_paused = true;
	writeFileSync(storeDisk, JSON.stringify(stagedPreferences));
	capture = { ...baselineCapture, paused: true };
	nextStoreGetRefusedKey = "companion_paused";
	await mount();
	await until(
		() =>
			ipcCalls.some(
				(call) =>
					call.command === "plugin:store|get" &&
					(call.args as { key?: string }).key === "companion_paused" &&
					call.outcome === "refused"
			) &&
			inFlight === 0 &&
			(captureWrites().some((call) => call.completed) ||
				/could not (?:read|load).*capture|capture.*(?:not loaded|could not be read|could not be loaded)/i.test(
					container.textContent ?? ""
				)),
		"Owned initial preference read refusal did not finish"
	);
	const independentlyActive = await captureRead();
	expect(persistedPreferences().companion_paused).toBe(true);
	expect(independentlyActive).toEqual({ ...baselineCapture, paused: true });
	expect(captureWrites()).toHaveLength(0);
	expect(container.textContent).toMatch(
		/could not (?:read|load).*capture|capture.*(?:not loaded|could not be read|could not be loaded)/i
	);
	const beforeRetry = captureWrites().length;
	await click("Retry capture settings");
	await finishCaptureWrite(beforeRetry);
	expect(
		ipcCalls.filter(
			(call) =>
				call.command === "plugin:store|get" &&
				(call.args as { key?: string }).key === "companion_paused" &&
				call.outcome === "accepted"
		)
	).toHaveLength(1);
	expect(captureWrites().at(-1)?.body).toEqual({
		...baselineCapture,
		paused: true,
	});
	expect(await captureRead()).toEqual({ ...baselineCapture, paused: true });
	expect(persistedPreferences().companion_paused).toBe(true);
	expect(container.textContent).not.toMatch(
		/could not (?:read|load).*capture|capture.*(?:not loaded|could not be read|could not be loaded)/i
	);
});
