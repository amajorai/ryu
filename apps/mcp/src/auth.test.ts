import { afterEach, describe, expect, test } from "bun:test";
import {
	authBackendUrl,
	pollDeviceToken,
	requestDeviceCode,
	safeAuthBackendUrl,
	safeBrowserUrl,
} from "./auth.ts";

const previousAuthUrl = process.env.RYU_AUTH_URL;
const realFetch = globalThis.fetch;

afterEach(() => {
	if (previousAuthUrl === undefined) {
		delete process.env.RYU_AUTH_URL;
	} else {
		process.env.RYU_AUTH_URL = previousAuthUrl;
	}
	globalThis.fetch = realFetch;
});

describe("MCP authentication target", () => {
	test("defaults to the local control plane", () => {
		delete process.env.RYU_AUTH_URL;
		expect(authBackendUrl()).toBe("http://localhost:3000");
	});

	test("trims an explicit control-plane URL", () => {
		process.env.RYU_AUTH_URL = "  https://account.example.test  ";
		expect(authBackendUrl()).toBe("https://account.example.test");
	});
});

describe("MCP device authentication", () => {
	test("allows HTTPS or loopback auth backends only", () => {
		expect(safeAuthBackendUrl("https://auth.example/")).toBe(
			"https://auth.example"
		);
		expect(safeAuthBackendUrl("http://127.0.0.1:3000/")).toBe(
			"http://127.0.0.1:3000"
		);
		expect(() => safeAuthBackendUrl("http://auth.example")).toThrow(
			/HTTPS unless it targets loopback/
		);
	});

	test("accepts only browser-safe HTTP(S) verification URLs", () => {
		expect(safeBrowserUrl("https://ryu.example/device?code=%22safe%22")).toBe(
			"https://ryu.example/device?code=%22safe%22"
		);
		expect(safeBrowserUrl("javascript:alert(1)")).toBeNull();
		expect(safeBrowserUrl("data:text/html,alert(1)")).toBeNull();
		expect(safeBrowserUrl("not a URL")).toBeNull();
	});

	test("requests the device code directly from Better Auth", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedInit = init;
			return Promise.resolve(
				Response.json({
					device_code: "device-secret",
					expires_in: 900,
					interval: 5,
					user_code: "ABCD-1234",
					verification_uri: "https://ryu.example/device",
					verification_uri_complete:
						"https://ryu.example/device?user_code=ABCD-1234",
				})
			);
		}) as unknown as typeof fetch;

		const result = await requestDeviceCode("https://auth.example");

		expect(capturedUrl).toBe("https://auth.example/api/auth/device/code");
		expect(capturedInit?.method).toBe("POST");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({
			client_id: "ryu-mcp",
			scope: "openid profile email",
		});
		expect(result.deviceCode).toBe("device-secret");
	});

	test("bounds server-provided device timing values", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				Response.json({
					device_code: "device-secret",
					expires_in: 999_999,
					interval: 999_999,
					user_code: "ABCD-1234",
				})
			)) as unknown as typeof fetch;

		const result = await requestDeviceCode("https://auth.example");

		expect(result.expiresIn).toBe(3600);
		expect(result.interval).toBe(60);
	});

	test("polls Better Auth for the user session token", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedInit = init;
			return Promise.resolve(Response.json({ access_token: "session-token" }));
		}) as unknown as typeof fetch;

		await expect(
			pollDeviceToken("https://auth.example", "device-secret", 5, 900)
		).resolves.toBe("session-token");
		expect(capturedUrl).toBe("https://auth.example/api/auth/device/token");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({
			client_id: "ryu-mcp",
			device_code: "device-secret",
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
	});
});
