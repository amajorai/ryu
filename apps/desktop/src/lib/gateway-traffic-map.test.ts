// The desktop traffic map binding (spec 07.10): SSE frames are parsed by
// event name (CV-3), a reconnect's replayed rows count once (CV-1), and the
// local topology follows the gateway's running stages. Events carry ids,
// layers and S-codes only; no request text appears anywhere.

import { describe, expect, test } from "bun:test";
import {
	GATEWAY_NODE_ID,
	indexTopology,
	type TrafficPulse,
} from "@ryu/blocks/desktop/gateway-canvas/model.ts";
import { parseTrafficFrame } from "./api/gateway-traffic-contracts.ts";
import {
	buildLocalTopology,
	followGatewayTraffic,
	providerLabel,
} from "./gateway-traffic-map.ts";

function row(overrides: Record<string, unknown>) {
	return {
		api_key: "sk-loc***",
		cache_hit: false,
		error: null,
		event_type: "model_call",
		input_tokens: 10,
		latency_ms: 90,
		model: "test-model",
		output_tokens: 5,
		provider: "openai",
		request_id: "req_1",
		session_id: null,
		ts: "2026-10-24T00:00:00Z",
		...overrides,
	};
}

function frame(data: unknown, name = "traffic"): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("parseTrafficFrame", () => {
	test("reads a traffic frame with its verdict fields", () => {
		const parsed = parseTrafficFrame(
			frame(
				row({
					kind: "failure",
					route: "/v1/chat/completions",
					seq: 4,
					status: 451,
					verdict: {
						action: "block",
						categories: ["S9"],
						decided_by: "platform_floor",
						detector_ids: [],
						evaluator_ids: [],
					},
				})
			).trimEnd()
		);
		expect(parsed?.verdict?.decided_by).toBe("platform_floor");
		expect(parsed?.seq).toBe(4);
	});

	test("CV-3: another event name is never read as a traffic row", () => {
		expect(parseTrafficFrame(frame(row({}), "degraded").trimEnd())).toBeNull();
		expect(parseTrafficFrame(": keep-alive")).toBeNull();
	});

	test("an older relay's unnamed frame still parses; a broken one is skipped", () => {
		expect(
			parseTrafficFrame(`data: ${JSON.stringify(row({}))}`)
		).not.toBeNull();
		expect(parseTrafficFrame("event: traffic\ndata: {not json")).toBeNull();
	});

	test("every verdict feed field, shaped as the gateway emits it, parses", () => {
		const parsed = parseTrafficFrame(
			frame(
				row({
					credential_id_prefix: "cred_abc***",
					credential_origin: "node_operator",
					custody: "self_hosted",
					kind: "completion",
					org_id: "org_1",
					provider_cost_micro_usd: 1200,
					route: "/v1/messages",
					seq: 9,
					stage_latency_ms: { screen: 12, upstream: null },
					status: 200,
					team_ids: ["team_1"],
					verdict: {
						action: "warn",
						categories: ["S1"],
						code: null,
						decided_by: "evaluator",
						degraded: "deadline",
						detector_ids: ["prompt_attack"],
						evaluator_ids: ["coverage-pii-detector"],
						event_id: "vev_1",
					},
				})
			).trimEnd()
		);
		expect(parsed?.custody).toBe("self_hosted");
		expect(parsed?.stage_latency_ms?.screen).toBe(12);
		expect(parsed?.verdict?.event_id).toBe("vev_1");
		const nulls = parseTrafficFrame(
			frame(
				row({
					credential_id_prefix: null,
					org_id: null,
					route: null,
					stage_latency_ms: { screen: null, upstream: null },
					status: null,
					team_ids: null,
				})
			).trimEnd()
		);
		expect(nulls).not.toBeNull();
	});
});

