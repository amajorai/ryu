import { describe, expect, it } from "bun:test";
import type { IncomingMessage } from "node:http";
import {
	isControlAction,
	isJsonRequest,
	isTrustedLocalRequest,
	parseGhostCursorEvent,
	resolveControlPort,
} from "./control-protocol.ts";

// The loopback control server's security-relevant guards. Extracted from
// control.ts so they can be exercised with plain header/body objects and no
// Electron, sockets, or ghost-cursor overlay. Mirrors the browser sidecar's
// control.test.ts.

function reqWith(headers: Record<string, string | undefined>): IncomingMessage {
	return { headers } as unknown as IncomingMessage;
}

describe("resolveControlPort", () => {
	it("honours an explicit ISLAND_CONTROL_PORT over the profile", () => {
		expect(
			resolveControlPort({
				ISLAND_CONTROL_PORT: "9999",
				RYU_PROFILE: "dev",
			} as NodeJS.ProcessEnv)
		).toBe(9999);
	});

	it("shifts the base by +1000 in the dev profile", () => {
		expect(
			resolveControlPort({ RYU_PROFILE: "dev" } as NodeJS.ProcessEnv)
		).toBe(8989);
		// Case-insensitive + trimmed.
		expect(
			resolveControlPort({ RYU_PROFILE: "  DEV  " } as NodeJS.ProcessEnv)
		).toBe(8989);
	});

	it("uses the release base for release/empty/other profiles", () => {
		expect(resolveControlPort({} as NodeJS.ProcessEnv)).toBe(7989);
		expect(
			resolveControlPort({ RYU_PROFILE: "release" } as NodeJS.ProcessEnv)
		).toBe(7989);
		// A non-dev profile name is not treated as dev.
		expect(
			resolveControlPort({ RYU_PROFILE: "auditsmoke" } as NodeJS.ProcessEnv)
		).toBe(7989);
	});

	it("ignores a non-numeric or non-positive explicit port", () => {
		expect(
			resolveControlPort({ ISLAND_CONTROL_PORT: "abc" } as NodeJS.ProcessEnv)
		).toBe(7989);
		expect(
			resolveControlPort({ ISLAND_CONTROL_PORT: "0" } as NodeJS.ProcessEnv)
		).toBe(7989);
		expect(
			resolveControlPort({ ISLAND_CONTROL_PORT: "-5" } as NodeJS.ProcessEnv)
		).toBe(7989);
	});
});

describe("isControlAction", () => {
	it("accepts exactly the four window/lifecycle actions", () => {
		for (const action of ["toggle", "show", "hide", "quit"]) {
			expect(isControlAction(action)).toBe(true);
		}
	});

	it("rejects unknown strings and non-strings", () => {
		expect(isControlAction("restart")).toBe(false);
		expect(isControlAction("")).toBe(false);
		expect(isControlAction(null)).toBe(false);
		expect(isControlAction(undefined)).toBe(false);
		expect(isControlAction(42)).toBe(false);
		expect(isControlAction({ action: "show" })).toBe(false);
	});
});

describe("isTrustedLocalRequest (CSRF / DNS-rebind gate)", () => {
	const PORT = 7989;
	const trusted = (headers: Record<string, string | undefined>) =>
		isTrustedLocalRequest(reqWith(headers), PORT);

	it("rejects any non-empty Origin header (browser CSRF)", () => {
		expect(
			trusted({ origin: "https://evil.example", host: `127.0.0.1:${PORT}` })
		).toBe(false);
		// Even the opaque "null" origin is a real, non-empty Origin -> hostile.
		expect(trusted({ origin: "null", host: `127.0.0.1:${PORT}` })).toBe(false);
	});

	it("rejects a non-loopback or missing Host (DNS rebinding)", () => {
		expect(trusted({ host: `attacker.example:${PORT}` })).toBe(false);
		expect(trusted({ host: "127.0.0.1:9999" })).toBe(false);
		expect(trusted({})).toBe(false);
	});

	it("accepts a plain local request naming the exact loopback endpoint", () => {
		expect(trusted({ host: `127.0.0.1:${PORT}` })).toBe(true);
		expect(trusted({ host: `localhost:${PORT}` })).toBe(true);
		// An empty Origin string is treated as absent (legitimate local callers).
		expect(trusted({ origin: "", host: `127.0.0.1:${PORT}` })).toBe(true);
	});

	it("binds the check to the resolved port, not a hardcoded default", () => {
		expect(
			isTrustedLocalRequest(reqWith({ host: "127.0.0.1:8989" }), 8989)
		).toBe(true);
		expect(
			isTrustedLocalRequest(reqWith({ host: "127.0.0.1:7989" }), 8989)
		).toBe(false);
	});
});

