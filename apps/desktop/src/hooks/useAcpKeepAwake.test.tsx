import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node: import("@/src/lib/api/client.ts").ApiTarget & { name?: string } = {
	url: "http://local.test",
	token: "first",
	userJwt: null,
	name: "Local",
};
let ready = true;
const commands: boolean[] = [];
const calls: {
	signal: AbortSignal;
	resolve: <TValue>(value: TValue) => void;
	token: string | null;
}[] = [];
mock.module("./useActiveNode.ts", () => ({ useActiveNode: () => node }));
mock.module("@/src/store/useNodeStore.ts", () => ({
	isLocalNode: ({ url }: { url: string }) => url === "http://local.test",
}));
mock.module("@/src/lib/tauri-ready.ts", () => ({
	isTauriReady: () => ready,
	invokeWhenReady: (_command: string, args: { enabled: boolean }) => {
		commands.push(args.enabled);
		return Promise.resolve();
	},
}));
mock.module("@/src/lib/api/gateway.ts", () => ({
	fetchGatewayConfig: (target: { token: string | null }, signal: AbortSignal) =>
		new Promise((resolve, reject) => {
			calls.push({ signal, resolve, token: target.token });
			signal?.addEventListener("abort", () => reject(new Error("aborted")), {
				once: true,
			});
		}),
}));
const { useAcpKeepAwake } = await import("./useAcpKeepAwake.ts");
function Harness() {
	useAcpKeepAwake();
	return null;
}
const container = document.createElement("div");
let root = createRoot(container);
const config = (enabled: boolean) => ({
	acp: { keep_computer_awake: enabled, active_agents: 1 },
});
async function render() {
	await act(async () => root.render(<Harness />));
}
afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(container);
	calls.length = 0;
	commands.length = 0;
	ready = true;
	node = {
		url: "http://local.test",
		token: "first",
		userJwt: null,
		name: "Local",
	};
});

test("metadata does not restart reads; credentials cancel and replace old work", async () => {
	await render();
	node = { ...node, name: "Renamed" };
	await render();
	expect(calls).toHaveLength(1);
	node = { ...node, token: "second" };
	await render();
	expect(calls[0].signal.aborted).toBe(true);
	expect(calls[1].token).toBe("second");
	await act(async () => calls[0].resolve(config(true)));
	expect(commands).toHaveLength(0);
	await act(async () => calls[1].resolve(config(false)));
	expect(commands).toEqual([false]);
});

test("slow reads expire without overlapping and cleanup cancels pending reads", async () => {
	await render();
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10_200));
	});
	expect(calls).toHaveLength(1);
	expect(calls[0].signal.aborted).toBe(true);
	expect(commands).toEqual([false]);
	node = { ...node, token: "second" };
	await render();
	const pending = calls[1].signal;
	await act(async () => root.unmount());
	root = createRoot(container);
	expect(pending.aborted).toBe(true);
}, 15_000);

test("remote nodes release the local assertion without a Gateway read", async () => {
	node = { ...node, url: "https://remote.test" };
	await render();
	expect(calls).toHaveLength(0);
	expect(commands).toEqual([false]);
});

test("a browser without a native bridge performs no reads or commands", async () => {
	ready = false;
	await render();
	expect(calls).toHaveLength(0);
	expect(commands).toHaveLength(0);
});
