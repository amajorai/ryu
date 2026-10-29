import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadToken, runWhoami, safeAuthBackendUrl } from "./auth.ts";
import { storedCredentialTokenObservationSchema } from "./credential-token-observation.ts";

function withCredential<Value>(raw: string, read: () => Value): Value {
	const directory = mkdtempSync(join(tmpdir(), "ryu-mcp-raw-credential-"));
	const file = join(directory, "credential.json");
	const previous = process.env.RYU_MCP_AUTH_FILE;
	writeFileSync(file, raw);
	process.env.RYU_MCP_AUTH_FILE = file;
	try {
		return read();
	} finally {
		if (previous === undefined) {
			delete process.env.RYU_MCP_AUTH_FILE;
		} else {
			process.env.RYU_MCP_AUTH_FILE = previous;
		}
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("MCP historical raw credential observation", () => {
	test("retains overflow, deep future metadata and own proto identities", () => {
		const deep = `${"[".repeat(15_000)}0${"]".repeat(15_000)}`;
		const raw = JSON.parse(
			`{"token":"raw-session","name":1e1000,"email":-1e1000,"future":${deep},"__proto__":{"kept":true}}`
		);
		const observed = storedCredentialTokenObservationSchema.parse(raw);
		expect(observed).toBe(raw);
		expect(observed.name).toBe(Number.POSITIVE_INFINITY);
		expect(observed.email).toBe(Number.NEGATIVE_INFINITY);
		expect(observed.future).toBe(raw.future);
		expect(Object.getOwnPropertyDescriptor(observed, "__proto__")?.value).toBe(
			raw.__proto__
		);
		expect(Object.getPrototypeOf(observed)).toBe(Object.prototype);
	});

	test("loads token-only and exponent-overflow files without filtering metadata", () => {
		withCredential('{"token":"raw-session"}', () => {
			expect(loadToken()?.token).toBe("raw-session");
		});
		withCredential(
			'{"token":"raw-session","name":1e1000,"future":{"kept":true}}',
			() => {
				const loaded = loadToken();
				expect(loaded?.name).toBe(Number.POSITIVE_INFINITY);
				expect(loaded?.future).toEqual({ kept: true });
			}
		);
	});

	test.each([
		[null],
		[[]],
		[{ token: "" }],
		[{ token: false }],
	])("refuses the same absent or invalid token (%j)", (value) => {
		expect(
			storedCredentialTokenObservationSchema.safeParse(value).success
		).toBe(false);
	});

	test("uses native URL coercion for legacy array metadata and native conversion failures", () => {
		const raw = JSON.parse(
			'{"backendUrl":["https://auth.example"],"invalid":{"toString":"not callable"}}'
		);
		expect(safeAuthBackendUrl(raw.backendUrl)).toBe("https://auth.example");
		expect(() => safeAuthBackendUrl(raw.invalid)).toThrow(TypeError);
	});

	test("retains cached name conversion failure after the actual HTTP refusal", async () => {
		let calls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				calls++;
				expect(new URL(request.url).pathname).toBe("/api/auth/get-session");
				expect(request.headers.get("Authorization")).toBe("Bearer raw-session");
				return Response.json({ error: "unauthorized" }, { status: 401 });
			},
		});
		const directory = mkdtempSync(join(tmpdir(), "ryu-mcp-raw-name-"));
		const previous = process.env.RYU_MCP_AUTH_FILE;
		const file = join(directory, "credential.json");
		writeFileSync(
			file,
			JSON.stringify({
				token: "raw-session",
				backendUrl: [server.url.origin],
				name: { toString: "not callable" },
			})
		);
		process.env.RYU_MCP_AUTH_FILE = file;
		try {
			await expect(runWhoami()).rejects.toBeInstanceOf(TypeError);
			expect(calls).toBe(1);
		} finally {
			if (previous === undefined) {
				delete process.env.RYU_MCP_AUTH_FILE;
			} else {
				process.env.RYU_MCP_AUTH_FILE = previous;
			}
			rmSync(directory, { recursive: true, force: true });
			server.stop(true);
		}
	});

	test("token/root refusals do not observe ambient Zod error formatting", () => {
		const previous = z.config().customError;
		let calls = 0;
		z.config({
			customError() {
				calls++;
				throw new Error("unexpected ambient formatter");
			},
		});
		try {
			expect(
				storedCredentialTokenObservationSchema.safeParse({ token: "" }).success
			).toBe(false);
			expect(
				storedCredentialTokenObservationSchema.safeParse(null).success
			).toBe(false);
			expect(
				storedCredentialTokenObservationSchema.safeParse({
					token: "t",
					name: Number.POSITIVE_INFINITY,
				}).success
			).toBe(true);
			expect(calls).toBe(0);
		} finally {
			z.config({ customError: previous });
		}
	});
});
