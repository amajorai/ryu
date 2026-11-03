import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Control-level proof for the ShadowSettings rows the capture and credential
// suites do not reach by name: Keep history, Planner, Action limit, Jev endpoint,
// Jev model and Local model. The shipping component talks to a native Bun HTTP
// server on the local Core URL. Its computer-use policy route applies the same
// validation as Core (`apps/core/src/server/shadow_proxy/computer_use_settings.rs`:
// `Settings::validate`, `validate_endpoint`, `validate_local_model_selection`) and
// answers refusals in Core's `{ error: { code, message } }` shape. Capture
// preferences go through the installed Tauri Store frontend to an explicit IPC
// fixture that writes a real file.

export const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
export const previousCoreUrl = process.env.VITE_CORE_URL;
export const nodeToken = "shadow-controls-test-only-local-bearer";
export const configPath = "/api/shadow/computer-use/config";
export const capturePath = "/api/shadow/capture/control";
const secretListPath = "/api/plugins/%40ryu%2Fshadow/secrets";
export const contributionsPath = "/api/plugins/contributions";
export const proofDirectory = mkdtempSync(
	join(tmpdir(), "shadow-controls-proof-")
);
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

export const initialPolicy: Policy = {
	planner: "jev",
	jevUrl: "https://jev.example.test/v1/decide",
	jevModel: "saved-jev-model",
	layaUrl: "http://127.0.0.1:7980/api/ext/@ryu/laya/predict",
	localPluginId: "",
	localModelId: "",
	maxSteps: 7,
};
export const functionGemma: ContributedPlanner = {
	plugin: "@ryu/functiongemma",
	id: "functiongemma-270m",
	model_id: "functiongemma-270m-it",
	label: "FunctionGemma 270M",
};
export const layaRouter: ContributedPlanner = {
	plugin: "@ryu/laya",
	id: "router",
	model_id: "router",
	label: "Laya router",
};
export const baselineCapture = {
	frames: true,
	paused: false,
	app_allowlist: ["Terminal"],
	history_retention_days: 30,
};
export const initialPreferences: Record<string, unknown> = {
	companion_frames: true,
	companion_paused: false,
	companion_app_allowlist: ["Terminal"],
	shadow_history_retention_days: 30,
};

let planners: ContributedPlanner[] = [];
let enabledPlugins = new Set<string>();
export let capture = structuredClone(baselineCapture);
let stagedPreferences: Record<string, unknown> = {};
export let calls: Call[] = [];
export let unexpected: string[] = [];
export let egress: string[] = [];
export let inFlight = 0;

export function savedPolicy(): Policy {
	return JSON.parse(readFileSync(policyDisk, "utf8")) as Policy;
}
export function writePolicy(policy: Policy) {
	writeFileSync(`${policyDisk}.next`, JSON.stringify(policy));
	renameSync(`${policyDisk}.next`, policyDisk);
}
export function persistedPreferences() {
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

export const server = Bun.serve({
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

/** Restores the saved policy, capture state, store file and request logs. */
export function resetShadowPeer() {
	writePolicy(structuredClone(initialPolicy));
	planners = [];
	enabledPlugins = new Set();
	capture = structuredClone(baselineCapture);
	stagedPreferences = structuredClone(initialPreferences);
	writeFileSync(storeDisk, JSON.stringify(stagedPreferences));
	calls = [];
	unexpected = [];
	egress = [];
}
/** The planner models the plugin contributions route advertises. */
export function setPlanners(next: ContributedPlanner[]) {
	planners = next;
}
/** The plugin ids the contributions route reports as enabled. */
export function setEnabledPlugins(next: Set<string>) {
	enabledPlugins = next;
}
