import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Run this file in its own Bun process: its browser globals and external-host
// fixtures must not replace the contracts of another test file.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { create } = await import("zustand");
const node = {
	name: "Managed Bot",
	url: "https://bot-node.test",
	token: "node-admission",
	managed: true,
};
const entitlement = { managedInference: true };
const cloudNodes: (typeof node)[] = [];
const nodeStore = create<{
	cloudNodes: (typeof node)[];
	nodes: (typeof node)[];
	defaultNode: string;
	getActiveNode: () => typeof node;
	hydrateCloudNodes: () => Promise<void>;
}>(() => ({
	cloudNodes,
	nodes: [],
	defaultNode: "",
	getActiveNode: (): typeof node =>
		nodeStore
			.getState()
			.nodes.find(
				(candidate: typeof node) =>
					candidate.name === nodeStore.getState().defaultNode
			) ?? node,
	hydrateCloudNodes: async () => {
		nodeStore.setState({ cloudNodes: [node] });
	},
}));
mock.module("@/src/store/useNodeStore.ts", () => ({ useNodeStore: nodeStore }));
mock.module("@/src/hooks/useCreditsWallet.ts", () => ({
	useCreditsWallet: () => ({
		entitlement,
		loading: false,
		refresh: async () => undefined,
	}),
}));
mock.module("@/src/components/layout/Layout.tsx", () => ({
	default: () =>
		createElement(
			"main",
			{ "data-testid": "bot-ready-chat" },
			"Managed chat ready"
		),
}));
mock.module("@/lib/auth-client.ts", () => ({
	TOKEN_KEY: "bot-proof-account-token",
	getActiveToken: () =>
		globalThis.localStorage?.getItem("bot-proof-account-token") ?? null,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: async () => null,
}));
mock.module("@/lib/tauri-bridge.ts", () => ({
	openExternal: async () => undefined,
}));

const { BotManagedEntry } = await import("./BotManagedEntry.tsx");
const {
	defaultCloudAgentSelection,
	EMPTY_AGENT_SELECTION,
	agentLanePreferenceKey,
} = await import("@/src/lib/api/preferences.ts");
const preferencePath = `/api/preferences/${agentLanePreferenceKey("cloud")}`;
const originalFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let stored: string | null;
let acknowledgeWithoutPersistence: boolean;
let readUnavailable: boolean;
let holdReadback: Promise<void> | null;
let calls: {
	method: string;
	origin: string;
	path: string;
	body: unknown;
	auth: string | null;
}[];

async function settle() {
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});
}
async function waitFor(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
		await settle();
	}
	if (!predicate()) {
		throw new Error("Bot entry condition did not settle");
	}
}
beforeEach(() => {
	stored = null;
	acknowledgeWithoutPersistence = true;
	readUnavailable = false;
	holdReadback = null;
	entitlement.managedInference = true;
	calls = [];
	nodeStore.setState({ cloudNodes: [], nodes: [], defaultNode: "" });
	const fixtureFetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			const body: unknown =
				request.method === "GET" ? null : await request.json();
			const auth = request.headers.get("authorization");
			calls.push({
				method: request.method,
				origin: url.origin,
				path: url.pathname,
				body,
				auth,
			});
			if (
				url.origin !== node.url ||
				url.pathname !== preferencePath ||
				auth !== "Bearer node-admission" ||
				!["GET", "PUT"].includes(request.method)
			) {
				throw new Error("Unexpected Bot preference request");
			}
			if (request.method === "GET") {
				if (holdReadback && calls.some((call) => call.method === "PUT")) {
					await holdReadback;
				}
				if (readUnavailable) {
					return Response.json(
						{ error: "Read temporarily unavailable" },
						{ status: 503 }
					);
				}
				return Response.json(
					stored === null
						? { error: "unset" }
						: { key: agentLanePreferenceKey("cloud"), value: stored },
					{ status: stored === null ? 404 : 200 }
				);
			}
			if (
				JSON.stringify(body) !==
				JSON.stringify({
					value: JSON.stringify(defaultCloudAgentSelection(true)),
				})
			) {
				throw new Error("Unexpected Bot seed payload");
			}
			if (!acknowledgeWithoutPersistence) {
				stored = JSON.stringify(defaultCloudAgentSelection(true));
			}
			return Response.json({ ok: true });
		}
	);
	globalThis.fetch = Object.assign(fixtureFetch, {
		preconnect: originalFetch.preconnect,
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	globalThis.fetch = originalFetch;
});

