import { describe, expect, test } from "bun:test";
import { RyuAuthenticationError, RyuServerError } from "./errors.ts";
import {
	CAPABILITY_AUTH_FAILURE_TTL_MS,
	CAPABILITY_TTL_MS,
	type CapabilityCache,
	type CapabilityFeatures,
	cachedCapabilities,
} from "./wrap.ts";

const KEY = "passport http://127.0.0.1:8093";

function clock() {
	let current = 1_000_000;
	return {
		advance: (ms: number) => {
			current += ms;
		},
		now: () => current,
	};
}

function serverError(status: number): RyuServerError {
	return new RyuServerError({
		service: "passport",
		status,
		code: "server_error",
		message: "boom",
	});
}

describe("cachedCapabilities", () => {
	test("a positive answer expires, so a rolled-back server is noticed", async () => {
		const time = clock();
		const cache: CapabilityCache = new Map();
		const answers: CapabilityFeatures[] = [
			{ idempotency_keys: true },
			{ profiles: true },
		];
		let probes = 0;
		const probe = () => {
			const answer = answers[probes] ?? {};
			probes += 1;
			return Promise.resolve(answer);
		};
		expect(await cachedCapabilities(cache, KEY, probe, time.now)).toEqual({
			idempotency_keys: true,
		});
		time.advance(CAPABILITY_TTL_MS - 1);
		await cachedCapabilities(cache, KEY, probe, time.now);
		expect(probes).toBe(1);
		time.advance(1);
		expect(await cachedCapabilities(cache, KEY, probe, time.now)).toEqual({
			profiles: true,
		});
		expect(probes).toBe(2);
	});

	test("a pending probe is shared and never expires while it runs", async () => {
		const time = clock();
		const cache: CapabilityCache = new Map();
		let release: (features: CapabilityFeatures) => void = () => undefined;
		let probes = 0;
		const probe = () => {
			probes += 1;
			return new Promise<CapabilityFeatures>((resolve) => {
				release = resolve;
			});
		};
		const first = cachedCapabilities(cache, KEY, probe, time.now);
		time.advance(CAPABILITY_TTL_MS * 2);
		const second = cachedCapabilities(cache, KEY, probe, time.now);
		release({ idempotency_keys: true });
		expect(await first).toEqual({ idempotency_keys: true });
		expect(await second).toEqual({ idempotency_keys: true });
		expect(probes).toBe(1);
	});

	test("a 404 is cached for the full TTL and a 401 only briefly", async () => {
		for (const [status, ttl] of [
			[404, CAPABILITY_TTL_MS],
			[401, CAPABILITY_AUTH_FAILURE_TTL_MS],
		] as const) {
			const time = clock();
			const cache: CapabilityCache = new Map();
			let probes = 0;
			const probe = () => {
				probes += 1;
				return Promise.reject(
					status === 401
						? new RyuAuthenticationError({
								service: "passport",
								status,
								code: "unauthorized",
								message: "bad key",
							})
						: serverError(status)
				);
			};
			expect(await cachedCapabilities(cache, KEY, probe, time.now)).toBeNull();
			time.advance(ttl - 1);
			await cachedCapabilities(cache, KEY, probe, time.now);
			expect(probes).toBe(1);
			time.advance(1);
			await cachedCapabilities(cache, KEY, probe, time.now);
			expect(probes).toBe(2);
		}
	});

	test("a transient failure, or a probe that throws synchronously, is not cached", async () => {
		const cache: CapabilityCache = new Map();
		let probes = 0;
		const failing = () => {
			probes += 1;
			return Promise.reject(serverError(503));
		};
		expect(await cachedCapabilities(cache, KEY, failing)).toBeNull();
		expect(cache.has(KEY)).toBe(false);
		const throwing = (): Promise<CapabilityFeatures> => {
			probes += 1;
			throw new Error("no key");
		};
		expect(await cachedCapabilities(cache, KEY, throwing)).toBeNull();
		expect(cache.has(KEY)).toBe(false);
		expect(probes).toBe(2);
	});
});
