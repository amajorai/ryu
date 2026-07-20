// Integration check for the host bridge wiring (#446) WITHOUT a DOM/iframe.
//
// The `ExtensionHost` React component can only be exercised in a real webview
// (it needs an iframe + window `message` events), which requires the running
// desktop. This test instead drives the SAME pieces the host runs over a real
// `MessageChannel` (which Bun provides): the host side validates each envelope
// with `asRpcRequest`, gate-dispatches with `dispatchRpc`, and posts the reply;
// the "plugin" side sends requests over its port and awaits results by id. It
// proves the request/reply correlation + the gate behave correctly end to end
// over a real port: the part that is logic, not webview rendering.

import { describe, expect, it } from "bun:test";
import {
	asRpcRequest,
	type Capability,
	dispatchRpc,
	type HostServices,
	type RpcResponse,
} from "./rpc.ts";

const AGENTS = [{ id: "ryu", name: "Ryu" }];
const NOT_GRANTED = /Capability not granted/;

function services(): HostServices {
	return {
		listAgents: () => Promise.resolve(AGENTS),
		registerRoute: () => Promise.resolve(null),
	};
}

/** Attach the host's port handler (mirrors ExtensionHost.onPortMessage). */
function attachHost(
	port: MessagePort,
	granted: ReadonlySet<Capability>,
	svc: HostServices
): void {
	port.onmessage = (event: MessageEvent) => {
		const req = asRpcRequest(event.data);
		if (!req) {
			return;
		}
		dispatchRpc(req.method, req.args, granted, svc)
			.then((result) => {
				const reply: RpcResponse = {
					kind: "ryu-plugin-rpc-result",
					id: req.id,
					result,
				};
				port.postMessage(reply);
			})
			.catch((err: unknown) => {
				const reply: RpcResponse = {
					kind: "ryu-plugin-rpc-result",
					id: req.id,
					error: err instanceof Error ? err.message : String(err),
				};
				port.postMessage(reply);
			});
	};
	port.start?.();
}

/** Make a "plugin" caller over the other port that resolves replies by id. */
function pluginCaller(port: MessagePort) {
	const pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	let nextId = 1;
	port.onmessage = (event: MessageEvent) => {
		const msg = event.data as RpcResponse;
		if (msg?.kind !== "ryu-plugin-rpc-result") {
			return;
		}
		const p = pending.get(msg.id);
		if (!p) {
			return;
		}
		pending.delete(msg.id);
		if (typeof msg.error === "string") {
			p.reject(new Error(msg.error));
		} else {
			p.resolve(msg.result);
		}
	};
	port.start?.();
	return (method: string, args: unknown[] = []) =>
		new Promise<unknown>((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			port.postMessage({ kind: "ryu-plugin-rpc", id, method, args });
		});
}

describe("host RPC bridge over a real MessageChannel", () => {
	it("returns the agent list for a granted call", async () => {
		const channel = new MessageChannel();
		attachHost(
			channel.port1,
			new Set<Capability>(["core.listAgents"]),
			services()
		);
		const call = pluginCaller(channel.port2);
		await expect(call("core.listAgents")).resolves.toEqual(AGENTS);
		channel.port1.close();
		channel.port2.close();
	});

	it("propagates a gate rejection back to the plugin as an error reply", async () => {
		const channel = new MessageChannel();
		// No capabilities granted.
		attachHost(channel.port1, new Set<Capability>(), services());
		const call = pluginCaller(channel.port2);
		await expect(call("core.listAgents")).rejects.toThrow(NOT_GRANTED);
		channel.port1.close();
		channel.port2.close();
	});
});
