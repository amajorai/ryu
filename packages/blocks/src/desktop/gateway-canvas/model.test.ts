// Spec 07.10: the event to pulse mapping (CV-1, CV-5), the pulse budget and
// exact counters at 1000 events a second (CV-4), and the layout. Events carry
// only ids, layers and S-codes; no request text exists anywhere in the feed.

import { describe, expect, test } from "bun:test";
import { layoutTopology, linkEnds, pulsePath } from "./layout.ts";
import { createCanvasLiveStore } from "./live-store.ts";
import {
	type CanvasTrafficEvent,
	createEventDeduper,
	createPulseBudget,
	GATEWAY_NODE_ID,
	indexTopology,
	MAX_PULSES_PER_SECOND,
	pulseFromEvent,
	ROUTE_NODE_ID,
	surfaceForRoute,
	type TrafficPulse,
} from "./model.ts";
import { buildTopology } from "./topology.ts";

const topology = buildTopology({
	chain: {
		"scope:agent": { label: "Agent" },
		"scope:org": { label: "Organization" },
		"stage:budget": { label: "Budgets" },
		"stage:inspector": { label: "Inspector" },
		"stage:node": { label: "Node filters" },
		"stage:platform_floor": { label: "Platform floor", locked: true },
		"stage:rate_limit": { label: "Rate limit" },
	},
	gateway: { label: "This gateway" },
	infra: [{ id: "infra:core", label: "Ryu Core" }],
	providers: [
		{ label: "OpenAI", name: "openai" },
		{ label: "Other", name: "other" },
	],
	route: { label: "Router" },
	surfaces: [
		{ id: "surface:openai", label: "OpenAI-compatible API" },
		{ id: "surface:anthropic", label: "Anthropic Messages API" },
	],
});
const index = indexTopology(topology);

function event(overrides: Partial<CanvasTrafficEvent>): CanvasTrafficEvent {
	return {
		kind: "completion",
		latency_ms: 120,
		provider: "openai",
		request_id: "req_1",
		route: "/v1/chat/completions",
		...overrides,
	};
}

const FULL_PATH = [
	"surface:openai",
	GATEWAY_NODE_ID,
	"stage:rate_limit",
	"stage:budget",
	"stage:platform_floor",
	"scope:org",
	"scope:agent",
	"stage:node",
	"stage:inspector",
	ROUTE_NODE_ID,
	"provider:openai",
];

