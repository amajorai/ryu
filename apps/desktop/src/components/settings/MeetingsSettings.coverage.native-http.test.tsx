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

// Control-level coverage for the shipping Meetings settings tab, focused on the
// "Meeting apps" field and its interplay with the auto-detect switch. Every read
// and write crosses real loopback HTTP, through the production meetings and
// preference SDKs, to a Core-shaped fixture owned by this file. Its
// `/api/meetings/detection-config` handlers mirror the meetings sidecar
// (`apps-store/meetings/backend/src/api.rs`): GET falls back to the built-in app
// list only while no list was ever saved, and PUT applies a partial update.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
window.fetch = nativeFetch;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE_TOKEN = "meetings-coverage-node-token";
const USER_JWT = "meetings-coverage-user-jwt";
const DETECTION_PATH = "/api/meetings/detection-config";
const DEFAULT_MEETING_APPS = [
	"zoom",
	"teams",
	"meet",
	"slack",
	"discord",
	"webex",
	"skype",
	"facetime",
	"whereby",
	"around",
	"gather",
	"huddle",
];
const ENTITLEMENT_MIRRORS = new Set([
	"entitlement-active",
	"managed-inference-entitled",
]);
const SEEDED_PREFERENCES: Record<string, string> = {
	"meeting-diarization-enabled": "true",
	"meeting-diarization-model": "nemotron",
	"meeting-notes-effort": "medium",
	"meeting-notes-model": "gpt-4.1-mini",
	"meeting-notes-prompt": "Keep owners and dates.",
	"meeting-notes-template": "standup",
};

interface CoreCall {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

/** The sidecar's preference keys for detection, as raw stored strings. */
const sidecarPrefs = new Map<string, string>();
const corePrefs = new Map<string, string>();
const calls: CoreCall[] = [];
const unexpected: string[] = [];
const armed = new Map<string, number[]>();

function arm(method: string, path: string, ...statuses: number[]) {
	armed.set(`${method} ${path}`, statuses);
}

function detectionConfig() {
	const enabledPref = sidecarPrefs.get("meeting-detection-enabled");
	const appsPref = sidecarPrefs.get("meeting-detection-apps");
	let apps = DEFAULT_MEETING_APPS;
	if (appsPref !== undefined) {
		apps = JSON.parse(appsPref) as string[];
	}
	return {
		apps,
		enabled: enabledPref === undefined ? true : enabledPref.trim() !== "false",
	};
}

function catalog() {
	return {
		apiTypes: ["openai-completions"],
		providers: [
			{
				authKind: "api-key",
				configured: true,
				custom: false,
				id: "openai",
				label: "OpenAI",
				modelOverrides: {},
				routing: "gateway",
				suggestedModels: ["gpt-4.1-mini", "gpt-4.1"],
				supportsDiscovery: false,
			},
		],
		thinkingLevels: ["low", "medium", "high"],
	};
}

async function handle(request: Request, call: CoreCall): Promise<Response> {
	const path = call.path;
	if (path.startsWith("/api/preferences/")) {
		const key = decodeURIComponent(path.slice("/api/preferences/".length));
		if (request.method === "GET") {
			const value = corePrefs.get(key);
			call.status = value === undefined ? 404 : 200;
			return value === undefined
				? NativeResponse.json({ error: "not found" }, { status: 404 })
				: NativeResponse.json({ key, value });
		}
		if (request.method === "PUT") {
			const body = call.body as { value?: unknown } | null;
			if (typeof body?.value !== "string") {
				unexpected.push(`Invalid preference body for ${key}`);
				call.status = 400;
				return NativeResponse.json({ error: "bad body" }, { status: 400 });
			}
			if (!ENTITLEMENT_MIRRORS.has(key)) {
				corePrefs.set(key, body.value);
			}
			call.status = 200;
			return NativeResponse.json({ key, value: body.value });
		}
	}
	if (path === DETECTION_PATH) {
		if (request.method === "GET") {
			call.status = 200;
			return NativeResponse.json(detectionConfig());
		}
		if (request.method === "PUT") {
			const body = (call.body ?? {}) as { apps?: unknown; enabled?: unknown };
			const extra = Object.keys(body).filter(
				(key) => key !== "apps" && key !== "enabled"
			);
			if (extra.length > 0) {
				unexpected.push(`Unknown detection fields ${extra.join(",")}`);
			}
			if (typeof body.enabled === "boolean") {
				sidecarPrefs.set(
					"meeting-detection-enabled",
					body.enabled ? "true" : "false"
				);
			}
			if (body.apps !== undefined) {
				if (
					!(
						Array.isArray(body.apps) &&
						body.apps.every((app) => typeof app === "string")
					)
				) {
					unexpected.push("Detection apps must be a string list");
					call.status = 422;
					return NativeResponse.json({ error: "bad apps" }, { status: 422 });
				}
				sidecarPrefs.set("meeting-detection-apps", JSON.stringify(body.apps));
			}
			call.status = 200;
			return NativeResponse.json(detectionConfig());
		}
	}
	if (request.method !== "GET") {
		unexpected.push(`Undeclared ${request.method} ${path}`);
		call.status = 405;
		return NativeResponse.json({ error: "undeclared" }, { status: 405 });
	}
	call.status = 200;
	switch (path) {
		case "/api/meetings/templates":
			return NativeResponse.json({
				templates: [
					{ id: "general", name: "General" },
					{ id: "standup", name: "Daily standup" },
				],
			});
		case "/api/pi-config/catalog":
			return NativeResponse.json(catalog());
		case "/api/agents":
			return NativeResponse.json({ agents: [] });
		case "/api/engines":
			return NativeResponse.json({ engines: [] });
		case "/api/engine/active":
			return NativeResponse.json({
				active: "gateway",
				available: [],
				running: true,
			});
		default:
			unexpected.push(`Undeclared GET ${path}`);
			call.status = 404;
			return NativeResponse.json({ error: "undeclared" }, { status: 404 });
	}
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (
			request.headers.get("authorization") !== `Bearer ${NODE_TOKEN}` ||
			request.headers.get("x-ryu-user-jwt") !== USER_JWT
		) {
			unexpected.push(`${request.method} ${url.pathname} without node auth`);
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		const raw = request.method === "PUT" ? await request.text() : "";
		const call: CoreCall = {
			body: raw ? JSON.parse(raw) : null,
			method: request.method,
			path: url.pathname,
			status: 0,
		};
		calls.push(call);
		const queued = armed.get(`${request.method} ${url.pathname}`);
		const refusal = queued?.shift();
		if (refusal !== undefined) {
			call.status = refusal;
			return NativeResponse.json(
				{ error: "Meetings coverage refusal" },
				{ status: refusal }
			);
		}
		return await handle(request, call);
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
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { MeetingsSettings } = await import("./MeetingsSettings.tsx");

const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(async () => {
	sidecarPrefs.clear();
	corePrefs.clear();
	for (const [key, value] of Object.entries(SEEDED_PREFERENCES)) {
		corePrefs.set(key, value);
	}
	calls.length = 0;
	unexpected.length = 0;
	armed.clear();
	localStorage.clear();
	localStorage.setItem("meetings-coverage-unrelated", "kept");
	await act(async () => {
		queryClient.clear();
		sileo.clear();
	});
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "meetings-coverage",
		nodes: [
			{
				name: "meetings-coverage",
				token: NODE_TOKEN,
				url: server.url.origin,
				userJwt: USER_JWT,
			},
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await unmount();
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
		sileo.clear();
	});
	container.remove();
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("meetings-coverage-unrelated")).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
	expect(unexpected).toEqual([]);
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
	throw new Error(`${label} did not settle: ${document.body.textContent}`);
}

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<MeetingsSettings />
					<Toaster position="bottom-right" />
				</EntitlementProvider>
			</QueryClientProvider>
		)
	);
	await until(
		() => container.querySelector("#meeting-apps") !== null,
		"Meetings settings load"
	);
}

