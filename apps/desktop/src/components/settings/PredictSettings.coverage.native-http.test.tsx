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

// Control-level coverage for the shipping Autocomplete (Predict) settings tab's
// "Allowed apps" list. Every read and write crosses real loopback HTTP through
// the production predict SDK to a Core-shaped fixture owned by this file. Its
// `/api/predict/config` handlers mirror `crates/core/predict/src/api.rs`: GET
// returns the stored config and PUT replaces it with the posted `PredictConfig`
// and echoes it back. The allowlist's consumer, `ryu_predict::app_allowed`, is
// exercised by that crate's own Rust tests.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
window.fetch = nativeFetch;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE_TOKEN = "predict-coverage-node-token";
const USER_JWT = "predict-coverage-user-jwt";
const CONFIG_PATH = "/api/predict/config";
const PLACEHOLDER = "Leave empty to allow every app. One app name per line.";
const ENTITLEMENT_MIRRORS = new Set([
	"/api/preferences/entitlement-active",
	"/api/preferences/managed-inference-entitled",
]);
const SEEDED = {
	agentId: "writer-agent",
	appAllowlist: ["Notes"],
	debounceMs: 250,
	effort: "low",
	maxChars: 180,
	model: "local/predict-v1",
};

interface CoreCall {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

let stored: Record<string, unknown> = { ...SEEDED };
const calls: CoreCall[] = [];
const unexpected: string[] = [];
const refusals: number[] = [];

function validConfig(body: unknown): body is Record<string, unknown> {
	if (typeof body !== "object" || body === null) {
		return false;
	}
	const config = body as Record<string, unknown>;
	return (
		Array.isArray(config.appAllowlist) &&
		config.appAllowlist.every((app) => typeof app === "string") &&
		typeof config.debounceMs === "number" &&
		typeof config.maxChars === "number" &&
		typeof config.model === "string" &&
		typeof config.effort === "string"
	);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const path = url.pathname;
		if (
			request.headers.get("authorization") !== `Bearer ${NODE_TOKEN}` ||
			request.headers.get("x-ryu-user-jwt") !== USER_JWT
		) {
			unexpected.push(`${request.method} ${path} without node auth`);
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		const raw = request.method === "PUT" ? await request.text() : "";
		const call: CoreCall = {
			body: raw ? JSON.parse(raw) : null,
			method: request.method,
			path,
			status: 200,
		};
		calls.push(call);
		if (request.method === "PUT" && ENTITLEMENT_MIRRORS.has(path)) {
			return NativeResponse.json({ ok: true });
		}
		if (path === CONFIG_PATH) {
			if (request.method === "GET") {
				return NativeResponse.json(stored);
			}
			if (request.method === "PUT") {
				const refusal = refusals.shift();
				if (refusal !== undefined) {
					call.status = refusal;
					return NativeResponse.json(
						{ error: "Predict coverage refusal" },
						{ status: refusal }
					);
				}
				if (!validConfig(call.body)) {
					unexpected.push(`Invalid PredictConfig ${raw}`);
					call.status = 422;
					return NativeResponse.json({ error: "bad body" }, { status: 422 });
				}
				stored = { ...call.body };
				return NativeResponse.json(stored);
			}
		}
		if (request.method !== "GET") {
			unexpected.push(`Undeclared ${request.method} ${path}`);
			call.status = 405;
			return NativeResponse.json({ error: "undeclared" }, { status: 405 });
		}
		switch (path) {
			case "/api/agents":
				return NativeResponse.json({
					agents: [{ id: "writer-agent", name: "Writer", tools: [] }],
				});
			case "/api/pi-config/catalog":
				return NativeResponse.json({
					apiTypes: ["openai-completions"],
					providers: [],
					thinkingLevels: ["low", "medium", "high"],
				});
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
	},
});

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
const { PredictSettings } = await import("./PredictSettings.tsx");

const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(async () => {
	stored = { ...SEEDED };
	calls.length = 0;
	unexpected.length = 0;
	refusals.length = 0;
	localStorage.clear();
	localStorage.setItem("predict-coverage-unrelated", "kept");
	await act(async () => {
		queryClient.clear();
		sileo.clear();
	});
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "predict-coverage",
		nodes: [
			{
				name: "predict-coverage",
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
	expect(localStorage.getItem("predict-coverage-unrelated")).toBe("kept");
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
					<PredictSettings />
					<Toaster position="bottom-right" />
				</EntitlementProvider>
			</QueryClientProvider>
		)
	);
	await until(() => {
		const field = container.querySelector<HTMLTextAreaElement>(
			`textarea[placeholder="${PLACEHOLDER}"]`
		);
		return field !== null && !field.disabled;
	}, "Autocomplete settings load");
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

/** The "Allowed apps" field, found through its visible label. */
function allowedApps(): HTMLTextAreaElement {
	const label = [...container.querySelectorAll("label")].find(
		(candidate) => candidate.textContent?.trim() === "Allowed apps"
	);
	const field = label?.htmlFor
		? container.querySelector<HTMLTextAreaElement>(`#${label.htmlFor}`)
		: null;
	if (!field) {
		throw new Error("Missing labelled Allowed apps field");
	}
	return field;
}

async function type(element: HTMLTextAreaElement, value: string) {
	await act(async () => {
		element.focus();
	});
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	try {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value"
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	} finally {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	}
	await act(async () => {
		await Bun.sleep(0);
	});
}

/** Move focus off the field, as Tab or a click elsewhere does. */
async function leave(element: HTMLElement) {
	await act(async () => {
		element.blur();
	});
}

function configWrites() {
	return calls
		.filter((call) => call.method === "PUT" && call.path === CONFIG_PATH)
		.map((call) => ({ body: call.body, status: call.status }));
}

async function settledWrites(count: number) {
	await until(
		() => configWrites().length >= count && !allowedApps().disabled,
		`${count} config writes`
	);
}

test("a comma or newline list is saved as one app per line, keeps every other setting, and reloads", async () => {
	await mount();
	expect(allowedApps().value).toBe("Notes");
	expect(allowedApps().placeholder).toBe(PLACEHOLDER);

	await type(allowedApps(), "Chrome, Notes\n  Terminal ,\n\nnotepad.exe");
	expect(configWrites()).toEqual([]);
	await leave(allowedApps());
	await settledWrites(1);
	const expected = {
		...SEEDED,
		appAllowlist: ["Chrome", "Notes", "Terminal", "notepad.exe"],
	};
	expect(configWrites()).toEqual([{ body: expected, status: 200 }]);
	expect(stored).toEqual(expected);
	expect(allowedApps().value).toBe("Chrome\nNotes\nTerminal\nnotepad.exe");
	await until(
		() =>
			document.body.textContent?.includes("Autocomplete settings saved") ===
			true,
		"saved toast"
	);

	await remount();
	expect(allowedApps().value).toBe("Chrome\nNotes\nTerminal\nnotepad.exe");
	const debounce =
		container.querySelector<HTMLInputElement>("#predict-debounce");
	expect(debounce?.value).toBe("250");
});

test("clearing the list saves an empty allowlist, which allows every app", async () => {
	await mount();
	await type(allowedApps(), " \n , \n");
	await leave(allowedApps());
	await settledWrites(1);
	expect(configWrites()).toEqual([
		{ body: { ...SEEDED, appAllowlist: [] }, status: 200 },
	]);
	expect(allowedApps().value).toBe("");

	await remount();
	expect(allowedApps().value).toBe("");
	expect(allowedApps().placeholder).toBe(PLACEHOLDER);
});

test("a refused allowlist save restores the saved list, explains it, and Retry persists the same list", async () => {
	await mount();
	refusals.push(503);
	await type(allowedApps(), "Mail\nCalendar");
	await leave(allowedApps());
	await until(
		() =>
			container.textContent?.includes(
				"We couldn't save autocomplete settings. Your saved settings are still active."
			) === true,
		"save failure alert"
	);
	await until(() => !allowedApps().disabled, "fields unlocked");
	expect(allowedApps().value).toBe("Notes");
	expect(stored).toEqual(SEEDED);

	const retry = [...container.querySelectorAll('[role="alert"] button')].find(
		(button) => button.textContent?.trim() === "Retry"
	);
	if (!(retry instanceof HTMLElement)) {
		throw new Error("Missing Retry in the save alert");
	}
	await act(async () => retry.click());
	await settledWrites(2);
	const expected = { ...SEEDED, appAllowlist: ["Mail", "Calendar"] };
	expect(configWrites()).toEqual([
		{ body: expected, status: 503 },
		{ body: expected, status: 200 },
	]);
	expect(allowedApps().value).toBe("Mail\nCalendar");
	expect(container.querySelector('[role="alert"]')).toBeNull();

	await remount();
	expect(allowedApps().value).toBe("Mail\nCalendar");
});
