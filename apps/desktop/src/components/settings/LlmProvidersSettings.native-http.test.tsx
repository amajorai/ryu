import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Node } from "@/src/store/useNodeStore.ts";

// The SSE login stream is read with Bun's own Response/ReadableStream, so keep
// the native classes across DOM registration.
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
const { sileo } = await import("sileo");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { LlmProvidersSettings } = await import("./LlmProvidersSettings.tsx");

const node: Node = {
	name: "llm-providers-proof",
	url: "https://providers.fixture:7980",
	token: "providers-token",
	userJwt: null,
};

interface ProviderFixture {
	api: string;
	authEnv: string;
	authKind: string;
	configured: boolean;
	custom: boolean;
	id: string;
	label: string;
	routing: string;
	suggestedModels: string[];
	supportsDiscovery?: boolean;
	supportsOAuth?: boolean;
}
function apiKeyProvider(
	id: string,
	label: string,
	configured: boolean
): ProviderFixture {
	return {
		id,
		label,
		api: "openai-completions",
		authKind: "api-key",
		authEnv: `${id.toUpperCase()}_API_KEY`,
		routing: "gateway",
		configured,
		custom: false,
		suggestedModels: [],
		supportsDiscovery: false,
		supportsOAuth: false,
	};
}
const chatgptPlan: ProviderFixture = {
	id: "chatgpt-plan",
	label: "ChatGPT (plan)",
	api: "openai-responses",
	authKind: "subscription",
	authEnv: "",
	routing: "direct",
	configured: false,
	custom: false,
	suggestedModels: [],
	supportsDiscovery: false,
	supportsOAuth: true,
};

interface Call {
	body: unknown;
	method: string;
	path: string;
}
const originalFetch = globalThis.fetch;
const originalNodes = useNodeStore.getState();
const roots: Root[] = [];
let calls: Call[] = [];
let providers: ProviderFixture[] = [];
let createStatus = 200;
let routingStatus = 200;
let loginAccountId = "acct-1";
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;

function catalog() {
	return {
		providers,
		thinkingLevels: ["off"],
		apiTypes: ["openai-completions", "anthropic-messages"],
	};
}

function sse(events: unknown[]): Response {
	const body = events
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new NativeResponse(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

function respond(call: Call): Response {
	if (call.path === "/api/pi-config/catalog") {
		return NativeResponse.json(catalog());
	}
	if (call.path === "/api/pi-config" && call.method === "GET") {
		return NativeResponse.json({
			config: {
				provider: "gateway",
				model: null,
				thinkingLevel: null,
				routing: "gateway",
				configDir: "/tmp/pi",
			},
		});
	}
	if (call.path === "/api/pi-config/providers" && call.method === "POST") {
		const update = call.body as { provider: string; routing?: string };
		if (update.routing !== undefined) {
			if (routingStatus !== 200) {
				return NativeResponse.json(
					{ error: "routing is locked" },
					{ status: routingStatus }
				);
			}
			providers = providers.map((provider) =>
				provider.id === update.provider
					? { ...provider, routing: update.routing ?? provider.routing }
					: provider
			);
			return NativeResponse.json(catalog());
		}
		if (createStatus !== 200) {
			return NativeResponse.json(
				{ error: "base url unreachable" },
				{ status: createStatus }
			);
		}
		const input = call.body as { provider: string };
		providers = [
			...providers,
			{
				...apiKeyProvider(input.provider, input.provider, true),
				custom: true,
			},
		];
		return NativeResponse.json(catalog());
	}
	if (
		call.path === "/api/pi-config/providers/chatgpt-plan/login" &&
		call.method === "POST"
	) {
		return NativeResponse.json({ sessionId: "login-1" });
	}
	if (call.path === "/api/pi-config/login/login-1/events") {
		return sse([
			{
				type: "success",
				provider: "chatgpt-plan",
				accountId: loginAccountId,
				planUseAuthorized: true,
			},
		]);
	}
	if (call.path === "/api/pi-config/login/login-1/cancel") {
		return NativeResponse.json({ ok: true });
	}
	return NativeResponse.json({ error: "undeclared" }, { status: 404 });
}

beforeEach(() => {
	calls = [];
	providers = [];
	createStatus = 200;
	routingStatus = 200;
	loginAccountId = "acct-1";
	localStorage.clear();
	useNodeStore.setState({
		nodes: [node],
		defaultNode: node.name,
		autoSelect: false,
	});
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const call: Call = {
				path: url.pathname,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(call);
			return await Promise.resolve(respond(call));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await unmountAll();
	errorToast.mockRestore();
	successToast.mockRestore();
	globalThis.fetch = originalFetch;
	useNodeStore.setState(originalNodes);
});

async function unmountAll() {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
}

async function settle(ms = 20) {
	await act(async () => {
		await Bun.sleep(ms);
	});
}

async function until(predicate: () => boolean, reason: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await settle(10);
	}
	throw new Error(reason);
}

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
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
		() => document.querySelector("#custom-id") !== null,
		"providers page never loaded"
	);
}

