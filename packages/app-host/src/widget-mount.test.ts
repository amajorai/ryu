// Wiring test for the Ryu App WIDGET path (#446), WITHOUT a DOM/iframe.
//
// Two halves, both the pieces that are LOGIC rather than webview rendering:
//
//   (A) Mount seam — the hard-pinned CSP the host injects when it mounts a widget
//       (`buildWidgetCsp`). The full document assembly (`widgetBootstrapSrcdoc`)
//       uses `new DOMParser()`, a webview API that is `undefined` in Bun and is
//       deliberately NOT polyfilled here (the suite is DOM-free — bridge.ts needs
//       `window`), so this covers the CSP CONTRACT the mount enforces, not the DOM
//       surgery. The AppWidget component itself lives in apps/desktop (off-boundary
//       for this package) and is exercised in the desktop integration harness.
//
//   (B) Companion callTool round-trip — the `window.openai.callTool` /
//       `sendFollowUpMessage` / `setWidgetState` bridge, driven over a REAL
//       `MessageChannel` (Bun provides it) through the SAME `dispatchRpc` gate +
//       `toRpcError` serialization the live `ExtensionHost` runs (ExtensionHost.tsx
//       lines 149/283). This is the round-trip the existing suite never exercised:
//       a mounted widget's method call reaching the host service, and an ungranted
//       call being denied. Host boundary (rpc.ts / ExtensionHost.tsx) is unchanged.

import { describe, expect, it } from "bun:test";
import {
	asRpcRequest,
	type Capability,
	dispatchRpc,
	type HostServices,
	type RpcResponse,
	toRpcError,
} from "./rpc.ts";
import { buildWidgetCsp } from "./widget-bootstrap.ts";

// ── (A) mount seam: the hard-pinned widget CSP ─────────────────────────────────

describe("widget mount CSP contract (buildWidgetCsp)", () => {
	const NONCE = "mount-nonce-xyz";
	const csp = buildWidgetCsp(NONCE);

	it("gates every script on the host nonce (no unsafe-inline / unsafe-eval)", () => {
		expect(csp).toContain(`script-src 'nonce-${NONCE}'`);
		expect(csp).not.toContain("unsafe-eval");
		expect(csp).not.toContain("script-src 'unsafe-inline'");
	});

	it("hard-pins the egress lock — a mounted widget cannot fetch or beacon", () => {
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("connect-src 'none'");
		expect(csp).toContain("form-action 'none'");
		expect(csp).toContain("base-uri 'none'");
	});

	it("allows only inline/data passive assets, never a remote origin", () => {
		expect(csp).toContain("img-src data:");
		expect(csp).toContain("font-src data:");
		expect(csp).toContain("media-src data:");
		expect(csp).not.toContain("connect-src *");
		expect(csp).not.toContain("https:");
	});

	it("widens passive-asset src to the Core proxy origin but NEVER connect-src", () => {
		const widened = buildWidgetCsp(NONCE, "http://127.0.0.1:7980");
		expect(widened).toContain("img-src data: http://127.0.0.1:7980");
		expect(widened).toContain("font-src data: http://127.0.0.1:7980");
		expect(widened).toContain("media-src data: http://127.0.0.1:7980");
		// The egress lock is intact: active fetch/beacon stays fully blocked, so a
		// widget's data still flows only via the governed callTool bridge.
		expect(widened).toContain("connect-src 'none'");
		expect(widened).not.toContain("connect-src http");
	});

	it("drops a proxy origin carrying CSP-delimiter chars (no directive injection)", () => {
		const bad = buildWidgetCsp(NONCE, "http://127.0.0.1:7980; script-src *");
		// The sanitizer rejects it → the data:-only lock, byte-for-byte.
		expect(bad).toBe(csp);
		expect(bad).not.toContain("script-src *");
	});

	it("never widens to a raw remote https host — only the Core proxy origin", () => {
		// The proxy origin is loopback http; a public https host is not a valid proxy
		// origin here and the raw remote host must never appear in the widget CSP.
		const widened = buildWidgetCsp(NONCE, "http://127.0.0.1:7980");
		expect(widened).not.toContain("evil.example.com");
	});
});

