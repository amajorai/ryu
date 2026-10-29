import { describe, expect, it } from "bun:test";
import {
	aggregateUsageEvents,
	cacheReuseRatio,
	compactUsageTrendPoints,
	FOREGROUND_PURPOSE_KEY,
	ledgerProviderLabel,
	type UsageBucket,
	type UsageEvent,
	usageCacheSeries,
	usageProviderLabel,
	usagePurposeLabel,
} from "./usage-analytics.ts";

const RANGE = {
	from: new Date("2026-08-17T00:00:00.000Z"),
	to: new Date("2026-08-18T00:00:00.000Z"),
};

describe("aggregateUsageEvents", () => {
	it("keeps non-credit traffic visible without inventing spend", () => {
		const data = aggregateUsageEvents({
			caption: "Node traffic",
			events: [
				{
					durationMs: 100,
					feature: "Chat",
					inputTokens: 10,
					memberId: "user-1",
					model: "llama",
					nodeId: "node-1",
					outputTokens: 5,
					provider: "local",
					source: "local",
					timestamp: "2026-08-17T09:05:00.000Z",
				},
				{
					durationMs: 300,
					error: true,
					inputTokens: 20,
					memberId: "user-2",
					model: "gpt",
					nodeId: "node-1",
					outputTokens: 10,
					provider: "openai",
					source: "byok",
					timestamp: "2026-08-17T09:16:00.000Z",
				},
			],
			from: RANGE.from,
			granularity: "15m",
			scope: "node",
			scopeLabel: "This node",
			to: RANGE.to,
		});

		expect(data.totals).toMatchObject({
			activeDays: 1,
			activeMembers: 2,
			activeNodes: 1,
			averageLatencyMs: 200,
			errors: 1,
			inputTokens: 30,
			outputTokens: 15,
			requests: 2,
			spendMicroUsd: null,
		});
		expect(data.buckets.filter((bucket) => bucket.requests > 0)).toHaveLength(
			2
		);
		expect(data.bySource.map((row) => row.label)).toEqual(["BYOK", "Local"]);
		expect(data.byProvider.map((row) => row.key)).toEqual(["openai", "local"]);
	});

	it("attributes managed spend and excludes events outside the half-open range", () => {
		const data = aggregateUsageEvents({
			caption: "Organization traffic",
			events: [
				{
					costMicroUsd: 1250,
					inputTokens: 100,
					model: "managed-model",
					outputTokens: 50,
					provider: "openai-credits",
					source: "managed",
					timestamp: "2026-08-17T12:00:00.000Z",
				},
				{
					costMicroUsd: 9999,
					inputTokens: 1,
					model: "outside",
					outputTokens: 1,
					provider: "openai-credits",
					source: "managed",
					timestamp: "2026-08-18T00:00:00.000Z",
				},
			],
			from: RANGE.from,
			granularity: "hourly",
			scope: "organization",
			scopeLabel: "Organization",
			to: RANGE.to,
		});

		expect(data.totals.requests).toBe(1);
		expect(data.totals.spendMicroUsd).toBe(1250);
		expect(data.byModel).toEqual([
			{
				key: "managed-model",
				label: "managed-model",
				requests: 1,
				spendMicroUsd: 1250,
				tokens: 150,
			},
		]);
	});

	it("can add ledger-only spend without inflating request counts", () => {
		const data = aggregateUsageEvents({
			caption: "Credit ledger",
			events: [
				{
					costMicroUsd: 500,
					model: "managed-model",
					provider: "openai-credits",
					requestCount: 0,
					source: "managed",
					timestamp: "2026-08-17T12:00:00.000Z",
				},
			],
			from: RANGE.from,
			granularity: "daily",
			scope: "organization",
			scopeLabel: "Organization",
			to: RANGE.to,
		});

		expect(data.totals.requests).toBe(0);
		expect(data.totals.spendMicroUsd).toBe(500);
		expect(data.buckets[0]?.spendMicroUsd).toBe(500);
	});

	it("combines partial errors and weighted latency from canonical rollups", () => {
		const data = aggregateUsageEvents({
			caption: "Canonical rollups",
			events: [
				{
					agentSeconds: 12,
					costMicroUsd: null,
					errorCount: 1,
					inputTokens: 80,
					latencySamples: 3,
					latencyTotalMs: 600,
					outputTokens: 20,
					requestCount: 4,
					timestamp: "2026-08-17T09:00:00.000Z",
				},
				{
					agentSeconds: 8,
					costMicroUsd: 0,
					errorCount: 2,
					inputTokens: 40,
					latencySamples: 1,
					latencyTotalMs: 900,
					outputTokens: 10,
					requestCount: 2,
					timestamp: "2026-08-17T09:15:00.000Z",
				},
			],
			from: RANGE.from,
			granularity: "hourly",
			scope: "node",
			scopeLabel: "This node",
			to: RANGE.to,
		});

		expect(data.totals).toMatchObject({
			agentSeconds: 20,
			averageLatencyMs: 375,
			errors: 3,
			inputTokens: 120,
			outputTokens: 30,
			requests: 6,
			spendMicroUsd: 0,
		});
		expect(data.buckets.find((bucket) => bucket.requests > 0)).toMatchObject({
			averageLatencyMs: 375,
			errors: 3,
			requests: 6,
		});
	});

	it("keeps legacy raw latency and error fields compatible", () => {
		const data = aggregateUsageEvents({
			caption: "Legacy audit rows",
			events: [
				{
					durationMs: 100,
					error: false,
					timestamp: "2026-08-17T09:00:00.000Z",
				},
				{
					durationMs: 300,
					error: true,
					timestamp: "2026-08-17T09:01:00.000Z",
				},
			],
			from: RANGE.from,
			granularity: "hourly",
			scope: "node",
			scopeLabel: "This node",
			to: RANGE.to,
		});

		expect(data.totals).toMatchObject({
			averageLatencyMs: 200,
			errors: 1,
			requests: 2,
		});
	});

	it("treats fallback duration as one observation for a counted row", () => {
		const data = aggregateUsageEvents({
			caption: "Legacy counted row",
			events: [
				{
					durationMs: 120,
					requestCount: 4,
					timestamp: "2026-08-17T09:00:00.000Z",
				},
			],
			from: RANGE.from,
			granularity: "hourly",
			scope: "node",
			scopeLabel: "This node",
			to: RANGE.to,
		});

		expect(data.totals.averageLatencyMs).toBe(120);
		expect(data.totals.requests).toBe(4);
	});

	it.each([
		{
			expected: [
				["2026-08-17T09:00:00.000Z", 2],
				["2026-08-17T10:00:00.000Z", 1],
			],
			from: "2026-08-17T09:00:00.000Z",
			granularity: "hourly" as const,
			timestamps: [
				"2026-08-17T09:14:00.000Z",
				"2026-08-17T09:59:00.000Z",
				"2026-08-17T10:00:00.000Z",
			],
			to: "2026-08-17T11:00:00.000Z",
		},
		{
			expected: [
				["2026-08-17T00:00:00.000Z", 2],
				["2026-08-18T00:00:00.000Z", 1],
			],
			from: "2026-08-17T00:00:00.000Z",
			granularity: "daily" as const,
			timestamps: [
				"2026-08-17T00:01:00.000Z",
				"2026-08-17T23:59:00.000Z",
				"2026-08-18T00:00:00.000Z",
			],
			to: "2026-08-19T00:00:00.000Z",
		},
		{
			expected: [
				["2026-08-17T00:00:00.000Z", 2],
				["2026-08-24T00:00:00.000Z", 1],
			],
			from: "2026-08-17T00:00:00.000Z",
			granularity: "weekly" as const,
			timestamps: [
				"2026-08-17T00:00:00.000Z",
				"2026-08-23T23:59:00.000Z",
				"2026-08-24T00:00:00.000Z",
			],
			to: "2026-08-31T00:00:00.000Z",
		},
		{
			expected: [
				["2026-08-01T00:00:00.000Z", 2],
				["2026-09-01T00:00:00.000Z", 1],
			],
			from: "2026-08-01T00:00:00.000Z",
			granularity: "monthly" as const,
			timestamps: [
				"2026-08-01T00:00:00.000Z",
				"2026-08-31T23:59:00.000Z",
				"2026-09-01T00:00:00.000Z",
			],
			to: "2026-10-01T00:00:00.000Z",
		},
	])("groups events into $granularity buckets", (testCase) => {
		const data = aggregateUsageEvents({
			caption: "Grouped rows",
			events: testCase.timestamps.map((timestamp) => ({ timestamp })),
			from: new Date(testCase.from),
			granularity: testCase.granularity,
			scope: "node",
			scopeLabel: "This node",
			to: new Date(testCase.to),
		});

		expect<readonly (readonly (string | number)[])[]>(
			data.buckets
				.filter((bucket) => bucket.requests > 0)
				.map((bucket) => [bucket.start, bucket.requests])
		).toEqual(
			testCase.expected.map(([start, requests]): [string, number] => [
				start,
				requests,
			])
		);
	});
});