describe("isJsonRequest", () => {
	it("accepts application/json with or without parameters", () => {
		expect(isJsonRequest(reqWith({ "content-type": "application/json" }))).toBe(
			true
		);
		expect(
			isJsonRequest(
				reqWith({ "content-type": "application/json; charset=utf-8" })
			)
		).toBe(true);
		expect(
			isJsonRequest(
				reqWith({ "content-type": "Application/JSON;charset=UTF-8" })
			)
		).toBe(true);
	});

	it("rejects missing or non-JSON content types", () => {
		expect(isJsonRequest(reqWith({}))).toBe(false);
		expect(isJsonRequest(reqWith({ "content-type": "" }))).toBe(false);
		expect(isJsonRequest(reqWith({ "content-type": "text/plain" }))).toBe(
			false
		);
		// A text/plain "simple request" that dodges CORS preflight is rejected.
		expect(
			isJsonRequest(reqWith({ "content-type": "text/plain;charset=UTF-8" }))
		).toBe(false);
	});
});

describe("parseGhostCursorEvent", () => {
	it("parses a well-formed event and threads in the agent id", () => {
		const event = parseGhostCursorEvent(
			JSON.stringify({
				seq: 7,
				phase: "move",
				x: 100,
				y: 200,
				tool: "click",
				ts: 1234,
			}),
			"4321"
		);
		expect(event).toEqual({
			seq: 7,
			phase: "move",
			x: 100,
			y: 200,
			tool: "click",
			ts: 1234,
			agent: "4321",
		});
	});

	it("defaults the optional numeric/string fields when absent", () => {
		const event = parseGhostCursorEvent(
			JSON.stringify({ phase: "down", x: 1, y: 2 }),
			"0"
		);
		expect(event).toEqual({
			seq: 0,
			phase: "down",
			x: 1,
			y: 2,
			tool: "",
			ts: 0,
			agent: "0",
		});
	});

	it("accepts every known phase", () => {
		for (const phase of ["move", "down", "up", "type", "scroll", "done"]) {
			const event = parseGhostCursorEvent(
				JSON.stringify({ phase, x: 0, y: 0 }),
				"1"
			);
			expect(event?.phase).toBe(phase as never);
		}
	});

	it("rejects an unknown phase", () => {
		expect(
			parseGhostCursorEvent(
				JSON.stringify({ phase: "wiggle", x: 0, y: 0 }),
				"1"
			)
		).toBeNull();
	});

	it("rejects missing or non-numeric coordinates", () => {
		expect(
			parseGhostCursorEvent(JSON.stringify({ phase: "move", y: 0 }), "1")
		).toBeNull();
		expect(
			parseGhostCursorEvent(
				JSON.stringify({ phase: "move", x: "10", y: 0 }),
				"1"
			)
		).toBeNull();
	});

	it("rejects malformed JSON, empty bodies, and non-objects", () => {
		expect(parseGhostCursorEvent("{not json", "1")).toBeNull();
		expect(parseGhostCursorEvent("", "1")).toBeNull();
		expect(parseGhostCursorEvent("null", "1")).toBeNull();
		expect(parseGhostCursorEvent("42", "1")).toBeNull();
		expect(parseGhostCursorEvent('"a string"', "1")).toBeNull();
	});
});