async function unmount() {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
}

async function remount() {
	await unmount();
	await mount();
}

function appsField(): HTMLInputElement {
	const label = [...container.querySelectorAll("label")].find(
		(candidate) => candidate.textContent?.trim() === "Meeting apps"
	);
	const field = label?.htmlFor
		? container.querySelector<HTMLInputElement>(`#${label.htmlFor}`)
		: null;
	if (!field) {
		throw new Error("Missing labelled Meeting apps field");
	}
	return field;
}

function autoDetect(): HTMLElement {
	const found = container.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Auto-detect meetings"]'
	);
	if (!found) {
		throw new Error("Missing Auto-detect meetings switch");
	}
	return found;
}

function identifySpeakers(): HTMLElement {
	const found = container.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Identify speakers"]'
	);
	if (!found) {
		throw new Error("Missing Identify speakers switch");
	}
	return found;
}

function isChecked(element: HTMLElement) {
	return element.getAttribute("aria-checked") === "true";
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

/** Move focus off the field, as Tab or a click elsewhere does. */
async function leave(element: HTMLElement) {
	await act(async () => {
		element.blur();
	});
}

function detectionWrites() {
	return calls
		.filter((call) => call.method === "PUT" && call.path === DETECTION_PATH)
		.map((call) => ({ body: call.body, status: call.status }));
}

function preferenceWrites() {
	return calls.filter(
		(call) =>
			call.method === "PUT" &&
			call.path.startsWith("/api/preferences/") &&
			!ENTITLEMENT_MIRRORS.has(call.path.slice("/api/preferences/".length))
	);
}

test("Meeting apps normalizes the list on leave, saves only that patch, and reloads it", async () => {
	await mount();
	expect(appsField().value).toBe(DEFAULT_MEETING_APPS.join(", "));
	expect(appsField().placeholder).toBe("zoom, teams, meet, slack, discord");
	expect(isChecked(autoDetect())).toBe(true);

	await type(appsField(), "  zoom, , Google Meet ,teams,,  ");
	// Typing alone writes nothing.
	expect(detectionWrites()).toEqual([]);
	await leave(appsField());
	await until(() => detectionWrites().length === 1, "apps write");
	expect(detectionWrites()).toEqual([
		{ body: { apps: ["zoom", "Google Meet", "teams"] }, status: 200 },
	]);
	expect(appsField().value).toBe("zoom, Google Meet, teams");
	expect(detectionConfig()).toEqual({
		apps: ["zoom", "Google Meet", "teams"],
		enabled: true,
	});
	// The note-generation preferences are not touched by an app-list save.
	expect(preferenceWrites()).toEqual([]);
	expect(Object.fromEntries(corePrefs)).toEqual(SEEDED_PREFERENCES);

	await remount();
	expect(appsField().value).toBe("zoom, Google Meet, teams");
	expect(isChecked(autoDetect())).toBe(true);
	expect(isChecked(identifySpeakers())).toBe(true);
});

test("a refused app-list save keeps the draft and the node's saved list, and leaving again retries", async () => {
	sidecarPrefs.set("meeting-detection-apps", JSON.stringify(["zoom"]));
	await mount();
	expect(appsField().value).toBe("zoom");

	arm("PUT", DETECTION_PATH, 503);
	await type(appsField(), "zoom, Webex ");
	await leave(appsField());
	await until(
		() =>
			document.body.textContent?.includes(
				"Couldn't save your detection settings"
			) === true,
		"apps failure toast"
	);
	expect(appsField().value).toBe("zoom, Webex");
	expect(detectionConfig().apps).toEqual(["zoom"]);

	await act(async () => appsField().focus());
	await leave(appsField());
	await until(() => detectionWrites().length === 2, "apps retry");
	expect(detectionWrites()).toEqual([
		{ body: { apps: ["zoom", "Webex"] }, status: 503 },
		{ body: { apps: ["zoom", "Webex"] }, status: 200 },
	]);
	expect(detectionConfig()).toEqual({ apps: ["zoom", "Webex"], enabled: true });

	await remount();
	expect(appsField().value).toBe("zoom, Webex");
});

test("clearing Meeting apps saves an empty list that the node keeps instead of the defaults", async () => {
	await mount();
	await type(appsField(), " , ,");
	await leave(appsField());
	await until(() => detectionWrites().length === 1, "empty apps write");
	expect(detectionWrites()).toEqual([{ body: { apps: [] }, status: 200 }]);
	expect(appsField().value).toBe("");
	expect(detectionConfig().apps).toEqual([]);

	await remount();
	expect(appsField().value).toBe("");
	expect(appsField().placeholder).toBe("zoom, teams, meet, slack, discord");
});

test("auto-detect and the app list save independently and both survive a reload", async () => {
	await mount();

	await act(async () => autoDetect().click());
	await until(() => detectionWrites().length === 1, "toggle write");
	expect(isChecked(autoDetect())).toBe(false);

	await type(appsField(), "zoom, Around");
	await leave(appsField());
	await until(() => detectionWrites().length === 2, "apps write");
	expect(detectionWrites()).toEqual([
		{ body: { enabled: false }, status: 200 },
		{ body: { apps: ["zoom", "Around"] }, status: 200 },
	]);
	expect(detectionConfig()).toEqual({
		apps: ["zoom", "Around"],
		enabled: false,
	});

	await remount();
	expect(isChecked(autoDetect())).toBe(false);
	expect(appsField().value).toBe("zoom, Around");
	expect(preferenceWrites()).toEqual([]);
});

test("a refused auto-detect toggle snaps back, leaves the app list alone, and a retry saves it", async () => {
	sidecarPrefs.set("meeting-detection-apps", JSON.stringify(["zoom"]));
	await mount();

	arm("PUT", DETECTION_PATH, 503);
	await act(async () => autoDetect().click());
	await until(
		() =>
			document.body.textContent?.includes(
				"Couldn't save your detection settings"
			) === true,
		"toggle failure toast"
	);
	await until(() => isChecked(autoDetect()), "switch rolled back");
	expect(appsField().value).toBe("zoom");
	expect(detectionConfig()).toEqual({ apps: ["zoom"], enabled: true });

	await act(async () => autoDetect().click());
	await until(() => detectionWrites().length === 2, "toggle retry");
	await until(() => !isChecked(autoDetect()), "switch off");
	expect(detectionWrites()).toEqual([
		{ body: { enabled: false }, status: 503 },
		{ body: { enabled: false }, status: 200 },
	]);
	expect(detectionConfig()).toEqual({ apps: ["zoom"], enabled: false });

	await remount();
	expect(isChecked(autoDetect())).toBe(false);
	expect(appsField().value).toBe("zoom");
});
