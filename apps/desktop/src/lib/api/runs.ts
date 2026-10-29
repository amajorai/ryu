// Desktop compatibility entrypoint for the shared Core run-trace client.
// Keep this path stable for existing desktop consumers while the transport and
// wire normalization live in the platform-agnostic core-client package.
export {
	fetchRunTrace,
	type RunSpan,
	type RunSpanStatus,
} from "@ryuhq/core-client/runs.ts";
export {
	fetchRunTraceTree,
	flattenTraceTree,
	joinTraceUsage,
	listTraces,
	type RunTraceTree,
	type TraceAuditRow,
	type TraceListFilters,
	type TraceNode,
	type TraceSpanUsage,
	type TraceSummary,
	type TraceUsageTotals,
	usageTotals,
	type WaterfallRow,
} from "@ryuhq/core-client/traces.ts";