// ── (B) companion callTool round-trip over a real MessageChannel ───────────────

/** A capability-gated error that survived the port carries a `.code` (D6). */
interface PortError extends Error {
	code?: string;
}

/** Attach the host's port handler — the SAME shape ExtensionHost runs: validate
 *  the envelope, gate-dispatch with `dispatchRpc`, and serialize errors with
 *  `toRpcError` so a coded error keeps its `{ code, message }` shape. */
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
					error: toRpcError(err),
				};
				port.postMessage(reply);
			});
	};
	port.start?.();
}

/** A "widget" caller over the other port. Mirrors the frame bridge's
 *  `onPortMessage`: a string error becomes a plain Error; a `{ code, message }`
 *  error becomes an Error carrying `.code`. */
function widgetCaller(port: MessagePort) {
	const pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: PortError) => void }
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
		if (msg.error === undefined) {
			p.resolve(msg.result);
			return;
		}
		if (typeof msg.error === "string") {
			p.reject(new Error(msg.error));
			return;
		}
		const err: PortError = new Error(msg.error.message);
		err.code = msg.error.code;
		p.reject(err);
	};
	port.start?.();
	return (method: string, args: unknown[] = []) =>
		new Promise<unknown>((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			port.postMessage({ kind: "ryu-plugin-rpc", id, method, args });
		});
}

/** A widget host that records what it was asked to do. */
function recordingServices() {
	const calls: { method: string; args: unknown[] }[] = [];
	const svc: HostServices = {
		listAgents: () => Promise.resolve([]),
		registerRoute: () => Promise.resolve(null),
		callTool: (name, args) => {
			calls.push({ method: "callTool", args: [name, args] });
			return Promise.resolve({ ok: true, echoed: name });
		},
		sendFollowUpMessage: (input) => {
			calls.push({ method: "sendFollowUpMessage", args: [input] });
			return Promise.resolve();
		},
		setWidgetState: (state) => {
			calls.push({ method: "setWidgetState", args: [state] });
			return Promise.resolve();
		},
		getGlobals: () => Promise.resolve({ theme: "dark" }),
	};
	return { svc, calls };
}

/** The capabilities a mounted widget holds: `tool.call` + `ui.sendMessage` are
 *  Gateway-sourced from grants; `widget.state` is a LOCAL host cap always granted
 *  to a mounted widget (never grant-derived). */
const WIDGET_CAPS = new Set<Capability>([
	"tool.call",
	"ui.sendMessage",
	"widget.state",
]);

function channelPair(granted: ReadonlySet<Capability>, svc: HostServices) {
	const channel = new MessageChannel();
	attachHost(channel.port1, granted, svc);
	const call = widgetCaller(channel.port2);
	return {
		call,
		close: () => {
			channel.port1.close();
			channel.port2.close();
		},
	};
}

