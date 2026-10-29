import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping Agent models settings exactly as the Providers page wires
// it (the real useLlmProviders catalog and model-enabled writer), next to a
// consumer that reads the SAME Pi catalog through the real usePiConfig hook and
// filters an agent's advertised models with the shipping filterEnabledModels,
// as the composer's model picker does. Every Core call is a genuine HTTP
// exchange with an owned native peer that persists the overrides it accepts.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Object.assign(globalThis, { Response: NativeResponse, fetch: nativeFetch });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Call {
	body: unknown;
	method: string;
	path: string;
	status: number;
}
const advertised = [
	{ modelId: "gpt-a", name: "GPT A" },
	{ modelId: "gpt-b", name: "GPT B" },
];
const calls: Call[] = [];
const unknown: string[] = [];
const runtimeErrors: string[] = [];
const refuse = new Set<string>();
let overrides: Record<string, Record<string, boolean>> = {};
let pending = 0;

function catalog() {
	return {
		apiTypes: ["openai-completions"],
		providers: [],
		thinkingLevels: [],
		agentModelOverrides: structuredClone(overrides),
	};
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		pending += 1;
		try {
			const url = new URL(request.url);
			const raw = await request.text();
			const call: Call = {
				method: request.method,
				path: `${url.pathname}${url.search}`,
				body: raw === "" ? null : JSON.parse(raw),
				status: 0,
			};
			calls.push(call);
			const reply = (body: unknown, status = 200) => {
				call.status = status;
				return NativeResponse.json(body, { status });
			};
			if (
				request.headers.get("authorization") !== "Bearer agent-models-token" ||
				request.headers.get("x-ryu-user-jwt") !== "agent-models-jwt"
			) {
				unknown.push(`${call.method} ${call.path}: wrong authority`);
				return reply({ error: "Wrong authority" }, 403);
			}
			const key = `${call.method} ${call.path}`;
			if (refuse.delete(key)) {
				return reply({ error: "Owned agent model store unavailable" }, 503);
			}
			if (key === "GET /api/agents") {
				return reply({
					agents: [
						{ id: "ryu", name: "Ryu" },
						{ id: "codex", name: "Codex", engine: "codex" },
					],
				});
			}
			if (key === "GET /api/agents/codex/acp-config") {
				return reply({
					configOptions: null,
					modes: null,
					models: { availableModels: advertised, currentModelId: "gpt-a" },
				});
			}
			if (key === "GET /api/pi-config") {
				return reply({
					config: {
						configDir: "/srv/pi",
						model: null,
						provider: "gateway",
						routing: "gateway",
						thinkingLevel: null,
					},
				});
			}
			if (key === "GET /api/pi-config/catalog") {
				return reply(catalog());
			}
			const body = call.body as {
				enabled?: unknown;
				model?: unknown;
				provider?: unknown;
			} | null;
			if (
				key === "POST /api/pi-config/providers/model-enabled" &&
				body &&
				Object.keys(body).sort().join("|") === "enabled|model|provider" &&
				body.provider === "agent:codex" &&
				typeof body.model === "string" &&
				typeof body.enabled === "boolean"
			) {
				overrides = {
					...overrides,
					codex: { ...overrides.codex, [body.model]: body.enabled },
				};
				return reply(catalog());
			}
			unknown.push(key);
			return reply({ error: "Undeclared agent model contract" }, 404);
		} finally {
			pending -= 1;
		}
	},
});

const { act, createElement, Fragment } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { sileo } = await import("sileo");
const { useNodeStore, LOCAL_FALLBACK } = await import(
	"@/src/store/useNodeStore.ts"
);
const { useLlmProviders } = await import("@/src/hooks/useLlmProviders.ts");
const { usePiConfig } = await import("@/src/hooks/usePiConfig.ts");
const { filterEnabledModels } = await import("@/src/lib/api/pi-config.ts");
const { AgentModelsSettings } = await import("./AgentModelsSettings.tsx");

const previousNodes = useNodeStore.getState();
let client: InstanceType<typeof QueryClient>;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));

