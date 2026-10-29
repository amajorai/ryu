import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Isolated Bun process: actual node store, with native/control-plane transport
// boundaries replaced. Layout is a completion witness, not an access proof.
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
let selected = "Managed B";
const nativeCalls: { command: string; args?: { name?: string } }[] = [];
const managed = ["a", "b"].map((id) => ({
	id,
	name: `Managed ${id.toUpperCase()}`,
	url: `https://managed-${id}.test`,
	orgId: `org-${id}`,
	orgName: id,
	lastSeenAt: null,
	userJwt: `delegation-${id}`,
}));
mock.module("@/src/lib/tauri-ready.ts", () => ({
	TauriUnavailableError: class extends Error {},
	listenWhenReady: async () => () => undefined,
	invokeWhenReady: async (command: string, args?: { name?: string }) => {
		nativeCalls.push({ command, args });
		if (command === "list_nodes") {
			return {
				default: selected,
				nodes: managed.map((node) => ({
					name: node.name,
					url: node.url,
					token: null,
				})),
			};
		}
		if (command === "set_default_node" && args?.name !== undefined) {
			selected = args.name;
			return;
		}
		throw new Error(`Unexpected native command ${command}`);
	},
}));
mock.module("@/src/lib/api/managed-nodes.ts", () => ({
	fetchManagedNodes: async () => managed,
}));
mock.module("@/src/lib/gating/planCapBridge.ts", () => ({
	enforcePlanCap: async () => undefined,
}));
mock.module("@/src/hooks/useCreditsWallet.ts", () => ({
	useCreditsWallet: () => ({
		entitlement: { managedInference: true },
		loading: false,
		refresh: async () => undefined,
	}),
}));
mock.module("@/src/components/layout/Layout.tsx", () => ({
	default: () =>
		createElement("main", { "data-testid": "confirmed-chat" }, "Confirmed"),
}));
mock.module("@/lib/auth-client.ts", () => ({
	TOKEN_KEY: "account-token",
	BACKEND_URL: "https://identity.test",
	// The node store's desktop-route sync reads the signed-in account; this
	// proof runs without one.
	getActiveUserId: () => null,
	getActiveToken: () =>
		globalThis.localStorage?.getItem("account-token") ?? null,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: async () => null,
}));
mock.module("@/lib/tauri-bridge.ts", () => ({
	openExternal: async () => undefined,
}));
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { BotManagedEntry } = await import("./BotManagedEntry.tsx");
const originalFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	globalThis.fetch = originalFetch;
	managed.splice(0);
	await useNodeStore.getState().hydrateCloudNodes();
});

test("mounted Bot keeps canonical selected B and ignores pending A confirmation after native selection changes", async () => {
	async function settleUntil(predicate: () => boolean) {
		for (let attempt = 0; attempt < 150 && !predicate(); attempt++) {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
		}
		expect(predicate()).toBe(true);
	}
	const origins: string[] = [];
	let holdA: Promise<void> | null = null;
	let releaseA: (() => void) | undefined;
	const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		expect(request.method).toBe("GET");
		expect(url.pathname).toBe("/api/preferences/default-cloud-agent-selection");
		expect(request.headers.get("authorization")).toBe(
			`Bearer delegation-${url.hostname.includes("-a.") ? "a" : "b"}`
		);
		origins.push(url.origin);
		if (url.origin === managed[0]?.url) {
			await holdA;
		}
		return Response.json({
			value: JSON.stringify({
				agent_id: "ryu",
				provider: "managed-openrouter",
				model: "openrouter/auto",
				thinking_level: "",
				effort: "",
				access_mode: "",
			}),
		});
	};
	globalThis.fetch = Object.assign(transport, {
		preconnect: originalFetch.preconnect,
	});
	await useNodeStore.getState().refresh();
	await useNodeStore.getState().hydrateCloudNodes();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root?.render(createElement(BotManagedEntry)));
	await settleUntil(
		() => container?.querySelector("[data-testid=confirmed-chat]") !== null
	);
	expect(useNodeStore.getState().getActiveNode().name).toBe("Managed B");
	expect(origins).toEqual(["https://managed-b.test"]);
	// Actual persisted selection API, never private store state mutation.
	holdA = new Promise((resolve) => {
		releaseA = resolve;
	});
	await act(async () => useNodeStore.getState().setDefault("Managed A"));
	await settleUntil(() => origins.includes("https://managed-a.test"));
	expect(container.querySelector("[data-testid=confirmed-chat]")).toBeNull();
	await act(async () => useNodeStore.getState().setDefault("Managed B"));
	await act(async () => {
		releaseA?.();
		await holdA;
	});
	await settleUntil(
		() => container?.querySelector("[data-testid=confirmed-chat]") !== null
	);
	expect(useNodeStore.getState().getActiveNode().name).toBe("Managed B");
	expect(selected).toBe("Managed B");
	expect(
		nativeCalls.filter((call) => call.command === "set_default_node")
	).toEqual([
		{ command: "set_default_node", args: { name: "Managed A" } },
		{ command: "set_default_node", args: { name: "Managed B" } },
	]);
});
