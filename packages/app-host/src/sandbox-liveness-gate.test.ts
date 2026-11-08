import { describe, expect, test } from "bun:test";
import {
	createLivenessGate,
	LIVENESS_ACK_KIND,
	LIVENESS_PROBE_KIND,
	livenessResponderScript,
	MAX_GATED_MESSAGES,
} from "./sandbox-liveness-gate.ts";
import {
	htmlCompanionSrcdoc,
	thirdPartyPluginSrcdoc,
} from "./third-party-plugin.ts";

function recordingPort() {
	const sent: Array<{ kind: string; id: string }> = [];
	return {
		sent,
		postMessage(message: unknown) {
			sent.push(message as { kind: string; id: string });
		},
	};
}

function counterIds() {
	let next = 0;
	return () => {
		next += 1;
		return `probe-${next}`;
	};
}

describe("createLivenessGate", () => {
	test("delivers only after the port holder acks that message's probe", () => {
		const gate = createLivenessGate(counterIds());
		const port = recordingPort();
		const delivered: string[] = [];
		gate.attach(port);
		gate.admit(() => delivered.push("a"));
		expect(delivered).toEqual([]);
		expect(port.sent).toEqual([{ kind: LIVENESS_PROBE_KIND, id: "probe-1" }]);
		expect(
			gate.handlePortMessage({ kind: LIVENESS_ACK_KIND, id: "probe-1" })
		).toBe(true);
		expect(delivered).toEqual(["a"]);
		// A replayed or guessed ack delivers nothing more.
		gate.handlePortMessage({ kind: LIVENESS_ACK_KIND, id: "probe-1" });
		gate.handlePortMessage({ kind: LIVENESS_ACK_KIND, id: "probe-9" });
		expect(delivered).toEqual(["a"]);
	});

	test("holds messages until the port lands, then probes each", () => {
		const gate = createLivenessGate(counterIds());
		const delivered: string[] = [];
		gate.admit(() => delivered.push("early"));
		const port = recordingPort();
		gate.attach(port);
		expect(port.sent.map((probe) => probe.id)).toEqual(["probe-1"]);
		gate.handlePortMessage({ kind: LIVENESS_ACK_KIND, id: "probe-1" });
		expect(delivered).toEqual(["early"]);
	});

	test("an unanswered probe (a navigated realm) never delivers", () => {
		const gate = createLivenessGate(counterIds());
		const delivered: string[] = [];
		gate.attach(recordingPort());
		gate.admit(() => delivered.push("attacker"));
		gate.dispose();
		gate.handlePortMessage({ kind: LIVENESS_ACK_KIND, id: "probe-1" });
		gate.admit(() => delivered.push("late"));
		expect(delivered).toEqual([]);
	});

	test("bounds unacknowledged messages and passes other port traffic through", () => {
		const gate = createLivenessGate(counterIds());
		const port = recordingPort();
		gate.attach(port);
		for (let index = 0; index < MAX_GATED_MESSAGES + 5; index++) {
			gate.admit(() => undefined);
		}
		expect(port.sent).toHaveLength(MAX_GATED_MESSAGES);
		expect(gate.handlePortMessage({ kind: "ryu-plugin-rpc", id: 1 })).toBe(
			false
		);
	});
});

describe("bootstrap liveness responder", () => {
	test("both companion bootstraps answer the probe over their port", () => {
		const responder = livenessResponderScript();
		expect(responder).toContain(LIVENESS_PROBE_KIND);
		expect(responder).toContain(LIVENESS_ACK_KIND);
		const bundle = thirdPartyPluginSrcdoc("n", btoa("1"), "@ryu/demo", null);
		const html = htmlCompanionSrcdoc(
			"n",
			"<!doctype html><p>x</p>",
			"@ryu/demo",
			null
		);
		expect(bundle).toContain(responder);
		expect(html).toContain(responder);
	});

	test("the responder echoes the probe id on the port it came from", () => {
		const sent: unknown[] = [];
		const port = { postMessage: (message: unknown) => sent.push(message) };
		const respond = new Function(
			"msg",
			"port",
			`${livenessResponderScript()} return "unhandled";`
		) as (msg: unknown, port: unknown) => unknown;
		expect(
			respond({ kind: LIVENESS_PROBE_KIND, id: "x" }, port)
		).toBeUndefined();
		expect(sent).toEqual([{ kind: LIVENESS_ACK_KIND, id: "x" }]);
		expect(respond({ kind: "other" }, port)).toBe("unhandled");
	});
});
