import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// Control-level proof for the ShadowSettings rows the capture and credential
// suites do not reach by name: Keep history, Planner, Action limit, Jev endpoint,
// Jev model and Local model. The shipping component talks to a native Bun HTTP
// server on the local Core URL. Its computer-use policy route applies the same
// validation as Core (`apps/core/src/server/shadow_proxy/computer_use_settings.rs`:
// `Settings::validate`, `validate_endpoint`, `validate_local_model_selection`) and
// answers refusals in Core's `{ error: { code, message } }` shape. Capture
// preferences go through the installed Tauri Store frontend to an explicit IPC
// fixture that writes a real file.

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const previousCoreUrl = process.env.VITE_CORE_URL;
const nodeToken = "shadow-controls-test-only-local-bearer";
const configPath = "/api/shadow/computer-use/config";
const capturePath = "/api/shadow/capture/control";
const secretListPath = "/api/plugins/%40ryu%2Fshadow/secrets";
const contributionsPath = "/api/plugins/contributions";
const proofDirectory = mkdtempSync(join(tmpdir(), "shadow-controls-proof-"));
const policyDisk = join(proofDirectory, "computer-use.json");
const storeDisk = join(proofDirectory, "companion.bin.json");

type Planner = "native" | "jev" | "laya" | "local";
interface Policy {
	jevModel: string;
	jevUrl: string;
	layaUrl: string;
	localModelId: string;
	localPluginId: string;
	maxSteps: number;
	planner: Planner;
}
interface ContributedPlanner {
	id: string;
	label: string;
	model_id: string;
	plugin: string;
}
interface Call {
	body: unknown;
	completed: boolean;
	method: string;
	path: string;
	status: number;
}

const initialPolicy: Policy = {
	planner: "jev",
	jevUrl: "https://jev.example.test/v1/decide",
	jevModel: "saved-jev-model",
	layaUrl: "http://127.0.0.1:7980/api/ext/@ryu/laya/predict",
	localPluginId: "",
	localModelId: "",
	maxSteps: 7,
};
const functionGemma: ContributedPlanner = {
	plugin: "@ryu/functiongemma",
	id: "functiongemma-270m",
	model_id: "functiongemma-270m-it",
	label: "FunctionGemma 270M",
};
const layaRouter: ContributedPlanner = {
	plugin: "@ryu/laya",
	id: "router",
	model_id: "router",
	label: "Laya router",
};
const baselineCapture = {
	frames: true,
	paused: false,
	app_allowlist: ["Terminal"],
	history_retention_days: 30,
};
const initialPreferences: Record<string, unknown> = {
	companion_frames: true,
	companion_paused: false,
	companion_app_allowlist: ["Terminal"],
	shadow_history_retention_days: 30,
};

let planners: ContributedPlanner[] = [];
let enabledPlugins = new Set<string>();
let capture = structuredClone(baselineCapture);
let stagedPreferences: Record<string, unknown> = {};
let calls: Call[] = [];
let unexpected: string[] = [];
let egress: string[] = [];
let inFlight = 0;

function savedPolicy(): Policy {
	return JSON.parse(readFileSync(policyDisk, "utf8")) as Policy;
}
function writePolicy(policy: Policy) {
	writeFileSync(`${policyDisk}.next`, JSON.stringify(policy));
	renameSync(`${policyDisk}.next`, policyDisk);
}
function persistedPreferences() {
	return JSON.parse(readFileSync(storeDisk, "utf8")) as Record<string, unknown>;
}

