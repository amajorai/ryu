import { describe, expect, test } from "bun:test";
import {
	computeDelay,
	isReplayableBody,
	isReplaySafe,
	isRetryableFailure,
	NON_RETRYABLE_CODES,
	type RetryDecisionInput,
	shouldRetry,
} from "./retry.ts";

const NO_HINTS = {
	bodyRetryAfterSeconds: null,
	rateLimitRemaining: null,
	rateLimitResetSeconds: null,
	retryAfterSeconds: null,
};

function decision(overrides: Partial<RetryDecisionInput>): RetryDecisionInput {
	return {
		...NO_HINTS,
		code: null,
		replayableBody: true,
		replaySafe: true,
		status: 503,
		...overrides,
	};
}

describe("replay safety", () => {
	test("idempotent methods and keyed route writes are replay-safe", () => {
		for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "get"]) {
			expect(
				isReplaySafe({ body: null, hasRouteIdempotencyKey: false, method })
			).toBe(true);
		}
		expect(
			isReplaySafe({ body: "{}", hasRouteIdempotencyKey: true, method: "POST" })
		).toBe(true);
		expect(
			isReplaySafe({
				body: "{}",
				hasRouteIdempotencyKey: false,
				method: "POST",
			})
		).toBe(false);
		expect(
			isReplaySafe({
				body: "{}",
				hasRouteIdempotencyKey: false,
				method: "PATCH",
			})
		).toBe(false);
	});

	test("stream bodies are never replayable", () => {
		const stream = new ReadableStream();
		expect(isReplayableBody(stream)).toBe(false);
		expect(
			isReplaySafe({
				body: stream,
				hasRouteIdempotencyKey: true,
				method: "PUT",
			})
		).toBe(false);
	});

	test("buffered bodies are replayable", () => {
		for (const body of [
			null,
			undefined,
			"text",
			new ArrayBuffer(2),
			new Uint8Array(2),
			new Blob(["x"]),
			new URLSearchParams("a=1"),
			new FormData(),
		]) {
			expect(isReplayableBody(body)).toBe(true);
		}
	});
});

describe("shouldRetry", () => {
	test("5xx and network failures retry only when replay-safe", () => {
		for (const status of [0, 408, 425, 500, 502, 503, 504]) {
			expect(shouldRetry(decision({ status }))).toBe(true);
			expect(shouldRetry(decision({ replaySafe: false, status }))).toBe(false);
		}
		expect(shouldRetry(decision({ status: 501 }))).toBe(false);
	});

	test("429 retries for any method, but only with a hint and a replayable body", () => {
		const base = { replaySafe: false, status: 429 };
		expect(shouldRetry(decision(base))).toBe(false);
		expect(shouldRetry(decision({ ...base, retryAfterSeconds: 1 }))).toBe(true);
		expect(
			shouldRetry(
				decision({ ...base, rateLimitRemaining: 0, rateLimitResetSeconds: 3 })
			)
		).toBe(true);
		expect(
			shouldRetry(
				decision({ ...base, rateLimitRemaining: 4, rateLimitResetSeconds: 3 })
			)
		).toBe(false);
		expect(shouldRetry(decision({ ...base, bodyRetryAfterSeconds: 2 }))).toBe(
			true
		);
		expect(
			shouldRetry(
				decision({ ...base, replayableBody: false, retryAfterSeconds: 1 })
			)
		).toBe(false);
	});

	test("409 idempotency_in_progress retries; other 409s do not", () => {
		expect(
			shouldRetry(decision({ code: "idempotency_in_progress", status: 409 }))
		).toBe(true);
		expect(shouldRetry(decision({ code: "conflict", status: 409 }))).toBe(
			false
		);
	});

	test.each([...NON_RETRYABLE_CODES])("%s is never retried", (code) => {
		expect(
			shouldRetry(decision({ code, retryAfterSeconds: 1, status: 429 }))
		).toBe(false);
		expect(shouldRetry(decision({ code, status: 503 }))).toBe(false);
		expect(isRetryableFailure(503, code)).toBe(false);
	});

	test("402 and plain 4xx are never retried", () => {
		expect(shouldRetry(decision({ retryAfterSeconds: 1, status: 402 }))).toBe(
			false
		);
		for (const status of [400, 401, 403, 404, 410, 422]) {
			expect(shouldRetry(decision({ status }))).toBe(false);
		}
	});
});

describe("computeDelay", () => {
	test("Retry-After, then RateLimit t (r=0), then body, then backoff", () => {
		const all = {
			bodyRetryAfterSeconds: 3,
			rateLimitRemaining: 0,
			rateLimitResetSeconds: 2,
			retryAfterSeconds: 1,
		};
		expect(computeDelay(0, all)).toEqual({
			delayMs: 1000,
			source: "retry-after",
		});
		expect(computeDelay(0, { ...all, retryAfterSeconds: null })).toEqual({
			delayMs: 2000,
			source: "ratelimit",
		});
		expect(
			computeDelay(0, {
				...all,
				rateLimitRemaining: 1,
				retryAfterSeconds: null,
			})
		).toEqual({
			delayMs: 3000,
			source: "body",
		});
	});

	test("backoff doubles from 0.5 s, caps at 8 s, and jitters within [0.5, 1]", () => {
		expect(computeDelay(0, NO_HINTS, () => 1).delayMs).toBe(500);
		expect(computeDelay(0, NO_HINTS, () => 0).delayMs).toBe(250);
		expect(computeDelay(3, NO_HINTS, () => 1).delayMs).toBe(4000);
		expect(computeDelay(10, NO_HINTS, () => 1).delayMs).toBe(8000);
		expect(computeDelay(10, NO_HINTS, () => 0).delayMs).toBe(4000);
	});
});