describe("pulseFromEvent", () => {
	test("an allowed completion runs from its client to its provider", () => {
		expect(pulseFromEvent(event({}), index)).toMatchObject({
			outcome: "allow",
			path: FULL_PATH,
		});
	});

	test("CV-5: a floor block stops at the platform floor node", () => {
		const pulse = pulseFromEvent(
			event({
				kind: "failure",
				verdict: {
					action: "block",
					categories: ["S9"],
					decided_by: "platform_floor",
				},
			}),
			index
		);
		expect(pulse?.outcome).toBe("block");
		expect(pulse?.path.at(-1)).toBe("stage:platform_floor");
		expect(pulse?.layer).toBe("stage:platform_floor");
		expect(pulse?.codes).toEqual(["S9"]);
	});

	test("an org block stops at the organization layer, past the floor", () => {
		const pulse = pulseFromEvent(
			event({
				kind: "failure",
				verdict: { action: "block", decided_by: "org" },
			}),
			index
		);
		expect(pulse?.path).toEqual(FULL_PATH.slice(0, 6));
	});

	test("an upstream safety refusal ends at the provider", () => {
		const pulse = pulseFromEvent(
			event({
				kind: "failure",
				verdict: { action: "block", decided_by: "upstream" },
			}),
			index
		);
		expect(pulse?.layer).toBe("provider:openai");
		expect(pulse?.path).toEqual(FULL_PATH);
	});

	test("a refusal no layer claims stops at the gateway", () => {
		const pulse = pulseFromEvent(
			event({
				kind: "failure",
				provider: "none",
				verdict: { action: "block", decided_by: "none" },
			}),
			index
		);
		expect(pulse?.path).toEqual(["surface:openai", GATEWAY_NODE_ID]);
	});

	test("a layer this topology lacks also stops at the gateway", () => {
		const pulse = pulseFromEvent(
			event({
				kind: "failure",
				verdict: { action: "block", decided_by: "standing" },
			}),
			index
		);
		expect(pulse?.path.at(-1)).toBe(GATEWAY_NODE_ID);
	});

	test("CV-1: a sanitized request draws once, from its completion row", () => {
		const verdictRow = event({
			kind: "verdict",
			provider: "firewall",
			verdict: { action: "sanitize", decided_by: "node" },
		});
		const completion = event({
			verdict: { action: "sanitize", decided_by: "node" },
		});
		expect(pulseFromEvent(verdictRow, index)).toBeNull();
		expect(pulseFromEvent(completion, index)?.outcome).toBe("redacted");
	});

	test("an auxiliary inspector call row never draws", () => {
		expect(pulseFromEvent(event({ provider: "inspector" }), index)).toBeNull();
	});

	test("a cache hit ends at the router; an unknown provider uses Other", () => {
		expect(
			pulseFromEvent(event({ cache_hit: true, kind: null }), index)?.path.at(-1)
		).toBe(ROUTE_NODE_ID);
		expect(
			pulseFromEvent(event({ provider: "mistral" }), index)?.path.at(-1)
		).toBe("provider:other");
	});

	test("a reduced-mode screen is drawn as degraded; an upstream error as error", () => {
		expect(
			pulseFromEvent(
				event({
					verdict: { action: "allow", decided_by: "none", degraded: "t2" },
				}),
				index
			)?.outcome
		).toBe("degraded");
		expect(
			pulseFromEvent(
				event({ error: "upstream failed", kind: "failure" }),
				index
			)?.outcome
		).toBe("error");
	});

	test("older events without verdict fields still map", () => {
		const legacy: CanvasTrafficEvent = {
			cache_hit: false,
			error: null,
			provider: "openai",
			request_id: "req_legacy",
		};
		expect(pulseFromEvent(legacy, index)?.outcome).toBe("allow");
	});

	test("routes map to their client families", () => {
		expect(surfaceForRoute("/v1/messages")).toBe("surface:anthropic");
		expect(surfaceForRoute("/passthrough/anthropic/v1/messages")).toBe(
			"surface:passthrough"
		);
		expect(surfaceForRoute(null)).toBe("surface:other");
	});
});

describe("createEventDeduper", () => {
	test("CV-1: a replay after reconnect counts nothing twice", () => {
		const fresh = createEventDeduper();
		const rows = [
			event({ kind: "verdict", seq: 1 }),
			event({ kind: "completion", seq: 2 }),
		];
		expect(rows.map(fresh)).toEqual([true, true]);
		expect(rows.map(fresh)).toEqual([false, false]);
		// A restarted gateway reuses sequence numbers for new requests.
		expect(fresh(event({ request_id: "req_2", seq: 1 }))).toBe(true);
	});

	test("stays bounded", () => {
		const fresh = createEventDeduper(2);
		fresh(event({ seq: 1 }));
		fresh(event({ seq: 2 }));
		fresh(event({ seq: 3 }));
		expect(fresh(event({ seq: 1 }))).toBe(true);
	});
});