// The Providers page passes the shared catalog's overrides and its writer.
function ProvidersAgentModels() {
	const { catalog, loading, error, toggleModelEnabled } = useLlmProviders();
	if (loading || error) {
		return null;
	}
	return createElement(AgentModelsSettings, {
		agentModelOverrides: catalog?.agentModelOverrides,
		onToggleModel: async (
			provider: string,
			model: string,
			enabled: boolean
		) => {
			await toggleModelEnabled(provider, model, enabled);
		},
	});
}
// The composer reads the same catalog and filters Codex's advertised models.
function ComposerCatalogConsumer() {
	const { catalog } = usePiConfig();
	const visible = filterEnabledModels(
		advertised.map((model) => ({ id: model.modelId, name: model.name })),
		catalog?.agentModelOverrides?.codex,
		"gpt-a"
	);
	return createElement(
		"ul",
		{ "data-composer-consumer": "" },
		...visible.map((model) => createElement("li", { key: model.id }, model.id))
	);
}

async function until(predicate: () => boolean, reason: string) {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(reason);
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root!.render(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(
					Fragment,
					null,
					createElement(ProvidersAgentModels),
					createElement(ComposerCatalogConsumer)
				)
			)
		)
	);
}
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
}
function composerModels() {
	return [
		...(container?.querySelectorAll("[data-composer-consumer] li") ?? []),
	].map((item) => item.textContent);
}
function modelSwitch(name: string) {
	const found = container?.querySelector<HTMLElement>(
		`[aria-label="Show ${name} in Codex's model picker"]`
	);
	if (!found) {
		throw new Error(`Missing actual switch for ${name}`);
	}
	return found;
}
function checked(element: HTMLElement) {
	return element.getAttribute("aria-checked") === "true";
}
function callsFor(method: string, path: string) {
	return calls.filter((call) => call.method === method && call.path === path);
}

