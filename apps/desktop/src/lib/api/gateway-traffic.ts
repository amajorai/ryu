import { type ApiTarget, apiUrl, requestHeaders } from "./client.ts";
import {
	gatewayTrafficUnavailableSchema,
	parseTrafficFrame,
} from "./gateway-traffic-contracts.ts";

// ── Live traffic (SSE via Core proxy) ────────────────────────────────────────
//
// Core proxies the gateway's admin-gated `GET /v1/traffic` SSE stream at
// `/api/gateway/traffic`, forwarding the gateway bearer token server-side so the
// desktop never holds the master key. The stream is seeded with the recent ring
// buffer on connect (newest last), then pushes every completed request as an
// `event: traffic` + `data:` pair.

/** A single redacted live-traffic event (the gateway's `/v1/traffic` payload). */
export interface TrafficEvent {
	/** API key, truncated to its prefix (`sk-sec***`). Never a full key. */
	api_key: string;
	/** Whether the gateway's own response cache answered. */
	cache_hit: boolean;
	command?: string | null;
	/** A hosted credential id, truncated to its prefix. */
	credential_id_prefix?: string | null;
	/** Whose credential the request spent (`node_operator`, `ryu_vault`, ...). */
	credential_origin?: string | null;
	custody?: string | null;
	/** Error message, when the request failed. */
	error: string | null;
	/** Event type — "model_call" for LLM calls. */
	event_type: string;
	/** Input tokens billed (0 on error). */
	input_tokens: number;
	/**
	 * Which row of the request this is. This and the other optional verdict
	 * feed fields (spec 07.2) are absent on older gateways.
	 */
	kind?: "completion" | "verdict" | "cache_hit" | "failure";
	/** Wall-clock latency in milliseconds. */
	latency_ms: number;
	/** Model name, absent for a direct service call. */
	model: string | null;
	org_id?: string | null;
	/** Output tokens billed (0 on error). */
	output_tokens: number;
	/** Provider that served the request (e.g. "openai", "anthropic"). */
	provider: string;
	provider_cost_micro_usd?: number | null;
	/** Gateway-internal request id. */
	request_id: string;
	/** The matched route template, never the raw path. */
	route?: string | null;
	/** Strictly increasing per gateway process; dedupes a reconnect replay. */
	seq?: number;
	service_usage?: {
		requests: number;
		documents: number;
		provider_credits: number | null;
		cost_source:
			| "provider_reported"
			| "configured_estimate"
			| "unpriced"
			| "unsettled";
		cost_is_estimate: boolean;
	} | null;
	/** Core session/conversation id, when tagged. */
	session_id: string | null;
	stage_latency_ms?: { screen: number | null; upstream: number | null } | null;
	/** HTTP status the client received, when known. */
	status?: number | null;
	team_ids?: string[] | null;
	/** ISO-8601 timestamp when the event was published. */
	ts: string;
	/** What the deciding layer did. Names layers and codes, never text. */
	verdict?: TrafficVerdict | null;
}

/** The redacted verdict summary on a traffic event (spec 00.6). */
export interface TrafficVerdict {
	action: "allow" | "warn" | "sanitize" | "block";
	categories: string[];
	code?: string | null;
	decided_by: string;
	/** Why the screener ran in a reduced mode, when it did. */
	degraded?: string | null;
	detector_ids: string[];
	evaluator_ids: string[];
	event_id?: string | null;
}

/**
 * Subscribe to the gateway's live traffic feed via Core's proxy.
 *
 * Returns an unsubscribe function. The connection is created on demand and torn
 * down when the last subscriber unsubscribes. On gateway-down Core returns a
 * short `{ reachable: false }` JSON body instead of an SSE stream; the
 * subscription surfaces it as an error and closes (the caller reconnects via
 * its own retry loop). A non-2xx answer also reports its HTTP `status`, so a
 * caller can stop retrying a permission refusal (403) that a reconnect cannot
 * change. `onOpen` fires once the stream is open, before any row arrives.
 * `onEnd` fires when the stream closes cleanly (a gateway restart), so a
 * caller that dedupes the replay can reconnect.
 */
export function subscribeGatewayTraffic(
	target: ApiTarget,
	onEvent: (event: TrafficEvent) => void,
	onError?: (message: string, detail?: { status: number }) => void,
	onEnd?: () => void,
	onOpen?: () => void
): () => void {
	const url = apiUrl(target, "/api/gateway/traffic");
	const controller = new AbortController();
	const open = async (): Promise<void> => {
		try {
			const resp = await fetch(url, {
				headers: await requestHeaders(target),
				signal: controller.signal,
			});
			if (!resp.ok) {
				onError?.(`traffic feed returned ${resp.status}`, {
					status: resp.status,
				});
				return;
			}
			const contentType = resp.headers.get("content-type") ?? "";
			if (!contentType.includes("text/event-stream")) {
				// Core answered a fail-soft JSON body (`{reachable:false}`) instead
				// of a stream — the gateway is down or auth-gated.
				const text = await resp.text().catch(() => "");
				let message = "traffic feed unavailable";
				try {
					const parsed = gatewayTrafficUnavailableSchema.parse(
						JSON.parse(text)
					);
					if (parsed.error) {
						message = `traffic feed: ${String(parsed.error)}`;
					} else if (parsed.reachable === false) {
						message = "traffic feed: gateway unreachable";
					}
				} catch {
					// Not JSON — fall through to the generic message.
				}
				onError?.(message);
				return;
			}

			const reader = resp.body?.getReader();
			if (!reader) {
				onError?.("traffic feed: no response body");
				return;
			}
			onOpen?.();
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				while (!controller.signal.aborted) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					buffer += decoder.decode(value, { stream: true });
					// Split on event boundaries: `event: traffic\ndata: {…}\n\n`.
					while (!controller.signal.aborted) {
						const idx = buffer.indexOf("\n\n");
						if (idx === -1) {
							break;
						}
						const frame = buffer.slice(0, idx);
						buffer = buffer.slice(idx + 2);
						const parsed = parseTrafficFrame(frame);
						if (parsed) {
							onEvent(parsed);
						}
					}
				}
			} finally {
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
			if (!controller.signal.aborted) {
				onEnd?.();
			}
		} catch (error) {
			if (controller.signal.aborted) {
				return; // Tear-down, not an error.
			}
			onError?.(error instanceof Error ? error.message : "traffic feed failed");
		}
	};

	void open();
	return () => controller.abort();
}