describe("buildLocalTopology", () => {
	test("follows the running stages and lists providers with health", () => {
		const topology = buildLocalTopology({
			gatewayReachable: true,
			pipelineStages: ["rate-limit", "firewall", "route", "audit"],
			providerHealth: {
				anthropic: { circuit: "open", consecutiveFailures: 5, openForSecs: 3 },
			},
			providers: ["openai", "anthropic"],
			signedIn: false,
		});
		const ids = topology.nodes.map((node) => node.id);
		expect(ids).not.toContain("stage:inspector");
		expect(ids).not.toContain("infra:control_plane");
		expect(ids).toContain("stage:platform_floor");
		const anthropic = topology.nodes.find(
			(node) => node.id === "provider:anthropic"
		);
		expect(anthropic?.health).toBe("down");
		expect(anthropic?.label).toBe("Anthropic");
	});

	test("an older gateway without a stage list gets every screener", () => {
		const topology = buildLocalTopology({
			assignedPolicies: { team: 2 },
			gatewayReachable: false,
			providers: [],
			signedIn: true,
		});
		const ids = topology.nodes.map((node) => node.id);
		expect(ids).toContain("stage:inspector");
		expect(ids).toContain("stage:evaluator");
		expect(ids).toContain("infra:control_plane");
		expect(
			topology.nodes.find((node) => node.id === "scope:team")?.detail
		).toBe("2 policies assigned");
		expect(
			topology.nodes.find((node) => node.id === GATEWAY_NODE_ID)?.health
		).toBe("down");
	});

	test("the version only moves when something drawn changes", () => {
		const input = {
			gatewayReachable: true,
			providers: ["openai"],
			signedIn: false,
		};
		expect(buildLocalTopology(input).version).toBe(
			buildLocalTopology({ ...input, providers: ["openai"] }).version
		);
		expect(buildLocalTopology(input).version).not.toBe(
			buildLocalTopology({ ...input, providers: ["openai", "ollama"] }).version
		);
	});

	test("labels unknown providers readably", () => {
		expect(providerLabel("my-compat_backend")).toBe("My Compat Backend");
	});
});

describe("followGatewayTraffic", () => {
	const index = indexTopology(
		buildLocalTopology({
			gatewayReachable: true,
			providers: ["openai"],
			signedIn: false,
		})
	);

	test("CV-1: replayed rows after a reconnect are drawn once", () => {
		const verdict = {
			action: "sanitize",
			categories: [],
			decided_by: "node",
			detector_ids: ["internal_ref"],
			evaluator_ids: [],
		};
		const frames = [
			frame(row({ kind: "verdict", provider: "firewall", seq: 1, verdict })),
			frame(row({ kind: "completion", seq: 2, verdict })),
			frame(row({}), "degraded"),
			// The replay a reconnect serves.
			frame(row({ kind: "completion", seq: 2, verdict })),
		];
		const pulses: TrafficPulse[] = [];
		const statuses: string[] = [];
		const stop = followGatewayTraffic(
			(onEvent) => {
				for (const text of frames) {
					const parsed = parseTrafficFrame(text.trimEnd());
					if (parsed) {
						onEvent(parsed);
					}
				}
				return () => undefined;
			},
			() => index,
			(pulse) => pulses.push(pulse),
			(state) => statuses.push(state.status)
		);
		stop();
		expect(pulses).toHaveLength(1);
		expect(pulses[0]?.outcome).toBe("redacted");
		expect(statuses).toEqual(["connecting", "live"]);
	});

	test("a permission refusal stops for good; other failures retry", async () => {
		let calls = 0;
		const statuses: string[] = [];
		const stop = followGatewayTraffic(
			(_onEvent, onError) => {
				calls += 1;
				onError("traffic feed returned 403", { status: 403 });
				return () => undefined;
			},
			() => index,
			() => undefined,
			(state) => statuses.push(state.status)
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		stop();
		expect(calls).toBe(1);
		expect(statuses.at(-1)).toBe("denied");

		let retries = 0;
		const retrying = followGatewayTraffic(
			(_onEvent, onError) => {
				retries += 1;
				onError("traffic feed: gateway unreachable");
				return () => undefined;
			},
			() => index,
			() => undefined,
			() => undefined
		);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		retrying();
		expect(retries).toBe(2);
	});

	test("an open stream with no rows yet reads as live", () => {
		const statuses: string[] = [];
		const stop = followGatewayTraffic(
			(_onEvent, _onError, _onEnd, onOpen) => {
				onOpen();
				return () => undefined;
			},
			() => index,
			() => undefined,
			(state) => statuses.push(state.status)
		);
		stop();
		expect(statuses).toEqual(["connecting", "live"]);
	});

	test("a cleanly closed stream reconnects and dedupes the replay", async () => {
		let connects = 0;
		const statuses: string[] = [];
		const pulses: TrafficPulse[] = [];
		const replayed = parseTrafficFrame(
			frame(row({ kind: "completion", seq: 3 })).trimEnd()
		);
		const stop = followGatewayTraffic(
			(onEvent, _onError, onEnd) => {
				connects += 1;
				if (replayed) {
					onEvent(replayed);
				}
				if (connects === 1) {
					onEnd();
				}
				return () => undefined;
			},
			() => index,
			(pulse) => pulses.push(pulse),
			(state) => statuses.push(state.status)
		);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		stop();
		expect(connects).toBe(2);
		expect(statuses).toEqual([
			"connecting",
			"live",
			"unavailable",
			"connecting",
			"live",
		]);
		expect(pulses).toHaveLength(1);
	});
});