describe("widget → host callTool bridge over a real MessageChannel", () => {
	it("routes window.openai.callTool to services.callTool with pinned name+args", async () => {
		const { svc, calls } = recordingServices();
		const { call, close } = channelPair(WIDGET_CAPS, svc);
		const result = await call("tool.call", ["my-app__save", { note: "hi" }]);
		expect(result).toEqual({ ok: true, echoed: "my-app__save" });
		expect(calls).toEqual([
			{ method: "callTool", args: ["my-app__save", { note: "hi" }] },
		]);
		close();
	});

	it("routes sendFollowUpMessage to services.sendFollowUpMessage", async () => {
		const { svc, calls } = recordingServices();
		const { call, close } = channelPair(WIDGET_CAPS, svc);
		await call("ui.sendMessage", [{ prompt: "continue please" }]);
		expect(calls).toEqual([
			{ method: "sendFollowUpMessage", args: [{ prompt: "continue please" }] },
		]);
		close();
	});

	it("routes setWidgetState to services.setWidgetState", async () => {
		const { svc, calls } = recordingServices();
		const { call, close } = channelPair(WIDGET_CAPS, svc);
		await call("widget.setState", [{ checked: [1, 2] }]);
		expect(calls).toEqual([
			{ method: "setWidgetState", args: [{ checked: [1, 2] }] },
		]);
		close();
	});

	it("rejects a malformed tool.call with the coded invalid_args (bad name)", async () => {
		const { svc } = recordingServices();
		const { call, close } = channelPair(WIDGET_CAPS, svc);
		try {
			await call("tool.call", [123, {}]);
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as PortError).code).toBe("invalid_args");
		}
		close();
	});

	it("denies an ungranted tool.call as a plain CapabilityError (not in the coded set)", async () => {
		const { svc } = recordingServices();
		// No capabilities granted.
		const { call, close } = channelPair(new Set<Capability>(), svc);
		try {
			await call("tool.call", ["my-app__save", {}]);
			throw new Error("expected rejection");
		} catch (err) {
			// `tool.call` is NOT in CODED_ERROR_CAPABILITIES → plain-string error,
			// so it survives the port WITHOUT a `.code`.
			expect((err as PortError).code).toBeUndefined();
			expect((err as Error).message).toMatch(/Capability not granted/);
		}
		close();
	});

	it("denies an ungranted app-bridge method with a coded `denied`", async () => {
		const { svc } = recordingServices();
		const { call, close } = channelPair(new Set<Capability>(), svc);
		try {
			// `model.complete` IS in CODED_ERROR_CAPABILITIES → structured `denied`.
			await call("model.complete", [{ prompt: "x" }]);
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as PortError).code).toBe("denied");
		}
		close();
	});
});

// ── window.openai parity: requestModal template + openExternal + file stubs ─────

describe("window.openai parity methods", () => {
	const LOCAL_CAPS = new Set<Capability>(["ui.displayMode"]);

	it("threads requestModal { template } to the host service (NOT dropped)", async () => {
		let received: unknown = "unset";
		const svc: HostServices = {
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve(null),
			requestModal: (input) => {
				received = input.template;
				return Promise.resolve({ mode: "fullscreen" });
			},
		};
		const { call, close } = channelPair(LOCAL_CAPS, svc);
		const res = await call("ui.requestModal", [{ template: "detail-view" }]);
		expect(res).toEqual({ mode: "fullscreen" });
		expect(received).toBe("detail-view");
		close();
	});

	it("vets openExternal to http(s) and rejects other schemes at the gate", async () => {
		const opened: string[] = [];
		const svc: HostServices = {
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve(null),
			openExternal: ({ href }) => {
				opened.push(href);
				return Promise.resolve();
			},
		};
		const { call, close } = channelPair(LOCAL_CAPS, svc);
		await call("ui.openExternal", ["https://example.com/x"]);
		expect(opened).toEqual(["https://example.com/x"]);
		// A javascript: URL never reaches the host service — rejected as invalid_args.
		try {
			await call("ui.openExternal", ["javascript:alert(1)"]);
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as PortError).code).toBe("invalid_args");
		}
		expect(opened).toEqual(["https://example.com/x"]);
		close();
	});

	it("file methods reject cleanly (not the unknown-method deny)", async () => {
		const svc: HostServices = {
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve(null),
		};
		const { call, close } = channelPair(LOCAL_CAPS, svc);
		try {
			await call("ui.uploadFile", [{}]);
			throw new Error("expected rejection");
		} catch (err) {
			// A KNOWN-but-unimplemented method → structured server_error with a clear
			// message, NOT the unknown-method CapabilityError.
			expect((err as PortError).code).toBe("server_error");
			expect((err as Error).message).toMatch(/not supported/);
		}
		close();
	});
});
