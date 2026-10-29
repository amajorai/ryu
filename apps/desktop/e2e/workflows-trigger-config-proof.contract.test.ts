import { expect, test } from "bun:test";
import {
	parseWorkflowFixtureArgs,
	parseWorkflowFixtureReset,
	parseWorkflowFixtureSave,
	parseWorkflowFixtureSnapshot,
} from "./workflow-fixture-contract.ts";

const workflow = {
	edges: [{ from: "input", to: "output" }],
	id: "workflow-1",
	name: "Trigger contract",
	nodes: [
		{ id: "input", type: "input", key: null },
		{ id: "output", type: "output", key: null },
	],
	triggers: [
		{
			type: "unsupported-negative-fixture",
			cron: "not a valid schedule",
			enabled: false,
		},
	],
};

test("trigger workflow validation preserves negative domain values and opaque metadata", () => {
	const input = parseWorkflowFixtureArgs(
		JSON.stringify({ ...workflow, metadata: { retries: -1, disabled: null } })
	);
	const parsed = parseWorkflowFixtureSave(input);
	expect(input).toBe(parsed);
	expect(parsed.triggers).toEqual(workflow.triggers);
	expect(parsed.metadata).toEqual({ retries: -1, disabled: null });
});

test("trigger reset retains optional null inputs and negative failure counts", () => {
	const input = parseWorkflowFixtureArgs(
		JSON.stringify({
			appEvents: null,
			composioTriggers: null,
			toolkits: null,
			workflows: null,
			failures: { "workflows.save": -2 },
		})
	);
	const parsed = parseWorkflowFixtureReset(input);
	expect(input).toBe(parsed);
	expect(parsed.appEvents).toBeNull();
	expect(parsed.workflows).toBeNull();
	expect(parsed.failures).toEqual({ "workflows.save": -2 });
});

test("trigger JSON boundary rejects malformed JSON and non-record containers", () => {
	expect(() => parseWorkflowFixtureArgs("{")).toThrow();
	expect(() => parseWorkflowFixtureArgs("[]")).toThrow();
	expect(() => parseWorkflowFixtureArgs("null")).toThrow();
});

test("workflow save allows missing, empty, and null ids for host-generated ids", () => {
	const { id: _id, ...withoutId } = workflow;
	expect(
		parseWorkflowFixtureSave(
			parseWorkflowFixtureArgs(JSON.stringify(withoutId))
		).id
	).toBeUndefined();
	expect(
		parseWorkflowFixtureSave(
			parseWorkflowFixtureArgs(JSON.stringify({ ...workflow, id: "" }))
		).id
	).toBe("");
	expect(
		parseWorkflowFixtureSave(
			parseWorkflowFixtureArgs(JSON.stringify({ ...workflow, id: null }))
		).id
	).toBeNull();
});

test("workflow typed fields and reset failure counters are checked at the boundary", () => {
	expect(() =>
		parseWorkflowFixtureSave(
			parseWorkflowFixtureArgs(JSON.stringify({ ...workflow, name: 7 }))
		)
	).toThrow();
	expect(() =>
		parseWorkflowFixtureSave(
			parseWorkflowFixtureArgs(
				JSON.stringify({ ...workflow, nodes: [{ id: "node", type: null }] })
			)
		)
	).toThrow();
	expect(() =>
		parseWorkflowFixtureReset(
			parseWorkflowFixtureArgs('{"failures":{"workflows.save":"two"}}')
		)
	).toThrow();
});

test("schema validation preserves captured own JSON keys at every workflow level", () => {
	const input = parseWorkflowFixtureArgs(
		'{"id":"workflow-1","name":"Own keys","edges":[],"nodes":[{"id":"node","type":"input","__proto__":{"nested":true}}],"triggers":[],"__proto__":{"captured":true}}'
	);
	const parsed = parseWorkflowFixtureSave(input);
	expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
	expect(parsed.__proto__).toEqual({ captured: true });
	expect(Object.hasOwn(parsed.nodes[0], "__proto__")).toBe(true);
	expect(parsed.nodes[0].__proto__).toEqual({ nested: true });
});

test("captured trigger snapshots validate calls while retaining request own keys", () => {
	const parsed = parseWorkflowFixtureSnapshot(
		'{"calls":[{"method":"workflows.webhook","args":{"id":"workflow-1","__proto__":{"captured":true}}}],"workflows":[]}'
	);
	expect(parsed.calls[0].method).toBe("workflows.webhook");
	expect(Object.hasOwn(parsed.calls[0].args, "__proto__")).toBe(true);
	expect(parsed.calls[0].args.__proto__).toEqual({ captured: true });
	expect(() =>
		parseWorkflowFixtureSnapshot(
			'{"calls":[{"method":7,"args":{}}],"workflows":[]}'
		)
	).toThrow();
});

test("reset validates failure counters even for special own dictionary keys", () => {
	expect(() =>
		parseWorkflowFixtureReset(
			parseWorkflowFixtureArgs('{"failures":{"__proto__":{"invalid":true}}}')
		)
	).toThrow();
	const parsed = parseWorkflowFixtureReset(
		parseWorkflowFixtureArgs('{"failures":{"__proto__":2}}')
	);
	expect(Object.hasOwn(parsed.failures ?? {}, "__proto__")).toBe(true);
	expect(parsed.failures?.__proto__).toBe(2);
});

test("recorder reset payloads retain JSON record metadata and reject non-record results", () => {
	const input = {
		recordStopResult: { draft: { steps: [{ action: "click" }] }, events: [] },
	};
	expect(parseWorkflowFixtureReset(input)).toBe(input);
	expect(() => parseWorkflowFixtureReset({ recordStopResult: [] })).toThrow();
	expect(() =>
		parseWorkflowFixtureReset({ recordStopResult: "invalid" })
	).toThrow();
});
