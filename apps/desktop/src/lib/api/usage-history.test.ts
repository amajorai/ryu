import { afterEach, expect, test } from "bun:test";
import contractFixture from "../../../../core/src/usage_history/fixtures/contract.json" with {
	type: "json",
};
import {
	fetchUsageHistory,
	historyProcessedTokens,
	importUsageHistory,
	parseHistoryImportReport,
	parseUsageHistoryReport,
	syncUsageHistoryAccount,
} from "./usage-history.ts";

const totals = {
	inputTokens: 100,
	outputTokens: 30,
	cacheReadTokens: 50,
	cacheWriteTokens: 10,
	cachedOutputTokens: 5,
	reasoningTokens: 20,
	missingInputRecords: 0,
	missingOutputRecords: 0,
	missingCacheReadRecords: 0,
	missingCacheWriteRecords: 0,
	missingCachedOutputRecords: 0,
	missingReasoningRecords: 0,
};
const summary = {
	totals,
	sessions: 1,
	records: 1,
	estimatedCostUsd: null,
	reportedCostUsd: null,
	billedCostUsd: null,
	sourceEstimatedCostUsd: null,
	cacheSavingsUsd: null,
	unpricedRecords: 1,
	daily: [],
	models: [],
	sources: [],
};
const report = {
	summary,
	sources: [
		{
			id: "codex",
			label: "Codex",
			transport: "localFiles",
			available: true,
			limitations: "Retained counters only",
		},
	],
};
const imported = {
	scannedFiles: 1,
	importedRecords: 1,
	updatedRecords: 0,
	duplicateRecords: 0,
	skippedFiles: 0,
	errorCount: 0,
	errors: [],
	hasMore: false,
};
const target = {
	url: "http://127.0.0.1:8980",
	token: "node-token",
	userJwt: null,
};
const realFetch = globalThis.fetch;
function stubFetch(
	handler: (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1]
	) => Promise<Response>
): typeof fetch {
	return Object.assign(handler, { preconnect: realFetch.preconnect });
}
afterEach(() => {
	globalThis.fetch = realFetch;
});

test("parses the shared Core serialization contract", () => {
	const parsed = parseUsageHistoryReport(contractFixture);
	expect(parsed.summary.sessions).toBe(1);
	expect(parsed.summary.estimatedCostUsd).toBe(3);
	expect(historyProcessedTokens(parsed.summary.totals)).toBe(3_500_000);
});

test("keeps unknown prices distinct from zero and counts disjoint cache input once", () => {
	expect(parseUsageHistoryReport(report).summary.estimatedCostUsd).toBeNull();
	expect(historyProcessedTokens(totals)).toBe(190);
});

test("rejects malformed nested totals, negative counts and missing import fields", () => {
	expect(() =>
		parseUsageHistoryReport({
			...report,
			summary: { ...summary, totals: { ...totals, outputTokens: -1 } },
		})
	).toThrow("malformed");
	expect(() =>
		parseUsageHistoryReport({
			...report,
			summary: {
				...summary,
				daily: [
					{ ...summary, date: "2026-10-01", sourceId: "codex", modelId: false },
				],
			},
		})
	).toThrow("malformed");
	expect(() =>
		parseHistoryImportReport({ ...imported, hasMore: "yes" })
	).toThrow("malformed");
	expect(() => parseHistoryImportReport({})).toThrow("malformed");
	expect(() =>
		parseUsageHistoryReport({
			...report,
			summary: { ...summary, estimatedCostUsd: Number.NaN },
		})
	).toThrow("malformed");
	expect(() =>
		parseUsageHistoryReport({
			...report,
			summary: { ...summary, billedCostUsd: -0.01 },
		})
	).toThrow("malformed");
	expect(() =>
		parseUsageHistoryReport({
			...report,
			summary: {
				...summary,
				totals: { ...totals, cacheReadTokens: Number.POSITIVE_INFINITY },
			},
		})
	).toThrow("malformed");
	expect(
		parseHistoryImportReport({
			...imported,
			hasMore: true,
			duplicateRecords: 1,
		})
	).toMatchObject({ hasMore: true, duplicateRecords: 1 });
});

test("requests the selected node and separate organization report scope", async () => {
	let url = "";
	let authorization = "";
	globalThis.fetch = stubFetch(async (input, init) => {
		url = String(input);
		authorization = new Headers(init?.headers).get("Authorization") ?? "";
		return Response.json(report);
	});
	await fetchUsageHistory(target, "2026-09-01", undefined, "organization");
	expect(url).toBe(
		"http://127.0.0.1:8980/api/usage/history?scope=organization&startDate=2026-09-01"
	);
	expect(authorization).toBe("Bearer node-token");
});

test("requests unattributed usage separately from native session history", async () => {
	let url = "";
	globalThis.fetch = stubFetch(async (input) => {
		url = String(input);
		return Response.json(report);
	});
	await fetchUsageHistory(target, undefined, undefined, "unattributed");
	expect(url).toBe(
		"http://127.0.0.1:8980/api/usage/history?scope=unattributed"
	);
});