test("acknowledged but unpersisted Auto cloud seed stays out of chat and retries through exact readback", async () => {
	await act(async () => root.render(createElement(BotManagedEntry)));
	await waitFor(() => calls.length >= 2);
	await settle();
	expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]);
	expect(stored).toBeNull();
	expect(container.querySelector('[data-testid="bot-ready-chat"]')).toBeNull();
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"Couldn't confirm your managed workspace"
	);
	const retry = container.querySelector<HTMLButtonElement>(
		'[data-testid="bot-retry"]'
	);
	expect(retry).not.toBeNull();
	expect(retry?.disabled).toBe(false);
	acknowledgeWithoutPersistence = false;
	await act(async () => retry?.click());
	await waitFor(
		() => container.querySelector('[data-testid="bot-ready-chat"]') !== null
	);
	expect(calls.map((call) => call.method)).toEqual([
		"GET",
		"PUT",
		"GET",
		"GET",
		"PUT",
		"GET",
	]);
	expect(
		calls.map(({ origin, path, auth }) => ({ origin, path, auth }))
	).toEqual(
		Array.from({ length: 6 }, () => ({
			origin: node.url,
			path: preferencePath,
			auth: "Bearer node-admission",
		}))
	);
	expect(
		calls.filter((call) => call.method === "GET").map((call) => call.body)
	).toEqual([null, null, null, null]);
	expect(stored).toBe(JSON.stringify(defaultCloudAgentSelection(true)));
	expect(
		calls.filter((call) => call.method === "PUT").map((call) => call.body)
	).toEqual(
		Array.from({ length: 2 }, () => ({
			value: JSON.stringify(defaultCloudAgentSelection(true)),
		}))
	);
});

test("an existing Console cloud choice is confirmed without replacement", async () => {
	const selected = {
		...EMPTY_AGENT_SELECTION,
		agent_id: "ryu",
		provider: "managed-openrouter",
		model: "anthropic/claude-sonnet-4",
	};
	stored = JSON.stringify(selected);
	nodeStore.setState({ cloudNodes: [node] });
	await act(async () => root.render(createElement(BotManagedEntry)));
	await waitFor(
		() => container.querySelector('[data-testid="bot-ready-chat"]') !== null
	);
	expect(calls.map((call) => call.method)).toEqual(["GET"]);
	expect(calls).toEqual([
		{
			method: "GET",
			origin: node.url,
			path: preferencePath,
			auth: "Bearer node-admission",
			body: null,
		},
	]);
	expect(stored).toBe(JSON.stringify(selected));
});

test("an unavailable initial read never overwrites the Console choice and retry confirms it", async () => {
	const selected = {
		...EMPTY_AGENT_SELECTION,
		model: "existing-console-model",
		provider: "managed-openrouter",
	};
	stored = JSON.stringify(selected);
	readUnavailable = true;
	await act(async () => root.render(createElement(BotManagedEntry)));
	await waitFor(() => container.querySelector('[role="alert"]') !== null);
	expect(calls.map((call) => call.method)).toEqual(["GET"]);
	expect(stored).toBe(JSON.stringify(selected));
	expect(container.querySelector('[data-testid="bot-ready-chat"]')).toBeNull();
	readUnavailable = false;
	await act(async () =>
		container
			.querySelector<HTMLButtonElement>('[data-testid="bot-retry"]')
			?.click()
	);
	await waitFor(
		() => container.querySelector('[data-testid="bot-ready-chat"]') !== null
	);
	expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
	expect(calls).toEqual(
		Array.from({ length: 2 }, () => ({
			method: "GET",
			origin: node.url,
			path: preferencePath,
			auth: "Bearer node-admission",
			body: null,
		}))
	);
	expect(stored).toBe(JSON.stringify(selected));
});

test("revoking entitlement during pending readback cannot open chat", async () => {
	let release: (() => void) | undefined;
	holdReadback = new Promise<void>((resolve) => {
		release = resolve;
	});
	acknowledgeWithoutPersistence = false;
	await act(async () => root.render(createElement(BotManagedEntry)));
	await waitFor(() => calls.length === 3);
	expect(
		container.querySelector<HTMLButtonElement>('[data-testid="bot-retry"]')
			?.disabled
	).toBe(true);
	expect(container.querySelector('[data-testid="bot-ready-chat"]')).toBeNull();
	entitlement.managedInference = false;
	await act(async () => root.render(createElement(BotManagedEntry)));
	expect(
		container.querySelector('[data-testid="bot-subscribe"]')
	).not.toBeNull();
	await act(async () => release?.());
	await settle();
	expect(container.querySelector('[data-testid="bot-ready-chat"]')).toBeNull();
	expect(
		container.querySelector('[data-testid="bot-subscribe"]')
	).not.toBeNull();
	expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]);
	expect(
		calls.map(({ origin, path, auth }) => ({ origin, path, auth }))
	).toEqual(
		Array.from({ length: 3 }, () => ({
			origin: node.url,
			path: preferencePath,
			auth: "Bearer node-admission",
		}))
	);
});
