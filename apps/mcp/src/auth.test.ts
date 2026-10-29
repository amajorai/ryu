import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	authBackendUrl,
	pollDeviceToken,
	requestDeviceCode,
	safeAuthBackendUrl,
	safeBrowserUrl,
} from "./auth.ts";

const previousAuthUrl = process.env.RYU_AUTH_URL;
const previousProfile = process.env.RYU_PROFILE;
const realFetch = globalThis.fetch;

const restoreEnv = (name: string, value: string | undefined): void => {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
};

afterEach(() => {
	restoreEnv("RYU_AUTH_URL", previousAuthUrl);
	restoreEnv("RYU_PROFILE", previousProfile);
	globalThis.fetch = realFetch;
});

describe("MCP authentication target", () => {
	test("defaults to the hosted control plane for an installed bridge", () => {
		delete process.env.RYU_AUTH_URL;
		delete process.env.RYU_PROFILE;
		expect(authBackendUrl()).toBe("https://api.ryuhq.com");
		process.env.RYU_PROFILE = "nightly";
		expect(authBackendUrl()).toBe("https://api.ryuhq.com");
	});

	test("defaults to the local control plane under the dev profile", () => {
		delete process.env.RYU_AUTH_URL;
		process.env.RYU_PROFILE = " Dev ";
		expect(authBackendUrl()).toBe("http://localhost:3000");
	});

	test("trims an explicit control-plane URL over the profile default", () => {
		process.env.RYU_PROFILE = "dev";
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
		globalThis.fetch = Object.assign(
			(
				url: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1]
			) => {
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
			},
			{
				preconnect: (...args: Parameters<typeof realFetch.preconnect>) =>
					realFetch.preconnect(...args),
			}
		);

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
		globalThis.fetch = Object.assign(
			() =>
				Promise.resolve(
					Response.json({
						device_code: "device-secret",
						expires_in: 999_999,
						interval: 999_999,
						user_code: "ABCD-1234",
					})
				),
			{
				preconnect: (...args: Parameters<typeof realFetch.preconnect>) =>
					realFetch.preconnect(...args),
			}
		);

		const result = await requestDeviceCode("https://auth.example");

		expect(result.expiresIn).toBe(3600);
		expect(result.interval).toBe(60);
	});

	test("polls Better Auth for the user session token", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = Object.assign(
			(
				url: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1]
			) => {
				capturedUrl = String(url);
				capturedInit = init;
				return Promise.resolve(
					Response.json({ access_token: "session-token" })
				);
			},
			{
				preconnect: (...args: Parameters<typeof realFetch.preconnect>) =>
					realFetch.preconnect(...args),
			}
		);

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

function installDeviceReply(
	body: Parameters<typeof Response.json>[0],
	status = 200
) {
	globalThis.fetch = Object.assign(
		() => Promise.resolve(Response.json(body, { status })),
		{
			preconnect: (...args: Parameters<typeof realFetch.preconnect>) =>
				realFetch.preconnect(...args),
		}
	);
}

const currentDeviceReply = {
	device_code: "device-secret",
	user_code: "ABCD-1234",
	verification_uri: "https://ryu.example/device",
	verification_uri_complete: "https://ryu.example/device?user_code=ABCD-1234",
	expires_in: 900,
	interval: 5,
};

const currentTokenReply = {
	access_token: "session-token",
	token_type: "Bearer",
	expires_in: 900,
	scope: "openid profile email",
};

describe("MCP public device response boundary", () => {
	test("projects the full published device reply and retains native defaults", async () => {
		installDeviceReply({
			...currentDeviceReply,
			future_metadata: { retained: true },
		});
		await expect(requestDeviceCode("https://auth.example")).resolves.toEqual({
			backendUrl: "https://auth.example",
			deviceCode: "device-secret",
			userCode: "ABCD-1234",
			verificationUri: "https://ryu.example/device",
			verificationUriComplete: "https://ryu.example/device?user_code=ABCD-1234",
			expiresIn: 900,
			interval: 5,
		});
	});

	test("preserves code-only legacy browser and timing defaults", async () => {
		installDeviceReply({
			device_code: "device-secret",
			user_code: "ABCD-1234",
		});
		const result = await requestDeviceCode("https://auth.example");
		expect(result.verificationUri).toBe("https://auth.example/device");
		expect(result.verificationUriComplete).toBe("https://auth.example/device");
		expect(result.expiresIn).toBe(900);
		expect(result.interval).toBe(5);
	});

	test("preserves malformed optional hint fallbacks and rejects unsafe URLs", async () => {
		installDeviceReply({
			...currentDeviceReply,
			verification_uri: { url: "https://ryu.example/device" },
			verification_uri_complete: "javascript:alert(1)",
			expires_in: "900",
			interval: null,
		});
		const result = await requestDeviceCode("https://auth.example");
		expect(result.verificationUri).toBe("https://auth.example/device");
		expect(result.verificationUriComplete).toBe("https://auth.example/device");
		expect(result.expiresIn).toBe(900);
		expect(result.interval).toBe(5);
	});

	test.each([
		[null],
		[[]],
		[{ ...currentDeviceReply, device_code: "" }],
		[{ ...currentDeviceReply, user_code: false }],
	])("rejects malformed required device codes as invalid replies", async (body) => {
		installDeviceReply(body);
		await expect(requestDeviceCode("https://auth.example")).rejects.toThrow(
			"Better Auth returned an invalid device code response"
		);
	});

	test("keeps raw non-ok HTTP error coercion before success-body admission", async () => {
		installDeviceReply({ error: { detail: "raw legacy error" } }, 400);
		await expect(requestDeviceCode("https://auth.example")).rejects.toThrow(
			"Device code request failed (400): [object Object]"
		);
		installDeviceReply({ error: { toString: "not callable" } }, 400);
		await expect(
			requestDeviceCode("https://auth.example")
		).rejects.toBeInstanceOf(TypeError);
	});

	test("accepts the full native token reply and legacy malformed metadata", async () => {
		installDeviceReply(currentTokenReply);
		await expect(
			pollDeviceToken("https://auth.example", "device-secret", 0.001, 900)
		).resolves.toBe("session-token");
		installDeviceReply({
			...currentTokenReply,
			token_type: null,
			expires_in: [],
			scope: false,
		});
		await expect(
			pollDeviceToken("https://auth.example", "device-secret", 0.001, 900)
		).resolves.toBe("session-token");
	});

	test.each([
		{
			error: "access_denied",
			message: "Access denied. You declined the sign-in request.",
		},
		{
			error: "expired_token",
			message: "The sign-in request expired. Please try again.",
		},
		{
			error: "unexpected_device_failure",
			message: "Sign-in failed: unexpected_device_failure",
		},
	])("preserves raw terminal poll errors", async ({ error, message }) => {
		installDeviceReply({ error, error_description: "native description" }, 400);
		await expect(
			pollDeviceToken("https://auth.example", "device-secret", 0.001, 900)
		).rejects.toThrow(message);
	});

	test("continues an invalid-token authorization-pending reply before success", async () => {
		let attempts = 0;
		globalThis.fetch = Object.assign(
			() =>
				Promise.resolve(
					Response.json(
						++attempts === 1
							? { access_token: false, error: "authorization_pending" }
							: currentTokenReply
					)
				),
			{
				preconnect: (...args: Parameters<typeof realFetch.preconnect>) =>
					realFetch.preconnect(...args),
			}
		);
		await expect(
			pollDeviceToken("https://auth.example", "device-secret", 0.001, 900)
		).resolves.toBe("session-token");
		expect(attempts).toBe(2);
	});

	test("preserves the native slow-down retry branch", async () => {
		let attempts = 0;
		globalThis.fetch = Object.assign(
			() =>
				Promise.resolve(
					Response.json(
						++attempts === 1
							? { error: "slow_down", error_description: "Please wait" }
							: currentTokenReply
					)
				),
			{
				preconnect: (...args: Parameters<typeof realFetch.preconnect>) =>
					realFetch.preconnect(...args),
			}
		);
		await expect(
			pollDeviceToken("https://auth.example", "device-secret", 0.001, 900)
		).resolves.toBe("session-token");
		expect(attempts).toBe(2);
	}, 10_000);
});

test("device boundary diagnostics do not invoke global Zod error formatting", async () => {
	const previousCustomError = z.config().customError;
	let formattingCalls = 0;
	z.config({
		customError: () => {
			formattingCalls += 1;
			throw new Error("Unexpected ambient formatter");
		},
	});
	try {
		installDeviceReply({
			...currentDeviceReply,
			verification_uri: {},
			expires_in: "900",
		});
		await expect(
			requestDeviceCode("https://auth.example")
		).resolves.toMatchObject({
			verificationUri: "https://auth.example/device",
			expiresIn: 900,
		});
		installDeviceReply({ ...currentDeviceReply, device_code: "" });
		await expect(requestDeviceCode("https://auth.example")).rejects.toThrow(
			"Better Auth returned an invalid device code response"
		);
		installDeviceReply(null);
		await expect(requestDeviceCode("https://auth.example")).rejects.toThrow(
			"Better Auth returned an invalid device code response"
		);
		expect(formattingCalls).toBe(0);
	} finally {
		z.config({ customError: previousCustomError });
	}
});