describe("CV-4: 1000 events a second for 10 seconds", () => {
	test("draws at most 30 pulses in any second and counts every event", () => {
		let clock = 0;
		const store = createCanvasLiveStore({
			now: () => clock,
			pulseLifetimeMs: 10,
			schedule: () => undefined,
		});
		const allowed = pulseFromEvent(event({}), index) as TrafficPulse;
		const blocked = pulseFromEvent(
			event({
				kind: "failure",
				verdict: { action: "block", decided_by: "platform_floor" },
			}),
			index
		) as TrafficPulse;
		const drawnPerSecond: number[] = [];
		let drawnBefore = 0;
		let seen = 0;
		for (let second = 0; second < 10; second += 1) {
			let drawn = 0;
			for (let tick = 0; tick < 1000; tick += 1) {
				clock = second * 1000 + tick;
				store.ingest(tick % 10 === 0 ? blocked : allowed);
				const ids = store.pulses().map((entry) => entry.id);
				const newest = ids.at(-1) ?? 0;
				if (newest > drawnBefore) {
					drawn += newest - drawnBefore;
					drawnBefore = newest;
				}
				seen += 1;
			}
			drawnPerSecond.push(drawn);
		}
		store.flush();
		expect(Math.max(...drawnPerSecond)).toBeLessThanOrEqual(
			MAX_PULSES_PER_SECOND
		);
		expect(drawnPerSecond.every((count) => count > 0)).toBe(true);
		expect(store.counters(GATEWAY_NODE_ID).requests).toBe(seen);
		expect(store.counters("stage:platform_floor").blocked).toBe(1000);
		expect(store.counters("provider:openai").requests).toBe(9000);
		expect(store.totals().requests).toBe(10_000);
		expect(store.totals().sampledOut).toBe(10_000 - drawnBefore);
		expect(store.edgeCount(GATEWAY_NODE_ID, "stage:rate_limit")).toBe(10_000);
	});

	test("blocks keep their own share of the budget", () => {
		const admit = createPulseBudget();
		const allow: TrafficPulse = { outcome: "allow", path: ["a", "b"] };
		const block: TrafficPulse = { outcome: "block", path: ["a"] };
		for (let index = 0; index < 100; index += 1) {
			admit(allow, 0);
		}
		expect(admit(block, 1)).toBe(true);
	});

	test("with motion off, counters still count and nothing is drawn", () => {
		const store = createCanvasLiveStore({ schedule: () => undefined });
		store.setMotion(false);
		store.ingest(pulseFromEvent(event({}), index) as TrafficPulse);
		store.flush();
		expect(store.pulses()).toHaveLength(0);
		expect(store.counters(GATEWAY_NODE_ID).requests).toBe(1);
	});
});

describe("layoutTopology", () => {
	const layout = layoutTopology(topology);

	test("clients, gateway, admission, policy, screening, router, providers left to right", () => {
		const column = (id: string) => layout[id]?.column;
		expect(column("surface:openai")).toBe(0);
		expect(column(GATEWAY_NODE_ID)).toBe(1);
		expect(column("stage:rate_limit")).toBe(2);
		expect(column("stage:budget")).toBe(2);
		expect(column("stage:platform_floor")).toBe(3);
		expect(column("scope:agent")).toBe(3);
		expect(column("stage:node")).toBe(4);
		expect(column(ROUTE_NODE_ID)).toBe(5);
		expect(column("provider:openai")).toBe(6);
		expect(column("provider:other")).toBe(6);
	});

	test("a group stacks in traffic order and infrastructure sits below", () => {
		const floor = layout["stage:platform_floor"];
		const org = layout["scope:org"];
		const core = layout["infra:core"];
		expect(floor && org && floor.y < org.y).toBe(true);
		expect(core?.column).toBe(-1);
		const lowest = Math.max(
			...Object.values(layout)
				.filter((entry) => entry.column >= 0)
				.map((entry) => entry.y)
		);
		expect((core?.y ?? 0) > lowest).toBe(true);
	});

	test("links in one column run bottom to top; pulses ride the same points", () => {
		const floor = layout["stage:platform_floor"];
		const org = layout["scope:org"];
		if (!(floor && org)) {
			throw new Error("missing placement");
		}
		const ends = linkEnds(floor, org);
		expect(ends.vertical).toBe(true);
		expect(ends.target.y).toBe(org.y);
		const d = pulsePath(["stage:platform_floor", "scope:org"], layout);
		expect(d).toBe(
			`M${ends.source.x},${ends.source.y} L${ends.target.x},${ends.target.y}`
		);
		expect(pulsePath(["stage:platform_floor", "missing"], layout)).toBeNull();
	});
});
