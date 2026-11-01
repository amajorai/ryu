import { describe, expect, test } from "bun:test";
import {
	type DeviceLimitContext,
	deviceLimitRefusalError,
	failOpenPreCheck,
	stampDeviceLimitSession,
} from "./device-limit-plugin.ts";
import type { DeviceLimitPolicy } from "./device-limit-policy.ts";
import {
	DEVICE_LIMIT_DEFAULTS,
	DEVICE_LIMIT_REACHED_CODE,
} from "./device-limits.ts";

const enforcedPolicy = (): Promise<DeviceLimitPolicy> =>
	Promise.resolve({
		enforced: true,
		limits: { ...DEVICE_LIMIT_DEFAULTS, web: 1 },
	});

function brokenContext(failing: "sessions" | "user"): DeviceLimitContext {
	return {
		context: {
			adapter: {
				findMany: () =>
					failing === "sessions"
						? Promise.reject(new Error("session read failed"))
						: Promise.resolve([]),
				findOne: () => Promise.reject(new Error("device code read failed")),
			},
			internalAdapter: {
				findUserById: (id: string) =>
					failing === "user"
						? Promise.reject(new Error("user read failed"))
						: Promise.resolve({ id }),
			},
		},
		headers: new Headers(),
		path: "/sign-in/email",
	};
}

describe("device limits fail open", () => {
	test("a failed session count allows the sign-in and still stamps it", async () => {
		const data = await stampDeviceLimitSession(
			{ userId: "user-1" },
			brokenContext("sessions"),
			null,
			enforcedPolicy
		);
		expect(data.surface).toBe("web");
	});

	test("a failed user read allows the sign-in", async () => {
		const data = await stampDeviceLimitSession(
			{ userId: "user-1" },
			brokenContext("user"),
			null,
			enforcedPolicy
		);
		expect(data.surface).toBe("web");
	});

	test("a pre-check swallows read failures", async () => {
		await expect(
			failOpenPreCheck(() =>
				Promise.reject(new Error("device code read failed"))
			)
		).resolves.toBeUndefined();
	});

	test("a pre-check still rethrows a device-limit refusal", async () => {
		await expect(
			failOpenPreCheck(() =>
				Promise.reject(deviceLimitRefusalError("desktop", 5))
			)
		).rejects.toMatchObject({ body: { code: DEVICE_LIMIT_REACHED_CODE } });
	});
});
