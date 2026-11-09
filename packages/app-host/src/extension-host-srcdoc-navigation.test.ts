// ExtensionHost's srcdoc transport (desktop, island and web companions, MCP App
// widgets) against a companion that navigates its own frame. The navigated
// document keeps the same `contentWindow`, so `event.source` identity cannot tell
// it apart, and its `load` can be stalled forever by the attacker's server. These
// tests mount the real ExtensionHost effect (React hooks stubbed, no DOM) and
// assert what the host actually posts and delivers.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realReact from "react";
import type { ExtensionFrameMessage } from "./extension-host-handshake.ts";
import { sandboxForCompanion } from "./extension-host-handshake.ts";
import type { Capability, HostServices } from "./rpc.ts";
import {
	LIVENESS_ACK_KIND,
	LIVENESS_PROBE_KIND,
} from "./sandbox-liveness-gate.ts";

type Effect = () => (() => void) | undefined;

interface Posted {
	message: Record<string, unknown>;
	ports: readonly MessagePort[];
}

const effects: Effect[] = [];
// The component's first `useRef` is its iframe ref; the test fills it in.
const iframeRef: { current: unknown } = { current: null };
let refCalls = 0;

mock.module("react", () => ({
	...realReact,
	useEffect: (effect: Effect) => {
		effects.push(effect);
	},
	useLayoutEffect: (effect: Effect) => {
		effects.push(effect);
	},
	useRef: (initial: unknown) => {
		refCalls += 1;
		return refCalls === 1 ? iframeRef : { current: initial };
	},
}));

// Other suites in this process load ExtensionHost with the real React first, and
// `mock.module` does not rebind a module that is already evaluated. A query
// suffix gives this file its own instance, evaluated against the stub above.
const extensionHostModule: string = "./ExtensionHost.tsx?srcdoc-navigation";
const { ExtensionHost } = (await import(
	extensionHostModule
)) as typeof import("./ExtensionHost.tsx");

const SRCDOC = "<!doctype html><title>companion</title>";
const NONCE = "nonce-1";

class FakeWindow {
	readonly listeners = new Set<(event: MessageEvent) => void>();
	addEventListener(_type: string, listener: (event: MessageEvent) => void) {
		this.listeners.add(listener);
	}
	removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
		this.listeners.delete(listener);
	}
	emit(data: unknown, source: unknown) {
		const event = { data, source } as unknown as MessageEvent;
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}
}

class FakeIframe extends EventTarget {
	readonly attributes = new Map<string, string>();
	readonly dataset: Record<string, string> = {};
	readonly posted: Posted[] = [];
	srcdoc = SRCDOC;
	readonly contentWindow = {
		postMessage: (
			message: Record<string, unknown>,
			_origin: string,
			ports: readonly MessagePort[] = []
		) => {
			this.posted.push({ message, ports });
		},
	};
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
}

const fakeWindow = new FakeWindow();
let iframe: FakeIframe;
let cleanups: Array<() => void> = [];
let delivered: ExtensionFrameMessage[] = [];

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function mount(granted: ReadonlySet<Capability>) {
	effects.length = 0;
	refCalls = 0;
	ExtensionHost({
		granted,
		nonce: NONCE,
		onMessage: (message) => {
			delivered.push(message);
		},
		services: {} as HostServices,
		srcdoc: SRCDOC,
		title: "companion",
	});
	iframeRef.current = iframe;
	// Only the bridge effect (the first) matters here; run it as React would.
	const cleanup = effects[0]?.();
	if (cleanup) {
		cleanups.push(cleanup);
	}
}

/** The companion's own handshake; returns the port2 it receives. */
async function handshake(): Promise<MessagePort> {
	fakeWindow.emit(
		{ kind: "ryu-plugin-ready", nonce: NONCE },
		iframe.contentWindow
	);
	const transfer = iframe.posted.find(
		(entry) => entry.message.kind === "ryu-plugin-host-port"
	);
	const port = transfer?.ports[0];
	if (!port) {
		throw new Error("the host did not transfer a port");
	}
	return port;
}

