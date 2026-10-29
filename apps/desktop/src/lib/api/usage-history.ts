import { z } from "zod";

import { type ApiTarget, request } from "./client.ts";

export interface HistoryTokenTotals {
	cachedOutputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inputTokens: number;
	missingCachedOutputRecords: number;
	missingCacheReadRecords: number;
	missingCacheWriteRecords: number;
	missingInputRecords: number;
	missingOutputRecords: number;
	missingReasoningRecords: number;
	outputTokens: number;
	reasoningTokens: number;
}

interface HistoryAggregate {
	billedCostUsd: number | null;
	cacheSavingsUsd: number | null;
	estimatedCostUsd: number | null;
	records: number;
	reportedCostUsd: number | null;
	sessions: number;
	sourceEstimatedCostUsd: number | null;
	totals: HistoryTokenTotals;
	unpricedRecords: number;
}

export interface HistoryBucket extends HistoryAggregate {
	accountId?: string | null;
	date: string;
	modelId: string | null;
	sourceId: string;
}

export interface HistorySummary extends HistoryAggregate {
	accounts?: HistoryBucket[];
	daily: HistoryBucket[];
	models: HistoryBucket[];
	sources: HistoryBucket[];
}

export interface HistorySource {
	available: boolean;
	id: string;
	label: string;
	limitations: string;
	transport: string;
}

export interface UsageHistoryReport {
	sources: HistorySource[];
	summary: HistorySummary;
}

export interface HistoryImportRequest {
	maxFiles?: number;
	retryFailed?: boolean;
	roots: { sourceId: string; path: string; accountId?: string }[];
	sourceIds: string[];
}

export type HistoryScope =
	| "session"
	| "account"
	| "organization"
	| "unattributed"
	| "unreconciled";
export interface HistoryAccountSyncRequest {
	accountId: string;
	credential: string;
	cursor?: string;
	endDate: string;
	sourceId: string;
	startDate: string;
}

export async function syncUsageHistoryAccount(
	target: ApiTarget,
	body: HistoryAccountSyncRequest,
	signal?: AbortSignal
): Promise<HistoryAccountSyncResult> {
	const destination = new URL(target.url);
	const hostname = destination.hostname.replace(/^\[|\]$/g, "");
	const loopback =
		hostname === "localhost" ||
		hostname === "::1" ||
		/^127(?:\.\d{1,3}){3}$/.test(hostname);
	if (
		destination.username ||
		destination.password ||
		(destination.protocol !== "https:" &&
			!(destination.protocol === "http:" && loopback))
	) {
		throw new Error("Provider admin keys require HTTPS or a local Core node.");
	}
	const value = await request(
		target,
		"/api/usage/history/account-sync",
		{ body, method: "POST", signal },
		z.json()
	);
	const result = historyAccountSyncSchema.safeParse(value);
	if (!result.success) {
		throw new Error("The node returned a malformed account sync result.");
	}

	return {
		report: parseHistoryImportReport(result.data.report),
		nextCursor: result.data.nextCursor,
	};
}

export interface HistoryImportReport {
	duplicateRecords: number;
	errorCount: number;
	errors: string[];
	hasMore: boolean;
	importedRecords: number;
	scannedFiles: number;
	skippedFiles: number;
	updatedRecords: number;
}

const historyResponseInputSchema = z.json();
export type HistoryResponseInput = z.infer<typeof historyResponseInputSchema>;
const historyCountSchema = z
	.number()
	.refine((value) => Number.isSafeInteger(value) && value >= 0);
const historyMoneySchema = z.number().nonnegative().nullable();
const historyTokenTotalsSchema = z
	.object({
		inputTokens: historyCountSchema,
		outputTokens: historyCountSchema,
		cacheReadTokens: historyCountSchema,
		cacheWriteTokens: historyCountSchema,
		cachedOutputTokens: historyCountSchema,
		reasoningTokens: historyCountSchema,
		missingInputRecords: historyCountSchema,
		missingOutputRecords: historyCountSchema,
		missingCacheReadRecords: historyCountSchema,
		missingCacheWriteRecords: historyCountSchema,
		missingCachedOutputRecords: historyCountSchema,
		missingReasoningRecords: historyCountSchema,
	})
	.passthrough();
const historyAggregateSchema = z.object({
	totals: historyTokenTotalsSchema,
	sessions: historyCountSchema,
	records: historyCountSchema,
	unpricedRecords: historyCountSchema,
	estimatedCostUsd: historyMoneySchema,
	billedCostUsd: historyMoneySchema,
	sourceEstimatedCostUsd: historyMoneySchema,
	reportedCostUsd: historyMoneySchema,
	cacheSavingsUsd: historyMoneySchema,
});
const historyBucketSchema = historyAggregateSchema
	.extend({
		date: z.string(),
		sourceId: z.string(),
		accountId: z.string().nullable().optional(),
		modelId: z.string().nullable(),
	})
	.passthrough();
const historySummarySchema = historyAggregateSchema
	.extend({
		accounts: z.array(historyBucketSchema).optional(),
		daily: z.array(historyBucketSchema),
		models: z.array(historyBucketSchema),
		sources: z.array(historyBucketSchema),
	})
	.passthrough();
