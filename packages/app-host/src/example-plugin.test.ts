// Unit tests for the built-in example plugin's srcdoc builder. It is a fixture
// (used to prove the extension-host loop end to end), but the nonce interpolation
// is security-relevant: the host-generated nonce is JSON-encoded into the frame's
// script and echoed in the "ready" handshake the host verifies. DOM-free — the
// builder returns a plain HTML string.

import { describe, expect, it } from "bun:test";
import { examplePluginSrcdoc } from "./example-plugin.ts";
import { HOST_API_VERSION } from "./rpc.ts";
import { livenessResponderScript } from "./sandbox-liveness-gate.ts";

describe("examplePluginSrcdoc", () => {
	it("bakes the exact nonce into the ready handshake and the host-port guard", () => {
		const doc = examplePluginSrcdoc("nonce-abc123");
		expect(doc).toStartWith("<!doctype html>");
		expect(doc).toContain("ryuInstallHorizontalWheelScrolling");
		// The frame announces readiness echoing the nonce…
		expect(doc).toContain('{ kind: "ryu-plugin-ready", nonce: NONCE');
		// …and accepts the transferred port ONLY when the message carries that nonce.
		expect(doc).toContain(
			'msg.kind !== "ryu-plugin-host-port" || msg.nonce !== NONCE'
		);
		expect(doc).toContain('var NONCE = "nonce-abc123";');
	});

	it("advertises the current HOST_API_VERSION in the handshake", () => {
		const doc = examplePluginSrcdoc("n");
		expect(doc).toContain(
			`hostApiVersion: ${JSON.stringify(HOST_API_VERSION)}`
		);
	});

	it("JSON-encodes the nonce so a quote-bearing value cannot break out of the string literal", () => {
		// The nonce is host-generated (crypto.randomUUID) in production, but the builder
		// must still encode it safely — a raw `"; …` value would otherwise inject script.
		const doc = examplePluginSrcdoc('evil"; alert(1); var x="');
		expect(doc).toContain('var NONCE = "evil\\"; alert(1); var x=\\"";');
		// The raw (un-escaped) break-out sequence must NOT appear verbatim.
		expect(doc).not.toContain('var NONCE = "evil"; alert(1);');
	});

	it("only ever calls Core over the gated bridge (core.listAgents), never a raw fetch", () => {
		const doc = examplePluginSrcdoc("n");
		expect(doc).toContain('call("core.listAgents", [])');
		expect(doc).not.toContain("fetch(");
	});

	it("accepts the host's live appearance snapshot", () => {
		const doc = examplePluginSrcdoc("n", {
			"--background": "#101114",
			"--foreground": "#f5f5f5",
			"--ryu-theme-mode": "dark",
			"--ryu-ui-scale": "1.25",
		});
		expect(doc).toContain("--background: #101114;");
		expect(doc).toContain('"--ryu-theme-mode":"dark"');
		expect(doc).toContain("applyThemeTokens(msg.tokens)");
	});
});

describe("examplePluginSrcdoc liveness", () => {
	it("answers the host's liveness probe before handling RPC results", () => {
		const doc = examplePluginSrcdoc("nonce-abc123");
		const responderAt = doc.indexOf(livenessResponderScript());
		expect(responderAt).toBeGreaterThan(-1);
		expect(responderAt).toBeLessThan(
			doc.indexOf('if (msg.kind !== "ryu-plugin-rpc-result") return;')
		);
	});
});

describe("example plugin RPC settlement", () => {
	// The example is the pattern third-party frames copy, so it must reject a
	// structured `{ code, message }` error as well as a legacy string error.
	function settleBlock(): string {
		const doc = examplePluginSrcdoc("n");
		const start = doc.indexOf("if (msg.error !== undefined");
		const end = doc.indexOf("p.resolve(msg.result);", start);
		return `${doc.slice(start, end)}p.resolve(msg.result);\n}`;
	}

	function settle(msg: Record<string, unknown>) {
		const outcome: {
			rejected?: Error & { code?: unknown };
			resolved?: unknown;
		} = {};
		new Function("msg", "p", settleBlock())(msg, {
			reject: (error: Error) => {
				outcome.rejected = error;
			},
			resolve: (value: unknown) => {
				outcome.resolved = value;
			},
		});
		return outcome;
	}

	it("rejects a structured error instead of resolving it", () => {
		const { rejected, resolved } = settle({
			error: { code: "denied", message: "missing grant" },
		});
		expect(resolved).toBeUndefined();
		expect(rejected?.message).toBe("missing grant");
		expect(rejected?.code).toBe("denied");
	});

	it("rejects an empty string error instead of resolving it", () => {
		const { rejected, resolved } = settle({ error: "" });
		expect(resolved).toBeUndefined();
		expect(rejected?.message).toBe("error");
	});

	it("rejects a legacy string error and resolves a result", () => {
		expect(settle({ error: "nope" }).rejected?.message).toBe("nope");
		expect(settle({ result: 3 }).resolved).toBe(3);
	});
});
