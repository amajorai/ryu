import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The Shadow settings peer: a real Bun server standing in for Core, plus the
// instrumented client fetch. Shared by the ShadowSettings.native-http suites.

// The shipping Shadow client is device-local. Configure its genuine supported
// Core URL before importing it; never rewrite a URL, SDK function or response.
export const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
export const previousCoreUrl = process.env.VITE_CORE_URL;
export const configPath = "/api/shadow/computer-use/config";
export const secretListPath = "/api/plugins/%40ryu%2Fshadow/secrets";
export const secretPath = `${secretListPath}/SHADOW_JEV_API_KEY`;
export const nodeToken = "shadow-test-only-local-bearer";
export const dummyKey = "shadow-dummy-key-never-valid";
export const initialConfig = {
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
export type Config = typeof initialConfig;
interface Call {
	authorization: string | null;
	body: unknown;
	completed: boolean;
	jwt: string | null;
	method: string;
	path: string;
	status: number;
}
export let saved: Config = structuredClone(initialConfig);
export let secret: string | null = null;
export let calls: Call[] = [];
export let unexpected: string[] = [];
let nextConfigReadStatus: number | null = null;
let nextConfigWriteStatus: number | null = null;
let nextSecretReadStatus: number | null = null;
let nextSecretWriteStatus: number | null = null;
let nextSecretDeleteStatus: number | null = null;
let heldPath: string | null = null;
let heldMethod: string | null = null;
export let releaseHeld: (() => void) | null = null;
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
			url.pathname === "/api/shadow/capture/control" &&
			["GET", "POST"].includes(request.method)
		) {
			// This finite fixture represents the genuine stopped capture sidecar.
			// No OS capture/permission/restart/inference success is synthesized.
			return reply({ error: "Owned Shadow capture is stopped" }, 502);
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
export const egress: string[] = [];
export let inFlight = 0;
interface ClientRead {
	bodyConsumed: boolean;
	headersReceived: boolean;
	method: string;
	path: string;
	status: number | null;
}
export let clientReads: ClientRead[] = [];
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

/** Forget every request and restore the saved config between tests. */
export function resetShadowPeer() {
	saved = structuredClone(initialConfig);
	secret = null;
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
}

/** Hold the next request to `path` with `method` until `takeHeldRelease()`. */
export function holdNext(path: string, method: string) {
	heldPath = path;
	heldMethod = method;
}

/** Take the pending release of a held request, if any. */
export function takeHeldRelease() {
	const resolve = releaseHeld;
	releaseHeld = null;
	return resolve;
}

type FailableRequest =
	| "configRead"
	| "configWrite"
	| "secretDelete"
	| "secretRead"
	| "secretWrite";

/** Answer the next `kind` request with `status`. */
export function failNext(kind: FailableRequest, status: number) {
	switch (kind) {
		case "configRead":
			nextConfigReadStatus = status;
			break;
		case "configWrite":
			nextConfigWriteStatus = status;
			break;
		case "secretDelete":
			nextSecretDeleteStatus = status;
			break;
		case "secretRead":
			nextSecretReadStatus = status;
			break;
		case "secretWrite":
			nextSecretWriteStatus = status;
			break;
		default:
			throw new Error(`Unknown request ${kind satisfies never}`);
	}
}

/** Store `value` as the saved Jev key, as if an earlier session had set it. */
export function setSavedSecret(value: string | null) {
	secret = value;
}