// Core's `validate_endpoint` and `Settings::validate`, message for message.
function isLoopbackHost(host: string) {
	return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
}
function endpointError(value: string, loopbackOnly: boolean): string | null {
	if (value.length > 2048) {
		return "computer-use endpoint URLs must be at most 2048 bytes";
	}
	if (!URL.canParse(value)) {
		return "computer-use endpoint must be a valid URL";
	}
	const url = new URL(value);
	if (url.username || url.password || url.search || url.hash) {
		return "computer-use endpoints cannot contain credentials, query, or fragment";
	}
	const loopback = isLoopbackHost(url.hostname);
	if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
		return "computer-use endpoints require HTTPS; HTTP is loopback-only";
	}
	if (loopbackOnly && !loopback) {
		return "layaUrl must use the local Core loopback address";
	}
	return null;
}
const pluginIdPattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
function policyError(policy: Policy): string | null {
	const endpoint =
		endpointError(policy.jevUrl, false) ?? endpointError(policy.layaUrl, true);
	if (endpoint) {
		return endpoint;
	}
	if (!policy.jevModel.trim() || policy.jevModel.length > 128) {
		return "jevModel must be 1..=128 characters";
	}
	if (policy.planner === "local") {
		if (!pluginIdPattern.test(policy.localPluginId)) {
			return "localPluginId must be a valid Ryu plugin id";
		}
		if (
			!policy.localModelId.trim() ||
			policy.localModelId.length > 256 ||
			/\p{Cc}/u.test(policy.localModelId)
		) {
			return "localModelId must be 1..=256 printable characters";
		}
	}
	if (
		!Number.isInteger(policy.maxSteps) ||
		policy.maxSteps < 1 ||
		policy.maxSteps > 20
	) {
		return "maxSteps must be between 1 and 20";
	}
	if (policy.planner === "local") {
		const advertised = planners.some(
			(planner) =>
				planner.plugin === policy.localPluginId &&
				planner.model_id === policy.localModelId
		);
		if (!advertised) {
			return "the selected model is not advertised by the selected Ryu plugin";
		}
		if (!enabledPlugins.has(policy.localPluginId)) {
			return "enable the selected local model plugin before choosing it";
		}
	}
	return null;
}
const policyKeys = [
	"jevModel",
	"jevUrl",
	"layaUrl",
	"localModelId",
	"localPluginId",
	"maxSteps",
	"planner",
];

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
			status: 0,
			completed: false,
		};
		calls.push(call);
		const reply = (value: unknown, status = 200) => {
			call.status = status;
			call.completed = true;
			return NativeResponse.json(value, { status });
		};
		const refuse = (status: number, code: string, message: string) =>
			reply({ error: { code, message } }, status);
		if (request.headers.get("authorization") !== `Bearer ${nodeToken}`) {
			unexpected.push(`${request.method} ${call.path} without local bearer`);
			return refuse(401, "unauthorized", "local bearer required");
		}
		if (url.pathname === configPath && request.method === "GET") {
			return reply({
				...savedPolicy(),
				applied: false,
				jevApiKeyConfigured: false,
			});
		}
		if (url.pathname === configPath && request.method === "POST") {
			if (
				!body ||
				typeof body !== "object" ||
				JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(policyKeys)
			) {
				unexpected.push("computer-use POST without the complete policy");
				return refuse(
					400,
					"invalid_computer_use_config",
					"computer-use settings have an invalid shape"
				);
			}
			const policy = body as Policy;
			const refusal = policyError(policy);
			if (refusal) {
				return refuse(400, "invalid_computer_use_config", refusal);
			}
			writePolicy(policy);
			return reply({ ...policy, applied: false, jevApiKeyConfigured: false });
		}
		if (url.pathname === secretListPath && request.method === "GET") {
			// Core lists stored slots only; no Jev key has been stored here.
			return reply({ secrets: [] });
		}
		if (url.pathname === contributionsPath && request.method === "GET") {
			return reply({
				computer_use_planners: planners.filter((planner) =>
					enabledPlugins.has(planner.plugin)
				),
			});
		}
		if (url.pathname === capturePath && request.method === "GET") {
			return reply(structuredClone(capture));
		}
		if (url.pathname === capturePath && request.method === "POST") {
			const update = body as Record<string, unknown>;
			const days = update.history_retention_days;
			if (
				days !== undefined &&
				!(Number.isInteger(days) && Number(days) >= 1 && Number(days) <= 3650)
			) {
				unexpected.push(`invalid retention ${String(days)}`);
				return refuse(400, "invalid_capture_control", "invalid retention");
			}
			capture = { ...capture, ...update };
			return reply(structuredClone(capture));
		}
		unexpected.push(`${request.method} ${call.path}`);
		return refuse(503, "undeclared", "Undeclared Shadow controls request");
	},
});
process.env.VITE_CORE_URL = server.url.origin;
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
// Explicit IPC fixture behind the installed `@tauri-apps/plugin-store` frontend.
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: (command: string, args: Record<string, unknown>) => {
		if (command === "plugin:store|load" && args.path === "companion.bin") {
			return 1;
		}
		const key = String(args.key);
		if (args.rid !== 1) {
			unexpected.push(`store IPC ${command} for an unknown resource`);
			throw new Error("Unknown store resource");
		}
		if (command === "plugin:store|get") {
			return [
				structuredClone(stagedPreferences[key]),
				Object.hasOwn(stagedPreferences, key),
			];
		}
		if (command === "plugin:store|set") {
			stagedPreferences[key] = structuredClone(args.value);
			return null;
		}
		if (command === "plugin:store|save") {
			writeFileSync(`${storeDisk}.next`, JSON.stringify(stagedPreferences));
			renameSync(`${storeDisk}.next`, storeDisk);
			return null;
		}
		unexpected.push(`store IPC ${command}`);
		throw new Error("Undeclared store command");
	},
});
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof nativeFetch>) => {
		const input = args[0];
		const href =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (new URL(href).origin !== server.url.origin) {
			egress.push(href);
			throw new Error("Shadow controls proof refuses unowned egress");
		}
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
const { ShadowSettings } = await import("./ShadowSettings.tsx");
const originalNodeState = useNodeStore.getState();

let root: Root | null = null;
let client: InstanceType<typeof QueryClient> | null = null;
let container: HTMLDivElement;

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
async function settle() {
	await until(
		() => inFlight === 0 && calls.every((call) => call.completed),
		"Owned native requests did not settle"
	);
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	});
}
/** The shipping row whose title is `title`, as SettingsItem renders it. */
function row(title: string): HTMLElement {
	const heading = [
		...container.querySelectorAll<HTMLElement>('[data-slot="item-title"]'),
	].find((item) => item.textContent?.trim() === title);
	const item = heading?.closest<HTMLElement>('[data-slot="item"]');
	if (!item) {
		throw new Error(`Missing shipping settings row ${title}`);
	}
	return item;
}
function rowInput(title: string): HTMLInputElement {
	const inputs = row(title).querySelectorAll<HTMLInputElement>(
		'input:not([aria-hidden="true"])'
	);
	if (inputs.length !== 1 || !inputs[0]) {
		throw new Error(`Row ${title} must own exactly one visible input`);
	}
	return inputs[0];
}
/** The caption SettingsItem renders below the card that holds the row. */
function rowDescription(title: string): string {
	return (
		row(title).closest('[data-slot="item-group"]')?.nextElementSibling
			?.textContent ?? ""
	);
}
function rowTrigger(title: string): HTMLElement {
	const trigger = row(title).querySelector<HTMLElement>('[role="combobox"]');
	if (!trigger) {
		throw new Error(`Row ${title} has no select trigger`);
	}
	return trigger;
}
function hasRow(title: string) {
	return [
		...container.querySelectorAll<HTMLElement>('[data-slot="item-title"]'),
	].some((item) => item.textContent?.trim() === title);
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
/** The policy Save action, whether idle ("Save …") or busy ("Saving…"). */
function saveButton() {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) =>
			["Save computer-use settings", "Saving…"].includes(
				item.textContent?.trim() ?? ""
			)
	);
}
async function type(element: HTMLInputElement, value: string) {
	await act(async () => {
		element.focus();
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function choose(trigger: HTMLElement, label: string) {
	await act(async () => trigger.click());
	await until(
		() => trigger.getAttribute("aria-expanded") === "true",
		"Select popup did not open"
	);
	const options = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].filter((item) => item.textContent?.trim() === label);
	if (options.length !== 1 || !options[0]) {
		throw new Error(`Expected one shipping option ${label}`);
	}
	const option = options[0];
	await act(async () => option.click());
	await until(
		() => trigger.getAttribute("aria-expanded") === "false",
		"Select popup did not close"
	);
}
function policyWrites() {
	return calls.filter(
		(call) => call.path === configPath && call.method === "POST"
	);
}
function captureWrites() {
	return calls.filter(
		(call) => call.path === capturePath && call.method === "POST"
	);
}
function section(title: string) {
	const heading = [...container.querySelectorAll("h3")].find(
		(item) => item.textContent?.trim() === title
	);
	const element = heading?.parentElement?.parentElement;
	if (!element) {
		throw new Error(`Missing ${title} section`);
	}
	return element;
}
async function save() {
	const before = policyWrites().length;
	await act(async () => button("Save computer-use settings").click());
	await until(
		() =>
			policyWrites().length === before + 1 &&
			policyWrites().every((call) => call.completed) &&
			saveButton()?.textContent?.trim() === "Save computer-use settings" &&
			!saveButton()?.disabled,
		"Computer-use save did not reach a settled UI"
	);
	await settle();
	return policyWrites().at(-1);
}
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client!}>
				<ShadowSettings />
			</QueryClientProvider>
		)
	);
	await until(
		() =>
			container.textContent?.includes("Computer use") === true &&
			!container.textContent.includes("Loading computer-use settings") &&
			calls.some(
				(call) =>
					call.path === capturePath && call.method === "POST" && call.completed
			) &&
			calls.some((call) => call.path === contributionsPath && call.completed),
		"Shipping Shadow settings did not finish loading"
	);
	await settle();
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

