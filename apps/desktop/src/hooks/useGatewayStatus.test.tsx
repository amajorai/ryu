import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

import type { GatewayStatus } from "@/src/lib/api/gateway.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node: ApiTarget = {
	url: "https://first.example",
	token: null,
	userJwt: null,
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
const calls: {
	signal: AbortSignal;
	resolve: (value: GatewayStatus) => void;
	reject: (reason: Error) => void;
	url: string;
}[] = [];
mock.module("@/src/lib/api/gateway.ts", () => ({
	fetchGatewayStatus: (target: { url: string }, signal: AbortSignal) =>
		new Promise<GatewayStatus>((resolve, reject) => {
			calls.push({ signal, resolve, reject, url: target.url });
		}),
}));
const { useGatewayStatus } = await import("./useGatewayStatus.ts");
let result: ReturnType<typeof useGatewayStatus>;
function Harness({ enabled }: { enabled: boolean }) {
	result = useGatewayStatus(enabled);
	return null;
}
const container = document.createElement("div");
let root = createRoot(container);
const snapshot = (url: string): GatewayStatus => ({
	reachable: true,
	url,
	health: null,
	metrics: null,
});
async function render(enabled = true) {
	await act(async () => {
		root.render(<Harness enabled={enabled} />);
	});
}
afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(container);
	calls.length = 0;
	node = { url: "https://first.example", token: null, userJwt: null };
});

test("closed dialogs do no work; close cancels pending work and reopening starts fresh", async () => {
	await render(false);
	expect(calls).toHaveLength(0);
	await render();
	expect(calls).toHaveLength(1);
	await render(false);
	expect(calls[0].signal.aborted).toBe(true);
	await act(async () => calls[0].resolve(snapshot("old")));
	expect(result.status).toBeNull();
	await render();
	expect(calls).toHaveLength(2);
	await act(async () => calls[1].resolve(snapshot("fresh")));
	expect(result.status?.url).toBe("fresh");
});

test("slow polling and repeated refreshes share one request", async () => {
	await render();
	const first = result.refresh();
	expect(result.refresh()).toBe(first);
	await new Promise((resolve) => setTimeout(resolve, 5200));
	expect(calls).toHaveLength(1);
	await act(async () => {
		calls[0].resolve(snapshot("first"));
		await first;
	});
	expect(result.loading).toBe(false);
	const next = result.refresh();
	expect(calls).toHaveLength(2);
	await act(async () => {
		calls[1].reject(new Error("Core unreachable"));
		await next;
	});
	expect(result.status).toBeNull();
	expect(result.error).toBe("Core unreachable");
}, 10_000);

test("node and credential changes abort old requests and ignore their late responses", async () => {
	await render();
	node = { ...node, url: "https://second.example" };
	await render();
	expect(calls[0].signal.aborted).toBe(true);
	expect(calls[1].url).toBe(node.url);
	await act(async () => calls[1].resolve(snapshot("second")));
	await act(async () => calls[0].resolve(snapshot("stale-first")));
	expect(result.status?.url).toBe("second");
	node = { ...node, token: "rotated" };
	await render();
	expect(calls[1].signal.aborted).toBe(true);
	expect(calls).toHaveLength(3);
	expect(result.status).toBeNull();
});

test("an unresponsive request is aborted at the deadline", async () => {
	await render();
	const signal = calls[0].signal;
	await act(async () => {
		await new Promise<void>((resolve) =>
			signal.addEventListener(
				"abort",
				() => {
					calls[0].reject(new Error("Status request timed out"));
					resolve();
				},
				{ once: true }
			)
		);
	});
	expect(signal.aborted).toBe(true);
	expect(result.loading).toBe(false);
	expect(result.error).toBe("Status request timed out");
}, 15_000);
