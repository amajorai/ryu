import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	deviceLimitReachedMessage,
	deviceSurfaceScopeToken,
} from "@ryu/auth/lib/device-limits";

GlobalRegistrator.register();
const {
	DEVICE_LIMIT_GENERIC_MESSAGE,
	DeviceLimitReachedError,
	deviceCodeScope,
	deviceLimitSignInMessage,
} = await import("./device-limit-error.ts");
const { pollAuthStatus, SIGN_IN_TIMED_OUT_MESSAGE, startDeviceAuth } =
	await import("./oauth.ts");
const fetchSpy = spyOn(globalThis, "fetch");

afterEach(() => {
	fetchSpy.mockReset();
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});
afterAll(() => {
	fetchSpy.mockRestore();
	GlobalRegistrator.unregister();
});

const refusalBody = {
	code: "DEVICE_LIMIT_REACHED",
	error: "device_limit_reached",
	error_description: "server sentence",
	limit: 5,
	message: "server sentence",
	surface: "desktop",
};

test("a full refusal body maps to the contract sentence for its surface and cap", () => {
	expect(deviceLimitSignInMessage(refusalBody)).toBe(
		deviceLimitReachedMessage("desktop", 5)
	);
	const error = new DeviceLimitReachedError(refusalBody);
	expect(error.message).toBe(deviceLimitReachedMessage("desktop", 5));
	expect(error.surface).toBe("desktop");
	expect(error.limit).toBe(5);
});

test("a refusal naming only one of surface and cap carries neither", () => {
	for (const body of [
		"device_limit_reached",
		{ error: "device_limit_reached", limit: 5 },
		{ error: "device_limit_reached", surface: "desktop" },
	]) {
		const error = new DeviceLimitReachedError(body);
		expect(error.message).toBe(DEVICE_LIMIT_GENERIC_MESSAGE);
		expect(error.surface).toBeNull();
		expect(error.limit).toBeNull();
	}
});

test("a bare or partial refusal falls back to the generic sentence", () => {
	expect(deviceLimitSignInMessage("device_limit_reached")).toBe(
		DEVICE_LIMIT_GENERIC_MESSAGE
	);
	expect(deviceLimitSignInMessage({ error: "device_limit_reached" })).toBe(
		DEVICE_LIMIT_GENERIC_MESSAGE
	);
	expect(deviceLimitSignInMessage({ ...refusalBody, surface: "toaster" })).toBe(
		DEVICE_LIMIT_GENERIC_MESSAGE
	);
});

test("other device-token errors are not device-limit refusals", () => {
	for (const body of [
		{ error: "access_denied" },
		{ error: "authorization_pending" },
		{ access_token: "token" },
		null,
		"expired_token",
	]) {
		expect(deviceLimitSignInMessage(body)).toBeNull();
	}
});

test("only a declared surface adds its scope token", () => {
	expect(deviceCodeScope("openid profile email", null)).toBe(
		"openid profile email"
	);
	expect(deviceCodeScope("openid profile email", "desktop")).toBe(
		`openid profile email ${deviceSurfaceScopeToken("desktop")}`
	);
	expect(deviceCodeScope("openid profile email", "web")).toBe(
		`openid profile email ${deviceSurfaceScopeToken("web")}`
	);
});

const deviceCode = {
	device_code: "device-code",
	user_code: "USER-CODE",
	interval: 5,
	expires_in: 900,
};

async function requestedScope(): Promise<unknown> {
	fetchSpy.mockResolvedValue(Response.json(deviceCode));
	await startDeviceAuth("http://localhost:3000");
	const init = fetchSpy.mock.calls[0]?.[1];
	return JSON.parse(String(init?.body)).scope;
}

test("the Tauri app declares the desktop surface when requesting a device code", async () => {
	Reflect.set(window, "__TAURI_INTERNALS__", {
		invoke: () => undefined,
		transformCallback: () => 0,
	});
	expect(await requestedScope()).toBe(
		`openid profile email ${deviceSurfaceScopeToken("desktop")}`
	);
});

test("the hosted webapp build declares the web surface", async () => {
	const previousSurface = process.env.VITE_RYU_SURFACE;
	process.env.VITE_RYU_SURFACE = "webapp";
	try {
		expect(await requestedScope()).toBe(
			`openid profile email ${deviceSurfaceScopeToken("web")}`
		);
	} finally {
		if (previousSurface === undefined) {
			Reflect.deleteProperty(process.env, "VITE_RYU_SURFACE");
		} else {
			process.env.VITE_RYU_SURFACE = previousSurface;
		}
	}
});

test("a browser build without the Tauri bridge declares no surface", async () => {
	expect(await requestedScope()).toBe("openid profile email");
});

test("polling stops on a device-limit refusal and reports its sentence, not a timeout", async () => {
	fetchSpy.mockResolvedValue(Response.json(refusalBody, { status: 403 }));
	const outcome = await new Promise<Error>((resolve, reject) => {
		pollAuthStatus(
			{
				backendUrl: "http://localhost:3000",
				deviceCode: "device-code",
				expiresIn: 900,
				interval: 5,
				userCode: "USER-CODE",
				verificationUri: "http://localhost:3000/device",
				verificationUriComplete: "http://localhost:3000/device",
			},
			() => reject(new Error("unexpected token")),
			resolve
		);
	});
	expect(outcome).toBeInstanceOf(DeviceLimitReachedError);
	expect(outcome.message).toBe(deviceLimitReachedMessage("desktop", 5));
	expect(outcome.message).not.toBe(SIGN_IN_TIMED_OUT_MESSAGE);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
}, 15_000);
