import { setDefaultTimeout } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Control-level coverage for the shipping DictationSettings tab. Every read and
// write crosses real loopback HTTP to a Core-shaped preference store owned by
// this file, through the production preference SDK and request client. The
// island's real `parseDictationPrefs` then reads the stored blob, which is the
// consumer that registers the shortcuts and inserts text on the OS side.
export const nativeFetch = globalThis.fetch;
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

export const NODE_TOKEN = "dictation-coverage-node-token";
export const DICTATION_PATH = "/api/preferences/dictation";
export const SPEECH_PATH = "/api/preferences/speech-processing";
export const EMPTY_SELECTION = {
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

export const store = new Map<string, string>();
export const calls: CoreCall[] = [];
export const unexpected: string[] = [];
export const armed = new Map<string, number[]>();
let holdNextPut: string | null = null;
export let releaseHeld: (() => void) | null = null;

export function arm(method: string, path: string, ...statuses: number[]) {
	armed.set(`${method} ${path}`, statuses);
}

function takeArmed(method: string, path: string): number | null {
	const queue = armed.get(`${method} ${path}`);
	const status = queue?.shift();
	return status ?? null;
}

export const server = Bun.serve({
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

/** Holds the next PUT to `path` until the case releases it (`null`: none). */
export function holdNextPutTo(path: string | null) {
	holdNextPut = path;
}
/** Forgets any held PUT and its release. */
export function resetHeldPut() {
	holdNextPut = null;
	releaseHeld = null;
}
