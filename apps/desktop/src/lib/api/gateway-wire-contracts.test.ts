import { expect, test } from "bun:test";
import {
	parseGatewayUsageRollupResponse,
	subscribeGatewayTraffic,
} from "./gateway.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import { gatewayTrafficEventSchema } from "./gateway-traffic-contracts.ts";

const usage = {
	timestamp: "2026-10-06T00:00:00Z",
	provider: "openai",
	model: "model",
	memberId: null,
	nodeId: "node",
	feature: null,
	source: "managed",
	inputTokens: 1,
	outputTokens: 2,
	requestCount: 1,
	errorCount: 0,
	latencyTotalMs: 3,
	latencySamples: 1,
	agentSeconds: 0.1,
	costMicroUsd: null,
	future: { retained: true },
};
const traffic = {
	api_key: "sk-sec***",
	cache_hit: false,
	error: null,
	event_type: "model_call",
	input_tokens: 1,
	latency_ms: 3,
	model: null,
	output_tokens: 2,
	provider: "openai",
	request_id: "one",
	session_id: null,
	ts: "2026-10-06T00:00:00Z",
	future: { retained: true },
};
test("usage codec preserves event identity and optional envelope omissions", () => {
	const result = parseGatewayUsageRollupResponse({
		kind: "rollup",
		bucketSeconds: 900,
		events: [usage],
	});
	expect(result.events[0] === usage).toBe(true);
	expect(Object.keys(result)).toEqual(["bucketSeconds", "events", "kind"]);
	expect(
		parseGatewayUsageRollupResponse({
			kind: "rollup",
			bucketSeconds: 900,
			events: [],
			reachable: false,
			status: 503,
		})
	).toMatchObject({ reachable: false, status: 503 });
});
test("usage rejects malformed known fields and unsafe counters with the existing error", () => {
	for (const invalid of [
		{ timestamp: "invalid" },
		{ source: "future" },
		{ inputTokens: -1 },
		{ requestCount: 1.2 },
		{ latencySamples: Number.MAX_SAFE_INTEGER + 1 },
		{ memberId: 1 },
		{ agentSeconds: Number.POSITIVE_INFINITY },
	]) {
		expect(() =>
			parseGatewayUsageRollupResponse({
				kind: "rollup",
				bucketSeconds: 900,
				events: [{ ...usage, ...invalid }],
			})
		).toThrow("Gateway usage rollup response was malformed.");
	}
	expect(() =>
		parseGatewayUsageRollupResponse({
			kind: "rollup",
			bucketSeconds: 900,
			events: [],
			reachable: "false",
		})
	).toThrow();
});
test("usage keeps optional purpose and prompt-cache counters", () => {
	const tagged = {
		...usage,
		cacheReadTokens: 30,
		cacheWriteTokens: 10,
		purpose: "plugin:@ryu/foo",
	};
	const result = parseGatewayUsageRollupResponse({
		kind: "rollup",
		bucketSeconds: 900,
		events: [tagged, { ...usage, purpose: null }, usage],
	});
	expect(result.events[0]).toMatchObject({
		cacheReadTokens: 30,
		cacheWriteTokens: 10,
		purpose: "plugin:@ryu/foo",
	});
	expect(result.events[1]?.purpose).toBeNull();
	expect(result.events[2]?.purpose).toBeUndefined();
	for (const invalid of [
		{ cacheReadTokens: -1 },
		{ cacheWriteTokens: 1.5 },
		{ cacheReadTokens: "3" },
	]) {
		expect(() =>
			parseGatewayUsageRollupResponse({
				kind: "rollup",
				bucketSeconds: 900,
				events: [{ ...usage, ...invalid }],
			})
		).toThrow("Gateway usage rollup response was malformed.");
	}
	// An unexpected purpose must not blank the whole rollup.
	expect(
		parseGatewayUsageRollupResponse({
			kind: "rollup",
			bucketSeconds: 900,
			events: [{ ...usage, purpose: 7 }],
		}).events
	).toHaveLength(1);
});
test("traffic validates the complete event and preserves additive JSON metadata", () => {
	expect(gatewayTrafficEventSchema.parse(traffic) === traffic).toBe(true);
	for (const invalid of [
		{ input_tokens: "1" },
		{ service_usage: { requests: 1 } },
		{ future: undefined },
		{ command: false },
	]) {
		expect(
			gatewayTrafficEventSchema.safeParse({ ...traffic, ...invalid }).success
		).toBe(false);
	}
	const full = {
		...traffic,
		command: null,
		service_usage: {
			requests: 1,
			documents: 2,
			provider_credits: null,
			cost_source: "provider_reported",
			cost_is_estimate: false,
		},
	};
	expect(gatewayTrafficEventSchema.parse(full) === full).toBe(true);
});
test("real traffic SSE drops a malformed frame and continues delivering validated owner events", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return new Response(
				`event: traffic\ndata: ${JSON.stringify({ ...traffic, input_tokens: "invalid" })}\n\nevent: traffic\ndata: ${JSON.stringify(traffic)}\n\n`,
				{ headers: { "content-type": "text/event-stream" } }
			);
		},
	});
	let unsubscribe = () => {};
	try {
		const received = await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("traffic event timed out")),
				3000
			);
			unsubscribe = subscribeGatewayTraffic(
				{ url: `http://127.0.0.1:${server.port}`, token: "fixture" },
				(event) => {
					clearTimeout(timer);
					resolve(event);
				},
				(error) => {
					clearTimeout(timer);
					reject(new Error(error));
				}
			);
		});
		expect(received).toEqual(traffic);
	} finally {
		unsubscribe();
		server.stop(true);
	}
});

test("traffic SSE reports a permission refusal's HTTP status so callers can stop retrying", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return Response.json(
				{ error: "insufficient permissions: audit.view" },
				{ status: 403 }
			);
		},
	});
	let unsubscribe = () => {};
	try {
		const failure = await new Promise<{
			detail: { status: number } | undefined;
			message: string;
		}>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("traffic refusal timed out")),
				3000
			);
			unsubscribe = subscribeGatewayTraffic(
				{ url: `http://127.0.0.1:${server.port}`, token: "fixture" },
				() => {
					clearTimeout(timer);
					reject(new Error("a refused feed must not deliver events"));
				},
				(message, detail) => {
					clearTimeout(timer);
					resolve({ detail, message });
				}
			);
		});
		expect(failure).toEqual({
			detail: { status: 403 },
			message: "traffic feed returned 403",
		});
	} finally {
		unsubscribe();
		server.stop(true);
	}
});

test("Gateway request JSON supports optional draft fields without dropping own future keys", () => {
	const draft = {
		metadata: JSON.parse('{"__proto__":{"future":true}}'),
		vars: { omitted: undefined },
		values: [true, null, undefined],
	};
	expect(gatewayJsonValueSchema.parse(draft) === draft).toBe(true);
	expect(JSON.stringify(gatewayJsonValueSchema.parse(draft))).toBe(
		JSON.stringify(draft)
	);
	expect(gatewayJsonValueSchema.safeParse({ fn: () => {} }).success).toBe(
		false
	);
	expect(
		gatewayJsonValueSchema.safeParse({
			metadata: JSON.parse('{"__proto__":{"future":true}}'),
			invalid: Number.NaN,
		}).success
	).toBe(true);
	const invalid = JSON.parse('{"__proto__":{"future":true}}');
	Object.defineProperty(invalid, "__proto__", {
		value: () => {},
		enumerable: true,
	});
	expect(gatewayJsonValueSchema.safeParse(invalid).success).toBe(false);
});
