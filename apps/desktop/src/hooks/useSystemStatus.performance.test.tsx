import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
mock.module("@/src/lib/api/client.ts", () => ({
	ApiError: class ApiError extends Error {},
}));
const node = {
	name: "remote",
	url: "https://node.example",
	token: null,
	userJwt: null,
};
let local = false;
const originalFetch = globalThis.fetch;
const nodeState = {
	getActiveNode: () => node,
	setActiveNodeOnline: () => undefined,
};
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: <T,>(select: (state: typeof nodeState) => T) =>
		select(nodeState),
	isLocalNode: () => local,
}));
let running = false;
mock.module("@/src/lib/api/system.ts", () => ({
	fetchSystemStatus: async () => ({
		coreReachable: true,
		activeEngine: null,
		engineRunning: false,
		gatewayReachable: true,
		sidecars: { shadow: running },
		mesh: null,
	}),
	fetchHealth: async () => ({}),
}));
mock.module("@/src/lib/core-refresh.ts", () => ({
	triggerGlobalRefresh: () => undefined,
}));
mock.module("@/src/lib/tauri-ready.ts", () => ({
	isTauriReady: () => false,
	invokeWhenReady: async () => ({}),
}));
const { useSystemStatus } = await import("./useSystemStatus.ts");
let result: ReturnType<typeof useSystemStatus>;
let commits = 0;
function Harness() {
	result = useSystemStatus();
	useEffect(() => {
		commits++;
	});
	return null;
}
const container = document.createElement("div");
let root = createRoot(container);
afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(container);
	commits = 0;
	running = false;
	local = false;
	globalThis.fetch = originalFetch;
});
test("unchanged status snapshots do not rerender consumers, while real changes do", async () => {
	await act(async () => root.render(<Harness />));
	const settled = commits;
	await act(async () => {
		await result.refresh();
		await result.refresh();
	});
	expect(commits).toBe(settled);
	running = true;
	await act(async () => result.refresh());
	expect(commits).toBeGreaterThan(settled);
	expect(result.sidecars.shadow).toBe(true);
});

test("a stalled optional Island probe cannot hold the Core status open", async () => {
	local = true;
	let aborted = false;
	const fetchStub = Object.assign(
		(_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(new Error("probe timeout"));
					},
					{ once: true }
				);
			}),
		{ preconnect: originalFetch.preconnect }
	);
	spyOn(globalThis, "fetch").mockImplementation(fetchStub);

	await act(async () => root.render(<Harness />));
	expect(result.loading).toBe(true);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 1700));
	});
	expect(aborted).toBe(true);
	expect(result.loading).toBe(false);
	expect(result.coreReachable).toBe(true);
	expect(result.islandReachable).toBe(false);
});
