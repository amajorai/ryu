// "Add provider" on the custom provider page: the list comes back with the
// new provider's row focused. The save resolves before the catalog reaches
// React (the query cache tells its observers a tick later), so the list is on
// screen one render ahead of the new row. These tests mount the real surface
// with the real hook against an in-memory copy of Core's routes.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Node } from "@/src/store/useNodeStore.ts";

const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { MemoryRouter } = await import("react-router-dom");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { clearSettingReveal } = await import("@/src/lib/settings-focus.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { LlmProvidersSettings } = await import("../LlmProvidersSettings.tsx");

const node: Node = {
	name: "provider-add-proof",
	url: "https://provider-add.fixture:7980",
	token: "provider-add-token",
	userJwt: null,
};

function provider(id: string, label: string, extra: object = {}) {
	return {
		api: "openai-completions",
		authEnv: "",
		authKind: "api-key",
		configured: false,
		custom: false,
		id,
		label,
		routing: "gateway",
		suggestedModels: [],
		supportsDiscovery: false,
		supportsOAuth: false,
		...extra,
	};
}

interface Call {
	body: unknown;
	method: string;
	path: string;
}
const originalFetch = globalThis.fetch;
const originalNodes = useNodeStore.getState();
const roots: Root[] = [];
let calls: Call[] = [];
/** The providers Core lists. */
let listed: ReturnType<typeof provider>[] = [];
/** False: the answer to a save does not list the new provider yet. */
let saveListsProvider = true;
let client: InstanceType<typeof QueryClient>;

function catalog() {
	return {
		apiTypes: ["openai-completions"],
		providers: listed,
		thinkingLevels: ["off"],
	};
}

function respond(call: Call): Response {
	if (call.path === "/api/pi-config/catalog") {
		return NativeResponse.json(catalog());
	}
	if (call.path === "/api/pi-config" && call.method === "GET") {
		return NativeResponse.json({
			config: {
				configDir: "/tmp/pi",
				model: null,
				provider: "openai",
				routing: "gateway",
				thinkingLevel: null,
			},
		});
	}
	if (call.path === "/api/pi-config/providers" && call.method === "POST") {
		const id = String((call.body as { provider: string }).provider);
		const before = catalog();
		listed = [...listed, provider(id, id, { configured: true, custom: true })];
		return NativeResponse.json(saveListsProvider ? catalog() : before);
	}
	return NativeResponse.json({ error: "undeclared" }, { status: 404 });
}

beforeEach(() => {
	calls = [];
	saveListsProvider = true;
	listed = [
		provider("openai", "OpenAI", { configured: true }),
		provider("groq", "Groq"),
	];
	localStorage.clear();
	clearSettingReveal();
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: node.name,
		nodes: [node],
	});
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const call: Call = {
				body: init?.body ? JSON.parse(String(init.body)) : null,
				method: init?.method ?? "GET",
				path: url.pathname,
			};
			calls.push(call);
			return await Promise.resolve(respond(call));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	clearSettingReveal();
	globalThis.fetch = originalFetch;
	useNodeStore.setState(originalNodes);
});

async function settle(ms = 20) {
	await act(async () => {
		await Bun.sleep(ms);
	});
}

async function until(predicate: () => boolean, reason: string) {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (predicate()) {
			return;
		}
		await settle(10);
	}
	throw new Error(`${reason}: ${document.body.textContent}`);
}

function one<T extends HTMLElement = HTMLElement>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (!element) {
		throw new Error(`Missing ${selector}: ${document.body.textContent}`);
	}
	return element;
}

const row = (rowId: string) => one(`[data-provider-page-row="${rowId}"]`);
const searchField = () => one<HTMLInputElement>('input[type="search"]');

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	client = new QueryClient({
		defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<EntitlementProvider>
						<LlmProvidersSettings />
					</EntitlementProvider>
				</MemoryRouter>
			</QueryClientProvider>
		)
	);
	await until(
		() => document.querySelector("[data-provider-list]") !== null,
		"provider settings never loaded"
	);
}

async function type(selector: string, value: string) {
	const field = one<HTMLInputElement>(selector);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** Open the custom provider page, fill the form and press "Add provider". */
async function addProvider(id: string) {
	await act(async () => row("custom-provider").click());
	await until(
		() => document.querySelector("#custom-id") !== null,
		"the custom provider page never opened"
	);
	await type("#custom-id", id);
	await type("#custom-url", "http://127.0.0.1:11434/v1");
	const add = Array.from(document.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === "Add provider"
	);
	if (!add) {
		throw new Error("Missing Add provider");
	}
	// As a click does in a browser: the pressed button holds the focus.
	add.focus();
	await act(async () => add.click());
	await until(
		() => document.querySelector("[data-provider-list]") !== null,
		"the list never came back"
	);
}

/** Core's catalog is read again, as after any later change on the node. */
async function readCatalogAgain() {
	await act(async () => {
		await client.invalidateQueries({ queryKey: ["pi-config-catalog"] });
	});
	await settle();
}

test("after Add provider the list comes back on the new provider's row", async () => {
	await mount();
	await addProvider("local-llama");
	await until(
		() =>
			document.querySelector(
				'[data-provider-page-row="provider:local-llama"]'
			) !== null,
		"the new provider never joined the list"
	);
	await settle();
	expect(
		calls.filter((call) => call.method === "POST").map((call) => call.body)
	).toEqual([
		{
			api: "openai-completions",
			apiKey: null,
			baseUrl: "http://127.0.0.1:11434/v1",
			provider: "local-llama",
		},
	]);
	expect(document.activeElement).toBe(row("provider:local-llama"));
});

test("a new provider that is listed later takes the focus from the search field, where it waited", async () => {
	saveListsProvider = false;
	await mount();
	await addProvider("late-llama");
	await settle();
	// Not in the catalog React has: the focus is on the list, never on the body.
	expect(
		document.querySelector('[data-provider-page-row="provider:late-llama"]')
	).toBeNull();
	expect(document.activeElement).toBe(searchField());

	await readCatalogAgain();
	expect(document.activeElement).toBe(row("provider:late-llama"));

	// The debt is paid once: a later read of the catalog moves nothing.
	row("provider:groq").focus();
	await readCatalogAgain();
	expect(document.activeElement).toBe(row("provider:groq"));
});

test("focus that the user moved while the new row was on its way stays where they put it", async () => {
	saveListsProvider = false;
	await mount();
	await addProvider("late-llama");
	await settle();
	expect(document.activeElement).toBe(searchField());
	row("provider:groq").focus();

	await readCatalogAgain();
	expect(
		document.querySelector('[data-provider-page-row="provider:late-llama"]')
	).not.toBeNull();
	expect(document.activeElement).toBe(row("provider:groq"));
});

test("typing in the search field ends the wait for the new row", async () => {
	saveListsProvider = false;
	await mount();
	await addProvider("late-llama");
	await settle();
	expect(document.activeElement).toBe(searchField());
	await type('input[type="search"]', "l");

	await readCatalogAgain();
	expect(
		document.querySelector('[data-provider-page-row="provider:late-llama"]')
	).not.toBeNull();
	expect(document.activeElement).toBe(searchField());
	expect(searchField().value).toBe("l");
});