export const usageHistoryReportSchema = z.object({
	summary: historySummarySchema,
	sources: z.array(
		z
			.object({
				id: z.string(),
				label: z.string(),
				transport: z.string(),
				available: z.boolean(),
				limitations: z.string(),
			})
			.passthrough()
	),
}) satisfies z.ZodType<UsageHistoryReport>;
export const historyImportReportSchema = z.object({
	scannedFiles: historyCountSchema,
	importedRecords: historyCountSchema,
	updatedRecords: historyCountSchema,
	duplicateRecords: historyCountSchema,
	skippedFiles: historyCountSchema,
	errorCount: historyCountSchema,
	hasMore: z.boolean(),
	errors: z.array(z.string()),
}) satisfies z.ZodType<HistoryImportReport>;
const historyAccountSyncSchema = z.object({
	report: historyResponseInputSchema.optional(),
	nextCursor: z.string().nullable(),
});
const historyTrackingSchema = z.object({ enabled: z.boolean() });
const historyImportOperationSchema = z.object({
	id: z.string().regex(/^[a-z0-9-]{1,64}$/iu),
	state: historyResponseInputSchema.optional(),
	report: historyResponseInputSchema.optional(),
	progress: historyResponseInputSchema.optional(),
	error: historyResponseInputSchema.optional(),
});
export interface HistoryAccountSyncResult {
	nextCursor: string | null;
	report: HistoryImportReport;
}
export interface HistoryTrackingSettings {
	enabled: boolean;
}

export function parseUsageHistoryReport(
	value: HistoryResponseInput | undefined
): UsageHistoryReport {
	const report = usageHistoryReportSchema.safeParse(value);
	if (!report.success) {
		throw new Error("The node returned malformed usage history.");
	}
	return report.data;
}
export function parseHistoryImportReport(
	value: HistoryResponseInput | undefined
): HistoryImportReport {
	const report = historyImportReportSchema.safeParse(value);
	if (!report.success) {
		throw new Error("The node returned a malformed history import result.");
	}
	return report.data;
}

export async function fetchUsageHistory(
	target: ApiTarget,
	startDate?: string,
	signal?: AbortSignal,
	scope: HistoryScope = "session"
): Promise<UsageHistoryReport> {
	const query = new URLSearchParams({ scope });
	if (startDate) {
		query.set("startDate", startDate);
	}
	return parseUsageHistoryReport(
		await request(
			target,
			`/api/usage/history?${query}`,
			{
				signal,
			},
			z.json()
		)
	);
}

export async function fetchUsageHistoryTracking(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<HistoryTrackingSettings> {
	const value = await request(
		target,
		"/api/usage/history/tracking",
		{
			signal,
		},
		z.json()
	);
	const result = historyTrackingSchema.safeParse(value);
	if (!result.success) {
		throw new Error("The node returned malformed history tracking settings.");
	}
	return result.data;
}

export async function setUsageHistoryTracking(
	target: ApiTarget,
	enabled: boolean,
	signal?: AbortSignal
): Promise<HistoryTrackingSettings> {
	const value = await request(
		target,
		"/api/usage/history/tracking",
		{
			body: { enabled },
			method: "PUT",
			signal,
		},
		z.json()
	);
	const result = historyTrackingSchema.safeParse(value);
	if (!result.success) {
		throw new Error("The node returned malformed history tracking settings.");
	}
	return result.data;
}

export async function importUsageHistory(
	target: ApiTarget,
	body: HistoryImportRequest,
	signal?: AbortSignal,
	onProgress?: (report: HistoryImportReport) => void
): Promise<HistoryImportReport> {
	let operation = await request(
		target,
		"/api/usage/history/import",
		{
			body,
			method: "POST",
			signal,
		},
		z.json()
	);
	for (;;) {
		const parsed = historyImportOperationSchema.safeParse(operation);
		if (!parsed.success) {
			throw new Error(
				"The node returned a malformed history import operation."
			);
		}
		const current = parsed.data;
		if (current.state === "completed") {
			return parseHistoryImportReport(current.report);
		}
		const error = z.string().safeParse(current.error);
		if (current.state === "failed" && error.success) {
			throw new Error(error.data);
		}
		if (current.state !== "running") {
			throw new Error(
				"The node returned a malformed history import operation."
			);
		}

		onProgress?.(parseHistoryImportReport(current.progress));
		await waitForHistoryPoll(signal);
		operation = await request(
			target,
			`/api/usage/history/import/operations/${current.id}`,
			{ signal },
			z.json()
		);
	}
}

function waitForHistoryPoll(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(
				new DOMException("History import polling cancelled.", "AbortError")
			);
			return;
		}
		const abort = () => {
			clearTimeout(timer);
			reject(
				new DOMException("History import polling cancelled.", "AbortError")
			);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, 1000);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/** Cache read/write are disjoint from input; reasoning is already in output. */
export function historyProcessedTokens(totals: HistoryTokenTotals): number {
	return (
		totals.inputTokens +
		totals.outputTokens +
		totals.cacheReadTokens +
		totals.cacheWriteTokens
	);
}
