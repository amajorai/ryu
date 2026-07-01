/**
 * Unit tests for the gateway-mandatory model client (TS layer).
 *
 * The transport is now the Rust core (`@ryuhq/sdk-native` → `crates/ryu-sdk`), so
 * the wire-shape and SSE-parsing assertions live in the Rust crate's tests
 * (`cargo test -p ryu-sdk`) — they cannot be exercised here by mocking JS
 * `fetch`, because the native client uses reqwest, not `fetch`. These tests
 * cover what the TS layer is responsible for: egress enforcement (delegated to
 * Rust), the public client/factory shape, and base-URL/model resolution.
 */

import { describe, expect, it } from "bun:test";
import { defineModel } from "./client.ts";
import { assertAllowedEgressUrl } from "./gateway.ts";

// Top-level regex constant (avoids lint/performance/useTopLevelRegex)
const RE_EGRESS_BLOCKED = /egress is not allowed/i;

const MOCK_GATEWAY = "http://127.0.0.1:7981";

// ── Egress enforcement (delegated to the Rust core) ───────────────────────────

describe("egress enforcement", () => {
	it("rejects api.openai.com as a base URL", () => {
		expect(() =>
			defineModel("gpt-4o", { baseUrl: "https://api.openai.com/v1" })
		).toThrow(RE_EGRESS_BLOCKED);
	});

	it("rejects api.anthropic.com as a base URL", () => {
		expect(() =>
			defineModel("claude-3-5-sonnet", {
				baseUrl: "https://api.anthropic.com/v1",
			})
		).toThrow(RE_EGRESS_BLOCKED);
	});

	it("rejects generativelanguage.googleapis.com", () => {
		expect(() =>
			defineModel("gemini-2.5-flash", {
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			})
		).toThrow(RE_EGRESS_BLOCKED);
	});

	it("rejects openrouter.ai", () => {
		expect(() =>
			defineModel("gpt-4o", { baseUrl: "https://openrouter.ai/api/v1" })
		).toThrow(RE_EGRESS_BLOCKED);
	});

	it("allows a loopback gateway URL", () => {
		expect(() =>
			defineModel("gpt-4o", { baseUrl: "http://127.0.0.1:7981" })
		).not.toThrow();
	});

	it("allows localhost gateway URL", () => {
		expect(() =>
			defineModel("gpt-4o", { baseUrl: "http://localhost:7981" })
		).not.toThrow();
	});

	it("assertAllowedEgressUrl throws on direct provider URL", () => {
		expect(() => assertAllowedEgressUrl("https://api.openai.com/v1")).toThrow(
			RE_EGRESS_BLOCKED
		);
	});

	it("assertAllowedEgressUrl passes for loopback", () => {
		expect(() => assertAllowedEgressUrl("http://127.0.0.1:7981")).not.toThrow();
	});
});

// ── Client / factory shape ────────────────────────────────────────────────────

describe("ModelClient shape", () => {
	it("exposes chat() and stream() backed by the native core", () => {
		const client = defineModel("gpt-4o", { baseUrl: MOCK_GATEWAY });
		expect(typeof client.chat).toBe("function");
		expect(typeof client.stream).toBe("function");
	});

	it("reports the configured model id", () => {
		const client = defineModel("claude-3-5-sonnet", { baseUrl: MOCK_GATEWAY });
		expect(client.model).toBe("claude-3-5-sonnet");
	});
});

// ── defineModel factory ───────────────────────────────────────────────────────

describe("defineModel", () => {
	it("returns a ModelClient with the given model id", () => {
		const client = defineModel("claude-3-5-sonnet", { baseUrl: MOCK_GATEWAY });
		expect(client.model).toBe("claude-3-5-sonnet");
	});

	it("uses the default gateway URL when no baseUrl is given", () => {
		const prev = process.env.RYU_GATEWAY_URL;
		process.env.RYU_GATEWAY_URL = "";

		const client = defineModel("gpt-4o");
		expect(client.baseUrl).toBe("http://127.0.0.1:7981");

		process.env.RYU_GATEWAY_URL = prev ?? "";
	});
});
