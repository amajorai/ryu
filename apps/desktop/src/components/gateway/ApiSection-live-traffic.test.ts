import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { TrafficEvent } from "@/src/lib/api/gateway-traffic.ts";
import { trafficSubject } from "./ApiSection-live-traffic.tsx";

const tl: LiteralMessage = (source) => `[${source}]`;

function event(overrides: Partial<TrafficEvent>): TrafficEvent {
	return { event_type: "service_call", ...overrides } as TrafficEvent;
}

describe("trafficSubject", () => {
	test("web service calls are named with catalogued labels", () => {
		expect(trafficSubject(event({ command: "web.search" }), tl)).toBe(
			"[Web search]"
		);
		expect(trafficSubject(event({ command: "web.fetch" }), tl)).toBe(
			"[Web fetch]"
		);
		expect(trafficSubject(event({ command: "maps.route" }), tl)).toBe(
			"[Web service]"
		);
	});

	test("a model call shows its model id as written", () => {
		expect(
			trafficSubject(event({ event_type: "model_call", model: "gpt-5" }), tl)
		).toBe("gpt-5");
	});
});
