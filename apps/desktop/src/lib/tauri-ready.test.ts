// apps/desktop/src/lib/tauri-ready.test.ts
//
// The gate's whole reason to exist is the ORDERING case: a call issued before
// Tauri injected `window.__TAURI_INTERNALS__` must queue and resolve once the
// bridge arrives, rather than rejecting with the TypeError that production
// recorded 88 times. A vite build cannot prove that; only this can.
//
// `window` does not exist under `bun test`, so each case installs a fake one and
// drives `__TAURI_INTERNALS__` by hand — which is exactly the object the real
// `@tauri-apps/api` reaches into (`invoke()` is
// `window.__TAURI_INTERNALS__.invoke(...)`), so the module under test is
// exercised against the REAL Tauri client, not a stand-in for it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppResponseValue } from "@ryuhq/core-client/app-request-json.ts";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { z } from "zod";
import { syncGatewayProviderKey } from "./api/secrets.ts";
import {
	invokeWhenReady,
	isTauriReady,
	listenWhenReady,
	resetTauriGateForTests,
	TauriUnavailableError,
	withTauri,
} from "./tauri-ready.ts";

interface FakeInternals {
	invoke: (cmd: string, args?: InvokeArgs) => Promise<AppResponseValue>;
	transformCallback: () => number;
	unregisterCallback?: (id: number) => void;
}

interface BridgeWindowFixture {
	__TAURI_INTERNALS__?: Partial<FakeInternals>;
}
let bridgeWindow: BridgeWindowFixture = {};
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"window"
);
const unavailableErrorSchema = z.instanceof(TauriUnavailableError);

/** A stand-in for what Tauri injects. `invoke` records the calls it saw so a test
 *  can assert the bounded retry fired exactly once. */
function makeInternals(
	respond: (cmd: string, args?: InvokeArgs) => Promise<AppResponseValue>
) {
	const calls: string[] = [];
	return {
		calls,
		internals: {
			invoke: (cmd: string, args?: InvokeArgs) => {
				calls.push(cmd);
				return respond(cmd, args);
			},
			// The event API funnels its handler through this before invoking
			// `plugin:event|listen`; a number id is all it needs back.
			transformCallback: () => 1,
			unregisterCallback: () => undefined,
		},
	};
}

beforeEach(() => {
	resetTauriGateForTests();
	bridgeWindow = {};
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		writable: true,
		value: bridgeWindow,
	});
});

afterEach(() => {
	resetTauriGateForTests();
	if (originalWindowDescriptor) {
		Object.defineProperty(globalThis, "window", originalWindowDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, "window");
	}
});

describe("Gateway keychain mirror", () => {
	test("browser saves and removal succeed after Core persistence without a desktop bridge", async () => {
		await expect(
			syncGatewayProviderKey("huggingface", "test-key")
		).resolves.toBeUndefined();
		await expect(
			syncGatewayProviderKey("huggingface", null)
		).resolves.toBeUndefined();
	});
	test("desktop saves and removal reach the native credential store", async () => {
		const seen: { cmd: string; args?: InvokeArgs }[] = [];
		const { internals } = makeInternals(async (cmd, args) => {
			seen.push({ cmd, args });
			return undefined;
		});
		bridgeWindow.__TAURI_INTERNALS__ = internals;
		await syncGatewayProviderKey("huggingface", "test-key");
		await syncGatewayProviderKey("huggingface", null);
		expect(seen).toEqual([
			{
				cmd: "set_provider_key",
				args: { provider: "huggingface", key: "test-key" },
			},
			{ cmd: "delete_provider_key", args: { provider: "huggingface" } },
		]);
	});
	test("real desktop storage failures are reported", async () => {
		const failure = new Error("credential store denied access");
		const { internals } = makeInternals(() => Promise.reject(failure));
		bridgeWindow.__TAURI_INTERNALS__ = internals;
		await expect(
			syncGatewayProviderKey("huggingface", "test-key")
		).rejects.toBe(failure);
	});
});