function input(selector: string): HTMLInputElement {
	const element = document.querySelector<HTMLInputElement>(selector);
	if (!element) {
		throw new Error(`Missing ${selector}`);
	}
	return element;
}

async function type(selector: string, value: string) {
	const element = input(selector);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function button(name: string, scope: ParentNode = document): HTMLButtonElement {
	const match = Array.from(scope.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === name
	);
	if (!match) {
		throw new Error(`Missing button ${name}`);
	}
	return match;
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
	await settle();
}

function creates(): Call[] {
	return calls.filter(
		(call) => call.path === "/api/pi-config/providers" && call.method === "POST"
	);
}

function titles(spy: { mock: { calls: unknown[][] } }): unknown[] {
	return spy.mock.calls.map((args) =>
		typeof args[0] === "object" && args[0] !== null
			? Reflect.get(args[0], "title")
			: args[0]
	);
}

function sectionLabels(headingId: string): string[] {
	const section = document
		.getElementById(headingId)
		?.closest<HTMLElement>("section");
	if (!section) {
		throw new Error(`Missing section ${headingId}`);
	}
	return Array.from(
		section.querySelectorAll<HTMLElement>('[data-slot="provider-label"]')
	).map((label) => label.textContent ?? "");
}

test("configured API-key providers are listed before unconfigured ones", async () => {
	providers = [
		apiKeyProvider("zeta", "Zeta AI", false),
		apiKeyProvider("alpha", "Alpha AI", true),
		apiKeyProvider("mid", "Mid AI", false),
		apiKeyProvider("beta", "Beta AI", true),
	];
	await mount();

	expect(sectionLabels("api-key-provider-heading")).toEqual([
		"Alpha AI",
		"Beta AI",
		"Zeta AI",
		"Mid AI",
	]);
});

test("the custom provider form requires an id and base URL, and a key requires the spend-limit confirmation", async () => {
	await mount();
	const add = () => button("Add provider");
	expect(add().disabled).toBe(true);

	await type("#custom-id", "  ollama  ");
	expect(add().disabled).toBe(true);
	await type("#custom-url", "   ");
	expect(add().disabled).toBe(true);
	await type("#custom-url", " http://localhost:11434/v1 ");
	expect(add().disabled).toBe(false);

	await type("#custom-key", "sk-local");
	expect(add().disabled).toBe(true);
	const confirm = document.querySelector<HTMLElement>("#custom-key-limit");
	if (!confirm) {
		throw new Error("Missing spend-limit confirmation");
	}
	await click(confirm);
	expect(add().disabled).toBe(false);

	await click(add());
	await until(() => successToast.mock.calls.length > 0, "create never settled");

	expect(creates().map((call) => call.body)).toEqual([
		{
			provider: "ollama",
			baseUrl: "http://localhost:11434/v1",
			apiKey: "sk-local",
			api: "openai-completions",
		},
	]);
	expect(titles(successToast)).toContain("Custom provider added");
	expect(input("#custom-id").value).toBe("");
	expect(input("#custom-url").value).toBe("");
	expect(add().disabled).toBe(true);
	await until(
		() => sectionLabels("api-key-provider-heading").includes("ollama"),
		"created provider never joined the list"
	);
});

test("a rejected custom provider keeps the form and reports Core's error", async () => {
	createStatus = 400;
	await mount();
	await type("#custom-id", "vllm");
	await type("#custom-url", "http://localhost:8000/v1");
	await click(button("Add provider"));
	await until(() => errorToast.mock.calls.length > 0, "error never reported");

	expect(creates()).toHaveLength(1);
	expect(titles(errorToast)).toEqual(["Could not add provider"]);
	expect(
		Reflect.get(new Object(errorToast.mock.calls[0]?.[0]), "description")
	).toBe("base url unreachable");
	expect(successToast.mock.calls.map((args) => args[0])).not.toContainEqual(
		expect.objectContaining({ title: "Custom provider added" })
	);
	expect(input("#custom-id").value).toBe("vllm");
	expect(input("#custom-url").value).toBe("http://localhost:8000/v1");
});

/** Run one ChatGPT plan login to its `success` event. */
async function connectChatgptPlan() {
	const connected = () =>
		titles(successToast).filter((title) => title === "Connected ChatGPT")
			.length;
	const before = connected();
	await click(button("Continue with ChatGPT"));
	await until(() => connected() > before, "login never succeeded");
	await settle();
}

function welcomeShown(): boolean {
	return (
		document.body.textContent?.includes("Your ChatGPT plan is connected") ===
		true
	);
}

test("the ChatGPT plan welcome is shown once per account and remembered across remounts", async () => {
	providers = [chatgptPlan];
	await mount();
	const trigger = Array.from(
		document.querySelectorAll<HTMLElement>("button")
	).find((candidate) => candidate.textContent?.includes("ChatGPT (plan)"));
	if (!trigger) {
		throw new Error("Missing ChatGPT plan card");
	}
	await click(trigger);

	await connectChatgptPlan();
	expect(welcomeShown()).toBe(true);
	expect(localStorage.getItem("ryu-chatgpt-plan-welcome:acct-1")).toBe("true");
	await click(button("Got it"));
	expect(welcomeShown()).toBe(false);

	await unmountAll();
	await mount();
	const again = Array.from(
		document.querySelectorAll<HTMLElement>("button")
	).find((candidate) => candidate.textContent?.includes("ChatGPT (plan)"));
	if (!again) {
		throw new Error("Missing ChatGPT plan card after remount");
	}
	await click(again);
	await connectChatgptPlan();
	expect(welcomeShown()).toBe(false);

	loginAccountId = "acct-2";
	await connectChatgptPlan();
	expect(welcomeShown()).toBe(true);
	expect(localStorage.getItem("ryu-chatgpt-plan-welcome:acct-2")).toBe("true");
});

function routingSwitch(providerId: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(
		`[role="switch"][aria-labelledby="routing-${providerId}-label"]`
	);
	if (!element) {
		throw new Error(`Missing routing switch for ${providerId}`);
	}
	return element;
}

test("the Gateway routing switch saves direct egress, and a rejected change reverts it", async () => {
	providers = [apiKeyProvider("alpha", "Alpha AI", true)];
	await mount();
	const card = Array.from(
		document.querySelectorAll<HTMLElement>("button")
	).find((candidate) => candidate.textContent?.includes("Alpha AI"));
	if (!card) {
		throw new Error("Missing Alpha AI card");
	}
	await click(card);
	expect(routingSwitch("alpha").getAttribute("aria-checked")).toBe("true");

	await click(routingSwitch("alpha"));
	await until(() => successToast.mock.calls.length > 0, "routing never saved");
	expect(creates().map((call) => call.body)).toEqual([
		{ provider: "alpha", routing: "direct" },
	]);
	expect(titles(successToast)).toEqual(["Alpha AI egress is direct"]);
	expect(providers[0]?.routing).toBe("direct");
	expect(routingSwitch("alpha").getAttribute("aria-checked")).toBe("false");

	routingStatus = 409;
	await click(routingSwitch("alpha"));
	await until(() => errorToast.mock.calls.length > 0, "error never reported");
	expect(creates().at(-1)?.body).toEqual({
		provider: "alpha",
		routing: "gateway",
	});
	expect(titles(errorToast)).toEqual(["Could not update routing"]);
	expect(providers[0]?.routing).toBe("direct");
	expect(routingSwitch("alpha").getAttribute("aria-checked")).toBe("false");
});