beforeEach(() => {
	writePolicy(structuredClone(initialPolicy));
	planners = [];
	enabledPlugins = new Set();
	capture = structuredClone(baselineCapture);
	stagedPreferences = structuredClone(initialPreferences);
	writeFileSync(storeDisk, JSON.stringify(stagedPreferences));
	calls = [];
	unexpected = [];
	egress = [];
	const local = {
		name: "local-controls",
		url: server.url.origin,
		token: nodeToken,
		userJwt: null,
	};
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
});
afterEach(async () => {
	await unmount();
	await until(
		() => inFlight === 0 && calls.every((call) => call.completed),
		"Owned requests remain at teardown"
	);
	if (unexpected.length > 0 || egress.length > 0) {
		throw new Error(
			`Undeclared requests or egress: ${JSON.stringify({ unexpected, egress })}`
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
	await server.stop(true);
	rmSync(proofDirectory, { recursive: true, force: true });
});

test("Keep history commits on focus loss and always shows the window Shadow keeps, for clamped and empty entries, across remount", async () => {
	await mount();
	const retention = rowInput("Keep history");
	expect(retention.getAttribute("aria-label")).toBe(
		"Shadow history retention in days"
	);
	expect(retention.value).toBe("30");
	const before = captureWrites().length;
	const commit = async (typed: string, sent: number, writes: number) => {
		await type(rowInput("Keep history"), typed);
		expect(captureWrites()).toHaveLength(before + writes - 1);
		await act(async () => rowInput("Keep history").blur());
		await until(
			() => captureWrites().length === before + writes,
			`Leaving Keep history with ${JSON.stringify(typed)} did not commit`
		);
		await settle();
		expect(captureWrites().at(-1)?.body).toEqual({
			history_retention_days: sent,
		});
		expect(capture).toEqual({
			...baselineCapture,
			history_retention_days: sent,
		});
		expect(persistedPreferences()).toEqual({
			...initialPreferences,
			shadow_history_retention_days: sent,
		});
		expect(rowInput("Keep history").value).toBe(String(sent));
	};
	await commit("45", 45, 1);
	await commit("99999", 3650, 2);
	// Same accepted window again: the field must not keep the rejected text.
	await commit("5000", 3650, 3);
	await commit("", 3650, 4);
	await unmount();
	await mount();
	expect(rowInput("Keep history").value).toBe("3650");
	expect(captureWrites().at(-1)?.body).toEqual({
		...baselineCapture,
		history_retention_days: 3650,
	});
});

test("Planner switches Jev to Shadow model without a write until Save, then saves only the planner and a fresh mount reads it", async () => {
	await mount();
	const trigger = rowTrigger("Planner");
	expect(trigger.getAttribute("aria-label")).toBe(
		"Shadow computer-use planner"
	);
	expect(trigger.textContent).toContain("Jev Ultrafast");
	expect(hasRow("Jev endpoint")).toBe(true);
	await choose(trigger, "Shadow model");
	expect(rowTrigger("Planner").textContent).toContain("Shadow model");
	expect(hasRow("Jev endpoint")).toBe(false);
	expect(hasRow("Jev model")).toBe(false);
	expect(policyWrites()).toHaveLength(0);
	expect(savedPolicy().planner).toBe("jev");
	const write = await save();
	expect(write?.body).toEqual({ ...initialPolicy, planner: "native" });
	expect(write?.status).toBe(200);
	expect(savedPolicy()).toEqual({ ...initialPolicy, planner: "native" });
	expect(section("Computer use").textContent).toContain(
		"Computer-use settings saved; they will apply when Shadow starts."
	);
	await unmount();
	await mount();
	expect(rowTrigger("Planner").textContent).toContain("Shadow model");
	expect(hasRow("Jev endpoint")).toBe(false);
	await choose(rowTrigger("Planner"), "Jev Ultrafast");
	expect(rowInput("Jev endpoint").value).toBe(initialPolicy.jevUrl);
	expect(rowInput("Jev model").value).toBe(initialPolicy.jevModel);
	expect(policyWrites()).toHaveLength(1);
});

test("Action limit's own input never sends a non-number: a cleared entry keeps the last valid limit and Save persists the next valid one", async () => {
	await mount();
	const limit = rowInput("Action limit");
	expect(limit.getAttribute("aria-label")).toBe("Maximum computer-use steps");
	expect(limit.value).toBe("7");
	await type(limit, "");
	expect(rowInput("Action limit").value).toBe("7");
	await type(rowInput("Action limit"), "15");
	expect(rowInput("Action limit").value).toBe("15");
	const write = await save();
	expect(write?.body).toEqual({ ...initialPolicy, maxSteps: 15 });
	expect(savedPolicy().maxSteps).toBe(15);
	await unmount();
	await mount();
	expect(rowInput("Action limit").value).toBe("15");
});

test("Jev endpoint and model: Core's HTTPS refusal keeps the draft and the saved file; the corrected endpoint and model save together and reload", async () => {
	await mount();
	const endpoint = rowInput("Jev endpoint");
	expect(endpoint.getAttribute("aria-label")).toBe("Jev decision endpoint URL");
	expect(endpoint.value).toBe(initialPolicy.jevUrl);
	expect(rowInput("Jev model").getAttribute("aria-label")).toBe(
		"Jev model identifier"
	);
	await type(endpoint, "http://jev.example.test/v1/decide");
	const refused = await save();
	expect(refused?.status).toBe(400);
	expect(refused?.body).toEqual({
		...initialPolicy,
		jevUrl: "http://jev.example.test/v1/decide",
	});
	const alert = section("Computer use").querySelector('[role="alert"]');
	expect(alert?.textContent).toContain(
		"Computer-use settings could not be saved"
	);
	expect(alert?.textContent).toContain(
		"computer-use endpoints require HTTPS; HTTP is loopback-only"
	);
	expect(rowInput("Jev endpoint").value).toBe(
		"http://jev.example.test/v1/decide"
	);
	expect(savedPolicy()).toEqual(initialPolicy);
	await type(
		rowInput("Jev endpoint"),
		"https://jev-two.example.test/v2/decide"
	);
	await type(rowInput("Jev model"), "jev-ultrafast-2");
	const accepted = await save();
	expect(accepted?.status).toBe(200);
	expect(accepted?.body).toEqual({
		...initialPolicy,
		jevUrl: "https://jev-two.example.test/v2/decide",
		jevModel: "jev-ultrafast-2",
	});
	expect(section("Computer use").querySelector('[role="alert"]')).toBeNull();
	expect(savedPolicy()).toEqual({
		...initialPolicy,
		jevUrl: "https://jev-two.example.test/v2/decide",
		jevModel: "jev-ultrafast-2",
	});
	await unmount();
	await mount();
	expect(rowInput("Jev endpoint").value).toBe(
		"https://jev-two.example.test/v2/decide"
	);
	expect(rowInput("Jev model").value).toBe("jev-ultrafast-2");
});

test("Local model lists enabled plugin models, preselects the first, saves the chosen plugin/model pair and reloads it", async () => {
	planners = [functionGemma, layaRouter];
	enabledPlugins = new Set([functionGemma.plugin, layaRouter.plugin]);
	await mount();
	expect(hasRow("Local model")).toBe(false);
	await choose(rowTrigger("Planner"), "Local model plugin");
	expect(hasRow("Jev endpoint")).toBe(false);
	const local = rowTrigger("Local model");
	expect(local.getAttribute("aria-label")).toBe("Local computer-use model");
	expect(local.textContent).toContain(
		"FunctionGemma 270M · @ryu/functiongemma"
	);
	expect(rowDescription("Local model")).toContain(
		"Options come from enabled model plugins."
	);
	await choose(local, "Laya router · @ryu/laya");
	expect(rowTrigger("Local model").textContent).toContain(
		"Laya router · @ryu/laya"
	);
	expect(policyWrites()).toHaveLength(0);
	const write = await save();
	expect(write?.status).toBe(200);
	expect(write?.body).toEqual({
		...initialPolicy,
		planner: "local",
		localPluginId: "@ryu/laya",
		localModelId: "router",
	});
	expect(savedPolicy()).toMatchObject({
		planner: "local",
		localPluginId: "@ryu/laya",
		localModelId: "router",
		jevUrl: initialPolicy.jevUrl,
		maxSteps: 7,
	});
	await unmount();
	await mount();
	expect(rowTrigger("Planner").textContent).toContain("Local model plugin");
	expect(rowTrigger("Local model").textContent).toContain(
		"Laya router · @ryu/laya"
	);
});

test("Local model marks a saved model no plugin advertises as unavailable and blocks Save; Core's disabled-plugin refusal keeps the saved choice", async () => {
	writePolicy({
		...initialPolicy,
		planner: "local",
		localPluginId: "@ryu/removed-planner",
		localModelId: "gone-model",
	});
	planners = [functionGemma];
	enabledPlugins = new Set([functionGemma.plugin]);
	await mount();
	expect(rowTrigger("Local model").textContent).toContain(
		"Unavailable model · @ryu/removed-planner"
	);
	expect(button("Save computer-use settings").disabled).toBe(true);
	await act(async () => button("Save computer-use settings").click());
	expect(policyWrites()).toHaveLength(0);
	await choose(
		rowTrigger("Local model"),
		"FunctionGemma 270M · @ryu/functiongemma"
	);
	expect(button("Save computer-use settings").disabled).toBe(false);
	// The plugin is disabled after Desktop listed it; Core re-checks on save.
	enabledPlugins = new Set();
	const refused = await save();
	expect(refused?.status).toBe(400);
	expect(section("Computer use").textContent).toContain(
		"enable the selected local model plugin before choosing it"
	);
	expect(savedPolicy()).toMatchObject({
		localPluginId: "@ryu/removed-planner",
		localModelId: "gone-model",
	});
	expect(rowTrigger("Local model").textContent).toContain(
		"FunctionGemma 270M · @ryu/functiongemma"
	);
	enabledPlugins = new Set([functionGemma.plugin]);
	const accepted = await save();
	expect(accepted?.status).toBe(200);
	expect(savedPolicy()).toMatchObject({
		planner: "local",
		localPluginId: functionGemma.plugin,
		localModelId: functionGemma.model_id,
	});
});

test("Local model without any enabled planner plugin explains how to add one and keeps Save disabled", async () => {
	await mount();
	await choose(rowTrigger("Planner"), "Local model plugin");
	expect(rowTrigger("Local model").textContent).toContain(
		"Choose an enabled plugin model"
	);
	expect(rowDescription("Local model")).toContain(
		"Install and enable a local computer-use model plugin"
	);
	expect(button("Save computer-use settings").disabled).toBe(true);
	await act(async () => button("Save computer-use settings").click());
	expect(policyWrites()).toHaveLength(0);
	expect(savedPolicy()).toEqual(initialPolicy);
});

test("Planner and Local model are keyboard operable: arrows move from the saved choice, Escape discards, Enter selects and returns focus to the trigger", async () => {
	planners = [functionGemma, layaRouter];
	enabledPlugins = new Set([functionGemma.plugin, layaRouter.plugin]);
	await mount();
	const press = async (key: string) => {
		const target = document.activeElement;
		if (!target) {
			throw new Error("No focused element for keyboard input");
		}
		await act(async () => {
			target.dispatchEvent(
				new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
			);
			target.dispatchEvent(
				new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true })
			);
		});
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		});
	};
	const focused = () => (document.activeElement as HTMLElement | null) ?? null;
	const planner = rowTrigger("Planner");
	await act(async () => planner.focus());
	await press("ArrowDown");
	expect(planner.getAttribute("aria-expanded")).toBe("true");
	expect(focused()?.getAttribute("role")).toBe("option");
	expect(focused()?.textContent?.trim()).toBe("Jev Ultrafast");
	await press("ArrowUp");
	expect(focused()?.textContent?.trim()).toBe("Shadow model");
	await press("Escape");
	expect(planner.getAttribute("aria-expanded")).toBe("false");
	expect(planner.textContent).toContain("Jev Ultrafast");
	expect(hasRow("Jev endpoint")).toBe(true);
	await act(async () => planner.focus());
	await press("ArrowDown");
	await press("ArrowDown");
	expect(focused()?.textContent?.trim()).toBe("Local model plugin");
	await press("Enter");
	expect(planner.getAttribute("aria-expanded")).toBe("false");
	expect(focused()).toBe(planner);
	expect(planner.textContent).toContain("Local model plugin");
	const local = rowTrigger("Local model");
	expect(local.textContent).toContain(
		"FunctionGemma 270M · @ryu/functiongemma"
	);
	await act(async () => local.focus());
	await press("ArrowDown");
	expect(focused()?.textContent?.trim()).toBe(
		"FunctionGemma 270M · @ryu/functiongemma"
	);
	await press("ArrowDown");
	await press("Enter");
	expect(focused()).toBe(local);
	expect(local.textContent).toContain("Laya router · @ryu/laya");
	expect(policyWrites()).toHaveLength(0);
	const write = await save();
	expect(write?.body).toEqual({
		...initialPolicy,
		planner: "local",
		localPluginId: layaRouter.plugin,
		localModelId: layaRouter.model_id,
	});
	expect(savedPolicy().localPluginId).toBe(layaRouter.plugin);
});
