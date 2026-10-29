import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// The shipping Shadow client is device-local. Configure its genuine supported
// Core URL before importing it; never rewrite a URL, SDK function or response.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const previousCoreUrl = process.env.VITE_CORE_URL;
const configPath = "/api/shadow/computer-use/config";
const secretListPath = "/api/plugins/%40ryu%2Fshadow/secrets";
const secretPath = `${secretListPath}/SHADOW_JEV_API_KEY`;
const nodeToken = "shadow-test-only-local-bearer";
const initialConfig = {
	applied: false,
	jevApiKeyConfigured: false,
	planner: "jev" as const,
	jevUrl: "https://configured-provider.example.test/decide",
	jevModel: "saved-decision-model",
	layaUrl: "https://preserved-local.example.test/predict",
	localPluginId: "@ryu/saved-local-planner",
	localModelId: "saved-local-model",
	maxSteps: 7,
};
type Config = typeof initialConfig;
interface Call {
	authorization: string | null;
	body: unknown;
	completed: boolean;
	jwt: string | null;
	method: string;
	path: string;
	status: number;
}
let saved: Config = structuredClone(initialConfig);
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

let secret: string | null = null;
let calls: Call[] = [];
let unexpected: string[] = [];
let nextConfigReadStatus: number | null = null;
let nextConfigWriteStatus: number | null = null;
let nextSecretReadStatus: number | null = null;
let nextSecretWriteStatus: number | null = null;
let nextSecretDeleteStatus: number | null = null;
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
		if (url.pathname === configPath && request.method === "GET") {
			const refusal = nextConfigReadStatus;
			nextConfigReadStatus = null;
			return refusal
				? reply({ error: "Owned saved config unavailable" }, refusal)
				: reply(structuredClone(saved));
		}
		if (url.pathname === configPath && request.method === "POST") {
			const refusal = nextConfigWriteStatus;
			nextConfigWriteStatus = null;
			if (refusal) {
				return reply({ error: "Owned config write refused" }, refusal);
			}
			const expectedKeys = [
				"planner",
				"jevUrl",
				"jevModel",
				"layaUrl",
				"localPluginId",
				"localModelId",
				"maxSteps",
			].sort();
			if (
				!body ||
				typeof body !== "object" ||
				JSON.stringify(Object.keys(body).sort()) !==
					JSON.stringify(expectedKeys)
			) {
				unexpected.push(
					"Config writer sent a malformed/partial full-policy payload"
				);
				return reply({ error: "Exact full config required" }, 503);
			}
			// Canonical Core Settings/Update uses u8 plus validate()'s 1..=20.
			// Refuse invalid values independently of the mounted input implementation.
			const maxSteps = (body as { maxSteps?: unknown }).maxSteps;
			if (
				typeof maxSteps !== "number" ||
				!Number.isInteger(maxSteps) ||
				maxSteps < 1 ||
				maxSteps > 20
			) {
				unexpected.push(
					"Config writer violated canonical integer maxSteps 1..20 contract"
				);
				return reply({ error: "maxSteps must be between 1 and 20" }, 400);
			}
			saved = {
				...saved,
				...(body as Omit<Config, "applied" | "jevApiKeyConfigured">),
			};
			return reply(structuredClone(saved));
		}
		if (url.pathname === secretListPath && request.method === "GET") {
			const refusal = nextSecretReadStatus;
			nextSecretReadStatus = null;
			return refusal
				? reply({ error: "Owned credential metadata unavailable" }, refusal)
				: reply({
						secrets: [
							{
								key: "SHADOW_JEV_API_KEY",
								set: secret !== null,
								readable: true,
								shadowed_by_env: false,
								updated_at: 1_791_500_000_000,
							},
						],
					});
		}
		if (url.pathname === secretPath && request.method === "PUT") {
			const refusal = nextSecretWriteStatus;
			nextSecretWriteStatus = null;
			if (refusal) {
				return reply({ error: "Owned credential write refused" }, refusal);
			}
			if (
				!body ||
				typeof body !== "object" ||
				Object.keys(body).join() !== "value" ||
				typeof (body as { value?: unknown }).value !== "string"
			) {
				unexpected.push("Malformed secret write");
				return reply({ error: "Exact secret payload required" }, 503);
			}
			secret = (body as { value: string }).value;
			return reply({ ok: true });
		}
		if (url.pathname === secretPath && request.method === "DELETE") {
			const refusal = nextSecretDeleteStatus;
			nextSecretDeleteStatus = null;
			if (refusal) {
				return reply({ error: "Owned credential deletion refused" }, refusal);
			}
			secret = null;
			return reply({ ok: true });
		}
		if (
			url.pathname === "/api/plugins/contributions" &&
			request.method === "GET"
		) {
			return reply({ computer_use_planners: [] });
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
process.env.VITE_CORE_URL = server.url.origin;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
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
		if (url.origin !== server.url.origin) {
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
			if (url.origin !== server.url.origin) {
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
	process.env.RYU_SHADOW_SETTINGS_PROOF_SOURCE ?? "./ShadowSettings.tsx";
const { ShadowSettings } = await import(componentSource);
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
function input(name: string) {
	const element = container.querySelector<HTMLInputElement>(
		`input[aria-label="${name}"]`
	);
	if (!element) {
		throw new Error(`Missing shipping input ${name}`);
	}
	return element;
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
async function edit(name: string, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input(name), value);
		input(name).dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function click(name: string) {
	await act(async () => button(name).click());
}
let caughtCaptureRenderErrors: unknown[] = [];
async function mount(containRenderFailure = false) {
	container = document.createElement("div");
	document.body.append(container);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	root = createRoot(container, {
		onUncaughtError: containRenderFailure
			? (error) => caughtCaptureRenderErrors.push(error)
			: undefined,
	});
	await act(async () =>
		root!.render(
			<QueryClientProvider client={client!}>
				<ShadowSettings />
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
	client = null;
	container?.remove();
}
async function loaded() {
	await until(() => {
		const configRead = clientReads
			.filter((read) => read.path === configPath && read.method === "GET")
			.at(-1);
		const metadataRead = clientReads
			.filter((read) => read.path === secretListPath && read.method === "GET")
			.at(-1);
		const captureRead = clientReads
			.filter((read) => read.path === capturePath && read.method === "POST")
			.at(-1);
		const saveButton = [
			...container.querySelectorAll<HTMLButtonElement>("button"),
		].find((item) => item.textContent?.trim() === "Save computer-use settings");
		const retention = container.querySelector<HTMLInputElement>(
			'input[aria-label="Shadow history retention in days"]'
		);
		return (
			configRead?.status === 200 &&
			configRead.bodyConsumed &&
			metadataRead?.status === 200 &&
			metadataRead.bodyConsumed &&
			captureRead?.headersReceived === true &&
			(captureRead.status !== 200 || captureRead.bodyConsumed) &&
			saveButton !== undefined &&
			!saveButton.disabled &&
			retention !== null
		);
	}, "Actual capture preference push and auxiliary config/metadata did not reach shipping UI");
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
		const controls =
			parent.querySelectorAll<HTMLButtonElement>('[role="switch"]');
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
	await until(
		() =>
			clientReads.some(
				(read) =>
					read.path === capturePath &&
					read.method === "POST" &&
					read.headersReceived &&
					read.status !== null
			) &&
			!!container.querySelector(
				'input[aria-label="Shadow history retention in days"]'
			),
		"Actual persisted settings push and mounted capture controls did not finish"
	);
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
async function enterRetention(value: string) {
	await edit("Shadow history retention in days", value);
	await act(async () =>
		input("Shadow history retention in days").dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
		)
	);
}
let evidenceSerial = 0;
beforeEach(() => {
	caughtCaptureRenderErrors = [];
	saved = structuredClone(initialConfig);
	capture = structuredClone(baselineCapture);
	secret = null;
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
	nextConfigReadStatus =
		nextConfigWriteStatus =
		nextSecretReadStatus =
		nextSecretWriteStatus =
		nextSecretDeleteStatus =
			null;
	heldPath = heldMethod = null;
	releaseHeld = null;
	const local = { name: "local-regression", ...target };
	const remote = {
		name: "selected-remote",
		url: "https://unowned-selected-remote.example.test",
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
	if (previousCoreUrl === undefined) {
		delete process.env.VITE_CORE_URL;
	} else {
		process.env.VITE_CORE_URL = previousCoreUrl;
	}
	await server.stop(true);
});

test("accepted actual frame/pause writes preserve unrelated capture fields and survive independent disk and HTTP reads/remount", async () => {
	await mount();
	await captureLoaded();
	let before = captureWrites().length;
	await toggleCapture("Screen recording");
	await finishCaptureWrite(before);
	expect(captureWrites().at(-1)?.body).toEqual({ frames: false });
	expect(persistedPreferences()).toEqual({
		...initialPreferences,
		companion_frames: false,
	});
	expect(await captureRead()).toEqual({ ...baselineCapture, frames: false });
	before = captureWrites().length;
	await toggleCapture("Pause all capture");
	await finishCaptureWrite(before);
	expect(captureWrites().at(-1)?.body).toEqual({ paused: true });
	expect(persistedPreferences()).toEqual({
		...initialPreferences,
		companion_frames: false,
		companion_paused: true,
	});
	expect(await captureRead()).toEqual({
		...baselineCapture,
		frames: false,
		paused: true,
	});
	await unmount();
	await mount();
	await captureLoaded();
	expect(captureSwitch("Screen recording").getAttribute("aria-checked")).toBe(
		"false"
	);
	expect(captureSwitch("Pause all capture").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(captureWrites().at(-1)?.body).toEqual({
		frames: false,
		paused: true,
		app_allowlist: ["Terminal"],
		history_retention_days: 30,
	});
});

test("actual allowlist comma edit trims whitespace/drops empty entries and saves exact sparse payload plus durable disk/remount", async () => {
	await mount();
	await captureLoaded();
	const before = captureWrites().length;
	await edit(
		"App allowlist, comma-separated app names",
		" Terminal , , Visual Studio Code , "
	);
	await act(async () =>
		input("App allowlist, comma-separated app names").dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
		)
	);
	await finishCaptureWrite(before);
	expect(captureWrites().at(-1)?.body).toEqual({
		app_allowlist: ["Terminal", "Visual Studio Code"],
	});
	expect(persistedPreferences()).toEqual({
		...initialPreferences,
		companion_app_allowlist: ["Terminal", "Visual Studio Code"],
	});
	expect(await captureRead()).toEqual({
		...baselineCapture,
		app_allowlist: ["Terminal", "Visual Studio Code"],
	});
	await unmount();
	await mount();
	await captureLoaded();
	expect(input("App allowlist, comma-separated app names").value).toBe(
		"Terminal, Visual Studio Code"
	);
});

test("actual retention lower/upper boundaries persist canonical integers without changing frames/pause/allowlist and survive remount", async () => {
	await mount();
	await captureLoaded();
	for (const [raw, normalized] of [
		["0", 1],
		["99999", 3650],
		["14", 14],
	] as const) {
		const before = captureWrites().length;
		await enterRetention(raw);
		await finishCaptureWrite(before);
		expect(captureWrites().at(-1)?.body).toEqual({
			history_retention_days: normalized,
		});
		expect(await captureRead()).toEqual({
			...baselineCapture,
			history_retention_days: normalized,
		});
		expect(persistedPreferences()).toEqual({
			...initialPreferences,
			shadow_history_retention_days: normalized,
		});
		expect(input("Shadow history retention in days").value).toBe(
			String(normalized)
		);
	}
	await unmount();
	await mount();
	await captureLoaded();
	expect(input("Shadow history retention in days").value).toBe("14");
});

for (const status of [403, 503]) {
	test(`capture POST${status} leaves independently read active pause unchanged while desired pause is durably saved, and shows not-applied state`, async () => {
		await mount();
		await captureLoaded();
		nextCaptureStatus = status;
		const before = captureWrites().length;
		await toggleCapture("Pause all capture");
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

for (const refusal of ["set", "save"] as const) {
	test(`native store ${refusal} refusal cannot claim durable save; actual pause ACK is independently active and visible persistence error is required`, async () => {
		await mount();
		await captureLoaded();
		if (refusal === "set") {
			nextStoreSetRefused = true;
		} else {
			nextStoreSaveRefused = true;
		}
		const before = captureWrites().length;
		await toggleCapture("Pause all capture");
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
			captureSwitch("Pause all capture").getAttribute("aria-checked")
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

test("persisted paused preference refused during initial apply is not proof of active incognito and requires truthful not-applied notice", async () => {
	stagedPreferences.companion_paused = true;
	writeFileSync(storeDisk, JSON.stringify(stagedPreferences));
	nextCaptureStatus = 403;
	await mount();
	await captureLoaded();
	expect(persistedPreferences().companion_paused).toBe(true);
	expect(await captureRead()).toEqual(baselineCapture);
	expect(captureWrites()[0]).toMatchObject({
		status: 403,
		body: { ...baselineCapture, paused: true },
	});
	expect(container.textContent).toMatch(
		/capture.*(?:not applied|could not be applied|could not apply)|(?:not applied|could not apply).*capture/i
	);
	expect(container.textContent).not.toContain("Shadow records nothing at all");
});

test("held actual pause POST keeps physical capture unchanged and renders applying state until actual acknowledgment", async () => {
	await mount();
	await captureLoaded();
	heldPath = capturePath;
	heldMethod = "POST";
	const before = captureWrites().length;
	await toggleCapture("Pause all capture");
	await until(
		() => releaseHeld !== null,
		"Actual pause HTTP request never reached held boundary"
	);
	expect(persistedPreferences().companion_paused).toBe(true);
	expect(await captureRead()).toEqual(baselineCapture);
	expect(container.textContent).toMatch(/applying.*capture|capture.*applying/i);
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

// Corrupt values are genuine JSON returned by the installed Store frontend.
// The explicit React root error callback records a shipping render crash; the
// tests require zero caught errors, unchanged disk/active state and zero POSTs.
for (const corruption of [
	{ key: "companion_frames", value: "false", label: "string frame flag" },
	{ key: "companion_paused", value: "false", label: "string pause flag" },
	{ key: "companion_paused", value: null, label: "present null pause flag" },
	{
		key: "companion_app_allowlist",
		value: { app: "Terminal" },
		label: "object allowlist",
	},
	{
		key: "companion_app_allowlist",
		value: ["Terminal", 7],
		label: "mixed allowlist",
	},
	{
		key: "shadow_history_retention_days",
		value: "7",
		label: "string history retention",
	},
]) {
	test(`malformed saved ${corruption.label} keeps capture unchanged and recovers after a genuine preference reread`, async () => {
		stagedPreferences.companion_paused = true;
		stagedPreferences[corruption.key] = corruption.value;
		writeFileSync(storeDisk, JSON.stringify(stagedPreferences));
		const corruptDisk = persistedPreferences();
		capture = { ...baselineCapture, paused: true };
		try {
			await mount(true);
			await until(
				() =>
					inFlight === 0 &&
					(caughtCaptureRenderErrors.length > 0 ||
						captureWrites().some((call) => call.completed) ||
						/could not read saved capture preferences/i.test(
							container.textContent ?? ""
						)),
				"Actual corrupt preference read did not settle"
			);
		} catch (error) {
			// React19 forwards render errors through act while its queue is active.
			// These remain explicit failures of the zero-errors oracle below.
			caughtCaptureRenderErrors.push(error);
		}
		expect(await captureRead()).toEqual({ ...baselineCapture, paused: true });
		expect(persistedPreferences()).toEqual(corruptDisk);
		expect(caughtCaptureRenderErrors).toHaveLength(0);
		expect(captureWrites()).toHaveLength(0);
		expect(container.textContent).toMatch(
			/could not read saved capture preferences/i
		);
		// Explicit fixture repair represents corrected on-disk data. Retry must
		// read actual Store values again, not reuse an invalid cached draft.
		stagedPreferences = { ...initialPreferences, companion_paused: true };
		writeFileSync(storeDisk, JSON.stringify(stagedPreferences));
		const before = captureWrites().length;
		await click("Retry capture settings");
		await finishCaptureWrite(before);
		expect(captureWrites().at(-1)?.body).toEqual({
			...baselineCapture,
			paused: true,
		});
		expect(await captureRead()).toEqual({ ...baselineCapture, paused: true });
		expect(persistedPreferences()).toEqual(stagedPreferences);
		for (const key of Object.keys(initialPreferences)) {
			expect(
				ipcCalls.filter(
					(call) =>
						call.command === "plugin:store|get" &&
						(call.args as { key?: string }).key === key &&
						call.outcome === "accepted"
				)
			).toHaveLength(2);
		}
		expect(container.textContent).not.toMatch(
			/could not read saved capture preferences/i
		);
	});
}

test("genuinely missing capture preferences retain first-install defaults", async () => {
	stagedPreferences = {};
	writeFileSync(storeDisk, JSON.stringify(stagedPreferences));
	await mount();
	await loaded();
	expect(captureWrites().at(-1)?.body).toEqual({
		...baselineCapture,
		app_allowlist: [],
	});
	expect(await captureRead()).toEqual({
		...baselineCapture,
		app_allowlist: [],
	});
	expect(persistedPreferences()).toEqual({});
	expect(container.textContent).not.toMatch(
		/could not read saved capture preferences/i
	);
});
