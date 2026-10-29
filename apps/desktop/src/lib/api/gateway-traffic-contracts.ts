import { rpcJsonResponseSchema } from "@ryu/app-host/rpc";
import { z } from "zod";
import type { TrafficEvent } from "./gateway.ts";

const trafficContract = z.object({
	api_key: z.string(),
	cache_hit: z.boolean(),
	command: z.string().nullable().optional(),
	error: z.string().nullable(),
	event_type: z.string(),
	input_tokens: z.number(),
	latency_ms: z.number(),
	model: z.string().nullable(),
	output_tokens: z.number(),
	provider: z.string(),
	request_id: z.string(),
	service_usage: z
		.object({
			requests: z.number(),
			documents: z.number(),
			provider_credits: z.number().nullable(),
			cost_source: z.enum([
				"provider_reported",
				"configured_estimate",
				"unpriced",
				"unsettled",
			]),
			cost_is_estimate: z.boolean(),
		})
		.nullable()
		.optional(),
	session_id: z.string().nullable(),
	ts: z.string(),
	// Verdict feed fields (spec 07.2); older gateways omit every one.
	kind: z.enum(["completion", "verdict", "cache_hit", "failure"]).optional(),
	seq: z.number().optional(),
	route: z.string().nullable().optional(),
	status: z.number().nullable().optional(),
	org_id: z.string().nullable().optional(),
	team_ids: z.array(z.string()).nullable().optional(),
	credential_id_prefix: z.string().nullable().optional(),
	custody: z.string().nullable().optional(),
	credential_origin: z.string().nullable().optional(),
	provider_cost_micro_usd: z.number().nullable().optional(),
	stage_latency_ms: z
		.object({
			screen: z.number().nullable(),
			upstream: z.number().nullable(),
		})
		.nullable()
		.optional(),
	verdict: z
		.object({
			action: z.enum(["allow", "warn", "sanitize", "block"]),
			categories: z.array(z.string()),
			code: z.string().nullable().optional(),
			decided_by: z.string(),
			degraded: z.string().nullable().optional(),
			detector_ids: z.array(z.string()),
			evaluator_ids: z.array(z.string()),
			event_id: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
}) satisfies z.ZodType<TrafficEvent>;

/** The complete Gateway traffic serializer is validated without dropping future fields. */
export const gatewayTrafficEventSchema = z.custom<TrafficEvent>(
	(value) =>
		rpcJsonResponseSchema.safeParse(value).success &&
		trafficContract.safeParse(value).success
);
export const gatewayTrafficUnavailableSchema = z.object({
	error: z.json().optional(),
	reachable: z.boolean().optional(),
});

/** The SSE event name the gateway frames traffic rows with. */
const TRAFFIC_EVENT_NAME = "traffic";

/**
 * Parse one SSE frame of the traffic stream. Only `event: traffic` frames
 * (or unnamed ones, from older relays) carry a traffic row; any other event
 * name and keep-alive comments return `null` rather than being misread as a
 * row (spec 07.2).
 */
export function parseTrafficFrame(frame: string): TrafficEvent | null {
	let name = "message";
	const data: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith(":")) {
			continue;
		}
		if (line.startsWith("event:")) {
			name = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			data.push(line.slice(5).trim());
		}
	}
	if (name !== TRAFFIC_EVENT_NAME && name !== "message") {
		return null;
	}
	const payload = data.join("\n");
	if (!payload || payload === "[DONE]") {
		return null;
	}
	try {
		return gatewayTrafficEventSchema.parse(JSON.parse(payload));
	} catch {
		// Malformed frame: skip it; the stream continues.
		return null;
	}
}