beforeEach(async () => {
	overrides = {};
	calls.length = 0;
	unknown.length = 0;
	runtimeErrors.length = 0;
	refuse.clear();
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	errorToast = spyOn(sileo, "error");
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
	const node = {
		...LOCAL_FALLBACK,
		name: "agent-models",
		url: server.url.toString().replace(/\/$/, ""),
		token: "agent-models-token",
		userJwt: "agent-models-jwt",
	};
	await act(async () => {
		useNodeStore.setState({
			defaultNode: node.name,
			nodes: [node],
			localNodes: [node],
			cloudNodes: [],
			autoSelect: false,
			autoSelectedNode: null,
			tabOverrides: {},
		});
	});
});
afterEach(async () => {
	await unmount();
	client.clear();
	errorToast.mockRestore();
	window.removeEventListener("error", onError);
	window.removeEventListener("unhandledrejection", onRejection);
	// Per-case closure: no in-flight exchange, undeclared request or renderer error.
	const violations = [
		pending === 0 ? null : `${pending} native exchanges still pending`,
		unknown.length === 0 ? null : `undeclared requests: ${unknown.join("; ")}`,
		runtimeErrors.length === 0
			? null
			: `runtime errors: ${runtimeErrors.join("; ")}`,
	].filter((violation) => violation !== null);
	if (violations.length > 0) {
		throw new Error(
			`Agent models case closure failed: ${violations.join(" | ")}`
		);
	}
});
afterAll(async () => {
	useNodeStore.setState(previousNodes);
	await server.stop(true);
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("an agent model toggle probes lazily, survives a refused write, and publishes the acknowledged override to the composer catalog and a fresh mount", async () => {
	await mount();
	await until(
		() =>
			container?.textContent?.includes("Codex") === true &&
			composerModels().length === 2,
		"Agent list and shared catalog did not load"
	);
	// The flagship is never offered here, and expanding is what spawns a probe.
	const disclosures = [...(container?.querySelectorAll("button") ?? [])].map(
		(button) => button.textContent ?? ""
	);
	expect(disclosures.filter((label) => label.startsWith("Codex"))).toHaveLength(
		1
	);
	expect(disclosures.some((label) => label.startsWith("Ryu"))).toBe(false);
	expect(container?.textContent).toContain("All models visible");
	expect(callsFor("GET", "/api/agents")).toHaveLength(1);
	expect(callsFor("GET", "/api/agents/codex/acp-config")).toEqual([]);
	const trigger = [...(container?.querySelectorAll("button") ?? [])].find(
		(button) => button.textContent?.includes("Codex")
	);
	if (!trigger) {
		throw new Error("Missing actual Codex disclosure");
	}
	await act(async () => trigger.click());
	await until(
		() => container?.textContent?.includes("GPT B") === true,
		"Codex models were not probed"
	);
	expect(callsFor("GET", "/api/agents/codex/acp-config")).toHaveLength(1);
	expect(checked(modelSwitch("GPT A"))).toBe(true);
	expect(checked(modelSwitch("GPT B"))).toBe(true);
	const catalogReads = callsFor("GET", "/api/pi-config/catalog").length;
	// A refused write keeps the model visible everywhere and explains why.
	refuse.add("POST /api/pi-config/providers/model-enabled");
	await act(async () => modelSwitch("GPT B").click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"Refused toggle did not surface an error"
	);
	expect(errorToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Could not update model",
	});
	expect(String(errorToast.mock.calls[0]?.[0]?.description)).toContain("503");
	await until(
		() =>
			modelSwitch("GPT B").getAttribute("aria-disabled") !== "true" &&
			!modelSwitch("GPT B").hasAttribute("data-disabled"),
		"Refused switch stayed locked"
	);
	expect(checked(modelSwitch("GPT B"))).toBe(true);
	expect(container?.textContent).toContain("All models visible");
	expect(composerModels()).toEqual(["gpt-a", "gpt-b"]);
	expect(overrides).toEqual({});
	// The explicit retry is acknowledged and its returned catalog is consumed.
	await act(async () => modelSwitch("GPT B").click());
	await until(
		() => !checked(modelSwitch("GPT B")),
		"Acknowledged toggle did not hide GPT B"
	);
	const writes = callsFor("POST", "/api/pi-config/providers/model-enabled");
	expect(writes.map((call) => [call.body, call.status])).toEqual([
		[{ provider: "agent:codex", model: "gpt-b", enabled: false }, 503],
		[{ provider: "agent:codex", model: "gpt-b", enabled: false }, 200],
	]);
	expect(overrides).toEqual({ codex: { "gpt-b": false } });
	expect(container?.textContent).toContain("1 model hidden");
	await until(
		() => composerModels().join("|") === "gpt-a",
		"Composer catalog still offered GPT B"
	);
	expect(checked(modelSwitch("GPT A"))).toBe(true);
	expect(callsFor("GET", "/api/pi-config/catalog").length).toBe(catalogReads);
	expect(errorToast).toHaveBeenCalledTimes(1);
	// An independent mount reads the persisted override from the node.
	await unmount();
	client.clear();
	const beforeRemount = calls.length;
	await mount();
	await until(
		() =>
			composerModels().join("|") === "gpt-a" &&
			container?.textContent?.includes("Codex") === true,
		"Fresh mount did not read the persisted override"
	);
	// The collapsed card reports the persisted override without spawning the
	// agent's probe; it must not claim every model is visible.
	expect(callsFor("GET", "/api/agents/codex/acp-config")).toHaveLength(1);
	expect(container?.textContent).not.toContain("All models visible");
	expect(container?.textContent).toContain("1 model hidden");
	expect(callsFor("GET", "/api/pi-config/catalog").length).toBeGreaterThan(
		catalogReads
	);
	expect(
		calls.slice(beforeRemount).some((call) => call.method === "POST")
	).toBe(false);
	// Teardown releases every observer; invalidation after unmount fetches nothing.
	await unmount();
	const afterUnmount = calls.length;
	await act(async () => {
		await client.invalidateQueries();
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(calls.length).toBe(afterUnmount);
	expect(
		client
			.getQueryCache()
			.getAll()
			.every((query) => query.getObserversCount() === 0)
	).toBe(true);
});