describe("compactUsageTrendPoints", () => {
	it("bounds long-range chart work without changing metric totals", () => {
		const points = Array.from({ length: 38_400 }, (_, index) => ({
			errors: index % 2,
			label: `Bucket ${index}`,
			requests: 1,
			spend: index % 3 === 0 ? 2 : null,
			tokens: 3,
		}));
		const compacted = compactUsageTrendPoints(points);

		expect(compacted.length).toBeLessThanOrEqual(1000);
		expect(compacted.reduce((total, point) => total + point.requests, 0)).toBe(
			38_400
		);
		expect(compacted.reduce((total, point) => total + point.tokens, 0)).toBe(
			115_200
		);
		expect(
			compacted.reduce((total, point) => total + (point.spend ?? 0), 0)
		).toBe(25_600);
	});

	it("keeps the first canonical bucket when a range begins mid-bucket", () => {
		const data = aggregateUsageEvents({
			caption: "Canonical rollups",
			events: [
				{
					bucketSeconds: 900,
					requestCount: 2,
					timestamp: "2026-08-17T09:00:00.000Z",
				},
				{
					bucketSeconds: 900,
					requestCount: 99,
					timestamp: "2026-08-17T08:45:00.000Z",
				},
			],
			from: new Date("2026-08-17T09:07:00.000Z"),
			granularity: "15m",
			scope: "organization",
			scopeLabel: "Organization",
			to: new Date("2026-08-17T09:30:00.000Z"),
		});

		expect(data.totals.requests).toBe(2);
		expect(data.buckets[0]?.requests).toBe(2);
	});
});

