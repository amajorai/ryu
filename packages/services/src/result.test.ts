import { describe, expect, test } from "bun:test";
import { createRyuError } from "./errors.ts";
import {
	createSafeProxy,
	EMPTY_META,
	type RyuResponseMeta,
	registerCallMeta,
	toResult,
} from "./result.ts";

const META: RyuResponseMeta = {
	attempts: 1,
	deprecation: null,
	idempotencyKey: "k",
	rateLimit: null,
	replayed: false,
	requestId: "req_1",
	status: 201,
};

describe("toResult", () => {
	test("a resolved promise becomes { data, error: null, meta }", async () => {
		const promise = Promise.resolve({ id: "e_1" });
		registerCallMeta(promise, () => META);
		expect(await toResult(promise)).toEqual({
			data: { id: "e_1" },
			error: null,
			meta: META,
		});
	});

	test("a RyuError rejection becomes { data: null, error, meta }", async () => {
		const error = createRyuError({
			code: "not_found",
			message: "Missing.",
			service: "notify",
			status: 404,
		});
		const promise = Promise.reject(error);
		registerCallMeta(promise, () => ({ ...META, status: 404 }));
		const result = await toResult(promise);
		expect(result.data).toBeNull();
		expect(result.error).toBe(error);
		expect(result.meta?.status).toBe(404);
	});

	test("an unregistered promise gets empty meta on success and null on failure", async () => {
		expect((await toResult(Promise.resolve(1))).meta).toEqual(EMPTY_META);
		const error = createRyuError({
			code: "x",
			message: "m",
			service: "box",
			status: 500,
		});
		expect((await toResult(Promise.reject(error))).meta).toBeNull();
	});

	test("a non-RyuError is rethrown", async () => {
		await expect(
			toResult(Promise.reject(new TypeError("bug")))
		).rejects.toThrow("bug");
	});
});

describe("createSafeProxy", () => {
	test("resolves and caches each property; is not thenable", () => {
		let resolved = 0;
		const proxy = createSafeProxy<Record<string, unknown>>((key) => {
			resolved += 1;
			return { key };
		});
		expect(proxy.notify).toEqual({ key: "notify" });
		expect(proxy.notify).toBe(proxy.notify);
		expect(resolved).toBe(1);
		expect(proxy.then).toBeUndefined();
	});
});
