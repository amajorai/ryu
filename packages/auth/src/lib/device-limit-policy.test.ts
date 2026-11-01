import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	adapterSessionFinder,
	countLiveSessionsBySurfaceForUser,
	countUserSessionsBySurface,
	DEVICE_LIMIT_SESSION_SCAN_LIMIT,
	registerDeviceLimitPolicyResolver,
	resolveDeviceLimitPolicy,
} from "./device-limit-policy.ts";
import { DEVICE_LIMIT_DEFAULTS } from "./device-limits.ts";

afterEach(() => {
	registerDeviceLimitPolicyResolver(null);
});

function quietErrors() {
	return spyOn(console, "error").mockImplementation(() => undefined);
}

describe("resolveDeviceLimitPolicy", () => {
	test("is not enforced without a resolver", async () => {
		expect(await resolveDeviceLimitPolicy("user-1")).toEqual({
			enforced: false,
			limits: DEVICE_LIMIT_DEFAULTS,
		});
	});

	test("returns an enforced policy with sanitized limits", async () => {
		registerDeviceLimitPolicyResolver(async ({ userId }) => {
			expect(userId).toBe("user-1");
			return {
				enforced: true,
				limits: { ...DEVICE_LIMIT_DEFAULTS, cli: 2, desktop: -1, web: 1.5 },
			};
		});
		const policy = await resolveDeviceLimitPolicy("user-1");
		expect(policy.enforced).toBe(true);
		expect(policy.limits.cli).toBe(2);
		expect(policy.limits.desktop).toBe(DEVICE_LIMIT_DEFAULTS.desktop);
		expect(policy.limits.web).toBe(DEVICE_LIMIT_DEFAULTS.web);
	});

	test("a null or unenforced answer is not enforced", async () => {
		registerDeviceLimitPolicyResolver(async () => null);
		expect((await resolveDeviceLimitPolicy("user-1")).enforced).toBe(false);
		registerDeviceLimitPolicyResolver(async () => ({
			enforced: false,
			limits: DEVICE_LIMIT_DEFAULTS,
		}));
		expect((await resolveDeviceLimitPolicy("user-1")).enforced).toBe(false);
	});

	test("a failing lookup is not enforced and never throws", async () => {
		const errors = quietErrors();
		registerDeviceLimitPolicyResolver(() =>
			Promise.reject(new Error("flags down"))
		);
		expect((await resolveDeviceLimitPolicy("user-1")).enforced).toBe(false);
		registerDeviceLimitPolicyResolver(() => {
			throw new Error("sync failure");
		});
		expect((await resolveDeviceLimitPolicy("user-1")).enforced).toBe(false);
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});

	test("a slow lookup times out as not enforced", async () => {
		const errors = quietErrors();
		registerDeviceLimitPolicyResolver(
			() =>
				new Promise((resolve) => {
					setTimeout(
						() => resolve({ enforced: true, limits: DEVICE_LIMIT_DEFAULTS }),
						200
					);
				})
		);
		expect((await resolveDeviceLimitPolicy("user-1", 10)).enforced).toBe(false);
		errors.mockRestore();
	});

	test("an empty user id is not enforced", async () => {
		registerDeviceLimitPolicyResolver(async () => ({
			enforced: true,
			limits: DEVICE_LIMIT_DEFAULTS,
		}));
		expect((await resolveDeviceLimitPolicy("")).enforced).toBe(false);
	});
});

describe("countUserSessionsBySurface", () => {
	test("reads a bounded page of the user's live sessions through the adapter", async () => {
		const now = new Date();
		const live = new Date(now.getTime() + 60_000);
		const calls: unknown[] = [];
		const adapter = {
			findMany: <T>(input: unknown): Promise<T[]> => {
				calls.push(input);
				return Promise.resolve([
					{ expiresAt: live, surface: "cli" },
					{ expiresAt: live, surface: "cli" },
					{ expiresAt: new Date(0), surface: "cli" },
					{ expiresAt: live },
				] as T[]);
			},
		};
		const counts = await countUserSessionsBySurface({
			findSessions: adapterSessionFinder(adapter),
			now,
			userId: "user-1",
		});
		expect(counts.cli).toBe(2);
		expect(counts.web).toBe(1);
		expect(calls).toEqual([
			{
				limit: DEVICE_LIMIT_SESSION_SCAN_LIMIT,
				model: "session",
				sortBy: { direction: "desc", field: "createdAt" },
				where: [
					{ field: "userId", value: "user-1" },
					{ field: "expiresAt", operator: "gt", value: now },
				],
			},
		]);
	});

	test("countLiveSessionsBySurfaceForUser reads the same bounded live page", async () => {
		const now = new Date();
		const calls: unknown[] = [];
		const adapter = {
			findMany: <T>(input: unknown): Promise<T[]> => {
				calls.push(input);
				return Promise.resolve([
					{ expiresAt: new Date(now.getTime() + 1000), surface: "desktop" },
					{
						expiresAt: new Date(now.getTime() + 1000),
						impersonatedBy: "support-1",
						surface: "desktop",
					},
				] as T[]);
			},
		};
		const counts = await countLiveSessionsBySurfaceForUser(
			adapter,
			"user-2",
			now
		);
		expect(counts.desktop).toBe(1);
		expect(calls).toEqual([
			{
				limit: DEVICE_LIMIT_SESSION_SCAN_LIMIT,
				model: "session",
				sortBy: { direction: "desc", field: "createdAt" },
				where: [
					{ field: "userId", value: "user-2" },
					{ field: "expiresAt", operator: "gt", value: now },
				],
			},
		]);
	});
});
