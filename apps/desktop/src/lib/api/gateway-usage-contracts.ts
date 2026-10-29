import { z } from "zod";
import type {
	GatewayUsageRollupEvent,
	GatewayUsageRollupResponse,
} from "./gateway.ts";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const eventContract = z
	.object({
		timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))),
		provider: z.string(),
		model: z.string(),
		memberId: z.string().nullable(),
		nodeId: z.string().nullable(),
		feature: z.string().nullable(),
		source: z.enum(["byok", "local", "managed", "self_hosted", "unknown"]),
		inputTokens: counter,
		outputTokens: counter,
		requestCount: counter,
		errorCount: counter,
		latencyTotalMs: counter,
		latencySamples: counter,
		agentSeconds: z.number().nonnegative(),
		costMicroUsd: counter.nullable(),
		// Added by newer Gateways, so all three stay optional. The Gateway sums
		// cache counters as u64 and validates purpose against its tag grammar.
		// A bad counter rejects the whole response like every other counter,
		// but an unexpected purpose must never blank the dashboard: it is caught
		// here and narrowed to a string when the event is mapped.
		cacheReadTokens: counter.optional(),
		cacheWriteTokens: counter.optional(),
		purpose: z.string().nullable().optional().catch(null),
	})
	.passthrough() satisfies z.ZodType<GatewayUsageRollupEvent>;

// The event contract has no transforms: returning the validated original retains
// owner metadata and event identity, as the previous usage parser did.
const eventSchema = z.custom<GatewayUsageRollupEvent>(
	(value) => eventContract.safeParse(value).success
);
export const gatewayUsageWireSchema = z.object({
	kind: z.literal("rollup"),
	bucketSeconds: z.literal(900),
	events: z.array(eventSchema),
	reachable: z.boolean().optional(),
	status: counter.optional(),
}) satisfies z.ZodType<GatewayUsageRollupResponse>;