function mcpReplies(): Posted[] {
	return iframe.posted.filter((entry) => entry.message.jsonrpc === "2.0");
}

const initialize = {
	jsonrpc: "2.0",
	id: 7,
	method: "ui/initialize",
	params: {},
};

beforeEach(() => {
	Reflect.set(globalThis, "window", fakeWindow);
	iframe = new FakeIframe();
	iframe.setAttribute("srcdoc", SRCDOC);
	iframe.setAttribute("sandbox", sandboxForCompanion({ srcdoc: SRCDOC }));
	delivered = [];
});

afterEach(() => {
	for (const cleanup of cleanups) {
		cleanup();
	}
	cleanups = [];
	Reflect.deleteProperty(globalThis, "window");
});

describe("ExtensionHost srcdoc self-navigation", () => {
	test("the live companion's window traffic is delivered after its port acks", async () => {
		mount(new Set());
		const port = await handshake();
		port.onmessage = (event: MessageEvent) => {
			if (event.data?.kind === LIVENESS_PROBE_KIND) {
				port.postMessage({ kind: LIVENESS_ACK_KIND, id: event.data.id });
			}
		};
		fakeWindow.emit({ kind: "sketch", token: "t" }, iframe.contentWindow);
		fakeWindow.emit(initialize, iframe.contentWindow);
		for (
			let attempt = 0;
			attempt < 20 && mcpReplies().length === 0;
			attempt++
		) {
			await tick();
		}
		expect(delivered).toContainEqual({ kind: "sketch", token: "t" });
		expect(mcpReplies().map((entry) => entry.message.id)).toEqual([7]);
		port.close();
	});

	test("a navigated document whose load never fires gets no bridge traffic", async () => {
		mount(new Set());
		const port = await handshake();
		// The companion navigated: its realm (and port2) is gone, nobody answers
		// the probe, and the attacker server never lets `load` fire.
		port.close();
		fakeWindow.emit({ kind: "exfil" }, iframe.contentWindow);
		fakeWindow.emit(initialize, iframe.contentWindow);
		await tick();
		await tick();
		expect(delivered).toEqual([]);
		expect(mcpReplies()).toEqual([]);
	});

	test("a handshake re-run on the same element transfers no second port", async () => {
		mount(new Set());
		const port = await handshake();
		port.close();
		const before = iframe.posted.length;
		// `granted` changed: the effect re-runs on the same iframe element, and the
		// navigated document (which learned the nonce) re-announces.
		mount(new Set<Capability>(["tool.call"]));
		fakeWindow.emit(
			{ kind: "ryu-plugin-ready", nonce: NONCE },
			iframe.contentWindow
		);
		const after = iframe.posted
			.slice(before)
			.map((entry) => entry.message.kind);
		expect(after).not.toContain("ryu-plugin-host-port");
		expect(after).not.toContain("ryu-sandbox-document");
	});

	test("a navigation load closes the port and blanks the frame", async () => {
		mount(new Set());
		const port = await handshake();
		const received: unknown[] = [];
		port.onmessage = (event: MessageEvent) => {
			received.push(event.data);
		};
		await tick();
		received.length = 0;
		// The companion document's own load, then a navigation.
		iframe.dispatchEvent(new Event("load"));
		expect(iframe.getAttribute("srcdoc")).toBe(SRCDOC);
		iframe.dispatchEvent(new Event("load"));
		expect(iframe.getAttribute("srcdoc")).toBeNull();
		expect(iframe.getAttribute("src")).toBe("about:blank");
		fakeWindow.emit(initialize, iframe.contentWindow);
		await tick();
		expect(received).toEqual([]);
		expect(mcpReplies()).toEqual([]);
	});
});