test("requests unresolved native/live overlap as a separate subtotal", async () => {
	let url = "";
	globalThis.fetch = stubFetch(async (input) => {
		url = String(input);
		return Response.json(report);
	});
	await fetchUsageHistory(target, undefined, undefined, "unreconciled");
	expect(url).toBe(
		"http://127.0.0.1:8980/api/usage/history?scope=unreconciled"
	);
});

test("preserves optional account subtotals and rejects malformed identities", () => {
	const account = {
		...contractFixture.summary.sources[0],
		accountId: "account-a",
	};
	const withAccounts = {
		...report,
		summary: { ...report.summary, accounts: [account] },
	};
	expect(
		parseUsageHistoryReport(withAccounts).summary.accounts?.[0]?.accountId
	).toBe("account-a");
	expect(() =>
		parseUsageHistoryReport({
			...withAccounts,
			summary: {
				...withAccounts.summary,
				accounts: [{ ...account, accountId: 1 }],
			},
		})
	).toThrow();
	expect(parseUsageHistoryReport(report).summary.accounts).toBeUndefined();
});

test("imports only explicitly chosen sources and roots and preserves cancellation", async () => {
	let body: unknown;
	let signal: AbortSignal | null | undefined;
	globalThis.fetch = stubFetch(async (_input, init) => {
		body = JSON.parse(String(init?.body));
		signal = init?.signal;
		return Response.json(
			{ id: "operation-1", state: "completed", report: imported },
			{ status: 202 }
		);
	});
	const controller = new AbortController();
	const request = {
		sourceIds: ["codex"],
		roots: [{ sourceId: "codex", path: "D:/history" }],
		maxFiles: 500,
		retryFailed: true,
	};
	await expect(
		importUsageHistory(target, request, controller.signal)
	).resolves.toEqual(imported);
	expect(body).toEqual(request);
	expect(signal).toBe(controller.signal);
});

test("polls a retained import operation and publishes bounded progress", async () => {
	const urls: string[] = [];
	const progress: unknown[] = [];
	globalThis.fetch = stubFetch(async (input) => {
		urls.push(String(input));
		return Response.json(
			urls.length === 1
				? { id: "operation-2", state: "running", progress: imported }
				: { id: "operation-2", state: "completed", report: imported }
		);
	});
	expect(
		await importUsageHistory(
			target,
			{ sourceIds: ["codex"], roots: [] },
			undefined,
			(report) => progress.push(report)
		)
	).toEqual(imported);
	expect(urls[1]).toBe(
		"http://127.0.0.1:8980/api/usage/history/import/operations/operation-2"
	);
	expect(progress).toEqual([imported]);
});

test("cancels polling without issuing another request and rejects malformed operation paths", async () => {
	let requests = 0;
	globalThis.fetch = stubFetch(async () => {
		requests += 1;
		return Response.json({
			id: "operation-3",
			state: "running",
			progress: imported,
		});
	});
	const controller = new AbortController();
	await expect(
		importUsageHistory(
			target,
			{ sourceIds: ["codex"], roots: [] },
			controller.signal,
			() => controller.abort()
		)
	).rejects.toMatchObject({ name: "AbortError" });
	expect(requests).toBe(1);
	globalThis.fetch = stubFetch(async () =>
		Response.json({ id: "../secrets", state: "running", progress: imported })
	);
	await expect(
		importUsageHistory(target, { sourceIds: ["codex"], roots: [] })
	).rejects.toThrow("malformed");
});

test("reports failed import operations", async () => {
	globalThis.fetch = stubFetch(async () =>
		Response.json({
			id: "operation-4",
			state: "failed",
			error: "Unable to scan history.",
		})
	);
	await expect(
		importUsageHistory(target, { sourceIds: ["codex"], roots: [] })
	).rejects.toThrow("Unable to scan history.");
});

test("account sync returns its resumable cursor and propagates authorization failures", async () => {
	globalThis.fetch = stubFetch(async () =>
		Response.json({ report: imported, nextCursor: "page-2" })
	);
	const body = {
		sourceId: "openai-org-usage",
		credential: "test-only",
		accountId: "team-a",
		startDate: "2026-09-01",
		endDate: "2026-10-01",
	};
	expect((await syncUsageHistoryAccount(target, body)).nextCursor).toBe(
		"page-2"
	);
	globalThis.fetch = stubFetch(async () =>
		Response.json({ error: "unauthorized" }, { status: 403 })
	);
	await expect(syncUsageHistoryAccount(target, body)).rejects.toMatchObject({
		status: 403,
	});
});

test("never sends provider admin keys to a remote plaintext Core endpoint", async () => {
	let called = false;
	globalThis.fetch = stubFetch(async () => {
		called = true;
		return Response.json({});
	});
	await expect(
		syncUsageHistoryAccount(
			{ url: "http://remote.example", token: null },
			{
				sourceId: "openai-org-usage",
				credential: "test-only",
				accountId: "team",
				startDate: "2026-09-01",
				endDate: "2026-10-01",
			}
		)
	).rejects.toThrow("HTTPS");
	expect(called).toBe(false);
});