describe("usageProviderLabel", () => {
	it("names every Ryu own-supply slot Ryu Router, never the vendor or a tier", () => {
		for (const slot of [
			"cloudflare",
			"bedrock",
			"vertex",
			"openai-credits",
			"anthropic-credits",
		]) {
			expect(usageProviderLabel(slot)).toBe("Ryu Router");
		}
		expect(usageProviderLabel("ryu")).toBe("Ryu Router");
		// BYOK and (possibly BYOK) OpenRouter analytics keep their own names.
		expect(usageProviderLabel("openai")).toBe("openai");
		expect(usageProviderLabel("openrouter")).toBe("openrouter");
	});

	it("names managed ledger traffic Ryu Router, OpenRouter included", () => {
		expect(ledgerProviderLabel("openrouter")).toBe("Ryu Router");
		expect(ledgerProviderLabel("bedrock")).toBe("Ryu Router");
		expect(ledgerProviderLabel("openai")).toBe("openai");
	});
});

function aggregateNode(events: UsageEvent[]) {
	return aggregateUsageEvents({
		caption: "Node traffic",
		events,
		from: RANGE.from,
		granularity: "hourly",
		scope: "node",
		scopeLabel: "This node",
		to: RANGE.to,
	});
}

describe("purpose and prompt-cache attribution", () => {
	it("breaks requests out by purpose with a sentinel for foreground calls", () => {
		const data = aggregateNode([
			{
				purpose: null,
				requestCount: 5,
				timestamp: "2026-08-17T09:00:00.000Z",
			},
			{
				purpose: "compaction",
				requestCount: 3,
				timestamp: "2026-08-17T09:15:00.000Z",
			},
			{
				purpose: "plugin:@ryu/foo",
				requestCount: 2,
				timestamp: "2026-08-17T10:00:00.000Z",
			},
			{
				purpose: "future_purpose",
				requestCount: 1,
				timestamp: "2026-08-17T10:15:00.000Z",
			},
			// A host that does not report purpose is not counted as foreground.
			{ requestCount: 4, timestamp: "2026-08-17T11:00:00.000Z" },
		]);

		expect(
			data.byPurpose?.map(({ key, label, requests }) => ({
				key,
				label,
				requests,
			}))
		).toEqual([
			{
				key: FOREGROUND_PURPOSE_KEY,
				label: "Chat and agent turns",
				requests: 5,
			},
			{ key: "compaction", label: "Context compaction", requests: 3 },
			{ key: "plugin:@ryu/foo", label: "Plugin · @ryu/foo", requests: 2 },
			{ key: "future_purpose", label: "future_purpose", requests: 1 },
		]);
	});

	it("keeps a tagged 'foreground' purpose apart from untagged calls", () => {
		const data = aggregateNode([
			{ purpose: null, timestamp: "2026-08-17T09:00:00.000Z" },
			{ purpose: "foreground", timestamp: "2026-08-17T09:00:00.000Z" },
		]);

		expect(data.byPurpose?.map((row) => row.key).sort()).toEqual(
			[FOREGROUND_PURPOSE_KEY, "foreground"].sort()
		);
	});

	it("omits the purpose breakdown when nothing is tagged", () => {
		expect(
			aggregateNode([{ timestamp: "2026-08-17T09:00:00.000Z" }]).byPurpose
		).toBeUndefined();
		expect(
			aggregateNode([{ purpose: null, timestamp: "2026-08-17T09:00:00.000Z" }])
				.byPurpose
		).toBeUndefined();
	});

	it("sums cache reads and writes into buckets and totals", () => {
		const data = aggregateNode([
			{
				cacheReadTokens: 30,
				cacheWriteTokens: 10,
				timestamp: "2026-08-17T09:00:00.000Z",
			},
			{
				cacheReadTokens: 20,
				timestamp: "2026-08-17T09:30:00.000Z",
			},
			{ timestamp: "2026-08-17T10:00:00.000Z" },
		]);

		expect(data.totals).toMatchObject({
			cacheReadTokens: 50,
			cacheWriteTokens: 10,
		});
		const nineAm = data.buckets.find(
			(bucket) => bucket.start === "2026-08-17T09:00:00.000Z"
		);
		expect(nineAm).toMatchObject({ cacheReadTokens: 50, cacheWriteTokens: 10 });
	});

	it("labels unknown purposes verbatim", () => {
		expect(usagePurposeLabel("something_new")).toBe("something_new");
		expect(usagePurposeLabel("plugin:")).toBe("plugin:");
		expect(usagePurposeLabel("auto_title")).toBe("Chat titles");
	});

	it("computes cache reuse as reads over reads plus writes", () => {
		expect(cacheReuseRatio(0, 0)).toBeNull();
		expect(cacheReuseRatio(3, 1)).toBe(0.75);
	});

	it("groups cache series as a ratio of sums", () => {
		const bucket = (
			label: string,
			cacheReadTokens: number,
			cacheWriteTokens: number
		): UsageBucket => ({
			averageLatencyMs: null,
			cacheReadTokens,
			cacheWriteTokens,
			end: "",
			errors: 0,
			inputTokens: 0,
			label,
			outputTokens: 0,
			requests: 0,
			spendMicroUsd: null,
			start: "",
		});
		const points = usageCacheSeries(
			[bucket("a", 1, 0), bucket("b", 0, 9), bucket("c", 0, 0)],
			2
		);

		expect(points).toEqual([
			{ label: "a – b", ratio: 0.1, read: 1, write: 9 },
			{ label: "c", ratio: null, read: 0, write: 0 },
		]);
	});
});