describe("isTauriReady", () => {
	test("is false until the bridge is injected, true after", () => {
		expect(isTauriReady()).toBe(false);
		const { internals } = makeInternals(() => Promise.resolve(null));
		bridgeWindow.__TAURI_INTERNALS__ = internals;
		expect(isTauriReady()).toBe(true);
	});

	test("rejects a partial bridge that cannot register event callbacks", () => {
		bridgeWindow.__TAURI_INTERNALS__ = {
			invoke: async () => null,
		};
		expect(isTauriReady()).toBe(false);
	});
});

describe("invokeWhenReady", () => {
	test("passes straight through when the bridge is already there", async () => {
		const { internals, calls } = makeInternals(() => Promise.resolve("ok"));
		bridgeWindow.__TAURI_INTERNALS__ = internals;

		await expect(invokeWhenReady<string>("get_ryu_status")).resolves.toBe("ok");
		expect(calls).toEqual(["get_ryu_status"]);
	});

	test("QUEUES a call made before the bridge exists and resolves once it lands", async () => {
		const { internals, calls } = makeInternals(() =>
			Promise.resolve({ nodes: [], default: "local" })
		);

		// Issued with no bridge at all — this is the boot race the gate exists for.
		const pending = invokeWhenReady<{
			default: string;
			nodes: AppResponseValue[];
		}>("list_nodes");

		// Tauri injects a beat later, exactly as a slow cold start does.
		setTimeout(() => {
			bridgeWindow.__TAURI_INTERNALS__ = internals;
		}, 60);

		await expect(pending).resolves.toEqual({ nodes: [], default: "local" });
		// One bounded retry: the pre-bridge attempt never reached `internals`.
		expect(calls).toEqual(["list_nodes"]);
	});

	test("rejects with a typed error, not a TypeError, when the bridge never arrives", async () => {
		let caught: TauriUnavailableError | undefined;
		try {
			await invokeWhenReady("list_nodes");
		} catch (error) {
			caught = unavailableErrorSchema.parse(error);
		}
		expect(caught).toBeInstanceOf(TauriUnavailableError);
		expect(caught?.target).toBe("list_nodes");
	});

	test("does NOT retry or swallow a genuine failure once the bridge is present", async () => {
		const { internals, calls } = makeInternals((cmd) =>
			Promise.reject(new Error(`command ${cmd} blew up`))
		);
		bridgeWindow.__TAURI_INTERNALS__ = internals;

		await expect(invokeWhenReady("add_node")).rejects.toThrow(
			"command add_node blew up"
		);
		expect(calls).toEqual(["add_node"]);
	});
});

describe("listenWhenReady", () => {
	test("degrades to a no-op unlisten outside Tauri instead of rejecting", async () => {
		const unlisten = await listenWhenReady("nodes-changed", () => undefined);
		expect(z.function().safeParse(unlisten).success).toBe(true);
		// Calling it must be safe — App.tsx tears these down on unmount.
		expect(() => unlisten()).not.toThrow();
	});

	test("subscribes once the bridge arrives late", async () => {
		const { internals, calls } = makeInternals(() => Promise.resolve(7));

		const pending = listenWhenReady("core-install-progress", () => undefined);
		setTimeout(() => {
			bridgeWindow.__TAURI_INTERNALS__ = internals;
		}, 60);

		const unlisten = await pending;
		expect(z.function().safeParse(unlisten).success).toBe(true);
		expect(calls).toEqual(["plugin:event|listen"]);
	});

	test("swallows stale event-plugin teardown failures", async () => {
		const { internals } = makeInternals(() => Promise.resolve(7));
		bridgeWindow.__TAURI_INTERNALS__ = internals;

		const unlisten = await listenWhenReady(
			"core-install-progress",
			() => undefined
		);
		// The event plugin can disappear first while the core bridge still exists.
		expect(() => unlisten()).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});

describe("withTauri", () => {
	test("resolves null outside Tauri rather than throwing the raw TypeError", async () => {
		const result = await withTauri(() => {
			// What `getCurrentWebviewWindow()` does outside Tauri.
			if (!bridgeWindow.__TAURI_INTERNALS__) {
				throw new TypeError("window.__TAURI_INTERNALS__ is unavailable");
			}
			return "unreachable";
		});
		expect(result).toBeNull();
	});

	test("propagates a real error untouched", async () => {
		await expect(
			withTauri(() => {
				throw new Error("not a bridge problem");
			})
		).rejects.toThrow("not a bridge problem");
	});
});
